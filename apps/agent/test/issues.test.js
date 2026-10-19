"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const issues = require("../lib/operator/issues");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const good = {
  title: "Factory output panel shows zero after a retool",
  kind: "bug",
  summary: "After a sector retool, the factory output panel shows zero output for the next turn although production continued.",
  steps: ["Own a corporation with a factory", "Retool its sector", "Open the output panel on the next turn"],
  expected: "The panel shows the turn's real output.",
  actual: "The panel shows 0 until the turn after.",
  where: ["src/components/corporations/OutputPanel.tsx", "corporation page, Output tab"],
  impact: "Every player who retools sees a false zero for one turn; no money is lost.",
  areas: ["ui", "made-up"],
};

test("an issue renders in the house shape with labels", () => {
  const b = issues.build(good, ["Lord Fixture"]);
  assert.equal(b.title, good.title);
  assert.deepEqual(b.labels, ["bug", "ui"]);
  assert.match(b.body, /^After a sector retool/);
  assert.match(b.body, /## Steps to reproduce\n\n1\. Own a corporation with a factory\n2\. Retool its sector\n3\. Open/);
  assert.match(b.body, /## Expected\n\nThe panel shows/);
  assert.match(b.body, /## Actual\n\nThe panel shows 0/);
  assert.match(b.body, /## Where\n\n- `src\/components\/corporations\/OutputPanel\.tsx`\n- corporation page, Output tab/);
  assert.match(b.body, /## Impact\n\nEvery player/);
  assert.match(b.body, /_Filed by Keir from a player report\._$/);
  assert.doesNotMatch(b.body, /[–—]/);
});

test("an issue refuses names, Discord ids, ticket numbers, internal hosts and thin evidence", () => {
  assert.throws(() => issues.build({ ...good, actual: "Lord Fixture saw 0." }, ["Lord Fixture"]), /Lord Fixture/);
  assert.throws(() => issues.build({ ...good, notes: "Reported by <@123456789012345678>" }), /public/);
  assert.throws(() => issues.build({ ...good, notes: "See ticket 1544." }), /public/);
  assert.throws(() => issues.build({ ...good, notes: "Logs on ops.lakesidegames.net" }), /public/);
  assert.throws(() => issues.build({ ...good, title: "bug: broken" }), /title/);
  assert.throws(() => issues.build({ ...good, actual: "" }), /actual/);
  assert.equal(issues.build({ ...good, kind: "enhancement", expected: "Show last turn's output with a note.", actual: "" }).labels[0], "enhancement");
});

function fixture({ search = [], pr = null, compare = {}, unreadableFiles = false, issueLabels = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-issues-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [],
    taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const calls = [], gh = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => [], call: async (server, toolName, args) => {
    calls.push([server, toolName, args]);
    if (toolName === "railway_status") return { services: [{ service: "AHD Production", status: "SUCCESS" }, { service: "AHD Turn Worker", status: "SUCCESS" }] };
    if (toolName === "support_get") return { number: 9, reporter: { characterName: "Lord Fixture" } };
    if (toolName === "kanban_list") return { items: [] };
    if (toolName === "kanban_add") return { id: 77 };
    return { ok: true };
  } };
  const exec = async (cmd, args) => {
    const a = args.slice(1);
    gh.push(a);
    const method = a[0] === "-X" ? a[1] : "GET";
    const route = a[0] === "-X" ? a[2] : a[0];
    if (route.startsWith("search/issues")) return JSON.stringify({ items: search });
    if (method === "POST" && route === "repos/lakesidegamedev/AHDGame/issues") return JSON.stringify({ number: 501, html_url: "https://github.com/lakesidegamedev/AHDGame/issues/501" });
    if (/^repos\/lakesidegamedev\/AHDGame\/pulls\/\d+\/files/.test(route)) { if (unreadableFiles) throw new Error("fixture unavailable files"); return JSON.stringify((pr?.files || []).map((filename) => ({ filename }))); }
    if (/^repos\/lakesidegamedev\/AHDGame\/pulls\/\d+$/.test(route)) return JSON.stringify(pr);
    if (/^repos\/lakesidegamedev\/AHDGame\/commits\/.+\/status$/.test(route)) {
      const branch = decodeURIComponent(route.split("/commits/")[1].split("/status")[0]);
      return JSON.stringify({ sha: branch, statuses: [{ context: "A House Divided - AHD Production", state: "success" }, { context: "A House Divided - AHD Turn Worker", state: "success" }] });
    }
    if (/^repos\/lakesidegamedev\/AHDGame\/compare\//.test(route)) { const b = decodeURIComponent(route.split("/compare/")[1].split("...")[0]); return JSON.stringify({ status: compare[b] || "diverged" }); }
    if (/^repos\/lakesidegamedev\/AHDGame\/issues\/\d+$/.test(route) && method === "GET") return JSON.stringify({ number: Number(route.split("/").pop()), state: "open", labels: issueLabels, html_url: `https://github.com/lakesidegamedev/AHDGame/issues/${route.split("/").pop()}`, title: "Fixture issue" });
    return JSON.stringify({ ok: true });
  };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: {}, now: () => 5000, exec });
  const job = ledger.createJob("t", { kind: "ticket", role: "support", ticket: 9, repository: "AHDGame", source: { author: "fixtureuser" }, deadline: 9e15 }); job.state = "running";
  return { ledger, broker, calls, gh, job, mcp };
}
const detail = "Output panel reads last turn's cached zero after retool; see OutputPanel.tsx and the retool command.";

test("raise_to_developers files a pretty public issue and links it from the kanban card", async () => {
  const f = fixture();
  const { title, kind, ...issue } = good;
  const r = await f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue, force: false });
  assert.equal(r.issue, 501);
  const post = f.gh.find((a) => a[0] === "-X" && a[1] === "POST" && a[2] === "repos/lakesidegamedev/AHDGame/issues");
  assert.ok(post.includes(`title=${title}`));
  assert.ok(post.includes("labels[]=bug") && post.includes("labels[]=ui"));
  assert.match(post.find((x) => x.startsWith("body=")), /## Expected/);
  const add = f.calls.find((c) => c[1] === "kanban_add");
  assert.equal(add[2].github, "lakesidegamedev/AHDGame#501");
  assert.equal(f.ledger.data.keirIssues[501].ticket, 9);
});

test("raise_to_developers offers a matching open issue instead of filing twice", async () => {
  const f = fixture({ search: [{ number: 480, title: "Factory output panel shows zero after retool", body: "After a sector retool the output panel shows zero output" }] });
  const { title, kind, ...issue } = good;
  const r = await f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue });
  assert.equal(r.raised, false);
  assert.equal(r.issueCandidates[0].number, 480);
  assert.ok(!f.gh.some((a) => a[1] === "POST" && a[2] === "repos/lakesidegamedev/AHDGame/issues"));
  // The player's character name never reaches the public repo.
  await assert.rejects(f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue: { ...issue, actual: "Lord Fixture saw zero output" }, force: true }), /Lord Fixture/);
});

test("a client-specific issue needs the player asked which client before their report joins it", async () => {
  const { title, kind, ...issue } = good;
  const f = fixture({ issueLabels: [{ name: "bug" }, { name: "AHDClient" }] });
  f.job.source = { author: "fixtureuser", content: "I got kicked out of my party and never left." };
  await assert.rejects(f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue, issueNumber: 941 }), /only affects one client[\s\S]*Ask the player which they used/);
  assert.ok(!f.gh.some((a) => a[1] === "POST" && /issues\/941\/comments/.test(a[2])));
  // Once Keir has asked (any ticket post with a client question), it may attach.
  f.ledger.data.clientAsked = { 9: 1 };
  const r = await f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue, issueNumber: 941 });
  assert.equal(r.appended, true);
  // The player naming their client is enough too; an unlabelled issue never asks.
  const g = fixture({ issueLabels: [{ name: "AHDClient" }] });
  g.job.source = { author: "fixtureuser", content: "On the phone app my party vanished." };
  assert.equal((await g.broker.tool(g.job, "raise_to_developers", { title, detail, kind, issue, issueNumber: 941 })).appended, true);
  const h = fixture({ issueLabels: [{ name: "bug" }] });
  assert.equal((await h.broker.tool(h.job, "raise_to_developers", { title, detail, kind, issue, issueNumber: 941 })).appended, true);
});

test("where closes the issues a live Keir PR references; turn code waits for the turn worker", async () => {
  const web = fixture({ pr: { number: 600, merged: true, merge_commit_sha: "abcabcabcabc", head: { ref: "keir/fix-panel" }, body: "Fix the panel.\n\nRefs #501", files: ["src/components/corporations/OutputPanel.tsx"] }, compare: { main: "identical" } });
  web.ledger.data.keirIssues = { 501: { number: 501, state: "open", ticket: 9 } };
  const out = await web.broker.tool(web.job, "github", { action: "where", number: 600 });
  assert.deepEqual(out.issuesClosed, [501]);
  assert.ok(web.gh.some((a) => a[1] === "PATCH" && a[2] === "repos/lakesidegamedev/AHDGame/issues/501" && a.includes("state=closed")));
  assert.equal(web.ledger.data.keirIssues[501].state, "closed");

  const turn = fixture({ pr: { number: 601, merged: true, merge_commit_sha: "defdefdefdef", head: { ref: "keir/fix-turn" }, body: "Refs #502", files: ["src/lib/turn/settle.ts"] }, compare: { main: "identical" } });
  const held = await turn.broker.tool(turn.job, "github", { action: "where", number: 601 });
  assert.equal(held.issuesClosed, undefined, "turn fix is not live until turn-worker/production has it");

  // Someone else's PR saying Refs does not close a human-filed issue.
  const other = fixture({ pr: { number: 602, merged: true, merge_commit_sha: "999999999999", head: { ref: "feat/x" }, body: "Refs #503", files: ["src/components/A.tsx"] }, compare: { main: "identical" } });
  const kept = await other.broker.tool(other.job, "github", { action: "where", number: 602 });
  assert.equal(kept.issuesClosed, undefined);
});

test("public issue guards catch credentials and Unicode reporter names", () => {
  for (const notes of ["Bearer secret-fixture-value", "token=fixture-secret", "github_pat_fixture123456", "https://user:password@example.com/"]) assert.throws(() => issues.build({ ...good, notes }), /public/);
  assert.throws(() => issues.build({ ...good, actual: "Élodie saw zero output" }, ["Élodie"]), /public/);
  assert.throws(() => issues.build({ ...good, actual: "王小明 saw zero output" }, ["王小明"]), /public/);
});

test("an issue retries its missing developer card without filing a duplicate", async () => {
  const f = fixture();
  const original = f.mcp.call;
  let failed = false;
  f.mcp.call = async (...args) => {
    if (args[1] === "kanban_add" && !failed) { failed = true; throw new Error("fixture card failed"); }
    return original(...args);
  };
  const { title, kind, ...issue } = good;
  await assert.rejects(f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue }), /fixture card failed/);
  const first = await f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue });
  assert.equal(first.id, 77);
  const again = await f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue });
  assert.equal(again.id, first.id);
  assert.equal(f.calls.filter((c) => c[1] === "kanban_add").length, 1);
  assert.equal(f.gh.filter((a) => a[0] === "-X" && a[1] === "POST" && a[2] === "repos/lakesidegamedev/AHDGame/issues").length, 1);
});

test("public publication fails closed when reporter lookup fails", async () => {
  const f = fixture();
  f.job.reporterCharacter = { id: null, name: null };
  const { title, kind, ...issue } = good;
  await assert.rejects(f.broker.tool(f.job, "raise_to_developers", { title, detail, kind, issue }), /verified reporter/);
  assert.ok(!f.gh.some((a) => a[0] === "-X"));
});


test("issue closure fails closed on unreadable files and unrelated fix references", async () => {
  const pr = { number: 600, merged: true, merge_commit_sha: "abcabcabcabc", head: { ref: "keir/fix" }, body: "Refs #501", files: ["src/lib/turn/settle.ts"] };
  const unreadable = fixture({ pr, compare: { main: "identical", "turn-worker/production": "identical" }, unreadableFiles: true });
  const out = await unreadable.broker.tool(unreadable.job, "github", { action: "where", number: 600 });
  assert.equal(out.issuesClosed, undefined);
  assert.ok(!unreadable.gh.some((a) => a[0] === "-X" && a[1] === "PATCH"));
  const unrelated = fixture({ pr: { ...pr, files: ["src/components/Panel.tsx"] }, compare: { main: "identical" } });
  await assert.rejects(unrelated.broker.tool(unrelated.job, "github", { action: "close_issue", number: 999, fix: 600 }), /explicitly reference/);
});

test("public issues refuse ticket channel names, private networks and deployment logs", () => {
  for (const notes of ["ticket-bug-1234", "Host 10.0.0.5", "Host 192.168.1.4", "Host 172.20.0.4", "keir.internal.lan", "https://example.railway.app/logs", "mongodb://db/game"]) assert.throws(() => issues.build({ ...good, notes }), /public/, notes);
});

test("concurrent tasks share one public issue and developer card", async () => {
  const f = fixture();
  const other = f.ledger.createJob("other-report", { ...f.job, id: "other-report", effects: {}, issues: [], raisedToDevelopers: [] });
  const { title, kind, ...issue } = good;
  const input = { title, detail, kind, issue };
  const [a, b] = await Promise.all([f.broker.tool(f.job, "raise_to_developers", input), f.broker.tool(other, "raise_to_developers", input)]);
  assert.equal(a.issue, b.issue);
  assert.equal(a.id, b.id);
  assert.equal(f.gh.filter((a) => a[1] === "POST" && a[2] === "repos/lakesidegamedev/AHDGame/issues").length, 1);
});
