"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { mapSnapshotScopeCheck, nearCollections, TYPED_READS } = require("../lib/operator/broker");

test("map_snapshot country scope names the metrics that work", () => {
  assert.throws(() => mapSnapshotScopeCheck({ scope: "country", country: "US", metric: "parties" }), /party_org.*Country scope metrics: population/s);
  assert.throws(() => mapSnapshotScopeCheck({ scope: "country", country: "US", metric: "players" }), /geo_aggregate/);
  assert.doesNotThrow(() => mapSnapshotScopeCheck({ scope: "world", metric: "parties" }));
  assert.doesNotThrow(() => mapSnapshotScopeCheck({ scope: "country", country: "US", metric: "party_org" }));
});
test("a misspelt collection gets near names", () => {
  const names = ["partyBudget", "partyAgendas", "characters", "corporations"];
  assert.deepEqual(nearCollections("partyBudgets", names), ["partyBudget"]);
  assert.deepEqual(nearCollections("Characters", names), ["characters"]);
  assert.deepEqual(nearCollections("zzzzz", names), []);
});
test("typed reads point at tools that exist", () => {
  assert.match(TYPED_READS.corporations, /trace_corp/);
});
