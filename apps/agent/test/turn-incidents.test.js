"use strict";
// Keir 11.3: a failed turn opens its incident in code, at once. Built from the real record of 2026-11-21: turn 108 failed
// at 11:31, 11:34, 11:43 and 12:00 UTC (corporationTurn, mustStop) and recovered at 13:16 with 54 phases skipped; a person
// opened the incident at 13:04. Fixtures are trimmed copies of that record with no player or staff data.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { staticControls, createControls, SWITCHES } = require("../lib/operator/controls");
const ti = require("../lib/operator/turnincidents");
const { setup } = require("./keir10-post.helpers");

const DETAIL = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "turn-108-failure-detail.json"), "utf8"));
const INCIDENT_1871 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "incident-1871.json"), "utf8"));
const at = (hhmm) => Date.parse(`2026-11-21T${hhmm}:00.000Z`);
const RECOVERED = Date.parse(DETAIL.attempts.find((a) => a.success).realTime);
const COMMIT = DETAIL.attempts[0].buildCommit;
const STACK = DETAIL.attempts[1].failedPhaseDetails[0].message;

// The game and the support service as this morning, at the clock's time.
function makeWorld({ clock, lock = {}, overview = {}, incidents = [], failCreate = null, failList = null } = {}) {
  const w = { clock, calls: [], creates: [], updates: [], incidents: incidents.map((x) => ({ publicUpdates: [], ...x })), next: 1880, failCreate, failList, lock, overview };
  w.currentTurn = () => (w.clock() >= RECOVERED ? 108 : 107);
  w.mcp = { async call(server, tool, args, write) {
    w.calls.push({ server, tool, args, write });
    const t = w.clock();
    if (tool === "lock_status") return { verdict: "idle", currentTurn: w.currentTurn(), targetTurn: null, isProcessing: false, processingKind: null, overdueMin: 0, paused: false, pauseReason: null, runbook: null, ...w.lock };
    if (tool === "game_overview") return { turn: w.currentTurn(), iteration: { type: "Iteration", number: 3 }, paused: Boolean(w.lock.paused), pauseReason: w.lock.pauseReason ?? null, ...w.overview };
    if (tool === "turn_failure_detail") return { ...DETAIL, attempts: DETAIL.attempts.filter((a) => Date.parse(a.realTime) <= t) };
    if (tool === "engine_health") { const latest = DETAIL.attempts.filter((a) => Date.parse(a.realTime) <= t)[0]; return { lastTurn: latest ? { turn: 108, success: latest.success, failedPhases: latest.success ? [] : ["corporationTurn"] } : { turn: 107, success: true, failedPhases: [] } }; }
    if (tool === "support_list") { if (w.failList) throw w.failList(); return { items: w.incidents.filter((x) => !["resolved", "closed"].includes(x.status)).map(({ number, title, status, category, createdAt }) => ({ kind: "ticket", number, title, status, category, createdAt })) }; }
    if (tool === "support_get") { const x = w.incidents.find((i) => i.number === args.number); if (!x) throw new Error("not found"); return x; }
    if (tool === "support_search") return { results: w.incidents.filter((x) => x.title.includes(args.query)).map(({ number, title, category }) => ({ number, title, category })) };
    if (tool === "support_create_ticket") {
      assert.equal(write, true);
      if (w.failCreate) { const e = w.failCreate(); if (e) throw e; }
      const n = w.next++;
      w.creates.push({ ...args, number: n, at: t });
      w.incidents.push({ number: n, title: args.title, category: "incident", status: "open", description: args.description, createdAt: new Date(t).toISOString(), publicUpdates: [] });
      return { ok: true, ticketNumber: n, channelId: "900000000000000001" };
    }
    if (tool === "support_public_update") {
      const x = w.incidents.find((i) => i.number === args.number);
      x.publicUpdates.push({ message: args.message, at: new Date(t).toISOString() });
      w.updates.push({ number: args.number, message: args.message, at: t });
      return { ok: true };
    }
    throw new Error(`unexpected ${server} ${tool}`);
  } };
  return w;
}

function rig({ start = "11:32", controls = staticControls(), world = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-ti-")), ledgerFile = null, supportDeferred = () => false } = {}) {
  let t = at(start);
  const clock = () => t;
  const ledger = createLedger(ledgerFile || path.join(dir, "ledger.json"));
  const notes = [];
  const realNotify = ledger.notify.bind(ledger);
  ledger.notify = (key, dest, content) => { notes.push({ key, dest, content }); realNotify(key, dest, content); };
  const w = makeWorld({ clock, ...world });
  const pass = ti.createTurnIncidents({ ledger, mcp: w.mcp, controls, now: clock, config: { supportDeferred, taskLifetimeMs: 7 * 86400000 }, lockDir: path.join(dir, "locks") });
  return { ledger, d: ledger.data, w, pass, notes, dir, set: (hhmm) => { t = typeof hhmm === "number" ? hhmm : at(hhmm); }, sweep: (o) => pass.sweep(o) };
}
const holds = (d) => (d.turnIncidents?.holds || []).map((h) => `${h.code}: ${h.why}`).join("\n");

test("the switch exists, is on by default and is described", () => {
  assert.equal(SWITCHES.turnIncidents.on, true);
  assert.equal(SWITCHES.turnIncidents.env, "KEIR_TURN_INCIDENTS");
  assert.equal(staticControls().gate("turnIncidents").act, true);
});

test("11:31 opens exactly one incident on the first sweep; 11:34, 11:43 and 12:00 add to it and open nothing; 13:16 posts one recovery", async () => {
  const r = rig({ start: "11:32" });
  // The watch finding that saw it first, with its own task, so the incident links to it instead of repeating its work.
  const finding = r.ledger.createJob("finding:turn:108:failed:1", { kind: "finding", role: "support", finding: "turn:108:failed", source: { content: "Turn 108 failed" } });
  (r.d.watch ||= {}).findings = { "turn:108:failed": { fp: "turn:108:failed", sensor: "turns", state: "raised", jobId: finding.id, evidence: "{\"turn\":108,\"kind\":\"turn-failed\"}", firstSeen: at("11:32"), lastTurnSeen: 108 } };
  const out = await r.sweep();
  assert.equal(r.w.creates.length, 1, "one incident");
  const c = r.w.creates[0];
  assert.equal(c.category, "incident");
  assert.equal(c.discord_user_id, undefined, "the support service's own bot is the reporter; nobody is impersonated");
  assert.equal(c.title, "Turn 108 failed: the game is not advancing");
  assert.match(c.description, /^Turn 108 failed to finish at 11:31 UTC, in the step that runs companies' production and sales\./);
  assert.match(c.description, /not advancing until this is fixed/);
  assert.match(c.description, /Keir is on it/);
  assert.equal(out.incident, 1880);
  // The same words go to the channel as its first update.
  assert.equal(r.w.updates.length, 1);
  assert.equal(r.w.updates[0].message, c.description);
  // A normal ticket task with the normal authority, Keir's to own, linked to the finding.
  const job = r.d.jobs[r.d.seen["ticket:1880"]];
  assert.equal(job.kind, "ticket"); assert.equal(job.role, "support"); assert.equal(job.ticket, 1880);
  assert.equal(job.channelId, "900000000000000001"); assert.equal(job.keirIncident, true);
  assert.equal(job.linkedFinding, "turn:108:failed"); assert.equal(job.linkedFindingJob, finding.id);
  assert.match(job.source.content, /already investigating the cause/);
  assert.ok(r.d.keirIncidents[1880], "the channel scan treats it as Keir's incident, not staff's");
  assert.equal(r.d.channels["900000000000000001"].category, "incident");
  // The owner is told once.
  assert.equal(r.notes.filter((n) => /opened/.test(n.key)).length, 1);
  assert.match(r.notes[0].content, /Turn 108 failed at 11:31 UTC\. Keir opened incident #1880/);
  assert.ok(r.d.alerts.some((a) => /^error:watch-turn-incident:/.test(a.key)), "through the Watchkeeper incident alert path");

  for (const hhmm of ["11:35", "11:36", "11:44", "11:50", "12:01", "12:30", "13:05"]) { r.set(hhmm); await r.sweep(); }
  assert.equal(r.w.creates.length, 1, "repeats open nothing");
  assert.equal(r.w.updates.length, 1, "repeats of the same turn in the same step are folded, not posted");

  r.set(RECOVERED + 4 * 60000); await r.sweep();
  assert.equal(r.w.updates.length, 2, "one recovery update");
  const rec = r.w.updates[1].message;
  assert.match(rec, /^Turn 108 finished at 13:16 UTC and the game is advancing again\./);
  assert.match(rec, /stuck for 1 hour and 45 minutes/);
  assert.match(rec, /Turn 108 was tried 3 more times without success/);
  assert.match(rec, /follow-up on that is still in progress/, "the recovery skipped work, so it is not called resolved");
  assert.doesNotMatch(rec, /resolved|fixed/i);
  for (const hhmm of ["13:30", "13:45"]) { r.set(hhmm); await r.sweep(); }
  assert.equal(r.w.updates.length, 2, "recovery is said once");
  assert.equal(r.notes.filter((n) => n.dest === "owner").length, 1, "no owner alert per retry");
});

test("the title and messages carry no internal detail from the record", async () => {
  const r = rig({ start: "11:32" });
  await r.sweep();
  r.set("13:20"); await r.sweep();
  const words = [r.w.creates[0].title, r.w.creates[0].description, ...r.w.updates.map((u) => u.message)];
  assert.ok(STACK.includes("/app/src/lib/turn/corporation/index.ts"), "the fixture carries the stack trace");
  for (const text of words) {
    assert.ok(!text.includes(COMMIT) && !text.includes(COMMIT.slice(0, 7)), "no commit hash");
    assert.doesNotMatch(text, /\/app\/|\.ts\b|node:internal|processTicksAndRejections|withSpan|at async/, "no stack trace or file path");
    assert.doesNotMatch(text, /corporationTurn|mustStop|Funded producer|reconciled opening generation|turnSystem|Error\b/, "no phase ids, reasons or error text");
    assert.doesNotMatch(text, /[\u2013\u2014]/, "no dashes");
    assert.ok(ti.sentences(text).length <= ti.MAX_SENTENCES && text.length <= ti.MAX_CHARS, "the ticket post shape");
    assert.doesNotMatch(text, /\bwill be (?:fixed|back)\b|\bby \d|\bwithin\b|\bsoon\b/i, "no promise about when");
  }
});

test("an incident a person already opened is reused, and the owner is told once", async () => {
  const r = rig({ start: "13:05", world: { incidents: [INCIDENT_1871] } });
  const out = await r.sweep();
  assert.equal(r.w.creates.length, 0);
  assert.equal(out.incident, 1871);
  assert.equal(r.d.turnIncidents.current.number, 1871);
  assert.equal(r.d.turnIncidents.current.by, "existing");
  assert.equal(r.w.updates.length, 0, "the same turn needs no repeat in a person's incident");
  assert.match(holds(r.d), /already-open: incident #1871/);
  assert.match(r.notes[0].content, /Incident #1871 was already open/);
  assert.equal(r.d.seen["ticket:1871"], undefined, "a person's incident stays with staff; no new task is made for it");
  r.set("13:20"); await r.sweep();
  assert.equal(r.w.updates.length, 1); assert.match(r.w.updates[0].message, /advancing again/);
});

test("a different turn failing while the incident is open adds one update, with the folded repeats", async () => {
  const r = rig({ start: "11:32" });
  await r.sweep();
  r.set("12:01"); await r.sweep();
  // Turn 108 is still failing; then the record shows the next turn number failing (another sensor, another world view).
  const later = { ...DETAIL, turn: 108, attempts: DETAIL.attempts.filter((a) => !a.success) };
  const orig = r.w.mcp.call;
  r.w.mcp.call = async (s, tool, args, write) => tool === "turn_failure_detail" ? { ...later, turn: 108 } : orig(s, tool, args, write);
  r.w.lock.currentTurn = 108; // turn 108 got through by hand; 109 now fails
  r.w.mcp.call = async (s, tool, args, write) => tool === "turn_failure_detail" ? { turn: 109, attempts: [{ realTime: "2026-11-21T12:10:00.000Z", success: false, failedPhaseDetails: [{ phase: "bankingTurn", status: "failed", reason: "mustStop", message: STACK }] }] } : orig(s, tool, args, write);
  r.set("12:11"); await r.sweep();
  assert.equal(r.w.creates.length, 1, "no second incident");
  assert.equal(r.w.updates.length, 2);
  assert.match(r.w.updates[1].message, /^Turn 109 failed to finish at 12:10 UTC, in the banking step\./);
  assert.match(r.w.updates[1].message, /Turn 108 was tried 3 more times without success/);
  r.set("12:20"); await r.sweep();
  assert.equal(r.w.updates.length, 2, "the same turn again adds nothing");
});

test("the kill switch and Keir's pause each open nothing and record why", async () => {
  const k = rig({ start: "11:32", controls: staticControls({}, { held: "owner stop" }) });
  await k.sweep();
  assert.equal(k.w.creates.length, 0);
  assert.match(holds(k.d), /stopped: kill switch engaged \(owner stop\)/);
  const p = rig({ start: "11:32" });
  p.d.paused = true;
  const controls = createControls({ readFile: () => null, killSwitch: { state: () => ({ engaged: false }) }, data: p.d, env: {} });
  const pass = ti.createTurnIncidents({ ledger: p.ledger, mcp: p.w.mcp, controls, now: () => at("11:32"), lockDir: path.join(p.dir, "locks") });
  await pass.sweep();
  assert.equal(p.w.creates.length, 0);
  assert.match(holds(p.d), /stopped: Keir is paused/);
  const off = rig({ start: "11:32", controls: staticControls({ turnIncidents: "off" }) });
  await off.sweep();
  assert.equal(off.w.creates.length, 0); assert.match(holds(off.d), /turnIncidents is off/);
});

test("a deliberate game pause and a reset each open nothing and record why; an unexplained pause still opens", async () => {
  const paused = rig({ start: "11:32", world: { lock: { paused: true, pauseReason: "Paused by admin" } } });
  await paused.sweep();
  assert.equal(paused.w.creates.length, 0); assert.match(holds(paused.d), /paused: the game is paused on purpose \(Paused by admin\)/);
  const reset = rig({ start: "11:32", world: { lock: { isProcessing: true, processingKind: "economyReset", paused: true, pauseReason: "Economy reset" } } });
  await reset.sweep();
  assert.equal(reset.w.creates.length, 0); assert.match(holds(reset.d), /reset: a reset is running/);
  const resetPause = rig({ start: "11:32", world: { lock: { paused: true, pauseReason: "Economy reset complete; review before resuming turns" } } });
  await resetPause.sweep();
  assert.equal(resetPause.w.creates.length, 0); assert.match(holds(resetPause.d), /^reset:/m);
  const unexplained = rig({ start: "11:32", world: { lock: { paused: true, pauseReason: null } } });
  await unexplained.sweep();
  assert.equal(unexplained.w.creates.length, 1, "no reason is not a deliberate pause");
  // The engine's own auto-pause is a turn failure, not a decision.
  const auto = rig({ start: "12:01", world: { lock: { paused: true, pauseReason: "Auto-paused: no turn completed in 4h (cron may have stopped)" } } });
  await auto.sweep();
  assert.equal(auto.w.creates.length, 1);
  assert.equal(ti.pauseKind("Auto-paused: no turn completed in 4h (cron may have stopped)"), "failure");
  assert.equal(ti.pauseKind("Paused by admin"), "deliberate");
  assert.equal(ti.pauseKind(null), "unexplained");
});

test("support unreachable: a retry with backoff and one owner alert; the retry opens one incident", async () => {
  let down = true;
  const refused = () => Object.assign(new Error("fetch failed (ECONNREFUSED reaching the support MCP server)"), { code: "MCP_CONNECT_REFUSED" });
  const r = rig({ start: "11:32", world: { failCreate: () => (down ? refused() : null) } });
  await r.sweep();
  assert.equal(r.w.creates.length, 0);
  const rec = r.d.turnIncidents.records["w3:t108"];
  assert.equal(rec.state, "retry"); assert.ok(rec.nextAt > at("11:32"));
  assert.equal(r.notes.filter((n) => /blocked/.test(n.key)).length, 1);
  assert.match(r.notes[0].content, /could not open the incident yet/);
  const tries = () => r.w.calls.filter((c) => c.tool === "support_create_ticket").length;
  r.set(at("11:32") + 30000); await r.sweep();
  assert.equal(tries(), 1, "backoff holds the next try");
  r.set("11:34"); await r.sweep();
  assert.equal(tries(), 2); assert.equal(r.notes.filter((n) => /blocked/.test(n.key)).length, 1, "alerted once");
  down = false;
  r.set("11:40"); await r.sweep();
  assert.equal(r.w.creates.length, 1);
  r.set("11:45"); await r.sweep();
  assert.equal(r.w.creates.length, 1);
  assert.equal(r.notes.filter((n) => /opened/.test(n.key)).length, 1);
});

test("a failed read of open incidents is never taken as none open", async () => {
  let broken = true;
  const r = rig({ start: "11:32" });
  const orig = r.w.mcp.call;
  r.w.mcp.call = async (s, tool, a, w) => { if (tool === "support_list" && broken) throw new Error("timeout"); if (tool === "support_list" && broken === "empty") return { ok: true }; return orig(s, tool, a, w); };
  await r.sweep();
  broken = "empty"; r.set("11:33"); await r.sweep();
  assert.equal(r.w.creates.length, 0, "an error or a reply with no list opens nothing");
  r.set("11:38"); await r.sweep();
  assert.equal(r.notes.filter((n) => /blocked/.test(n.key)).length, 1, "the owner hears once that it cannot open");
  broken = false; r.set("11:39"); await r.sweep();
  assert.equal(r.w.creates.length, 1);
});

test("a crash after the intent is written but before the answer does not open a second", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-ti-crash-"));
  const file = path.join(dir, "ledger.json");
  // First life: the create reaches the service and creates the incident, but the process dies before it hears back.
  const a = rig({ start: "11:32", dir, ledgerFile: file });
  let snapshot = null;
  const orig = a.w.mcp.call;
  a.w.mcp.call = async (s, tool, args, w) => {
    if (tool === "support_create_ticket") { snapshot = fs.readFileSync(file, "utf8"); await orig(s, tool, args, w); throw Object.assign(new Error("process died"), { crash: true }); }
    return orig(s, tool, args, w);
  };
  await a.sweep();
  assert.ok(snapshot, "the intent was written to the ledger before the call");
  assert.equal(JSON.parse(snapshot).turnIncidents.records["w3:t108"].state, "opening");
  assert.ok(fs.readdirSync(path.join(dir, "locks")).length === 1, "and the lock file exists");
  // Second life: the ledger as it was at the crash, the same lock directory, the same service.
  fs.writeFileSync(file, snapshot);
  const b = rig({ start: "11:36", dir, ledgerFile: file });
  b.w.incidents = a.w.incidents; b.w.creates = a.w.creates; b.w.next = a.w.next;
  await b.sweep();
  await (b.set("11:40"), b.sweep());
  assert.equal(a.w.creates.length, 1, "exactly one incident");
  assert.equal(b.d.turnIncidents.current.number, 1880, "the created incident is found and adopted");
  assert.ok(b.d.seen["ticket:1880"] === undefined || b.d.jobs[b.d.seen["ticket:1880"]].kind === "ticket");
  assert.ok(b.d.keirIncidents[1880], "the channel scan will adopt it as Keir's");
  b.set("11:50"); await b.sweep();
  assert.equal(a.w.incidents.find((x) => x.number === 1880).publicUpdates.length, 1, "the opening line is posted once, after reading the ticket back");
});

test("an uncertain create that is not found waits for the settle time and two reads before trying again", async () => {
  let n = 0;
  const r = rig({ start: "11:32", world: { failCreate: () => (++n === 1 ? new Error("The operation was aborted due to timeout") : null) } });
  await r.sweep();
  assert.equal(r.d.turnIncidents.records["w3:t108"].state, "uncertain");
  r.set("11:33"); await r.sweep();
  r.set("11:35"); await r.sweep();
  assert.equal(n, 1, "not retried inside the settle time");
  r.set("11:43"); await r.sweep(); // verified absent: second empty read after the settle time
  r.set("11:44"); await r.sweep();
  assert.equal(n, 2); assert.equal(r.w.creates.length, 1);
});

test("a second process cannot start the same open while the first holds the lock", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-ti-two-"));
  const a = rig({ start: "11:32", dir, ledgerFile: path.join(dir, "a.json") });
  let release;
  const gate = new Promise((res) => { release = res; });
  const orig = a.w.mcp.call;
  a.w.mcp.call = async (s, tool, args, w) => { if (tool === "support_create_ticket") await gate; return orig(s, tool, args, w); };
  const first = a.sweep();
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  const b = rig({ start: "11:32", dir, ledgerFile: path.join(dir, "b.json") });
  b.w.incidents = a.w.incidents; b.w.creates = a.w.creates;
  await b.sweep();
  release(); await first;
  assert.equal(a.w.creates.length, 1);
  assert.equal(b.d.turnIncidents.records["w3:t108"].state, "uncertain", "the second process only reconciles");
});

test("preview opens nothing and records what it would open", async () => {
  const r = rig({ start: "11:32", controls: staticControls({}, { preview: true }) });
  await r.sweep();
  assert.equal(r.w.creates.length, 0); assert.equal(r.w.updates.length, 0);
  const row = r.d.preview.items["turn-incidents:open incident:w3:t108"];
  assert.ok(row); assert.match(row.reason, /Turn 108 failed: the game is not advancing\. Turn 108 failed to finish at 11:31 UTC/);
  assert.equal(r.notes.length, 0, "no owner alert in preview");
  assert.equal(Object.keys(r.d.jobs).length, 0);
});

test("a restart with the turn already failed opens one incident, with the engine's first failure time", async () => {
  const r = rig({ start: "12:30" });
  await r.sweep();
  assert.equal(r.w.creates.length, 1);
  assert.match(r.w.creates[0].description, /^Turn 108 failed to finish at 11:31 UTC/);
});

test("a failure three hours old that has recovered opens nothing", async () => {
  const r = rig({ start: "16:20" });
  await r.sweep();
  assert.equal(r.w.creates.length, 0); assert.equal(r.w.updates.length, 0);
  assert.equal(r.d.turnIncidents.lastRead.failing, null);
  const probe = rig({ start: "16:20" });
  assert.equal((await probe.pass.probe()).quiet, true, "the one-minute probe stays quiet on a healthy game");
});

test("processing-dead: a stale lock opens an incident with no failed attempt recorded", async () => {
  const r = rig({ start: "10:40", world: { lock: { verdict: "STUCK (heartbeat stale >5min)", isProcessing: true, processingKind: "turn", targetTurn: 108, processingPhase: "corporationTurn", heartbeatAgeSec: 420 } } });
  await r.sweep();
  assert.equal(r.w.creates.length, 1);
  assert.match(r.w.creates[0].description, /^Turn 108 stopped partway through, in the step that runs companies' production and sales, and has not finished\./);
  const late = rig({ start: "10:40", world: { lock: { verdict: "overdue (not processing, past schedule)", overdueMin: 15 } } });
  await late.sweep();
  assert.match(late.w.creates[0].description, /^Turn 108 was due by 10:25 UTC and has not started\./);
});

test("another coordinator owning support intake does not stop it, and is recorded", async () => {
  const r = rig({ start: "11:32", supportDeferred: () => true });
  await r.sweep();
  assert.equal(r.w.creates.length, 1);
  assert.ok(r.d.audit.some((x) => x.kind === "turn_incident_support_deferred"));
});

test("the one-minute probe looks further only when something is wrong", async () => {
  const r = rig({ start: "11:32" });
  const out = await r.pass.probe();
  assert.equal(r.w.creates.length, 1, `probe saw the failure: ${JSON.stringify(out)}`);
  const quiet = rig({ start: "11:00" });
  assert.equal((await quiet.pass.probe()).quiet, true);
  assert.equal(quiet.w.calls.filter((c) => c.tool === "turn_failure_detail").length, 0, "no heavy read on a quiet minute");
});

test("concurrent sweeps share one run", async () => {
  const r = rig({ start: "11:32" });
  await Promise.all([r.pass.check({ source: "watch" }), r.pass.check({ source: "watchkeeper" }), r.pass.probe()]);
  assert.equal(r.w.creates.length, 1);
});

test("a severe turn finding is not proposed to staff when its incident is already open", async () => {
  const { createWatch } = require("../lib/operator/watch");
  const proposals = [];
  const data = { jobs: {}, seen: {}, audit: [], watch: { findings: { "turn:108:failed": { fp: "turn:108:failed", sensor: "turns", severe: true, state: "raised", title: "Turn 108 failed", lastTurnSeen: 108, evidence: "{}" } } } };
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); } };
  const w = createWatch({ ledger, mcp: { call: async () => ({}) }, propose: async (p) => { proposals.push(p); return { messageId: "1" }; }, turnIncident: (turn) => (turn === 108 ? 1880 : null), config: { enabled: true } });
  await w.tick();
  assert.equal(proposals.length, 0);
  assert.equal(data.watch.findings["turn:108:failed"].incident, 1880);
});

test("the finding task is still refused open_ticket, channel_reply and the rest", async () => {
  const f = setup({});
  const finding = f.ledger.createJob("finding:turn:108:failed:x", { kind: "finding", role: "support", finding: "turn:108:failed", source: { role: "system", content: "Turn 108 failed", at: new Date().toISOString() } });
  finding.state = "running";
  for (const [name, input] of [["open_ticket", { category: "incident", title: "Turn 108", description: "down" }], ["channel_reply", { message: "Hello" }], ["progress_update", { message: "x" }],
    ["support_action", { tool: "support_public_update", args: { message: "x" } }], ["merge_into_incident", { incident: 1871, reason: "x" }], ["open_suggestion", {}]]) {
    await assert.rejects(f.broker.tool(finding, name, input), /finding tasks never post/, name);
  }
});

test("the preview report shows the switch, what the service recorded and what it would open", async () => {
  const { buildPreview, render } = require("../bin/keir-preview.js");
  const { resolve } = require("../lib/operator/controls");
  const r = rig({ start: "11:32", controls: staticControls({}, { preview: true }) });
  await r.sweep();
  const data = JSON.parse(JSON.stringify(r.d));
  const out = await buildPreview({ data, settings: resolve({}), api: async () => [], now: at("11:33"), env: {} });
  const text = render(out, { settings: resolve({}), killSwitch: "released", paused: false, github: false });
  assert.match(text, /turnIncidents\s+on\s+KEIR_TURN_INCIDENTS/);
  assert.match(text, /would open: w3:t108/);
  assert.match(text, /\[turn-incidents\] open incident w3:t108/);
  assert.match(text, /last read: .*turn 108 failing \(failed\)/);
});
