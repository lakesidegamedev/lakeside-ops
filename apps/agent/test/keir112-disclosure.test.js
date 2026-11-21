"use strict";
// Keir 11.2 item 7: every PR Keir opens carries the Conflict of interest section AHDGame's custom-rules check requires.
// PRs 6784, 6791, 6798, 6799 and 6878 failed it because the section depended on the model (only doc review PRs got it).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const { hasDisclosure, withDisclosure } = require("../lib/operator/prdisclosure");

test("withDisclosure adds the section once and keeps a body that already has it", () => {
  const once = withDisclosure("fix: reuse regional state reads\n\nChange-class: bugfix");
  assert.equal(hasDisclosure(once), true);
  assert.equal(withDisclosure(once), once);
  assert.equal(hasDisclosure("Body with ### Conflict of interest inline, not a heading"), false);
});

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
test("publish_patch: an engineering PR body the model wrote without the section is published with it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-disclosure-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "1", staffIds: ["2"], botId: "3", guildId: "4", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: { AHDGame: dir }, watched: () => false };
  const exec = async (cmd) => (cmd === "/usr/bin/gh" ? "https://github.com/lakesidegamedev/AHDGame/pull/6784\n" : "");
  const diff = "diff --git a/src/components/Map.tsx b/src/components/Map.tsx\n--- a/src/components/Map.tsx\n+++ b/src/components/Map.tsx\n+const x = 1;\n";
  const sandbox = { run: async (id, command) => ({ code: 0, output: /diff --no-ext-diff/.test(command) ? diff : "" }), deps: () => null };
  const broker = createBroker({ ledger, config, mcp: { servers: () => [], list: async () => [], call: async () => ({}) }, discord: async () => [], sandbox, now: () => 5000, exec });
  const job = ledger.createJob("t", { role: "owner", kind: "command", repository: "AHDGame", source: {}, deadline: 9e15 }); job.state = "running";
  await broker.tool(job, "publish_patch", { title: "fix: reuse regional state reads in primary map projections", body: "Reuses the regional reads.\n\nChange-class: bugfix" });
  const bodies = fs.readdirSync(path.join(dir, "artifacts")).filter((f) => f.endsWith("-pr.md")).map((f) => fs.readFileSync(path.join(dir, "artifacts", f), "utf8"));
  assert.equal(bodies.length, 1);
  assert.equal(hasDisclosure(bodies[0]), true);
  assert.equal(bodies[0].match(/Conflict of interest/g).length, 1);
});
