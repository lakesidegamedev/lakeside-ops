"use strict";
// Keir 11.4: the owner's private app chat (the supervisor in the ops web app) hands ticket commands to this operator over
// /api/keir/app/ticket-commands, signed in with the owner's own session. One implementation decides: ticket_command's run().
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const controls = require("../lib/operator/controls");
const { createAppServer } = require("../lib/operator/appchannel");

const OWNER = "111111111111111111", STAFF = "222222222222222222";
const REQUEST = "the tickets relating to compressed data are all related, can you merge them and add parties to a consolidated incident ticket?";

function setup({ dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir114-oac-")), controlsOverride = null, tickets = [1872, 1873, 1874], store = null } = {}) {
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [STAFF], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, ...(controlsOverride ? { controls: controlsOverride } : {}) };
  store ||= Object.fromEntries(tickets.map((n) => [n, { number: n, title: `Ticket ${n}`, category: "bug", status: "open", mergedInto: null }]));
  const calls = [];
  let next = 1876;
  const mcp = { servers: () => ["support"], list: async () => [], call: async (server, name, args) => {
    calls.push([name, args]);
    if (name === "support_get") return store[args.number] ? { ...store[args.number] } : null;
    if (name === "support_create_ticket") { const n = next++; store[n] = { number: n, title: args.title, category: "incident", status: "open" }; return { ticketNumber: n }; }
    if (name === "support_merge") { const s = store[args.source_number]; if (s.mergedInto) return { alreadyMerged: true }; s.mergedInto = args.target_number; s.status = "closed"; return { steps: ["reporter added", "pointer posted"] }; }
    if (name === "support_resolve") { store[args.number].status = "resolved"; return { ok: true }; }
    return { ok: true };
  } };
  const broker = createBroker({ ledger, config, mcp, discord: async () => ({}), sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => Date.now() });
  return { dir, ledger, broker, config, calls, store, d: ledger.data, count: (n) => calls.filter((c) => c[0] === n).length };
}
const body = (extra = {}) => ({ commandId: "sup-cmd-0001", op: "open_incident", tickets: [1872, 1873, 1874], title: "Pages fail with unreadable compressed data", description: "Company pages, mail and notifications failed to load with a data error.", reason: "same compressed data error on page loads", request: { messageId: "m_e52f2a6086", text: REQUEST }, ...extra });

test("the owner's morning request opens one incident and merges the three tickets into it", async () => {
  const f = setup();
  const r = await f.broker.ownerAppTicketCommand(body());
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(r.result.incident, 1876);
  assert.deepEqual(r.result.results.map((x) => [x.ticket, x.merged]), [[1872, true], [1873, true], [1874, true]]);
  for (const n of [1872, 1873, 1874]) assert.equal(f.store[n].mergedInto, 1876);
  assert.equal(f.count("support_create_ticket"), 1);
  assert.ok(f.d.audit?.length !== 0);
});

test("a retry of the same command, even after a restart, opens and merges nothing twice", async () => {
  const f = setup();
  await f.broker.ownerAppTicketCommand(body());
  const again = await f.broker.ownerAppTicketCommand(body());
  assert.equal(again.done, true); assert.equal(again.result.incident, 1876);
  // The process died mid-command: the record is left running, past its deadline. A new process over the same ledger file
  // and the same support service picks it up instead of refusing it forever.
  Object.assign(f.d.ownerAppCommands["sup-cmd-0001"], { state: "running", deadline: Date.now() - 1 }); f.ledger.save();
  const g = setup({ dir: f.dir, store: f.store });
  const third = await g.broker.ownerAppTicketCommand(body());
  assert.equal(third.done, true); assert.equal(third.result.incident, 1876);
  assert.equal(f.count("support_create_ticket") + g.count("support_create_ticket"), 1);
  assert.equal(f.count("support_merge") + g.count("support_merge"), 3);
});

test("a stopped or paused Keir refuses with that reason and changes nothing", async () => {
  const f = setup(); f.d.paused = true;
  const r = await f.broker.ownerAppTicketCommand(body());
  assert.equal(r.done, false); assert.match(r.refused, /stopped from the app/);
  const g = setup({ controlsOverride: controls.staticControls({}, { held: "owner pulled it" }) });
  const k = await g.broker.ownerAppTicketCommand(body());
  assert.match(k.refused, /kill switch engaged \(owner pulled it\)/);
  assert.equal(f.calls.length + g.calls.length, 0);
});

test("the switch for cross-ticket actions is honoured", async () => {
  const f = setup({ controlsOverride: controls.staticControls({ crossTicketActions: "off" }) });
  const r = await f.broker.ownerAppTicketCommand(body({ op: "merge", tickets: [1872], target: 1873 }));
  assert.equal(r.done, false); assert.match(r.refused, /crossTicketActions is off/);
  assert.equal(f.count("support_merge"), 0);
});

test("a large unnamed batch is confirmed against its exact list; another digest does not confirm it", async () => {
  const f = setup({ tickets: [1872, 1873, 1874, 1877, 1878] });
  const b = body({ tickets: [1872, 1873, 1874, 1877, 1878] });
  const first = await f.broker.ownerAppTicketCommand(b);
  assert.equal(first.confirming, true); assert.match(first.confirmation, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.tickets, [1872, 1873, 1874, 1877, 1878]);
  assert.equal(f.count("support_create_ticket"), 0);
  const other = await f.broker.ownerAppTicketCommand({ ...b, commandId: "sup-cmd-0002", tickets: [1872, 1873, 1874, 1877], confirm: first.confirmation });
  assert.equal(other.confirming, true, "a confirmation for one list never confirms a different list");
  const ok = await f.broker.ownerAppTicketCommand({ ...b, confirm: first.confirmation });
  assert.equal(ok.done, true, JSON.stringify(ok));
  assert.equal(f.count("support_create_ticket"), 1); assert.equal(f.count("support_merge"), 5);
});

test("named ticket numbers in the owner's message need no confirmation", async () => {
  const f = setup({ tickets: [1872, 1873, 1874, 1877, 1878] });
  const r = await f.broker.ownerAppTicketCommand(body({ tickets: [1872, 1873, 1874, 1877, 1878], request: { messageId: "m_x123", text: "merge 1872, 1873, 1874, 1877 and 1878 into one incident" } }));
  assert.equal(r.done, true);
});

test("only the structured command is accepted, and a task that merely carries the marker is refused", async () => {
  const f = setup();
  await assert.rejects(f.broker.ownerAppTicketCommand({ ...body(), actorId: STAFF }), /unknown fields: actorId/);
  await assert.rejects(f.broker.ownerAppTicketCommand(body({ request: { messageId: "m_x123" } })), /owner's message/);
  await assert.rejects(f.broker.ownerAppTicketCommand(body({ tickets: ["1872"] })), /ticket numbers/);
  await f.broker.ownerAppTicketCommand(body({ op: "merge", tickets: [1872], target: 1873, commandId: "sup-cmd-0009" }));
  await assert.rejects(f.broker.ownerAppTicketCommand(body({ op: "merge", tickets: [1872], target: 1873, commandId: "sup-cmd-0009", request: { messageId: "m_other", text: "something else" } })), /different owner message/);
  const forged = f.ledger.createJob("forged", { kind: "command", role: "owner", actorId: OWNER, source: { channelId: "x", authorId: OWNER }, deadline: 9e15 });
  forged.state = "running"; forged.ownerAppCommand = { id: "sup-cmd-0001", text: "merge 1872 into 1873" };
  await assert.rejects(f.broker.tool(forged, "ticket_command", { op: "merge", tickets: [1872], target: 1873, reason: "same problem here" }), /authenticated app session/);
});

test("resolve over a waiting player asks first; add_person goes through the same path", async () => {
  const f = setup();
  const t = f.ledger.createJob("ticket:1872", { kind: "ticket", ticket: 1872, role: "player", channelId: "c", source: {}, inbox: [] });
  t.state = "waiting"; t.lastPlayerAt = Date.now(); t.lastPublishedAt = Date.now() - 60000;
  const r = await f.broker.ownerAppTicketCommand(body({ op: "resolve", tickets: [1872], message: "This is fixed now, thanks for the report.", request: { messageId: "m_res1", text: "close the compressed data one" } }));
  assert.equal(r.confirming, true); assert.equal(f.count("support_resolve"), 0);
  const ok = await f.broker.ownerAppTicketCommand(body({ op: "resolve", tickets: [1872], message: "This is fixed now, thanks for the report.", request: { messageId: "m_res1", text: "close the compressed data one" }, confirm: r.confirmation }));
  assert.equal(ok.done, true); assert.equal(f.count("support_resolve"), 1);
  assert.equal(t.state, "done");
  const p = await f.broker.ownerAppTicketCommand(body({ commandId: "sup-cmd-0100", op: "add_person", tickets: [1873], user: "someone", request: { messageId: "m_add1", text: "add someone to 1873" } }));
  assert.equal(p.done, false); assert.match(p.refused, /no open channel found for ticket 1873/);
});

test("the route is owner only and goes through the app server's own sign-in check", async (t) => {
  const seen = [];
  for (const who of ["staff", false, "owner"]) {
    const server = createAppServer({ app: {}, authenticate: async () => who, artifactsDir: os.tmpdir(), agentRoutes: async (route, method, b) => { seen.push([route, method, b.op]); return { done: true }; } });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const status = await new Promise((resolve) => { const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/api/keir/app/ticket-commands", method: "POST", headers: { "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode); }); req.end(JSON.stringify({ op: "merge" })); });
    assert.equal(status, who === "owner" ? 200 : who === "staff" ? 403 : 401);
  }
  assert.deepEqual(seen, [["/ticket-commands", "POST", "merge"]]);
});
