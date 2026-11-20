"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");

// The snapshot belongs to one activation. The messages belong to the ledger.
const active = new WeakMap();
const calls = new AsyncLocalStorage();
const foreground = new WeakSet();
const foregroundTools = new Set(["support_updates", "conversation_updates", "ticket_history", "view_attachment", "check_draft", "channel_reply", "finish", "read_tool", "present_evidence"]);
// Keir 11.1: the only reads a foreground turn may make through read_tool. The curated public dictionary and the vetted
// game evidence reads; no raw records, code, knowledge or other servers. The full investigation stays with the worker.
const foregroundReads = { "ops-knowledge": new Set(["support_evidence_lookup"]), gamestate: new Set(["market_history", "commodity_market", "reporter_operating_results", "reporter_action_points", "country_fiscal"]) };
function readAllowed(job, server, tool) {
  return eligible(job) && foregroundReads[server]?.has(tool) === true;
}

function eligible(job) {
  return !job.codingParent && job.channelId && job.channelId !== "app" &&
    (job.replyChannel === job.channelId || (!job.replyChannel && job.kind === "ticket")) && ["ticket", "command", "conversation"].includes(job.kind);
}
function human(job, row) {
  return eligible(job) && row?.messageId && row.authorId && row.channelId === job.channelId &&
    !row.directiveId && !row.codingResult && !row.investigationResult &&
    [undefined, "player", "moderator", "owner", "support"].includes(row.role) &&
    (job.kind === "ticket" || row.authorId === job.actorId);
}
function begin(job, snapshot) {
  const owed = new Set(foreground.has(job) ? snapshot : []);
  if (job.kind === "conversation") {
    const current = snapshot.filter(row => human(job, row)).at(-1) || (job.activationCount === 1 ? job.source : null);
    if (current && (current.replyTo || current.mentioned || current.contextMessageId || current.contextSinceMessageIds?.length) &&
        (current.content?.includes("?") || current.contextMessageId || current.contextSinceMessageIds?.length)) owed.add(current);
  }
  active.set(job, { captured: new Set(snapshot), owed, revision: 0 });
}
function consume(job, rows, history) {
  const used = new Set(rows);
  job.requestInbox = distinct(history);
  job.inbox = (job.inbox || []).filter(row => !used.has(row) || active.get(job)?.owed.has(row));
  if (!job.inbox.some(row => human(job, row))) delete job.addressedPending;
}
function distinct(history) {
  const seen = new Set();
  return history.filter(row => {
    if (!row?.messageId) return true;
    if (seen.has(row.messageId)) return false;
    seen.add(row.messageId);
    return true;
  });
}
function unread(job) {
  const turn = active.get(job);
  return turn ? (job.inbox || []).filter(row => !turn.captured.has(row) && human(job, row)) : [];
}
function check(job) {
  const call = calls.getStore();
  if (unread(job).length || (call?.job === job && call.revision !== active.get(job)?.revision))
    throw new Error("A newer Discord message arrived. Read conversation_updates, then answer the current question before continuing.");
}
function read(job) {
  const rows = unread(job);
  if (rows.length) {
    const turn = active.get(job);
    for (const row of rows) { turn.owed.add(row); turn.captured.add(row); }
    consume(job, rows, [...(job.requestInbox || []), ...rows].slice(-20));
    active.get(job).revision++;
    job.activationInternalWake = false;
    job.observedPlayerAt = Math.max(job.observedPlayerAt || 0, ...rows.map(row => Date.parse(row.at) || 0));
  }
  return rows;
}
// Discord snowflakes order messages even within the same millisecond. A job
// may receive its next turn while the previous answer is still in the outbox.
function latestSource(job) {
  return [job.source, ...(job.requestInbox || []), ...(job.inbox || [])]
    .filter(row => human(job, row) && /^\d{16,20}$/.test(row.messageId))
    .reduce((id, row) => BigInt(row.messageId) > BigInt(id || 0) ? row.messageId : id, null);
}
function superseded(job, entry) {
  const latest = job && entry.answerTo && latestSource(job);
  return Boolean(latest && BigInt(latest) > BigInt(entry.answerTo));
}
// Keep acknowledged interruptions in the durable inbox until a reply has a
// receipt (or a durable outbox entry). A restart can then resume the question.
function answered(job) {
  const turn = active.get(job);
  if (!turn) return;
  const answered = calls.getStore()?.owed || [];
  for (const row of answered) turn.owed.delete(row);
  consume(job, answered, job.requestInbox || []);
}
function owes(job) { return Boolean(active.get(job)?.owed.size); }
function forCall(job, fn) {
  return active.has(job) ? calls.run({ job, revision: active.get(job).revision, owed: [...active.get(job).owed] }, fn) : fn();
}
module.exports = { inFlight: job => active.has(job), distinct, foreground, foregroundTools, foregroundReads, readAllowed, latestSource, superseded, answered, owes, eligible, human, begin, consume, unread, check, read, forCall, end(job) { active.delete(job); foreground.delete(job); } };
