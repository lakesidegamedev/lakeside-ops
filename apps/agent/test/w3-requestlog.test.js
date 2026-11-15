"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createRequestLog } = require("../lib/operator/requestlog");

const who = { matched: true, private: { userId: "b".repeat(24) } };
test("reads the reporter's requests through a closed projection and groups them", async () => {
  let sent;
  const mcp = { call: async (server, tool, args) => { sent = { server, tool, args }; return { docs: [
    { method: "POST", path: "/api/corporations/6a7babd099b159cfd5190a9f/buy", status: 429, timestamp: "2026-11-15T10:00:02Z" },
    { method: "POST", path: "/api/corporations/6a7babd099b159cfd5190a9e/buy", status: 429, timestamp: "2026-11-15T10:00:01Z" },
    { method: "GET", path: "/api/me", status: 200, timestamp: "2026-11-15T10:00:00Z" }] }; } };
  const out = await createRequestLog({ mcp, resolveIdentity: async () => who, now: () => Date.parse("2026-11-15T11:00:00Z") }).call({ ticket: 3, role: "support" }, {});
  assert.deepEqual(Object.keys(sent.args.projection).sort(), ["method", "path", "status", "timestamp"]);
  assert.ok(!/ip|userAgent/i.test(JSON.stringify(sent.args.projection)));
  assert.equal(out.failed.length, 2);
  assert.equal(out.calls[0].path, "/api/corporations/:id/buy"); assert.equal(out.calls[0].count, 2);
  assert.match(out.note, /no duration/);
});

test("no account match or a player task reads nothing", async () => {
  const mcp = { call: async () => { throw new Error("should not read"); } };
  const t = createRequestLog({ mcp, resolveIdentity: async () => ({ matched: false }) });
  assert.equal((await t.call({ ticket: 1, role: "support" }, {})).matched, false);
  await assert.rejects(t.call({ ticket: 1, role: "player" }, {}), /players cannot/);
});
