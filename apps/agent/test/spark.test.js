"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { makeSpark, MODEL } = require("../lib/operator/spark");
const { makeDistiller, makeCurator } = require("../lib/operator/knowledge");
const { createClassifier } = require("../lib/operator/classify");
const { render } = require("../lib/operator/decisions");

function fake(output, { code = 0, inspect = () => {}, hang = false } = {}) {
  return (bin, args, opts) => {
    inspect(bin, args, opts);
    const child = new EventEmitter(); child.stdout = new EventEmitter();
    child.stdin = { end() { if (!hang) setImmediate(() => { child.stdout.emit("data", output); child.emit("close", code); }); } };
    return child;
  };
}

test("Spark runs Codex GPT 6 Luna at low effort in an isolated home with every tool off, then removes scratch files", async () => {
  let workspace, home;
  const spark = makeSpark({ spawnImpl: fake("A short answer", { inspect(bin, args, opts) {
    assert.equal(bin, "codex");
    assert.equal(MODEL, "gpt-6-luna");
    assert.deepEqual(args.slice(0, 5), ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only"]);
    workspace = opts.cwd; home = opts.env.CODEX_HOME;
    assert.deepEqual(fs.readdirSync(workspace), []);
    assert.equal(fs.readlinkSync(`${home}/auth.json`), require("node:path").join(process.env.HOME || require("node:os").homedir(), ".codex/auth.json"));
    const toml = fs.readFileSync(`${home}/config.toml`, "utf8");
    assert.match(toml, /model = "gpt-6-luna"/); assert.match(toml, /model_reasoning_effort = "low"/);
    assert.match(toml, /shell_tool = false/); assert.doesNotMatch(toml, /mcp_servers/);
  } }) });
  assert.equal(await spark("System instruction", "Task input"), "A short answer");
  assert.equal(fs.existsSync(workspace), false); assert.equal(fs.existsSync(home), false);
});

test("structured helpers accept plain model output, including fenced JSON", async () => {
  const notes = [{ text: "Corporations pay taxes on their profits.", path: null }];
  assert.deepEqual(await makeDistiller({ spawnImpl: fake('```json\n' + JSON.stringify({ notes }) + '\n```') })({ title: "Taxes", body: "Game rules" }), notes);
  const actions = [{ op: "drop", id: "old", reason: "Duplicate" }];
  assert.deepEqual(await makeCurator({ spawnImpl: fake(JSON.stringify({ actions })) })([{ id: "old", kind: "knowledge", text: "A duplicate note" }]), actions);
  assert.deepEqual(await makeDistiller({ spawnImpl: fake('{"notes":{}}') })({ body: "Rules" }), []);
  assert.deepEqual(await makeCurator({ spawnImpl: fake('{"actions":"oops"}') })([]), []);
});

test("provider failure preserves the quiet classifier, original summary and empty learning fallbacks", async () => {
  const spawnImpl = fake('{"forKeir":true}', { code: 1 });
  assert.equal(await createClassifier({ spawnImpl, jev: async () => null })({ transcript: [], message: { content: "Question" } }), false);
  const question = "Approve this specific fix. It repairs the broken action.";
  assert.equal(render(question), `**Decision needed**\n${question}`);
  assert.deepEqual(await makeDistiller({ spawnImpl })({ body: "Rules" }), []);
  assert.deepEqual(await makeCurator({ spawnImpl })([]), []);
});

test("a stalled helper resolves at its deadline even if the process never closes", async () => {
  let workspace;
  const spark = makeSpark({ timeoutMs: 10, spawnImpl: fake("", { hang: true, inspect(_bin, _args, opts) { workspace = opts.cwd; } }) });
  assert.equal(await spark("Instructions", "Input"), "");
  assert.equal(fs.existsSync(workspace), false);
});

test("spawn errors and excessive output also finish safely", async () => {
  assert.equal(await makeSpark({ spawnImpl() { throw new Error("missing binary"); } })("System", "Input"), "");
  assert.equal(await makeSpark({ spawnImpl: fake("x".repeat(64001)) })("System", "Input"), "");
});
