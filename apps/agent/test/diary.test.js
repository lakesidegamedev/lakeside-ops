"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDiary, reflect, INTERVAL_MS, RETRY_MS } = require("../lib/operator/diary");

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-diary-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let at = 1800000000000;
  const ledger = { data: { jobs: {} } };
  const opts = { stateDir, ledger, now: () => at };
  return { opts, advance: n => { at += n; }, read: () => JSON.parse(fs.readFileSync(path.join(stateDir, "private/diary.json"))),
    mode: () => fs.statSync(path.join(stateDir, "private/diary.json")).mode & 0o777 };
}

test("private diary survives restart, retains history and writes once per twelve hours", async t => {
  const f = fixture(t), contexts = [];
  const generate = async c => { contexts.push(c); return "I learned to check the receipt."; };
  let diary = createDiary({ ...f.opts, generate });
  await diary.tick();
  assert.equal(f.mode(), 0o600);
  assert.equal(f.read().entries.length, 1);
  assert.equal(f.opts.ledger.data.entries, undefined);
  diary = createDiary({ ...f.opts, generate });
  f.advance(INTERVAL_MS - 1); await diary.tick();
  assert.equal(contexts.length, 1);
  f.advance(1); await diary.tick();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1].previousEntries[0].text, "I learned to check the receipt.");
  assert.equal(f.read().entries.length, 2);
});

test("failure backs off across restart without recording an entry", async t => {
  const f = fixture(t);
  await assert.rejects(createDiary({ ...f.opts, generate: async () => { throw Error("offline"); } }).tick());
  let calls = 0;
  const diary = createDiary({ ...f.opts, generate: async () => { calls++; return "Quiet day."; } });
  await diary.tick(); assert.equal(calls, 0);
  f.advance(RETRY_MS); await diary.tick();
  assert.equal(calls, 1); assert.equal(f.read().entries.length, 1);
});

test("concurrent ticks cannot duplicate entries, and pause suppresses generation", async t => {
  const f = fixture(t); let finish, calls = 0;
  const diary = createDiary({ ...f.opts, generate: () => { calls++; return new Promise(r => { finish = r; }); } });
  f.opts.ledger.data.paused = true; await diary.tick(); assert.equal(calls, 0);
  f.opts.ledger.data.paused = false;
  const pending = diary.tick(); await diary.tick(); assert.equal(calls, 1);
  finish("I checked my work."); await pending;
  assert.equal(f.read().entries.length, 1);
});

test("reflection receives bounded recent summaries without raw conversations or credentials", async t => {
  const f = fixture(t); let context;
  f.opts.ledger.data.jobs.old = { at: 1, summary: "stale" };
  for (let i = 0; i < 90; i++) f.opts.ledger.data.jobs[i] = {
    updatedAt: f.opts.now(), kind: "ticket", state: "done",
    summary: "Fixed. OLLAMA_API_KEY=secret-value", source: { content: "private raw message" },
  };
  await createDiary({ ...f.opts, generate: async c => { context = c; return "A quiet reflection."; } }).tick();
  assert.equal(context.workCount, 90); assert.equal(context.work.length, 80);
  assert.doesNotMatch(JSON.stringify(context), /secret-value|private raw message|stale/);
});

test("empty model output does not become a diary entry", async t => {
  const f = fixture(t);
  await assert.rejects(createDiary({ ...f.opts, generate: async () => " " }).tick(), /invalid/);
  assert.equal(f.read().entries, undefined);
});

test("DeepSeek reflection uses the common CLI with no tools and rejects incomplete output", async () => {
  let request;
  const invoke = async input => { request = input; return { result: "I learned something.", usage: {} }; };
  assert.equal((await reflect({ work: [] }, { invoke })).entry, "I learned something.");
  assert.equal(request.runner, "ollama");
  assert.equal(request.model, "deepseek-v4.1-flash");
  assert.deepEqual(request.tools, []); assert.equal(request.maxOutputTokens, 2600);
  assert.equal(request.kind, "generation");
  assert.ok(request.stateDir.endsWith("private"));
  await assert.rejects(reflect({}, { invoke: async () => ({ is_error: true }) }), /incomplete/);
  await assert.rejects(reflect({}, { invoke: async () => ({ result: "" }) }), /invalid/);
});
test("reflection usage records counts without private text or completion claims", async t => {
  const f=fixture(t);
  await createDiary({...f.opts,generate:async(c,{onUsage})=>{onUsage({input:100,output:20});return "PRIVATE_DIARY_TEXT";}}).tick();
  const raw=fs.readFileSync(path.join(f.opts.stateDir,"usage.jsonl"),"utf8"), row=JSON.parse(raw.trim());
  assert.doesNotMatch(raw,/PRIVATE_DIARY_TEXT|previousEntries/);
  assert.equal(row.tokens.input,100);assert.equal(row.tokens.output,20);assert.equal(row.taskState,undefined);
});

test("ideas build across entries and people are remembered from real interactions only", async t => {
  const f = fixture(t), contexts = [];
  const at = () => new Date(f.opts.now()).toISOString();
  f.opts.ledger.data.jobs.a = { updatedAt: f.opts.now(), kind: "ticket", ticket: 1706, state: "done", summary: "answered",
    source: { authorId: "1082686076491137115", author: "Hyawii", content: "the PM tab has no cabinet member <@123456789012>", at: at() },
    requestInbox: [{ role: "system", authorId: "wait-review", content: "This wait is overdue", at: at() },
      { authorId: "1479984768194969663", author: "Keir", content: "my own post", at: at() }] };
  const opts = { ...f.opts, ownerId: "333052320252297216", botId: "1479984768194969663" };
  let reply = { entry: "I rushed Hyawii.", ideas: [{ key: "Read Visits First", text: "Check the visit history before asking.", status: "new" }],
    people: [{ id: "1082686076491137115", note: "Writes short asides in brackets; wants a straight answer." }, { id: "999999999999", note: "invented" }] };
  const diary = createDiary({ ...opts, generate: async c => { contexts.push(c); return reply; } });
  await diary.tick();
  const c0 = contexts[0];
  assert.equal(c0.interactions.length, 1);
  assert.equal(c0.interactions[0].name, "Hyawii"); assert.equal(c0.interactions[0].role, "player");
  assert.deepEqual(c0.interactions[0].tickets, [1706]);
  assert.match(c0.interactions[0].said[0], /@someone/);
  assert.doesNotMatch(JSON.stringify(c0.interactions), /overdue|my own post/);
  let d = f.read();
  assert.equal(d.ideas["read-visits-first"].status, "new");
  assert.equal(d.people["1082686076491137115"].notes.length, 1);
  assert.equal(d.people["999999999999"], undefined);
  f.advance(INTERVAL_MS);
  f.opts.ledger.data.jobs.a.updatedAt = f.opts.now(); f.opts.ledger.data.jobs.a.source.at = at();
  reply = { entry: "It worked.", ideas: [{ key: "read-visits-first", text: "Visit history first; it answered two tickets.", status: "tested" }], people: [] };
  await diary.tick();
  const c1 = contexts[1];
  assert.equal(c1.ideasSoFar[0].key, "read-visits-first");
  assert.equal(c1.peopleKnown[0].notes[0], "Writes short asides in brackets; wants a straight answer.");
  d = f.read();
  assert.equal(d.ideas["read-visits-first"].revisions, 2);
  assert.equal(d.ideas["read-visits-first"].history[0].status, "new");
  assert.equal(d.people["1082686076491137115"].interactions, 2);
});

test("a prose answer still becomes an entry and fenced JSON is parsed", () => {
  const { parseReflection } = require("../lib/operator/diary");
  assert.deepEqual(parseReflection("Just prose today."), { entry: "Just prose today.", ideas: [], people: [] });
  assert.equal(parseReflection('```json\n{"entry":"Fenced.","ideas":[],"people":[]}\n```').entry, "Fenced.");
});
