"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createPlayerTrail } = require("../lib/operator/playertrail");

const who = { matched: true, private: { userId: "a".repeat(24) } };
const env = { POSTHOG_PERSONAL_API_KEY: "k".repeat(30), POSTHOG_PROJECT_ID: "12345", POSTHOG_HOST: "https://ph.example" };
const rows = [
  ["$pageview", "2026-11-13 21:30:00", "/wrapped", "s1", null, null, null],
  ["$autocapture", "2026-11-13 21:30:05", "/wrapped", "s1", "Open wrapped for me@example.com", null, null],
  ["$rageclick", "2026-11-13 21:30:09", "/wrapped", "s1", "Next", null, null],
  ["$exception", "2026-11-13 21:30:10", "/wrapped", "s1", null, "TypeError at 10.1.2.3", null],
];

test("builds a bounded HogQL query for the reporter only and summarizes it", async () => {
  let sent;
  const fetcher = async (url, opts) => { sent = { url, opts, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ results: rows }) }; };
  const out = await createPlayerTrail({ env, fetcher, resolveIdentity: async () => who, now: () => Date.parse("2026-11-13T22:00:00Z") })
    .call({ ticket: 4, role: "support" }, { around: "2026-11-13T21:30:00Z", minutes: 15 });
  assert.equal(sent.url, "https://ph.example/api/projects/12345/query/");
  assert.equal(sent.body.query.values.distinct, "a".repeat(24));
  assert.ok(!/email|\$ip|person\.properties/i.test(sent.body.query.query), "no email or ip column is selected");
  assert.equal(out.counts.$rageclick, 1);
  assert.equal(out.rageClicks[0].path, "/wrapped");
  assert.equal(out.errors.length, 1);
  assert.ok(!JSON.stringify(out).includes("me@example.com") && !JSON.stringify(out).includes("10.1.2.3"));
  assert.match(out.replayLinks[0], /^https:\/\/ph\.example\/project\/12345\/replay\/s1$/);
  assert.match(out.instruction, /never put a replay link/);
});

test("not configured degrades with a note, without any network call", async () => {
  const out = await createPlayerTrail({ env: {}, fetcher: async () => { throw new Error("no network"); }, resolveIdentity: async () => who }).call({ ticket: 4, role: "support" }, {});
  assert.equal(out.configured, false);
});

test("an unresolved reporter or a player task reads nothing", async () => {
  const t = createPlayerTrail({ env, fetcher: async () => { throw new Error("no network"); }, resolveIdentity: async () => ({ matched: false }) });
  assert.equal((await t.call({ ticket: 4, role: "support" }, {})).matched, false);
  await assert.rejects(t.call({ ticket: 4, role: "player" }, {}), /players cannot/);
  await assert.rejects(t.call({ role: "support" }, {}), /assigned ticket/);
});

test("an empty window says it is not proof of inactivity", async () => {
  const out = await createPlayerTrail({ env, fetcher: async () => ({ ok: true, json: async () => ({ results: [] }) }), resolveIdentity: async () => who }).call({ ticket: 4, role: "support" }, {});
  assert.equal(out.events, 0); assert.match(out.note, /not proof/);
});
