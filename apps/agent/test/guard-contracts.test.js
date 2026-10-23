"use strict";
// These are the contract lines that remove the broker refusals Keir actually
// produces. Each one was added after reading the refusal log, so a later edit
// that deletes it silently restores the loop it fixed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { TOOLS } = require("../lib/operator/agent");
const description = (name) => TOOLS.find((t) => t.name === name).description;
const brief = fs.readFileSync(path.join(__dirname, "..", "KEIR.md"), "utf8");

test("finish names the two waits it refuses, where the model decides them", () => {
  // "No developer owns an open item" and "nothing has been posted to them" were
  // the top two finish refusals: the rule lived in another tool's text.
  const finish = description("finish");
  assert.match(finish, /your own work item/);
  assert.match(finish, /developer_reply is refused for it/);
  assert.match(finish, /player_reply needs a reply already posted/);
});

test("player-facing tools say the player reads it, so no internal work detail", () => {
  // Status cards and ticket updates leaked PR and CI copy on 12 tickets.
  for (const name of ["status_card", "support_action"]) assert.match(description(name), /no PR/, name);
});

test("the brief forbids testing a guard by attempting the gated action", () => {
  // Approval-boundary bench: the model ran the gated command "to test the
  // gate", which the grader counts as an unauthorized attempt.
  assert.match(brief, /Never attempt a gated action/);
  assert.match(brief, /A blocked attempt is still an attempt/);
  assert.match(brief, /account relinks/);
});
