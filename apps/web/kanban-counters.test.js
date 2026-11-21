// Keir's automatic counts are not cards: routing, the counter list,
// promotion and the one-time migration, with fixtures from the live board.
// Run: node --test kanban-counters.test.js
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openKanban } = require("./kanban-store");
const { counterFromAdd, counterFromReport, counterFromCard, occurrencesAdded } = require("./kanban-counters");
const { registerKanbanTools } = require("./mcp/kanban-tools");
const { registerFleetTools } = require("./mcp/fleet-tools");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "kanban-board-fixture.json"), "utf8"));
const card = (id) => FIXTURE.cards.find((c) => c.id === id);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock;
let k;
let dbPath;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-counters-test-"));
  dbPath = path.join(dir, "kanban.db");
  clock = new Date("2026-11-14T16:05:15Z");
  k = openKanban(dbPath, { now: () => clock });
  k.upsertProduct({ slug: "a-house-divided", name: "A House Divided", aliases: ["ahd"] });
  k.upsertProduct({ slug: "lakeside-mcp", name: "Lakeside MCP", aliases: ["mcp"] });
}
const later = (ms) => { clock = new Date(clock.getTime() + ms); };
function tools() {
  const registered = {};
  registerKanbanTools({ tool: (name, _d, _s, fn) => { registered[name] = fn; } }, {
    auth: { name: "test", scopes: { write: true } },
    jsonResult: (o) => ({ ok: true, o }),
    errorResult: (m) => ({ ok: false, m }),
    store: () => k,
  });
  return registered;
}
// Exactly what apps/agent/lib/operator/capabilitygaps.js sends for a new gap.
function keirGapAdd(fixtureId, { impact = "medium" } = {}) {
  const c = card(fixtureId);
  return { product: "lakeside-mcp", kind: "capability", lane: "inbox", actor: "keir", impact, title: c.title, detail: c.detail };
}
// What the MCP layer hands the store: zod defaults applied, needs_owner forced off.
const viaTool = (input) => ({ lane: "inbox", impact: "medium", ...input, needs_owner: false });
// Keir's handling of the reply: Number(card?.id) || null.
const keirCardId = (reply) => Number(reply?.id) || null;
const boardCount = () => k.db.prepare("SELECT COUNT(*) AS n FROM kanban_items").get().n;

// Load fixture cards with their real history (creator included), then reopen
// the store so the link backfill runs as it does in production.
function loadCards(ids) {
  const ins = k.db.prepare(`INSERT INTO kanban_items (id, product, title, detail, lane, impact, kind, assigned_to, progress_summary, last_progress_at, evidence_url, created_at, updated_at, area, class)
    VALUES (@id, @product, @title, @detail, @lane, @impact, @kind, @assigned_to, @progress_summary, @last_progress_at, @evidence_url, @created_at, @updated_at, @area, @class)`);
  const ev = k.db.prepare("INSERT INTO kanban_events (item_id, product, event_type, actor, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const id of ids) {
    const c = card(id);
    ins.run({ ...c, progress_summary: c.progress_summary || "", area: c.area || null, class: c.class || null });
    for (const e of [...c.events].reverse()) ev.run(c.id, c.product, e.event_type, e.actor, e.summary, e.created_at);
  }
  k.close();
  k = openKanban(dbPath, { now: () => clock });
}

describe("recognising an automatic counter", () => {
  it("matches Keir's tool-gap and failure filings exactly, from the live cards", () => {
    assert.equal(counterFromAdd(keirGapAdd(255330), "keir").signature, "raw:retiredCharacters");
    assert.equal(counterFromAdd(keirGapAdd(254943), "keir").signature, "tool:turn_anomalies:wrong argument names");
    const spike = card(255399);
    const f = counterFromAdd({ product: "lakeside-mcp", area: "keir", kind: "bug", lane: "inbox", actor: "keir", title: spike.title, detail: spike.detail }, "keir");
    assert.equal(f.signature, "failure:reasoning:unanswered_finish_refused:0dbfb588");
    assert.deepEqual([f.total, f.window_hits, f.tickets], [12, 10, [1833, 1837, 1836, 1838, 1842]]);
    assert.equal(counterFromAdd({ product: "lakeside-mcp", area: "keir", kind: "bug", lane: "inbox", title: "Keir failures regressed: tool on 11.2.0", detail: "tool failures per 100 activations: 9 on 11.2.0 (40 activations) vs 3 on 11.1.0 (55).\n\nSamples:\nnone\n\nNext step: Compare releases" }, "keir").signature, "failure:regression:tool:11.2.0");
    assert.equal(counterFromReport({ id: 254959, event: "progress", actor: "keir", summary: "Now 8 hits across 2 tasks in 7 days.", idempotency_key: "gap:raw:governmentFormations:8" }, "keir").signature, "raw:governmentFormations");
    assert.equal(counterFromReport({ id: 9, event: "progress", actor: "keir", summary: "Keir failure spike: reasoning/x: y", idempotency_key: "failure:reasoning:x:0dbfb588:4910" }, "keir").signature, "failure:reasoning:x:0dbfb588");
    assert.equal(counterFromReport({ id: 9, event: "progress", actor: "keir", summary: "Now 3 hits across 1 tasks in 7 days.", idempotency_key: "gap:tool:code_search:tool timed out:3" }, "keir").signature, "tool:code_search:tool timed out");
  });

  it("never swallows a card someone chose to file", () => {
    const gap = keirGapAdd(255330);
    // Same words, filed by an agent.
    assert.equal(counterFromAdd(gap, "claude:s1"), null);
    // Keir's deliberate raise_to_developers cards: capability, but lane next and "Raised by Keir".
    const raised = card(254939);
    assert.equal(counterFromAdd({ product: "lakeside-mcp", title: raised.title, detail: raised.detail, kind: "capability", lane: "next", actor: "keir" }, "keir"), null);
    assert.equal(counterFromAdd({ product: "lakeside-mcp", title: raised.title, detail: raised.detail, kind: "capability", lane: "inbox", actor: "keir" }, "keir"), null, "no counter marker");
    // A promotion-style title with the marker copied into the detail.
    assert.equal(counterFromAdd({ ...gap, title: "Build a read tool for retiredCharacters" }, "keir"), null);
    // Any field Keir's counter code never sends makes it a card.
    for (const extra of [{ ticket: 1852 }, { start: true }, { assigned_to: "keir" }, { github: "lakesidegamedev/lakeside-ops#1" }, { lane: "next" }, { area: "capabilities" }, { force: true }, { parent_id: 255031 }, { class: "idea" }])
      assert.equal(counterFromAdd({ ...gap, ...extra }, "keir"), null, JSON.stringify(extra));
    // Product spelled differently, or a different kind.
    assert.equal(counterFromAdd({ ...gap, product: "mcp" }, "keir"), null);
    assert.equal(counterFromAdd({ ...gap, kind: "feature" }, "keir"), null);
    // A failure-looking title without Keir's alert detail.
    assert.equal(counterFromAdd({ product: "lakeside-mcp", area: "keir", kind: "bug", lane: "inbox", title: "Keir failure new: tool/x", detail: "I saw this happen twice." }, "keir"), null);
    // Reports: an ordinary progress note, a completion, evidence, or a key that does not match the summary.
    assert.equal(counterFromReport({ id: 1, event: "progress", summary: "Now 8 hits across 2 tasks in 7 days." }, "keir"), null);
    assert.equal(counterFromReport({ id: 1, event: "completed", summary: "Now 8 hits across 2 tasks in 7 days.", idempotency_key: "gap:raw:x:8" }, "keir"), null);
    assert.equal(counterFromReport({ id: 1, event: "progress", summary: "Now 9 hits across 2 tasks in 7 days.", idempotency_key: "gap:raw:x:8" }, "keir"), null);
    assert.equal(counterFromReport({ id: 1, event: "progress", summary: "Now 8 hits across 2 tasks in 7 days.", idempotency_key: "gap:raw:x:8" }, "claude"), null);
    assert.equal(counterFromReport({ id: 1, event: "progress", summary: "Now 8 hits across 2 tasks in 7 days.", idempotency_key: "gap:raw:x:8", evidence_url: "https://x.test" }, "keir"), null);
  });

  it("recognises the migration's cards but not deliberate capability cards", () => {
    assert.equal(counterFromCard(card(254959)).signature, "raw:governmentFormations");
    assert.equal(counterFromCard(card(255033)).signature, "raw:statePartyOrg", "filed under a shared token name, same exact form");
    for (const id of [254935, 254668, 254939, 255627]) assert.equal(counterFromCard(card(id)), null, String(id));
  });
});

describe("counters instead of cards", () => {
  beforeEach(fresh);

  it("Keir's gap filing is counted, its reply still works, and no card appears", async () => {
    const t = tools();
    const reply = (await t.kanban_add(viaTool(keirGapAdd(255330)))).o;
    assert.equal(reply.counted, true);
    assert.equal(keirCardId(reply), null, "Keir stores no card id and files the next count as another add");
    assert.equal(reply.signature, "raw:retiredCharacters");
    assert.equal(boardCount(), 0);
    later(3 * HOUR);
    const again = (await t.kanban_add(viaTool({ ...keirGapAdd(255330), detail: card(255330).detail.replace("Seen 3 times across 2 tasks", "Seen 7 times across 3 tasks") }))).o;
    assert.equal(again.added, 4);
    const c = k.counters.get("raw:retiredCharacters");
    assert.deepEqual([c.last_7_days, c.last_30_days, c.tasks, c.status], [7, 7, 3, "counting"]);
    assert.equal(boardCount(), 0);
  });

  it("Keir's repeat report on an old card id is counted and leaves the card alone", async () => {
    loadCards([254959]);
    const before = k.get(254959);
    const t = tools();
    const r = (await t.work_report({ id: 254959, event: "progress", actor: "keir", summary: "Now 21 hits across 5 tasks in 7 days.", idempotency_key: "gap:raw:governmentFormations:21" })).o;
    assert.equal(r.counted, true);
    const after = k.get(254959);
    assert.equal(after.updated_at, before.updated_at);
    assert.equal(after.progress_summary, before.progress_summary);
    assert.equal(k.counters.get("raw:governmentFormations").tasks, 5);
  });

  it("failure alerts are counted by their running total", async () => {
    const t = tools();
    const spike = card(255399);
    const input = { product: "lakeside-mcp", area: "keir", kind: "bug", lane: "inbox", actor: "keir", title: spike.title, detail: spike.detail };
    assert.equal(keirCardId((await t.kanban_add(viaTool(input))).o), null);
    later(6 * HOUR);
    await t.kanban_add(viaTool({ ...input, detail: spike.detail.replace("Total 12, last 24 hours 10", "Total 19, last 24 hours 9") }));
    // Its repeat report carries no figures: it moves last_seen, adds nothing.
    later(6 * HOUR);
    await t.work_report({ id: 77, event: "progress", actor: "keir", summary: spike.title, idempotency_key: "failure:reasoning:unanswered_finish_refused:0dbfb588:4911" });
    const c = k.counters.get("failure:reasoning:unanswered_finish_refused:0dbfb588");
    assert.equal(c.occurrences, 19);
    assert.equal(c.family, "failure alert");
    assert.deepEqual(c.tickets, [1833, 1837, 1836, 1838, 1842]);
    assert.equal(c.last_seen, clock.toISOString());
    assert.equal(boardCount(), 0);
  });

  it("a deliberately filed card with a similar title stays a card", async () => {
    const t = tools();
    const made = (await t.kanban_add({ product: "lakeside-mcp", kind: "capability", lane: "inbox", impact: "medium", title: "A read for retiredCharacters without raw database queries", detail: "Agents keep needing this.", actor: "claude:s2" })).o;
    assert.ok(made.id > 0);
    assert.equal(made.counted, undefined);
    const raised = card(254939);
    const keirRaised = (await t.kanban_add({ product: "lakeside-mcp", title: raised.title, detail: raised.detail, kind: "capability", lane: "next", actor: "keir" })).o;
    assert.ok(keirRaised.id > 0, "Keir's raise_to_developers card is a card");
    assert.equal(boardCount(), 2);
  });

  it("running 7-day counts difference correctly, and a lapsed window counts afresh", () => {
    assert.equal(occurrencesAdded(null, { window_hits: 5 }, 0), 5);
    const prev = { window_hits: 8, last_seen: "2026-11-01T00:00:00Z" };
    assert.equal(occurrencesAdded(prev, { window_hits: 13 }, Date.parse("2026-11-03T00:00:00Z")), 5);
    assert.equal(occurrencesAdded(prev, { window_hits: 6 }, Date.parse("2026-11-03T00:00:00Z")), 0, "old hits left the window");
    assert.equal(occurrencesAdded(prev, { window_hits: 3 }, Date.parse("2026-11-09T00:00:00Z")), 3, "a week later the window is new");
    assert.equal(occurrencesAdded({ last_total: 12 }, { total: 19 }, 0), 7);
  });
});

describe("promotion is a deliberate act", () => {
  beforeEach(fresh);

  it("files one card linked back, never a second while it is open, and shows addressed when the count stops", async () => {
    const t = tools();
    await t.kanban_add(viaTool(keirGapAdd(255330)));
    const p = (await t.kanban_counter_promote({ signature: "raw:retiredCharacters", title: "Build a read tool for retired characters", actor: "claude:s3" })).o;
    assert.equal(p.promoted, true);
    assert.equal(p.item.kind, "capability");
    assert.match(p.item.detail, /Promoted from the counter raw:retiredCharacters: 3 times in the last 7 days/);
    assert.equal(p.item.events[0].event_type, "promoted");
    assert.equal(p.counter.status, "card open");
    assert.equal(p.counter.card.id, p.item.id);

    // Counting goes on, still no new card.
    later(2 * HOUR);
    await t.kanban_add(viaTool({ ...keirGapAdd(255330), detail: card(255330).detail.replace("Seen 3 times", "Seen 6 times") }));
    const again = (await t.kanban_counter_promote({ signature: "raw:retiredCharacters", actor: "codex" })).o;
    assert.equal(again.promoted, false);
    assert.equal(again.item.id, p.item.id);
    assert.equal(boardCount(), 1);
    assert.equal(k.counters.get("raw:retiredCharacters").last_7_days, 6);

    later(DAY);
    k.report({ id: p.item.id, event: "completed", summary: "Shipped the read tool", evidence_url: "https://github.com/lakesidegamedev/lakeside-code/pull/1", actor: "claude:s3" });
    assert.equal(k.counters.get("raw:retiredCharacters").status, "addressed");
    later(DAY);
    await t.kanban_add(viaTool({ ...keirGapAdd(255330), detail: card(255330).detail.replace("Seen 3 times", "Seen 9 times") }));
    assert.equal(k.counters.get("raw:retiredCharacters").status, "seen again after its card closed");
    assert.equal(boardCount(), 1, "still never a card by itself");
    // With its card done, a new promotion files a fresh card.
    assert.equal((await t.kanban_counter_promote({ signature: "raw:retiredCharacters", actor: "claude" })).o.promoted, true);
  });

  it("an unknown counter is a clear error", async () => {
    const r = await tools().kanban_counter_promote({ signature: "raw:nope", actor: "claude" });
    assert.equal(r.ok, false);
    assert.match(r.m, /no counter raw:nope/);
  });
});

describe("migrating the existing counter cards", () => {
  beforeEach(fresh);
  const COUNTERS = [254959, 255330, 254943, 255033, 255399, 255357];
  const OTHERS = [254935, 254939, 255627];

  it("the dry run changes nothing; the real run moves them with their history; a second run moves nothing", () => {
    loadCards([...COUNTERS, ...OTHERS]);
    // One counter card someone actually picked up stays on the board.
    k.report({ id: 255357, event: "started", summary: "Looking at the characters raw reads", actor: "claude:s4" });
    const before = k.db.prepare("SELECT id, lane, updated_at FROM kanban_items ORDER BY id").all();

    const dry = k.counters.migrateCards({ dryRun: true });
    assert.equal(dry.cards, 5);
    assert.deepEqual(dry.kept_on_board.map((x) => x.id), [255357]);
    assert.match(dry.kept_on_board[0].reason, /assigned to claude:s4/);
    assert.deepEqual(k.db.prepare("SELECT id, lane, updated_at FROM kanban_items ORDER BY id").all(), before);
    assert.equal(k.counters.list().total, 0);

    const run = k.counters.migrateCards({ dryRun: false });
    assert.equal(run.moved, 5);
    assert.deepEqual(run.by_family, { tool_gap: 4, failure_alert: 1 });
    const moved = k.get(254959);
    assert.equal(moved.lane, "done");
    assert.equal(moved.events[0].event_type, "moved_to_counters");
    assert.match(moved.events[0].summary, /^Moved to the counter list as raw:governmentFormations\. .*Lane was next\.$/);
    for (const id of OTHERS) assert.notEqual(k.get(id).lane, "done", `deliberate card ${id} untouched`);
    assert.equal(k.get(255357).lane, "now");

    // 254959's history: filed at 5 (2 Nov), then 10, 13 and 8 within the week, so 13 occurrences in that week.
    const gov = k.counters.get("raw:governmentFormations");
    assert.equal(gov.occurrences, 13);
    assert.deepEqual(gov.migrated_from_cards, [254959]);
    assert.equal(gov.first_seen, "2026-11-02T01:26:26.551Z");
    assert.equal(k.counters.get("failure:reasoning:unanswered_finish_refused:0dbfb588").occurrences, 12);

    assert.equal(k.counters.migrateCards({ dryRun: false }).moved, 0);
  });

  it("live reports that arrived before the migration combine with the replayed history", async () => {
    loadCards([254959]);
    clock = new Date("2026-11-10T00:00:00Z");
    await tools().work_report({ id: 254959, event: "progress", actor: "keir", summary: "Now 11 hits across 3 tasks in 7 days.", idempotency_key: "gap:raw:governmentFormations:11" });
    k.counters.migrateCards({ dryRun: false });
    // 13 in the first week, then 11 a day after the 9 Nov report of 8: +3.
    assert.equal(k.counters.get("raw:governmentFormations").occurrences, 16);
  });
});

describe("reading the counters", () => {
  beforeEach(fresh);

  it("mcp_capability_requests lists counters most frequent first, with 7 and 30 day counts, tasks and tickets", async () => {
    const t = tools();
    await t.kanban_add(viaTool(keirGapAdd(255330)));
    await t.kanban_add(viaTool({ ...keirGapAdd(255330), title: "A read for corporateSectors without raw database queries", detail: card(255330).detail.replace(/retiredCharacters/g, "corporateSectors").replace("Seen 3 times across 2 tasks", "Seen 71 times across 18 tasks") }));
    const registered = {};
    const saved = { a: process.env.OPS_KNOWLEDGE_MCP_TOKEN, b: process.env.MCP_FLEET_TOKEN };
    delete process.env.OPS_KNOWLEDGE_MCP_TOKEN; delete process.env.MCP_FLEET_TOKEN;
    try {
      registerFleetTools({ tool: (name, _d, _s, fn) => { registered[name] = fn; } }, { jsonResult: (o) => ({ ok: true, o }), errorResult: (m) => ({ ok: false, m }), kanban: () => k });
      const out = (await registered.mcp_capability_requests({ limit: 10, include_closed: false, counters: true })).o;
      assert.equal(out.counters_total, 2);
      assert.deepEqual(out.counters.map((c) => [c.signature, c.last_7_days, c.last_30_days, c.tasks]), [["raw:corporateSectors", 71, 71, 18], ["raw:retiredCharacters", 3, 3, 2]]);
      assert.match(out.counters[0].summary, /71 in the last 7 days, 71 in 30, across 18 tasks/);
      assert.match(out.requests_error, /no fleet token/);
    } finally {
      if (saved.a !== undefined) process.env.OPS_KNOWLEDGE_MCP_TOKEN = saved.a;
      if (saved.b !== undefined) process.env.MCP_FLEET_TOKEN = saved.b;
    }
  });

  it("the counters page renders every value escaped", () => {
    const { makeCountersBody } = require("./hub/counters");
    k.counters.record({ signature: "raw:<b>x</b>", family: "tool_gap", title: "A read for <script>", window_hits: 2, window_tasks: 1, samples: ["<img src=x>"] });
    const { body } = makeCountersBody({ list: k.counters.list() });
    assert.ok(!body.includes("<script>") && !body.includes("<img") && !body.includes("<b>x"));
    assert.match(body, /A read for &lt;script&gt;/);
  });
});
