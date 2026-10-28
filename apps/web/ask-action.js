"use strict";
/**
 * POST /internal/ask-action: file a suggestion or open a ticket that a player
 * confirmed in Ask Keir (web, game drawer or Discord). Ask authenticates the
 * player and holds the pending draft; this side resolves who they are in the
 * game and runs the same cores as support_create_suggestion and
 * support_create_ticket.
 *
 * Body: {kind, actionId, identity: {userId?, discordId?}, title, description,
 * category, gameSystem?, sourceText, surface, pageUrl?}
 *
 * Responses: 200 {ok:true, receipt:{kind, number, url}} (duplicate:true when
 * the action was already filed), 400 invalid input or moderation, 403 banned,
 * 404 unknown user, 409 an earlier attempt needs inspection, 422 no Discord
 * link for a ticket, 502/503 upstream or configuration failure.
 */

const crypto = require("node:crypto");
const { CATEGORIES: SUGGESTION_CATEGORIES, SYSTEMS } = require("./mcp/support-create-suggestion");
const { moderateSubmission } = require("./mcp/support-web-moderation");

const TICKET_CATEGORIES = ["bug", "gameplay", "account", "other"];
const SURFACES = { web: "Ask website", drawer: "in-game Ask drawer", discord: "Discord" };
const snowflake = /^\d{15,22}$/, objectIdHex = /^[a-f0-9]{24}$/i, actionIdRe = /^[A-Za-z0-9_-]{16,128}$/;
// Stages where createSupportTicket has created nothing, so a retry is safe.
const TICKET_RETRYABLE = new Set(["config", "invalid", "reserve"]);

class AskActionError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const text = (value, max) => (typeof value === "string" ? value.trim() : "").slice(0, max);

function parseAction(p) {
  if (!p || typeof p !== "object") throw new AskActionError(400, "Invalid body");
  const kind = p.kind;
  if (kind !== "suggestion" && kind !== "ticket") throw new AskActionError(400, "kind must be suggestion or ticket");
  if (!actionIdRe.test(String(p.actionId || ""))) throw new AskActionError(400, "Invalid actionId");
  const userId = text(p.identity?.userId, 64), discordId = text(p.identity?.discordId, 32);
  if (userId && !objectIdHex.test(userId)) throw new AskActionError(400, "Invalid userId");
  if (discordId && !snowflake.test(discordId)) throw new AskActionError(400, "Invalid discordId");
  if (!userId && !discordId) throw new AskActionError(400, "identity.userId or identity.discordId required");
  const title = text(p.title, 200), description = text(p.description, kind === "ticket" ? 5000 : 4000);
  if (!title || !description) throw new AskActionError(400, "title and description are required");
  const categories = kind === "ticket" ? TICKET_CATEGORIES : SUGGESTION_CATEGORIES;
  const category = p.category || (kind === "ticket" ? "bug" : "other");
  if (!categories.includes(category)) throw new AskActionError(400, `category must be one of ${categories.join(", ")}`);
  const gameSystem = p.gameSystem || "meta_other";
  if (kind === "suggestion" && !SYSTEMS.includes(gameSystem)) throw new AskActionError(400, "Invalid gameSystem");
  const surface = Object.hasOwn(SURFACES, p.surface) ? p.surface : "web";
  let pageUrl = null;
  try { const u = new URL(text(p.pageUrl, 300)); if (u.protocol === "https:" && !u.username && !u.password) pageUrl = u.href; } catch { /* optional */ }
  return { kind, actionId: p.actionId, userId, discordId, title, description, category, gameSystem, surface, pageUrl, sourceText: text(p.sourceText, 5000) };
}

// discordId wins when given; otherwise the AHD account's linked Discord id.
async function resolveIdentity({ userId, discordId }, Users) {
  const projection = { discordId: 1, isBanned: 1 };
  let user = null;
  if (discordId) user = await Users.findOne({ discordId }, { projection });
  else {
    const { ObjectId } = require("mongodb");
    user = await Users.findOne({ _id: new ObjectId(userId) }, { projection });
    if (!user) throw new AskActionError(404, "Unknown user");
  }
  if (user?.isBanned === true) throw new AskActionError(403, "This account cannot file suggestions or tickets.");
  const linked = discordId || (snowflake.test(String(user?.discordId || "")) ? String(user.discordId) : null);
  return { discordId: linked, userId: linked ? null : userId };
}

function suggestionFailure(error) {
  const message = String(error?.message || error);
  if (/not configured/.test(message)) return new AskActionError(503, message);
  if (/different submission|needs inspection|inspect/.test(message)) return new AskActionError(409, message);
  return new AskActionError(502, message);
}

async function fileSuggestion(action, who, { Intake, Tickets, Suggestions, createSuggestion, env }) {
  try {
    const receipt = await createSuggestion({
      ask_action_id: action.actionId, ...(who.discordId ? { discord_user_id: who.discordId } : { ahd_user_id: who.userId }),
      source_text: action.sourceText || undefined, title: action.title, description: action.description,
      category: action.category, gameSystem: action.gameSystem,
    }, { Intake, Tickets, Suggestions, env });
    return { receipt: { kind: "suggestion", number: receipt.number, url: receipt.url }, duplicate: receipt.duplicate === true };
  } catch (error) { throw error instanceof AskActionError ? error : suggestionFailure(error); }
}

// The ticket core has no idempotency of its own, so the Ask action claims its
// source in the same intake collection the suggestion core uses. A claim is
// released only when nothing was created; otherwise it stays held for staff.
async function openTicket(action, who, { Intake, createTicket, findMember, flags }) {
  if (!who.discordId) throw new AskActionError(422, "Link your Discord account to open a ticket.", { needsDiscordLink: true });
  const member = await findMember(who.discordId);
  if (!member) throw new AskActionError(422, "Join the A House Divided Discord server to open a ticket, so you can talk with staff there.", { needsDiscordServer: true });
  const source = `ask-ticket:${action.actionId}`;
  const id = crypto.createHash("sha256").update(source).digest("hex");
  const digest = crypto.createHash("sha256").update(JSON.stringify([action.category, action.title, action.description])).digest("hex");
  try { await Intake.insertOne({ _id: id, source, reporterId: who.discordId, ...(action.sourceText ? { sourceText: action.sourceText } : {}), digest, state: "started", at: new Date() }); }
  catch (e) {
    if (e.code !== 11000) throw e;
    const old = await Intake.findOne({ _id: id });
    if (old?.reporterId !== who.discordId || old?.digest !== digest) throw new AskActionError(409, "This action already belongs to a different submission; inspect its receipt");
    if (old.state === "done") return { receipt: old.receipt, duplicate: true };
    throw new AskActionError(409, "Previous ticket attempt needs inspection; no second ticket was opened");
  }
  const extraFields = [
    { name: "Via", value: SURFACES[action.surface], inline: true },
    ...(action.pageUrl ? [{ name: "Page", value: action.pageUrl, inline: false }] : []),
    ...(action.sourceText ? [{ name: "Player request", value: action.sourceText, inline: false }] : []),
    ...(flags.length ? [{ name: "Flagged by auto moderation", value: flags.join(", "), inline: false }] : []),
  ];
  let ticket;
  try {
    ticket = await createTicket({
      discordUserId: who.discordId, category: action.category, title: action.title, description: action.description,
      openedVia: `Keir through Ask (${SURFACES[action.surface]}) on behalf of <@${who.discordId}>`, extraFields,
    });
  } catch (error) {
    const retryable = TICKET_RETRYABLE.has(error?.stage);
    if (retryable) await Intake.deleteOne({ _id: id, state: "started" });
    else await Intake.updateOne({ _id: id }, { $set: { state: "failed", error: String(error?.message || error).slice(0, 500), failedAt: new Date() } });
    throw new AskActionError(error?.stage === "config" ? 503 : 502, retryable ? "The ticket could not be opened. Please try again shortly." : "The ticket may be partly open; staff will check it before anything is retried.");
  }
  const receipt = { kind: "ticket", number: ticket.ticketNumber, url: ticket.channelUrl };
  await Intake.updateOne({ _id: id }, { $set: { state: "done", receipt, completedAt: new Date() } });
  return { receipt, duplicate: false };
}

async function handleAskAction(payload, deps) {
  try {
    const action = parseAction(payload);
    const verdict = moderateSubmission({ subject: action.title, description: action.description });
    if (!verdict.ok) throw new AskActionError(400, verdict.error);
    const who = await resolveIdentity(action, deps.Users);
    const { receipt, duplicate } = action.kind === "ticket"
      ? await openTicket(action, who, { ...deps, flags: verdict.flags })
      : await fileSuggestion(action, who, deps);
    return { status: 200, body: { ok: true, receipt, ...(duplicate ? { duplicate: true } : {}) } };
  } catch (error) {
    if (error instanceof AskActionError) return { status: error.status, body: { error: error.message, ...error.extra } };
    deps.logger?.error?.("[ask-action]", error?.message || error);
    return { status: 500, body: { error: "Action failed" } };
  }
}

module.exports = { handleAskAction, parseAction, resolveIdentity, AskActionError };
