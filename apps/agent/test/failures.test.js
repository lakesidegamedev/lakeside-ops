"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const F = require("../lib/operator/failures");
const retention = require("../lib/operator/retention");
const sentry = require("../lib/operator/sentryout");

const mk = (opts = {}) => { let t = opts.t || 1_000_000_000_000; const clock = { now: () => t, set: (v) => { t = v; } }; const db = new DatabaseSync(":memory:"); return { db, clock, rec: F.createRecorder({ db, now: clock.now, release: "10.0.0", ...opts }) }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "keir-fail-"));

test("classification of real refusal texts", () => {
  const c = (error, tool) => F.classifyAudit("tool_refused", { job: "j1", error, tool });
  assert.deepEqual([c("Not finished: unfinished investigation is still yours").class, c("Not finished: unfinished investigation is still yours").kind], ["reasoning", "finish_refused_open_work"]);
  assert.equal(c('Not posted: "It is fixed" states an outcome Keir has no receipt for. Read it first.').kind, "claim_without_receipt");
  assert.equal(c("Not posted: this task posted in ticket 12 3 min ago").kind, "post_refused");
  assert.deepEqual([c("MCP error -32602: Input validation error: Invalid arguments").class, c("MCP error -32602: Input validation error: Invalid arguments").kind], ["tool", "schema_rejected"]);
  assert.equal(c("The operation was aborted due to timeout").kind, "timeout");
  assert.equal(c('{"content":[{"type":"text","text":"Not Authorized"}],"isError":true}').kind, "refused_authority");
  assert.equal(c("this ticket's channel no longer exists (the ticket was closed)").kind, "not_found");
  assert.equal(c("something odd").kind, "refused_other");
});

test("other audit kinds", () => {
  assert.equal(F.classifyAudit("raw_read", { collection: "gameState" }).kind, "raw_read_fallback");
  assert.equal(F.classifyAudit("tool_markup_leaked", {}).class, "reasoning");
  assert.equal(F.classifyAudit("cli_activation", { subtype: "error_max_turns" }).kind, "step_limit");
  assert.equal(F.classifyAudit("cli_activation", { subtype: "error_empty_result" }).kind, "empty_result");
  assert.equal(F.classifyAudit("cli_activation", { subtype: "auth_failed" }).class, "provider");
  assert.equal(F.classifyAudit("cli_activation", { subtype: "success" }), null);
  assert.equal(F.classifyAudit("wake_capped", { job: "a", runs: 5 }).class, "process");
  assert.equal(F.classifyAudit("feedback_logged", { kind: "slow_or_silent" }).class, "player");
  assert.equal(F.classifyAudit("feedback_logged", { kind: "wrong_or_misleading" }).class, "reasoning");
  assert.equal(F.classifyAudit("feedback_logged", { kind: "behaviour_request" }), null);
  assert.equal(F.classifyAudit("sweeper_action", { action: "nudge" }), null);
  assert.equal(F.classifyAudit("sweeper_action", { action: "escalate_owner", reason: "x" }).kind, "sweeper_escalation");
  assert.equal(F.classifyUsage({ outcome: "ok" }), null);
  assert.equal(F.classifyUsage({ outcome: "timeout" }).kind, "timeout");
  assert.equal(F.classifyUsage({ outcome: "interrupted" }).kind, "interrupted");
  assert.equal(F.isCorrectionPost("Correction: the figure was 5"), true);
});

test("fingerprints strip numbers, ids, tickets and quotes", () => {
  const a = F.fingerprint({ class: "reasoning", kind: "post_refused", tool: "channel_reply", detail: 'Not posted: ticket 1829 got "hello" 12 min ago' });
  const b = F.fingerprint({ class: "reasoning", kind: "post_refused", tool: "channel_reply", detail: 'Not posted: ticket 77 got "other words" 3 min ago' });
  const c = F.fingerprint({ class: "tool", kind: "post_refused", tool: "channel_reply", detail: 'Not posted: ticket 77 got "other words" 3 min ago' });
  assert.equal(a, b); assert.notEqual(a, c);
  assert.match(F.normalize("job 0123456789ab failed 1,234 times"), /job # failed # times/);
});

test("grouping, samples, tickets and idempotent sources", () => {
  const { rec, db } = mk();
  for (let i = 0; i < 7; i++) rec.fromAudit("tool_refused", { job: "j" + i, ticket: 100 + (i % 3), tool: "x_read", error: `The operation was aborted due to timeout ${i}` }, { src: `ev:${i}` });
  rec.fromAudit("tool_refused", { job: "j0", ticket: 100, tool: "x_read", error: "The operation was aborted due to timeout 0" }, { src: "ev:0" }); // replay
  const g = rec.groups({ limit: 5 });
  assert.equal(g.length, 1); assert.equal(g[0].count, 7); assert.equal(g[0].samples.length, 5); assert.deepEqual(g[0].tickets.sort(), [100, 101, 102]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM failures").get().n, 7);
});

test("guard deadlock and refusal loop are derived from sequences", () => {
  const { rec } = mk();
  rec.fromAudit("tool_refused", { job: "j", tool: "channel_reply", error: "Not posted: ticket 5 already got this update 2 min ago" }, { at: 1000 });
  rec.fromAudit("tool_refused", { job: "j", tool: "finish", error: "Not finished: your last answer to the player was refused and nothing has been posted since" }, { at: 20000 });
  const kinds = rec.groups({ limit: 10 }).map((g) => g.kind);
  assert.ok(kinds.includes("guard_deadlock")); assert.ok(!kinds.includes("finish_refused_open_work"));
  const other = mk();
  for (let i = 0; i < 3; i++) other.rec.fromAudit("tool_refused", { job: "k", tool: "t", error: `Input validation error at ${i}` }, { at: 1000 * i });
  assert.ok(other.rec.groups({ limit: 10 }).some((g) => g.kind === "refusal_loop"));
});

test("recording never throws and counts errors", () => {
  const { rec } = mk();
  assert.equal(rec.record(null), null);
  assert.equal(rec.record({ class: "bogus", kind: "x" }), null);
  const bad = F.createRecorder({ db: new DatabaseSync(":memory:") });
  bad.db.exec("DROP TABLE failures");
  assert.equal(bad.record({ class: "tool", kind: "timeout" }), null);
  assert.equal(bad.stats.errors, 1);
});

test("scan: NEW, SPIKE, crash and release regression, one card per fingerprint", async () => {
  const { rec, clock } = mk();
  const now = clock.now();
  for (let i = 0; i < 3; i++) rec.record({ class: "tool", kind: "timeout", tool: "a", detail: "slow" }, { at: now - 1000 * i });
  rec.exception(new Error("boom"));
  for (let i = 0; i < 12; i++) rec.record({ class: "reasoning", kind: "step_limit", detail: "activation error_max_turns" }, { at: now - 1000 * i });
  // old history so step_limit is not new, yet only 12 in a week: spike needs > 3x avg (1.7/day) and >= 10
  rec.db.prepare("UPDATE failure_groups SET first_seen = ? WHERE kind = 'step_limit'").run(now - 3 * 86400000);
  const types = rec.detect(now).map((a) => `${a.type}:${a.group?.kind}`);
  assert.ok(types.includes("NEW:timeout")); assert.ok(types.includes("NEW:crash")); assert.ok(types.includes("SPIKE:step_limit"));
  const cards = [];
  const file = async (c) => { cards.push(c); return 77; };
  const r1 = await rec.scan(now, { file });
  assert.ok(r1.filed.length >= 3);
  const n1 = cards.length;
  await rec.scan(now + 3600000, { file });
  assert.equal(cards.length, n1, "no refile inside 6 hours");
  await rec.scan(now + 7 * 3600000, { file });
  assert.ok(cards.some((c) => c.existingCardId === 77), "later alert updates the same card");

  const r = mk();
  const t = r.clock.now();
  const act = (rel, n, fails) => { for (let i = 0; i < n; i++) r.rec.fromUsage({ at: new Date(t - (rel === "1.0" ? 5 : 1) * 3600000 + i).toISOString(), job: "j" + i, attempt: `${rel}-${i}`, release: { version: rel }, outcome: i < fails ? "error_max_turns" : "ok" }, { at: t - (rel === "1.0" ? 5 : 1) * 3600000 + i }); };
  act("1.0", 100, 10); act("1.1", 100, 20);
  const reg = r.rec.detect(t).filter((a) => a.type === "REGRESSION");
  assert.equal(reg.length, 1); assert.equal(reg[0].cls, "reasoning");
  assert.equal(r.rec.releaseRates("1.1").per100.reasoning, 20);
  const small = mk(); small.rec.fromUsage({ at: new Date().toISOString(), attempt: "a", release: { version: "2" }, outcome: "ok" }, {});
  assert.equal(small.rec.detect().filter((a) => a.type === "REGRESSION").length, 0);
});

test("transcript path resolution", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "cli-attempts")); fs.writeFileSync(path.join(dir, "cli-attempts", "att-1.json"), "{}");
  assert.equal(F.transcriptPath("att-1", { stateDir: dir }), path.join(dir, "cli-attempts", "att-1.json"));
  fs.writeFileSync(path.join(dir, "claude-stream-att-1.jsonl"), "");
  assert.equal(F.transcriptPath("att-1", { stateDir: dir }), path.join(dir, "claude-stream-att-1.jsonl"));
  assert.equal(F.transcriptPath("missing", { stateDir: dir }), null);
  assert.equal(F.transcriptPath("../etc/passwd", { stateDir: dir }), null);
  assert.equal(F.transcriptPaths("att-1", { stateDir: dir }).length, 2);
  const h = path.join(dir, "harness"); fs.mkdirSync(h);
  const hdb = new DatabaseSync(path.join(h, "harness.db")); hdb.exec("CREATE TABLE attempt_events (id INTEGER PRIMARY KEY, attempt_id TEXT, seq INT, at INT, kind TEXT, payload TEXT); INSERT INTO attempt_events (attempt_id,seq,at,kind,payload) VALUES ('att-2',1,1,'tool_use','{}')"); hdb.close();
  assert.equal(F.transcriptPath("att-2", { stateDir: dir }), `${path.join(h, "harness.db")}#att-2`);
});

test("retention dry run and apply keep protected and recent", () => {
  const dir = tmp(), old = Date.now() - 20 * 86400000;
  fs.mkdirSync(path.join(dir, "cli-attempts"));
  const mkOld = (p, dirp = false) => { const f = path.join(dir, p); dirp ? fs.mkdirSync(f) : fs.writeFileSync(f, "x"); fs.utimesSync(f, old / 1000, old / 1000); return f; };
  const oldHome = mkOld("claude-home-aaa", true), oldStream = mkOld("claude-stream-att-9.jsonl"), keepStream = mkOld("claude-stream-att-keep.jsonl");
  fs.writeFileSync(path.join(dir, "claude-stream-new.jsonl"), "x"); fs.writeFileSync(path.join(dir, "ledger.json"), "{}");
  const protect = new Set(["att-keep"]);
  const dry = retention.run({ stateDir: dir, protect });
  assert.equal(dry.candidates, 2); assert.equal(dry.protectedCount, 1); assert.ok(fs.existsSync(oldHome));
  const res = retention.run({ stateDir: dir, protect, apply: true });
  assert.equal(res.removed, 2);
  assert.ok(!fs.existsSync(oldHome) && !fs.existsSync(oldStream)); assert.ok(fs.existsSync(keepStream)); assert.ok(fs.existsSync(path.join(dir, "ledger.json")));
  const ids = retention.protectedIds({ jobs: { a: { id: "a", state: "running", provider: { attempt: "att-x" } }, b: { id: "b", state: "done" } } });
  assert.ok(ids.has("a") && ids.has("att-x") && !ids.has("b"));
});

test("sentry envelope", async () => {
  assert.equal(sentry.createSentry({}), null);
  const p = sentry.parseDsn("https://abc@sentry.example.com/12");
  assert.equal(p.url, "https://sentry.example.com/api/12/envelope/");
  const sent = [];
  const s = sentry.createSentry({ dsn: "https://abc@sentry.example.com/12", release: "10.0.0", post: async (_, body) => sent.push(body) });
  await s.captureAlert({ type: "NEW", fingerprint: "fp1", group: { class: "tool", kind: "timeout" } }, { title: "t", detail: "d" });
  const ev = JSON.parse(sent[0].split("\n")[2]);
  assert.equal(ev.release, "10.0.0"); assert.deepEqual(ev.fingerprint, ["fp1"]); assert.equal(ev.tags.class, "tool");
});

test("backfill is idempotent and the CLI reads a temp db", () => {
  const dir = tmp(), file = path.join(dir, "events.db"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, task_id TEXT, attempt_id TEXT, ticket INTEGER, actor TEXT, release TEXT, payload TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO events (at, kind, attempt_id, ticket, release, payload) VALUES (?,?,?,?,?,?)");
  for (let i = 0; i < 4; i++) ins.run(Date.now() - i * 1000, "audit:tool_refused", "j" + i, 40 + i, "10.0.0", JSON.stringify({ job: "j" + i, tool: "t", error: `fetch failed ${i}` }));
  ins.run(Date.now(), "audit:created", "j9", null, "10.0.0", "{}");
  fs.writeFileSync(path.join(dir, "usage.jsonl"), JSON.stringify({ event: "activation", at: new Date().toISOString(), job: "j1", attempt: "a1", release: { version: "10.0.0" }, outcome: "timeout" }) + "\n");
  const rec = F.createRecorder({ db });
  const r1 = F.backfill({ recorder: rec, eventsDb: db, usageFile: path.join(dir, "usage.jsonl") });
  F.backfill({ recorder: rec, eventsDb: db, usageFile: path.join(dir, "usage.jsonl") });
  assert.equal(r1.events, 4);
  assert.equal(rec.groups({ limit: 10 }).reduce((a, g) => a + g.count, 0), 5);
  db.close();
  const bin = path.join(__dirname, "..", "bin", "keir-failures.js"), env = { ...process.env, KEIR_OPERATOR_STATE_DIR: dir };
  const out = execFileSync("node", [bin, "top", "--since", "1d", "--db", file, "--usage", path.join(dir, "usage.jsonl")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(out, /network/); assert.match(out, /timeout/);
  const fp = /(tool:network:\w+)/.exec(out)[1];
  const show = execFileSync("node", [bin, "show", fp, "--db", file, "--usage", path.join(dir, "usage.jsonl")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(show, /samples:/);
});

test("top failures feed the weekly builder plan", () => {
  const { rec } = mk();
  for (let i = 0; i < 4; i++) rec.record({ class: "tool", kind: "schema_rejected", tool: "x", detail: "bad args", ticket: i + 1 });
  rec.record({ class: "provider", kind: "quota", detail: "limit" });
  const top = rec.topFailures(5);
  assert.equal(top.length, 1); assert.equal(top[0].count, 4);
  const plan = require("../lib/operator/builderplan").planBuilder({ capabilityGaps: { "raw:x": { hits: 5, tasks: 3, title: "Gap", weighted: 5 } } }, { failures: top });
  assert.match(plan.prompt, /tool\/schema_rejected/);
});

test("a correction posted to a player is a reasoning failure", () => {
  const { classifyAudit } = require("../lib/operator/failures");
  const f = classifyAudit("correction_posted", { job: "j1", ticket: 9 });
  assert.equal(f.class, "reasoning");
  assert.equal(f.kind, "correction_posted");
});
