"use strict";
// Keir 8.5: Keir ships its own bug and display fixes while the owner is away.
//
// Owner, 2026-11-06: "Yes, bug/display fixes only". For a code bug classed bugfix or display,
// raise_to_developers no longer only files a card and waits: it dispatches a detached coding worker
// (a systemd unit running a headless Claude session in its own AHDGame worktree), then this module
// watches the run to the end. Rule, balance and economy-behaviour changes keep waiting for the owner.
//
// A run is a durable record on the ledger (d.codingWorkers.runs). Every step is a state transition
// that re-reads the world, so a restart resumes from the record and nothing is held in memory:
//
//   queued -> running -> checks -> merge_ready -> to_staging -> to_main -> verifying -> done
//   side exits: needs_owner (economy paths or a gated class), escalated (worker, CI or deploy trouble)
//
// Keir 8.5.1 adds a second run kind, "investigate": when Keir's own lookups leave a ticket's cause unverified
// (an open self-owned blocking question card, or a waiting task whose summary says so), a read-only
// investigation worker finds the cause. A report without a PR ends the run as "reported" and goes back to the
// ticket task; a bugfix or display PR joins the build flow above; rule and economy findings become owner options.
//
// Hard rules, all enforced here and tested:
//  - Kill switch: no launch, merge or promote while engaged. A running worker is left to finish.
//  - Merge and promote only on EXACT green: verify, dependency-review and custom-rules must each have a
//    completed run whose conclusion is "success". Anything else (pending, failed, missing) never merges.
//  - Promote freeze: no feature merge into development while a development -> staging PR is open.
//  - Feature PR squash, promotion PRs MERGE commit. Never a force push, never a bypass.
//  - Caps: two live workers, one run per ticket, admission by host memory and load, a daily launch cap,
//    and the existing daily production promotion cap.
//  - "Live" is told to the ticket only after both the web and the turn worker run the merged commit.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { GAME_REPO, GITHUB_OWNER } = require("./github");
const trustLimits = require("./limits");
const blast = require("./blastradius");
const cc = require("./changeclass");
const inv = require("./investigation");
const { markProgress } = require("./trustlog");

const REQUIRED = Object.freeze(["verify", "dependency-review", "custom-rules"]);
const SHIPPABLE = Object.freeze(["bugfix", "display"]);
const MAX_ACTIVE = 2;
const MIN_MEM_KB = 16 * 1024 * 1024;
const LOAD_FACTOR = 0.7;
const CHECKS_DEADLINE_MS = 3 * 3600000;
const HOP_DEADLINE_MS = 3 * 3600000;
const DEPLOY_DEADLINE_MS = 60 * 60000;
const WORKER_RUNTIME_SEC = 7200;
const MAX_STEP_ERRORS = 8;
const TERMINAL = inv.ENDED;
const SHA = /^[0-9a-f]{40}$/;
const REPO = GAME_REPO;
const WORKTREE_ROOT = "/root/projects/AHDGame/worktrees";

// ---- pure decisions -------------------------------------------------------------------------

// Which raised items may be built by a worker at all. Owner-gated classes never are.
function decideDispatch({ kind, changeClass, requiresOwner = false } = {}) {
  const cls = cc.normalizeClass(changeClass);
  if (kind !== "bug") return { ok: false, reason: "only a code bug is built by a worker" };
  if (requiresOwner || (cls && cc.requiresOwner(cls))) return { ok: false, reason: `${cls || "owner-gated"} changes wait for the owner` };
  if (!SHIPPABLE.includes(cls)) return { ok: false, reason: `class ${cls || "undeclared"} is not bugfix or display` };
  return { ok: true, changeClass: cls };
}

// Host admission: skip a launch when memory is short or the box is busy.
function admit({ memAvailableKb, load1, cpus }) {
  if (!Number.isFinite(memAvailableKb) || !Number.isFinite(load1) || !cpus) return { ok: false, reason: "host load unreadable" };
  if (memAvailableKb < MIN_MEM_KB) return { ok: false, reason: `only ${(memAvailableKb / 1048576).toFixed(1)} GiB of memory available (need 16)` };
  if (load1 > LOAD_FACTOR * cpus) return { ok: false, reason: `load ${load1.toFixed(1)} is above ${(LOAD_FACTOR * cpus).toFixed(1)}` };
  return { ok: true };
}
function readHost() {
  let memAvailableKb = NaN;
  try { memAvailableKb = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))?.[1]); } catch {}
  return { memAvailableKb, load1: os.loadavg()[0], cpus: os.cpus().length };
}

// The only definition of green. Each required check needs its newest run completed with conclusion success.
// A cancelled older run is ignored when a newer run of the same check exists (workflow concurrency).
function exactGreen(runs, required = REQUIRED) {
  const detail = {}, failed = [], pending = [];
  for (const name of required) {
    const latest = (runs || []).filter((r) => r.name === name).sort((a, b) => (b.id || 0) - (a.id || 0))[0];
    if (!latest) { detail[name] = "missing"; pending.push(name); }
    else if (latest.status !== "completed") { detail[name] = latest.status || "unknown"; pending.push(name); }
    else if (latest.conclusion === "success") detail[name] = "success";
    else { detail[name] = latest.conclusion || "unknown"; failed.push({ name, id: latest.id, conclusion: latest.conclusion, output: latest.output }); }
  }
  const verdict = failed.length ? "REQUIRED_FAILED" : pending.length ? "REQUIRED_PENDING" : "REQUIRED_GREEN";
  return { verdict, green: verdict === "REQUIRED_GREEN", detail, failed: failed.map((f) => f.name), failures: failed, pending };
}
// A waiter's output line is green only when it is exactly REQUIRED_GREEN. REQUIRED_FAILED, REQUIRED_PENDING
// and anything that merely contains the prefix are not.
const isGreenLine = (line) => String(line ?? "").trim() === "REQUIRED_GREEN";

const short = (id) => String(id).replace(/[^0-9a-z]/gi, "").slice(-6).toLowerCase();
const tail = (text, n) => String(text || "").slice(-n);

function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => execFile(cmd, args, { maxBuffer: 1 << 20, timeout: 60000, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: String(stdout || "").trim(), err: String(stderr || "").trim() })));
}

// ---- the brief a worker gets ----------------------------------------------------------------

const RULES = `You are a headless Sonnet worker on the production ops box, started by Keir (the A House Divided support operator). You do not talk to players.
- Run EVERY command in the FOREGROUND. Never background a command, never "wait to be re-invoked": -p mode has no re-invocation. Poll CI in the foreground with a hard cap of 40 minutes, then write your report.
- Work ONLY in your own git worktree (path below, created from origin/development). Never git checkout in /root/projects/AHDGame itself. Stage explicit files, never git add . or -A.
- AHDGame is PUBLIC: no secrets, player names, Discord ids, ticket numbers, internal hosts or paths, or ops references in code, commits, branch names or PR text. Conventional commits (commitlint enforced).
- The PR targets development. Add a versionless changelog note under the repo's unreleased changelog directory, following the existing files; its areas must each be one of engine, frontend, fullstack, backend. The PR body must carry a line "Change-class: <bugfix|display>" on its own line. Do not predict PR numbers.
- Do NOT merge, promote, deploy, restart services or touch systemd. Do NOT post to Discord or tickets. Prod data is READ-ONLY (gamestate and heal-ops read tools, no writes).
- Code lookup: /root/bin/mcpcall.sh ops-knowledge code_search or code_exact, then read the real files in your worktree; rg for completeness.
- Memory budget: shared production host. Run targeted tests (npx vitest run <files>) and a scoped tsc (npx tsc -p <tsconfig> --noEmit) once at the end. No full verify, no full test suite, no big heap.
- BEFORE every push: npx prettier --check on every changed file and --write any it flags. Also type-check changed test files; CI runs tsc over tests.
- Write tests that would have caught the bug. Never print secrets.
- No em dashes or en dashes anywhere you write.
- Wait for the required checks on your PR (verify, dependency-review, custom-rules), foreground, 40 minute cap. Do not merge.
- If the fix turns out to be a rule, balance or economy-behaviour change, or needs an owner decision, STOP: do not open a PR; write the options in the report.
- Your last step is to write the report file named below: root cause with file and line, what you changed, tests and results, the PR URL and the final state of the three required checks, prod evidence you read, a draft plain-language reply for the player (no jargon, no apology), and open risks stated honestly.`;

const INVESTIGATE_RULES = `You are a headless Sonnet worker on the production ops box, started by Keir (the A House Divided support operator). You do not talk to players. Keir looked at a player's report, could not verify the cause, and handed the investigation to you.
- Run EVERY command in the FOREGROUND. Never background a command, never "wait to be re-invoked": -p mode has no re-invocation. Poll CI in the foreground with a hard cap of 40 minutes, then write your report.
- Prod data is READ-ONLY: gamestate and heal-ops read tools only (heal_query, heal_count, trace_*), no heal_apply, no writes, no Discord, no tickets.
- Find the cause with evidence: trace the numbers turn by turn from prod, then find the code path (file and line on origin/development) that produces them. A cause without numbers is not verified. Code lookup: /root/bin/mcpcall.sh ops-knowledge code_search or code_exact, then read the real files; rg for completeness.
- Classify the finding as exactly one of: bug or display defect (class bugfix or display), economy behaviour or rule or balance (class economy-behaviour, rule, balance), or working as designed / player error.
- If it is a bugfix or display defect, fix it: work ONLY in your own git worktree (path below, created from origin/development), never git checkout in /root/projects/AHDGame itself, stage explicit files. AHDGame is PUBLIC: no secrets, player names, Discord ids, ticket numbers, internal hosts or paths, or ops references in code, commits, branch names or PR text. Conventional commits. The PR targets development, carries a versionless changelog note under the repo's unreleased changelog directory (areas one of engine, frontend, fullstack, backend) and a line "Change-class: <bugfix|display>" on its own line. Write a test that would have caught it. BEFORE every push run npx prettier --check on every changed file and type-check changed test files; run only targeted tests and a scoped tsc, no full verify. Wait for the required checks (verify, dependency-review, custom-rules), foreground, 40 minute cap. Do not merge, promote, deploy or touch systemd.
- If it is an economy behaviour, rule or balance matter, or needs an owner decision, do NOT open a PR: write two to four options in plain words in the report, with what each changes for players.
- No em dashes or en dashes anywhere you write. Never print secrets.
- Your last step is to write the report file named below. Its first line must be "VERDICT: <one sentence: the cause, with the key number>" and its second line "CLASS: <bugfix|display|economy-behaviour|rule|balance|as-designed|unknown>". Then: root cause with file and line, the prod numbers you read, what you changed (if anything), tests, the PR URL and final state of the three required checks, a draft plain-language reply for the player (no jargon, no apology), and open risks stated honestly. If you could not verify the cause, say exactly what you checked and what is still unknown.`;

function buildBrief(run, { retryNote = "", fixNote = "" } = {}) {
  const investigate = run.kind === "investigate";
  return [investigate ? INVESTIGATE_RULES : RULES, "",
    "---", `RUN ${run.id} (${run.mode === "fix" ? "CI fix attempt" : `attempt ${run.attempt}`}).${investigate ? (run.changeClass ? ` Change class: ${run.changeClass}.` : " Investigation.") : ` Change class: ${run.changeClass}.`}`,
    `Worktree: ${run.worktree}  (create with: git -C /root/projects/AHDGame worktree add ${run.worktree} -b ${run.branch} origin/development)`,
    run.mode === "fix" && run.pr ? `Existing PR #${run.pr} on branch ${run.branch}. Do NOT open a new PR: fix the failing checks on that branch and push to it. Reuse the worktree if it exists, otherwise add it from the branch.` : "",
    "", `${investigate ? "TO INVESTIGATE" : "PROBLEM"}: ${run.title}`, "", run.detail,
    run.issue ? `\nPublic issue: #${run.issue} (reference it in the PR as "Fixes #${run.issue}").` : "",
    retryNote ? `\nThe previous attempt ended without a PR. Tail of its log:\n${retryNote}` : "",
    fixNote ? `\nThe required checks failed. Failing job output:\n${fixNote}` : "",
    "", `Write your report to ${run.report} as the final step.`].filter((x) => x !== "").join("\n");
}

// ---- the module -----------------------------------------------------------------------------

function createCodingWorkers({
  ledger, api, write = api, mcp = null, killSwitch = null, limits = null, stateDir = "/var/lib/keir-operator",
  now = () => Date.now(), log = () => {}, host = readHost, exec = sh, probe = null,
  enabled = true, model = "claude-sonnet-5-5", effort = "high", claudeBin = "/root/.hermes/node/bin/claude",
  readFile = (f) => fs.readFileSync(f, "utf8"), mkdir = (p) => fs.mkdirSync(p, { recursive: true }),
} = {}) {
  const d = ledger.data;
  const store = () => (d.codingWorkers ||= { runs: {}, seq: 0 });
  const runs = () => Object.values(store().runs);
  const lim = () => (limits ? limits.get() : trustLimits.DEFAULTS);
  const dir = path.join(stateDir, "workers");
  const killed = () => (killSwitch ? killSwitch.state().engaged : false);
  const assertClear = (what) => { if (killSwitch) killSwitch.assertClear(what); };
  const audit = (kind, detail) => { try { ledger.audit(kind, detail); } catch {} };
  const jobOf = (run) => d.jobs[run.jobId];
  const note = (run, text) => { (run.history ||= []).push({ at: now(), text: String(text).slice(0, 300) }); run.history = run.history.slice(-30); };

  async function card(run, summary, event = "progress", extra = {}) {
    if (!mcp || !run.card) return;
    try { await mcp.call("ops-knowledge", "work_report", { id: run.card, event, actor: "keir", summary: String(summary).slice(0, 1500), idempotency_key: `cw:${run.id}:${event}:${tail(summary, 40).replace(/\W+/g, "")}`, ...extra }, true); }
    catch (e) { log(`coding-workers card ${run.card}: ${String(e.message).slice(0, 160)}`); }
  }
  function tellTicket(run, content, { alert = false } = {}) {
    const job = jobOf(run);
    if (!job) return;
    (job.inbox ||= []).push({ authorId: "coding-workers", role: "system", at: new Date(now()).toISOString(), content });
    if (["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
    if (alert) ledger.notify(`recovery:coding-worker:${run.id}:${run.state}`, "owner", content);
  }
  function escalate(run, why, state = "escalated") {
    run.state = state; run.endedAt = now(); run.reason = String(why).slice(0, 500);
    note(run, `${state}: ${why}`); audit("coding_worker_escalated", { run: run.id, state, why: String(why).slice(0, 200) });
    const text = state === "needs_owner"
      ? `Coding worker ${run.id} (ticket ${run.ticket}) produced PR #${run.pr}, which needs the owner before it can ship: ${why}. Nothing was merged.`
      : `Coding worker ${run.id} (ticket ${run.ticket}) needs a person: ${why}. Nothing further will be merged for it.`;
    tellTicket(run, `${text} Do not tell the player a fix is coming or live.`, { alert: true });
    return card(run, text, "progress");
  }

  // -- dispatch --
  function activeCount() { return runs().filter((r) => r.state === "running").length; }
  function runFor(ticket) { return runs().find((r) => String(r.ticket) === String(ticket) && !TERMINAL.has(r.state)); }
  const skipped = (ticket) => {
    try { if (readFile(path.join(dir, "skip-tickets")).split(/\s+/).includes(String(ticket))) return true; } catch {}
    return false;
  };

  // Register a run for a raised bug. Returns the run, or { skipped, reason }.
  async function dispatch({ job, cardId = null, title, detail, issue = null, changeClass, kind = "bug", requiresOwner = false }) {
    if (!enabled) return { skipped: true, reason: "coding workers are switched off" };
    const dec = decideDispatch({ kind, changeClass, requiresOwner });
    if (!dec.ok) return { skipped: true, reason: dec.reason };
    const ticket = job.ticket || null;
    if (!ticket) return { skipped: true, reason: "only a ticket's own task dispatches a worker" };
    if (skipped(ticket)) return { skipped: true, reason: "ticket is on the skip list" };
    const existing = runs().find((r) => String(r.ticket) === String(ticket) && r.card === cardId) || runFor(ticket);
    if (existing) return { skipped: true, reason: `ticket already has run ${existing.id}`, run: existing };
    const s = store(); s.seq += 1;
    const id = `cw-${ticket || "x"}-${s.seq}`, sid = short(`${now().toString(36)}${s.seq}`);
    const run = s.runs[id] = { id, ticket, jobId: job.id, card: cardId, changeClass: dec.changeClass, title: String(title).slice(0, 200), detail: String(detail || "").slice(0, 5000), issue,
      state: "queued", attempt: 1, mode: "build", short: sid, branch: `fix/keir-${sid}`, worktree: `${WORKTREE_ROOT}/keir-${sid}`,
      report: path.join(dir, `${id}.report.md`), log: path.join(dir, `${id}.log`), createdAt: now(), history: [], errors: 0 };
    note(run, "queued"); audit("coding_worker_queued", { run: id, ticket, card: cardId });
    ledger.save();
    await launchIfAble(run);
    ledger.save();
    return { skipped: false, run };
  }

  // Keir 8.5.1: hand an unverified cause to a read-only investigation worker. Skips are reported with
  // `permanent` when retrying cannot help (switched off, skip list, budget spent), so the sweeper escalates.
  function queueInvestigation({ job, reason = "" }) {
    if (!enabled) return { skipped: true, permanent: true, reason: "coding workers are switched off" };
    const ticket = job?.ticket || null;
    if (!ticket) return { skipped: true, permanent: true, reason: "only a ticket's own task dispatches a worker" };
    if (skipped(ticket)) return { skipped: true, permanent: true, reason: "ticket is on the skip list" };
    if (job.resolved || job.channelClosed || ["done", "dismissed", "cancelled", "deferred"].includes(job.state)) return { skipped: true, reason: "ticket is not open for work" };
    const jobs = Object.values(d.jobs).filter((j) => j.ticket === ticket);
    const cause = inv.causeUnverified(jobs);
    if (!cause) return { skipped: true, reason: "the cause is not marked unverified" };
    const active = inv.activeRun(d, ticket);
    if (active) return { skipped: true, active: true, reason: `ticket already has run ${active.id}`, run: active };
    if (inv.investigationsFor(d, ticket) >= inv.MAX_INVESTIGATIONS_PER_TICKET) return { skipped: true, permanent: true, reason: `${inv.MAX_INVESTIGATIONS_PER_TICKET} investigation workers already ran for this ticket` };
    const card = cause.card || null;
    const detail = card ? `${card.title}\n(Keir's own card ${card.id}; read it with ops-knowledge kanban_get for what he already checked.)` : cause.summary;
    const report = String(job.source?.content || "").slice(0, 1200);
    const full = [detail, report && `The player's report:\n${report}`, job.summary && `Keir's own last summary:\n${String(job.summary).slice(0, 1500)}`, reason && `Why this was started: ${reason}`].filter(Boolean).join("\n\n");
    const s = store(); s.seq += 1;
    const id = `cw-${ticket}-${s.seq}`, sid = short(`${now().toString(36)}${s.seq}`);
    const run = s.runs[id] = { id, kind: "investigate", ticket, jobId: job.id, card: card?.id || null, changeClass: null, title: String(card?.title || "Cause of the reported problem is unverified").slice(0, 200), detail: full.slice(0, 5000), issue: null,
      state: "queued", attempt: 1, mode: "build", short: sid, branch: `fix/keir-${sid}`, worktree: `${WORKTREE_ROOT}/keir-${sid}`,
      report: path.join(dir, `${id}.report.md`), log: path.join(dir, `${id}.log`), createdAt: now(), history: [], errors: 0 };
    note(run, `queued investigation (${cause.source})`); audit("coding_worker_queued", { run: id, ticket, card: run.card, kind: "investigate" });
    ledger.save();
    return { skipped: false, run };
  }
  // Queue and launch at once (Keir's own activation ended with the cause unverified). The sweeper only queues;
  // the 60 s worker ticker launches, subject to the same caps and admission.
  async function dispatchInvestigation(args) {
    const out = queueInvestigation(args);
    if (!out.skipped) { await launchIfAble(out.run); ledger.save(); }
    return out;
  }

  async function launchIfAble(run) {
    if (killed()) return false;
    if (activeCount() >= MAX_ACTIVE) { run.waiting = "two workers already running"; return false; }
    const a = admit(host());
    if (!a.ok) { run.waiting = a.reason; return false; }
    const key = `${run.id}:${run.attempt}:${run.mode}`;
    const cap = trustLimits.checkCounter(d, "worker", key, now(), lim());
    if (!cap.ok) { run.waiting = cap.reason; return false; }
    assertClear("Launching a coding worker");
    mkdir(dir);
    const unit = `keir-worker-${run.ticket || "x"}-${run.short}-${run.attempt}${run.mode === "fix" ? "f" : ""}`;
    const prompt = buildBrief(run, { retryNote: run.retryNote, fixNote: run.fixNote });
    const args = [`--unit=${unit}`, "--collect", "-p", "Environment=IS_SANDBOX=1", "-p", "Environment=HOME=/root", "-p", "Environment=PATH=/root/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin",
      "-p", "WorkingDirectory=/root", "-p", `RuntimeMaxSec=${WORKER_RUNTIME_SEC}`, "-p", "MemoryMax=8G",
      "/bin/bash", "-c", 'exec "$0" -p "$1" --model "$2" --effort "$4" --dangerously-skip-permissions > "$3" 2>&1', claudeBin, prompt, model, run.log, effort];
    const r = await exec("systemd-run", args);
    if (r.code !== 0) { run.waiting = `systemd-run failed: ${tail(r.err || r.out, 160)}`; run.errors = (run.errors || 0) + 1; return false; }
    trustLimits.recordCounter(d, "worker", key, now());
    Object.assign(run, { state: "running", unit, startedAt: now(), waiting: null, errors: 0 });
    delete run.retryNote; delete run.fixNote;
    note(run, `launched ${unit}`); audit("coding_worker_launched", { run: run.id, unit });
    await card(run, `Keir started coding worker ${run.id} (${run.mode === "fix" ? "CI fix" : `attempt ${run.attempt}`}, unit ${unit}). ${run.kind === "investigate" ? "It investigates the unverified cause read-only and reports back; if the cause is a bug it opens a bugfix or display PR." : `It builds a ${run.changeClass} fix in its own worktree and opens a PR`}; Keir merges only when the three required checks are green.`);
    return true;
  }

  // -- adoption of items raised before this release or while workers were off --
  async function adopt() {
    if (!enabled) return;
    for (const job of Object.values(d.jobs)) {
      if (["done", "dismissed", "cancelled"].includes(job.state) || job.resolved || job.channelClosed || !job.ticket) continue;
      for (const r of job.raisedToDevelopers || []) {
        if (r.releasedAt || r.kind !== "bug" || r.workerSeen) continue;
        const dec = decideDispatch({ kind: r.kind, changeClass: r.changeClass || job.changeClass, requiresOwner: r.requiresOwner });
        if (!dec.ok) continue;
        r.workerSeen = true;
        let detail = r.title;
        if (mcp && r.id) { try { const c = await mcp.call("ops-knowledge", "kanban_get", { id: r.id }, false); detail = String(c?.detail || c?.description || detail); } catch {} }
        const out = await dispatch({ job, cardId: r.id || null, title: r.title, detail, issue: r.issue || null, changeClass: dec.changeClass });
        if (!out.skipped) log(`coding-workers adopted ticket ${job.ticket} card ${r.id}`);
        ledger.save();
      }
    }
  }

  // -- steps --
  const unitActive = async (unit) => ["active", "activating", "reloading"].includes((await exec("systemctl", ["is-active", `${unit}.service`])).out);

  async function stepRunning(run) {
    if (await unitActive(run.unit)) return;
    let report = ""; try { report = readFile(run.report); } catch {}
    let pr = run.pr || null;
    if (!pr) {
      const found = await api([`repos/${REPO}/pulls?state=all&head=${GITHUB_OWNER}:${run.branch}&per_page=5`]).catch(() => []);
      pr = Array.isArray(found) && found[0] ? found[0].number : null;
      if (!pr) { const m = new RegExp(`github\\.com/${REPO}/pull/(\\d+)`).exec(report); pr = m ? Number(m[1]) : null; }
    }
    if (run.mode === "fix") { run.mode = "build"; run.checksSince = now(); run.state = "checks"; note(run, "fix worker exited"); return; }
    if (pr) { try { markProgress(d, run.ticket, now(), "worker PR opened"); } catch {} }
    if (pr && report) { Object.assign(run, { pr, state: "checks", checksSince: now() }); note(run, `worker exited, PR #${pr}`); card(run, `Coding worker ${run.id} opened PR #${pr}. Waiting for the required checks.`); return; }
    if (pr) { Object.assign(run, { pr, state: "checks", checksSince: now() }); note(run, `worker exited without a report, PR #${pr}`); return; }
    let logTail = ""; try { logTail = tail(readFile(run.log), 2500); } catch {}
    if (report && !pr && run.kind === "investigate") return finishInvestigation(run, report);
    if (report && !pr) return escalate(run, `the worker finished without a PR; its report is at ${run.report} (likely an owner decision or a rule question)`);
    if (run.attempt < 2) { run.attempt += 1; run.state = "queued"; run.retryNote = logTail || "(no log)"; note(run, "no PR and no report; one retry queued"); return; }
    return escalate(run, "the worker exited twice without a PR or a report");
  }

  // An investigation that ends with findings and no PR: hand the report back to the ticket task and count it as
  // real progress for the sweeper (a finding with a cause, or an exact statement of what is still unknown).
  function finishInvestigation(run, report) {
    run.state = "reported"; run.endedAt = now();
    const verdict = /^\s*VERDICT:\s*(.+)$/im.exec(report)?.[1] || "", klass = /^\s*CLASS:\s*([\w-]+)/im.exec(report)?.[1] || "unknown";
    run.verdict = verdict.slice(0, 300); run.findingClass = klass.toLowerCase();
    run.reportSummary = String(report).slice(0, 1500);
    try { markProgress(d, run.ticket, now(), "investigation report"); } catch {}
    note(run, `reported: ${klass}`); audit("coding_worker_reported", { run: run.id, class: klass });
    const owner = ["economy-behaviour", "rule", "balance"].includes(run.findingClass);
    tellTicket(run, `Investigation worker ${run.id} finished. Verdict: ${verdict || "(none stated)"} Class: ${klass}. Full report: ${run.report}\n${run.reportSummary}\n\nNow: tell the player the finding in plain words (the cause or exactly what was ruled out, never "still checking"), update or release your own card, ${owner ? "and put the options in the report to the owner as a decision (this is a rule or economy-behaviour matter, nothing ships on its own), " : ""}and do not claim a fix is live.`);
    return card(run, `Investigation worker ${run.id} reported (${klass}): ${verdict || "see report"}`);
  }

  async function prFiles(number) {
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const rows = await api([`repos/${REPO}/pulls/${number}/files?per_page=100&page=${page}`]);
      if (!Array.isArray(rows)) return null;
      files.push(...rows.flatMap((x) => [x.filename, ...(x.previous_filename ? [x.previous_filename] : [])]));
      if (rows.length < 100) return files;
    }
    return null;
  }

  // Everything a worker PR must pass before Keir merges it on its own authority.
  async function gate(run, pr) {
    const files = await prFiles(run.pr);
    const b = blast.classify(files);
    const c = cc.classifyChange({ declared: run.changeClass, body: pr.body, title: pr.title, blastClass: b.cls });
    if (c.gated) return `its class is ${c.cls} (${c.source})`;
    if (b.cls === "economy") return `it touches economy or turn-worker paths (${b.reasons.slice(0, 3).join(", ")})`;
    if (c.needsDeclaration) return "its change class is not declared";
    run.files = (files || []).slice(0, 60); run.worker = files.some((f) => blast.WORKER_PATHS.test(f));
    return null;
  }

  async function checkRuns(sha) { return ((await api([`repos/${REPO}/commits/${sha}/check-runs?per_page=100`])) || {}).check_runs || []; }

  async function stepChecks(run) {
    const pr = await api([`repos/${REPO}/pulls/${run.pr}`]);
    if (pr.merged) { run.mergeSha = pr.merge_commit_sha; run.state = "to_staging"; run.hopSince = now(); return; }
    if (pr.state === "closed") return escalate(run, `PR #${run.pr} was closed without merging`);
    if (pr.base?.ref !== "development") return escalate(run, `PR #${run.pr} targets ${pr.base?.ref}, not development`);
    if (run.kind === "investigate" && !run.changeClass) {
      const declared = cc.normalizeClass(/^\s*Change-class:\s*([\w-]+)/im.exec(pr.body || "")?.[1]);
      if (!SHIPPABLE.includes(declared)) return escalate(run, `the investigation PR is class ${declared || "undeclared"}, not bugfix or display`, "needs_owner");
      run.changeClass = declared;
    }
    if (!run.gated) { const why = await gate(run, pr); if (why) return escalate(run, why, "needs_owner"); run.gated = true; }
    const g = exactGreen(await checkRuns(pr.head.sha));
    run.checks = g.detail;
    if (g.verdict === "REQUIRED_FAILED") {
      if (run.fixTried) return escalate(run, `required checks failed again after a fix attempt (${g.failed.join(", ")})`);
      run.fixTried = true; run.mode = "fix"; run.state = "queued";
      run.fixNote = g.failures.map((f) => `${f.name} (${f.conclusion}): ${tail([f.output?.title, f.output?.summary, f.output?.text].filter(Boolean).join("\n"), 1500)}`).join("\n---\n");
      note(run, `checks failed: ${g.failed.join(", ")}; one fix attempt queued`); return;
    }
    if (g.verdict === "REQUIRED_PENDING") {
      if (now() - (run.checksSince || run.createdAt) > CHECKS_DEADLINE_MS) return escalate(run, `required checks still not green after 3 hours (${JSON.stringify(g.detail)})`);
      return;
    }
    run.greenSha = pr.head.sha; run.state = "merge_ready";
  }

  const frozen = async () => {
    const open = await api([`repos/${REPO}/pulls?state=open&base=staging&head=${GITHUB_OWNER}:development`]);
    return Array.isArray(open) && open.length > 0;
  };

  async function stepMergeReady(run) {
    assertClear("Merging a coding worker PR");
    const pr = await api([`repos/${REPO}/pulls/${run.pr}`]);
    if (pr.merged) { run.mergeSha = pr.merge_commit_sha; run.state = "to_staging"; run.hopSince = now(); return; }
    if (await frozen()) { if (!run.frozenLogged) { run.frozenLogged = true; note(run, "promote freeze: merge queued behind the open development to staging PR"); } return; }
    run.frozenLogged = false;
    // Re-read the checks on the head being merged; a new push after green restarts the gate.
    const g = exactGreen(await checkRuns(pr.head.sha));
    if (!g.green) { run.state = "checks"; return; }
    if (pr.mergeable === false) return escalate(run, `PR #${run.pr} has merge conflicts`);
    const res = await write(["-X", "PUT", `repos/${REPO}/pulls/${run.pr}/merge`, "-f", "merge_method=squash", "-f", `sha=${pr.head.sha}`]);
    run.mergeSha = res?.sha || null; run.state = "to_staging"; run.hopSince = now();
    note(run, `squash-merged PR #${run.pr}`); audit("coding_worker_merged", { run: run.id, pr: run.pr, sha: run.mergeSha });
    await card(run, `Keir merged PR #${run.pr} to development (required checks green). Promoting to staging, then main.`);
  }

  // One promotion hop (development -> staging, staging -> main). Returns "done" | "wait".
  async function hop(run, from, to) {
    const contains = async () => {
      const c = await api([`repos/${REPO}/compare/${to}...${run.mergeSha}`]).catch(() => null);
      return c && ["behind", "identical"].includes(c.status);
    };
    if (run.mergeSha && SHA.test(run.mergeSha) && await contains()) return "done";
    assertClear(`Promoting ${from} to ${to}`);
    const ahead = await api([`repos/${REPO}/compare/${to}...${from}`]);
    if (!ahead.ahead_by) return "done";
    let pr = ((await api([`repos/${REPO}/pulls?state=open&base=${to}&head=${GITHUB_OWNER}:${from}`])) || [])[0];
    if (!pr) {
      if (to === "main") {
        const key = `promote-main:${ahead.merge_base_commit?.sha || from}`, cap = trustLimits.checkCounter(d, "deploy", key, now(), lim());
        if (!cap.ok) { run.waiting = cap.reason; return "wait"; }
      }
      pr = await write(["-X", "POST", `repos/${REPO}/pulls`, "-f", `title=chore: promote ${from} to ${to}`, "-f", `head=${from}`, "-f", `base=${to}`, "-f", `body=Promotion of ${ahead.ahead_by} commits, including an automated bug fix.`]);
      note(run, `opened promote PR #${pr.number} ${from} to ${to}`);
    }
    run.hopPr = pr.number;
    const full = await api([`repos/${REPO}/pulls/${pr.number}`]);
    const g = exactGreen(await checkRuns(full.head.sha));
    if (g.verdict === "REQUIRED_FAILED") { await escalate(run, `promote PR #${pr.number} (${from} to ${to}) has failing required checks (${g.failed.join(", ")})`); return "wait"; }
    if (!g.green) {
      if (now() - (run.hopSince || run.createdAt) > HOP_DEADLINE_MS) await escalate(run, `promote PR #${pr.number} not green after 3 hours`);
      return "wait";
    }
    if (full.mergeable === false) { await escalate(run, `promote PR #${pr.number} has conflicts`); return "wait"; }
    if (to === "main") {
      const key = `promote-main:${ahead.merge_base_commit?.sha || from}`, cap = trustLimits.checkCounter(d, "deploy", key, now(), lim());
      if (!cap.ok) { run.waiting = cap.reason; return "wait"; }
      trustLimits.recordCounter(d, "deploy", key, now());
    }
    const res = await write(["-X", "PUT", `repos/${REPO}/pulls/${pr.number}/merge`, "-f", "merge_method=merge", "-f", `sha=${full.head.sha}`]);
    if (to === "main") run.mainSha = res?.sha || null;
    note(run, `merged promote PR #${pr.number} ${from} to ${to}`); audit("coding_worker_promoted", { run: run.id, to, pr: pr.number });
    return "done";
  }

  async function stepToStaging(run) {
    if (await hop(run, "development", "staging") === "done") { run.state = "to_main"; run.hopSince = now(); }
  }
  async function stepToMain(run) {
    if (await hop(run, "staging", "main") !== "done") return;
    if (!run.mainSha) { const m = await api([`repos/${REPO}/commits/main`]); run.mainSha = m?.sha || null; }
    run.state = "verifying"; run.verifySince = now();
    await card(run, `Keir promoted the fix to main (${tail(run.mainSha, 10)}). Verifying the web and turn worker deployments.`);
  }

  async function deployed(service) {
    if (!probe) return null;
    const sha = String(await probe(service) || "").trim();
    return SHA.test(sha) ? sha : null;
  }
  async function stepVerifying(run) {
    if (!run.mainSha) return escalate(run, "the main commit of the promotion is unknown");
    const out = {};
    for (const service of ["web", "worker"]) {
      const sha = await deployed(service);
      out[service] = sha;
      if (!sha) continue;
      if (sha === run.mainSha) continue;
      const c = await api([`repos/${REPO}/compare/${sha}...${run.mainSha}`]).catch(() => null);
      if (!c || !["behind", "identical"].includes(c.status)) out[service] = null;
    }
    run.deployed = out;
    if (!out.web || !out.worker) {
      if (now() - (run.verifySince || now()) > DEPLOY_DEADLINE_MS) return escalate(run, `main ${tail(run.mainSha, 10)} not running on ${[!out.web && "web", !out.worker && "the turn worker"].filter(Boolean).join(" and ")} after 60 minutes`);
      return;
    }
    const job = jobOf(run);
    if (job) {
      (job.releaseEvidence ||= {})[run.mergeSha ? run.mergeSha.slice(0, 10) : run.mainSha.slice(0, 10)] = { at: now(), development: true, staging: true, main: true, repository: "AHDGame", turnWorker: run.worker === true, source: "coding-workers" };
      (job.pullRequests ||= []).push(`https://github.com/${REPO}/pull/${run.pr}`);
    }
    run.state = "done"; run.endedAt = now(); note(run, "live");
    audit("coding_worker_live", { run: run.id, pr: run.pr, main: run.mainSha });
    tellTicket(run, `The fix for this ticket is live: PR #${run.pr} is merged and both the web and the turn worker run main ${tail(run.mainSha, 10)}. Verified by Keir's coding worker run ${run.id}. Tell the player briefly that it is live now. If the fix changes numbers, re-check them after the next turn and report what you find.`);
    await card(run, `Live: PR #${run.pr} deployed on web and the turn worker (${tail(run.mainSha, 10)}).`, "completed", { evidence_url: `https://github.com/${REPO}/pull/${run.pr}` });
  }

  const STEPS = { queued: launchStep, running: stepRunning, checks: stepChecks, merge_ready: stepMergeReady, to_staging: stepToStaging, to_main: stepToMain, verifying: stepVerifying };
  async function launchStep(run) { await launchIfAble(run); }

  async function tick() {
    if (!enabled) return;
    try { await adopt(); } catch (e) { log(`coding-workers adopt: ${String(e.message).slice(0, 160)}`); }
    for (const run of runs()) {
      const step = STEPS[run.state];
      if (!step) continue;
      try { await step(run); run.errors = 0; }
      catch (e) {
        if (e.code === "KILL_SWITCH") { run.waiting = "kill switch engaged"; continue; }
        run.errors = (run.errors || 0) + 1; log(`coding-workers ${run.id} ${run.state}: ${String(e.message).slice(0, 200)}`);
        if (run.errors >= MAX_STEP_ERRORS) await escalate(run, `repeated errors in ${run.state}: ${String(e.message).slice(0, 160)}`);
      }
      ledger.save();
    }
    ledger.save();
  }

  function status() { return runs().map((r) => ({ id: r.id, kind: r.kind || "build", ticket: r.ticket, state: r.state, pr: r.pr || null, unit: r.unit || null, waiting: r.waiting || null })); }
  return { dispatch, dispatchInvestigation, queueInvestigation, tick, adopt, status, runs, runFor };
}

module.exports = { createCodingWorkers, decideDispatch, admit, exactGreen, isGreenLine, buildBrief, REQUIRED, MAX_ACTIVE, MIN_MEM_KB };
