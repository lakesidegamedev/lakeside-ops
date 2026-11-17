"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { playbookFor, contextFor, finishRefusal, kindOf } = require("../lib/operator/playbooks");

const ticket = (fields = {}) => ({ id: "t1", kind: "ticket", role: "support", ticket: 9, channelId: "c", tags: { kind: "bug_report" }, ...fields });

test("the kind comes from intake tags, then the channel; incidents take priority", () => {
  assert.equal(kindOf(ticket(), {}), "bug_report");
  assert.equal(kindOf(ticket({ tags: {} }), { channels: { c: { category: "mechanics" } } }), "mechanics_question");
  assert.equal(kindOf(ticket({ incidentCandidates: [{ number: 5 }] }), {}), "incident_candidate");
  assert.equal(playbookFor(ticket({ kind: "command" }), {}), null);
  assert.equal(playbookFor(ticket({ codingParent: "x" }), {}), null);
});

test("a bug report walks read, cause, route, tell; done is refused until each is recorded", () => {
  const d = { jobs: {}, statusCards: {} };
  const j = ticket(); d.jobs.t1 = j;
  assert.match(finishRefusal(j, d, "done"), /reporter's live records/);
  j.reporterCharacter = { id: "42" }; j.investigatedReads = 3;
  assert.match(finishRefusal(j, d, "done"), /Route it/);
  j.raisedToDevelopers = [{ id: 7 }];
  assert.match(finishRefusal(j, d, "done"), /Tell the player/);
  j.lastPlayerAt = 100; j.lastAskAt = 200;
  assert.equal(finishRefusal(j, d, "done"), null);
  assert.equal(finishRefusal(ticket(), d, "waiting"), null);
});

test("not a bug: the answered card stage routes it", () => {
  const j = ticket({ reporterCharacter: { id: "1" }, investigatedReads: 4, lastPlayerAt: 1, lastAskAt: 2 });
  const d = { jobs: { t1: j }, statusCards: { 9: { items: [{ name: "x", stage: "answered" }] } } };
  assert.equal(finishRefusal(j, d, "done"), null);
});

test("a data repair needs verified loss and a heal request or raise, never a bare promise", () => {
  const j = ticket({ tags: { kind: "data_repair" }, reporterCharacter: { id: "1" }, investigatedReads: 3, lastPlayerAt: 1, lastAskAt: 2 });
  const d = { jobs: { t1: j }, actions: {} };
  assert.match(finishRefusal(j, d, "done"), /request_heal/);
  d.actions.a = { jobId: "t1" };
  assert.equal(finishRefusal(j, d, "done"), null);
});

test("the activation context lists the steps and names the next one", () => {
  const ctx = contextFor(ticket({ tags: { kind: "mechanics_question" } }), { jobs: {} });
  assert.equal(ctx.kind, "mechanics_question");
  assert.match(ctx.steps[0], /^\[ \] Check the rule/);
  assert.match(ctx.next, /Check the rule/);
});

test("the no-effect rule is in both prompts and in the bug and mechanics playbooks", () => {
  const fs = require("node:fs"), path = require("node:path");
  const rule = /says a research, upgrade, purchase or action had no effect, treat it as a likely bug first/;
  for (const f of ["KEIR.md", "KEIR-CORE.md"]) assert.match(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), rule, f);
  for (const kind of ["bug_report", "mechanics_question"]) {
    const j = ticket({ tags: { kind } });
    const labels = require("../lib/operator/playbooks").PLAYBOOKS[kind](require("../lib/operator/playbooks").facts(j, { jobs: { t1: j } })).map((s) => s.label).join("\n");
    assert.match(labels, /had no effect, check the state itself makes sense for the world/, kind);
  }
});
