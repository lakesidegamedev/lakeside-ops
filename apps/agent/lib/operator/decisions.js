"use strict";
// Owner decisions (owner policy 2026-10-12). A genuine decision is DMed to the
// owner with named preference choices or exact action approval buttons. After three hours it
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
const VERDICT = /\n\n\*\*Decision:\*\* (✅ Approved|❌ Rejected|💬 Explain|🔹 Selected [1-6]) (?:by|from) <@(\d{15,22})>(?: <t:\d+:R>)?(?::\s*([\s\S]*))?$/;
const KIND = { "✅ Approved": "approve", "❌ Rejected": "reject", "💬 Explain": "explain" };

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length < 2 || options.length > 6) throw new Error("A choice needs two to six named options");
  const seen = new Set();
  const normalized = options.map((o, i) => {
    if (!o || typeof o.label !== "string" || !o.label.trim() || o.label.length > 70 || o.detail && (typeof o.detail !== "string" || o.detail.length > 180)) throw new Error("Choice labels must be 1 to 70 characters; details at most 180");
    const label = clean(o.label).replace(/\n/g, " ");
    if (seen.has(label.toLowerCase())) throw new Error("Choice labels must be distinct");
    seen.add(label.toLowerCase());
    return { id: String(i + 1), label, detail: clean(o.detail), recommended: o.recommended === true };
  });
  if (normalized.reduce((n, o) => n + o.label.length + o.detail.length, 0) > 950) throw new Error("Keep choice options concise: total labels and details at most 950 characters");
  return normalized;
}
function binding(action, binds) { return crypto.createHash("sha256").update(JSON.stringify(action ? {kind: action.kind, args: action.args, explanation: action.explanation} : binds)).digest("hex"); }
function actionReview(action, binds, explanation = null) {
  const a = action?.args || {};
  const {summary: _summary, ...operation} = a;
  const title = action?.kind === "github" ? `${a.action || "GitHub operation"} ${a.repository || "AHDGame"}${a.number ? ` PR #${a.number}` : ""}${a.from ? ` from ${a.from}` : ""}${a.to ? ` to ${a.to}` : ""}` : action?.kind === "heal" ? "Change live game data" : action?.kind ? ({heal:"Allow this game repair?",computer_input:"Allow this browser action?",host_command:"Allow this server action?",mcp_write:"Allow this change?"}[action.kind] || "Allow this change?") : binds ? `Merge AHDGame PR #${binds.number}` : "Review proposal";
  const scope = musePolicy.logInput(action?.ownerMuse?.scope || (action?.kind === "heal" ? a.spec || a : action ? operation : binds || {}));
  return { ...((action?.kind === "github" || binds) && (action?.explanation || explanation) ? require("./approvalcopy").prepare(action?.explanation || explanation, action ? a : {action:"merge",...binds}) : {title: clean(title).slice(0, 100)}), ...(action?.kind === "heal" && a.spec?.description && !require("./approvalcopy").JARGON.test(a.spec.description) ? {description:clean(a.spec.description)} : {}), scope, digest: action?.ownerMuse?.digest || action?.digest || null };
}
function buttons(id, options = null, review = null) {
  if (review && !review.human && JSON.stringify(review.scope).length > 850) return [{type:1, components:[{type:2, style:2, label:"Ask for a narrower proposal", custom_id:`keir_decision:explain:${id}`}]}];
  if (options) {
    const rows = [];
    for (let i = 0; i < options.length; i += 3) rows.push({ type: 1, components: options.slice(i, i + 3).map(o => ({type: 2, style: 2, label: o.label, custom_id: `keir_decision:choose${o.id}:${id}`})) });
    rows.push({type:1, components:[{type:2, style:2, label:"Ask a question / other answer", custom_id:`keir_decision:explain:${id}`}]});
    return rows;
  }
  return [{ type: 1, components: [
    { type: 2, style: 3, label: "Approve this action", custom_id: `keir_decision:approve:${id}` },
    { type: 2, style: 4, label: "Decline this action", custom_id: `keir_decision:reject:${id}` },
    { type: 2, style: 2, label: "Ask a question", custom_id: `keir_decision:explain:${id}` },
  ] }];
}

// Model-written text must never be able to forge a verdict line.
const clean = (t) => String(t || "").replace(/\*\*Decision:\*\*/gi, "Decision:").replace(/[\u2013\u2014]/g, ",").trim().slice(0, 1500);

function render(question, { onBehalf, signoff, options, review } = {}) {
  if (options) return `${onBehalf ? "Answering on Egg's behalf.\n\n" : ""}**Choose one**\n${question.slice(0, 450)}\n\n${options.map(o => `${o.id}. **${o.label}**${o.recommended ? " (recommended)" : ""}${o.detail ? `: ${o.detail}` : ""}`).join("\n")}\n\nYour choice sets the direction. Any action requiring approval gets a separate proposal.`;
  if (review?.human) return `${onBehalf ? "Answering on Egg's behalf.\n\n" : ""}**${review.title}**\n${require("./approvalcopy").body(review)}\n\n**Approve:** ${review.approve}\n**Decline:** ${review.decline}\n**Ask a question:** send this back to Keir without approving it.`;
  if (review) {
    const scope = JSON.stringify(review.scope).replace(/\*\*Decision:\*\*/gi, "Decision:");
    return `${onBehalf ? "Answering on Egg's behalf.\n\n" : ""}**Approval required: ${review.title}**\n${question.slice(0, 300)}${scope.length > 850 ? "\n\nThis request is too large to review here. Review it in the Keir app before deciding." : ""}\n\n**Approve this action:** authorize the operation above, subject to its existing checks.\n**Decline:** do not run this operation.\n**Ask a question:** return it to Keir without approval.`;
  }
  const head = `${onBehalf ? "Egg hasn't answered this in 3 hours, so it's yours to decide on Egg's behalf.\n\n" : ""}**Decision needed**\n`;
  return `${head}${question}`;
}

// Shared short preview for app work lists; permission copy is never rewritten.
function firstSentence(text) { const m = /^[\s\S]{20,220}?[.!?](\s|$)/.exec(String(text)); return (m ? m[0] : String(text).slice(0, 200)).trim(); }

/** Open (or reuse) a pending decision for a job, optionally bound to an action. */
// binds: { number, head } of an AHDGame PR the question asks the owner to
// merge. An approval then records an exact merge approval at that head
// (Keir 5.1.1), so later promotions carrying it chain instead of re-asking.
function openDecision(ledger, config, { jobId, actionId = null, question, signoff = false, binds = null, decisionKey = null, options = null, explanation = null }) {
  const choices = options == null ? null : normalizeOptions(options);
  if (choices && (actionId || signoff || binds)) throw new Error("A choice cannot be bound to an action approval");
  if (signoff && !actionId && !binds) throw new Error("Sign-off requires a bound action or exact PR head");
  if (actionId && (!ledger.data.actions?.[actionId] || ledger.data.actions[actionId].jobId !== jobId || ledger.data.actions[actionId].state !== "pending")) throw new Error("Approval requires a pending bound action owned by this task");
  if (!actionId && !signoff && !binds) require("./decisionpolicy").requireRealDecision(question);
  const d = ledger.data;
  d.decisions ||= {};
  const existing = Object.values(d.decisions).find((x) => x.state === "pending" && x.jobId === jobId && (x.actionId || null) === actionId && (x.decisionKey || null) === decisionKey);
  if (existing) {
    if (choices && (existing.question !== clean(question) || JSON.stringify(existing.options) !== JSON.stringify(choices))) throw new Error("This task already has a different unanswered choice. Wait for its answer or withdraw it before replacing it.");
    return existing;
  }
  const id = crypto.randomBytes(6).toString("hex");
  let text = clean(question);
  if (choices && text.length > 450) throw new Error("Keep the choice question at most 450 characters; put each outcome in its option detail");
  const action = actionId && d.actions[actionId];
  const review = action || binds ? actionReview(action, binds, explanation) : null;
  if (review?.human) text = require("./approvalcopy").body(review);
  else if(review?.description) text = review.description;
  const decision = { id, jobId, actionId, ...(choices ? { options: choices, type: "choice" } : {}), ...(review ? { review, approvalBinding: binding(action, binds), type: "approval" } : {}), question: text, state: "pending", at: Date.now(), sent: {}, ...(decisionKey ? { decisionKey } : {}), ...(signoff ? { signoff: true } : {}), ...(binds ? { binds } : {}) };
  d.decisions[id] = decision;
  // The durable decision is already exposed by the authenticated app API and
  // app push collector. App-only delivery does not mint an approval receipt.
  if (!require("./decisionpolicy").appDecisions(config)) ledger.notify(`ask:${id}:${config.ownerId}`, "owner", render(text, decision), { components: buttons(id, choices, review), decision: id, recipient: config.ownerId });
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
    if (require("./decisionpolicy").obsoleteReason(x, d)) throw new Error("This obsolete synthetic approval cannot authorize work; its existing hold is preserved");
    const job = d.jobs[x.jobId];
    const action = x.actionId && d.actions[x.actionId];
    if (verdict === "approve" && (action?.kind === "github" || x.binds) && !x.review?.human) throw new Error("This request needs a plain-language explanation before it can be approved. Ask Keir for a fresh proposal.");
    const selected = x.options?.find(o => verdict === `choose:${o.id}`);
    if (x.options && !selected && verdict !== "explain") throw new Error("Choose a named choice; approval and rejection cannot answer this question");
    if (!x.options && !["approve", "reject", "explain"].includes(verdict)) throw new Error("Invalid decision verdict");
    if (selected && proof !== authenticated) throw new Error("Choice requires authenticated human ingress");
    if (!job || ["done", "dismissed", "cancelled"].includes(job.state) || require("./ticketpause").pauseFor(d, job) || d.paused || job.appPaused) throw new Error("Decision task is ended or paused");
    if (x.approvalBinding && binding(action, x.binds) !== x.approvalBinding) throw new Error("Approval scope changed; request a fresh proposal");
    if (action && (action.state !== "pending" || action.expiresAt && action.expiresAt <= now())) throw new Error("Approval action changed or expired");
    const ownerMuse = musePolicy.origin(d, job).scoped || Boolean(action?.ownerMuse);
    if (ownerMuse) {
      if (proof !== authenticated || ![config.ownerId, config.ownerMuseDelegateId].filter(Boolean).includes(actor)) throw new Error("Owner Muse requires an authenticated Mason or explicitly configured Ariane decision");
      if (d.decisions?.[x.id] !== x || x.state !== "pending" || !job || ["done", "dismissed", "cancelled"].includes(job.state) || d.paused || job.appPaused || job.deadline <= now()) throw new Error("Owner Muse decision is stale, paused or already answered");
      if (action) {
        musePolicy.validate(d, config, job, action, now());
        if (action.state !== "pending" || action.ownerMuseDecision !== x.id) throw new Error("Owner Muse action is not awaiting this decision");
      } else if (verdict === "approve") throw new Error("A generic question cannot approve an owner Muse action; request an exact proposal");
    }
    x.state = selected ? "selected" : verdict; if (selected) x.selectedOption = { ...selected }; x.answeredBy = actor; x.answeredAt = now(); x.answer = text || null;
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
      const line = selected ? `${who} chose: ${selected.label}${selected.detail ? `. ${selected.detail}` : ""}. This is direction, not execution approval.` : verdict === "approve" ? `${who} approved: ${x.question}` : verdict === "reject" ? `${who} rejected: ${x.question}` : `${who} replied to your decision request: ${text}`;
      (job.inbox ||= []).push({ authorId: actor, role: actor === config.ownerId ? "owner" : "support", content: line, at: new Date(now()).toISOString(), decision: x.id });
      delete job.ownerDecisionPending;
      delete job.recoveryReviewRequired;
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
      try { await apply(x, (v[1].startsWith("🔹 Selected ") ? `choose:${v[1].slice(-1)}` : KIND[v[1]]), actor, (v[3] || "").trim().slice(0, 2000), authenticated, "authenticated-discord"); }
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
    const obsolete = Object.values(d.decisions || {}).filter(x => ["withdrawn", "expired", "superseded", "revoked", "cancelled", "approve", "reject", "explain", "selected"].includes(x.state) && (!x.closedOut || Object.values(x.sent || {}).some(s => s.messageId && !s.deleted)));
    // Bound legacy cleanup and rotate failures so old copies cannot monopolize
    // the operator loop or starve newer decisions.
    for (const x of obsolete.sort((a, b) => (a.cleanupAttemptAt || 0) - (b.cleanupAttemptAt || 0)).slice(0, 6)) { x.cleanupAttemptAt = now(); await closeOut(x); }
    for (const x of Object.values(d.decisions || {})) {
      if (x.state !== "pending") continue;
      const obsoleteReason = require("./decisionpolicy").obsoleteReason(x, d);
      if (obsoleteReason) {
        x.state = "withdrawn"; x.withdrawnReason = obsoleteReason;
        // Preserve the operational hold. Withdrawing a fake permission card
        // cannot transfer ownership, clear uncertainty or approve a plan.
        if (d.jobs[x.jobId]) d.jobs[x.jobId].recoveryReviewRequired = obsoleteReason;
        ledger.audit("synthetic_decision_withdrawn", { decision: x.id, job: x.jobId, reason: obsoleteReason });
        ledger.save(); await closeOut(x); continue;
      }
      const job = d.jobs[x.jobId];
      const action = x.actionId && d.actions[x.actionId];
      if (!job || ["done", "dismissed", "cancelled"].includes(job.state) || (action && action.state !== "pending")) {
        // The action the question was about goes with it, so a dead request
        // can never stand in for a live one.
        if (action && action.state === "pending") action.state = "withdrawn";
        x.state = "withdrawn"; ledger.save(); await closeOut(x); continue;
      }
      if ((action?.kind === "github" || x.binds) && !x.review?.human) {
        x.state="withdrawn";x.withdrawnReason="Needs a plain-language explanation before approval";
        if(action?.state==="pending" && !Object.values(job.effects||{}).some(e=>e.state==="started")) action.state="withdrawn";
        delete job.ownerDecisionPending;
        (job.inbox ||= []).push({role:"system",authorId:"system",at:new Date(now()).toISOString(),content:"The old technical approval request was withdrawn without approving or rejecting its action. Use github with a plain-language explanation of the player change, impact and risk to prepare a fresh request. Preserve all existing holds and earlier answered decisions."});
        if(["waiting","blocked"].includes(job.state) && !require("./ticketpause").pauseFor(d,job) && !job.appPaused && !d.paused) {job.state="queued";job.wakeAt=0;}
        ledger.audit("approval_explanation_required",{decision:x.id,job:job.id});ledger.save();await closeOut(x);continue;
      }
      if (await check(x)) continue;
      if ((action && action.expiresAt && action.expiresAt < now()) || (!action && now() - x.at > PLAIN_EXPIRY_MS)) { expire(x, action); await closeOut(x); continue; }
      const ownerKey = `ask:${x.id}:${config.ownerId}`;
      if (!require("./decisionpolicy").appDecisions(config) && !x.sent[config.ownerId] && !d.outbox[ownerKey]) {
        ledger.notify(ownerKey, "owner", render(x.question, x), { components: buttons(x.id, x.options, x.review), decision: x.id, recipient: config.ownerId });
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
        for (const delegate of (musePolicy.origin(d, job).scoped ? [config.ownerMuseDelegateId].filter(Boolean) : delegates())) ledger.notify(`ask:${x.id}:${delegate}`, delegate, render(x.question, { ...x, onBehalf: true }), { components: buttons(x.id, x.options, x.review), decision: x.id, recipient: delegate });
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

module.exports = { normalizeOptions, actionReview, ownerInitiated, firstSentence, withdrawDecisions, openDecision, createDecisions, buttons, VERDICT, clean, render, ESCALATE_MS };
