"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { registerEvidencePages, createLimiter, resolveChart, classify } = require("./evidence-pages");

// Synthetic identities only.
const REPORTER = "100000000000000001", OTHER = "100000000000000002", STAFF = "100000000000000003";
const REPORTER_USER = "64b7f0c2a1b2c3d4e5f60718", OTHER_USER = "64b7f0c2a1b2c3d4e5f60719";
const CHAR = "7", OTHER_CHAR = "8";
const T0 = Date.parse("2026-11-20T10:00:00Z");
const OPENED = new Date(T0 - 3600000);
const profile = (c) => `https://ahousedividedgame.com/character/${c}`;
const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const pin = (over = {}) => ({ v: 1, kind: "ticket_reporter", ticket: 123, ticketCreatedAt: OPENED.toISOString(), character: CHAR, source: "support_get", ...over });
// Pages are written in the format apps/agent/lib/operator/evidencepages.js uses.
function writePage(dir, id, { visibility = "ticket", ticket = 123, kind = "report", expiresAt = null, title = "Market history: steel", snaps = 1, archived = null, audience = pin(), tool = "market_history", meta = {}, snapAt = (n) => T0 + n * 1000 } = {}) {
  const p = path.join(dir, id);
  fs.mkdirSync(p, { recursive: true });
  const base = { id, version: 2, createdAt: new Date(T0).toISOString(), expiresAt, kind, product: "ahd", tool, metric: "commodity_volume", unit: "units", world: null, title };
  fs.writeFileSync(path.join(p, "meta.json"), JSON.stringify(visibility === "ticket" ? { ...base, visibility, ticket, ...(audience ? { audience } : {}), ...meta } : { ...base, visibility, ticket: null, ...meta }));
  fs.writeFileSync(path.join(p, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  for (let n = 1; n <= snaps; n++) {
    fs.writeFileSync(path.join(p, `snap-${String(n).padStart(4, "0")}.json`), JSON.stringify({ n, at: new Date(snapAt(n)).toISOString(), observedAt: new Date(snapAt(n)).toISOString(),
      rowsHash: `h${n}`, tool: "market_history", metric: "commodity_volume", unit: { soldUnits: "t per turn" }, unitLabel: "t per turn", world: "epoch-fixture-0001", asOfTurn: 130 + n,
      scope: { commodity: "steel", country: "US" }, title: "Commodity volume: Steel, US", columns: ["turn", "soldUnits", "source"],
      columnMeta: { turn: { label: "Turn", unit: null, kind: "x" }, soldUnits: { label: "Sold (cleared)", unit: "t per turn", kind: "measure" }, source: { label: "Source", unit: null, kind: "text" } },
      rows: [{ turn: 129 + n, soldUnits: 700 + n, source: `book <b>${n}</b>` }, { turn: 130 + n, soldUnits: null, source: "modelled" }],
      tables: [{ id: "summary", title: "Whole window", columns: ["fromTurn", "total"], columnMeta: { fromTurn: { label: "From turn", unit: "turn" }, total: { label: "Total sold", unit: "t" } }, rows: [{ fromTurn: 129, total: 1400 }] }],
      facts: [{ label: "Current balance", value: 86, unit: "points" }], caveats: ["Offered and sold are different measures."],
      sources: ["funded country book"], gaps: ["soldUnits is null before turn 120 [early_gap]"] }));
  }
  if (archived) fs.writeFileSync(path.join(p, "archived.json"), JSON.stringify(archived));
}

const liveTicket = (over = {}) => ({ ticketNumber: 123, discordUserId: REPORTER, userId: REPORTER_USER, createdAt: OPENED, reporter: { profileUrl: profile(CHAR) }, ...over });
async function withServer({ account = null, sessionError = null, tickets = { 123: liveTicket() }, discordUsers = { [REPORTER]: REPORTER_USER, [OTHER]: OTHER_USER },
  userDiscord = { [REPORTER_USER]: REPORTER, [OTHER_USER]: OTHER }, characters = { [CHAR]: REPORTER_USER, [OTHER_CHAR]: OTHER_USER }, limit = 1000, now = T0 + 60000 } = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-pages-")); dirs.push(dir);
  const app = express();
  const calls = { session: 0, ticket: 0, character: 0 };
  registerEvidencePages(app, {
    dir, now: () => now, staffDiscordIds: [STAFF], logger: { log() {}, warn() {}, error() {} }, allow: createLimiter({ max: limit }),
    verifySession: async () => { calls.session++; if (sessionError) throw new Error(sessionError); return account; },
    findTicket: async (n) => { calls.ticket++; return tickets[n] || null; },
    identify: async (accountId) => accountId.startsWith("discord:")
      ? { discordId: accountId.slice(8), userId: discordUsers[accountId.slice(8)] || null }
      : { discordId: userDiscord[accountId] || null, userId: accountId in userDiscord ? accountId : null },
    characterOwner: async (c) => { calls.character++; return characters[c] || null; },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ dir, base, calls, get: (p) => fetch(base + p, { redirect: "manual" }) }); } finally { server.close(); }
}
const ID = "a".repeat(32), ID2 = "b".repeat(32);
const status = async (opts, page, p = `/support/evidence/${ID}`) => withServer(opts, async ({ dir, get }) => { writePage(dir, ID, page); return (await get(p)).status; });

describe("evidence pages", () => {
  it("public aggregate pages open without sign-in, escape every stored value and carry strict headers", async () => {
    await withServer({}, async ({ dir, get, calls }) => {
      writePage(dir, ID, { visibility: "public_aggregate", title: "Steel <script>alert(1)</script>" });
      const res = await get(`/support/evidence/${ID}`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(!html.includes("<script>") && html.includes("Steel &lt;script&gt;"));
      assert.ok(html.includes("book &lt;b&gt;1&lt;/b&gt;"));
      assert.ok(html.includes("Public game data") && !/Ticket \d/.test(html));
      assert.ok(html.includes("not recorded"), "nulls are shown as gaps, never filled");
      assert.ok(html.includes("Sold (cleared)") && html.includes("t per turn"), "human heading and unit from the column metadata");
      assert.ok(html.includes("Whole window") && html.includes("Total sold") && html.includes("1,400"), "extra tables are rendered with their own headings");
      assert.ok(html.includes("Current balance") && html.includes("Offered and sold are different measures."));
      assert.ok(html.includes("scope: steel, US") && html.includes("as of turn 131") && html.includes("world epoch-f"), "scope, time and world identity");
      assert.ok(!html.includes("epoch-fixture-0001"), "only a short world tag is shown");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-security-policy"), /default-src 'none'; img-src 'self'/);
      assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(calls.session, 0);
      const png = await get(`/support/evidence/${ID}/chart.png`);
      assert.equal(png.status, 200); assert.equal(png.headers.get("content-type"), "image/png");
    });
  });

  it("an unknown or faulty visibility is never served, publicly or privately", async () => {
    const owner = { account: { accountId: `discord:${REPORTER}` } };
    for (const [label, page] of [
      ["public page naming a ticket", { visibility: "public_aggregate", meta: { ticket: 123 } }],
      ["public page carrying an audience", { visibility: "public_aggregate", meta: { audience: pin() } }],
      ["public tracker", { visibility: "public_aggregate", kind: "tracker", expiresAt: new Date(T0 + 86400000).toISOString() }],
      ["public reporter data", { visibility: "public_aggregate", tool: "reporter_operating_results" }],
      ["unknown visibility", { visibility: "reporter" }],
      ["ticket page with no audience", { audience: null }],
      ["audience for another ticket", { audience: pin({ ticket: 124 }) }],
      ["audience without a character", { audience: pin({ character: "" }) }],
      ["audience from another source shape", { audience: { ...pin(), v: 2 } }],
      ["tracker without a deadline", { kind: "tracker", expiresAt: null }],
      ["unknown kind", { kind: "dashboard" }],
      ["another product", { meta: { product: "other" } }],
    ]) {
      assert.equal(await status({}, page), 404, label);
      assert.equal(await status(owner, page), 404, `${label} (signed-in reporter)`);
    }
    assert.equal(classify({ id: ID, product: "ahd", visibility: "public_aggregate", kind: "report", ticket: null, expiresAt: null, tool: "market_history" }, ID), "public");
    assert.equal(classify({ id: ID, product: "ahd", visibility: "public_aggregate", kind: "report", ticket: null, expiresAt: null, tool: "market_history" }, ID2), null, "meta must name its own id");
  });

  it("ticket pages need the pinned original reporter, rechecked against the live ticket, the viewer and the character on every request", async () => {
    await withServer({}, async ({ dir, get }) => {
      writePage(dir, ID);
      const res = await get(`/support/evidence/${ID}`);
      assert.equal(res.status, 401);
      const html = await res.text();
      assert.ok(html.includes("https://lakesidegames.net/account") && !html.includes("Market history"));
      assert.equal((await get(`/support/evidence/${ID}/chart.png`)).status, 401, "the attachment is gated too");
    });
    await withServer({ account: { accountId: `discord:${REPORTER}` } }, async ({ dir, get, calls }) => {
      writePage(dir, ID);
      const res = await get(`/support/evidence/${ID}`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Ticket 123/);
      assert.equal((await get(`/support/evidence/${ID}/chart.png`)).status, 200);
      assert.equal(calls.ticket, 2, "ownership is read on every request");
      assert.equal(calls.character, 2, "the pinned character is checked on every request");
    });
    assert.equal(await status({ account: { accountId: REPORTER_USER } }), 200, "the reporter's AHD account");
    assert.equal(await status({ account: { accountId: `discord:${STAFF}` } }), 200, "staff");
    for (const p of [`/support/evidence/${ID}`, `/support/evidence/${ID}/chart.png`]) assert.equal(await status({ account: { accountId: `discord:${OTHER}` } }, {}, p), 403, `another player: ${p}`);
    assert.equal(await status({ sessionError: "accounts down" }), 503, "fails closed when sign-in cannot be checked");
    assert.equal(await status({ account: { accountId: `discord:${REPORTER}` }, tickets: {} }), 404, "a missing ticket shows nothing");
  });

  it("reassigning the ticket never reveals the previous reporter's page, to the old or the new reporter", async () => {
    const reporter = { account: { accountId: `discord:${REPORTER}` } }, other = { account: { accountId: `discord:${OTHER}` } };
    // Reporter fields moved to another player, profile link left behind (a partial heal).
    const moved = { 123: liveTicket({ discordUserId: OTHER, userId: OTHER_USER }) };
    assert.equal(await status({ ...other, tickets: moved }), 403, "the new reporter does not own the pinned character");
    assert.equal(await status({ ...reporter, tickets: moved }), 403, "the old reporter no longer owns the ticket");
    // A full reassignment, profile link included.
    const reassigned = { 123: liveTicket({ discordUserId: OTHER, userId: OTHER_USER, reporter: { profileUrl: profile(OTHER_CHAR) } }) };
    assert.equal(await status({ ...other, tickets: reassigned }), 403, "the pin names the original reporter");
    assert.equal(await status({ ...reporter, tickets: reassigned }), 403);
    // The ticket number reused by a different ticket row.
    assert.equal(await status({ ...reporter, tickets: { 123: liveTicket({ createdAt: new Date(T0) }) } }), 403, "a re-created ticket is not the pinned one");
    // The character changed hands.
    assert.equal(await status({ ...reporter, characters: { [CHAR]: OTHER_USER } }), 403, "the pinned character must be the viewer's own");
    // The reporter link was removed.
    assert.equal(await status({ ...reporter, tickets: { 123: liveTicket({ reporter: undefined }) } }), 403);
    // Staff keep their separate path.
    assert.equal(await status({ account: { accountId: `discord:${STAFF}` }, tickets: reassigned }), 200);
  });

  it("unknown users and guessed links get nothing", async () => {
    // A Discord account with no AHD account cannot prove the pinned character, even as the ticket's Discord id.
    assert.equal(await status({ account: { accountId: `discord:${REPORTER}` }, discordUsers: {} }), 403);
    // A signed-in account the game does not know.
    assert.equal(await status({ account: { accountId: "64b7f0c2a1b2c3d4e5f6071a" } }), 403);
    assert.equal(await status({ account: { accountId: "not-an-account" } }), 403);
    await withServer({ account: { accountId: `discord:${REPORTER}` } }, async ({ dir, get }) => {
      writePage(dir, ID);
      for (const p of [`/support/evidence/${ID2}`, "/support/evidence/..%2f..%2fetc", "/support/evidence/ABC", `/support/evidence/${ID}x`, `/support/evidence/${"0".repeat(32)}/chart.png`]) assert.equal((await get(p)).status, 404, p);
      fs.writeFileSync(path.join(dir, ID, "meta.json"), JSON.stringify({ id: ID2, visibility: "ticket", ticket: 123 }));
      assert.equal((await get(`/support/evidence/${ID}`)).status, 404, "meta must name its own id");
      fs.writeFileSync(path.join(dir, ID, "meta.json"), "{ torn");
      assert.equal((await get(`/support/evidence/${ID}`)).status, 404, "a torn meta is not found, not public");
    });
  });

  it("expired sessions sign in again; an expired or archived tracker is an immutable view", async () => {
    assert.equal(await status({ account: null }), 401, "an expired session is no session");
    await withServer({ account: { accountId: `discord:${REPORTER}` } }, async ({ dir, get }) => {
      writePage(dir, ID, { kind: "tracker", expiresAt: new Date(T0 + 86400000).toISOString(), snaps: 3, archived: { at: new Date(T0 + 7200000).toISOString(), reason: "takeover", snapshots: 2 } });
      const html = await (await get(`/support/evidence/${ID}`)).text();
      assert.match(html, /Archived 2026-11-20 12:00 UTC \(staff took the ticket over\)\. This page no longer changes\./);
      assert.ok(html.includes("as of turn 132") && !html.includes("as of turn 133"), "snapshot written after archive is not shown");
      assert.match(html, /Earlier check 1/);
    });
    await withServer({ account: { accountId: `discord:${REPORTER}` }, now: T0 + 3600000 }, async ({ dir, get }) => {
      writePage(dir, ID, { kind: "tracker", expiresAt: new Date(T0 + 86400000).toISOString() });
      assert.match(await (await get(`/support/evidence/${ID}`)).text(), /Tracking until 2026-11-21 10:00 UTC\. .*Nothing is posted to your ticket\./);
    });
    await withServer({ account: { accountId: `discord:${REPORTER}` }, now: T0 + 86400001 }, async ({ dir, get }) => {
      // Snapshot 3 was appended after the absolute deadline (a stale writer): never shown.
      writePage(dir, ID, { kind: "tracker", expiresAt: new Date(T0 + 86400000).toISOString(), snaps: 3, snapAt: (n) => n === 3 ? T0 + 86400000 + 5 : T0 + n * 1000 });
      const html = await (await get(`/support/evidence/${ID}`)).text();
      assert.match(html, /Tracking ended 2026-11-21 10:00 UTC\. This page no longer changes\./, "the 24 h limit holds even before the sweep archives it");
      assert.ok(html.includes("as of turn 132") && !html.includes("as of turn 133"));
    });
    await withServer({ account: { accountId: `discord:${REPORTER}` } }, async ({ dir, get }) => {
      // A gap in the numbering ends the page there; a report shows one snapshot only.
      writePage(dir, ID, { snaps: 2 });
      fs.rmSync(path.join(dir, ID, "snap-0001.json"));
      assert.match(await (await get(`/support/evidence/${ID}`)).text(), /No data has been recorded yet/);
    });
  });

  it("the support service resolves a chart only from the store and only for its own ticket", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-pages-")); dirs.push(dir);
    writePage(dir, ID, { ticket: 123 });
    writePage(dir, ID2, { visibility: "public_aggregate" });
    assert.equal(resolveChart(dir, ID, { ticket: 123 }), path.join(dir, ID, "chart.png"));
    assert.equal(resolveChart(dir, ID, { ticket: 124 }), null, "another ticket never gets private evidence");
    assert.equal(resolveChart(dir, ID2, { ticket: 124 }), path.join(dir, ID2, "chart.png"), "public aggregate fits any ticket");
    for (const bad of ["../" + ID, "/etc/passwd", "c".repeat(32), null]) assert.equal(resolveChart(dir, bad, { ticket: 123 }), null);
    const faulty = "d".repeat(32);
    writePage(dir, faulty, { visibility: "public_aggregate", meta: { ticket: 123 } });
    assert.equal(resolveChart(dir, faulty, { ticket: 124 }), null, "a faulty public page is not public");
  });

  it("rate limits per client", async () => {
    await withServer({ limit: 2 }, async ({ dir, get }) => {
      writePage(dir, ID, { visibility: "public_aggregate" });
      assert.equal((await get(`/support/evidence/${ID}`)).status, 200);
      assert.equal((await get(`/support/evidence/${ID}`)).status, 200);
      const res = await get(`/support/evidence/${ID}`);
      assert.equal(res.status, 429); assert.equal(res.headers.get("retry-after"), "60");
    });
  });

  it("registration refuses to run without every ownership lookup", () => {
    assert.throws(() => registerEvidencePages(express(), { verifySession: async () => null, findTicket: async () => null, identify: async () => ({}) }), /characterOwner/);
  });
});
