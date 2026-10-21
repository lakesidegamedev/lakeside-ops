"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { invokeAgy, invokeCursor, invokeMuse } = require("../lib/operator/providers");

// A fake child process that records what it was launched with.
function fakeSpawn(stdout, onLaunch, code = 0) {
  return (cmd, args, opts) => {
    onLaunch(cmd, args, opts);
    const c = new EventEmitter();
    c.pid = 999999; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end() {} };
    setImmediate(() => { c.stdout.emit("data", stdout); c.emit("close", code); });
    return c;
  };
}
const base = () => ({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "keir-prov-")), model: "m", effort: "medium", brief: "BRIEF", prompt: '{"task":1}',
  tools: [{ name: "finish" }, { name: "read" }], url: "http://127.0.0.1:1/mcp/abc", maxTurns: 6, timeoutMs: 5000, signal: new AbortController().signal });

test("agy runs with only Keir's tools allowed, its shell denied, and a Claude-shaped result", async () => {
  let seen;
  const spawnImpl = fakeSpawn(JSON.stringify({ status: "SUCCESS", response: "done", num_turns: 3, usage: { input_tokens: 10, output_tokens: 2 } }), (cmd, args, opts) => {
    const home = opts.env.HOME;
    seen = { cmd, args, settings: JSON.parse(fs.readFileSync(path.join(home, ".gemini/antigravity-cli/settings.json"), "utf8")),
      mcp: JSON.parse(fs.readFileSync(path.join(home, ".gemini/config/mcp_config.json"), "utf8")), task: fs.readFileSync(path.join(opts.cwd, "task.md"), "utf8") };
  });
  const r = await invokeAgy({ ...base(), spawnImpl });
  assert.equal(seen.cmd, "agy");
  assert.equal(seen.mcp.mcpServers.keir.serverUrl, "http://127.0.0.1:1/mcp/abc");
  assert.ok(seen.settings.permissions.allow.includes("mcp(keir/finish)"));
  assert.ok(seen.settings.permissions.deny.includes("command(*)"));
  assert.match(seen.task, /BRIEF[\s\S]*"task":1/);
  assert.deepEqual([r.result, r.num_turns, r.is_error], ["done", 3, false]);
});

test("Cursor Auto gets a private auth link, only the activation MCP and no local tools", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-cursor-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json"); fs.writeFileSync(authFile, "{}", { mode: 0o600 });
  const input = { ...base(), stateDir: dir, model: "auto", authFile,
    tools: [{ name: "read_servers" }, { name: "finish" }] };
  let seen;
  const result = await invokeCursor({ ...input, spawnImpl: fakeSpawn("Keir finished.", (cmd, args, opts) => {
    const home = opts.env.HOME, ws = args[args.indexOf("--workspace") + 1];
    seen = { cmd, args, home: opts.env.HOME,
      mcp: JSON.parse(fs.readFileSync(path.join(home, ".cursor/mcp.json"), "utf8")),
      permissions: JSON.parse(fs.readFileSync(path.join(ws, ".cursor/cli.json"), "utf8")),
      auth: fs.realpathSync(path.join(home, ".config/cursor/auth.json")) };
  }) });
  assert.equal(result.subtype, "success"); assert.equal(result.result, "Keir finished.");
  assert.equal(seen.args[seen.args.indexOf("--model") + 1], "auto");
  assert.ok(seen.args.includes("--approve-mcps")); assert.ok(seen.args.includes("--trust"));
  assert.deepEqual(Object.keys(seen.mcp.mcpServers), ["keir"]);
  assert.deepEqual(seen.permissions.permissions.allow, ["Mcp(keir:read_servers)", "Mcp(keir:finish)"]);
  assert.ok(seen.permissions.permissions.deny.includes("Shell(*)"));
  assert.equal(seen.auth, authFile);
  assert.equal(fs.existsSync(seen.home), false, "activation home is removed after completion");
});
test("Antigravity receives large briefs over stdin rather than a host path its sandbox cannot read", async () => {
  let input, args;
  const spawnImpl = (cmd, values, opts) => {
    args = values;
    const child = fakeSpawn(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "done", usage: {} } }), () => {})(cmd, values, opts);
    child.stdin.end = body => { input = body; };
    return child;
  };
  const result = await invokeAgy({ ...base(), brief: "B".repeat(150000), spawnImpl });
  assert.ok(args.includes("--input-format"));
  assert.ok(args.every(arg => arg.length < 10000));
  const message = JSON.parse(input);
  assert.equal(message.event, "user");
  assert.match(message.message.content[0].text, /B{150000}/);
  assert.match(message.message.content[0].text, /"task":1/);
  assert.equal(result.result, "done");
});

test("muse runs headless with shell, writes and web off and Keir's MCP server pinned", async () => {
  let args;
  const r = await invokeMuse({ ...base(), spawnImpl: fakeSpawn("final answer", (cmd, a) => { args = a; }) });
  for (const flag of ["--disable-shell", "--disable-write", "--disable-web-tools", "--no-session-log"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.some((a) => a.startsWith("mcp_servers.keir=") && a.includes("/mcp/abc")));
  assert.equal(args[args.indexOf("--max-model-steps") + 1], "6");
  assert.deepEqual([r.result, r.is_error], ["final answer", false]);
});

test("a failed muse run surfaces as a model request failure", async () => {
  await assert.rejects(invokeMuse({ ...base(), spawnImpl: fakeSpawn("", () => {}, 2) }), /model request failed: muse exited 2/);
});

test("a muse step-cap stop is a turn limit, not an error", async () => {
  const spawnImpl = (cmd, args, opts) => { const { EventEmitter } = require("node:events"); const c = new EventEmitter(); c.pid = 999998; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end() {} };
    setImmediate(() => { c.stderr.emit("data", "agent loop failed: model did not reach a terminal state within 6 step(s)"); c.emit("close", 1); }); return c; };
  const r = await invokeMuse({ ...base(), spawnImpl });
  assert.equal(r.subtype, "error_max_turns");
});

test("codex runs with an isolated config: only Keir's MCP, auto-approved, shell and plugins off", async () => {
  let seen;
  const { invokeCodex } = require("../lib/operator/providers");
  const spawnImpl = (cmd, args, opts) => {
    const toml = fs.readFileSync(path.join(opts.env.CODEX_HOME, "config.toml"), "utf8");
    fs.writeFileSync(args[args.indexOf("-o") + 1], "answer");
    seen = { cmd, args, toml, home: opts.env.CODEX_HOME };
    const c = new EventEmitter(); c.pid = 999997; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end(input) { seen.stdin = input; } };
    setImmediate(() => { c.stdout.emit("data", JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12345, output_tokens: 234, cached_input_tokens: 12000 } }) + "\n"); c.emit("close", 0); }); return c;
  };
  const r = await invokeCodex({ ...base(), model: "gpt-6-luna", effort: "max", spawnImpl });
  assert.equal(seen.cmd, "codex");
  assert.match(seen.toml, /model_reasoning_effort = "max"/);
  assert.match(seen.toml, /shell_tool = false/);
  assert.match(seen.toml, /\[mcp_servers\.keir\]\nurl = "http:\/\/127\.0\.0\.1:1\/mcp\/abc"\ndefault_tools_approval_mode = "approve"/);
  assert.match(seen.toml, /required = true/, "Keir cannot run without its broker tools");
  assert.match(seen.toml, /mcp_optional_startup_grace_ms = 0/);
  assert.ok(!/mcp_servers\.(?!keir)/.test(seen.toml), "no other MCP servers");
  assert.ok(seen.args.includes("--ephemeral") && seen.args.includes("read-only"));
  assert.match(seen.stdin, /BRIEF[\s\S]*"task":1/);
  assert.ok(seen.args.includes("--json"));
  assert.deepEqual([r.result, r.usage.input_tokens, r.usage.output_tokens, r.usage.cache_read_input_tokens], ["answer", 12345, 234, 12000]);
});


test("current benchmark follows the actual Codex worker model and fixed medium pin", () => {
  const { currentWorker } = require("../lib/operator/benchmarkProvider");
  assert.deepEqual(currentWorker({ KEIR_WORKER_PROVIDER: "codex:gpt-6.1-sol@medium", KEIR_MODEL: "claude-opus-5-5" }), { runner: "codex", model: "gpt-6.1-sol", effort: "medium" });
  assert.deepEqual(currentWorker({}), { runner: "claude", model: "claude-opus-5-5", effort: null });
});

test("the Rust runner receives the job, lane, tool session and route, and its Claude-shaped result passes through", async () => {
  const { invokeRust } = require("../lib/operator/providers");
  let seen;
  const out = JSON.stringify({ subtype: "success", is_error: false, result: "answered", num_turns: 4, usage: { input_tokens: 5, output_tokens: 1 }, provenance: { runner: "rust", attempt: "k-1", label: "claude-cli-subscription-via-rust", tool_calls: 4 } });
  let briefSeen;
  const r = await invokeRust({ ...base(), spawnImpl: fakeSpawn(out, (cmd, args, opts) => { seen = { cmd, args, opts }; briefSeen = fs.readFileSync(args[args.indexOf("--brief-file") + 1], "utf8"); }), runner: "claude", job: { id: "job1", ticket: 1522 }, lane: "quick", bin: "/usr/local/bin/lakeside" });
  assert.equal(seen.cmd, "/usr/local/bin/lakeside");
  assert.equal(seen.args[0], "activation");
  assert.equal(seen.args[seen.args.indexOf("--task") + 1], "ticket:1522");
  assert.equal(seen.args[seen.args.indexOf("--route") + 1], "claude:m@medium");
  assert.equal(seen.args[seen.args.indexOf("--tools-url") + 1], "http://127.0.0.1:1/mcp/abc");
  assert.equal(briefSeen, "BRIEF");
  assert.equal(fs.existsSync(seen.args[seen.args.indexOf("--brief-file") + 1]), false, "scratch is cleaned up");
  assert.equal(r.subtype, "success"); assert.equal(r.provenance.runner, "rust"); assert.equal(r.num_turns, 4);
  await assert.rejects(invokeRust({ ...base(), spawnImpl: fakeSpawn("not json", () => {}, 1), runner: "claude", job: { id: "j" }, lane: "worker" }), /lakeside/);
});

test("the Rust runner takes listed lanes, probes only when listed, and worker tickets only from the allowlist", () => {
  const { rustLaneAllowed } = require("../lib/operator/agent");
  const cfg = (lanes, tickets = []) => ({ rustRunnerLanes: lanes, rustRunnerTickets: tickets });
  assert.equal(rustLaneAllowed(cfg(["quick"]), { kind: "conversation" }, "quick"), true);
  assert.equal(rustLaneAllowed(cfg(["quick"]), { kind: "ticket", ticket: 1 }, "worker"), false);
  assert.equal(rustLaneAllowed(cfg(["quick"]), { internalProbe: true }, "quick"), false, "probes need their own entry");
  assert.equal(rustLaneAllowed(cfg(["probe"]), { internalProbe: true }, "quick"), true);
  assert.equal(rustLaneAllowed(cfg(["worker"], [1539]), { kind: "ticket", ticket: 1539 }, "worker"), true);
  assert.equal(rustLaneAllowed(cfg(["worker"], [1539]), { kind: "ticket", ticket: 1540 }, "worker"), false);
  assert.equal(rustLaneAllowed(cfg(["worker"], [1539]), { kind: "command" }, "worker"), true, "owner commands without a ticket follow the lane");
  assert.equal(rustLaneAllowed(cfg(["worker"]), { kind: "ticket", ticket: 7 }, "worker"), true, "empty allowlist means every ticket");
});

test("the vision lane routes a screenshot task to the configured model once, and leaves coders and text tasks alone", () => {
  const { routeForVision } = require("../lib/operator/agent");
  const audits = []; const ledger = { audit: (k, d) => audits.push([k, d]), save() {} };
  const cfg = { visionProvider: "muse:muse-spark-1.3@medium" };
  const job = { id: "j", ticket: 1522, tags: { needsVision: true }, provider: { lane: "worker", runner: "muse", model: "muse-wonder-full-1.0" } };
  assert.equal(routeForVision(job, cfg, ledger, "worker"), true);
  assert.deepEqual([job.provider.runner, job.provider.model, job.provider.effort, job.provider.lane, job.provider.vision], ["muse", "muse-spark-1.3", "medium", "worker", true]);
  assert.equal(job.provider.routedFrom, "muse:muse-wonder-full-1.0");
  assert.equal(routeForVision(job, cfg, ledger, "worker"), false, "the next activation hands it back");
  assert.deepEqual([job.provider.runner, job.provider.model, job.provider.vision], ["muse", "muse-wonder-full-1.0", undefined], "back on its driver");
  assert.equal(audits.length, 2); assert.equal(audits[0][0], "vision_lane_routed"); assert.equal(audits[1][0], "vision_lane_released");
  assert.equal(routeForVision(job, cfg, ledger, "worker"), false, "no new screenshot, no new routing");
  job.requestInbox = [{ attachments: [{ type: "image/png" }] }];
  assert.equal(routeForVision(job, cfg, ledger, "worker"), true, "a new screenshot routes once more");
  const quick = { id: "q", tags: { needsVision: true } };
  routeForVision(quick, cfg, ledger, "quick"); assert.equal(quick.provider.lane, "quick", "lane kept so providerOf does not reassign");
  assert.equal(routeForVision({ id: "t", tags: { needsVision: false } }, cfg, ledger), false);
  assert.equal(routeForVision({ id: "c", codingParent: "p", tags: { needsVision: true } }, cfg, ledger), false);
  const def = { id: "d", tags: { needsVision: true } }; routeForVision(def, {}, ledger); assert.equal(def.provider.model, "claude-sonnet-5-5", "Sonnet subscription is the default");
});
