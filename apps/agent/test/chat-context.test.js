"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { createAgent } = require("../lib/operator/agent");
const { createLedger } = require("../lib/operator/store");

async function capture(t, content = "Hello", tags = { kind: "banter", complexity: "trivial", kindConfidence: 0.99 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-chat-context-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { stateDir: dir, briefFile: path.join(__dirname, "../KEIR.md"), model: "fixture", quickProvider: "claude:fixture", taskLifetimeMs: 60000, skills: false, tagIntake: async () => tags, dynamicEffort: false, ownerId: "owner", repositories: {} };
  const job = ledger.createJob("hello", { kind: "conversation", role: "owner", actorId: "owner", replyChannel: "app", channelId: "app", source: { channelId: "app", content, at: new Date().toISOString() } });
  let seen, recalled = 0;
  const broker = { servers: () => ["gamestate"], appContext: () => ({ sharedWork: "UNRELATED_WORK".repeat(2000) }), context: () => ({ messages: [{ text: "OLD_THREAD".repeat(2000) }] }), notebook: { recall: () => { recalled++; return ["UNRELATED_MEMORY".repeat(1000)]; } },
    tool: async (_job, name) => { if (name === "finish") job.state = "done"; return { state: job.state }; } };
  const spawnImpl = (_cmd, args) => {
    const child = new EventEmitter(); child.pid = 999999; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = prompt => {
      seen = { brief: args[args.indexOf("--system-prompt") + 1], prompt: String(prompt) };
      setImmediate(() => { child.stdout.emit("data", JSON.stringify({ type: "result", subtype: "success", result: "Hello!", usage: {} }) + "\n"); child.emit("close", 0); });
    };
    return child;
  };
  await createAgent({ ledger, config, broker, spawnImpl }).run(job, new AbortController().signal);
  return { seen, recalled, ledger, job };
}

test("a literal hello does not send the operating manual, unrelated work or notebook to the provider", async t => {
  const { seen, recalled, job } = await capture(t);
  t.diagnostic(JSON.stringify(job.contextBudget));
  assert.ok(seen.brief.length < 6000, `greeting brief is ${seen.brief.length} characters`);
  assert.ok(seen.prompt.length < 6000, `greeting context is ${seen.prompt.length} characters`);
  assert.equal(recalled, 0, "greetings should not perform notebook recall");
  assert.doesNotMatch(seen.prompt, /UNRELATED_WORK|OLD_THREAD|UNRELATED_MEMORY/);
});

test("Jev can choose focused context, while uncertain, sensitive and attached tasks keep full context", async t => {
  const focused = await capture(t, "What is the current game turn?", { kind: "mechanics_question", complexity: "simple", kindConfidence: 0.99, contextProfile: "focused" });
  assert.equal(focused.job.contextBudget.profile, "focused"); assert.ok(focused.seen.brief.length < 6000); assert.equal(focused.recalled, 0);
  const full = await capture(t, "Why is my treasury wrong?", { kind: "mechanics_question", complexity: "hard", kindConfidence: 0.4, contextProfile: "focused", injection: true });
  assert.equal(full.job.contextBudget.profile, "full"); assert.ok(full.seen.brief.length > 30000); assert.equal(full.recalled, 1);
  const { profile, literalGreeting } = require("../lib/operator/chatcontext");
  assert.equal(literalGreeting({ kind: "conversation", source: { content: "Hello, deploy the fix" } }), false);
  assert.equal(profile({ kind: "conversation", source: { content: "Hello", attachments: [{}] } }), "full");
  assert.equal(profile({ kind: "ticket", source: { content: "Hello" } }), "full");
});

test("a compact session discovers and invokes granted tools over multiple calls without broadening authority", async t => {
  const { sessionContext } = require("../lib/operator/chatcontext"), { createToolServer } = require("../lib/operator/toolserver");
  const calls = [], job = { id: "compact", role: "owner" };
  const tools = [{ name: "read_tool", description: "Read a scoped source", input_schema: { type: "object", properties: { server: { type: "string" } }, required: ["server"], additionalProperties: false } }, { name: "finish", description: "Finish", input_schema: { type: "object", properties: { state: { type: "string" } }, required: ["state"] } }];
  const broker = { tool: async (_j, name, args) => { calls.push({ name, args }); return name === "finish" ? { state: args.state } : { turn: 276 }; } };
  const deferred = sessionContext({ job, ledger: { data: {}, save() {} }, broker, config: { skills: false }, tools, fullBrief: "policy ".repeat(4000) });
  const server = createToolServer({ broker, normalizeImage: () => {} });
  const session = await server.open(job, deferred.tools, new AbortController().signal, deferred); t.after(() => { session.close(); server.close(); });
  async function rpc(name, args) {
    return (await (await fetch(session.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result;
  }
  const discovered = await rpc("load_context", { section: "tools", names: ["read_tool"] });
  assert.equal(JSON.parse(discovered.content[0].text).tools[0].name, "read_tool");
  const first = await rpc("load_context", { section: "instructions" });
  const page = JSON.parse(first.content[0].text); assert.equal(page.text.length, 10000); assert.equal(page.nextOffset, 10000);
  const next = JSON.parse((await rpc("load_context", { section: "instructions", offset: page.nextOffset })).content[0].text); assert.equal(next.text.length, 10000);
  assert.equal((await rpc("call_tool", { name: "read_tool", args: { server: "gamestate" } })).isError, undefined);
  assert.equal(calls[0].name, "read_tool");
  assert.equal((await rpc("call_tool", { name: "shell", args: {} })).isError, true);
  assert.equal((await rpc("call_tool", { name: "call_tool", args: {} })).isError, true);
  assert.equal((await rpc("call_tool", { name: "read_tool", args: {} })).isError, true);
  assert.equal((await rpc("load_context", { section: "tools", names: ["shell"] })).isError, true);
  assert.equal(calls.length, 1);
  await rpc("finish", { state: "done" });
  assert.equal((await rpc("load_context", { section: "tools" })).isError, true);
});
