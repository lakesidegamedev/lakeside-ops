"use strict";
// Keir 11.4 release review: guards must refuse the false claim, not the words. Twenty ordinary true sentences a player or
// the owner might be sent, each containing "cannot", "can't", "developers", "render" or "with the", run through the claim
// guards in the strictest contexts: a player's ticket while Keir's own worker holds the fix and the picture tool was
// offered, a developer asking in that ticket, and the owner's app. All must pass. The original false sentences are
// listed after them and must still be refused.
const test = require("node:test");
const assert = require("node:assert");
const truth = require("../lib/operator/handofftruth");
const standdown = require("../lib/operator/standdown");

const OWNER = "111111111111111111", STAFF = "222222222222222222", PLAYER = "555555555555555555";
const config = { ownerId: OWNER, staffIds: [STAFF], botId: "333333333333333333" };
const TRUE_SENTENCES = [
  "You cannot create a second company while your first one is still listed.",
  "You can't produce steel in a region with no iron supply.",
  "I can't make changes to your account balance; a moderator has to approve a refund.",
  "You cannot vote in a primary for a party you are not a member of.",
  "This page cannot render a chart for a company with no history yet.",
  "The map can't render regions you have not explored.",
  "The developers decided last month that bonds pay out at the end of each turn.",
  "The developers have said this is working as intended.",
  "The developers have not changed loan interest this week; your rate rose because your credit score fell.",
  "The developers added the export tariff in the last update.",
  "Your shares are held with the central bank until the trade settles.",
  "I can't merge your ticket into another player's; only staff can do that.",
  "Your report is with the team now.",
  "The tooltip will render the new wording once the fix is live.",
  "You can't render the full map on a phone, so use the region list instead.",
  "I can't see your screen, so tell me which page you were on.",
  "It is not with the developers yet; I am still reading the code.",
  "Nobody on the team has this yet and the developers have not seen it, so I am preparing a fix myself.",
  "The game cannot show a price until the market has traded once.",
  "Players with the trader perk can't be outbid on contracts they already hold.",
];
const FALSE_SENTENCES = [
  "It is with the developers now and I will come back when there is something to try.",
  "I cannot render the page from here, so that is the copy as it would appear.",
];

function contexts() {
  const at = new Date(10 * 3600000).toISOString();
  const ticket = { id: "t", kind: "ticket", role: "support", ticket: 1872, source: { authorId: PLAYER, role: "player", content: "my company page crashes", at }, raisedToDevelopers: [{ id: 255638, at: 1, kind: "bug", workerRun: "cw-1872-55" }] };
  const d = { jobs: { t: ticket }, codingWorkers: { runs: { "cw-1872-55": { id: "cw-1872-55", ticket: 1872, state: "running" } } }, decisions: {}, actions: {} };
  const staffAsk = { ...ticket, inbox: [{ authorId: STAFF, role: "support", content: "Keir, what is the rule here?", at: new Date(10 * 3600000 + 1000).toISOString() }] };
  const app = { id: "a", kind: "command", role: "owner", actorId: OWNER, replyChannel: "app", source: { channelId: "app", authorId: OWNER, content: "what is the rule?" } };
  return [
    ["player ticket, Keir's worker on it, picture tool offered", { d, job: ticket, ticketNo: 1872, jobs: [ticket], config, renderOffered: true }],
    ["developer asking in the ticket", { d, job: staffAsk, ticketNo: 1872, jobs: [staffAsk], config, renderOffered: true }],
    ["owner's app", { d, job: app, config, renderOffered: true }],
  ];
}

for (const [i, sentence] of TRUE_SENTENCES.entries()) {
  test(`true sentence ${i + 1} passes every claim guard: ${sentence}`, () => {
    for (const [where, ctx] of contexts()) {
      assert.equal(truth.deflection(sentence, ctx), null, `${where}: ${sentence}`);
      assert.equal(truth.withoutDeflections(sentence, ctx), sentence, where);
    }
    assert.equal(standdown.capabilityClaim(sentence), null);
  });
}

test("the twenty sentences are twenty, and each has one of the words that used to trip a guard", () => {
  assert.equal(TRUE_SENTENCES.length, 20);
  for (const s of TRUE_SENTENCES) assert.match(s, /cannot|can't|developers|render|with the/i, s);
});

test("the original false sentences are still refused in the player's ticket", () => {
  const [, ctx] = contexts()[0];
  for (const s of FALSE_SENTENCES) assert.ok(truth.deflection(s, ctx), s);
});
