"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { args, locations } = require("../bin/lakeside");
test("CLI separates prompts from explicit setup flags", () => {
  assert.deepEqual(args(["chat", "inspect", "my", "project", "--thread", "thread1"]), { command: "chat", options: { thread: "thread1" }, words: ["inspect", "my", "project"] });
  assert.equal(locations({ XDG_CONFIG_HOME: "/tmp/config", XDG_STATE_HOME: "/tmp/state" }).config, path.join("/tmp/config", "lakeside", "lakeside.json"));
});
