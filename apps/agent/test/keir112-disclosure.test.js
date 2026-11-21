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

// Item 7: a merge Keir was asked to carry out and GitHub refuses is never a silent dead end.
function mergeFixture(pr, checks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-deadend-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "1", staffIds: ["2"], botId: "3", guildId: "4", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const writes = [];
  const exec = async (cmd, args) => {
    if (cmd !== "/usr/bin/gh") return "";
    const route = args.filter((a) => !a.startsWith("-") && a !== "api" && !/^[a-z_]+=/.test(a)).at(-1);
    if (args.includes("-X")) { writes.push(args.join(" ")); return "{}"; }
    if (/check-runs/.test(route)) return JSON.stringify({ check_runs: checks.map(([name, conclusion], i) => ({ id: 50 + i, name, status: "completed", conclusion, started_at: "2026-11-18T02:40:00Z" })) });
    if (/\/files/.test(route)) return JSON.stringify([{ filename: "docs/wiki/energy.md" }]);
    if (/\/reviews/.test(route)) return "[]";
    if (route === "user") return JSON.stringify({ login: "Egg3901" });
    if (new RegExp(`pulls/${pr.number}$`).test(route)) return JSON.stringify(pr);
    return "null";
  };
  const broker = createBroker({ ledger, config, mcp: { servers: () => [], list: async () => [], call: async () => ({}) }, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => 5000, exec });
  return { ledger, broker, writes };
}
const keirDocPr = (n, body) => ({ number: n, title: "docs: correct the Energy stat description", state: "open", merged: false, mergeable: true, user: { login: "keir-bot" }, body, base: { ref: "development", sha: "b" }, head: { sha: `h${n}`, ref: `keir/task-ddd237cfc8d0-${n}`, repo: { full_name: "lakesidegamedev/AHDGame" } }, html_url: `https://github.com/lakesidegamedev/AHDGame/pull/${n}` });

for (const n of [6784, 6791, 6798, 6799, 6878]) {
  test(`PR ${n}: refused for a missing Conflict of interest section, Keir repairs its own description instead of going silent`, async () => {
    const f = mergeFixture(keirDocPr(n, "Corrects the guide."), [["verify", "success"], ["dependency-review", "success"], ["custom-rules", "failure"]]);
    const job = f.ledger.createJob(`keirpr:${n}`, { role: "support", kind: "command", internalProbe: true, repository: "AHDGame", adoptedPr: n, source: {}, deadline: 9e15 }); job.state = "running";
    const r = await f.broker.tool(job, "github", { action: "merge", number: n, changeClass: "display" });
    assert.equal(r.merged, false);
    assert.ok(f.writes.some((x) => x.includes(`pulls/${n}`) && /## Conflict of interest/.test(x)), f.writes.join("\n"));
    assert.ok(!Object.keys(f.ledger.data.outbox).some((k) => k.startsWith("pr-blocked:")), "repaired, so no owner line");
  });
}

test("a developer's PR refused for its author's missing section gets one plain owner line (ticket 1857, PR 6866)", async () => {
  const pr = { ...keirDocPr(6866, "Shows fundable issuance."), title: "fix(bonds): show fundable issuance", user: { login: "a-developer" }, head: { sha: "h6866", ref: "feat/bond-fundable", repo: { full_name: "lakesidegamedev/AHDGame" } } };
  const f = mergeFixture(pr, [["verify", "success"], ["dependency-review", "success"], ["custom-rules", "failure"]]);
  const job = f.ledger.createJob("ownerwait:6866", { role: "support", kind: "command", internalProbe: true, repository: "AHDGame", ownerWaitPr: 6866, source: {}, deadline: 9e15 }); job.state = "running";
  for (let i = 0; i < 2; i++) await f.broker.tool(job, "github", { action: "merge", number: 6866, changeClass: "display" });
  const lines = Object.entries(f.ledger.data.outbox).filter(([k]) => k.startsWith("pr-blocked:6866:"));
  assert.equal(lines.length, 1, "one line per PR, head and reason");
  assert.match(lines[0][1].content, /PR #6866 \(fix\(bonds\): show fundable issuance\) is ready to merge but blocked: its description is missing the Conflict of interest section, which its author has to add\. Nothing was merged\./);
  assert.ok(!f.writes.some((x) => /pulls\/6866 .*body=/.test(x)), "never edits someone else's PR");
});

test("an adopted Keir PR whose verify check is red gets one owner line", async () => {
  const f = mergeFixture(keirDocPr(6853, "Frames portraits.\n\n## Conflict of interest\n- [x]"), [["verify", "failure"], ["dependency-review", "success"], ["custom-rules", "success"]]);
  const job = f.ledger.createJob("keirpr:6853", { role: "support", kind: "command", internalProbe: true, repository: "AHDGame", adoptedPr: 6853, source: {}, deadline: 9e15 }); job.state = "running";
  await f.broker.tool(job, "github", { action: "merge", number: 6853, changeClass: "display" });
  assert.match(f.ledger.data.outbox["pr-blocked:6853:verify:h6853"].content, /blocked: the build and test check failed/);
});
