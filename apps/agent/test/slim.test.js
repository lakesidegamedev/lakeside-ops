"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rules = require("../lib/slim/rules");
const S = require("../lib/slim/state");
const { buildTools, checkPublicText } = require("../lib/slim/tools");
const { createHost, wakePrompt } = require("../lib/slim/host");
const { createSlimToolServer } = require("../lib/slim/toolserver");
const { configToml, threadIdFrom } = require("../lib/slim/codex-session");
const { createReplayAdapters } = require("../lib/slim/adapters");
const { slimConfig, mayAct } = require("../lib/slim/config");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "keir-slim-"));
const clear = { state: () => ({ engaged: false }) };
const engaged = { state: () => ({ engaged: true, reason: "test" }) };
const base = (over = {}) => ({ state: S.emptyState(1), names: ["sababa", "Moshe Greenbaum"], ownerNames: ["Egg"], ownerPrivateNames: ["Ownername"], ...over });
const rulesHit = (text, over) => rules.checkPost(text, base(over)).problems.map((p) => p.rule);

test("config is off by default and only live may act", () => {
  assert.equal(slimConfig({}).mode, "off");
  assert.equal(slimConfig({ KEIR_SLIM_MODE: "nonsense" }).mode, "off");
  assert.equal(slimConfig({}).model, "gpt-6.2-sol");
  assert.equal(mayAct({ mode: "replay" }, clear), false);
  assert.equal(mayAct({ mode: "live" }, engaged), false);
  assert.equal(mayAct({ mode: "live" }, clear), true);
});

test("hard rules: a plain, sourced answer passes", () => {
  assert.deepEqual(rulesHit("Your bank failed on turn 183. The central bank's CA$6.36B advance was spent on bills, and that sank it. That is our bug."), []);
  assert.deepEqual(rulesHit("It is not fixed yet. A fix is being built, and I'll check your numbers after the next turn."), []);
  assert.deepEqual(rulesHit("Hi Moshe, I found the cause."), []);
});

test("hard rules: leaks", () => {
  assert.ok(rulesHit("See /root/projects/game/src/bank.ts").includes("leak_internal"));
  assert.ok(rulesHit("PR #7468 fixes it").includes("leak_internal"));
  assert.ok(rulesHit("The support_get tool returned it").includes("leak_internal"));
  assert.ok(rulesHit("I asked the codex model").includes("leak_runtime"));
  assert.ok(rulesHit("Your id is 198551111605551129").includes("leak_private"));
  assert.ok(rulesHit("Write to someone@example.com").includes("leak_private"));
  assert.ok(rulesHit("Ownername is looking at it").includes("leak_private"));
});

test("hard rules: outcome claims need receipts", () => {
  assert.ok(rulesHit("The fix is live now.").includes("outcome_receipt"));
  assert.ok(rulesHit("CA$88M has been paid into your company.").includes("outcome_receipt"));
  assert.deepEqual(rulesHit("Once the fix is live, it will stop."), []);
  let s = S.addReceipt(S.emptyState(1), "fixLive", { what: "bank", verifiedRead: "read the bank after turn 190: open, equity CA$88M" });
  assert.deepEqual(rules.checkPost("The fix is live now.", base({ state: s })).problems, []);
  s = S.addReceipt(s, "paid", { amount: "CA$88M", ledgerRef: "turn 190 restitution" });
  assert.deepEqual(rules.checkPost("CA$88M has been paid into your company.", base({ state: s })).problems, []);
});

test("hard rules: name, promises, owner voice", () => {
  assert.ok(rulesHit("Hi Dave, I found it.").includes("player_name"));
  assert.ok(rulesHit("We will compensate you for the bank.").includes("no_promise"));
  assert.ok(rulesHit("You'll get a refund.").includes("no_promise"));
  assert.ok(rulesHit("Egg decided to pay you back.").includes("owner_voice"));
  assert.ok(rulesHit("The developers will add this next week.").includes("owner_voice"));
  assert.deepEqual(rulesHit("Compensation is with the team now."), []);
});

test("hard rules: one spam cap, resolution exempt", () => {
  let s = S.recordHuman(S.emptyState(1), { role: "player", at: "2026-11-24T10:00:00Z" });
  s = S.recordPost(s, { text: "a", delivered: true }, Date.parse("2026-11-24T10:01:00Z"));
  assert.deepEqual(rules.checkPost("Update.", base({ state: s })).problems, []);
  s = S.recordPost(s, { text: "b", delivered: true }, Date.parse("2026-11-24T10:02:00Z"));
  assert.ok(rules.checkPost("Another update.", base({ state: s })).problems.some((p) => p.rule === "spam_cap"));
  assert.ok(!rules.checkPost("Your report is closed.", base({ state: s, kind: "resolution" })).problems.some((p) => p.rule === "spam_cap"));
  s = S.recordHuman(s, { role: "player", at: "2026-11-24T10:03:00Z" });
  assert.deepEqual(rules.checkPost("Answer.", base({ state: s })).problems, []);
});

test("hard rules: paused or killed refuses; every problem listed at once", () => {
  const s = { ...S.emptyState(1), paused: { by: "staff" } };
  assert.ok(rules.checkPost("Hi.", base({ state: s })).problems.some((p) => p.rule === "paused"));
  assert.ok(rules.checkPost("Hi.", base({ killed: true })).problems.some((p) => p.rule === "paused"));
  const many = rules.checkPost("Hi Dave, the fix is live and we will refund you. See PR #3.", base()).problems.map((p) => p.rule);
  for (const r of ["player_name", "outcome_receipt", "no_promise", "leak_internal"]) assert.ok(many.includes(r), r);
});

test("shape turns dashes into plain punctuation", () => {
  assert.equal(rules.shape("Turns 182–184 — all fine"), "Turns 182 to 184, all fine");
});

test("state: updates, approvals and rendering", () => {
  let s = S.applyUpdate(S.emptyState(5), { established: [{ fact: "bank failed turn 183", source: "bank record" }], ruled_out: [{ idea: "discount window loan", why: "too small" }], promises: [{ text: "post the cause", due: "today" }], next: { step: "trace advance", waits_on: "nothing" } });
  assert.equal(s.established.length, 1);
  s = S.applyUpdate(s, { established: [{ fact: "bank failed turn 183", source: "bank record" }] });
  assert.equal(s.established.length, 1, "no duplicate facts");
  const { state, approval } = S.addApproval(s, "decision", { question: "Cash or rebuild?", options: ["Cash", "Rebuild"] });
  assert.equal(approval.status, "pending");
  assert.match(state.next.waitsOn, /owner decision/);
  const r = S.render(S.answerApproval(state, approval.id, { status: "answered", text: "Cash" }).state);
  assert.match(r, /Established:[\s\S]*bank failed turn 183/);
  assert.match(r, /decision .* answered: Cash or rebuild\? -> Cash/);
});

function fakeCtx(over = {}) {
  const dir = tmp();
  const store = S.createFileStore(dir);
  const s = store.load(7); s.playerNames = ["sababa"]; s.lastHumanAt = new Date().toISOString(); store.save(s);
  const posted = [];
  const ctx = {
    ticket: 7, cfg: { ownerNames: ["Egg"], ownerPrivateNames: [] }, store, killSwitch: clear, now: () => Date.now(), effects: [], ruleHits: [], finished: null,
    playerNames: () => store.load(7).playerNames,
    adapters: {
      post: async (p) => { posted.push(p); return { delivered: true }; },
      resolve: async () => ({ delivered: true }),
      approval: async () => ({ recorded: true }),
      openPr: async () => ({ opened: true, url: "https://example.invalid/pull/1" }),
      mergeToDevelopment: async () => ({ merged: true }),
      mcpCall: async (server, tool) => ({ server, tool }),
      mcpList: async () => [{ name: "trace_bonds" }, { name: "lean_patch" }],
    },
    ...over,
  };
  return { ctx, store, posted, tools: Object.fromEntries(buildTools(ctx).map((t) => [t.name, t])) };
}

test("tools: post_reply posts once rules pass and records it", async () => {
  const { tools, posted, store, ctx } = fakeCtx();
  const bad = await tools.post_reply.handler({ text: "The fix is live.", kind: "update", basis: "none" });
  assert.equal(bad.posted, false);
  assert.equal(ctx.ruleHits[0].rule, "outcome_receipt");
  const good = await tools.post_reply.handler({ text: "I found the cause: the advance was spent on bills.", kind: "answer", basis: "bank record turn 183" });
  assert.equal(good.posted, true);
  assert.equal(posted.length, 1);
  assert.equal(store.load(7).posts.length, 1);
  await assert.rejects(tools.post_reply.handler({ text: "x", kind: "answer", basis: "" }), /basis/);
});

test("tools: approvals record and the ticket waits on the owner", async () => {
  const { tools, store } = fakeCtx();
  await assert.rejects(tools.request_decision.handler({ question: "Cash?", options: ["Cash"], why: "x" }), /two to four/);
  const r = await tools.request_decision.handler({ question: "Cash or rebuild?", options: ["Cash (recommended)", "Rebuild"], why: "cash is faster" });
  assert.equal(r.requested, true);
  await tools.request_compensation.handler({ amount: "CA$88M", recipient: "Greenbaum Group", basis: "equity before failure", evidence: "bank record" });
  await tools.request_promote.handler({ pr: "https://example.invalid/pull/1", what: "bank fix", why: "ticket", risk: "banks only", evidence: "tests" });
  assert.deepEqual(store.load(7).approvals.map((a) => a.kind), ["decision", "compensation", "promote"]);
});

test("tools: writes stop when paused; reads still work; game reads refuse writes", async () => {
  const { tools, store } = fakeCtx();
  const s = store.load(7); s.paused = { by: "staff" }; store.save(s);
  await assert.rejects(tools.update_state.handler({ next: { step: "x" } }), /paused/);
  await assert.rejects(tools.request_decision.handler({ question: "q", options: ["a", "b"], why: "w" }), /paused/);
  assert.equal((await tools.post_reply.handler({ text: "hello", kind: "answer", basis: "no facts" })).posted, false);
  assert.deepEqual(await tools.game_read.handler({ server: "gamestate", tool: "trace_bonds", args: {} }), { server: "gamestate", tool: "trace_bonds" });
  await assert.rejects(tools.game_read.handler({ server: "gamestate", tool: "lean_patch" }), /not a read/);
  assert.deepEqual((await tools.game_tools.handler({ server: "gamestate" })).map((t) => t.name), ["trace_bonds"]);
});

test("tools: receipts need the player's own read; PR text is public", async () => {
  const { tools, store } = fakeCtx();
  await assert.rejects(tools.record_receipt.handler({ kind: "fix_live", what: "bank" }), /verified_read/);
  await tools.record_receipt.handler({ kind: "fix_live", what: "bank", verified_read: "bank open after turn 190" });
  assert.equal((await tools.post_reply.handler({ text: "The fix is live now.", kind: "update", basis: "receipt" })).posted, true);
  const pr = await tools.open_pr.handler({ title: "fix(bank): advance", body: "Reported by sababa in ticket", tests: "ok" });
  assert.equal(pr.opened, false);
  assert.ok(checkPublicText("see /root/projects/x").length);
  const ok = await tools.open_pr.handler({ title: "fix(bank): central bank advance cannot be spent on bills", body: "Adds a guard.", tests: "bank tests pass" });
  assert.equal(ok.opened, true);
  assert.equal(store.load(7).prs.length, 1);
  await assert.rejects(tools.merge_to_development.handler({ pr: "https://example.invalid/pull/99" }), /own pull requests/);
});

test("codex session config keeps instructions as standing developer instructions", () => {
  const t = configToml({ model: "gpt-6.2-sol", effort: "low", sandbox: "read-only", compactTokens: 150000, instructions: 'Line "one"\nline two', url: "http://127.0.0.1:1/mcp/x" });
  assert.match(t, /developer_instructions = "Line \\"one\\"\\nline two"/);
  assert.match(t, /model_auto_compact_token_limit = 150000/);
  assert.match(t, /\[mcp_servers\.keir\]\nurl = "http:\/\/127\.0\.0\.1:1\/mcp\/x"/);
  assert.equal(threadIdFrom('{"type":"x"}\n{"type":"thread.started","thread_id":"abc"}\n'), "abc");
});

// A fake model: speaks MCP to the real tool endpoint, like Codex does.
function fakeSessions(script) {
  const calls = [];
  return {
    calls,
    async wake(req) {
      calls.push(req);
      const rpc = async (method, params) => (await (await fetch(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
      await rpc("initialize", {});
      const tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
      for (const [name, args] of script(req, tools)) await rpc("tools/call", { name, arguments: args });
      const completion = await (await fetch(req.completionUrl)).json().catch(() => null);
      return { sessionId: req.sessionId || "thread-1", completion, result: "done" };
    },
  };
}

function hostFixture({ mode = "replay", killSwitch = clear, script } = {}) {
  const dir = tmp();
  const store = S.createFileStore(path.join(dir, "tickets"));
  const sessions = fakeSessions(script || (() => [["post_reply", { text: "I'm looking at your bank now.", kind: "update", basis: "no facts" }], ["finish", { next_step: "read the bank", waits_on: "nothing" }]]));
  const toolServer = createSlimToolServer();
  const posted = [];
  const reports = [];
  const host = createHost({
    cfg: { mode, stateDir: dir, ownerNames: [], ownerPrivateNames: [], wakeTimeoutMs: 60000, budget: { wakesPerDay: 3, minutesPerTicket: 300 } },
    store, sessions, toolServer, killSwitch, checkoutFor: () => dir,
    adaptersFor: () => ({ post: async (p) => { posted.push(p); return { delivered: true }; }, mcpCall: async () => ({}), mcpList: async () => [] }),
    onWake: (r) => reports.push(r),
  });
  return { host, store, sessions, posted, reports, toolServer, dir };
}

test("host: a wake runs one session turn through the real tool endpoint", async () => {
  const f = hostFixture();
  f.host.setPlayerNames(9, ["sababa"]);
  const r = await f.host.deliver(9, [{ role: "player", name: "sababa", at: "2026-11-24T16:38:22Z", text: "my bank was closed" }]);
  assert.equal(r.finished, true);
  assert.equal(f.posted.length, 1);
  assert.equal(r.effects[0].kind, "post");
  assert.equal(f.store.load(9).sessionId, "thread-1");
  assert.match(f.sessions.calls[0].prompt, /Start by reading it with ticket_read/);
  assert.match(f.sessions.calls[0].instructions, /one support ticket for its whole life/);
  // The second wake resumes the same session and has no first-wake intro.
  await f.host.deliver(9, [{ role: "owner", name: "egg", at: "2026-11-24T19:06:30Z", text: "lol wtf" }, { role: "player", name: "sababa", at: "2026-11-24T19:06:00Z", text: "any news?" }]);
  assert.equal(f.sessions.calls[1].sessionId, "thread-1");
  assert.doesNotMatch(f.sessions.calls[1].prompt, /Start by reading/);
  assert.ok(f.sessions.calls[1].prompt.indexOf("OWNER egg") < f.sessions.calls[1].prompt.indexOf("PLAYER sababa"), "owner first");
  f.toolServer.close();
});

test("host: off, kill switch and pause hold events for later; budget pauses and alerts", async () => {
  const off = hostFixture({ mode: "off" });
  assert.equal((await off.host.deliver(1, [{ role: "player", at: "2026-11-24T10:00:00Z", text: "hi" }])).skipped, "off");
  assert.equal(off.sessions.calls.length, 0);
  const killed = hostFixture({ killSwitch: engaged });
  assert.equal((await killed.host.deliver(1, [{ role: "player", at: "2026-11-24T10:00:00Z", text: "hi" }])).skipped, "kill switch");
  const p = hostFixture();
  p.host.pause(1, { by: "staff", reason: "handling it" });
  assert.equal((await p.host.deliver(1, [{ role: "player", at: "2026-11-24T10:00:00Z", text: "first" }])).skipped, "paused");
  await p.host.resume(1);
  assert.match(p.sessions.calls[0].prompt, /first/, "held message delivered after resume");
  const b = hostFixture();
  for (let i = 0; i < 4; i++) await b.host.deliver(2, [{ role: "player", at: new Date(Date.UTC(2026, 10, 24, 10, i)).toISOString(), text: `m${i}` }]);
  assert.equal(b.sessions.calls.length, 3);
  assert.equal(b.store.load(2).paused.by, "budget");
  for (const f of [off, killed, p, b]) f.toolServer.close();
});

test("host: the spam cap holds across wakes until a person writes", async () => {
  const f = hostFixture({ script: () => [["post_reply", { text: "Update one.", kind: "update", basis: "no facts" }], ["post_reply", { text: "Update two.", kind: "update", basis: "no facts" }], ["post_reply", { text: "Update three.", kind: "update", basis: "no facts" }], ["finish", { next_step: "x", waits_on: "player" }]] });
  const r = await f.host.deliver(3, [{ role: "player", at: "2026-11-24T10:00:00Z", text: "hi" }]);
  assert.equal(f.posted.length, 2);
  assert.equal(r.ruleHits[0].rule, "spam_cap");
  f.toolServer.close();
});

test("wake prompt lists new events and the state", () => {
  const p = wakePrompt({ ticket: 4, state: S.emptyState(4), events: [{ role: "player", name: "a", at: "2026-11-24T10:00:00Z", text: "hello" }], now: Date.parse("2026-11-24T10:00:05Z"), first: true });
  assert.match(p, /Now: 2026-11-24T10:00:05/);
  assert.match(p, /PLAYER a: hello/);
  assert.match(p, /Ticket state:\n\nTicket 4/);
});

test("replay adapters hide everything after the replay point and capture writes", async () => {
  let cursor = "2026-11-24T17:00:00.000Z";
  const history = { title: "Bank closed", events: [
    { at: "2026-11-24T16:38:22.000Z", kind: "player_message", who: "player sababa", text: "my bank was closed" },
    { at: "2026-11-24T19:51:36.000Z", kind: "player_message", who: "player sababa", text: "later message" },
  ] };
  const seen = [];
  const mcp = { call: async (server, tool, args) => {
    seen.push({ tool, args });
    if (tool === "support_history_get") return { opened: "2026-11-20T00:00:00Z", closed: "2026-11-25T00:00:00Z", status: "resolved", events: [{ at: "2026-11-21T00:00:00Z" }, { at: "2026-11-24T18:00:00Z" }] };
    if (tool === "support_history_search") return { results: [{ ticket: 5, closed: "2026-11-25T00:00:00Z", status: "resolved" }] };
    return {};
  } };
  const a = createReplayAdapters({ mcp, ticket: 1896, getCursor: () => cursor, history });
  assert.deepEqual((await a.readTicket(1896)).conversation.map((m) => m.text), ["my bank was closed"]);
  const other = await a.historyRead({ number: 5 });
  assert.equal(other.events.length, 1);
  assert.equal(other.status, "open");
  const found = await a.historySearch({ query: "bank" });
  assert.equal(found.results[0].status, "open");
  assert.equal(seen.find((s) => s.tool === "support_history_search").args.until, "2026-11-24");
  await assert.rejects(a.githubGet("repos/x/y/pulls"), /not available/);
  await assert.rejects(a.mcpCall("ops-knowledge", "code_search", {}), /checkout/);
  assert.equal((await a.post({ text: "x" })).status, "captured");
  cursor = "2026-11-24T20:00:00.000Z";
  assert.equal((await a.readTicket(1896)).conversation.length, 2);
});
