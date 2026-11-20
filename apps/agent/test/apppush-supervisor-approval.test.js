"use strict";
// End to end: the private supervisor's approval alert projection (real writer,
// real reader) feeding the real app push dispatcher with an injected APNs
// transport. Covers quiet hours, release afterwards, APNs retry, closing before
// delivery, a dispatcher that was down, staleness, dedupe, an absent Apple
// provider and an unconfigured standalone install. No device or network.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const crypto = require("node:crypto");
const { createLedger } = require("../lib/operator/store");
const { createConversation } = require("../lib/operator/conversation");
const { createAppChannel } = require("../lib/operator/appchannel");
const { createAppPush } = require("../lib/operator/apppush");
const { createAttentionReader } = require("../lib/operator/supervisorattention");
const { createAttention } = require("../../web/keir-supervisor/attention");

const config = { ownerId: "333052320252297216", botId: "1479984768194969663", staffIds: ["2"], taskLifetimeMs: 3600000 };
const NY = { enabled: true, start: "22:00", end: "07:00", tz: "America/New_York" };
const PHONE_A = "a".repeat(64), PHONE_B = "b".repeat(64);
const at = (iso) => Date.parse(iso);
const pid = () => `p_${crypto.randomBytes(8).toString("hex")}`;
// What the supervisor knows about a proposal. Only id, state and createdAt may ever leave it.
const proposal = (createdAt, extra = {}) => { const id = pid(); return { id, state: "pending", createdAt, title: "fix(secret): rotate the private widget", summary: "PRIVATE chat summary", files: ["lib/private.js"], digest: "d".repeat(64), ...extra }; };

function rig({ provider = true, withAttention = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keir-approval-push-"));
  const ledger = createLedger(path.join(tmp, "ledger.json"));
  const app = createAppChannel({ ledger, config, conversation: createConversation({ ledger, config }) });
  const clock = { t: at("2026-11-20T03:00:00Z") }; // 22:00 in New York: inside the quiet window
  const now = () => clock.t;
  const dir = path.join(tmp, "alerts");
  const writer = createAttention({ dir, now });
  const reader = withAttention ? createAttentionReader({ dir, now }) : null;
  const sent = [];
  const transport = { rule: () => ({ status: 200 }) };
  const apns = provider ? { send: async (token, payload, opts) => { sent.push({ phone: token[0], payload, opts }); return transport.rule(token[0], payload); } } : null;
  const push = createAppPush({ ledger, apns, attention: reader, now });
  const proposals = {};
  const add = (p) => { proposals[p.id] = p; writer.sync(proposals); return p; };
  const close = (p, state = "rejected") => { p.state = state; writer.sync(proposals); };
  const to = (phone) => sent.filter((s) => s.phone === phone);
  return { ledger, app, clock, push, writer, proposals, add, close, sent, to, transport, dir };
}

test("one required approval alert: held in quiet hours, released after, retried on APNs failure, never repeated", async () => {
  const r = rig();
  r.app.register(PHONE_A, {}, NY); r.app.register(PHONE_B, {});
  const p = r.add(proposal(r.clock.t));

  await r.push.tick();
  // The phone without quiet hours is alerted at once; the quiet one is held, not dropped.
  assert.equal(r.to("b").length, 1); assert.equal(r.to("a").length, 0);
  const note = r.to("b")[0].payload;
  assert.equal(note.route, "supervisor-proposal"); assert.equal(note.proposal, p.id); assert.equal(note.thread, "owner-supervisor");
  assert.equal(note.aps.category, undefined, "no actions on the lock screen: approval stays in the authenticated app");
  assert.equal(r.to("b")[0].opts.collapseId, `keir-approval-${p.id}`);
  // Nothing from the private conversation or patch is in the payload or the projection file.
  const everything = JSON.stringify(note) + fs.readFileSync(path.join(r.dir, `${p.id}.json`), "utf8");
  for (const secret of ["secret", "PRIVATE", "private.js", "rotate", "d".repeat(16)]) assert.ok(!everything.includes(secret), `leaked ${secret}`);
  assert.deepEqual(Object.keys(note).sort(), ["aps", "proposal", "route", "thread"]);
  assert.equal(Object.values(r.ledger.data.appThread.push.deferred).flat().length, 1);

  // Still quiet and ticking again: no duplicate to anyone, and unrelated churn does not add alerts.
  r.clock.t += 60 * 60000; r.writer.sync(r.proposals);
  await r.push.tick(); await r.push.tick();
  assert.equal(r.sent.length, 1);

  // Quiet hours end (07:30 EST) but Apple is down: the held alert is kept and retried.
  r.clock.t = at("2026-11-20T12:30:00Z");
  r.transport.rule = (phone) => (phone === "a" ? { status: 503, reason: "ServiceUnavailable" } : { status: 200 });
  await r.push.tick();
  assert.equal(r.to("a").length, 1);
  assert.equal(r.ledger.data.appThread.push.lastError.status, 503);
  assert.equal(Object.values(r.ledger.data.appThread.push.deferred).flat().length, 1, "still queued after a failed send");
  r.transport.rule = () => ({ status: 200 });
  await r.push.tick();
  assert.equal(r.to("a").length, 2); assert.equal(r.to("a")[1].payload.proposal, p.id);
  assert.equal(Object.values(r.ledger.data.appThread.push.deferred).flat().length, 0);
  await r.push.tick();
  assert.equal(r.to("a").length, 2); assert.equal(r.to("b").length, 1, "each phone got it exactly once");
});

test("an approval closed while its alert is held back is dropped, not sent", async () => {
  const r = rig();
  r.app.register(PHONE_A, {}, NY);
  const p = r.add(proposal(r.clock.t));
  await r.push.tick();
  assert.equal(r.sent.length, 0);
  r.close(p, "rejected");                      // the owner decided on another device
  r.clock.t = at("2026-11-20T12:30:00Z");
  await r.push.tick();
  assert.equal(r.sent.length, 0);
  assert.equal(Object.values(r.ledger.data.appThread.push.deferred).flat().length, 0);
  assert.equal(r.ledger.data.audit.filter((a) => a.kind === "app_push_deferred_dropped").length, 1);
});

test("a superseded approval is stale; only the newest is alerted when the dispatcher was down", async () => {
  const r = rig();
  r.app.register(PHONE_B, {});
  r.clock.t = at("2026-11-20T15:00:00Z");
  // The dispatcher is down (no tick) while three proposals arrive and two are replaced or decided.
  const older = r.add(proposal(r.clock.t)), replaced = r.add(proposal(r.clock.t + 1000)), newest = r.add(proposal(r.clock.t + 2000));
  r.close(older, "superseded"); r.close(replaced, "superseded");
  await r.push.tick();
  assert.deepEqual(r.sent.map((s) => s.payload.proposal), [newest.id]);
  assert.equal(r.proposals[newest.id].state, "pending");
});

test("an approval nobody acted on for three days no longer wakes a phone", async () => {
  const r = rig();
  r.app.register(PHONE_B, {});
  r.clock.t = at("2026-11-20T15:00:00Z");
  r.add(proposal(r.clock.t - 73 * 3600000));
  await r.push.tick();
  assert.equal(r.sent.length, 0);
});

test("a phone that turned decision alerts off, or has none registered, is not pushed and the approval stays due", async () => {
  const r = rig();
  r.clock.t = at("2026-11-20T15:00:00Z");
  const p = r.add(proposal(r.clock.t));
  await r.push.tick();                          // no phone yet: nothing is marked sent
  assert.equal(r.sent.length, 0);
  assert.match(r.push.status().approvalAlerts.problem, /No phone is registered/);
  r.app.register(PHONE_A, { decisions: false });
  await r.push.tick();
  assert.equal(r.sent.length, 0);
  r.app.register(PHONE_B, {});
  await r.push.tick();
  assert.deepEqual(r.sent.map((s) => [s.phone, s.payload.proposal]), [["b", p.id]]);
});

test("without an Apple provider the app says so, once, and nothing throws", async () => {
  const r = rig({ provider: false });
  r.app.register(PHONE_A, {});
  const p = r.add(proposal(r.clock.t));
  await r.push.tick(); await r.push.tick();
  const status = r.push.status();
  assert.equal(status.configured, false);
  assert.equal(status.approvalAlerts.pending, 1); assert.equal(status.approvalAlerts.undelivered, 1);
  assert.match(status.approvalAlerts.problem, /Apple push is not installed/);
  assert.deepEqual(r.ledger.data.audit.filter((a) => a.kind === "app_attention_no_provider").map((a) => a.proposal), [p.id], "reported once per proposal");
  assert.equal(r.proposals[p.id].state, "pending");
});

test("unconfigured standalone: no projection directory means ordinary app push is untouched", async () => {
  const r = rig({ withAttention: false });
  r.app.register(PHONE_B, {});
  r.add(proposal(r.clock.t));
  await r.push.tick();
  assert.equal(r.sent.length, 0);
  assert.equal(r.push.status().approvalAlerts, undefined);
  assert.equal(createAttentionReader({ dir: "" }), null);
  assert.equal(createAttention({ dir: "" }), null);
  assert.throws(() => createAttention({ dir: "relative/path" }), /absolute/);
  assert.equal(createAttentionReader({ dir: "relative/path" }).pending().length, 0, "a relative path is never read");
});

test("projection files are strictly validated and a foreign or oversized file is ignored", () => {
  const r = rig();
  const good = r.add(proposal(r.clock.t));
  fs.writeFileSync(path.join(r.dir, "p_0000000000000001.json"), JSON.stringify({ version: 1, kind: "supervisor-approval", id: "p_0000000000000002", state: "pending", createdAt: r.clock.t }));
  fs.writeFileSync(path.join(r.dir, "p_0000000000000003.json"), JSON.stringify({ version: 1, kind: "other", id: "p_0000000000000003", state: "pending", createdAt: r.clock.t }));
  fs.writeFileSync(path.join(r.dir, "p_0000000000000004.json"), "x".repeat(5000));
  fs.writeFileSync(path.join(r.dir, "notes.json"), "{}");
  const reader = createAttentionReader({ dir: r.dir, now: () => r.clock.t });
  assert.deepEqual(reader.pending().map((x) => x.id), [good.id]);
  assert.equal(reader.isPending("../etc/passwd"), false);
});
