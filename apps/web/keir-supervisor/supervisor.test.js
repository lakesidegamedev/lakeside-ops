"use strict";
// Integration tests for the private owner supervisor. The support operator is
// never started (its app port points at a closed socket and the guardian file
// reports it failed). A fixture "model" drives the real loopback MCP tool
// server, which runs real file edits and a real `node --test` inside the
// bubblewrap sandbox on a temporary clone. Sandbox tests skip, with the reason,
// on hosts without a usable bubblewrap.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { createSupervisor, createPublisher, guardianStatus } = require("./supervisor");
const { createSandbox } = require("./sandbox");
const { createAttention } = require("./attention");
const { handleKeirSupervisorRoute, ownerIdentity } = require("./routes");

const OWNER = ownerIdentity({ KEIR_OWNER_ID: "42" });
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "keir-sup-")); }

function fixtureRepo(root) {
  const src = path.join(root, "source");
  fs.mkdirSync(path.join(src, "lib"), { recursive: true });
  fs.writeFileSync(path.join(src, "lib/sum.js"), "module.exports = (a, b) => a - b;\n");
  fs.writeFileSync(path.join(src, "lib/sum.test.js"), "const test = require('node:test');\nconst assert = require('node:assert');\nconst sum = require('./sum');\ntest('adds', () => assert.equal(sum(2, 3), 5));\n");
  execFileSync("git", ["init", "-q", "-b", "main", src]);
  git(src, "add", "-A"); git(src, "commit", "-qm", "init");
  return src;
}

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

// A fixture model: fixes the bug, tests it, reports, proposes publishing.
function repairModel(log = []) {
  return {
    available: () => ({ available: true, reason: null, runner: "fixture", model: "fixture" }),
    async run({ toolUrl, prompt }) {
      log.push(prompt);
      const t = mcp(toolUrl);
      await t.init();
      const names = await t.list();
      assert.ok(names.includes("run_tests") && names.includes("propose_publish") && !names.includes("approve"));
      const g = await t.call("guardian_status");
      await t.call("open_workspace", { repo: "lakeside-ops" });
      const before = await t.call("read_file", { path: "lib/sum.js" });
      assert.match(before.text, /a - b/);
      await t.call("edit_file", { path: "lib/sum.js", old_string: "a - b", new_string: "a + b" });
      await t.call("post_update", { text: "Found it: sum subtracts. Fixed, running the test." });
      const tests = await t.call("run_tests", { files: ["lib/sum.test.js"] });
      const proposal = await t.call("propose_publish", { title: "fix(lib): add instead of subtract", summary: "sum() subtracted its arguments." });
      return { text: `Fixed lib/sum.js. Test ${tests.passed ? "passed" : "failed"} (pass ${tests.pass}, fail ${tests.fail}). Operator is ${g.units["keir-operator"].activeState}. Proposal ${proposal.proposal}.` };
    },
  };
}

function setup({ executor, sandbox, publisher = null, publishEnabled = false, root = tmp(), maxAttempts = 2, attention = null, evidence = null } = {}) {
  const source = fs.existsSync(path.join(root, "source")) ? path.join(root, "source") : fixtureRepo(root);
  const guardianDir = fs.existsSync(path.join(root, "guardian")) ? path.join(root, "guardian") : guardianFile(root);
  const stateDir = path.join(root, "state");
  const repos = { "lakeside-ops": { key: "lakeside-ops", source, base: "main", github: null, deps: [], note: "fixture", available: true, reason: null } };
  const sb = sandbox || createSandbox(path.join(stateDir, "workspaces"));
  const sup = createSupervisor({ stateDir, repos, sandbox: sb, executor, guardianDir, publisher, publishEnabled, maxAttempts, attention, evidence });
  return { root, source, stateDir, sup, sandbox: sb, repos, guardianDir };
}

async function serve(sup, status = async () => ({ configured: true })) {
  const sessions = { owner: { role: "admin", email: OWNER }, staff: { role: "admin", email: "someone@else" }, mod: { role: "moderator", email: OWNER } };
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const handled = await handleKeirSupervisorRoute(req, res, pathname, {
      env: { KEIR_OWNER_ID: "42" },
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


let sandboxState = null;
async function sandboxReady() {
  if (!sandboxState) { const d = tmp(); sandboxState = await createSandbox(d).available(); fs.rmSync(d, { recursive: true, force: true }); }
  return sandboxState;
}

test("guardian status is read from the guardian's own file and sanitized", () => {
  const root = tmp();
  const g = guardianStatus(guardianFile(root));
  assert.equal(g.available, true);
  assert.equal(g.units["keir-operator"].activeState, "failed");
  assert.equal(g.units["keir-operator"].secret, undefined);
  assert.equal(guardianStatus(path.join(root, "missing")).available, false);
});

test("owner-only access, CSRF rules, dedupe and an unavailable executor, with support down", async () => {
  const executor = { available: () => ({ available: false, reason: "Claude Code CLI not installed for the web service account", runner: "claude", model: "m" }), run: async () => { throw new Error("must not run"); } };
  const sandbox = { exists: () => false, op: async () => { throw new Error("no sandbox use expected"); }, available: async () => ({ available: false }) };
  const { sup, stateDir } = setup({ executor, sandbox });
  await sup.start();
  const app = await serve(sup);
  try {
    assert.equal((await app.req("/api/keir/supervisor/thread", { who: null })).status, 401);
    assert.equal((await app.req("/api/keir/supervisor/thread", { who: "staff" })).status, 403);
    assert.equal((await app.req("/api/keir/supervisor/thread", { who: "mod" })).status, 403);
    assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "hi", clientId: "client-0001" }, headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "hi", clientId: "client-0001" }, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(app.base + "/api/keir/supervisor/messages", { method: "POST", headers: { cookie: "ops_session=owner", "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "hi", clientId: "bad id" } })).status, 400);

    const first = await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "Is Keir up?", clientId: "client-0001" } });
    assert.equal(first.status, 202);
    const a = await first.json();
    assert.equal(a.accepted, true); assert.equal(a.duplicate, false);
    const again = await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "Is Keir up?", clientId: "client-0001" } });
    assert.equal(again.status, 200);
    const b = await again.json();
    assert.equal(b.duplicate, true); assert.equal(b.job.id, a.job.id); assert.equal(b.message.id, a.message.id);
    assert.equal((await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "different", clientId: "client-0001" } })).status, 409);

    await untilIdle(sup);
    const view = await (await app.req("/api/keir/supervisor/thread")).json();
    assert.equal(view.messages.filter((m) => m.role === "owner").length, 1);
    const err = view.messages.find((m) => m.kind === "error");
    assert.match(err.text, /could not start the model.*not installed.*nothing was changed/i);
    assert.equal(view.jobs[0].state, "blocked");
    assert.equal(view.working, false);
    assert.equal(view.executor.available, false);
    // Persisted: a fresh read of the state file has the same transcript.
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.equal(saved.messages.length, 2);
    assert.ok(saved.clientIds["client-0001"]);
  } finally { app.close(); sup.stop(); }
});

test("real repair in the sandbox: edit, focused test, proposal bound to the patch; live checkout untouched", async (t) => {
  const ready = await sandboxReady();
  if (!ready.available) return t.skip(`bubblewrap unavailable: ${ready.reason}`);
  const prompts = [];
  const alertDir = path.join(tmp(), "alerts");
  const { sup, source, stateDir } = setup({ executor: repairModel(prompts), attention: createAttention({ dir: alertDir }) });
  await sup.start();
  const app = await serve(sup);
  try {
    const posted = await (await app.req("/api/keir/supervisor/messages", { method: "POST", body: { text: "sum() is wrong, fix it", clientId: "ios-repair-1" } })).json();
    // Long poll from the cursor until the answer arrives.
    let cursor = posted.message.seq, messages = [];
    for (let i = 0; i < 40 && !messages.some((m) => m.kind === "answer" || m.kind === "error"); i++) {
      const v = await (await app.req(`/api/keir/supervisor/thread?after=${cursor}&wait=5`)).json();
      messages.push(...v.messages); cursor = v.cursor;
    }
    const kinds = messages.map((m) => m.kind);
    assert.deepEqual(kinds, ["update", "approval", "answer"], JSON.stringify(messages));
    assert.match(messages[2].text, /Test passed \(pass 1, fail 0\)\. Operator is failed\./);
    assert.match(prompts[0], /sum\(\) is wrong, fix it/);

    const view = await (await app.req("/api/keir/supervisor/thread")).json();
    const job = view.jobs[0];
    assert.equal(job.state, "done");
    assert.deepEqual(job.changedFiles, ["lib/sum.js"]);
    assert.equal(job.tests.passed, true);
    // The live source checkout is untouched.
    assert.equal(fs.readFileSync(path.join(source, "lib/sum.js"), "utf8"), "module.exports = (a, b) => a - b;\n");
    assert.equal(git(source, "status", "--porcelain"), "");
    // The edit lives in the workspace clone.
    const ws = path.join(stateDir, "workspaces", job.workspace, "repo", "lib/sum.js");
    assert.match(fs.readFileSync(ws, "utf8"), /a \+ b/);

    const { proposals } = await (await app.req("/api/keir/supervisor/proposals")).json();
    assert.equal(proposals.length, 1);
    const p = proposals[0];
    assert.equal(p.state, "pending"); assert.deepEqual(p.files, ["lib/sum.js"]); assert.match(p.tests, /passed/);
    // One alert file for the pending proposal, carrying only its id and state: no chat, title, summary or patch.
    assert.deepEqual(fs.readdirSync(alertDir), [`${p.id}.json`]);
    const alert = JSON.parse(fs.readFileSync(path.join(alertDir, `${p.id}.json`), "utf8"));
    assert.deepEqual(Object.keys(alert).sort(), ["createdAt", "id", "kind", "state", "updatedAt", "version"]);
    assert.equal(alert.state, "pending");
    assert.doesNotMatch(JSON.stringify(alert), /sum|subtract|lib\//);
    const wrong = await app.req(`/api/keir/supervisor/proposals/${p.id}`, { method: "POST", body: { verdict: "approve", digest: "0".repeat(64) } });
    assert.equal(wrong.status, 409);
    const disabled = await app.req(`/api/keir/supervisor/proposals/${p.id}`, { method: "POST", body: { verdict: "approve", digest: p.digest } });
    assert.equal(disabled.status, 409);
    assert.match((await disabled.json()).error, /not enabled/);
    assert.equal(sup.proposals()[0].state, "pending");
    assert.equal(JSON.parse(fs.readFileSync(path.join(alertDir, `${p.id}.json`), "utf8")).state, "pending", "a refused approval leaves the alert open");
    const rejected = await (await app.req(`/api/keir/supervisor/proposals/${p.id}`, { method: "POST", body: { verdict: "reject", digest: p.digest } })).json();
    assert.equal(rejected.proposal.state, "rejected");
    assert.equal(JSON.parse(fs.readFileSync(path.join(alertDir, `${p.id}.json`), "utf8")).state, "closed", "deciding closes the alert");
    assert.equal((await app.req(`/api/keir/supervisor/proposals/${p.id}`, { method: "POST", body: { verdict: "reject", digest: p.digest } })).status, 409);
  } finally { app.close(); sup.stop(); }
});

test("crash mid-job and web restart: work is preserved and the job resumes once", async (t) => {
  const ready = await sandboxReady();
  if (!ready.available) return t.skip(`bubblewrap unavailable: ${ready.reason}`);
  const root = tmp();
  let snapshot = null;
  // Attempt 1: edit, then the "web server" dies while the model is still running.
  const dying = { available: () => ({ available: true }), async run({ toolUrl, signal }) {
    const m = mcp(toolUrl); await m.init();
    await m.call("open_workspace", { repo: "lakeside-ops" });
    await m.call("edit_file", { path: "lib/sum.js", old_string: "a - b", new_string: "a + b" });
    snapshot = fs.readFileSync(path.join(root, "state", "state.json"), "utf8");
    await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
    return { cancelled: true };
  } };
  const one = setup({ executor: dying, root });
  await one.sup.start();
  const posted = one.sup.post("fix sum and run its test", "ios-crash-0001");
  for (let i = 0; i < 400 && !snapshot; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(snapshot, "first attempt never reached the edit");
  one.sup.stop();
  // Simulate the hard crash: state as it was mid-run, lock held by a dead pid.
  fs.writeFileSync(path.join(root, "state", "state.json"), snapshot);
  fs.writeFileSync(path.join(root, "state", "runner.lock"), "999999");

  const prompts = [];
  const resume = { available: () => ({ available: true }), async run({ toolUrl, prompt }) {
    prompts.push(prompt);
    const m = mcp(toolUrl); await m.init();
    const opened = await m.call("open_workspace", { repo: "lakeside-ops" });
    const tests = await m.call("run_tests", { files: ["lib/sum.test.js"] });
    return { text: `reused=${opened.reused} kept=${opened.changedFiles.join(",")} passed=${tests.passed}` };
  } };
  const two = setup({ executor: resume, root });
  const started = await two.sup.start();
  assert.equal(started.owner, true); assert.equal(started.recovered, 1);
  await untilIdle(two.sup);
  const view = two.sup.thread({});
  const job = view.jobs[0];
  assert.equal(job.id, posted.job.id);
  assert.equal(job.state, "done");
  assert.equal(job.attempts, 2);
  assert.deepEqual(job.preserved[0].files, ["lib/sum.js"]);
  assert.match(prompts[0], /Resume note[\s\S]*restarted[\s\S]*lib\/sum\.js/);
  assert.match(view.messages.find((m) => m.kind === "notice").text, /restarted while I was working[\s\S]*lib\/sum\.js/);
  assert.equal(view.messages.at(-1).text, "reused=true kept=lib/sum.js passed=true");
  // The preserved patch is on disk.
  assert.ok(fs.readdirSync(path.join(root, "state", "artifacts")).some((f) => /-restart1-\d+\.patch$/.test(f)));
  // Replaying the original client id after the restart does not create a job.
  const replay = two.sup.post("fix sum and run its test", "ios-crash-0001");
  assert.equal(replay.duplicate, true); assert.equal(replay.job.id, posted.job.id);
  assert.equal(Object.keys(two.sup.store.state.jobs).length, 1);
  two.sup.stop();
});

test("model process crash: preserved diff, automatic single resume, then honest failure", async (t) => {
  const ready = await sandboxReady();
  if (!ready.available) return t.skip(`bubblewrap unavailable: ${ready.reason}`);
  let calls = 0;
  const crashing = { available: () => ({ available: true }), async run({ toolUrl }) {
    calls += 1;
    const m = mcp(toolUrl); await m.init();
    await m.call("open_workspace", { repo: "lakeside-ops" });
    if (calls === 1) await m.call("write_file", { path: "notes/plan.md", content: "half done\n" });
    return { interrupted: true, reason: "model exited 1: connection reset" };
  } };
  const { sup, stateDir } = setup({ executor: crashing });
  await sup.start();
  sup.post("long refactor", "ios-crash-model-1");
  await untilIdle(sup);
  const view = sup.thread({});
  assert.equal(calls, 2);
  assert.equal(view.jobs[0].state, "failed");
  assert.equal(view.jobs[0].preserved.length, 2);
  assert.deepEqual(view.jobs[0].preserved[0].files, ["notes/plan.md"]);
  const kinds = view.messages.map((m) => m.kind);
  assert.deepEqual(kinds, ["message", "notice", "error"]);
  assert.match(view.messages[2].text, /could not finish[\s\S]*notes\/plan\.md[\s\S]*continue/);
  assert.equal(fs.readdirSync(path.join(stateDir, "artifacts")).filter((f) => f.endsWith(".patch")).length, 2);
  sup.stop();
});

test("sandbox isolation: no host files, credentials, env or network; symlink escapes refused", async (t) => {
  const ready = await sandboxReady();
  if (!ready.available) return t.skip(`bubblewrap unavailable: ${ready.reason}`);
  const results = {};
  const probe = { available: () => ({ available: true }), async run({ toolUrl }) {
    const m = mcp(toolUrl); await m.init();
    await m.call("open_workspace", { repo: "lakeside-ops" });
    results.host = await m.call("shell", { command: `ls /root /etc ${JSON.stringify(path.dirname(require.resolve("./supervisor")))} 2>&1; echo "env=$(env | cut -d= -f1 | sort | tr '\\n' ' ')"` });
    results.net = await m.call("shell", { command: "/opt/keir-runtime/node -e \"require('net').connect(443,'1.1.1.1').on('error',e=>console.log('neterr',e.code)).on('connect',()=>console.log('connected'))\"; sleep 1" });
    await m.call("shell", { command: "ln -s /etc/hostname lib/escape && ln -s ../../.. lib/up" });
    try { await m.call("read_file", { path: "lib/escape" }); results.escape = "read"; } catch (e) { results.escape = e.message; }
    try { await m.call("read_file", { path: "../state.json" }); results.dotdot = "read"; } catch (e) { results.dotdot = e.message; }
    try { await m.call("read_file", { path: "/etc/passwd" }); results.abs = "read"; } catch (e) { results.abs = e.message; }
    try { await m.call("write_file", { path: "lib/up/x", content: "x" }); results.upwrite = "written"; } catch (e) { results.upwrite = e.message; }
    try { await m.call("open_workspace", { repo: "/root/projects/AHDGame" }); results.repo = "opened"; } catch (e) { results.repo = e.message; }
    return { text: "probed" };
  } };
  const { sup } = setup({ executor: probe });
  await sup.start();
  sup.post("probe", "probe-000001");
  await untilIdle(sup);
  assert.match(results.host.output, /ls: cannot access '\/root'/);
  assert.match(results.host.output, /ls: cannot access '\/etc'/);
  const names = /env=(.*)/.exec(results.host.output)[1].trim().split(" ");
  const allowed = ["CI", "FORCE_COLOR", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0", "HOME", "LANG", "NODE_OPTIONS", "NO_COLOR", "OLDPWD", "PATH", "PWD", "SHLVL", "TMPDIR", "UV_THREADPOOL_SIZE", "_"];
  assert.deepEqual(names.filter((n) => !allowed.includes(n)), [], `unexpected sandbox env: ${names.join(" ")}`);
  assert.doesNotMatch(results.host.output, /supervisor\.js/);
  assert.match(results.net.output, /neterr/);
  assert.doesNotMatch(results.net.output, /connected/);
  assert.match(results.escape, /not found|outside the repository/);
  assert.match(results.dotdot, /leaves the repository/);
  assert.match(results.abs, /absolute paths are not allowed/);
  assert.match(results.upwrite, /outside the repository|leaves/);
  assert.match(results.repo, /unknown repository/);
  sup.stop();
});

test("approval publishes the frozen patch from a fresh clone, once", async (t) => {
  const ready = await sandboxReady();
  if (!ready.available) return t.skip(`bubblewrap unavailable: ${ready.reason}`);
  const root = tmp();
  const source = fixtureRepo(root);
  const remote = path.join(root, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  git(source, "remote", "add", "origin", remote);
  git(source, "fetch", "-q", "origin");
  const { sup } = setup({ executor: repairModel(), root, publishEnabled: true, publisher: createPublisher({ env: gitEnv }) });
  await sup.start();
  const app = await serve(sup);
  try {
    sup.post("fix sum", "ios-publish-01");
    await untilIdle(sup);
    const p = sup.proposals()[0];
    const res = await app.req(`/api/keir/supervisor/proposals/${p.id}`, { method: "POST", body: { verdict: "approve", digest: p.digest } });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.proposal.state, "published");
    assert.equal(body.proposal.branch, `keir-supervisor/${p.id}`);
    const shown = execFileSync("git", ["--git-dir", remote, "show", `${body.proposal.branch}:lib/sum.js`], { encoding: "utf8" });
    assert.match(shown, /a \+ b/);
    assert.match(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", body.proposal.branch], { encoding: "utf8" }), /^fix\(lib\): add instead of subtract/);
    assert.equal((await app.req(`/api/keir/supervisor/proposals/${p.id}`, { method: "POST", body: { verdict: "approve", digest: p.digest } })).status, 409);
    assert.equal(git(source, "status", "--porcelain"), "");
    assert.match(sup.thread({}).messages.at(-1).text, /Published .* Nothing was merged or deployed/);
  } finally { app.close(); sup.stop(); }
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
