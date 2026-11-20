"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const pageview = require("./pageview");
const { redactSecrets } = require("../text");

const LIMIT = 2 * 1024 * 1024;
const SNOWFLAKE = /^\d{15,22}$/;
const TOKEN = /^[a-f0-9]{20}$/;
const JOB_ID = /^[a-f0-9]{12}$/;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const words = (text) => String(text || "").replace(/\s+/g, " ").trim();

function fileFor(stateDir, jobId, id) {
  if (!JOB_ID.test(jobId) || !TOKEN.test(id)) throw new Error("invalid visual review artifact");
  return path.join(stateDir, "artifacts", `visual-${jobId}-${id}.png`);
}

function originFor(job) {
  const source = job.source || {};
  const channelId = job.replyChannel || job.channelId;
  if (!SNOWFLAKE.test(channelId || "") || source.channelId !== channelId) throw new Error("UI review requires an authenticated Discord request");
  if (job.visualReview?.origin?.channelId !== channelId) throw new Error("UI review needs its original request message");
  return job.visualReview.origin;
}

async function begin(job, { replyTo }, { discord, config }) {
  if (job.visualReview) {
    const origin = originFor(job);
    if (replyTo && replyTo !== origin.messageId) throw new Error("the original UI request is already bound");
    return job.visualReview;
  }
  const source = job.source || {};
  const channelId = job.replyChannel || job.channelId;
  const messageId = source.messageId || replyTo;
  if (!SNOWFLAKE.test(channelId || "") || channelId !== source.channelId || !SNOWFLAKE.test(messageId || "")) {
    throw new Error("Provide the original player message ID from ticket_history for a ticket adopted without a message ID.");
  }
  if (replyTo && source.messageId && replyTo !== source.messageId) throw new Error("reply to the original request for this task");
  const channel = await discord("GET", `/channels/${channelId}`);
  if (channel?.id !== channelId || channel.guild_id !== config.guildId) throw new Error("UI review channel is outside the configured guild");
  const original = await discord("GET", `/channels/${channelId}/messages/${messageId}`);
  if (original?.id !== messageId || original.channel_id !== channelId || !original.author?.id || original.author.bot || original.webhook_id ||
      (!source.messageId && [config.ownerId, ...(config.staffIds || [])].includes(original.author.id)) ||
      (source.authorId && source.authorId !== original.author.id)) {
    throw new Error("Could not verify the original human request in this channel.");
  }
  if (job.visualReview && job.visualReview.origin.messageId !== messageId) throw new Error("the original UI request is already bound");
  return (job.visualReview ||= { origin: { channelId, messageId }, images: {}, pending: true });
}

async function fixtureRender(job, input, { sandbox, signal }) {
  if (!/^(?:\.?[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.html$/.test(input.fixture) || input.fixture.length > 180) {
    throw new Error("Use a task-relative HTML fixture path, such as .ui-review/sector.html or sector.html.");
  }
  const preset = pageview.DEVICES[input.device || "desktop"];
  if (preset === undefined) throw new Error("unknown viewport");
  const request = Buffer.from(JSON.stringify({ file: input.fixture, preset, expect: words(input.expect) })).toString("base64");
  const worker = fs.readFileSync(path.join(__dirname, "visual-review-worker.js")).toString("base64");
  const command = `node -e 'eval(Buffer.from("${worker}","base64").toString())' ${request}`;
  const result = await sandbox.capture(job.id, command, signal, { computer: true, maxBytes: Math.ceil(LIMIT * 4 / 3) + 10000 });
  if (result.code !== 0 || result.truncated) throw new Error("The isolated browser could not capture the expected fixture screen.");
  return JSON.parse(result.output);
}

async function capture(job, input, options) {
  const state = await begin(job, input, options);
  options.ledger.save();
  const expect = words(input.expect);
  if (expect.length < 3 || expect.length > 100 || Boolean(input.path) === Boolean(input.fixture)) {
    throw new Error("Use exactly one public game path or fixture and provide the visible text that identifies the changed screen.");
  }
  let result, stage;
  if (input.fixture) {
    if (input.live && !await options.liveFixture(job)) throw new Error("The workspace must match the exact deployed web commit with clean tracked files before a fixture can be called live.");
    result = await options.renderFixture(job, input, options);
    if (input.live && !await options.liveFixture(job)) throw new Error("The deployed web commit changed while capturing the fixture. Recheck before calling it live.");
    stage = input.live ? "live" : "testing";
  } else {
    const target = pageview.options(input).url;
    result = await options.renderPage(input);
    if (new URL(result.url).pathname !== new URL(target).pathname || !pageview.publicPage(result.url)) {
      throw new Error("The browser did not reach the intended public game screen.");
    }
    stage = "live";
  }
  if (!words(result.text).toLowerCase().includes(expect.toLowerCase())) throw new Error("The rendered screen did not show the expected change.");
  if (redactSecrets(result.text) !== result.text) throw new Error("The rendered screen contains private or credential-like text.");
  if (options.signal?.aborted) throw new Error("UI review was interrupted");
  options.assertActive(job);
  const pngData = result.image?.data;
  if (typeof pngData !== "string" || pngData.length > Math.ceil(LIMIT * 4 / 3) + 4) throw new Error("Browser screenshot is missing or too large");
  const sharp = require("sharp");
  const image = sharp(Buffer.from(pngData, "base64"), { limitInputPixels: 4000000 });
  if ((await image.metadata()).format !== "png") throw new Error("Browser capture did not return a PNG");
  const png = await image.png().toBuffer();
  if (png.length > LIMIT) throw new Error("Browser screenshot is too large");
  const sha256 = digest(png);
  const id = digest(JSON.stringify([stage, Boolean(input.fixture), input.device || "desktop", sha256])).slice(0, 20);
  if (Object.keys(state.images).length >= 8 && !state.images[id]) throw new Error("This request has reached its eight-render review limit");
  const file = fileFor(options.config.stateDir, job.id, id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, png, { mode: 0o600 });
  const record = { id, sha256, stage, sample: Boolean(input.fixture), device: input.device || "desktop", text: words(result.text).slice(0, 4000), ...(input.live && input.fixture ? { commit: job.repositoryRef.commit } : {}) };
  state.images[id] = record;
  state.pending = true;
  options.ledger.save();
  return { id, stage, sample: record.sample, device: record.device, text: record.text, image: { data: png.toString("base64"), media_type: "image/png" }, instruction: "Inspect the image, then attach it with channel_reply using visualIds and the exact navigation path." };
}

function prepare(job, ids, navigation, message) {
  const origin = originFor(job);
  const state = job.visualReview;
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > 3 || unique.some(id => !TOKEN.test(id) || !state.images[id])) {
    throw new Error("Attach one to three browser renders captured for this request.");
  }
  const images = unique.map(id => state.images[id]);
  if (images.some(r => r.stage !== images[0].stage)) throw new Error("Send live and in-testing screens in separate updates.");
  const route = words(navigation);
  if (route.length < 10 || route.length > 280) throw new Error("Include the exact in-game click path, using the menu and button labels.");
  const stage = images[0].stage;
  if (job.visualReviewStage && stage !== job.visualReviewStage) throw new Error("The release update needs a new capture of the live screen.");
  const label = stage === "live" ? "Live." : "In testing.";
  const sample = images.some(r => r.sample) ? " Shown with sample data." : "";
  const previews = unique.sort();
  const key = `channel-reply:${job.id}:visual:${digest([origin.channelId, origin.messageId, stage, ...previews].join(":")).slice(0, 20)}`;
  return { key, origin, previews, stage, message: `${label}${sample} ${message.trim()}\n\n${route}` };
}

function reviewedFile(stateDir, job, id) {
  const image = job.visualReview?.images[id];
  const filename = fileFor(stateDir, job.id, id);
  if (!image || digest(fs.readFileSync(filename)) !== image.sha256) throw new Error("UI screenshot no longer matches the reviewed capture");
  return { filename, image };
}

function look(stateDir, job, id) {
  originFor(job);
  const { filename, image } = reviewedFile(stateDir, job, id);
  return { id, stage: image.stage, sample: image.sample, device: image.device, text: image.text,
    image: { data: fs.readFileSync(filename).toString("base64"), media_type: "image/png" } };
}

function uploadFiles(stateDir, job, entry) {
  const origin = originFor(job);
  const review = entry.visualReview;
  if (review.origin.channelId !== origin.channelId || review.origin.messageId !== origin.messageId) throw new Error("UI review no longer matches the original request");
  return review.previews.map((id) => {
    const { filename, image } = reviewedFile(stateDir, job, id);
    if (image.stage !== review.stage) throw new Error("UI screenshot belongs to a different environment");
    return { path: filename, name: `ui-${image.device}-${id}.png` };
  });
}

function matchesReceipt(sent, botId, origin, files) {
  return sent?.author?.id === botId && sent.channel_id === origin.channelId &&
    sent.message_reference?.message_id === origin.messageId && SNOWFLAKE.test(sent.id || "") &&
    sent.attachments?.length === files.length && files.every(file =>
      sent.attachments.some(item => item.filename === file.name && item.content_type === "image/png" && SNOWFLAKE.test(item.id || "")));
}

async function send(job, entry, { discord, config, ledger, components, assertCanSend, now = () => Date.now() }) {
  if (entry.visualReceipt) return entry.visualReceipt;
  const files = uploadFiles(config.stateDir, job, entry);
  const origin = entry.visualReview.origin;
  const route = `/channels/${origin.channelId}/messages`;
  let sent;
  if (entry.visualSendStartedAt) {
    const recent = await discord("GET", route + "?limit=100");
    sent = recent.find(item => matchesReceipt(item, config.botId, origin, files) && item.content === entry.content);
    // Discord only checks nonces over a short window. After that window never
    // guess that a lost HTTP response meant the message was never posted.
    if (!sent && now() - entry.visualSendStartedAt > 2 * 60000) {
      throw Object.assign(new Error("The browser preview delivery is uncertain; inspect the original channel before retrying."), { code: "VISUAL_DELIVERY_UNCERTAIN" });
    }
  }
  if (!sent) {
    assertCanSend();
    entry.visualSendStartedAt ||= now();
    ledger.save();
    sent = await discord("POST", route, {
      content: entry.content, allowed_mentions: { parse: [] },
      nonce: `${entry.id}-ui`, enforce_nonce: true,
      message_reference: { message_id: origin.messageId, fail_if_not_exists: true },
      attachments: files.map((file, id) => ({ id, filename: file.name })),
      ...(components ? { components } : {}),
    }, files);
  }
  if (!matchesReceipt(sent, config.botId, origin, files)) throw new Error("Discord did not confirm the exact threaded screenshot reply");
  entry.visualReceipt = { messageId: sent.id, attachments: sent.attachments.map(({ id, filename, content_type }) => ({ id, filename, content_type })), timestamp: sent.timestamp };
  entry.messageIds = [sent.id];
  entry.deliveredChunks = 1;
  ledger.save();
  return entry.visualReceipt;
}

function shouldAttach(job, message) {
  return Boolean(job.visualReview ? job.visualReview.pending : job.visualReviewExpected) &&
    /\b(?:live|in testing|ready for review|ready to review|visual check passed)\b/i.test(message) &&
    !/\b(?:not (?:yet )?live|isn.t live|still needs|visual check (?:is )?pending|before it goes live)\b/i.test(message);
}

module.exports = { begin, capture, fixtureRender, look, prepare, send, shouldAttach, uploadFiles };
