"use strict";
// Keir 11.3 (owner, 2026-11-21): "Bar extreme circumstances Keir should always be able to open turn failure incidents."
// Turn 108 first failed at 11:31 UTC; Keir's monitor saw it at once, but the incident that tells players the game is down
// was opened by a person at 13:04. A failed turn is a fact read from the engine, not a hunch, so this pass opens the
// incident in code, with no model, the moment a turn attempt is seen to fail.
//
// What counts as failed: the engine's newest attempt at the next turn is recorded as not successful (any failed phase,
// including a stop reason), or the turn is processing-dead (the lock is stale or the turn is overdue with no holder), or
// the game paused itself because turns stopped finishing.
//
// Only three things hold it back, each recorded with its reason (state.holds, the audit log):
//   1. a turn failure incident is already open (Keir's, a person's or another agent's): the failure is added to it;
//   2. the owner stopped Keir (kill switch or pause), or the switch is off;
//   3. the game is paused on purpose or a reset is running, so no turn is expected.
// Nothing else does: not quiet hours, the post budget, ask limits, another coordinator owning support intake (recorded),
// a missing model, a full queue or an existing finding.
//
// Exactly once: each failure is keyed on world and turn. Before the support call the intent is written to the ledger and
// to a lock file created with O_EXCL (so a second process cannot start the same open). A call that fails in a way that
// proves nothing was created is retried on later sweeps with backoff; any other failure is reconciled by reading the open
// incidents and searching for the exact title, and is never retried on an empty read before the settle time has passed
// and two reads have agreed. Every open incident is listed first; a read that fails or does not return a list means
// "unknown", never "none open".
//
// Updates are sparse: repeated attempts of the same turn in the same step are folded into the next meaningful update
// (another turn failing, a different step stopping it, the game pausing itself, or recovery). Recovery is one update with
// the time the game was down; a recovery that skipped work says follow-up is still in progress. Closing stays with the
// incident's own ticket task and the existing rules.
const nodeFs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { shapeTicketPost, playerLeak, MAX_CHARS, MAX_SENTENCES, sentences } = require("./playercopy");
const { preview } = require("./controls");

const SWITCH = "turnIncidents";
const MINUTE = 60000, HOUR = 60 * MINUTE;
const BACKOFF = [1, 2, 4, 8, 15].map((m) => m * MINUTE);
const SETTLE_MS = 10 * MINUTE;          // an uncertain create is not retried before this, nor before two empty reads
const CLOSED_CHECK_MS = 10 * MINUTE;    // how often an open incident's own status is re-read
const FOLD_MIN_MS = 30 * MINUTE;        // a same-turn change of step is posted at most this often
const RECOVERED_KEEP_MS = 6 * HOUR;     // a recovered incident still absorbs a new failure for this long, if open
const STATUS_BOUND_MS = 5 * MINUTE;
const MAX_UNRECORDED_CREATES = 3;      // creates that made a channel but no ticket record, before Keir stops and tells the owner     // an incident whose status cannot be read is not added to; past this, a new one opens
const OPEN = (s) => !["resolved", "closed", "merged", "rejected", "done"].includes(String(s || "").toLowerCase());

// --- reading the engine ------------------------------------------------------------------------------------------

const parse = (v) => {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  if (v && typeof v === "object" && typeof v.text === "string" && Object.keys(v).length === 1) return parse(v.text);
  return v ?? null;
};
const time = (v) => { const t = Date.parse(v?.$date || v || ""); return Number.isFinite(t) ? t : null; };
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// A pause whose reason names a person or planned work is deliberate. No reason, or a reason that is itself a turn
// failure (the engine's auto-pause after no turn finished), is not.
const FAILURE_PAUSE = /auto-?paused|no turn completed|fail|stuck|crash|error|did not finish|could not|cron/i;
const RESET = /\breset\b|migrat|new world|world (?:is being )?(?:rebuilt|created)/i;
function pauseKind(reason) {
  const r = String(reason || "").trim();
  if (!r) return "unexplained";
  if (FAILURE_PAUSE.test(r)) return "failure";
  if (RESET.test(r)) return "reset";
  return "deliberate";
}

function phaseOf(attempt) {
  const failed = (attempt?.failedPhaseDetails || []).find((p) => p && p.status === "failed") || (attempt?.failedPhaseDetails || []).find((p) => p && /fail|error|stuck|timed?out/i.test(p.status || ""));
  return { phase: failed?.phase || (attempt?.failedPhases || [])[0] || null, reason: failed?.reason || null };
}
// What the successful attempt's own record says about its work (release review M4): "skipped" only when the record
// shows skipped, deferred, failed or aborted work; "clean" only when it says clean and shows none; otherwise "unknown".
// Players are told work was skipped only on "skipped".
const SKIPPED = /\bskipp|\bdeferred\b|not reached|left (?:undone|unfinished)|partial/i;
function recoveryState(attempt) {
  if (!attempt) return "unknown";
  if ((attempt.failedPhases || []).length || (attempt.abortedPhases || []).length) return "skipped";
  if ((attempt.warnings || []).some((w) => SKIPPED.test(typeof w === "string" ? w : w?.detail || w?.message || ""))) return "skipped";
  return !attempt.outcome || attempt.outcome === "clean" ? "clean" : "unknown";
}
const cleanRecovery = (attempt) => recoveryState(attempt) === "clean";

// One answer from three reads, plus engine health when a turn read failed: what is failing now, what recovered, and
// what holds it back. Returns { readable, world, currentTurn, failing, recovered, hold, paused, pauseReason }.
function assess({ lock, overview, detail, health = null }, at) {
  if (!lock && !overview && !health) return { readable: false };
  const currentTurn = num(lock?.currentTurn) ?? num(overview?.turn) ?? num(health?.turn);
  const world = num(overview?.iteration?.number ?? overview?.iteration) ?? num(health?.iteration?.number ?? health?.iteration);
  const paused = Boolean(lock?.paused ?? overview?.paused ?? health?.paused);
  const pauseReason = lock?.pauseReason ?? overview?.pauseReason ?? health?.pauseReason ?? null;
  const out = { readable: true, world, currentTurn, paused, pauseReason, failing: null, recovered: null, hold: null };
  // A reset or other maintenance holds the lock under another kind; a reset also pauses with its own reason.
  const kind = String(lock?.processingKind || "");
  if (lock?.isProcessing && kind && kind !== "turn") out.hold = { code: "reset", why: `a ${kind === "economyReset" ? "reset" : `maintenance job (${kind})`} is running, so no turn is expected` };
  else if (paused && pauseKind(pauseReason) === "reset") out.hold = { code: "reset", why: `the game is paused for a reset (${String(pauseReason).slice(0, 80)})` };
  else if (paused && pauseKind(pauseReason) === "deliberate") out.hold = { code: "paused", why: `the game is paused on purpose (${String(pauseReason).slice(0, 80)})` };

  const turn = num(detail?.turn);
  const attempts = Array.isArray(detail?.attempts) ? detail.attempts.filter((a) => a && time(a.realTime)).sort((a, b) => time(b.realTime) - time(a.realTime)) : [];
  if (turn !== null && attempts.length) {
    const done = currentTurn !== null && turn <= currentTurn;
    if (attempts[0].success === false && !done) {
      if (currentTurn !== null && turn > currentTurn + 1) out.hold ||= { code: "reset", why: `turn ${turn} is ahead of the game's turn ${currentTurn}, so the record is from another world` };
      else {
        const run = [];
        for (const a of attempts) { if (a.success !== false) break; run.push(a); }
        const first = run[run.length - 1], last = run[0];
        out.failing = { turn, kind: "failed", firstFailedAt: time(first.realTime), lastFailedAt: time(last.realTime), attempts: run.length, ...phaseOf(last),
          attemptTimes: run.map((a) => time(a.realTime)).reverse() };
      }
    } else {
      const ok = attempts.find((a) => a.success === true);
      if (ok || done) out.recovered = { turn, at: ok ? time(ok.realTime) : null, state: recoveryState(ok) };
    }
  }
  // Release review M3: with the failure record unreadable, engine health's last turn log still shows a failed attempt
  // at the next turn. Its time is not known, so the first sighting stands in for it and is never printed as the time.
  const last = health?.lastTurn;
  if (!out.failing && !detail && last?.success === false && currentTurn !== null && num(last.turn) === currentTurn + 1) {
    const p = (last.failedPhases || [])[0];
    out.failing = { turn: num(last.turn), kind: "failed", firstFailedAt: at, lastFailedAt: at, attempts: 1, approxTime: true, phase: (typeof p === "string" ? p : p?.phase) || null, reason: (typeof p === "object" && p?.reason) || null };
  }
  if (!out.failing) {
    // Processing-dead: a stale lock, or overdue with nothing holding it. The engine's own verdict, read as text.
    const verdict = String(lock?.verdict || "");
    const target = num(lock?.targetTurn) ?? (currentTurn !== null ? currentTurn + 1 : null);
    if (/^STUCK/i.test(verdict) && target !== null) {
      const age = num(lock?.heartbeatAgeSec);
      out.failing = { turn: target, kind: "dead", firstFailedAt: age !== null ? at - age * 1000 : at, lastFailedAt: at, attempts: 1, phase: lock?.processingPhase || null, reason: "stale" };
    } else if (/^overdue/i.test(verdict) && target !== null) {
      const late = num(lock?.overdueMin);
      out.failing = { turn: target, kind: "overdue", firstFailedAt: late !== null ? at - late * MINUTE : at, lastFailedAt: at, attempts: 1, phase: null, reason: "overdue" };
    } else if (paused && pauseKind(pauseReason) === "failure" && target !== null) {
      out.failing = { turn: target, kind: "paused", firstFailedAt: at, lastFailedAt: at, attempts: 1, phase: null, reason: "auto-paused" };
    }
    // The success that follows a failure clears a recovered turn's dead signal too.
    if (out.failing && out.recovered && out.recovered.turn >= out.failing.turn) out.failing = null;
  }
  if (out.failing) out.failing.autoPaused = paused && pauseKind(pauseReason) === "failure";
  return out;
}

// --- player words ------------------------------------------------------------------------------------------------

const PLAIN_PHASES = {
  corporationTurn: "the step that runs companies' production and sales",
  bankingTurn: "the banking step", bondTurn: "the bond market step", forexTurn: "the currency exchange step",
  commodityPrices: "the commodity price step", economicModel: "the economy step", fiscalYear: "the government budget step",
  billLifecycle: "the step that moves bills through legislatures", elections: "the elections step", electionTurn: "the elections step",
};
// A step with no plain name is never shown as its internal name (release review m5), only in neutral words.
const UNNAMED_STEP = "one of the turn's steps";
function plainPhase(phase) {
  if (!phase) return null;
  return PLAIN_PHASES[phase] || UNNAMED_STEP;
}
// No time shown to anyone is UTC (owner rule). Player copy uses Discord's timestamp markup, which every reader sees in
// their own time zone (the same form as the waiting updates in broker.js); the owner gets US Eastern, labelled ET.
// A missing or invalid time is left out rather than printed wrong.
const validTime = (t) => typeof t === "number" && Number.isFinite(t) && t > 0;
const stamp = (t) => (validTime(t) ? `<t:${Math.floor(t / 1000)}:t>` : null);
const EASTERN = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const eastern = (t) => (validTime(t) ? `${EASTERN.format(new Date(t)).replace(/\s/g, " ")} ET` : "an unknown time");
const ownerWhen = (rec) => `${rec.approxTime ? "was first seen failing at" : "failed at"} ${eastern(rec.firstFailedAt)}`;
function duration(ms) {
  const m = Math.max(1, Math.round(ms / MINUTE)), h = Math.floor(m / 60), r = m % 60;
  const part = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return h ? (r ? `${part(h, "hour")} and ${part(r, "minute")}` : part(h, "hour")) : part(r, "minute");
}
// Every player line goes through the same shape and leak rules as Keir's other ticket posts, and never carries a dash.
function finish(text) {
  const t = shapeTicketPost(String(text).replace(/[\u2013\u2014]/g, ",").replace(/\s+/g, " ").trim());
  const leak = playerLeak(t);
  if (leak) throw new Error(`turn incident copy leaks ${leak.kind}`);
  return t;
}
function titleFor(f) { return `Turn ${f.turn} failed: the game is not advancing`; }
function whatHappened(f) {
  const step = plainPhase(f.phase);
  if (f.kind === "dead") return `Turn ${f.turn} stopped partway through${step ? `, in ${step},` : ""} and has not finished.`;
  if (f.kind === "overdue") return stamp(f.firstFailedAt) ? `Turn ${f.turn} was due by ${stamp(f.firstFailedAt)} and has not started.` : `Turn ${f.turn} is overdue and has not started.`;
  if (f.kind === "paused") return `No turn has finished recently, so the game has paused itself before turn ${f.turn}.`;
  if (f.approxTime || !stamp(f.firstFailedAt)) return `Turn ${f.turn} failed and has not finished${step ? `; it stopped in ${step}` : ""}.`;
  return `Turn ${f.turn} failed to finish at ${stamp(f.firstFailedAt)}${step ? `, in ${step}` : ""}.`;
}
function openingMessage(f) {
  return finish(`${whatHappened(f)} The game is not advancing until this is fixed, so no new turns will run for now. Keir is on it and will post here when there is news.`);
}
function foldedRepeats(n, turn) { return n > 0 ? ` Turn ${turn} was tried ${n === 1 ? "once more" : `${n} more times`} without success.` : ""; }
function newTurnMessage(f, folded) {
  return finish(`${whatHappened(f)}${folded ? foldedRepeats(folded.count, folded.turn) : ""} The game is still not advancing. Keir is on it.`);
}
function newStepMessage(f, folded) {
  const step = plainPhase(f.phase);
  return finish(`The latest attempt at turn ${f.turn} stopped in ${step || "a different step"}.${folded ? foldedRepeats(folded.count, folded.turn) : ""} The game is still not advancing.`);
}
function pausedMessage(f, folded) {
  return finish(`The game has now paused itself because no turn has finished since the failure.${folded ? foldedRepeats(folded.count, folded.turn) : ""} Keir is still on it.`);
}
const RECOVERY_END = { clean: "This incident stays open until the next turns run cleanly.", skipped: "Some of the turn's work was skipped on the way, so follow-up on that is still in progress.",
  unknown: "Keir is checking that the turn's work completed fully." };
function recoveryMessage({ turn, at, state, clean, downMs, folded }) {
  const how = state || (clean === true ? "clean" : clean === false ? "skipped" : "unknown");
  const when = stamp(at) ? `finished at ${stamp(at)}` : "has finished";
  return finish(`Turn ${turn} ${when} and the game is advancing again. It was stuck for ${stamp(at) ? "" : "about "}${duration(downMs)}.${folded ? foldedRepeats(folded.count, folded.turn) : ""} ${RECOVERY_END[how] || RECOVERY_END.unknown}`);
}

// An open incident is the turn failure incident only on strong evidence (release review M2): Keir opened it for a turn
// failure, or its title is in the established form, a turn as the subject of the failure ("Turn 108 failed", "Turns
// are not processing"). Either way it must also be recent, or name the very turn that is failing: an old incident left
// open for follow-up does not swallow a new outage. Any title that merely mentions a turn and a failure word does not.
const TURN_TITLE = /^\s*(?:turn\s+(\d+)|turns)\b[^.\n]{0,60}?\b(?:fail(?:s|ed|ing|ure)?|stuck|frozen|froze|not (?:advancing|running|processing|finishing)|stall(?:s|ed|ing)?|halt(?:s|ed)?|did not (?:finish|run|process))\b/i;
const ABSORB_MS = 24 * HOUR;
function isTurnIncident(t, { turn = null, at = Date.now(), keir = null } = {}) {
  const m = TURN_TITLE.exec(String(t?.title || ""));
  const keirTurn = keir && (keir.turnIncident || /^turn:\d+:/.test(keir.fingerprint || "")) ? Number(/t(\d+)$/.exec(keir.turnIncident || "")?.[1] ?? /^turn:(\d+):/.exec(keir.fingerprint || "")?.[1]) : null;
  if (!m && keirTurn === null) return false;
  if (turn !== null && (Number(m?.[1]) === turn || keirTurn === turn)) return true;
  const born = time(t?.createdAt) ?? (Number.isFinite(keir?.at) ? keir.at : null);
  return born !== null && at - born <= ABSORB_MS;
}

// --- the pass ----------------------------------------------------------------------------------------------------

function createTurnIncidents({ ledger, mcp, controls, config = {}, now = () => Date.now(), log = () => {}, fs = nodeFs, lockDir = null, onOpened = () => {} }) {
  const d = ledger.data;
  const st = () => {
    const s = (d.turnIncidents ||= {});
    s.records ||= {}; s.holds ||= []; s.notes ||= {};
    return s;
  };
  const token = randomBytes(6).toString("hex");
  let inflight = null;

  function hold(key, code, why, extra = {}) {
    const s = st(), t = now();
    const prior = s.holds.find((h) => h.key === key && h.code === code);
    if (prior) { prior.lastAt = t; prior.count = (prior.count || 1) + 1; prior.why = why; }
    else { s.holds.push({ key, code, why, at: t, lastAt: t, count: 1, ...extra }); ledger.audit("turn_incident_held", { key, code, why }); log(`turn incident ${key}: held, ${why}`); }
    s.holds = s.holds.slice(-30);
    s.lastHold = { key, code, why, at: t };
  }
  function note(key, kind, text) {
    // Owner alerts through the Watchkeeper incident path (alerts list and the app's incident push). Once per key.
    const s = st();
    if (s.notes[key]) return false;
    s.notes[key] = now();
    ledger.notify(`error:watch-turn-incident:${kind}:${key}`, "owner", text);
    return true;
  }

  // --- the support service, read strictly --------------------------------------------------------------------------
  async function listOpenIncidents() {
    const r = await mcp.call("support", "support_list", { kind: "ticket", category: "incident", openOnly: true, limit: 20 }, false);
    if (!r || !Array.isArray(r.items)) throw new Error("support_list returned no list");
    return r.items.filter((t) => t && t.category === "incident" && OPEN(t.status) && Number.isSafeInteger(Number(t.number)));
  }
  async function readTicket(number) {
    const t = await mcp.call("support", "support_get", { kind: "ticket", number }, false);
    if (!t || Number(t.number) !== Number(number)) throw new Error(`support_get ${number} returned no ticket`);
    return t;
  }
  // Posts a public update at most once: the exact text already on the ticket counts as posted.
  async function postOnce(cur, slot, message, act) {
    cur.posts ||= {};
    const p = cur.posts[slot];
    if (p?.state === "done") return true;
    if (!act) { preview(d, "turn-incidents", "post update", `incident ${cur.number} ${slot}`, message, {}, now()); return false; }
    if (p?.state === "started") {
      // A crash or error after the call left this unknown: read the ticket back before trying again.
      let t; try { t = await readTicket(cur.number); } catch { return false; }
      const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
      if ((t.publicUpdates || []).some((u) => norm(u?.message) === norm(p.message))) { cur.posts[slot] = { ...p, state: "done", at: now(), reconciled: true }; ledger.save(); return true; }
      if (now() - p.at < SETTLE_MS) return false;
    }
    cur.posts[slot] = { state: "started", at: now(), message }; ledger.save();
    try {
      await mcp.call("support", "support_public_update", { kind: "ticket", number: cur.number, update_kind: "progress", message, deliver: true }, true);
      cur.posts[slot] = { state: "done", at: now(), message }; cur.lastPostAt = now();
      ledger.audit("turn_incident_update", { incident: cur.number, slot }); ledger.save();
      return true;
    } catch (e) {
      if (definitelyNotSent(e)) delete cur.posts[slot];
      else cur.posts[slot].error = String(e.message).slice(0, 200);
      ledger.save(); log(`turn incident ${cur.number} update ${slot}: ${String(e.message).slice(0, 160)}`);
      return false;
    }
  }
  const definitelyNotSent = (e) => ["MCP_CONNECT_REFUSED", "MCP_ARGUMENT_REJECTED", "EXTERNAL_WRITE_REFUSED"].includes(e?.code) ||
    /no channel was created|kill switch|write scope required|not configured/i.test(String(e?.message || ""));

  // --- the lock file: an O_EXCL receipt written before the external call -------------------------------------------
  const lockFile = (key) => (lockDir ? path.join(lockDir, `${key.replace(/[^\w.-]/g, "_")}.json`) : null);
  function takeLock(key) {
    const f = lockFile(key);
    if (!f) return { ok: true };
    try { fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 }); } catch {}
    try {
      const fd = fs.openSync(f, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ key, token, pid: process.pid, at: now() })); } finally { fs.closeSync(fd); }
      return { ok: true };
    } catch (e) {
      if (e.code !== "EEXIST") return { ok: false, why: `lock file unusable (${e.code || e.message})` };
      let held = null; try { held = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      return held?.token === token ? { ok: true } : { ok: false, exists: true, held };
    }
  }
  function writeLock(key, extra) { const f = lockFile(key); if (!f) return; try { fs.writeFileSync(f, JSON.stringify({ key, token, pid: process.pid, at: now(), ...extra })); } catch {} }
  function dropLock(key) { const f = lockFile(key); if (!f) return; try { fs.unlinkSync(f); } catch {} }
  function sweepLocks() {
    if (!lockDir) return;
    let names = []; try { names = fs.readdirSync(lockDir); } catch { return; }
    for (const n of names) { const f = path.join(lockDir, n); try { if (now() - fs.statSync(f).mtimeMs > 7 * 24 * HOUR) fs.unlinkSync(f); } catch {} }
  }

  // --- adopting and opening ----------------------------------------------------------------------------------------
  function findingFor(turn) {
    const all = Object.values(d.watch?.findings || {});
    return all.find((f) => f.fp === `turn:${turn}:failed`) || all.filter((f) => f.sensor === "turns" && f.lastTurnSeen === turn && f.state !== "resolved").sort((a, b) => a.firstSeen - b.firstSeen)[0] || null;
  }
  function adopt(number, title, by, rec) {
    const s = st();
    s.current = { number, title: title || null, by, key: rec.key, turns: [rec.turn], at: now(), lastTurn: rec.turn, lastPhase: rec.phase || null, lastKind: rec.kind,
      // Attempts before the incident opened (a late open, a restart, an adopted incident) are counted, not lost (m1).
      folded: { turn: rec.turn, count: Math.max(0, (rec.attempts || 1) - 1) }, firstFailedAt: rec.firstFailedAt, checkedAt: now(), seenAttempts: { [rec.turn]: rec.attempts || 1 }, pausedPosted: Boolean(rec.autoPaused) };
    rec.state = "attached"; rec.incident = number; rec.attachedOpenAt = now();
    ledger.audit("turn_incident_adopted", { key: rec.key, incident: number, by });
    return s.current;
  }
  function startTicketJob(cur, rec, channelId, message) {
    const n = cur.number, finding = findingFor(rec.turn), findingJob = finding?.jobId ? d.jobs[finding.jobId] : null;
    (d.keirIncidents ||= {})[n] = { title: cur.title, summary: message, fingerprint: finding?.fp || `turn:${rec.turn}:failed`, turnIncident: rec.key, at: now() };
    if (!channelId) return null; // the channel scan adopts it from keirIncidents when it sees the channel
    d.channels[channelId] = { ...(d.channels[channelId] || {}), category: "incident" };
    const existing = d.jobs[d.seen[`ticket:${n}`]];
    if (existing) return existing;
    const content = [`Keir opened this incident in code the moment turn ${rec.turn} failed (first ${rec.approxTime ? "seen" : "failure"} ${stamp(rec.firstFailedAt)}, ${eastern(rec.firstFailedAt)}${rec.phase ? `, phase ${rec.phase}` : ""}${rec.reason ? `, reason ${rec.reason}` : ""}). Keir owns it.`,
      `Its first message is already posted: "${message}" Keir also posts, in code, one update when another turn fails or the step changes and one when the game advances again; do not repeat those.`,
      `Your work: investigate with turn_status and the latest turn failure, post only meaningful findings, merge player reports about the same problem into it, propose a repair for approval when there is one, and close it once turns run cleanly again (two clean turns).`,
      finding ? `The monitor's finding ${finding.fp}${findingJob ? ` (task ${findingJob.id}, ${findingJob.state})` : ""} is already investigating the cause; build on its evidence instead of repeating it. Evidence: ${String(finding.evidence || "").slice(0, 800)}` : null,
    ].filter(Boolean).join("\n\n");
    const job = ledger.createJob(`ticket:${n}`, { kind: "ticket", role: "support", ticket: n, channelId, replyChannel: channelId, keirIncident: true, turnIncident: rec.key,
      ...(finding ? { linkedFinding: finding.fp } : {}), ...(findingJob ? { linkedFindingJob: findingJob.id } : {}),
      source: { channelId, content, at: new Date(now()).toISOString() }, deadline: now() + (config.taskLifetimeMs || 7 * 24 * HOUR) });
    job.summary = "Keir-opened turn failure incident: own it until turns run cleanly.";
    if (finding) { finding.incident = n; }
    return job;
  }

  async function open(rec, act) {
    const title = titleFor(rec), message = openingMessage(rec);
    if (!act) {
      preview(d, "turn-incidents", "open incident", rec.key, `${title}. ${message}`, {}, now());
      rec.previewedAt = now(); rec.state = "previewed";
      return null;
    }
    if (rec.nextAt && now() < rec.nextAt) return null;
    const lock = takeLock(rec.key);
    if (!lock.ok) {
      if (lock.exists && rec.state !== "uncertain") { rec.state = "uncertain"; rec.intentAt ||= lock.held?.at || now(); rec.lockHeldBy = lock.held?.pid || null; ledger.audit("turn_incident_lock_held", { key: rec.key, by: lock.held?.pid || null }); }
      if (!lock.exists) { rec.lastError = lock.why; hold(rec.key, "lock", lock.why); }
      return null;
    }
    rec.state = "opening"; rec.intentAt = now(); rec.title = title; rec.tries = (rec.tries || 0) + 1;
    if (config.supportDeferred?.()) { rec.supportDeferred = true; ledger.audit("turn_incident_support_deferred", { key: rec.key, note: "another coordinator owns support intake; opening anyway" }); }
    ledger.save();
    let r;
    try {
      r = await mcp.call("support", "support_create_ticket", { category: "incident", title, description: message }, true);
    } catch (e) {
      const error = String(e.message).slice(0, 240);
      rec.lastError = error;
      if (definitelyNotSent(e)) {
        rec.state = "retry"; rec.nextAt = now() + BACKOFF[Math.min(BACKOFF.length - 1, (rec.tries || 1) - 1)]; dropLock(rec.key);
        ledger.audit("turn_incident_open_failed", { key: rec.key, error, retryAt: rec.nextAt });
      } else {
        rec.state = "uncertain"; rec.emptyReads = 0;
        // The support service made the Discord channel but could not record the ticket (release review M5): counted,
        // and the channel name kept for the owner, so repeated tries are bounded.
        const orphan = /channel\s+#?([\w-]+)\s+created but/i.exec(String(e.message));
        if (orphan) { rec.unrecordedCreates = (rec.unrecordedCreates || 0) + 1; rec.orphans = [...new Set([...(rec.orphans || []), orphan[1]])].slice(-10); }
        ledger.audit("turn_incident_open_uncertain", { key: rec.key, error });
      }
      note(rec.key, "blocked", `Turn ${rec.turn} ${ownerWhen(rec)} but Keir could not open the incident yet (${error.slice(0, 160)}). It keeps trying while the turn is failed.`);
      ledger.save();
      return null;
    }
    const number = Number(r?.ticketNumber || r?.number || r?.ticket?.number);
    if (!Number.isSafeInteger(number) || number <= 0) {
      rec.state = "uncertain"; rec.emptyReads = 0; rec.lastError = "the support service answered without a ticket number";
      note(rec.key, "blocked", `Turn ${rec.turn} failed. Keir asked the support service for an incident but got no ticket number back; it is checking whether one was created.`);
      ledger.save(); return null;
    }
    return opened(rec, number, r.channelId || r.channel?.id || null, title, message, "keir");
  }
  async function opened(rec, number, channelId, title, message, how) {
    const cur = adopt(number, title, "keir", rec);
    cur.channelId = channelId; cur.posts = {}; cur.opened = true; cur.openingMessage = message;
    // Found rather than heard back: another process (or this one before a crash) may already have posted the opening
    // line, so it is read back from the ticket before it is posted.
    if (how === "reconciled") cur.posts.opening = { state: "started", at: now() - SETTLE_MS, message };
    writeLock(rec.key, { incident: number });
    const job = startTicketJob(cur, rec, channelId, message);
    if (job) cur.jobId = job.id;
    ledger.audit("turn_incident_opened", { key: rec.key, incident: number, turn: rec.turn, how, job: job?.id || null, supportDeferred: Boolean(rec.supportDeferred) });
    log(`turn incident opened: #${number} for turn ${rec.turn} (${how})`);
    note(`incident:${number}`, "opened", `Turn ${rec.turn} ${ownerWhen(rec)}. Keir opened incident #${number} and is on it.${rec.orphans?.length ? ` Earlier tries left ${rec.orphans.map((c) => `#${c}`).join(", ")} with no ticket record; those channels can be removed.` : ""}`);
    try { require("./incidents").resetIncidentCache(); } catch {}
    onOpened(cur);
    ledger.save();
    // The description is the ticket's record; the same words go to the incident channel as its first update.
    await postOnce(cur, "opening", message, true);
    return cur;
  }
  // An uncertain create: found means adopt; absent counts only after the settle time and two successful empty reads.
  async function reconcile(rec, list) {
    const hit = list.find((t) => t.title === rec.title) || null;
    if (hit) return opened(rec, Number(hit.number), null, hit.title, openingMessage(rec), "reconciled");
    let searched = null;
    try {
      const s = await mcp.call("support", "support_search", { query: rec.title, kind: "ticket", limit: 10 }, false);
      const rows = s?.results || s?.items || s?.tickets;
      if (Array.isArray(rows)) searched = rows.find((t) => t?.title === rec.title && (t.category === undefined || t.category === "incident")) || false;
    } catch {}
    if (searched) return opened(rec, Number(searched.number ?? searched.ticketNumber), null, searched.title, openingMessage(rec), "reconciled");
    if (searched === null) return null; // the search failed: proves nothing
    rec.emptyReads = (rec.emptyReads || 0) + 1;
    if (now() - (rec.intentAt || 0) >= SETTLE_MS && rec.emptyReads >= 2) {
      dropLock(rec.key);
      ledger.audit("turn_incident_verified_absent", { key: rec.key, reads: rec.emptyReads });
      if ((rec.unrecordedCreates || 0) >= MAX_UNRECORDED_CREATES) {
        rec.state = "create-unrecorded";
        hold(rec.key, "create-unrecorded", `${rec.unrecordedCreates} tries made a channel but no incident record; not trying again`);
        note(`${rec.key}:unrecorded`, "blocked", `Turn ${rec.turn} is failing and Keir could not open its incident: ${rec.unrecordedCreates} tries each made a Discord channel (${(rec.orphans || []).map((c) => `#${c}`).join(", ")}) but the ticket was never recorded. Keir has stopped trying; please open the incident by hand and remove those channels.`);
      } else { rec.state = "retry"; rec.nextAt = 0; }
    }
    return null;
  }

  // --- updates on the incident -------------------------------------------------------------------------------------
  async function addFailure(cur, f, act) {
    if (cur.recovered) { delete cur.recovered; cur.recoveryPosted = false; cur.folded = { turn: f.turn, count: 0 }; }
    const repeat = (f.attempts || 1) - (cur.seenAttempts?.[f.turn] || 0);
    const firstSight = !cur.turns.includes(f.turn);
    (cur.seenAttempts ||= {})[f.turn] = Math.max(cur.seenAttempts[f.turn] || 0, f.attempts || 1);
    if (firstSight) {
      const folded = cur.folded?.count ? { ...cur.folded } : null;
      cur.turns.push(f.turn); cur.lastTurn = f.turn; cur.lastPhase = f.phase; cur.lastKind = f.kind;
      if (cur.turns.length === 1) return; // the incident's own opening already said it
      if (await postOnce(cur, `turn:${f.turn}`, newTurnMessage(f, folded), act)) cur.folded = { turn: f.turn, count: 0 };
      return;
    }
    if ((f.kind === "paused" || f.autoPaused) && !cur.pausedPosted) {
      cur.pausedPosted = true; cur.lastKind = f.kind;
      if (await postOnce(cur, `paused:${f.turn}`, pausedMessage(f, cur.folded?.count ? cur.folded : null), act)) cur.folded = { turn: f.turn, count: 0 };
      return;
    }
    if (f.phase && cur.lastPhase && plainPhase(f.phase) !== plainPhase(cur.lastPhase) && now() - (cur.lastPostAt || 0) >= FOLD_MIN_MS) {
      cur.lastPhase = f.phase;
      if (await postOnce(cur, `step:${f.turn}:${f.phase}`, newStepMessage(f, cur.folded?.count ? cur.folded : null), act)) cur.folded = { turn: f.turn, count: 0 };
      return;
    }
    // A repeat of the same failure: counted, said in the next meaningful update.
    if (repeat > 0 && f.kind === "failed") { cur.folded = cur.folded?.turn === f.turn ? { turn: f.turn, count: cur.folded.count + repeat } : { turn: f.turn, count: repeat }; }
  }
  async function recover(cur, rec, r, act) {
    if (cur.recoveryPosted) return;
    const at = r.at || now();
    const message = recoveryMessage({ turn: r.turn, at: r.at || null, state: r.state, downMs: at - (cur.firstFailedAt || rec?.firstFailedAt || at), folded: cur.folded?.count ? cur.folded : null });
    if (await postOnce(cur, `recovered:${r.turn}`, message, act)) {
      cur.recoveryPosted = true; cur.recovered = { turn: r.turn, at, state: r.state, postedAt: now() }; cur.folded = { turn: r.turn, count: 0 };
      if (rec) { rec.state = "recovered"; rec.recoveredAt = at; }
      ledger.audit("turn_incident_recovered", { incident: cur.number, turn: r.turn, state: r.state, downMinutes: Math.round((at - (cur.firstFailedAt || at)) / MINUTE) });
    }
  }
  // Reads the incident's own status now: "open", "closed" (it is then no longer the one to add to) or "unknown".
  // A failed read of the ticket falls back to the open incident list, which can prove open but never closed.
  async function readStatus(cur) {
    let t; try { t = await readTicket(cur.number); } catch { t = null; }
    if (!t) {
      try { if ((await listOpenIncidents()).some((x) => Number(x.number) === Number(cur.number))) { cur.checkedAt = now(); return "open"; } } catch {}
      return "unknown";
    }
    cur.checkedAt = now();
    if (OPEN(t.status) && t.category === "incident" && !t.mergedInto) return "open";
    const s = st();
    s.past = [...(s.past || []), { ...cur, closedAt: now(), status: t.status, mergedInto: t.mergedInto || null }].slice(-20);
    if (s.current === cur) delete s.current;
    ledger.audit("turn_incident_closed_seen", { incident: cur.number, status: t.status });
    return "closed";
  }
  // Re-reads the incident's own status every so often; a closed incident is no longer the one to add to.
  async function stillOpen(cur) {
    if (now() - (cur.checkedAt || 0) < CLOSED_CHECK_MS) return true;
    return (await readStatus(cur)) !== "closed";
  }

  // --- one sweep ---------------------------------------------------------------------------------------------------
  async function sweep({ source = "sweep" } = {}) {
    const s = st(), at = now();
    s.lastSweep = { at, source };
    const gate = controls.gate(SWITCH);
    const reads = await Promise.allSettled([mcp.call("turndiag", "lock_status", {}, false), mcp.call("gamestate", "game_overview", {}, false),
      mcp.call("turndiag", "turn_failure_detail", { attempts: 8 }, false)]);
    const [lock, overview, detail] = reads.map((r) => (r.status === "fulfilled" ? parse(r.value) : null));
    // A turn read that failed is never "nothing wrong" (release review M3): engine health is read as well.
    const health = !lock || !detail ? parse(await mcp.call("engine", "engine_health", {}, false).catch(() => null)) : null;
    const a = assess({ lock, overview, detail, health }, at);
    s.lastRead = { at, readable: a.readable, failing: a.failing ? { turn: a.failing.turn, kind: a.failing.kind } : null, recovered: a.recovered ? { turn: a.recovered.turn } : null, hold: a.hold?.code || null, detailRead: Boolean(detail), ...(health ? { healthRead: true } : {}) };
    // Neither the failure record nor engine health answered: Keir cannot see a failed turn. The owner is told once
    // after five minutes, and told again when the reads are back.
    if (!detail && !health) {
      s.blindSince ||= at;
      if (at - s.blindSince >= 5 * MINUTE) note("turn-health", "blind", `Keir cannot read turn health: neither the turn failure record nor engine health has answered for ${duration(at - s.blindSince)}, so it cannot see whether a turn has failed. It keeps trying.`);
    } else if (s.blindSince) {
      delete s.blindSince;
      if (s.notes["turn-health"]) {
        delete s.notes["turn-health"];
        d.alerts = (d.alerts || []).filter((x) => x.key !== "error:watch-turn-incident:blind:turn-health");
        ledger.notify("error:watch-turn-incident:sighted:turn-health", "owner", "Keir can read turn health again.");
      }
    }
    if (!a.readable) { s.lastRead.why = "neither the turn lock nor the game overview could be read"; ledger.save(); return { unreadable: true }; }

    // Stopped (kill switch, pause) or switched off: nothing is written or posted. Reads still run so the hold is recorded
    // against the failure it held back, and only when a turn is actually failing.
    if (!gate.run) {
      if (a.failing) hold(`w${a.world ?? "unknown"}:t${a.failing.turn}`, /kill switch|paused/.test(gate.why || "") ? "stopped" : "off", gate.why || "off");
      ledger.save(); return { held: gate.why };
    }
    let cur = s.current && (await stillOpen(s.current)) ? s.current : null;
    // An opening update that did not go out (a crash, the service down) is retried before anything else is said.
    if (cur?.opened && cur.openingMessage && cur.posts?.opening?.state !== "done") await postOnce(cur, "opening", cur.openingMessage, gate.act);
    const f = a.failing;
    if (f) {
      const key = `w${a.world ?? "unknown"}:t${f.turn}`;
      if (a.hold) { hold(key, a.hold.code, a.hold.why); ledger.save(); return { held: a.hold.why, key }; }
      const rec = (s.records[key] ||= { key, world: a.world, turn: f.turn, firstFailedAt: f.firstFailedAt, firstSeenAt: at, state: "new" });
      rec.firstFailedAt = Math.min(rec.firstFailedAt || f.firstFailedAt, f.firstFailedAt); rec.phase ||= f.phase;
      rec.approxTime = !(rec.exactTime ||= !f.approxTime); rec.reason ||= f.reason; rec.kind ||= f.kind; rec.lastSeenAt = at; rec.attempts = f.attempts; rec.autoPaused = f.autoPaused;
      if (rec.state === "closed-while-failing") { ledger.save(); return { held: "closed by a person while failing", key }; }
      // A failure not yet on the current incident is added to it only after its status is read fresh (B1): an incident
      // closed minutes ago must never absorb, or hold back, a new failure. Unknown is neither open nor closed: it is read
      // again on the next sweeps, and past a short bound the failure gets its own incident and the owner is told.
      let notThis = null;
      if (cur && !(rec.state === "attached" && rec.incident === cur.number)) {
        const status = await readStatus(cur);
        if (status === "closed") cur = null;
        else if (status === "unknown") {
          rec.statusUnreadSince ||= at;
          if (at - rec.statusUnreadSince < STATUS_BOUND_MS) {
            hold(key, "status-unknown", `could not read whether incident #${cur.number} is still open; reading again before adding turn ${f.turn} to it`);
            ledger.save(); return { key, unreadable: "status" };
          }
          note(`${key}:status`, "blocked", `Turn ${f.turn} is failing and Keir could not read for ${duration(at - rec.statusUnreadSince)} whether incident #${cur.number} is still open, so it is opening a new incident for this turn instead.`);
          notThis = cur.number; cur = null;
        } else delete rec.statusUnreadSince;
      }
      if (cur) {
        if (rec.state !== "attached" || rec.incident !== cur.number) { rec.state = "attached"; rec.incident = cur.number; rec.attachedOpenAt = now(); ledger.audit("turn_incident_added", { key, incident: cur.number }); hold(key, "already-open", `incident #${cur.number} is already open for turn failures; added to it`); }
        if (cur.recovered || !cur.firstFailedAt) cur.firstFailedAt = f.firstFailedAt;
        await addFailure(cur, f, gate.act);
        ledger.save(); return { key, incident: cur.number };
      }
      // A record attached to an incident while that incident was open, which has since closed while the turn is still
      // failing: a person closed or merged it. It is not reopened, and the owner is told once.
      if (rec.incident && rec.attachedOpenAt && ["attached", "recovered"].includes(rec.state)) {
        rec.state = "closed-while-failing";
        const past = (st().past || []).filter((p) => p.number === rec.incident).pop();
        hold(key, "closed", `incident #${rec.incident} was closed while turn ${f.turn} is still failing; not reopened`);
        note(`${key}:closed`, "held", `Turn ${f.turn} is still failing but its incident #${rec.incident} was ${past?.mergedInto ? `merged into #${past.mergedInto}` : "closed"}. Keir has not reopened it; open one again if players still need it.`);
        ledger.save(); return { key };
      }
      let list;
      try { list = await listOpenIncidents(); }
      catch (e) {
        rec.lastError = `open incidents could not be read: ${String(e.message).slice(0, 160)}`;
        rec.unreadSince ||= at;
        if (at - rec.unreadSince >= 5 * MINUTE || (rec.tries || 0) > 0) note(rec.key, "blocked", `Turn ${f.turn} ${ownerWhen(rec)} but Keir cannot read the support service to open the incident (${rec.lastError.slice(0, 120)}). It keeps trying while the turn is failed.`);
        ledger.save(); return { key, unreadable: "support" };
      }
      delete rec.unreadSince;
      // "opening" seen by a sweep means the process stopped between writing the intent and hearing back (each sweep
      // awaits its own open): what happened is unknown, so it is reconciled, never simply repeated.
      if (rec.state === "opening") { rec.state = "uncertain"; rec.emptyReads = 0; ledger.audit("turn_incident_open_interrupted", { key, intentAt: rec.intentAt || null }); }
      if (rec.state === "uncertain") { const c = await reconcile(rec, list); ledger.save(); return { key, incident: c?.number || null, uncertain: !c }; }
      const existing = list.find((t) => Number(t.number) !== notThis && isTurnIncident(t, { turn: f.turn, at, keir: d.keirIncidents?.[t.number] }));
      if (existing) {
        if (!gate.act) { preview(d, "turn-incidents", "add to incident", `${key} -> #${existing.number}`, `incident #${existing.number} "${existing.title}" is already open`, {}, now()); ledger.save(); return { key, incident: Number(existing.number), preview: true }; }
        const c = adopt(Number(existing.number), existing.title, "existing", rec);
        hold(key, "already-open", `incident #${existing.number} ("${String(existing.title).slice(0, 80)}") is already open; added to it`);
        note(`incident:${existing.number}`, "opened", `Turn ${f.turn} ${ownerWhen(rec)}. Incident #${existing.number} was already open; Keir is adding to it.`);
        // Said only when the open incident is about another turn; the same turn needs no repeat.
        if (!new RegExp(`\\bturn\\s+${f.turn}\\b`, "i").test(existing.title || "")) await postOnce(c, `turn:${f.turn}`, newTurnMessage(f, null), true);
        ledger.save(); return { key, incident: c.number, adopted: true };
      }
      if (rec.state === "create-unrecorded") { ledger.save(); return { key, held: "create-unrecorded" }; }
      const c = await open(rec, gate.act);
      ledger.save();
      return { key, incident: c?.number || null, preview: !gate.act || undefined };
    }
    // Nothing failing now. An open incident whose last turn ran gets its one recovery update.
    if (cur && !cur.recoveryPosted) {
      let r = a.recovered && a.recovered.turn >= (cur.lastTurn || 0) ? a.recovered : null;
      if (!r && a.currentTurn !== null && a.currentTurn >= (cur.lastTurn || Infinity)) {
        // The latest failure record is another turn's (a stuck or overdue turn logs no failed attempt): the recovered
        // turn's own record says when it finished and whether work was skipped. Unreadable means unknown, never skipped.
        const own = parse(await mcp.call("turndiag", "turn_failure_detail", { turn: cur.lastTurn, attempts: 8 }, false).catch(() => null));
        const ok = num(own?.turn) === cur.lastTurn ? (own.attempts || []).filter((x) => x && x.success === true && time(x.realTime)).sort((x, y) => time(y.realTime) - time(x.realTime))[0] : null;
        r = { turn: cur.lastTurn, at: ok ? time(ok.realTime) : null, state: recoveryState(ok) };
      }
      if (r) await recover(cur, s.records[cur.key] || Object.values(s.records).find((x) => x.incident === cur.number && x.turn === cur.lastTurn), r, gate.act);
    }
    // A recovered incident stops absorbing new failures after a while even if nobody closed it yet.
    if (cur?.recovered && now() - (cur.recovered.postedAt || 0) > RECOVERED_KEEP_MS) { s.past = [...(s.past || []), { ...cur, retiredAt: now() }].slice(-20); delete s.current; }
    for (const [k, r] of Object.entries(s.records)) if (now() - (r.lastSeenAt || r.firstSeenAt || 0) > 7 * 24 * HOUR) delete s.records[k];
    sweepLocks();
    ledger.save();
    return { idle: true };
  }

  // Cheap first look, once a minute: two small reads. The full sweep runs only when something looks wrong or an incident
  // or an open attempt is still live.
  async function probe() {
    const s = st();
    const live = Boolean(s.current) || Object.values(s.records).some((r) => ["opening", "retry", "uncertain", "new"].includes(r.state));
    if (!live) {
      const [lock, health] = (await Promise.allSettled([mcp.call("turndiag", "lock_status", {}, false), mcp.call("engine", "engine_health", {}, false)])).map((r) => (r.status === "fulfilled" ? parse(r.value) : null));
      const trouble = !lock || !health || /^(?:STUCK|overdue)/i.test(String(lock?.verdict || "")) || Boolean(lock?.paused) || health?.lastTurn?.success === false || (health?.lastTurn?.failedPhases || []).length > 0 ||
        (num(health?.lastTurn?.turn) !== null && num(lock?.currentTurn) !== null && num(health.lastTurn.turn) > num(lock.currentTurn));
      if (!trouble) return { quiet: true };
    } else if (s.current?.recovered && now() - (s.lastSweep?.at || 0) < CLOSED_CHECK_MS) return { quiet: true };
    return check({ source: "probe" });
  }
  // One sweep at a time; callers that arrive during a sweep share it.
  function check(opts) {
    if (inflight) return inflight;
    inflight = sweep(opts).catch((e) => { log(`turn incidents: ${String(e.message).slice(0, 200)}`); return { error: e.message }; }).finally(() => { inflight = null; });
    return inflight;
  }
  // The incident a watch finding's turn belongs to, if one is open or attached.
  function incidentForTurn(turn) {
    const s = st();
    if (s.current?.turns?.includes(turn)) return s.current.number;
    return Object.values(s.records).find((r) => r.turn === turn && r.incident && r.state !== "closed-while-failing")?.incident || null;
  }
  function status() {
    const s = st();
    return { current: s.current ? { number: s.current.number, by: s.current.by, turns: s.current.turns, recovered: s.current.recovered || null } : null,
      pending: Object.values(s.records).filter((r) => ["opening", "retry", "uncertain", "create-unrecorded"].includes(r.state)).map((r) => ({ key: r.key, state: r.state, lastError: r.lastError || null, nextAt: r.nextAt || null })),
      lastHold: s.lastHold || null, lastRead: s.lastRead || null };
  }
  return { check, probe, sweep, status, incidentForTurn };
}

module.exports = { createTurnIncidents, assess, pauseKind, plainPhase, duration, titleFor, openingMessage, newTurnMessage, recoveryMessage, isTurnIncident, cleanRecovery, recoveryState, SWITCH, MAX_CHARS, MAX_SENTENCES, sentences };
