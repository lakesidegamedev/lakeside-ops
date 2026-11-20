"use strict";
// Keir 11.1: a ticket answer that carries Keir's evidence chart.
//
// Keir stages a presentation in the shared evidence store
// (EVIDENCE_PAGES_DIR/<id>/: chart.png, delivery.json, and meta.json plus
// snapshots when a report page exists). support_public_update passes only the
// id. This file decides, from the ticket row and the store alone, whether that
// id may go on this ticket's reply:
//
//   - the id is 32 hex and its directory is a real directory in the store;
//   - delivery.json names this ticket and this ticket's current channel, and
//     its attach window has not passed;
//   - chart.png is a regular PNG file of bounded size (no links), unless the
//     manifest says `chart: false`: a link-only presentation (a dense dated
//     report with mixed units has no single chart);
//   - a report link is built here from EVIDENCE_PUBLIC_BASE (explicitly set,
//     no default), only when Keir staged one and meta.json and the first
//     snapshot exist with the same visibility and, if private, this ticket.
//     A link-only presentation with no buildable link is refused, so the
//     answer goes as plain text.
//   - answerTo, the request the stage answers, is passed on only as a
//     candidate; the reply path verifies it in the ticket channel.
//
// The link and the chart never enter publicUpdates (the public receipt
// timeline renders those). The private receipt is ticket.evidenceDeliveries.

const fs = require("node:fs");
const path = require("node:path");

const ID = /^[a-f0-9]{32}$/;
const SNOWFLAKE = /^\d{16,20}$/;
const MAX_PNG = 8 * 1024 * 1024;
const GRACE_MS = 45 * 60000; // delivery retries run 10 minutes apart; a staged chart stays valid this long past its window
const FILE_NAME = "ahd-evidence-chart.png";
const DISCORD_API = "https://discord.com/api/v10";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readJson(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

// Links go out only once the page route is explicitly configured for this service.
function linkBase() {
  const base = String(process.env.EVIDENCE_PUBLIC_BASE || "").replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+$/i.test(base) ? base : null;
}

/**
 * Check a staged presentation against the ticket. Returns
 * { ok: true, png, filename, link, line } or { ok: false, reason }.
 */
function prepareEvidence({ ticket, presentation, dir = process.env.EVIDENCE_PAGES_DIR || "/var/lib/lakeside-evidence", now = Date.now() } = {}) {
  if (!ID.test(String(presentation || ""))) return { ok: false, reason: "invalid_id" };
  if (!ticket || !Number.isInteger(Number(ticket.ticketNumber))) return { ok: false, reason: "no_ticket" };
  if (ticket.category === "investigation") return { ok: false, reason: "private_investigation" };
  const root = path.resolve(dir);
  const base = path.join(root, presentation);
  try {
    const st = fs.lstatSync(base);
    if (!st.isDirectory() || path.dirname(base) !== root) return { ok: false, reason: "not_in_store" };
  } catch { return { ok: false, reason: "not_in_store" }; }
  const manifest = readJson(path.join(base, "delivery.json"));
  if (!manifest || manifest.id !== presentation) return { ok: false, reason: "not_staged" };
  if (Number(manifest.ticket) !== Number(ticket.ticketNumber)) return { ok: false, reason: "other_ticket" };
  if (!ticket.discordChannelId || String(manifest.channel) !== String(ticket.discordChannelId)) return { ok: false, reason: "other_channel" };
  const attachBy = Date.parse(manifest.attachBy || "");
  if (!Number.isFinite(attachBy) || now > attachBy + GRACE_MS) return { ok: false, reason: "expired" };
  // Version 1 manifests predate link-only presentations and always had a chart.
  const wantsChart = manifest.chart !== false;
  let png = null;
  if (wantsChart) {
    const chart = path.join(base, "chart.png");
    try {
      const st = fs.lstatSync(chart);
      if (!st.isFile() || st.size < 8 || st.size > MAX_PNG) return { ok: false, reason: "chart_invalid" };
      png = fs.readFileSync(chart);
    } catch { return { ok: false, reason: "chart_missing" }; }
    if (!png.subarray(0, 8).equals(PNG_MAGIC)) return { ok: false, reason: "chart_invalid" };
  }
  let link = null;
  if (manifest.link === true) {
    const meta = readJson(path.join(base, "meta.json"));
    const first = fs.existsSync(path.join(base, "snap-0001.json"));
    const owned = meta && meta.id === presentation && first && meta.visibility === manifest.visibility &&
      (meta.visibility === "public_aggregate" || (meta.visibility === "ticket" && Number(meta.ticket) === Number(ticket.ticketNumber)));
    const origin = linkBase();
    if (owned && origin) link = { url: `${origin}/support/evidence/${presentation}`, visibility: meta.visibility, tracker: meta.kind === "tracker" };
  }
  const line = link
    ? `Full table${link.tracker ? ", updated for 24 hours" : ""}: ${link.url}${link.visibility === "ticket" ? ` (sign in at ${new URL(link.url).host} with the account linked to your Discord)` : ""}`
    : null;
  if (!png && !line) return { ok: false, reason: manifest.link === true && !linkBase() ? "links_disabled" : "no_link" };
  const answerTo = SNOWFLAKE.test(String(manifest.answerTo || "")) ? String(manifest.answerTo) : null;
  return { ok: true, png, filename: png ? FILE_NAME : null, link: link ? link.url : null, line, answerTo };
}

/** Post one message with a PNG attached. Same result shape as postDiscordBot, plus attachments. */
async function postDiscordWithFile(channelId, content, { nonce, components, reference, file, filename = FILE_NAME, fetchImpl = fetch } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token) return { skipped: "no bot token" };
  if (!/^\d{5,}$/.test(String(channelId || ""))) return { error: "invalid channel" };
  try {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({
      content, allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename }],
      ...(components ? { components } : {}),
      ...(reference ? { message_reference: reference } : {}),
      ...(nonce ? { nonce, enforce_nonce: true } : {}),
    }));
    form.append("files[0]", new Blob([file], { type: "image/png" }), filename);
    const r = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST", headers: { Authorization: `Bot ${token}` }, body: form, signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { error: `discord ${r.status}: ${body.slice(0, 160)}`, status: r.status };
    }
    const msg = await r.json();
    return { posted: true, via: "bot", id: msg.id, channel: channelId, content: typeof msg.content === "string" ? msg.content : null, attachments: (msg.attachments || []).map((a) => ({ id: a.id, filename: a.filename, size: a.size })) };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Claim the presentation for this update key on the ticket. One presentation
 * goes on one reply: a retry of the same update reuses its claim, any other
 * update is refused. Returns { claimed: true } or { claimed: false, reason }.
 */
/**
 * Verify that `messageId` is a human request in the ticket's own channel
 * before a reply is threaded under it. Returns a message_reference or null.
 * Never a reference to a message elsewhere, a bot message or an unreadable one.
 */
async function verifyReplyTarget(channelId, messageId, { fetchImpl = fetch } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN || "";
  if (!token || !SNOWFLAKE.test(String(channelId || "")) || !SNOWFLAKE.test(String(messageId || ""))) return null;
  // A message id is always newer than its channel's id.
  if (BigInt(messageId) <= BigInt(channelId)) return null;
  try {
    const r = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const msg = await r.json();
    if (!msg || String(msg.id) !== String(messageId) || String(msg.channel_id) !== String(channelId) || !msg.author || msg.author.bot || msg.webhook_id) return null;
    return { message_id: String(messageId), channel_id: String(channelId), fail_if_not_exists: false };
  } catch { return null; }
}

/**
 * The support update key. A broker-staged evidence answer (update_key set by
 * Keir's broker) keeps one key across retries, so a replay finds its own
 * update and never posts twice. Every other update gets a fresh key: unrelated
 * answers are never deduplicated.
 */
function supportUpdateKey(updateKind, updateKey, now = Date.now()) {
  return /^keir-[a-f0-9]{24}$/.test(String(updateKey || "")) ? `${updateKind}:${updateKey}` : `${updateKind}:${now}`;
}

async function claimEvidence(tickets, ticket, { presentation, updateKey, now = new Date() }) {
  const prior = (Array.isArray(ticket.evidenceDeliveries) ? ticket.evidenceDeliveries : []).find((e) => e && e.presentation === presentation);
  if (prior) return prior.updateKey === updateKey ? { claimed: true, retry: true, prior } : { claimed: false, reason: "already_shown" };
  const r = await tickets.updateOne(
    { _id: ticket._id, $or: [{ evidenceDeliveries: { $exists: false } }, { evidenceDeliveries: { $not: { $elemMatch: { presentation } } } }] },
    { $push: { evidenceDeliveries: { presentation, updateKey, status: "pending", at: now } } },
  );
  return r && (r.modifiedCount > 0 || r.matchedCount > 0) ? { claimed: true } : { claimed: false, reason: "already_shown" };
}

async function recordEvidence(tickets, ticket, { presentation, updateKey, receipt }) {
  await tickets.updateOne(
    { _id: ticket._id, evidenceDeliveries: { $elemMatch: { presentation, updateKey } } },
    { $set: { "evidenceDeliveries.$.status": receipt.status, "evidenceDeliveries.$.receipt": receipt } },
  );
}

module.exports = { FILE_NAME, prepareEvidence, postDiscordWithFile, verifyReplyTarget, supportUpdateKey, claimEvidence, recordEvidence };
