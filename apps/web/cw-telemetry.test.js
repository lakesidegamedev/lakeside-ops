// Unit tests for the Corporate Warfare telemetry ingest and store.
// Run: node --test cw-telemetry.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { handleCwTelemetryRoute, validate, makeLimiter, MAX_BODY } = require("./cw-telemetry-routes");
const { openTelemetry } = require("./cw-telemetry-store");

function envelope(overrides = {}) {
  return {
    install_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    app_version: "1.3.0",
    build: "4",
    snapshot: {
      schema: 1,
      engine_version: "1.3.0",
      dataset_hash: "a".repeat(64),
      scenario: "guided",
      seed: 7,
      week: 10,
      goods: [
        { id: "steel", made_lots: 585, sold_lots: 600, imported_lots: 0, exported_lots: 300, stock_lots: 1700, median_ask_cents: 46000, reference_cents: 40000, household_spend_cents: 0 },
      ],
      corridor: { firms_operating: 30, firms_dissolved: 1, raids: 0, outside_cash_cents: 49_000_000_000 },
      player: { cash_cents: 80_000_000, revenue_13w_cents: 90_000_000, net_income_13w_cents: -1_000_000, divisions: 1, plants: 5 },
      ...overrides,
    },
  };
}

function call(body, { store, allow = () => true, raw } = {}) {
  const text = raw !== undefined ? raw : JSON.stringify(body);
  const req = Readable.from([text]);
  Object.assign(req, { method: "POST", headers: {} });
  const out = { status: 0, body: "" };
  const res = { setHeader() {}, writeHead(s) { out.status = s; }, end(b) { out.body = String(b || ""); } };
  return handleCwTelemetryRoute(req, res, "/api/cw/telemetry", {
    addSecurityHeaders() {},
    store: () => store,
    allow,
    clientIp: () => "203.0.113.9",
  }).then((handled) => ({ handled, ...out, json: () => JSON.parse(out.body) }));
}

describe("cw telemetry", () => {
  it("stores a valid snapshot once and ignores a repeat", async () => {
    const store = openTelemetry(":memory:");
    const first = await call(envelope(), { store });
    assert.equal(first.status, 202);
    assert.equal(first.json().stored, true);
    const again = await call(envelope(), { store });
    assert.equal(again.status, 202);
    assert.equal(again.json().stored, false);
    assert.equal(store.recent({ days: 1 }).length, 1);
  });

  it("rejects bad shapes, big bodies and floods", async () => {
    const store = openTelemetry(":memory:");
    assert.equal(validate(envelope({ week: 11 })), "week invalid");
    assert.equal(validate(envelope({ schema: 4 })), null);
    assert.equal(validate(envelope({ schema: 100 })), "unsupported snapshot schema");
    assert.equal(validate({ ...envelope(), install_id: "not-a-uuid" }), "install_id must be a uuid");
    assert.equal(validate(envelope({ goods: [{ id: "Steel!" }] })), "good id invalid");
    assert.equal((await call(null, { store, raw: "{not json" })).status, 400);
    assert.equal((await call(null, { store, raw: "x".repeat(MAX_BODY + 10) })).status, 413);
    assert.equal((await call(envelope(), { store, allow: () => false })).status, 429);
    assert.equal(store.recent({ days: 1 }).length, 0);
  });

  it("the limiter allows a window's quota per address", () => {
    let t = 0;
    const allow = makeLimiter({ limit: 2, windowMs: 1000, now: () => t });
    assert.equal(allow("a"), true);
    assert.equal(allow("a"), true);
    assert.equal(allow("a"), false);
    assert.equal(allow("b"), true);
    t = 1500;
    assert.equal(allow("a"), true);
  });

  it("summarises market balance across snapshots", async () => {
    const store = openTelemetry(":memory:");
    await call(envelope(), { store });
    await call(envelope({ week: 15 }), { store });
    const balance = store.balance({ days: 1 });
    assert.equal(balance.snapshots, 2);
    assert.equal(balance.installs, 1);
    assert.equal(balance.playersLosing13w, 2);
    const steel = balance.goods.find((g) => g.id === "steel");
    // $460 against a $400 reference is 15 percent over.
    assert.equal(steel.priceVsRefPct, 15);
    assert.equal(steel.made, 585);
  });
});
