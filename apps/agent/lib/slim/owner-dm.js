"use strict";
// Approval cards to the owner, in the owner's direct-message channel with
// Keir's bot, and the owner's answers back. The owner answers by replying to
// a card, or by writing its id (for example "decision-1a2b3c4d5e A").
// Accepted answers get a check mark reaction; nothing else is posted.

const fs = require("node:fs");
const path = require("node:path");

const API = "https://discord.com/api/v10";
const ID = /\b((?:decision|promote|compensation)-[0-9a-f]{10})\b/i;

/** Turn an owner reply into { status, text } for an approval of `kind`. */
function parseAnswer(content, approval) {
  const t = String(content || "").replace(ID, "").trim();
  const letter = /^\(?([A-D])\)?(?:[\s.,:!)]|$)/i.exec(t);
  if (approval?.kind === "decision" && letter) {
    const i = letter[1].toUpperCase().charCodeAt(0) - 65;
    const option = approval.payload?.options?.[i];
    if (option) return { status: "answered", text: `${letter[1].toUpperCase()}) ${option}${t.length > 2 ? ` (${t.slice(1).trim()})` : ""}` };
  }
  if (/^(?:no|decline[d]?|reject(?:ed)?|deny|denied|don't|do not)\b/i.test(t)) return { status: "declined", text: t };
  if (/^(?:yes|approve[d]?|ok(?:ay)?|go|do it|ship it|pay it|confirmed?)\b/i.test(t)) return { status: "approved", text: t };
  return { status: "answered", text: t };
}

function createOwnerDm({ token, channel, ownerIds, stateFile, fetchImpl = fetch }) {
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  let data = { cards: {}, after: null };
  try { data = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* fresh */ }
  const save = () => { fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile, JSON.stringify(data), { mode: 0o600 }); };
  const ready = Boolean(token && channel);

  async function api(method, route, body) {
    const r = await fetchImpl(`${API}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`discord ${method} ${route.split("?")[0]} ${r.status}`);
    return r.status === 204 ? null : r.json();
  }

  /** Check the channel is reachable (read only). */
  async function check() {
    if (!ready) return { ok: false, reason: "owner DM channel or bot token not configured" };
    const c = await api("GET", `/channels/${channel}`);
    return { ok: true, type: c.type };
  }

  async function sendCard({ ticket, kind, id, text }) {
    if (!ready) return { sent: false, reason: "owner DM channel or bot token not configured" };
    const m = await api("POST", `/channels/${channel}/messages`, { content: text.slice(0, 1990), allowed_mentions: { parse: [] } });
    data.cards[m.id] = { ticket, kind, id };
    save();
    return { sent: true, messageId: m.id };
  }

  /**
   * New owner messages that answer a card: [{ ticket, approvalId, content, messageId }].
   * The first call only sets the starting point.
   */
  async function answers() {
    if (!ready) return [];
    if (!data.after) {
      const last = await api("GET", `/channels/${channel}/messages?limit=1`);
      data.after = last[0]?.id || "0"; save();
      return [];
    }
    const msgs = await api("GET", `/channels/${channel}/messages?after=${data.after}&limit=50`);
    const ordered = [...msgs].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const out = [];
    for (const m of ordered) {
      data.after = m.id;
      if (!ownerIds.includes(String(m.author?.id))) continue;
      const ref = m.message_reference?.message_id && data.cards[m.message_reference.message_id];
      const named = ID.exec(m.content || "");
      const card = ref || (named && Object.values(data.cards).find((c) => c.id.toLowerCase() === named[1].toLowerCase()));
      if (card) out.push({ ticket: card.ticket, approvalId: card.id, content: m.content || "", messageId: m.id });
    }
    save();
    return out;
  }

  async function acknowledge(messageId) {
    await api("PUT", `/channels/${channel}/messages/${messageId}/reactions/${encodeURIComponent("✅")}/@me`).catch(() => {});
  }

  return { ready, check, sendCard, answers, acknowledge, parseAnswer };
}

module.exports = { createOwnerDm, parseAnswer };
