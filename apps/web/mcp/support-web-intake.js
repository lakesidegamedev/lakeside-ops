"use strict";
/**
 * Public support intake for the lakesidegames.net services page form.
 *
 *   POST /api/support/ticket  (proxied by Caddy from lakesidegames.net)
 *
 * Only signed-in Lakeside accounts can send a ticket. Every submission is
 * checked server-side by forwarding the visitor's session cookie to the
 * accounts service (GET /account/api/session); the account id, username and
 * email from that answer are attached to the ticket.
 *
 * Order of checks: sign-in, form validation, A House Divided ban (account and
 * IP), rate limits per IP and per account, duplicate within 24 hours, then
 * automatic moderation (support-web-moderation.js). Borderline content goes
 * through with a "Flagged by auto moderation" field for staff. Nothing here
 * acts on the player beyond refusing the submission.
 *
 * Opens a normal Discord ticket through createSupportTicket, the same path as
 * support_create_ticket. The bot is the reporter unless the given Discord
 * username matches a guild member, who then gets channel access.
 *
 * Responses: 200 {ok:true,ticketNumber}, 400 validation or moderation,
 * 401 not signed in, 403 blocked account or cross-site request, 409 duplicate,
 * 413 body too large, 429 rate limited, 502 when Discord or the game API
 * fails, 503 when the sign-in check is unavailable.
 */

const { createHash } = require("node:crypto");
const { ObjectId } = require("mongodb");
const { moderateSubmission } = require("./support-web-moderation");

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
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIMITS = { short: { windowMs: 10 * 60 * 1000, max: 3 }, day: { windowMs: DAY, max: 10 } };
const ACCOUNT_LIMITS = { hour: { windowMs: HOUR, max: 3 }, day: { windowMs: DAY, max: 6 } };
const SESSION_COOKIE = "__Host-lakeside_session";
const SESSION_URL = process.env.SUPPORT_SESSION_URL || "https://lakesidegames.net/account/api/session";
const ALLOWED_ORIGINS = new Set(["https://lakesidegames.net", "https://www.lakesidegames.net"]);
// Ceiling across all IPs so a spread-out flood cannot bury the ticket category.
const GLOBAL_LIMIT = { windowMs: 60 * 60 * 1000, max: 30 };
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
  const discord = field(body, "discord", { max: 64, label: "Discord username" });
  if (discord && !DISCORD_RE.test(discord)) throw new HttpError(400, "Enter your Discord username as it appears in Discord, for example lakeside_player.");
  const subject = field(body, "subject", { required: true, max: 120, label: "Subject" });
  const description = field(body, "description", { required: true, max: 4000, multiline: true, label: "Description" });
  return { product, category, discord, subject, description };
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

// Per account: the hourly and daily caps, plus the same subject and
// description from one account within 24 hours. In memory, like the IP limit.
function createAccountGuard({ limits = ACCOUNT_LIMITS, now = () => Date.now() } = {}) {
  const limiter = createRateLimiter({ limits, global: { windowMs: HOUR, max: Infinity }, now });
  const recent = new Map(); // accountId -> [{ fingerprint, at }]
  const fingerprint = (s) => createHash("sha256")
    .update(`${s.subject}\n${s.description}`.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
  const live = (accountId) => (recent.get(accountId) || []).filter((r) => now() - r.at < DAY);
  return {
    isDuplicate(accountId, submission) {
      const fp = fingerprint(submission);
      return live(accountId).some((r) => r.fingerprint === fp);
    },
    take: (accountId) => limiter.take(accountId),
    // Returns an undo function for when the ticket could not be opened.
    record(accountId, submission) {
      const entry = { fingerprint: fingerprint(submission), at: now() };
      recent.set(accountId, [...live(accountId), entry]);
      return () => recent.set(accountId, (recent.get(accountId) || []).filter((r) => r !== entry));
    },
  };
}

function sessionToken(req) {
  const values = String(req.headers.cookie || "").split(";").map((c) => c.trim())
    .filter((c) => c.startsWith(SESSION_COOKIE + "=")).map((c) => c.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{20,200}$/.test(values[0]) ? values[0] : null;
}

// Ask the accounts service who owns this session. Returns the account, null
// when signed out, and throws when the check itself fails.
function createSessionVerifier({ url = SESSION_URL, fetchImpl = fetch } = {}) {
  return async function verifySession(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const res = await fetchImpl(url, {
      headers: { Cookie: `${SESSION_COOKIE}=${token}`, Accept: "application/json", "User-Agent": "lakeside-support-intake/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) throw new Error(`session check returned ${res.status}`);
    const data = await res.json();
    if (!data || data.signedIn !== true) return null;
    if (typeof data.accountId !== "string" || !data.accountId || typeof data.username !== "string" || !data.username) {
      throw new Error("session check returned no account id");
    }
    return { accountId: data.accountId, username: data.username, email: typeof data.email === "string" ? data.email : "" };
  };
}

// A House Divided bans: the account itself (AHD id, or the AHD user linked to
// the Discord id) and banned IPs. AHD has no separate mute for users, so a ban
// is the only standing that blocks. Returns a reason string or null.
function createStandingCheck(db) {
  const Users = db.collection("users");
  const BannedIps = db.collection("bannedIps");
  return async function checkStanding({ accountId, ip }) {
    let query = null;
    if (/^[a-f0-9]{24}$/i.test(accountId)) {
      query = { _id: new ObjectId(accountId) };
    } else if (/^discord:\d{1,30}$/.test(accountId)) {
      query = { discordId: accountId.slice("discord:".length) };
    }
    if (query) {
      const user = await Users.findOne(query, { projection: { isBanned: 1, isMuted: 1, mutedUntil: 1 } });
      if (user?.isBanned) return "banned in A House Divided";
      if (user?.isMuted || (user?.mutedUntil && new Date(user.mutedUntil) > new Date())) return "muted in A House Divided";
    }
    if (ip && ip !== "unknown") {
      const banned = await BannedIps.findOne({ ip, allowRegistration: { $ne: true } }, { projection: { _id: 1 } });
      if (banned) return "IP banned in A House Divided";
    }
    return null;
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

function ticketDescription(s, account, discordStatus, flags) {
  return [
    s.description,
    "",
    "---",
    "Opened from lakesidegames.net",
    `Product: ${PRODUCTS[s.product]}`,
    `Web category: ${CATEGORIES[s.category].label}`,
    `Lakeside account: ${account.username} (id ${account.accountId})`,
    `Account email: ${account.email || "none on the account"}`,
    `Discord username: ${s.discord ? `${s.discord} (${discordStatus})` : "not given"}`,
    ...(flags.length ? [`Flagged by auto moderation: ${flags.join(", ")}`] : []),
  ].join("\n");
}

function sameSite(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return false;
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function registerWebIntake(app, {
  createTicket, findMember, verifySession, checkStanding = async () => null,
  limiter = createRateLimiter(), accountGuard = createAccountGuard(),
  logger = console, path = "/api/support/ticket",
}) {
  if (typeof verifySession !== "function") throw new Error("registerWebIntake needs verifySession");
  app.post(path, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const send = (status, payload) => res.status(status).json(payload);
    try {
      if (Number(req.headers["content-length"] || 0) > MAX_BODY_BYTES) throw new HttpError(413, "That message is too long.");
      if (!req.is("application/json")) throw new HttpError(400, "Send the form as JSON.");
      if (!sameSite(req)) throw new HttpError(403, "Send tickets from the form on lakesidegames.net.");
      let account;
      try {
        account = await verifySession(req);
      } catch (error) {
        logger.warn("[web-intake] session check failed:", error.message);
        throw new HttpError(503, "We could not check your sign-in right now. Please try again shortly, or email contact@lakesidegames.net.");
      }
      if (!account) throw new HttpError(401, "Sign in to your Lakeside account to send a ticket.");
      const body = req.body;
      if (body && typeof body === "object" && typeof body.website === "string" && body.website.trim()) {
        return send(200, { ok: true, ticketNumber: 0 });
      }

      const submission = validateSubmission(body);
      const ip = clientIp(req);
      const standing = await checkStanding({ accountId: account.accountId, ip });
      if (standing) {
        logger.log(`[web-intake] refused account=${account.accountId}: ${standing}`);
        throw new HttpError(403, "This account cannot send support tickets. If you think this is a mistake, email contact@lakesidegames.net.");
      }
      const tooMany = (wait, error) => { res.set("Retry-After", String(wait)); return send(429, { ok: false, error }); };
      const ipWait = limiter.take(ip);
      if (ipWait) return tooMany(ipWait, "Too many tickets from this connection. Please wait a while, or ask in our Discord.");
      if (accountGuard.isDuplicate(account.accountId, submission)) {
        throw new HttpError(409, "You already sent this ticket in the last 24 hours. We have it, so there is no need to send it again.");
      }
      // Refused submissions count against the IP limit above but not against
      // the account's ticket allowance.
      const verdict = moderateSubmission(submission);
      if (!verdict.ok) {
        logger.log(`[web-intake] moderation refused account=${account.accountId}`);
        throw new HttpError(400, verdict.error);
      }
      const accountWait = accountGuard.take(account.accountId);
      if (accountWait) return tooMany(accountWait, "You have sent the most tickets allowed for now (3 an hour, 6 a day). Please wait, or add details to your open ticket in Discord.");
      const flags = verdict.flags;
      // Claim the fingerprint now so two identical submissions in flight cannot both pass.
      const unrecord = accountGuard.record(account.accountId, submission);

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
        { name: "Lakeside account", value: `${account.username} (id ${account.accountId})`, inline: false },
        { name: "Account email", value: account.email || "None on the account", inline: false },
        { name: "Discord username", value: submission.discord ? `${submission.discord} (${discordStatus})` : "Not given", inline: true },
      ];
      if (flags.length) extraFields.push({ name: "Auto moderation", value: `Flagged by auto moderation: ${flags.join(", ")}`, inline: false });
      const result = await createTicket({
        discordUserId: member?.user?.id,
        category: map.ticket,
        title: submission.subject,
        description: ticketDescription(submission, account, discordStatus, flags),
        openedVia: "Opened from lakesidegames.net",
        channelLabel: member ? undefined : "web",
        extraFields,
      }).catch((error) => { unrecord(); throw error; });
      logger.log(`[web-intake] opened ticket #${result.ticketNumber} product=${submission.product} category=${submission.category} member=${Boolean(member)} flagged=${flags.length > 0}`);
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

module.exports = {
  registerWebIntake, validateSubmission, createRateLimiter, createAccountGuard, createSessionVerifier, createStandingCheck,
  sessionToken, clientIp, PRODUCTS, CATEGORIES, MAX_BODY_BYTES,
};
