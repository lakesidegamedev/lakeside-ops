"use strict";
// Keir 10.1.13 (owner, 2026-11-17): no alerts or player posts about a ticket that is already over.
const test = require("node:test");
const assert = require("node:assert");
const { setup } = require("./keir10-post.helpers");
const { assess, createTicketWatch, LIMITS } = require("../lib/operator/ticketwatch");
const { endedReason, closeTicketJobs } = require("../lib/operator/ticketstate");
const { createSweeper } = require("../lib/operator/sweeper");

const H = 3600000;
const ticket = (n, extra = {}) => ({ number: n, title: `Ticket ${n}`, status: "open", category: "bug", createdAt: new Date(0).toISOString(), ...extra });
const fakeLedger = (data) => { const outbox = {}; return { data, outbox, notify: (k, dest, c) => { outbox[k] = { dest, c }; }, audit: () => {}, save: () => {} }; };
const staleJob = () => ({ id: "j", ticket: 1838, kind: "ticket", state: "waiting", observedPlayerAt: 1 * H, lastPublishedAt: 2 * H, resolutionReadyAt: 2 * H, activationAt: [] });

test("1838: the support record says resolved, so the watch drops the alert and stops Keir's jobs", async () => {
  const ledger = fakeLedger({ jobs: { j: staleJob() }, seen: { "ticket:1838": "j" }, decisions: {}, channels: {} });
  const mcp = { call: async (_s, tool) => (tool === "support_list" ? { items: [ticket(1838)] } : { status: "resolved", conversation: {} }) };
  const w = createTicketWatch({ ledger, mcp, config: { staffIds: [] }, now: () => 20 * H, limits: LIMITS });
  assert.equal((await w.tick()).alerts, 0);
  assert.equal(Object.keys(ledger.outbox).length, 0, "no DM");
  assert.equal(ledger.data.jobs.j.state, "done", "jobs stop");
});

test("an open ticket with a readable open record still alerts", async () => {
  const ledger = fakeLedger({ jobs: { j: staleJob() }, seen: { "ticket:1838": "j" }, decisions: {}, channels: {} });
  const mcp = { call: async (_s, tool) => (tool === "support_list" ? { items: [ticket(1838)] } : { status: "open", conversation: {} }) };
  const w = createTicketWatch({ ledger, mcp, config: { staffIds: [] }, now: () => 20 * H, limits: LIMITS });
  assert.equal((await w.tick()).alerts, 1);
});

test("a ticket whose channel was deleted outside Keir counts as resolved: jobs close, no alert", async () => {
  const job = { ...staleJob(), state: "done", channelClosed: true };
  const ledger = fakeLedger({ jobs: { j: job, k: { id: "k", ticket: 1838, kind: "ticket", state: "waiting", codingParent: "j" } }, seen: { "ticket:1838": "j" }, decisions: {}, channels: {} });
  assert.equal(endedReason(ledger.data, 1838), "channel closed");
  const mcp = { call: async (_s, tool) => (tool === "support_list" ? { items: [ticket(1838)] } : { status: "open", conversation: {} }) };
  const w = createTicketWatch({ ledger, mcp, config: { staffIds: [] }, now: () => 20 * H, limits: LIMITS });
  assert.equal((await w.tick()).alerts, 0);
  closeTicketJobs(ledger, 1838, "channel closed", { channelGone: true });
  assert.equal(ledger.data.jobs.k.state, "done");
  assert.equal(ledger.data.jobs.k.channelClosed, true);
});

test("a running job is left to finish its turn when its ticket ends", () => {
  const ledger = fakeLedger({ jobs: { a: { id: "a", ticket: 5, state: "running" }, b: { id: "b", ticket: 5, state: "queued", inbox: [1] } } });
  closeTicketJobs(ledger, 5, "resolved", { skipRunning: true });
  assert.equal(ledger.data.jobs.a.state, "running");
  assert.equal(ledger.data.jobs.b.state, "done");
});

test("1842: an answered ticket waiting on the auto-closer's quiet clock is not reported as spinning", () => {
  const d = { jobs: { j: { id: "j", state: "waiting", observedPlayerAt: 1 * H, lastPublishedAt: 2 * H, activationAt: [3, 4, 5, 6, 7].map((h) => h * H) } }, seen: { "ticket:1842": "j" }, decisions: {} };
  assert.ok(!assess(d, ticket(1842, { number: 1842 }), 8 * H).some((x) => x.kind === "spinning"));
  d.jobs.j.lastPublishedAt = 0; d.jobs.j.activationAt = [3, 4, 5, 6, 7].map((h) => h * H);
  assert.ok(assess(d, ticket(1842), 8 * H).some((x) => x.kind === "spinning"), "an unanswered ticket still is");
});

test("the sweeper treats a ticket whose channel is gone or support record is closed as closed", () => {
  const d = { jobs: { j: { id: "j", ticket: 9, kind: "ticket", state: "waiting", at: 0 } }, seen: { "ticket:9": "j" }, decisions: {}, ticketOutcomes: { x: { ticket: 9, status: "resolved" } } };
  const ledger = fakeLedger(d);
  const s = createSweeper({ ledger, config: {}, now: () => 30 * H });
  assert.equal(s.snapshot(9, [d.jobs.j], 30 * H).open, false);
  d.ticketOutcomes = {}; d.jobs.j.channelClosed = true;
  assert.equal(s.snapshot(9, [d.jobs.j], 30 * H).open, false);
});

test("1842: after the ticket is resolved, no player post goes out", async () => {
  const f = setup();
  f.job.resolutionSubmitted = true;
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I haven't got a confirmed answer for you yet. I'm still working on it." }), /has ended/);
  assert.equal(f.posts().length, 0);
});

test("a ticket closed by the support service blocks Keir's posts and handoff DMs", async () => {
  const f = setup();
  f.ledger.data.ticketOutcomes = { o: { ticket: 123, status: "closed" } };
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "Checking the plant for you now." }), /has ended/);
  assert.equal(f.posts().length, 0);
});

test("resolving a ticket stops the other Keir jobs on it", async () => {
  const f = setup();
  const sib = f.ledger.createJob("s", { role: "support", kind: "ticket", ticket: 123, deadline: 9e15 });
  sib.state = "waiting";
  closeTicketJobs(f.ledger, 123, "resolved", { except: f.job });
  assert.equal(sib.state, "done");
  assert.equal(f.job.state, "running");
});
