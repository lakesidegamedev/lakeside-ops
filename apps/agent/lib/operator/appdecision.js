"use strict";
const policy = require("./ownermuse-policy");
// One review projection across chat, tasks and tickets. Execution still validates
// the sealed action and authenticated ingress when the owner answers.
function decisionView(data, x, now = Date.now()) {
  const job = data.jobs?.[x.jobId], action = data.actions?.[x.actionId];
  const origin = policy.origin(data, job);
  const unavailable = x.state !== "pending" ? "This decision has already been answered."
    : !job || ["done", "dismissed", "cancelled"].includes(job.state) ? "The task has ended. Ask Keir for a fresh proposal."
    : data.paused || job.appPaused || require("./ticketpause").pauseFor(data, job) ? "Keir is paused. Start or resume the task before answering."
    : origin.scoped && (!origin.valid || job.deadline <= now) ? "This saved proposal needs a fresh authenticated task."
    : action && (action.state !== "pending" || action.expiresAt <= now) ? "This action changed or expired. Ask Keir for a fresh proposal." : null;
  return { id: x.id, jobId: x.jobId, question: x.question, type: x.type || (x.actionId || x.binds ? "approval" : "question"), options: x.options || null, review: x.review ? (({scope, ...summary}) => summary)(x.review) : null, tldr: x.tldr || null, state: x.state, at: x.at,
    ticket: job?.ticket || null, canOpenTask: job?.role === "owner", signoff: Boolean(x.signoff), canAnswer: !unavailable,
    canRefresh: Boolean(job && x.state === "pending" && !["done", "dismissed", "cancelled"].includes(job.state) && !data.paused && !job.appPaused && (!origin.scoped || origin.valid)),
    canApprove: !x.options && !unavailable && (!origin.scoped || Boolean(action)), reason: unavailable || (origin.scoped && !action ? "Reply to this question. Approval requires an exact action proposal." : null),
    ...(action ? { actionId: action.id, kind: action.kind, args: policy.logInput(action.args || {}), scope: policy.logInput(action.ownerMuse?.scope || {}), digest: action.ownerMuse?.digest || action.digest || null, expiresAt: action.expiresAt || null } : x.binds ? { scope: policy.logInput(x.binds) } : {}) };
}
module.exports = { decisionView };
