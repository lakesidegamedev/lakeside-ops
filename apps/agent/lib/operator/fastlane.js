"use strict";
// Keir 7: one Keir, two speeds. A ticket that only asks how the game works is
// answered by Ask Keir's question pipeline (about 20K tokens, under a minute)
// instead of a full agent run (a median 4.4M tokens per ticket the week of
// 2026-10-25). The agent runs only when the ticket needs investigation or an
// action, and then it starts with whatever the fast lane already found.
//
// The fast lane is read-only by construction: it calls Ask, which has no write
// tools, and posts through the broker's own channel_reply and finish, so every
// player-copy, figure and ownership guard still applies. Player text never
// reaches a tool that can change anything. KEIR_FAST_LANE=0 turns it off.

const ANSWER_KINDS = new Set(["mechanics_question"]);
const REDIRECT_KINDS = new Set(["gameplay_advice"]);
const MIN_CONFIDENCE = 0.7;
const MAX_ANSWERS = 2;
// Ask's own checks. Any of these means the answer is not safe to post as is.
const BLOCKING_ISSUES = new Set(["refused_with_live_evidence", "truncated", "narrated_evidence_bundle", "insufficient_evidence", "player_frustrated"]);
// A follow-up that says the answer did not help, or that something is broken,
// goes to the agent.
const PUSHBACK = /\b(?:wrong|incorrect|not what i|doesn.?t (?:help|answer|work)|didn.?t (?:help|answer|work)|still (?:broken|wrong|not)|bug|broken|error|missing|lost|disappeared|refund|compensat|help me fix)\b/i;

function humanMessages(job) {
  const author = job.source?.authorId;
  const fresh = (job.inbox || []).filter((m) => m && m.role !== "system" && m.role !== "assistant" && (!author || m.authorId === author) && String(m.content || "").trim());
  if (!(job.history || []).length && !(job.fastLane?.answers || 0)) return [job.source, ...fresh].filter((m) => m && String(m.content || "").trim());
  return fresh;
}

function attachmentsIn(messages) {
  return messages.reduce((n, m) => n + (m.attachments || []).length, 0);
}

// Decide before any model runs. Returns { kind: "answer" | "redirect", question } or { skip: reason }.
function plan(job, config = {}, tags = job.tags || {}) {
  if (config.fastLane === false) return { skip: "off" };
  if (job.kind !== "ticket" || !job.ticket || job.role !== "support") return { skip: "not a ticket" };
  if (job.codingParent || job.internalProbe || job.voiceMode || job.channelClosed) return { skip: "not player work" };
  if (job.fastLane?.escalated) return { skip: "escalated" };
  if ((job.fastLane?.answers || 0) >= MAX_ANSWERS) return { skip: "answer budget spent" };
  if (job.pullRequests?.length || job.incidentCandidates?.length || job.ownerDecisionPending) return { skip: "work in progress" };
  if (job.activationInternalWake) return { skip: "internal wake" };
  if (tags.injection) return { skip: "injection" };
  if (tags.urgency === "outage") return { skip: "outage" };
  const answer = ANSWER_KINDS.has(tags.kind), redirect = REDIRECT_KINDS.has(tags.kind);
  if (!answer && !redirect) return { skip: `kind ${tags.kind || "unknown"}` };
  if (!(Number(tags.kindConfidence) >= MIN_CONFIDENCE)) return { skip: "unsure kind" };
  const messages = humanMessages(job);
  if (!messages.length) return { skip: "no new player message" };
  if (attachmentsIn(messages)) return { skip: "attachment" };
  const question = messages.map((m) => String(m.content).trim()).join("\n").slice(0, 2000);
  if (job.fastLane?.answers && PUSHBACK.test(question)) return { skip: "pushback" };
  return { kind: answer ? "answer" : "redirect", question };
}

// Parse a finished Ask SSE body into its done event.
function doneEvent(body) {
  let done = null, error = null;
  for (const block of String(body || "").split(/\n\n+/)) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!event || !data) continue;
    try {
      if (event === "done") done = JSON.parse(data);
      else if (event === "error") error = JSON.parse(data);
    } catch {}
  }
  return { done, error };
}

async function askKeir({ question, job, reporter, config, fetcher = fetch, timeoutMs = config.askTimeoutMs || 150000, signal }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const res = await fetcher(`${config.askUrl}/api/keir-ask/answer`, {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.askSecret}` },
      body: JSON.stringify({
        question, discordId: String(job.source?.authorId || ""), discordUsername: String(job.source?.author || "player"),
        convId: `keir-ticket-${job.ticket}`,
        requester: reporter ? { characterName: reporter.characterName || reporter.name || undefined, country: reporter.country || undefined, corporationName: reporter.corporationName || undefined } : undefined,
      }),
    });
    const text = await res.text();
    if (!res.ok) return { error: `ask ${res.status}` };
    const { done, error } = doneEvent(text);
    if (error && !done) return { error: `ask error ${String(error.error || error.message || "").slice(0, 120)}` };
    return done ? { done } : { error: "ask returned no answer" };
  } catch (e) {
    return { error: ac.signal.aborted ? "ask timeout" : `ask ${String(e.message || e).slice(0, 120)}` };
  } finally { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); }
}

// Is Ask's answer safe to post unchanged? Returns null when it is, else the reason.
function rejectReason(done) {
  const answer = String(done?.answer || "").trim();
  if (!answer) return "empty answer";
  const v = done.validation || {};
  const blocking = (v.issues || []).filter((i) => BLOCKING_ISSUES.has(i));
  if (blocking.length) return `ask flagged ${blocking.join(", ")}`;
  if ((v.grounding || []).length) return "ask grounding notes";
  if ((v.inventedPaths || []).length) return "ask cited unseen sources";
  const a = v.attribution;
  if (a && Number.isFinite(Number(a.coverage)) && Number(a.coverage) < 0.6) return `low attribution ${Number(a.coverage).toFixed(2)}`;
  if (/^>\s/m.test(answer)) return "answer carries a caveat";
  return null;
}

function createFastLane({ ledger, broker, config, fetcher, numbersIn, tagIntake, recordUsage = () => {}, now = () => Date.now() }) {
  async function attempt(job, signal) {
    // A follow-up is judged on what the player just wrote, not on the
    // ticket's first message: a question can turn into a bug report.
    let tags = job.tags || {};
    if (job.fastLane?.answers && !job.fastLane.escalated && plan(job, config, tags).question) {
      const fresh = humanMessages(job);
      try { tags = await tagIntake({ ...job, source: fresh[0], inbox: fresh.slice(1), requestInbox: [] }) || { kind: null }; } catch { tags = { kind: null }; }
    }
    const p = plan(job, config, tags);
    if (p.skip) return { handled: false, reason: p.skip };
    const lane = (job.fastLane ||= { answers: 0 });
    const started = now();
    const note = (state, extra = {}) => { lane.last = { at: new Date(now()).toISOString(), state, ...extra }; ledger.audit("fast_lane", { job: job.id, ticket: job.ticket, route: p.kind, state, ...extra }); };
    let message;
    if (p.kind === "redirect") {
      message = require("./advicerouting").REPLY;
    } else {
      if (!config.askSecret) { note("skipped", { reason: "no ask secret" }); return { handled: false, reason: "no ask secret" }; }
      let reporter = null;
      try { reporter = await broker.tool(job, "reporter_state", {}, signal); } catch {}
      const r = await askKeir({ question: p.question, job, reporter, config, fetcher, signal });
      if (r.error) { note("escalated", { reason: r.error, ms: now() - started }); lane.escalated = true; ledger.save(); return { handled: false, reason: r.error }; }
      const reason = rejectReason(r.done);
      if (reason) {
        lane.escalated = true; lane.draft = String(r.done.answer || "").slice(0, 2000);
        note("escalated", { reason, ms: now() - started, model: r.done.modelId || null });
        ledger.save();
        return { handled: false, reason, draft: lane.draft };
      }
      message = String(r.done.answer).trim();
      // Ask grounded these figures against its own evidence; the broker's
      // figure check accepts numbers that are in this activation's evidence.
      job.evidence = [...(job.evidence || []), ...numbersIn(message).map((n) => n.value)];
      job.evidenceText = (String(job.evidenceText || "") + "\n[ask_keir] " + message).slice(-20000);
      lane.model = r.done.modelId || null;
      lane.tokens = r.done.tokens || null;
    }
    try {
      // The ticket's own support update: delivered as a reply, receipted by
      // the support service, and guarded exactly like the agent's posts.
      await broker.tool(job, "support_action", { tool: "support_public_update", args: { message } }, signal);
    } catch (e) {
      // A refused post (too long, a guard) goes to the agent with the draft.
      lane.escalated = true; lane.draft = message.slice(0, 2000);
      delete job.replyRefusedPending;
      note("escalated", { reason: `post refused: ${String(e.message).slice(0, 160)}`, ms: now() - started });
      ledger.save();
      return { handled: false, reason: "post refused", draft: lane.draft };
    }
    lane.answers += 1;
    await broker.tool(job, "finish", {
      state: "waiting", waitFor: "player_reply",
      summary: p.kind === "redirect" ? "Directed gameplay advice to Ask." : "Answered the player's question from Ask Keir; waiting for the player.",
    }, signal);
    note("answered", { ms: now() - started, model: lane.model || null });
    recordUsage(job, { ms: now() - started, model: lane.model, tokens: lane.tokens, kind: p.kind });
    ledger.save();
    return { handled: true, kind: p.kind };
  }
  return { attempt };
}

module.exports = { createFastLane, plan, rejectReason, doneEvent, askKeir, humanMessages, ANSWER_KINDS, REDIRECT_KINDS, MAX_ANSWERS };
