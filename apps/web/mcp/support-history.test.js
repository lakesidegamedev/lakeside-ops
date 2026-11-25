"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("./support-history");

const cfg = { staffIds: new Set(["100"]), agentBotIds: new Set(["900"]), embedUrl: "", embedModel: "", recorder: false, sweepMinutes: 15 };

const ticket = () => ({
  ticketNumber: 42,
  title: "Bank closed",
  description: "My bank closed",
  category: "bug",
  status: "resolved",
  discordUserId: "7",
  discordUsername: "player7",
  createdAt: new Date("2026-11-24T16:00:00Z"),
  messages: [
    { authorId: "7", authorName: "player7", content: "Bank closed", createdAt: new Date("2026-11-24T16:00:00Z") },
    { authorId: "7", authorName: "player7", content: "why did it close?", createdAt: new Date("2026-11-24T16:01:00Z") },
    { authorId: "100", authorName: "owner", content: "looking", createdAt: new Date("2026-11-24T16:05:00Z") },
    { authorId: "55", authorName: "friend", content: "same here", createdAt: new Date("2026-11-24T16:06:00Z") },
    { authorId: "900", authorName: "SupportBot", content: "checking", createdAt: new Date("2026-11-24T16:07:00Z") },
    { authorId: "discord-bot", authorName: "Ticket lifecycle monitor", content: "channel deleted", createdAt: new Date("2026-11-24T22:00:00Z") },
  ],
  publicUpdates: [
    { key: "progress:1", kind: "progress", message: "We found the cause.", at: new Date("2026-11-24T17:00:00Z"), delivery: { status: "posted" } },
    { key: "resolution:r1", kind: "resolution", message: "Your support report is closed.", at: new Date("2026-11-24T21:00:00Z") },
  ],
  statusHistory: [{ status: "resolved", at: new Date("2026-11-24T21:00:00Z"), by: "coordinator", source: "mcp", note: "resolution receipt recorded" }],
  resolution: { receiptId: "r1", message: "Paid you back.", actions: [{ label: "Paid CA$1" }], followUp: "Nothing to do.", resolvedAt: new Date("2026-11-24T21:00:00Z"), closedBy: "coordinator", channelDelivery: { status: "posted" } },
  resolutionAttribution: { agent: "coordinator", evidence: "ledger" },
  opsFindingsText: "Central bank cash was spent on bills.",
  opsFindingsPostedAt: new Date("2026-11-24T18:00:00Z"),
  prUrl: "https://example.invalid/pr/1",
  prNumber: 1,
  copyRefusals: [{ at: new Date("2026-11-24T16:30:00Z"), tool: "support_public_update", by: "keir", match: "PR", kind: "internal" }],
});

test("eventsFromTicket covers every kind of record with roles", () => {
  const events = h.eventsFromTicket(ticket(), cfg);
  const kinds = events.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === "player_message").length, 2);
  assert.ok(kinds.includes("opened"));
  assert.ok(kinds.includes("staff_message"));
  assert.ok(kinds.includes("participant_message"));
  assert.ok(kinds.includes("agent_message"));
  assert.ok(kinds.includes("system_message"));
  assert.ok(kinds.includes("finding"));
  assert.ok(kinds.includes("fix"));
  assert.ok(kinds.includes("status"));
  assert.ok(kinds.includes("refused_post"));
  // The resolution is recorded once, from the receipt, not again from publicUpdates.
  assert.equal(kinds.filter((k) => k === "resolution").length, 1);
  assert.equal(kinds.filter((k) => k === "support_post").length, 1);
  const res = events.find((e) => e.kind === "resolution");
  assert.match(res.text, /Paid you back\.[\s\S]*Paid CA\$1[\s\S]*Nothing to do\./);
  assert.equal(res.meta.creditedTo, "coordinator");
});

test("event ids are deterministic and unique", () => {
  const a = h.eventsFromTicket(ticket(), cfg).map((e) => e._id);
  const b = h.eventsFromTicket(ticket(), cfg).map((e) => e._id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.ok(a.every((id) => id.startsWith("42:")));
});

test("a reopen keeps the earlier receipt as its own event", () => {
  const t = ticket();
  t.resolutionHistory = [{ receiptId: "r0", message: "First answer", resolvedAt: new Date("2026-11-20T00:00:00Z") }];
  t.conversationHistory = [{ channelId: "c1", replacedAt: new Date("2026-11-21T00:00:00Z"), requestId: "q1", reason: "player asked again", by: "staff" }];
  const events = h.eventsFromTicket(t, cfg);
  assert.equal(events.filter((e) => e.kind === "resolution").length, 2);
  assert.equal(events.filter((e) => e.kind === "reopen").length, 1);
});

test("private replies are recorded only while their text is held", () => {
  assert.equal(h.eventFromPrivateReply({ ticketNumber: 42, key: "k", text: null }), null);
  const e = h.eventFromPrivateReply({ ticketNumber: 42, key: "progress:9", text: "exact words", kind: "progress", createdAt: new Date() });
  assert.equal(e._id, "42:post:progress:9");
  assert.equal(e.text, "exact words");
  assert.equal(e.meta.ticketOnly, true);
});

test("digest keeps searchable words and a stable meaning hash", () => {
  const t = ticket();
  const d1 = h.digestFromTicket(t, h.eventsFromTicket(t, cfg));
  assert.equal(d1._id, 42);
  assert.match(d1.text, /why did it close/);
  assert.doesNotMatch(d1.text, /channel deleted/); // system noise stays out of search
  assert.match(d1.embedText, /Finding: Central bank/);
  // A late chat message past the first few player messages does not force a re-embed.
  t.messages.push({ authorId: "100", authorName: "owner", content: "thanks", createdAt: new Date("2026-11-25T00:00:00Z") });
  const d2 = h.digestFromTicket(t, h.eventsFromTicket(t, cfg));
  assert.equal(d1.embedHash, d2.embedHash);
});

test("fuse ranks items found by both lists first", () => {
  const r = h.fuse([[1, 2, 3], [3, 4]]);
  assert.equal(r[0].ticketNumber, 3);
  assert.deepEqual(new Set(r.map((x) => x.ticketNumber)), new Set([1, 2, 3, 4]));
});

test("cosine and snippet", () => {
  assert.equal(h.cosine([1, 0], [1, 0]), 1);
  assert.equal(h.cosine([1, 0], [0, 1]), 0);
  const s = h.snippet("x ".repeat(200) + "the exchange rate moved this turn", "exchange rate");
  assert.match(s, /exchange rate/);
});

test("storeEvents writes once and refreshes only state in meta", async () => {
  const writes = [];
  const db = { collection: () => ({ bulkWrite: async (ops) => { writes.push(...ops); return { upsertedCount: ops.length }; } }) };
  const events = h.eventsFromTicket(ticket(), cfg);
  const r = await h.storeEvents(db, events, "backfill");
  assert.equal(r.inserted, events.length);
  for (const op of writes) {
    const u = op.updateOne.update;
    assert.ok(u.$setOnInsert.text !== undefined);
    assert.equal(u.$setOnInsert.source, "backfill");
    assert.ok(!("meta" in (u.$set || {})));
    for (const k of Object.keys(u.$set || {})) assert.match(k, /^meta\./);
    if (u.$set) assert.ok(!("meta" in u.$setOnInsert), "meta must not be both inserted whole and set by field");
  }
});

test("search text includes resolution evidence and real status notes, not routine ones", () => {
  const t = ticket();
  t.resolutionAttribution = { agent: "coordinator", evidence: "zero 'Exchange rate unavailable' errors since the fix" };
  t.statusHistory.push({ status: "in_progress", at: new Date("2026-11-24T17:30:00Z"), by: "staff", source: "mcp", note: "turn stalled on a currency lookup" });
  const d = h.digestFromTicket(t, h.eventsFromTicket(t, cfg));
  assert.match(d.text, /Exchange rate unavailable/);
  assert.match(d.text, /currency lookup/);
  assert.doesNotMatch(d.text, /resolution receipt recorded/);
  assert.match(d.embedText, /Exchange rate unavailable/);
  assert.match(d.embedText, /Reply: We found the cause|Finding:/);
});

test("queryTerms drops short and common words", () => {
  assert.deepEqual(h.queryTerms("why did the exchange rate turn"), ["exchange", "rate", "turn"]);
});

test("snippet matches whole words and prefers the passage with the most query words", () => {
  const text = "Internal Server Error returns here. " + "filler ".repeat(80) + "zero Exchange rate unavailable errors since turn 210";
  const s = h.snippet(text, "exchange rate turn");
  assert.match(s, /Exchange rate unavailable errors since turn 210/);
});
