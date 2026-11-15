"use strict";
// Keir 10, track W2: the post path. Guard deadlock (ticket 1812), the post budget.
const test = require("node:test");
const assert = require("node:assert");
const { setup } = require("./keir10-post.helpers");

const ANSWER = "Your plant is idle because it has no coal supplier. Renew the contract and it starts again next turn.";
const EXTRA = "The fix is live on the main server now.";

test("1812: an answer, then a refused extra post, then a paced retry: the flag never arms and finish succeeds", async () => {
  const f = setup(); f.playerWrote(5);
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  assert.equal(f.posts().length, 1);
  f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: EXTRA }), /outcome Keir has no receipt/);
  assert.equal(f.job.replyRefusedPending, undefined, "the player already has an answer to their latest message");
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Your plant is idle because it has no coal supplier, so renew the contract and it runs next turn." }), /already got this update|this task posted/);
  assert.equal(f.job.replyRefusedPending, undefined);
  await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Answered; waiting for the player." });
  assert.equal(f.job.state, "waiting");
});

test("1812: a stale flag is cleared at finish once the player's latest message has a real answer", async () => {
  const f = setup(); f.playerWrote(5);
  f.job.replyRefusedPending = true; // armed earlier, before the answer went out by another task
  const other = f.ledger.createJob("t2", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777" }, deadline: 9e15 });
  (f.ledger.data.ticketPosts ||= {})[123] = [{ at: f.now() - 60000, jobId: other.id, kind: "reply", text: ANSWER }];
  await f.broker.tool(f.job, "finish", { state: "done", summary: "Answered by the other task." });
  assert.equal(f.job.replyRefusedPending, undefined);
  assert.ok(["done", "waiting"].includes(f.job.state), f.job.state);
});

test("1812: while an answer is owed, pacing lets one corrected post through and the flag clears", async () => {
  const f = setup(); f.playerWrote(20);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: EXTRA }), /outcome Keir has no receipt/);
  assert.equal(f.job.replyRefusedPending, true, "no real answer yet, so the corrected answer is owed");
  // Meanwhile three holding lines went out since the player wrote, the last one just now: the monologue cap would hold the next post.
  (f.ledger.data.monologue ||= {})[123] = { humanAt: f.job.observedPlayerAt, count: 3, at: f.now() - 30000 };
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 30000, jobId: f.job.id, kind: "reply", text: "I'm still looking into it." }] };
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  assert.equal(f.posts().length, 1, "the corrected answer is posted despite the monologue cap");
  assert.equal(f.job.replyRefusedPending, undefined);
  await f.broker.tool(f.job, "finish", { state: "waiting", waitFor: "player_reply", summary: "Answered." });
  assert.equal(f.job.state, "waiting");
});

test("1812: an owed corrected answer is not held back by the three minute other-task rule", async () => {
  const f = setup(); f.playerWrote(20);
  const other = f.ledger.createJob("t2", { role: "support", kind: "ticket", ticket: 123, channelId: "777777777777777777", replyChannel: "777777777777777777", source: { channelId: "777777777777777777" }, deadline: 9e15 });
  f.ledger.data.ticketPosts = { 123: [{ at: f.now() - 20000, jobId: other.id, kind: "reply", text: "Hi, I'm Keir, the support assistant for this game." }] };
  f.job.replyRefusedPending = true;
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  assert.equal(f.posts().length, 1);
});

test("post budget: reports what the rules allow and rides along on a pacing refusal", async () => {
  const f = setup(); f.playerWrote(5);
  let b = f.broker.postBudget(f.job);
  assert.equal(b.replyOwed, true);
  assert.equal(b.postsLeftBeforePause, 3);
  assert.equal(b.lastPost, null);
  assert.equal(b.correctionAllowed, true);
  await f.broker.tool(f.job, "channel_reply", { message: ANSWER });
  b = f.broker.postBudget(f.job);
  assert.equal(b.replyOwed, false);
  assert.equal(b.posts24h, 1);
  assert.equal(b.postsLeftBeforePause, 2);
  assert.ok(b.longPostInSec > 0 && b.longPostInSec <= 600);
  assert.match(b.lastPost.text, /no coal supplier/);
  f.advance(1);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "The contract renews at the start of next turn. Your plant restarts once it is renewed. Output then returns to normal over two turns." }),
    (e) => /this task posted in ticket/.test(e.message) && /Post budget: 2 posts left/.test(e.message) && /long post is allowed in/.test(e.message));
  assert.equal(f.broker.postBudget({ kind: "command" }), null, "not a ticket job");
});

// ---- item 4: one card per problem (ticket 1812) ----
const DETAIL = "The recorded fleet supply is recalculated every turn but the result is not saved, so a full fleet reads zero supply next turn.";

test("1812: every distinct problem gets its own developer item, even when the board hands back a used id", async () => {
  const ids = [900, 900, 901, 902];
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: ids.shift() } : tool === "kanban_list" ? [] : { ok: true }) });
  const a = await f.broker.tool(f.job, "raise_to_developers", { kind: "question", needsHuman: true, title: "Ask drawer refusal comes from the Ask service", detail: DETAIL, force: true });
  assert.equal(a.id, 900);
  const b = await f.broker.tool(f.job, "raise_to_developers", { kind: "question", needsHuman: true, title: "Port crowding limits a whole fleet by the port", detail: DETAIL, force: true });
  assert.equal(b.id, 901, "the reused id is not taken for a different problem");
  assert.equal(f.audits("kanban_card_reused").length, 1);
  const c = await f.broker.tool(f.job, "raise_to_developers", { kind: "question", needsHuman: true, title: "Marine wording shows the wrong unit name", detail: DETAIL, force: true });
  assert.equal(c.id, 902);
  assert.deepEqual(f.job.raisedToDevelopers.map((r) => r.id), [900, 901, 902]);
  assert.equal(new Set(f.job.raisedToDevelopers.map((r) => r.title)).size, 3, "no record had its title overwritten");
});

test("1812: if the board keeps returning a used id for a different problem, nothing is recorded and the model is told why", async () => {
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: 900 } : tool === "kanban_list" ? [] : { ok: true }) });
  await f.broker.tool(f.job, "raise_to_developers", { kind: "question", needsHuman: true, title: "Ask drawer refusal comes from the Ask service", detail: DETAIL, force: true });
  await assert.rejects(f.broker.tool(f.job, "raise_to_developers", { kind: "question", needsHuman: true, title: "Port crowding limits a whole fleet by the port", detail: DETAIL, force: true }), /already holds a different problem/);
  assert.equal(f.job.raisedToDevelopers.length, 1);
});

test("1812: appendTo is the only way to join an existing item", async () => {
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: 900 } : tool === "kanban_list" ? [] : { ok: true }) });
  await f.broker.tool(f.job, "raise_to_developers", { kind: "question", needsHuman: true, title: "Ask drawer refusal comes from the Ask service", detail: DETAIL, force: true });
  const r = await f.broker.tool(f.job, "raise_to_developers", { kind: "question", needsHuman: true, appendTo: 900, title: "More evidence for the Ask drawer refusal", detail: DETAIL });
  assert.equal(r.appended, true);
  assert.equal(r.id, 900);
});

// ---- item 6: one owner digest per ticket ----
const Q = (title, question, rec = 1) => ({ kind: "decision", changeClass: "economy_change", title, detail: DETAIL, question, options: [{ label: "Do the first thing", detail: "Takes the first path.", recommended: rec === 1 }, { label: "Do the second thing", detail: "Takes the second path.", recommended: rec === 2 }], force: true });

test("1813: a second owner decision on a ticket joins the first DM instead of opening another", async () => {
  let id = 700;
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: id++ } : tool === "kanban_list" ? [] : { ok: true }) });
  const a = await f.broker.tool(f.job, "raise_to_developers", Q("Port crowding rule", "Should a fleet be limited by the whole port or by its own share of the port?"));
  const b = await f.broker.tool(f.job, "raise_to_developers", Q("Marine wording", "Should the marine unit name follow the wing name on the roster screen?", 2));
  const c = await f.broker.tool(f.job, "raise_to_developers", Q("Supply persistence", "Should supply be saved at the end of each turn for every fleet?"));
  assert.ok(a.decision && b.decision && c.decision);
  assert.notEqual(a.decision, b.decision, "each question stays its own decision, so an answer maps back to one question");
  assert.equal(b.digested, true);
  const owner = Object.values(f.ledger.data.outbox).filter((o) => o.destination === "owner" && o.decision);
  assert.equal(owner.length, 1, "one DM for the ticket");
  assert.equal(owner[0].decision, a.decision);
  assert.equal(f.audits("decision_digested").length, 2);
  assert.equal(f.ledger.data.decisions[b.decision].digestOf, a.decision);
  assert.equal(f.ledger.data.decisions[c.decision].digestOf, a.decision);
});

test("1813: the digest DM lists every open question with its options, recommended first, and refreshes when one joins", async () => {
  let id = 700;
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: id++ } : tool === "kanban_list" ? [] : { ok: true }) });
  const { createDecisions, digestSiblings, render } = require("../lib/operator/decisions");
  const a = await f.broker.tool(f.job, "raise_to_developers", Q("Port crowding rule", "Should a fleet be limited by the whole port or by its own share of the port?"));
  const b = await f.broker.tool(f.job, "raise_to_developers", Q("Marine wording", "Should the marine unit name follow the wing name on the roster screen?", 2));
  const head = f.ledger.data.decisions[a.decision];
  const text = render(head.question, { ...head, digest: digestSiblings(f.ledger.data, head) });
  assert.match(text, /1 more open question on this ticket/);
  assert.match(text, /Question 2:\*\* Ticket 123: Marine wording/);
  assert.ok(text.indexOf("2. Do the second thing (recommended)") < text.indexOf("1. Do the first thing"), "the recommended option comes first");
  // The head's DM was already sent; tick replaces it with the longer one.
  const deleted = [];
  head.sent = { "111111111111111111": { channelId: "dm1", messageId: "m1", content: "old" } };
  const dec = createDecisions({ ledger: f.ledger, config: { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333" }, discord: async (m, u) => { if (m === "DELETE") deleted.push(u); return {}; }, now: () => f.now() });
  await dec.tick();
  assert.deepEqual(deleted, ["/channels/dm1/messages/m1"]);
  const refreshed = Object.entries(f.ledger.data.outbox).filter(([k, o]) => o.decision === a.decision && /:d1$/.test(k));
  assert.equal(refreshed.length, 1);
  assert.match(refreshed[0][1].content, /Question 2:/);
});

test("1813: answering the head hands the DM to the next open question; each answer names its own question", async () => {
  let id = 700;
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: id++ } : tool === "kanban_list" ? [] : { ok: true }) });
  const { createDecisions } = require("../lib/operator/decisions");
  const a = await f.broker.tool(f.job, "raise_to_developers", Q("Port crowding rule", "Should a fleet be limited by the whole port or by its own share of the port?"));
  const b = await f.broker.tool(f.job, "raise_to_developers", Q("Marine wording", "Should the marine unit name follow the wing name on the roster screen?", 2));
  const owner = "111111111111111111";
  const dec = createDecisions({ ledger: f.ledger, config: { ownerId: owner, staffIds: [], botId: "333333333333333333" }, discord: async () => ({}), now: () => f.now() });
  f.job.state = "waiting";
  await dec.applyAuthenticatedApp(f.ledger.data.decisions[a.decision], "choose:1", owner, "");
  assert.equal(f.ledger.data.decisions[a.decision].state, "selected");
  assert.equal(f.ledger.data.decisions[b.decision].state, "pending", "the other question is untouched");
  assert.equal(f.job.ownerDecisionPending, true, "still waiting on the owner for the other question");
  assert.match(f.job.inbox.at(-1).content, /chose for "Ticket 123: Port crowding rule/);
  await dec.tick();
  assert.equal(f.ledger.data.decisions[b.decision].digestOf, undefined, "promoted to head");
  assert.ok(Object.values(f.ledger.data.outbox).some((o) => o.decision === b.decision && o.destination === "owner"), "its DM goes out now");
  await dec.applyAuthenticatedApp(f.ledger.data.decisions[b.decision], "choose:2", owner, "");
  assert.equal(f.ledger.data.decisions[b.decision].selectedOption.label, "Do the second thing");
  assert.equal(f.job.ownerDecisionPending, undefined);
});

test("1813: the 12 hour re-ping still fires for the head of a digest", async () => {
  let id = 700;
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: id++ } : tool === "kanban_list" ? [] : { ok: true }) });
  const { createDecisions, REPING_MS } = require("../lib/operator/decisions");
  const a = await f.broker.tool(f.job, "raise_to_developers", Q("Port crowding rule", "Should a fleet be limited by the whole port or by its own share of the port?"));
  await f.broker.tool(f.job, "raise_to_developers", Q("Marine wording", "Should the marine unit name follow the wing name on the roster screen?", 2));
  const head = f.ledger.data.decisions[a.decision];
  head.sent = { "111111111111111111": { channelId: "dm1", messageId: "m1", content: "x" } };
  delete head.digestDirty;
  const dec = createDecisions({ ledger: f.ledger, config: { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333" }, discord: async () => ({}), now: () => Date.now() + REPING_MS + 60000 });
  await dec.tick();
  assert.equal(head.pings, 1);
  const ping = Object.entries(f.ledger.data.outbox).find(([k]) => k.endsWith(":r1"));
  assert.match(ping[1].content, /Still waiting on you/);
  assert.match(ping[1].content, /Question 2:/);
});

test("a decision for a different ticket still gets its own DM", async () => {
  let id = 700;
  const f = setup({ call: async (_s, tool) => (tool === "kanban_add" ? { id: id++ } : tool === "kanban_list" ? [] : { ok: true }) });
  await f.broker.tool(f.job, "raise_to_developers", Q("Port crowding rule", "Should a fleet be limited by the whole port or by its own share of the port?"));
  const other = f.ledger.createJob("t9", { role: "support", kind: "ticket", ticket: 124, channelId: "777777777777777778", replyChannel: "777777777777777778", source: { channelId: "777777777777777778", channelName: "ticket-bug-fixture-124" }, deadline: 9e15 }); other.state = "running";
  await f.broker.tool(other, "raise_to_developers", Q("Marine wording", "Should the marine unit name follow the wing name on the roster screen?", 2));
  assert.equal(Object.values(f.ledger.data.outbox).filter((o) => o.destination === "owner" && o.decision).length, 2);
});
