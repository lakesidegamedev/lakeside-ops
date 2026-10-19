"use strict";

// support_merge: merge a repeat ticket into another ticket, usually an open
// incident. Same database semantics as the game's PATCH action "merge"
// (AHDGame #4081): the repeat ticket closes with mergedInto, mergedAt and
// mergedBy, and the target records it once in mergedTickets. Discord side,
// mirroring the bot's /merge-ticket: the reporter is added to the target
// channel and mentioned there with their report, a pointer is posted in the
// repeat ticket's channel, and that channel is then deleted.
//
// Order matters for a partial failure: the reporter is given access to the
// target before anything closes, the database link is written before the
// source channel is touched, and every step is safe to repeat.

const API = "https://discord.com/api/v10";
const VIEW_SEND_HISTORY = String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 15n)); // view, send, read history, attach files

async function discord(path, init = {}, fetchImpl = fetch) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(API + path, {
      ...init,
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "ahd-support-mcp/1.0", ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after || 1) * 1000) + 200));
      continue;
    }
    if (res.status === 404 && init.allow404) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${init.method || "GET"} ${path.split("?")[0]} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Discord ${path.split("?")[0]} stayed rate limited`);
}

const OPEN = (t) => !["closed", "resolved", "wont_fix", "rejected"].includes(t?.status);
const excerpt = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

async function mergeTicket({ Tickets, sourceNumber, targetNumber, reason, mergedBy, requireIncident = true, deleteSource = true, now = new Date(), discordImpl = discord }) {
  if (sourceNumber === targetNumber) return { error: "a ticket cannot be merged into itself" };
  const source = await Tickets.findOne({ ticketNumber: sourceNumber });
  if (!source) return { error: `ticket #${sourceNumber} not found` };
  const target = await Tickets.findOne({ ticketNumber: targetNumber });
  if (source.category === "investigation" || target?.category === "investigation") return { error: "investigation tickets cannot be merged with support tickets" };
  if (!target) return { error: `target ticket #${targetNumber} not found` };
  if (source.mergedInto != null && source.mergedInto !== targetNumber) return { error: `ticket #${sourceNumber} was already merged into #${source.mergedInto}` };
  if (target.mergedInto != null) return { error: `target #${targetNumber} was itself merged into #${target.mergedInto}` };
  if (!OPEN(target)) return { error: `target #${targetNumber} is ${target.status}` };
  if (requireIncident && target.category !== "incident") return { error: `target #${targetNumber} is a ${target.category} ticket, not an incident; pass require_incident:false only for a staff-directed merge` };
  if (source.category === "moderation") return { error: "moderation tickets are never merged by tools; moderators handle them" };

  const steps = [];
  const already = source.mergedInto === targetNumber && source.status === "closed";
  // 1. Reporter can see and post in the target before anything closes.
  if (target.discordChannelId && source.discordUserId) {
    await discordImpl(`/channels/${target.discordChannelId}/permissions/${source.discordUserId}`, { method: "PUT", body: JSON.stringify({ type: 1, allow: VIEW_SEND_HISTORY, deny: "0" }) });
    steps.push("access");
    if (!already) {
      const lines = [`<@${source.discordUserId}> joined from ticket #${sourceNumber}: ${excerpt(source.title, 120)}`];
      const report = source.description || source.messages?.[0]?.content;
      if (report) lines.push(`> ${excerpt(report, 400)}`);
      await discordImpl(`/channels/${target.discordChannelId}/messages`, { method: "POST", body: JSON.stringify({ content: lines.join("\n"), allowed_mentions: { users: [source.discordUserId] } }) });
      steps.push("announced");
    }
  }
  // 2. Database link, both directions, each guarded so a retry adds nothing.
  await Tickets.updateOne(
    { ticketNumber: targetNumber, "mergedTickets.ticketNumber": { $ne: sourceNumber } },
    { $set: { updatedAt: now }, $push: { mergedTickets: { ticketNumber: sourceNumber, ...(source.discordUserId ? { discordUserId: source.discordUserId } : {}), mergedAt: now, ...(mergedBy ? { mergedBy } : {}) } } }
  );
  if (!already) {
    const note = `merged into #${targetNumber}${reason ? `: ${reason}` : ""}`.slice(0, 600);
    await Tickets.updateOne(
      { ticketNumber: sourceNumber, $or: [{ mergedInto: { $exists: false } }, { mergedInto: targetNumber }] },
      { $set: { status: "closed", mergedInto: targetNumber, mergedAt: now, closedAt: now, updatedAt: now, ...(mergedBy ? { mergedBy, closedBy: mergedBy } : {}) },
        $push: { statusHistory: { status: "closed", at: now, source: "mcp", note, ...(mergedBy ? { by: mergedBy } : {}) } } }
    );
  }
  steps.push("linked");
  // 3. Pointer in the repeat ticket, then close its channel like the bot does.
  if (source.discordChannelId && !already) {
    const label = target.category === "incident" ? "incident" : "ticket";
    const pointer = target.discordChannelId
      ? `This is the same problem as ${label} #${targetNumber}, so your report has been added there. You can follow updates and add anything new in <#${target.discordChannelId}>.`
      : `This is the same problem as ${label} #${targetNumber}, so your report has been added there.`;
    await discordImpl(`/channels/${source.discordChannelId}/messages`, { method: "POST", allow404: true, body: JSON.stringify({ content: pointer, allowed_mentions: { parse: [] } }) });
    steps.push("pointer");
    if (deleteSource && target.discordChannelId) {
      await discordImpl(`/channels/${source.discordChannelId}`, { method: "DELETE", allow404: true, headers: { "X-Audit-Log-Reason": encodeURIComponent(`Ticket #${sourceNumber} merged into #${targetNumber}`) } });
      steps.push("source-channel-deleted");
    }
  }
  return { ok: true, alreadyMerged: already, sourceNumber, targetNumber, targetCategory: target.category, steps };
}

function registerMerge(server, { auth, Tickets, z, jsonResult, errorResult }) {
  server.tool(
    "support_merge",
    "Merge a repeat ticket into another open ticket, usually an incident (WRITE-scoped token required). The repeat ticket closes with a link to the target, its reporter is added to the target channel and mentioned there with their report, a pointer is posted in the repeat ticket, and its channel is deleted. By default the target must be an incident; staff-directed merges into other tickets pass require_incident false. Moderation tickets are refused. Safe to retry.",
    {
      source_number: z.number().int().positive().describe("The repeat ticket to merge"),
      target_number: z.number().int().positive().describe("The open ticket it joins, usually an incident"),
      reason: z.string().trim().max(500).optional().describe("Why they are the same problem; recorded in history"),
      merged_by: z.string().trim().max(128).optional().describe("Who asked for the merge: a Discord id, or the agent name"),
      require_incident: z.boolean().default(true),
      delete_source_channel: z.boolean().default(true),
    },
    async ({ source_number, target_number, reason, merged_by, require_incident, delete_source_channel }) => {
      if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
      try {
        const out = await mergeTicket({ Tickets, sourceNumber: source_number, targetNumber: target_number, reason, mergedBy: merged_by || auth.name || "agent", requireIncident: require_incident, deleteSource: delete_source_channel });
        return out.error ? errorResult(out.error) : jsonResult(out);
      } catch (e) {
        return errorResult(`merge failed part way; it is safe to call again: ${String(e.message || e).slice(0, 300)}`);
      }
    }
  );
}

module.exports = { registerMerge, mergeTicket };
