"use strict";
// Public mentions: Keir notices when someone names it ("Keir", "Keith"),
// @-mentions it or replies to it in a public channel, and makes a
// conservative call. It answers only a clear game question with a factual
// answer from live data, once, in a short reply. It stays silent on banter,
// opinions, balance debates, moderation and anyone's ticket; account or
// money matters get one pointer to open a ticket. Every decision is logged
// with its reason.

const fs = require("node:fs");
const path = require("node:path");

const VIEW = 1n << 10n;

/** Text channels members can see, outside excluded categories and names. */
function publicChannels(channels, roles, { guildId, memberRole = "Member", excludeCategories = /dev|archiv|ticket|staff|mod|admin|corporate warfare|grand century|margin of victory/i, excludeNames = /^(?:ticket-|mod-|staff|admin|log|rules$|announcements$|welcome$|starboard$|applications$)/i } = {}) {
  const member = roles.find((r) => r.name === memberRole);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const view = (c, roleId) => {
    const o = (c?.permission_overwrites || []).find((x) => x.id === roleId);
    if (!o) return null;
    if (BigInt(o.deny) & VIEW) return false;
    if (BigInt(o.allow) & VIEW) return true;
    return null;
  };
  return channels.filter((c) => [0, 5].includes(c.type)).filter((c) => {
    const cat = byId.get(c.parent_id);
    if (cat && excludeCategories.test(cat.name || "")) return false;
    if (excludeNames.test(c.name || "")) return false;
    const everyone = view(c, guildId) ?? view(cat, guildId);
    const members = member ? view(c, member.id) ?? view(cat, member.id) : null;
    return members === true || (everyone !== false && members !== false);
  }).map((c) => ({ id: c.id, name: c.name, last: c.last_message_id || null }));
}

/** Whether a message is addressed to Keir: by name, by @-mention, or as a reply to Keir. */
function mentionsKeir(msg, { botId, names = ["keir", "keith"] }) {
  const text = String(msg.content || "");
  if (botId && (msg.mentions || []).some((u) => u.id === botId)) return true;
  if (botId && new RegExp(`<@!?${botId}>`).test(text)) return true;
  if (botId && msg.referenced_message?.author?.id === botId) return true;
  return new RegExp(`\\b(?:${names.map((n) => n.replace(/[^a-z]/gi, "")).join("|")})\\b`, "i").test(text);
}

const SILENT = [
  [/\b(?:report(?:ed|ing)?|harass\w*|abus\w*|scam\w*|alts?|alt accounts?|multi-?account\w*|cheat\w*|exploit\w*|bann?(?:ed|ing|s)?|mute[ds]?|kick(?:ed)?|toxic|slurs?)\b/i, "moderation"],
  [/\btickets?\b|#\d{3,5}\b/i, "about a ticket"],
  [/\b(?:egg|egg3901|owner|dev(?:s|eloper)?s?)\b.{0,40}\b(?:think|said|want|decid|plan|should|will)\b/i, "speaking for the team"],
  [/\b(?:what do you think|your (?:opinion|take|thoughts)|do you (?:like|agree)|(?:is|are) (?:it|this|that|the \w+) (?:broken|op|overpowered|unfair|balanced|good|bad|dumb|stupid)|nerf|buff)\b/i, "opinion or balance debate"],
];
const TICKET = /\b(?:refunds?|compensat\w*|reimburs\w*|my (?:money|cash|funds|balance|account|savings|bank account)|lost (?:my|all|the) (?:money|cash|funds)|log ?in|login|password|e-?mail|hack(?:ed)?|recover\w*|locked out|delete[ds]? my|reset my|charged|payments?|patreon|subscription)\b/i;

/** The cheap, code-only first call. action: silent | ticket | judge. */
function prefilter(text, { names = ["keir", "keith"] } = {}) {
  const bare = String(text || "").replace(/<@!?\d+>/g, " ").replace(new RegExp(`\\b(?:${names.join("|")})\\b`, "gi"), " ").replace(/\s+/g, " ").trim();
  if (bare.replace(/[^a-z0-9]/gi, "").length < 8) return { action: "silent", reason: "too short to be a question" };
  for (const [rx, reason] of SILENT) if (rx.test(text)) return { action: "silent", reason };
  if (TICKET.test(text)) return { action: "ticket", reason: "account or money matter" };
  if (!/\?|\b(?:why|how|what|when|where|which|who|can(?:'t|not)?|does|do|is|are|should)\b/i.test(bare)) return { action: "silent", reason: "not a question" };
  return { action: "judge", reason: "possible game question" };
}

function createPublicLog(file) {
  return (entry) => { try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 }); } catch { /* audit log is best effort */ } };
}

/**
 * Decides each mention once. limits: { channelMinutes, perHour }.
 * judge(m) -> { posted: bool, reason } runs the model wake; post(m, text) replies.
 */
function createPublicResponder({ stateFile, log, judge, post, mayAct, now = () => Date.now(), limits = { channelMinutes: 10, perHour: 6 }, pointer = "This sounds like something for a support ticket. Please open one with /ticket and the team will look at your account there." }) {
  let data = { handled: [], replies: [] };
  try { data = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* fresh */ }
  const save = () => { fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 }); fs.writeFileSync(stateFile, JSON.stringify(data), { mode: 0o600 }); };
  const limited = (channelId) => {
    const t = now();
    data.replies = data.replies.filter((r) => t - r.at < 3600000);
    if (data.replies.some((r) => r.channelId === channelId && t - r.at < limits.channelMinutes * 60000)) return `channel rate limit (one reply per ${limits.channelMinutes} minutes)`;
    if (data.replies.length >= limits.perHour) return `hourly rate limit (${limits.perHour} replies)`;
    return null;
  };
  async function handle(m) {
    const base = { channel: m.channelName, channelId: m.channelId, messageId: m.messageId, author: m.authorName, text: String(m.content || "").slice(0, 300) };
    if (data.handled.includes(m.messageId)) return { decision: "skipped", reason: "already handled" };
    data.handled = [...data.handled, m.messageId].slice(-2000); save();
    if (!mayAct()) { log({ ...base, decision: "skipped", reason: "not live or kill switch on" }); return { decision: "skipped" }; }
    const pre = prefilter(m.content);
    if (pre.action === "silent") { log({ ...base, decision: "skipped", reason: pre.reason }); return { decision: "skipped", reason: pre.reason }; }
    const busy = limited(m.channelId);
    if (busy) { log({ ...base, decision: "skipped", reason: busy }); return { decision: "skipped", reason: busy }; }
    if (pre.action === "ticket") {
      await post(m, pointer);
      data.replies.push({ channelId: m.channelId, at: now() }); save();
      log({ ...base, decision: "pointed to a ticket", reason: pre.reason });
      return { decision: "pointed" };
    }
    let r;
    try { r = await judge(m); } catch (e) { r = { posted: false, reason: `judge failed: ${e.message}` }; }
    if (r.posted) { data.replies.push({ channelId: m.channelId, at: now() }); save(); }
    log({ ...base, decision: r.posted ? "answered" : "skipped", reason: r.reason || (r.posted ? "clear game question" : "judged not to answer"), ...(r.text ? { reply: r.text.slice(0, 500) } : {}) });
    return { decision: r.posted ? "answered" : "skipped", reason: r.reason };
  }
  return { handle };
}

/**
 * Watches public channels with one guild channel listing per tick: only a channel whose newest message changed is
 * read. A channel seen for the first time starts from its newest message (no backlog).
 */
function createPublicWatcher({ discord, guildId, botId, names, onMention, log = () => {}, refreshRolesMs = 600000 }) {
  const last = new Map();
  let roles = null, rolesAt = 0, busy = false;
  async function tick() {
    if (busy) return 0;
    busy = true;
    let found = 0;
    try {
      if (!roles || Date.now() - rolesAt > refreshRolesMs) { roles = await discord("GET", `/guilds/${guildId}/roles`); rolesAt = Date.now(); }
      const channels = await discord("GET", `/guilds/${guildId}/channels`);
      for (const c of publicChannels(channels, roles, { guildId })) {
        if (!last.has(c.id)) { last.set(c.id, c.last); continue; }
        if (!c.last || c.last === last.get(c.id)) continue;
        const after = last.get(c.id) || c.last;
        const msgs = await discord("GET", `/channels/${c.id}/messages?after=${after}&limit=50`);
        last.set(c.id, c.last);
        for (const m of [...(msgs || [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))) {
          if (m.author?.bot || m.webhook_id || m.author?.id === botId) continue;
          if (!mentionsKeir(m, { botId, names })) continue;
          found++;
          await onMention({ channelId: c.id, channelName: c.name, messageId: m.id, authorId: m.author?.id, authorName: m.author?.global_name || m.author?.username, content: m.content || "", at: m.timestamp });
        }
      }
    } catch (e) { log(`[keir-slim] public watch: ${e.message}`); }
    finally { busy = false; }
    return found;
  }
  return { tick };
}

module.exports = { publicChannels, mentionsKeir, prefilter, createPublicResponder, createPublicWatcher, createPublicLog };
