"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createResolver, characterIdFrom, visitedCharacter } = require("../lib/operator/resolvereporter");

function fakeMcp({ ticket, users = [], characters = [], retired = [] }) {
  const calls = [];
  return { calls, call: async (server, tool, args) => {
    calls.push({ server, tool, args });
    if (server === "support") return ticket;
    const f = args.filter;
    if (args.collection === "users") {
      const hit = users.filter((u) => (f.username && u.username === f.username) || (f.discordId && u.discordId === f.discordId) || (f._id && u._id === f._id.$oid));
      return { docs: hit.map((u) => Object.fromEntries(Object.keys(args.projection).filter((k) => k in u).map((k) => [k, u[k]]))) };
    }
    if (args.collection === "characters") return { docs: f.sequentialId ? characters.filter((c) => c.sequentialId === f.sequentialId) : characters.filter((c) => c.userId === f.$expr.$eq[1]) };
    if (args.collection === "retiredCharacters") return { docs: retired.filter((r) => r.userId === f.$expr.$eq[1]) };
    return { docs: [] };
  } };
}
const USER = { _id: "u1", username: "synthuser", discordId: "900000000000001" };
const CHAR = { sequentialId: 77, name: "Test Person", countryId: "US", homeState: "OH", currentOffice: "Senator", userId: "u1" };

test("an unlinked reporter is found through the linked Discord account", async () => {
  const mcp = fakeMcp({ ticket: { reporter: {} }, users: [USER], characters: [CHAR], retired: [{ userId: "u1", retiredAt: "2026-10-04T10:00:00Z", reason: "game_reset", snapshot: { name: "Old Name", countryId: "DD" } }] });
  const job = { ticket: 1, source: { authorId: "900000000000001" } };
  const r = createResolver({ mcp });
  const out = await r.resolve(job);
  assert.equal(out.matched, true);
  assert.equal(r.present(out).current[0].name, "Test Person");
  assert.equal(r.present(out).retired[0].name, "Old Name");
  assert.deepEqual(out.via.map((v) => v.method), ["linked Discord account"]);
  assert.equal(job.reporterCharacter.id, "77", "one current character becomes the reporter for player reads");
});

test("the model never sees the account id or the Discord id", async () => {
  const r = createResolver({ mcp: fakeMcp({ ticket: { reporter: { username: "synthuser" } }, users: [USER], characters: [CHAR] }) });
  const shown = JSON.stringify(r.present(await r.resolve({ ticket: 1, source: { authorId: "900000000000001" } })));
  assert.ok(!shown.includes("u1\"") && !shown.includes("900000000000001") && !/private/.test(shown));
  assert.ok(shown.includes("game username on the ticket"));
});

test("two different accounts are reported as ambiguous, not guessed", async () => {
  const other = { _id: "u2", username: "synthuser", discordId: "900000000000002" };
  const mcp = fakeMcp({ ticket: { reporter: { username: "synthuser" } }, users: [{ ...USER, username: "other" }, other] });
  const r = createResolver({ mcp });
  const out = await r.resolve({ ticket: 1, source: { authorId: "900000000000001" } });
  assert.equal(out.matched, false); assert.equal(out.ambiguous, true);
  assert.match(r.present(out).instruction, /different accounts/);
});

test("nothing matches: says so, asks for nothing it can read", async () => {
  const r = createResolver({ mcp: fakeMcp({ ticket: { reporter: {} } }) });
  const out = await r.resolve({ ticket: 1, source: { authorId: "123" } });
  assert.equal(out.matched, false);
});

test("a hostile username never reaches a query filter", async () => {
  const mcp = fakeMcp({ ticket: { reporter: { username: "x\" } , $where" } } });
  await createResolver({ mcp }).resolve({ ticket: 1, source: { authorId: "1" } });
  assert.ok(!mcp.calls.some((c) => c.args?.filter?.username));
});

test("helpers parse profile links and repeated visits", () => {
  assert.equal(characterIdFrom("https://www.ahousedividedgame.com/character/12"), "12");
  assert.equal(characterIdFrom("https://evil.example/character/12"), null);
  assert.equal(visitedCharacter({ supportRecentVisits: [{ path: "/character/5" }, { path: "/character/5/x" }, { path: "/character/9" }] }), "5");
  assert.equal(visitedCharacter({ supportRecentVisits: [{ path: "/character/5" }] }), null);
});
