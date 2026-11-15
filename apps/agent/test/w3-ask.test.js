"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createAskTool } = require("../lib/operator/asktool");

const sse = (done) => `event: done\ndata: ${JSON.stringify(done)}\n\n`;
function fetcher(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const route = new URL(url).pathname; calls.push({ route, body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.authorization });
    const r = routes[route]; if (!r) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => r.text ?? JSON.stringify(r.json) };
  };
  f.calls = calls; return f;
}
const cfg = { askUrl: "https://ask.example", askSecret: "s".repeat(40) };

test("health says failing and tells Keir not to redirect", async () => {
  const f = fetcher({ "/healthz": { json: {} }, "/api/keir-ask/health": { json: { status: "failing", total: 50, refused: 30, refusalRate: 0.6 } } });
  const out = await createAskTool({ config: cfg, fetcher: f }).call({}, { action: "health" });
  assert.equal(out.status, "failing"); assert.match(out.instruction, /Do not redirect/);
});

test("health without the secret falls back to the public probe", async () => {
  const out = await createAskTool({ config: { askUrl: cfg.askUrl }, fetcher: fetcher({ "/healthz": { json: {} } }) }).call({}, { action: "health" });
  assert.equal(out.reachable, true); assert.equal(out.status, "unknown");
});

test("health reports down when Ask is unreachable", async () => {
  const out = await createAskTool({ config: cfg, fetcher: async () => { throw new Error("ECONNREFUSED"); } }).call({}, { action: "health" });
  assert.equal(out.status, "down");
});

test("unconfigured Ask degrades to a note", async () => {
  assert.equal((await createAskTool({ config: {}, fetcher: fetcher({}) }).call({}, { action: "health" })).status, "unknown");
  assert.match((await createAskTool({ config: { askUrl: "https://x" }, fetcher: fetcher({}) }).call({ ticket: 1 }, { action: "history" })).note, /not configured/);
});

test("history is scoped to the ticket's reporter, ignoring userKeys from a non-staff task", async () => {
  const f = fetcher({ "/api/keir-ask/history": { json: { count: 1, asks: [{ outcome: "refused" }] } } });
  const tool = createAskTool({ config: cfg, fetcher: f, resolveIdentity: async () => ({ private: { userId: "u1", discordId: "900000000000001" } }), staff: () => false });
  const out = await tool.call({ ticket: 5, source: { authorId: "900000000000001" } }, { action: "history", userKeys: ["discord:777"] });
  assert.deepEqual(f.calls.at(-1).body.userKeys, ["discord:900000000000001", "ahd:u1"]);
  assert.equal(out.refused, 1); assert.match(out.instruction, /Do not tell the player Ask will answer/);
});

test("staff may name keys", async () => {
  const f = fetcher({ "/api/keir-ask/history": { json: { count: 0, asks: [] } } });
  await createAskTool({ config: cfg, fetcher: f, staff: () => true }).call({ ticket: 5 }, { action: "history", userKeys: ["discord:777"] });
  assert.deepEqual(f.calls.at(-1).body.userKeys, ["discord:777"]);
});

test("query returns Ask's answer and flags a refusal", async () => {
  const ok = fetcher({ "/api/keir-ask/answer": { text: sse({ answer: "Cloture needs 60 votes.", validation: { issues: [] } }) } });
  const a = await createAskTool({ config: cfg, fetcher: ok }).call({ id: "j", role: "support" }, { action: "query", question: "How is cloture counted?" });
  assert.equal(a.answered, true);
  const bad = fetcher({ "/api/keir-ask/answer": { text: sse({ answer: "I can't tell.", validation: { issues: ["refused_with_live_evidence"] } }) } });
  const b = await createAskTool({ config: cfg, fetcher: bad }).call({ id: "j", role: "support" }, { action: "query", question: "How is cloture counted?" });
  assert.equal(b.answered, false); assert.match(b.instruction, /Do not redirect/);
  await assert.rejects(createAskTool({ config: cfg, fetcher: ok }).call({ role: "player" }, { action: "query", question: "How is cloture counted?" }), /players cannot/);
});

test("a failing Ask switches the advice redirect off and the context says why", () => {
  const advice = require("../lib/operator/advicerouting");
  const job = { kind: "ticket", role: "support", ticket: 9, tags: { kind: "gameplay_advice" }, source: { content: "Where should I invest my money?" } };
  advice.resetAskHealth();
  assert.equal(advice.requiresRedirect(job, {}), true);
  advice.noteAskHealth({ status: "failing", refusalRate: 0.6 }, Date.now());
  assert.equal(advice.requiresRedirect(job, {}), false);
  assert.match(advice.askNote(), /60%/);
  advice.noteAskHealth({ status: "failing", refusalRate: 0.6 }, Date.now() - 31 * 60000);
  assert.equal(advice.requiresRedirect(job, {}), true, "a stale reading changes nothing");
  advice.noteAskHealth({ status: "ok" }); assert.equal(advice.askNote(), null);
  advice.resetAskHealth();
});
