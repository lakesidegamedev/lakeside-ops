"use strict";
const { createHash } = require("node:crypto");
// Keir 5.0 watch (owner, 2026-10-14): "no player is ever the first to notice".
// Cheap deterministic sensors run after each processed turn and on their own
// cadence. No model runs here. An observation becomes a finding once it is
// hard (a failed turn, a broken page) or has persisted across two sweeps; a
// finding becomes one model task ("finding" kind) that confirms it, files the
// issue, prepares a heal plan and drafts a fix. A severe finding is also
// proposed to staff as an incident.
//
// Posture (owner): detect and report. Finding tasks never apply heals and
// never merge, except display-only fixes. The broker enforces that.
//
// Noise is the failure mode: fingerprints dedupe, soft signals must persist,
// and new finding tasks are capped per hour and per day.

const HOUR = 3600000;
const CADENCE = { turns: 5 * 60000, economy: 0, invariants: 0, heal: 3 * HOUR, sentry: 0.5 * HOUR, pages: 2 * HOUR };
const LIMITS = { perHour: 3, perDay: 8 };
const RESOLVE_AFTER = 6 * HOUR;
// Logged-out public pages a player reaches first.
// Pages whose text is mostly the game's own (news and changelog quote error
// words in prose, so they are not walked).
const PAGES = ["/", "/elections", "/corporations", "/market", "/parties", "/politicians"];
const PAGE_ERROR = /\b(?:application error|internal server error|something went wrong|unhandled runtime error|this page could not be found|502 bad gateway|503 service unavailable)|\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/i;
const PHASE_FAILURE = /^phase-(?:failed|error|stuck|timed?out)/;
function failureCause(value) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text.length >= 12 && /\s/.test(text) && !/^(?:other|unknown|internal server error|something went wrong|phase failed|operation failed)$/i.test(text) ? text : null;
}
function warningPhase(a) {
  if (a.kind !== "warning" || typeof a.detail !== "string") return null;
  const match = /^([a-zA-Z][\w]*):\s*(.+)$/.exec(a.detail);
  return match ? { phase: match[1], text: match[2] } : null;
}
const warningFingerprint = (text) => `turn:warning:${text.toLowerCase().replace(/\d+/g, "#").slice(0, 80)}`;
const TERMINAL = ["done", "dismissed", "cancelled"];
// Keir 5.1 root cause (2026-10-15 audit: one line of credit fault became five
// findings, three public issues and two competing PRs). The same error text
// from any sensor is one cause: a Sentry "Error: X" and a turn phase failing
// with X are one investigation.
function causeKey(text) {
  const t = String(text || "").replace(/^(?:\s*(?:uncaught\s+)?\w*(?:error|exception):\s*)+/i, "").toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return t.length >= 12 && /\s/.test(t) ? t.slice(0, 160) : null;
}
const rootCause = (f) => causeKey(f.phaseFailure?.cause || f.cause);
// After a finding's task finishes, this many new distinct observations mean
// the problem outlived the work: it is raised again, at most once per window.
const RECUR_AFTER = 2, RECUR_WINDOW = 6 * HOUR, RECUR_MAX = 3;
// A turn finding is verified fixed after this many processed turns without it.
const CLEAN_TURNS = 2;
// A sensor with no success for this long (or failing this long) is an alert.
const STALE = { turns: HOUR, economy: 3 * HOUR, invariants: 3 * HOUR, heal: 9 * HOUR, sentry: 2 * HOUR, pages: 6 * HOUR };
const FAILING_ALERT = HOUR;
// A heal detector failing this many times in a row is skipped for a day
// instead of failing the whole heal sensor.
const DETECTOR_STRIKES = 3;

function sentryWatchQuery(query, { project = "a-house-divided", environment = "production" } = {}) {
  if (![project, environment].every((s) => /^[\w-]+$/.test(s))) throw new Error("invalid Sentry watch scope");
  return `${query} project:${project} environment:${environment}`;
}

function finiteIssues(value, prefix = "", out = [], depth = 0) {
  if (out.length >= 10 || depth > 6) return out;
  if (typeof value === "number" && !Number.isFinite(value)) out.push(prefix || "(root)");
  else if (value === "NaN" || value === "Infinity" || value === "-Infinity") out.push(prefix || "(root)");
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) finiteIssues(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  return out;
}

const LOCAL_BROWSER = /browserType\.launch|Executable doesn't exist|Cannot find module|Failed to launch|Host system is missing dependencies/i;
function createWatch({ ledger, mcp, config = {}, now = () => Date.now(), sentry = null, viewPage = null, propose = null, log = () => {} }) {
  const d = ledger.data;
  function state() {
    const w = (d.watch ||= {});
    w.findings ||= {}; w.ran ||= {}; w.succeeded ||= {}; w.spawned ||= [];
    w.score ||= { caughtFirst: 0, playerFirst: 0 }; w.credited ||= {};
    return w;
  }
  const site = config.siteUrl || "https://www.ahousedividedgame.com";

  // One observation. hard: real on first sight. severe: also an incident
  // proposal. evidence: short facts the finding task starts from.
  function observe({ fp, sensor, title, evidence, hard = false, severe = false, defectId = null, event = null, cause = null }) {
    const w = state(), t = now();
    const f = w.findings[fp] ||= { fp, sensor, title, firstSeen: t, seen: 0, state: "observed" };
    if (f.state === "resolved") { f.state = "observed"; f.seen = 0; f.events = []; f.firstSeen = t; f.reopened = (f.reopened || 0) + 1; delete f.jobId; delete f.proposed; delete f.resolvedAt; delete f.verifiedAt; delete f.afterJob; }
    f.lastSeen = t;
    if (event === null || !(f.events || []).includes(event)) {
      f.seen++;
      if (event !== null) f.events = [...(f.events || []), event].slice(-100);
      // Still happening after its task finished: counted towards recurrence.
      const job = f.jobId && d.jobs[f.jobId];
      if (f.state === "raised" && job && TERMINAL.includes(job.state)) f.afterJob = (f.afterJob || 0) + 1;
    }
    const turnNo = Number(/^turn:(\d+):/.exec(event || "")?.[1]);
    if (Number.isFinite(turnNo)) f.lastTurnSeen = Math.max(f.lastTurnSeen || 0, turnNo);
    f.title = title; f.evidence = String(evidence || "").slice(0, 3000); f.hard = f.hard || hard; f.severe = f.severe || severe;
    if (defectId) f.defectId = defectId;
    if (cause) f.cause = cause;
    return f;
  }

  // The finding a correlated one belongs to, following the chain.
  function rootOf(fp) {
    const w = state();
    let f = w.findings[fp];
    for (let i = 0; f?.correlatedWith && i < 10; i++) f = w.findings[f.correlatedWith] || f;
    return f || null;
  }
  // Every finding sharing fp's root, root first.
  function group(fp) {
    const root = rootOf(fp);
    if (!root) return [];
    return [root, ...Object.values(state().findings).filter((f) => f !== root && rootOf(f.fp) === root)];
  }
  // Every task that worked any finding in fp's group (current and earlier).
  function groupJobs(fp) {
    return [...new Set(group(fp).flatMap((f) => [f.jobId, ...(f.priorJobs || [])]).filter(Boolean))];
  }
  function findingByJob(jobId) {
    return Object.values(state().findings).find((f) => f.jobId === jobId || (f.priorJobs || []).includes(jobId)) || null;
  }
  // An unresolved, uncorrelated finding with the same root cause that was
  // raised already or seen earlier: the one this finding belongs under.
  function sameCauseRoot(f) {
    const key = rootCause(f);
    if (!key) return null;
    return Object.values(state().findings).filter((g) => g !== f && !g.correlatedWith && g.state !== "resolved" && rootCause(g) === key &&
      (g.state !== "observed" || g.firstSeen < f.firstSeen)).sort((a, b) => a.firstSeen - b.firstSeen)[0] || null;
  }

  function budget() {
    const w = state(), t = now();
    w.spawned = (w.spawned || []).filter((x) => t - x < 24 * HOUR);
    return w.spawned.filter((x) => t - x < HOUR).length < LIMITS.perHour && w.spawned.length < LIMITS.perDay;
  }

  function promote() {
    if (config.mode === "report") return [];
    const w = state(), out = [];
    const ready = Object.values(w.findings).filter((f) => !f.correlatedWith && (f.state === "recurring" || (f.state === "observed" && (f.hard || f.seen >= 2)))).sort((a, b) => Number(b.state === "recurring") - Number(a.state === "recurring") || Number(b.severe) - Number(a.severe) || Number(b.hard) - Number(a.hard) || a.firstSeen - b.firstSeen);
    for (const f of ready) {
      const root = f.state === "observed" && sameCauseRoot(f);
      if (root) {
        f.correlatedWith = root.fp; f.state = "correlated";
        ledger.audit("watch_finding_correlated", { fp: f.fp, root: root.fp, cause: rootCause(f) });
        continue;
      }
      if (!budget()) { if (!f.deferredAt) { f.deferredAt = now(); ledger.audit("watch_finding_deferred", { fp: f.fp }); } continue; }
      const recurring = f.state === "recurring";
      const prior = recurring ? `\n\nThis was raised before and is still happening after that work finished (${f.afterJobAtRecur || RECUR_AFTER} more observations).${f.issue ? ` Its issue is #${f.issue}.` : ""} Check whether the fix is merged and live where it runs (turn code needs turn-worker/production). If it is live, the fix did not work: say so with the evidence. If it is not live yet, record what it waits on. Add to the existing issue and item; do not file new ones.` : "";
      const job = ledger.createJob(`finding:${f.fp}:${f.firstSeen}${recurring ? `:recur${f.recurrences}` : ""}`, { kind: "finding", role: "support", repository: "AHDGame", finding: f.fp, deadline: now() + 24 * HOUR,
        ...(f.issue ? { issues: [f.issue] } : {}),
        source: { role: "system", content: `Keir watch found this before any player reported it.\n\n${f.title}\n\n${f.evidence}${prior}`, at: new Date(now()).toISOString() } });
      f.state = "raised"; f.jobId = job.id; f.raisedAt = now(); w.spawned.push(now()); delete f.afterJob;
      ledger.audit("watch_finding_raised", { fp: f.fp, job: job.id, sensor: f.sensor, severe: f.severe });
      out.push(f);
    }
    return out;
  }

  function observePhaseFailure(a, warnings) {
    const w = state(), phase = String(a.phase || "unknown"), kind = String(a.kind);
    // A warning is evidence of this failure only when both phase and turn match.
    // Never infer shared causes from the sensor's generic classification "other".
    const causes = [...new Set(warnings.map((x) => failureCause(x.text)).filter(Boolean))];
    const cause = failureCause(a.reason) || (causes.length === 1 ? causes[0] : null);
    const key = cause ? `turn:${kind}:cause:${createHash("sha256").update(cause).digest("hex")}`
      : `turn:${kind}:${phase}${a.phase ? "" : `:${a.turn}`}`;
    const samePhase = (f) => f.phaseFailure?.kind === kind && f.phaseFailure.phases.includes(phase) ||
      (f.sensor === "turns" && /^turn:\d+:phase-/.test(f.fp) && f.fp.endsWith(`:${kind}:${phase}`));
    const rank = (f) => f.jobId && d.jobs[f.jobId] ? (["done", "dismissed", "cancelled"].includes(d.jobs[f.jobId].state) ? 1 : 2) : 0;
    const candidates = Object.values(w.findings).filter((f) => !f.correlatedWith && f.state !== "resolved" &&
      (f.fp === key || f.phaseFailure?.key === key || (samePhase(f) && (cause ? !f.phaseFailure?.cause || f.phaseFailure.cause === cause : !f.phaseFailure?.cause))))
      .sort((x, y) => rank(y) - rank(x) || x.firstSeen - y.firstSeen);
    const prior = candidates[0];
    const fp = prior?.fp || key;
    const detail = prior?.phaseFailure || { key, kind, phases: [], observations: [] };
    for (const f of candidates.slice(1)) if (f.phaseFailure) {
      for (const p of f.phaseFailure.phases) if (!detail.phases.includes(p)) detail.phases.push(p);
      for (const observation of f.phaseFailure.observations) if (!detail.observations.some((x) => x.event === observation.event)) detail.observations.push(observation);
    }
    if (cause) { detail.cause = cause; detail.key = key; }
    if (!detail.phases.includes(phase)) detail.phases.push(phase);
    const event = `turn:${a.turn}:${kind}:${phase}`;
    const observation = { event, ...a, warnings: warnings.map((x) => x.text) };
    const index = detail.observations.findIndex((x) => x.event === event);
    if (index < 0) detail.observations.push(observation);
    else detail.observations[index] = observation;
    detail.observations = detail.observations.slice(-20);
    const evidence = `${detail.cause ? `Observed error: ${detail.cause}. ` : ""}Failing phases: ${detail.phases.join(", ")}. Observations: ${JSON.stringify(detail.observations)}`;
    const finding = observe({ fp, sensor: "turns", hard: true, event,
      title: `Recurring turn phase failure: ${detail.phases.join(", ")}`, evidence });
    finding.phaseFailure = detail;
    // Retain existing issue/job receipts on upgrade. Already raised duplicate
    // tasks are not cancelled or transferred; only future promotions coalesce.
    const covered = warnings.filter((x) => cause && failureCause(x.text) === cause);
    const replaced = new Set(candidates.slice(1).map((f) => f.fp));
    for (const old of [...candidates.slice(1), ...Object.values(w.findings).filter((f) => replaced.has(f.correlatedWith)), ...covered.map((x) => w.findings[warningFingerprint(x.raw.detail)]).filter(Boolean)]) {
      if (old.fp === fp) continue;
      old.correlatedWith = fp;
      if (old.state === "observed") old.state = "correlated";
    }
    return { finding, covered };
  }

  // Severe findings go to staff as an incident proposal, once each.
  async function escalate() {
    if (!propose || config.mode === "report") return;
    for (const f of Object.values(state().findings)) {
      if (!f.severe || f.proposed || f.state !== "raised") continue;
      try {
        const proposal = await propose({ title: f.title.slice(0, 180), summary: `Keir found this itself, before any player report. ${f.evidence.slice(0, 400)}`, severe: true, source: "watch", fingerprint: f.fp });
        if (proposal?.messageId && !proposal.postError) f.proposed = now();
      }
      catch (e) { log(`watch propose: ${e.message}`); }
    }
  }

  // A finding no longer seen for six hours is resolved. A raised one keeps its
  // task; the task decides what to do.
  function settle() {
    const t = now(), w = state();
    for (const f of Object.values(w.findings)) {
      const job = f.jobId && d.jobs[f.jobId];
      const finished = !job || TERMINAL.includes(job.state);
      // Keir 5.1: a problem that outlives its finished task is raised again
      // (bounded), instead of sitting "raised" while players keep hitting it.
      if (f.state === "raised" && job && finished && !f.correlatedWith && (f.afterJob || 0) >= RECUR_AFTER &&
          (f.recurrences || 0) < RECUR_MAX && t - (f.recurAt || 0) >= RECUR_WINDOW) {
        f.priorJobs = [...new Set([...(f.priorJobs || []), f.jobId])];
        f.recurrences = (f.recurrences || 0) + 1; f.recurAt = t; f.afterJobAtRecur = f.afterJob;
        f.state = "recurring"; delete f.jobId; delete f.deferredAt;
        ledger.audit("watch_finding_recurring", { fp: f.fp, after: f.afterJob, issue: f.issue || null, recurrences: f.recurrences });
        ledger.notify?.(`error:watch-recurring:${f.fp}:${f.recurrences}`, "owner", `Still happening after Keir's work on it finished: ${f.title}.${f.issue ? ` Issue #${f.issue}.` : ""} Raised again.`);
        continue;
      }
      // A turn problem is verified fixed after clean processed turns, not
      // after six quiet hours (the sensor re-reads recent turns, so lastSeen
      // keeps moving while old failures stay in its window).
      const cleanTurns = f.sensor === "turns" && Number.isFinite(f.lastTurnSeen) && Number.isFinite(w.lastTurn) && w.lastTurn - f.lastTurnSeen >= CLEAN_TURNS && !w.errors?.turns;
      if (finished && f.state !== "resolved" && f.state !== "recurring" && !f.correlatedWith && cleanTurns) {
        f.state = "resolved"; f.resolvedAt = t; f.verifiedAt = t;
        for (const g of group(f.fp)) if (g !== f && g.state !== "resolved") { g.state = "resolved"; g.resolvedAt = t; }
        ledger.audit("watch_fix_verified", { fp: f.fp, cleanThrough: w.lastTurn, lastFailedTurn: f.lastTurnSeen, issue: f.issue || null, raised: Boolean(f.raisedAt) });
        continue;
      }
      if (finished && f.state !== "resolved" && f.state !== "recurring" && t - f.lastSeen > RESOLVE_AFTER && (w.succeeded[f.sensor] || 0) > f.lastSeen) { f.state = "resolved"; f.resolvedAt = t; ledger.audit("watch_finding_cleared", { fp: f.fp }); }
    }
    for (const [fp, f] of Object.entries(state().findings)) if (f.state === "resolved" && t - (f.resolvedAt || 0) > 30 * 24 * HOUR) delete state().findings[fp];
  }

  const sensors = {
    async turns() {
      // turndiag kinds: turn-failed, phase-<status>, slow-turn, warning.
      const r = await mcp.call("turndiag", "turn_anomalies", { turns: 3 }, false);
      const warnings = (r?.anomalies || []).map((a) => { const parsed = warningPhase(a); return parsed && { ...parsed, raw: a }; }).filter(Boolean);
      const coveredWarnings = new Set();
      for (const a of r?.anomalies || []) {
        const kind = String(a.kind || "");
        if (kind === "turn-failed") observe({ fp: `turn:${a.turn}:failed`, sensor: "turns", hard: true, severe: true, title: `Turn ${a.turn} failed`, evidence: JSON.stringify(a).slice(0, 1500) });
        else if (PHASE_FAILURE.test(kind)) {
          const related = warnings.filter((x) => x.phase === a.phase && x.raw.turn === a.turn);
          const { covered } = observePhaseFailure(a, related);
          covered.forEach((x) => coveredWarnings.add(x.raw));
        }
        // phase-running is the live turn; slow turns are tracked by the turn performance work.
      }
      // Unmatched warnings retain their own soft-signal persistence rule.
      for (const a of r?.anomalies || []) if (a.kind === "warning" && !coveredWarnings.has(a)) {
        const text = typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail || "");
        observe({ fp: warningFingerprint(text), sensor: "turns", event: `turn:${a.turn}`, title: `Turn warning: ${text.slice(0, 140)}`, evidence: `Turn ${a.turn}: ${text}`.slice(0, 1500) });
      }
    },
    async economy() {
      const r = await mcp.call("engine", "economy_pulse", {}, false);
      const bad = finiteIssues(r);
      if (bad.length) observe({ fp: `economy:nonfinite:${bad.slice(0, 3).join(",")}`, sensor: "economy", hard: true, title: "Economy pulse reports non-finite numbers", evidence: `Fields: ${bad.join(", ")}` });
    },
    // The game's own invariants (gamestate invariant_check). A breach is a
    // finding per rule and entity; a measurement (equity pool residual) is a
    // finding only when it grows between checks, since it carries history.
    async invariants() {
      const w = state();
      let r;
      try { r = await mcp.call("gamestate", "invariant_check", {}, false); }
      catch (e) { if (/unknown tool|not found|-32601/i.test(e.message)) { w.invariantsUnavailable = now(); return false; } throw e; }
      delete w.invariantsUnavailable;
      const measures = (w.measures ||= {});
      for (const rule of r?.rules || []) {
        // One broken rule is one investigation, even when every entity is
        // affected. Preserve samples as evidence without consuming the day's
        // task budget or paging staff once per corporation.
        if (Number(rule.breaches) > 0) observe({ fp: `invariant:${rule.id}`, sensor: "invariants", hard: true, severe: rule.id === "non_finite_money" || rule.breaches > 25,
          title: `Invariant broken: ${rule.id.replace(/_/g, " ")}`,
          evidence: `Rule ${rule.id} (mirrors ${rule.source}): ${rule.breaches} breach(es) of ${rule.checked} checked. Sample: ${JSON.stringify(rule.sample || []).slice(0, 2200)}` });
        for (const m of rule.measurements || []) {
          if (typeof m.residual !== "number" || !Number.isFinite(m.residual)) continue;
          const prev = measures[m.key];
          measures[m.key] = { value: m.residual, at: now() };
          if (!prev) continue;
          const grew = m.residual - prev.value, floor = Math.max(1, Math.abs(m.cashLocal || 0) * 1e-9);
          if (grew > floor) observe({ fp: `invariant:${rule.id}:${m.pool}:grew`, sensor: "invariants", hard: true,
            title: `Equity pool ${m.pool} created money with no counterparty`,
            evidence: `Conservation residual (mirrors ${rule.source}) rose by ${grew} ${m.pool} since the last check (${prev.value} to ${m.residual}). A positive increase is money created with no counterparty.` });
        }
      }
    },
    async heal() {
      const list = await mcp.call("heal-ops", "heal_list", {}, false);
      // Structural detectors only: restitution defects are one-off repairs.
      const defects = (list?.defects || []).filter((x) => !x.mintsMoney && (x.envs || []).includes("prod"));
      // Keir 5.1: one broken detector (2026-10-14: "no state enterprise target
      // for DD/financial", every cycle) no longer blinds the whole sensor. It
      // is skipped for a day after repeated failures and reported in health.
      const w = state(), strikes = (w.detectors ||= {});
      let failed = null, ran = 0;
      for (const x of defects) {
        const s = strikes[x.id];
        if (s?.skipUntil > now()) continue;
        const r = await mcp.call("heal-ops", "heal_detect", { defectId: x.id, env: "prod" }, false).catch((e) => ({ ok: false, error: e.message }));
        if (!r || r.ok === false) {
          const error = String(r?.error || "unavailable").slice(0, 200), count = (s?.count || 0) + 1;
          strikes[x.id] = { error, count, at: now(), ...(count >= DETECTOR_STRIKES ? { skipUntil: now() + 24 * HOUR } : {}) };
          if (count === DETECTOR_STRIKES) { ledger.audit("watch_detector_skipped", { defect: x.id, error }); ledger.notify?.(`error:watch-detector:${x.id}`, "owner", `heal-ops detector ${x.id} failed ${count} times in a row (${error}); Keir skips it for a day.`); }
          failed ||= new Error(`detector ${x.id}: ${error}`);
          continue;
        }
        ran++; delete strikes[x.id];
        const count = Number(r?.detect?.affected ?? r?.count ?? r?.affected ?? 0);
        if (count > 0) observe({ fp: `heal:${x.id}`, sensor: "heal", defectId: x.id, hard: x.severity === "P1", severe: x.severity === "P1" && count > 100,
          title: `Known defect is back on prod: ${x.title}`, evidence: `heal-ops detector ${x.id} (${x.severity}) finds ${count} corrupt rows on prod. Its fix: ${JSON.stringify(x.codeFix || {})}. Sample: ${JSON.stringify(r?.detect?.sample || r?.sample || []).slice(0, 800)}. ${(r?.detect?.notes || []).join("; ").slice(0, 400)}` });
      }
      // Only a sensor where nothing ran is a failed sensor.
      if (failed && !ran) throw failed;
    },
    async sentry() {
      if (!sentry) return;
      const rows = await sentry("is:unresolved firstSeen:-6h", "6h");
      if (!Array.isArray(rows)) return false;
      for (const i of rows || []) {
        const count = Number(i.count || 0), users = Number(i.users || 0);
        if (count < 5 && users < 2) continue;
        observe({ fp: `sentry:${i.id}`, sensor: "sentry", hard: users >= 5, severe: users >= 25, cause: String(i.title || ""),
          title: `New error: ${String(i.title || "").slice(0, 140)}`, evidence: `Sentry ${i.shortId || i.id}: ${count} events, ${users} users since ${i.firstSeen}. Culprit ${i.culprit || "unknown"}. Release ${i.release || "unknown"}.` });
      }
    },
    async pages() {
      if (!viewPage) return;
      for (const p of PAGES) {
        const url = `${site}${p}`;
        const r = await viewPage(url).catch((e) => ({ error: e.message }));
        // A browser that cannot start on this host says nothing about the game:
        // it is this sensor failing (e.g. Playwright bumped past the installed
        // Chromium), so it degrades monitoring instead of filing a page finding.
        if (LOCAL_BROWSER.test(String(r?.error || ""))) throw new Error(`page sensor browser unavailable: ${String(r.error).slice(0, 160)}`);
        const text = String(r?.text || "");
        const hit = r?.error ? `could not load (${String(r.error).slice(0, 120)})` : !text.trim() ? "rendered blank" : (PAGE_ERROR.exec(text) || PAGE_ERROR.exec(r.title || ""))?.[0];
        if (hit) observe({ fp: `page:${p}:${String(hit).toLowerCase().slice(0, 40)}`, sensor: "pages", hard: /blank|could not load|application error|internal server error|502|503/i.test(hit),
          title: `Public page ${p} shows ${hit}`, evidence: `Logged-out view of ${url}: "${hit}". Title "${r?.title || ""}". Text starts: ${text.slice(0, 400)}` });
      }
    },
  };

  // Runs every due sensor. turnProcessed forces the per-turn sensors.
  async function tick({ turnProcessed = false, turn } = {}) {
    if (d.paused || config.enabled === false) return { skipped: true };
    const w = state(), t = now(), ran = [];
    w.mode = config.mode === "report" ? "report" : "active";
    if (Number.isFinite(turn) && (w.lastTurn === undefined || turn !== w.lastTurn)) turnProcessed = true;
    for (const [name, every] of Object.entries(CADENCE)) {
      const perTurn = every === 0;
      const retrying = w.errors?.[name];
      const due = retrying ? t - (w.ran[name] || 0) >= 5 * 60000 : w.ran[name] === undefined || t - w.ran[name] >= every;
      if (perTurn ? !turnProcessed : !(name === "turns" && turnProcessed) && !due) continue;
      w.ran[name] = t;
      try {
        const healthy = await sensors[name](); ran.push(name);
        if (healthy !== false) { w.succeeded[name] = t; delete w.errors?.[name]; }
      } catch (e) {
        const error = String(e.message).slice(0, 200), prior = w.errors?.[name];
        if (!prior || prior.error !== error || t - prior.loggedAt >= HOUR) { log(`watch ${name}: ${error}`); ledger.audit("watch_sensor_failed", { sensor: name, error }); }
        (w.errors ||= {})[name] = { error, at: t, since: prior?.since || prior?.at || t, loggedAt: !prior || prior.error !== error || t - prior.loggedAt >= HOUR ? t : prior.loggedAt };
      }
    }
    if (Number.isFinite(turn) && ["economy", "invariants"].every((name) => ran.includes(name) || !turnProcessed)) w.lastTurn = turn;
    settle();
    healthAlerts();
    const raised = promote();
    await escalate();
    w.headline = headline();
    ledger.save();
    return { ran, raised: raised.map((f) => f.fp), mode: w.mode };
  }

  // Scorecard. A ticket that joins an issue or item a finding already raised
  // proves Keir got there first; a ticket-sourced issue with no finding is a
  // problem a player saw first.
  function credit({ issue = null, item = null, fromTicket }) {
    const w = state();
    const f = Object.values(w.findings).find((x) => (issue && x.issue === issue) || (item && x.item === item));
    const key = f ? `finding:${f.fp}` : issue ? `issue:${issue}` : item ? `item:${item}` : null;
    if (!fromTicket || !key || w.credited[key] || (issue && w.credited[`issue:${issue}`]) || (item && w.credited[`item:${item}`])) return;
    w.credited[key] = now();
    if (issue) w.credited[`issue:${issue}`] = now();
    if (item) w.credited[`item:${item}`] = now();
    if (fromTicket && f && !f.playerConfirmed) { f.playerConfirmed = now(); w.score.caughtFirst++; ledger.audit("watch_caught_first", { fp: f.fp, issue, item }); }
    else if (fromTicket && !f) w.score.playerFirst++;
    ledger.save();
  }
  function linkFinding(fp, { issue, item }) {
    const f = state().findings[fp];
    if (!f) return;
    if (issue) f.issue = issue; if (item) f.item = item; ledger.save();
  }
  // Keir 5.1 sensor health: a sensor that has not succeeded for its window,
  // or has failed for an hour, is an alert (logged, not a DM), once a day.
  function health() {
    const w = state(), t = now(), out = {};
    for (const name of Object.keys(CADENCE)) {
      const last = w.succeeded[name] || 0, err = w.errors?.[name];
      const failingFor = err ? t - Math.min(err.since || err.at, err.at) : 0;
      // Per-turn sensors only run when turns do; a quiet game is not stale.
      const stale = CADENCE[name] === 0 ? false : !last || t - last > STALE[name];
      out[name] = { ok: !err && !stale, lastSuccess: last || null, error: err?.error || null, failingForMs: failingFor };
    }
    out.detectors = Object.fromEntries(Object.entries(w.detectors || {}).filter(([, s]) => s.skipUntil > t).map(([k, s]) => [k, s.error]));
    return out;
  }
  function healthAlerts() {
    const h = health(), day = new Date(now()).toISOString().slice(0, 10), w = state();
    if (!w.ran || !Object.keys(w.ran).length) return [];
    const out = [];
    for (const name of Object.keys(CADENCE)) {
      const s = h[name];
      if (s.ok || (!s.error && !w.ran[name])) continue;
      if (s.error && s.failingForMs < FAILING_ALERT) continue;
      const key = `error:watch-sensor:${name}:${day}`;
      if (ledger.data.alerts?.some((a) => a.key === key)) continue;
      ledger.notify?.(key, "owner", `Keir watch sensor ${name} is ${s.error ? `failing: ${s.error}` : `stale: no success for ${Math.round((now() - (s.lastSuccess || 0)) / 60000)} minutes`}.`);
      out.push(name);
    }
    return out;
  }
  // The 5.0 mission is "no player is ever the first to notice". This is the
  // headline: who saw it first, how far ahead, and how often Keir was wrong.
  function score() {
    const w = state(), s = w.score, total = s.caughtFirst + s.playerFirst;
    const all = Object.values(w.findings);
    const open = all.filter((f) => f.state !== "resolved" && !f.correlatedWith);
    const leads = all.filter((f) => f.playerConfirmed).map((f) => f.playerConfirmed - f.firstSeen).sort((a, b) => a - b);
    const raisedJobs = all.flatMap((f) => [f.jobId, ...(f.priorJobs || [])]).filter(Boolean).map((id) => d.jobs[id]).filter(Boolean);
    const dismissed = raisedJobs.filter((j) => j.state === "dismissed").length;
    return { caughtFirst: s.caughtFirst, playerFirst: s.playerFirst, share: total ? Math.round((s.caughtFirst / total) * 100) : null,
      leadMinutesMedian: leads.length ? Math.round(leads[Math.floor(leads.length / 2)] / 60000) : null,
      openFindings: open.length, raised: open.filter((f) => f.state === "raised").length, recurring: all.filter((f) => f.recurrences).length,
      verifiedFixed: all.filter((f) => f.verifiedAt).length, dismissed, raisedTotal: raisedJobs.length,
      sensorsDown: Object.entries(health()).filter(([k, v]) => k !== "detectors" && !v.ok).map(([k]) => k) };
  }
  function headline() {
    const s = score();
    return `Watch: caught first ${s.caughtFirst}, player first ${s.playerFirst}${s.share === null ? "" : ` (${s.share}%)`}${s.leadMinutesMedian === null ? "" : `, median lead ${s.leadMinutesMedian}m`}. ` +
      `${s.openFindings} open, ${s.recurring} recurred after work, ${s.verifiedFixed} verified fixed, ${s.dismissed}/${s.raisedTotal} raised tasks dismissed.` +
      (s.sensorsDown.length ? ` Sensors down: ${s.sensorsDown.join(", ")}.` : "");
  }

  return { tick, observe, promote, settle, credit, linkFinding, score, headline, health, healthAlerts, rootOf, group, groupJobs, findingByJob, sensors, LIMITS, PAGES };
}

module.exports = { createWatch, finiteIssues, sentryWatchQuery, causeKey, PAGE_ERROR, CADENCE, LIMITS, STALE, RECUR_AFTER, CLEAN_TURNS };
