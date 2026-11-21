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
// A parked job is re-checked in code this often. It never starts a model run on this timer.
const PARK_RECHECK_MS = 6 * HOUR;
const MAX_EXPIRIES_PER_PASS = 10;

const WAIT_KINDS = ["turn", "pr", "deploy", "decision", "player", "owner", "developer", "staff", "worker", "other"];
const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

// Root ticket and finding jobs. Coding children, probes, commands and conversations keep their own rules.
function applies(job) {
  return Boolean(job) && ["ticket", "finding"].includes(job.kind) && !job.codingParent && !job.internalProbe && !job.investigation;
}

// What kind of wait a sentence describes, when the model did not say. Order matters: a PR named in the wait wins.
function infer(text, { waitFor, turnWatch, pendingDecision } = {}) {
  const t = String(text || "");
  const pr = /\b(?:PR|pull request)\s*#?(\d{3,6})\b|#(\d{4,6})\b/i.exec(t);
  if (pr) return { kind: /\b(?:deploy|live|release|main server|promot)/i.test(t) ? "deploy" : "pr", ref: Number(pr[1] || pr[2]) };
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
      const pr = prState(d, n, now);
      if (!pr) return { checkable: false, why: n ? "PR state not read recently" : "no PR named" };
      // A merged PR is what a deploy wait needs first; after that only github where can tell, so the model runs.
      return { checkable: true, mark: `pr:${n}:${pr.state}:${pr.head || ""}`, reached: on.kind === "pr" ? pr.state !== "open" : pr.merged };
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
function fromFinish(d, job, input, now, { pendingDecision = false } = {}) {
  if (!applies(job) || !["waiting", "blocked"].includes(input.state)) return null;
  const given = clip(input.closesWhen, 300), waiting = clip(input.waitingOn, 300);
  const prior = job.closing;
  if (!given && !prior?.closesWhen) {
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
  if (c.wokeFor === "timer-unchecked" && !acted && !changed && c.setAt !== now) c.quietWakes = (c.quietWakes || 0) + 1;
  else if (acted || changed || c.setAt === now || ["change", "message"].includes(c.wokeFor)) c.quietWakes = 0;
  if (seen.checkable) c.mark = seen.mark;
  c.timerAt = job.wakeAt;
  c.timerMs = Number.isFinite(job.wakeAt) ? Math.max(0, job.wakeAt - now) : null;
  delete c.wokeFor;
  // After the one escalation activation the job either raised the ask or it parks.
  if (c.escalation?.how === "ask" && !c.escalation.settled) {
    c.escalation.settled = true;
    const asked = Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending");
    if (!asked) return park(d, job, now, "no ask was raised");
    return { asked: true };
  }
  if ((c.quietWakes || 0) >= config.quietWakes && !c.parked) return escalate(d, job, now, config);
  return null;
}

// --- Wakes ------------------------------------------------------------------------------------------------------------

const label = (job) => job.ticket ? `Ticket ${job.ticket}` : `Finding ${String(job.engineeringTitle || job.summary || job.id).slice(0, 80)}`;

function park(d, job, now, why) {
  const c = job.closing;
  c.parked = { at: now, on: c.waitingOn, why };
  job.state = "waiting"; job.wakeAt = now + PARK_RECHECK_MS; c.timerAt = job.wakeAt;
  return { parked: true, effects: [
    { type: "audit", kind: "job_parked", detail: { job: job.id, ticket: job.ticket || null, on: clip(c.waitingOn, 160), why, quietWakes: c.quietWakes || 0 } },
    { type: "notify", key: `parked:${job.id}:${c.setAt || 0}`, destination: "owner", content: `${label(job)} is parked: it has woken ${c.quietWakes || 0} times with nothing changing and is now waiting on ${clip(c.waitingOn, 200)}. It closes when ${clip(c.closesWhen, 200).replace(/^closes when /i, "")}. Keir will not check it on a timer again; it wakes when that changes or someone writes.` },
  ] };
}

// Exactly one of: hand the PR to the open-PR pass, one activation to raise the single ask, or park.
function escalate(d, job, now, config = DEFAULTS) {
  const c = job.closing;
  c.escalations = (c.escalations || 0) + 1;
  const n = c.on?.kind === "pr" || c.on?.kind === "deploy" ? (Number.isFinite(c.on.ref) ? c.on.ref : heldPr(job)) : heldPr(job);
  const pr = n ? Object.values(d.prTruth?.prs || {}).find((r) => Number(r.number) === Number(n)) : null;
  const ownPr = n && (job.pullRequests || []).some((u) => prNumberOf(u) === n);
  if (ownPr && (!pr || pr.state === "open") && !(c.handedPrs || []).includes(n)) {
    c.handedPrs = [...(c.handedPrs || []), n];
    c.escalation = { at: now, how: "handoff", pr: n };
    const out = park(d, job, now, `PR ${n} handed to the open-PR pass`);
    // The open-PR pass makes the one ask, repair or close; the owner sees that, so no separate parked line.
    out.effects = [out.effects[0], { type: "audit", kind: "pr_handed_to_open_pr_pass", detail: { job: job.id, pr: n } }];
    return { handedOff: n, effects: out.effects };
  }
  const waitsOnOwner = ["owner", "decision"].includes(c.on?.kind);
  const asked = Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending");
  if (waitsOnOwner && !asked && job.kind === "ticket" && !c.escalation) {
    c.escalation = { at: now, how: "ask" };
    (job.inbox ||= []).push({ authorId: "closing-check", role: "system", at: new Date(now).toISOString(),
      content: `This task has woken ${c.quietWakes} times waiting on ${clip(c.waitingOn, 200)} and nothing has changed. It closes when ${clip(c.closesWhen, 200).replace(/^closes when /i, "")}. Do exactly one thing now: put the one question that would unblock it to the owner (github merge for a PR, or raise_to_developers kind decision with the options), then finish waiting on that answer. Do not post to the player unless the answer or a needed question is ready. If no question would unblock it, finish waiting and the task parks until something changes.` });
    job.state = "queued"; job.wakeAt = 0;
    return { ask: true, effects: [{ type: "audit", kind: "closing_escalated", detail: { job: job.id, ticket: job.ticket || null, how: "ask", quietWakes: c.quietWakes } }] };
  }
  c.escalation = { at: now, how: "park" };
  return park(d, job, now, "nothing it waits on changed");
}

// wakeStep hook, for a waiting job whose timer is due and whose inbox is empty. Returns null to let the wake go ahead,
// or { quiet, effects } when the job stays waiting without a model run.
function quietWake(d, job, now, config = DEFAULTS) {
  const c = job.closing;
  if (!applies(job) || !c || job.state !== "waiting" || job.inbox?.length) return null;
  // Only the timer this wait set: a retry, a close grace, a cap or a recovery timer always reaches the model.
  if (!c.parked && (c.timerAt !== job.wakeAt || !(c.timerMs >= MIN_CHECKED_WAIT_MS))) return null;
  if (job.closeReadyAt || job.resolutionReadyAt && !job.resolved || job.deadline < now) return null;
  // A due promise always reaches the model (a turn promise is due when its turn ran, not at its estimated time).
  if (require("./promises").dueNow(d, job.ticket, now)) return null;
  const seen = observe(d, job, now);
  if (!seen.checkable) {
    if (c.parked) { job.wakeAt = now + PARK_RECHECK_MS; c.timerAt = job.wakeAt; return { quiet: true, effects: [] }; }
    c.wokeFor = "timer-unchecked"; return null;
  }
  // The mark carries "reached" for a named turn and the state for a PR, so a change of mark is the only signal: a wait
  // already reached when the model last finished does not wake it again on every timer.
  if (c.mark !== undefined && seen.mark !== c.mark) {
    const was = c.parked;
    c.mark = seen.mark; c.quietWakes = 0; delete c.parked; delete c.escalation; c.wokeFor = "change";
    return was ? { quiet: false, effects: [{ type: "audit", kind: "job_unparked", detail: { job: job.id, ticket: job.ticket || null, mark: seen.mark } }] } : null;
  }
  if (c.mark === undefined) { c.mark = seen.mark; c.wokeFor = "change"; return null; }
  if (c.parked) { job.wakeAt = now + PARK_RECHECK_MS; c.timerAt = job.wakeAt; return { quiet: true, effects: [] }; }
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

// A message or an unparking event wakes a parked job; it is no longer parked once a model run starts.
function onActivation(job, now, { human = false } = {}) {
  const c = job.closing;
  if (!c) return;
  if (c.parked) { delete c.parked; c.quietWakes = 0; if (c.escalation?.how !== "ask") delete c.escalation; }
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
  job.stepBack = { at: now, level: lv.level, why: lv.why, posted: 0 };
  const c = job.closing;
  (job.inbox ||= []).push({ authorId: "step-back", role: "system", at: new Date(now).toISOString(),
    content: `Step back before anything else. This ticket has ${lv.why.join(" and ")}. Here is the whole ticket in short:\n${timeline(d, job) || "(no record)"}\n${c ? `Recorded closing condition: closes when ${clip(c.closesWhen, 200).replace(/^closes when /i, "")}; waiting on ${clip(c.waitingOn, 200)}.\n` : ""}First call checkpoint stating: what the player actually needs, what is still missing to close this, who it is waiting on, and whether your last several posts moved that. Then post at most one message, and only if it is the answer, a question you need answered, or a plain statement of what the ticket is waiting for. Finish with closesWhen and waitingOn updated.` });
  return true;
}
// Post guard during a step-back activation: a checkpoint first, then at most one post.
function stepBackRefusal(job, { checkpointed }) {
  const s = job.stepBack;
  if (!s || s.done) return null;
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
  const clock = d.watch?.turnClock;
  if (!clock || !Number.isFinite(clock.turn)) return false;
  if (job.world !== undefined && clock.iteration !== undefined && job.world !== clock.iteration) return true;
  const named = PAST_TURN.exec(`${job.engineeringTitle || ""} ${String(job.source?.content || "").slice(0, 300)}`);
  return Boolean(named) && Number(named[1]) > clock.turn + 50;
}
function hasQuestion(d, job) {
  return Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending")
    || Object.values(d.actions || {}).some((a) => a.jobId === job.id && ["pending", "approved", "executing"].includes(a.state))
    || Object.values(d.jobs || {}).some((j) => j.codingParent === job.id && !JOB_TERMINAL.includes(j.state))
    || Object.values(job.effects || {}).some((e) => ["started", "executing", "uncertain"].includes(e?.state));
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
    const gone = oldWorld(d, job, now);
    const blockedEmpty = job.state === "blocked" && now - since >= limit;
    const parkedLong = job.state === "waiting" && job.closing?.parked && now - job.closing.parked.at >= limit;
    if (!(gone && now - (job.at || since) >= limit) && !blockedEmpty && !parkedLong) continue;
    // Every candidate went quiet at least the expiry period ago; one that did so before the pass first ran is historical.
    const quietSince = parkedLong ? job.closing.parked.at + limit : since + limit;
    if (hist.check(quietSince, { open: true }) === "later") continue;
    const why = gone ? "it belongs to a world that no longer exists" : blockedEmpty ? `it was blocked ${Math.round((now - since) / HOUR)} hours with no question behind it` : `it was parked ${Math.round((now - job.closing.parked.at) / HOUR)} hours with nothing changing`;
    if (!g.act) { require("./controls").preview(d, "finding-expiry", "close finding", `job ${job.id}`, `${why}: ${clip(job.summary, 160)}`, {}, now); closed.push(job.id); continue; }
    const was = clip(job.summary, 200);
    job.state = "dismissed";
    job.summary = `Closed automatically: ${why}. Was: ${was}`;
    job.history = [...(job.history || []), { at: new Date(now).toISOString(), kind: "expired", summary: job.summary }].slice(-20);
    delete job.wakeAt;
    ledger.audit("finding_expired", { job: job.id, why: gone ? "old_world" : blockedEmpty ? "blocked_no_question" : "parked", was });
    closed.push(job.id);
  }
  if (closed.length && g.act) ledger.save();
  return closed;
}

// The live view for people and the context: one line each.
function describe(job) {
  const c = job?.closing;
  if (!c) return null;
  return { closesWhen: c.closesWhen, waitingOn: c.waitingOn, on: c.on, quietWakes: c.quietWakes || 0, parked: c.parked ? { since: new Date(c.parked.at).toISOString(), why: c.parked.why } : null, ...(c.derived ? { derived: true } : {}) };
}

module.exports = { DEFAULTS, settings, WAIT_KINDS, MISSING, applies, infer, observe, fromFinish, afterFinish, quietWake, onActivation, escalate, park,
  notePost, stepBackLevel, stepBack, stepBackRefusal, timeline, closingCallsForTurn, noteTurnReport, oldWorld, expireFindings, describe, turnClock,
  CLOCK_FRESH_MS, PR_FRESH_MS, PARK_RECHECK_MS, MIN_CHECKED_WAIT_MS };
