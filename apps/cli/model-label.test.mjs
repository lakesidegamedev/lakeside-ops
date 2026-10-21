import test from "node:test";
import assert from "node:assert/strict";
import { describeModel } from "./tui/model-label.mjs";

const PALETTE = ["primary", "blue", "amber", "text", "muted", "dim", "green"];

test("model ids are formatted with an acronym-aware title case", () => {
  const deepseek = describeModel("opencode-go", "deepseek-v4.1-flash-free");
  assert.equal(deepseek.model, "Deepseek V4.1-Flash-Free");
  assert.equal(deepseek.provider, "OpenCode Go");
  assert.equal(deepseek.label, "OpenCode Go - Deepseek V4.1-Flash-Free");

  assert.equal(describeModel("anthropic", "claude-sonnet-4-5").model, "Sonnet-4-5");
  assert.equal(describeModel("anthropic", "claude-sonnet-4-5").label, "Claude - Sonnet-4-5");
  assert.equal(describeModel("openai", "gpt-5.1-codex").model, "GPT-5.1-Codex");
});

test("a reseller keeps its route name but borrows the model family mark", () => {
  const resold = describeModel("opencode", "deepseek-v4.1-flash-free");
  assert.equal(resold.provider, "OpenCode Zen");
  assert.equal(resold.label, "OpenCode Zen - Deepseek V4.1-Flash-Free");
  assert.equal(resold.glyph, "≈");
  assert.equal(resold.color, "blue");
});

test("unknown and empty ids stay readable", () => {
  const unknown = describeModel("weird", "mystery-model");
  assert.equal(unknown.provider, "Weird");
  assert.equal(unknown.model, "Mystery Model");
  assert.equal(unknown.label, "Weird - Mystery Model");
  assert.equal(unknown.glyph, "◆");
  assert.equal(unknown.color, "dim");

  assert.deepEqual(describeModel("", ""), { label: "", provider: "", model: "", glyph: "◆", color: "dim" });
});

test("every mark is one character and every colour is a palette key", () => {
  const models = [
    ["anthropic", "claude-sonnet-4-5"],
    ["openai", "gpt-5.1-codex"],
    ["opencode-go", "deepseek-v4.1-flash-free"],
    ["google", "gemini-2.5-pro"],
    ["xai", "grok-4"],
    ["meta", "llama-3.3-70b"],
    ["mistral", "mistral-large"],
    ["ollama", "llama3.2"],
    ["weird", "mystery-model"],
    ["", ""],
  ];
  for (const [provider, model] of models) {
    const result = describeModel(provider, model);
    assert.equal(result.glyph.length, 1);
    assert.ok(PALETTE.includes(result.color), `${result.color} is not a palette key`);
  }
});
