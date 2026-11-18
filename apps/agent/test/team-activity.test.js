"use strict";
// Keir 10.4: team_activity and the guard that keeps Keir from closing an issue the team is already fixing (ticket 1852).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTeamActivity } = require("../lib/operator/teamactivity");
const cover = require("../lib/operator/teamcover");
const { setup, CH } = require("./keir10-post.helpers");

const OWNER = "111111111111111111", STAFF = "222222222222222222", BOT = "333333333333333333", PLAYER = "555555555555555555", MOD = "666666666666666666";
const config = { ownerId: OWNER, staffIds: [STAFF, "777777777777777770"], juniorIds: ["777777777777777770"], botId: BOT };
const msg = (id, authorId, content, extra = {}) => ({ id: String(id), author: { id: authorId, username: `u${authorId.slice(-2)}`, bot: authorId === BOT }, content, timestamp: new Date(1e12 + Number(id)).toISOString(), ...extra });
const card = { id: 255428, lane: "now", title: "Tech tree R&D prices are unreachable at real R&D income (ticket 1852)", assigned_to: "claude:coord1117", progress_summary: "started\nfix worker launched", created_at: new Date(Date.now() - 3 * 3600000).toISOString(), detail_excerpt: "" };
const SYSTEMCTL = "claude-team-1117.service loaded active running [systemd-run] /root/misc/archive/x/run-team.sh\nkeir-worker-1852-ab12-1.service loaded active running [systemd-run] /bin/bash -c exec\nssh.service loaded active running OpenBSD Secure Shell server\n";
const files = { "/root/misc/archive/x/run-team.sh": 'exec claude -p "$(cat /root/misc/archive/x/brief-team.md)"', "/root/misc/archive/x/brief-team.md": "Rules: foreground.\n\nPROBLEM (owner, ticket 1852 today): the owner wrote \"I'm fixing\" and Keir kept saying no fix needed.\nBUILD a tool." };

function fakes(over = {}) {
  const calls = [];
  const discord = over.discord || (async (_m, url) => { calls.push(url); return [msg(1, PLAYER, "prices are unreachable"), msg(2, BOT, "Looking into it"), msg(3, OWNER, "I'm fixing this one"), msg(4, PLAYER, "thanks"), msg(5, MOD, "mod note"), msg(6, STAFF, "agreed, patch coming")]; });
  const mcp = over.mcp || { call: async (_s, tool, args) => { calls.push(`${tool}:${args.lane}`); return { items: args.lane === "now" ? [card, { ...card, id: 2, title: "Unrelated work" }] : [] }; } };
  const exec = over.exec || (async (cmd, args) => {
    calls.push(`${cmd} ${args[0]}`);
    if (cmd === "systemctl" && args[0] === "list-units") return SYSTEMCTL;
    if (cmd === "systemctl") return "Tue 2026-11-17 22:46:06 CET\n";
    return JSON.stringify([{ number: 6800, title: "fix(economy): tech tree research prices", body: "Makes tech tree research prices reachable", isDraft: false, headRefName: "fix/x", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }, { number: 1, title: "docs: other", body: "", statusCheckRollup: [] }]);
  });
  const ledger = { data: { codingWorkers: { runs: { a: { unit: "keir-worker-1852-ab12-1", ticket: 1852, title: "Cause of tech tree prices" } } }, jobs: {}, seen: {} } };
  return { calls, tool: createTeamActivity({ config, discord, mcp, exec, ledger, isModerator: (id) => id === MOD, readFile: (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; }, now: over.now || (() => Date.now()) }) };
}

test("all four sections for the 1852 shape: staff, card, workers, PR", async () => {
  const { tool } = fakes();
  const out = await tool.call({ channelId: CH, ticket: 1852 }, { topic: "tech tree research prices" });
  assert.equal(out.covered, true); assert.equal(out.staffSaidFixing, true);
  assert.match(out.report, /owner: I'm fixing this one/);
  assert.match(out.report, /staff: agreed, patch coming/); assert.match(out.report, /mod: mod note/);
  assert.ok(!/prices are unreachable|Looking into it|thanks/.test(out.report.split("\n").filter((l) => l.startsWith("- owner") || l.startsWith("- staff") || l.startsWith("- mod")).join("\n")), "player and bot messages are left out");
  assert.match(out.report, /#255428 \[now\].*claude:coord1117 \| fix worker launched \| 3h old/);
  assert.ok(!/Unrelated work/.test(out.report));
  assert.match(out.report, /claude-team-1117 \(this ticket\) since Tue.*the owner wrote "I'm fixing" and Keir kept saying no fix needed/);
  assert.match(out.report, /keir-worker-1852-ab12-1 \(this ticket\).*Cause of tech tree prices/);
  assert.ok(!/ssh/.test(out.report));
  assert.match(out.report, /AHDGame#6800 \(topic match\).*checks passing/);
  assert.ok(out.report.length <= 2500);
});

test("only staff since Keir's last post count, and only staff roles", async () => {
  const { tool } = fakes();
  const s = await tool._sections.staffMessages({ channelId: CH, ticket: 1 }, 1);
  assert.deepEqual(s.messages.map((m) => m.role), ["owner", "mod", "staff"]);
  const none = fakes({ discord: async () => [msg(1, OWNER, "old"), msg(2, BOT, "answer")] });
  assert.deepEqual((await none.tool._sections.staffMessages({ channelId: CH }, 1)).messages, []);
});

test("an unrelated ticket and topic is not covered", async () => {
  const { tool } = fakes({ discord: async () => [msg(1, PLAYER, "hi")], exec: async (cmd, args) => (cmd === "systemctl" ? (args[0] === "list-units" ? "" : "") : "[]"), mcp: { call: async () => ({ items: [{ ...card, title: "Something else", id: 9 }] }) } });
  const out = await tool.call({ channelId: CH, ticket: 4000 }, {});
  assert.equal(out.covered, false);
  assert.match(out.report, /staff messages since Keir's last post: none/);
});

test("a topic-only match is advisory: it does not set covered", async () => {
  const { tool } = fakes({ discord: async () => [msg(1, PLAYER, "hi")], mcp: { call: async () => ({ items: [] }) } });
  const out = await tool.call({ channelId: CH, ticket: 4000 }, { topic: "tech tree research prices" });
  assert.equal(out.covered, false); assert.equal(out.possibleMatch, true);
  assert.match(out.instruction, /topic only/);
});

test("each section degrades to unavailable and the tool never throws", async () => {
  const boom = async () => { throw new Error("down for the count"); };
  const { tool } = fakes({ discord: boom, mcp: { call: boom }, exec: boom });
  const out = await tool.call({ channelId: CH, ticket: 1852 }, { topic: "tech tree prices" });
  assert.equal(out.covered, false);
  for (const n of [1, 2, 3, 4]) assert.match(out.report, new RegExp(`${n}\\. [^\\n]*unavailable: [^\\n]*down for the count`));
  const bare = await createTeamActivity({}).call({}, {});
  assert.match(bare.report, /team activity/);
});

test("results are cached for 60 seconds per ticket and topic", async () => {
  let t = 1000; const f = fakes({ now: () => t });
  await f.tool.call({ channelId: CH }, { ticket: 1852 }); const n = f.calls.length;
  await f.tool.call({ channelId: CH }, { ticket: 1852 }); assert.equal(f.calls.length, n, "second call is cached");
  await f.tool.call({ channelId: CH }, { ticket: 1852, topic: "other words here" }); assert.ok(f.calls.length > n, "another topic is another entry");
  t += 61000; const m = f.calls.length;
  await f.tool.call({ channelId: CH }, { ticket: 1852 }); assert.ok(f.calls.length > m, "expired");
});

test("the report is capped near 2,500 characters", async () => {
  const long = "x".repeat(400);
  const { tool } = fakes({ discord: async () => Array.from({ length: 20 }, (_, i) => msg(10 + i, OWNER, `fixing ${long}`)), mcp: { call: async () => ({ items: Array.from({ length: 9 }, (_, i) => ({ ...card, id: i, title: `ticket 1852 ${long}` })) }) } });
  const out = await tool.call({ channelId: CH, ticket: 1852 }, {});
  assert.ok(out.report.length <= 2500);
});

test("the guard: only a team-covered conclusion is refused", () => {
  assert.equal(cover.conclusionOf("Answered: no fix needed, this works as designed."), "no_fix");
  assert.equal(cover.conclusionOf("Correction: I was wrong earlier about the cap."), "correction");
  assert.equal(cover.conclusionOf("A fix is in progress."), null);
  assert.equal(cover.refusal("no_fix", { covered: false }), null);
  assert.equal(cover.refusal("no_fix", null), null);
  assert.equal(cover.refusal(null, { covered: true }), null);
  assert.match(cover.refusal("no_fix", { covered: true, staffSaidFixing: true }), /staff said in the channel/);
  assert.match(cover.refusal("correction", { covered: true }), /a card, a worker or a pull request/);
});

function brokerFixture(over) {
  const f = setup({ discord: async (_m, url) => (String(url).includes("/guilds/") ? [{ id: CH, name: "ticket-bug-fixture-123" }] : over.messages || []),
    exec: async (cmd, args) => (cmd === "systemctl" ? "" : "[]"),
    call: async (_s, tool, args) => (tool === "kanban_list" ? { items: over.cards || [] } : { ok: true, id: "card-9", hits: [], delivery: { posted: true, delivery: { status: "posted" } } }) });
  f.ledger.data.statusCards = f.ledger.data.statusCards || {};
  f.playerWrote(5); return f;
}

test("broker: a no-fix-needed post is refused while a card covers the ticket, and allowed once nothing does", async () => {
  const text = "This works as designed, so no fix is needed on our side. The research cost is set by your lab output each turn.";
  const covered = brokerFixture({ cards: [{ ...card, title: "Prices (ticket 123)" }] });
  await assert.rejects(covered.broker.tool(covered.job, "channel_reply", { message: text }), /fix is in progress and who is on it/);
  assert.equal(covered.posts().length, 0);
  assert.equal(covered.audits("team_cover_refused").length, 1);
  const free = brokerFixture({ cards: [] });
  await free.broker.tool(free.job, "channel_reply", { message: text }).catch((e) => assert.doesNotMatch(e.message, /fix is in progress and who is on it/));
});

test("broker: staff saying they are fixing it refuses a correction, at most three times per ticket", async () => {
  const f = brokerFixture({ messages: [msg(2, OWNER, "I'm fixing this now")] });
  f.broker.tool; const text = "Correction: I was wrong earlier, the cap is not what I said.";
  for (let i = 0; i < 3; i++) await assert.rejects(f.broker.tool(f.job, "channel_reply", { message: text }), /fix is in progress and who is on it/);
  await f.broker.tool(f.job, "channel_reply", { message: text }).catch((e) => assert.doesNotMatch(e.message, /fix is in progress and who is on it/));
  assert.equal(f.audits("team_cover_refused").length, 3);
});

test("broker: the answered card stage is refused while a card covers the ticket", async () => {
  const f = brokerFixture({ cards: [{ ...card, title: "Prices (ticket 123)" }] });
  f.job.investigatedReads = 3;
  await assert.rejects(f.broker.tool(f.job, "status_card", { items: [{ name: "Research prices", stage: "answered" }] }), /fix is in progress and who is on it/);
  assert.equal(f.audits("team_cover_refused").length, 1);
  const free = brokerFixture({ cards: [] }); free.job.investigatedReads = 3;
  await free.broker.tool(free.job, "status_card", { items: [{ name: "Research prices", stage: "answered" }] }).catch((e) => assert.doesNotMatch(e.message, /fix is in progress and who is on it/));
  assert.equal(free.audits("team_cover_refused").length, 0);
});

test("broker: a misrouted staff-side team_activity lookup returns the native result", async () => {
  const f = brokerFixture({ cards: [{ ...card, title: "Prices (ticket 123)" }] });
  const out = await f.broker.tool(f.job, "team_activity", {});
  assert.equal(out.covered, true); assert.match(out.report, /#255428/);
  const aliased = await f.broker.tool(f.job, "read_tool", { server: "ops-knowledge", tool: "team_activity", args: {} });
  assert.deepEqual(aliased, out);
});

test("the rule is in both prompts and in the ticket playbooks", () => {
  const fs = require("node:fs"), path = require("node:path");
  for (const f of ["KEIR.md", "KEIR-CORE.md"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.match(text, /do not say no fix is needed, do not argue the rule and do not post a correction/, f);
    assert.match(text, /team_activity/, f);
  }
  assert.match(fs.readFileSync(path.join(__dirname, "..", "KEIR.md"), "utf8"), /\| Team activity \| team_activity:/);
  const { PLAYBOOKS, facts } = require("../lib/operator/playbooks");
  for (const kind of ["bug_report", "mechanics_question", "question", "data_repair"]) {
    const j = { id: "t1", ticket: 1, tags: { kind }, channelId: "c" };
    const steps = PLAYBOOKS[kind](facts(j, { jobs: { t1: j } }));
    const step = steps.find((s) => s.id === "team_covered");
    assert.ok(step, kind); assert.equal(step.required, false); assert.equal(step.done, false);
    j.teamActivityAt = 5;
    assert.equal(PLAYBOOKS[kind](facts(j, { jobs: { t1: j } })).find((s) => s.id === "team_covered").done, true);
  }
});
