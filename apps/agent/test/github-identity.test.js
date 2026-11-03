"use strict";
// Keir 8: what Keir authors on GitHub shows as the keir-bot account; merges and reads stay on the box login.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const l = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: [], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000,
    maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {}, watched: () => false, ...extra };
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env || null });
    const route = args.filter((a) => !a.startsWith("-") && a !== "api" && !/^[a-z_\[\]]+=/.test(a)).at(-1);
    if (/search\/issues/.test(route)) return JSON.stringify({ items: [] });
    if (/repos\/lakesidegamedev\/AHDGame\/issues$/.test(route)) return JSON.stringify({ number: 4200, html_url: "https://github.com/lakesidegamedev/AHDGame/issues/4200" });
    return JSON.stringify({});
  };
  const mcp = { servers: () => [], list: async () => [], call: async (server, tool) => (tool === "kanban_list" ? [] : tool === "kanban_add" ? { id: 900 } : {}) };
  const b = createBroker({ ledger: l, config, mcp, discord: async () => [], sandbox: {}, now: () => 1_800_000_000_000, exec });
  const job = l.createJob("cmd:x", { kind: "command", role: "owner", actorId: "111111111111111111", repository: "AHDGame", deadline: 9e15, source: {} });
  job.state = "running";
  return { b, calls, job };
}
const issue = { title: "Wallet balance with sub-cent fractions unbalances line of credit servicing", detail: "Servicing fails the banking phase every turn since 195 with unbalanced cash flows.", kind: "bug",
  issue: { summary: "Line of credit servicing aborts the banking turn phase each turn.", expected: "Servicing balances to the cent.", actual: "The phase aborts with unbalanced cash flows.", impact: "Banking and credit lines stop updating for everyone." } };

test("with a Keir token, the issue it files is created as keir-bot and its searches stay on the box login", async (t) => {
  const f = fixture(t, { githubReviewerToken: "tok-bot" });
  const r = await f.b.tool(f.job, "raise_to_developers", issue);
  assert.equal(r.issue, 4200);
  const create = f.calls.find((c) => c.args.includes("POST") && c.args.some((a) => /repos\/lakesidegamedev\/AHDGame\/issues$/.test(a)));
  assert.ok(create, "an issue was created");
  assert.equal(create.env?.GH_TOKEN, "tok-bot", "authored as Keir");
  const reads = f.calls.filter((c) => c.args.some((a) => /search\/issues/.test(a)));
  assert.ok(reads.length > 0 && reads.every((c) => c.env === null), "reads keep the box login");
});

test("without a Keir token nothing changes: every call keeps the box login", async (t) => {
  const f = fixture(t);
  await f.b.tool(f.job, "raise_to_developers", issue);
  assert.ok(f.calls.length > 0 && f.calls.every((c) => c.env === null));
});

test("merges, branch deletion and reads are never wrapped in the Keir identity (source contract)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/broker.js"), "utf8").split("\n");
  const wrapped = src.filter((l) => /asKeir|apiKeir|keirGit/.test(l) && !/^\s*(const|\/\/)/.test(l));
  for (const line of wrapped) assert.ok(!/\/merge|DELETE|git\/refs/.test(line), `Keir identity on a merge or delete: ${line.trim().slice(0, 120)}`);
  assert.ok(wrapped.length >= 8, "the authored writes are wrapped");
});
