"use strict";
// The answer feedback row Keir puts under its answers. Player replies posted by the
// support service carry the identical row; Keir's interaction handler records clicks on
// them (see adoptSupportReply in apps/agent/lib/operator/feedback.js). This file is a
// dependency-free copy because the web service does not ship apps/agent; a test in
// apps/agent/test keeps the two identical. stripOthers keeps the "newest message only"
// rule when a support reply lands (the matching rule for Keir's own answers is in
// apps/agent/lib/operator/feedback.js).
const PREFIX = "keir_fb:";

function row() {
  return [{ type: 1, components: [
    { type: 2, style: 2, emoji: { name: "⭐" }, custom_id: `${PREFIX}great` },
    { type: 2, style: 2, emoji: { name: "👍" }, custom_id: `${PREFIX}up` },
    { type: 2, style: 2, emoji: { name: "👎" }, custom_id: `${PREFIX}down` },
    { type: 2, style: 2, label: "Report a problem", custom_id: `${PREFIX}report` },
  ] }];
}

const holdsRow = (m) => /^\d+$/.test(String(m && m.id || ""))
  && (m.components || []).some((r) => (r.components || []).some((c) => String(c.custom_id || "").startsWith(PREFIX)));

/**
 * One row per channel, on the newest message. Called after a reply lands: lists the
 * channel's recent messages and removes the row from every holder except keepId, whether
 * it came from Keir or an earlier support reply. Best effort, never throws; Keir's own
 * sweep catches anything missed. Only the bot that owns the rows can edit them.
 */
async function stripOthers(channelId, keepId, { token = process.env.DISCORD_BOT_TOKEN || "", api = "https://discord.com/api/v10", fetchImpl = fetch } = {}) {
  if (!token || !/^\d{15,22}$/.test(String(channelId || "")) || !keepId) return { skipped: true, stripped: [] };
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  const stripped = [];
  try {
    const r = await fetchImpl(`${api}/channels/${channelId}/messages?limit=100`, { headers, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { error: `discord ${r.status}`, stripped };
    const list = await r.json();
    for (const m of (Array.isArray(list) ? list : []).filter(holdsRow)) {
      if (m.id === String(keepId)) continue;
      const p = await fetchImpl(`${api}/channels/${channelId}/messages/${m.id}`, { method: "PATCH", headers, body: JSON.stringify({ components: [] }), signal: AbortSignal.timeout(8000) });
      if (p.ok) stripped.push(m.id);
    }
    return { stripped };
  } catch (e) {
    return { error: e.message, stripped };
  }
}

module.exports = { row, stripOthers, holdsRow, PREFIX };
