"use strict";
// Characterization of Keir's job lifecycle: what the scheduling rules in
// lib/operator/lifecycle.js do today, as tables. These pin behavior that moved out of
// operator.js drain() and scan() unchanged. A row that looks odd is pinned on purpose
// and marked ODDITY; changing it is a behavior change, not a cleanup.
const test = require("node:test"), assert = require("node:assert/strict");
const os = require("node:os"), path = require("node:path"), fs = require("node:fs");
const { createLedger } = require("../lib/operator/store");
const lc = require("../lib/operator/lifecycle");

const NOW = 10_000_000_000, MIN = 60000, LIFE = 6 * 3600000;
const config = { taskLifetimeMs: LIFE };
const ctxFor = (over = {}) => ({ now: NOW, config, claimedBy: () => null, directiveHeld: () => false, ...over });
const ticket = (over = {}) => ({ id: "j1", kind: "ticket", role: "support", ticket: 5, channelId: "c1", state: "queued", inbox: [], effects: {}, rounds: 2, deadline: NOW + LIFE, ...over });
const human = { role: "player", authorId: "p1", content: "hello" };
const kinds = (effects) => effects.map((e) => e.type === "audit" ? `audit:${e.kind}` : `notify:${e.key}`);

// job state, holds and mail in; next state and recorded effects out.
const WAKE = [
  // staff claim
  ["staff claim defers a queued ticket", { state: "queued" }, { claim: true }, { state: "deferred", effects: [] }],
  ["staff claim defers a waiting ticket even with mail", { state: "waiting", inbox: [human], wakeAt: 0 }, { claim: true }, { state: "deferred", effects: [] }],
  ["staff claim does not defer an owner-role job", { state: "waiting", role: "owner", inbox: [human], wakeAt: NOW + MIN }, { claim: true }, { state: "queued", effects: [] }],
  ["staff claim does not defer a command", { state: "waiting", kind: "command", inbox: [human], wakeAt: NOW + MIN }, { claim: true }, { state: "queued", effects: [] }],
  ["staff claim does not touch a done ticket", { state: "done" }, { claim: true }, { state: "done", effects: [] }],
  // ODDITY: dismissed is not excluded from the claim rule, so it comes back as deferred.
  ["ODDITY a dismissed ticket under a claim becomes deferred", { state: "dismissed" }, { claim: true }, { state: "deferred", effects: [] }],
  // owner decision
  ["owner decision with no mail blocks", { state: "queued", ownerDecisionPending: true }, {}, { state: "blocked", summary: /outstanding owner decision/, effects: [] }],
  ["owner decision, mail only from system sources, blocks", { state: "waiting", ownerDecisionPending: true, inbox: [{ authorId: "developer-watch" }, { role: "system", authorId: "x" }], wakeAt: 0 }, {}, { state: "blocked", effects: [] }],
  ["owner decision, player mail, wakes the conversation", { state: "waiting", ownerDecisionPending: true, inbox: [human], wakeAt: NOW + MIN }, {}, { state: "queued", effects: ["audit:requeued_for_conversation"] }],
  ["owner decision, player mail, closed channel, stays blocked", { state: "waiting", ownerDecisionPending: true, channelClosed: true, inbox: [human], wakeAt: NOW + MIN }, {}, { state: "blocked", effects: [] }],
  ["owner decision on a done ticket is left alone", { state: "done", ownerDecisionPending: true }, {}, { state: "done", effects: [] }],
  // ODDITY: operator.js humanInbox does not exclude turn-watch mail; the unread watchdog does.
  ["ODDITY turn-watch mail counts as a human message for an owner decision", { state: "blocked", ownerDecisionPending: true, inbox: [{ authorId: "turn-watch" }] }, {}, { state: "queued", effects: ["audit:requeued_for_conversation"] }],
  // resolution stall
  ["resolution recorded 21 min ago, channel still open: blocked and owner told", { state: "queued", resolutionSubmitted: true, resolutionSubmittedAt: NOW - 21 * MIN }, {}, { state: "blocked", summary: /after 20 minutes/, effects: ["notify:close-stalled:j1"] }],
  ["resolution recorded exactly 20 min ago still waits", { state: "queued", resolutionSubmitted: true, resolutionSubmittedAt: NOW - 20 * MIN }, {}, { state: "waiting", effects: [] }],
  ["resolution recorded 5 min ago waits, mail does not wake it", { state: "queued", inbox: [human], resolutionSubmitted: true, resolutionSubmittedAt: NOW - 5 * MIN }, {}, { state: "waiting", effects: [] }],
  ["a blocked job with a resolution is not re-stalled", { state: "blocked", resolutionSubmitted: true, resolutionSubmittedAt: NOW - 99 * MIN }, {}, { state: "blocked", effects: [] }],
  ["a resolved job skips the stall rule", { state: "waiting", wakeAt: 0, resolutionSubmitted: true, resolved: true, resolutionSubmittedAt: NOW - 99 * MIN }, {}, { state: "queued", effects: [] }],
  ["staff claim outranks a resolution stall", { state: "queued", resolutionSubmitted: true, resolutionSubmittedAt: NOW - 99 * MIN }, { claim: true }, { state: "deferred", effects: [] }],
  // dead ends
  ["a probe blocked 61 min is dismissed", { state: "blocked", kind: "probe", ticket: null, updatedAt: NOW - 61 * MIN, summary: "stuck" }, {}, { state: "dismissed", summary: /^Dismissed automatically: a probe or benchmark left blocked\. Was: stuck/, effects: ["audit:job_dismissed"] }],
  ["a probe blocked exactly 60 min is kept", { state: "blocked", internalProbe: true, ticket: null, updatedAt: NOW - 60 * MIN }, {}, { state: "blocked", effects: [] }],
  ["a subworker whose report reached its parent, blocked 31 min, is dismissed", { state: "blocked", kind: "coding", ticket: null, codingParent: "p", codingReported: true, updatedAt: NOW - 31 * MIN }, {}, { state: "dismissed", summary: /its report already reached the parent/, effects: ["audit:job_dismissed"] }],
  ["a subworker whose report has not reached its parent is kept", { state: "blocked", kind: "coding", ticket: null, codingParent: "p", updatedAt: NOW - 99 * MIN }, {}, { state: "blocked", effects: [] }],
  // directive hold
  ["a held directive stops every later rule, wake and deadline included", { state: "waiting", wakeAt: 0, deadline: 1 }, { directive: true }, { state: "waiting", effects: [] }],
  // wake
  ["waiting with wakeAt reached queues and drops debounceWake", { state: "waiting", wakeAt: NOW, debounceWake: true }, {}, { state: "queued", noDebounce: true, effects: [] }],
  ["waiting before wakeAt, no mail, stays", { state: "waiting", wakeAt: NOW + MIN }, {}, { state: "waiting", effects: [] }],
  ["waiting with mail wakes before wakeAt", { state: "waiting", wakeAt: NOW + MIN, inbox: [human] }, {}, { state: "queued", effects: [] }],
  ["waiting with mail but debounceWake set stays", { state: "waiting", wakeAt: NOW + MIN, inbox: [human], debounceWake: true }, {}, { state: "waiting", keepDebounce: true, effects: [] }],
  ["waiting with no wakeAt at all never wakes on time (NaN compare)", { state: "waiting" }, {}, { state: "waiting", effects: [] }],
  ["blocked with mail queues", { state: "blocked", inbox: [human, human] }, {}, { state: "queued", effects: ["audit:requeued_for_inbox"], auditDetail: { messages: 2, ticket: 5 } }],
  ["blocked with mail on a closed channel stays", { state: "blocked", channelClosed: true, inbox: [human] }, {}, { state: "blocked", effects: [] }],
  ["blocked subworker with mail stays", { state: "blocked", codingParent: "p", updatedAt: NOW, inbox: [human] }, {}, { state: "blocked", effects: [] }],
  ["blocked probe with mail stays", { state: "blocked", internalProbe: true, updatedAt: NOW, inbox: [human] }, {}, { state: "blocked", effects: [] }],
  ["blocked with nothing to read stays", { state: "blocked" }, {}, { state: "blocked", effects: [] }],
  ["a paused job is not woken by mail", { state: "paused", inbox: [human] }, {}, { state: "paused", effects: [] }],
  // ODDITY: deferred has no way out in this module; gateway.js and supportowner.js lift it.
  ["ODDITY a deferred job with the claim gone and mail stays deferred here", { state: "deferred", inbox: [human] }, {}, { state: "deferred", effects: [] }],
  // deadline
  ["first deadline expiry extends a queued job", { state: "queued", deadline: NOW - 1 }, {}, { state: "queued", deadline: NOW + LIFE, effects: ["audit:deadline_extended"] }],
  ["first deadline expiry also wakes a waiting job", { state: "waiting", wakeAt: NOW + 99 * MIN, deadline: NOW - 1 }, {}, { state: "queued", effects: ["audit:deadline_extended"] }],
  ["second deadline expiry blocks and tells the owner", { state: "running", deadline: NOW - 1, deadlineExtensions: 1 }, {}, { state: "blocked", summary: /ran out of time twice/, effects: ["notify:deadline:j1"] }],
  ["deadline is not checked on a blocked job", { state: "blocked", deadline: NOW - 1 }, {}, { state: "blocked", effects: [] }],
  ["a deadline exactly now is not expired", { state: "queued", deadline: NOW }, {}, { state: "queued", effects: [] }],
];
for (const [name, fields, holds, want] of WAKE) {
  test(`wakeStep: ${name}`, () => {
    const job = ticket(fields);
    const effects = lc.wakeStep(job, ctxFor({ claimedBy: () => holds.claim ? "staff1" : null, directiveHeld: () => !!holds.directive }));
    assert.equal(job.state, want.state);
    if (want.summary) assert.match(job.summary, want.summary);
    if (want.noDebounce) assert.equal("debounceWake" in job, false);
    if (want.keepDebounce) assert.equal(job.debounceWake, true);
    if (want.deadline) assert.equal(job.deadline, want.deadline);
    assert.deepEqual(kinds(effects), want.effects);
    if (want.auditDetail) assert.deepEqual({ messages: effects[0].detail.messages, ticket: effects[0].detail.ticket }, want.auditDetail);
  });
}

test("wakeStep with a real ledger: stall and deadline notices are quiet alerts, effects land in order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-")), ledger = createLedger(path.join(dir, "l.json"));
  const stalled = ticket({ id: "a", resolutionSubmitted: true, resolutionSubmittedAt: NOW - 30 * MIN });
  const late = ticket({ id: "b", ticket: 6, state: "running", deadline: NOW - 1, deadlineExtensions: 1 });
  const woke = ticket({ id: "c", ticket: 7, state: "blocked", inbox: [human] });
  for (const j of [stalled, late, woke]) lc.applyEffects(ledger, lc.wakeStep(j, ctxFor()));
  assert.deepEqual(ledger.data.alerts.map((a) => a.key), ["close-stalled:a", "deadline:b"]);
  assert.match(ledger.data.alerts[0].content, /^Ticket 5: Resolution is recorded/);
  assert.match(ledger.data.alerts[1].content, /^Task b: Task ran out of time twice/);
  assert.deepEqual(ledger.data.audit.map((a) => a.kind), ["requeued_for_inbox"]);
  assert.equal(ledger.data.audit[0].job, "c");
  assert.deepEqual(ledger.data.outbox, {}, "no owner DM for any of these");
});

// run end: what the catch handler decides
const err = (m) => new Error(m);
const RUN = [
  ["settled job is not an error", { state: "done" }, {}, err("x"), null],
  ["a queued job (restart already requeued it) is not an error", { state: "queued" }, {}, err("x"), null],
  ["a paused job is not an error", { state: "paused" }, {}, err("x"), null],
  ["self-recovery park (waiting) is not an error", { state: "waiting", summary: "Self-recovery: parked" }, {}, err("x"), null],
  ["self-recovery park (blocked) is not an error", { state: "blocked", summary: "Self-recovery: parked" }, {}, err("x"), null],
  ["waiting without the self-recovery prefix is still handled", { state: "waiting", summary: "other" }, {}, err("boom"), { state: "blocked", effects: ["notify:error:j1:2"] }],
  ["abort for an owner pause parks the job and clears wakeAt", { state: "running", wakeAt: 5 }, { aborted: true, pause: true }, err("aborted"), { state: "paused", noWake: true, effects: [] }],
  ["abort while the whole desk is paused waits a minute", { state: "running" }, { aborted: true, paused: true }, err("aborted"), { state: "waiting", wakeAt: NOW + MIN, effects: [] }],
  ["abort for support deferral waits a minute", { state: "running" }, { aborted: true, deferred: true }, err("aborted"), { state: "waiting", wakeAt: NOW + MIN, effects: [] }],
  ["abort for staff activity waits until staff are done if later", { state: "running" }, { aborted: true, staffHeld: true, staffUntil: NOW + 10 * MIN }, err("aborted"), { state: "waiting", wakeAt: NOW + 10 * MIN, effects: [] }],
  ["abort on a staff-claimed non-owner ticket waits", { state: "running" }, { aborted: true, claimed: true }, err("aborted"), { state: "waiting", wakeAt: NOW + MIN, effects: [] }],
  ["abort on a staff-claimed owner-role ticket does not take the hold", { state: "running", role: "owner" }, { aborted: true, claimed: true }, err("aborted"), { state: "blocked", effects: ["notify:error:j1:2"] }],
  ["a stop with no abort still waits (CLI child died first)", { state: "running" }, { stopping: true }, err("child exited"), { state: "waiting", wakeAt: NOW + MIN, effects: [] }],
  ["abort with no hold reason is an error", { state: "running" }, { aborted: true }, err("aborted"), { state: "blocked", summary: "aborted", effects: ["notify:error:j1:2"] }],
  ["a write this activation started makes the abort uncertain: blocked", { state: "running", effects: { w: { state: "started", at: NOW } } }, { aborted: true, paused: true, startedAt: NOW - 1 }, err("aborted"), { state: "blocked", effects: ["notify:error:j1:2"] }],
  ["an older unsettled write does not stop the hold", { state: "running", effects: { w: { state: "started", at: NOW - 99 * MIN } } }, { aborted: true, paused: true, startedAt: NOW - 1 }, err("aborted"), { state: "waiting", wakeAt: NOW + MIN, effects: [] }],
  ["network failure retries after a minute", { state: "running" }, {}, err("fetch failed"), { state: "waiting", wakeAt: NOW + MIN, effects: ["audit:transient_retry"] }],
  ["second network failure retries after two minutes", { state: "running", transientFailures: 1 }, {}, err("ETIMEDOUT"), { state: "waiting", wakeAt: NOW + 2 * MIN, effects: ["audit:transient_retry"] }],
  ["fourth network failure is an error", { state: "running", transientFailures: 3 }, {}, err("fetch failed"), { state: "blocked", effects: ["notify:error:j1:2"] }],
  ["network failure after a started write is an error", { state: "running", effects: { w: { state: "started", at: 1 } } }, {}, err("fetch failed"), { state: "blocked", effects: ["notify:error:j1:2"] }],
  ["empty provider reply waits a minute and tells the owner once an hour", { state: "running" }, {}, err("model request failed: empty activation"), { state: "waiting", wakeAt: NOW + MIN, effects: ["audit:transient_retry", `notify:empty-provider:${Math.floor(NOW / 3600000)}`] }],
  ["second empty reply waits 15 minutes", { state: "running", emptyWaits: 1 }, {}, err("model request failed: empty activation"), { state: "waiting", wakeAt: NOW + 15 * MIN, effects: ["audit:transient_retry", `notify:empty-provider:${Math.floor(NOW / 3600000)}`] }],
  ["host capacity refusal waits 30 seconds", { state: "running" }, {}, err("model request failed: rust runner: resource admission refused: busy"), { state: "waiting", wakeAt: NOW + 30000, effects: ["audit:transient_retry"] }],
  ["quota exhaustion waits 15 minutes", { state: "running" }, {}, err("quota exhausted"), { state: "waiting", wakeAt: NOW + 15 * MIN, effects: ["audit:transient_retry"] }],
  ["any other error blocks the job and tells the owner", { state: "running" }, {}, err("tool exploded"), { state: "blocked", summary: "tool exploded", effects: ["notify:error:j1:2"] }],
  ["a command with a reply channel also tells the channel", { state: "running", kind: "command", ticket: null, replyChannel: "r1" }, {}, err("tool exploded"), { state: "blocked", effects: ["notify:error:j1:2", "notify:error-reply:j1:2"] }],
  ["a command with no reply channel does not", { state: "running", kind: "command", ticket: null }, {}, err("tool exploded"), { state: "blocked", effects: ["notify:error:j1:2"] }],
];
for (const [name, fields, h, e, want] of RUN) {
  test(`onRunError: ${name}`, () => {
    const job = ticket(fields);
    const out = lc.onRunError(job, e, { now: NOW, aborted: !!h.aborted, stopping: !!h.stopping, paused: !!h.paused, startedAt: h.startedAt ?? NOW - 1,
      supportDeferred: () => !!h.deferred, staffHeld: () => !!h.staffHeld, claimedBy: () => h.claimed ? "staff1" : null,
      pauseFor: () => h.pause ? { ticket: 5 } : null, staffActiveUntil: () => h.staffUntil || 0, redact: (t) => t });
    if (want === null) { assert.equal(out, null); return; }
    assert.equal(job.state, want.state);
    if (want.summary) assert.equal(job.summary, want.summary);
    if (want.wakeAt) assert.equal(job.wakeAt, want.wakeAt);
    if (want.noWake) assert.equal("wakeAt" in job, false);
    assert.deepEqual(kinds(out.effects), want.effects);
  });
}

test("onRunError redacts the message it stores and sends", () => {
  const job = ticket({ state: "running" });
  const out = lc.onRunError(job, err("token sk-abc leaked"), { now: NOW, startedAt: 0, supportDeferred: () => false, staffHeld: () => false, claimedBy: () => null, pauseFor: () => null, staffActiveUntil: () => 0, redact: (t) => t.replace("sk-abc", "[redacted]") });
  assert.equal(job.summary, "token [redacted] leaked");
  assert.equal(out.effects[0].content, "Task j1 stopped: token [redacted] leaked");
});

// scan: closed-channel sweep
const sweepCtx = (over = {}) => ({ liveChannels: new Set(["live"]), readTicket: async () => ({ status: "open" }), channelGone: async () => false, ...over });
const SWEEP = [
  ["a ticket whose channel is still in the guild list is left alone", { channelId: "live" }, {}, { closed: false, state: "waiting" }],
  ["a job with no ticket number is never swept", { ticket: null, channelId: "gone" }, { gone: true }, { closed: false, state: "waiting" }],
  ["a done ticket is not swept again", { state: "done", channelId: "gone" }, { gone: true }, { closed: false, state: "done" }],
  ["a channel missing from the list but still there on Discord stays open", { channelId: "gone" }, { gone: false }, { closed: false, state: "waiting" }],
  ["a channel Discord reports gone closes the job", { channelId: "gone" }, { gone: true }, { closed: true, state: "done", summary: /closed externally/, channelClosed: true }],
  ["a gone channel with a recorded resolution is a verified close", { channelId: "gone", resolutionSubmitted: true }, { gone: true }, { closed: true, state: "done", summary: /closure verified/, resolved: true }],
  ["a blocked job whose channel is gone is closed too", { channelId: "gone", state: "blocked" }, { gone: true }, { closed: true, state: "done" }],
  // ODDITY: only done and cancelled are skipped, so a dismissed ticket flips to done.
  ["ODDITY a dismissed ticket whose channel is gone becomes done", { channelId: "gone", state: "dismissed" }, { gone: true }, { closed: true, state: "done" }],
  ["a channel-less ticket the support record shows closed ends", { channelId: null }, { status: "closed" }, { closed: true, state: "done", channelClosed: true, effects: ["audit:ticket_closed_without_channel"] }],
  ["a channel-less ticket resolved or merged ends too", { channelId: null }, { status: "merged" }, { closed: true, state: "done", effects: ["audit:ticket_closed_without_channel"] }],
  ["a channel-less ticket still open is kept", { channelId: null }, { status: "in_progress" }, { closed: false, state: "waiting" }],
  ["a channel-less ticket whose record cannot be read is kept", { channelId: null }, { readFails: true }, { closed: false, state: "waiting" }],
];
for (const [name, fields, h, want] of SWEEP) {
  test(`sweepClosedChannel: ${name}`, async () => {
    const job = ticket({ state: "waiting", ...fields });
    const out = await lc.sweepClosedChannel(job, sweepCtx({
      channelGone: async () => !!h.gone,
      readTicket: async () => { if (h.readFails) throw new Error("support down"); return { status: h.status }; } }));
    assert.equal(out.closed, want.closed);
    assert.equal(job.state, want.state);
    if (want.summary) assert.match(job.summary, want.summary);
    if (want.channelClosed) assert.equal(job.channelClosed, true);
    if (want.resolved) assert.equal(job.resolved, true);
    assert.deepEqual(kinds(out.effects), want.effects || []);
  });
}

// scan: adoption
function world(jobs = {}, channels = {}, seen = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-")), ledger = createLedger(path.join(dir, "l.json"));
  Object.assign(ledger.data.jobs, jobs); Object.assign(ledger.data.channels, channels); Object.assign(ledger.data.seen, seen);
  return ledger;
}
const ticketNumber = (name) => Number(/(\d+)$/.exec(name || "")?.[1]) || null;
const adoptCtx = (ledger, over = {}) => ({ ledger, config, now: NOW, ticketNumber, adoptReopened: async () => {}, log: () => {}, ...over });
const ch = { id: "c9", name: "ticket-bug-someone-42" };

test("adoptOpenChannel: an open ticket channel with no task gets a queued support job", async () => {
  const ledger = world();
  await lc.adoptOpenChannel(ch, adoptCtx(ledger));
  const job = ledger.data.jobs[ledger.data.seen["ticket:42"]];
  assert.equal(job.state, "queued"); assert.equal(job.kind, "ticket"); assert.equal(job.role, "support");
  assert.equal(job.ticket, 42); assert.equal(job.channelId, "c9"); assert.equal(job.deadline, NOW + LIFE);
  assert.match(job.source.content, /adopted by the sweep/);
  assert.deepEqual(ledger.data.audit.map((a) => a.kind), ["created", "ticket_adopted_by_sweep"]);
});
const SKIPS = [
  ["not a ticket channel", { id: "c9", name: "general" }, {}],
  ["moderation category, not owner-directed", ch, { channels: { c9: { category: "moderation" } } }],
  ["incident category, not owner-directed", ch, { channels: { c9: { category: "incident" } } }],
  ["staff claimed the channel", ch, { channels: { c9: { claimedBy: "staff1" } } }],
  ["the ticket is already registered", ch, { seen: { "ticket:42": "j9" }, jobs: { j9: ticket({ id: "j9", channelId: "c9" }) } }],
];
for (const [name, channel, w] of SKIPS) {
  test(`adoptOpenChannel: skips ${name}`, async () => {
    const ledger = world(w.jobs, w.channels, w.seen), before = Object.keys(ledger.data.jobs).length;
    await lc.adoptOpenChannel(channel, adoptCtx(ledger));
    assert.equal(Object.keys(ledger.data.jobs).length, before);
  });
}
test("adoptOpenChannel: an owner-directed moderation channel is adopted", async () => {
  const ledger = world({}, { c9: { category: "moderation", ownerDirectedAt: 1 } });
  await lc.adoptOpenChannel(ch, adoptCtx(ledger));
  assert.ok(ledger.data.seen["ticket:42"]);
});
test("adoptOpenChannel: a live task already on the channel is registered, not duplicated (ticket 1757)", async () => {
  const ledger = world({ h: ticket({ id: "h", ticket: null, channelId: "c9" }) });
  await lc.adoptOpenChannel(ch, adoptCtx(ledger));
  assert.equal(ledger.data.seen["ticket:42"], "h");
  assert.equal(Object.keys(ledger.data.jobs).length, 1);
});
test("adoptOpenChannel: a handed-off job with no channel gets this one", async () => {
  const ledger = world({ j9: ticket({ id: "j9", ticket: 42, channelId: null, source: { content: "x" } }) }, {}, { "ticket:42": "j9" });
  await lc.adoptOpenChannel(ch, adoptCtx(ledger));
  const j = ledger.data.jobs.j9;
  assert.equal(j.channelId, "c9"); assert.equal(j.replyChannel, "c9");
  assert.deepEqual(j.source, { content: "x", channelId: "c9", channelName: ch.name });
});
test("adoptOpenChannel: a closed ticket seen again in a new channel is handed to reopened-ticket adoption; its failure is only logged", async () => {
  const ledger = world({ j9: ticket({ id: "j9", ticket: 42, channelId: "old", channelClosed: true, state: "done" }) }, {}, { "ticket:42": "j9" });
  const calls = [], logs = [];
  await lc.adoptOpenChannel(ch, adoptCtx(ledger, { adoptReopened: async (n, c) => { calls.push([n, c.id]); throw new Error("nope"); }, log: (t) => logs.push(t) }));
  assert.deepEqual(calls, [[42, "c9"]]);
  assert.deepEqual(logs, ["reopened ticket 42: nope"]);
});

const card = { id: "m1", author: { id: "bot" }, embeds: [{}], timestamp: "2026-11-01T00:00:00Z" };
const intakeCfg = { botId: "bot", taskLifetimeMs: LIFE };
test("adoptFromIntake: a new ticket with only the intake card gets a job", () => {
  const ledger = world(), job = lc.adoptFromIntake(ledger, ch, [card], { staff: null, category: "bug", number: 42, config: intakeCfg, now: NOW });
  assert.equal(job.summary, "New ticket needs investigation.");
  assert.equal(job.source.at, card.timestamp); assert.equal(job.deadline, NOW + LIFE); assert.equal(ledger.data.seen["ticket:42"], job.id);
});
for (const [name, args, w] of [
  ["a staff claim", { staff: { author: { id: "s" } }, category: "bug" }, {}],
  ["a recorded claim", { staff: null, category: "bug" }, { channels: { c9: { claimedBy: "s" } } }],
  ["moderation", { staff: null, category: "moderation" }, {}],
  ["incident", { staff: null, category: "incident" }, {}],
  ["an existing job", { staff: null, category: "bug" }, { seen: { "ticket:42": "j9" } }],
  ["no intake card", { staff: null, category: "bug", rows: [{ id: "m", author: { id: "p" } }] }, {}],
]) {
  test(`adoptFromIntake: no job for ${name}`, () => {
    const ledger = world({}, w.channels, w.seen);
    assert.equal(lc.adoptFromIntake(ledger, ch, args.rows || [card], { staff: args.staff, category: args.category, number: 42, config: intakeCfg, now: NOW }), null);
    assert.deepEqual(ledger.data.jobs, {});
  });
}
