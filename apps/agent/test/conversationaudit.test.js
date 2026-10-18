"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { auditConversation } = require("../lib/operator/conversationaudit");
const now = 1800000000000;
function fixture() {
 const data = { jobs: { j: { id: "j", kind: "ticket", ticket: 1 } }, decisions: {} };
 const options = { now, since: now - 3600000, ownerId: "owner", tickets: { 1: { status: "open", conversation: { channelId: "c" }, intake: { cardMessageId: "card" }, publicUpdates: [] } }, messages: { 1: [] } };
 return { data, options };
}
test("audit inspects actual messages rather than a successful ledger delivery claim", () => {
 const { data, options } = fixture(); data.jobs.j.lastPublishedAt = now;
 options.messages[1] = [{ id: "human", timestamp: now - 20 * 60000, author: { bot: false }, content: "Can you explain the problem?" }, { id: "card", timestamp: now - 1000, author: { bot: true }, content: "", embeds: [{ description: "Answer posted" }] }];
 assert.ok(auditConversation(data, options).findings.some(f => f.kind === "player-reply-unanswered"));
});
test("audit catches public internal notes and reply receipts that only edited a card", () => {
 const { data, options } = fixture();
 options.messages[1] = [{ id: "leak", timestamp: now, author: { bot: true }, content: "Dig done. Options are in your decision DM." }];
 options.tickets[1].publicUpdates = [{ key: "r", at: now, kind: "resolution", delivery: { status: "posted", messageId: "card" } }];
 assert.deepEqual(auditConversation(data, options).findings.map(f => f.kind).sort(), ["answer-delivered-only-to-card", "internal-handoff-public"]);
});
test("a held ticket may investigate and talk, but closing it is flagged", () => {
 const { data, options } = fixture(); data.jobs.j.ownerClosureHold = { handoffId: "h" };
 assert.equal(auditConversation(data, options).findings.length, 0);
 options.tickets[1].status = "resolved";
 assert.ok(auditConversation(data, options).findings.some(f => f.kind === "closure-against-owner-hold"));
});
test("decision copies are checked against the same durable question and sent content", () => {
 const { data, options } = fixture();
 data.decisions.d = { id: "d", jobId: "j", state: "pending", at: now, question: "Choose A or B", sent: { owner: { channelId: "dm", messageId: "m", content: "Choose A or B" } } };
 options.decisionMessages = { "dm:m": { content: "Different question" } };
 assert.ok(auditConversation(data, options).findings.some(f => f.kind === "decision-copy-content-drift"));
 options.decisionMessages["dm:m"].content = "Choose A or B\n\nDecision: Approved";
 assert.equal(auditConversation(data, options).findings.length, 0);
});
test("observation failures are explicit and excluded incident tickets are untouched", () => {
 const { data, options } = fixture(); options.messages[1] = { error: "timeout" };
 assert.equal(auditConversation(data, options).findings[0].kind, "ticket-observation-unavailable");
 options.excludedTickets = [1]; assert.equal(auditConversation(data, options).findings.length, 0);
});

test("a deleted closed channel does not hide a final answer that only edited a card", () => {
 const { data, options } = fixture(); options.tickets[1].status = "resolved";
 options.messages[1] = { error: "HTTP404", status: 404 };
 options.tickets[1].publicUpdates = [{ key: "r", at: now, kind: "resolution", delivery: { status: "posted", messageId: "card" } }];
 assert.ok(auditConversation(data, options).findings.some(f => f.kind === "answer-delivered-only-to-card"));
});

test("active work with an old visible reply is reviewed while a real player-reply wait is not", () => {
 const { data, options } = fixture(); data.jobs.j.state = "waiting"; data.jobs.j.updatedAt = now;
 options.messages[1] = [{ id: "old", timestamp: now - 3 * 3600000, author: { bot: true }, content: "I am checking the sale path." }];
 assert.ok(auditConversation(data, options).findings.some(f => f.kind === "active-ticket-conversation-stale"));
 data.jobs.j.waitingFor = { kind: "player_reply" };
 assert.equal(auditConversation(data, options).findings.length, 0);
});

test("a withdrawn decision cannot silently leave its task held", () => {
 const { data, options } = fixture(); data.jobs.j.ownerDecisionPending = true; data.jobs.j.state = "blocked";
 data.decisions.d = { id: "d", jobId: "j", state: "withdrawn", at: now, sent: {} };
 assert.ok(auditConversation(data, options).findings.some(f => f.kind === "orphan-owner-decision-hold"));
});
