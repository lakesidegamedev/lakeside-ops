"use strict";
// The ticket bot's intake card names the category: a "Category" field
// ("Moderation Issue") and a title like "🛡️ Moderation Issue — #0042".
// Moderation tickets belong to human moderators; Keir never works them.
// Incident tickets are staff-owned catch-alls that repeat reports merge into.
function ticketCategory(rows, botId) {
  for (const m of rows || []) {
    if (m.author?.id !== botId) continue;
    for (const e of m.embeds || []) {
      const field = (e.fields || []).find((f) => String(f.name).toLowerCase() === "category")?.value;
      const text = String(field || (/#\d+/.test(e.title || "") ? e.title : "") || "").toLowerCase();
      if (!text) continue;
      if (text.includes("investigation")) return "investigation";
      if (text.includes("moderation")) return "moderation";
      if (text.includes("incident")) return "incident";
      if (text.includes("suggest")) return "suggestion";
      if (text.includes("bug")) return "bug";
      return "mechanics";
    }
  }
  return null;
}
// Keir 5.7.1 (owner, 2026-10-16): "if I direct Keir to work in it he should
// work in it". An owner direction on a ticket (app directive or an instruction
// in the channel) sets ownerDirectedAt and lifts the moderation/incident
// stand-down for that ticket only.
const ownerDirected = (ledger, channelId) => Boolean(ledger.data.channels?.[channelId]?.ownerDirectedAt);
const isModerationChannel = (ledger, channelId) => ["moderation", "investigation"].includes(ledger.data.channels?.[channelId]?.category) && !ownerDirected(ledger, channelId);
const isIncidentChannel = (ledger, channelId) => ledger.data.channels?.[channelId]?.category === "incident" && !ownerDirected(ledger, channelId);
// Categories Keir never opens automatic ticket work in: humans own them.
const STAFF_OWNED = new Set(["moderation", "incident", "investigation"]);
module.exports = { ticketCategory, isModerationChannel, isIncidentChannel, ownerDirected, STAFF_OWNED };
