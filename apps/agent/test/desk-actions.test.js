"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createDeskActions } = require("../lib/operator/deskactions");
const actions = require("../lib/desk/actions");
const models = require("../lib/desk/models");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const calls = [];
  const supportOwner = { setTicketOwner: (t, o, by) => { calls.push(["owner", t, o, by]); return {}; }, deferred: () => false };
  const killSwitch = { engage: () => (calls.push(["engage"]), { engaged: true }), release: () => (calls.push(["release"]), { engaged: false }) };
  const config = { incidentChannel: "123456789012345678" };
  const desk = createDeskActions({ ledger, config, supportOwner, killSwitch });
  const job = (n, fields) => ledger.createJob(`ticket:${n}`, { kind: "ticket", role: "support", ticket: n, channelId: `9000000000000000${n}`, ...fields });
  return { ledger, desk, calls, job };
}
const dev = { id: "11", role: "dev" }, junior = { id: "12", role: "junior" }, nobody = { id: "13", role: "player" };

test("operator: nudge requeues waiting and blocked, refuses running, queued and unknown-effect work", () => {
  const { desk, job, ledger } = setup();
  const a = job(1, { state: "waiting", wakeAt: 5 }), b = job(2, { state: "running" }), c = job(3, { state: "blocked", effects: { x: { state: "started" } } });
  assert.equal(desk.run({ action: "nudge", ticket: 1, actor: junior }).ok, true);
  assert.equal(a.state, "queued"); assert.equal(a.wakeAt, undefined);
  assert.equal(desk.run({ action: "nudge", ticket: 2, actor: junior }).ok, false);
  assert.equal(desk.run({ action: "nudge", ticket: 3, actor: junior }).ok, false);
  assert.equal(desk.run({ action: "nudge", ticket: 1, actor: junior }).ok, false);
  const row = ledger.data.audit.find((r) => r.kind === "desk_action");
  assert.deepEqual([row.action, row.actor, row.role, row.ticket], ["nudge", "12", "junior", 1]);
  const out = Object.values(ledger.data.outbox);
  assert.equal(out.length, 1); assert.equal(out[0].destination, "channel:123456789012345678");
});

test("operator: pause and resume use the ticket pause, release hands the ticket to people", () => {
  const { desk, job, ledger, calls } = setup();
  const a = job(4, { state: "queued" });
  assert.equal(desk.run({ action: "pause", ticket: 4, actor: junior }).ok, true);
  assert.equal(a.state, "paused"); assert.ok(ledger.data.ticketPauses[4]);
  assert.equal(desk.run({ action: "resume", ticket: 4, actor: junior }).ok, true);
  assert.equal(a.state, "queued");
  assert.equal(desk.run({ action: "release", ticket: 4, actor: junior }).ok, true);
  assert.deepEqual(calls[0], ["owner", 4, "staff", "desk:12"]);
});

test("operator: wrong roles are refused, on and off are developer only, no action posts to a player", () => {
  const { desk, job, ledger, calls } = setup();
  job(5, { state: "waiting" });
  assert.equal(desk.run({ action: "nudge", ticket: 5, actor: nobody }).ok, false);
  assert.equal(desk.run({ action: "off", actor: junior }).ok, false);
  assert.equal(desk.run({ action: "off", actor: dev }).ok, true);
  assert.equal(desk.run({ action: "on", actor: dev }).ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ["engage", "release"]);
  desk.run({ action: "nudge", ticket: 5, actor: dev });
  for (const o of Object.values(ledger.data.outbox)) assert.equal(o.destination, "channel:123456789012345678");
});

test("operator: a queued route applies only to jobs created after it", async () => {
  const { desk, job, ledger } = setup();
  const old = job(6, {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(desk.run({ action: "route", provider: "opencode", model: "m", actor: dev, override: true }).ok, true);
  await new Promise((r) => setTimeout(r, 5));
  const fresh = job(7, {});
  assert.equal(desk.routeFor(old), null);
  assert.equal(desk.routeFor(fresh).model, "m");
  assert.equal(ledger.data.audit.find((r) => r.action === "route").override, true);
});

const fakeFetch = (log, status = 200, body = { ok: true, message: "done" }) => async (url, opts) => { log.push([url, JSON.parse(opts.body), opts.headers.Authorization]); return { status, ok: status < 400, json: async () => body }; };
const env = { KEIR_OPERATOR_PORT: "9999", KEIR_OPERATOR_ADMIN_TOKEN: "tok" };

test("desk: each action calls the operator endpoint and refuses the wrong role before calling", async () => {
  const log = [];
  const config = { env, fetchImpl: fakeFetch(log) };
  for (const action of ["nudge", "release", "pause", "resume"]) {
    const r = await actions.run({ action, ticket: 7, actor: junior, config });
    assert.equal(r.content, "done");
  }
  assert.equal(log.length, 4);
  assert.ok(log.every(([u, b, a]) => u === "http://127.0.0.1:9999/v5/desk/action" && a === "Bearer tok" && b.ticket === 7 && b.actor.role === "junior"));
  assert.match((await actions.run({ action: "off", actor: junior, config })).content, /Only developers/);
  assert.match((await actions.run({ action: "nudge", ticket: 7, actor: nobody, config })).content, /Only junior/);
  assert.match((await actions.run({ action: "nudge", actor: junior, config })).content, /which ticket/);
  assert.equal(log.length, 4);
  assert.equal((await actions.run({ action: "on", actor: dev, config })).content, "done");
});

test("desk: operator down says Keir is off; on clears the switch and starts it", async () => {
  const down = async () => { throw new Error("ECONNREFUSED"); };
  const config = { env, fetchImpl: down };
  assert.match((await actions.run({ action: "pause", ticket: 7, actor: junior, config })).content, /Keir is off/);
  let released = false, started = false;
  const r = await actions.run({ action: "on", actor: dev, config: { ...config, killSwitch: { release: () => { released = true; } }, startUnit: async () => (started = true) } });
  assert.ok(released && started); assert.match(r.content, /starting/);
  assert.doesNotMatch((await actions.run({ action: "pause", ticket: 1, actor: junior, config: { env: { KEIR_OPERATOR_ADMIN_TOKEN: "secret-tok" }, fetchImpl: down } })).content, /secret-tok/);
});

function registry(entries) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reg-")), "r.json");
  fs.writeFileSync(f, JSON.stringify({ schema: 1, bar: "zero false claims", entries }));
  return f;
}
const E = (o) => ({ provider: "opencode", model: "m1", effort: "high", date: "2026-11-12", cases: 16, right: 11, falseClaims: 4, passedBar: false, ...o });

test("models: view lists entries, says none proven today, and shows the current model", async () => {
  const cfg = { env: { ...env, KEIR_MODEL_REGISTRY: registry([E({}), E({ model: "m2" })]), KEIR_WORKER_PROVIDER: "claude:x" }, cache: new Map(), probeImpl: async () => { throw new Error("must not probe"); } };
  const r = await models.view(cfg);
  assert.match(r.content, /Current: claude:x/); assert.match(r.content, /opencode:m1@high: 2026-11-12, 16 cases, 11 right, 4 false claims, not proven/);
  assert.match(r.content, /No model is proven yet/);
});

test("models: proven needs passedBar and a fresh passing probe, probes at most once per 10 minutes", async () => {
  let n = 0, t = 1000000, ok = true;
  const cfg = { env: { ...env, KEIR_MODEL_REGISTRY: registry([E({ passedBar: true })]) }, cache: new Map(), now: () => t, probeImpl: async () => (n++, ok) };
  const e = models.loadRegistry(cfg).entries[0];
  assert.equal(await models.isProven(e, cfg), true);
  await models.isProven(e, cfg); assert.equal(n, 1);
  t += 11 * 60000; ok = false;
  assert.equal(await models.isProven(e, cfg), false); assert.equal(n, 2);
  await models.isProven(e, cfg); assert.equal(n, 2);
  assert.equal(await models.isProven({ ...e, passedBar: false }, { ...cfg, cache: new Map() }), false);
});

test("models: select allows proven, refuses not proven, logs override, devs only, applies via the route endpoint", async () => {
  const log = [];
  const cfg = { env: { ...env, KEIR_MODEL_REGISTRY: registry([E({ passedBar: true }), E({ model: "m2" })]) }, cache: new Map(), probeImpl: async () => true, fetchImpl: fakeFetch(log, 200, { ok: true, message: "New tickets will use it." }) };
  assert.match((await models.select({ provider: "opencode", model: "m1", actor: junior, config: cfg })).content, /Only developers/);
  assert.equal((await models.select({ provider: "opencode", model: "m1", effort: "high", actor: dev, config: cfg })).content, "New tickets will use it.");
  assert.equal(log[0][1].action, "route"); assert.equal(log[0][1].override, false);
  assert.match((await models.select({ provider: "opencode", model: "m2", actor: dev, config: cfg })).content, /not proven/);
  assert.equal(log.length, 1);
  const r = await models.select({ provider: "opencode", model: "m2", override: true, actor: dev, config: cfg });
  assert.match(r.content, /override/); assert.equal(log[1][1].override, true);
  assert.match((await models.select({ provider: "x", model: "y", override: true, actor: dev, config: cfg })).content, /not in the registry/);
});
