"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { rawReadArgs } = require("../lib/operator/broker");

test("raw game-record reads are forced to prod and capped", () => {
  const a = rawReadArgs("heal_query", { env: "dev", collection: "corporations", filter: { name: "X" }, limit: 500 });
  assert.deepStrictEqual(a, { env: "prod", collection: "corporations", filter: { name: "X" }, limit: 50 });
  assert.deepStrictEqual(rawReadArgs("heal_count", { collection: "financialTxLog", filter: {} }), { env: "prod", collection: "financialTxLog", filter: {} });
  assert.deepStrictEqual(rawReadArgs("heal_collections", { env: "dev" }), { env: "prod" });
});

test("account, ticket and credential collections stay closed", () => {
  for (const c of ["users", "sessions", "tickets", "ticketMessages", "apiKeys", "authTokens", "payments", "actionAuditLog", "discordLinks", "keirLedger", ""])
    assert.throws(() => rawReadArgs("heal_query", { collection: c }), /closed|game records/);
});

test("contact and credential fields cannot be filtered or projected", () => {
  assert.throws(() => rawReadArgs("heal_query", { collection: "characters", projection: { email: 1 } }), /closed/);
  assert.throws(() => rawReadArgs("heal_query", { collection: "characters", filter: { $or: [{ discordId: "1" }] } }), /closed/);
  assert.ok(rawReadArgs("heal_query", { collection: "characters", filter: { sequentialId: 35 }, projection: { name: 1, cash: 1 } }));
});

test("delegate escalation is for game issues, never owner-started development", () => {
  const { ownerInitiated } = require("../lib/operator/decisions");
  const config = { ownerId: "1" };
  const d = { jobs: {} };
  assert.equal(ownerInitiated(d, config, { kind: "command", actorId: "1", source: { authorId: "1" } }), true);
  assert.equal(ownerInitiated(d, config, { kind: "command", actorId: "1", ticket: 1575 }), false);
  assert.equal(ownerInitiated(d, config, { kind: "finding" }), false);
  assert.equal(ownerInitiated(d, config, { kind: "ticket", ticket: 12 }), false);
});

test("internal finish notes are never posted as replies", () => {
  const { META_SUMMARY } = require("../lib/operator/broker");
  for (const t of ["Banter already answered in the source channel with the fully costed jokes reply; subsequent GIF exchange also completed. No further post needed.",
    "Nothing further to post.", "The player was told the fix is live."]) assert.ok(META_SUMMARY.test(t), t);
  for (const t of ["Steel demand is counted correctly again from turn 227.", "Your allowance comes back on turn 291."]) assert.ok(!META_SUMMARY.test(t), t);
});

test("raw reads refuse server-side script and redact closed fields from results", () => {
  const { rawReadArgs, redactRaw } = require("../lib/operator/broker");
  assert.throws(() => rawReadArgs("heal_query", { collection: "corporations", filter: { $where: "sleep(1000)" } }), /script operators/);
  assert.throws(() => rawReadArgs("heal_query", { collection: "corporations", filter: { $or: [{ $function: {} }] } }), /script operators/);
  assert.doesNotThrow(() => rawReadArgs("heal_query", { collection: "corporations", filter: { $expr: { $eq: [{ $toString: "$_id" }, "x"] } } }));
  assert.deepEqual(redactRaw({ docs: [{ name: "Acme", ownerEmail: "a@b", nested: { sessionId: "s", cash: 5 } }] }), { docs: [{ name: "Acme", nested: { cash: 5 } }] });
});

test("extended JSON id filters are translated into id-string comparisons", () => {
  // The model writes ObjectId values the way the driver prints them, as
  // {"$oid": hex}. The query transport sends plain JSON, and Mongo refuses it:
  // "unknown operator: $oid" alone, "cannot nest $ under $in" inside an array.
  // Unwrapping to a bare string would silently match nothing against an
  // ObjectId field, so compare the string form instead.
  const a = "64b00000000000000000000a", b = "64b00000000000000000000b";
  assert.deepStrictEqual(
    rawReadArgs("heal_query", { collection: "corporations", filter: { _id: { $oid: a } }, projection: { name: 1 } }),
    { env: "prod", collection: "corporations", filter: { $expr: { $eq: [{ $toString: "$_id" }, a] } }, limit: 25, projection: { name: 1 } });
  assert.deepStrictEqual(
    rawReadArgs("heal_query", { collection: "indexFundRedemptionQueue", filter: { fundId: { $in: [{ $oid: a }, b] }, status: { $in: ["queued"] } } }),
    { env: "prod", collection: "indexFundRedemptionQueue", filter: { $and: [{ status: { $in: ["queued"] } }, { $expr: { $in: [{ $toString: "$fundId" }, [a, b]] } }] }, limit: 25 });
  assert.deepStrictEqual(
    rawReadArgs("heal_count", { collection: "bonds", filter: { $or: [{ corporationId: { $oid: a } }, { corporationId: { $in: [{ $oid: b }] } }] } }),
    { env: "prod", collection: "bonds", filter: { $or: [
      { $expr: { $eq: [{ $toString: "$corporationId" }, a] } },
      { $expr: { $in: [{ $toString: "$corporationId" }, [b]] } },
    ] } });
});

test("closed contact fields do not swallow game fields that merely contain the same letters", () => {
  const { rawReadArgs, redactRaw } = require("../lib/operator/broker");
  assert.doesNotThrow(() => rawReadArgs("heal_query", { collection: "corporations", filter: { ownership: { $gt: 0 } }, projection: { membership: 1, leadership: 1, totalShares: 1 } }));
  assert.deepEqual(redactRaw({ ownership: 1.35, membership: 2, ip: "1.2.3.4", ipAddress: "x", address: "y", passwordHash: "z" }), { ownership: 1.35, membership: 2 });
  for (const field of ["email", "discordId", "sessionToken", "phone", "lastIp"]) assert.throws(() => rawReadArgs("heal_query", { collection: "characters", filter: { [field]: "x" } }), /closed/);
});
