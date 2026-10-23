"use strict";
const crypto = require("node:crypto");
const policy = require("./ownermuse-policy");
const { isAppJob } = require("./appchannel");
const { ownerText } = require("./privacy");
const snowflake = value => /^\d{15,22}$/.test(String(value || ""));
const requested = text => /\b(?:file|submit|create|open|log|record|raise)\b[\s\S]{0,100}\b(?:suggestion|feature request)\b/i.test(text) && !/\b(?:do not|don't|never)\b[\s\S]{0,30}\b(?:file|submit|create|open|log|record|raise)\b/i.test(text);

async function openSuggestion({ ledger, config, mcp, discord, effect, supportAuthority, job, input, signal }) {
  if (config.supportDeferred(job)) throw new Error("Suggestion intake is held for the existing support owner");
  if (job.codingParent || job.kind === "finding") throw new Error("Suggestion intake belongs to the original conversation");
  const args = { title: ownerText(String(input.title || "")).trim(), description: ownerText(String(input.description || "")).trim(), category: input.category, gameSystem: input.gameSystem };
  if (!args.title || args.title.length > 200 || !args.description || args.description.length > 4000) throw new Error("Give the suggestion a bounded title and description");
  if (input.impact !== undefined) args.impact = ownerText(input.impact);
  if (input.priority !== undefined) args.priority = input.priority;
  let key;
  if (isAppJob(job)) {
    const origin = policy.origin(ledger.data, job), receipt = ledger.data.ownerMuseOrigins?.[origin.root];
    const message = ledger.data.appThread?.messages?.find(m => m.id === receipt?.messageId);
    const original = message && { ...message }; if (original) delete original.jobId;
    if (!origin.valid || origin.actorId !== config.ownerId || !message || message.role !== "owner" || message.jobId !== origin.root || policy.digest(original) !== receipt.messageDigest) throw new Error("Suggestion needs an unchanged authenticated owner request");
    if (!requested(message.text)) throw new Error("Ask explicitly to file a suggestion before creating one");
    if (input.channelId || input.reportMessageId || input.discord_user_id) throw new Error("App suggestions retain the authenticated owner as submitter");
    args.discord_user_id = config.ownerId; args.app_request_id = `${message.id}:${origin.digest}`;
    key = `suggestion:app:${message.id}`;
  } else if (job.kind === "ticket" && input.archivedMessage) {
    await supportAuthority(job);
    if (input.channelId || input.reportMessageId) throw new Error("Archived ticket filing uses its persisted origin only");
    const ticket = await mcp.call("support", "support_get", { kind: "ticket", number: job.ticket }, false, signal);
    const previous = ticket.conversation?.previousChannelId;
    if (ticket.number !== job.ticket || ticket.conversation?.channelId !== job.channelId || !previous) throw new Error("Archived filing needs this ticket's verified reopen lineage");
    const original = Object.values(ledger.data.jobs).find(j => j.kind === "ticket" && j.ticket === job.ticket && j.source?.channelId === previous && (input.archivedMessage === ticket.description || j.source?.content === input.archivedMessage) && snowflake(j.source?.authorId));
    if (!original) throw new Error("Archived source has no preserved authenticated author");
    args.discord_user_id = original.source.authorId;
    args.source_ticket_number = job.ticket; args.source_ticket_message = input.archivedMessage;
    key = `suggestion:ticket:${job.ticket}:${crypto.createHash("sha256").update(input.archivedMessage).digest("hex")}`;
  } else {
    let channelId = job.source?.channelId || job.channelId, reportId = input.reportMessageId || job.source?.replyTo || job.source?.messageId;
    const developer = job.kind === "command" && [config.ownerId, ...(config.staffIds || [])].includes(job.actorId) && ["owner", "support"].includes(job.role);
    if (developer) {
      const actual = await discord("GET", `/channels/${job.source.channelId}/messages/${job.source.messageId}`);
      if (actual.webhook_id || actual.author?.bot || actual.author?.id !== job.actorId || !requested(actual.content)) throw new Error("Suggestion requester provenance changed or filing was not requested");
      channelId = input.channelId || channelId;
    } else if (job.kind === "ticket") {
      const rows = await supportAuthority(job, ["running"]);
      if (input.channelId && input.channelId !== job.channelId || !rows.some(m => m.id === reportId)) throw new Error("Select a source message from this ticket's verified history");
      channelId = job.channelId;
    } else throw new Error("Suggestion filing needs an authenticated developer request or an assigned ticket");
    if (!snowflake(channelId) || !snowflake(reportId)) throw new Error("Select an actual suggestion source message");
    const channel = await discord("GET", `/channels/${channelId}`);
    if (channel.guild_id !== config.guildId) throw new Error("Suggestion source is outside the game guild");
    const source = await discord("GET", `/channels/${channelId}/messages/${reportId}`);
    if (source.id !== reportId || source.webhook_id || source.author?.bot || !snowflake(source.author?.id)) throw new Error("Suggestion needs a verified human source author");
    args.discord_user_id = source.author.id; args.source_channel_id = channelId; args.source_message_id = reportId;
    key = `suggestion:discord:${channelId}:${reportId}`;
  }
  const result = await effect(job, key, () => mcp.call("support", "support_create_suggestion", args, true, signal));
  if (result.filed !== true || !Number.isSafeInteger(result.number) || result.number <= 0 || result.reporterId !== args.discord_user_id || !result.url) throw new Error("Suggestion filing needs a verified native receipt; inspect before retrying");
  (job.filedSuggestions ||= {})[key] = result; ledger.save();
  if (job.ticket) require("./supportblockers").clear(ledger, job.ticket);
  return { ...result, instruction: "Native suggestion filed for the source author. Share its feedback link. This is a proposal, not an accepted design or a shipped fix. Do not create another GitHub enhancement for the same suggestion; its native intake owns optional GitHub mirroring." };
}
module.exports = { openSuggestion };
