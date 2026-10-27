"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  registerWebIntake, createRateLimiter, createAccountGuard, createSessionVerifier, createStandingCheck,
  validateSubmission, clientIp, sessionToken,
} = require("./support-web-intake");
const { moderateSubmission } = require("./support-web-moderation");

const TOKEN = "t".repeat(43);
const SIGNED_IN = { Cookie: `__Host-lakeside_session=${TOKEN}` };
const ACCOUNT = { accountId: "64b7f0c2a1b2c3d4e5f60718", username: "Mogul", email: "player@example.com" };

const valid = {
  product: "corporate-warfare", category: "player-report",
  discord: "some_player", subject: "Someone is spamming", description: "Details here @everyone <@123>",
  website: "",
};

let seq = 0;
// A fresh subject and description so the duplicate rule does not trip.
const fresh = (extra = {}) => ({ ...valid, subject: `Problem ${++seq}`, description: `Details for problem ${seq}`, ...extra });

async function withServer(options, fn) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const calls = [];
  const logger = { log() {}, warn() {}, error() {} };
  registerWebIntake(app, {
    createTicket: async (opts) => { calls.push(opts); if (options.fail) throw Object.assign(new Error("discord down"), { stage: "reserve" }); return { ticketNumber: 2001 }; },
    findMember: async (name) => (options.member && name === "some_player" ? { user: { id: "555555555555555555", username: name } } : null),
    verifySession: options.verifySession || (async (req) => {
      const cookie = String(req.headers.cookie || "");
      if (!cookie.includes(TOKEN)) return null;
      const who = /acct=(\w+)/.exec(cookie);
      return who ? { ...ACCOUNT, accountId: who[1] } : ACCOUNT;
    }),
    checkStanding: options.checkStanding,
    limiter: options.limiter,
    accountGuard: options.accountGuard,
    logger,
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const post = (body, headers = SIGNED_IN) => fetch(`http://127.0.0.1:${listener.address().port}/api/support/ticket`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  try { await fn({ post, calls }); } finally { await new Promise((resolve) => listener.close(resolve)); }
}

describe("web support intake route", () => {
  it("opens a ticket for a signed-in account and attaches the account", async () => {
    await withServer({ member: true }, async ({ post, calls }) => {
      const res = await post(valid, { ...SIGNED_IN, "X-Forwarded-For": "203.0.113.9", Origin: "https://lakesidegames.net", "Sec-Fetch-Site": "same-origin" });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, ticketNumber: 2001 });
      assert.equal(res.headers.get("cache-control"), "no-store");
      const [opts] = calls;
      assert.equal(opts.category, "moderation");
      assert.equal(opts.discordUserId, "555555555555555555");
      assert.equal(opts.openedVia, "Opened from lakesidegames.net");
      assert.equal(opts.title, "Someone is spamming");
      assert.match(opts.description, /Product: Corporate Warfare/);
      assert.match(opts.description, /Lakeside account: Mogul \(id 64b7f0c2a1b2c3d4e5f60718\)/);
      assert.match(opts.description, /Account email: player@example\.com/);
      assert.match(opts.description, /Discord username: some_player \(matched server member/);
      assert.doesNotMatch(opts.description, /Flagged by auto moderation/);
      assert.ok(!/@everyone|<@1/.test(opts.description), "mentions are neutralised");
      assert.ok(opts.extraFields.some((f) => f.name === "Lakeside account" && f.value === "Mogul (id 64b7f0c2a1b2c3d4e5f60718)"));
      assert.ok(opts.extraFields.some((f) => f.name === "Account email" && f.value === "player@example.com"));
      assert.ok(!opts.extraFields.some((f) => f.name === "Auto moderation"));
    });
  });

  it("refuses unsigned requests with 401, including honeypot posts", async () => {
    await withServer({}, async ({ post, calls }) => {
      for (const headers of [{}, { Cookie: "__Host-lakeside_session=wrong" }]) {
        const res = await post(fresh(), headers);
        assert.equal(res.status, 401);
        assert.match((await res.json()).error, /Sign in/);
      }
      assert.equal((await post({ ...valid, website: "http://spam.example" }, {})).status, 401);
      assert.equal(calls.length, 0);
    });
  });

  it("returns 503 when the sign-in check fails, and 403 for cross-site posts", async () => {
    await withServer({ verifySession: async () => { throw new Error("accounts down"); } }, async ({ post, calls }) => {
      assert.equal((await post(fresh())).status, 503);
      assert.equal(calls.length, 0);
    });
    await withServer({}, async ({ post, calls }) => {
      assert.equal((await post(fresh(), { ...SIGNED_IN, Origin: "https://evil.example" })).status, 403);
      assert.equal((await post(fresh(), { ...SIGNED_IN, "Sec-Fetch-Site": "cross-site" })).status, 403);
      assert.equal(calls.length, 0);
    });
  });

  it("refuses accounts banned in A House Divided", async () => {
    await withServer({ checkStanding: async ({ accountId }) => (accountId === ACCOUNT.accountId ? "banned in A House Divided" : null) }, async ({ post, calls }) => {
      const res = await post(fresh());
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /cannot send support tickets/);
      assert.equal(calls.length, 0);
    });
  });

  it("uses the bot as reporter when the Discord username is not a member", async () => {
    await withServer({ member: false }, async ({ post, calls }) => {
      const res = await post(fresh({ category: "billing" }));
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

  it("honeypot submissions from a signed-in account get a fake success and create nothing", async () => {
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
        { ...valid, discord: "has spaces and stuff" },
        { ...valid, subject: "" },
        { ...valid, subject: "s".repeat(121) },
        { ...valid, description: "   " },
        { ...valid, description: "d ".repeat(2001) },
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
      assert.equal((await post(JSON.stringify(valid), { ...SIGNED_IN, "Content-Type": "text/plain" })).status, 400);
      assert.equal(calls.length, 0);
    });
  });

  it("ignores the old email and username fields", async () => {
    await withServer({}, async ({ post, calls }) => {
      assert.equal((await post(fresh({ email: "spoof@example.com", username: "Someone Else" }))).status, 200);
      assert.doesNotMatch(calls[0].description, /spoof@example\.com|Someone Else/);
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
      const as = (acct, ip) => ({ Cookie: `__Host-lakeside_session=${TOKEN}; acct=${acct}`, "X-Forwarded-For": ip });
      for (let i = 0; i < 3; i++) assert.equal((await post(fresh(), as(`ip${i}`, "198.51.100.1"))).status, 200);
      const limited = await post(fresh(), as("ip9", "198.51.100.1"));
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal((await post(fresh(), as("ip9", "198.51.100.2"))).status, 200);
      assert.equal(calls.length, 4);
    });
  });

  it("rate limits per account: 3 an hour, even across IPs", async () => {
    await withServer({}, async ({ post, calls }) => {
      for (let i = 0; i < 3; i++) assert.equal((await post(fresh(), { ...SIGNED_IN, "X-Forwarded-For": `198.51.100.${10 + i}` })).status, 200);
      const limited = await post(fresh(), { ...SIGNED_IN, "X-Forwarded-For": "198.51.100.20" });
      assert.equal(limited.status, 429);
      assert.match((await limited.json()).error, /3 an hour, 6 a day/);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(calls.length, 3);
    });
  });

  it("rejects the same subject and description from one account within 24 hours", async () => {
    await withServer({}, async ({ post, calls }) => {
      const body = fresh();
      assert.equal((await post(body, { ...SIGNED_IN, "X-Forwarded-For": "198.51.100.30" })).status, 200);
      const again = await post({ ...body, description: `  ${body.description.toUpperCase()} ` }, { ...SIGNED_IN, "X-Forwarded-For": "198.51.100.31" });
      assert.equal(again.status, 409);
      assert.match((await again.json()).error, /already sent this ticket/);
      assert.equal(calls.length, 1);
    });
  });

  it("refuses slurs, spam and link stuffing, and flags borderline content", async () => {
    await withServer({}, async ({ post, calls }) => {
      const ip = (n) => ({ ...SIGNED_IN, "X-Forwarded-For": `198.51.100.${40 + n}` });
      const slur = await post(fresh({ description: "you are a n1gger" }), ip(1));
      assert.equal(slur.status, 400);
      assert.match((await slur.json()).error, /language we do not accept/);
      assert.equal((await post(fresh({ description: "a https://a.example b https://b.example c https://c.example" }), ip(2))).status, 400);
      assert.equal(calls.length, 0);
      const flagged = await post(fresh({ description: "this shit is broken in Papua New Guinea" }), ip(3));
      assert.equal(flagged.status, 200);
      const field = calls[0].extraFields.find((f) => f.name === "Auto moderation");
      assert.equal(field.value, "Flagged by auto moderation: possible slur (word with other meanings), profanity");
      assert.match(calls[0].description, /Flagged by auto moderation: possible slur/);
    });
  });

  it("frees the duplicate claim when ticket creation fails, and returns 502", async () => {
    const accountGuard = createAccountGuard();
    const body = fresh();
    await withServer({ fail: true, accountGuard }, async ({ post }) => {
      const res = await post(body);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).ok, false);
    });
    assert.equal(accountGuard.isDuplicate(ACCOUNT.accountId, validateSubmission(body)), false);
  });
});

describe("automatic moderation", () => {
  const check = (description, subject = "Help") => moderateSubmission({ subject, description, discord: "" });
  it("blocks slurs and hate speech, including spaced spellings", () => {
    for (const text of ["you are a n1gger", "k y s", "f.a.g", "go back you wetback", "kill yourself"]) assert.equal(check(text).ok, false, text);
  });
  it("lets ordinary words through that the AHD lists also match", () => {
    for (const text of ["My army in Niger and Nigeria is stuck", "I am a b c tester", "Hi, I cannot log in after the update."]) {
      assert.deepEqual(check(text), { ok: true, flags: [] }, text);
    }
    assert.deepEqual(check("a chink in the armour"), { ok: true, flags: ["possible slur (word with other meanings)"] });
  });
  it("rejects spam: links over 2, repeated characters, caps walls, spam phrases", () => {
    assert.equal(check("https://a.example www.b.example discord.gg/abc").ok, false);
    assert.deepEqual(check("see https://a.example and https://b.example"), { ok: true, flags: ["2 links"] });
    assert.equal(check("helloooooooooooo").ok, false);
    assert.equal(check("THIS GAME IS COMPLETELY BROKEN AND NOBODY IS FIXING ANYTHING AT ALL").ok, false);
    assert.equal(check("free robux for everyone").ok, false);
    assert.equal(check("We offer SEO services for your site").ok, false);
  });
  it("flags profanity and mostly-capital text without refusing it", () => {
    assert.deepEqual(check("this is shit"), { ok: true, flags: ["profanity"] });
    assert.deepEqual(check("THE MARKET PAGE IS BROKEN AND I CANNOT SELL anything at all today"), { ok: true, flags: ["mostly capitals"] });
  });
});

describe("session verification", () => {
  const req = (cookie) => ({ headers: { cookie } });
  it("reads exactly one well-formed session cookie", () => {
    assert.equal(sessionToken(req(`a=b; __Host-lakeside_session=${TOKEN}`)), TOKEN);
    assert.equal(sessionToken(req(`__Host-lakeside_session=${TOKEN}; __Host-lakeside_session=${TOKEN}`)), null);
    assert.equal(sessionToken(req("__Host-lakeside_session=bad token")), null);
    assert.equal(sessionToken(req("")), null);
  });
  it("forwards only the session cookie and maps the answer", async () => {
    const seen = [];
    const answer = (status, body) => async (url, init) => { seen.push({ url, init }); return { status, json: async () => body }; };
    const verify = (impl) => createSessionVerifier({ url: "https://accounts.example/account/api/session", fetchImpl: impl });
    const signedIn = { signedIn: true, accountId: "discord:42", username: "Mogul", email: "" };
    assert.deepEqual(await verify(answer(200, signedIn))(req(`other=1; __Host-lakeside_session=${TOKEN}`)), { accountId: "discord:42", username: "Mogul", email: "" });
    assert.equal(seen[0].init.headers.Cookie, `__Host-lakeside_session=${TOKEN}`);
    assert.equal(seen[0].url, "https://accounts.example/account/api/session");
    assert.equal(await verify(answer(200, { signedIn: false }))(req(`__Host-lakeside_session=${TOKEN}`)), null);
    assert.equal(await verify(answer(200, signedIn))(req("")), null, "no cookie means no call");
    assert.equal(seen.length, 2);
    await assert.rejects(verify(answer(503, {}))(req(`__Host-lakeside_session=${TOKEN}`)));
    await assert.rejects(verify(answer(200, { signedIn: true, username: "x" }))(req(`__Host-lakeside_session=${TOKEN}`)), /no account id/);
  });
});

describe("A House Divided standing", () => {
  const fakeDb = ({ users = [], bannedIps = [] }) => ({
    collection: (name) => ({
      findOne: async (query) => (name === "users" ? users : bannedIps).find((row) => Object.entries(query).every(([k, v]) => {
        if (v && typeof v === "object" && "$ne" in v) return row[k] !== v.$ne;
        return String(row[k]) === String(v);
      })) || null,
    }),
  });
  it("blocks banned AHD accounts, Discord-linked bans and banned IPs", async () => {
    const check = createStandingCheck(fakeDb({
      users: [{ _id: "64b7f0c2a1b2c3d4e5f60718", isBanned: true }, { _id: "64b7f0c2a1b2c3d4e5f60719", discordId: "42", isBanned: true }, { _id: "64b7f0c2a1b2c3d4e5f6071a", discordId: "43" }],
      bannedIps: [{ ip: "203.0.113.66" }, { ip: "203.0.113.67", allowRegistration: true }],
    }));
    assert.equal(await check({ accountId: "64b7f0c2a1b2c3d4e5f60718", ip: "198.51.100.1" }), "banned in A House Divided");
    assert.equal(await check({ accountId: "discord:42", ip: "198.51.100.1" }), "banned in A House Divided");
    assert.equal(await check({ accountId: "discord:43", ip: "198.51.100.1" }), null);
    assert.equal(await check({ accountId: "discord:43", ip: "203.0.113.66" }), "IP banned in A House Divided");
    assert.equal(await check({ accountId: "discord:43", ip: "203.0.113.67" }), null, "an allowance row is not a ban");
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

  it("caps an account at 6 a day and has no global ceiling of its own", () => {
    let t = 0;
    const guard = createAccountGuard({ now: () => t });
    for (let i = 0; i < 6; i++) { assert.equal(guard.take("acct"), 0, `ticket ${i + 1}`); t += 61 * 60 * 1000; }
    assert.ok(guard.take("acct") > 0, "7th in a day is refused");
    for (let i = 0; i < 40; i++) assert.equal(guard.take(`other${i}`), 0);
  });

  it("trusts X-Forwarded-For only from loopback", () => {
    assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "203.0.113.5" } }), "203.0.113.5");
    assert.equal(clientIp({ socket: { remoteAddress: "198.51.100.7" }, headers: { "x-forwarded-for": "203.0.113.5" } }), "198.51.100.7");
  });
});
