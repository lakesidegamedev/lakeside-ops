// Server-side Discord notifications for automated ticket repair / ship.
// Internal operations posts and player-facing ticket updates have separate
// builders and separate idempotency keys. Promotion steps do not create player
// messages; only development, production, heals, and resolution do.

"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const {
  LAND_ON_DEVELOPMENT_LABEL,
  LAND_ON_DEVELOPMENT_PROMPT,
  FULL_PIPELINE_LABEL,
  FULL_PIPELINE_PROMPT,
} = require("./code-ship");
const { primaryRepoDir } = require("./src/core/paths");
const { getResolution, isTerminalStatus, normalizeActions } = require("./ticket-receipt");
const { PLAYER_COPY, contextRequestKey } = require("./ticket-context");

const AHD_REPO = process.env.AHD_REPO_DIR || primaryRepoDir();
const OPS_CHANNEL = process.env.DISCORD_OPS_CHANNEL_NAME || "operations";
const DISCORD_API = "https://discord.com/api/v10";
// Post-cutover (2026-08-12) the ticket fix pipeline opens PRs on lakesidegamedev/AHDGame.
// The retired lakesidegamedev/a-house-divided repo no longer receives PR events.
const DEFAULT_TICKET_REPO = process.env.AHD_GITHUB_REPO || "lakesidegamedev/AHDGame";
/** Poll interval for the webhook-miss safety net (ms). */
const OPS_TLDR_POLL_MS = Number(process.env.TICKET_OPS_TLDR_POLL_MS || 120000);
const TICKET_ASSESS_DIR = process.env.TICKET_ASSESS_DIR || "/var/lib/lakeside-tickets/assessments";
const TICKET_LINKS_LEDGER = path.join(path.dirname(TICKET_ASSESS_DIR), "links.json");
const PLAYER_UPDATE_RETRY_MS = 10 * 60 * 1000;

function readTicketLinksLedger() {
  try {
    return JSON.parse(fs.readFileSync(TICKET_LINKS_LEDGER, "utf8")) || {};
  } catch {
    return {};
  }
}

function ticketPublicUrl(ticketNumber) {
  const n = Number(ticketNumber);
  const base = (process.env.PUBLIC_BASE || "https://ops.lakesidegames.net").replace(/\/+$/, "");
  const ledger = readTicketLinksLedger();
  let token = ledger.tokens && ledger.tokens[String(n)];
  if (!token && Number.isInteger(n) && n > 0) {
    try {
      ledger.tokens = ledger.tokens || {};
      ledger.numbers = ledger.numbers || {};
      token = cryptoRandomToken();
      ledger.tokens[String(n)] = token;
      ledger.numbers[token] = n;
      fs.mkdirSync(path.dirname(TICKET_LINKS_LEDGER), { recursive: true });
      fs.writeFileSync(TICKET_LINKS_LEDGER, JSON.stringify(ledger, null, 1));
    } catch {
      token = null;
    }
  }
  return token ? `${base}/t/${token}` : null;
}

function cryptoRandomToken() {
  return require("node:crypto").randomBytes(9).toString("base64url");
}

/**
 * Role pinged when a ticket-repair PR lands in #operations.
 * Prefer an explicit developers role; fall back to the historical Dev Team /
 * moderator id that triage already uses.
 */
function developerRoleId() {
  return (
    process.env.DISCORD_DEVELOPER_ROLE_ID
    || process.env.DISCORD_DEV_TEAM_ROLE_ID
    || process.env.DISCORD_MODERATOR_ROLE_ID
    || ""
  ).trim();
}

/**
 * Ops TL;DR is only for the ticket-repair PR into development — never for the
 * promote/sync PRs that land that fix through staging → master.
 */
function isTicketRepairOpsPr({ baseRef, headRef, title } = {}) {
  const base = String(baseRef || "").replace(/^refs\/heads\//, "").toLowerCase();
  // Fail closed: only PRs into development. Merge-through (→ staging / → master) never posts.
  if (base !== "development") return false;

  const head = String(headRef || "").replace(/^refs\/heads\//, "");
  const t = String(title || "");
  // Explicit promotion / merge-through shapes (even if somehow aimed at development).
  if (/^(promote|sync|merge|release)\b/i.test(t)) return false;
  if (/\b(development|staging)\s*→\s*(staging|master)\b/i.test(t)) return false;
  if (/^(promote|staging|development|master)([/_]|$)/i.test(head)) return false;
  if (/^promote\//i.test(head)) return false;
  return true;
}

function extractTicketNumber(...sources) {
  for (const raw of sources) {
    if (raw == null) continue;
    const text = String(raw);
    const patterns = [
      /ticket[-_/ ]?#?(\d{1,6})(?:[-_/]|$|\b)/i,
      /\bticket\s*#\s*(\d{1,6})\b/i,
      /\bauto-fix ticket #(\d{1,6})\b/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return parseInt(m[1], 10);
    }
  }
  return null;
}

function coerceTicketNumber(...sources) {
  for (const raw of sources) {
    if (raw == null || raw === "") continue;
    const direct = Number(raw);
    if (Number.isInteger(direct) && direct > 0 && direct <= 999999) return direct;
  }
  return extractTicketNumber(...sources);
}

/**
 * Build a 1–2 paragraph ops TL;DR focused on WHAT CHANGED (code fix), not the
 * diagnosis. Prefer "## What changed" / "## Fix" / "## Changes"; else "## Summary"
 * with Fix:/Changed: lines preferred; else title. Never reuse the pre-PR findings.
 */
function summarizeFix({ title, body } = {}) {
  const raw = String(body || "").replace(/\r\n/g, "\n").trim();
  if (raw) {
    const sectionMatchers = [
      /(?:^|\n)#{1,3}\s*what\s+changed\s*\n+([\s\S]*?)(?=\n#{1,3}\s+\S|\n---\s*\n|$)/i,
      /(?:^|\n)#{1,3}\s*changes?\s*\n+([\s\S]*?)(?=\n#{1,3}\s+\S|\n---\s*\n|$)/i,
      /(?:^|\n)#{1,3}\s*fix\b[^\n]*\n+([\s\S]*?)(?=\n#{1,3}\s+\S|\n---\s*\n|$)/i,
      /(?:^|\n)#{1,3}\s*summary\s*\n+([\s\S]*?)(?=\n#{1,3}\s+\S|\n---\s*\n|$)/i,
    ];
    let section = "";
    let fromNamedChangeSection = false;
    for (let i = 0; i < sectionMatchers.length; i++) {
      const m = raw.match(sectionMatchers[i]);
      if (m && m[1].trim()) {
        section = m[1].trim();
        fromNamedChangeSection = i < 3;
        break;
      }
    }
    const source = section || raw;
    // Prefer explicit "Fix:" / "Changed:" lines when Summary mixes diagnosis + fix.
    const fixLines = source
      .split(/\n+/)
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter((l) => /^(fix|changed|change|what changed)\b/i.test(l));
    if (!fromNamedChangeSection && fixLines.length) {
      const clipped = clipTldrParagraphs(
        fixLines.map((l) => l.replace(/^(fix|changed|change|what changed)\s*[:\-–—]?\s*/i, "").trim()).join("\n\n"),
        2,
        1200
      );
      if (clipped) return clipped;
    }
    const paragraphs = source
      .split(/\n\n+/)
      .map((p) => p.replace(/^#+\s*/gm, "").replace(/^[-*]\s+/gm, "• ").trim())
      .filter((p) => p && !/^(summary|description|overview|test plan|checklist|root cause)$/i.test(p));
    // Drop pure root-cause paragraphs when we have later change paragraphs.
    const changeish = paragraphs.filter((p) => !/^(root cause|diagnosis|symptom)\b/i.test(p));
    const picked = (changeish.length ? changeish : paragraphs).slice(0, 2);
    const clipped = clipTldrParagraphs(picked.join("\n\n"), 2, 1200);
    if (clipped) return clipped;
  }

  let t = String(title || "")
    .replace(/^\[.*?\]\s*/, "")
    .replace(/^(fix|feat|chore|docs|refactor)(\([^)]*\))?:\s*/i, "")
    .trim();
  return (t || "Ticket fix ready for review.").slice(0, 280);
}

function clipTldrParagraphs(text, maxParagraphs = 2, maxChars = 1200) {
  const paragraphs = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\n+/)
    .map((p) => p.replace(/\s+\n/g, "\n").trim())
    .filter(Boolean)
    .slice(0, maxParagraphs);
  if (!paragraphs.length) return "";
  let out = paragraphs.join("\n\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return out;
}

function formatOpsTldr({ prUrl, ticketNumber, summary, pingDevelopers = true } = {}) {
  const lines = [];
  const roleId = pingDevelopers ? developerRoleId() : "";
  if (roleId) lines.push(`<@&${roleId}>`);
  const url = String(prUrl || "").trim();
  if (url) lines.push(url);
  lines.push("");
  const body = String(summary || "").trim() || "Ticket fix ready for review.";
  if (Number.isInteger(ticketNumber)) {
    lines.push(`TL;DR: Ticket #${ticketNumber}`);
  } else {
    lines.push("TL;DR:");
  }
  lines.push("");
  lines.push(body);
  return lines.join("\n").slice(0, 1900);
}

/**
 * Pre-PR ops update: findings + explicit "PR on the way" so humans see progress
 * before the GitHub webhook / poller posts the PR link TL;DR.
 */
function formatOpsPrOnTheWay({ ticketNumber, title, findings, summary } = {}) {
  const lines = [];
  const roleId = developerRoleId();
  if (roleId) lines.push(`<@&${roleId}>`);
  const head = Number.isInteger(ticketNumber)
    ? `Ticket #${ticketNumber}${title ? ` — ${String(title).trim()}` : ""}`
    : (title ? String(title).trim() : "Ticket repair");
  lines.push(head);
  lines.push("");
  const body = String(findings || summary || "").trim() || "(no findings text)";
  lines.push(body.slice(0, 1500));
  lines.push("");
  lines.push("PR on the way.");
  return lines.join("\n").slice(0, 1900);
}

function playerUpdateFromPr(body) {
  const match = String(body || "").match(/(?:^|\n)#{1,3}\s*player update\s*\n+([\s\S]*?)(?=\n#{1,3}\s+\S|$)/i);
  const text = match && match[1].trim();
  return text && text.length >= 30 ? text.slice(0, 900) : null;
}

function playerUpdateFromTicket(ticket) {
  const development = (ticket && ticket.publicUpdates || []).find((update) => update.kind === "development" && !update.supersededAt);
  const message = String(development && development.message || "");
  const start = "We have a fix for this report in our test environment for verification.\n\n";
  const end = "\n\nIt is not live for everyone yet.";
  if (!message.startsWith(start) || !message.includes(end)) return null;
  return message.slice(start.length, message.indexOf(end)).trim() || null;
}

function formatProductionRecheck({ summary }) {
  return [
    "A fix for this report just shipped to production.",
    ...(summary ? ["", summary] : []),
    "",
    "Please hard-refresh and check whether the issue still occurs. Reply in this channel if it still looks wrong. We will leave this ticket open until you confirm.",
  ].join("\n").slice(0, 1900);
}

function formatDevelopmentNotice({ summary } = {}) {
  return [
    "We have a fix for this report in our test environment for verification.",
    ...(summary ? ["", summary] : []),
    "",
    "It is not live for everyone yet. We will update you again when it reaches the live game.",
  ].join("\n");
}

function formatHealAppliedNotice() {
  return [
    "We corrected the affected game data for this report.",
    "",
    "Please refresh the game and check again. If it still looks wrong, reply in this ticket channel.",
  ].join("\n");
}

function formatResolutionNotice({ message, actions, followUp } = {}) {
  const summary = String(message || "").trim().slice(0, 1200);
  const safeActions = normalizeActions(actions);
  const next = String(followUp || "").trim();
  const lines = [
    "Your support report has been resolved.",
    "",
    summary || "We completed the support work for this report.",
  ];
  if (safeActions.length) {
    lines.push("", "What we did:", ...safeActions.map((action) => `- ${action.label}${action.detail ? `: ${action.detail}` : ""}`));
  }
  lines.push("", next || "If the issue returns, reply in this ticket channel so we can help again.");
  return lines.join("\n").slice(0, 1800);
}

function formatContextRequestNotice({ needed } = {}) {
  const requests = [...new Set((needed || []).map(String))]
    .filter((kind) => PLAYER_COPY[kind])
    .map((kind) => `- ${PLAYER_COPY[kind]}`);
  if (!requests.length) return "";
  return [
    "We need one more detail to work this report:",
    "",
    ...requests,
    "",
    "Reply here with the missing link or details and we will continue.",
  ].join("\n").slice(0, 1800);
}

function discordMentionPayload(content, mentionRoleIds) {
  const roles = Array.isArray(mentionRoleIds)
    ? mentionRoleIds.filter(Boolean).map(String).slice(0, 100)
    : [];
  return {
    content: String(content).slice(0, 1900),
    // Without this, role pings in webhook/bot content are silent.
    allowed_mentions: { parse: [], roles },
  };
}

async function postDiscordWebhook(content, { mentionRoleIds } = {}) {
  const webhook = process.env.DISCORD_OPS_WEBHOOK_URL || "";
  if (!webhook) return { skipped: "no ops webhook" };
  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...discordMentionPayload(content, mentionRoleIds), ...(nonce ? { nonce, enforce_nonce: true } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `webhook ${r.status}: ${body.slice(0, 160)}` };
    }
    return { posted: true, via: "webhook" };
  } catch (e) {
    return { error: e.message };
  }
}

/** Post an embed into a channel as the bot. Same auth path as postDiscordBot. */
async function postDiscordEmbed(channelIdOrName, embed, { content } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) return { skipped: "no bot token" };
  let channelId = String(channelIdOrName || "");
  if (!/^\d{5,}$/.test(channelId)) {
    channelId = await resolveChannelId(channelId);
    if (!channelId) return { error: `unknown channel "${channelIdOrName}"` };
  }
  try {
    const r = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...(content ? { content } : {}), embeds: [embed] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `discord ${r.status}: ${body.slice(0, 160)}` };
    }
    const msg = await r.json();
    return { posted: true, via: "bot", id: msg.id, channel: channelId };
  } catch (e) {
    return { error: e.message };
  }
}

async function postDiscordBot(channelIdOrName, content, { mentionRoleIds, nonce } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) return { skipped: "no bot token" };
  let channelId = String(channelIdOrName || "");
  if (!/^\d{5,}$/.test(channelId)) {
    channelId = await resolveChannelId(channelId);
    if (!channelId) return { error: `unknown channel "${channelIdOrName}"` };
  }
  try {
    const r = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...discordMentionPayload(content, mentionRoleIds), ...(nonce ? { nonce, enforce_nonce: true } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `discord ${r.status}: ${body.slice(0, 160)}` };
    }
    const msg = await r.json();
    return { posted: true, via: "bot", id: msg.id, channel: channelId };
  } catch (e) {
    return { error: e.message };
  }
}

let _chanCache = { at: 0, byName: {} };
async function resolveChannelId(nameOrId) {
  if (/^\d{5,}$/.test(String(nameOrId))) return String(nameOrId);
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) return null;
  if (Date.now() - _chanCache.at < 60000 && Object.keys(_chanCache.byName).length) {
    return _chanCache.byName[String(nameOrId).toLowerCase().replace(/^#/, "")] || null;
  }
  try {
    let guildId = process.env.DISCORD_GUILD_ID || null;
    if (!guildId) {
      const g = await fetch(`${DISCORD_API}/users/@me/guilds`, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(8000),
      }).then((r) => (r.ok ? r.json() : []));
      guildId = g && g[0] && g[0].id;
    }
    if (!guildId) return null;
    const chans = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? r.json() : []));
    const byName = {};
    for (const c of chans || []) {
      if (c.type === 0 || c.type === 5) byName[String(c.name).toLowerCase()] = c.id;
    }
    _chanCache = { at: Date.now(), byName };
    return byName[String(nameOrId).toLowerCase().replace(/^#/, "")] || null;
  } catch {
    return null;
  }
}

function updateWasModified(result) {
  return !!(result && (result.modifiedCount > 0 || result.matchedCount > 0));
}

function playerUpdateDelivery(result, at, attempts = 1) {
  if (result && result.posted) {
    return { status: "posted", attempts, postedAt: at, messageId: result.id || null, channelId: result.channel || null };
  }
  if (result && result.skipped) return { status: "skipped", attempts, at, reason: String(result.skipped).slice(0, 240) };
  return { status: "failed", attempts, at, error: String((result && result.error) || "Discord post failed").slice(0, 240) };
}

function compactTicketUpdate(kind, message) {
  const labels = { development: "Fix in testing", production: "Fix live", heal: "Game data corrected", context: "Details requested", progress: "Update recorded" };
  const source = String(message || "").replace(/\s+/g, " ").trim();
  const caveat = /not live for everyone yet\.?/i.exec(source)?.[0];
  let summary = source.slice(0, 790);
  if (summary.length < source.length && caveat && !summary.toLowerCase().includes(caveat.toLowerCase())) summary = `${summary.slice(0, 690).trimEnd()} ${caveat}`;
  return { label: labels[kind] || "Update recorded", summary: summary.slice(0, 900) };
}

/** Edit the one durable ticket card. Progress remains on the receipt timeline. */
async function editTicketIntakeCard(ticket, { kind, message, updateKey } = {}) {
  const cardId = String(ticket && ticket.intake && ticket.intake.cardMessageId || "");
  const channelId = String(ticket && ticket.discordChannelId || "");
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!/^\d{15,22}$/.test(cardId) || !/^\d{15,22}$/.test(channelId)) return { skipped: "intake card unavailable" };
  if (!token) return { error: "no bot token" };
  const endpoint = `${DISCORD_API}/channels/${channelId}/messages/${cardId}`;
  try {
    const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
    const current = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
    if (!current.ok) return { error: `discord card fetch ${current.status}` };
    const msg = await current.json();
    const original = msg.embeds && msg.embeds[0];
    if (!original) return { error: "intake card has no embed" };
    const { label, summary } = compactTicketUpdate(kind, message);
    const fields = (original.fields || []).filter((field) => !["progress", "latest update"].includes(String(field.name || "").toLowerCase()));
    fields.push({ name: "Progress", value: label, inline: true });
    fields.push({ name: "Latest update", value: summary || "The team recorded a progress update.", inline: false });
    const edited = await fetch(endpoint, {
      method: "PATCH", headers,
      body: JSON.stringify({ embeds: [{ ...original, fields }], components: msg.components || [] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!edited.ok) return { error: `discord card edit ${edited.status}` };
    return { posted: true, via: "intake-card", id: cardId, channel: channelId, updateKey };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Record one human-facing milestone and either edit the durable intake card or
 * use the legacy channel-message path for tickets without a registered card.
 * The key is claimed in Mongo before delivery, so repeated webhooks cannot
 * create duplicate updates. Card edits are safe to retry in place.
 */
async function maybePostTicketChannelUpdate(db, {
  ticketNumber,
  key,
  kind,
  message,
  receiptUrl,
  postChannel = postDiscordBot,
  editCard = editTicketIntakeCard,
  deliveryMode = "card",
} = {}) {
  if (!Number.isInteger(Number(ticketNumber))) return { skipped: "no ticket number" };
  if (!String(key || "").trim()) return { skipped: "no update key" };
  const tickets = db.collection("tickets");
  const ticket = await tickets.findOne({ ticketNumber: Number(ticketNumber) });
  if (!ticket) return { skipped: "ticket not found" };

  const updateKey = String(key).slice(0, 180);
  const now = new Date();
  const existing = (Array.isArray(ticket.publicUpdates) ? ticket.publicUpdates : [])
    .find((entry) => String(entry && entry.key || "") === updateKey);
  deliveryMode = existing?.deliveryMode || deliveryMode;
  if (!["card", "reply"].includes(deliveryMode)) return { skipped: "invalid delivery mode" };
  const existingStatus = String(existing && existing.delivery && existing.delivery.status || "");
  if (existingStatus === "posted") {
    return { skipped: "already posted", alreadyPosted: true, posted: true, ticketNumber: Number(ticketNumber), key: updateKey };
  }
  if (existingStatus === "pending") {
    const started = new Date(existing.at || 0).getTime();
    if (!Number.isFinite(started) || Date.now() - started < PLAYER_UPDATE_RETRY_MS) {
      return { skipped: "delivery in progress", ticketNumber: Number(ticketNumber), key: updateKey };
    }
  }

  const url = receiptUrl || ticketPublicUrl(ticketNumber);
  const safeMessage = String(message || "").trim().slice(0, 1400);
  if (!safeMessage) return { skipped: "empty player message" };
  const includeReceipt = ["opening", "resolution"].includes(String(kind || ""));
  const content = (url && includeReceipt ? `${safeMessage}\n\nView your support receipt: ${url}` : safeMessage).slice(0, 1900);
  const attempts = Number(existing && existing.delivery && existing.delivery.attempts || 0) + 1;
  const pendingDelivery = { status: "pending", attempts, at: now };
  let claim;
  if (existing) {
    claim = await tickets.updateOne(
      {
        _id: ticket._id,
        publicUpdates: {
          $elemMatch: {
            key: updateKey,
            "delivery.status": { $in: ["failed", "skipped", "pending"] },
          },
        },
      },
      { $set: { "publicUpdates.$.delivery": pendingDelivery, "publicUpdates.$.at": now, "publicUpdates.$.message": safeMessage, updatedAt: now } }
    );
  } else {
    claim = await tickets.updateOne(
      { _id: ticket._id, $or: [{ publicUpdates: { $exists: false } }, { publicUpdates: { $not: { $elemMatch: { key: updateKey } } } }] },
      {
        $push: {
          publicUpdates: {
            key: updateKey,
            kind: String(kind || "update").slice(0, 40),
            deliveryMode,
            message: safeMessage,
            at: now,
            ...(url ? { receiptUrl: url } : {}),
            delivery: pendingDelivery,
          },
        },
        $set: { updatedAt: now },
      }
    );
  }
  if (!updateWasModified(claim)) return { skipped: "already claimed", ticketNumber: Number(ticketNumber), key: updateKey };

  const result = ticket.discordChannelId
    ? deliveryMode !== "reply" && ticket.intake && ticket.intake.cardMessageId
      ? await editCard(ticket, { kind, message: safeMessage, receiptUrl: url, updateKey })
      : await postChannel(ticket.discordChannelId, content, { nonce: crypto.createHash("sha256").update(`${ticketNumber}:${updateKey}`).digest("hex").slice(0, 24) })
    : { skipped: "no ticket channel" };
  const delivery = playerUpdateDelivery(result, new Date(), attempts);
  const set = {
    "publicUpdates.$.delivery": delivery,
    updatedAt: new Date(),
  };
  if (String(kind || "") === "resolution" && result && result.posted) {
    // Record the channel delivery separately. The bot still DMs the reporter
    // when the ticket closes, so a channel post must not mark that as delivered.
    set["resolution.channelDelivery"] = delivery;
  }
  await tickets.updateOne({ _id: ticket._id, "publicUpdates.key": updateKey }, { $set: set });
  return { ...result, ticketNumber: Number(ticketNumber), key: updateKey, content, receiptUrl: url, delivery };
}

async function retryPendingTicketUpdates(db, { limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - PLAYER_UPDATE_RETRY_MS);
  const tickets = await db.collection("tickets").find({
    publicUpdates: {
      $elemMatch: {
        "delivery.status": { $in: ["failed", "skipped", "pending"] },
        at: { $lte: cutoff },
      },
    },
  }).limit(Math.min(100, Math.max(1, Number(limit) || 50))).toArray();
  const results = [];
  for (const ticket of tickets) {
    for (const update of Array.isArray(ticket.publicUpdates) ? ticket.publicUpdates : []) {
      const status = String(update && update.delivery && update.delivery.status || "");
      if (!["failed", "skipped", "pending"].includes(status)) continue;
      if (Number(update.delivery && update.delivery.attempts || 0) >= 5) continue;
      results.push(await maybePostTicketChannelUpdate(db, {
        ticketNumber: ticket.ticketNumber,
        key: update.key,
        kind: update.kind,
        message: update.message,
        receiptUrl: update.receiptUrl,
        deliveryMode: update.deliveryMode || "card",
      }));
    }
  }
  return { checked: tickets.length, attempted: results.length, posted: results.filter((item) => item && item.posted).length, results };
}

async function maybePostTicketResolution(db, { ticketNumber, resolution, by } = {}) {
  const ticket = await db.collection("tickets").findOne({ ticketNumber: Number(ticketNumber) });
  if (!ticket) return { skipped: "ticket not found" };
  const receipt = getResolution({ ...ticket, resolution: resolution || ticket.resolution });
  if (!receipt) return { skipped: "no resolution receipt" };
  const receiptUrl = ticketPublicUrl(ticketNumber);
  return maybePostTicketChannelUpdate(db, {
    ticketNumber: Number(ticketNumber),
    key: `resolution:${receipt.receiptId}`,
    kind: "resolution",
    message: formatResolutionNotice({ message: receipt.message, actions: receipt.actions, followUp: receipt.followUp }),
    receiptUrl,
  });
}

async function maybePostTicketContextRequest(db, { ticketNumber, contextRequest } = {}) {
  const needed = Array.isArray(contextRequest && contextRequest.needed)
    ? [...new Set(contextRequest.needed.map(String).filter((kind) => PLAYER_COPY[kind]))]
    : [];
  if (!needed.length) return { skipped: "no missing context" };
  const ticket = await db.collection("tickets").findOne({ ticketNumber: Number(ticketNumber) });
  if (!ticket) return { skipped: "ticket not found" };
  // A closed/resolved channel is already complete. The receipt still carries
  // the banner, but a new request in a closed conversation would be confusing
  // and would look like support reopened the report.
  if (isTerminalStatus(ticket.status)) return { skipped: "ticket is terminal" };
  if ((ticket.publicUpdates || []).some((update) => ["development", "production", "heal", "resolution"].includes(update.kind) && !update.supersededAt)) {
    return { skipped: "fix already underway" };
  }
  const key = String(contextRequest.key || contextRequestKey(needed) || "");
  return maybePostTicketChannelUpdate(db, {
    ticketNumber: Number(ticketNumber),
    key,
    kind: "context",
    message: formatContextRequestNotice({ needed }),
  });
}

async function maybePostDevelopmentNotice(db, {
  repo,
  prNumber,
  title,
  body,
  headRef,
  headSha,
  baseRef,
} = {}) {
  if (!isTicketRepairOpsPr({ baseRef, headRef, title })) {
    return { skipped: "not a development ticket-repair PR" };
  }
  const ticketNumber = extractTicketNumber(headRef, title, body);
  if (!Number.isInteger(ticketNumber)) return { skipped: "no ticket number" };
  const summary = playerUpdateFromPr(body);
  if (!summary) return { skipped: "PR needs a Player update section" };
  return maybePostTicketChannelUpdate(db, {
    ticketNumber,
    key: `development:${prNumber || headSha || ticketNumber}`,
    kind: "development",
    message: formatDevelopmentNotice({ summary }),
  });
}

async function maybePostTicketHeal(db, { ticketNumber, runId, kind = "heal" } = {}) {
  if (!Number.isInteger(Number(ticketNumber))) return { skipped: "no ticket number" };
  return maybePostTicketChannelUpdate(db, {
    ticketNumber: Number(ticketNumber),
    key: `heal:${String(runId || "unknown")}`,
    kind,
    message: formatHealAppliedNotice(),
  });
}

async function postOpsPlain(content, { mentionRoleIds } = {}) {
  const viaWebhook = await postDiscordWebhook(content, { mentionRoleIds });
  if (viaWebhook.posted) return viaWebhook;
  const viaBot = await postDiscordBot(OPS_CHANNEL, content, { mentionRoleIds });
  if (viaBot.posted) return viaBot;
  return viaWebhook.error ? viaWebhook : viaBot;
}

function isShaOnRef(sha, ref, cwd = AHD_REPO) {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, ref], {
      cwd,
      timeout: 5000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function fetchOriginMain(cwd = AHD_REPO) {
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], {
      cwd,
      timeout: 30000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function ticketShipAppendix(ticketNumber) {
  if (!Number.isInteger(ticketNumber)) return "";
  return [

    "",
    `Ticket ship follow-up (ticket #${ticketNumber}):`,
    "- The repair agent (or you) should have already posted findings to #operations via support_notify_ops_findings before the PR.",
    "- The ops dashboard posts the #operations TL;DR when the fix PR opens — do not duplicate it.",
    "- Add a ## Player update section to the repair PR body. Explain in plain language what caused the report and what changed; this exact text goes to the ticket channel and public receipt at the testing milestone and again at production. Do not include private player data. A PR without this section does not publish a testing notice.",
    "- A player-facing update is posted once when the fix reaches development, once when it reaches production, and once for an applied heal. Promotion PRs do not create player messages.",
    "- After you verify the issue is actually resolved, call support_resolve with the user-facing summary, actions taken, follow-up, and source agent. That records the receipt; the bot delivers it to the player and closes the Discord ticket channel. Do not call support_set_status for a terminal ticket and do not post to Discord yourself.",
  ].join("\n");
}

function buildShipPrompt(kind, ticketNumber) {
  const base = kind === "pipeline" ? FULL_PIPELINE_PROMPT : LAND_ON_DEVELOPMENT_PROMPT;
  const label = kind === "pipeline" ? FULL_PIPELINE_LABEL : LAND_ON_DEVELOPMENT_LABEL;
  return { label, prompt: base + ticketShipAppendix(ticketNumber) };
}

async function resolveTicketContext(db, { codeSession, tmuxName, ticketNumber: known } = {}) {
  let ticketNumber = known
    || (codeSession && codeSession.ticketNumber)
    || extractTicketNumber(
      codeSession && codeSession.title,
      codeSession && codeSession.branchName,
      codeSession && codeSession.seedPrompt,
      tmuxName
    );

  let fix = null;
  if (codeSession && codeSession.sessionId) {
    fix = await db.collection("fix_sessions").findOne({ codeSessionId: codeSession.sessionId });
  }
  if (!fix && tmuxName) {
    fix = await db.collection("fix_sessions").findOne({ tmuxName });
  }
  if (fix && fix.targetType === "ticket" && fix.targetId) {
    const ticket = await db.collection("tickets").findOne({ _id: fix.targetId });
    if (ticket) {
      return {
        ticket,
        ticketNumber: ticket.ticketNumber || ticketNumber,
        fix,
        codeSessionId: fix.codeSessionId || (codeSession && codeSession.sessionId) || null,
      };
    }
  }
  if (Number.isInteger(ticketNumber)) {
    const ticket = await db.collection("tickets").findOne({ ticketNumber });
    if (ticket) {
      return {
        ticket,
        ticketNumber,
        fix: ticket.fixSessionId
          ? await db.collection("fix_sessions").findOne({ _id: ticket.fixSessionId })
          : fix,
        codeSessionId: (codeSession && codeSession.sessionId) || (fix && fix.codeSessionId) || null,
      };
    }
  }
  return { ticket: null, ticketNumber: ticketNumber || null, fix, codeSessionId: codeSession && codeSession.sessionId };
}

/**
 * Prepare a ship-choice prompt and, for full pipeline + ticket work, arm the
 * production recheck notifier.
 */
async function prepareShipChoice(db, { kind, codeSession, tmuxName } = {}) {
  const normalized = kind === "pipeline" ? "pipeline" : "development";
  const ctx = await resolveTicketContext(db, { codeSession, tmuxName });
  const { label, prompt } = buildShipPrompt(normalized, ctx.ticketNumber);

  if (normalized === "pipeline" && ctx.ticketNumber) {
    const arm = {
      ticketNumber: ctx.ticketNumber,
      awaitingProductionNotify: true,
      productionNotifyRequestedAt: new Date(),
    };
    if (ctx.codeSessionId) {
      await db.collection("code_sessions").updateOne(
        { sessionId: ctx.codeSessionId },
        { $set: { ...arm, updatedAt: new Date() } }
      );
    }
    if (ctx.fix && ctx.fix._id) {
      await db.collection("fix_sessions").updateOne(
        { _id: ctx.fix._id },
        { $set: arm }
      );
    }
  }

  return {
    kind: normalized,
    label,
    prompt,
    ticketNumber: ctx.ticketNumber || null,
    awaitingProductionNotify: normalized === "pipeline" && !!ctx.ticketNumber,
  };
}

/**
 * When a GitHub PR opens for a ticket repair, post the ops TL;DR once.
 */
async function maybePostOpsTldrForPr(db, {
  repo,
  prNumber,
  title,
  body,
  headRef,
  headSha,
  baseRef,
  prUrl,
} = {}) {
  if (!isTicketRepairOpsPr({ baseRef, headRef, title })) {
    return { skipped: "not a development ticket-repair PR" };
  }

  // Prefer the branch name — promotion PR titles often mention the ticket too.
  const ticketNumber = extractTicketNumber(headRef, title, body);
  if (!Number.isInteger(ticketNumber)) return { skipped: "no ticket number" };

  const ticket = await db.collection("tickets").findOne({ ticketNumber });
  if (!ticket) return { skipped: "ticket not found" };

  // Prefer the linked fix session; fall back to any recent running fix for this ticket.
  let fix = ticket.fixSessionId
    ? await db.collection("fix_sessions").findOne({ _id: ticket.fixSessionId })
    : null;
  if (!fix) {
    fix = await db.collection("fix_sessions").findOne(
      { targetType: "ticket", targetId: ticket._id },
      { sort: { launchedAt: -1 } }
    );
  }

  const url = prUrl || (repo && prNumber ? `https://github.com/${repo}/pull/${prNumber}` : "");
  // PR TL;DR = what changed in the PR. Do not reuse the pre-PR findings ping.
  const summary = summarizeFix({ title, body });
  const roleId = developerRoleId();
  const content = formatOpsTldr({ prUrl: url, ticketNumber, summary, pingDevelopers: true });

  // Idempotency: skip if already posted for this PR / ticket.
  if (fix && fix.opsTldrPostedAt && fix.opsTldrPrNumber === prNumber) {
    return { skipped: "already posted" };
  }
  if (ticket.opsTldrPostedAt && ticket.opsTldrPrNumber === prNumber) {
    return { skipped: "already posted on ticket" };
  }

  const result = await postOpsPlain(content, {
    mentionRoleIds: roleId ? [roleId] : [],
  });
  const stamp = {
    opsTldrPostedAt: new Date(),
    opsTldrPrNumber: prNumber || null,
    opsTldrPrUrl: url || null,
    prUrl: url || null,
    prNumber: prNumber || null,
    prHeadSha: headSha || null,
  };
  if (fix && fix._id) {
    await db.collection("fix_sessions").updateOne({ _id: fix._id }, { $set: stamp });
  }
  await db.collection("tickets").updateOne({ _id: ticket._id }, { $set: stamp });
  if (fix && fix.codeSessionId) {
    await db.collection("code_sessions").updateOne(
      { sessionId: fix.codeSessionId },
      {
        $set: {
          ticketNumber,
          prUrl: url || null,
          prNumber: prNumber || null,
          prHeadSha: headSha || null,
          prState: "OPEN",
          opsTldrPostedAt: stamp.opsTldrPostedAt,
          updatedAt: new Date(),
        },
      }
    );
  }
  return { ...result, ticketNumber, prNumber, content };
}

/** After Full Pipeline is armed, post the production milestone once the fix is live. */
async function maybePostProductionRecheck(db, { codeSession, tmuxName, worktreePath } = {}) {
  const session = codeSession || null;
  const awaiting = !!(session && session.awaitingProductionNotify)
    || !!(await (async () => {
      if (!tmuxName) return false;
      const fix = await db.collection("fix_sessions").findOne({ tmuxName });
      return !!(fix && fix.awaitingProductionNotify);
    })());
  if (!awaiting) return { skipped: "not awaiting" };

  const ctx = await resolveTicketContext(db, {
    codeSession: session,
    tmuxName,
    ticketNumber: session && session.ticketNumber,
  });
  if (!ctx.ticket || !ctx.ticketNumber) return { skipped: "no ticket" };
  if (ctx.ticket.productionNotifyPostedAt) return { skipped: "already posted" };
  if (ctx.fix && ctx.fix.productionNotifyPostedAt) return { skipped: "already posted on fix" };
  if (session && session.productionNotifyPostedAt) return { skipped: "already posted on session" };

  const sha = (session && session.prHeadSha)
    || (ctx.fix && ctx.fix.prHeadSha)
    || null;

  const cwd = worktreePath && path.isAbsolute(worktreePath) ? worktreePath : AHD_REPO;
  // Refresh the production branch so ancestor checks stay current.
  fetchOriginMain(AHD_REPO);

  let onMain = false;
  if (sha) {
    onMain = isShaOnRef(sha, "origin/main", AHD_REPO) || isShaOnRef(sha, "main", AHD_REPO);
  }
  // Fallback: if this worktree's tip is on main (feature commits promoted).
  if (!onMain && worktreePath) {
    try {
      const tip = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      onMain = isShaOnRef(tip, "origin/main", AHD_REPO) || isShaOnRef(tip, "main", AHD_REPO);
    } catch {
      /* ignore */
    }
  }
  if (!onMain) return { skipped: "not on main yet", sha };

  const content = formatProductionRecheck({ summary: playerUpdateFromTicket(ctx.ticket) });
  const result = await maybePostTicketChannelUpdate(db, {
    ticketNumber: ctx.ticketNumber,
    key: `production:${sha || ctx.ticketNumber}`,
    kind: "production",
    message: content,
  });
  if (result && result.posted) {
    const stamp = {
      productionNotifyPostedAt: new Date(),
      awaitingProductionNotify: false,
    };
    await db.collection("tickets").updateOne({ _id: ctx.ticket._id }, { $set: { productionNotifyPostedAt: stamp.productionNotifyPostedAt } });
    if (ctx.fix && ctx.fix._id) {
      await db.collection("fix_sessions").updateOne({ _id: ctx.fix._id }, { $set: stamp });
    }
    if (ctx.codeSessionId) {
      await db.collection("code_sessions").updateOne(
        { sessionId: ctx.codeSessionId },
        { $set: { ...stamp, updatedAt: new Date() } }
      );
    }
  }
  return { ...result, ticketNumber: ctx.ticketNumber, content, cwd };
}

/**
 * Post findings to #operations before the fix PR opens. Idempotent per ticket
 * (one "PR on the way" ping). Agents call this via support_notify_ops_findings;
 * they must not use discord_send.
 */
async function maybePostOpsFindings(db, {
  ticketNumber,
  title,
  findings,
  summary,
} = {}) {
  if (!Number.isInteger(ticketNumber)) return { skipped: "no ticket number" };

  const ticket = await db.collection("tickets").findOne({ ticketNumber });
  if (!ticket) return { skipped: "ticket not found" };

  let fix = ticket.fixSessionId
    ? await db.collection("fix_sessions").findOne({ _id: ticket.fixSessionId })
    : null;
  if (!fix) {
    fix = await db.collection("fix_sessions").findOne(
      { targetType: "ticket", targetId: ticket._id },
      { sort: { launchedAt: -1 } }
    );
  }

  if (fix && fix.opsFindingsPostedAt) return { skipped: "already posted" };
  if (ticket.opsFindingsPostedAt) return { skipped: "already posted on ticket" };

  const content = formatOpsPrOnTheWay({
    ticketNumber,
    title: title || ticket.title,
    findings,
    summary,
  });
  const roleId = developerRoleId();
  const result = await postOpsPlain(content, {
    mentionRoleIds: roleId ? [roleId] : [],
  });
  const stamp = {
    opsFindingsPostedAt: new Date(),
    opsFindingsText: String(findings || summary || "").slice(0, 2000),
  };
  if (fix && fix._id) {
    await db.collection("fix_sessions").updateOne({ _id: fix._id }, { $set: stamp });
  }
  await db.collection("tickets").updateOne({ _id: ticket._id }, { $set: stamp });
  if (fix && fix.codeSessionId) {
    await db.collection("code_sessions").updateOne(
      { sessionId: fix.codeSessionId },
      { $set: { ...stamp, updatedAt: new Date() } }
    );
  }
  return { ...result, ticketNumber, content };
}

/**
 * Ask #operations for an admin to run a DB heal. Agents must never apply heals
 * themselves — this is the only sanctioned path from ticket repair.
 */
function formatOpsHealRequest({ ticketNumber, title, reason, plan, env } = {}) {
  const lines = [];
  const roleId = developerRoleId();
  if (roleId) lines.push(`<@&${roleId}>`);
  const head = Number.isInteger(ticketNumber)
    ? `Admin DB heal required — ticket #${ticketNumber}${title ? ` — ${String(title).trim()}` : ""}`
    : `Admin DB heal required${title ? ` — ${String(title).trim()}` : ""}`;
  lines.push(head);
  lines.push("");
  if (env) lines.push(`Env: ${String(env)}`);
  const why = String(reason || "").trim();
  if (why) {
    lines.push("");
    lines.push(why.slice(0, 900));
  }
  const how = String(plan || "").trim();
  if (how) {
    lines.push("");
    lines.push("Proposed heal (admin must run — agents must not apply):");
    lines.push(how.slice(0, 700));
  }
  lines.push("");
  lines.push("An admin should run this heal (heal-ops / approved script). Do not leave it to the ticket agent.");
  return lines.join("\n").slice(0, 1900);
}

async function maybePostOpsHealRequest(db, {
  ticketNumber,
  title,
  reason,
  plan,
  env = "prod",
} = {}) {
  if (!Number.isInteger(ticketNumber)) return { skipped: "no ticket number" };

  const ticket = await db.collection("tickets").findOne({ ticketNumber });
  if (!ticket) return { skipped: "ticket not found" };

  let fix = ticket.fixSessionId
    ? await db.collection("fix_sessions").findOne({ _id: ticket.fixSessionId })
    : null;
  if (!fix) {
    fix = await db.collection("fix_sessions").findOne(
      { targetType: "ticket", targetId: ticket._id },
      { sort: { launchedAt: -1 } }
    );
  }

  // Allow a second ping only if the reason text changed materially; otherwise idempotent.
  const reasonKey = String(reason || "").slice(0, 200);
  if (
    (fix && fix.opsHealRequestedAt && fix.opsHealRequestReason === reasonKey)
    || (ticket.opsHealRequestedAt && ticket.opsHealRequestReason === reasonKey)
  ) {
    return { skipped: "already requested" };
  }

  const content = formatOpsHealRequest({
    ticketNumber,
    title: title || ticket.title,
    reason,
    plan,
    env,
  });
  const roleId = developerRoleId();
  const result = await postOpsPlain(content, {
    mentionRoleIds: roleId ? [roleId] : [],
  });
  const stamp = {
    opsHealRequestedAt: new Date(),
    opsHealRequestReason: reasonKey,
    opsHealRequestEnv: String(env || "prod"),
    opsHealRequestText: String(reason || "").slice(0, 2000),
  };
  if (fix && fix._id) {
    await db.collection("fix_sessions").updateOne({ _id: fix._id }, { $set: stamp });
  }
  await db.collection("tickets").updateOne({ _id: ticket._id }, { $set: stamp });
  if (fix && fix.codeSessionId) {
    await db.collection("code_sessions").updateOne(
      { sessionId: fix.codeSessionId },
      { $set: { ...stamp, updatedAt: new Date() } }
    );
  }
  return { ...result, ticketNumber, content };
}

/**
 * Safety net when the GitHub webhook misses an `opened` delivery: poll recent
 * open PRs, and post the #operations TL;DR for any ticket-repair PR that has
 * not been notified yet. Idempotent via maybePostOpsTldrForPr stamps.
 */
async function pollTicketPrOpsTldrs(db, {
  repo = DEFAULT_TICKET_REPO,
  limit = 25,
} = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ahd-ops-ticket-ship",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let pulls;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=open&per_page=${Math.min(100, limit)}&sort=created&direction=desc`,
      { headers, signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `github ${r.status}: ${body.slice(0, 160)}` };
    }
    pulls = await r.json();
  } catch (e) {
    return { error: e.message };
  }

  const results = [];
  for (const pr of pulls || []) {
    const headRef = pr.head?.ref || "";
    const title = pr.title || "";
    const body = pr.body || "";
    const ticketNumber = extractTicketNumber(headRef, title, body);
    if (!Number.isInteger(ticketNumber)) continue;
    try {
      const r = await maybePostOpsTldrForPr(db, {
        repo,
        prNumber: pr.number,
        title,
        body,
        headRef,
        headSha: pr.head?.sha,
        baseRef: pr.base?.ref,
        prUrl: pr.html_url,
      });
      if (r && !r.skipped) results.push({ prNumber: pr.number, ticketNumber, ...r });
      else if (r && r.skipped) results.push({ prNumber: pr.number, ticketNumber, skipped: r.skipped });
    } catch (e) {
      results.push({ prNumber: pr.number, ticketNumber, error: e.message });
    }
  }
  const posted = results.filter((r) => r.posted).length;
  return { checked: (pulls || []).length, considered: results.length, posted, results };
}

module.exports = {
  extractTicketNumber,
  coerceTicketNumber,
  summarizeFix,
  clipTldrParagraphs,
  formatOpsTldr,
  formatOpsPrOnTheWay,
  formatOpsHealRequest,
  formatProductionRecheck,
  playerUpdateFromPr,
  formatDevelopmentNotice,
  formatHealAppliedNotice,
  formatResolutionNotice,
  formatContextRequestNotice,
  ticketShipAppendix,
  buildShipPrompt,
  prepareShipChoice,
  maybePostOpsTldrForPr,
  maybePostOpsFindings,
  maybePostOpsHealRequest,
  maybePostTicketChannelUpdate,
  compactTicketUpdate,
  editTicketIntakeCard,
  retryPendingTicketUpdates,
  maybePostTicketResolution,
  maybePostTicketContextRequest,
  maybePostDevelopmentNotice,
  maybePostTicketHeal,
  maybePostProductionRecheck,
  pollTicketPrOpsTldrs,
  developerRoleId,
  postOpsPlain,
  postDiscordBot,
  postDiscordEmbed,
  ticketPublicUrl,
  isShaOnRef,
  isTicketRepairOpsPr,
  OPS_TLDR_POLL_MS,
};
