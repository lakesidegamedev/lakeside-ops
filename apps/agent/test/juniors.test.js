"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createJuniorRoster } = require("../lib/operator/juniors");
const authority = require("../lib/operator/authority");
const { createPrincipals } = require("../lib/operator/principals");

const ROLE = "900000000000000001";
const member = (id, roles = [ROLE], bot = false) => ({ user: { id, bot }, roles });
const config = () => ({ ownerId: "111111111111111111", botId: "333333333333333333", guildId: "444444444444444444", staffIds: ["222222222222222222"], juniorRoleId: ROLE });

test("junior developers come from the Discord role and join staff after the delegate", async () => {
  const c = config(), staff = c.staffIds;
  const rows = [member("555555555555555551"), member("555555555555555552", ["1"]), member("555555555555555553", [ROLE], true), member(c.ownerId), member("222222222222222222")];
  const roster = createJuniorRoster({ config: c, discord: async () => rows });
  await roster.refresh();
  assert.equal(c.staffIds, staff, "rebuilt in place for modules holding the array");
  assert.deepEqual(c.staffIds, ["222222222222222222", "555555555555555551"]);
  assert.deepEqual(c.juniorIds, ["555555555555555551"]);
  // The delegate is unchanged, so a junior can neither grant ticket authority nor sign off on the owner's behalf.
  assert.equal(authority.granter(c, "555555555555555551"), false);
  assert.deepEqual(createPrincipals(c).rolesOf("555555555555555551"), ["developer"]);
  rows.length = 0;
  await roster.refresh();
  assert.deepEqual(c.staffIds, ["222222222222222222"]);
});

test("an unreadable member list keeps the last good roster", async () => {
  const c = config();
  let rows = [member("555555555555555551")];
  const roster = createJuniorRoster({ config: c, discord: async () => rows });
  await roster.refresh();
  rows = { message: "Missing Access" };
  await assert.rejects(roster.refresh(), /unreadable/);
  assert.deepEqual(c.staffIds, ["222222222222222222", "555555555555555551"]);
});

test("member pages are followed until the last short page", async () => {
  const c = config(), seen = [];
  const first = Array.from({ length: 1000 }, (_, i) => member(String(600000000000000000n + BigInt(i)), i === 5 ? [ROLE] : []));
  const roster = createJuniorRoster({ config: c, discord: async (_m, url) => { seen.push(url); return seen.length === 1 ? first : [member("700000000000000001")]; } });
  await roster.refresh();
  assert.match(seen[1], /after=600000000000000999/);
  assert.deepEqual(c.juniorIds, ["600000000000000005", "700000000000000001"]);
});
