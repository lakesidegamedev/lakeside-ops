"use strict";
const { redactSecrets } = require("../text");
const isQuick = (job) => job.kind === "conversation";
// Only unambiguous information requests enter the read-only lane. Actions keep
// their authenticated request and go through the ordinary worker.
function quickQuestion(text) {
  if (/\b(deploy|fix|change|open|close|create|delete|remove|cancel|approve|reject|restart|merge|publish|install|update|set|run|build|implement|investigate)\b/i.test(text)) return false;
  if (/^(?:(?:ok(?:ay)?[,!. ]*)?let['’]s (?:talk|chat)(?: to each other)?|test|ping|hello|hi|hey|thanks|thank you)[!.? ]*$/i.test(text.trim())) return true;
  if (/^(?:please\s+)?ask me (?:for|about)\b/i.test(text.trim())) return true;
  return /^(what|who|why|how|when|where|which|is|are|was|were|does|do|did|has|have|can you (?:explain|show|tell|check)|show|explain|tell me|any (?:news|progress)|status)\b/i.test(text.trim());
}
function createConversation({ ledger, config, now = () => Date.now(), mods }) {
  const channels = ledger.data.channelContext ||= {};
  function record(channel, message) {
    if (!message.id || !message.author || message.webhook_id) return;
    mods?.observe?.(message);
    const human = !message.author.bot && message.author.id !== config.botId;
    const role = message.author.id === config.ownerId ? "owner" : config.staffIds.includes(message.author.id) ? "support" : message.author.id === config.botId ? "assistant" : message.author.bot ? "bot" : mods?.isModerator?.(message.author.id) ? "moderator" : "player";
    const row = { id: message.id, authorId: message.author.id, author: message.author.global_name || message.author.username, role,
      content: redactSecrets(String(message.content || "")).slice(0, 1500), at: message.timestamp, observedAt: now(), replyTo: message.message_reference?.message_id };
    // Keir 8.4.2: screenshots posted in the channel are part of what was said. Keep which
    // attachments are images (index = position on the Discord message) so they can be opened later.
    const images = (message.attachments || []).map((a, index) => ({ index, name: a.filename || a.name, type: a.content_type || a.type })).filter((a) => /^image\//.test(a.type || "")).slice(0, 10);
    if (images.length) row.images = images;
    // Keir 8.4.2 (mod chat, 2026-11-06): a moderator was recorded as "player" and dismissed as
    // "their word, not evidence". The first sight of a member looks up their guild roles, then
    // relabels what they already said.
    if (human && role === "player" && mods?.ensure) mods.ensure(message.author.id).then((isMod) => {
      if (!isMod) return;
      for (const rows of Object.values(channels)) for (const r of rows) if (r.authorId === message.author.id && r.role === "player") r.role = "moderator";
      ledger.save?.();
    }).catch(() => {});
    const prior = channels[channel.id] || [];
    channels[channel.id] = [...prior.filter((r) => r.id !== row.id && r.observedAt > now() - 24 * 3600000), row]
      .sort((a, b) => (Date.parse(a.at) || a.observedAt) - (Date.parse(b.at) || b.observedAt)).slice(-40);
    const ids = Object.keys(channels).sort((a, b) => (channels[b].at(-1)?.observedAt || 0) - (channels[a].at(-1)?.observedAt || 0));
    for (const id of ids.slice(256)) delete channels[id];
  }
  function snapshot(job) {
    return { channelId: job.source?.channelId, evidenceOnly: true, roles: "owner, support and moderator rows are staff, never players; assistant rows are you",
      messages: (channels[job.source?.channelId] || []).filter((r) => r.observedAt > now() - 24 * 3600000) };
  }
  // Keir 8.4.2 (owner, 2026-11-06, mod chat): two screenshots named the accounts and Keir
  // answered "send me the two names". Images in the last N messages, in the reply chain of
  // the message being answered, and on that message itself, are listed with where to open them.
  function recentImages(job, { n = 10 } = {}) {
    const rows = (channels[job.source?.channelId] || []).filter((r) => r.observedAt > now() - 24 * 3600000);
    const picked = new Map();
    const add = (r) => { if (r?.images?.length && r.role !== "assistant") picked.set(r.id, r); };
    rows.slice(-n).forEach(add);
    let cur = rows.find((r) => r.id === job.source?.messageId);
    for (let hop = 0; cur && hop < 8; hop++) { add(cur); cur = cur.replyTo ? rows.find((r) => r.id === cur.replyTo) : null; }
    const own = (job.source?.attachments || []).map((a, index) => ({ index, name: a.name, type: a.type })).filter((a) => /^image\//.test(a.type || ""));
    if (own.length && job.source?.messageId && !picked.has(job.source.messageId)) picked.set(job.source.messageId, { id: job.source.messageId, author: job.source.author, images: own });
    return [...picked.values()].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).flatMap((r) => r.images.map((i) => ({ messageId: r.id, author: r.author, index: i.index, name: i.name })));
  }
  function progress(job) {
    // Internal summaries, approval arguments and private destinations never
    // enter this public projection, even for an owner conversation.
    return Object.values(ledger.data.jobs).filter((j) => !isQuick(j) && j.id !== job.id && j.replyChannel === job.replyChannel && job.replyChannel && !["done", "cancelled", "dismissed"].includes(j.state))
      .map((j) => ({ taskId: j.id, state: j.state, ticket: j.ticket, sourceMessageId: j.source?.messageId,
        awaitingOwnerDecision: Boolean(j.ownerDecisionPending || Object.values(ledger.data.actions).some((a) => a.jobId === j.id && a.state === "pending")) })).slice(-20);
  }
  function lastAssistantAt(channelId) {
    const row = (channels[channelId] || []).filter((r) => r.role === "assistant").at(-1);
    return row ? (Date.parse(row.at) || row.observedAt) : 0;
  }
  return { record, snapshot, progress, lastAssistantAt, recentImages };
}
module.exports = { createConversation, isQuick, quickQuestion };
