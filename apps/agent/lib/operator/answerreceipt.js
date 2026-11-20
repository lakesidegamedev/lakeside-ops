"use strict";
// Keir 11.1.1 (live review, 2026-11-20): two live jobs on one question ticket. A complete answer was delivered through
// the authenticated support_public_update path, with a Discord receipt, after the player's latest message. It came
// from outside the job that later tried to close, so no job held resolutionReadyAt (a handoff had also cleared the
// coordinator's mark). The closing job was told to "give the player the final answer", and posted a redundant
// recap with a promise to close.
//
// The closure gate may count such a reply only from two independent records, never from a worker's own claim:
//   - the support service's stored public update for this ticket, delivered as a reply into this ticket's channel,
//   - the Discord channel itself, where every delivered part exists as a bot message, after the latest human message,
//     with text that is part of the stored update.
// The reply is complete only when it is not a holding line, promises no further follow-up, and no later bot or staff
// post promises one either.
// Everything else (grace, unread replies, holds, staff claims, decisions) stays with the caller.
const { promisesFollowUp, outstandingPromise } = require("./standdown");

const DELIVERED = new Set(["posted", "sent", "delivered", "already_posted"]);
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const snowflake = (v) => typeof v === "string" && /^\d{1,25}$/.test(v);

// ticket: support_get result. rows: Discord messages read by the broker for this ticket's channel.
// isAnswerSide(row): bot or staff. isHolding(text): a holding line, which is never a final answer.
// Returns null, or { at, messageId, key, complete }.
function verifiedAnswerAfterRequest({ ticket, number, channelId, rows, isAnswerSide, isHolding = () => false }) {
  if (!ticket || Number(ticket.number) !== Number(number) || !channelId || ticket.conversation?.channelId !== channelId) return null;
  const ordered = (rows || []).filter((m) => m && snowflake(m.id)).slice().sort(byId);
  const latestRequest = ordered.filter((m) => !m.author?.bot && norm(m.content)).at(-1);
  if (!latestRequest) return null;
  const rowOf = new Map(ordered.map((m) => [m.id, m]));
  let best = null;
  for (const u of ticket.publicUpdates || []) {
    const del = u?.delivery;
    if (!del || !DELIVERED.has(del.status) || (u.deliveryMode || "reply") !== "reply" || del.channelId !== channelId) continue;
    const ids = (Array.isArray(del.parts) && del.parts.length ? del.parts.map((p) => p?.id) : [del.messageId]);
    if (!ids.length || !ids.every(snowflake)) continue;
    const parts = ids.map((id) => rowOf.get(id));
    const text = norm(u.message);
    if (!text || parts.some((m) => !m || !m.author?.bot || !norm(m.content) || !text.includes(norm(m.content)))) continue;
    const first = parts.slice().sort(byId)[0];
    if (BigInt(first.id) <= BigInt(latestRequest.id)) continue;
    if (!best || BigInt(first.id) > BigInt(best.first.id)) best = { u, first };
  }
  if (!best) return null;
  const at = Date.parse(best.first.timestamp || "") || 0;
  if (!at) return null;
  const answerSide = isAnswerSide || ((m) => Boolean(m.author?.bot));
  const complete = !isHolding(best.u.message) && !promisesFollowUp(best.u.message) && !outstandingPromise(ordered, answerSide);
  return { at, messageId: best.first.id, key: best.u.key || null, complete };
}

module.exports = { verifiedAnswerAfterRequest };
