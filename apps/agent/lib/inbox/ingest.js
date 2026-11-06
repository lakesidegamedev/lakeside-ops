"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Reads conversations from Discord itself. A poke says "look at this message";
// the content, author and attachments always come from Discord's API.

const MAX_IMAGE_BYTES = 25 << 20;
// iPhones send HEIC; the screenshot check converts everything it can read.
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif", "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff" };
const EXT_TYPES = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp", gif: "gif", heic: "heic", heif: "heif", avif: "avif", bmp: "bmp", tif: "tiff", tiff: "tiff" };
const imageExt = (a) => IMAGE_TYPES[String(a.content_type || "").split(";")[0].toLowerCase()] || EXT_TYPES[String(a.filename || "").split(".").pop().toLowerCase()];
const snowflake = (v) => typeof v === "string" && /^\d{15,22}$/.test(v);

function createIngest({ discord, store, botId, guildId, attachmentsDir, fetchImpl = fetch, now = () => Date.now() }) {
  fs.mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });

  const channelCache = new Map();
  async function observe(channelId, messages) {
    if (!snowflake(channelId) || !Array.isArray(messages) || messages.length > 100 || messages.some((m) => !snowflake(m?.id) || !m.author || !snowflake(m.author.id) || (m.channel_id && m.channel_id !== channelId))) {
      const e = new Error("invalid observation"); e.status = 400; throw e;
    }
    let cached = channelCache.get(channelId);
    if (!cached || now() - cached.at > 300000) {
      cached = { ch: await discord("GET", `/channels/${channelId}`), at: now() };
      if (channelCache.size > 1000) channelCache.clear();
      channelCache.set(channelId, cached);
    }
    if (!store.thread(channelId) && cached.ch.guild_id === guildId && messages.some((m) => m.author.id === botId || m.mentions?.some((u) => u.id === botId) || m.referenced_message?.author?.id === botId)) {
      const context = await discord("GET", `/channels/${channelId}/messages?around=${messages[0].id}&limit=100`);
      await recordChannel(cached.ch, context);
    }
    return recordChannel(cached.ch, messages);
  }

  async function saveImage(messageId, a) {
    const ext = imageExt(a);
    if (!ext || !(a.size <= MAX_IMAGE_BYTES)) return null;
    const file = `${messageId}-${a.id}.${ext}`;
    const full = path.join(attachmentsDir, file);
    if (fs.existsSync(full)) return { file, sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") };
    const r = await fetchImpl(a.url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`attachment download ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
    fs.writeFileSync(full, buf, { mode: 0o600 });
    return { file, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
  }

  async function normalize(msg, channelId) {
    const attachments = [];
    for (const a of msg.attachments || []) {
      const entry = { id: a.id, filename: a.filename, contentType: a.content_type || null, size: a.size };
      try { Object.assign(entry, (await saveImage(msg.id, a)) || {}); } catch (e) { entry.error = e.message; }
      attachments.push(entry);
    }
    return {
      id: msg.id, channelId, authorId: msg.author.id, authorName: msg.author.global_name || msg.author.username,
      direction: msg.author.id === botId ? "out" : "in", content: [msg.content || "", ...(msg.embeds || []).map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join("\n"))].filter(Boolean).join("\n\n"), attachments, at: Date.parse(msg.timestamp) || now(),
    };
  }

  /** Validates that a channel is a DM between the bot and one human. */
  async function dmChannel(channelId) {
    const ch = await discord("GET", `/channels/${channelId}`);
    const user = ch.recipients?.[0];
    if (ch.type !== 1 || !user || user.bot) { const e = new Error("not a direct message channel"); e.status = 403; throw e; }
    return { ch, user };
  }

  async function record(channelId, user, msg) {
    store.upsertThread({ channelId, userId: user.id, username: user.username, displayName: user.global_name, at: now() });
    const normalized = await normalize(msg, channelId);
    const isNew = store.addMessage(normalized);
    return { isNew, message: normalized };
  }

  async function recordChannel(ch, rows) {
    if (ch.type === 1) {
      const user = ch.recipients?.find((u) => u.id !== botId && !u.bot);
      if (!user) return [];
      return Promise.all(rows.filter((m) => m.author).map((m) => record(ch.id, user, m)));
    }
    if (!guildId || ch.guild_id !== guildId || ![0, 5, 10, 11, 12].includes(ch.type)) return [];
    if (!store.thread(ch.id) && !rows.some((m) => m.author?.id === botId || m.mentions?.some((u) => u.id === botId) || m.referenced_message?.author?.id === botId)) return [];
    const kind = /^ticket-/.test(ch.name || "") ? "ticket" : [10, 11, 12].includes(ch.type) ? "thread" : "channel";
    store.upsertThread({ channelId: ch.id, kind, channelName: ch.name, displayName: ch.name, guildId, at: now() });
    const out = [];
    for (const msg of rows.filter((m) => m.author)) {
      const message = await normalize(msg, ch.id);
      out.push({ isNew: store.addMessage(message), message });
    }
    return out;
  }

  /** Handle a poke from the bot. Returns the normalized message when it is new. */
  async function ingestPoke(channelId, messageId) {
    if (!snowflake(channelId) || !snowflake(messageId)) { const e = new Error("invalid ids"); e.status = 400; throw e; }
    const { user } = await dmChannel(channelId);
    const msg = await discord("GET", `/channels/${channelId}/messages/${messageId}`);
    const out = await record(channelId, user, msg);
    return { ...out, user, channelId };
  }

  /** Catch up on a known thread: missed pokes and replies sent by other Keir processes. */
  async function backfill(channelId) {
    const t = store.thread(channelId);
    if (!t) return [];
    const user = { id: t.user_id, username: t.username, global_name: t.display_name };
    const ch = t.kind === "dm" ? null : await discord("GET", `/channels/${channelId}`);
    const fresh = [];
    let after = t.last_message_id;
    for (let page = 0; page < 10; page++) {
      const rows = await discord("GET", `/channels/${channelId}/messages?limit=100${after ? `&after=${after}` : ""}`);
      if (!rows?.length) break;
      rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      for (const msg of rows) {
        const out = ch ? (await recordChannel(ch, [msg]))[0] : await record(channelId, user, msg);
        if (out?.isNew) fresh.push(out.message);
      }
      after = rows.at(-1).id;
      if (rows.length < 100) break;
    }
    return fresh;
  }

  /** Send as Keir and record it. Mentions are never pinged. */
  async function send(channelId, content, sentBy = "keir") {
    const leak = require("../operator/toolmarkup").outboundLeak(content);
    if (leak) throw new Error(`Not sent: the message contains ${leak.kind === "broker_echo" ? "Keir's own tool or refusal text" : "tool-call text"} ("${leak.match}").`);
    const msg = await discord("POST", `/channels/${channelId}/messages`, { content: String(content).slice(0, 2000), allowed_mentions: { parse: [] } });
    store.addMessage({ id: msg.id, channelId, authorId: botId, authorName: "Keir", direction: "out", content: msg.content, attachments: [], sentBy, at: Date.parse(msg.timestamp) || now() });
    return msg;
  }

  return { ingestPoke, backfill, send, dmChannel, recordChannel, observe };
}

module.exports = { createIngest, snowflake };
