"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const hk = require("../lib/operator/prhousekeeping");

const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const PROBE = "/fixture/ahd-deployed-sha.sh";
process.env.KEIR_DEPLOYED_SHA_CMD = PROBE;
const R = "repos/lakesidegamedev/AHDGame";

// prs: { number: pull object }. compare: { branch: status } for any sha.
function fixture({ prs = {}, compare = {}, issue = { state: "open", labels: [] } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-hk-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [],
    taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false };
  const gh = [], comments = [];
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => [], call: async (s, t) => (t === "kanban_list" ? { items: [] } : t === "kanban_add" ? { id: 77 } : { ok: true }) };
  const exec = async (cmd, args) => {
    if (cmd === PROBE) return `${"a".repeat(40)}\n`;
    const a = args.slice(1); gh.push(a);
    const method = a[0] === "-X" ? a[1] : "GET", route = a[0] === "-X" ? a[2] : a[0];
    const m = new RegExp(`^${R}/pulls/(\\d+)$`).exec(route);
    if (m && method === "GET") return JSON.stringify(prs[m[1]] || null);
    if (new RegExp(`^${R}/pulls/\\d+/files`).test(route)) return JSON.stringify([{ filename: "src/components/A.tsx" }]);
    if (route.startsWith(`${R}/compare/`)) { const raw = decodeURIComponent(route.split("/compare/")[1].split("...")[0]); const base = raw === "a".repeat(40) ? "main" : raw === "b".repeat(40) ? "turn-worker/production" : raw; return JSON.stringify({ status: compare[base] || "diverged" }); }
    if (new RegExp(`^${R}/deployments`).test(route)) return JSON.stringify([]);
    if (new RegExp(`^${R}/issues/\\d+/comments\\?`).test(route) && method === "GET") return JSON.stringify(comments.map((body) => ({ body })));
    if (new RegExp(`^${R}/issues/\\d+/comments$`).test(route) && method === "POST") { comments.push(a.find((x) => x.startsWith("body=")).slice(5)); return JSON.stringify({}); }
    if (new RegExp(`^${R}/issues/\\d+$`).test(route) && method === "GET") return JSON.stringify({ number: Number(route.split("/").pop()), ...issue, updated_at: "2026-11-17T10:00:00Z" });
    return JSON.stringify({ ok: true });
  };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: {}, now: () => 5000, exec });
  const job = (kind, extra = {}) => { const j = ledger.createJob(`t-${kind}-${Math.random()}`, { kind, role: "support", repository: "AHDGame", source: { author: "x" }, deadline: 9e15, ...extra }); j.state = "running"; return j; };
  return { ledger, broker, gh, comments, job };
}
const merged = (n, body, extra = {}) => ({ number: n, state: "closed", merged: true, merge_commit_sha: `${String(n).padStart(12, "c")}`, head: { ref: "keir/fix", sha: "f".repeat(40) }, body, user: { login: "keir-bot", type: "User" }, ...extra });
const open = (n, login, ref, body = "", extra = {}) => ({ number: n, state: "open", merged: false, head: { ref, sha: "e".repeat(40) }, body, user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" }, ...extra });
const patched = (f, route) => f.gh.some((a) => a[0] === "-X" && a[1] === "PATCH" && a[2] === `${R}/${route}` && a.includes("state=closed"));

test("close_issue works from engineering, watch, finding and coding lanes, not for players", async () => {
  for (const kind of ["finding", "coding", "ticket", "command"]) {
    const f = fixture({ prs: { 6716: merged(6716, "Fixes #6717", { files: [] }) }, compare: { main: "identical" } });
    const j = f.job(kind, { ...(kind === "command" ? { role: "owner", actorId: "111111111111111111", source: { authorId: "111111111111111111" } } : {}) });
    const r = await f.broker.tool(j, "github", { action: "close_issue", number: 6717, fix: 6716 });
    assert.equal(r.closed, true, kind);
    assert.ok(patched(f, "issues/6717"), kind);
  }
  const f = fixture({ prs: { 6716: merged(6716, "Fixes #6717") }, compare: { main: "identical" } });
  await assert.rejects(f.broker.tool(f.job("ticket", { role: "player" }), "github", { action: "close_issue", number: 6717, fix: 6716 }), /players|staff-side/);
});

test("close_issue still refuses when the fix is not live", async () => {
  const f = fixture({ prs: { 6716: merged(6716, "Fixes #6717") }, compare: {} });
  const r = await f.broker.tool(f.job("finding"), "github", { action: "close_issue", number: 6717, fix: 6716 });
  assert.equal(r.closed, false);
  assert.ok(!patched(f, "issues/6717"));
});

test("close closes a superseded bot PR with the superseding PR named, and deletes only keir/ branches", async () => {
  const f = fixture({ prs: { 6720: open(6720, "keir-bot", "keir/old", "Fixes #6717"), 6716: merged(6716, "Fixes #6717") } });
  const r = await f.broker.tool(f.job("finding"), "github", { action: "close", number: 6720, supersededBy: 6716 });
  assert.equal(r.closed, true); assert.equal(r.branchDeleted, true);
  assert.ok(patched(f, "pulls/6720"));
  assert.match(f.comments.join("\n"), /#6716/);
  assert.ok(f.gh.some((a) => a[1] === "DELETE" && a[2] === `${R}/git/refs/heads/keir/old`));
});

test("close of another agent's PR needs coverage and keeps its branch", async () => {
  const f = fixture({ prs: { 6721: open(6721, "agent-helper[bot]", "agent/x", "Refs #6717"), 6716: merged(6716, "Fixes #6717") } });
  const r = await f.broker.tool(f.job("ticket"), "github", { action: "close", number: 6721, supersededBy: 6716 });
  assert.equal(r.closed, true); assert.equal(r.branchDeleted, false);
  assert.ok(!f.gh.some((a) => a[1] === "DELETE"));
  // no shared issue and not contained: refused
  const g = fixture({ prs: { 6722: open(6722, "agent-helper[bot]", "agent/y", "Refs #1"), 6716: merged(6716, "Fixes #2") } });
  await assert.rejects(g.broker.tool(g.job("ticket"), "github", { action: "close", number: 6722, supersededBy: 6716 }), /does not cover/);
  // contained in main: allowed
  const h = fixture({ prs: { 6723: open(6723, "agent-helper[bot]", "agent/z", "Refs #1"), 6716: merged(6716, "Fixes #2") }, compare: { main: "behind" } });
  assert.equal((await h.broker.tool(h.job("ticket"), "github", { action: "close", number: 6723, supersededBy: 6716 })).closed, true);
});

test("close never touches a person's PR or an unmerged superseder", async () => {
  const f = fixture({ prs: { 6730: open(6730, "arle-bina", "feature/x", "Fixes #6717"), 6716: merged(6716, "Fixes #6717"), 6731: open(6731, "keir-bot", "keir/n", "Fixes #6717"), 6732: open(6732, "someone", "keir/n2", "") } });
  await assert.rejects(f.broker.tool(f.job("finding"), "github", { action: "close", number: 6730, supersededBy: 6716 }), /never a person/);
  await assert.rejects(f.broker.tool(f.job("finding"), "github", { action: "close", number: 6731, supersededBy: 6732 }), /not merged/);
  assert.ok(!patched(f, "pulls/6730"));
  await assert.rejects(f.broker.tool(f.job("ticket", { role: "player" }), "github", { action: "close", number: 6731, supersededBy: 6716 }));
  // a non-keir bot PR with no superseder is refused
  const g = fixture({ prs: { 6740: open(6740, "agent-helper[bot]", "agent/q", "") } });
  await assert.rejects(g.broker.tool(g.job("finding"), "github", { action: "close", number: 6740 }), /supersededBy/);
});

test("Keir's own stale PR closes without a superseder", async () => {
  const f = fixture({ prs: { 6750: open(6750, "keir-bot", "keir/stale", "") } });
  assert.equal((await f.broker.tool(f.job("finding"), "github", { action: "close", number: 6750, comment: "Stale, closing." })).closed, true);
});

test("raise_to_developers refuses GitHub housekeeping and points at the github tool", async () => {
  const f = fixture();
  const j = f.job("finding", { ticket: 9 });
  const base = { kind: "question", title: "Close superseded PR 6716 and two done issues", detail: "PR 6716 is superseded by the merged fix, so close superseded PR 6716 and close issue 6717 now that the fix is live." };
  await assert.rejects(f.broker.tool(j, "raise_to_developers", base), /github tool/);
  await assert.rejects(f.broker.tool(j, "raise_to_developers", { ...base, title: "Delete the stale branch keir/old", detail: "Please delete the branch keir/old which is fully merged into development already." }), /github tool/);
  await assert.rejects(f.broker.tool(j, "raise_to_developers", { ...base, title: "Re-run the failed check on 6700", detail: "The verify check was flaky; re-run the failed check job on that pull request please." }), /github tool/);
});

test("housekeeping detector", () => {
  assert.ok(hk.housekeepingRequest("Close issue 6717 now the fix is live"));
  assert.ok(hk.housekeepingRequest("close the superseded PR"));
  assert.equal(hk.housekeepingRequest("Players cannot see the output panel after a retool"), null);
  assert.equal(hk.botAuthor({ login: "arle-bina", type: "User" }), false);
  assert.equal(hk.botAuthor({ login: "keir-bot", type: "User" }), true);
  assert.equal(hk.botAuthor({ login: "x[bot]", type: "Bot" }), true);
});

test("finish with needsOwner cannot ask the owner to do GitHub housekeeping", async () => {
  const f = fixture();
  await assert.rejects(f.broker.tool(f.job("ticket"), "finish", { state: "blocked", needsOwner: true, summary: "Close issue 6717 on GitHub, the fix is live." }), /github tool/);
});

test("a finding's prepared heal is an Approve / Decline decision, not a text DM", async () => {
  const f = fixture();
  const j = f.job("finding");
  const r = await f.broker.tool(j, "request_heal", { kind: "repair", reason: "Prepared repair for stuck rows", spec: { description: "fix rows" } }).catch((e) => ({ error: String(e.message) }));
  const decisions = Object.values(f.ledger.data.decisions || {});
  if (!r.error) { assert.equal(decisions.length, 1); assert.equal(decisions[0].type, "approval"); }
  assert.ok(!Object.values(f.ledger.data.outbox || {}).some((o) => /Prepared repair from Keir monitoring/.test(o.content || "")));
});
