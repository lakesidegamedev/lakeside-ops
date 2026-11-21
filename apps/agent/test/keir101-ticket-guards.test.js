"use strict";
// Keir 10.1 (owner, 2026-11-16): tickets 1833, 1834 and 1835 stalled because a lifecycle step depended on the
// model remembering a flag. These cover the deterministic guards that replace those flags.
const test = require("node:test");
const assert = require("node:assert");
const { setup } = require("./keir10-post.helpers");
const { outcomeClaims } = require("../lib/operator/broker");
const { assess, createTicketWatch, LIMITS } = require("../lib/operator/ticketwatch");

const H = 3600000;
const board = (ids) => async (_s, tool) => (tool === "kanban_add" ? { id: ids.shift() } : tool === "kanban_list" ? [] : { ok: true });
const DETAIL = "The player lost their old Discord account and the game blocks the new one as a second account from the same phone.";

test("1834: the player-facing wording that promised a developer check is recognised as an escalation claim", () => {
  const claim = (t) => outcomeClaims(t).filter((c) => c.kind === "escalated" && !c.future).length;
  assert.equal(claim("I passed your old Discord and character name to the developers for a recovery check."), 1);
  assert.equal(claim("The developers will check your account and reply here."), 1, "future tense does not excuse a promise of a person");
  assert.equal(claim("When the moderators reply I will update you."), 1);
  assert.equal(claim("I will pass this on to the developers."), 0, "saying you will pass it on is allowed");
  assert.equal(claim("Thanks, mobile data helps."), 0);
});

test("1834: an account action is never Keir's own to-do; it DMs the owner and counts as a real handoff", async () => {
  const f = setup({ call: board([700]) });
  const r = await f.broker.tool(f.job, "raise_to_developers", { kind: "question", title: "Old account recovery: relink login to the player's new Discord", detail: DETAIL, force: true });
  assert.equal(r.id, 700);
  const rec = f.job.raisedToDevelopers.find((x) => x.id === 700);
  assert.ok(!rec.selfOwned, "account actions need a person");
  assert.equal(rec.needsHuman, true);
  const dm = f.ledger.data.outbox["handoff:700"];
  assert.ok(dm, "the owner is told");
  assert.equal(dm.destination, "owner");
  assert.match(dm.content, /needs a person/);
});

test("1834: a self-owned card is not proof that the developers have it", async () => {
  const f = setup({ call: board([701]) });
  await f.broker.tool(f.job, "raise_to_developers", { kind: "question", title: "Why does the market chart skip a turn here", detail: "The chart reads the market history but one turn is missing from the stored series for this player.", force: true });
  assert.ok(f.job.raisedToDevelopers[0].selfOwned);
  assert.equal(f.ledger.data.outbox["handoff:701"], undefined, "Keir's own work items do not page anyone");
  f.playerWrote(5);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: "I passed this to the developers and they are looking at the chart now." }), /developers have it|reached them|a person can check/);
});

const ticket = (n, extra = {}) => ({ number: n, title: `Ticket ${n}`, status: "open", category: "bug", createdAt: new Date(0).toISOString(), ...extra });
const world = (job) => ({ jobs: job ? { j: { id: "j", state: "waiting", ...job } } : {}, seen: job ? { "ticket:1833": "j" } : {}, decisions: {} });

test("1833: repeated checks with nothing new are reported as spinning", () => {
  const now = 20 * H;
  const job = { observedPlayerAt: 1 * H, lastPublishedAt: 2 * H, activationAt: [3, 4, 5, 6, 7].map((h) => h * H) };
  const f = assess(world(job), ticket(1833), now);
  assert.ok(f.some((x) => x.kind === "spinning" && x.runs === 5));
  job.activationAt = [3, 4].map((h) => h * H);
  assert.ok(!assess(world(job), ticket(1833), now).some((x) => x.kind === "spinning"));
});

test("an answered ticket still open after 6 hours is silent; a question to the player gets 26 hours", () => {
  const job = { observedPlayerAt: 1 * H, lastPublishedAt: 2 * H, resolutionReadyAt: 2 * H, activationAt: [] };
  assert.ok(assess(world(job), ticket(1833), 9 * H).some((x) => x.kind === "silent"));
  delete job.resolutionReadyAt;
  assert.ok(!assess(world(job), ticket(1833), 9 * H).some((x) => x.kind === "silent"), "waiting on the player's answer is normal");
  assert.ok(assess(world(job), ticket(1833), 29 * H).some((x) => x.kind === "silent"));
});

test("a pending owner decision suppresses the silent alert; a player waiting 2 hours is reported", () => {
  const job = { observedPlayerAt: 1 * H, lastPublishedAt: 2 * H, resolutionReadyAt: 2 * H, activationAt: [], ownerDecisionPending: true };
  assert.equal(assess(world(job), ticket(1833), 30 * H).length, 0);
  const waiting = { observedPlayerAt: 5 * H, lastPublishedAt: 2 * H, activationAt: [] };
  const f = assess(world(waiting), ticket(1833), 8 * H);
  assert.ok(f.some((x) => x.kind === "waiting" && x.hours === 3));
});

test("1835: moderation tickets alert at once and again after 4 hours; unowned tickets after an hour", () => {
  const mod = ticket(1835, { category: "moderation", createdAt: new Date(0).toISOString() });
  assert.deepEqual(assess(world(), mod, 10 * 60000).map((x) => x.kind), ["moderation"]);
  assert.deepEqual(assess(world(), mod, 5 * H).map((x) => x.kind), ["moderation", "moderation-open"]);
  assert.equal(assess(world(), ticket(1840), 30 * 60000).length, 0);
  assert.deepEqual(assess(world(), ticket(1840), 2 * H).map((x) => x.kind), ["unowned"]);
  assert.equal(assess(world(), ticket(1841, { category: "incident" }), 9 * H).length, 0, "incidents belong to staff");
});

test("the watch sends one owner DM per sweep, copies moderation to delegates, and never repeats an alert", async () => {
  const outbox = {};
  const ledger = { data: { jobs: {}, seen: {}, decisions: {}, channels: {} }, notify: (k, dest, content) => { outbox[k] = { dest, content }; }, audit: () => {}, save: () => {} };
  const open = [ticket(1835, { category: "moderation" }), ticket(1840)];
  const mcp = { call: async (_s, tool, args) => tool === "support_list" ? { items: open } : { description: args.number === 1835 ? "I'd like to request VPN access" : "", conversation: { channelId: "c" } } };
  let t = 3 * H;
  const w = createTicketWatch({ ledger, mcp, config: { staffIds: ["s1"] }, now: () => t, limits: LIMITS });
  const r = await w.tick();
  assert.equal(r.alerts, 2);
  const keys = Object.keys(outbox);
  assert.equal(keys.filter((k) => outbox[k].dest === "owner").length, 1);
  assert.equal(keys.filter((k) => outbox[k].dest === "s1").length, 1);
  assert.match(outbox[keys.find((k) => outbox[k].dest === "owner")].content, /VPN access/);
  assert.doesNotMatch(outbox[keys.find((k) => outbox[k].dest === "s1")].content, /1840/, "delegates only get moderation items");
  t += 5 * 60000;
  assert.equal((await w.tick()).alerts, 0, "nothing new, nothing sent");
  ledger.data.channels.c = { claimedBy: "s1" };
  open.length = 0;
  await w.tick();
  assert.deepEqual(ledger.data.ticketWatch.alerted, {}, "closed tickets are forgotten so a reopen alerts again");
});

test("a staff-claimed ticket with no Keir task is not reported as unowned", async () => {
  const outbox = {};
  const ledger = { data: { jobs: {}, seen: {}, decisions: {}, channels: { c: { claimedBy: "s1" } } }, notify: (k, d, c) => { outbox[k] = c; }, audit: () => {}, save: () => {} };
  const mcp = { call: async (_s, tool) => tool === "support_list" ? { items: [ticket(1842)] } : { conversation: { channelId: "c" } } };
  const w = createTicketWatch({ ledger, mcp, config: { staffIds: [] }, now: () => 3 * H });
  assert.equal((await w.tick()).alerts, 0);
  assert.equal(Object.keys(outbox).length, 0);
});

test("the watch does nothing while Keir is paused", async () => {
  const ledger = { data: { paused: true }, notify: () => assert.fail("no alerts while paused"), audit: () => {}, save: () => {} };
  const w = createTicketWatch({ ledger, mcp: { call: async () => assert.fail("no reads while paused") }, config: {} });
  assert.deepEqual(await w.tick(), { skipped: "paused" });
});

const { sweepOrphans } = require("../lib/operator/orphans");
test("orphaned actions and decisions move to the archive; anything pending or recent stays", () => {
  const D = 86400000, now = 30 * D;
  const data = {
    jobs: { live: { id: "live", state: "waiting" } },
    actions: {
      a1: { id: "a1", jobId: "gone", state: "done", at: 1 * D },
      a2: { id: "a2", jobId: "gone", state: "approved", at: 1 * D },
      a3: { id: "a3", jobId: "gone", state: "pending", at: 1 * D },
      a4: { id: "a4", jobId: "gone", state: "done", at: 28 * D },
      a5: { id: "a5", jobId: "live", state: "done", at: 1 * D },
    },
    decisions: {
      d1: { id: "d1", jobId: "gone", state: "approve", at: 1 * D },
      d2: { id: "d2", jobId: "gone", state: "pending", at: 1 * D, actionId: "a1" },
    },
  };
  const out = sweepOrphans(data, now);
  assert.deepEqual(out.map((r) => `${r.type}:${r.id}`).sort(), ["action:a2", "decision:d1"]);
  assert.equal(out.find((r) => r.id === "a2").state, "orphaned", "an approved action is never left runnable");
  assert.deepEqual(Object.keys(data.actions).sort(), ["a1", "a3", "a4", "a5"], "a pending decision keeps its action");
  assert.deepEqual(Object.keys(data.decisions), ["d2"]);
});

test("a lookup about Canada elections does not back a claim that Canada has no Senate", async () => {
  const f = setup({ call: async (_s, tool, args) => {
    if (tool === "code_search") return { hits: args.question === "Canadian Senate"
      ? [{ path: "src/lib/countries/ca/institutionsFacts.ts", text: 'name: "Canada", legislature: { bicameral: false, upperChamber: { name: "Senate", seats: 105 } }' }]
      : [{ path: "src/app/api/discord-bot/elections/route.ts", text: "Returns Canada elections when the country filter is CA." }] };
    return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } };
  } });
  f.playerWrote(5);
  const read = (question) => f.broker.tool(f.job, "read_tool", {
    server: "ops-knowledge", tool: "code_search", args: { question, source: "prod" },
  });
  await read("Canada elections in the bot");
  const message = "No, Canada has no Senate in the game yet. It has not been built, and whether it comes at all has not been decided.";
  const draft = await f.broker.tool(f.job, "check_draft", { message });
  assert.match(JSON.stringify(draft), /read the institution configuration/i);
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message }), /read the institution configuration/i);
  assert.equal(f.posts().length, 0);
  await read("Canadian Senate");
  await assert.rejects(f.broker.tool(f.job, "channel_reply", { message }), /code has a chamber with this name/);
  const answer = "Canada has a 105-seat appointed Senate. Bills are handled through the Commons.";
  await f.broker.tool(f.job, "channel_reply", { message: answer });
  assert.deepEqual(f.posts(), [answer]);
});
