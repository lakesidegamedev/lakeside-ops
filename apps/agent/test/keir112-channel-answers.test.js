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
  // Third pass (review M1): a reply must also give an answer the question can take; free text in a reply to a question
  // with named options is context, not a choice.
  assert.deepEqual(say(w, "no, leave it as is for now", { replyTo: { id: "q1", authorId: BOT } }), []);
  assert.deepEqual(say(w, "Keep the current cap", { replyTo: { id: "q1", authorId: BOT } }), [w.x.id]);
  assert.equal(w.x.state, "selected");
  assert.equal(w.x.answeredVia, "ticket_channel_reply");
  assert.equal(w.data.jobs.j1.state, "queued");
  assert.match(w.data.jobs.j1.inbox.at(-1).content, /in the ticket channel/);
});

test("a reply to a Keir post in the channel that carries the question answers it; a reply to another post does not", () => {
  const w = ship1857();
  assert.deepEqual(say(w, "sure", { replyTo: { id: "p2", authorId: BOT, content: "Unrelated progress note about bonds." } }), []);
  assert.equal(w.x.state, "pending");
  const posted = `Waiting on Egg: ${w.x.question}`;
  assert.deepEqual(say(w, "ship it", { replyTo: { id: "p3", authorId: BOT, content: posted } }), [], "named options need the option");
  assert.deepEqual(say(w, "1", { replyTo: { id: "p3", authorId: BOT, content: posted } }), [w.x.id]);
  assert.equal(w.x.state, "selected");
});

test("naming an option by label or number answers it", () => {
  let w = cap1860();
  // Fourth pass (review N4): outside a reply only the whole message names an option. A label with more around it is
  // context: the asking task is told, and the question stays open.
  assert.deepEqual(say(w, "Keep the current cap, we will revisit later"), []);
  assert.match(w.data.jobs.j1.inbox.at(-1).content, /not taken as the answer to your open question/);
  assert.deepEqual(say(w, "go with Keep the current cap please"), [w.x.id]);
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

// ---- Third pass: the review's M1 and M2 ----
const sayN = (w, text, extra = {}) => { const sent = []; const r = say(w, text, { notify: (key, line) => sent.push({ key, line }), ...extra }); return { r, sent }; };

test("M1: a non-answer sent as a reply, a common-word label in passing, and an ok before a deferral answer nothing", () => {
  const w = cap1860();
  w.x.sent[OWNER] = { channelId: "dm", messageId: "q1" };
  assert.deepEqual(say(w, "can you link the PR here so I can review it?", { replyTo: { id: "q1", authorId: BOT } }), []);
  assert.equal(w.x.state, "pending");
  const refund = world(1842, "Ticket 1842: How should the lost build be handled?", [{ label: "Wait" }, { label: "Refund the player" }]);
  assert.deepEqual(say(refund, "wait, why is the refund so large?"), []);
  assert.equal(refund.x.state, "pending");
  assert.deepEqual(say(refund, "Wait"), [refund.x.id], "the label on its own still answers");
  const yn = world(1842, "Ticket 1842: Refund the lost shop build?", null);
  assert.deepEqual(say(yn, "ok, let me look at the numbers first"), []);
  assert.equal(yn.x.state, "pending");
  assert.deepEqual(say(yn, "go with Keep the current cap please"), [], "a label from another question is not an answer");
  const pick = cap1860();
  assert.deepEqual(say(pick, "go with Keep the current cap please"), [pick.x.id]);
});

test("M2: an unmatched owner message that looks meant for the question tells him once, in his DMs, how to answer", () => {
  const w = world(1842, "Ticket 1842: Refund the lost shop build?", null);
  const first = sayN(w, "yes tell them");
  assert.deepEqual(first.r, []);
  assert.equal(first.sent.length, 1);
  assert.equal(first.sent[0].key, `owner-unmatched:${w.x.id}`);
  assert.match(first.sent[0].line, /^Ticket 1842: your message "yes tell them" was not taken as your answer to "Ticket 1842: Refund the lost shop build\?"\. That question is still open\. To answer, tap a button on the question, reply to it, or say yes or no on its own\.$/);
  assert.equal(sayN(w, "yes tell them please").sent.length, 0, "once per question");
  const opts = cap1860();
  assert.match(sayN(opts, "raise it please").sent[0].line, /name the option on its own \(1 "Raise the demand cap" or 2 "Keep the current cap"\)/);
});

test("M2: the three real production messages never answer and never nag more than once; one addressed to someone else gets nothing", () => {
  for (const [w, text] of [[ship1857(), "can you link it here for [someone] to review?"], [cap1860(), "yeah automobiles was removed"], [tech1852(), "Keir is wrong"]]) {
    let notes = 0;
    for (let i = 0; i < 4; i++) { const out = sayN(w, text); assert.deepEqual(out.r, []); notes += out.sent.length; }
    assert.equal(w.x.state, "pending");
    assert.ok(notes <= 1, `${text}: ${notes}`);
  }
  const elsewhere = cap1860();
  assert.equal(sayN(elsewhere, "<@100000000000000002> yeah can you raise the cap for them?").sent.length, 0);
  const unrelated = tech1852();
  assert.equal(sayN(unrelated, "Keir is wrong").sent.length, 0, "nothing in it is about the question");
});

test("N4: a label inside a negated or deferring sentence is not a choice, even as a reply; mixed yes and no is no answer", () => {
  const refund = () => world(1890, "Ticket 1890: Refund the player for the lost build, or leave it?", [{ label: "Refund the player" }, { label: "Leave it" }]);
  for (const text of ["we should not refund the player until I check the logs", "dont refund the player yet, I will check", "refund the player later maybe", "should we refund the player"]) {
    const w = refund();
    assert.deepEqual(say(w, text), [], text);
    w.x.sent[OWNER] = { channelId: "dm", messageId: "q1" };
    assert.deepEqual(say(w, text, { replyTo: { id: "q1", authorId: BOT } }), [], `${text} (reply)`);
    assert.equal(w.x.state, "pending");
  }
  // The other side: a plain choice still counts, alone or inside a reply.
  let w = refund();
  assert.deepEqual(say(w, "Refund the player"), [w.x.id]);
  w = refund(); w.x.sent[OWNER] = { channelId: "dm", messageId: "q1" };
  assert.deepEqual(say(w, "ok, refund the player please, thanks", { replyTo: { id: "q1", authorId: BOT } }), [w.x.id]);
  const yn = world(1891, "Ticket 1891: Refund the lost shop build?", null);
  assert.equal(sd.yesNo("No, absolutely yes"), null);
  assert.deepEqual(say(yn, "No, absolutely yes"), []);
  assert.deepEqual(say(yn, "No."), [yn.x.id]);
});

test("M2: every unmatched owner message meant for the question reaches the asking task; the DM notice stays one per question", () => {
  const w = cap1860();
  const sent = [];
  const notify = (key, line) => { sent.push(key); return true; };
  say(w, "the demand cap is the real issue here", { notify });
  say(w, "honestly the demand cap needs a rethink", { notify });
  assert.deepEqual(sent, [`owner-unmatched:${w.x.id}`], "one notice");
  const lines = w.data.jobs.j1.inbox.filter((m) => m.authorId === "owner-channel");
  assert.equal(lines.length, 2, "the second message is not lost");
  assert.match(lines[1].content, /needs a rethink/);
  // A preview notice does not use up the real one.
  const v = cap1860();
  say(v, "the demand cap is the real issue here", { notify: () => false });
  assert.equal(v.x.unmatchedNoticeAt, undefined);
});

// Review 3 F4 (the reviewer's answers.js): one open question, "Raise the demand cap for this player to 500?".
const cap500 = (options) => world(1900, "Raise the demand cap for this player to 500?", options);
const TWO = () => [{ label: "Raise it to 500" }, { label: "Leave the cap" }];
const PLAYER_MSG = { id: "999", authorId: "200000000000000009", content: "Do I need to do anything else?" };

test("F4: a reply to someone else's message never answers the question, and is kept only as context", () => {
  for (const [text, replyTo, options] of [
    ["no", PLAYER_MSG, null], ["ok", PLAYER_MSG, null],
    ["sure", { id: "998", authorId: DELEGATE, content: "want me to grab the logs?" }, null],
    ["1", PLAYER_MSG, TWO()], ["Leave the cap", PLAYER_MSG, TWO()],
    ["yes", { id: "997", authorId: BOT, content: "I checked your factory and the wages look right now." }, null],
  ]) {
    const w = cap500(options);
    const sent = [];
    assert.deepEqual(say(w, text, { replyTo, notify: (k) => { sent.push(k); return true; } }), [], `${text} as a reply to ${replyTo.authorId}`);
    assert.equal(w.x.state, "pending");
    assert.equal(w.x.channelContext.at(-1).text, text, "kept on the question as context");
    if (replyTo.authorId !== BOT) {
      assert.deepEqual(sent, [], "talking to someone else: no DM notice");
      assert.equal((w.data.jobs.j1.inbox || []).length, 0);
    }
  }
});

test("F4: naming an option to reject it, question it or put it off is not choosing it, alone or as a reply", () => {
  const texts = ["don't do option 1, I need to think", "option 1 looks wrong to me, why 500?", "not option 2", "anything but option 1",
    "not Leave the cap", "anything but Leave the cap", "Leave the cap is wrong", "option 2 is a bad idea", "take 2 minutes and think about it"];
  for (const text of texts) {
    const w = cap500(TWO());
    assert.deepEqual(say(w, text), [], text);
    w.x.sent[OWNER] = { channelId: "dm", messageId: "q1" };
    assert.deepEqual(say(w, text, { replyTo: { id: "q1", authorId: BOT } }), [], `${text} (reply)`);
    assert.equal(w.x.state, "pending", text);
  }
});

test("F4, the other side: a true reply, a bare option, and a plain yes or no to a yes or no question still answer", () => {
  const counted = [
    ["1", {}, TWO(), "Raise it to 500"], ["option 2", {}, TWO(), "Leave the cap"], ["go with 2 please", {}, TWO(), "Leave the cap"],
    ["option 1 please", {}, TWO(), "Raise it to 500"], ["Leave the cap", {}, TWO(), "Leave the cap"],
    ["1", { reply: true }, TWO(), "Raise it to 500"], ["go with option 2, thanks", { reply: true }, TWO(), "Leave the cap"],
    ["Leave the cap please", { reply: true }, TWO(), "Leave the cap"],
  ];
  for (const [text, { reply }, options, label] of counted) {
    const w = cap500(options);
    if (reply) w.x.sent[OWNER] = { channelId: "dm", messageId: "q1" };
    assert.deepEqual(say(w, text, reply ? { replyTo: { id: "q1", authorId: BOT } } : {}), [w.x.id], text);
    assert.equal(w.x.selectedOption.label, label, text);
  }
  for (const [text, reply] of [["yes", false], ["no", false], ["yes", true], ["no.", true]]) {
    const w = cap500(null);
    if (reply) w.x.sent[OWNER] = { channelId: "dm", messageId: "q1" };
    assert.deepEqual(say(w, text, reply ? { replyTo: { id: "q1", authorId: BOT } } : {}), [w.x.id], `${text}${reply ? " (reply)" : ""}`);
    assert.equal(w.x.state, "answered");
  }
  // An unmatched message meant for the question still reaches the task and gets the one notice.
  const w = cap500(TWO());
  const sent = [];
  say(w, "option 1 looks wrong to me, why 500?", { notify: (k) => { sent.push(k); return true; } });
  say(w, "not option 2 either", { notify: (k) => { sent.push(k); return true; } });
  assert.equal(sent.length, 1);
  assert.equal(w.data.jobs.j1.inbox.filter((m) => m.authorId === "owner-channel").length, 2);
});
