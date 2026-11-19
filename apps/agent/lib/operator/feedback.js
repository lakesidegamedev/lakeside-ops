"use strict";
const { JOB_TERMINAL } = require("./machines");
// Keir 10.2: answer feedback. Keir's newest answer in a channel carries one small
// row: Great, Helpful, Not helpful, Report. When a newer answer lands in the same
// channel, or a day passes, the row is removed, so threads stay clean.
//
// The rule is "one row per channel, on the newest message", and it holds for both
// writers: Keir's own delivery and replies posted by the support service (which Keir
// never sees). The ledger alone cannot know about the support service's rows, so the
// rule is enforced from Discord's own state: after any row-carrying message lands, the
// channel's recent messages are listed and every other row is removed (see
// staleHolders). The web service does the same after its post (apps/web/feedback-row.js).
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
const SCAN_MS = 30 * 60000;
const SCAN_PER_SWEEP = 15;
const WAKE_MS = 3600000; // one feedback wake per ticket per hour
const TERMINAL = new Set(JOB_TERMINAL);

function row() {
  return [{ type: 1, components: [
    { type: 2, style: 2, emoji: { name: "⭐" }, custom_id: `${PREFIX}great` },
    { type: 2, style: 2, emoji: { name: "👍" }, custom_id: `${PREFIX}up` },
    { type: 2, style: 2, emoji: { name: "👎" }, custom_id: `${PREFIX}down` },
    { type: 2, style: 2, label: "Report a problem", custom_id: `${PREFIX}report` },
  ] }];
}

const snowflakeDesc = (a, b) => { const x = BigInt(a.id), y = BigInt(b.id); return x < y ? 1 : x > y ? -1 : 0; };

/** True when a Discord message carries one of our feedback rows. */
function holdsRow(m, botId = null) {
  if (!m || !/^\d+$/.test(String(m.id || ""))) return false;
  if (botId && m.author?.id !== botId) return false;
  return (m.components || []).some((r) => (r.components || []).some((c) => String(c.custom_id || "").startsWith(PREFIX)));
}

/**
 * Which messages should lose their row. Keeper = keepId, else the newest holder. Every other
 * holder goes. With expireBefore (ms) and no keepId, a keeper older than that goes too.
 */
function staleHolders(messages, { keepId = null, botId = null, expireBefore = null } = {}) {
  const held = (Array.isArray(messages) ? messages : []).filter((m) => holdsRow(m, botId)).sort(snowflakeDesc);
  const keep = keepId ? String(keepId) : held[0]?.id || null;
  const out = held.filter((m) => m.id !== keep).map((m) => m.id);
  if (!keepId && expireBefore != null && held[0]) {
    const at = Date.parse(held[0].timestamp || "");
    if (Number.isFinite(at) && at < expireBefore) out.push(held[0].id);
  }
  return out;
}

function parseRecorded(content) {
  const m = RECORDED.exec(String(content || ""));
  if (!m) return null;
  const reason = /\nReason: ([\s\S]*)$/.exec(content)?.[1]?.trim().slice(0, 1500) || null;
  return { vote: VOTE_OF[m[1]], reason };
}

function createFeedback({ ledger, config, discord, isModerator = null, now = () => Date.now(), log = () => {}, release = null, enabled = true, wake = null }) {
  const state = () => { const f = (ledger.data.answerFeedback ||= {}); f.messages ||= {}; f.latest ||= {}; f.votes ||= {}; return f; };

  /** Components for the last chunk of a channel answer, or null. */
  function components(key, entry, channelJob) {
    if (!enabled || !channelJob || entry.components || !ANSWER_KEY.test(key)) return null;
    return row();
  }

  async function strip(channelId, messageId) {
    try { await discord("PATCH", `/channels/${channelId}/messages/${messageId}`, { components: [] }); return true; }
    catch (e) { log(`feedback: could not remove the row from ${messageId}: ${e.message}`); return false; }
  }

  /**
   * Make the channel obey one-row-newest-only from Discord's own state, which also covers
   * support-service replies that are not in the ledger. Returns the message ids stripped.
   */
  async function reconcile(channelId, { keepId = null, expire = false } = {}) {
    if (!/^\d{15,22}$/.test(String(channelId || ""))) return [];
    let list;
    try { list = await discord("GET", `/channels/${channelId}/messages?limit=100`); }
    catch (e) { log(`feedback: could not list ${channelId}: ${e.message}`); return []; }
    const done = [];
    for (const id of staleHolders(list, { keepId, botId: config.botId, expireBefore: expire ? now() - SHOW_MS : null })) if (await strip(channelId, id)) done.push(id);
    return done;
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
    await reconcile(channelId, { keepId: messageId });
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

  /** The text of the answer a vote is about: Discord's own copy, else the ticket post nearest it. */
  async function answerText(answer, messageId) {
    try { const m = await discord("GET", `/channels/${answer.channelId}/messages/${messageId}`); if (typeof m?.content === "string" && m.content.trim()) return m.content; } catch { /* fall back to the ledger */ }
    const posts = (ledger.data.ticketPosts?.[answer.ticket] || []).filter((p) => p && p.text && (p.at || 0) <= (answer.at || 0) + 120000);
    return (posts.filter((p) => !answer.job || p.jobId === answer.job).at(-1) || posts.at(-1))?.text || "";
  }

  /**
   * Keir 10.4: a player's thumbs down or report on a ticket answer goes into the ticket's case file (their statement, and the
   * asked items that answer touched reopen), then wakes the ticket once an hour with the instruction to answer the one missed.
   * Owner, staff and mod votes never get here: they are recorded only. Never throws; the vote is already saved.
   */
  async function playerUnhelpful(vote, answer) {
    try {
      const d = ledger.data, at = now();
      const res = require("./ticketcase").playerUnhelpful(d, vote.ticket, { answerText: await answerText(answer, vote.messageId), reason: vote.reason, at });
      ledger.save();
      const w = ((state().wakes ||= {}));
      if (at - (w[vote.ticket] || 0) < WAKE_MS) { ledger.audit("answer_feedback_wake_skipped", { ticket: vote.ticket, why: "rate-limited" }); return; }
      const root = d.jobs?.[d.seen?.[`ticket:${vote.ticket}`]] || Object.values(d.jobs || {}).find((j) => j && j.kind === "ticket" && j.ticket === vote.ticket && !j.codingParent && !TERMINAL.has(j.state));
      if (!root || TERMINAL.has(root.state) || root.channelClosed) { ledger.audit("answer_feedback_wake_skipped", { ticket: vote.ticket, why: "ticket not live" }); return; }
      w[vote.ticket] = at;
      const open = res?.open?.length ? ` Open items: ${res.open.slice(0, 3).map((t) => `"${t.slice(0, 120)}"`).join("; ")}.` : "";
      (root.inbox ||= []).push({ role: "system", authorId: "answer-feedback", at: new Date(at).toISOString(), feedback: true,
        content: `The player marked one of your answers in this ticket as ${vote.vote === "report" ? "a problem" : "not helpful"}${vote.reason ? `: "${vote.reason.replace(/\s+/g, " ").slice(0, 200)}"` : " (no reason given)"}.${res?.first ? ` That answer began: "${res.first}".` : ""} Re-read the "Player asked" items in the case file and answer the one that was missed, in the player's own words, before anything else. Do not call their report the wrong problem.${open}` });
      if (["waiting", "blocked", "queued"].includes(root.state)) { root.state = "queued"; root.wakeAt = at; delete root.recoveryReviewRequired; }
      root.updatedAt = at;
      ledger.audit("answer_feedback_wake", { ticket: vote.ticket, job: root.id, vote: vote.vote, reopened: res?.reopened?.length || 0 });
      ledger.save();
      if (wake) wake(root);
    } catch (e) { log(`feedback: ticket follow-up failed: ${String(e.message).slice(0, 160)}`); }
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
    if (vote.voter === "player" && (vote.vote === "down" || vote.vote === "report") && previous !== vote.vote && vote.ticket) await playerUnhelpful(vote, answer);
    return { ok: true, vote: vote.vote, voter: vote.voter, changed: Boolean(previous && previous !== vote.vote) };
  }

  /**
   * Remove day-old rows and forget old records. Also re-checks the channels of open tickets
   * (a few per pass, each at most every SCAN_MS) because the support service posts rows that
   * only Discord knows about: those expire and de-duplicate here too.
   */
  async function sweep() {
    const f = state(), at = now();
    for (const [channelId, l] of Object.entries(f.latest)) if (at - l.at > SHOW_MS) { delete f.latest[channelId]; ledger.save(); await strip(channelId, l.messageId); }
    f.scanned ||= {};
    const open = new Set(Object.values(ledger.data.jobs || {})
      .filter((j) => j && j.kind === "ticket" && !JOB_TERMINAL.includes(j.state))
      .map((j) => j.replyChannel || j.channelId).filter((c) => /^\d{15,22}$/.test(String(c || ""))));
    const due = [...open].filter((c) => at - (f.scanned[c] || 0) >= SCAN_MS).sort((a, b) => (f.scanned[a] || 0) - (f.scanned[b] || 0)).slice(0, SCAN_PER_SWEEP);
    for (const channelId of due) { f.scanned[channelId] = at; ledger.save(); await reconcile(channelId, { expire: true }); }
    for (const [c, t] of Object.entries(f.scanned)) if (at - t > RETAIN_MS) delete f.scanned[c];
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

  return { components, delivered, reconcile, record, sweep, summary, digestLine };
}

module.exports = { createFeedback, row, parseRecorded, holdsRow, staleHolders, PREFIX, ANSWER_KEY, SHOW_MS };
