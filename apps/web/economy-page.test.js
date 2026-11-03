"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeEconomyBody, readFeed, fmt, bandText } = require("./economy-page");

function gate(over) {
  return { key: "k", sub: 1, group: "Corporations", src: "c", field: "f", label: "Measure", unit: "%", green: [4, 15], amber: [2, 22], note: "n", now: 30, prev12: 28, status: "red", pts: [[500, 10], [510, 20], [520, 30]], openingInfo: false, ...over };
}

function feed(over) {
  const rows = [[500, 3, 4, 5, 4, 0, 80, 70, 0.9, 1.1, 2, 0, 1], [520, 3.2, 4.1, 5, 4, 0, 82, 71, 0.95, 1.2, 1, 0, 1]];
  return {
    v: 1, generatedAt: new Date().toISOString(), game: { year: 2003 }, worldId: "w:1", latest: 520, firstTurn: 0, resets: [507], deploys: [],
    scores: { health: [[500, 70], [520, 73]], gameplay: [[520, 68]], commodities: [[520, 56]] },
    gates: [gate(), gate({ key: "k2", sub: 3, label: "Same measure counted twice" }), gate({ key: "g", label: "Fine <b>", status: "green", now: 10 })],
    macro: { fields: ["infl", "growth", "unemp", "prime", "realRate", "fill", "intent", "sdMedian", "realMedian", "deepShort", "glut", "outliers"], rows },
    wealth: { fields: ["gini", "median", "top1", "n", "total"], rows: [[520, 0.9, 5e6, 40, 256, 7e10]] },
    corpSeries: { fields: ["nActive"], rows: [[520, 1000]] }, trades: { fields: ["n", "notional"], rows: [[520, 2, 1e6]] },
    commodities: [{ key: "healthcare_services", price: 8400, base: 2500, real: 3, real12: 3, sd: 0.22, sd12: 0.2, sdPts: [0.2, 0.22], realPts: [3, 3] }],
    countries: [{ id: "IT", gdpA: 1.5e12, growth: 4.5, growth12: 0.2, infl: 19.4, infl12: 18.8, unemp: 11.4, unemp12: 8.5, prime: 14.3, gap: 0.5, bal: -147, rating: "CCC" }],
    breakdown: { family: { Industry: { n: 2, rev: 10, net: 1, mcap: 5, cash: 1, lossShare: 5, medMargin: 10 } }, owner: {} },
    topCorps: [{ name: "Acme <script>", type: "x", family: "Industry", country: "US", owner: "Player", mcap: 1e9, net: 1, rev: 2, cash: 3, rating: "AAA" }],
    movers: { up: [["Up Co", "x", "Industry", "US", "NPP", 12.5, 1e6, 1, 500]], down: [] },
    fixes: [{ id: "f", priority: "P0", area: "Markets", title: "Fix it", prs: [123], status: "live", liveTurn: 600 }],
    ...over,
  };
}

test("every tab renders, escapes values and uses no dash characters", () => {
  for (const tab of ["overview", "markets", "companies", "players", "countries", "fixes"]) {
    const { body } = makeEconomyBody({ feed: feed(), tab });
    assert.match(body, /class="eco-tabs"/);
    assert.doesNotMatch(body, /Acme <script>|Fine <b>/);
    assert.doesNotMatch(body, /[–—]/);
  }
});

test("needs attention lists a measure counted in two scores once", () => {
  const { body } = makeEconomyBody({ feed: feed(), tab: "overview" });
  assert.match(body, /Needs attention \(1\)/);
});

test("range defaults to the last reset and can widen to the whole world", () => {
  assert.match(makeEconomyBody({ feed: feed() }).body, /class="on" href="\/economy\?tab=overview">Since reset \(t507\)/);
  assert.match(makeEconomyBody({ feed: feed(), range: "all" }).body, /class="on" href="\/economy\?tab=overview&range=all">Whole world/);
});

test("unknown tab falls back to overview; missing feed shows a plain message", () => {
  assert.match(makeEconomyBody({ feed: feed(), tab: "nope" }).body, /Needs attention/);
  const missing = readFeed(path.join(os.tmpdir(), "no-such-economy-feed.json"));
  assert.equal(missing.feed, null);
  assert.match(makeEconomyBody(missing).body, /not been written yet/);
});

test("readFeed parses a written feed", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eco-")), "economy.json");
  fs.writeFileSync(file, JSON.stringify(feed()));
  assert.equal(readFeed(file).feed.latest, 520);
});

test("formatting", () => {
  assert.equal(fmt(30.24, "%"), "30.2%");
  assert.equal(fmt(3, "x"), "3.00x");
  assert.equal(fmt(999, ""), "no burn");
  assert.equal(bandText({ green: [48, 1e9], unit: "" }), "at least 48");
  assert.equal(bandText({ green: [0, 3], amber: [0, 8], unit: "" }), "at most 3.00");
  assert.equal(bandText({ green: [4, 15], unit: "%" }), "4.0% to 15.0%");
});
