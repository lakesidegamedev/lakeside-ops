"use strict";
const crypto = require("node:crypto");

const CATEGORIES = ["feature_request", "ui_improvement", "game_balance", "new_content", "accessibility", "other"];
const SYSTEMS = ["elections", "legislature", "executive", "judiciary", "economy", "corporations", "parties", "npps", "map_geo", "combat_or_military", "diplomacy", "onboarding_account", "notifications", "meta_other"];
const snowflake = /^\d{15,22}$/;

function verifiedReceipt(result, game) {
  if (!Number.isSafeInteger(result?.issueNumber) || result.issueNumber <= 0) return null;
  try {
    const url = new URL(result.detailUrl), expected = new URL(`${game}/feedback/${result.issueNumber}`);
    if (url.protocol !== expected.protocol || url.port !== expected.port || url.hostname.replace(/^www\./, "") !== expected.hostname.replace(/^www\./, "") || url.pathname !== expected.pathname || url.username || url.password || url.search || url.hash) return null;
    return { number: result.issueNumber, url: url.href, githubIssueUrl: result.githubIssueUrl || null, filed: true };
  } catch { return null; }
}

// A durable claim precedes the game API call. An ambiguous response stays held:
// repeating a timed-out POST could create a second suggestion and notification.
function registerCreateSuggestion(server, { auth, Intake, Tickets, Suggestions, z, jsonResult, errorResult, fetchImpl = fetch, env = process.env }) {
  server.tool("support_create_suggestion", "File a native suggestion on behalf of its verified submitter (WRITE). Discord sources are fetched to verify the author. App origins must be supplied by the authenticated owner broker. Returns the native suggestion number and feedback URL, separately from optional GitHub delivery.", {
    title: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(4000),
    category: z.enum(CATEGORIES), gameSystem: z.enum(SYSTEMS),
    impact: z.string().max(500).optional(), priority: z.number().int().min(1).max(5).optional(),
    discord_user_id: z.string().regex(snowflake).optional(),
    source_channel_id: z.string().regex(snowflake).optional(), source_message_id: z.string().regex(snowflake).optional(),
    source_ticket_number: z.number().int().positive().optional(), source_ticket_message: z.string().trim().min(1).max(5000).optional(),
    app_request_id: z.string().min(1).max(200).optional(),
  }, async (input) => {
    if (auth?.scopes?.write !== true) return errorResult("write scope required");
    const game = (env.AHD_GAME_API_URL || "https://ahousedividedgame.com").replace(/\/$/, "");
    if (!env.DISCORD_BOT_API_KEY) return errorResult("Game bot API credential is not configured");
    try {
      let reporter = { id: input.discord_user_id }, source, sourceText;
      const discord = async (path) => {
        if (!env.DISCORD_BOT_TOKEN) throw new Error("Discord bot credential is not configured");
        const r = await fetchImpl(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`Cannot verify Discord source (${r.status})`);
        return r.json();
      };
      if (input.source_ticket_number) {
        if (input.app_request_id || input.source_channel_id || input.source_message_id || !input.source_ticket_message) throw new Error("Archived ticket sources cannot be mixed with another origin");
        const ticket = await Tickets?.findOne({ ticketNumber: input.source_ticket_number });
        if (!ticket || !snowflake.test(ticket.discordUserId || "") || (input.discord_user_id && ticket.discordUserId !== input.discord_user_id)) throw new Error("Archived ticket submitter does not match the reporter");
        // Legacy message strings have no author witness. Only the authenticated
        // opening report and messages with an explicit matching author qualify.
        const messages = [ticket.description, ...(ticket.messages || []).filter(m => m && typeof m === "object" && m.authorId === ticket.discordUserId).map(m => m.content)].filter(x => typeof x === "string");
        if (!messages.includes(input.source_ticket_message)) throw new Error("Archived source is not in the ticket's persisted conversation");
        reporter = { id: ticket.discordUserId, username: ticket.discordUsername, global_name: ticket.discordDisplayName };
        sourceText = input.source_ticket_message;
        source = `ticket:${ticket.ticketNumber}:${crypto.createHash("sha256").update(sourceText).digest("hex")}`;
      } else if (input.source_ticket_message) {
        throw new Error("Archived source requires its ticket number");
      } else if (input.app_request_id) {
        if (input.source_channel_id || input.source_message_id || !env.KEIR_OWNER_ID || input.discord_user_id !== env.KEIR_OWNER_ID) throw new Error("App suggestions must retain the configured owner as submitter");
        source = `app:${input.app_request_id}`;
      } else {
        if (!input.source_channel_id || !input.source_message_id) throw new Error("A real source message is required");
        const channel = await discord(`/channels/${input.source_channel_id}`);
        if (channel.guild_id !== (env.AHD_GUILD_ID || "1465445442987888743")) throw new Error("Source is outside the game guild");
        const message = await discord(`/channels/${input.source_channel_id}/messages/${input.source_message_id}`);
        if (message.id !== input.source_message_id || message.webhook_id || message.author?.bot || message.author?.id !== input.discord_user_id || !String(message.content || "").trim()) throw new Error("Suggestion submitter does not match the source author");
        reporter = message.author; sourceText = message.content.slice(0, 5000);
        source = `discord:${input.source_channel_id}:${input.source_message_id}`;
      }
      const id = crypto.createHash("sha256").update(source).digest("hex");
      const payload = { title: input.title, description: input.description, category: input.category, gameSystem: input.gameSystem,
        ...(input.impact !== undefined ? { impact: input.impact } : {}), ...(input.priority !== undefined ? { priority: input.priority } : {}),
        discordUserId: reporter.id, ...(reporter.username ? { discordUsername: reporter.username } : {}), ...(reporter.global_name ? { discordDisplayName: reporter.global_name } : {}) };
      const digest = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      try { await Intake.insertOne({ _id: id, source, reporterId: reporter.id, ...(sourceText ? { sourceText } : {}), digest, state: "started", at: new Date() }); }
      catch (e) {
        if (e.code !== 11000) throw e;
        const old = await Intake.findOne({ _id: id });
        if (old?.reporterId !== reporter.id || old?.digest !== digest) throw new Error("This source already belongs to a different submission; inspect its receipt");
        if (old.state === "done") return jsonResult({ ...old.receipt, duplicate: true });
        // Reconcile a response lost after the game committed, without another POST.
        const matches = Suggestions ? await Suggestions.find({ discordSubmitUserId: reporter.id, title: payload.title, description: payload.description, category: payload.category, gameSystem: payload.gameSystem, createdAt: { $gte: old.at, $lte: new Date(new Date(old.at).getTime() + 120000) } }).limit(2).toArray() : [];
        if (matches.length === 1) {
          const found = matches[0];
          const verified = verifiedReceipt({ issueNumber: found.issueNumber, detailUrl: found.context?.url, githubIssueUrl: found.githubIssueUrl }, game);
          if (verified && (payload.impact === undefined || found.impact === payload.impact) && (payload.priority === undefined || found.priority === payload.priority)) {
            const receipt = { ...verified, reporterId: reporter.id, source };
            await Intake.updateOne({ _id: id, digest }, { $set: { state: "done", receipt, completedAt: new Date(), reconciled: true } });
            return jsonResult({ ...receipt, duplicate: true, recovered: true });
          }
        }
        throw new Error("Previous submission outcome needs inspection; no second suggestion was created");
      }
      const response = await fetchImpl(`${game}/api/discord-bot/suggestions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Token": env.DISCORD_BOT_API_KEY }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000), redirect: "error" });
      if (!response.ok) throw new Error(`Suggestion API returned ${response.status}; inspect the intake before retrying`);
      const result = await response.json();
      const verified = verifiedReceipt(result, game);
      if (!verified) throw new Error("Suggestion API returned an incomplete receipt; inspect before retrying");
      const receipt = { ...verified, reporterId: reporter.id, source };
      await Intake.updateOne({ _id: id }, { $set: { state: "done", receipt, completedAt: new Date() } });
      return jsonResult(receipt);
    } catch (error) { return errorResult(error.message); }
  });
}
module.exports = { registerCreateSuggestion, verifiedReceipt, CATEGORIES, SYSTEMS };
