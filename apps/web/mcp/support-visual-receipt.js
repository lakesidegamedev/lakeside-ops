"use strict";

const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{15,22}$/;
const FILE_NAME = /^ui-(?:desktop|iphone|android)-[a-f0-9]{20}\.png$/;

async function recordVisualReply(tickets, { number, channelId, messageId, replyTo, stage }, {
  token = process.env.DISCORD_BOT_TOKEN, fetchImpl = fetch, now = () => new Date(),
} = {}) {
  if (![channelId, messageId, replyTo].every(id => SNOWFLAKE.test(id || "")) || !["live", "testing"].includes(stage)) throw new Error("invalid visual delivery receipt");
  const ticket = await tickets.findOne({ ticketNumber: number });
  if (!ticket || ticket.category === "investigation" || ticket.discordChannelId !== channelId) throw new Error("visual reply is outside the assigned ticket channel");
  const key = `visual:${messageId}`;
  const old = (ticket.publicUpdates || []).find(row => row.key === key);
  if (old?.delivery?.status === "posted") return { posted: true, messageId };
  if (!token) throw new Error("Discord verification unavailable");
  const read = async (path) => {
    const result = await fetchImpl(DISCORD_API + path, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!result.ok) throw new Error("Discord visual delivery could not be verified");
    return result.json();
  };
  const [bot, sent] = await Promise.all([read("/users/@me"), read(`/channels/${channelId}/messages/${messageId}`)]);
  const label = stage === "live" ? "Live." : "In testing.";
  if (!bot?.id || sent?.author?.id !== bot.id || sent.webhook_id || sent.id !== messageId || sent.channel_id !== channelId ||
      sent.message_reference?.message_id !== replyTo || !sent.content?.startsWith(label) || sent.content.length > 1400) {
    throw new Error("Discord reply does not match the visual delivery receipt");
  }
  const attachments = sent.attachments || [];
  if (attachments.length < 1 || attachments.length > 3 || attachments.some(item =>
    !SNOWFLAKE.test(item.id || "") || !FILE_NAME.test(item.filename || "") || item.content_type !== "image/png")) {
    throw new Error("Discord reply does not carry verified visual attachments");
  }
  const at = now();
  await tickets.updateOne({
    _id: ticket._id, discordChannelId: channelId, "publicUpdates.key": { $ne: key },
  }, {
    $push: { publicUpdates: { key, kind: stage === "live" ? "production" : "development", deliveryMode: "reply",
      message: sent.content, at, delivery: { status: "posted", via: "visual-reply", channelId, messageId, replyTo, postedAt: at,
        attachments: attachments.map(({ id, filename }) => ({ id, filename })) } } },
    $set: { updatedAt: at },
  });
  const confirmed = await tickets.findOne({ _id: ticket._id, discordChannelId: channelId, "publicUpdates.key": key });
  if (!confirmed) throw new Error("visual ticket delivery was verified but its receipt could not be recorded");
  return { posted: true, messageId };
}

module.exports = { recordVisualReply };
