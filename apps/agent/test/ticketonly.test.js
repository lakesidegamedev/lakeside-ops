"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isPrivateReporterRead, supportsTicketOnly, narrowedArgs } = require("../lib/operator/ticketonly");

const newer = [{ name: "support_public_update", inputSchema: { properties: { message: {}, ticket_only: {} } } }];
const older = [{ name: "support_public_update", inputSchema: { properties: { message: {} } } }];

test("only the two private reporter reads mark a ticket", () => {
  assert.equal(isPrivateReporterRead("gamestate", "reporter_operating_results"), true);
  assert.equal(isPrivateReporterRead("gamestate", "reporter_action_points"), true);
  assert.equal(isPrivateReporterRead("gamestate", "market_history"), false);
  assert.equal(isPrivateReporterRead("ops-knowledge", "reporter_action_points"), false);
});

test("narrowing is added when the server advertises it and fails closed when it does not", () => {
  assert.equal(supportsTicketOnly(newer), true);
  assert.deepEqual(narrowedArgs({ message: "m" }, newer), { message: "m", ticket_only: true });
  assert.equal(supportsTicketOnly(older), false);
  assert.equal(supportsTicketOnly([]), false);
  assert.throws(() => narrowedArgs({ message: "m" }, older), /not sent/);
});
