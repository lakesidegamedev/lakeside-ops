"use strict";
// Approval cards to the owner, in the owner's direct-message channel with
// Keir's bot, and the owner's answers back. The owner clicks a button on the
// card (the game's Discord bot appends the verdict to the card, as for old
// Keir's cards, and it is read back here), or, as a fallback, replies to the
// card with a letter or yes or no. A typed answer gets a check mark reaction.

const fs = require("node:fs");
const path = require("node:path");

const API = "https://discord.com/api/v10";
const { verdictFrom, optionLabel } = require("./ownercopy");
const ID = /\b((?:decision|promote|compensation)-[0-9a-f]{10})\b/i;

/** Turn an owner reply into { status, text } for an approval of `kind`. */
function parseAnswer(content, approval) {
  const t = String(content || "").replace(ID, "").trim();
  const letter = /^\(?([A-D])\)?(?:[\s.,:!)]|$)/i.exec(t);
  if (approval?.kind === "decision" && letter) {
    const i = letter[1].toUpperCase().charCodeAt(0) - 65;
    const option = optionLabel(approval.payload?.options?.[i]);
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

  /** card: { content, embeds, components } from ownercopy.renderCard. */
  async function sendCard({ ticket, kind, id, card }) {
    if (!ready) return { sent: false, reason: "owner DM channel or bot token not configured" };
    const m = await api("POST", `/channels/${channel}/messages`, { content: card.content.slice(0, 1990), embeds: card.embeds, components: card.components, allowed_mentions: { parse: [] } });
    data.cards[m.id] = { ticket, kind, id, content: m.content, open: true };
    save();
    return { sent: true, messageId: m.id };
  }

  /**
   * New owner answers: [{ ticket, approvalId, messageId, answer?: {status, text}, content? }].
   * Button verdicts carry `answer`; typed replies carry `content` for parseAnswer.
   * approvalOf(ticket, id) returns the stored approval (for option labels).
   */
  async function answers(approvalOf = () => null) {
    if (!ready) return [];
    const out = [];
    // 1 clicked buttons: the verdict line appended to the card's text
    for (const [mid, card] of Object.entries(data.cards)) {
      if (!card.open) continue;
      let msg; try { msg = await api("GET", `/channels/${channel}/messages/${mid}`); } catch { continue; }
      const v = verdictFrom(msg.content, card.content, approvalOf(card.ticket, card.id));
      if (!v || !ownerIds.includes(String(v.actor))) continue;
      card.open = false;
      out.push({ ticket: card.ticket, approvalId: card.id, messageId: mid, answer: { status: v.status, text: v.text }, clicked: true });
    }
    // 2 typed replies (fallback)
    if (!data.after) {
      const last = await api("GET", `/channels/${channel}/messages?limit=1`);
      data.after = last[0]?.id || "0"; save();
      return out;
    }
    const msgs = await api("GET", `/channels/${channel}/messages?after=${data.after}&limit=50`);
    const ordered = [...msgs].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const m of ordered) {
      data.after = m.id;
      if (!ownerIds.includes(String(m.author?.id))) continue;
      const refId = m.message_reference?.message_id;
      const ref = refId && data.cards[refId];
      const named = ID.exec(m.content || "");
      const card = ref || (named && Object.values(data.cards).find((c) => c.id.toLowerCase() === named[1].toLowerCase()));
      if (card && card.open !== false) { card.open = false; out.push({ ticket: card.ticket, approvalId: card.id, content: m.content || "", messageId: m.id }); }
    }
    save();
    return out;
  }

  /** A card answered elsewhere (CLI, ticket channel) stops being polled. */
  function closeCard(approvalId) {
    for (const c of Object.values(data.cards)) if (c.id === approvalId) c.open = false;
    save();
  }

  async function acknowledge(messageId) {
    await api("PUT", `/channels/${channel}/messages/${messageId}/reactions/${encodeURIComponent("✅")}/@me`).catch(() => {});
  }

  return { ready, check, sendCard, answers, acknowledge, closeCard, parseAnswer };
}

module.exports = { createOwnerDm, parseAnswer };
