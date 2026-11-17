"use strict";
// Keir 10.1.9 closing rule (owner, 2026-11-17): Keir never closed tickets. Tickets 1836, 1837, 1838, 1841 and 1842
// sat answered and "waiting" with "awaiting auto-close" because nothing defined how long quiet is and the
// question lane told the model not to resolve. This is the deterministic closer. A ticket is resolved, through
// the normal support_resolve path (attribution, receipt, resolution copy), when
//   (a) the player confirmed the fix or the answer worked, or
//   (b) the fix is live for players and the player has been quiet for 6 hours, or
//   (c) the question was answered and the player has been quiet for 6 hours.
// Never when the owner holds closure, an owner decision is open, a developer handoff is open, the ticket is held
// or paused, or the player's last message is unanswered.
const HOUR = 3600000, MIN = 60000;
const QUIET_MS = 6 * HOUR;
const standdown = require("./standdown");
const BUG_LANES = new Set(["bug", "data_repair", "outage"]);

// A confirmation is a thanks or a "that worked" with no new question and no "still broken".
const CONFIRM = /\b(?:thanks?|thank you|thx|ty|cheers|appreciate(?:d)?|perfect|great|awesome|nice one|that (?:did it|works?|worked|fixed it|solved it|explains it)|(?:it(?:'s| is| now)?|now (?:it(?:'s| is)?)?|all) (?:works?|working|fixed|sorted|good|resolved)|(?:works?|working|fixed|sorted|resolved|solved) now|got it|makes sense|all good|all sorted)\b/i;
const NOT_CONFIRM = /\?|\b(?:but|however|still|yet|except|not (?:fixed|working|resolved|solved|right)|doesn'?t|don'?t|isn'?t|wasn'?t|won'?t|can'?t|cannot|broken|wrong|again|why|how|what|when|where|which)\b/i;
function isConfirmation(text) {
  const t = String(text || "").trim();
  return t.length > 0 && t.length <= 280 && CONFIRM.test(t) && !NOT_CONFIRM.test(t.replace(/\bthanks? (?:for|anyway)\b/ig, "thanks"));
}

const COPY = Object.freeze({
  a: "Glad that sorted it. I am closing this ticket now. If anything else comes up, open a new one and we will pick it up.",
  b: "The fix is live and we have not heard anything since, so I am closing this ticket. If it still looks wrong to you, reply here and it will be reopened.",
  c: "Your question is answered and it has been quiet since, so I am closing this ticket. If you need anything else, reply here or open a new one.",
});

// Pure decision for one ticket snapshot. Returns { action: "close"|"none", rule, reason }.
function decideClose(t, now, cfg = {}) {
  const quiet = cfg.quietMs ?? QUIET_MS;
  const none = (reason) => ({ action: "none", reason });
  if (!t.open) return none("closed");
  if (t.running) return none("being worked");
  if (t.ownerClosureHold) return none("owner closure hold");
  if (t.pendingDecision) return none("owner decision open");
  if (t.pendingHandoffs) return none("developer handoff open");
  if (t.held) return none(`held: ${t.held}`);
  if (t.lastHumanUnanswered) return none("the player's last message is unanswered");
  const answeredAt = Math.max(t.answeredAt || 0, t.liveAt || 0);
  if (!answeredAt) return none("not answered yet");
  // A player message newer than Keir's last reply that is not a confirmation is owed an answer.
  const humanAt = t.lastHumanAt || 0;
  if (humanAt > (t.lastReplyAt || 0) && !t.confirmed) return none("the player wrote after the last reply");
  // A confirmation that is the player's latest message counts even if Keir acknowledged it afterwards: compare it with the
  // last answer before the confirmation (answerBeforeHumanAt), not with Keir's latest publish.
  const priorAnswer = t.answerBeforeHumanAt ?? answeredAt;
  if (t.confirmed && humanAt >= priorAnswer) return { action: "close", rule: "a", reason: "the player confirmed it worked" };
  // The player's silence runs from the first answer after their last message, so later Keir posts and card edits never
  // restart it. Without channel rows, fall back to the ledger's latest reply.
  const silent = t.firstAnswerAfterHumanAt ? Math.max(humanAt, t.firstAnswerAfterHumanAt) : Math.max(humanAt, t.lastReplyAt || 0, answeredAt);
  if (now - silent < quiet) return none(`quiet for ${Math.round((now - silent) / MIN)} min, needs ${Math.round(quiet / MIN)}`);
  if (t.liveAt && now - t.liveAt >= quiet && now - humanAt >= quiet) return { action: "close", rule: "b", reason: "the fix is live and the player has been quiet for 6 hours" };
  // Keir 10.1.14 (ticket 1838): "your question is answered" over a still-open "still being looked into". An answer that
  // is not the last word cannot be closed on while the latest staff or bot post promises a follow-up that never came.
  if (t.promisedFollowUp) return none("a follow-up was promised and has not come");
  if (t.answeredAt && !t.fixPending && !(BUG_LANES.has(t.lane) && !t.liveAt)) return { action: "close", rule: "c", reason: "the question was answered and the player has been quiet for 6 hours" };
  return none("a fix is still in progress");
}

function createAutoCloser({ ledger, broker, config, now = () => Date.now(), log = () => {}, held = () => null, killSwitch = null, cardDone = null, cfg = {}, maxPerTick = 3, retryMs = HOUR }) {
  const d = ledger.data;
  const ts = (v) => { const n = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(n) ? n : 0; };
  const isStaff = (id) => id === config.ownerId || (config.staffIds || []).includes(id);

  function rootsByTicket() {
    const by = new Map();
    for (const j of Object.values(d.jobs)) {
      if (j.kind !== "ticket" || !Number.isSafeInteger(j.ticket) || j.ticket <= 0) continue;
      const cur = by.get(j.ticket);
      if (!cur || (j.at || 0) > (cur.at || 0)) by.set(j.ticket, j);
    }
    return by;
  }

  // A developer handoff is satisfied once the fix is verified live after it was raised, or its linked GitHub issue is closed.
  // developerwatch releases done cards for blocking handoffs; this covers the rest (fix-pending cards nobody released).
  function releaseSatisfied(jobs, n, at) {
    const live = d.liveSaid?.[n] || 0;
    for (const j of jobs) for (const r of j.raisedToDevelopers || []) {
      if (r.selfOwned || r.releasedAt) continue;
      const issue = r.issue != null ? d.keirIssues?.[r.issue] : null;
      const why = live && live >= (r.at || 0) ? "fix_live" : issue?.state === "closed" ? "issue_closed" : null;
      if (!why) continue;
      r.releasedAt = at; r.releasedBy = `autoclose:${why}`;
      ledger.audit("developer_handoff_released", { job: j.id, ticket: n, item: r.id, reason: why });
    }
  }

  // Cheap checks from the ledger alone. Discord is read only for tickets that pass.
  function snapshot(root) {
    const n = root.ticket;
    const jobs = Object.values(d.jobs).filter((j) => j.ticket === n);
    releaseSatisfied(jobs, n, now());
    const coordinator = d.jobs[d.seen?.[`ticket:${n}`]];
    const closed = root.channelClosed || root.resolved || root.resolutionSubmitted || ["done", "cancelled", "dismissed"].includes(root.state);
    const pending = Object.values(d.decisions || {}).some((x) => x.state === "pending" && jobs.some((j) => j.id === x.jobId));
    const handoffs = jobs.some((j) => (j.raisedToDevelopers || []).some((r) => r.blocking && r.id && !r.releasedAt && !r.selfOwned));
    const fixPending = handoffs || jobs.some((j) => (j.raisedToDevelopers || []).some((r) => !r.selfOwned && !r.releasedAt && r.kind !== "question"));
    const lastHumanAt = Math.max(0, ...jobs.map((j) => Math.max(ts(j.observedPlayerAt), ts(j.lastPlayerAt))));
    const lastReplyAt = Math.max(0, ...jobs.map((j) => ts(j.lastPublishedAt)));
    const shared = coordinator && coordinator.ticket === n && coordinator.channelId === root.channelId ? coordinator.resolutionReadyAt || 0 : 0;
    return {
      ticket: n, root, lane: root.lane, open: !closed && root.state === "waiting",
      running: jobs.some((j) => j.state === "running" || j.state === "queued"),
      ownerClosureHold: Boolean(jobs.some((j) => j.ownerClosureHold) || coordinator?.ownerClosureHold),
      pendingDecision: pending || jobs.some((j) => j.ownerDecisionPending),
      pendingHandoffs: handoffs, fixPending,
      held: (root.ticketPaused && "paused by the owner") || held(root) || null,
      answeredAt: shared || root.resolutionReadyAt || 0, liveAt: d.liveSaid?.[n] || 0,
      lastHumanAt, lastReplyAt, lastHumanUnanswered: false, confirmed: false,
    };
  }

  // Fold the real channel history into the snapshot: the player's last words decide confirmation and unanswered.
  function readRows(s, rows) {
    const isAnswer = (m) => m.author?.bot || isStaff(m.author?.id);
    const human = rows.filter((m) => !isAnswer(m)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    // Bot and staff posts from any path (StarmerBot, support_public_update) answer the player, not only Keir's own jobs.
    const answers = rows.filter(isAnswer);
    const lastAnswerAt = Math.max(0, ...answers.map((m) => ts(m.timestamp)));
    const base = { ...s, lastReplyAt: Math.max(s.lastReplyAt, lastAnswerAt), promisedFollowUp: standdown.outstandingPromise(rows, isAnswer) };
    const last = human.at(-1);
    if (!last) return base;
    const at = ts(last.timestamp);
    const after = answers.filter((m) => BigInt(m.id) > BigInt(last.id)), before = answers.filter((m) => BigInt(m.id) < BigInt(last.id));
    const out = { ...base, lastHumanAt: Math.max(s.lastHumanAt, at), lastHumanTs: at,
      firstAnswerAfterHumanAt: after.length ? Math.min(...after.map((m) => ts(m.timestamp))) : 0,
      answerBeforeHumanAt: Math.max(0, ...before.map((m) => ts(m.timestamp))) };
    const answeredAfter = after.length > 0;
    out.confirmed = isConfirmation(last.content);
    out.lastHumanUnanswered = !out.confirmed && !answeredAfter && (/\?/.test(String(last.content || "")) || ts(last.timestamp) > out.lastReplyAt);
    return out;
  }

  async function readRows_(job, signal) {
    const was = job.state;
    job.state = "running";
    try { return await broker.supportAuthority(job, ["running"]); } finally { if (job.state === "running") job.state = was; }
  }

  async function closeOne(s, decision, signal) {
    const job = s.root, was = job.state;
    // The closing line goes out through the same support_resolve path the model uses; the task is "running" only for this call.
    job.state = "running";
    try {
      if (!job.resolutionReadyAt && job.lastPublishedAt) job.resolutionReadyAt = ts(job.lastPublishedAt);
      // A confirmation was read and classified here, so it counts as seen; otherwise the resolve gate would refuse it as an unread reply.
      if (decision.rule === "a" && s.lastHumanTs) job.observedPlayerAt = Math.max(ts(job.observedPlayerAt), s.lastHumanTs);
      return await broker.tool(job, "support_action", { tool: "support_resolve", args: { message: COPY[decision.rule] } }, signal);
    } finally { if (job.state === "running") job.state = was; }
  }

  async function tick(signal) {
    const at = now(), closed = [], skipped = [];
    if (d.paused || killSwitch?.state?.().engaged || config.autoCloseEnabled === false) return { skipped: true, closed };
    for (const [n, root] of rootsByTicket()) {
      if (closed.length >= maxPerTick) break;
      let s;
      try { s = snapshot(root); } catch (e) { log(`autoclose: ticket ${n}: ${e.message}`); continue; }
      // A handoff whose kanban card is done is satisfied (developerwatch only tracks blocking ones).
      if (s.open && cardDone && (s.pendingHandoffs || s.fixPending)) {
        let released = false;
        for (const j of Object.values(d.jobs).filter((x) => x.ticket === n)) for (const r of j.raisedToDevelopers || []) {
          if (r.selfOwned || r.releasedAt || !r.id) continue;
          try { if (await cardDone(r.id)) { r.releasedAt = at; r.releasedBy = "autoclose:card_done"; released = true; ledger.audit("developer_handoff_released", { job: j.id, ticket: n, item: r.id, reason: "card_done" }); } } catch (e) { log(`autoclose: card ${r.id}: ${e.message}`); }
        }
        if (released) { ledger.save(); s = snapshot(root); }
      }
      if (!s.open || !(s.answeredAt || s.liveAt || root.lastPublishedAt)) continue;
      if (root.autoClose?.at && at - root.autoClose.at < retryMs) continue;
      // Ledger-only gate first: skip tickets that cannot close whatever the channel says.
      if (!s.answeredAt && root.lastPublishedAt) s.answeredAt = ts(root.lastPublishedAt);
      const pre = decideClose({ ...s, confirmed: true, lastHumanUnanswered: false, answerBeforeHumanAt: 0 }, at + QUIET_MS * 2, cfg);
      if (pre.action === "none") continue;
      try {
        const rows = await readRows_(root, signal);
        s = readRows(s, rows);
        const decision = decideClose(s, at, cfg);
        if (decision.action !== "close") continue;
        await closeOne(s, decision, signal);
        root.autoClose = { at, rule: decision.rule, closed: true };
        ledger.audit("ticket_auto_closed", { job: root.id, ticket: n, rule: decision.rule, reason: decision.reason });
        closed.push({ ticket: n, rule: decision.rule });
      } catch (e) {
        // Refused (grace not over, new reply, policy): remember when, retry later, never spin.
        root.autoClose = { at, error: String(e.message || e).slice(0, 300) };
        ledger.audit("ticket_auto_close_refused", { job: root.id, ticket: n, error: root.autoClose.error });
        skipped.push({ ticket: n, error: root.autoClose.error });
      }
    }
    if (closed.length || skipped.length) ledger.save();
    return { skipped: false, closed, refused: skipped };
  }
  return { tick, snapshot, readRows };
}

module.exports = { decideClose, createAutoCloser, isConfirmation, COPY, QUIET_MS };
