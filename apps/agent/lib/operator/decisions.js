"use strict";
// Owner decisions (owner policy 2026-10-12). A genuine decision is DMed to the
// owner with Approve / Reject / Explain buttons. Unanswered after three hours it
// also goes to the delegate (Ariane), who may answer on the owner's behalf.
//
// Keir 4.0 (owner, 2026-10-14): nothing ships to the live server without a
// sign-off. It goes to the owner first and to Ariane only after three hours
// unanswered; whoever answers first, every copy is then deleted. Every copy of
// any request is deleted once it is answered, expires or is no longer needed,
// so the DMs only ever hold live questions. Unanswered requests expire with their action (24
// hours for most) or after two days when they carry no action.
//
// The buttons are handled by adhd-bot, which holds the Discord connection: it
// checks the clicker is the owner or delegate (Discord vouches for who clicked),
// stamps the verdict onto this same bot-authored DM and pokes the operator. The
// operator re-reads the DM from Discord and trusts only a verdict line appended
// after the text it sent. Nothing in the poke itself is trusted.
const crypto = require("node:crypto");
const { makeSpark } = require("./spark");
const authority = require("./authority");
const musePolicy = require("./ownermuse-policy");
const { rootJob } = require("./workrecord");

// Owner, 2026-10-16: decisions go to the owner first (app, then Discord DM).
// Only if he stays unreachable do they go to the support delegate, and only
// for ticket, incident and other game-issue work. Development work the owner
// started himself is his alone and never goes to the delegate.
function ownerInitiated(d, config, job) {
  const root = rootJob(job, d.jobs) || job;
  if (!root) return false;
  if (root.ticket || ["ticket", "finding", "incident"].includes(root.kind)) return false;
  const app = root.replyChannel && root.source?.channelId === root.replyChannel && String(root.replyChannel).startsWith("app");
  return root.actorId === config.ownerId || root.source?.authorId === config.ownerId || Boolean(app);
}

const ESCALATE_MS = 3 * 3600000;
const PLAIN_EXPIRY_MS = 48 * 3600000;
const VERDICT = /\n\n\*\*Decision:\*\* (✅ Approved|❌ Rejected|💬 Explain) (?:by|from) <@(\d{15,22})>(?: <t:\d+:R>)?(?::\s*([\s\S]*))?$/;
const KIND = { "✅ Approved": "approve", "❌ Rejected": "reject", "💬 Explain": "explain" };

function buttons(id) {
  return [{ type: 1, components: [
    { type: 2, style: 3, label: "Approve", custom_id: `keir_decision:approve:${id}` },
    { type: 2, style: 4, label: "Reject", custom_id: `keir_decision:reject:${id}` },
    { type: 2, style: 2, label: "Explain", custom_id: `keir_decision:explain:${id}` },
  ] }];
}

// Model-written text must never be able to forge a verdict line.
const clean = (t) => String(t || "").replace(/\*\*Decision:\*\*/gi, "Decision:").replace(/[\u2013\u2014]/g, ",").trim().slice(0, 1500);

function render(question, { onBehalf, tldr, signoff } = {}) {
  const head = signoff ? `${onBehalf ? "Egg hasn't answered this in 3 hours, so it's yours to sign off on Egg's behalf.\n\n" : ""}**Sign-off to ship**\n` : `${onBehalf ? "Egg hasn't answered this in 3 hours, so it's yours to decide on Egg's behalf.\n\n" : ""}**Decision needed**\n`;
  return tldr ? `${head}${tldr}\n\n**Details:** ${question}` : `${head}${question}`;
}

// The plain-English brief at the top of a decision DM. Owner, 2026-10-13:
// "gimme a brief TL;DR"; owner, 2026-10-16: "who is they? The user didn't ask
// for this? Simple English, argue for and against, and put the agent's
// recommendation." The model sees what the requester actually asked, not only
// Keir's own question, so it can say whether anyone asked for the change.
const TLDR_SYSTEM = [
  "You write the brief at the top of a decision request sent to the owner of the game A House Divided.",
  "Use exactly these labelled lines, each one short plain sentence:",
  "Who asked: who raised it (a player, staff, the owner, or Keir itself) and what they actually asked for. If Keir is proposing a change nobody asked for, say so.",
  "The choice: what the owner is deciding.",
  "Then one line per option, written as: <option in a few words>: for, <reason>; against, <reason>.",
  "Keir recommends: the option and why, in one sentence.",
  "Never write they, them or their for Keir or the requester; name who it is. No jargon, code names, file paths, PR numbers, hashes or dashes. Reply with the brief only.",
].join("\n");
function firstSentence(text) { const m = /^[\s\S]{20,220}?[.!?](\s|$)/.exec(String(text)); return (m ? m[0] : String(text).slice(0, 200)).trim(); }
function makeTldr(options = {}) {
  const spark = makeSpark(options);
  return async (question, context = {}) => {
    const asked = context.ask ? `What the requester actually wrote${context.ticket ? ` (ticket ${context.ticket})` : ""}: ${String(context.ask).slice(0, 800)}\n\n` : "";
    const text = clean(await spark(TLDR_SYSTEM, `${asked}Keir's decision request: ${String(question).slice(0, 4000)}`)).replace(/\n{2,}/g, "\n").slice(0, 900);
    // A refusal, a question back, or a vague "they" is not a brief.
    return text.length >= 10 && /Who asked:/i.test(text) && !/\bthey(?:'re|’re)?\b|\bthem\b/i.test(text) && !/^I (?:don't|do not|can't|cannot)|could you|please provide/i.test(text) ? text : firstSentence(question);
  };
}

/** Open (or reuse) a pending decision for a job, optionally bound to an action. */
// binds: { number, head } of an AHDGame PR the question asks the owner to
// merge. An approval then records an exact merge approval at that head
// (Keir 5.1.1), so later promotions carrying it chain instead of re-asking.
function openDecision(ledger, config, { jobId, actionId = null, question, signoff = false, binds = null }) {
  if (!actionId && !signoff && !binds) require("./decisionpolicy").requireRealDecision(question);
  const d = ledger.data;
  d.decisions ||= {};
  const existing = Object.values(d.decisions).find((x) => x.state === "pending" && x.jobId === jobId && (x.actionId || null) === actionId);
  if (existing) return existing;
  const id = crypto.randomBytes(6).toString("hex");
  const text = clean(question);
  const decision = { id, jobId, actionId, question: text, state: "pending", at: Date.now(), sent: {}, ...(signoff ? { signoff: true } : {}), ...(binds ? { binds } : {}) };
  d.decisions[id] = decision;
  // The durable decision is already exposed by the authenticated app API and
  // app push collector. App-only delivery does not mint an approval receipt.
  if (!require("./decisionpolicy").appDecisions(config)) ledger.notify(`ask:${id}:${config.ownerId}`, "owner", render(text, { signoff }), { components: buttons(id), decision: id, recipient: config.ownerId });
  ledger.audit("decision_opened", { decision: id, job: jobId, action: actionId, signoff: Boolean(signoff) });
  return decision;
}

function createDecisions({ ledger, config, discord, now = () => Date.now(), log = () => {}, onAnswered = () => {} }) {
  const d = ledger.data;
  const delegates = () => config.staffIds.slice(0, 1);

  // flushOutbox reports where each decision DM landed.
  function delivered(entry, channelId, messageId) {
    const x = entry.decision && d.decisions?.[entry.decision];
    if (!x) return;
    x.sent[entry.recipient] = { channelId, messageId, content: entry.sentContent };
    if (x.state !== "pending") x.closedOut = false;
    ledger.save();
  }

  const authenticated = Symbol("verified human decision ingress");
  function apply(x, verdict, actor, text, proof = null, via = null) {
    if (d.decisions?.[x.id] !== x || x.state !== "pending") throw new Error("Decision is stale or already answered");
    const job = d.jobs[x.jobId];
    const action = x.actionId && d.actions[x.actionId];
    const ownerMuse = musePolicy.origin(d, job).scoped || Boolean(action?.ownerMuse);
    if (ownerMuse) {
      if (proof !== authenticated || ![config.ownerId, config.ownerMuseDelegateId].filter(Boolean).includes(actor)) throw new Error("Owner Muse requires an authenticated Mason or explicitly configured Ariane decision");
      if (d.decisions?.[x.id] !== x || x.state !== "pending" || !job || ["done", "dismissed", "cancelled"].includes(job.state) || d.paused || job.appPaused || job.deadline <= now()) throw new Error("Owner Muse decision is stale, paused or already answered");
      if (action) {
        musePolicy.validate(d, config, job, action, now());
        if (action.state !== "pending" || action.ownerMuseDecision !== x.id) throw new Error("Owner Muse action is not awaiting this decision");
      } else if (verdict === "approve") throw new Error("A generic question cannot approve an owner Muse action; request an exact proposal");
    }
    x.state = verdict; x.answeredBy = actor; x.answeredAt = now(); x.answer = text || null;
    const onBehalf = actor !== config.ownerId;
    const who = onBehalf ? "Ariane, answering for the owner," : "The owner";
    if (action && action.state === "pending") {
      if (verdict === "approve") {
        // The delegate answers on the owner's behalf (owner policy), so the
        // approval carries the owner's authority and records who gave it.
        action.state = "approved"; action.approvedBy = config.ownerId; action.approvalMessage = x.sent[actor]?.messageId || null; action.approvedAt = now();
        if (onBehalf) action.approvedOnBehalfBy = actor;
        if (!ownerMuse) action.expiresAt = Math.max(action.expiresAt || 0, now() + 3600000);
        if (ownerMuse) action.ownerMuseApproval = { actor, decision: x.id, digest: action.ownerMuse.digest, at: now(), via };
        // Keir 4.2: the ticket's first yes carries its later non-huge steps.
        const n = job && (job.ticket || Number(/^ticket-.*-(\d+)$/.exec(job.source?.channelName || "")?.[1] || 0));
        if (!ownerMuse && n && authority.grant(d, config, n, { by: actor, messageId: action.approvalMessage, how: "approved", at: now() })) ledger.audit("ticket_authority_granted", { ticket: n, by: actor, decision: x.id, how: "approved" });
      } else if (verdict === "reject") {
        action.state = "rejected";
        const n = job && (job.ticket || Number(/^ticket-.*-(\d+)$/.exec(job.source?.channelName || "")?.[1] || 0));
        if (!ownerMuse && n) delete d.ticketAuthority?.[n];
      }
    }
    // Keir 5.1.1: a freeform "merge PR N?" yes becomes an exact approval at
    // the head the question named. A later head is not covered.
    if (!ownerMuse && !action && verdict === "approve" && x.binds?.number && x.binds?.head) {
      const args = { action: "merge", number: Number(x.binds.number), head: String(x.binds.head) };
      const a = { id: crypto.randomBytes(6).toString("hex"), jobId: x.jobId, kind: "github", args, digest: crypto.createHash("sha256").update(JSON.stringify({ kind: "github", args })).digest("hex"),
        state: "approved", at: now(), expiresAt: now() + 86400000, approvedBy: config.ownerId, approvalMessage: x.sent[actor]?.messageId || null, approvedAt: now(), boundFromDecision: x.id,
        ...(actor !== config.ownerId ? { approvedOnBehalfBy: actor } : {}) };
      if (a.approvalMessage) { d.actions[a.id] = a; x.actionId = a.id; ledger.audit("decision_bound_approval", { decision: x.id, action: a.id, pr: args.number, head: args.head }); }
    }
    if (job && !["done", "dismissed", "cancelled"].includes(job.state)) {
      const line = verdict === "approve" ? `${who} approved: ${x.question}` : verdict === "reject" ? `${who} rejected: ${x.question}` : `${who} replied to your decision request: ${text}`;
      (job.inbox ||= []).push({ authorId: actor, role: actor === config.ownerId ? "owner" : "support", content: line, at: new Date(now()).toISOString(), decision: x.id });
      delete job.ownerDecisionPending;
      job.state = "queued"; job.wakeAt = 0;
    }
    ledger.audit("decision_answered", { decision: x.id, verdict, actor });
    try { onAnswered(x, verdict, actor, text); } catch {}
    ledger.save();
    // Every copy is deleted once answered: the DMs keep only live questions.
    return removeCopies(x);
  }

  async function removeCopies(x) {
    for (const entry of Object.values(d.outbox || {})) if (entry.decision === x.id && !entry.deliveredAt) {
      entry.deliveredAt = now(); entry.skipped = `decision ${x.state}`;
    }
    await Promise.all(Object.values(x.sent || {}).filter((s) => s.messageId && !s.deleted).map((s) => discord("DELETE", `/channels/${s.channelId}/messages/${s.messageId}`).then(() => { s.deleted = true; }).catch(error => { if (error.status === 404) s.deleted = true; })));
    x.closedOut = Object.values(x.sent || {}).every(s => !s.messageId || s.deleted); ledger.save();
  }

  async function check(x) {
    if (x.state !== "pending") return false;
    for (const [recipient, s] of Object.entries(x.sent)) {
      if (!s.messageId) continue;
      let msg; try { msg = await discord("GET", `/channels/${s.channelId}/messages/${s.messageId}`); } catch { continue; }
      if (x.state !== "pending") return false;
      if (msg.author?.id !== config.botId) continue;
      const body = String(msg.content || "");
      // The verdict must follow exactly what Keir sent; anything else is ignored.
      if (!s.content || !body.startsWith(s.content)) continue;
      const tail = body.slice(s.content.length);
      const v = VERDICT.exec(tail);
      if (!v) continue;
      const actor = v[2];
      if (!(musePolicy.origin(d, d.jobs[x.jobId]).scoped ? [config.ownerId, config.ownerMuseDelegateId].filter(Boolean) : [config.ownerId, ...delegates()]).includes(actor) || (actor !== recipient && actor !== config.ownerId)) continue;
      try { await apply(x, KIND[v[1]], actor, (v[3] || "").trim().slice(0, 2000), authenticated, "authenticated-discord"); }
      catch (error) {
        if (!musePolicy.origin(d, d.jobs[x.jobId]).scoped) throw error;
        ledger.audit("owner_muse_decision_refused", { decision: x.id, actor, reason: error.message }); ledger.save();
        return false;
      }
      return true;
    }
    return false;
  }

  async function closeOut(x) { await removeCopies(x); }

  // An unanswered request lapses with its action, or after two days without
  // one. The task hears so once and does not ask again for the same thing.
  function expire(x, action) {
    x.state = "expired"; x.expiredAt = now();
    if (action && action.state === "pending") action.state = "expired";
    const job = d.jobs[x.jobId];
    if (job && !["done", "dismissed", "cancelled"].includes(job.state)) {
      (job.inbox ||= []).push({ authorId: "system", role: "system", content: `Your request expired without an answer from Egg or Ariane: ${x.question.slice(0, 300)}. Do not ask again for the same change; if the player asks, say the fix is waiting on a developer.`, at: new Date(now()).toISOString(), decision: x.id });
      delete job.ownerDecisionPending;
      if (["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
    }
    ledger.audit("decision_expired", { decision: x.id, job: x.jobId, action: x.actionId || null });
    ledger.save();
  }

  async function tick() {
    // A decision the task moved past (or whose action resolved) stops asking.
    const obsolete = Object.values(d.decisions || {}).filter(x => ["withdrawn", "expired", "superseded", "revoked", "cancelled", "approve", "reject", "explain"].includes(x.state) && (!x.closedOut || Object.values(x.sent || {}).some(s => s.messageId && !s.deleted)));
    // Bound legacy cleanup and rotate failures so old copies cannot monopolize
    // the operator loop or starve newer decisions.
    for (const x of obsolete.sort((a, b) => (a.cleanupAttemptAt || 0) - (b.cleanupAttemptAt || 0)).slice(0, 6)) { x.cleanupAttemptAt = now(); await closeOut(x); }
    for (const x of Object.values(d.decisions || {})) {
      if (x.state !== "pending") continue;
      const job = d.jobs[x.jobId];
      const action = x.actionId && d.actions[x.actionId];
      if (!job || ["done", "dismissed", "cancelled"].includes(job.state) || (action && action.state !== "pending")) {
        // The action the question was about goes with it, so a dead request
        // can never stand in for a live one.
        if (action && action.state === "pending") action.state = "withdrawn";
        x.state = "withdrawn"; ledger.save(); await closeOut(x); continue;
      }
      if (await check(x)) continue;
      if ((action && action.expiresAt && action.expiresAt < now()) || (!action && now() - x.at > PLAIN_EXPIRY_MS)) { expire(x, action); await closeOut(x); continue; }
      const ownerKey = `ask:${x.id}:${config.ownerId}`;
      if (!require("./decisionpolicy").appDecisions(config) && !x.sent[config.ownerId] && !d.outbox[ownerKey]) {
        ledger.notify(ownerKey, "owner", render(x.question, { tldr: x.tldr, signoff: x.signoff }), { components: buttons(x.id), decision: x.id, recipient: config.ownerId });
        ledger.save();
      }
      // Game repairs (heals, compensation) the owner started are still issue work and may escalate.
      const development = x.signoff || x.binds || !action || /publish|merge|promot|release|deploy|github|patch/i.test(String(action.kind || ""));
      if (!x.escalatedAt && now() - x.at > ESCALATE_MS && !musePolicy.origin(d, job).scoped && development && ownerInitiated(d, config, job)) {
        // Owner-started development work: never escalate to the delegate.
        x.escalatedAt = now(); ledger.audit("decision_escalation_skipped", { decision: x.id, reason: "owner-initiated development" }); ledger.save();
      }
      if (!x.escalatedAt && now() - x.at > ESCALATE_MS) {
        x.escalatedAt = now();
        for (const delegate of (musePolicy.origin(d, job).scoped ? [config.ownerMuseDelegateId].filter(Boolean) : delegates())) ledger.notify(`ask:${x.id}:${delegate}`, delegate, render(x.question, { onBehalf: true, signoff: x.signoff }), { components: buttons(x.id), decision: x.id, recipient: delegate });
        ledger.audit("decision_escalated", { decision: x.id, to: musePolicy.origin(d, job).scoped ? [config.ownerMuseDelegateId].filter(Boolean) : delegates() });
        ledger.save();
      }
    }
  }

  return { delivered, tick, check, apply, applyAuthenticatedApp: (x, verdict, actor, text) => {
    if (actor !== config.ownerId) throw new Error("Owner-only app session required");
    return apply(x, verdict, actor, text, authenticated, "authenticated-app");
  } };
}

/** A task that finishes in any state but blocked no longer needs its open question. */
function withdrawDecisions(ledger, jobId, reason) {
  for (const x of Object.values(ledger.data.decisions || {})) {
    if (x.state === "pending" && x.jobId === jobId && !x.actionId) { x.state = "withdrawn"; x.withdrawnReason = reason; }
  }
}

module.exports = { ownerInitiated, makeTldr, firstSentence, withdrawDecisions, openDecision, createDecisions, buttons, VERDICT, clean, render, ESCALATE_MS };
