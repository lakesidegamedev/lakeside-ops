"use strict";
const { JOB_TERMINAL } = require("./machines");
// Keir 5.7 (owner, 2026-10-16): "use Jev to automatically log and track
// feedback and review past ticket interactions once per day to self improve".
//
// 1. Feedback log. Every human message that could be about Keir (a ticket
//    channel, a DM, or text naming Keir) gets one bundled Jev call, fire and
//    forget, never blocking intake. Feedback about Keir or how a ticket is
//    being handled is logged with its kind and severity in d.feedbackLog.
//    Jev fails open: no key or no verdict means nothing is logged.
// 2. Daily review. Once a day (KEIR_SELF_REVIEW_HOUR, America/New_York,
//    default 5) one review task reads the last day's feedback, the tickets
//    Keir worked and its own stall recoveries, reads the real conversations,
//    saves evidence-backed lessons with `remember`, and files systemic fixes
//    on its own board with raise_to_developers. It never posts to a player.
const JEV = "/root/bin/lib/jev.mjs";
const defaultAsk = (spec) => process.env.KEIR_JEV === "off" ? Promise.resolve(null) : import(JEV).then((m) => m.ask(spec));
const FEEDBACK_KINDS = {
  slow_or_silent: "Complains the bot is slow, silent, stuck, ignoring them, not answering, or not doing the work.",
  wrong_or_misleading: "Says the bot was wrong, made something up, contradicted itself, lied or broke a promise.",
  tone: "Objects to the bot's tone, wording, length, jokes or attitude.",
  praise: "Thanks or praises the bot or the way the ticket was handled.",
  behaviour_request: "Asks the bot or its developers to change how the bot works or behaves.",
  bot_bug: "Reports the bot itself malfunctioning: duplicate posts, broken messages, leaked internals, wrong channel.",
  not_feedback: "Not about the bot or the support handling: a game question, game bug, chatter or banter between players.",
};
const SEVERITY = ["minor", "notable", "serious"];
const KEEP = 1000;
const DAY_MS = 24 * 3600000;

function easternParts(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function createFeedbackLog({ ledger, ask = defaultAsk, now = () => Date.now(), log = () => {}, timeoutMs = 5000 }) {
  const d = ledger.data;
  const inFlight = new Set();
  function relevant({ text, ticket, dm, mentionsKeir }) {
    const t = String(text || "").trim();
    if (t.length < 3 || /^https?:\/\/\S+$/.test(t)) return false;
    return Boolean(ticket || dm || mentionsKeir || /\b(?:keir|keith|starmer|the bot|support bot)\b/i.test(t));
  }
  async function observe(entry) {
    try {
      if (!relevant(entry) || inFlight.has(entry.messageId) || (d.feedbackSeen || {})[entry.messageId]) return null;
      inFlight.add(entry.messageId);
      const out = await ask({
        state: { text: String(entry.text).slice(0, 1200), author: entry.role, ticket: entry.ticket || null, place: entry.dm ? "direct message" : entry.ticket ? "support ticket channel" : "community channel" },
        questions: {
          feedback: { type: "noul", instructions: "Is this message feedback about Keir (also called Keith or Starmer, the support bot for the game A House Divided) or about how this support ticket is being handled?", criteria: { true: "It reacts to the bot's replies, speed, accuracy, tone or behaviour, or to the handling of the ticket.", false: "It is about the game itself, a player's own situation, or chatter that does not judge the bot or the handling." } },
          kind: { type: "choice", instructions: "What kind of feedback is it?", criteria: FEEDBACK_KINDS },
          severity: { type: "score", instructions: "How serious is this for trust in the bot?", criteria: SEVERITY },
        },
        timeoutMs,
      }).catch(() => null);
      const p = Number(out?.answers?.feedback?.noul);
      (d.feedbackSeen ||= {})[entry.messageId] = now();
      const seenKeys = Object.keys(d.feedbackSeen); if (seenKeys.length > 4000) for (const k of seenKeys.slice(0, seenKeys.length - 4000)) delete d.feedbackSeen[k];
      const kind = String(out?.answers?.kind?.choice || "");
      if (!Number.isFinite(p) || p < 0.6 || !(kind in FEEDBACK_KINDS) || kind === "not_feedback") { ledger.save(); return null; }
      const s = Number(out?.answers?.severity?.score);
      const item = { at: now(), messageId: entry.messageId, channelId: entry.channelId, ticket: entry.ticket || null, role: entry.role, kind,
        severity: Number.isFinite(s) ? SEVERITY[Math.max(0, Math.min(SEVERITY.length - 1, Math.round(s)))] : null, probability: p, text: String(entry.text).replace(/\s+/g, " ").slice(0, 300) };
      d.feedbackLog = [...(d.feedbackLog || []), item].slice(-KEEP);
      ledger.audit("feedback_logged", { ticket: item.ticket, kind, severity: item.severity, role: item.role });
      ledger.save();
      log(`feedback logged: ${kind}${item.ticket ? ` on ticket ${item.ticket}` : ""}`);
      return item;
    } catch (e) { log(`feedback log: ${String(e.message).slice(0, 160)}`); return null; }
    finally { inFlight.delete(entry.messageId); }
  }
  return { observe, relevant };
}

function reviewBrief(d, since, until) {
  const feedback = (d.feedbackLog || []).filter((f) => f.at >= since && f.at < until);
  const tickets = Object.values(d.jobs || {}).filter((j) => j.kind === "ticket" && j.ticket && (Number(j.updatedAt) || Date.parse(j.updatedAt || "") || 0) >= since)
    .map((j) => `- Ticket ${j.ticket}: ${j.state}, ${j.rounds || 0} rounds. ${String(j.summary || "").replace(/\s+/g, " ").slice(0, 220)}`);
  const recoveries = (d.recoveries || []).filter((r) => r.at >= since && r.at < until).map((r) => `- ${r.action}${r.ticket ? ` ticket ${r.ticket}` : ""}: ${String(r.reason || "").slice(0, 140)}`);
  // Keir 10: the review starts from the lowest-scored closed tickets (max 4), not a sample of all of them.
  const worstLines = require("./ticketscore").worst(d, { since: until - 3 * DAY_MS, limit: 4, below: 80 })
    .map((t) => `- Ticket ${t.ticket} (${t.lane}, score ${t.score}/100): ${Object.entries(t.penalties).map(([k, v]) => `${k} -${v}`).join(", ") || "no penalties"}`);
  const fb = feedback.map((f) => `- [${f.kind}${f.severity ? `, ${f.severity}` : ""}] ${f.ticket ? `ticket ${f.ticket}, ` : ""}${f.role}: "${f.text}"`);
  return { feedback, text: [
    `Daily self-review for the 24 hours ending ${new Date(until).toISOString()}.`,
    "", `Feedback logged about Keir (${fb.length}):`, ...(fb.length ? fb.slice(0, 40) : ["- none"]),
    "", `Tickets worked (${tickets.length}):`, ...(tickets.length ? tickets.slice(0, 40) : ["- none"]),
    "", `Worst closed tickets of the last 3 days, lowest score first (${worstLines.length}):`, ...(worstLines.length ? worstLines : ["- none below the bar"]),
    "", `Self-recoveries (stalls, spins, unknown waits) (${recoveries.length}):`, ...(recoveries.length ? recoveries.slice(0, 40) : ["- none"]),
    "", "Do this:",
    "1. Read the actual conversations (support_get and ticket_history) for the worst closed tickets above first, then every ticket with feedback or a self-recovery.",
    "2. Find recurring patterns in how you handled them: silence or slow replies, wrong or unverified claims, broken promises, stalls on an unknown outcome, asking players for what you could look up, tone, and what went well.",
    "3. For each distinct, evidence-backed pattern, call remember with kind lesson: one plain sentence saying what to do differently next time, citing the ticket. Start the text with the lane it belongs to, [lane:question], [lane:bug], [lane:outage], [lane:account] or [lane:idea], so the lesson is served with that lane's playbook and never added to the brief. Supersede older lessons that this contradicts, with a reason. At most 6 lessons; no lesson without evidence.",
    "4. For a pattern that needs a code or process change in Keir, call raise_to_developers kind question on your own board with the evidence. Do not duplicate an open card.",
    "5. Do not post in any ticket or channel and do not contact players. Finish done with a 3 to 5 line summary: what you learned and what you filed.",
  ].join("\n") };
}

function createDailyReview({ ledger, config = {}, now = () => Date.now(), hour = 5, log = () => {}, drain = () => {} }) {
  const d = ledger.data;
  function tick() {
    if (d.paused || !config.ownerId) return null;
    const st = (d.selfReview ||= { runs: [] });
    for (const r of st.runs) if (!r.summary && d.jobs[r.job] && ["done", "dismissed", "cancelled", "blocked"].includes(d.jobs[r.job].state)) {
      r.summary = String(d.jobs[r.job].summary || "").slice(0, 1200); r.state = d.jobs[r.job].state; r.finishedAt = now();
    }
    const e = easternParts(now());
    if (e.hour < hour || st.lastDay === e.day) return null;
    if (Object.values(d.jobs).some((j) => j.selfReview && !JOB_TERMINAL.includes(j.state))) return null;
    st.lastDay = e.day;
    const until = now(), since = until - DAY_MS;
    const brief = reviewBrief(d, since, until);
    const key = `self-review:${e.day}`;
    const job = ledger.createJob(key, { kind: "command", role: "owner", actorId: config.ownerId, channelId: "keir-self-review", noOwnerDm: true,
      source: { authorId: config.ownerId, messageId: key, content: brief.text, at: new Date(until).toISOString() }, deadline: until + 3 * 3600000 });
    job.selfReview = { day: e.day, feedback: brief.feedback.length };
    for (const f of brief.feedback) f.reviewedOn = e.day;
    st.runs = [...st.runs, { day: e.day, job: job.id, at: until, feedback: brief.feedback.length }].slice(-30);
    ledger.audit("self_review_started", { job: job.id, day: e.day, feedback: brief.feedback.length });
    ledger.save(); log(`self-review started for ${e.day}: ${brief.feedback.length} feedback items`); drain();
    return job;
  }
  return { tick };
}

module.exports = { createFeedbackLog, createDailyReview, reviewBrief, FEEDBACK_KINDS, SEVERITY, easternParts };
