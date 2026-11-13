"use strict";
// Keir 9 feature C: a ticket task starts with a few labelled, fresh notes, and a recalled note never replaces the code lookup.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { createNotebook } = require("../lib/operator/knowledge");
const { queryFor } = require("../lib/operator/ticketrecall");

const FILE = "server/src/engine/supplyChain.ts", OTHER = "server/src/engine/taxRates.ts";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-recall-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sha = { current: "a".repeat(40) };
  const exec = (_c, args) => { if (args.includes("rev-parse")) return sha.current + "\n"; throw new Error("unexpected git call"); };
  return { dir, sha, nb: createNotebook({ file: path.join(dir, "nb.json"), exec }) };
}
const mechanic = (nb, text, p = FILE) => nb.remember({ kind: "mechanic", text, path: p });
const lines = (nb) => fs.readFileSync(nb.recallLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("queryFor adds file names, their word parts and screen names", () => {
  const q = queryFor({ texts: ["The Supply Chain screen is empty, see supplyChain.ts"], reads: [{ path: "server/src/engine/taxRates.ts" }] });
  assert.match(q, /supplychain/); assert.match(q, /supply chain/); assert.match(q, /taxrates/); assert.match(q, /tax/);
});

test("labels: checked rule, earlier answer not verified, earlier mistake", (t) => {
  const { nb } = fixture(t);
  mechanic(nb, "Supply chain output is capped at the plant capacity each turn.");
  nb.remember({ kind: "resolution", verified: false, ticket: 41, paths: [OTHER], text: "Answer given to a player in ticket 41, not checked against the code (the ticket read x): Tax rates apply per sector." });
  nb.remember({ kind: "lesson", ticket: 42, paths: [FILE], text: 'Ticket 42: do not repeat this mistake. A wrong claim was given and later retracted. Wrong: "Supply chain output has no cap" Right: "Supply chain output is capped" The file that settled it: supplyChain.ts.' });
  const out = nb.recallForTicket("supply chain output cap tax rates sector supplychain", { ticket: 99, job: "j1" });
  const by = (re) => out.find((o) => re.test(o.note));
  assert.match(by(/^checked rule from the code/).note, new RegExp(FILE));
  assert.match(by(/^earlier answer on ticket 41, not verified:/).note, /Tax rates apply per sector/);
  assert.doesNotMatch(by(/^earlier answer/).note, /Answer given to a player/);
  assert.match(by(/^earlier mistake:/).note, /"Supply chain output has no cap" was wrong, "Supply chain output is capped" was right/);
});

test("size cap: at most three notes within 600 characters", (t) => {
  const { nb } = fixture(t);
  for (let i = 0; i < 6; i++) mechanic(nb, `Supply chain output rule ${i}: ` + "the plant capacity limit applies every turn to output. ".repeat(12));
  const out = nb.recallForTicket("supply chain output plant capacity limit", { ticket: 1 });
  assert.ok(out.length >= 1 && out.length <= 3);
  assert.ok(out.reduce((n, o) => n + o.note.length, 0) <= 600);
});

test("stale notes (their code file changed) are left out and not counted as recalled", (t) => {
  const { nb, sha } = fixture(t);
  const n = mechanic(nb, "Supply chain output is capped at the plant capacity each turn.");
  assert.equal(nb.recallForTicket("supply chain output capacity", { ticket: 1 }).length, 1);
  sha.current = "b".repeat(40);
  assert.deepEqual(nb.recallForTicket("supply chain output capacity", { ticket: 1, job: "j2" }), []);
  assert.equal(nb.all().find((x) => x.id === n.id).recalls, 1);
});

test("accounting: shown notes are recorded against the ticket and job, others are not", (t) => {
  const { nb } = fixture(t);
  for (let i = 0; i < 5; i++) mechanic(nb, `Supply chain output capacity rule number ${i} stated plainly for the plant.`);
  const out = nb.recallForTicket("supply chain output capacity plant", { ticket: 77, job: "job-7" });
  const log = lines(nb);
  assert.equal(log.length, 1);
  assert.deepEqual({ job: log[0].job, ticket: log[0].ticket, via: log[0].via, ids: log[0].ids }, { job: "job-7", ticket: 77, via: "ticket-context", ids: out.map((o) => o.id) });
  assert.equal(nb.all().filter((n) => n.recalls).length, out.length);
});

// A real agent activation on a lean ticket task: the notes arrive in the prompt.
function activation(t, nb, extra = {}) {
  const { createAgent } = require("../lib/operator/agent");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-recall-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const ledger = { data: { actions: {}, jobs: {}, channels: {}, ticketLearn: { 5: { reads: [{ path: FILE }], posts: [], at: 1 } } }, save() {}, audit() {} };
  const job = { id: "tk", kind: "ticket", ticket: 5, role: "support", source: { content: "The Supply Chain screen shows no output. Why?", at: new Date().toISOString() }, rounds: 0, ...extra };
  ledger.data.jobs[job.id] = job;
  const agent = createAgent({ ledger, broker: { notebook: nb, tool: async (j, name) => { if (name === "finish") j.state = "done"; } },
    config: { leanContext: true, orientation: false, stateDir: root, skillsRoot: root, briefFile: path.join(__dirname, "../KEIR.md"), model: "test", workerProvider: "claude", maxRounds: 2, maxTurnMs: 5000 },
    spawnImpl: () => {
      const c = new EventEmitter(); c.pid = 999999; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin = { end(input) { seen.push(String(input)); setImmediate(() => { c.stdout.emit("data", JSON.stringify({ type: "result", subtype: "success", result: "ok" }) + "\n"); c.emit("close", 0); }); } };
      return c;
    } });
  return { agent, job, seen };
}

test("a lean ticket task gets the labelled notes in its first activation, and they are counted", async (t) => {
  const { nb } = fixture(t);
  mechanic(nb, "Supply chain output is capped at the plant capacity each turn.");
  const { agent, job } = activation(t, nb);
  let context;
  const orig = JSON.stringify;
  JSON.stringify = function (v, ...a) { if (v && v.taskId === "tk" && v.notebook) context = v; return orig.call(this, v, ...a); };
  try { await agent.run(job, new AbortController().signal); } finally { JSON.stringify = orig; }
  assert.ok(context, "the activation context was built with notebook notes");
  assert.equal(context.notebook.length, 1);
  assert.match(context.notebook[0].note, /^checked rule from the code/);
  assert.equal(lines(nb)[0].ticket, 5);
  assert.equal(lines(nb)[0].job, "tk");
});

// A recalled "not verified" note is not a code read: the rule check still asks for one.
test("a recalled not-verified note does not satisfy the code lookup rule", async (t) => {
  const { createLedger } = require("../lib/operator/store");
  const { createBroker } = require("../lib/operator/broker");
  const { REFUSAL } = require("../lib/operator/rulelookup");
  const { nb } = fixture(t);
  nb.remember({ kind: "resolution", verified: false, ticket: 41, paths: [FILE], text: "Answer given to a player in ticket 41, not checked against the code (x): Revenue falls because plants are mothballed." });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-recall-rule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const CH = "777777777777777777";
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { screenOutgoing: async () => ({ labels: [], refuse: null }), ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 1 };
  const calls = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => [], call: async (...a) => { calls.push(a); return {}; } };
  const discord = async (_m, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : []);
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, notebook: nb });
  const job = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 123, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-123", content: "Why did my revenue fall?" }, deadline: 9e15 });
  job.state = "running"; ledger.data.seen["ticket:123"] = job.id; ledger.data.disclosed = { 123: { at: 1, posted: true } };
  const shown = nb.recallForTicket("revenue falls plants mothballed supplychain", { ticket: 123, job: job.id });
  assert.match(shown[0].note, /not verified/);
  await broker.tool(job, "recall", { query: "revenue plants mothballed" });
  await assert.rejects(broker.tool(job, "channel_reply", { message: "Your revenue fell because the plants were mothballed at turn 675." }), (e) => e.message === REFUSAL);
  assert.ok(!job.codeLookups && !job.lastCodeReadAt);
});
