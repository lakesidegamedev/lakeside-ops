"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolutionAttribution } = require("./support-attribution");

test("closing on Keir's behalf credits Keir independently of authenticated closer", () => {
  const r = resolutionAttribution({}, { agent: "keir", jobId: "j1", evidence: "verified answer" }, { by: "codex", now: 100 });
  assert.deepEqual(r, { agent: "keir", jobId: "j1", evidence: "verified answer", recordedBy: "codex", recordedAt: 100 });
});
test("another closer retrying delivery preserves existing attribution", () => {
  const prior = { agent: "keir", evidence: "fix", recordedBy: "codex", recordedAt: 100 };
  assert.equal(resolutionAttribution({ resolutionAttribution: prior }, undefined, { by: "other", now: 200 }), prior);
  assert.equal(resolutionAttribution({}, undefined, { by: "other", now: 200 }), null);
});
