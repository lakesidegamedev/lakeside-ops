"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { leaked } = require("../lib/operator/toolmarkup");

test("printed tool calls are recognised and never treated as an answer", () => {
  assert.equal(leaked('I will check.\n<tool_calls>\n<invoke name="mcp__keir__github">\n<parameter name="action">status</parameter>\n</invoke>\n</tool_calls>'), true);
  assert.equal(leaked("<｜DSML｜function_calls>"), true);
  assert.equal(leaked("PR #4404 is green and merged; the fix is live on the main server."), false);
  assert.equal(leaked("Use the invoke button in settings."), false);
  assert.equal(leaked("I'll start by understanding the available tools and then answer Ariane's question."), true);
  assert.equal(leaked("Let me discover the tools I have access to."), true);
  assert.equal(leaked("I'll check your mine's sales next turn and tell you here."), false);
});

test("direct DeepSeek double-bar tool markup is rejected", () => {
  assert.equal(leaked('<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_tool">'), true);
  assert.equal(leaked('<||DSML|| calls>'), true);
});
