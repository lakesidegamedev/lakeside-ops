"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createConversation } = require("../lib/operator/conversation");
const { createAppChannel } = require("../lib/operator/appchannel");
const { createAppPush, duePushes } = require("../lib/operator/apppush");
const { quietNow, normalizeQuiet } = require("../lib/operator/quiethours");

const config = { ownerId: "333052320252297216", botId: "1479984768194969663", staffIds: ["2"], taskLifetimeMs: 3600000 };
const NY = { enabled: true, start: "22:00", end: "07:00", tz: "America/New_York" };
const A = "a".repeat(64), B = "b".repeat(64);
const at = (iso) => Date.parse(iso);

function setup(file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-quiet-")), "ledger.json")) {
  const ledger = createLedger(file);
  const app = createAppChannel({ ledger, config, conversation: createConversation({ ledger, config }) });
  return { ledger, app, file };
}
// A support-origin approval (ticket job) and an owner-app one, in the one decisions collection.
function seed(ledger, now) {
  const d = ledger.data;
  d.appThread ||= {}; d.appThread.push = { seq: 0, decisions: {}, alerts: {}, since: 0 };
  d.jobs.t1 = { id: "t1", kind: "ticket", role: "support", ticket: 1832, state: "waiting", source: {} };
  d.jobs.o1 = { id: "o1", kind: "command", role: "owner", state: "waiting", source: {} };
  d.decisions = {
    sup000000001: { id: "sup000000001", jobId: "t1", ticket: 1832, question: "Credit the player?", state: "pending", at: now, sent: {}, review: { title: "Change live game data" } },
    own000000001: { id: "own000000001", jobId: "o1", question: "Merge PR 4180?", state: "pending", at: now, sent: {} },
  };
}
const apnsFor = (calls, rule = () => ({ status: 200 })) => ({ send: async (token, payload) => { calls.push({ device: token[0], payload }); return rule(token[0], payload); } });

test("quiet hours are read in the chosen zone, overnight, and across both DST changes", () => {
  // 22:00 to 07:00 New York. EDT in October, EST after the 2026-11-01 fall back.
  assert.equal(quietNow(NY, at("2026-10-15T02:30:00Z")), true);   // 22:30 EDT
  assert.equal(quietNow(NY, at("2026-10-15T14:00:00Z")), false);  // 10:00 EDT
  assert.equal(quietNow(NY, at("2026-10-15T11:00:00Z")), false);  // 07:00 EDT, end is exclusive
  assert.equal(quietNow(NY, at("2026-10-15T10:59:00Z")), true);   // 06:59 EDT
  assert.equal(quietNow(NY, at("2026-11-20T11:30:00Z")), true);   // 06:30 EST
  assert.equal(quietNow(NY, at("2026-11-20T12:00:00Z")), false);  // 07:00 EST
  // Fall back 2026-11-01 02:00 EDT -> 01:00 EST: wall clock decides, so 00:30 and 06:30 are quiet either side of it.
  assert.equal(quietNow(NY, at("2026-11-01T04:30:00Z")), true);   // 00:30 EDT
  assert.equal(quietNow(NY, at("2026-11-01T11:30:00Z")), true);   // 06:30 EST
  assert.equal(quietNow(NY, at("2026-11-01T12:00:00Z")), false);  // 07:00 EST
  // Spring forward 2026-03-08: 02:00 EST does not exist. 06:30 EDT is still quiet, 07:00 EDT is not.
  assert.equal(quietNow(NY, at("2026-03-08T10:30:00Z")), true);
  assert.equal(quietNow(NY, at("2026-03-08T11:00:00Z")), false);
  // Same instant, other zone.
  assert.equal(quietNow({ ...NY, tz: "Asia/Tokyo" }, at("2026-10-15T14:00:00Z")), true); // 23:00 JST
  // Same-day window.
  assert.equal(quietNow({ enabled: true, start: "13:00", end: "15:00", tz: "UTC" }, at("2026-10-15T14:00:00Z")), true);
  assert.equal(quietNow({ enabled: true, start: "13:00", end: "15:00", tz: "UTC" }, at("2026-10-15T15:00:00Z")), false);
});

test("quiet hours are off by default and bad input never creates a silent window", () => {
  assert.equal(quietNow(undefined, at("2026-10-15T03:00:00Z")), false);
  assert.equal(quietNow({ enabled: false, start: "00:00", end: "23:00", tz: "UTC" }, at("2026-10-15T03:00:00Z")), false);
  for (const bad of [{ ...NY, tz: "Mars/Base" }, { ...NY, start: "25:00" }, { ...NY, end: "22:00" }, { ...NY, enabled: "yes" }, "22:00-07:00"]) {
    assert.deepEqual(normalizeQuiet(bad), { enabled: false }, JSON.stringify(bad));
  }
});

test("registration stores the window per device and an older app build does not wipe it", () => {
  const { app, ledger } = setup();
  assert.equal(app.register(A, {}).quiet.enabled, false);
  app.register(A, {}, NY); app.register(B, {});
  const devices = () => Object.fromEntries(ledger.data.appThread.devices.map((x) => [x.token[0], x.quiet]));
  assert.deepEqual(devices().a, NY); assert.equal(devices().b, undefined);
  app.register(A, { replies: false });                       // omits quiet: keeps it
  assert.deepEqual(devices().a, NY);
  app.register(A, {}, { enabled: false });                    // explicit off clears it
  assert.equal(devices().a.enabled, false);
});

test("a support approval reaches the phone with its exact decision id, once, and owner approvals still do", async () => {
  const { ledger, app } = setup();
  app.register(A, {});
  const now = at("2026-10-15T14:00:00Z");
  seed(ledger, now);
  const calls = [];
  const push = createAppPush({ ledger, now: () => now, apns: apnsFor(calls) });
  await push.tick(); await push.tick();
  const byId = Object.fromEntries(calls.map((c) => [c.payload.decision, c.payload]));
  assert.deepEqual(Object.keys(byId).sort(), ["own000000001", "sup000000001"]);
  assert.equal(calls.length, 2, "each approval is sent once");
  assert.equal(byId.sup000000001.route, "decision"); assert.equal(byId.sup000000001.ticket, 1832);
  assert.match(byId.sup000000001.aps.alert.title, /ticket 1832/);
  assert.match(byId.sup000000001.aps.alert.body, /Change live game data: Credit the player/);
  assert.equal(byId.own000000001.ticket, undefined);
  // Delivery changed nothing about the decision itself.
  assert.equal(ledger.data.decisions.sup000000001.state, "pending");
  assert.equal(ledger.data.decisions.sup000000001.answeredBy, undefined);
});

test("approvals that cannot be answered are not pushed, and push once they can", () => {
  const { ledger } = setup();
  const now = at("2026-10-15T14:00:00Z");
  seed(ledger, now);
  ledger.data.jobs.o1.state = "done";                         // task ended
  ledger.data.decisions.sup000000001.actionId = "missing";    // no bound action: obsolete
  assert.deepEqual(duePushes(ledger.data, { now }).filter((p) => p.pref === "decisions"), []);
  ledger.data.jobs.o1.state = "waiting"; delete ledger.data.decisions.sup000000001.actionId;
  assert.deepEqual(duePushes(ledger.data, { now }).map((p) => p.decision).sort(), ["own000000001", "sup000000001"]);
});

test("a quiet phone defers while another phone gets it now, and resume sends only what is still pending", async () => {
  const { ledger, app } = setup();
  app.register(A, {}, NY); app.register(B, {});
  const t0 = at("2026-10-15T03:00:00Z");                     // 23:00 EDT: A is quiet
  seed(ledger, t0);
  let clock = t0;
  const calls = [];
  const push = createAppPush({ ledger, now: () => clock, apns: apnsFor(calls) });
  await push.tick();
  assert.deepEqual(calls.map((c) => c.device), ["b", "b"], "the awake phone is not delayed");
  assert.equal(ledger.data.appThread.push.deferred[Object.keys(ledger.data.appThread.push.deferred)[0]].length, 2);
  // Overnight the owner answers one approval elsewhere. Quiet still holds.
  ledger.data.decisions.own000000001.state = "approve";
  clock = at("2026-10-15T10:59:00Z");
  await push.tick();
  assert.equal(calls.length, 2, "nothing is delivered during quiet hours");
  // 07:00 EDT: quiet ends. The answered one is suppressed, the pending one arrives, exactly once.
  clock = at("2026-10-15T11:00:00Z");
  await push.tick(); await push.tick();
  assert.deepEqual(calls.slice(2).map((c) => [c.device, c.payload.decision]), [["a", "sup000000001"]]);
  assert.deepEqual(Object.values(ledger.data.appThread.push.deferred).flat(), []);
  assert.ok(ledger.data.audit.some((e) => e.kind === "app_push_deferred_dropped" && e.key === "decision:own000000001"));
});

test("the deferred approval and its receipts survive a restart, and a failed send is retried", async () => {
  const first = setup();
  first.app.register(A, {}, NY); first.app.register(B, {});
  const t0 = at("2026-10-15T03:00:00Z");
  seed(first.ledger, t0);
  let clock = t0;
  await createAppPush({ ledger: first.ledger, now: () => clock, apns: apnsFor([]) }).tick();
  // New process, same ledger file.
  const second = setup(first.file);
  const queued = Object.values(second.ledger.data.appThread.push.deferred).flat();
  assert.deepEqual(queued.map((e) => e.decision).sort(), ["own000000001", "sup000000001"]);
  assert.equal(duePushes(second.ledger.data, { now: clock }).length, 0, "no duplicate for the phone that already has it");
  clock = at("2026-10-15T11:05:00Z");
  const calls = []; let fail = true;
  const push = createAppPush({ ledger: second.ledger, now: () => clock, apns: apnsFor(calls, () => fail ? { status: 503 } : { status: 200 }) });
  await push.tick();
  assert.equal(Object.values(second.ledger.data.appThread.push.deferred).flat().length, 2, "kept for retry after a rejection");
  fail = false;
  await push.tick();
  assert.equal(calls.filter((c) => c.device === "a" && c.payload.aps.alert.body).length, 3, "one failed attempt, then both approvals sent");
  const third = setup(first.file);
  assert.deepEqual(Object.values(third.ledger.data.appThread.push.deferred).flat(), [], "receipts persisted: a later restart sends nothing");
  clock += 60000; fail = false; calls.length = 0;
  await createAppPush({ ledger: third.ledger, now: () => clock, apns: apnsFor(calls) }).tick();
  assert.equal(calls.length, 0);
});

test("a decision that is still open but not answerable stays queued instead of being lost", async () => {
  const { ledger, app } = setup();
  app.register(A, {}, NY);
  const t0 = at("2026-10-15T03:00:00Z");
  seed(ledger, t0);
  let clock = t0;
  const calls = [];
  const push = createAppPush({ ledger, now: () => clock, apns: apnsFor(calls) });
  await push.tick();
  ledger.data.paused = true;                                  // Keir paused overnight
  clock = at("2026-10-15T12:00:00Z");
  await push.tick();
  assert.equal(calls.length, 0);
  assert.equal(Object.values(ledger.data.appThread.push.deferred).flat().length, 2);
  ledger.data.paused = false;
  await push.tick();
  assert.equal(calls.length, 2);
});

test("progress updates never push, quiet hours or not (owner rule 2026-11-23: status goes to the digest)", async () => {
  const { ledger, app } = setup();
  app.register(A, {}, NY);
  const t0 = at("2026-10-15T03:00:00Z");
  ledger.data.appThread.push = { seq: 0, decisions: {}, alerts: {}, since: 0 };
  const t = ledger.data.appThread;
  t.messages = [1, 2, 3].map((n) => ({ seq: n, role: "keir", text: `Update ${n}`, update: true, thread: "main" }));
  t.seq = 3;
  let clock = t0;
  const calls = [];
  const push = createAppPush({ ledger, now: () => clock, apns: apnsFor(calls) });
  await push.tick();
  clock = at("2026-10-15T11:30:00Z");
  await push.tick();
  assert.equal(calls.length, 0);
});

test("removing a dead device discards its queue", async () => {
  const { ledger, app } = setup();
  app.register(A, {}, NY);
  const t0 = at("2026-10-15T03:00:00Z");
  seed(ledger, t0);
  let clock = t0;
  const push = createAppPush({ ledger, now: () => clock, apns: apnsFor([], () => ({ status: 410, reason: "Unregistered" })) });
  await push.tick();
  clock = at("2026-10-15T11:30:00Z");
  await push.tick();
  assert.equal(ledger.data.appThread.devices.length, 0);
  assert.deepEqual(ledger.data.appThread.push.deferred, {});
});
