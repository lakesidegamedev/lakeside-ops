"use strict";
// Tests for the private owner supervisor: the owner's app chat as a full Claude
// Code agent. A fake `claude` binary (and fake systemd-run / systemctl) stand in
// for the real ones so the spawned command, its environment, the MCP config, the
// process-tree stop, the runtime cap and restart recovery are all checked
// against real child processes. Owner-only auth is checked on every route.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createSupervisor, guardianStatus, brief, TOOLS } = require("./supervisor");
const { createClaudeExecutor, sessionFile } = require("./executor");
const { handleKeirSupervisorRoute, ownerIdentity } = require("./routes");
const { formatET } = require("./et");
const { ownerAttention, origin } = require("./owner-attention");

const OWNER = ownerIdentity({ KEIR_OWNER_ID: "42" });

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "keir-sup-")); }

function guardianFile(root) {
  const dir = path.join(root, "guardian"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ at: Date.now(), healthy: false, killSwitchFilePresent: false,
    units: { "keir-operator": { activeState: "failed", status: "down", reason: "gave up after 3 restarts", action: "none", restartsInWindow: 3, secret: "x" } },
    timers: { "keir-shadow.timer": { activeState: "active", status: "ok" } }, restarts: [{ at: Date.now(), unit: "keir-operator", reason: "health probe failed" }], giveUps: [] }));
  return dir;
}

// Minimal MCP client, the same JSON-RPC calls Claude Code makes.
function mcp(url) {
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await r.json();
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  return {
    init: () => rpc("initialize", { protocolVersion: "2025-06-18" }),
    list: async () => (await rpc("tools/list", {})).tools.map((t) => t.name),
    call: async (name, args = {}) => {
      const r = await rpc("tools/call", { name, arguments: args });
      const text = r.content.map((c) => c.text).join("\n");
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    },
  };
}

// A ledger with one valid pending decision on ticket 1871 (the shape of the
// item the app counted on 2026-11-21), one answered decision and one question
// whose task already finished.
function ledgerFixture() {
  return {
    jobs: { j1: { id: "j1", state: "running", ticket: 1871 }, j2: { id: "j2", state: "done", ticket: 9 } },
    decisions: {
      d1: { id: "d1", jobId: "j1", state: "pending", at: Date.UTC(2026, 10, 21, 17, 9, 55), question: "Ticket 1871: Pay the turn 108 CEO salaries and dividends as a correction?" },
      d2: { id: "d2", jobId: "j1", state: "selected", at: Date.UTC(2026, 10, 21, 16, 0) },
    },
    appThread: { questions: { q1: { id: "q1", jobId: "j2", state: "pending", title: "Stale question" } } },
  };
}

function setup({ executor, root = tmp(), maxAttempts = 2, attention = null, evidence = null, attentionRead, jobTimeoutMs } = {}) {
  const guardianDir = fs.existsSync(path.join(root, "guardian")) ? path.join(root, "guardian") : guardianFile(root);
  const stateDir = path.join(root, "state");
  const sup = createSupervisor({ stateDir, executor, guardianDir, maxAttempts, attention, evidence,
    attentionRead: attentionRead || (() => ownerAttention({ ledger: ledgerFixture() })), ...(jobTimeoutMs ? { jobTimeoutMs } : {}) });
  return { root, stateDir, sup, guardianDir };
}

async function serve(sup, status = async () => ({ configured: true }), appUpstream = undefined) {
  const sessions = { owner: { role: "admin", email: OWNER }, staff: { role: "admin", email: "someone@else" }, mod: { role: "moderator", email: OWNER } };
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const handled = await handleKeirSupervisorRoute(req, res, pathname, {
      env: { KEIR_OWNER_ID: "42", KEIR_APP_BASE_URL: appUpstream },
      resolveSession: async (r) => sessions[/ops_session=(\w+)/.exec(r.headers.cookie || "")?.[1]] || null,
      getSupervisor: () => ({ configured: true, missing: [], instance: sup, status }),
    });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (p, { who = "owner", method = "GET", body, headers = {} } = {}) => fetch(base + p, { method,
    headers: { ...(who ? { cookie: `ops_session=${who}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { base, req, close: () => server.close() };
}

async function untilIdle(sup) { assert.equal(await sup.idle(120000), true, "jobs did not settle"); }
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error("condition not met in time");
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Fake host: a `claude` that records how it was started and speaks stream-json,
// a systemd-run that records its scope request and execs the command after
// "--", and a systemctl that records what it was asked to kill.
function fakeHost(root, { mode = "answer", extraServers = {} } = {}) {
  const home = path.join(root, "home"); const bin = path.join(root, "bin"); const rec = path.join(root, "rec");
  for (const d of [home, bin, rec, path.join(home, ".claude")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/.credentials.json"), "{}");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { support: { type: "http", url: "http://127.0.0.1:9735/mcp", headers: { Authorization: "Bearer sk-not-a-real-token-000000000000" } }, gamestate: { type: "http", url: "http://127.0.0.1:9730/mcp" }, ...extraServers },
    projects: { [home]: { mcpServers: { "ops-knowledge": { type: "http", url: "http://127.0.0.1:9725/mcp" } } } } }));
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, `#!${process.execPath}
const fs = require("fs"); const { spawn } = require("child_process");
const rec = ${JSON.stringify(rec)}; const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2); const mcpFile = args[args.indexOf("--mcp-config") + 1];
let stdin = ""; process.stdin.on("data", (c) => { stdin += c; }); process.stdin.on("end", async () => {
  fs.writeFileSync(rec + "/claude-" + Date.now() + "-" + process.pid + ".json", JSON.stringify({ args, cwd: process.cwd(), env: process.env, pid: process.pid, pgid: process.pid, stdin, mcp: JSON.parse(fs.readFileSync(mcpFile, "utf8")) }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "system", subtype: "init", tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__support__support_get", "mcp__supervisor__owner_attention"], mcp_servers: [{ name: "support", status: "connected" }, { name: "supervisor", status: "connected" }] });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr list", description: "List open pull requests" } }] } });
  if (mode === "act") {
    // What a desk job does with full reach: a host shell command and a write
    // through a host MCP server from the account's own ~/.claude.json.
    const { execSync } = require("child_process");
    fs.writeFileSync(rec + "/shell.txt", execSync("echo shell-ran-as-$(id -un)").toString());
    const conf = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"));
    const r = await fetch(conf.mcpServers.kanban.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kanban_update", arguments: { id: 7, impact: "low" } } }) });
    const written = await r.json();
    out({ type: "result", subtype: "success", is_error: false, result: "Ran it and updated card 7: " + written.result.content[0].text, num_turns: 2 });
    return;
  }
  if (mode === "hang") {
    const kid = spawn("sleep", ["300"], { stdio: "ignore" });
    fs.writeFileSync(rec + "/tree.json", JSON.stringify({ claude: process.pid, child: kid.pid }));
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: "result", subtype: "success", is_error: false, result: "Done. Merged PR 12 after its checks went green.", num_turns: 3, usage: { output_tokens: 10 }, total_cost_usd: 0.01 });
});
`, { mode: 0o755 });
  const systemdRun = path.join(bin, "systemd-run");
  fs.writeFileSync(systemdRun, `#!/bin/bash\nprintf '%s\\n' "$@" > ${rec}/systemd-run.args\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n`, { mode: 0o755 });
  const systemctl = path.join(bin, "systemctl");
  fs.writeFileSync(systemctl, `#!/bin/bash\necho "$@" >> ${rec}/systemctl.log\n`, { mode: 0o755 });
  const env = { HOME: home, PATH: process.env.PATH, KEIR_SUPERVISOR_CLAUDE_BIN: claude, KEIR_SUPERVISOR_SYSTEMD_RUN: systemdRun, KEIR_SUPERVISOR_SYSTEMCTL: systemctl,
    OPS_SESSION_SECRET: "web-service-secret-must-not-leak", KEIR_SUPERVISOR_MODEL: "claude-opus-5-5", KEIR_SUPERVISOR_EFFORT: "high" };
  const records = () => fs.readdirSync(rec).filter((f) => f.startsWith("claude-")).sort().map((f) => JSON.parse(fs.readFileSync(path.join(rec, f), "utf8")));
  return { home, bin, rec, env, claude, records, file: (n) => path.join(rec, n) };
}

test("a signed-in owner can ask the supervisor to create a private side chat", async (t) => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url, cookie: req.headers.cookie, ...JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "abcdef012345", title: "Payroll review" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const executor = { available: () => ({ available: true }), async run({ toolUrl }) {
    const client = mcp(toolUrl);
    await client.init();
    const created = await client.call("create_side_chat", { title: "Payroll review" });
    assert.equal(created.id, "abcdef012345");
    return { text: `Created ${created.title}.` };
  } };
  const { sup, root } = setup({ executor });
  t.after(() => { sup.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await sup.start();
  const app = await serve(sup, undefined, `http://127.0.0.1:${upstream.address().port}`);
  t.after(app.close);
  const body = { text: "Create a side chat for payroll review", clientId: "side-chat-test" };
  assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body })).status, 202);
  await untilIdle(sup);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/api/keir/app/threads");
  assert.equal(received[0].cookie, "ops_session=owner");
  assert.equal(received[0].title, "Payroll review");
  assert.match(received[0].creationKey, /^sup:j_[a-f0-9]{16}:[a-f0-9]{16}$/);
  assert.equal(sup.thread({}).messages.at(-1).text, "Created Payroll review.");
});

test("a requested queue snapshot persists with the answer and limits the rendered rows", async (t) => {
  const snapshot = { state: "read", at: Date.now(), possiblyMore: false,
    items: Array.from({ length: 13 }, (_, i) => ({ number: i + 1, title: `Ticket ${i + 1}`, status: "open" })) };
  const evidence = { queue: async () => snapshot };
  const executor = { available: () => ({ available: true }), async run({ toolUrl }) {
    const client = mcp(toolUrl);
    await client.init();
    assert.deepEqual(await client.call("support_queue", { showCard: true }), snapshot);
    return { text: "I found 13 open tickets." };
  } };
  const { sup, root } = setup({ executor, evidence });
  t.after(() => { sup.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await sup.start();
  sup.post("Show my open tickets", "test-queue-card");
  await untilIdle(sup);
  const answer = sup.thread({}).messages.find((message) => message.kind === "answer");
  assert.equal(answer.text, "I found 13 open tickets.");
  assert.deepEqual(answer.queueCard.items, snapshot.items.slice(0, 12));
  assert.equal(answer.queueCard.possiblyMore, true);
});


test("guardian status is read from the guardian's own file and sanitized", () => {
  const root = tmp();
  const g = guardianStatus(guardianFile(root));
  assert.equal(g.available, true);
  assert.equal(g.units["keir-operator"].activeState, "failed");
  assert.equal(g.units["keir-operator"].secret, undefined);
  assert.match(g.atET, / (AM|PM) ET$/);
  assert.equal(guardianStatus(path.join(root, "missing")).available, false);
});

test("times to the owner are US Eastern with ET, never UTC", () => {
  // 2026-11-21 17:09:55 UTC is 12:09 PM in New York (EST, UTC-5).
  assert.equal(formatET(Date.UTC(2026, 10, 21, 17, 9, 55)), "12:09 PM ET");
  assert.equal(formatET("2026-11-21T20:57:00Z", { date: true }), "Sat, Nov 21, 3:57 PM ET");
  // Summer time is UTC-4.
  assert.equal(formatET(Date.UTC(2026, 6, 4, 16, 0)), "12:00 PM ET");
  assert.equal(formatET(null), null);
  assert.equal(formatET("not a date"), null);
});

test("owner-only auth is enforced on every supervisor route", async () => {
  const executor = { available: () => ({ available: false, reason: "Claude Code CLI not installed for the web service account" }), run: async () => { throw new Error("must not run"); } };
  const { sup } = setup({ executor });
  await sup.start();
  const app = await serve(sup);
  try {
    const routes = [["GET", "/api/keir/supervisor/thread"], ["GET", "/api/keir/supervisor/status"], ["GET", "/api/keir/supervisor/proposals"], ["GET", "/api/keir/supervisor/attention"],
      ["POST", "/api/keir/supervisor/messages", { text: "merge it", clientId: "auth-probe-1" }], ["POST", "/api/keir/supervisor/jobs/j_0123456789abcdef/cancel", {}],
      ["POST", "/api/keir/supervisor/proposals/p_0123456789abcdef", { verdict: "approve", digest: "x" }]];
    for (const [method, p, body] of routes) {
      assert.equal((await app.req(p, { who: null, method, body })).status, 401, `${method} ${p} without a session`);
      assert.equal((await app.req(p, { who: "staff", method, body })).status, 403, `${method} ${p} as another admin`);
      assert.equal((await app.req(p, { who: "mod", method, body })).status, 403, `${method} ${p} as a non-admin owner email`);
    }
    // Nothing reached the runner from the refused requests.
    assert.equal(sup.thread({}).messages.length, 0);
    assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "hi", clientId: "client-0001" }, headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "hi", clientId: "client-0001" }, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(app.base + "/api/keir/supervisor/messages", { method: "POST", headers: { cookie: "ops_session=owner", "content-type": "text/plain" }, body: "{}" })).status, 415);
    // The owner gets through, with dedupe, and an honest error when the model cannot start.
    const first = await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "Is Keir up?", clientId: "client-0001" } });
    assert.equal(first.status, 202);
    const again = await (await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "Is Keir up?", clientId: "client-0001" } })).json();
    assert.equal(again.duplicate, true);
    await untilIdle(sup);
    const view = await (await app.req("/api/keir/supervisor/thread")).json();
    assert.match(view.messages.find((m) => m.kind === "error").text, /could not start on this server.*not installed.*nothing was changed/i);
    assert.equal((await app.req("/api/keir/supervisor/attention")).status, 200);
  } finally { app.close(); sup.stop(); }
});

test("a job runs full Claude Code: all tools, permissions skipped, host settings and MCP servers, a memory-capped scope", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = fakeHost(root);
  const executor = createClaudeExecutor({ env: host.env, stateDir: path.join(root, "state") });
  const state = executor.available();
  assert.equal(state.available, true);
  assert.deepEqual(state.mcpServers, ["gamestate", "ops-knowledge", "support"]);
  assert.equal(state.memoryMax, "16G");
  assert.equal(state.model, "claude-opus-5-5");
  const { sup } = setup({ executor, root });
  t.after(() => sup.stop());
  await sup.start();
  sup.post("Merge PR 12 when it is green", "full-access-01");
  await untilIdle(sup);
  const [run] = host.records();
  const flag = (name) => run.args[run.args.indexOf(name) + 1];
  assert.ok(run.args.includes("--dangerously-skip-permissions"));
  for (const restriction of ["--tools", "--allowedTools", "--disallowedTools", "--setting-sources", "--strict-mcp-config", "--system-prompt", "--permission-mode", "--no-session-persistence"]) {
    assert.ok(!run.args.includes(restriction), `${restriction} must not be passed`);
  }
  assert.equal(flag("--model"), "claude-opus-5-5");
  assert.equal(flag("--effort"), "high");
  assert.equal(flag("--output-format"), "stream-json");
  assert.match(flag("--append-system-prompt"), /There is no approval step/);
  assert.match(flag("--session-id"), /^[0-9a-f-]{36}$/);
  // Host MCP servers load from the account's own ~/.claude.json, as in an
  // interactive session; the extra config adds only the supervisor endpoint.
  assert.deepEqual(Object.keys(run.mcp.mcpServers), ["supervisor"]);
  assert.match(run.mcp.mcpServers.supervisor.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{48}$/);
  assert.ok(!fs.existsSync(flag("--mcp-config")), "the per-run MCP file is removed afterwards");
  // A root login environment: real HOME, no web-service secrets.
  assert.equal(run.env.HOME, host.home);
  assert.equal(run.cwd, host.home);
  assert.equal(run.env.IS_SANDBOX, "1");
  assert.equal(run.env.TZ, "America/New_York");
  assert.equal(run.env.OPS_SESSION_SECRET, undefined);
  assert.match(run.stdin, /## Needs the owner[^]*1 thing needs the owner[^]*ticket 1871/);
  assert.match(run.stdin, /^Now: \w{3}, \w{3} \d+ \d{4}, \d+:\d{2} (AM|PM) ET\./);
  const scope = fs.readFileSync(host.file("systemd-run.args"), "utf8").split("\n");
  assert.ok(scope.includes("--scope") && scope.includes("--collect"));
  assert.ok(scope.includes("MemoryMax=16G") && scope.includes("MemorySwapMax=0"));
  assert.ok(scope.some((a) => /^--unit=keir-supervisor-j_[a-f0-9]{16}-a1\.scope$/.test(a)));
  const view = sup.thread({});
  assert.equal(view.messages.at(-1).text, "Done. Merged PR 12 after its checks went green.");
  const job = sup.store.state.jobs[view.jobs[0].id];
  assert.equal(job.runtime.tools, 10);
  assert.deepEqual(job.runtime.mcpServers.map((s) => s.name), ["support", "supervisor"]);
  assert.match(job.unit, /^keir-supervisor-j_[a-f0-9]{16}-a1\.scope$/);
});

test("the chat's own tools add to Claude Code; nothing proposes, approves or restricts", () => {
  const names = TOOLS().map((x) => x.name);
  assert.ok(names.includes("owner_attention") && names.includes("post_update"));
  for (const gone of ["propose_publish", "open_workspace", "shell", "mcp_read", "mcp_catalogue", "approve"]) assert.ok(!names.includes(gone), gone);
  const text = brief();
  assert.match(text, /There is no approval step, no allowlist and no proposal flow/);
  assert.match(text, /never UTC/);
  assert.doesNotMatch(text, /[–—]/);
  assert.doesNotMatch(text, /You (can only|cannot) /);
  assert.match(text, /render\.js/);
});

test("stop kills the whole process tree, including the scope", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = fakeHost(root, { mode: "hang" });
  const executor = createClaudeExecutor({ env: host.env, stateDir: path.join(root, "state") });
  const { sup } = setup({ executor, root });
  t.after(() => sup.stop());
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  const { job } = sup.post("Do a long thing", "stop-tree-01");
  const tree = await until(() => fs.existsSync(host.file("tree.json")) && JSON.parse(fs.readFileSync(host.file("tree.json"), "utf8")));
  assert.ok(alive(tree.claude) && alive(tree.child));
  await until(() => sup.store.state.jobs[job.id].activity?.text === "Running: List open pull requests");
  assert.equal(sup.thread({}).current.activity, "Running: List open pull requests");
  const res = await app.req(`/api/keir/supervisor/jobs/${job.id}/cancel`, { method: "POST", body: {} });
  assert.equal(res.status, 200);
  await untilIdle(sup);
  await until(() => !alive(tree.claude) && !alive(tree.child));
  assert.match(fs.readFileSync(host.file("systemctl.log"), "utf8"), /kill --kill-whom=all --signal=SIGKILL keir-supervisor-j_[a-f0-9]{16}-a1\.scope/);
  const view = sup.thread({});
  assert.equal(view.jobs[0].state, "cancelled");
  assert.match(view.messages.at(-1).text, /Stopped as asked\. I ended that job and everything it had started/);
});

test("a job past the runtime cap is stopped with its process tree and reported honestly", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = fakeHost(root, { mode: "hang" });
  const executor = createClaudeExecutor({ env: host.env, stateDir: path.join(root, "state") });
  const { sup } = setup({ executor, root, jobTimeoutMs: 1500 });
  t.after(() => sup.stop());
  await sup.start();
  sup.post("Do a very long thing", "runtime-cap-01");
  const tree = await until(() => fs.existsSync(host.file("tree.json")) && JSON.parse(fs.readFileSync(host.file("tree.json"), "utf8")));
  await untilIdle(sup);
  await until(() => !alive(tree.claude) && !alive(tree.child));
  const view = sup.thread({});
  assert.equal(view.jobs[0].state, "failed");
  assert.equal(view.jobs[0].attempts, 1, "a timed-out job is not retried automatically");
  assert.match(view.messages.at(-1).text, /ran past the \d+ minute limit for one job, and ended everything it had started/);
});

test("after a web restart the old scope is stopped and the same Claude Code session resumes once", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = "11111111-2222-4333-8444-555555555555";
  // First web process: the job starts, then the process "dies" mid-run.
  const first = { available: () => ({ available: true }), run: ({ onStart }) => { onStart({ unit: "keir-supervisor-old-a1.scope", pid: 2 ** 22 + 7, sessionId, resumed: false }); return new Promise(() => {}); } };
  const a = setup({ executor: first, root });
  await a.sup.start();
  const { job } = a.sup.post("Ship the fix", "restart-01");
  await until(() => a.sup.store.state.jobs[job.id].unit);
  // Second web process on the same state.
  const reaped = [], runs = [];
  const second = { available: () => ({ available: true }), reap: async (unit) => { reaped.push(unit); return true; },
    run: async (opts) => { runs.push(opts); return { text: "Picked it back up and finished." }; } };
  const b = setup({ executor: second, root });
  t.after(() => b.sup.stop());
  const started = await b.sup.start();
  assert.equal(started.recovered, 1);
  await untilIdle(b.sup);
  assert.deepEqual(reaped, ["keir-supervisor-old-a1.scope"]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].resume, true);
  assert.equal(runs[0].sessionId, sessionId);
  assert.equal(runs[0].attempt, 2);
  assert.match(runs[0].prompt, /web service restarted while you were working/);
  const texts = b.sup.thread({}).messages.map((m) => m.text);
  assert.ok(texts.includes("The server restarted while I was working on this. Picking it up again from where I was."));
  assert.equal(texts.at(-1), "Picked it back up and finished.");
});

test("the executor resumes a saved session and starts fresh when the transcript is gone", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = fakeHost(root);
  const executor = createClaudeExecutor({ env: { ...host.env, KEIR_SUPERVISOR_SYSTEMD_RUN: "" }, stateDir: path.join(root, "state") });
  const saved = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const file = sessionFile(host.home, host.home, saved);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}\n");
  const base = { jobId: "j_0000000000000001", brief: "b", prompt: "p", toolUrl: "http://127.0.0.1:1/mcp/x" };
  const resumed = await executor.run({ ...base, attempt: 2, sessionId: saved, resume: true });
  assert.equal(resumed.sessionId, saved);
  const missing = await executor.run({ ...base, attempt: 3, sessionId: "00000000-0000-4000-8000-000000000000", resume: true });
  assert.notEqual(missing.sessionId, "00000000-0000-4000-8000-000000000000");
  const [r1, r2] = host.records();
  assert.equal(r1.args[r1.args.indexOf("--resume") + 1], saved);
  assert.ok(!r2.args.includes("--resume") && r2.args.includes("--session-id"));
  assert.equal(executor.available().scope, "process-group");
});

test("the app badge count and the chat's \"needs you\" answer come from one function", async (t) => {
  const ledger = ledgerFixture();
  let reads = 0;
  const attentionRead = () => { reads += 1; return ownerAttention({ ledger, now: Date.UTC(2026, 10, 21, 17, 10) }); };
  const seen = {};
  const executor = { available: () => ({ available: true }), async run({ toolUrl, prompt }) {
    const client = mcp(toolUrl); await client.init();
    seen.tool = await client.call("owner_attention");
    seen.prompt = prompt;
    return { text: `${seen.tool.count} thing needs you.` };
  } };
  const { sup, root } = setup({ executor, attentionRead });
  t.after(() => { sup.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  sup.post("Does anything need me?", "attention-01");
  await untilIdle(sup);
  const route = await (await app.req("/api/keir/supervisor/attention")).json();
  assert.equal(reads, 3, "job context, the chat's tool and the route all called the same reader");
  assert.deepEqual(seen.tool, route);
  assert.equal(route.count, 1);
  assert.equal(route.items[0].id, "decision:d1");
  assert.equal(route.items[0].ticket, 1871);
  assert.equal(route.items[0].sinceET, "Sat, Nov 21, 12:09 PM ET");
  assert.match(seen.prompt, /1 thing needs the owner\.\n- decision \(ticket 1871\): Ticket 1871: Pay the turn 108/);
  // The stale question on a finished task is not counted (the app drops it too).
  assert.ok(!route.items.some((i) => i.id === "question:q1"));
  // An unreadable ledger is reported as unknown, never as "nothing needs you".
  const blind = ownerAttention({ ledger: null });
  assert.equal(blind.complete, false);
  assert.match(blind.summary, /cannot say/);
});

test("decisions hidden from the app by an invalid task origin are hidden from the chat too", () => {
  const ledger = ledgerFixture();
  ledger.jobs.j3 = { id: "j3", state: "running", replyChannel: "app" };
  ledger.decisions.d3 = { id: "d3", jobId: "j3", state: "pending", at: 1 };
  ledger.appThread.questions.q2 = { id: "q2", jobId: "j1", state: "pending", title: "Which tier?" };
  const r = ownerAttention({ ledger });
  assert.deepEqual(r.items.map((i) => i.id), ["decision:d1", "question:q2"]);
  // The copy of the operator's origin rule agrees with the operator itself.
  let agent;
  try { agent = require("../../agent/lib/operator/ownermuse-policy"); } catch { return; }
  for (const id of Object.keys(ledger.jobs)) assert.deepEqual({ ...origin(ledger, ledger.jobs[id]) }, (({ scoped, valid }) => ({ scoped, valid }))(agent.origin(ledger, ledger.jobs[id])), id);
});

test("an old pending proposal can still be rejected from the app card", async (t) => {
  const executor = { available: () => ({ available: true }), run: async () => ({ text: "ok" }) };
  const { sup, root } = setup({ executor });
  t.after(() => { sup.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  sup.store.state.proposals.p_0123456789abcdef = { id: "p_0123456789abcdef", jobId: "j_x", repo: "lakeside-ops", state: "pending", title: "old", summary: "", files: [], digest: "d".repeat(64), tests: "", createdAt: 1 };
  sup.store.save();
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  const res = await app.req("/api/keir/supervisor/proposals/p_0123456789abcdef", { method: "POST", body: { verdict: "reject", digest: "d".repeat(64) } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).proposal.state, "rejected");
});

test("the owner can recall an archived exchange after restart without returning the current request", async (t) => {
  const { createStore, HOT_MESSAGES } = require("./store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-owner-recall-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  store.append({ role: "owner", text: "Remember the equity allocation for ticket 1867." });
  for (let i = 0; i < HOT_MESSAGES; i++) store.append({ role: "supervisor", text: "Another exchange" });
  const recent = store.append({ role: "supervisor", text: "Updated ticket 1867." });
  const current = store.append({ role: "owner", text: "Recall ticket 1867." });
  store.save();
  const reopened = createStore(dir);
  const results = await reopened.recall("TICKET 1867", current.seq);
  assert.deepEqual(results.map((row) => row.seq), [recent.seq, 1]);
  assert.match(results[1].excerpt, /equity allocation/);
});

// ---- Every owner chat in the app: images, model choice, the desk and side chats ----

// A real 2x2 PNG, built here so the test needs no fixture file.
const PNG = (() => {
  const zlib = require("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
})();
function rawUpload(app, bytes, { who = "owner", thread = "owner-supervisor", name = "chart.png", headers = {} } = {}) {
  return fetch(app.base + "/api/keir/supervisor/uploads", { method: "POST", body: bytes,
    headers: { ...(who ? { cookie: `ops_session=${who}` } : {}), "content-type": "image/png", "x-filename": name, "x-keir-thread": thread, ...headers } });
}

test("uploads, files and the model picker are owner-only", async (t) => {
  const executor = { available: () => ({ available: true }), model: "claude-opus-5-5", run: async () => ({ text: "ok" }) };
  const { sup, root } = setup({ executor });
  t.after(() => { sup.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  for (const who of [null, "staff", "mod"]) {
    const expected = who ? 403 : 401;
    assert.equal((await rawUpload(app, PNG, { who })).status, expected, `upload as ${who}`);
    assert.equal((await app.req("/api/keir/supervisor/models?thread=main", { who })).status, expected, `models as ${who}`);
    assert.equal((await app.req("/api/keir/supervisor/models", { who, method: "POST", body: { thread: "main", selection: "claude-haiku-5-5" } })).status, expected);
  }
  assert.equal(Object.keys(sup.store.state.files).length, 0, "nothing was stored for a refused upload");
  assert.equal((await rawUpload(app, PNG, { headers: { origin: "https://evil.example" } })).status, 403);
  const up = await rawUpload(app, PNG);
  assert.equal(up.status, 201);
  const d = await up.json();
  assert.match(d.url, /^\/api\/keir\/supervisor\/files\/[a-f0-9]{32}$/);
  assert.equal(d.type, "image/png");
  for (const who of [null, "staff", "mod"]) {
    assert.equal((await app.req(d.url, { who })).status, who ? 403 : 401, `file read as ${who}`);
    assert.equal((await app.req(d.url, { who, method: "DELETE" })).status, who ? 403 : 401, `file delete as ${who}`);
  }
  const got = await app.req(d.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.match(got.headers.get("cache-control"), /no-store/);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(PNG));
  // Not an image or document by its bytes: refused whatever the header says.
  assert.equal((await rawUpload(app, Buffer.from([0, 1, 2, 3, 0, 0]))).status, 415);
  assert.equal((await app.req(d.url, { method: "DELETE" })).status, 200);
  assert.equal((await app.req(d.url)).status, 404);
});

test("an image attached to a home-chat message reaches the job and the model is told its path", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = fakeHost(root);
  const executor = createClaudeExecutor({ env: host.env, stateDir: path.join(root, "state") });
  const { sup } = setup({ executor, root });
  t.after(() => sup.stop());
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  const d = await (await rawUpload(app, PNG, { name: "corp chart.png" })).json();
  const posted = await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "What chart is this?", clientId: "image-home-01", attachments: [{ id: d.id }] } });
  assert.equal(posted.status, 202);
  await untilIdle(sup);
  const [run] = host.records();
  const file = path.join(root, "state", "files", `${d.id}.png`);
  assert.ok(fs.existsSync(file), "stored with an image extension Claude Code's Read tool recognises");
  assert.ok(run.stdin.includes(file), "the prompt names the image's path");
  assert.match(run.stdin, /Open each with the Read tool/i);
  assert.match(run.stdin, /corp chart\.png, image\/png/);
  const owner = sup.thread({}).messages.find((m) => m.role === "owner");
  assert.deepEqual(owner.attachments.map((a) => a.id), [d.id]);
  // A sent upload is part of the message now: it cannot be claimed or deleted again.
  assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "again", clientId: "image-home-02", attachments: [d.id] } })).status, 409);
  assert.equal((await app.req(d.url, { method: "DELETE" })).status, 409);
  // An upload from another chat is not usable here.
  const other = await (await rawUpload(app, PNG, { thread: "main" })).json();
  assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "x", clientId: "image-home-03", attachments: [other.id] } })).status, 404);
  // Attachments alone are a message.
  const alone = await (await rawUpload(app, PNG)).json();
  assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "", clientId: "image-home-04", attachments: [alone.id] } })).status, 202);
  await untilIdle(sup);
});

test("the owner's model choice reaches the spawned command, per chat and per message", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = fakeHost(root);
  const executor = createClaudeExecutor({ env: host.env, stateDir: path.join(root, "state") });
  const { sup } = setup({ executor, root });
  t.after(() => sup.stop());
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  const picker = await (await app.req("/api/keir/supervisor/models?thread=main")).json();
  assert.deepEqual(picker.models.map((m) => m.id), ["auto", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]);
  assert.deepEqual(picker.efforts, ["auto", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(picker.selection, "auto");
  const set = await (await app.req("/api/keir/supervisor/models", { method: "POST", body: { thread: "main", selection: "claude-sonnet-5-5", effort: "max" } })).json();
  assert.equal(set.selection, "claude-sonnet-5-5");
  assert.equal(set.effort, "max");
  assert.equal((await app.req("/api/keir/supervisor/models", { method: "POST", body: { thread: "main", selection: "gpt-6" } })).status, 400);
  assert.equal((await app.req("/api/keir/supervisor/models", { method: "POST", body: { thread: "../etc", selection: "claude-opus-5-5" } })).status, 400);
  // The desk's saved choice; the home chat keeps the default; one message overrides.
  await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "desk question", clientId: "model-desk-01", thread: "main" } });
  await untilIdle(sup);
  await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "home question", clientId: "model-home-01" } });
  await untilIdle(sup);
  await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "quick one", clientId: "model-home-02", model: "claude-haiku-5-5", effort: "low" } });
  await untilIdle(sup);
  const flags = host.records().map((r) => [r.args[r.args.indexOf("--model") + 1], r.args[r.args.indexOf("--effort") + 1]]);
  assert.deepEqual(flags, [["claude-sonnet-5-5", "max"], ["claude-opus-5-5", "high"], ["claude-haiku-5-5", "low"]]);
  const desk = await (await app.req("/api/keir/supervisor/thread?thread=main")).json();
  assert.equal(desk.modelSelection, "claude-sonnet-5-5");
  assert.equal(desk.jobs[0].model, "claude-sonnet-5-5");
});

test("the support desk and side chats are the same unrestricted agent, each its own conversation", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writes = [];
  const hostMcp = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const msg = JSON.parse(body); writes.push(msg.params);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "impact low" }] } }));
  });
  await new Promise((r) => hostMcp.listen(0, "127.0.0.1", r));
  t.after(() => hostMcp.close());
  const host = fakeHost(root, { mode: "act", extraServers: { kanban: { type: "http", url: `http://127.0.0.1:${hostMcp.address().port}/mcp` } } });
  const executor = createClaudeExecutor({ env: host.env, stateDir: path.join(root, "state") });
  const { sup } = setup({ executor, root });
  t.after(() => sup.stop());
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "home only", clientId: "desk-home-01" } });
  await untilIdle(sup);
  await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "Run hostname and set card 7 to low", clientId: "desk-act-01", thread: "main" } });
  await untilIdle(sup);
  await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "side chat question", clientId: "side-act-01", thread: "abcdef012345" } });
  await untilIdle(sup);
  const [, desk, side] = host.records();
  for (const run of [desk, side]) {
    assert.ok(run.args.includes("--dangerously-skip-permissions"));
    for (const restriction of ["--tools", "--allowedTools", "--disallowedTools", "--strict-mcp-config", "--permission-mode"]) assert.ok(!run.args.includes(restriction), restriction);
    assert.match(run.args[run.args.indexOf("--append-system-prompt") + 1], /There is no approval step/);
  }
  assert.match(desk.stdin, /This conversation: the support desk chat/);
  assert.doesNotMatch(desk.stdin, /home only/, "the desk does not see the home chat's transcript");
  assert.match(side.stdin, /This conversation: a side chat \(id abcdef012345\)/);
  // The shell command ran and the MCP write went through, with no approval step.
  assert.match(fs.readFileSync(host.file("shell.txt"), "utf8"), /^shell-ran-as-/);
  // One write per job (home, desk, side chat): every chat has the same reach.
  assert.deepEqual(writes.map((w) => [w.name, w.arguments.impact]), [["kanban_update", "low"], ["kanban_update", "low"], ["kanban_update", "low"]]);
  const deskView = await (await app.req("/api/keir/supervisor/thread?thread=main")).json();
  assert.deepEqual(deskView.messages.map((m) => m.role), ["owner", "supervisor"]);
  assert.match(deskView.messages[1].text, /^Ran it and updated card 7: impact low/);
  for (const m of deskView.messages) assert.doesNotMatch(m.text, /Muse|cannot run|read-only|unsupported/i);
  const homeView = await (await app.req("/api/keir/supervisor/thread")).json();
  assert.deepEqual(homeView.messages.map((m) => m.text.slice(0, 9)), ["home only", "Ran it an"]);
  assert.equal((await app.req("/api/keir/supervisor/thread?thread=watches")).status, 400);
});

test("a file Keir attaches shows inline with its reply, served owner-only", async (t) => {
  const image = path.join(tmp(), "render.png");
  fs.writeFileSync(image, PNG);
  const executor = { available: () => ({ available: true }), async run({ toolUrl }) {
    const client = mcp(toolUrl);
    await client.init();
    assert.equal((await client.call("attach_file", { path: image })).attached, true);
    await assert.rejects(client.call("attach_file", { path: "relative.png" }), /absolute/);
    return { text: "Here is the render." };
  } };
  const { sup, root } = setup({ executor });
  t.after(() => { sup.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await sup.start();
  const app = await serve(sup);
  t.after(app.close);
  await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "render the landing page", clientId: "render-01", thread: "main" } });
  await untilIdle(sup);
  const answer = (await (await app.req("/api/keir/supervisor/thread?thread=main")).json()).messages.find((m) => m.kind === "answer");
  assert.equal(answer.attachments.length, 1);
  assert.equal(answer.attachments[0].type, "image/png");
  assert.equal(answer.attachments[0].name, "render.png");
  const served = await app.req(answer.attachments[0].url);
  assert.equal(served.status, 200);
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(PNG));
  assert.equal((await app.req(answer.attachments[0].url, { who: "staff" })).status, 403);
  // Keir's own files are not the owner's drafts to delete.
  assert.equal((await app.req(answer.attachments[0].url, { method: "DELETE" })).status, 409);
});
