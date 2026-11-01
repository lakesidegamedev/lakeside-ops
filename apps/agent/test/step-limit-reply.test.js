"use strict";
// #mod-bot, 2026-11-01: an owner's one-line stats question spent every quick
// step reading, and the model's "Maximum steps reached" note was posted as
// the answer.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events");
const { createAgent, STEP_LIMIT_TEXT } = require("../lib/operator/agent");
const { createLedger } = require("../lib/operator/store");
const stepguard = require("../lib/operator/stepguard");
const NOTE = "## Maximum steps reached for this agent\n\nTools are now disabled, so I could not deliver the channel reply or call `finish`. Nothing was posted.\n\n### Remaining tasks\n1. Post the reply.";

async function run(t, text, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-step-limit-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { stateDir: dir, briefFile: path.join(__dirname, "../KEIR.md"), model: "fixture", quickProvider: "claude:fixture", taskLifetimeMs: 60000, skills: false, tagIntake: async () => ({ kind: "owner_command", kindConfidence: 0.9, contextProfile: "focused" }), dynamicEffort: false, ownerId: "owner", repositories: {} };
  const job = ledger.createJob("q", { kind: "conversation", role: "owner", actorId: "owner", replyChannel: "chan", channelId: "chan", source: { channelId: "chan", authorId: "owner", content: "how many players have logged on in the last 7 days?", at: new Date().toISOString() }, ...extra });
  const calls = [];
  const broker = { servers: () => ["gamestate"], appContext: () => ({}), context: () => ({}), notebook: { recall: () => [] },
    tool: async (_job, name, input) => { calls.push({ name, input }); if (name === "finish" || name === "handoff") job.state = name === "handoff" ? "queued" : "done"; return { state: job.state }; } };
  const spawnImpl = () => {
    const child = new EventEmitter(); child.pid = 999999; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => { child.stdout.emit("data", JSON.stringify({ type: "result", subtype: "success", result: text, usage: {} }) + "\n"); child.emit("close", 0); });
    return child;
  };
  await createAgent({ ledger, config, broker, spawnImpl }).run(job, new AbortController().signal);
  return { job, calls, ledger };
}

test("a step-limit note is a private checkpoint, never a reply", async t => {
  const { job, calls, ledger } = await run(t, NOTE);
  assert.ok(!calls.some(c => c.name === "channel_reply"), "nothing is posted to the channel");
  assert.ok(!calls.some(c => c.name === "finish"), "the note does not become a finish summary");
  assert.ok(calls.some(c => c.name === "handoff"), "the owner's question moves to a full worker activation");
  assert.match(job.summary, /^Checkpoint from a step-limited activation/);
  assert.ok(ledger.data.audit.some(a => a.kind === "step_limit_reached"));
});

test("an ordinary answer is still delivered", async t => {
  const { calls } = await run(t, "142 player characters have logged on in the last 7 days: 93 in the US, 28 in the UK and 21 in Japan.");
  assert.ok(!calls.some(c => c.name === "handoff"));
});

test("the step-limit detector catches the note and leaves ordinary answers alone", () => {
  assert.ok(STEP_LIMIT_TEXT.test(NOTE));
  for (const ok of ["142 player characters logged on this week.", "The turn limit on cloture was reached in the Senate.", "Your budget step-up passed."]) assert.ok(!STEP_LIMIT_TEXT.test(ok), ok);
});

test("the last step is kept for the answer", () => {
  const session = { maxTurns: 6, steps: 5 };
  assert.match(stepguard.refuse(session, "read_tool", { server: "gamestate", tool: "geo_aggregate" }), /Post your answer now/);
  assert.equal(stepguard.refuse(session, "channel_reply", { message: "x" }), null, "replying is never refused");
  assert.equal(stepguard.refuse({ maxTurns: 6, steps: 3 }, "read_tool", { server: "gamestate", tool: "x" }), null);
});
