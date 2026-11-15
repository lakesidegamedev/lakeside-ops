"use strict";
const test = require("node:test");
const assert = require("node:assert");
const s = require("./sentry-client");

const event = {
  eventID: "584ffe8b0000000000000000deadbeef", dateCreated: "2026-11-15T04:25:58Z", title: "Error: boom",
  tags: [{ key: "route", value: "/senate" }, { key: "error_code", value: "CLIENT_ERROR" }, { key: "browser", value: "Chrome 130" }, { key: "secret", value: "x" }],
  release: { version: "ahd@1.2.3" },
  user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4", username: "bob" },
  entries: [
    { type: "exception", data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames: [
      { function: "a", filename: "node_modules/lib.js", lineNo: 1, inApp: false }, { function: "b", filename: "src/b.ts", lineNo: 9, inApp: true }, { function: "c", filename: "src/c.ts", lineNo: 3, inApp: true }] } }] } },
    { type: "breadcrumbs", data: { values: Array.from({ length: 15 }, (_, i) => ({ category: "ui", message: `m${i}` })) } },
    { type: "request", data: { url: "https://x.test/senate" } },
  ],
};

test("normaliseRef accepts player copy and full ids", () => {
  assert.strictEqual(s.normaliseRef("Ref: 584FFE8B"), "584ffe8b");
  assert.strictEqual(s.normaliseRef("584ffe8b0000000000000000deadbeef"), "584ffe8b0000000000000000deadbeef");
  assert.strictEqual(s.normaliseRef("nothing"), null);
});

test("matchEventPrefix matches client-side and ignores others", () => {
  const rows = [{ id: "584ffe8baaaa" }, { id: "999ffe8baaaa" }, { id: null }];
  assert.deepStrictEqual(s.matchEventPrefix(rows, "Ref: 584ffe8b").map(r => r.id), ["584ffe8baaaa"]);
  assert.deepStrictEqual(s.matchEventPrefix(rows, "zz"), []);
});

test("shapeEvent keeps wanted tags, in-app frames, breadcrumb tail, id-only user", () => {
  const e = s.shapeEvent(event);
  assert.strictEqual(e.ref, "584ffe8b");
  assert.deepStrictEqual(e.exception, { type: "TypeError", value: "x is undefined" });
  assert.deepStrictEqual(e.topFrames.map(f => f.function), ["c", "b"]);
  assert.strictEqual(e.tags.route, "/senate");
  assert.strictEqual(e.tags.release, "ahd@1.2.3");
  assert.strictEqual(e.tags.secret, undefined);
  assert.strictEqual(e.breadcrumbs.length, 10);
  assert.strictEqual(e.userId, "u1");
  assert.ok(!JSON.stringify(e).includes("a@b.c") && !JSON.stringify(e).includes("1.2.3.4"));
});

test("shapeIssue returns the contract fields", () => {
  const i = s.shapeIssue({ id: 5, shortId: "AHD-1", title: "t", culprit: "c", count: "12", userCount: 3, firstSeen: "a", lastSeen: "b", permalink: "p", project: { slug: "a-house-divided" } });
  assert.deepStrictEqual(Object.keys(i).slice(0, 9), ["id", "shortId", "title", "culprit", "count", "userCount", "firstSeen", "lastSeen", "permalink"]);
  assert.strictEqual(i.count, 12);
});

function fakeFetch(map) {
  return async url => {
    const hit = map(String(url));
    return { ok: hit.status === 200, status: hit.status, headers: { get: k => (hit.headers || {})[k] || null }, json: async () => hit.body };
  };
}

test("client maps 401 and 429 to clear errors", async () => {
  const c401 = s.createClient({ token: "t", fetchImpl: fakeFetch(() => ({ status: 401 })) });
  await assert.rejects(() => c401.get("/x"), /401/);
  const c429 = s.createClient({ token: "t", fetchImpl: fakeFetch(() => ({ status: 429, headers: { "retry-after": "7" } })) });
  await assert.rejects(() => c429.get("/x"), /rate limit.*7s/);
});

test("lookupEvent pages until the prefix matches", async () => {
  const link = '<https://sentry.io/api/0/x/?cursor=0:100:0>; rel="next"; results="true"';
  const c = s.createClient({ token: "t", fetchImpl: fakeFetch(u => u.includes("cursor=")
    ? { status: 200, body: { data: [{ id: "584ffe8bffff", title: "T", issue: "AHD-2", project: "p", timestamp: "ts" }] } }
    : { status: 200, headers: { link }, body: { data: [{ id: "1111", title: "n" }] } }) });
  const r = await s.lookupEvent(c, "Ref: 584ffe8b");
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.scanned, 2);
  assert.strictEqual(r.matches[0].issue, "AHD-2");
  const none = await s.lookupEvent(c, "ffffffff", { maxPages: 1 });
  assert.strictEqual(none.found, false);
});

test("listIssues resolves project slugs and implies is:unresolved", async () => {
  const seen = [];
  const c = s.createClient({ token: "t", fetchImpl: fakeFetch(u => { seen.push(u); return u.includes("/projects/") ? { status: 200, body: [{ id: 7, slug: "a-house-divided" }] } : { status: 200, body: [{ id: 1, shortId: "A-1", title: "t", count: "1", userCount: 1 }] }; }) });
  const rows = await s.listIssues(c, { project: "a-house-divided", query: "error_code:CLIENT_ERROR" });
  assert.strictEqual(rows.length, 1);
  assert.match(seen[1], /project=7/);
  assert.match(decodeURIComponent(seen[1].replace(/\+/g, " ")), /is:unresolved error_code:CLIENT_ERROR/);
  await assert.rejects(() => s.listIssues(c, { project: "nope" }), /Unknown project/);
});
