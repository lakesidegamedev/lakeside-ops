"use strict";
// Keir 11.2 item 3: channel chat is not a decision. Fixtures are the three real cases from the 2026-11-21 audit
// (tickets 1857, 1860, 1852), with player names and Discord ids replaced.
const test = require("node:test");
const assert = require("node:assert");
const sd = require("../lib/operator/standdown");
const { openDecision, createDecisions } = require("../lib/operator/decisions");

const OWNER = "100000000000000001", DELEGATE = "100000000000000002", BOT = "100000000000000003";
const NOW = Date.parse("2026-11-19T12:00:00Z"), H = 3600000;

function world(ticket, question, options) {
  const data = { jobs: { j1: { id: "j1", ticket, kind: "ticket", state: "waiting", ownerDecisionPending: true } }, actions: {}, outbox: {}, audit: [], decisions: {} };
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify(key, dest, content, extra = {}) { data.outbox[key] ||= { destination: dest, content, ...extra }; } };
  const config = { ownerId: OWNER, staffIds: [DELEGATE], botId: BOT };
  const x = openDecision(ledger, config, { jobId: "j1", question, options, ticket });
  x.at = NOW - H;
  return { data, ledger, config, x };
}
const ship1857 = () => world(1857, "Ticket 1857: Approve shipping the bond issue screen fix (worker PR 6865). Ship the bond issue screen fix now?", [{ label: "Ship PR 6865 now", recommended: true }, { label: "Wait for a developer review" }]);
const cap1860 = () => world(1860, "Ticket 1860: Raise the traded-market demand cap so corporations can keep building, or keep it. Should the traded-market demand cap rise?", [{ label: "Raise the demand cap" }, { label: "Keep the current cap" }]);
const tech1852 = () => world(1852, "Ticket 1852: Tech tree R&D prices are unreachable at real R&D income. Which pricing should apply?", [{ label: "Scale prices to R&D income" }, { label: "Keep current prices" }]);
const say = (w, text, extra = {}) => sd.applyOwnerChannelAnswer(w.data, { ticket: w.data.jobs.j1.ticket, ownerId: OWNER, authorId: OWNER, text, messageId: "m9", at: NOW, botId: BOT, ...extra });

test("the three real channel messages do not answer the open question", () => {
  for (const [w, text] of [[ship1857(), "can you link it here for [someone] to review?"], [cap1860(), "yeah automobiles was removed"], [tech1852(), "Keir is wrong"]]) {
    assert.deepEqual(say(w, text), [], text);
    assert.equal(w.x.state, "pending", text);
    assert.equal(w.data.jobs.j1.ownerDecisionPending, true);
    assert.equal(w.data.ownerChannelAnswers, undefined);
    assert.equal(w.x.channelContext.at(-1).text, text, "kept as context on the question");
    assert.equal(sd.ownerAnsweredSince(w.data, w.data.jobs.j1.ticket), false, "Keir may still say it is waiting on the owner");
  }
});

test("a Discord reply to the question's own message answers it", () => {
  const w = cap1860();
  w.x.sent[OWNER] = { channelId: "dm", messageId: "q1" };
  assert.deepEqual(say(w, "no, leave it as is for now", { replyTo: { id: "q1", authorId: BOT } }), [w.x.id]);
  assert.equal(w.x.state, "answered");
  assert.equal(w.x.answeredVia, "ticket_channel_reply");
  assert.equal(w.data.jobs.j1.state, "queued");
  assert.match(w.data.jobs.j1.inbox.at(-1).content, /in the ticket channel/);
});

test("a reply to a Keir post in the channel that carries the question answers it; a reply to another post does not", () => {
  const w = ship1857();
  assert.deepEqual(say(w, "sure", { replyTo: { id: "p2", authorId: BOT, content: "Unrelated progress note about bonds." } }), []);
  assert.equal(w.x.state, "pending");
  const posted = `Waiting on Egg: ${w.x.question}`;
  assert.deepEqual(say(w, "ship it", { replyTo: { id: "p3", authorId: BOT, content: posted } }), [w.x.id]);
  assert.equal(w.x.state, "answered");
});

test("naming an option by label or number answers it", () => {
  let w = cap1860();
  assert.deepEqual(say(w, "Keep the current cap, we will revisit later"), [w.x.id]);
  assert.equal(w.x.state, "selected");
  assert.equal(w.x.selectedOption.label, "Keep the current cap");
  w = tech1852();
  assert.deepEqual(say(w, "option 1"), [w.x.id]);
  assert.equal(w.x.selectedOption.label, "Scale prices to R&D income");
  w = ship1857();
  assert.deepEqual(say(w, "2"), [w.x.id]);
  assert.equal(w.x.selectedOption.label, "Wait for a developer review");
});

test("yes or no answers only a single yes or no question, and only as its own clause", () => {
  const w = world(1842, "Ticket 1842: Refund the lost shop build?", null);
  assert.deepEqual(say(w, "yeah automobiles was removed"), []);
  assert.deepEqual(say(w, "Do the refund, yes."), [w.x.id]);
  assert.equal(w.x.state, "answered");
  const two = world(1842, "Ticket 1842: Refund the shop build?", [{ label: "Yes, refund it" }, { label: "No refund" }]);
  assert.deepEqual(say(two, "no"), [two.x.id]);
  assert.equal(two.x.selectedOption.label, "No refund");
  const named = ship1857();
  assert.deepEqual(say(named, "yes"), [], "a choice with named options needs the option, not yes");
});

test("a message that could answer two open questions answers neither", () => {
  const w = cap1860();
  const y = openDecision(w.ledger, w.config, { jobId: "j1", question: "Ticket 1860: Second question about cap timing for the next turn?", options: [{ label: "Raise it now" }, { label: "Keep the current cap" }], ticket: 1860, decisionKey: "timing" });
  y.at = NOW - H;
  assert.deepEqual(say(w, "Keep the current cap"), []);
  assert.deepEqual(say(w, "1"), [], "a bare number with two questions open is ambiguous");
  assert.equal(w.x.state, "pending");
});

test("when a channel answer ends a question, every DM copy loses its buttons", async () => {
  const w = cap1860();
  const messages = {};
  const discord = async (method, route, body) => {
    const id = route.split("/").pop();
    if (method === "PATCH") { messages[id] = { edited: body }; return {}; }
    if (method === "DELETE") { messages[id] = { deleted: true }; return null; }
    return null;
  };
  const decisions = createDecisions({ ledger: w.ledger, config: w.config, discord, now: () => NOW + 60000 });
  w.x.sent = { [OWNER]: { channelId: "dm-o", messageId: "o1" }, [DELEGATE]: { channelId: "dm-d", messageId: "d1" } };
  assert.deepEqual(say(w, "Raise the demand cap"), [w.x.id]);
  await decisions.tick();
  assert.equal(messages.o1.deleted, true, "the owner's own copy is removed: he answered it");
  assert.deepEqual(messages.d1.edited.components, [], "the delegate's copy keeps no working buttons");
  assert.match(messages.d1.edited.content, /No longer needed\.\*\* Egg chose "Raise the demand cap" in the ticket/);
  assert.equal(w.x.closedOut, true);
});
