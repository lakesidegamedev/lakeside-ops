"use strict";
// Keir 11.2 item 5: one ask per item across jobs. Fixtures: ticket 1859 (two jobs prepared the same bond pool repair and
// the owner approved both) and PR 6947 (approved twice, from the job that wrote it and from an owner-wait job).
const test = require("node:test");
const assert = require("node:assert");
const { openDecision, createDecisions, askKey } = require("../lib/operator/decisions");

const OWNER = "100000000000000001", DELEGATE = "100000000000000002", BOT = "100000000000000003";

function setup() {
  const data = { jobs: {}, actions: {}, decisions: {}, outbox: {}, audit: [] };
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify(key, dest, content, extra = {}) { data.outbox[key] ||= { destination: dest, content, ...extra }; } };
  const config = { ownerId: OWNER, staffIds: [DELEGATE], botId: BOT };
  const messages = {};
  const discord = async (method, route, body) => {
    const id = route.split("/").pop();
    if (method === "GET") return messages[id];
    if (method === "PATCH") { messages[id] = { ...messages[id], content: body.content }; return messages[id]; }
    if (method === "DELETE") { messages[id] = { deleted: true }; return null; }
  };
  const decisions = createDecisions({ ledger, config, discord });
  const job = (id, extra = {}) => (data.jobs[id] = { id, state: "waiting", kind: "ticket", ...extra });
  const action = (id, jobId, kind, args) => (data.actions[id] = { id, jobId, kind, args, state: "pending", at: Date.now(), expiresAt: Date.now() + 86400000 });
  const asks = () => Object.keys(data.outbox).filter((k) => k.startsWith("ask:"));
  return { data, ledger, config, messages, decisions, job, action, asks };
}
// The 1859 repair: same dry-run plan, different free-text descriptions from two jobs.
const plan = (description) => ({ spec: { kind: "adhoc", env: "prod", collection: "bondMarketPools", filter: { currency: "USD" }, action: { kind: "set", set: { cashLocal: 1380000000000 } }, description }, planDigest: "5d1c0a" });

test("ticket 1859: a second job preparing the same repair joins the open ask instead of sending another", async () => {
  const t = setup();
  t.job("j2dd", { ticket: 1859 }); t.job("jd53", { ticket: 1859 });
  t.action("e528", "j2dd", "heal", plan("Restore the USD bond market's missing opening cash."));
  t.action("3fc7", "jd53", "heal", plan("Ticket 1859, USD bond market: restore the missing opening cash."));
  assert.equal(askKey(t.data, { actionId: "e528" }), askKey(t.data, { actionId: "3fc7" }));
  const first = openDecision(t.ledger, t.config, { jobId: "j2dd", actionId: "e528", question: "Restore the USD bond pool cash", signoff: true });
  const second = openDecision(t.ledger, t.config, { jobId: "jd53", actionId: "3fc7", question: "Restore the USD bond pool cash", signoff: true });
  assert.equal(second.id, first.id);
  assert.equal(t.asks().length, 1, "one DM to the owner");
  assert.deepEqual(first.followers.map((f) => f.jobId), ["jd53"]);
  // The owner approves once: the asking job runs it; the joined job is told and its own copy is retired.
  const entry = t.data.outbox[t.asks()[0]];
  t.messages.m1 = { id: "m1", author: { id: BOT }, content: entry.content + `\n\n**Decision:** ✅ Approved by <@${OWNER}> <t:1:R>` };
  first.sent[OWNER] = { channelId: "dm", messageId: "m1", content: entry.content };
  assert.equal(await t.decisions.check(first), true);
  assert.equal(t.data.actions.e528.state, "approved");
  assert.equal(t.data.actions["3fc7"].state, "superseded");
  assert.equal(t.data.jobs.jd53.state, "queued");
  assert.match(t.data.jobs.jd53.inbox.at(-1).content, /another Keir task asked about.*Do not ask again/s);
  // A third ask for the same plan from the second job, while the approval is still being carried out, is refused.
  t.action("e278", "jd53", "heal", plan("again"));
  assert.throws(() => openDecision(t.ledger, t.config, { jobId: "jd53", actionId: "e278", question: "Restore the USD bond pool cash", signoff: true }), /already approved this exact request on another Keir task/);
  assert.equal(t.data.actions.e278.state, "superseded");
  assert.equal(t.asks().length, 1);
});

test("a changed repair plan (new numbers after a turn) is a new ask", () => {
  const t = setup();
  t.job("a"); t.job("b");
  t.action("p1", "a", "heal", plan("x"));
  t.action("p2", "b", "heal", { ...plan("x"), planDigest: "after-turn-64" });
  const one = openDecision(t.ledger, t.config, { jobId: "a", actionId: "p1", question: "Repair", signoff: true });
  const two = openDecision(t.ledger, t.config, { jobId: "b", actionId: "p2", question: "Repair", signoff: true });
  assert.notEqual(one.id, two.id);
});

test("PR 6947: the job that wrote it and an owner-wait job produce one ask; a new head replaces it", () => {
  const t = setup();
  t.job("ab34", { kind: "finding" }); t.job("fdd4", { kind: "command", internalProbe: true, ownerWaitPr: 6947 });
  const merge = (head) => ({ action: "merge", number: 6947, head, repository: "lakesidegamedev/AHDGame", summary: "s" });
  t.action("11b9", "ab34", "github", merge("e613506c"));
  t.action("6ced", "fdd4", "github", merge("e613506c"));
  const a = openDecision(t.ledger, t.config, { jobId: "ab34", actionId: "11b9", question: "Merge?", signoff: true });
  const b = openDecision(t.ledger, t.config, { jobId: "fdd4", actionId: "6ced", question: "Merge?", signoff: true });
  assert.equal(a.id, b.id);
  assert.equal(t.asks().length, 1);
  // After a push, the owner-wait job asks for the new head: the old ask is superseded, one live question remains.
  t.action("7aaa", "fdd4", "github", merge("0c89e032"));
  const c = openDecision(t.ledger, t.config, { jobId: "fdd4", actionId: "7aaa", question: "Merge?", signoff: true });
  assert.notEqual(c.id, a.id);
  assert.equal(a.state, "superseded");
  assert.equal(t.data.actions["11b9"].state, "superseded");
  assert.equal(Object.values(t.data.decisions).filter((x) => x.state === "pending").length, 1);
});

test("a bound PR question and an action approval for the same PR share the key", () => {
  const t = setup();
  t.action("g", "j", "github", { action: "merge", number: 7001, head: "h" });
  assert.equal(askKey(t.data, { binds: { number: 7001, head: "h" } }), askKey(t.data, { actionId: "g" }));
  assert.equal(askKey(t.data, { binds: { number: 7001 } }), "pr:AHDGame:7001");
});

// ---- Third pass: the review's M3, m7 and m1 ----
test("M3: an approval whose task has ended does not block a new ask, so the merge can still happen", async () => {
  const t = setup();
  t.job("taskA", { ticket: 1900 }); t.job("taskB", { ticket: 1900 });
  const merge = { action: "merge", number: 6947, head: "e613506c", repository: "lakesidegamedev/AHDGame", summary: "s" };
  t.action("aa", "taskA", "github", merge);
  const first = openDecision(t.ledger, t.config, { jobId: "taskA", actionId: "aa", question: "Merge?", signoff: true });
  first.state = "approve"; first.answeredAt = Date.now(); t.data.actions.aa.state = "approved";
  // Task A ends on its deadline before it executes the merge.
  t.data.jobs.taskA.state = "cancelled";
  t.action("bb", "taskB", "github", merge);
  const second = openDecision(t.ledger, t.config, { jobId: "taskB", actionId: "bb", question: "Merge?", signoff: true });
  assert.notEqual(second.id, first.id);
  assert.equal(second.state, "pending");
  assert.equal(t.data.actions.bb.state, "pending", "task B's action is not superseded");
  // While the approving task is alive the duplicate is still refused.
  t.data.jobs.taskA.state = "waiting"; second.state = "withdrawn";
  t.action("cc", "taskB", "github", merge);
  assert.throws(() => openDecision(t.ledger, t.config, { jobId: "taskB", actionId: "cc", question: "Merge?", signoff: true }), /already approved this exact request/);
});

test("m7: the task whose question a new head replaced follows the new question and hears how it ends", async () => {
  const t = setup();
  t.job("ab34", { kind: "finding", ownerDecisionPending: true }); t.job("fdd4", { kind: "command", internalProbe: true });
  const merge = (head) => ({ action: "merge", number: 6947, head, repository: "lakesidegamedev/AHDGame", summary: "s" });
  t.action("11b9", "ab34", "github", merge("e613506c"));
  const a = openDecision(t.ledger, t.config, { jobId: "ab34", actionId: "11b9", question: "Merge?", signoff: true });
  t.action("7aaa", "fdd4", "github", merge("0c89e032"));
  const c = openDecision(t.ledger, t.config, { jobId: "fdd4", actionId: "7aaa", question: "Merge?", signoff: true });
  assert.equal(a.state, "superseded");
  assert.deepEqual(c.followers.map((f) => f.jobId), ["ab34"]);
  c.state = "withdrawn"; c.withdrawnReason = "merged on GitHub";
  await t.decisions.tick();
  assert.equal(t.data.jobs.ab34.state, "queued");
  assert.match(t.data.jobs.ab34.inbox.at(-1).content, /ended \(withdrawn: merged on GitHub\)/);
});

test("m1: releasing followers never requeues a job blocked for a person", async () => {
  const t = setup();
  t.job("lead"); t.job("stuck", { state: "blocked", summary: "uncertain write" }); t.job("onq", { state: "blocked", ownerDecisionPending: true });
  t.data.decisions.q = { id: "q", jobId: "lead", state: "withdrawn", question: "Merge?", sent: {}, followers: [{ jobId: "stuck", at: 1 }, { jobId: "onq", at: 1 }] };
  await t.decisions.tick();
  assert.equal(t.data.jobs.stuck.state, "blocked");
  assert.equal(t.data.jobs.onq.state, "queued");
});

test("first start: an owner sentence 11.1 took as an answer keeps its DM buttons; an 11.2 channel answer is closed out", async () => {
  const t = setup();
  t.job("j");
  t.data.decisions.old = { id: "old", jobId: "j", state: "answered", answeredVia: "ticket_channel", question: "Raise the cap?", sent: { [OWNER]: { channelId: "dm", messageId: "m-old" } } };
  t.data.decisions.neu = { id: "neu", jobId: "j", state: "answered", answeredVia: "ticket_channel_option", answeredBy: OWNER, question: "Keep the cap?", sent: { [DELEGATE]: { channelId: "dm2", messageId: "m-new" } } };
  t.messages["m-old"] = { content: "old" }; t.messages["m-new"] = { content: "new" };
  await t.decisions.tick();
  assert.equal(t.messages["m-old"].content, "old", "untouched");
  assert.notEqual(t.messages["m-new"].content, "new");
});

test("N7: the one-ask rule has a switch; off, a second task asks as before; preview records it and still asks", () => {
  const { openDecision } = require("../lib/operator/decisions");
  const { staticControls } = require("../lib/operator/controls");
  for (const [mode, previewed] of [["off", false], ["preview", true]]) {
    const data = { jobs: { j1: { id: "j1", state: "waiting" }, j2: { id: "j2", state: "running" } }, actions: {}, decisions: {}, outbox: {}, audit: [] };
    const ledger = { data, save() {}, audit() {}, notify() {} };
    const config = { ownerId: "o", staffIds: [], controls: staticControls({ oneAsk: mode }) };
    const binds = { repository: "lakesidegamedev/AHDGame", number: 7001, head: "h1" };
    const a = openDecision(ledger, config, { jobId: "j1", question: "Merge PR 7001?", binds, signoff: true });
    const b = openDecision(ledger, config, { jobId: "j2", question: "Merge PR 7001?", binds, signoff: true });
    assert.notEqual(a.id, b.id, mode);
    assert.equal(a.state, "pending");
    assert.equal(Boolean(data.preview?.items && Object.keys(data.preview.items).some((k) => k.startsWith("one-ask:"))), previewed);
  }
});

test("suspicion 5: a pending ask whose task ended is replaced, not joined", () => {
  const { openDecision } = require("../lib/operator/decisions");
  const data = { jobs: { j1: { id: "j1", state: "dismissed" }, j2: { id: "j2", state: "running" } }, actions: {}, decisions: {}, outbox: {}, audit: [] };
  const ledger = { data, save() {}, audit() {}, notify() {} };
  const binds = { repository: "lakesidegamedev/AHDGame", number: 7001, head: "h1" };
  const a = openDecision(ledger, { ownerId: "o", staffIds: [] }, { jobId: "j1", question: "Merge PR 7001?", binds, signoff: true });
  const b = openDecision(ledger, { ownerId: "o", staffIds: [] }, { jobId: "j2", question: "Merge PR 7001?", binds, signoff: true });
  assert.notEqual(a.id, b.id);
  assert.equal(a.state, "superseded");
  assert.match(a.withdrawnReason, /task that asked it ended/);
});
