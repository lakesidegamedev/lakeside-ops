"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { redChecks } = require("../lib/operator/github");

test("a cancelled check superseded by a newer run of the same check is not red", () => {
  const runs = [
    { name: "custom-rules", status: "completed", conclusion: "cancelled" },
    { name: "custom-rules", status: "completed", conclusion: "success" },
    { name: "verify", status: "in_progress", conclusion: null },
  ];
  assert.deepEqual(redChecks(runs), []);
  assert.deepEqual(redChecks([{ name: "custom-rules", status: "completed", conclusion: "cancelled" }]).map((r) => r.name), ["custom-rules"]);
  assert.deepEqual(redChecks([...runs, { name: "test (1)", status: "completed", conclusion: "failure" }]).map((r) => r.name), ["test (1)"]);
});
