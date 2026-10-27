"use strict";
/**
 * Public support intake for the lakesidegames.net services page form.
 *
 *   POST /api/support/ticket  (proxied by Caddy from lakesidegames.net)
 *
 * Validates the form, rate limits per client IP, and opens a normal Discord
 * ticket through createSupportTicket, the same path as support_create_ticket.
 * The bot is the reporter unless the given Discord username matches a guild
 * member, who then gets channel access like any reporter.
 *
 * Responses: 200 {ok:true,ticketNumber}, 400 validation, 413 body too large,
 * 429 rate limited, 502 when Discord or the game API fails.
 */

const PRODUCTS = {
  ahd: "A House Divided",
  ahdclient: "AHD Client app",
  "corporate-warfare": "Corporate Warfare",
  "grand-century": "Grand Century",
  "margin-of-victory": "Margin of Victory",
  account: "Lakeside account",
  ask: "Ask",
  docs: "Docs",
  website: "lakesidegames.net website",
};

// Web form category -> ticket category and the label staff see.
const CATEGORIES = {
  bug: { ticket: "bug", label: "Bug" },
  account: { ticket: "account", label: "Account" },
  billing: { ticket: "account", label: "Billing" },
  data: { ticket: "account", label: "Data or privacy request" },
  "player-report": { ticket: "moderation", label: "Player report" },
  question: { ticket: "gameplay", label: "Question" },
  other: { ticket: "other", label: "Other" },
};

const MAX_BODY_BYTES = 16 * 1024;
const LIMITS = { short: { windowMs: 10 * 60 * 1000, max: 3 }, day: { windowMs: 24 * 60 * 60 * 1000, max: 10 } };
// Ceiling across all IPs so a spread-out flood cannot bury the ticket category.
const GLOBAL_LIMIT = { windowMs: 60 * 60 * 1000, max: 30 };
const EMAIL_RE = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[A-Za-z]{2,}$/;
const DISCORD_RE = /^@?[A-Za-z0-9_.]{2,32}(?:#\d{1,4})?$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Strip control characters (keeping newlines and tabs in the description)
// and break Discord mentions so form text can never ping anyone.
function clean(value, { multiline = false } = {}) {
  let text = String(value).replace(/\r\n?/g, "\n");
  text = multiline ? text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "") : text.replace(/[\u0000-\u001F\u007F]/g, " ");
  return text.replace(/@(everyone|here)/gi, "@​$1").replace(/<@/g, "<@​").trim();
}

function field(body, key, { required = false, max, multiline = false, label }) {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new HttpError(400, `${label} is required.`);
    return "";
  }
  if (typeof raw !== "string") throw new HttpError(400, `${label} must be text.`);
  const value = clean(raw, { multiline });
  if (required && !value) throw new HttpError(400, `${label} is required.`);
  if (value.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer.`);
  return value;
}

function validateSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send the form as JSON.");
  const product = typeof body.product === "string" ? body.product.trim() : "";
  if (!PRODUCTS[product]) throw new HttpError(400, "Choose the game or service this is about.");
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!CATEGORIES[category]) throw new HttpError(400, "Choose what this is about.");
  const email = field(body, "email", { required: true, max: 254, label: "Email" });
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid email address.");
  const discord = field(body, "discord", { max: 64, label: "Discord username" });
  if (discord && !DISCORD_RE.test(discord)) throw new HttpError(400, "Enter your Discord username as it appears in Discord, for example lakeside_player.");
  const username = field(body, "username", { max: 64, label: "Username" });
  const subject = field(body, "subject", { required: true, max: 120, label: "Subject" });
  const description = field(body, "description", { required: true, max: 4000, multiline: true, label: "Description" });
  return { product, category, email, discord, username, subject, description };
}

function createRateLimiter({ limits = LIMITS, global = GLOBAL_LIMIT, now = () => Date.now() } = {}) {
  const hits = new Map();
  let globalHits = [];
  const longest = Math.max(...Object.values(limits).map((l) => l.windowMs));
  return {
    // Returns seconds to wait when over a limit, otherwise records the hit and returns 0.
    take(ip) {
      const t = now();
      const list = (hits.get(ip) || []).filter((at) => t - at < longest);
      globalHits = globalHits.filter((at) => t - at < global.windowMs);
      let wait = 0;
      for (const { windowMs, max } of Object.values(limits)) {
        const inWindow = list.filter((at) => t - at < windowMs);
        if (inWindow.length >= max) wait = Math.max(wait, Math.ceil((inWindow[0] + windowMs - t) / 1000));
      }
      if (globalHits.length >= global.max) wait = Math.max(wait, Math.ceil((globalHits[0] + global.windowMs - t) / 1000));
      if (wait) { hits.set(ip, list); return wait; }
      list.push(t);
      hits.set(ip, list);
      globalHits.push(t);
      if (hits.size > 5000) for (const [key, value] of hits) if (!value.some((at) => t - at < longest)) hits.delete(key);
      return 0;
    },
  };
}

// Caddy sets X-Forwarded-For to the real visitor. Trust it only when the
// request reached us over loopback, which is the only way Caddy connects.
function clientIp(req) {
  const peer = req.socket?.remoteAddress || "";
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return local && forwarded ? forwarded : peer || "unknown";
}

function ticketDescription(s, discordStatus) {
  return [
    s.description,
    "",
    "---",
    "Opened from lakesidegames.net",
    `Product: ${PRODUCTS[s.product]}`,
    `Web category: ${CATEGORIES[s.category].label}`,
    `Contact email: ${s.email}`,
    `Discord username: ${s.discord ? `${s.discord} (${discordStatus})` : "not given"}`,
    `Lakeside or in-game username: ${s.username || "not given"}`,
  ].join("\n");
}

function registerWebIntake(app, {
  createTicket, findMember, limiter = createRateLimiter(), logger = console, path = "/api/support/ticket",
}) {
  app.post(path, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const send = (status, payload) => res.status(status).json(payload);
    try {
      if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) throw new HttpError(413, "That message is too long.");
      if (!req.is("application/json")) throw new HttpError(400, "Send the form as JSON.");
      const body = req.body;
      if (body && typeof body === "object" && typeof body.website === "string" && body.website.trim()) {
        return send(200, { ok: true, ticketNumber: 0 });
      }
      const submission = validateSubmission(body);
      const ip = clientIp(req);
      const wait = limiter.take(ip);
      if (wait) {
        res.set("Retry-After", String(wait));
        return send(429, { ok: false, error: "Too many tickets from this connection. Please wait a while, or ask in our Discord." });
      }

      let member = null;
      let discordStatus = "not found in the Discord server";
      if (submission.discord) {
        try {
          member = await findMember(submission.discord);
          if (member) discordStatus = "matched server member, given channel access";
        } catch (error) {
          discordStatus = "member lookup failed";
          logger.warn("[web-intake] member lookup failed:", error.message);
        }
      }
      const map = CATEGORIES[submission.category];
      const extraFields = [
        { name: "Product", value: PRODUCTS[submission.product], inline: true },
        { name: "Web category", value: map.label, inline: true },
        { name: "Contact email", value: submission.email, inline: false },
        { name: "Discord username", value: submission.discord ? `${submission.discord} (${discordStatus})` : "Not given", inline: true },
        { name: "Lakeside username", value: submission.username || "Not given", inline: true },
      ];
      const result = await createTicket({
        discordUserId: member?.user?.id,
        category: map.ticket,
        title: submission.subject,
        description: ticketDescription(submission, discordStatus),
        openedVia: "Opened from lakesidegames.net",
        channelLabel: member ? undefined : "web",
        extraFields,
      });
      logger.log(`[web-intake] opened ticket #${result.ticketNumber} product=${submission.product} category=${submission.category} member=${Boolean(member)}`);
      return send(200, { ok: true, ticketNumber: result.ticketNumber });
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { ok: false, error: error.message });
      logger.error("[web-intake] ticket creation failed:", error.stage || "upstream", error.message);
      return send(502, { ok: false, error: "We could not open your ticket right now. Please try again shortly, or ask in our Discord." });
    }
  });
  // Body parser failures (bad JSON, oversized body) for this route only.
  app.use(path, (error, _req, res, next) => {
    if (!error) return next();
    res.set("Cache-Control", "no-store");
    if (error.type === "entity.too.large") return res.status(413).json({ ok: false, error: "That message is too long." });
    return res.status(400).json({ ok: false, error: "Send the form as JSON." });
  });
}

module.exports = { registerWebIntake, validateSubmission, createRateLimiter, clientIp, PRODUCTS, CATEGORIES, MAX_BODY_BYTES };
