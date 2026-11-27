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
      changedFiles: async () => ["src/components/OperationsCard.tsx"],
      duplicatePrs: async () => ({ strong: [], related: [] }),
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
  const sessions = fakeSessions(script || (() => [["post_reply", { text: "Your bank failed on turn 183 when the advance was spent on bills.", kind: "update", basis: "no facts" }], ["finish", { next_step: "read the bank", waits_on: "nothing" }]]));
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

test("intake: takeover on first poll, new messages after; investigation tickets never", async () => {
  const intake = require("../lib/slim/intake");
  const cfg = { ownerIds: ["100"], ownerHandles: ["egg3901"] };
  let events = { 1902: [{ id: "1902:opened", kind: "opened", who: "player v", at: "2026-11-25T14:38:20Z", text: "t" }, { id: "1902:m1", kind: "player_message", who: "player v", at: "2026-11-25T14:38:21Z", text: "hi" }] };
  const mcp = { call: async (s, tool, a) => {
    if (tool === "support_list") return { items: [{ kind: "ticket", number: 1902, category: "bug" }, { kind: "ticket", number: 1901, category: "investigation" }, ...(events[1903] ? [{ kind: "ticket", number: 1903, category: "bug" }] : [])] };
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

test("resolve_ticket: only after confirmation, a request to close, or 24 quiet hours after the last post", async () => {
  const f = fakeCtx();
  let sent = 0;
  let clock = Date.parse("2026-11-25T19:00:00Z");
  f.ctx.now = () => clock;
  f.ctx.adapters.readTicket = async () => ({ status: "open" });
  f.ctx.adapters.resolve = async () => { sent++; return { delivered: true }; };
  let player = [{ at: "2026-11-25T14:00:00Z", text: "tech says 2036" }];
  f.ctx.adapters.historyRead = async () => ({ events: player });
  const s = f.store.load(7); s.lastPlayerAt = "2026-11-25T14:00:00Z"; f.store.save(s);
  const close = { message: "Your report is closed.", basis: "fix live receipt" };
  assert.match((await f.tools.resolve_ticket.handler(close)).note, /Post the answer/);
  f.store.save(S.recordPost(f.store.load(7), { text: "It's live now.", kind: "update", delivered: true }, Date.parse("2026-11-25T18:58:00Z")));
  // Two minutes after "it's live": refused (ticket 1902).
  const early = await f.tools.resolve_ticket.handler(close);
  assert.equal(early.resolved, false);
  assert.match(early.note, /1440 minutes/);
  // A made-up confirmation is refused.
  assert.equal((await f.tools.resolve_ticket.handler({ ...close, player_confirmed: "works now, thanks" })).resolved, false);
  // The player writes something else after the post: answer first.
  player = [...player, { at: "2026-11-25T19:30:00Z", text: "still shows 2036 on one plant" }];
  clock = Date.parse("2026-11-26T20:00:00Z");
  assert.match((await f.tools.resolve_ticket.handler(close)).note, /wrote after your last post/);
  // They confirm after a new post: allowed.
  f.store.save(S.recordPost(f.store.load(7), { text: "That plant is fixed too.", kind: "update", delivered: true }, Date.parse("2026-11-26T20:05:00Z")));
  player = [...player, { at: "2026-11-26T20:10:00Z", text: "Works now, thanks!" }];
  clock = Date.parse("2026-11-26T20:11:00Z");
  assert.equal((await f.tools.resolve_ticket.handler({ ...close, player_confirmed: "works now, thanks" })).resolved, true);
  assert.equal(sent, 1);
});

test("resolve_ticket: 24 quiet hours, or the player asking to close", async () => {
  const f = fakeCtx();
  let clock = Date.parse("2026-11-26T19:01:00Z");
  f.ctx.now = () => clock;
  f.ctx.adapters.readTicket = async () => ({ status: "open" });
  f.ctx.adapters.resolve = async () => ({ delivered: true });
  f.ctx.adapters.historyRead = async () => ({ events: [{ at: "2026-11-25T14:00:00Z", text: "you can close this" }] });
  f.store.save(S.recordPost(f.store.load(7), { text: "It's live now.", kind: "update", delivered: true }, Date.parse("2026-11-25T19:00:00Z")));
  assert.equal((await f.tools.resolve_ticket.handler({ message: "Closed.", basis: "x" })).resolved, true, "24 quiet hours passed");
  const g = fakeCtx();
  g.ctx.now = () => Date.parse("2026-11-25T19:05:00Z");
  g.ctx.adapters.readTicket = async () => ({ status: "open" });
  g.ctx.adapters.resolve = async () => ({ delivered: true });
  g.ctx.adapters.historyRead = async () => ({ events: [{ at: "2026-11-25T19:03:00Z", text: "All good, you can close this ticket" }] });
  g.store.save(S.recordPost(g.store.load(7), { text: "It's live now.", kind: "update", delivered: true }, Date.parse("2026-11-25T19:00:00Z")));
  assert.equal((await g.tools.resolve_ticket.handler({ message: "Closed.", basis: "x", player_asked_to_close: "you can close this ticket" })).resolved, true);
});

test("spam cap on ticket 1904's timeline: the fourth post and the repeated screenshot ask are stopped", () => {
  let s = S.emptyState(1904);
  const human = (at) => { s = S.recordHuman(s, { role: "player", at }); };
  const post = (at, text) => { s = S.recordPost(s, { text, kind: "question", delivered: true }, Date.parse(at)); };
  const check = (at, text) => rules.checkPost(text, { state: s, now: Date.parse(at), names: ["Ben Harrison"] }).problems.filter((p) => p.rule === "spam_cap");
  human("2026-11-26T02:59:42Z");
  const first = "What looks wrong on the corporation page, and which section is it in? I couldn't open the screenshot.";
  assert.deepEqual(check("2026-11-26T03:00:55Z", first), []);
  post("2026-11-26T03:00:55Z", first);
  human("2026-11-26T03:06:21Z");
  assert.deepEqual(check("2026-11-26T03:07:27Z", "Which word or label is showing vertically? One example is enough."), []);
  post("2026-11-26T03:07:27Z", "Which word or label is showing vertically? One example is enough.");
  human("2026-11-26T03:07:57Z");
  const third = check("2026-11-26T03:08:17Z", "I see the screenshot attached. It still won't open on my side. If you can type one of the words, I can find it.");
  assert.ok(third.some((p) => /screenshot trouble said again/.test(p.match)), "the repeated screenshot ask is stopped");
  post("2026-11-26T03:08:17Z", "I see the screenshot attached. It still won't open on my side.");
  human("2026-11-26T03:10:19Z");
  const fourth = check("2026-11-26T03:11:19Z", "The screenshot is attached, and you don't need to repeat the report. I have the page link and I'm checking.");
  // The player wrote again, so a reply is owed: the count limits never block it (repeat rules still apply).
  assert.ok(!fourth.some((p) => /posts in the last 30 minutes/.test(p.match)), "a reply to the newest message is never blocked by the count");
  // Later, after a quiet half hour, a new reply is fine again.
  assert.deepEqual(check("2026-11-26T03:45:00Z", "Found it: the Operations card wraps each word onto its own line. A fix is being built."), []);
  // The two-in-a-row rule still holds on its own.
  assert.ok(rules.checkPost("x", { state: { ...s, lastHumanAt: "2026-11-26T03:00:00Z" }, now: Date.parse("2026-11-26T05:00:00Z") }).problems.some((p) => /posts since anyone wrote/.test(p.match)));
});

test("host: ticket screenshots are attached to the session once; a load failure is said once", async () => {
  const dir = tmp();
  const store = S.createFileStore(path.join(dir, "tickets"));
  const calls = [];
  const sessions = { wake: async (req) => { calls.push(req); return { sessionId: "t", completion: { state: "waiting" } }; } };
  const toolServer = createSlimToolServer();
  let fail = false;
  const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const host = createHost({ cfg: { mode: "replay", stateDir: dir, ownerNames: [], ownerPrivateNames: [], wakeTimeoutMs: 60000, budget: { wakesPerDay: 9, minutesPerTicket: 300 } }, store, sessions, toolServer, killSwitch: clear, checkoutFor: () => dir,
    adaptersFor: () => ({ ticketImages: async () => { if (fail) throw new Error("support down"); return [{ data: png, mimeType: "image/png" }]; }, post: async () => ({ delivered: true }), mcpCall: async () => ({}), mcpList: async () => [] }) });
  await host.deliver(1904, [{ role: "player", at: "2026-11-26T02:59:42Z", text: "Visual broken" }]);
  assert.equal(calls[0].images.length, 1);
  assert.ok(fs.existsSync(calls[0].images[0]));
  assert.match(calls[0].prompt, /attached to this message as images/);
  await host.deliver(1904, [{ role: "player", at: "2026-11-26T03:06:21Z", text: "words going vertical" }]);
  assert.equal(calls[1].images.length, 0, "the same screenshot is not attached twice");
  fail = true;
  await host.deliver(1905, [{ role: "player", at: "2026-11-26T04:00:00Z", text: "see image" }]);
  assert.match(calls[2].prompt, /could not be loaded for you/);
  await host.deliver(1905, [{ role: "player", at: "2026-11-26T04:05:00Z", text: "did you see it?" }]);
  assert.doesNotMatch(calls[3].prompt, /could not be loaded/, "said once");
  toolServer.close();
});

test("open_pr stops when an open or merged fix from the last 48 hours exists", async () => {
  const f = fakeCtx();
  let opened = 0;
  f.ctx.adapters.openPr = async () => { opened++; return { opened: true, url: "https://example.invalid/pull/7611" }; };
  let seen;
  f.ctx.adapters.duplicatePrs = async (q) => { seen = q; return { strong: [{ number: 7608, state: "merged", url: "https://example.invalid/pull/7608", why: ["changes the same code: src/components/OperationsCard.tsx"] }], related: [] }; };
  const r = await f.tools.open_pr.handler({ title: "fix(corporations): give operations notes room", body: "Moves long notes below the figures.", tests: "card tests pass" });
  assert.equal(r.opened, false);
  assert.equal(r.duplicates[0].number, 7608);
  assert.deepEqual(seen.files, ["src/components/OperationsCard.tsx"]);
  assert.equal(seen.ticket, 7);
  assert.equal(opened, 0);
  f.ctx.adapters.duplicatePrs = async () => { throw new Error("github down"); };
  assert.equal((await f.tools.open_pr.handler({ title: "fix: x", body: "y", tests: "z" })).opened, false, "never on a guess");
  assert.equal(opened, 0);
  // A weaker overlap needs the session to say why its fix is different.
  f.ctx.adapters.duplicatePrs = async () => ({ strong: [], related: [{ number: 7572, state: "merged", why: ["changes the same code: src/components/OperationsCard.tsx"] }] });
  const soft = await f.tools.open_pr.handler({ title: "fix: x", body: "y", tests: "z" });
  assert.equal(soft.opened, false);
  assert.equal(soft.related[0].number, 7572);
  assert.equal((await f.tools.open_pr.handler({ title: "fix: x", body: "y", tests: "z", related_checked: "7572 changes the pill colours, not the label width" })).opened, true);
  assert.equal(opened, 1);
});

test("host: the team's posts since the last wake win over the session's stale notes", async () => {
  const { teamActivity } = require("../lib/slim/host");
  const f = hostFixture();
  let s = f.store.load(1904);
  s = S.applyUpdate(s, { established: [{ fact: "Cannot reproduce yet", source: "keir" }], next: { step: "Wait for the player to describe the screenshot", waits_on: "player" } });
  s = S.recordPost(s, { text: "I couldn't open the screenshot. What looks wrong?", kind: "question", delivered: true }, Date.parse("2026-11-26T03:00:55Z"));
  f.store.save(s);
  const history = [
    { at: "2026-11-26T03:00:55Z", kind: "support_post", who: "support", text: "I couldn't open the screenshot. What looks wrong?" },
    { at: "2026-11-26T03:24:05Z", kind: "support_post", who: "support", text: "Your screenshot came through fine. A fix for the Operations card is being built now." },
    { at: "2026-11-26T03:30:00Z", kind: "status", who: "support", text: "resolution receipt recorded" },
    { at: "2026-11-26T03:40:00Z", kind: "fix", who: "support", text: "https://example.invalid/pull/7608" },
  ];
  // Only the team's own activity counts: Keir's post and routine notes are left out.
  assert.deepEqual(teamActivity(history, f.store.load(1904)).map((u) => u.text.slice(0, 20)), ["Your screenshot came", "https://example.inva"]);
  const host = createHost({ cfg: { mode: "replay", stateDir: f.dir, ownerNames: [], ownerPrivateNames: [], wakeTimeoutMs: 60000, budget: { wakesPerDay: 9, minutesPerTicket: 300 } }, store: f.store, sessions: f.sessions, toolServer: f.toolServer, killSwitch: clear, checkoutFor: () => f.dir,
    adaptersFor: () => ({ historyRead: async () => ({ events: history }), post: async () => ({ delivered: true }), mcpCall: async () => ({}), mcpList: async () => [] }) });
  await host.deliver(1904, [{ role: "system", at: "2026-11-26T03:50:00Z", text: "The pause is lifted." }]);
  const prompt = f.sessions.calls.at(-1).prompt;
  assert.match(prompt, /The team worked on this ticket since you last did/);
  assert.match(prompt, /A fix for the Operations card is being built now/);
  assert.match(prompt, /pull\/7608/);
  // The state the session saw: next step reset, the team's update established.
  assert.match(prompt, /Next: Re-plan from the team's latest update/);
  assert.ok(f.store.load(1904).established.some((e) => /being built now/.test(e.fact) && /team update/.test(e.source)));
  // The next wake does not show the same updates again.
  await host.deliver(1904, [{ role: "player", at: "2026-11-26T04:00:00Z", text: "thanks" }]);
  assert.doesNotMatch(f.sessions.calls.at(-1).prompt, /The team worked on this ticket/);
  f.toolServer.close();
});

test("fast watch: a person's new message is seen on the next tick; bots and the first look are not", async () => {
  const { createFastWatch } = require("../lib/slim/fastwatch");
  let msgs = { c1: [{ id: "100", author: { id: "9" } }] };
  const seen = [];
  const discord = async (method, route) => {
    const [, ch, q] = /^\/channels\/(\w+)\/messages\?(.*)$/.exec(route);
    if (q === "limit=1") return msgs[ch].slice(-1);
    const after = BigInt(/after=(\d+)/.exec(q)[1]);
    return msgs[ch].filter((m) => BigInt(m.id) > after).reverse();
  };
  const w = createFastWatch({ discord, botId: "1", onHuman: async (h) => seen.push(h) });
  w.watch("c1", { ticket: 1904 });
  await w.tick();
  assert.equal(seen.length, 0, "the first look only sets the starting point");
  msgs.c1.push({ id: "101", author: { id: "1", bot: true }, timestamp: "2026-11-26T05:00:00Z" }, { id: "102", author: { id: "7" }, timestamp: "2026-11-26T05:00:01Z" });
  await w.tick();
  assert.deepEqual(seen.map((h) => [h.ticket, h.messageId, h.authorId]), [[1904, "102", "7"]]);
  await w.tick();
  assert.equal(seen.length, 1, "each message once");
});

test("limiter: owner and staff wakes jump the queue when every slot is busy", async () => {
  const { createLimiter } = require("../lib/slim/fastwatch");
  const l = createLimiter(1);
  const order = [];
  let release;
  const block = new Promise((r) => { release = r; });
  const p1 = l.run(async () => { await block; order.push("running"); });
  const p2 = l.run(async () => order.push("player"));
  const p3 = l.run(async () => order.push("owner"), { urgent: true });
  release();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ["running", "owner", "player"]);
});

test("response clock: time to typing and to the first post, per message", () => {
  const { createResponseClock } = require("../lib/slim/fastwatch");
  const lines = [];
  const c = createResponseClock({ append: (l) => lines.push(l) });
  c.message(1904, { messageId: "m1", at: "2026-11-26T05:00:00.000Z", typingAt: "2026-11-26T05:00:03.500Z" });
  c.posted(1904, "2026-11-26T05:00:41.000Z");
  assert.deepEqual(lines[0], { ticket: 1904, messageId: "m1", messageAt: "2026-11-26T05:00:00.000Z", typingMs: 3500, firstPostMs: 41000 });
  c.message(1904, { messageId: "m2", at: "2026-11-26T05:10:00.000Z", typingAt: "2026-11-26T05:10:02.000Z" });
  c.wakeEnded(1904);
  assert.equal(lines[1].firstPostMs, null);
  assert.equal(c.pending(1904).length, 0);
});

test("a post is reported the moment it happens (typing stops, clock stops)", async () => {
  const f = fakeCtx();
  const seen = [];
  f.ctx.onEffect = (e) => seen.push(e.kind);
  await f.tools.post_reply.handler({ text: "The label column is too narrow, so each word wraps. A fix is being built.", kind: "answer", basis: "screenshot" });
  assert.deepEqual(seen, ["post"]);
});

test("deploy: live means the deployed web and worker both contain the fix", async () => {
  const d = require("../lib/slim/deploy");
  const jsonl = [
    { row: "ahd-us-web", sha: "aaa111", result: "deployed", finished_at: "2026-11-26T04:17:55Z" },
    { row: "ahd-us-worker", sha: "fff999", result: "deployed", finished_at: "2026-11-26T05:08:00Z" },
    { row: "ahd-us-web", sha: "bbb222", result: "failed" },
    { row: "ahd-us-web", sha: "fff999", result: "deployed", finished_at: "2026-11-26T05:15:11Z" },
  ].map((r) => JSON.stringify(r)).join("\n");
  assert.deepEqual(d.latestDeployed("x", () => jsonl), { web: { sha: "fff999", at: "2026-11-26T05:15:11Z" }, worker: { sha: "fff999", at: "2026-11-26T05:08:00Z" } });
  const calls = [];
  const ancestry = { "fix1:fff999": 0, "fix2:fff999": 1 };
  const run = async (repo, args) => { calls.push(args.join(" ")); if (args[0] === "cat-file") return { code: args[2].startsWith("fix3") ? 1 : 0 }; if (args[0] === "fetch") return { code: 0 }; return { code: ancestry[`${args[2]}:${args[3]}`] ?? 1 }; };
  const live = await d.liveStatus({ repo: "/r", releasesFile: "x", mergeSha: "fix1", run, read: () => jsonl });
  assert.equal(live.live, true);
  assert.equal(live.web.at, "2026-11-26T05:15:11Z");
  assert.equal((await d.liveStatus({ repo: "/r", releasesFile: "x", mergeSha: "fix2", run, read: () => jsonl })).live, false);
  await d.liveStatus({ repo: "/r", releasesFile: "x", mergeSha: "fix3", run, read: () => jsonl });
  assert.ok(calls.some((c) => c.startsWith("fetch")), "an unknown commit is fetched before comparing");
});

test("a fix that is not live is watched, and the ticket is woken the moment it is", async () => {
  const f = fakeCtx();
  f.ctx.adapters.deployStatus = async () => ({ pr: 7612, merged: true, mergeSha: "abc", live: false, note: "Waits for the next deploy." });
  const r = await f.tools.deploy_status.handler({ pr: "7612" });
  assert.equal(r.watching, true);
  assert.deepEqual(f.store.load(7).liveWatch.map((w) => [w.pr, w.mergeSha]), [[7612, "abc"]]);
  const d = require("../lib/slim/deploy");
  const woke = [];
  let live = false;
  const status = async () => ({ live, web: { sha: "f75ea4d9147e", at: "2026-11-26T05:15:11Z" }, worker: { sha: "f75ea4d9147e", at: "2026-11-26T05:08:00Z" } });
  await d.checkLiveWatches({ store: f.store, repo: "/r", releasesFile: "x", status, deliver: (n, ev) => woke.push([n, ev[0].text]) });
  assert.equal(woke.length, 0);
  live = true;
  await d.checkLiveWatches({ store: f.store, repo: "/r", releasesFile: "x", status, deliver: (n, ev) => woke.push([n, ev[0].text]) });
  assert.equal(woke.length, 1);
  assert.match(woke[0][1], /Fix #7612 is live on the game now/);
  assert.equal(f.store.load(7).liveWatch.length, 0, "woken once");
  // Already live: nothing to watch.
  f.ctx.adapters.deployStatus = async () => ({ pr: 7613, merged: true, mergeSha: "def", live: true });
  assert.equal((await f.tools.deploy_status.handler({ pr: "7613" })).watching, undefined);
});

test("spam cap: a reply to a new message always goes; an extra post is held and woken when the window clears", async () => {
  // Ticket 1905: three answers to three questions, then a fourth question.
  let s = S.emptyState(1905);
  for (const [q, a] of [["04:39:00", "04:40:07"], ["04:42:00", "04:42:55"], ["04:46:00", "04:46:52"]]) {
    s = S.recordHuman(s, { role: "player", at: `2026-11-26T${q}Z` });
    s = S.recordPost(s, { text: `Answer at ${a} about districts ${a}`, kind: "answer", delivered: true }, Date.parse(`2026-11-26T${a}Z`));
  }
  s = S.recordHuman(s, { role: "player", at: "2026-11-26T04:58:01Z" });
  const ok = rules.checkPost("California's 2030 House race has 48 seats, and the same label fix covers it.", { state: s, kind: "answer", now: Date.parse("2026-11-26T04:58:40Z") }).problems;
  assert.deepEqual(ok, [], "answering a new question is allowed");
  // Without a new message, three in 30 minutes is still the limit, and the held answer gets a reminder.
  const f = fakeCtx();
  f.ctx.now = () => Date.parse("2026-11-26T04:50:00Z");
  let t = f.store.load(7); t.lastHumanAt = "2026-11-26T04:46:00Z"; t.posts = s.posts; f.store.save(t);
  const r = await f.tools.post_reply.handler({ text: "One more detail about the map labels for you.", kind: "update", basis: "no facts" });
  assert.equal(r.posted, false);
  assert.match(r.note, /woken in \d+ minutes/);
  const rem = f.store.load(7).reminder;
  assert.ok(rem.minutes >= 5 && rem.minutes <= 22, `reminder ${rem.minutes}`);
});

test("no placeholder posts: an acknowledgement or a promise to look is refused; real content passes", () => {
  for (const t of [
    "I have the bill you linked. I'll check whether voting is open and whether your seat is eligible.",
    "I haven't confirmed what closed your bank. I'll check the closure record and look for any notice.",
    "Thanks, I have the bill link. I'm checking why the Pennsylvania bill shows as expired.",
  ]) assert.ok(rules.checkPost(t, base()).problems.some((p) => p.match === "only says you will look"), t);
  for (const t of [
    "The Canadians First Act is still open in the House of Commons. Your seat can vote once the second reading starts.",
    "Found it. Your bill isn't expired. Its vote is still open and I'll check why the page says expired.",
    "Your bank failed on turn 183. I'll check the other two banks next.",
  ]) assert.deepEqual(rules.checkPost(t, base()).problems, [], t);
  assert.deepEqual(rules.checkPost("I'll check and post here.", base({ kind: "resolution" })).problems.filter((p) => p.match === "only says you will look"), []);
});

test("intake: a brand-new ticket carries its channel and opening time, and the cheap check spots it", async () => {
  const intake = require("../lib/slim/intake");
  const events = { 1906: [{ id: "1906:opened", kind: "opened", who: "player m", at: "2026-11-26T06:49:14.767Z", text: "t" }, { id: "1906:m1", kind: "player_message", who: "player m", at: "2026-11-26T06:49:14.767Z", text: "will not let me vote" }] };
  const items = [];
  const mcp = { call: async (s, tool, a) => {
    if (tool === "support_list") return { items };
    if (tool === "support_get") return { conversation: { channelId: "1575403035826458677" } };
    return { title: "x", opened: "2026-11-26T06:49:14.767Z", events: events[a.number] };
  } };
  const state = intake.createIntakeState(path.join(tmp(), "intake.json"));
  await intake.poll({ mcp, cfg: { ownerIds: [] }, state, first: true, now: Date.parse("2026-11-26T06:00:00Z") });
  items.push({ kind: "ticket", number: 1906, category: "bug" }, { kind: "ticket", number: 1907, category: "moderation" });
  assert.deepEqual((await intake.newTickets({ mcp, state })).map((t) => t.number), [1906, 1907], "moderation tickets get the same fast pickup");
  const got = await intake.poll({ mcp, cfg: { ownerIds: [] }, state, first: false, now: Date.parse("2026-11-26T06:49:20Z") });
  assert.equal(got[0].isNew, true);
  assert.equal(got[0].channelId, "1575403035826458677");
  assert.equal(got[0].openedAt, "2026-11-26T06:49:14.767Z");
  assert.deepEqual(await intake.newTickets({ mcp, state }), [], "seen now");
});

test("moderation: picked up like any ticket; one already answered by the team is watched quietly", async () => {
  const intake = require("../lib/slim/intake");
  const items = [];
  const events = {
    1907: [{ id: "1907:opened", kind: "opened", who: "player jbm", at: "2026-11-26T16:33:00Z", text: "Potential alting" }, { id: "1907:m1", kind: "player_message", who: "player jbm", at: "2026-11-26T16:33:34Z", text: "Both went offline at the same time" }, { id: "1907:p1", kind: "support_post", who: "support", at: "2026-11-26T16:54:43Z", text: "I checked both accounts." }],
    1909: [{ id: "1909:opened", kind: "opened", who: "player k", at: "2026-11-26T17:10:00Z", text: "alts" }, { id: "1909:m1", kind: "player_message", who: "player k", at: "2026-11-26T17:10:01Z", text: "these two look like alts" }],
  };
  const mcp = { call: async (s, tool, a) => (tool === "support_list" ? { items } : tool === "support_get" ? { conversation: { channelId: "c" } } : { title: "t", category: "moderation", opened: events[a.number][0].at, events: events[a.number] }) };
  const state = intake.createIntakeState(path.join(tmp(), "intake.json"));
  await intake.poll({ mcp, cfg: { ownerIds: [] }, state, first: true, now: Date.parse("2026-11-26T16:00:00Z") });
  items.push({ kind: "ticket", number: 1907, category: "moderation" }, { kind: "ticket", number: 1909, category: "moderation" });
  const got = await intake.poll({ mcp, cfg: { ownerIds: [] }, state, first: false, now: Date.parse("2026-11-26T17:10:05Z") });
  assert.deepEqual(got.map((g) => [g.ticket, g.category, Boolean(g.isNew)]), [[1909, "moderation", true]], "1907 was answered already: no wake, no replay");
  events[1907].push({ id: "1907:m2", kind: "player_message", who: "player jbm", at: "2026-11-26T17:20:00Z", text: "thanks, anything else?" });
  const later = await intake.poll({ mcp, cfg: { ownerIds: [] }, state, first: false, now: Date.parse("2026-11-26T17:20:05Z") });
  assert.deepEqual(later.map((g) => [g.ticket, g.events.map((e) => e.text)]), [[1907, ["thanks, anything else?"]]], "its next message wakes Keir");
});

test("moderation: neutral moderator summary without personal data; never accuse the reported player", async () => {
  const f = fakeCtx();
  const posted = [];
  f.ctx.adapters.modPost = async (p) => { posted.push(p.text); return { posted: true }; };
  await assert.rejects(f.tools.mod_summary.handler({ text: "Checked two characters." }), /only for moderation/);
  const s = f.store.load(7); s.category = "moderation"; f.store.save(s);
  let r = await f.tools.mod_summary.handler({ text: "Report: characters 131 and 143. alt_ring_audit found a shared IP 203.0.113.9 and email a@b.co." });
  assert.equal(r.posted, false);
  assert.ok(r.problems.some((p) => /203\.0\.113\.9/.test(p)) && r.problems.some((p) => /a@b\.co/.test(p)));
  r = await f.tools.mod_summary.handler({ text: "These two are clearly alts and should be banned." });
  assert.equal(r.posted, false);
  r = await f.tools.mod_summary.handler({ text: "Alt report on Chris Hansen and Dan Rourke (ticket 1907). alt_ring_audit: no shared device or other technical signal; same offline time only. For moderators to review." });
  assert.equal(r.posted, true);
  await f.tools.mod_summary.handler({ text: "Follow up: the reporter added nothing new. Still for moderators to review." });
  assert.equal((await f.tools.mod_summary.handler({ text: "A third note for moderators." })).posted, false, "two summaries per ticket at most");
  assert.equal(posted.length, 2);
  // The reporter is told what was checked, never that someone is an alt or will be punished.
  const reply = await f.tools.post_reply.handler({ text: "Those two are clearly alts and will be banned.", kind: "answer", basis: "alt_ring_audit" });
  assert.equal(reply.posted, false);
  assert.equal((await f.tools.post_reply.handler({ text: "I checked both accounts with our alt-account check and sent what it showed to the moderators. They review every report.", kind: "answer", basis: "alt_ring_audit" })).posted, true);
});

test("one slot per ticket: a burst of messages joins the queued wake or one follow-up, never fills every slot", async () => {
  const { createLimiter, createTicketQueue } = require("../lib/slim/fastwatch");
  const limiter = createLimiter(2);
  const runs = [];
  const gates = [];
  const run = (n, events) => { runs.push([n, events.map((e) => e.text)]); return new Promise((r) => gates.push(r)); };
  const q = createTicketQueue({ limiter, run });
  // Ticket 1909: opened, then three messages while its first wake runs.
  q.deliver(1909, [{ text: "opened" }]);
  await new Promise((r) => setImmediate(r));
  q.deliver(1909, [{ text: "link" }]);
  q.deliver(1909, [{ text: "actual link:" }]);
  q.deliver(1909, [{ text: "the url" }]);
  // Another ticket still gets a slot straight away.
  q.deliver(1905, [{ text: "other ticket" }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, [[1909, ["opened"]], [1905, ["other ticket"]]]);
  assert.equal(limiter.stats().waiting, 0, "1909's later messages hold no slot");
  gates[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(runs[2], [1909, ["link", "actual link:", "the url"]], "one follow-up wake with all three");
  gates.slice(1).forEach((g) => g());
});

test("public: which channels count as public, and what counts as a mention", () => {
  const pub = require("../lib/slim/public");
  const VIEW = String(1 << 10);
  const gid = "g", roles = [{ id: "g", name: "@everyone" }, { id: "m", name: "Member" }];
  const chans = [
    { id: "cat1", type: 4, name: "Global Channels", permission_overwrites: [{ id: "m", allow: VIEW, deny: "0" }, { id: "g", allow: "0", deny: VIEW }] },
    { id: "cat2", type: 4, name: "Dev Channels", permission_overwrites: [] },
    { id: "ws", type: 0, name: "wall-street", parent_id: "cat1", last_message_id: "5", permission_overwrites: [{ id: "m", allow: VIEW, deny: "0" }, { id: "g", allow: "0", deny: VIEW }] },
    { id: "gen", type: 0, name: "general", parent_id: "cat1", last_message_id: "6", permission_overwrites: [] },
    { id: "dev", type: 0, name: "dev-chat", parent_id: "cat2", permission_overwrites: [] },
    { id: "modc", type: 0, name: "mod-chat", parent_id: "cat1", permission_overwrites: [] },
    { id: "hidden", type: 0, name: "secret", parent_id: "cat1", permission_overwrites: [{ id: "m", allow: "0", deny: VIEW }] },
  ];
  assert.deepEqual(pub.publicChannels(chans, roles, { guildId: gid }).map((c) => c.name), ["wall-street", "general"]);
  assert.equal(pub.mentionsKeir({ content: "Why can't I build Retail Keith" }, { botId: "b" }), true);
  assert.equal(pub.mentionsKeir({ content: "keirsten is here" }, { botId: "b" }), false);
  assert.equal(pub.mentionsKeir({ content: "<@b> help" }, { botId: "b" }), true);
  assert.equal(pub.mentionsKeir({ content: "ok thanks", referenced_message: { author: { id: "b" } } }, { botId: "b" }), true);
  const act = (t) => pub.prefilter(t).action;
  assert.equal(act("Why can't I build Retail Keith"), "judge");
  assert.equal(act("Keith ur so dumb lol"), "silent");
  assert.equal(act("Keir I lost all my money, refund?"), "ticket");
  assert.equal(act("keir is X an alt?"), "silent");
  assert.equal(act("what do you think Keir, is the economy broken?"), "silent");
  assert.equal(act("Keir what does Egg think about tariffs"), "silent");
  assert.equal(act("keith check my ticket 1905"), "silent");
});

test("public: each message once, one reply per channel per 10 minutes, account matters pointed once, every call logged", async () => {
  const pub = require("../lib/slim/public");
  const dir = tmp();
  const logs = [], posts = [];
  let clock = Date.parse("2026-11-27T10:00:00Z");
  let judged = 0;
  const r = pub.createPublicResponder({ stateFile: path.join(dir, "s.json"), log: (e) => logs.push(e), now: () => clock, mayAct: () => true,
    post: async (m, t) => posts.push([m.channelId, t]),
    judge: async () => { judged++; return { posted: true, text: "Retail needs a store site first.", reason: "answered: code" }; } });
  const m = (id, ch, content) => ({ messageId: id, channelId: ch, channelName: ch, authorName: "p", content });
  await r.handle(m("1", "ws", "Why can't I build Retail Keith"));
  await r.handle(m("1", "ws", "Why can't I build Retail Keith"));
  assert.equal(judged, 1, "never the same message twice");
  await r.handle(m("2", "ws", "Keith how do I open a store?"));
  assert.match(logs.at(-1).reason, /channel rate limit/);
  await r.handle(m("3", "gen", "Keir I lost all my money, refund?"));
  assert.match(posts.at(-1)[1], /open one with \/ticket/);
  await r.handle(m("4", "gen2", "keith lol"));
  assert.deepEqual(logs.map((l) => l.decision), ["answered", "skipped", "pointed to a ticket", "skipped"]);
  assert.ok(logs.every((l) => l.reason), "every decision has a reason");
  clock += 11 * 60000;
  await r.handle(m("5", "ws", "Keith how do I open a store?"));
  assert.equal(judged, 2, "after 10 minutes the channel may get another answer");
  const off = pub.createPublicResponder({ stateFile: path.join(dir, "o.json"), log: (e) => logs.push(e), mayAct: () => false, post: async () => { throw new Error("must not post"); }, judge: async () => { throw new Error("must not judge"); } });
  await off.handle(m("9", "ws", "Why can't I build Retail Keith"));
  assert.match(logs.at(-1).reason, /not live or kill switch/);
});

test("public judge: the reply passes the ticket rules and never names the owner; skip records its reason", async () => {
  const { createPublicJudge } = require("../lib/slim/public-judge");
  const toolServer = createSlimToolServer();
  const posted = [];
  let script;
  const sessions = { wake: async (req) => {
    const rpc = async (method, params) => (await (await fetch(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
    for (const [name, args] of script) await rpc("tools/call", { name, arguments: args });
    return { completion: { state: "done" } };
  } };
  const judge = createPublicJudge({ cfg: { stateDir: tmp(), ownerNames: ["Egg", "the owner"], ownerPrivateNames: ["Ownername"] }, sessions, toolServer, adapters: {}, post: async (m, t) => posted.push(t), discord: async () => [] });
  const m = { channelId: "ws", channelName: "wall-street", messageId: "1", authorName: "Sam", content: "Why can't I build Retail Keith" };
  script = [["answer", { text: "Egg says retail needs a store site first.", basis: "code" }], ["answer", { text: "Retail needs a store site in the state first. Build one from the sector page, then Retail unlocks.", basis: "code_search retail prerequisites" }]];
  const r = await judge(m);
  assert.equal(r.posted, true);
  assert.deepEqual(posted, ["Retail needs a store site in the state first. Build one from the sector page, then Retail unlocks."], "the owner-name draft was refused");
  script = [["skip", { reason: "banter" }]];
  const s = await judge({ ...m, messageId: "2", content: "Keith lol" });
  assert.deepEqual([s.posted, s.reason], [false, "banter"]);
  toolServer.close();
});

test("ticket 1913: a follow-up wake never crashes or drops messages, and an unanswered newest message is retried", async () => {
  const { createLimiter, createTicketQueue } = require("../lib/slim/fastwatch");
  const seen = [];
  let fail = true;
  const q = createTicketQueue({ limiter: createLimiter(1), run: async (n, events, opts) => {
    const { intro } = opts; // the real host destructures its options: null must never reach it
    seen.push(events.map((e) => e.text));
    if (fail) { fail = false; throw new Error("boom"); }
  } });
  q.deliver(1913, [{ text: "I'm also state chair" }]);
  q.deliver(1913, [{ text: "and I have been the whole iter" }]);
  await new Promise((r) => setTimeout(r, 20));
  q.deliver(1913, [{ text: "they're not stacking for me" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen[0], ["I'm also state chair"]);
  assert.ok(seen.slice(1).flat().includes("and I have been the whole iter"), "the follow-up wake ran");
  assert.ok(seen.slice(1).flat().includes("they're not stacking for me"), "the newest message was delivered");
  assert.ok(seen.slice(1).flat().includes("I'm also state chair"), "a failed delivery is queued again, not dropped");
  // A wake that ends with the newest message unanswered after a refusal is retried in 5 minutes.
  const f = hostFixture({ script: () => [["post_reply", { text: "I'll check.", kind: "answer", basis: "no facts" }], ["finish", { next_step: "x", waits_on: "player" }]] });
  await f.host.deliver(1913, [{ role: "player", at: new Date().toISOString(), text: "they're not stacking for me" }]);
  const st = f.store.load(1913);
  assert.equal(st.reminder.minutes, 5);
  assert.match(st.reminder.reason, /newest message/);
  assert.ok(rules.checkPost("Both bonuses count: 2 for National Vice Chair and 2 for State Chair.", { state: { ...S.emptyState(1), posts: [1, 2, 3, 4].map((i) => ({ at: new Date(Date.now() - i * 60000).toISOString(), kind: "answer", delivered: true, text: `post ${i}` })), lastHumanAt: new Date().toISOString() }, kind: "answer" }).problems.every((p) => p.rule !== "spam_cap"), "never blocked by the count when a person is owed a reply");
  f.toolServer.close();
});

test("party_roles: fixed read-only queries on four collections through Keir's read token", async () => {
  const { createLiveAdapters } = require("../lib/slim/adapters");
  const calls = [];
  const aegon = "6afb7b51f2d559ce85b3b99c";
  const docs = {
    characters: [{ _id: aegon, name: "Aegon Roosevelt", party: "1" }],
    politicalParties: [{ name: "Democratic Party", countryId: "us", chairId: "x", viceChairId: aegon, committeeIds: [] }],
    statePartyOrg: [{ stateId: "CA", partyId: "1", chairId: aegon }],
    caucuses: [{ name: "Progressive Caucus", partyId: "1", chairId: aegon, disbandedAt: null }, { name: "Old Caucus", partyId: "1", viceChairId: aegon, disbandedAt: "2026-11-01" }],
  };
  const mcp = { call: async (server, tool, args, write) => { calls.push({ server, tool, write, collection: args.collection, env: args.env }); return { docs: docs[args.collection] }; } };
  const a = createLiveAdapters({ mcp, cfg: {}, ticketCheckout: () => "/tmp" });
  const r = await a.partyRoles({ character: "Aegon Roosevelt" });
  assert.deepEqual(r.roles.map((x) => `${x.level}: ${x.role}`), ["national party: vice chair", "state party: chair", "caucus: chair"], "a disbanded caucus does not count");
  assert.ok(calls.every((c) => c.server === "heal-ops" && c.tool === "heal_query" && c.write === false && c.env === "prod"));
  assert.deepEqual([...new Set(calls.map((c) => c.collection))].sort(), ["caucuses", "characters", "politicalParties", "statePartyOrg"]);
  const none = await createLiveAdapters({ mcp: { call: async () => ({ docs: [] }) }, cfg: {}, ticketCheckout: () => "/tmp" }).partyRoles({ character: "Nobody" });
  assert.equal(none.found, false);
});

test("an owner question is always answered: up to two re-wakes, never for an aside", async () => {
  const { addressedToKeir } = require("../lib/slim/host");
  assert.equal(addressedToKeir("<@1479984768194969663> just run the exact totals. Is it just because of positions?"), true);
  assert.equal(addressedToKeir("yeah"), false);
  // A wake that only records state and never posts (ticket 1913 at 05:48).
  const f = hostFixture({ script: () => [["update_state", { established: [{ fact: "totals worked out", source: "calc" }] }], ["finish", { next_step: "x", waits_on: "nothing" }]] });
  await f.host.deliver(1913, [{ role: "owner", name: "egg3901", at: "2026-11-27T05:48:00Z", text: "just run the exact totals. Is it just because of positions?" }]);
  for (let i = 0; i < 20 && f.sessions.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.sessions.calls.length, 3, "the first wake plus two re-wakes, no more");
  assert.match(f.sessions.calls[1].prompt, /The owner asked you directly/);
  assert.match(f.sessions.calls[1].prompt, /Never record the answer only in ticket state/);
  const g = hostFixture({ script: () => [["finish", { next_step: "x", waits_on: "nothing" }]] });
  await g.host.deliver(1914, [{ role: "owner", name: "egg3901", at: "2026-11-27T06:00:00Z", text: "yeah" }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(g.sessions.calls.length, 1, "an owner aside needs no answer");
  f.toolServer.close(); g.toolServer.close();
});
