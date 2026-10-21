"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writeEngineStub } = require("./test-support/engine-stub.cjs");

test("installed-style entry point adds private peers, rejects invalid targets and lists receipts", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside-code-commands-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, LAKESIDE_CODE_CONFIG_DIR: dir, LAKESIDE_CODE_STATE_DIR: path.join(dir, "state") };
  delete env.LAKESIDE_CODE_PEERS;
  const run = args => spawnSync(process.execPath, [path.join(__dirname, "bin/lakeside.cjs"), "code", ...args], { encoding: "utf8", env });
  const saved = run(["peers", "add", "--id", "reviewer", "--kind", "opencode", "--url", "http://127.0.0.1:4096", "--directory", "/worktrees/review", "--token-env", "REVIEW_PASSWORD"]);
  assert.equal(saved.status, 0, saved.stderr);
  const file = path.join(dir, "peers.json"), peers = JSON.parse(fs.readFileSync(file));
  assert.equal(peers[0].tokenEnv, "REVIEW_PASSWORD");
  const stat = fs.statSync(file);
  assert.ok(stat.isFile());
  // Windows ignores POSIX mode bits, so only POSIX can assert 0o600.
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
  const rejected = run(["peers", "add", "--id", "bad", "--kind", "keir", "--url", "http://remote.example"]);
  assert.equal(rejected.status, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), peers);
  const receipts = run(["handoffs"]);
  assert.equal(receipts.status, 0, receipts.stderr);
  assert.deepEqual(JSON.parse(receipts.stdout), []);
});

test("bare installed lakeside opens the coding engine in the current folder", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside-code-default-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = path.join(dir, "launch.json");
  const engine = writeEngineStub(dir, "engine", 'if (process.argv.includes("--version")) console.log("1.19.0"); else require("node:fs").writeFileSync(process.env.TEST_LAUNCH_RESULT, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n');
  const env = { ...process.env, LAKESIDE_OPENCODE_BIN: engine, LAKESIDE_CODE_CONFIG_DIR: path.join(dir, "config"), TEST_LAUNCH_RESULT: result };
  const run = args => spawnSync(process.execPath, [path.join(__dirname, "bin/lakeside.cjs"), ...args], { cwd: dir, encoding: "utf8", env });
  const started = run([]);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(result)), { args: [], cwd: dir });
  assert.ok(run(["--version"]).stdout.startsWith(`Lakeside Code ${require("./package.json").version} `));
  assert.match(run(["--help"]).stdout, /skills/);
});

test("doctor reports an unconfigured VPS without failing", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside-code-doctor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = writeEngineStub(dir, "engine", 'if (process.argv.includes("--version")) console.log("1.19.0");\n');
  const env = { ...process.env, LAKESIDE_OPENCODE_BIN: engine, LAKESIDE_CODE_CONFIG_DIR: path.join(dir, "config"), LAKESIDE_CODE_STATE_DIR: path.join(dir, "state") };
  const doctor = spawnSync(process.execPath, [path.join(__dirname, "bin/lakeside.cjs"), "code", "doctor"], { encoding: "utf8", env });
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.vps.state, "unconfigured");
  assert.equal(report.ready, true);
});

test("vps help names both operations and an unknown subcommand never reaches the engine", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside-code-vps-help-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, LAKESIDE_CODE_CONFIG_DIR: dir, LAKESIDE_CODE_STATE_DIR: path.join(dir, "state") };
  const run = args => spawnSync(process.execPath, [path.join(__dirname, "bin/lakeside.cjs"), "code", ...args], { encoding: "utf8", env });
  const help = run(["vps", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /vps \[status\]/);
  assert.match(help.stdout, /vps connect/);
  const unknown = run(["vps", "tools"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /vps \[status\]/);
});
