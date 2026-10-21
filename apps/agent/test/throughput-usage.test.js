"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { emptyLanes, pickForLanes } = require("../lib/operator/lanes");
const { estimate, usageReport } = require("../lib/operator/usage");
const { usageRecord } = require("../lib/operator/agent");
const job = (id, kind, extra = {}) => ({ id, kind, state: "queued", at: 1, ...extra });
test("usage receipts keep exact version, host tool calls and empty-run evidence including interrupted runs", () => {
  const release = { version: "5.9.5", sha: "a".repeat(40) };
  const record = usageRecord(job("x", "ticket"), { interrupted: true }, 10, "claude-opus-5-5", "claude-cli-subscription", { release, toolCalls: 0, empty: true });
  assert.deepEqual(record.release, release); assert.equal(record.toolCalls, 0); assert.equal(record.emptyActivation, true);
  assert.equal(record.outcome, "interrupted");
  assert.equal(usageRecord(job("x", "ticket"), {}, 1, "model").release, null);
});
test("three coders and three investigators run together, with chat available under full background load", () => {
  const jobs = [...Array.from({ length: 4 }, (_, i) => job(`c${i}`, "coding")),
    ...Array.from({ length: 4 }, (_, i) => job(`i${i}`, "ticket", { ticket: i + 1 })),
    job("owner", "command", { role: "owner" }), job("watch", "finding", { operatorRole: "watchkeeper" }), job("eng", "finding", { operatorRole: "engineering" })];
  const picks = pickForLanes(jobs, emptyLanes());
  assert.equal(picks.filter(p => p.job.kind === "coding").length, 3);
  assert.equal(picks.filter(p => p.job.kind === "ticket").length, 3);
  const active = emptyLanes();
  for (const p of picks) { active[p.lane] = { job: p.job }; p.job.state = "running"; }
  const chat = pickForLanes([...jobs, job("chat", "conversation")], active);
  assert.equal(chat.length, 1); assert.equal(chat[0].lane, "conversation");
});
test("parallel slots never duplicate a ticket or bypass a staff claim", () => {
  const jobs = [job("a", "coding", { ticket: 9 }), job("b", "coding", { ticket: 9 }),
    job("held", "ticket", { ticket: 1558, channelId: "held" }), job("free", "ticket", { ticket: 10 })];
  const picks = pickForLanes(jobs, emptyLanes(), { claimedBy: id => id === "held" ? "owner" : null });
  assert.deepEqual(picks.map(p => p.job.id).sort(), ["a", "free"]);
});
const at = "2026-10-16T00:00:00Z";
const codex = { event: "activation", at, job: "a", model: "gpt-6.1-sol", provider: "codex-cli-chatgpt-subscription", durationMs: 100, outcome: "ok",
  tokens: { input: 1000000, output: 100000, cacheRead: 900000, cacheWrite: null } };
test("Codex inclusive input is not double counted; request context uncertainty is explicit", () => {
  const e = estimate(codex);
  assert.equal(e.usd, 1.29); assert.equal(e.upperUsd, 2.08);
  assert.equal(estimate({ ...codex, tokens: { ...codex.tokens, cacheRead: 2000000 } }).status, "invalid-usage");
});
test("Claude cache writes and TTL use separate rates and missing legacy write counts stay unknown", () => {
  const row = { ...codex, model: "claude-opus-5-5", provider: "claude-cli-subscription", tokens: { input: 100, output: 100, cacheRead: 1000, cacheWrite: 1000, cacheWrite5m: 400, cacheWrite1h: 600 } };
  assert.equal(estimate(row).usd, 0.0094);
  assert.equal(estimate(row).upperUsd, 0.0094);
  assert.equal(estimate({ ...row, tokens: { ...row.tokens, cacheWrite: null } }).usd, null);
});
test("unknown models, partial telemetry and API request events never become free complete measurements", () => {
  const rows = [codex, { ...codex, job: "b", model: "unknown" }, { ...codex, tokens: { input: null, output: null } }, { ...codex, event: "usage" }, { ...codex, at: "2026-10-14T00:00:00Z" }];
  const r = usageReport(rows, { since: Date.parse(at), until: Date.parse(at) });
  assert.equal(r.total.activations, 3); assert.equal(r.total.pricedActivations, 1); assert.equal(r.total.measuredActivations, 2);
  assert.equal(r.total.apiEquivalentUsd, 1.29); assert.equal(r.pricing.actualBilledUsd, null);
  assert.deepEqual(r.total.unpriced, { "unknown-model": 1, "missing-usage": 1 });
  assert.equal(r.tasks.length, 2);
  assert.equal(usageReport([], { since: 0, until: 1 }).total.apiEquivalentUsd, null);
});
test("Gemini rate changes are timestamped and structured usage survives into task records", () => {
  const row = { ...codex, model: "gemini-3.8-flash", provider: "antigravity-cli-subscription", tokens: { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(estimate(row).usd, 4.5);
  assert.equal(estimate({ ...row, at: "2027-01-01T00:00:00Z" }).usd, 9);
  const r = usageRecord({ id: "child", codingParent: "parent", state: "done" }, { usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 } } }, 3, "claude-opus-5-5");
  assert.equal(r.parent, "parent"); assert.equal(r.taskState, "done"); assert.equal(r.tokens.cacheWrite1h, 2);
});
test("shared host capacity is a wait, and uncertain writes remain held", () => {
  const { retryReadFailure } = require("../lib/operator/recovery");
  const error = new Error("model request failed: rust runner: resource admission refused: all 8 host worker slots are occupied");
  const j = { effects: {} };
  assert.equal(retryReadFailure(j, error, 100), true); assert.equal(j.state, "waiting"); assert.equal(j.wakeAt, 30100);
  assert.equal(retryReadFailure({ effects: { x: { state: "started" } } }, error), false);
});
