"use strict";
/**
 * support_create_ticket: open a support ticket on a player's behalf, the same
 * way the Discord ticket bot does, for reports made outside the ticket flow
 * (a #general message, a DM, a screenshot passed along by staff).
 *
 * 1. Reserves a number from the shared atomic game counter before creating a channel.
 * 2. Creates the ticket channel in the ticket category, copying the role and
 *    bot permission overwrites from the newest existing ticket channel and
 *    granting the reporter the same access the bot grants.
 * 3. Posts the bot's ticket embed with its Claim and Close buttons, so the
 *    bot's own handlers work on it, plus the staff role ping.
 * 4. Registers the ticket with the game through the bot API so triage, the
 *    receipt page and the support MCP see it like any other ticket.
 *
 * Env: DISCORD_BOT_TOKEN (StarmerBot), DISCORD_BOT_API_KEY (game bot API),
 * AHD_GUILD_ID / AHD_TICKET_CATEGORY_ID / AHD_TICKET_PING_ROLE_ID optional.
 */

const GUILD_ID = process.env.AHD_GUILD_ID || "1465445442987888743";
const TICKET_CATEGORY_ID = process.env.AHD_TICKET_CATEGORY_ID || "1483979826967744534";
const PING_ROLE_ID = process.env.AHD_TICKET_PING_ROLE_ID || "1470571508689535188";
const GAME_API = process.env.AHD_GAME_API_URL || "https://ahousedividedgame.com";
const API = "https://discord.com/api/v10";

const CATEGORY = {
  bug: { slug: "bug", label: "Bug Report", emoji: "🐛", color: 15548997 },
  gameplay: { slug: "mechanics", label: "Mechanics Help", emoji: "🧩", color: 5793266 },
  moderation: { slug: "moderation", label: "Moderation", emoji: "🛡️", color: 15105570 },
  account: { slug: "account", label: "Account", emoji: "👤", color: 3447003 },
  other: { slug: "other", label: "Other", emoji: "📨", color: 9807270 },
  // Staff-opened catch-all for an outage or a problem many players hit
  // (AHDGame #4081). Keir may open one for a severe cluster of tickets.
  incident: { slug: "incident", label: "Incident", emoji: "🚨", color: 13843259 },
};

async function discord(path, init = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, {
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

function channelSlug(name) {
  return String(name || "player").toLowerCase().replace(/[^a-z0-9_-]+/g, "").slice(0, 32) || "player";
}

function ticketPageCandidate(description) {
  const match = String(description || "").match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.;]+$/, "");
  if (!match) return null;
  try {
    const url = new URL(match);
    const path = url.pathname.split(/[?#]/, 1)[0];
    if (url.protocol !== "https:" || url.username || url.password || !/^(?:www\.)?ahousedividedgame\.com$/i.test(url.hostname)) return null;
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\s<>%]|\.\./.test(path) || path.length > 300 || /^\/(?:api|admin|moderator|auth|login|logout|register|reset-password|settings|account)(?:\/|$)/i.test(path)) return null;
    return `https://ahousedividedgame.com${path}`;
  } catch {
    return null;
  }
}

function normalizePlatformLabel(value) {
  const label = String(value || "").toLowerCase();
  if (/android/.test(label)) return "Android";
  if (/\bios\b|iphone|ipad/.test(label)) return "iOS";
  if (/mobile|phone|tablet/.test(label)) return /browser|web/.test(label) ? "Mobile browser" : "Mobile";
  if (/desktop|windows|macos|linux|computer|laptop/.test(label)) return /client|app/.test(label) ? "Desktop client" : "Desktop browser";
  if (/client/.test(label)) return "Desktop client";
  return "Platform unknown";
}

function ticketIntakeComponents(number) {
  return [
    { type: 1, components: [
      { type: 2, custom_id: `ticket_intake:confirm_page:${number}`, style: 1, label: "Confirm page" },
      { type: 2, custom_id: `ticket_intake:change_page:${number}`, style: 2, label: "Change page" },
      { type: 2, custom_id: `ticket_intake:confirm_platform:${number}`, style: 1, label: "Confirm details" },
      { type: 2, custom_id: `ticket_intake:edit_details:${number}`, style: 2, label: "Edit details" },
    ] },
  ];
}

async function sendWithRetry(
  channelId,
  message,
  nonce,
  send = discord,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const idempotentMessage = { ...message, nonce, enforce_nonce: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await send(`/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify(idempotentMessage),
      });
      return true;
    } catch (error) {
      if (attempt === 2) {
        console.error(`Discord message delivery failed in channel ${channelId}:`, error);
        return false;
      }
      await wait(400 * (attempt + 1));
    }
  }
  return false;
}

async function editMessageWithRetry(path, message, edit = discord, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await edit(path, { method: "PATCH", body: JSON.stringify(message) });
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(400 * (attempt + 1));
    }
  }
  console.error(`Discord card edit failed for ${path}:`, lastError);
  return false;
}

// A failure we can name for the caller. stage is "invalid" for bad input,
// "reserve" when no number was reserved (nothing was created), and "register"
// when the channel exists but the game API refused the ticket.
class TicketCreateError extends Error {
  constructor(message, { stage = "upstream", channel = null } = {}) {
    super(message);
    this.name = "TicketCreateError";
    this.stage = stage;
    this.channel = channel;
  }
}

// Find a guild member by Discord username. Exact username match only, so a
// near miss never grants a stranger access to someone else's ticket.
async function findGuildMemberByUsername(name, send = discord) {
  const query = String(name || "").trim().replace(/^@/, "").replace(/#0$/, "").toLowerCase();
  if (!/^[a-z0-9_.]{2,32}$/.test(query)) return null;
  const results = await send(`/guilds/${GUILD_ID}/members/search?query=${encodeURIComponent(query)}&limit=10`);
  return (Array.isArray(results) ? results : []).find((m) => m.user && !m.user.bot && String(m.user.username).toLowerCase() === query) || null;
}

// Find a guild member by Discord id, or null when they are not in the server.
async function findGuildMember(discordUserId, send = discord) {
  if (!/^\d{15,22}$/.test(String(discordUserId || ""))) return null;
  const member = await send(`/guilds/${GUILD_ID}/members/${discordUserId}`, { allow404: true });
  return member?.user && !member.user.bot ? member : null;
}

/**
 * Open a ticket: reserve the number, create the channel, post the intake card
 * and staff ping, register with the game and persist the intake details.
 * Shared by the support_create_ticket tool and the public web intake route.
 *
 * With no discordUserId the bot is the reporter. That is allowed for an
 * incident and for an openedVia source such as the website form; those
 * tickets get Claim/Close only, without the page and platform controls.
 */
async function createSupportTicket({
  discordUserId, category = "bug", title, description, platform, imageUrls, sourceChannelId,
  ticketPublicUrl, openedVia, channelLabel, extraFields = [],
}) {
  const botApiKey = process.env.DISCORD_BOT_API_KEY;
  if (!botApiKey) throw new TicketCreateError("DISCORD_BOT_API_KEY is not configured for the support MCP", { stage: "config" });
  const meta = CATEGORY[category];
  if (!meta) throw new TicketCreateError(`unknown category ${category}`, { stage: "invalid" });
  const incident = category === "incident";
  const me = await discord("/users/@me");
  if (!discordUserId) {
    if (!incident && !openedVia) throw new TicketCreateError("discord_user_id is required for a player ticket", { stage: "invalid" });
    discordUserId = me.id;
  }
  const botReporter = discordUserId === me.id;
  const intakeControls = !incident && !botReporter;
  const member = await discord(`/guilds/${GUILD_ID}/members/${discordUserId}`);
  const username = member.user.username;
  const displayName = member.nick || member.user.global_name || username;

  const channels = await discord(`/guilds/${GUILD_ID}/channels`);
  const ticketChannels = channels
    .filter((c) => c.type === 0 && /^(?:closed-)?ticket-.+-\d+$/.test(c.name || ""))
    .map((c) => ({ ...c, number: Number(c.name.match(/-(\d+)$/)[1]) }))
    .sort((a, b) => b.number - a.number);
  const reserved = await fetch(`${GAME_API}/api/discord-bot/tickets/reserve`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Token": botApiKey },
    body: JSON.stringify({ discordFloor: ticketChannels[0]?.number || 0 }),
    signal: AbortSignal.timeout(20000),
  });
  if (!reserved.ok) throw new TicketCreateError(`Ticket number reservation failed (${reserved.status}); no channel was created`, { stage: "reserve" });
  const { ticketNumber: number } = await reserved.json();
  if (!Number.isSafeInteger(number) || number <= (ticketChannels[0]?.number || 0)) throw new TicketCreateError("Invalid ticket number reservation; no channel was created", { stage: "reserve" });

  const template = ticketChannels[0];
  const overwrites = template
    ? template.permission_overwrites.filter((o) => o.type === 0 || o.id === me.id)
    : [{ id: GUILD_ID, type: 0, allow: "0", deny: "1024" }];
  if (!overwrites.some((o) => o.id === GUILD_ID)) overwrites.push({ id: GUILD_ID, type: 0, allow: "0", deny: "1024" });
  if (!overwrites.some((o) => o.id === me.id)) overwrites.push({ id: me.id, type: 1, allow: "11280", deny: "0" });
  const reporterAllow = template?.permission_overwrites.find((o) => o.type === 1 && o.id !== me.id)?.allow || "68608";
  if (!botReporter) overwrites.push({ id: discordUserId, type: 1, allow: reporterAllow, deny: "0" });

  const channel = await discord(`/guilds/${GUILD_ID}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name: `ticket-${meta.slug}-${channelSlug(channelLabel || username)}-${number}`,
      type: 0,
      parent_id: template?.parent_id || TICKET_CATEGORY_ID,
      permission_overwrites: overwrites.map(({ id, type, allow, deny }) => ({ id, type, allow, deny })),
    }),
  });

  const created = Math.floor(Date.now() / 1000);
  const fields = [
    { name: "Opened by", value: openedVia || `<@${me.id}> on behalf of <@${discordUserId}>`, inline: false },
    { name: "Reporter", value: botReporter && openedVia ? "No Discord account linked" : `<@${discordUserId}>`, inline: true },
    { name: "Category", value: meta.label, inline: true },
    { name: "Created", value: `<t:${created}:R>`, inline: true },
    ...(platform ? [{ name: "Platform", value: normalizePlatformLabel(platform), inline: true }] : []),
    ...extraFields.filter((f) => f && f.name && f.value).map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: Boolean(f.inline) })),
    { name: "Subject", value: title.slice(0, 200), inline: false },
  ];
  let candidatePageUrl = ticketPageCandidate(description);
  let platformLabel = normalizePlatformLabel(platform);
  let gameVersion = null;
  let clientVersion = null;
  // Page and platform prompts are for a reporter in the channel. Without one
  // (incident, web form with no matched member) nobody could answer them.
  if (intakeControls) fields.push(
    { name: "Intake", value: "Please confirm the page and platform details", inline: false },
    { name: "Affected page / issue", value: candidatePageUrl ? `[${candidatePageUrl}](${candidatePageUrl}) · please confirm` : "No page detected · confirm or replace the suggested page", inline: false },
    { name: "Platform and versions", value: [platformLabel, "Game: version unknown", "Client: version unknown", "Status: please confirm"].join("\n"), inline: false },
  );
  fields.push({ name: "Receipt", value: "Receipt link is being prepared", inline: false });
  const embed = await discord(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      embeds: [{ title: `${meta.emoji} ${meta.label} - #${number}`, color: meta.color, fields, footer: { text: "ahousedividedgame.com" } }],
      components: [{ type: 1, components: [
        { type: 2, custom_id: "ticket_claim", style: 2, label: "Claim", emoji: { name: "🙋" } },
        { type: 2, custom_id: "ticket_close", style: 4, label: "Close Ticket", emoji: { name: "🔒" } },
      ] }],
    }),
  });
  await discord(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: `<@&${PING_ROLE_ID}>`, allowed_mentions: { roles: [PING_ROLE_ID] } }),
  });
  const res = await fetch(`${GAME_API}/api/discord-bot/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bot-Token": botApiKey },
    body: JSON.stringify({
      category, title, description, ticketNumber: number,
      discordChannelId: channel.id, discordUserId,
      discordUsername: username, discordDisplayName: displayName,
      ...(imageUrls?.length ? { imageUrls } : {}),
      message: { discordMessageId: embed.id, authorId: discordUserId, authorName: displayName, content: description, ...(imageUrls?.length ? { imageUrls } : {}) },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new TicketCreateError(`channel #${channel.name} created but the game API refused the ticket (${res.status}): ${body.slice(0, 300)}. Register it before anyone replies.`, { stage: "register", channel });
  }
  const registered = JSON.parse(body);
  const receiptUrl = ticketPublicUrl?.(number) || null;
  try {
    const contextRes = await fetch(`${GAME_API}/api/discord-bot/tickets?ticketNumber=${number}&discordChannelId=${encodeURIComponent(channel.id)}`, {
      headers: { "X-Bot-Token": botApiKey }, signal: AbortSignal.timeout(10000),
    });
    if (contextRes.ok) {
      const context = await contextRes.json();
      const suggestion = context.intakeSuggestion || {};
      candidatePageUrl = candidatePageUrl || suggestion.candidatePageUrl || null;
      platformLabel = platform ? normalizePlatformLabel(platform) : normalizePlatformLabel(suggestion.platformLabel);
      gameVersion = suggestion.gameVersion || null;
      clientVersion = suggestion.clientVersion || null;
    }
  } catch (error) {
    console.warn(`Ticket #${number} intake context lookup failed:`, error.message);
  }
  const questions = (registered.contextQuestions || []).filter((q) => typeof q === "string" && q.trim()).slice(0, 4);
  const updatedFields = fields.filter((field) => !["Intake", "Affected page / issue", "Platform and versions", "Receipt", "Details needed"].includes(field.name));
  if (intakeControls) updatedFields.push(
    { name: "Intake", value: "Please confirm the page and platform details", inline: false },
    { name: "Affected page / issue", value: candidatePageUrl ? `[${candidatePageUrl}](${candidatePageUrl}) · please confirm` : "No page detected · confirm or replace the suggested page", inline: false },
    { name: "Platform and versions", value: [platformLabel, `Game: ${gameVersion || "version unknown"}`, `Client: ${clientVersion || "version unknown"}`, "Status: please confirm"].join("\n"), inline: false },
  );
  updatedFields.push({ name: "Receipt", value: receiptUrl ? `[View ticket receipt](${receiptUrl})` : "Receipt link unavailable", inline: false });
  if (intakeControls && questions.length) updatedFields.push({ name: "Details needed", value: questions.join("\n").slice(0, 1000), inline: false });
  const intakePersistResponse = await fetch(`${GAME_API}/api/discord-bot/tickets`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Bot-Token": botApiKey },
    body: JSON.stringify({
      action: "intake", ticketNumber: number, discordChannelId: channel.id,
      intake: {
        cardMessageId: embed.id, receiptUrl, candidatePageUrl,
        platformLabel, gameVersion, clientVersion,
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const intakePersisted = intakePersistResponse.ok;
  const intakeCardDelivered = await editMessageWithRetry(`/channels/${channel.id}/messages/${embed.id}`, {
      embeds: [{ ...embed.embeds[0], fields: updatedFields, footer: { text: intakeControls ? "✅ Correct page / issue · ❌ Wrong page / issue · ahousedividedgame.com" : "ahousedividedgame.com" } }],
      components: [{ type: 1, components: [
        { type: 2, custom_id: "ticket_claim", style: 2, label: "Claim", emoji: { name: "🙋" } },
        { type: 2, custom_id: "ticket_close", style: 4, label: "Close Ticket", emoji: { name: "🔒" } },
      ] }, ...(intakeControls ? ticketIntakeComponents(number) : [])],
  });
  if (intakeControls) {
    await discord(`/channels/${channel.id}/messages/${embed.id}/reactions/%E2%9C%85/@me`, { method: "PUT" }).catch(() => {});
    await discord(`/channels/${channel.id}/messages/${embed.id}/reactions/%E2%9D%8C/@me`, { method: "PUT" }).catch(() => {});
  }
  const receiptDelivered = Boolean(receiptUrl) && intakePersisted && intakeCardDelivered;
  const questionsDelivered = intakeCardDelivered;
  const announcementDelivered = !sourceChannelId || await sendWithRetry(sourceChannelId, {
    content: `Starmer opened a ticket on behalf of <@${discordUserId}>: https://discord.com/channels/${GUILD_ID}/${channel.id}`,
    allowed_mentions: { users: [discordUserId] },
  }, `t${number}-announcement`);
  return {
    ok: true, ticketNumber: number, channelId: channel.id, channelName: channel.name,
    channelUrl: `https://discord.com/channels/${GUILD_ID}/${channel.id}`, reporter: { id: discordUserId, username, displayName },
    receiptUrl, receiptDelivered, questionsDelivered, intakePersisted, intakeCardDelivered, announcementDelivered,
  };
}

function registerCreateTicket(server, { auth, Tickets, z, jsonResult, errorResult, ticketPublicUrl }) {
  server.tool(
    "support_create_ticket",
    "Open a support ticket on a player's behalf (WRITE-scoped token required). Use for reports made outside the ticket flow. Category incident opens a staff catch-all for an outage or a problem many players hit; it needs no reporter, and repeat tickets then join it with support_merge. Creates the ticket channel, posts one persistent intake card with Claim/Close and page/platform controls, and registers it with the game. Returns the ticket number and channel.",
    {
      discord_user_id: z.string().regex(/^\d{15,22}$/).optional().describe("Reporter's Discord user id; optional only for an incident, which defaults to the bot"),
      category: z.enum(["bug", "gameplay", "moderation", "account", "other", "incident"]).default("bug"),
      title: z.string().trim().min(1).max(200).describe("Ticket subject, shown in the embed"),
      description: z.string().trim().min(1).max(5000).describe("What the player reported, in their words where possible, with context"),
      platform: z.string().trim().max(100).optional().describe("Broad platform or device class such as Android, iOS, mobile browser, desktop browser, or desktop client"),
      source_channel_id: z.string().regex(/^\d{15,22}$/).optional().describe("Originating chat; announce that Starmer opened the ticket with a link"),
      image_urls: z.array(z.string().url()).max(10).optional(),
    },
    async ({ discord_user_id, category, title, description, platform, image_urls, source_channel_id }) => {
      if (!auth || auth.scopes?.write !== true) return errorResult("write scope required — this token is read-only");
      try {
        return jsonResult(await createSupportTicket({
          discordUserId: discord_user_id, category, title, description, platform,
          imageUrls: image_urls, sourceChannelId: source_channel_id, ticketPublicUrl,
        }));
      } catch (error) {
        return errorResult(String(error.message || error));
      }
    }
  );
}

module.exports = {
  registerCreateTicket, createSupportTicket, findGuildMemberByUsername, findGuildMember, TicketCreateError,
  sendWithRetry, ticketPageCandidate, discord, CATEGORY, channelSlug,
};
