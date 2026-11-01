"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createFastLane, plan, rejectReason, doneEvent } = require("../lib/operator/fastlane");
const { numbersIn } = require("../lib/operator/knowledge");
const advice = require("../lib/operator/advicerouting");

const QUESTION = { kind: "mechanics_question", kindConfidence: 0.9 };
const CONFIG = { fastLane: true, askUrl: "https://ask.example", askSecret: "secret" };

function job(fields = {}) {
  return { id: "j1", kind: "ticket", role: "support", ticket: 1800, history: [], inbox: [], tags: QUESTION,
    source: { authorId: "42", author: "Alice", content: "How many votes does cloture need?", attachments: [] }, ...fields };
}
function sse(done) { return `event: meta\ndata: {}\n\nevent: delta\ndata: "x"\n\nevent: done\ndata: ${JSON.stringify(done)}\n\n`; }
const CLEAN = { answer: "Cloture needs three fifths of the votes cast, so 60 of 100 when every member votes.", modelId: "deepseek-v4-flash", validation: { issues: [], grounding: [], inventedPaths: [], attribution: { coverage: 0.9 } } };

function harness(t, { done = CLEAN, status = 200, refuse = null, tags } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-fastlane-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const calls = [], requests = [], usage = [];
  const broker = { tool: async (j, name, input) => {
    calls.push({ name, input });
    if (name === "reporter_state") return { characterName: "Alice Smith", country: "US" };
    if (name === "support_action" && refuse) throw new Error(refuse);
    if (name === "finish") j.state = input.state;
    return { ok: true };
  } };
  const fetcher = async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return { ok: status === 200, status, text: async () => sse(done) }; };
  const lane = createFastLane({ ledger, broker, config: CONFIG, fetcher, numbersIn, tagIntake: async () => tags, recordUsage: (_j, r) => usage.push(r) });
  return { ledger, lane, calls, requests, usage };
}

test("only a confident, attachment-free ticket question takes the fast lane", () => {
  assert.equal(plan(job(), CONFIG).kind, "answer");
  assert.equal(plan(job({ tags: { kind: "gameplay_advice", kindConfidence: 0.9 } }), CONFIG).kind, "redirect");
  assert.match(plan(job({ tags: { kind: "bug_report", kindConfidence: 0.95 } }), CONFIG).skip, /kind/);
  assert.equal(plan(job({ tags: { ...QUESTION, kindConfidence: 0.5 } }), CONFIG).skip, "unsure kind");
  assert.equal(plan(job({ tags: { ...QUESTION, injection: true } }), CONFIG).skip, "injection");
  assert.equal(plan(job({ source: { authorId: "42", content: "see screenshot", attachments: [{ url: "x" }] } }), CONFIG).skip, "attachment");
  assert.equal(plan(job({ kind: "conversation" }), CONFIG).skip, "not a ticket");
  assert.equal(plan(job({ pullRequests: [1] }), CONFIG).skip, "work in progress");
  assert.equal(plan(job({ fastLane: { escalated: true } }), CONFIG).skip, "escalated");
  assert.equal(plan(job(), { ...CONFIG, fastLane: false }).skip, "off");
});

test("a follow-up needs a new message from the reporter, and pushback goes to the agent", () => {
  const answered = { history: [{ kind: "finish" }], fastLane: { answers: 1 } };
  assert.equal(plan(job(answered), CONFIG).skip, "no new player message");
  assert.equal(plan(job({ ...answered, inbox: [{ authorId: "99", content: "staff note" }] }), CONFIG).skip, "no new player message");
  assert.equal(plan(job({ ...answered, inbox: [{ authorId: "42", content: "And what about filibusters?" }] }), CONFIG).kind, "answer");
  assert.equal(plan(job({ ...answered, inbox: [{ authorId: "42", content: "That is wrong, my bill is still broken" }] }), CONFIG).skip, "pushback");
  assert.equal(plan(job({ history: [{}], fastLane: { answers: 2 }, inbox: [{ authorId: "42", content: "one more?" }] }), CONFIG).skip, "answer budget spent");
});

test("Ask's own doubts keep an answer off the ticket", () => {
  assert.equal(rejectReason(CLEAN), null);
  assert.equal(rejectReason({ answer: "" }), "empty answer");
  assert.match(rejectReason({ ...CLEAN, validation: { issues: ["truncated"] } }), /truncated/);
  assert.match(rejectReason({ ...CLEAN, validation: { grounding: ["claim unsupported"] } }), /grounding/);
  assert.match(rejectReason({ ...CLEAN, validation: { inventedPaths: ["src/x.ts"] } }), /unseen/);
  assert.match(rejectReason({ ...CLEAN, validation: { attribution: { coverage: 0.3 } } }), /attribution/);
  assert.match(rejectReason({ ...CLEAN, answer: "Yes.\n\n> This one used no energy" }), /caveat/);
  assert.equal(rejectReason({ ...CLEAN, validation: { issues: ["escalated_tier"] } }), null);
});

test("doneEvent reads the done payload out of an Ask stream", () => {
  assert.deepEqual(doneEvent(sse({ answer: "a" })).done, { answer: "a" });
  assert.equal(doneEvent("event: error\ndata: {\"error\":\"busy\"}\n\n").done, null);
});

test("a clean answer is posted through the broker and the ticket waits for the player", async t => {
  const h = harness(t), j = job();
  const r = await h.lane.attempt(j);
  assert.deepEqual(r, { handled: true, kind: "answer" });
  assert.deepEqual(h.calls.map(c => c.name), ["reporter_state", "support_action", "finish"]);
  assert.deepEqual(h.calls[1].input, { tool: "support_public_update", args: { message: CLEAN.answer } });
  assert.deepEqual(h.calls[2].input.waitFor, "player_reply");
  assert.equal(h.requests[0].url, "https://ask.example/api/keir-ask/answer");
  assert.equal(h.requests[0].init.headers.authorization, "Bearer secret");
  assert.equal(h.requests[0].body.discordId, "42");
  assert.equal(h.requests[0].body.requester.characterName, "Alice Smith");
  assert.ok(j.evidence.includes(60), "Ask's figures become this activation's evidence");
  assert.equal(j.fastLane.answers, 1);
  assert.equal(h.usage.length, 1);
  assert.ok(h.ledger.data.audit.some(a => a.kind === "fast_lane" && a.state === "answered"));
});

test("advice gets the Ask redirect with no Ask call and no model", async t => {
  const h = harness(t), j = job({ tags: { kind: "gameplay_advice", kindConfidence: 0.9 } });
  assert.equal((await h.lane.attempt(j)).handled, true);
  assert.equal(h.requests.length, 0);
  assert.equal(h.calls[0].name, "support_action");
  assert.equal(h.calls[0].input.args.message, advice.REPLY);
});

test("a doubted, failed or refused answer escalates once with its draft", async t => {
  const doubted = harness(t, { done: { ...CLEAN, validation: { grounding: ["x"] } } }), a = job();
  const r1 = await doubted.lane.attempt(a);
  assert.equal(r1.handled, false); assert.equal(r1.draft, CLEAN.answer); assert.equal(a.fastLane.escalated, true);
  assert.ok(!doubted.calls.some(c => c.name === "support_action"));
  assert.equal((await doubted.lane.attempt(a)).reason, "escalated", "never retried after escalation");

  const down = harness(t, { status: 503 }), b = job();
  assert.equal((await down.lane.attempt(b)).reason, "ask 503");

  const refused = harness(t, { refuse: "Not posted: 7 sentences" }), c = job({ replyRefusedPending: false });
  const r3 = await refused.lane.attempt(c);
  assert.equal(r3.handled, false); assert.equal(r3.reason, "post refused");
  assert.equal(c.replyRefusedPending, undefined, "the agent is not blamed for the fast lane's refused draft");
  assert.ok(!refused.calls.some(cl => cl.name === "finish"));
});

test("a follow-up is re-tagged, so a question that turns into a bug report goes to the agent", async t => {
  const h = harness(t, { tags: { kind: "bug_report", kindConfidence: 0.95 } });
  const j = job({ history: [{}], fastLane: { answers: 1 }, inbox: [{ authorId: "42", content: "Ok, and why does my vote count show zero?" }] });
  const r = await h.lane.attempt(j);
  assert.equal(r.handled, false); assert.match(r.reason, /bug_report/);
  assert.equal(h.requests.length, 0);
});

test("without the Ask secret a question falls through to the agent", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-fastlane-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const lane = createFastLane({ ledger, broker: { tool: async () => { throw new Error("no calls"); } }, config: { ...CONFIG, askSecret: null }, fetcher: async () => { throw new Error("no calls"); }, numbersIn, tagIntake: async () => null });
  assert.deepEqual(await lane.attempt(job()), { handled: false, reason: "no ask secret" });
});

// The real broker, so every player-copy and ticket guard runs on the answer.
test("through the real broker, a clean answer posts as a ticket update and the ticket waits for the player", async t => {
  const { createBroker } = require("../lib/operator/broker");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-fastlane-broker-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false, ...CONFIG };
  const calls = [];
  const mcp = { servers: () => ["gamestate", "support"], list: async () => [{ name: "support_public_update", inputSchema: { type: "object", additionalProperties: true } }],
    call: async (...args) => { calls.push(args); return { ok: true, ticketNumber: 1800, channelId: "777777777777777777", delivery: { posted: true, delivery: { status: "posted" } } }; } };
  const discord = async (_method, route) => route.includes("/guilds/") ? [{ id: "777777777777777777", name: "ticket-gameplay-1800", permission_overwrites: [] }] : [];
  const broker = createBroker({ ledger, config, mcp, discord, sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => 5000 });
  const j = ledger.createJob("ticket:1800", { kind: "ticket", role: "support", ticket: 1800, channelId: "777777777777777777", deadline: 9e15, tags: QUESTION,
    source: { authorId: "888888888888888888", author: "Alice", channelId: "777777777777777777", content: "How many votes does cloture need?", attachments: [], at: new Date(4000).toISOString() } });
  j.state = "running";
  require("../lib/operator/knowledge").readTicketRecord(ledger, 1800, j);
  const fetcher = async () => ({ ok: true, status: 200, text: async () => sse(CLEAN) });
  const lane = createFastLane({ ledger, broker, config, fetcher, numbersIn, tagIntake: async () => null });
  const r = await lane.attempt(j);
  assert.deepEqual(r, { handled: true, kind: "answer" }, JSON.stringify(ledger.data.audit.filter(a => a.kind === "tool_refused" || a.kind === "fast_lane")));
  const post = calls.filter(c => c[1] === "support_public_update").at(-1);
  assert.equal(post[2].number, 1800); assert.equal(post[2].message, CLEAN.answer); assert.equal(post[2].deliver, true);
  assert.equal(j.state, "waiting");
  assert.equal(j.waitingFor?.kind, "player_reply");
});
