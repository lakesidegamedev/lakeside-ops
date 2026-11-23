"use strict";
// Owner rule 2026-11-23: Keir interrupts the owner only for real decisions, in plain words; everything else goes to the
// daily digest or nowhere. Waiting tickets handed back by developer agents are Keir's and are never escalated.
// Synthetic data only.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const policy = require("../lib/operator/ownerpolicy");
const { createLedger } = require("../lib/operator/store");
const { duePushes } = require("../lib/operator/apppush");
const hb = require("../lib/operator/handback");
const { decideTicket } = require("../lib/operator/sweeper");
const { retryBlockedOwnerWork } = require("../lib/operator/releaseretry");
const { setup } = require("./keir10-post.helpers");

const tmpLedger = () => createLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-quiet-")), "ledger.json"));

test("only decisions, the daily digest and direct replies DM the owner; everything else is a digest line", () => {
  const l = tmpLedger();
  l.notify("ask:abc:owner", "owner", "**Choose one** ...");
  l.notify("trust-report:2026-11-23", "owner", "Keir, last 24 hours ...");
  l.notify("finish:job1:3", "owner", "Done: the report is published.");
  for (const k of ["handoff:700", "escalation:1884", "sweeper-owner:1", "ticketwatch:1", "parked:1884", "unread:1883", "pr-blocked:7228", "promise-overdue:1886:x", "findings-expired:1"]) l.notify(k, "owner", `Ticket 1884 needs a person: staff review needed (wake cap) https://github.com/x/y/pull/1`);
  assert.deepEqual(Object.keys(l.data.outbox).sort(), ["ask:abc:owner", "finish:job1:3", "trust-report:2026-11-23"]);
  assert.equal(l.data.alerts.filter((a) => a.digest).length, 9);
});

test("owner text is plain: no links, no wake-cap or receipt jargon; internal errors never reach the lock screen", () => {
  assert.equal(policy.plain("Ticket 1884 needs a person: staff review needed (wake cap) https://github.com/a/b/pull/7"), "Ticket 1884 is waiting: staff review needed (its retry limit)");
  assert.equal(policy.pushBody("This saved app task lacks authenticated origin receipts. Start a new authenticated app task for writes."), policy.BLOCKED_LINE);
  assert.equal(policy.pushBody("Turn 202 ran cleanly."), "Turn 202 ran cleanly.");
});

test("pushes: a scheduled task's error never pushes, decisions do, one quiet brief a day (the 30-minute push loop)", () => {
  const day = Date.parse("2026-11-23T13:00:00Z");
  const err = "This saved app task lacks authenticated origin receipts. Start a new authenticated app task for writes.";
  const d = { decisions: { q1: { id: "q1", state: "pending", at: day, question: "Refund the bond pool?", options: [{ id: "1", label: "Yes" }] } },
    appThread: { seq: 3, messages: [1, 2, 3].map((n) => ({ seq: n, role: "keir", text: err, thread: "main" })),
      feed: [{ id: "b1", kind: "brief", at: day + 1, title: "Morning brief" }, { id: "b2", kind: "brief", at: day + 2, title: "Morning brief" }], push: { seq: 0, decisions: {}, alerts: {}, since: day - 1, feedAt: day - 1 } } };
  const due = duePushes(d, { now: day + 10 });
  const prefs = due.map((p) => p.pref);
  assert.ok(!prefs.includes("replies"), "nothing the owner asked for, so no reply pushes");
  assert.equal(prefs.filter((p) => p === "feed").length, 1, "one brief");
  due.forEach((p) => p.mark());
  assert.equal(duePushes(d, { now: day + 20 }).filter((p) => p.pref === "feed").length, 0);
});

test("a blocked brief or a permission-blocked task is not re-run on every release", () => {
  const now = Date.parse("2026-11-23T14:00:00Z");
  const job = (extra) => ({ id: extra.id, state: "blocked", kind: "command", role: "owner", actorId: "o", updatedAt: now - 3600000, ...extra });
  const data = { jobs: { a: job({ id: "a", appBrief: "scheduled" }), b: job({ id: "b", ownerMuseBlocker: { code: "OWNER_MUSE_UNSUPPORTED" } }), c: job({ id: "c" }) }, decisions: {} };
  assert.deepEqual(retryBlockedOwnerWork(data, { ownerId: "o", releaseId: "r1", now }), ["c"]);
});

test("team_activity is an allowed read for scheduled app tasks (it failed every morning brief since 11-18)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/ownermuse-policy.js"), "utf8");
  assert.match(src.slice(src.indexOf("const READS"), src.indexOf("const PRIVATE")), /"team_activity"/);
});

// ---- hand-backs -----------------------------------------------------------------------------------------------------

const CARD = { id: 255738, tickets: [1892], pull_requests: ["lakesidegamedev/AHDGame#7275"], last_progress_at: "2026-11-23T14:53:22.403Z", assigned_to: "claude:t1892", lane: "now",
  progress_summary: "HANDOFF TO KEIR (owner: waiting tickets go back to Keir). Fix PR #7275 is squash-merged to development as 1574e6a. Still owed: (1) the fix reaching prod. (3) Post the fix-is-live update." };

test("a HANDOFF TO KEIR card is parsed into the ticket, the note and the fix PRs", () => {
  assert.equal(hb.isHandback(CARD), true);
  const h = hb.parse(CARD);
  assert.deepEqual(h.tickets, [1892]); assert.deepEqual(h.prs, [7275]); assert.match(h.note, /^HANDOFF TO KEIR/);
  assert.match(hb.inboxNote(h), /only when Keir has told you the live build contains the fix/);
  assert.match(hb.inboxNote(h), /Never send this ticket to the owner/);
  assert.equal(hb.isHandback({ progress_summary: "Working on the fix." }), false);
});

test("a handed-back ticket that is only waiting is never swept or escalated", () => {
  const now = Date.parse("2026-11-23T20:00:00Z");
  const base = { ticket: 1892, open: true, held: null, running: false, pendingDecision: null, waitingOnPlayer: false, waitingOnDeveloper: true, lastHumanAt: now - 9 * 3600000, lastReplyAt: now - 8 * 3600000,
    lastSubstantiveAt: now - 10 * 3600000, inActiveHours: true, lastActionAt: now - 4 * 3600000, lastActionKind: "investigate_worker", lastEscalationAt: 0, ownQuestion: null, investigationActive: false, lastRunEndedAt: 0 };
  assert.equal(decideTicket(base, now).action, "escalate_owner", "without a hand-back the old path still exists");
  assert.equal(decideTicket({ ...base, handback: { card: 1, waitingOnLive: true } }, now).action, "none");
  assert.equal(decideTicket({ ...base, handback: { card: 1, waitingOnLive: false } }, now).action, "none", "a worker already tried: wait for the player or the build");
  assert.equal(decideTicket({ ...base, ownedElsewhere: "agent" }, now).action, "none", "someone else is on it");
});

// ---- staying quiet when someone already has the ticket (1884) ------------------------------------------------------

test("no worker hand-off, no post and no escalation while another agent posted to the player in the last two hours", async () => {
  const t0 = 10 * 3600000;
  const f = setup({ call: async (s, tool) => tool === "support_get" ? { publicUpdates: [{ at: new Date(t0 - 15 * 60000).toISOString(), message: "Here is what we found about your plant.", delivery: { status: "posted" } }] }
    : tool === "kanban_list" ? [] : { ok: true, delivery: { posted: true, delivery: { status: "posted" } } },
    codingWorkers: () => ({ queueInvestigation: () => { throw new Error("must not dispatch"); } }) });
  assert.equal(await f.broker.escalationCheck(f.job, { wakeCapped: true }), null);
  assert.deepEqual(f.posts(), []);
  assert.equal(f.audits("handoff_quiet_owned").length, 1);
  assert.equal(f.ledger.data.ticketOwners[123].by, "agent");
});

test("a challenge goes to a checking worker with a plain recheck line, not to staff (owner: always a worker)", async () => {
  const asked = [];
  const f = setup({ call: async (s, tool) => tool === "support_get" ? { publicUpdates: [] } : tool === "kanban_list" ? [] : { ok: true, delivery: { posted: true, delivery: { status: "posted" } } },
    codingWorkers: () => ({ queueInvestigation: (a) => { asked.push(a); return { skipped: false, run: { id: "cw-123-2" } }; } }) });
  f.job.lastPublishedAt = f.now() - 60000;
  f.job.inbox = [{ authorId: "888888888888888888", messageId: "6001", role: "player", content: "that's not true", at: new Date(f.now()).toISOString() }];
  const e = await f.broker.escalationCheck(f.job);
  assert.equal(e.handedTo, "cw-123-2");
  assert.match(asked[0].reason, /disputed/);
  const g = require("../lib/operator/guardrails");
  assert.deepEqual(f.posts(), [g.RECHECK_LINE]);
  assert.equal(f.ledger.data.ticketPauses?.[123], undefined);
});

// ---- decision copies -------------------------------------------------------------------------------------------------

test("decision questions carry what happens if the owner does nothing, in plain words", () => {
  const { render } = require("../lib/operator/decisions");
  const out = render("Ticket 1886 needs a person: pick one https://github.com/a/b/pull/9", { options: [{ id: "1", label: "Use legislature sizes", recommended: true }, { id: "2", label: "Display only" }] });
  assert.match(out, /\*\*Choose one\*\*/); assert.match(out, /\(recommended\)/); assert.match(out, /If you do nothing: nothing changes until you answer\./);
  assert.doesNotMatch(out, /github\.com|needs a person/);
});

test("hand-backs written as \"Handing ticket N back to Keir\" are read too, with the card's linked fixes", () => {
  const c = { id: 255739, tickets: [1890], pull_requests: ["lakesidegamedev/AHDGame#7272", "lakesidegamedev/AHDGame#7278"], progress_summary: "Handing ticket 1890 back to Keir. Done: #7272 is live. Still owed: (1) confirm 2eff188 is live." };
  assert.equal(hb.isHandback(c), true);
  assert.deepEqual(hb.parse(c).prs, [7272, 7278]);
  assert.match(hb.RULES, /If the note says to ask the owner before closing, do not/);
  assert.match(hb.liveNote(hb.parse(c), 7278, { deployment: { web: { sha: "a".repeat(40) } }, pr: { merge_commit_sha: "b".repeat(40) } }), /if the note says they were already told, do not post again/);
});

test("Keir's own staff hand-off pauses are lifted once; a pause a person set is never touched", () => {
  const data = { jobs: { a: { id: "a", ticket: 1891, state: "paused", ticketPaused: { ticket: 1891, by: "keir-escalation" } }, b: { id: "b", ticket: 1700, state: "paused", ticketPaused: { ticket: 1700, by: "222" } } },
    channels: { c1: { keirPaused: { ticket: 1891, by: "keir-escalation" } }, c2: { keirPaused: { ticket: 1700, by: "222" } } },
    ticketPauses: { 1891: { ticket: 1891, by: "keir-escalation" }, 1700: { ticket: 1700, by: "222" } },
    ticketEscalations: { 1891: { why: "wake_cap" }, 1700: { why: "player_challenge" } } };
  const { liftKeirEscalationPauses } = require("../lib/operator/ticketpause");
  assert.deepEqual(liftKeirEscalationPauses(data, 1000), [1891]);
  assert.equal(data.jobs.a.state, "waiting"); assert.match(data.jobs.a.inbox[0].content, /Keir owns it again/);
  assert.equal(data.jobs.b.state, "paused"); assert.ok(data.ticketPauses[1700]); assert.ok(data.channels.c2.keirPaused);
  assert.deepEqual(liftKeirEscalationPauses(data, 2000), [], "once");
});
