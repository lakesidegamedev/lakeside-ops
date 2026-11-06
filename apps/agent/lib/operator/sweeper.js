"use strict";
// Keir 8.4 stuck-ticket sweeper. Owner, 2026-11-06: "this needs to be Keir we can trust in our absence".
// Tickets went hours with no progress (1766 posted the same non-answer seven times in five hours, 1763
// stayed open for days). The wait contract in selfrecovery.js bounds how long a task may WAIT; this
// sweeper looks at the TICKET: has anything substantive happened, and is a player's message sitting unanswered?
//
// A ticket is stuck when it is open, not held, not being worked right now, and either
//   - nothing substantive has happened for staleMs (6 h): a new finding, a fix state change (PR, handoff,
//     release, heal) or an answer. "Still checking" restatements do not count (trustlog.isSubstantiveText);
//   - the player's message is the latest in the ticket and has gone unanswered for unansweredMs (30 min)
//     during Keir's active hours.
// Keir 8.5.1 (ticket 1785): "substantive" is stricter than "something was written". A status-card edit, a
// self-owned question card Keir filed for himself and any "investigating/checking" restatement never reset
// the stall clock; a PR, handoff, release, heal, a stage past "Investigating" or a real finding does.
// A self-owned blocking question card must never just wait: it has a running investigation worker
// (codingworkers.js, kind "investigate") or it is escalated.
// Action ladder, at most ONE action per ticket per windowMs (3 h): first a fresh investigation (an
// investigation worker when the cause is unverified, otherwise a system note that wakes the ticket's task),
// then, if that produced nothing substantive, one owner escalation, then at most one more every
// ownerRepingMs (12 h). A ticket waiting on a pending owner decision is never
// investigated or resolved: the player is told once that it awaits approval, and the owner is re-pinged
// by decisions.js every 12 h (the sweeper does not). All owner notices of one sweep go out as a single DM.
const { trust, markProgress } = require("./trustlog");
const inv = require("./investigation");

const HOUR = 3600000, MIN = 60000;
const DEFAULTS = Object.freeze({ staleMs: 6 * HOUR, unansweredMs: 30 * MIN, windowMs: 3 * HOUR, ownerRepingMs: 12 * HOUR, maxActionsPerSweep: 5, activeHours: [7, 23], timeZone: "America/New_York", questionGraceMs: 20 * MIN });
// Effects that are chatter or bookkeeping, not progress: a posted update, a reply, a status-card post or edit,
// the delivery of a notice.
const NOT_PROGRESS = /^(?:ticket-update|reply|status-card|delivery)(?::|$)/;
const CLOSED = new Set(["done", "cancelled", "dismissed"]);

function ts(v) { const n = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(n) ? n : 0; }

function inActiveHours(at, cfg = DEFAULTS) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: cfg.timeZone, hour: "numeric", hour12: false }).format(new Date(at))) % 24;
  const [from, to] = cfg.activeHours;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

// Pure decision for one ticket snapshot. Returns { action, reason } where action is one of
// none | investigate | investigate_worker | escalate_owner | notice_player_once. The 12 h owner re-ping of a pending decision is decisions.js's alone.
function decideTicket(t, now, cfg = DEFAULTS) {
  if (!t.open) return { action: "none", reason: "closed" };
  if (t.held) return { action: "none", reason: `held: ${t.held}` };
  if (t.pendingDecision) {
    const p = t.pendingDecision;
    if (!p.playerNotified && !t.running) return { action: "notice_player_once", reason: "an owner decision is pending and the player has not been told" };
    return { action: "none", reason: "awaiting the owner's decision" };
  }
  if (t.running) return { action: "none", reason: "being worked" };
  if (t.investigationActive) return { action: "none", reason: "a worker run is on it" };
  if (t.lastActionAt && now - t.lastActionAt < cfg.windowMs) return { action: "none", reason: "swept recently" };
  // A self-owned blocking question nobody is working. A worker that just reported gets one window to be acted on.
  const ownQuestionIdle = t.ownQuestion && now - t.ownQuestion.at >= cfg.questionGraceMs && !(t.lastRunEndedAt && now - t.lastRunEndedAt < cfg.windowMs);
  if (ownQuestionIdle && !t.waitingOnPlayer) {
    const wasTried = ["investigate_worker", "escalate_owner"].includes(t.lastActionKind) && t.lastActionAt > t.lastSubstantiveAt;
    if (!wasTried) return { action: "investigate_worker", reason: `its own blocking question card has had nobody working it for ${Math.round((now - t.ownQuestion.at) / MIN)} min` };
    if (!t.lastEscalationAt || now - t.lastEscalationAt >= cfg.ownerRepingMs) return { action: "escalate_owner", reason: "its own blocking question card is still unworked after an investigation was started" };
    return { action: "none", reason: "owner already told" };
  }
  const unanswered = t.lastHumanAt > t.lastReplyAt && now - t.lastHumanAt >= cfg.unansweredMs && t.inActiveHours;
  const stale = !t.waitingOnPlayer && now - t.lastSubstantiveAt >= cfg.staleMs;
  if (!unanswered && !stale) return { action: "none", reason: t.waitingOnPlayer ? "waiting on the player" : "healthy" };
  const reason = unanswered ? `the player's message has been unanswered for ${Math.round((now - t.lastHumanAt) / MIN)} min` : `no substantive progress for ${Math.round((now - t.lastSubstantiveAt) / HOUR)} h`;
  const investigatedWithoutResult = ["investigate", "investigate_worker", "escalate_owner"].includes(t.lastActionKind) && t.lastActionAt > t.lastSubstantiveAt;
  if (investigatedWithoutResult || t.waitingOnDeveloper) {
    if (t.lastEscalationAt && now - t.lastEscalationAt < cfg.ownerRepingMs) return { action: "none", reason: "owner already told" };
    return { action: "escalate_owner", reason: `${reason}${investigatedWithoutResult ? "; a fresh investigation produced nothing substantive" : "; waiting on a developer"}` };
  }
  return { action: "investigate", reason };
}

function createSweeper({ ledger, config, now = () => Date.now(), log = () => {}, held = () => null, killSwitch = null, wake = null, investigate = null, cfg = {} }) {
  const d = ledger.data, c = { ...DEFAULTS, ...cfg };
  const ticketsOf = () => {
    const by = new Map();
    for (const j of Object.values(d.jobs)) {
      const n = Number(j.ticket) || Number(/-(\d+)$/.exec(j.source?.channelName || "")?.[1]);
      if (!Number.isSafeInteger(n) || n <= 0) continue;
      (by.get(n) || by.set(n, []).get(n)).push(j);
    }
    return by;
  };
  const fingerprint = (jobs) => JSON.stringify(jobs.map((j) => [j.id, (j.pullRequests || []).length, (j.raisedToDevelopers || []).filter((r) => !r.selfOwned).length, Object.entries(j.effects || {}).filter(([k, e]) => e.state === "done" && !NOT_PROGRESS.test(k)).length, Boolean(j.resolutionSubmitted)]));

  function snapshot(n, jobs, at) {
    const t = trust(d), p = (t.progress[n] ||= {}), sweep = t.sweeps[n] || {};
    const root = jobs.filter((j) => j.kind === "ticket" && j.ticket === n).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    if (!root) return null;
    const open = !root.channelClosed && !root.resolved && !CLOSED.has(root.state);
    const lastHumanAt = Math.max(0, ...jobs.map((j) => Math.max(ts(j.observedPlayerAt), ts(j.lastPlayerAt))));
    const lastReplyAt = Math.max(0, p.lastReplyAt || 0, ...jobs.map((j) => ts(j.lastPublishedAt)));
    const fp = fingerprint(jobs);
    if (p.fp === undefined) { p.fp = fp; p.baselineAt = Math.max(ts(root.at), lastReplyAt, lastHumanAt); }
    else if (p.fp !== fp) { p.fp = fp; markProgress(d, n, at, "state change"); }
    const lastSubstantiveAt = Math.max(p.lastSubstantiveAt || 0, p.baselineAt || 0);
    const pending = Object.values(d.decisions || {}).find((x) => x.state === "pending" && jobs.some((j) => j.id === x.jobId));
    const heldReason = held(root) || jobs.some((j) => j.ticketPaused) && "paused by the owner" || null;
    const own = inv.openOwnQuestion(jobs), activeRun = inv.activeRun(d, n);
    const running = jobs.some((j) => j.state === "running" || (j.state === "queued" && at - ts(j.updatedAt) < 30 * MIN));
    return { ticket: n, open, held: heldReason, running, root,
      pendingDecision: pending ? { id: pending.id || pending.actionId, at: ts(pending.at), question: String(pending.question || "").slice(0, 200), lastPingAt: t.ownerPings[pending.id || pending.actionId] || 0,
        playerNotified: sweep.playerNoticedFor === (pending.id || pending.actionId) || t.replies.some((r) => r.ticket === n && r.at >= ts(pending.at)) } : null,
      waitingOnPlayer: root.waitingFor?.kind === "player_reply" && lastReplyAt >= lastHumanAt,
      waitingOnDeveloper: root.waitingFor?.kind === "developer_reply" || (root.raisedToDevelopers || []).some((r) => r.blocking && r.id && !r.releasedAt && !r.selfOwned),
      ownQuestion: own ? { id: own.id, at: Number(own.at) || 0 } : null, investigationActive: Boolean(activeRun), lastRunEndedAt: inv.lastEndedAt(d, n),
      lastHumanAt, lastReplyAt, lastSubstantiveAt, inActiveHours: inActiveHours(at, c),
      lastActionAt: sweep.at || 0, lastActionKind: sweep.kind || null, lastEscalationAt: sweep.lastEscalationAt || 0 };
  }

  function nudge(root, content, at) {
    (root.inbox ||= []).push({ role: "system", authorId: "sweeper", at: new Date(at).toISOString(), content });
    if (["waiting", "blocked", "queued"].includes(root.state)) { root.state = "queued"; root.wakeAt = at; delete root.recoveryReviewRequired; }
    root.updatedAt = at;
    if (wake) wake(root);
  }

  function tick() {
    const at = now();
    if (d.paused || killSwitch?.state().engaged || config?.sweeperEnabled === false) return { skipped: true, actions: [] };
    const t = trust(d), actions = [], owner = [];
    for (const [n, jobs] of ticketsOf()) {
      let s; try { s = snapshot(n, jobs, at); } catch (e) { log(`sweeper: ticket ${n}: ${e.message}`); continue; }
      if (!s) continue;
      const decision = decideTicket(s, at, c);
      if (decision.action === "none" || actions.length >= c.maxActionsPerSweep) continue;
      const rec = (t.sweeps[n] ||= {});
      if (decision.action === "investigate" || decision.action === "investigate_worker") {
        let out = null;
        if (investigate) { try { out = investigate(s.root, { reason: decision.reason }); } catch (e) { log(`sweeper: ticket ${n}: investigation dispatch: ${e.message}`); } }
        if (out && !out.skipped) { Object.assign(rec, { at, kind: "investigate_worker", reason: decision.reason, runId: out.run?.id }); }
        else if (decision.action === "investigate_worker") {
          // Nothing could be started (switched off, skip list, budget spent): a card must not just wait, so a person is told.
          if (t.sweeps[n]?.lastEscalationAt && at - t.sweeps[n].lastEscalationAt < c.ownerRepingMs) { actions.push({ ticket: n, action: "none", reason: "owner already told" }); continue; }
          const why = `${decision.reason}; no investigation worker could be started (${out?.reason || "unavailable"})`;
          owner.push(`Ticket ${n} needs a person: ${why}.`);
          Object.assign(rec, { at, kind: "escalate_owner", reason: why, lastEscalationAt: at });
          actions.push({ ticket: n, action: "escalate_owner", reason: why });
          ledger.audit("sweeper_action", { ticket: n, action: "escalate_owner", reason: why });
          continue;
        } else {
        nudge(s.root, `Stuck-ticket sweep: ${decision.reason}. Read the ticket from the start, establish what is actually new, then do one of: post a substantive update (a finding, a fix state change or an answer to what the player asked; never "still checking"), hand the investigation to the right owner, or finish with a concrete next action. Do not repeat an earlier post.`, at);
        Object.assign(rec, { at, kind: "investigate", reason: decision.reason });
        }
      } else if (decision.action === "notice_player_once") {
        nudge(s.root, "A decision on this ticket is waiting for the owner. Tell the player once, in plain words, that it awaits approval. Do not decide it, promise an outcome, or resolve the ticket.", at);
        Object.assign(rec, { playerNoticedFor: s.pendingDecision.id, noticeAt: at });
      } else if (decision.action === "escalate_owner") {
        owner.push(`Ticket ${n} needs a person: ${decision.reason}.`);
        Object.assign(rec, { at, kind: "escalate_owner", reason: decision.reason, lastEscalationAt: at });
      }
      actions.push({ ticket: n, ...decision });
      ledger.audit("sweeper_action", { ticket: n, action: decision.action, reason: decision.reason });
    }
    if (owner.length) ledger.notify(`sweeper-owner:${at}`, "owner", `Keir sweep, ${owner.length} item${owner.length === 1 ? "" : "s"}:\n${owner.slice(0, 12).map((l) => `- ${l}`).join("\n")}`);
    if (actions.length || owner.length) ledger.save();
    t.lastSweepAt = at;
    return { skipped: false, actions };
  }
  return { tick, snapshot, status: () => ({ lastSweepAt: trust(d).lastSweepAt || null, tracked: Object.keys(trust(d).sweeps).length }) };
}

module.exports = { DEFAULTS, decideTicket, inActiveHours, createSweeper };
