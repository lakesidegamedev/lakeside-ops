"use strict";
// Keir 11.2 second pass: work toward closing the ticket, not toward the next hourly update.
//
// The owner, after the 2026-11-21 audit: "Keir gets sometimes too focused on providing an hourly update and loses the
// forest for the trees." The records agree. Ticket 1845 got 58 Keir posts against 11 human messages, 26 of them within
// ten minutes of a turn. PR 6887's job woke 26 times in 72 hours to write "still unmerged, no recorded approval" and went
// back to sleep without asking anyone. Seventeen finding jobs re-woke for days to confirm what was already known.
//
// Every ticket and finding job now carries its closing condition on the job itself (job.closing), set by the model
// through finish (closesWhen, waitingOn, waitOn) and required before the job may wait:
//   closesWhen  what would close it ("the player's revenue after the fix is compared with turn 77")
//   waitingOn   what it waits for now, and who or what supplies it ("the first turn after deploy")
//   on          { kind, ref }: the same wait in a form code can check (turn, pr, decision, player, worker, ...)
//   mark        what code last saw of that wait (the turn number, the PR state and head, the decision states)
//   quietWakes  wakes in a row where the thing waited on had not changed
//
// A timer wake checks the wait in code first (wakeStep in lifecycle.js calls quietWake). Nothing changed: no model run,
// no post, one audit row, the timer is set again. After KEIR_QUIET_WAKES (3) quiet wakes in a row the job escalates
// once: it hands its own open PR to the open-PR pass (keirprs.js), or (a ticket that waits on the owner with no question
// open) gets one activation to raise the single ask, or it parks: no more timed model wakes, one owner line saying what
// it is parked on. A parked job still wakes on a message or when the thing it waits on changes.
//
// A long ticket gets one step-back activation each time it crosses a threshold (10 Keir posts, 24 hours open or 3
// corrections; doubling after that): it reads the whole ticket as a short timeline and states what the player needs,
// what is missing to close, who it waits on and whether the last posts moved that, before it may post once.
//
// Finding jobs that are blocked with no question behind them, parked with nothing changing, or from a world that no
// longer exists are closed with a one-line record after KEIR_FINDING_EXPIRY_HOURS (72).
const { JOB_TERMINAL } = require("./machines");

const HOUR = 3600000, MIN = 60000;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
function settings(env = process.env) {
  return {
    quietWakes: num(env.KEIR_QUIET_WAKES, 3),
    stepBackPosts: num(env.KEIR_STEPBACK_POSTS, 10),
    stepBackHours: num(env.KEIR_STEPBACK_HOURS, 24),
    stepBackCorrections: num(env.KEIR_STEPBACK_CORRECTIONS, 3),
    findingExpiryHours: num(env.KEIR_FINDING_EXPIRY_HOURS, 72),
    // Fourth pass (review N1): the safety net for a parked job. Code re-checks the wait this often (no post, no model run
    // when nothing changed). Hours, not days, for a ticket a player is waiting on.
    parkRecheckHours: num(env.KEIR_PARK_RECHECK_HOURS, 2),
    findingParkRecheckHours: num(env.KEIR_FINDING_PARK_RECHECK_HOURS, 6),
    // A wait no event can end (kind "other", an owner wait with no question open) is never parked: it keeps a slow timer
    // that still reaches the model.
    slowWakeHours: num(env.KEIR_SLOW_WAKE_HOURS, 2),
  };
}
const DEFAULTS = Object.freeze(settings({}));

// The turn clock is fresh enough to decide on for this long (the watch reads game_overview every 5 minutes).
const CLOCK_FRESH_MS = 20 * MIN;
// A PR state read by the reconcile pass (prtruth.js) is used for this long.
const PR_FRESH_MS = 2 * HOUR;
// Only waits the model asked for with a timer of at least this length are checked in code; shorter wakes are
// deliberate retries (checks settling, a reply owed) and always reach the model.
const MIN_CHECKED_WAIT_MS = 15 * MIN;
// Kept for callers that read it: the finding default of the parked re-check. Tickets use config.parkRecheckHours.
const PARK_RECHECK_MS = 6 * HOUR;
const MAX_EXPIRIES_PER_PASS = 10;

const WAIT_KINDS = ["turn", "pr", "deploy", "decision", "player", "owner", "developer", "staff", "worker", "other"];
const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

// Fourth pass (review N1, the blocker): a parked job has no model timer, so it may park only on a wait some event will
// end. For each kind: may it park, and what wakes it. "question" means only while an owner question is pending for the job.
// Every parked job is also re-checked in code (parkRecheckHours), and wakes at once when any event below changes its mark
// (quietWake runs for parked jobs on every lifecycle step, not only when the re-check is due).
const PARKING = Object.freeze({
  turn: { park: true, source: "the next turn runs (the turn clock is read every 5 minutes)" },
  pr: { park: true, source: "the pull request is merged, closed or changes (GitHub is read every 30 minutes)" },
  deploy: { park: true, source: "the fix reaches the main server (GitHub is read every 30 minutes)" },
  decision: { park: "question", source: "the owner answers the open question, or GitHub settles it" },
  owner: { park: "question", source: "the owner answers the open question, or GitHub settles it" },
  player: { park: true, source: "the player writes" },
  developer: { park: true, source: "a developer replies" },
  staff: { park: true, source: "staff write" },
  worker: { park: true, source: "the coding worker or its task changes state" },
  other: { park: false, source: null },
});

// Root ticket and finding jobs. Coding children, probes, commands and conversations keep their own rules.
function applies(job) {
  return Boolean(job) && ["ticket", "finding"].includes(job.kind) && !job.codingParent && !job.internalProbe && !job.investigation;
}

// What kind of wait a sentence describes, when the model did not say. Order matters: a PR named in the wait wins.
// Review 3 F1: only "PR" or "pull request" before a number names a PR; a bare "#1900" is as likely a ticket or an issue.
function infer(text, { waitFor, turnWatch, pendingDecision } = {}) {
  const t = String(text || "");
  const pr = /\b(?:PR|pull request)\s*#?(\d{3,6})\b/i.exec(t);
  if (pr) return { kind: /\b(?:deploy|live|release|main server|promot)/i.test(t) ? "deploy" : "pr", ref: Number(pr[1]) };
  const turn = /\bturn\s+(\d{1,5})\b/i.exec(t);
  if (turnWatch?.turn) return { kind: "turn", ref: Number(turnWatch.turn) };
  if (turn) return { kind: "turn", ref: Number(turn[1]) };
  if (/\b(?:next|first|another|a) turn\b|\bturn (?:has )?(?:run|processed)\b/i.test(t)) return { kind: "turn", ref: null };
  if (pendingDecision || /\b(?:owner|egg)\b.*\b(?:answer|approv|decid|choice|reply)|\b(?:approval|decision)\b/i.test(t)) return { kind: pendingDecision ? "decision" : "owner", ref: null };
  if (waitFor === "player_reply" || /\bplayer\b.*\b(?:reply|answer|confirm|respond)/i.test(t)) return { kind: "player", ref: null };
  if (waitFor === "developer_reply" || /\bdeveloper|cofounder|maintainer|wiki admin\b/i.test(t)) return { kind: "developer", ref: null };
  if (/\bworker\b/i.test(t)) return { kind: "worker", ref: null };
  if (/\bdeploy|\blive\b|\brelease/i.test(t)) return { kind: "deploy", ref: null };
  return { kind: "other", ref: null };
}

function normalizeOn(on, fallback) {
  if (!on || typeof on !== "object") return fallback;
  const kind = WAIT_KINDS.includes(on.kind) ? on.kind : fallback.kind;
  const ref = on.ref === undefined || on.ref === null || on.ref === "" ? (kind === fallback.kind ? fallback.ref : null) : (Number.isFinite(Number(on.ref)) ? Number(on.ref) : clip(on.ref, 80));
  return { kind, ref };
}

// --- What code can see of a wait (ledger only, no network) ---------------------------------------------------------

function turnClock(d, now) {
  const c = d.watch?.turnClock;
  if (c && Number.isFinite(c.turn) && now - (c.at || 0) <= CLOCK_FRESH_MS) return c;
  return null;
}
function prState(d, n, now) {
  if (!n) return null;
  const rec = Object.values(d.prTruth?.prs || {}).find((r) => Number(r.number) === Number(n));
  return rec && now - (rec.checkedAt || 0) <= PR_FRESH_MS ? rec : null;
}
// The open AHDGame PR a job holds, when it holds exactly one.
const prNumberOf = (u) => Number(/\/pull\/(\d+)\s*$/.exec(String(u || ""))?.[1] || 0);
function heldPr(job) {
  const prs = [...new Set((job.pullRequests || []).filter((u) => /\/AHDGame\/pull\//.test(u)).map(prNumberOf).filter(Boolean))];
  return prs.length ? prs[prs.length - 1] : null;
}

// { checkable, mark, reached } for a job's wait. checkable false means only the model can tell, so the wake goes ahead.
function observe(d, job, now) {
  const c = job.closing, on = c?.on || { kind: "other" };
  const decisions = () => Object.values(d.decisions || {}).filter((x) => x.jobId === job.id).map((x) => `${x.id}:${x.state}`).sort().join(",");
  const heard = () => `${job.lastPlayerAt || 0}:${job.observedPlayerAt || 0}`;
  switch (on.kind) {
    case "turn": {
      const clock = turnClock(d, now);
      if (!clock) return { checkable: false, why: "turn clock unread" };
      // A named turn changes the wait only when it is reached (a wait on turn 97 does not wake on turns 91 to 96); a new
      // world always does.
      if (Number.isFinite(on.ref)) return { checkable: true, mark: `turn:${clock.iteration ?? ""}:${clock.turn >= on.ref ? "reached" : "before"}`, reached: clock.turn >= on.ref };
      return { checkable: true, mark: `turn:${clock.iteration ?? ""}:${clock.turn}` };
    }
    case "pr": case "deploy": {
      const n = Number.isFinite(on.ref) ? on.ref : heldPr(job);
      // Review 3 F1: a deploy wait resolves in code only on a PR this job's own records tie to its fix; any other number
      // goes to the model to look.
      if (on.kind === "deploy" && n && !require("./livecoverage").jobOwnsPr(d, job, "AHDGame", n)) return { checkable: false, why: `PR ${n} is not one this job opened or was approved to merge` };
      const pr = prState(d, n, now);
      if (!pr) return { checkable: false, why: n ? "PR state not read recently" : "no PR named" };
      if (on.kind === "pr") return { checkable: true, mark: `pr:${n}:${pr.state}:${pr.head || ""}`, reached: pr.state !== "open" };
      // Review N1: a deploy wait is not over when the PR merges; it is over when the merge is on the main server. The GitHub
      // reconcile pass reads that (prtruth.js, onMain) and the mark carries it, so reaching main changes the mark. Until the
      // main read exists, code cannot tell and the wake reaches the model.
      if (pr.merged && typeof pr.onMain !== "boolean") return { checkable: false, why: "merged; main server not read yet" };
      return { checkable: true, mark: `pr:${n}:${pr.state}:${pr.head || ""}:${pr.merged ? (pr.onMain ? "main" : "not-main") : ""}`, reached: Boolean(pr.merged && pr.onMain) };
    }
    case "decision": case "owner":
      return { checkable: true, mark: `dec:${decisions()}:${heard()}` };
    case "player": case "developer": case "staff":
      // Messages wake the job through its inbox; a timer wake with an empty inbox means nobody wrote.
      return { checkable: true, mark: `msg:${heard()}:${(job.raisedToDevelopers || []).map((r) => `${r.id}:${r.releasedAt || ""}:${r.state || ""}`).join(",")}:${decisions()}` };
    case "worker": {
      const runs = Object.values(d.codingWorkers?.runs || {}).filter((r) => r.jobId === job.id).map((r) => `${r.id}:${r.state}`).sort().join(",");
      const kids = Object.values(d.jobs || {}).filter((j) => j.codingParent === job.id).map((j) => `${j.id}:${j.state}`).sort().join(",");
      return { checkable: true, mark: `work:${runs}:${kids}` };
    }
    default: return { checkable: false, why: "not checkable in code" };
  }
}

// --- Setting the condition (the finish tool) ---------------------------------------------------------------------

const MISSING = "Not finished: say what would close this and what it is waiting on before it waits. Finish again with closesWhen (what closes this ticket or finding, in one plain sentence, e.g. \"closes when the player's revenue after the fix is compared with turn 77\") and waitingOn (what it waits for now and who or what supplies it, e.g. \"the first turn after the deploy\" or \"the owner's answer on PR 6887\"). Add waitOn {kind, ref} when it is a turn, a PR, a decision, a player or developer reply or a worker, so the wait is checked without waking you.";

// Called by finish for waiting or blocked. Returns null when the job may wait, or the refusal text.
// Refused at most twice per activation; after that a condition is derived from the summary so a finish never loops.
// refuse false (switch finishNeedsCondition off or in preview): never refuse; a condition is derived as on the third try.
function fromFinish(d, job, input, now, { pendingDecision = false, refuse = true } = {}) {
  if (!applies(job) || !["waiting", "blocked"].includes(input.state)) return null;
  const given = clip(input.closesWhen, 300), waiting = clip(input.waitingOn, 300);
  const prior = job.closing;
  if (refuse && !given && !prior?.closesWhen) {
    const rec = job.closingRefusals = job.closingRefusals?.at === (job.lastRunStartedAt || 0) ? job.closingRefusals : { at: job.lastRunStartedAt || 0, n: 0 };
    if (rec.n < 2) { rec.n += 1; return MISSING; }
  }
  const waitText = waiting || prior?.waitingOn || clip(input.summary, 200) || "an update";
  const fallback = infer(waitText, { waitFor: input.waitFor, turnWatch: job.turnWatch, pendingDecision });
  // The same words without an explicit waitOn keep the recorded wait as it was: "the next turn" restated on every finish
  // must not re-arm itself to the following turn (that would open a turn report every turn).
  const restated = !input.waitOn && prior?.on && (!waiting || waiting === prior.waitingOn);
  const on = restated ? { ...prior.on } : normalizeOn(input.waitOn, input.waitOn || waiting ? fallback : (prior?.on || fallback));
  // "The next turn" becomes the turn number it means, so the wait is checkable and calls for one result only.
  const clock = turnClock(d, now);
  if (!restated && on.kind === "turn" && !Number.isFinite(on.ref) && clock) on.ref = clock.turn + 1;
  const next = {
    closesWhen: given || prior?.closesWhen || `derived: ${clip(input.summary, 200)}`,
    waitingOn: waitText, on,
    derived: !given && !prior?.closesWhen ? true : undefined,
  };
  const same = prior && prior.closesWhen === next.closesWhen && prior.waitingOn === next.waitingOn && prior.on?.kind === on.kind && prior.on?.ref === on.ref;
  if (same) {
    // The model re-stated the same wait. When it had nothing new to act on, that is a quiet wake confirmed by the model.
    job.closing = { ...prior, at: now };
  } else {
    job.closing = { ...next, setAt: now, at: now, quietWakes: 0, escalations: prior?.escalations || 0, handedPrs: prior?.handedPrs };
    delete job.closing.derived; if (next.derived) job.closing.derived = true;
    if (!job.closing.handedPrs) delete job.closing.handedPrs;
  }
  return null;
}

// After finish has settled the job's state and timer. Records the timer this wait asked for (only that timer is checked
// in code) and what code sees of the wait now. acted: the activation posted, wrote or raised something.
function afterFinish(d, job, { acted = false, now, config = DEFAULTS } = {}) {
  const c = job.closing;
  if (!applies(job) || !c || !["waiting", "blocked"].includes(job.state)) return null;
  const seen = observe(d, job, now);
  const changed = seen.checkable && c.mark !== undefined && seen.mark !== c.mark;
  // A timer wake code could not check, where the model then did nothing and re-stated the same wait, counts as quiet
  // too (evidence waits, like job 7c4b0cee's "no new failure evidence in this wake"). A message or a change is never quiet.
  if (["timer-unchecked", "slow"].includes(c.wokeFor) && !acted && !changed && c.setAt !== now) c.quietWakes = (c.quietWakes || 0) + 1;
  else if (acted || changed || c.setAt === now || ["change", "message"].includes(c.wokeFor)) { c.quietWakes = 0; delete c.slowed; }
  if (seen.checkable) c.mark = seen.mark;
  // A slowed wait keeps its slow timer while nothing happens (the model may not shorten it by restating the same wait).
  if (c.slowed && job.state === "waiting" && Number.isFinite(job.wakeAt)) job.wakeAt = Math.max(job.wakeAt, now + slowMs(config));
  c.timerAt = job.wakeAt;
  c.timerMs = Number.isFinite(job.wakeAt) ? Math.max(0, job.wakeAt - now) : null;
  delete c.wokeFor;
  // After the one escalation activation the job either raised the ask or it parks.
  if (c.escalation?.how === "ask" && !c.escalation.settled) {
    c.escalation.settled = true;
    const asked = Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending");
    if (!asked) return parkOrSlow(d, job, now, "no ask was raised", config);
    return { asked: true };
  }
  if ((c.quietWakes || 0) >= config.quietWakes && !c.parked) return escalate(d, job, now, config);
  return null;
}

// --- Wakes ------------------------------------------------------------------------------------------------------------

const label = (job) => job.ticket ? `Ticket ${job.ticket}` : `Finding ${String(job.engineeringTitle || job.summary || job.id).slice(0, 80)}`;
const slowMs = (config = DEFAULTS) => num(config.slowWakeHours, DEFAULTS.slowWakeHours) * HOUR;
function recheckMs(job, config = DEFAULTS) {
  return job.kind === "ticket" ? num(config.parkRecheckHours, DEFAULTS.parkRecheckHours) * HOUR : num(config.findingParkRecheckHours, DEFAULTS.findingParkRecheckHours) * HOUR;
}

// What the player is owed on this ticket, in plain words, or null (review N1: such a ticket is never parked silently).
function owedTo(d, job, now) {
  if (job.kind !== "ticket" || !job.ticket) return null;
  const promise = (d.ticketPromises?.[job.ticket] || []).find((p) => p.state === "open");
  if (promise) return `a follow-up Keir promised ("${clip(promise.text, 140)}")`;
  const asked = (d.ticketCases?.[String(job.ticket)]?.asked || []).find((a) => !a.answeredAt);
  if (asked) return `an answer to "${clip(asked.text, 140)}"`;
  if (job.closing?.on?.kind === "deploy") return "word when the fix is live";
  const player = Number(job.lastPlayerAt) || Date.parse(job.lastPlayerAt || "") || 0;
  const posted = Number(job.lastPublishedAt) || Date.parse(job.lastPublishedAt || "") || 0;
  if (player && player > posted) return "a reply to their last message";
  return null;
}

// May this job park on its wait? { ok, why }. Only a kind with a wired event source, only when code can read the wait now,
// and an owner wait only while a question is actually open.
function parkable(d, job, now) {
  const kind = job.closing?.on?.kind || "other";
  const rule = PARKING[kind] || PARKING.other;
  if (!rule.park) return { ok: false, why: `nothing in code can tell when "${kind}" waits end` };
  if (rule.park === "question" && !Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending")) return { ok: false, why: "no owner question is open, so no answer can wake it" };
  const seen = observe(d, job, now);
  if (!seen.checkable) return { ok: false, why: seen.why || "the wait cannot be read in code now" };
  return { ok: true, source: rule.source };
}

function park(d, job, now, why, config = DEFAULTS, { silent = false } = {}) {
  const c = job.closing;
  const owed = owedTo(d, job, now);
  const every = recheckMs(job, config);
  const source = (PARKING[c.on?.kind] || PARKING.other).source || "something changes";
  c.parked = { at: now, on: c.waitingOn, why, source, ...(owed ? { owed } : {}) };
  delete c.slowed;
  job.state = "waiting"; job.wakeAt = now + every; c.timerAt = job.wakeAt; c.timerMs = every;
  const effects = [{ type: "audit", kind: "job_parked", detail: { job: job.id, ticket: job.ticket || null, on: clip(c.waitingOn, 160), waitKind: c.on?.kind || "other", why, quietWakes: c.quietWakes || 0, owed: owed ? clip(owed, 160) : null } }];
  // A ticket where the player is owed something is never parked without a line the owner sees.
  if (!silent || owed) effects.push({ type: "notify", key: `parked:${job.id}:${c.setAt || 0}`, destination: "owner", content: `${label(job)} is parked: it has woken ${c.quietWakes || 0} times with nothing changing and is now waiting on ${clip(c.waitingOn, 200)}. It closes when ${clip(c.closesWhen, 200).replace(/^closes when /i, "")}.${owed ? ` The player is owed ${owed}.` : ""} It wakes when ${source}, when someone writes, and Keir re-checks it in code every ${Math.round(every / HOUR)} hours.` });
  return { parked: true, effects };
}

// A wait nothing can end in code keeps a slow timer that still reaches the model (review N1): never a silent park.
function slow(d, job, now, why, config = DEFAULTS) {
  const c = job.closing;
  const every = slowMs(config);
  c.slowed = { at: now, why };
  c.escalation = { at: now, how: "slow" };
  job.state = "waiting"; job.wakeAt = now + every; c.timerAt = job.wakeAt; c.timerMs = every;
  return { slowed: true, effects: [{ type: "audit", kind: "job_slowed", detail: { job: job.id, ticket: job.ticket || null, on: clip(c.waitingOn, 160), waitKind: c.on?.kind || "other", why, everyHours: every / HOUR } }] };
}
function parkOrSlow(d, job, now, why, config = DEFAULTS) {
  const p = parkable(d, job, now);
  return p.ok ? park(d, job, now, why, config) : slow(d, job, now, `${why}; ${p.why}`, config);
}

// Exactly one of: hand the PR to the open-PR pass, one activation to raise the single ask, park, or slow down.
// config.handoffReady() says the open-PR pass is on, has Keir's token and is not in preview (review N8); without it the job
// keeps its PR.
function escalate(d, job, now, config = DEFAULTS) {
  const c = job.closing;
  c.escalations = (c.escalations || 0) + 1;
  const n = c.on?.kind === "pr" || c.on?.kind === "deploy" ? (Number.isFinite(c.on.ref) ? c.on.ref : heldPr(job)) : heldPr(job);
  const pr = n ? Object.values(d.prTruth?.prs || {}).find((r) => Number(r.number) === Number(n)) : null;
  const ownPr = n && (job.pullRequests || []).some((u) => prNumberOf(u) === n);
  const ready = typeof config.handoffReady === "function" && Boolean(config.handoffReady());
  if (ownPr && ready && (!pr || pr.state === "open") && !(c.handedPrs || []).includes(n)) {
    c.handedPrs = [...(c.handedPrs || []), n];
    c.escalation = { at: now, how: "handoff", pr: n };
    // The open-PR pass makes the one ask, repair or close, which the owner sees; a ticket that owes the player something
    // still gets the parked line.
    const out = park(d, job, now, `PR ${n} handed to the open-PR pass`, config, { silent: true });
    out.effects.push({ type: "audit", kind: "pr_handed_to_open_pr_pass", detail: { job: job.id, pr: n } });
    return { handedOff: n, effects: out.effects };
  }
  const waitsOnOwner = ["owner", "decision"].includes(c.on?.kind);
  const asked = Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending");
  if (waitsOnOwner && !asked && job.kind === "ticket" && !c.escalation) {
    c.escalation = { at: now, how: "ask" };
    (job.inbox ||= []).push({ authorId: "closing-check", role: "system", at: new Date(now).toISOString(),
      content: `This task has woken ${c.quietWakes} times waiting on ${clip(c.waitingOn, 200)} and nothing has changed. It closes when ${clip(c.closesWhen, 200).replace(/^closes when /i, "")}. Do exactly one thing now: put the one question that would unblock it to the owner (github merge for a PR, or raise_to_developers kind decision with the options), then finish waiting on that answer. Do not post to the player unless the answer or a needed question is ready. If no question would unblock it, finish waiting and the task slows down to a check every few hours.` });
    job.state = "queued"; job.wakeAt = 0;
    return { ask: true, effects: [{ type: "audit", kind: "closing_escalated", detail: { job: job.id, ticket: job.ticket || null, how: "ask", quietWakes: c.quietWakes } }] };
  }
  if (c.escalation?.how !== "slow") c.escalation = { at: now, how: "park" };
  return parkOrSlow(d, job, now, "nothing it waits on changed", config);
}

// Leave the parked state (a change, a message, a safety-net wake): the handed-over PR comes back to the job (review N8).
function unpark(c) {
  delete c.parked; delete c.handedPrs; c.quietWakes = 0;
  if (c.escalation?.how !== "ask") delete c.escalation;
}

// wakeStep hook, for a waiting job whose timer is due and whose inbox is empty, and for every parked job on every step.
// Returns null to let the wake go ahead, or { quiet, effects } when the job stays waiting without a model run.
function quietWake(d, job, now, config = DEFAULTS) {
  const c = job.closing;
  if (!applies(job) || !c || job.state !== "waiting" || job.inbox?.length) return null;
  if (c.parked) return parkedCheck(d, job, now, config);
  // Only the timer this wait set: a retry, a close grace, a cap or a recovery timer always reaches the model.
  if (c.timerAt !== job.wakeAt || !(c.timerMs >= MIN_CHECKED_WAIT_MS)) return null;
  if (job.closeReadyAt || job.resolutionReadyAt && !job.resolved || job.deadline < now) return null;
  // A due promise always reaches the model (a turn promise is due when its turn ran, not at its estimated time).
  if (require("./promises").dueNow(d, job.ticket, now)) return null;
  // A slowed wait (nothing in code can tell) always reaches the model on its slow timer.
  if (c.slowed) { c.wokeFor = "slow"; return null; }
  const seen = observe(d, job, now);
  if (!seen.checkable) { c.wokeFor = "timer-unchecked"; return null; }
  // The mark carries "reached" for a named turn and the state for a PR, so a change of mark is the only signal: a wait
  // already reached when the model last finished does not wake it again on every timer.
  if (c.mark !== undefined && seen.mark !== c.mark) { c.mark = seen.mark; c.quietWakes = 0; delete c.escalation; c.wokeFor = "change"; return null; }
  if (c.mark === undefined) { c.mark = seen.mark; c.wokeFor = "change"; return null; }
  const every = Math.max(c.timerMs || 0, MIN_CHECKED_WAIT_MS);
  // A named future turn that has simply not come yet is on track, not stuck: checked in code, never escalated.
  if (c.on?.kind === "turn" && Number.isFinite(c.on.ref) && !seen.reached) { job.wakeAt = now + every; c.timerAt = job.wakeAt; return { quiet: true, effects: [] }; }
  c.quietWakes = (c.quietWakes || 0) + 1; c.lastQuietAt = now;
  const effects = [{ type: "audit", kind: "quiet_wake", detail: { job: job.id, ticket: job.ticket || null, quietWakes: c.quietWakes, on: c.on?.kind || "other" } }];
  if (c.quietWakes >= config.quietWakes) {
    const out = escalate(d, job, now, config);
    return { quiet: !out.ask, effects: [...effects, ...(out.effects || [])] };
  }
  job.wakeAt = now + every; c.timerAt = job.wakeAt;
  return { quiet: true, effects };
}

// A parked job, on every step. A changed mark wakes it now (the event). The safety net is due at wakeAt: an unchanged
// wait re-arms it with no post and no model run; a wait code cannot read any more wakes the model, since "unknown" is not
// "nothing changed". Nothing else touches the job, so an idle parked job costs one ledger read per step.
function parkedCheck(d, job, now, config = DEFAULTS) {
  const c = job.closing;
  const seen = observe(d, job, now);
  if (seen.checkable && c.mark !== undefined && seen.mark !== c.mark) {
    c.mark = seen.mark; unpark(c); c.wokeFor = "change"; job.wakeAt = now;
    return { quiet: false, effects: [{ type: "audit", kind: "job_unparked", detail: { job: job.id, ticket: job.ticket || null, mark: seen.mark, by: "change" } }] };
  }
  if (!(job.wakeAt <= now)) return { quiet: true, effects: [] };
  if (!seen.checkable) {
    unpark(c); c.wokeFor = "timer-unchecked";
    return { quiet: false, effects: [{ type: "audit", kind: "job_unparked", detail: { job: job.id, ticket: job.ticket || null, by: "safety net", why: seen.why || "wait unreadable" } }] };
  }
  c.parked.checkedAt = now;
  job.wakeAt = now + recheckMs(job, config); c.timerAt = job.wakeAt;
  return { quiet: true, effects: [] };
}

// A message or an unparking event wakes a parked job; it is no longer parked once a model run starts. A step-back left
// open by an activation that ended without finish (turn limit, crash, restart) no longer applies (review N3).
function onActivation(job, now, { human = false } = {}) {
  if (job.stepBack && !job.stepBack.done) {
    const s = job.stepBack;
    s.done = true; s.endedAbnormally = true;
    // It never got to its checkpoint and one post: let the next activation try it once more.
    if (!s.retry && !s.posted && job.stepBackLevel === s.level) { job.stepBackLevel = Math.max(0, s.level - 1); job.stepBackRetry = s.level; }
  }
  const c = job.closing;
  if (!c) return;
  if (c.parked || c.handedPrs) unpark(c);
  if (human || !c.wokeFor) c.wokeFor = human ? "message" : (job.inbox?.length ? "message" : "other");
  c.activatedAt = now;
}

// --- Step back on long tickets -----------------------------------------------------------------------------------------

// Durable per-ticket pace: Keir posts, corrections and a short log for the step-back timeline.
function notePost(d, ticket, text, { now, correction = false } = {}) {
  if (!ticket) return null;
  const p = ((d.ticketPace ||= {})[ticket] ||= { posts: 0, corrections: 0, firstAt: now, log: [] });
  p.posts += 1; if (correction) p.corrections += 1;
  p.log = [...p.log, { at: now, by: "keir", text: clip(text, 140) }].slice(-30);
  return p;
}
const level = (v, t) => (t > 0 && v >= t ? Math.floor(Math.log2(v / t)) + 1 : 0);
function stepBackLevel(d, job, now, config = DEFAULTS) {
  const p = d.ticketPace?.[job.ticket];
  const opened = Math.min(...[Date.parse(job.source?.at || "") || Infinity, job.at || Infinity, p?.firstAt || Infinity]);
  const hours = Number.isFinite(opened) ? (now - opened) / HOUR : 0;
  const parts = { posts: level(p?.posts || 0, config.stepBackPosts), hours: level(hours, config.stepBackHours), corrections: level(p?.corrections || 0, config.stepBackCorrections) };
  const top = Math.max(parts.posts, parts.hours, parts.corrections);
  const why = Object.entries(parts).filter(([, v]) => v === top && v > 0).map(([k]) => k === "posts" ? `${p.posts} Keir posts` : k === "hours" ? `${Math.floor(hours)} hours open` : `${p.corrections} corrections`);
  return { level: top, why, posts: p?.posts || 0 };
}

// The compact timeline a step-back activation reads first.
function timeline(d, job) {
  const tc = d.ticketCases?.[String(job.ticket)];
  const rows = [
    ...(tc?.asked || []).map((a) => ({ at: a.at, by: "player", text: clip(a.text, 140) })),
    ...(d.ticketPace?.[job.ticket]?.log || []),
    ...Object.values(d.decisions || {}).filter((x) => x.ticket === job.ticket || d.jobs?.[x.jobId]?.ticket === job.ticket).map((x) => ({ at: x.at || x.createdAt, by: "owner question", text: `${clip(x.question || x.title || x.summary, 100)} (${x.state})` })),
    ...(d.ticketPromises?.[job.ticket] || []).map((p) => ({ at: p.at, by: "promise", text: `${clip(p.text, 100)} (${p.state})` })),
  ].filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at).slice(-40);
  return rows.map((r) => `${new Date(r.at).toISOString().slice(5, 16).replace("T", " ")} ${r.by}: ${r.text}`).join("\n");
}

// At activation start. Returns true when this activation is a step-back; puts the timeline in front of the model.
function stepBack(d, job, now, config = DEFAULTS) {
  if (job.kind !== "ticket" || !job.ticket || !applies(job)) return false;
  const lv = stepBackLevel(d, job, now, config);
  if (lv.level <= (job.stepBackLevel || 0)) return false;
  job.stepBackLevel = lv.level;
  // Tied to this activation (review N3): a later activation never inherits its one-post limit.
  job.stepBack = { at: now, level: lv.level, why: lv.why, posted: 0, run: job.lastRunStartedAt || null, ...(job.stepBackRetry === lv.level ? { retry: true } : {}) };
  delete job.stepBackRetry;
  const c = job.closing;
  (job.inbox ||= []).push({ authorId: "step-back", role: "system", at: new Date(now).toISOString(),
    content: `Step back before anything else. This ticket has ${lv.why.join(" and ")}. Here is the whole ticket in short:\n${timeline(d, job) || "(no record)"}\n${c ? `Recorded closing condition: closes when ${clip(c.closesWhen, 200).replace(/^closes when /i, "")}; waiting on ${clip(c.waitingOn, 200)}.\n` : ""}First call checkpoint stating: what the player actually needs, what is still missing to close this, who it is waiting on, and whether your last several posts moved that. Then post at most one message, and only if it is the answer, a question you need answered, or a plain statement of what the ticket is waiting for. Finish with closesWhen and waitingOn updated.` });
  return true;
}
// The step-back in force for this activation, or null: one that is done, or was started by an earlier activation, is not.
function stepBackActive(job) {
  const s = job?.stepBack;
  if (!s || s.done) return null;
  if (s.run && job.lastRunStartedAt && s.run !== job.lastRunStartedAt) return null;
  return s;
}
// Post guard during a step-back activation: a checkpoint first, then at most one post.
function stepBackRefusal(job, { checkpointed }) {
  const s = stepBackActive(job);
  if (!s) return null;
  if (!checkpointed) return "Not posted: this is a step-back activation. First call checkpoint with what the player actually needs, what is still missing to close the ticket, who it is waiting on, and whether your last posts moved that.";
  if (s.posted >= 1) return "Not posted: a step-back activation posts at most one message, and it already went out. Finish with closesWhen and waitingOn.";
  return null;
}

// --- Turn commentary is opt-in ------------------------------------------------------------------------------------------

// Does the closing condition call for a specific turn's result right now? Only a turn wait with a turn number that has
// been reached, or one without a number when the clock moved since the condition was set.
// Calls for one result: turn N once it has run (or once, when the turn cannot be read), then it is used up until the
// model sets a new condition. A turn read that fails never silences a called-for report.
function closingCallsForTurn(d, job, now) {
  const c = job?.closing;
  if (!c || c.on?.kind !== "turn" || c.turnReported) return false;
  if (!Number.isFinite(c.on.ref)) return true;
  const clock = turnClock(d, now);
  return !clock || clock.turn >= c.on.ref;
}
function noteTurnReport(d, job, now) {
  const c = job?.closing;
  if (c && c.on?.kind === "turn") c.turnReported = turnClock(d, now)?.turn ?? c.on.ref ?? true;
}

// --- Finding expiry -------------------------------------------------------------------------------------------------------

const PAST_TURN = /\bturn\s+(\d{2,5})\b/i;
// A finding from a world that no longer exists: it names a turn well past the current one (the world was reset), or it
// was recorded under another world iteration.
function oldWorld(d, job, now) {
  // Review N9: only a fresh clock with a known world number decides; a stale read or a missing iteration proves nothing.
  const clock = turnClock(d, now);
  if (!clock) return false;
  if (job.world !== undefined && job.world !== null && clock.iteration !== undefined && clock.iteration !== null && job.world !== clock.iteration) return true;
  const named = PAST_TURN.exec(`${job.engineeringTitle || ""} ${String(job.source?.content || "").slice(0, 300)}`);
  return Boolean(named) && Number(named[1]) > clock.turn + 50;
}
function hasQuestion(d, job) {
  return Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending")
    || Object.values(d.actions || {}).some((a) => a.jobId === job.id && ["pending", "approved", "executing"].includes(a.state))
    || Object.values(d.jobs || {}).some((j) => j.codingParent === job.id && !JOB_TERMINAL.includes(j.state))
    || Object.values(job.effects || {}).some((e) => ["started", "executing", "uncertain"].includes(e?.state))
    // Review N9: a question to the developers that has not been released is a question.
    || (job.raisedToDevelopers || []).some((r) => !r.releasedAt && !["closed", "answered", "released"].includes(r.state));
}
// Blocked by its own finish with nothing behind it, as opposed to held for a person (a failed run, an expired deadline,
// an uncertain write, an owner blocker), which the owner was told about and which is never expired (review N9).
function blockedByOwnFinish(job, since) {
  if (job.ownerMuseBlocker || job.deadlineBlockedAt || job.uncertain) return false;
  const last = (job.history || []).at(-1);
  return Boolean(last && last.kind === "finish" && last.state === "blocked" && (Date.parse(last.at || "") || 0) >= since - 60000);
}
// The last time a person (the owner, staff, a developer, a player) wrote to this job.
function lastHumanAt(job) {
  const t = (v) => (typeof v === "number" ? v : Date.parse(v || "") || 0);
  return Math.max(t(job.lastPlayerAt), t(job.lastHumanAt), t(job.lastOwnerAt),
    ...(job.inbox || []).filter((m) => ["owner", "staff", "developer", "player", "user"].includes(m.role)).map((m) => t(m.at)), 0);
}
// One pass. Returns the jobs closed. Bounded; a job is closed once (it is terminal afterwards).
// Third pass (review M7): KEIR_FINDING_EXPIRY switch and preview, the kill switch and pause, and a bounded first start
// (findings that went quiet before the pass's first real run are closed a few per run).
function expireFindings(ledger, { now, config = DEFAULTS, controls = require("./controls").DEFAULT_CONTROLS } = {}) {
  const d = ledger.data, limit = config.findingExpiryHours * HOUR, closed = [];
  const g = controls.gate("findingExpiry");
  if (!g.run) return closed;
  const hist = require("./controls").history(d, "findingExpiry", { controls, now, act: g.act });
  for (const job of Object.values(d.jobs || {})) {
    if (closed.length >= MAX_EXPIRIES_PER_PASS) break;
    if (job.kind !== "finding" || job.codingParent || JOB_TERMINAL.includes(job.state) || ["running", "queued", "paused"].includes(job.state)) continue;
    if (hasQuestion(d, job)) continue;
    const since = job.stateAt || job.updatedAt || job.at || 0;
    if (now - lastHumanAt(job) < limit) continue; // a person touched it recently: not abandoned
    const gone = oldWorld(d, job, now);
    const blockedEmpty = job.state === "blocked" && now - since >= limit && blockedByOwnFinish(job, since);
    const parkedLong = job.state === "waiting" && job.closing?.parked && now - job.closing.parked.at >= limit;
    if (!(gone && now - (job.at || since) >= limit) && !blockedEmpty && !parkedLong) continue;
    // Every candidate went quiet at least the expiry period ago; one that did so before the pass first ran is historical.
    const quietSince = parkedLong ? job.closing.parked.at + limit : since + limit;
    if (hist.check(quietSince, { open: true }) === "later") continue;
    const why = gone ? "it belongs to a world that no longer exists" : blockedEmpty ? `it was blocked ${Math.round((now - since) / HOUR)} hours with no question behind it` : `it was parked ${Math.round((now - job.closing.parked.at) / HOUR)} hours with nothing changing`;
    if (!g.act) { require("./controls").preview(d, "finding-expiry", "close finding", `job ${job.id}`, `${why}: ${clip(job.summary, 160)}`, {}, now); closed.push(job.id); continue; }
    const was = clip(job.summary, 200);
    // Enough to reopen it exactly as it was (review N9).
    job.expired = { at: now, why, fromState: job.state, summary: String(job.summary || "").slice(0, 2000), wakeAt: job.wakeAt ?? null, closing: job.closing ? JSON.parse(JSON.stringify(job.closing)) : null };
    job.state = "dismissed";
    job.summary = `Closed automatically: ${why}. Was: ${was}`;
    job.history = [...(job.history || []), { at: new Date(now).toISOString(), kind: "expired", summary: job.summary }].slice(-20);
    delete job.wakeAt;
    ledger.audit("finding_expired", { job: job.id, why: gone ? "old_world" : blockedEmpty ? "blocked_no_question" : "parked", was });
    closed.push(job.id);
  }
  if (closed.length && g.act) {
    // One owner line per pass that closed findings, so a wrong expiry is seen (review N9); each can be reopened.
    const names = closed.map((id) => `${clip(d.jobs[id]?.expired?.summary || id, 70)} (${id})`);
    ledger.notify(`findings-expired:${now}`, "owner", `Keir closed ${closed.length} stale finding${closed.length === 1 ? "" : "s"} with nothing behind ${closed.length === 1 ? "it" : "them"}: ${names.join("; ")}. Each keeps its record and can be reopened.`);
    ledger.save();
  }
  return closed;
}

// The live view for people and the context: one line each.
function describe(job) {
  const c = job?.closing;
  if (!c) return null;
  return { closesWhen: c.closesWhen, waitingOn: c.waitingOn, on: c.on, quietWakes: c.quietWakes || 0, parked: c.parked ? { since: new Date(c.parked.at).toISOString(), why: c.parked.why, wakesWhen: c.parked.source || null, owed: c.parked.owed || null } : null,
    ...(c.slowed ? { slowed: { since: new Date(c.slowed.at).toISOString(), why: c.slowed.why } } : {}), ...(c.derived ? { derived: true } : {}) };
}

module.exports = { DEFAULTS, settings, WAIT_KINDS, PARKING, MISSING, applies, infer, observe, fromFinish, afterFinish, quietWake, onActivation, escalate, park, slow, parkable, owedTo, recheckMs, heldPr,
  notePost, stepBackLevel, stepBack, stepBackRefusal, stepBackActive, blockedByOwnFinish, hasQuestion, timeline, closingCallsForTurn, noteTurnReport, oldWorld, expireFindings, describe, turnClock,
  CLOCK_FRESH_MS, PR_FRESH_MS, PARK_RECHECK_MS, MIN_CHECKED_WAIT_MS };
