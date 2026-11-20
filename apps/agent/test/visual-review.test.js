"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const { createBroker } = require("../lib/operator/broker");
const { createLedger } = require("../lib/operator/store");
const visual = require("../lib/operator/visual-review");

const OWNER = "111111111111111111";
const PLAYER = "222222222222222222";
const CHANNEL = "333333333333333333";
const REQUEST = "444444444444444444";
const BOT = "555555555555555555";
const GUILD = "666666666666666666";
const REPLY = "777777777777777777";
const ATTACHMENT = "888888888888888888";

function fixture(t, { ticket = null, adopted = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-visual-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const ledgerPath = path.join(stateDir, "ledger.json");
  const ledger = createLedger(ledgerPath);
  const config = { stateDir, guildId: GUILD, ownerId: OWNER, staffIds: [], botId: BOT, supportDeferred: () => false };
  const job = ledger.createJob("ui", { state: "running", kind: ticket ? "ticket" : "command", role: ticket ? "support" : "owner",
    actorId: ticket ? null : OWNER, channelId: CHANNEL, replyChannel: CHANNEL, ticket,
    source: { channelId: CHANNEL, channelName: ticket ? `ticket-bug-construction-${ticket}` : "gameplay-advisors",
      ...(adopted ? {} : { messageId: REQUEST, authorId: ticket ? PLAYER : OWNER }) },
  });
  const rows = [];
  let posts = 0;
  const calls = [];
  const discord = async (method, route, body, files) => {
    calls.push({ method, route, body, files });
    if (route.startsWith("/guilds/")) return [{ id: CHANNEL, name: job.source.channelName }];
    if (route === `/channels/${CHANNEL}`) return { id: CHANNEL, guild_id: GUILD };
    if (route === `/channels/${CHANNEL}/messages/${REQUEST}`) return { id: REQUEST, channel_id: CHANNEL, author: { id: ticket ? PLAYER : OWNER } };
    if (method === "GET") return rows;
    posts++;
    const sent = { id: REPLY, channel_id: CHANNEL, author: { id: BOT, bot: true },
      content: body.content, message_reference: body.message_reference,
      attachments: files.map(file => ({ id: ATTACHMENT, filename: file.name, content_type: "image/png" })) };
    rows.push(sent);
    return sent;
  };
  return { ledgerPath, ledger, config, job, discord, rows, calls, posts: () => posts };
}

async function preview(text) {
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#216177" } }).png().toBuffer();
  return { url: "https://www.ahousedividedgame.com/party", text, image: { data: png.toString("base64") } };
}

async function supportBroker(f) {
  return createBroker({ ledger: f.ledger, config: f.config, discord: f.discord,
    mcp: { servers: () => [], call: async () => ({}) },
    sandbox: { run: async () => ({ code: 0, output: "" }) },
    renderFixture: async () => preview("Compare strategies"),
    renderVisual: async () => preview("Chair Office"),
  });
}

test("an adopted support ticket posts its first review to the original player with the fixture stage and exact navigation", async (t) => {
  const f = fixture(t, { ticket: 123, adopted: true });
  const broker = await supportBroker(f);
  const capture = await broker.tool(f.job, "visual_review", { action: "capture", replyTo: REQUEST,
    fixture: "build.html", expect: "Compare strategies" });
  assert.equal(capture.stage, "testing");
  assert.ok(capture.image.data);
  await assert.rejects(broker.tool(f.job, "channel_reply", { message: "The build screen is in testing." }), /attach the reviewed renders/);
  await assert.rejects(broker.tool(f.job, "channel_reply", { message: "The comparison now shows which products limit sales.", visualIds: [capture.id] }), /click path/);
  const reply = { message: "The comparison shows which products limit sales.", visualIds: [capture.id],
    navigation: "Open Sector Overview and select Build, then Compare strategies." };
  await broker.tool(f.job, "channel_reply", reply);
  const [entry] = Object.values(f.ledger.data.outbox);
  assert.match(entry.content, /^In testing\. Shown with sample data\./);
  assert.match(entry.content, /Sector Overview and select Build, then Compare strategies/);
  assert.deepEqual(entry.visualReview.origin, { messageId: REQUEST, channelId: CHANNEL });
  assert.equal(entry.visualReview.ticket, 123);
  assert.equal(f.job.visualReview.pending, false);
  f.job.visualReviewStage = "live";
  f.job.visualReview.pending = true;
  await assert.rejects(broker.tool(f.job, "channel_reply", reply), /new capture of the live screen/);
  delete f.job.visualReviewStage;
  await broker.tool(f.job, "channel_reply", reply);
  assert.equal(Object.keys(f.ledger.data.outbox).length, 1);
});

test("staff review binds real desktop and mobile captures to the staff request", async (t) => {
  const f = fixture(t);
  const raw = await preview("Chair Office");
  const options = { ...f, assertActive: () => {}, renderPage: async () => raw };
  const [desktop, mobile] = await Promise.all([
    visual.capture(f.job, { path: "/party", expect: "Chair Office" }, options),
    visual.capture(f.job, { path: "/party", expect: "Chair Office", device: "iphone" }, options),
  ]);
  const { key, message, ...review } = visual.prepare(f.job, [desktop.id, mobile.id], "Open the party menu and select Chair Office.", "The chair sits between the deputies.");
  const entry = { id: "123", content: message, visualReview: review };
  assert.match(key, /visual/);
  assert.notEqual(desktop.id, mobile.id);
  const result = await visual.send(f.job, entry, { ...f, assertCanSend: () => {} });
  assert.equal(result.messageId, REPLY);
  assert.match(entry.content, /^Live\./);
  assert.equal(result.attachments.length, 2);
  assert.deepEqual(f.calls.at(-1).body.message_reference, { message_id: REQUEST, fail_if_not_exists: true });
  assert.equal(f.calls.at(-1).body.allowed_mentions.parse.length, 0);
});

test("wrong screen, changed target, and stale or unverified fixtures stay pending", async (t) => {
  const f = fixture(t);
  const raw = await preview("Sign in");
  const options = { ...f, assertActive: () => {}, renderPage: async () => raw, liveFixture: async () => false };
  await assert.rejects(visual.capture(f.job, { path: "/party", expect: "Chair Office" }, options), /expected change/);
  await assert.rejects(visual.capture(f.job, { path: "/corporation", expect: "Sign in" }, options), /did not reach/);
  await assert.rejects(visual.capture(f.job, { fixture: "build.html", expect: "Compare strategies", live: true }, options), /exact deployed/);
  assert.equal(f.job.visualReview.pending, true);
  assert.equal(Object.keys(f.job.visualReview.images).length, 0);
});

test("restart reconciles the same Discord attachment and a staff takeover blocks new delivery", async (t) => {
  const f = fixture(t, { ticket: 123, adopted: true });
  const broker = await supportBroker(f);
  const capture = await broker.tool(f.job, "visual_review", { action: "capture", replyTo: REQUEST,
    fixture: "build.html", expect: "Compare strategies" });
  const payload = { message: "The comparison shows where there is room.", visualIds: [capture.id],
    navigation: "Open Sector Overview, select Build, then Compare strategies." };
  await broker.tool(f.job, "channel_reply", payload);
  const [entry] = Object.values(f.ledger.data.outbox);
  await assert.rejects(visual.send(f.job, entry, { ...f, assertCanSend: () => { throw new Error("staff takeover"); } }), /staff takeover/);
  assert.equal(f.posts(), 0);
  await assert.rejects(visual.send(f.job, entry, { ...f, assertCanSend: () => {}, discord: async (...args) => {
    await f.discord(...args);
    throw new Error("connection closed after sending");
  } }), /connection closed/);
  const restarted = createLedger(f.ledgerPath);
  const result = await visual.send(restarted.data.jobs[f.job.id], Object.values(restarted.data.outbox)[0],
    { ...f, ledger: restarted, assertCanSend: () => { throw new Error("should not resend"); } });
  assert.equal(result.messageId, REPLY);
  assert.equal(f.posts(), 1);
});
