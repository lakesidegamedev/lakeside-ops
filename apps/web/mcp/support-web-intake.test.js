"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { registerWebIntake, createRateLimiter, validateSubmission, clientIp } = require("./support-web-intake");

const valid = {
  product: "corporate-warfare", category: "player-report", email: "player@example.com",
  discord: "some_player", username: "Mogul", subject: "Someone is spamming", description: "Details here @everyone <@123>",
  website: "",
};

async function withServer(options, fn) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const calls = [];
  const logger = { log() {}, warn() {}, error() {} };
  registerWebIntake(app, {
    createTicket: async (opts) => { calls.push(opts); if (options.fail) throw Object.assign(new Error("discord down"), { stage: "reserve" }); return { ticketNumber: 2001 }; },
    findMember: async (name) => (options.member && name === "some_player" ? { user: { id: "555555555555555555", username: name } } : null),
    limiter: options.limiter,
    logger,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${listener.address().port}/api/support/ticket`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  try { await fn({ post, calls }); } finally { await new Promise((resolve) => listener.close(resolve)); }
}

describe("web support intake route", () => {
  it("opens a moderation ticket for a player report and returns the number", async () => {
    await withServer({ member: true }, async ({ post, calls }) => {
      const res = await post(valid, { "X-Forwarded-For": "203.0.113.9" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, ticketNumber: 2001 });
      assert.equal(res.headers.get("cache-control"), "no-store");
      const [opts] = calls;
      assert.equal(opts.category, "moderation");
      assert.equal(opts.discordUserId, "555555555555555555");
      assert.equal(opts.openedVia, "Opened from lakesidegames.net");
      assert.equal(opts.title, "Someone is spamming");
      assert.match(opts.description, /Opened from lakesidegames\.net/);
      assert.match(opts.description, /Product: Corporate Warfare/);
      assert.match(opts.description, /Contact email: player@example\.com/);
      assert.match(opts.description, /Discord username: some_player \(matched server member/);
      assert.match(opts.description, /Lakeside or in-game username: Mogul/);
      assert.ok(!/@everyone|<@1/.test(opts.description), "mentions are neutralised");
      assert.ok(opts.extraFields.some((f) => f.name === "Product" && f.value === "Corporate Warfare"));
    });
  });

  it("uses the bot as reporter when the Discord username is not a member", async () => {
    await withServer({ member: false }, async ({ post, calls }) => {
      const res = await post({ ...valid, category: "billing" });
      assert.equal(res.status, 200);
      assert.equal(calls[0].discordUserId, undefined);
      assert.equal(calls[0].channelLabel, "web");
      assert.equal(calls[0].category, "account");
      assert.match(calls[0].description, /not found in the Discord server/);
    });
  });

  it("maps every web category", () => {
    const expected = { bug: "bug", account: "account", billing: "account", data: "account", "player-report": "moderation", question: "gameplay", other: "other" };
    for (const [category, ticket] of Object.entries(expected)) {
      assert.equal(require("./support-web-intake").CATEGORIES[category].ticket, ticket);
      assert.doesNotThrow(() => validateSubmission({ ...valid, category }));
    }
  });

  it("honeypot submissions get a fake success and create nothing", async () => {
    await withServer({}, async ({ post, calls }) => {
      const res = await post({ ...valid, website: "http://spam.example" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, ticketNumber: 0 });
      assert.equal(calls.length, 0);
    });
  });

  it("rejects invalid input with a plain message", async () => {
    await withServer({}, async ({ post, calls }) => {
      for (const body of [
        { ...valid, product: "minecraft" },
        { ...valid, category: "refund" },
        { ...valid, email: "" },
        { ...valid, email: "not-an-email" },
        { ...valid, email: `${"a".repeat(250)}@example.com` },
        { ...valid, discord: "has spaces and stuff" },
        { ...valid, username: "u".repeat(65) },
        { ...valid, subject: "" },
        { ...valid, subject: "s".repeat(121) },
        { ...valid, description: "   " },
        { ...valid, description: "d".repeat(4001) },
        { ...valid, subject: { nested: true } },
        [valid],
      ]) {
        const res = await post(body);
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
        const json = await res.json();
        assert.equal(json.ok, false);
        assert.equal(typeof json.error, "string");
      }
      assert.equal((await post("{not json")).status, 400);
      assert.equal((await post(JSON.stringify(valid), { "Content-Type": "text/plain" })).status, 400);
      assert.equal(calls.length, 0);
    });
  });

  it("rejects bodies over 16 KB", async () => {
    await withServer({}, async ({ post, calls }) => {
      const res = await post({ ...valid, padding: "x".repeat(17 * 1024) });
      assert.equal(res.status, 413);
      assert.equal((await res.json()).ok, false);
      assert.equal(calls.length, 0);
    });
  });

  it("rate limits per IP: 3 per 10 minutes", async () => {
    await withServer({}, async ({ post, calls }) => {
      for (let i = 0; i < 3; i++) assert.equal((await post(valid, { "X-Forwarded-For": "198.51.100.1" })).status, 200);
      const limited = await post(valid, { "X-Forwarded-For": "198.51.100.1" });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal((await post(valid, { "X-Forwarded-For": "198.51.100.2" })).status, 200);
      assert.equal(calls.length, 4);
    });
  });

  it("returns 502 when ticket creation fails upstream", async () => {
    await withServer({ fail: true }, async ({ post }) => {
      const res = await post(valid);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).ok, false);
    });
  });
});

describe("rate limiter", () => {
  it("enforces the daily cap and the global hourly ceiling", () => {
    let t = 0;
    const limiter = createRateLimiter({ now: () => t });
    for (let i = 0; i < 10; i++) { assert.equal(limiter.take("a"), 0); t += 11 * 60 * 1000; }
    assert.ok(limiter.take("a") > 0, "11th in a day is refused");
    t += 24 * 60 * 60 * 1000;
    assert.equal(limiter.take("a"), 0);
    const global = createRateLimiter({ now: () => 0, global: { windowMs: 3600000, max: 2 } });
    assert.equal(global.take("x"), 0);
    assert.equal(global.take("y"), 0);
    assert.ok(global.take("z") > 0);
  });

  it("trusts X-Forwarded-For only from loopback", () => {
    assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.5" } }), "203.0.113.5");
    assert.equal(clientIp({ socket: { remoteAddress: "198.51.100.7" }, headers: { "x-forwarded-for": "203.0.113.5" } }), "198.51.100.7");
  });
});
