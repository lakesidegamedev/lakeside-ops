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
      promotionStatus: async () => ({ held: true, holds: ["development to staging #1: labelled hold"], inMain: false, autoPromote: { enabled: true, reasons: [] } }),
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

test("slim MCP client: SSE responses parse, writes pass the gate, reads retry on connect failure", async () => {
  const { parseRpc, createSlimMcp } = require("../lib/slim/mcp");
  assert.deepEqual(parseRpc('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n'), { jsonrpc: "2.0", id: 1, result: { ok: 1 } });
  const dir = tmp(); const cfgFile = path.join(dir, "c.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { s: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer w" } }, remote: { url: "https://example.com/mcp" } } }));
  let tries = 0;
  const fetchImpl = async () => { tries++; if (tries < 2) throw new TypeError("fetch failed"); return { ok: true, text: async () => '{"result":{"content":[{"type":"text","text":"{\\"a\\":1}"}]}}' }; };
  const m = createSlimMcp({ configFile: cfgFile, readToken: "r", fetchImpl, retryMs: [1], gate: (w) => { throw new Error(`${w} refused`); } });
  assert.deepEqual(await m.call("s", "t", {}), { a: 1 });
  await assert.rejects(m.call("s", "t", {}, true), /refused/);
  await assert.rejects(m.call("remote", "t", {}), /no local MCP server/);
});

test("intake: takeover on first poll, new messages after, moderation never", async () => {
  const intake = require("../lib/slim/intake");
  const cfg = { ownerIds: ["100"], ownerHandles: ["egg3901"] };
  let events = { 1902: [{ id: "1902:opened", kind: "opened", who: "player v", at: "2026-11-25T14:38:20Z", text: "t" }, { id: "1902:m1", kind: "player_message", who: "player v", at: "2026-11-25T14:38:21Z", text: "hi" }] };
  const mcp = { call: async (s, tool, a) => {
    if (tool === "support_list") return { items: [{ kind: "ticket", number: 1902, category: "bug" }, { kind: "ticket", number: 1901, category: "moderation" }, ...(events[1903] ? [{ kind: "ticket", number: 1903, category: "bug" }] : [])] };
    return { title: "x", reporter: "v", character: "Vincent", events: events[a.number] || [] };
  } };
  const state = intake.createIntakeState(path.join(tmp(), "intake.json"));
  const one = await intake.poll({ mcp, cfg, state, first: true, now: Date.parse("2026-11-25T14:40:00Z") });
  assert.equal(one.length, 1);
  assert.equal(one[0].ticket, 1902);
  assert.equal(one[0].takeover, true);
  assert.equal(one[0].lastHumanAt, "2026-11-25T14:38:21.000Z");
  assert.equal((await intake.poll({ mcp, cfg, state, first: false, now: Date.parse("2026-11-25T14:41:00Z") })).length, 0, "nothing new");
  events[1902].push({ id: "1902:m2", kind: "staff_message", who: "staff egg3901", authorId: "100", at: "2026-11-25T15:00:00Z", text: "owner here" });
  events[1903] = [{ id: "1903:opened", kind: "opened", who: "player a", at: "2026-11-25T16:00:00Z", text: "t" }, { id: "1903:m1", kind: "player_message", who: "player a", at: "2026-11-25T16:00:01Z", text: "help" }];
  const two = await intake.poll({ mcp, cfg, state, first: false, now: Date.parse("2026-11-25T14:41:00Z") });
  assert.deepEqual(two.map((x) => [x.ticket, x.events.map((e) => e.role)]), [[1902, ["owner"]], [1903, ["player"]]]);
  assert.equal(intake.roleFor({ kind: "staff_message", who: "staff egg3901" }, cfg), "owner", "owner by handle when no id");
  assert.equal(intake.roleFor({ kind: "staff_message", who: "staff other", authorId: "5" }, cfg), "staff");
  assert.equal(intake.roleFor({ kind: "system_message" }, cfg), null);
});

test("owner answers: letters pick decision options; yes and no", () => {
  const { parseAnswer } = require("../lib/slim/owner-dm");
  const dec = { kind: "decision", payload: { options: ["Cash", "Rebuild"] } };
  assert.deepEqual(parseAnswer("B", dec), { status: "answered", text: "B) Rebuild" });
  assert.deepEqual(parseAnswer("decision-1a2b3c4d5e a, but quick", dec).text, "A) Cash (, but quick)");
  assert.equal(parseAnswer("yes do it", { kind: "promote" }).status, "approved");
  assert.equal(parseAnswer("no, wait for the reset", { kind: "compensation" }).status, "declined");
  assert.equal(parseAnswer("pay half", { kind: "compensation" }).status, "answered");
});

test("record_owner_answer only when the owner wrote this wake", async () => {
  const f = fakeCtx();
  const r = await f.tools.request_compensation.handler({ amount: "CA$1", recipient: "x", basis: "b", evidence: "e" });
  await assert.rejects(f.tools.record_owner_answer.handler({ approval_id: r.id, status: "approved", answer: "yes" }), /Only when the owner/);
  f.ctx.ownerSpoke = true;
  await f.tools.record_owner_answer.handler({ approval_id: r.id, status: "approved", answer: "yes" });
  assert.equal(f.store.load(7).approvals[0].status, "approved");
});

test("request_decision: an owner or staff decision already on the ticket is used, not asked again", async () => {
  const f = fakeCtx();
  f.ctx.adapters.historyRead = async () => ({ events: [{ at: "2026-11-25T15:00:00Z", kind: "staff_message", who: "staff egg3901", text: "we can remove that arbitrary restriction, if it's been researched it should be added" }] });
  const ask = { question: "Should researched production methods work before they reach the plant's country?", options: [{ label: "Allow once researched", detail: "Player companies can switch as soon as they research it." }, { label: "Keep the wait", detail: "Show the opening year instead." }], why: "A player researched a method but could not use it." };
  const first = await f.tools.request_decision.handler(ask);
  assert.equal(first.requested, false);
  assert.match(first.ownerAndStaffMessages[0].text, /remove that arbitrary restriction/);
  assert.equal(f.store.load(7).approvals.length, 0, "nothing sent to the owner");
  const second = await f.tools.request_decision.handler({ ...ask, owner_messages_checked: "the staff message is about a different screen" });
  assert.equal(second.requested, true);
  // Answered (here by the owner) means decided: the same question is not asked again.
  const { state } = S.answerApproval(f.store.load(7), second.id, { status: "answered", text: "A) Allow once researched" });
  f.store.save(state);
  const third = await f.tools.request_decision.handler({ ...ask, question: "Should researched production methods be usable before they reach the plant's country?", owner_messages_checked: "x" });
  assert.equal(third.requested, false);
  assert.match(third.alreadyDecided.answer, /Allow once researched/);
});

test("owner cards: plain copy, recommended first, the id only in button ids, clicks read back", () => {
  const oc = require("../lib/slim/ownercopy");
  const bad = oc.checkOwnerCopy({ question: "Remove the country diffusion check?", why: "decision-d3f787d6b5 covers it. The switch_command path runs it. See PR #7557.", options: [{ label: "A", detail: "x" }] });
  for (const m of [/diffusion/, /decision-d3f787d6b5/, /PR #7557/]) assert.ok(bad.some((p) => m.test(p)), String(m));
  assert.ok(oc.checkOwnerCopy({ question: "q", why: "One. Two. Three. Four.", options: [] }).some((p) => /three short sentences/.test(p)));
  const payload = { question: "Should researched methods be usable right away?", why: "A player researched a method but the game made them wait until 2036.", options: [{ label: "Allow once researched", detail: "Players can switch as soon as they research it." }, { label: "Keep the wait", detail: "Show the opening year on the screen instead." }] };
  assert.deepEqual(oc.checkOwnerCopy(payload), []);
  const card = oc.renderCard({ ticket: 1902, kind: "decision", id: "decision-d3f787d6b5", payload });
  const visible = JSON.stringify({ c: card.content, e: card.embeds, labels: card.components.flatMap((r) => r.components.map((b) => b.label)) });
  assert.doesNotMatch(visible, /decision-d3f787d6b5/);
  assert.equal(card.embeds[0].title, payload.question);
  assert.match(card.embeds[0].fields[0].name, /^A\. Allow once researched \(recommended\)$/);
  assert.deepEqual(card.components[0].components.map((b) => b.custom_id), ["keir_decision:choose1:decision-d3f787d6b5", "keir_decision:choose2:decision-d3f787d6b5"]);
  const approval = { kind: "decision", payload };
  assert.deepEqual(oc.verdictFrom(`${card.content}\n\n**Decision:** 🔹 Selected 1 by <@333052320252297216> <t:1795571366:R>`, card.content, approval), { actor: "333052320252297216", status: "answered", text: "A) Allow once researched" });
  const promote = oc.renderCard({ ticket: 1, kind: "promote", id: "promote-0123456789", payload: { what: "Researched methods work right away", why: "Fix tested.", risk: "Only player companies.", pr: "https://github.com/o/r/pull/1" } });
  assert.deepEqual(promote.components[0].components.map((b) => b.custom_id || b.url), ["keir_decision:approve:promote-0123456789", "keir_decision:reject:promote-0123456789", "keir_decision:explain:promote-0123456789", "https://github.com/o/r/pull/1"]);
  assert.equal(oc.verdictFrom(`${promote.content}\n\n**Decision:** ✅ Approved by <@333052320252297216>`, promote.content, null).status, "approved");
  assert.equal(oc.verdictFrom(`${promote.content}\n\n**Decision:** ❌ Rejected by <@333052320252297216>: not yet`, promote.content, null).text, "not yet");
  assert.equal(oc.verdictFrom("someone else's text", promote.content, null), null);
});

test("owner DM: a clicked card is read back once; typed letters still work", async () => {
  const { createOwnerDm } = require("../lib/slim/owner-dm");
  const oc = require("../lib/slim/ownercopy");
  const payload = { question: "Cash or rebuild?", why: "w", options: [{ label: "Cash", detail: "d" }, { label: "Rebuild", detail: "d" }] };
  const card = oc.renderCard({ ticket: 9, kind: "decision", id: "decision-aaaaaaaaaa", payload });
  let content = card.content;
  const fetchImpl = async (url, opts = {}) => {
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (opts.method === "POST") return ok({ id: "500", content: JSON.parse(opts.body).content });
    if (/messages\/500$/.test(url)) return ok({ id: "500", content });
    if (/limit=1$/.test(url)) return ok([{ id: "400" }]);
    return ok([]);
  };
  const dm = createOwnerDm({ token: "t", channel: "c", ownerIds: ["333052320252297216"], stateFile: path.join(tmp(), "dm.json"), fetchImpl });
  await dm.sendCard({ ticket: 9, kind: "decision", id: "decision-aaaaaaaaaa", card });
  const approvalOf = () => ({ kind: "decision", payload });
  assert.deepEqual(await dm.answers(approvalOf), []);
  content = `${card.content}\n\n**Decision:** 🔹 Selected 2 by <@333052320252297216>`;
  const got = await dm.answers(approvalOf);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].answer, { status: "answered", text: "B) Rebuild" });
  assert.deepEqual(await dm.answers(approvalOf), [], "read once");
});

test("host: messages in flight when the process stopped are delivered after a restart", async () => {
  const f = hostFixture();
  fs.writeFileSync(path.join(f.dir, "pending", "inflight-5.json"), JSON.stringify([{ role: "player", at: "2026-11-25T10:00:00Z", text: "lost in a restart" }]));
  const again = createHost({ cfg: { mode: "replay", stateDir: f.dir, ownerNames: [], ownerPrivateNames: [], wakeTimeoutMs: 60000, budget: { wakesPerDay: 9, minutesPerTicket: 300 } }, store: f.store, sessions: f.sessions, toolServer: f.toolServer, killSwitch: clear, checkoutFor: () => f.dir, adaptersFor: () => ({ post: async () => ({ delivered: true }), mcpCall: async () => ({}), mcpList: async () => [] }) });
  assert.ok(!fs.existsSync(path.join(f.dir, "pending", "inflight-5.json")));
  await again.deliver(5, []);
  assert.match(f.sessions.calls.at(-1).prompt, /lost in a restart/);
  f.toolServer.close();
});

test("request_promote: the auto-promoter ships it unless the promotion is held or a hotfix", async () => {
  const ask = { pr: "https://github.com/o/r/pull/7557", what: "Researched methods work right away", why: "The fix is merged.", risk: "Only player companies.", evidence: "tests pass" };
  const status = (over) => async () => ({ held: false, holds: [], inMain: false, inStaging: false, autoPromote: { enabled: true, reasons: [] }, promotePrs: [{ number: 7582 }], ...over });
  let f = fakeCtx(); f.ctx.adapters.promotionStatus = status();
  let r = await f.tools.request_promote.handler(ask);
  assert.equal(r.requested, false);
  assert.match(r.note, /Do not ask the owner/);
  assert.equal(f.store.load(7).approvals.length, 0, "no owner ping");
  r = await f.tools.request_promote.handler({ ...ask, hotfix_reason: "players are losing money every turn" });
  assert.equal(r.requested, true, "a hotfix may ask");
  f = fakeCtx(); f.ctx.adapters.promotionStatus = status({ held: true, holds: ["the auto-promote off switch is set"] });
  assert.equal((await f.tools.request_promote.handler(ask)).requested, true, "held: ask");
  f = fakeCtx(); f.ctx.adapters.promotionStatus = status({ inMain: true });
  assert.match((await f.tools.request_promote.handler(ask)).note, /already on main/);
  f = fakeCtx(); f.ctx.adapters.promotionStatus = async () => { throw new Error("gh down"); };
  const err = await f.tools.request_promote.handler(ask);
  assert.equal(err.requested, false);
  assert.equal(f.store.load(7).approvals.length, 0, "never ask on a guess");
});

test("cutover: nothing from before Keir went live is delivered, and a resolved ticket is never resolved again", async () => {
  const intake = require("../lib/slim/intake");
  const cfg = { ownerIds: [], ownerHandles: [] };
  const events = { 5: [{ id: "5:opened", kind: "opened", who: "player a", at: "2026-11-25T10:00:00Z", text: "t" }, { id: "5:m1", kind: "player_message", who: "player a", at: "2026-11-25T10:00:01Z", text: "old" }] };
  const items = [{ kind: "ticket", number: 5, category: "bug" }];
  const mcp = { call: async (s, tool, a) => (tool === "support_list" ? { items } : { title: "x", opened: events[a.number][0].at, events: events[a.number] }) };
  const state = intake.createIntakeState(path.join(tmp(), "intake.json"));
  const now = Date.parse("2026-11-25T18:00:00Z");
  assert.equal((await intake.poll({ mcp, cfg, state, first: true, now })).length, 1);
  // A later poll that finds an old event for the first time (a backfilled or late record) does not deliver it.
  events[5].push({ id: "5:m0", kind: "player_message", who: "player a", at: "2026-11-25T09:00:00Z", text: "backfilled earlier message" });
  assert.equal((await intake.poll({ mcp, cfg, state, first: false, now })).length, 0);
  // A ticket Keir sees for the first time after start that opened before go-live is a takeover, not a replay.
  items.push({ kind: "ticket", number: 6, category: "bug" });
  events[6] = [{ id: "6:opened", kind: "opened", who: "player b", at: "2026-10-20T00:00:00Z", text: "t" }, { id: "6:m1", kind: "player_message", who: "player b", at: "2026-10-20T00:00:01Z", text: "from october" }];
  const late = await intake.poll({ mcp, cfg, state, first: false, now });
  assert.equal(late[0].ticket, 6);
  assert.equal(late[0].takeover, true);
  assert.ok(!late[0].events.some((e) => /from october/.test(e.text)));
  // resolve_ticket on an already resolved ticket sends nothing.
  const f = fakeCtx();
  let resolved = 0;
  f.ctx.adapters.readTicket = async () => ({ status: "resolved" });
  f.ctx.adapters.resolve = async () => { resolved++; return { delivered: true }; };
  const r = await f.tools.resolve_ticket.handler({ message: "Your report is closed.", basis: "x" });
  assert.equal(r.resolved, false);
  assert.equal(resolved, 0);
});
