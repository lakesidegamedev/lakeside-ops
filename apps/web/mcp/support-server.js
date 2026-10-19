// Support MCP gives agents read access to tickets & suggestions for the
// A House Divided game, INCLUDING their screenshots (returned as MCP image
// blocks so a vision-capable agent actually sees the bug) and the AI triage
// assessment, plus WRITE-scoped tools to correct report content and to link
// reports to the long-running tracker. Streamable HTTP + scoped bearer-token auth.
//   node mcp/support-server.js   (default :9735)
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", "mcp-discord.env") });
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = require("../packages/mcp-server");
const store = require("../knowledge-store");
const tokens = require("../agent-tokens");
const merge = require("./support-tracker");
const { syncTerminalTicketTracker } = require("./support-terminal");
const { maybePostOpsFindings, maybePostOpsHealRequest, maybePostTicketResolution, maybePostTicketChannelUpdate, ticketPublicUrl } = require("../ticket-ship-notify");
const {
  getResolution,
  isTerminalStatus,
  nextResolutionVersion,
  normalizeResolution,
} = require("../ticket-receipt");

const { registerReopen } = require("./support-reopen");
const { registerInvestigations } = require("./support-investigations");

const { registerCreateSuggestion } = require("./support-create-suggestion");
const { registerCreateTicket } = require("./support-create-ticket");
const { registerMerge } = require("./support-merge");

const PORT = parseInt(process.env.SUPPORT_MCP_PORT || "9735", 10);
const OPEN_TICKET = { status: { $nin: ["closed", "resolved", "rejected"] } };
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

function mechanicsTicketTrackerStatus(kind, ticket, status) {
  if (kind !== "ticket" || !["gameplay", "mechanics"].includes(String(ticket.category || "").toLowerCase())) {
    return null;
  }
  switch (String(status).toLowerCase()) {
    case "open":
    case "triaging":
      return "open";
    case "in_progress":
      return "active";
    case "blocked":
    case "parked":
      return "blocked";
    default:
      return null;
  }
}

// Discord attachment URLs are signed and expire (~24h). Mint fresh ones with the
// bot token so a vision agent can still load old tickets' screenshots.
async function refreshDiscordUrls(urls) {
  const dUrls = (urls || []).filter((u) => /\b(cdn|media)\.discord(app)?\.(com|net)\b/.test(u));
  if (!dUrls.length || !BOT_TOKEN) return {};
  try {
    const r = await fetch("https://discord.com/api/v10/attachments/refresh-urls", {
      method: "POST", headers: { Authorization: "Bot " + BOT_TOKEN, "Content-Type": "application/json", "User-Agent": "ahd-support-mcp/1.0" },
      body: JSON.stringify({ attachment_urls: dUrls }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return {};
    const d = await r.json(); const map = {};
    (d.refreshed_urls || []).forEach((x) => { map[x.original] = x.refreshed; });
    return map;
  } catch { return {}; }
}

const ticketShape = (t) => ({
  kind: "ticket", number: t.ticketNumber, title: t.title, category: t.category, status: t.status,
  conversation: { channelId: t.discordChannelId || null, previousChannelId: t.reopenRequest?.oldChannelId || null, reopenRequestId: t.reopenRequest?.state === "complete" ? t.reopenRequest.id : null, reopenedAt: t.reopenRequest?.state === "complete" ? t.reopenRequest.completedAt : null },
  supportRecentVisits: t.supportRecentVisits || [], description: t.description, reporter: t.reporter || t.discordDisplayName || t.discordUsername || null,
  images: t.imageUrls || [], tags: t.tags || [], messages: (t.messages || []).map((m) => (typeof m === "string" ? m : m.content || m.text)).filter(Boolean),
  statusHistory: t.statusHistory || [], createdAt: t.createdAt, updatedAt: t.updatedAt, fixSessionId: t.fixSessionId || null,
  trackerItemId: t.trackerItemId || null, resolution: t.resolution || null, publicUpdates: t.publicUpdates || [], receiptUrl: t.category === "investigation" ? null : ticketPublicUrl(t.ticketNumber), notificationPolicy: { progressDeliveryDefault: false, receiptLinkKinds: ["opening", "resolution"] }, contextRequest: t.contextRequest || null,
  intake: t.intake ? {
    cardMessageId: t.intake.cardMessageId || null,
    receiptUrl: t.intake.receiptUrl || null,
    candidatePageUrl: t.intake.candidatePageUrl || null,
    pageDescription: t.intake.pageDescription || null,
    platformLabel: t.intake.platformLabel || null,
    gameVersion: t.intake.gameVersion || null,
    clientVersion: t.intake.clientVersion || null,
    pageConfirmed: Boolean(t.intake.pageConfirmed),
    platformConfirmed: Boolean(t.intake.platformConfirmed),
    awaitingReply: t.intake.awaitingReply || null,
    revision: Number(t.intake.revision || 0),
  } : null,
  closedAt: t.closedAt || null, closedBy: t.closedBy || null, resolvedAt: t.resolvedAt || null, resolvedBy: t.resolvedBy || null,
  mergedInto: t.mergedInto ?? null, mergedAt: t.mergedAt || null, mergedBy: t.mergedBy || null,
  mergedTickets: (t.mergedTickets || []).map((m) => ({ number: m.ticketNumber, discordUserId: m.discordUserId || null, mergedAt: m.mergedAt || null, mergedBy: m.mergedBy || null })),
});
const suggestionShape = (s) => ({
  kind: "suggestion", number: s.issueNumber, title: s.title, category: s.category, gameSystem: s.gameSystem || null,
  status: s.status, triageStatus: s.triageStatus || null, description: s.description, context: s.context || null,
  images: s.screenshotUrl ? [s.screenshotUrl] : [], tags: s.tags || [], priority: s.priority, impact: s.impact || null,
  statusHistory: s.statusHistory || [], createdAt: s.createdAt, fixSessionId: s.fixSessionId || null, assessmentId: s.assessmentId || null,
  trackerItemId: s.trackerItemId || null,
});

async function fetchImageBlock(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "ahd-support-mcp/1.0" }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const mimeType = r.headers.get("content-type") || "image/png";
    if (!/^image\//.test(mimeType)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return null; // skip > 5MB
    return { type: "image", data: buf.toString("base64"), mimeType };
  } catch { return null; }
}

async function main() {
  const db = await store.getDb(process.env.MONGODB_URI);
  await tokens.ensureIndexes(db);
  const Tickets = db.collection("tickets"), Suggestions = db.collection("suggestions"), Assessments = db.collection("assessments");
  const TrackerItems = db.collection(merge.TRACKER_COLLECTION);

  async function getAssessment(kind, number) {
    return Assessments.findOne({ targetType: kind, displayNumber: number }, { sort: { createdAt: -1 } });
  }

  function buildServer(auth) {
    const server = new McpServer({ name: "ops-support", version: "1.0.0" });

    server.tool("support_list", "List support tickets and/or player suggestions, filterable by status/tag/category. Returns summaries (number, title, status, tags, whether it has a screenshot).",
      { kind: z.enum(["ticket", "suggestion", "all"]).optional().default("all"), status: z.string().optional(), tag: z.string().optional(),
        category: z.string().optional(), openOnly: z.boolean().optional().default(false), limit: z.number().int().min(1).max(60).optional().default(25) },
      async ({ kind, status, tag, category, openOnly, limit }) => {
        const out = [];
        const q = {}; if (status) q.status = status; if (tag) q.tags = tag; if (category) q.category = category;
        if (kind !== "suggestion") {
          const tq = { ...q, category: category && category !== "investigation" ? category : { $ne: "investigation" } }; if (category === "investigation") tq._id = { $exists: false }; if (openOnly) Object.assign(tq, OPEN_TICKET);
          (await Tickets.find(tq).sort({ createdAt: -1 }).limit(limit).toArray()).forEach((t) => { const s = ticketShape(t); out.push({ kind: s.kind, number: s.number, title: s.title, status: s.status, category: s.category, tags: s.tags, hasImage: s.images.length > 0, createdAt: s.createdAt }); });
        }
        if (kind !== "ticket") {
          const sq = { ...q }; if (openOnly) sq.status = { $nin: ["closed", "resolved", "rejected", "done", "completed"] };
          (await Suggestions.find(sq).sort({ createdAt: -1 }).limit(limit).toArray()).forEach((g) => { const s = suggestionShape(g); out.push({ kind: s.kind, number: s.number, title: s.title, status: s.status, category: s.category, tags: s.tags, hasImage: s.images.length > 0, createdAt: s.createdAt }); });
        }
        out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return jsonResult({ count: out.length, items: out.slice(0, limit) });
      });

    server.tool("support_get", "Full detail of one ticket or suggestion — description, messages/context, status history, the linked AI triage assessment, durable resolution receipt, public update delivery history, AND its screenshots returned as viewable images.",
      { kind: z.enum(["ticket", "suggestion"]), number: z.number().int() },
      async ({ kind, number }) => {
        const doc = kind === "ticket" ? await Tickets.findOne({ ticketNumber: number }) : await Suggestions.findOne({ issueNumber: number });
        if (!doc || kind === "ticket" && doc.category === "investigation" && !auth?.scopes?.write) return errorResult(`${kind} #${number} not found`);
        const item = kind === "ticket" ? ticketShape(doc) : suggestionShape(doc);
        const a = await getAssessment(kind, number);
        const assessment = a ? { summary: a.summary, recommendation: a.recommendation || a.recommendedAction, affectedFiles: a.affectedFiles || [], complexity: a.complexity, risk: a.risk, nextSteps: a.nextSteps, confidence: a.confidence, likelyAlreadyFixed: a.likelyAlreadyFixed, tags: a.tags, model: a.model } : null;
        const content = [{ type: "text", text: JSON.stringify({ ...item, assessment }, null, 2) }];
        // attach screenshots as viewable image blocks; refresh expired Discord links first
        const refreshed = await refreshDiscordUrls(item.images);
        for (const url of item.images.slice(0, 4)) {
          const block = await fetchImageBlock(refreshed[url] || url);
          if (block) content.push(block); else content.push({ type: "text", text: `[image unavailable: ${url}]` });
        }
        return { content };
      });

    server.tool("support_search", "Keyword search across tickets & suggestions (title, description, tags).",
      { query: z.string(), kind: z.enum(["ticket", "suggestion", "all"]).optional().default("all"), limit: z.number().int().min(1).max(40).optional().default(15) },
      async ({ query, kind, limit }) => {
        const rx = { $regex: query.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), $options: "i" };
        const filt = { $or: [{ title: rx }, { description: rx }, { tags: rx }] };
        const out = [];
        if (kind !== "suggestion") (await Tickets.find({ ...filt, category: { $ne: "investigation" } }).limit(limit).toArray()).forEach((t) => { const s = ticketShape(t); out.push({ kind: "ticket", number: s.number, title: s.title, status: s.status, tags: s.tags, hasImage: s.images.length > 0 }); });
        if (kind !== "ticket") (await Suggestions.find(filt).limit(limit).toArray()).forEach((g) => { const s = suggestionShape(g); out.push({ kind: "suggestion", number: s.number, title: s.title, status: s.status, tags: s.tags, hasImage: s.images.length > 0 }); });
        return jsonResult({ query, count: out.length, results: out.slice(0, limit) });
      });

    server.tool("support_with_images", "List tickets/suggestions that have a screenshot — the visual bugs a vision agent can actually inspect via support_get.",
      { kind: z.enum(["ticket", "suggestion", "all"]).optional().default("all"), limit: z.number().int().min(1).max(40).optional().default(20) },
      async ({ kind, limit }) => {
        const out = [];
        if (kind !== "suggestion") (await Tickets.find({ category: { $ne: "investigation" }, imageUrls: { $exists: true, $ne: [] } }).sort({ createdAt: -1 }).limit(limit).toArray()).forEach((t) => out.push({ kind: "ticket", number: t.ticketNumber, title: t.title, status: t.status, images: (t.imageUrls || []).length }));
        if (kind !== "ticket") (await Suggestions.find({ screenshotUrl: { $nin: [null, ""] } }).sort({ createdAt: -1 }).limit(limit).toArray()).forEach((g) => out.push({ kind: "suggestion", number: g.issueNumber, title: g.title, status: g.status, images: 1 }));
        return jsonResult({ count: out.length, items: out });
      });

    server.tool("support_stats", "Support overview: ticket/suggestion counts by status & category, top tags, how many have screenshots, open backlog.", {}, async () => {
      const byStatus = async (col, field) => (await col.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray()).map((x) => `${x._id || "?"}:${x.n}`);
      const topTags = async (col) => (await col.aggregate([{ $unwind: "$tags" }, { $group: { _id: "$tags", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]).toArray()).map((x) => `${x._id}(${x.n})`);
      return jsonResult({
        tickets: { total: await Tickets.countDocuments(), open: await Tickets.countDocuments(OPEN_TICKET), byStatus: await byStatus(Tickets, "status"), byCategory: await byStatus(Tickets, "category"), withImages: await Tickets.countDocuments({ imageUrls: { $exists: true, $ne: [] } }) },
        suggestions: { total: await Suggestions.countDocuments(), byStatus: await byStatus(Suggestions, "status"), byCategory: await byStatus(Suggestions, "category"), withImages: await Suggestions.countDocuments({ screenshotUrl: { $nin: [null, ""] } }) },
        topTags: await topTags(Suggestions),
      });
    });

    server.tool(
      "support_set_status",
      "Update a non-terminal status of a ticket or suggestion (WRITE-scoped token required). Appends an entry to statusHistory. Gameplay and mechanics ticket statuses also sync their tracker item: open or triaging maps to open, in_progress maps to active, and blocked or parked maps to blocked. For a ticket becoming resolved or closed, always call support_resolve so the end-user receipt, actions, follow-up, and ticket-channel notification are persisted together.",
      {
        kind: z.enum(["ticket", "suggestion"]),
        number: z.number().int(),
        status: z.string().min(1).max(40),
        note: z.string().max(500).optional(),
      },
      async ({ kind, number, status, note }) => {
        if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
        const col = kind === "ticket" ? Tickets : Suggestions;
        const key = kind === "ticket" ? { ticketNumber: number } : { issueNumber: number };
        const existing = await col.findOne(key);
        if (!existing) return errorResult(`${kind} #${number} not found`);
        if (kind === "ticket" && isTerminalStatus(status)) {
          return errorResult("terminal ticket status requires support_resolve with a user-facing message, actions, follow-up, and source");
        }
        const now = new Date();
        const entry = { status, at: now, by: auth.name || "agent", source: "mcp" };
        if (note) entry.note = note;
        const trackerStatus = mechanicsTicketTrackerStatus(kind, existing, status);
        let trackerFields = {};
        if (trackerStatus) {
          const built = merge.buildTrackerUpsert(kind, number, existing.title, {
            status: trackerStatus,
            updated_by: auth.name || "agent",
          }, now.getTime());
          if (built.error) return errorResult(built.error);
          await TrackerItems.updateOne({ id: built.id }, built.update, { upsert: true });
          trackerFields = { trackerItemId: built.id, trackerUpdatedAt: now };
        }
        await col.updateOne(key, {
          $set: {
            status,
            updatedAt: now,
            ...trackerFields,
          },
          $push: { statusHistory: entry },
        });
        return jsonResult({
          ok: true,
          kind,
          number,
          previousStatus: existing.status ?? null,
          status,
        });
      }
    );

    server.tool(
      "support_resolve",
      "Record a durable end-user resolution receipt, complete the linked support tracker item, and notify the ticket channel once (WRITE-scoped). If the ticket has never been linked, this creates the canonical tracker item before the terminal ticket write. Use this for every agent, operations, or Discord resolution. Include plain player-facing wording, concrete actions taken, and any follow-up. Never post directly with discord_send. Ops posts the outcome in the ticket channel; the bot sends the reporter a final DM with the receipt link and closes the channel. This is the only supported way for an agent to mark a ticket resolved or closed.",
      {
        number: z.number().int(),
        status: z.enum(["resolved", "closed"]).optional().default("resolved"),
        message: z.string().min(1).max(5000).describe("plain-language summary the player can understand"),
        actions: z.array(z.string().min(1).max(500)).max(12).optional().default([]).describe("specific player-facing actions completed"),
        followUp: z.string().max(2000).optional().describe("what the player should do next, if anything"),
        source: z.enum(["discord", "agent", "ops"]).optional().default("agent"),
      },
      async ({ number, status, message, actions, followUp, source }) => {
        if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
        const key = { ticketNumber: number };
        const existing = await Tickets.findOne(key);
        if (!existing) return errorResult(`ticket #${number} not found`);
        const now = new Date();
        const proposed = normalizeResolution({ message, actions, followUp, source }, { by: auth.name || "agent", now });
        const prior = getResolution(existing);
        const receipt = nextResolutionVersion(existing.resolution, proposed);
        const sameResolution = prior && prior.receiptId === receipt.receiptId && existing.status === status;
        const update = {
          $set: {
            status,
            updatedAt: now,
            resolution: receipt,
            ...(status === "closed" ? { closedAt: now, closedBy: auth.name || "agent" } : { resolvedAt: now, resolvedBy: auth.name || "agent" }),
          },
        };
        if (!sameResolution) {
          update.$push = {
            statusHistory: {
              status,
              at: now,
              by: auth.name || "agent",
              source: "mcp",
              note: "resolution receipt recorded",
            },
          };
        }
        const supersededReceiptKey = `resolution:${receipt.receiptId}`;
        const correctionOptions = prior && prior.receiptId !== receipt.receiptId
          ? {
              arrayFilters: [
                {
                  "old.kind": "resolution",
                  "old.key": { $ne: supersededReceiptKey },
                },
              ],
            }
          : undefined;
        if (correctionOptions) {
          update.$set["publicUpdates.$[old].supersededAt"] = now;
        }
        let trackerSync;
        try {
          trackerSync = await syncTerminalTicketTracker({
            trackerItems: TrackerItems,
            tickets: Tickets,
            ticketKey: key,
            ticket: existing,
            number,
            resolution: receipt,
            by: auth.name || "agent",
            now,
          });
        } catch (e) {
          return errorResult(`could not complete tracker state: ${e.message}`);
        }
        await Tickets.updateOne(
          key,
          update,
          correctionOptions
        );
        const notification = await maybePostTicketResolution(db, { ticketNumber: number, resolution: receipt, by: auth.name || "agent" });
        const refreshed = await Tickets.findOne(key);
        return jsonResult({
          ok: true,
          kind: "ticket",
          number,
          status,
          receipt: getResolution(refreshed || { resolution: receipt }),
          receiptUrl: existing.category === "investigation" ? null : ticketPublicUrl(number),
          trackerItemId: trackerSync.trackerItemId,
          notification,
        });
      }
    );

    server.tool("support_update", "Correct the content of a ticket or suggestion (WRITE-scoped token required): title, description, category, tags, plus gameSystem/priority/impact/context on suggestions. Only supplied fields are written. The edit is recorded in statusHistory with the status unchanged.",
      { kind: z.enum(["ticket", "suggestion"]), number: z.number().int(),
        title: z.string().min(1).max(200).optional(), description: z.string().min(1).max(8000).optional(),
        category: z.string().min(1).max(60).optional(), tags: z.array(z.string().min(1).max(40)).max(20).optional(),
        gameSystem: z.string().min(1).max(60).optional(), priority: z.string().min(1).max(20).optional(),
        impact: z.string().min(1).max(2000).optional(), context: z.string().min(1).max(8000).optional() },
      async ({ kind, number, ...fields }) => {
        if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
        const col = kind === "ticket" ? Tickets : Suggestions;
        const key = kind === "ticket" ? { ticketNumber: number } : { issueNumber: number };
        const existing = await col.findOne(key);
        if (!existing) return errorResult(`${kind} #${number} not found`);
        if (kind === "ticket" && fields.category && fields.category !== existing.category && (fields.category === "investigation" || existing.category === "investigation")) return errorResult("Investigation privacy cannot be changed through category edits");
        const now = new Date();
        const built = merge.buildContentUpdate(kind, existing, fields, auth.name || "agent", now);
        if (built.error) return errorResult(built.error);
        await col.updateOne(key, { $set: built.set, $push: { statusHistory: built.historyEntry } });
        return jsonResult({ ok: true, kind, number, updatedFields: Object.keys(built.set).filter((k) => k !== "updatedAt") });
      });

    server.tool("support_tracker_sync", "Link a ticket or suggestion to the long-running tracker (WRITE-scoped token required). Creates or updates one tracker item keyed support-<kind>-<number> with the given project/realm/phase/status/title/body/blocked_by/tags, records the report as its source, and stores the tracker id back on the report. Re-running converges on the same item.",
      { kind: z.enum(["ticket", "suggestion"]), number: z.number().int(),
        project: z.string().min(1).max(80).optional(), realm: z.string().min(1).max(80).optional(),
        phase: z.string().min(1).max(80).optional(),
        status: z.enum(["open", "active", "blocked", "done_branch", "done_dev", "done_prod", "done", "dropped"]).optional(),
        title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(8000).optional(),
        blocked_by: z.string().min(1).max(500).optional(), tags: z.array(z.string().min(1).max(40)).max(20).optional(),
        updated_by: z.string().min(1).max(80).optional() },
      async ({ kind, number, ...trackerArgs }) => {
        if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
        const col = kind === "ticket" ? Tickets : Suggestions;
        const key = kind === "ticket" ? { ticketNumber: number } : { issueNumber: number };
        const existing = await col.findOne(key);
        if (!existing) return errorResult(`${kind} #${number} not found`);
        const nowMs = Date.now();
        const built = merge.buildTrackerUpsert(kind, number, existing.title, trackerArgs, nowMs);
        if (built.error) return errorResult(built.error);
        await TrackerItems.updateOne({ id: built.id }, built.update, { upsert: true });
        await col.updateOne(key, { $set: { trackerItemId: built.id, trackerUpdatedAt: new Date(nowMs) } });
        return jsonResult({ ok: true, kind, number, trackerItemId: built.id });
      });

    server.tool("support_tracker_note", "Append a dated progress note to the tracker item linked to a ticket or suggestion (WRITE-scoped token required). The report must already be linked via support_tracker_sync.",
      { kind: z.enum(["ticket", "suggestion"]), number: z.number().int(),
        body: z.string().min(1).max(2000), updated_by: z.string().min(1).max(80).optional() },
      async ({ kind, number, body, updated_by }) => {
        if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
        const col = kind === "ticket" ? Tickets : Suggestions;
        const key = kind === "ticket" ? { ticketNumber: number } : { issueNumber: number };
        const existing = await col.findOne(key);
        if (!existing) return errorResult(`${kind} #${number} not found`);
        if (!existing.trackerItemId) return errorResult(`${kind} #${number} is not linked to the tracker. Call support_tracker_sync first.`);
        const nowMs = Date.now();
        const parent = await TrackerItems.findOne({ id: existing.trackerItemId });
        const built = merge.buildTrackerNote(existing.trackerItemId, body, updated_by, parent && parent.project, nowMs);
        if (built.error) return errorResult(built.error);
        await TrackerItems.insertOne(built.doc);
        return jsonResult({ ok: true, kind, number, trackerItemId: existing.trackerItemId, noteId: built.id });
      });

    server.tool(
      "support_public_update",
      "Record a non-terminal progress update on a ticket's public receipt and, when `deliver` is true, deliver in the requested mode (WRITE-scoped). delivery_mode reply posts a visible new message for a player answer; card edits the existing intake card for background milestones. Use for meaningful deployment milestones or investigation findings, not every message. The `kind` sets an explicit stage label (production = Fix live, development = Fix in testing, heal = Game data corrected, progress = Update recorded); the card keeps a concise summary while the full update remains on the receipt timeline. Progress updates omit the receipt link.",
      {
        kind: z.enum(["ticket"]),
        number: z.number().int(),
        update_kind: z.enum(["development", "heal", "production", "progress", "context"]).default("progress"),
        delivery_mode: z.enum(["card", "reply"]).optional().default("reply"),
        message: z.string().min(1).max(1400),
        deliver: z.boolean().optional().default(false),
      },
      async ({ kind, number, update_kind, message, deliver, delivery_mode }) => {
        if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
        const col = Tickets;
        const key = { ticketNumber: number };
        const existing = await col.findOne(key);
        if (!existing) return errorResult(`ticket #${number} not found`);
        const now = new Date();
        const updateKey = `${update_kind}:${Date.now()}`;
        const receiptUrl = existing.category === "investigation" ? null : ticketPublicUrl(number);
        // Delivered updates are inserted by maybePostTicketChannelUpdate, which
        // claims the key itself. Pre-inserting a "pending" entry here made it
        // read our own claim as a concurrent send and skip the post.
        // "not_requested" stays out of the retry loop, which re-sends "skipped".
        if (!deliver) {
          await col.updateOne(key, {
            $push: {
              publicUpdates: {
                key: updateKey,
                kind: update_kind,
                message: String(message).trim().slice(0, 1400),
                at: now,
                receiptUrl: receiptUrl || null,
                delivery: { status: "not_requested" },
              },
            },
            $set: { updatedAt: now },
          });
        }
        let deliveryResult = null;
        if (deliver) {
          deliveryResult = await maybePostTicketChannelUpdate(db, {
            ticketNumber: number,
            key: updateKey,
            kind: update_kind,
            deliveryMode: delivery_mode,
            message,
            receiptUrl,
          });
        }
        return jsonResult({
          ok: true,
          kind: "ticket",
          number,
          updateKey,
          update_kind,
          delivered: deliver,
          delivery: deliveryResult,
        });
      });

    server.tool(
      "support_notify_ops_findings",
      "Post ticket-repair findings to Discord #operations with \"PR on the way\" (WRITE-scoped). Call once immediately before opening the development PR. Never posts to ticket channels. Idempotent per ticket.",
      {
        kind: z.enum(["ticket"]).optional().default("ticket"),
        number: z.number().int(),
        findings: z.string().min(1).max(1800).describe("1–2 short paragraphs: root cause / diagnosis (not the code-change summary)"),
        title: z.string().max(200).optional(),
      },
      async ({ number, findings, title }) => {
        if (!auth || auth.scopes?.write !== true) {
          return errorResult("write scope required — this token is read-only");
        }
        const result = await maybePostOpsFindings(db, {
          ticketNumber: number,
          findings,
          title,
        });
        return jsonResult(result);
      }
    );

    server.tool(
      "support_notify_ops_heal",
      "Request an ADMIN database heal in Discord #operations (WRITE-scoped). Ticket-repair agents must NEVER apply heals themselves (no heal_apply / mongosh writes). Call this when live data needs a heal; an admin will run it. Idempotent for the same reason text.",
      {
        kind: z.enum(["ticket"]).optional().default("ticket"),
        number: z.number().int(),
        reason: z.string().min(1).max(1200).describe("why a heal is needed (corrupt rows / who / what)"),
        plan: z.string().max(1200).optional().describe("proposed heal steps or heal-ops defect id for the admin"),
        env: z.enum(["prod", "sandbox", "dev"]).optional().default("prod"),
        title: z.string().max(200).optional(),
      },
      async ({ number, reason, plan, env, title }) => {
        if (!auth || auth.scopes?.write !== true) {
          return errorResult("write scope required — this token is read-only");
        }
        const result = await maybePostOpsHealRequest(db, {
          ticketNumber: number,
          reason,
          plan,
          env,
          title,
        });
        return jsonResult(result);
      }
    );

    registerInvestigations(server, { auth, db, z, jsonResult, errorResult });

    registerCreateSuggestion(server, { auth, Intake: db.collection("agentSuggestionIntake"), z, jsonResult, errorResult });
    registerCreateTicket(server, { auth, Tickets, z, jsonResult, errorResult, ticketPublicUrl });
    registerReopen(server, { auth, Tickets, TrackerItems, z, jsonResult, errorResult, ticketPublicUrl });

    registerMerge(server, { auth, Tickets, z, jsonResult, errorResult });
    return server;
  }

  createServer({
    name: "support-mcp", version: "1.0.0", port: PORT, bind: process.env.MCP_BIND || "127.0.0.1",
    authorize: req => tokens.validate(db, req.headers.authorization), buildServer,
  });
}
function jsonResult(o) { return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] }; }
function errorResult(m) { return { content: [{ type: "text", text: "Error: " + m }], isError: true }; }
function rpcErr(code, message) { return { jsonrpc: "2.0", error: { code, message }, id: null }; }
main().catch((e) => { console.error("[support-mcp] fatal:", e); process.exit(1); });
