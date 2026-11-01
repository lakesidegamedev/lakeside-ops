"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isExpired } = require("./agent-tokens");

test("tokens expire at expiresAt and an unreadable expiry fails closed", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  assert.equal(isExpired({}, now), false);
  assert.equal(isExpired({ expiresAt: new Date("2026-11-02T00:00:00Z") }, now), false);
  assert.equal(isExpired({ expiresAt: new Date("2026-11-01T00:00:00Z") }, now), true);
  assert.equal(isExpired({ expiresAt: "not a date" }, now), true);
});
