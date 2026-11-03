"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPrMention, MENTION } = require("../lib/operator/prmention");

const REPO = "lakesidegamedev/AHDGame";
function setup({ role = "write", body = "@keir-bot can you check the bond math?", login = "HyawiiGithub", state = "open" } = {}) {
  const data = { jobs: {}, seen: {} }, audits = [], calls = [];
  const ledger = { data, save() {}, audit: (k, v) => audits.push([k, v]), createJob(key, fields) { const job = { id: `j${Object.keys(data.jobs).length + 1}`, state: "queued", ...fields }; data.jobs[job.id] = job; data.seen[key] = job.id; return job; } };
  const gh = async (args, opts) => {
    calls.push([args, opts]);
    const route = args.filter((a) => !a.startsWith("-")).at(-1);
    if (/issues\/comments\/77$/.test(route)) return { body, user: { login }, issue_url: `https://api.github.com/repos/${REPO}/issues/5400` };
    if (/permission$/.test(route)) return { role_name: role };
    if (/pulls\/5400$/.test(route)) return { state, title: "fix: bonds", head: { sha: "abcdef1234567890" } };
    if (/reactions$/.test(args.find((a) => /reactions$/.test(a)) || "")) return {};
    throw new Error("unexpected " + route);
  };
  return { m: createPrMention({ ledger, config: { prMentionEnabled: true }, gh }), data, audits, calls };
}
const ask = { repository: REPO, number: 5400, commentId: 77, kind: "issue_comment" };

test("the mention pattern matches the handle and plain Keir, not other names", () => {
  for (const s of ["@keir-bot please", "@Keir review", "hey @KEIR-BOT", "(@keir)"]) assert.ok(MENTION.test(s), s);
  for (const s of ["@keirbot", "@keir-botty", "keir please", "email@keir.dev", "@keir_x", "org/@keir"]) assert.ok(!MENTION.test(s), s);
});

test("a writer's mention queues one narrow review task per PR commit and acknowledges it", async () => {
  const { m, data, calls } = setup();
  const r = await m.handle(ask);
  const job = data.jobs[r.task];
  assert.equal(job.role, "support"); assert.equal(job.kind, "command"); assert.equal(job.prMention.number, 5400);
  assert.match(job.source.content, /Verdict: looks good/); assert.match(job.source.content, /not instructions/);
  assert.ok(calls.some(([a, o]) => a.some((x) => /reactions$/.test(x)) && o?.asReviewer), "eyes reaction as keir-bot");
  assert.match((await m.handle(ask)).skipped, /already reviewed/);
});

test("readers, strangers, keir-bot itself, closed PRs and other repositories are refused", async () => {
  assert.match((await setup({ role: "read" }).m.handle(ask)).skipped, /cannot push/);
  assert.match((await setup({ role: "triage" }).m.handle(ask)).skipped, /cannot push/);
  assert.match((await setup({ login: "keir-bot" }).m.handle(ask)).skipped, /own comment/);
  assert.match((await setup({ body: "looks fine" }).m.handle(ask)).skipped, /no mention/);
  assert.match((await setup({ state: "closed" }).m.handle(ask)).skipped, /not open/);
  assert.match((await setup().m.handle({ ...ask, number: 5401 })).skipped, /not on that pull request/);
  assert.match((await setup().m.handle({ ...ask, repository: "someone/else" })).skipped, /not the game repository/);
});
