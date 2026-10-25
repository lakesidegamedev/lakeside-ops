"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { createSupportOwner } = require("../lib/operator/supportowner");
const vm = require("node:vm");
const { createRequire } = require("node:module");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-takeover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const job = ledger.createJob("ticket:1558", { kind: "ticket", role: "support", ticket: 1558, channelId: "channel", replyChannel: "channel", source: { channelId: "channel" }, deadline: Date.now() + 86400000 });
  job.state = "running";
  const owner = createSupportOwner({ ledger });
  const broker = createBroker({ ledger, config: { ownerId: "owner", staffIds: [], stateDir: dir, repositories: {}, supportDeferred: () => false }, mcp: { servers: () => [] }, discord: async () => { throw new Error("unexpected Discord access"); }, sandbox: {} });
  return { ledger, job, owner, broker, dir };
}
test("ticket takeover fences real broker tools, closure and descendants without stopping other tickets", async t => {
  const f = fixture(t);
  const child = f.ledger.createJob("child", { kind: "command", role: "support", codingParent: f.job.id, deadline: Date.now() + 86400000 });
  child.state = "running";
  const conflictingChild = f.ledger.createJob("conflict", { kind: "command", role: "support", ticket: 1562, codingParent: f.job.id, deadline: Date.now() + 86400000 });
  conflictingChild.state = "running";
  const other = f.ledger.createJob("ticket:1562", { kind: "ticket", role: "support", ticket: 1562, deadline: Date.now() + 86400000 });
  other.state = "running";
  f.owner.setTicketOwner(1558, "codex", "owner");
  for (const job of [f.job, child, conflictingChild]) {
    await assert.rejects(f.broker.tool(job, "calculate", { expression: "1+1" }), /ticket 1558.*codex/i);
    await assert.rejects(f.broker.tool(job, "finish", { state: "done", summary: "Payroll fixes this" }), /ticket 1558.*codex/i);
    assert.equal(job.state, "running");
  }
  assert.equal((await f.broker.tool(other, "calculate", { expression: "1+1" })).value, 2);
});
test("queued public replies are suppressed durably, including children and partly delivered messages", t => {
  const f = fixture(t);
  const { suppressOutbox } = require("../lib/operator/supporttakeover");
  const child = f.ledger.createJob("child", { kind: "command", codingParent: f.job.id });
  const entry = f.ledger.data.outbox.queued = { destination: `channel:${child.id}`, content: "Try wages again", deliveredChunks: 1, messageIds: ["already-sent"] };
  f.owner.setTicketOwner(1558, "codex", "owner");
  const suppressedAt = entry.deliveredAt;
  assert.equal(suppressOutbox(f.ledger, "queued", entry, 123), true);
  assert.equal(entry.deliveredAt, suppressedAt);
  assert.equal(entry.suppressedByTakeover.ticket, 1558);
  assert.deepEqual(entry.messageIds, ["already-sent"]);
  f.owner.setTicketOwner(1558, "keir", "owner");
  const saved = createLedger(path.join(f.dir, "ledger.json"));
  assert.match(saved.data.outbox.queued.skipped, /takeover/);
  assert.equal(saved.data.outbox.queued.deliveredAt, suppressedAt, "old advice cannot replay when ownership returns");
});
test("private app receipts and unrelated player replies survive a single ticket takeover", t => {
  const f = fixture(t);
  const { suppressOutbox } = require("../lib/operator/supporttakeover");
  f.owner.setTicketOwner(1558, "codex", "owner");
  const app = f.ledger.createJob("app", { ticket: 1558, replyChannel: "app", source: { channelId: "app" } });
  const other = f.ledger.createJob("other", { ticket: 1564 });
  for (const destination of [`channel:${app.id}`, `channel:${other.id}`, "owner"]) assert.equal(suppressOutbox(f.ledger, "x", { destination }, 123), false);
});
test("takeover correction and actual implementation owner persist without waking or minting approval", t => {
  const f = fixture(t); f.job.state = "waiting";
  const approvals = JSON.stringify(f.ledger.data.actions);
  const receipt = f.owner.setTicketOwner(1558, "codex", "owner", { id: "owner-1558", implementationOwner: "b0409b22", correction: "All four hardware sites fully staffed; issue4196 does not resolve these margins.", remainingWork: ["Hardware recipes, realized prices and composite policy charges"] });
  assert.equal(receipt.takeover.id, "owner-1558");
  assert.equal(f.job.state, "waiting");
  assert.equal(JSON.stringify(f.ledger.data.actions), approvals);
  const saved = createLedger(path.join(f.dir, "ledger.json"));
  const context = saved.data.supportOwner.takeovers[1558];
  assert.equal(context.implementationOwner, "b0409b22");
  assert.match(context.correction, /fully staffed/);
  assert.equal(saved.data.jobs[f.job.id].history.at(-1).kind, "support_takeover");
});
for (const handback of [false, true]) test(`actual outbox dispatch rechecks takeover after an awaited lookup, handback=${handback}`, async t => {
  const f = fixture(t);
  const entry = f.ledger.data.outbox.reply = { destination: `channel:${f.job.id}`, content: "Change wages again", id: "reply", at: Date.now(), attempts: 0 };
  let posts = 0, deliveries = 0;
  const source = fs.readFileSync(path.join(__dirname, "../operator.js"), "utf8");
  const start = source.indexOf("async function flushOutbox()");
  const end = source.indexOf("\n// Moderation tickets", start);
  const run = vm.runInNewContext(`let delivering = false; ${source.slice(start, end)}; flushOutbox`, {
    ledger: f.ledger, require: createRequire(path.join(__dirname, "../operator.js")), RESUME_HORIZON_MS: 86400000,
    config: { guildId: "guild" }, isAppJob: () => false, redactSecrets: x => x,
    chunkMessage: x => [x], snowflake: () => false, log: () => {},
    events: { append: () => { deliveries++; } },
    discord: async method => {
      if (method === "GET") {
        f.owner.setTicketOwner(1558, "codex", "owner");
        if (handback) f.owner.setTicketOwner(1558, "keir", "owner");
        return { guild_id: "guild" };
      }
      posts++; return { id: "unexpected" };
    },
  });
  await run();
  assert.equal(posts, 0);
  assert.equal(deliveries, 0, "suppressed advice must not emit a delivery receipt");
  assert.equal(entry.suppressedByTakeover.ticket, 1558);
});
test("a waiting notice keeps ticket provenance when takeover lands during its history lookup", async t => {
  const f = fixture(t); f.job.state = "waiting";
  f.ledger.data.disclosed = { 1558: { posted: true } };
  let writes = 0;
  const broker = createBroker({ ledger: f.ledger,
    config: { ownerId: "owner", staffIds: [], stateDir: f.dir, repositories: {}, guildId: "guild", supportDeferred: () => false,
      screenOutgoing: async () => { f.owner.setTicketOwner(1558, "codex", "owner"); return { labels: [], refuse: null }; } },
    mcp: { servers: () => [], call: async () => { writes++; return {}; } }, sandbox: {},
    discord: async (_method, route) => {
      if (route.includes("/guilds/")) return [{ id: "channel", name: "ticket-bug-test-1558" }];
      return [];
    },
  });
  assert.equal(await broker.waitingUpdate(f.job, { repository: "lakesidegamedev/AHDGame", number: 4196, base: "development", running: 1 }), false);
  assert.equal(writes, 0);
  const notice = Object.values(f.ledger.data.jobs).find(j => j.kind === "notice");
  assert.equal(notice.ticket, 1558);
  assert.match(notice.summary, /owned by codex/);
  assert.deepEqual(notice.effects, {}, "a known refusal before execution is not an uncertain write");
});

test("a taken-over task can end its activation quietly without claiming resolution", async t => {
  const f = fixture(t);
  f.owner.setTicketOwner(1558, "codex", "owner");
  f.job.summary = "Verified regional workforce decline; cause still under investigation.";
  const outbox = JSON.stringify(f.ledger.data.outbox);
  const result = await f.broker.tool(f.job, "finish", { state: "blocked", summary: "Standing down for the current ticket owner." });
  assert.equal(result.state, "deferred");
  assert.equal(f.job.state, "deferred");
  assert.match(f.job.summary, /Verified regional workforce/);
  assert.equal(JSON.stringify(f.ledger.data.outbox), outbox);
  assert.equal(f.ledger.data.supportOwner.tickets[1558], "codex");
});

test("a taken-over owner command finishes terminal so it cannot fence later ticket replies", async t => {
  const f=fixture(t);
  f.job.kind="command"; f.job.role="owner";
  f.owner.setTicketOwner(1558,"codex","owner");
  const result=await f.broker.tool(f.job,"finish",{state:"blocked",summary:"Standing down"});
  assert.equal(result.state,"dismissed");
  assert.equal(f.job.state,"dismissed");
  assert.equal(Object.keys(f.ledger.data.outbox).length,0);
});

test("owner ticket pause suppresses old public replies but permits its single control acknowledgement", t => {
 const f=fixture(t),{setPause}=require("../lib/operator/ticketpause"),{suppressOutbox}=require("../lib/operator/supporttakeover");
 const child=f.ledger.createJob("pause-child",{kind:"coding",role:"support",codingParent:f.job.id,state:"running"});
 setPause(f.ledger,"channel",1558,true,{authorId:"owner",messageId:"pause"},123);
 assert.equal(child.state,"paused");assert.ok(child.ticketPaused);
 const stale={destination:`channel:${f.job.id}`,content:"Still investigating"};assert.equal(suppressOutbox(f.ledger,"stale",stale,124),true);
 const ack=f.ledger.createJob("pause-ack",{kind:"notice",role:"owner",ticket:1558,channelId:"channel",ticketPauseControl:true,state:"done"});
 assert.equal(suppressOutbox(f.ledger,"ack",{destination:`channel:${ack.id}`,content:"Paused."},124),false);
 assert.equal(require("../lib/operator/admission").hold(child),"owner-ticket-pause");
 setPause(f.ledger,"channel",1558,false,{authorId:"owner",messageId:"resume"},125);
 assert.equal(child.state,"queued");assert.equal(stale.skipped,"ticket takeover: stale automatic reply suppressed");
});

test("pause and resume preserve an uncertain external write without treating resume as permission to replay it", t => {
 const f=fixture(t),{setPause}=require("../lib/operator/ticketpause");f.job.effects.write={state:"started",at:100};
 setPause(f.ledger,"channel",1558,true,{authorId:"owner",messageId:"pause"},123);
 assert.equal(f.job.state,"paused");
 setPause(f.ledger,"channel",1558,false,{authorId:"owner",messageId:"resume"},124);
 assert.equal(f.job.state,"blocked");assert.equal(f.job.effects.write.state,"started");
});
