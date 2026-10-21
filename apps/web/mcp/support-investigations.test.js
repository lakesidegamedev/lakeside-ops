"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditCandidates, investigationSummary, staffOverwrites, pairCases, hasModNotes, scan, registerInvestigations } = require("./support-investigations");
const NOW = new Date("2026-10-19T12:00:00Z");
const A = "aaaaaaaaaaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbbbbbbbbbb", CA = "cccccccccccccccccccccccc", CB = "dddddddddddddddddddddddd";
const CANARY = "198.51.100.42 2001:db8::42 sensitive@example.invalid COOKIE_SECRET_SENTINEL FINGERPRINT_SECRET_SENTINEL";
const flag = (type, severity = "high") => ({ type, severity, detail: CANARY, detectedAt: NOW });
function accountFixture(userId = A, characterId = CA, otherUserId = B) {
  return { _id: characterId, characterId, userId, characterName: CANARY, flags: [
    { ...flag("shared_tracking_cookie"), evidence: { trackingId: "COOKIE_SECRET_SENTINEL", sharedWith: [{ userId: otherUserId }] } },
    { ...flag("coordinated_login_pattern"), evidence: { overlapWindowMinutes: 15, matches: [{ otherUserId, otherUsername: "sensitive@example.invalid", dayCount: 2, overlapCount: 4, sharedTrackingIds: ["COOKIE_SECRET_SENTINEL"] }] } },
  ] };
}
function directory() {
  return new Map([[A, { userId: A, characterId: CA, sequentialId: 101 }], [B, { userId: B, characterId: CB, sequentialId: 102 }]]);
}
function candidate() {
  return pairCases(auditCandidates([accountFixture()], [], NOW), directory())[0];
}
test("shared cookie and coordinated login for the same pair qualify without funding or additional thresholds", () => {
  const c = auditCandidates([accountFixture()], [], NOW)[0];
  assert.equal(c.needsReview, true);
  assert.equal(c.reviewBasis.kind, "shared_cookie_coordinated_login");
  assert.deepEqual(c.reviewBasis.relatedUserIds, [B]);
  assert.equal(JSON.stringify(c.reviewBasis).includes("COOKIE_SECRET_SENTINEL"), false);
  for (const type of ["shared_tracking_cookie", "coordinated_login_pattern"]) {
    const a = accountFixture(); a.flags = a.flags.filter(f => f.type !== type);
    assert.equal(auditCandidates([a], [], NOW)[0].needsReview, false);
  }
});
test("IP/fingerprint combinations and financial severity cannot substitute for the two requested signals", () => {
  const a = accountFixture(); a.flags = [flag("ip_sharing"), flag("shared_fingerprint")];
  assert.equal(auditCandidates([a], [], NOW)[0].needsReview, false);
  const txs = ["cash_mismatch", "velocity", "time_velocity", "large_transaction", "round_trip", "wash_trade", "same_price_wash"].map(type => ({ _id: type, subjectId: CA, subjectType: "character", type: "index_fund_dividend", suspectFlags: [flag(type)] }));
  assert.equal(auditCandidates([], txs, NOW)[0].needsReview, false);
});
test("mismatched pairs, stale or suppressed signals and dismissed accounts do not qualify", () => {
  for (const change of [
    a => { a.flags[1].evidence.matches[0].otherUserId = "eeeeeeeeeeeeeeeeeeeeeeee"; },
    a => { a.flags[0].detectedAt = "2026-09-01"; },
    a => { a.suppressedFlags = [{ type: "coordinated_login_pattern", suppressedUntil: "2026-10-20" }]; },
  ]) {
    const a = accountFixture(); change(a); assert.equal(auditCandidates([a], [], NOW)[0].needsReview, false);
  }
  assert.equal(auditCandidates([{ ...accountFixture(), dismissed: true }], [], NOW).length, 0);
});
test("mod note detection handles legacy and structured notes without interpreting their contents", () => {
  for (const u of [{ modNote: "known household" }, { modNotes: [{ text: "reviewed" }] }, { modNotes: [{}] }, { modNotes: {} }]) assert.equal(hasModNotes(u), true);
  for (const u of [{}, { modNote: "   ", modNotes: [] }, { modNotes: null }]) assert.equal(hasModNotes(u), false);
});
test("reciprocal observations become one case; a note on either account prevents the case", () => {
  const observations = auditCandidates([accountFixture(), accountFixture(B, CB, A)], [], NOW);
  let cases = pairCases(observations, directory());
  assert.equal(cases.length, 1); assert.equal(cases[0].key, `pair:${A}:${B}`);
  assert.equal(cases[0].accounts.length, 2);
  for (const userId of [A, B]) {
    const dir = directory(); dir.get(userId).hasModNotes = true;
    assert.equal(pairCases(observations, dir).length, 0);
  }
});
test("the summary whitelists account links and aggregate facts and never copies sensitive detector text", () => {
  const c = candidate(); c.subject = CANARY; c.reviewReason = CANARY; c.transactions = [{ secret: CANARY }];
  const text = investigationSummary(c, NOW);
  assert.match(text, /\/character\/101/); assert.match(text, /\/character\/102/);
  assert.match(text, /4 near-simultaneous login overlaps/); assert.match(text, /2 distinct days/);
  assert.match(text, /not a finding of misconduct/);
  for (const secret of CANARY.split(" ")) assert.equal(text.includes(secret), false, secret);
  assert.throws(() => investigationSummary({ ...c, accounts: [{ characterId: "https://evil.invalid" }, c.accounts[1]] }, NOW), /profile links/);
});
function dbFixture(users) {
  const data = {
    gameState: [{ currentTurn: 311 }],
    characters: [{ _id: CA, userId: A, sequentialId: 101 }, { _id: CB, userId: B, sequentialId: 102 }],
    corporations: [], users, suspiciousCharacters: [accountFixture(), accountFixture(B, CB, A)], financialTxLog: [],
  };
  return { collection(name) { return {
    findOne: async () => data[name]?.[0],
    find: () => ({ sort() { return this; }, limit() { return this; }, toArray: async () => data[name] || [] }),
  }; } };
}
test("the real scan excludes legacy/structured notes on either participant, without exporting note contents", async () => {
  assert.equal((await scan(dbFixture([{ _id: A }, { _id: B }]), NOW)).candidates.filter(c => c.needsReview).length, 1);
  for (const userId of [A, B]) for (const note of [{ modNote: "CONFIDENTIAL MOD NOTE" }, { modNotes: [{ text: "CONFIDENTIAL MOD NOTE" }] }]) {
    const users = [{ _id: A }, { _id: B }].map(u => u._id === userId ? { ...u, ...note } : u);
    const result = await scan(dbFixture(users), NOW);
    assert.equal(result.candidates.filter(c => c.needsReview).length, 0);
    assert.equal(JSON.stringify(result).includes("CONFIDENTIAL MOD NOTE"), false);
  }
});
test("investigation ACL permits only developer/moderator roles and the bot", () => {
  const acl = staffOverwrites("111111111111111111", "222222222222222222", ["333333333333333333", "444444444444444444"]);
  assert.deepEqual(acl.map(x => x.id), ["111111111111111111", "333333333333333333", "444444444444444444", "222222222222222222"]);
  assert.equal(acl[0].deny, "1024");
  assert.throws(() => staffOverwrites("111111111111111111", "222222222222222222", [undefined, undefined]));
});
test("filing pings only dev/mod roles, verifies ACL, sends safe facts and links, and deduplicates pair cases", async () => {
  const oldFetch = global.fetch, keys = ["DISCORD_DEVELOPER_ROLE_ID", "DISCORD_MODERATOR_ROLE_ID", "DISCORD_BOT_API_KEY"], env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { DISCORD_DEVELOPER_ROLE_ID: "333333333333333333", DISCORD_MODERATOR_ROLE_ID: "444444444444444444", DISCORD_BOT_API_KEY: "test" });
  const calls = [], handlers = {}, c = candidate(); let acl, invalidAcl = false, existing = null, noted = false;
  const chain = new Proxy({}, { get: () => () => chain });
  const discordImpl = async (path, init = {}) => {
    calls.push({ path, ...init });
    if (path === "/users/@me") return { id: "222222222222222222", username: "Keir" };
    if (path.endsWith("/roles")) return [{ id: process.env.DISCORD_DEVELOPER_ROLE_ID }, { id: process.env.DISCORD_MODERATOR_ROLE_ID }];
    if (path.endsWith("/channels") && !init.method) return [];
    if (path.endsWith("/channels") && init.method === "POST") { acl = JSON.parse(init.body).permission_overwrites; return { id: "channel" }; }
    if (path === "/channels/channel") return { id: "channel", permission_overwrites: invalidAcl ? [] : acl };
    if (path.endsWith("/messages")) return { id: "message" };
    throw Error(path);
  };
  global.fetch = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(url.includes("capabilities=1") ? { investigationIntake: true } : url.endsWith("/reserve") ? { ticketNumber: 42 } : { ok: true }), { status: 200 });
  };
  registerInvestigations({ tool: (name, description, schema, fn) => { handlers[name] = fn; } }, {
    auth: { scopes: { write: true } }, db: { collection: () => ({ findOne: async () => existing, updateOne: async () => ({ matchedCount: 1 }) }) },
    z: { string: () => chain }, jsonResult: x => x, errorResult: error => ({ error }), discordImpl,
    scanImpl: async () => ({ at: NOW.toISOString(), candidates: noted ? [] : [c] }),
  });
  try {
    let result = await handlers.support_create_investigation({ key: c.key }); assert.equal(result.staffOnly, true);
    const registration = calls.find(x => x.url?.endsWith("/tickets"));
    assert.equal(registration.body.investigationKey, `pair:${A}:${B}`); assert.equal(registration.body.discordUserId, "222222222222222222");
    const message = JSON.parse(calls.find(x => x.path?.endsWith("/messages")).body);
    assert.deepEqual(message.allowed_mentions, { parse: [], roles: ["333333333333333333", "444444444444444444"] });
    assert.match(message.content, /<@&333333333333333333> <@&444444444444444444>/); assert.match(message.content, /\/character\/101/); assert.match(message.content, /\/character\/102/);
    for (const secret of CANARY.split(" ")) { assert.equal(message.content.includes(secret), false); assert.equal(JSON.stringify(registration.body).includes(secret), false); }
    assert.equal(calls.some(x => /public-link|\/t\//.test(x.url || x.path)), false);
    calls.length = 0; invalidAcl = true; result = await handlers.support_create_investigation({ key: c.key }); assert.match(result.error, /ACL verification failed/); assert.equal(calls.some(x => x.path?.endsWith("/messages")), false);
    calls.length = 0; invalidAcl = false; existing = { _id: "existing", ticketNumber: 42, discordChannelId: "channel" }; result = await handlers.support_create_investigation({ key: c.key }); assert.equal(result.duplicate, true); assert.equal(calls.some(x => x.url?.endsWith("/reserve")), false);
    calls.length = 0; noted = true; result = await handlers.support_create_investigation({ key: c.key }); assert.match(result.error, /No current candidate/); assert.equal(calls.length, 0);
  } finally { global.fetch = oldFetch; for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test("account links use owned active profiles and never another user's active-character pointer", async () => {
  const result = await scan(dbFixture([{ _id: A, activeCharacterId: CB }, { _id: B, activeCharacterId: CB }]), NOW);
  const c = result.candidates.find(c => c.needsReview);
  assert.equal(c.accounts.find(a => a.userId === A).characterId, CA);
  assert.equal(c.accounts.find(a => a.userId === B).characterId, CB);
  const text = investigationSummary(c, NOW);
  assert.match(text, /\/character\/101/); assert.match(text, /\/character\/102/);
});
