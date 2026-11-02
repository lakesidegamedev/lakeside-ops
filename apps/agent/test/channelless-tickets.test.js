"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { closeIfTicketClosed } = require("../lib/operator/channellesstickets");

test("a channel-less ticket task ends when the support record says the ticket is closed (ticket 1730)", async () => {
  const job = { ticket: 1730, channelId: null, state: "waiting" };
  assert.equal(await closeIfTicketClosed(job, async () => ({ status: "closed" })), true);
  assert.equal(job.state, "done");
  assert.equal(job.channelClosed, true);
});

test("an open, unreadable or channel-backed ticket is left alone", async () => {
  const open = { ticket: 7, channelId: null, state: "waiting" };
  assert.equal(await closeIfTicketClosed(open, async () => ({ status: "in_progress" })), false);
  assert.equal(open.state, "waiting");
  const unreadable = { ticket: 8, channelId: null, state: "waiting" };
  assert.equal(await closeIfTicketClosed(unreadable, async () => { throw new Error("support down"); }), false);
  assert.equal(unreadable.state, "waiting");
  let read = false;
  const withChannel = { ticket: 9, channelId: "123", state: "waiting" };
  assert.equal(await closeIfTicketClosed(withChannel, async () => { read = true; return { status: "closed" }; }), false);
  assert.equal(read, false, "the Discord 404 path owns tickets that have a channel");
});

test("the sweep finds a live task already on a channel, so it does not adopt the ticket twice (ticket 1757)", () => {
  const { liveTaskForChannel } = require("../lib/operator/channellesstickets");
  const jobs = { a: { id: "a", kind: "ticket", channelId: "c1", state: "queued" }, b: { id: "b", kind: "ticket", channelId: "c2", state: "done" } };
  assert.equal(liveTaskForChannel(jobs, "c1").id, "a");
  assert.equal(liveTaskForChannel(jobs, "c2"), null, "a finished task does not hold the channel");
  assert.equal(liveTaskForChannel(jobs, null), null);
});
