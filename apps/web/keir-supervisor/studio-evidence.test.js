"use strict";
// Studio evidence for the private supervisor: one numbered support record and
// the phone card's game health facts, both read-only. Tool results here are
// synthetic, shaped like the real support_get / engine_health / mf_status /
// gc_status output, with secrets, host paths and URLs planted to prove they
// never pass through. Nothing here is served as a live feature.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStudioEvidence, summariseTicket } = require("./studio-evidence");
const { createSupervisor, TOOLS } = require("./supervisor");

const NOW = Date.parse("2026-11-20T12:00:00Z");
const ROOM = "1300000000000000001", OLD_ROOM = "1300000000000000002", OTHER = "1300000000000000099", CARD = "1400000000000000001";
const iso = (minutes) => new Date(NOW - minutes * 60000).toISOString();

function ticket(over = {}) {
  return {
    kind: "ticket", number: 1867, title: "Pension payout missing", category: "gameplay", status: "resolved",
    conversation: { channelId: ROOM, previousChannelId: null, reopenRequestId: null, reopenedAt: null },
    description: "My pension did not pay out this turn.", reporter: "PlayerOne", images: ["https://cdn.discordapp.com/attachments/1/2/secret.png?ex=1"],
    messages: ["Any update?", "Still missing."],
    statusHistory: [
      { status: "in_progress", at: iso(100), by: "keir", source: "mcp" },
      { status: "resolved", at: iso(10), by: "staff-one", source: "mcp", note: "resolution receipt recorded" },
    ],
    publicUpdates: [
      { key: "ack", kind: "opening", deliveryMode: "card", message: "We are looking into it.", at: iso(110), delivery: { status: "posted", attempts: 1, postedAt: iso(110), messageId: CARD, channelId: ROOM } },
      { key: "u1", kind: "update", deliveryMode: "reply", message: "Found the cause.", at: iso(90), delivery: { status: "posted", attempts: 1, postedAt: iso(90), messageId: "1500000000000000001", channelId: ROOM } },
      { key: "u2", kind: "heal", deliveryMode: "reply", message: "Your missing payout has been restored.", at: iso(60), delivery: { status: "posted", attempts: 1, postedAt: iso(60), messageId: "1500000000000000002", channelId: OTHER } },
      { key: "u3", kind: "production", deliveryMode: "reply", message: "The fix is live.", at: iso(30), delivery: { status: "failed", attempts: 2, at: iso(30), error: "Missing Access" } },
      { key: "u4", kind: "update", deliveryMode: "reply", message: "One more thing.", at: iso(20), delivery: { status: "pending", attempts: 1, at: iso(20) } },
    ],
    resolution: { message: "We restored your payout.", actions: ["Restored the missing pension payout"], followUp: null, source: "agent", createdAt: iso(10), resolvedAt: iso(10), closedBy: "staff-one",
      delivery: { status: "pending" }, channelDelivery: { status: "posted", attempts: 1, postedAt: iso(9), messageId: "1500000000000000003", channelId: ROOM } },
    resolutionAttribution: { agent: "keir", jobId: "job-77", evidence: "verified answer", recordedBy: "staff-one", recordedAt: iso(10) },
    copyRefusals: [{ at: iso(95), tool: "support_public_update", by: "keir", match: "internal-host.example:9735", kind: "an internal host" }],
    evidenceDeliveries: [],
    intake: { cardMessageId: CARD, receiptUrl: "https://example.test/receipt/secret-token" },
    fixSessionId: "fix-123", trackerItemId: null, secretField: "do-not-leak", createdAt: iso(120), updatedAt: iso(9),
    assessment: { summary: "internal triage do-not-leak" },
    ...over,
  };
}

function configFile(servers = ["support", "engine", "metroforge", "grand-century"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-evidence-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s, i) => [s, { url: `http://127.0.0.1:${9700 + i}/mcp`, headers: { "X-Fixture": "fixture-credential" } }])) }));
  return file;
}

const engine = () => ({ turn: 241, year: 1994, paused: false, checkedAt: new Date(NOW - 5000).toISOString(), lastTurn: { success: true, durationMs: 283180, warnings: 2 }, schedule: { next: "2026-11-20T18:00:00Z" }, secretField: "do-not-leak" });
const mf = () => ({ web: { repo: "/srv/private/metroforge", sha: "a1b2c3d4e5f6a7b8", committedAt: "2026-11-19T10:00:00Z", subject: "fix: Alice's payout bug", branch: "master" },
  preview: { url: "http://127.0.0.1:3402", reachable: true, ok: true }, api: { url: "http://127.0.0.1:3403/health", reachable: false, error: "connect ECONNREFUSED /srv/private" },
  latestRelease: { tag: "v0.9.1", publishedAt: "2026-11-01T00:00:00Z", url: "https://example.test/rel" } });
const cities = () => ({ dir: "/srv/private/cities", cities: [{ key: "nyc", label: "New York", real: true }, { key: "gen", label: "Genville", real: false }] });
const gc = () => ({ repo: { path: "/srv/private/gc", sha: "0123456789abcdef", committedAt: "2026-11-17T00:00:00Z", branch: "master", subject: "secret subject" }, live: { url: "https://example.test/gc", reachable: true, ok: true, indexChunk: "assets/index-AbC_123.js" }, latestRelease: null });

function fakeCall(over = {}) {
  const calls = [];
  const tools = { "support/support_get": () => ticket(), "engine/engine_health": engine, "metroforge/mf_status": mf, "metroforge/mf_cities": cities, "grand-century/gc_status": gc, ...over };
  const mcpCall = async (server, tool, args, options) => {
    calls.push({ server, tool, args, options });
    const f = tools[`${server}/${tool}`];
    if (!f) throw new Error(`unknown ${tool}`);
    return f(args);
  };
  return { calls, mcpCall };
}

const make = (mcpCall, configPath = configFile(), extra = {}) => createStudioEvidence({ mcpCall, configPath, now: () => NOW, ...extra });

test("a numbered ticket reads exactly one support record and returns its chronology with actors kept apart", async () => {
  const { calls, mcpCall } = fakeCall();
  const cfg = configFile();
  const out = await make(mcpCall, cfg).ticket(1867);
  assert.deepEqual(calls.map((c) => [c.server, c.tool, c.args]), [["support", "support_get", { kind: "ticket", number: 1867 }]]);
  assert.equal(calls[0].options.configPath, cfg);
  assert.equal(out.state, "read");
  assert.equal(out.ticket, 1867);
  const first = out.timeline[0];
  assert.deepEqual([first.kind, first.actor, first.text], ["player_ask", "player", "My pension did not pay out this turn."]);
  const times = out.timeline.map((e) => Date.parse(e.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "timeline is chronological");
  const changes = out.timeline.filter((e) => e.kind === "status_change").map((e) => [e.status, e.actor]);
  assert.deepEqual(changes, [["in_progress", "keir"], ["resolved", "staff-one"]]);
  assert.deepEqual([out.status.current, out.status.lastSetBy], ["resolved", "staff-one"]);
  assert.match(out.status.meaning, /not proof/);
  // Replies carry no sender in the record, so none is invented.
  assert.ok(out.timeline.filter((e) => e.kind === "player_update").every((e) => /^not recorded/.test(e.actor)));
  const credit = out.timeline.find((e) => e.kind === "resolution_credit");
  assert.deepEqual([credit.creditedTo, credit.actor], ["keir", "staff-one"]);
  const refusal = out.timeline.find((e) => e.kind === "refused_post");
  assert.deepEqual([refusal.actor, refusal.reason], ["keir", "an internal host"]);
  assert.match(out.otherMessages.note, /without author/);
});

test("only a Discord message in this ticket's own channel counts as delivered", async () => {
  const out = await make(fakeCall().mcpCall).ticket(1867);
  const byText = Object.fromEntries(out.timeline.filter((e) => e.kind === "player_update").map((e) => [e.text, e.delivery]));
  assert.equal(byText["We are looking into it."].delivered, false);
  assert.match(byText["We are looking into it."].where, /intake card/);
  assert.equal(byText["Found the cause."].delivered, true);
  assert.equal(byText["Found the cause."].channel, "this ticket's channel");
  assert.equal(byText["Your missing payout has been restored."].delivered, false);
  assert.match(byText["Your missing payout has been restored."].where, /not this ticket's channel/);
  assert.equal(byText["The fix is live."].delivered, false);
  assert.match(byText["The fix is live."].where, /failed \(Missing Access\)/);
  assert.equal(byText["One more thing."].delivered, false);
  assert.match(byText["One more thing."].where, /pending/);
  assert.deepEqual([out.replies.recorded, out.replies.deliveredToThisTicket, out.replies.firstVerifiedReplyAt], [5, 1, iso(90)]);
  const resolution = out.timeline.find((e) => e.kind === "resolution_receipt");
  assert.equal(resolution.channelDelivery.delivered, true);
  assert.equal(resolution.actor, "staff-one");

  const noId = summariseTicket(ticket({ publicUpdates: [{ kind: "update", deliveryMode: "reply", message: "x", at: iso(5), delivery: { status: "posted", postedAt: iso(5), channelId: ROOM } }] }), 1867, NOW);
  assert.equal(noId.timeline.find((e) => e.kind === "player_update").delivery.delivered, false);
  const reopened = summariseTicket(ticket({ conversation: { channelId: ROOM, previousChannelId: OLD_ROOM, reopenedAt: iso(50) },
    publicUpdates: [{ kind: "update", deliveryMode: "reply", message: "old room", at: iso(80), delivery: { status: "posted", postedAt: iso(80), messageId: "1500000000000000009", channelId: OLD_ROOM } }] }), 1867, NOW);
  const old = reopened.timeline.find((e) => e.kind === "player_update").delivery;
  assert.equal(old.delivered, true);
  assert.match(old.channel, /earlier channel/);
  assert.equal(reopened.replies.firstVerifiedReplyAt, null, "a reply before the reopen does not answer the reopened ticket");
});

test("a post, status or resolution never counts as proof the game changed", async () => {
  const out = await make(fakeCall().mcpCall).ticket(1867);
  assert.equal(out.actionProof.gameChangeProven, false);
  assert.match(out.actionProof.statement, /cannot prove the game was changed/);
  const said = out.actionProof.claimsOfChange.map((c) => [c.said, c.delivered]);
  assert.deepEqual(said, [["player update (heal)", false], ["player update (production)", false], ["resolution receipt action", undefined]]);
  assert.deepEqual(out.actionProof.pointers, { fixSessionId: "fix-123" });
});

test("nothing outside the allow-list leaves the ticket read", async () => {
  const dump = JSON.stringify(await make(fakeCall().mcpCall).ticket(1867));
  for (const leak of ["do-not-leak", "internal-host.example", "secret.png", "secret-token", "fixture-credential", "internal triage"]) assert.ok(!dump.includes(leak), `leaked ${leak}`);
});

test("a failed read or a wrong shape is described as unavailable, without the error text", async () => {
  const fail = await make(fakeCall({ "support/support_get": () => { throw new Error("connect ECONNREFUSED /srv/private/mongo"); } }).mcpCall).ticket(1867);
  assert.equal(fail.state, "unavailable");
  assert.ok(!JSON.stringify(fail).includes("/srv/private"));
  assert.match(fail.note, /says nothing about what happened/);
  for (const bad of [ticket({ number: 1868 }), { ...ticket(), kind: "suggestion" }, [ticket()], null, "text", ticket({ status: 5 }), ticket({ createdAt: "not a date" })]) {
    const out = await make(fakeCall({ "support/support_get": () => bad }).mcpCall).ticket(1867);
    assert.equal(out.state, "unavailable", JSON.stringify(bad)?.slice(0, 60));
    assert.equal(out.timeline, undefined);
  }
  const odd = await make(fakeCall({ "support/support_get": () => ticket({ statusHistory: "garbage", publicUpdates: { a: 1 } }) }).mcpCall).ticket(1867);
  assert.equal(odd.state, "read");
  assert.ok(odd.gaps.some((g) => /statusHistory/.test(g)) && odd.gaps.some((g) => /publicUpdates/.test(g)));
  const hung = await make(() => new Promise(resolve => setTimeout(resolve, 250)), configFile(), { ticketTimeoutMs: 50 }).ticket(1867);
  assert.equal(hung.state, "unavailable");
});

test("ticket numbers are validated before any read", async () => {
  const { calls, mcpCall } = fakeCall();
  const ev = make(mcpCall);
  for (const n of [0, -1, 1.5, "1867; drop", 1e12, null]) await assert.rejects(ev.ticket(n), /whole ticket number/);
  assert.equal(calls.length, 0);
});

test("game health returns the phone card facts for each game, without raw output or ticket rows", async () => {
  const { calls, mcpCall } = fakeCall();
  const out = await make(mcpCall).games();
  assert.deepEqual(out.games.map((g) => [g.id, g.state]), [["ahd", "live"], ["metroforge", "live"], ["grand-century", "live"]]);
  assert.deepEqual(calls.map((c) => `${c.server}/${c.tool}`).sort(), ["engine/engine_health", "grand-century/gc_status", "metroforge/mf_cities", "metroforge/mf_status"]);
  assert.ok(calls.every((c) => JSON.stringify(c.args) === "{}"));
  const ahd = out.games[0].reads[0].facts.map((f) => `${f.label}=${f.value}`);
  assert.deepEqual(ahd, ["Turn=241", "Year=1994", "Game=Running", "Latest turn=Succeeded in 283 s", "Warnings on latest turn=2", "Next turn due (UTC)=2026-11-20 18:00"]);
  assert.ok(out.games.every((g) => g.capabilities === undefined));
  const dump = JSON.stringify(out);
  for (const leak of ["do-not-leak", "/srv/private", "Alice", "secret subject", "127.0.0.1", "example.test", "fixture-credential"]) assert.ok(!dump.includes(leak), `leaked ${leak}`);
  const one = await make(fakeCall().mcpCall).games("grand-century");
  assert.deepEqual(one.games.map((g) => g.id), ["grand-century"]);
  await assert.rejects(make(mcpCall).games("evil"), /unknown game/);
});

test("a missing server, failed read, stale status or hung read is unavailable or unsupported, never guessed", async () => {
  const partial = await make(fakeCall({ "metroforge/mf_cities": () => { throw new Error("boom /srv/private"); } }).mcpCall).games("metroforge");
  assert.equal(partial.games[0].state, "partial");
  assert.equal(partial.games[0].reads.find((r) => r.id === "cities").state, "unavailable");
  const stale = await make(fakeCall({ "engine/engine_health": () => ({ ...engine(), checkedAt: new Date(NOW - 10 * 60000).toISOString() }) }).mcpCall).games("ahd");
  assert.equal(stale.games[0].state, "unavailable");
  assert.deepEqual(stale.games[0].reads[0].facts, []);
  const { calls, mcpCall } = fakeCall();
  const absent = await make(mcpCall, configFile(["support", "engine"])).games();
  assert.deepEqual(absent.games.map((g) => [g.id, g.state]), [["ahd", "live"], ["metroforge", "unsupported"], ["grand-century", "unsupported"]]);
  assert.ok(calls.every((c) => c.server === "engine"));
  const noConfig = await make(mcpCall, "/nonexistent/mcp.json").games();
  assert.ok(noConfig.games.every((g) => g.state === "unsupported"));
  const hung = await make(() => new Promise(resolve => setTimeout(resolve, 250)), configFile(), { readTimeoutMs: 50 }).games("ahd");
  assert.equal(hung.games[0].state, "unavailable");
});

test("the supervisor registers both reads as fixed tools and serves them through its tool server", async () => {
  const names = TOOLS([]).map((t) => t.name);
  assert.ok(names.includes("ticket_evidence") && names.includes("game_health"));
  const schema = Object.fromEntries(TOOLS([]).map((t) => [t.name, t.input_schema]));
  assert.deepEqual(Object.keys(schema.ticket_evidence.properties), ["number"]);
  assert.deepEqual(Object.keys(schema.game_health.properties), ["game"]);
  assert.equal(schema.ticket_evidence.additionalProperties, false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-evidence-sup-"));
  const { mcpCall } = fakeCall();
  const seen = {};
  const executor = {
    available: () => ({ available: true, reason: null, runner: "fixture", model: "fixture" }),
    async run({ toolUrl }) {
      let id = 0;
      const call = async (name, args) => {
        const r = await (await fetch(toolUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) })).json();
        return { error: r.result.isError === true, text: r.result.content.map((c) => c.text).join("\n") };
      };
      seen.ticket = JSON.parse((await call("ticket_evidence", { number: 1867 })).text);
      seen.games = JSON.parse((await call("game_health", {})).text);
      return { text: "done" };
    },
  };
  const sup = createSupervisor({ stateDir: path.join(root, "state"), repos: {}, sandbox: { exists: () => false }, executor, guardianDir: path.join(root, "g"),
    evidence: createStudioEvidence({ mcpCall, configPath: configFile(), now: () => NOW }) });
  try {
    await sup.start();
    sup.post("what did Keir actually do on ticket #1867?", "evidence-test-0001");
    assert.equal(await sup.idle(30000), true);
  } finally { sup.stop(); }
  assert.equal(seen.ticket.ticket, 1867);
  assert.equal(seen.ticket.actionProof.gameChangeProven, false);
  assert.equal(seen.games.games.length, 3);

  const bare = createSupervisor({ stateDir: path.join(root, "bare"), repos: {}, sandbox: { exists: () => false }, executor: { available: () => ({ available: false, reason: "fixture" }) }, guardianDir: path.join(root, "g") });
  assert.equal(bare.tools.some((t) => t.name === "ticket_evidence"), true);
  bare.stop();
});
