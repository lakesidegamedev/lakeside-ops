"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("monorepo release staging ships the headless runtime and preserves the live pointer", t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keir-release-"));
  t.after(() => {
    // Releases are intentionally read-only, including their directories.
    execFileSync("chmod", ["-R", "u+w", tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const repo = path.join(tmp, "repo"), agent = path.join(repo, "apps/agent"), releases = path.join(tmp, "runtime");
  fs.mkdirSync(path.join(agent, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(agent, "rust")); fs.mkdirSync(path.join(repo, "apps/web"));
  const cli = path.join(repo, "apps/cli");
  fs.mkdirSync(path.join(cli, "headless"), { recursive: true }); fs.mkdirSync(path.join(cli, "bin"));
  fs.mkdirSync(path.join(cli, "bench"));
  fs.writeFileSync(path.join(cli, "bench/test-fixture.json"), '{"answer":42}');
  fs.writeFileSync(path.join(cli, "headless/runtime.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(cli, "provider-routes.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(cli, "bin/activation.cjs"), "// fixture\n");
  fs.mkdirSync(path.join(repo, "apps/web/keir-supervisor"));
  fs.writeFileSync(path.join(repo, "apps/web/keir-supervisor/attention.js"), "module.exports = { contract: 1 };");
  fs.writeFileSync(path.join(repo, "apps/web/tenant-only.txt"), "Must not ship in an agent release");
  fs.writeFileSync(path.join(agent, "package.json"), JSON.stringify({ name: "keir-release-fixture", version: "1.2.3", scripts: { test: "node -e \"if(require('../web/keir-supervisor/attention').contract!==1||require('../cli/bench/test-fixture.json').answer!==42)process.exit(1);require('node:fs').writeFileSync('tested', 'yes')\"" } }));
  fs.writeFileSync(path.join(agent, "package-lock.json"), JSON.stringify({ name: "keir-release-fixture", version: "1.2.3", lockfileVersion: 3, packages: { "": { name: "keir-release-fixture", version: "1.2.3" } } }));
  fs.writeFileSync(path.join(agent, "rust/Cargo.toml"), '[workspace.package]\nversion = "1.2.3"\n');
  fs.copyFileSync(path.join(__dirname, "../deploy/release.sh"), path.join(agent, "deploy/release.sh"));
  const run = (bin, args, cwd = repo) => {
    try { return execFileSync(bin, args, { cwd, env: { ...process.env, KEIR_RELEASE_ROOT: releases }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
    catch (error) { throw new Error(`${bin} ${args.join(" ")}: ${error.stderr?.toString()} ${error.stdout?.toString()}`); }
  };
  run("git", ["init", "-b", "main"]); run("git", ["add", "apps"]);
  run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "fixture"]);
  run("git", ["init", "--bare", path.join(tmp, "origin.git")]);
  run("git", ["remote", "add", "origin", path.join(tmp, "origin.git")]); run("git", ["push", "origin", "main"]);
  const sha = run("git", ["rev-parse", "HEAD"]);
  fs.mkdirSync(releases); fs.symlinkSync("old-release", path.join(releases, "current"));
  assert.match(run("bash", ["deploy/release.sh", "HEAD", "--stage"], agent), /staged and tested/);
  const staged = path.join(releases, "releases", sha.slice(0, 12));
  assert.equal(fs.readlinkSync(path.join(releases, "current")), "old-release");
  assert.equal(fs.readFileSync(path.join(staged, "tested"), "utf8"), "yes");
  assert.equal(fs.existsSync(path.join(staged, "apps")), false);
  assert.ok(fs.existsSync(path.join(staged, "cli-runtime/headless/runtime.js")));
  assert.ok(fs.existsSync(path.join(staged, "cli-runtime/bin/activation.cjs")));
  assert.ok(fs.existsSync(path.join(staged, "cli-runtime/provider-routes.js")));
  assert.equal(fs.existsSync(path.join(staged, "tenant-only.txt")), false);
  assert.equal(fs.existsSync(path.join(staged, "cli-runtime/bench")), false);
  assert.equal(fs.existsSync(path.join(releases, "releases", sha.slice(0, 12) + ".building")), false);
  assert.equal(fs.existsSync(path.join(releases, "releases.jsonl")), false);
  assert.equal(run("git", ["tag"]), "");
  assert.equal(fs.readFileSync(path.join(staged, "RELEASE"), "utf8"), `${sha} 1.2.3\n`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staged, "SOURCE.json"))).component, "apps/agent");
});
