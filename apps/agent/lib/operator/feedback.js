"use strict";
// Keir 10.2: answer feedback. Keir's newest answer in a channel carries one small
// row: Great, Helpful, Not helpful, Report. When a newer answer lands in the same
// channel, or a day passes, the row is removed, so threads stay clean.
//
// The game bot owns the Discord connection, so clicks reach it, not us. It answers
// the clicker privately and then pokes us with only the interaction token. We read
// that private answer back from Discord: who clicked, which message, and the vote
// all come from Discord's own record of the interaction. Nothing in the poke is
// trusted, the same rule as the decision buttons.

const PREFIX = "keir_fb:";
// The bot's private reply starts with this line. Its wording is a contract with
// adhd-bot (src/utils/keirFeedback.ts).
const RECORDED = /^Thanks, feedback recorded: (⭐|👍|👎|🚩) /u;
const VOTE_OF = { "⭐": "great", "👍": "up", "👎": "down", "🚩": "report" };
const ANSWER_KEY = /^(channel-reply|finish|error-reply):/;
const SHOW_MS = 24 * 3600000;
const RETAIN_MS = 180 * 86400000;

function row() {
  return [{ type: 1, components: [
    { type: 2, style: 2, emoji: { name: "⭐" }, custom_id: `${PREFIX}great` },
    { type: 2, style: 2, emoji: { name: "👍" }, custom_id: `${PREFIX}up` },
    { type: 2, style: 2, emoji: { name: "👎" }, custom_id: `${PREFIX}down` },
    { type: 2, style: 2, label: "Report a problem", custom_id: `${PREFIX}report` },
  ] }];
}

function parseRecorded(content) {
  const m = RECORDED.exec(String(content || ""));
  if (!m) return null;
  const reason = /\nReason: ([\s\S]*)$/.exec(content)?.[1]?.trim().slice(0, 1500) || null;
  return { vote: VOTE_OF[m[1]], reason };
}

function createFeedback({ ledger, config, discord, isModerator = null, now = () => Date.now(), log = () => {}, release = null, enabled = true }) {
  const state = () => { const f = (ledger.data.answerFeedback ||= {}); f.messages ||= {}; f.latest ||= {}; f.votes ||= {}; return f; };

  /** Components for the last chunk of a channel answer, or null. */
  function components(key, entry, channelJob) {
    if (!enabled || !channelJob || entry.components || !ANSWER_KEY.test(key)) return null;
    return row();
  }

  async function strip(channelId, messageId) {
    try { await discord("PATCH", `/channels/${channelId}/messages/${messageId}`, { components: [] }); }
    catch (e) { log(`feedback: could not remove the row from ${messageId}: ${e.message}`); }
  }

  /** Remember what produced the answer and move the row off the previous one. */
  async function delivered(channelId, messageId, job) {
    const f = state(), at = now(), p = job.provider || {};
    f.messages[messageId] = { channelId, job: job.id, ticket: job.ticket || null, kind: job.kind || null, role: job.role || null,
      lane: p.lane || null, runner: p.runner || null, model: p.model || null, effort: p.effort || job.effort || null, release, at };
    const prev = f.latest[channelId];
    f.latest[channelId] = { messageId, at };
    ledger.save();
    if (prev && prev.messageId !== messageId) await strip(channelId, prev.messageId);
  }

  async function voterRole(userId) {
    if (userId === config.ownerId) return "owner";
    if ((config.staffIds || []).includes(userId)) return "staff";
    try { if (isModerator && await isModerator(userId)) return "mod"; }
    catch { /* a lookup failure counts the voter as a player */ }
    return "player";
  }

  /**
   * Player replies posted by the support service carry the same row but never pass through
   * Keir's delivery, so they are not in the ledger. Adopt one when Discord itself shows it is
   * the game bot's message with our buttons; the ticket comes from the channel's own name.
   */
  async function adoptSupportReply(channelId, messageId) {
    if (!/^\d{15,22}$/.test(String(channelId || ""))) return null;
    let msg, channel;
    try { msg = await discord("GET", `/channels/${channelId}/messages/${messageId}`); channel = await discord("GET", `/channels/${channelId}`); }
    catch { return null; }
    const ids = (msg?.components || []).flatMap((r) => (r.components || []).map((c) => c.custom_id));
    if (msg?.author?.id !== config.botId || !ids.some((id) => String(id).startsWith(PREFIX))) return null;
    const ticket = Number(/-(\d+)$/.exec(String(channel?.name || ""))?.[1]) || null;
    const f = state();
    return (f.messages[messageId] = { channelId, job: null, ticket, kind: "support-reply", role: "support", lane: null, runner: null, model: null, effort: null, release, at: now() });
  }

  /** Record one vote, read back from Discord by its interaction token. */
  async function record({ token } = {}) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_.-]{20,600}$/.test(token)) throw Object.assign(new Error("bad token"), { status: 400 });
    const reply = await discord("GET", `/webhooks/${config.botId}/${token}/messages/@original`);
    if (reply?.author?.id !== config.botId) throw Object.assign(new Error("not the game bot's reply"), { status: 409 });
    const meta = reply.interaction_metadata || {};
    const userId = meta.user?.id;
    const messageId = meta.interacted_message_id || meta.triggering_interaction_metadata?.interacted_message_id;
    const parsed = parseRecorded(reply.content);
    if (!userId || !messageId || !parsed) throw Object.assign(new Error("not a feedback interaction"), { status: 409 });
    const f = state();
    const answer = f.messages[messageId] || await adoptSupportReply(reply.channel_id, messageId);
    if (!answer) throw Object.assign(new Error("not a Keir answer with feedback"), { status: 404 });
    const key = `${messageId}:${userId}`, previous = f.votes[key]?.vote || null;
    const vote = { messageId, userId, voter: await voterRole(userId), vote: parsed.vote, reason: parsed.reason, at: now(),
      channelId: answer.channelId, ticket: answer.ticket, kind: answer.kind, lane: answer.lane, model: answer.model, runner: answer.runner, release: answer.release, job: answer.job };
    f.votes[key] = vote;
    ledger.audit("answer_feedback", { message: messageId, voter: vote.voter, vote: vote.vote, previous, ticket: vote.ticket, model: vote.model });
    ledger.save();
    return { ok: true, vote: vote.vote, voter: vote.voter, changed: Boolean(previous && previous !== vote.vote) };
  }

  /** Remove day-old rows and forget old records. */
  async function sweep() {
    const f = state(), at = now();
    for (const [channelId, l] of Object.entries(f.latest)) if (at - l.at > SHOW_MS) { delete f.latest[channelId]; ledger.save(); await strip(channelId, l.messageId); }
    let pruned = false;
    for (const [id, m] of Object.entries(f.messages)) if (at - m.at > RETAIN_MS) { delete f.messages[id]; pruned = true; }
    for (const [k, v] of Object.entries(f.votes)) if (at - v.at > RETAIN_MS) { delete f.votes[k]; pruned = true; }
    if (pruned) ledger.save();
  }

  /** Counts by week, model, work type and voter group, plus recent problem reports. */
  function summary({ days = 30 } = {}) {
    const f = state(), since = now() - days * 86400000;
    const votes = Object.values(f.votes).filter((v) => v.at >= since);
    const tally = (list) => {
      const t = { great: 0, up: 0, down: 0, report: 0, total: list.length };
      for (const v of list) t[v.vote]++;
      t.helpfulRate = list.length ? Number(((t.great + t.up) / list.length).toFixed(3)) : null;
      return t;
    };
    const by = (fn) => { const g = {}; for (const v of votes) (g[fn(v) || "unknown"] ||= []).push(v); return Object.fromEntries(Object.entries(g).map(([k, l]) => [k, tally(l)])); };
    const week = (v) => { const d = new Date(v.at); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    const answers = Object.values(f.messages).filter((m) => m.at >= since).length;
    return { days, answers, rated: new Set(votes.map((v) => v.messageId)).size, overall: tally(votes),
      byVoter: by((v) => v.voter), byModel: by((v) => v.model), byKind: by((v) => v.kind), byWeek: by(week), byRelease: by((v) => v.release),
      problems: votes.filter((v) => v.vote === "down" || v.vote === "report").sort((a, b) => b.at - a.at).slice(0, 50)
        .map((v) => ({ at: new Date(v.at).toISOString(), vote: v.vote, voter: v.voter, reason: v.reason, ticket: v.ticket, model: v.model, kind: v.kind,
          link: config.guildId ? `https://discord.com/channels/${config.guildId}/${v.channelId}/${v.messageId}` : null })) };
  }

  /** One line for the owner's morning digest, or empty. */
  function digestLine(since) {
    const votes = Object.values(state().votes).filter((v) => v.at > since);
    if (!votes.length) return "";
    const n = (k) => votes.filter((v) => v.vote === k).length;
    const reports = votes.filter((v) => v.vote === "report" || (v.vote === "down" && v.reason)).slice(-5)
      .map((v) => `- ${v.vote === "report" ? "🚩" : "👎"} ${v.voter}${v.ticket ? ` #${v.ticket}` : ""}: ${(v.reason || "no reason given").replace(/\s+/g, " ").slice(0, 160)}`);
    return [`Answer feedback: ${n("great")} ⭐, ${n("up")} 👍, ${n("down")} 👎, ${n("report")} 🚩.`, ...reports].join("\n");
  }

  return { components, delivered, record, sweep, summary, digestLine };
}

module.exports = { createFeedback, row, parseRecorded, PREFIX, ANSWER_KEY };
