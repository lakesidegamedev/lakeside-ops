"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildHubState, activityByHour, ciState } = require("./keir-hub-data");
const { handleKeirHubRoute } = require("./keir-hub-routes");
const { makeKeirHubBody } = require("./keir-hub-page");

const NOW = Date.parse("2026-10-14T06:00:00Z");
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-hub-"));
  const ledger = { jobs: {
    a1: { id: "a1", kind: "ticket", role: "support", state: "running", ticket: 1539, startedAt: NOW - 60000, updatedAt: NOW - 1000, rounds: 3, provider: { runner: "muse", model: "muse-wonder-full-1.0", via: "rust", attempt: "k-1" }, summary: "Tracing the energy line.", history: [{ at: new Date(NOW - 5000).toISOString(), kind: "checkpoint", summary: "Found the carry-forward." }], tags: { kind: "bug_report", mood: "frustrated" } },
    b2: { id: "b2", kind: "ticket", role: "support", state: "waiting", ticket: 1538, wakeAt: NOW + 600000, updatedAt: NOW - 3600000, provider: { runner: "claude" } },
    c3: { id: "c3", kind: "coding", codingParent: "a1", state: "done", ticket: 1539, updatedAt: NOW - 1800000, provider: { runner: "muse" }, summary: "Patched." },
    p4: { id: "p4", kind: "conversation", internalProbe: true, state: "running", updatedAt: NOW },
  }, decisions: { d1: { id: "d1", jobId: "a1", state: "pending", at: NOW - 7200000, tldr: "Promote the metrics fix?" } },
    statusCards: { 1539: { status: "x", items: [{ name: "Metrics", stage: "sandbox", blocked: false }] } }, audit: [{ kind: "rust_activation", at: NOW - 1000, job: "a1" }] };
  const p = { ledger: path.join(dir, "ledger.json"), usage: path.join(dir, "usage.jsonl"), harness: path.join(dir, "none.db"), shadow: path.join(dir, "shadow.json"), release: path.join(dir, "RELEASE"), env: path.join(dir, "env"), mcp: path.join(dir, "mcp.json") };
  fs.writeFileSync(p.ledger, JSON.stringify(ledger));
  fs.writeFileSync(p.usage, [
    { event: "activation", at: new Date(NOW - 30 * 60000).toISOString(), provider: "muse-cli-subscription", durationMs: 60000, outcome: "ok" },
    { event: "activation", at: new Date(NOW - 90 * 60000).toISOString(), provider: "claude-cli-subscription", durationMs: 20000, outcome: "error" },
    { event: "activation", at: new Date(NOW - 30 * 3600000).toISOString(), provider: "codex-cli-chatgpt-subscription", durationMs: 1, outcome: "ok" },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  fs.writeFileSync(p.release, "757e0c47d0766830d56fa54ef594fcd83ed4923c 3.5.2\n");
  fs.writeFileSync(p.env, "KEIR_RUST_RUNNER_LANES=probe,quick,worker\nKEIR_WORKER_PROVIDER=muse:muse-wonder-full-1.0@medium\n");
  fs.writeFileSync(p.mcp, JSON.stringify({ mcpServers: { support: { url: "http://127.0.0.1:1/mcp" } } }));
  fs.writeFileSync(p.shadow, JSON.stringify({ at: NOW, agreement_24h: [{ kind: "card-stage", agreed: 3, total: 3 }], review_queue: [], labels: [{ label: "closed_observing" }] }));
  return p;
}
const pr = (over) => ({ number: 4071, title: "fix(metrics): apply pressure (Fixes #4000)", state: "OPEN", url: "https://github.com/x/pull/4071", headRefName: "keir/task-a1aaaaaaaaaa-0", isDraft: false, statusCheckRollup: [{ conclusion: "SUCCESS" }], body: "", updatedAt: new Date(NOW).toISOString(), ...over });

test("hub state joins ledger, usage, PRs, tickets and kanban without network", async () => {
  const paths = fixture();
  const saved = JSON.parse(fs.readFileSync(paths.ledger, "utf8"));
  saved.watch = { mode: "active", findings: {}, succeeded: { turns: NOW - 1000 }, ran: { turns: NOW - 1000 } };
  fs.writeFileSync(paths.ledger, JSON.stringify(saved));
  fs.appendFileSync(paths.env, "KEIR_WATCH='report'\nSENTRY_API_TOKEN=credential-never-exposed\nSENTRY_ORG=game\n");
  require("./keir-hub-data")._cache.clear();
  const run = async (cmd, args) => args[0] === "pr" ? { stdout: JSON.stringify([pr({ headRefName: "keir/task-a1-0", title: "fix(metrics): ticket 1539 (Fixes #4000)" })]) } : { stdout: JSON.stringify({ number: 4000, title: "Metrics frozen", state: "open", html_url: "https://github.com/x/issues/4000" }) };
  const fetchImpl = async () => ({ text: async () => JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ items: [{ number: 1539, title: "Metrics not changing", status: "open", category: "bug" }, { number: 1538, title: "Scotus death", status: "open" }] }) }] } }) });
  const kanban = { list: () => [{ id: 254298, title: "Keir 4.0 phase 6", lane: "now", detail: "" }, { id: 9, title: "Ticket 1539 follow-up", lane: "next", detail: "" }, { id: 10, title: "Unrelated", lane: "now", detail: "" }] };
  const s = await buildHubState({ now: NOW, kanban, run, fetchImpl, paths, backgroundSources: false });
  assert.equal(s.kpis.live, 2, "probes are hidden"); assert.equal(s.kpis.running, 1); assert.equal(s.kpis.waiting, 1);
  assert.equal(s.kpis.decisionsPending, 1); assert.equal(s.kpis.activations24h, 2, "only the last 24 hours"); assert.equal(s.kpis.successRate24h, 0.5);
  assert.equal(s.kpis.rustActivations24h, 1);
  assert.deepEqual(s.lanes, ["probe", "quick", "worker"]); assert.equal(s.release.version, "3.5.2"); assert.equal(s.routing.worker, "muse:muse-wonder-full-1.0@medium");
  const w = s.workers.find((x) => x.id === "a1");
  assert.equal(w.via, "rust"); assert.equal(w.decisions.length, 1); assert.equal(w.tags.mood, "frustrated");
  const t = s.tickets.find((x) => x.number === 1539);
  assert.deepEqual(t.card.items.map((i) => i.stage), ["sandbox"]); assert.equal(t.active.via, "rust"); assert.equal(t.decisionPending, true); assert.deepEqual(t.prs, [4071]); assert.deepEqual(t.kanban, [9]);
  assert.deepEqual(s.kanban.map((k) => k.id).sort(), [254298, 9].sort(), "kanban items mentioning Keir or an open ticket");
  assert.equal(s.issues[0].number, 4000); assert.deepEqual(s.issues[0].from, [4071]);
  assert.equal(s.watch.available, true); assert.equal(s.watch.mode, "report");
  assert.equal(s.watch.sensors.find((sensor) => sensor.id === "turns").lastSuccessAt, NOW - 1000);
  assert.doesNotMatch(JSON.stringify(s.watch), /credential-never-exposed/);
  assert.equal(s.recent[0].id, "c3");
  assert.equal(s.shadow.agreement[0].agreed, 3);
});

test("activity buckets 24 hours by runner and CI state reads the rollup", () => {
  const b = activityByHour([{ atMs: NOW - 1000, provider: "muse-cli-subscription", durationMs: 10, outcome: "ok" }, { atMs: NOW - 2 * 3600000, provider: "antigravity-cli-subscription", outcome: "error" }], NOW);
  assert.equal(b.length, 24); assert.equal(b[22].muse, 1, "05:59:59 falls in the 05:00 bucket"); assert.equal(b[21].agy, 1); assert.equal(b[21].failed, 1);
  assert.equal(ciState(pr({})), "green"); assert.equal(ciState(pr({ statusCheckRollup: [{ conclusion: "FAILURE" }] })), "red");
  assert.equal(ciState(pr({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] })), "pending"); assert.equal(ciState(pr({ statusCheckRollup: [] })), "none");
});

test("routes: admins get the page and the JSON, others do not", async () => {
  const mk = () => { const r = { headers: {}, body: "", writeHead(s, h) { r.status = s; Object.assign(r.headers, h || {}); }, end(b) { r.body = b || ""; } }; return r; };
  const ctx = (role) => ({ resolveSession: async () => (role ? { role } : null), addSecurityHeaders() {}, renderShell: ({ title, body }) => `<title>${title}</title>${body}`, build: async () => ({ ok: true }) });
  let res = mk(); assert.equal(await handleKeirHubRoute({ method: "GET" }, res, "/elsewhere", ctx("admin")), false);
  res = mk(); await handleKeirHubRoute({ method: "GET" }, res, "/keir", ctx(null)); assert.equal(res.status, 302);
  res = mk(); await handleKeirHubRoute({ method: "GET" }, res, "/api/keir/hub", ctx(null)); assert.equal(res.status, 401);
  res = mk(); await handleKeirHubRoute({ method: "GET" }, res, "/keir", ctx("viewer")); assert.equal(res.status, 404);
  res = mk(); await handleKeirHubRoute({ method: "GET" }, res, "/keir", ctx("admin")); assert.equal(res.status, 200); assert.match(res.body, /Keir hub/); assert.match(res.body, /\/api\/keir\/hub/);
  res = mk(); await handleKeirHubRoute({ method: "GET" }, res, "/api/keir/hub", ctx("admin")); assert.equal(res.status, 200); assert.deepEqual(JSON.parse(res.body), { ok: true });
  res = mk(); await handleKeirHubRoute({ method: "POST" }, res, "/api/keir/hub", ctx("admin")); assert.equal(res.status, 405);
  const { body } = makeKeirHubBody(); assert.doesNotMatch(body, /[–—]/, "no dashes in page copy");
});

test("admin actions: merge needs same origin, numbers and a reason; probe and attempt reads route through", async () => {
  const mk = () => { const r = { headers: {}, body: "", writeHead(s, h) { r.status = s; Object.assign(r.headers, h || {}); }, end(b) { r.body = b || ""; } }; return r; };
  const calls = [];
  const actions = { PATHS: {}, mergeTicket: async (a) => { calls.push(["merge", a]); return { ok: true, steps: ["linked"] }; }, probeKeir: async () => ({ task: "abc123" }), readAttempt: (_f, id) => (id === "a-known1" ? { id } : null), probeState: (_f, t) => ({ state: "done", task: t }) };
  const ctx = { resolveSession: async () => ({ role: "admin", user: "egg" }), addSecurityHeaders() {}, renderShell: () => "", actions };
  const req = (method, body, headers = { "x-requested-with": "ops-dashboard", origin: "https://ops.example", host: "ops.example" }) => { const chunks = body ? [Buffer.from(JSON.stringify(body))] : []; return { method, headers, [Symbol.asyncIterator]: async function* () { yield* chunks; } }; };
  let res = mk(); await handleKeirHubRoute(req("POST", { source: 1540, target: 1539, reason: "same outage" }, { host: "ops.example", origin: "https://evil.example", "x-requested-with": "ops-dashboard" }), res, "/api/keir/hub/merge", ctx); assert.equal(res.status, 403);
  res = mk(); await handleKeirHubRoute(req("POST", { source: 1540, target: 1539 }), res, "/api/keir/hub/merge", ctx); assert.equal(res.status, 400, "reason required");
  res = mk(); await handleKeirHubRoute(req("POST", { source: "x", target: 1539, reason: "same" }), res, "/api/keir/hub/merge", ctx); assert.equal(res.status, 400);
  res = mk(); await handleKeirHubRoute(req("POST", { source: 1540, target: 1539, reason: "same outage" }), res, "/api/keir/hub/merge", ctx); assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ["merge", { source: 1540, target: 1539, reason: "same outage", by: "ops:egg" }]);
  res = mk(); await handleKeirHubRoute(req("POST", {}), res, "/api/keir/hub/probe", ctx); assert.equal(res.status, 202); assert.equal(JSON.parse(res.body).task, "abc123");
  res = mk(); await handleKeirHubRoute(req("GET"), res, "/api/keir/hub/probe/abc123", ctx); assert.equal(JSON.parse(res.body).state, "done");
  res = mk(); await handleKeirHubRoute(req("GET"), res, "/api/keir/hub/attempt/a-known1", ctx); assert.equal(res.status, 200);
  res = mk(); await handleKeirHubRoute(req("GET"), res, "/api/keir/hub/attempt/a-missing", ctx); assert.equal(res.status, 404);
  res = mk(); await handleKeirHubRoute(req("POST", {}), res, "/api/keir/hub/merge", { ...ctx, resolveSession: async () => ({ role: "viewer" }) }); assert.equal(res.status, 404, "non-admins never reach actions");
});

test("Jev analytics count the last seven days only", () => {
  const { jevAnalytics } = require("./keir-hub-data");
  const now = Date.parse("2026-10-14T06:00:00Z");
  const j = jevAnalytics([
    { kind: "intake_tagged", at: now - 1000, tags: { kind: "bug_report", mood: "frustrated", injection: true } },
    { kind: "intake_tagged", at: now - 8 * 86400000, tags: { kind: "banter" } },
    { kind: "post_screened", at: now - 5000, refused: true, labels: [{ label: "leaksInternals" }] },
  ], now);
  assert.equal(j.tagged, 1); assert.equal(j.injections, 1); assert.deepEqual(j.tags.kind, { bug_report: 1 });
  assert.equal(j.screened, 1); assert.equal(j.refused, 1); assert.deepEqual(j.labels, { leaksInternals: 1 });
});

test("performance proxy is admin-only, validates windows and never exposes the operator token", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-performance-proxy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, "env");
  fs.writeFileSync(envPath, "KEIR_OPERATOR_ADMIN_TOKEN=fixture-private-credential\nKEIR_OPERATOR_PORT=9765\n");
  let calls = 0;
  const actions = { ticketPerformance: ({ days }) => require("./keir-hub-data").ticketPerformance({ days, envPath,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, "http://127.0.0.1:9765/v5/performance?days=7");
      assert.equal(options.headers.Authorization, "Bearer fixture-private-credential");
      return { ok: true, json: async () => ({ resolved: { tickets: 2 } }) };
    } }) };
  const run = async (role, days = "7") => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await handleKeirHubRoute({ method: "GET", url: `/api/keir/hub/performance?days=${days}` }, res, "/api/keir/hub/performance", {
      resolveSession: async () => role ? { role } : null, addSecurityHeaders() {}, actions });
    return res;
  };
  assert.equal((await run(null)).status, 401); assert.equal((await run("viewer")).status, 404);
  assert.equal((await run("admin", "bad")).status, 400); assert.equal(calls, 0);
  const res = await run("admin"); assert.equal(res.status, 200); assert.equal(res.headers["Cache-Control"], "no-store");
  assert.doesNotMatch(res.body, /fixture-private-credential/);
  assert.deepEqual(JSON.parse(res.body), { resolved: { tickets: 2 } });
  const body = makeKeirHubBody().body;
  assert.match(body, /Ticket resolution performance/); assert.match(body, /Model turns/);
  for (const [, script] of body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(script);
});

test("Keir's audit trail is told in plain sentences and activations become timeline spans", () => {
  const { narrate, buildStream } = require("./keir-hub-data");
  const NOW = Date.parse("2026-10-14T06:00:00Z");
  const d = { jobs: {
    t1: { id: "t1", kind: "ticket", state: "waiting", ticket: 1514, at: new Date(NOW - 7200000).toISOString(), updatedAt: NOW - 60000, wakeAt: NOW + 600000, provider: { runner: "claude" } },
    p1: { id: "p1", kind: "probe", state: "done", internalProbe: true, updatedAt: NOW },
  }, decisions: { x1: { id: "x1", jobId: "t1" } }, audit: [
    { at: NOW - 3000, kind: "effect", job: "t1", key: "merge:4072:abc" },
    { at: NOW - 2000, kind: "decision_answered", decision: "x1", verdict: "approve" },
    { at: NOW - 1000, kind: "checkpoint", job: "t1" },
    { at: NOW - 500, kind: "created", job: "p1", source: "quick-probe:1" },
  ] };
  assert.deepEqual([narrate(d.audit[0], d).text, narrate(d.audit[0], d).cat], ["Merged PR #4072", "ship"]);
  assert.equal(narrate(d.audit[1], d).text, "You approved on ticket 1514");
  assert.equal(narrate(d.audit[2], d), null, "bookkeeping stays out");
  assert.equal(narrate(d.audit[3], d), null, "internal probes stay out");
  const usage = [{ atMs: NOW - 120000, job: "t1", ticket: 1514, provider: "claude-cli", durationMs: 60000, turns: 4, outcome: "ok", model: "claude-opus-5-5" }];
  const s = buildStream(d, usage, NOW);
  assert.equal(s.feed[0].text, "You approved on ticket 1514");
  assert.ok(s.feed.some((e) => e.cat === "run" && e.text === "Worked on ticket 1514 for 60s, 4 turns"));
  const lane = s.lanes.find((l) => l.id === "t1");
  assert.deepEqual(lane.spans[0], { from: NOW - 180000, to: NOW - 120000, runner: "claude", ok: true, model: "claude-opus-5-5" });
  assert.equal(lane.wakeAt, NOW + 600000);
  assert.ok(!s.lanes.some((l) => l.id === "p1"));
});
