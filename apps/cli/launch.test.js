"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { launch, launchSettings, prepare, engineBinary } = require("./launch");

test("coding flags preserve OpenCode project, resume and model arguments", () => {
  assert.deepEqual(launchSettings(["/work/project", "--name", "Lakeside Code", "--continue", "--model", "provider/model"], {}), {
    backend: "api", args: ["/work/project", "--continue", "--model", "provider/model"], preview: false, name: "Lakeside Code", binary: engineBinary({}),
  });
  assert.throws(() => launchSettings(["--name"], {}), /display name/);
  assert.throws(() => launchSettings(["--name", "bad\x1bname"], {}), /printable/);
  assert.throws(() => launchSettings(["--preview", "--prompt", "edit files"], {}), /runs by itself/);
});
test("provider choices keep subscription and API billing routes distinct", () => {
  for (const [provider, backend, model] of [
    ["antigravity", "antigravity", "gemini-test"], ["codex-sub", "codex", "gpt-test"],
    ["claude-sub", "claude", "claude-test"], ["codex-api", "api", "openai/gpt-test"],
    ["claude-api", "api", "anthropic/claude-test"], ["opencode-go", "api", "opencode-go/glm-test"],
    ["ollama", "api", "ollama/deepseek-test"],
    ["deepseek", "api", "deepseek/deepseek-flash"],
  ]) {
    const request = launchSettings(["--provider", provider, "--model", model.includes("/") ? model.split("/")[1] : model], {});
    assert.equal(request.backend, backend);
    assert.equal(request.nativeModel || request.args[request.args.indexOf("--model") + 1], model);
  }
  assert.throws(() => launchSettings(["--provider", "codex-sub", "--model", "openai/gpt-test"], {}), /billing route/);
  assert.throws(() => launchSettings(["--provider", "grok", "--model", "test"], {}), /Unknown provider/);
  assert.throws(() => launchSettings(["--provider", "cursor", "--model", "test"], {}), /Unknown provider/);
  assert.throws(() => launchSettings(["--provider", "codex-api"], {}), /explicit model/);
});

test("launcher accepts the installed ESM plugin and starts the pinned engine", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside code startup "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "test-engine"), result = path.join(dir, "result.json");
  fs.writeFileSync(binary, '#!/usr/bin/env node\nconst fs = require("node:fs");\nif (process.argv.includes("--version")) console.log(process.env.TEST_ENGINE_VERSION || "1.19.0");\nelse fs.writeFileSync(process.env.TEST_ENGINE_RESULT, process.env.OPENCODE_ROUTE);\n', { mode: 0o700 });
  const env = { ...process.env, LAKESIDE_CODE_CONFIG_DIR: dir, LAKESIDE_OPENCODE_BIN: binary, TEST_ENGINE_RESULT: result };
  await launch(["--preview"], env);
  assert.equal(JSON.parse(fs.readFileSync(result)).id, "lakeside.preview");
  await assert.rejects(launch([], { ...env, TEST_ENGINE_VERSION: "0.0.0" }), /found 0\.0\.0/);
});

test("launch config adds the client without replacing user providers, plugins or permissions", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside-code-launch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = { skills: { paths: ["/custom/skills"] }, command: { ponytail: { template: "owner command" } }, plugin: ["user-plugin"], permission: { bash: "ask" }, model: "my/model" };
  const env = { LAKESIDE_CODE_CONFIG_DIR: dir, OPENCODE_CONFIG_CONTENT: JSON.stringify(original), OTHER_SETTING: "kept" };
  const launch = prepare(launchSettings(["--preview"], env), env);
  const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.permission, { ...original.permission, agent_handoff: "ask", agent_cancel: "ask" });
  assert.equal(config.model, original.model);
  assert.equal(config.skills.paths[0], "/custom/skills");
  assert.match(config.skills.paths[1], /skills[\/]vendor$/);
  assert.deepEqual(config.command.ponytail, original.command.ponytail);
  assert.equal(config.plugin[0], "user-plugin");
  assert.match(config.plugin[1], /coordination-plugin\.mjs$/);
  assert.equal(launch.env.OTHER_SETTING, "kept");
  assert.equal(JSON.parse(launch.env.OPENCODE_ROUTE).id, "lakeside.preview");
  const tui = JSON.parse(fs.readFileSync(launch.env.OPENCODE_TUI_CONFIG));
  assert.equal(tui.plugin[0][1].name, "Lakeside Code");
  const staged = require("node:url").fileURLToPath(tui.plugin[0][0]);
  assert.ok(staged.startsWith(path.join(dir, "tui-runtime")));
  for (const file of ["terminal.tsx", "peers.mjs", "peer-monitor.mjs", "config.mjs", "midnight.json"]) assert.deepEqual(fs.readFileSync(path.join(path.dirname(staged), file)), fs.readFileSync(path.join(__dirname, file)));
  assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify(original));
});

test("a connected VPS makes each agent message and Discord post ask first", () => {
  const { prepare } = require("./launch");
  const { connectVps } = require("./vps-profile.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside-ask-"));
  try {
    const env = { ...process.env, LAKESIDE_CODE_CONFIG_DIR: root, LAKESIDE_CODE_STATE_DIR: path.join(root, "state") };
    const token = path.join(root, "token"); fs.writeFileSync(token, "d".repeat(64));
    connectVps("https://ops.example", token, env);
    const config = JSON.parse(prepare({ name: "Lakeside Code", backend: "api", args: [] }, env).env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.permission["keir-vps_vps_message"], "ask");
    assert.equal(config.permission["keir-vps_vps_discord_send"], "ask");
    assert.equal(config.permission.agent_handoff, "ask");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
