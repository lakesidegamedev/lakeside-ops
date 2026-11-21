// Cards close with the pull request or alert they were raised from, in the
// same single reconcile pass as tickets. Fixtures from the live board.
// Run: node --test kanban-sources.test.js
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openKanban } = require("./kanban-store");
const { runReconcile, createTicketStatusReader } = require("./kanban-tickets");
const src = require("./kanban-sources");
const { registerKanbanTools } = require("./mcp/kanban-tools");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "kanban-board-fixture.json"), "utf8"));
const card = (id) => FIXTURE.cards.find((c) => c.id === id);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock;
let k;
let dbPath;
let gh; // fake GitHub: "owner/repo#N" -> node, plus counters
let units; // fake systemd: unit -> state

function fakeGraphql() {
  gh = { prs: new Map(), down: false, calls: 0 };
  return async (query) => {
    gh.calls += 1;
    if (gh.down) throw new Error("gh: connect ETIMEDOUT");
    const data = {};
    for (const part of query.split(/(?=r\d+: repository\()/).slice(1)) {
      const [, alias, owner, name] = part.match(/^(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/);
      data[alias] = {};
      for (const pr of part.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)) data[alias][pr[1]] = gh.prs.get(`${owner}/${name}#${pr[2]}`) || null;
    }
    return { data };
  };
}
const merged = (at, oid = "abc1234") => ({ state: "MERGED", merged: true, mergedAt: at, closedAt: at, mergeCommit: { abbreviatedOid: oid } });
const closedPr = (at) => ({ state: "CLOSED", merged: false, mergedAt: null, closedAt: at, mergeCommit: null });
const openPr = () => ({ state: "OPEN", merged: false, mergedAt: null, closedAt: null, mergeCommit: null });

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-sources-test-"));
  dbPath = path.join(dir, "kanban.db");
  clock = new Date("2026-11-21T10:00:00Z");
  k = openKanban(dbPath, { now: () => clock });
  k.upsertProduct({ slug: "a-house-divided", name: "A House Divided", aliases: ["ahd"] });
  k.upsertProduct({ slug: "lakeside-mcp", name: "Lakeside MCP", aliases: ["mcp"] });
  units = new Map();
}
const later = (ms) => { clock = new Date(clock.getTime() + ms); };
function readers() {
  const prReader = src.createPullRequestReader({ graphql: fakeGraphql(), now: () => clock.getTime() });
  const unitState = async (unit) => { const u = units.get(unit); if (!u) throw new Error("systemctl: no such unit"); return u; };
  return { prReader, alertReader: src.createAlertReader({ prReader, unitState, now: () => clock.getTime() }) };
}
let R;
const run = (opts = {}) => runReconcile({ store: k, reader: null, ...R, ...opts });
function tools() {
  const registered = {};
  registerKanbanTools({ tool: (name, _d, _s, fn) => { registered[name] = fn; } }, {
    auth: { name: "test", scopes: { write: true } }, jsonResult: (o) => ({ ok: true, o }), errorResult: (m) => ({ ok: false, m }), store: () => k, ...R,
  });
  return registered;
}
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
const lastEvent = (id) => k.get(id).events[0];

describe("pure matchers", () => {
  it("parses pull requests and refuses issues", () => {
    assert.deepEqual(src.parsePullRequest("https://github.com/Egg3901/AHDGame/pull/7022"), { repo: "lakesidegamedev/AHDGame", number: 7022 });
    assert.deepEqual(src.parsePullRequest("lakesidegamedev/lakeside-ops#498"), { repo: "lakesidegamedev/lakeside-ops", number: 498 });
    assert.throws(() => src.parsePullRequest("https://github.com/lakesidegamedev/AHDGame/issues/6880"), /unrecognized pull request/);
    assert.throws(() => src.parsePullRequest("#7022"), /unrecognized pull request/);
  });

  it("infers a pull request only from a title naming one that matches the evidence link", () => {
    assert.deepEqual(src.inferPullRequest({ title: "Bug-hunt taxonomy sweep vs 1.20: two fixes in PR #5790", evidence_url: "https://github.com/lakesidegamedev/AHDGame/pull/5790" }), [{ repo: "lakesidegamedev/AHDGame", number: 5790 }]);
    // Evidence alone (a step of a bigger program), a mismatch, or two PRs: nothing.
    assert.deepEqual(src.inferPullRequest({ title: "NPP CEO quality: caretaker CEOs", evidence_url: "https://github.com/Egg3901/AHDGame/pull/4184" }), []);
    assert.deepEqual(src.inferPullRequest({ title: "Follow PR #5790", evidence_url: "https://github.com/lakesidegamedev/AHDGame/pull/5791" }), []);
    assert.deepEqual(src.inferPullRequest({ title: "PR #1 and PR #2", evidence_url: "https://github.com/a/b/pull/1" }), []);
    assert.deepEqual(src.inferPullRequest({ title: "Turn 7022 slow", evidence_url: "https://github.com/a/b/pull/7022" }), []);
  });

  it("finds what is still owed after a merge, from real progress notes", () => {
    const yes = [
      ["Production first batch is live. Worker release remains gated; maintenance owns final promotion.", "release"],
      ["PR #7022 refreshes the ratio and credit terms. All 28 targeted tests passed. Pending release.", "release"],
      ["Migration 2026-11-15-provider-link-history-indexes must be run after the next promote.", "migration to run"],
      ["merged, next: release", "release"],
      ["Staging promotion #6877 running and auto-promote active. Production verification remains pending.", "verification"],
      ["PR 465 is merged and ready for the next Keir release.", "release"],
      ["Awaiting deployment of the pinned publisher.", "deploy"],
      ["Fixes are on TestFlight; the device test remains.", "verification"],
      // Live card 255354 on 2026-11-21: the first draft of this matcher would have closed it.
      ["PR #6617 merged to development (70330d1). Follow-ups still open: election results archive kept across resets, politician earlier-iterations section, corporation infobox.", "follow-ups"],
      ["Wiki automatic pages: election results, party seat history (PR #6617) + follow-ups (reset archive, politician iterations, corp infobox)", "follow-ups"],
      // Live card 255587: the auto-promoter's migration hold.
      ["staging -> main changes src/lib/migrations/registry.ts. Merge by hand via the promote skill and run the migration after deploy (step 7).", "migration to run"],
    ];
    for (const [text, owed] of yes) assert.equal(src.owedAfterMerge(text), owed, text);
    for (const text of ["All 25 targeted tests passed.", "Merged and live; verified on production.", "", "Added the release notes page.", "All follow-ups are done."])
      assert.equal(src.owedAfterMerge(text), null, text);
  });

  it("derives alert keys only from a known monitor's exact fields", () => {
    const tr = card(255365);
    assert.deepEqual(src.alertFromFields({ actor: "turn-hold-monitor", title: tr.title, detail: tr.detail }), { key: "turn-hold-monitor:cannot-read-production", check: "systemd:ahd-turn-hold-monitor.service", link: "derived" });
    const ap = card(255580);
    assert.deepEqual(src.alertFromFields({ actor: "ahd-auto-promote", title: ap.title, detail: ap.detail }), { key: "ahd-auto-promote:staging->main:pr-6999", check: "pr:lakesidegamedev/AHDGame#6999", link: "derived" });
    assert.equal(src.alertFromFields({ actor: "backup-alert", title: "Service FAILED: rag-reindex", detail: "" }).check, "systemd:rag-reindex.service");
    // A person filing the same words, or a different title, is an ordinary card.
    assert.equal(src.alertFromFields({ actor: "claude", title: tr.title, detail: tr.detail }), null);
    assert.equal(src.alertFromFields({ actor: "turn-hold-monitor", title: "AHD turn-hold monitor is slow", detail: "" }), null);
    assert.equal(src.alertFromFields({ actor: "ahd-auto-promote", title: ap.title, detail: "no link" }), null);
    assert.equal(src.alertFromFields({ actor: "x", title: "y", alert_key: "unit-failed:foo", alert_check: "systemd:foo" }).check, "systemd:foo.service");
    assert.throws(() => src.alertFromFields({ alert_key: "bad key with spaces" }), /alert_key must be/);
  });

  it("reads systemd show output", async () => {
    const out = await src.systemdUnitState("ahd-turn-hold-monitor.service", async () => ({ stdout: "LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=@1795271604\n" }));
    assert.deepEqual(out, { loaded: true, active_state: "inactive", result: "success", exit_status: 0, exited_at: new Date(1795271604000).toISOString() });
    await assert.rejects(src.systemdUnitState("x; rm", async () => ({ stdout: "" })), /bad unit name/);
  });
});

describe("a card linked to a pull request", () => {
  beforeEach(() => { fresh(); R = readers(); });

  it("completes when the pull request merges, with a note naming the merge", async () => {
    const t = tools();
    const c = (await t.kanban_add({ product: "ahd", title: "Correct austerity units in country news", start: true, actor: "codex:news", pull_request: "lakesidegamedev/AHDGame#7027" })).o;
    assert.deepEqual(c.pull_requests, ["lakesidegamedev/AHDGame#7027"]);
    assert.deepEqual(c.sources, [{ kind: "pull_request", ref: "lakesidegamedev/AHDGame#7027" }]);
    gh.prs.set("lakesidegamedev/AHDGame#7027", openPr());
    assert.equal((await run()).changed, 0, "still open: nothing");
    gh.prs.set("lakesidegamedev/AHDGame#7027", merged("2026-11-21T12:00:00Z", "8eac0a7"));
    later(3 * HOUR);
    const out = await run();
    assert.deepEqual(out.by_source, { pull_request: { completed: 1 } });
    const after = k.get(c.id);
    assert.equal(after.lane, "done");
    assert.equal(lastEvent(c.id).event_type, "source_closed");
    assert.match(lastEvent(c.id).summary, /^Pull request lakesidegamedev\/AHDGame#7027 was merged on 21 Nov \(merge 8eac0a7\)\. This card was its work, so it closes with it\./);
    const again = await run();
    assert.equal(again.changed, 0, "a second run changes nothing");
  });

  it("merged with work still owed: kept, relabelled, and a dead assignee removed", async () => {
    const c = k.add({ product: "ahd", title: "Synchronize the US Budget debt ratio", start: true, pull_request: "https://github.com/lakesidegamedev/AHDGame/pull/7022" }, { actor: "codex:budget-ratio" });
    k.report({ id: c.id, event: "progress", summary: "PR #7022 refreshes the ratio. All 28 targeted tests passed. Pending release.", actor: "codex:budget-ratio" });
    later(30 * HOUR);
    gh.prs.set("lakesidegamedev/AHDGame#7022", merged("2026-11-22T08:00:00Z"));
    const out = await run();
    assert.deepEqual(out.by_source, { pull_request: { follow_up: 1 } });
    const after = k.get(c.id);
    assert.equal(after.lane, "next");
    assert.equal(after.assigned_to, null);
    assert.equal(after.title, "Still owed after PR #7022 merged (release): Synchronize the US Budget debt ratio");
    assert.match(lastEvent(c.id).summary, /The card says work remains after the merge: release\. It stays open for that work: relabelled with what is still owed; codex:budget-ratio unassigned \(nothing reported for 30 hours\); moved from Now to Next/);
    assert.equal((await run()).changed, 0);
  });

  it("still_owed set explicitly keeps the card open even with a plain progress note", async () => {
    const c = k.add({ product: "ahd", title: "Index provider links", lane: "backlog", pull_request: "lakesidegamedev/AHDGame#6588", still_owed: "run the migration" }, { actor: "claude" });
    gh.prs.set("lakesidegamedev/AHDGame#6588", merged("2026-11-21T11:00:00Z"));
    await run();
    assert.equal(k.get(c.id).title, "Still owed after PR #6588 merged (run the migration): Index provider links");
    assert.equal(k.get(c.id).lane, "backlog");
  });

  it("closed without merging goes back to the inbox, unassigned", async () => {
    const c = k.add({ product: "ahd", title: "Whole plants ledger", start: true, pull_request: "lakesidegamedev/AHDGame#5215" }, { actor: "claude:plants" });
    gh.prs.set("lakesidegamedev/AHDGame#5215", closedPr("2026-11-21T10:30:00Z"));
    later(HOUR);
    const out = await run();
    assert.deepEqual(out.by_source, { pull_request: { returned: 1 } });
    const after = k.get(c.id);
    assert.deepEqual([after.lane, after.assigned_to], ["inbox", null]);
    assert.match(lastEvent(c.id).summary, /was closed without merging on 21 Nov\. The work did not land, so this card is back in the inbox, unassigned \(was claude:plants\)/);
    assert.equal(lastEvent(c.id).event_type, "source_returned");
  });

  it("GitHub unreachable: nothing changes, and the run says why", async () => {
    const c = k.add({ product: "ahd", title: "Hide regional panels", lane: "next", assigned_to: "codex", pull_request: "lakesidegamedev/AHDGame#6877" }, { actor: "codex" });
    gh.down = true;
    const out = await run();
    assert.equal(out.changed, 0);
    assert.match(out.pull_request_error, /GitHub unreachable, pull request rules skipped: gh: connect ETIMEDOUT/);
    assert.equal(k.get(c.id).lane, "next");
    // A pull request GitHub does not know is unknown, not closed.
    gh.down = false;
    assert.equal((await run()).changed, 0);
    assert.deepEqual((await run()).skipped_unknown_pull_requests, ["lakesidegamedev/AHDGame#6877"]);
  });

  it("reads many pull requests in one batched call", async () => {
    for (let n = 1; n <= 30; n += 1) gh.prs.set(`lakesidegamedev/AHDGame#${n}`, openPr());
    const map = await R.prReader.states(Array.from({ length: 30 }, (_, i) => ({ repo: "lakesidegamedev/AHDGame", number: i + 1 })));
    assert.equal(gh.calls, 1);
    assert.equal(map.get("lakesidegamedev/AHDGame#7").state, "open");
    await R.prReader.states([{ repo: "lakesidegamedev/AHDGame", number: 7 }]);
    assert.equal(gh.calls, 1, "cached");
  });

  it("a card linked by hand through its title and evidence is backfilled", () => {
    const c = k.add({ product: "ahd", title: "Bug-hunt taxonomy sweep: two fixes in PR #5790", lane: "inbox", evidence_url: "https://github.com/lakesidegamedev/AHDGame/pull/5790" }, { actor: "claude" });
    k.db.prepare("UPDATE kanban_items SET pr_refs = NULL WHERE id = ?").run(c.id);
    k.close();
    k = openKanban(dbPath, { now: () => clock });
    assert.deepEqual([k.get(c.id).pull_requests, k.get(c.id).pull_request_link], [["lakesidegamedev/AHDGame#5790"], "inferred"]);
  });
});

describe("alerts from the real monitors", () => {
  beforeEach(() => { fresh(); R = readers(); });
  const PROMOTE = [255580, 255560, 255526, 255542, 255555, 255587, 255518, 255484, 255538];
  const READ = [255365, 255527, 255523, 255502, 255370, 255509, 255493, 255402, 255443];

  it("the auto-promote held cards close when their pull requests merged", async () => {
    clock = new Date("2026-11-21T14:00:00Z");
    loadCards(PROMOTE);
    for (const id of PROMOTE) assert.match(k.get(id).alert.check, /^pr:lakesidegamedev\/AHDGame#\d+$/, String(id));
    for (const [key, p] of Object.entries(FIXTURE.pull_requests)) gh.prs.set(key, merged(p.merged_at, p.sha.slice(0, 7)));
    const out = await run({ limit: 50 });
    // Seven holds are simply over. The two "adds a data migration" holds
    // (255560, 255587) still owe the migration after deploy: kept, relabelled.
    assert.deepEqual(out.by_source, { alert: { completed: 7, follow_up: 2 } });
    for (const id of PROMOTE.filter((x) => ![255560, 255587].includes(x))) assert.equal(k.get(id).lane, "done");
    assert.equal(k.get(255587).lane, "inbox");
    assert.match(k.get(255587).title, /^Still owed after PR #7007 merged \(migration to run\): Auto-promote held staging->main/);
    assert.match(lastEvent(255580).summary, /^Alert ahd-auto-promote:staging->main:pr-6999 cleared: pull request lakesidegamedev\/AHDGame#6999 was merged \(99aa310\)\. This card was raised by the alert, so it closes with it\./);
    assert.equal((await run()).changed, 0);
  });

  it("the cannot-read-production cards clear when the monitor's next run succeeds, and a repeat reopens the same card", async () => {
    clock = new Date("2026-11-21T14:00:00Z");
    loadCards(READ);
    for (const id of READ) assert.equal(k.get(id).alert.key, "turn-hold-monitor:cannot-read-production");
    // Still failing: nothing.
    units.set("ahd-turn-hold-monitor.service", { loaded: true, active_state: "failed", result: "exit-code", exit_status: 2, exited_at: "2026-11-21T13:59:00Z" });
    assert.equal((await run()).changed, 0);
    // systemctl unreadable: nothing.
    units.clear();
    const unreadable = await run();
    assert.equal(unreadable.changed, 0);
    assert.deepEqual(unreadable.skipped_unknown_alerts, ["turn-hold-monitor:cannot-read-production"]);
    // The read works again.
    units.set("ahd-turn-hold-monitor.service", { loaded: true, active_state: "inactive", result: "success", exit_status: 0, exited_at: "2026-11-21T14:01:00Z" });
    const out = await run();
    assert.deepEqual(out.by_source, { alert: { completed: 9 } });
    assert.match(lastEvent(255443).summary, /cleared: ahd-turn-hold-monitor\.service ran successfully at 2026-11-21 14:01 UTC/);

    // The monitor reports the same condition 5 hours later: the most recently closed card reopens, no new card.
    later(5 * HOUR);
    const t = tools();
    const tr = card(255365);
    const before = k.db.prepare("SELECT COUNT(*) AS n FROM kanban_items").get().n;
    const reply = (await t.kanban_add({ product: "a-house-divided", title: tr.title, detail: tr.detail, kind: "bug", area: "turns", impact: "high", class: "issue", actor: "turn-hold-monitor", force: true })).o;
    assert.equal(reply.reopened, true);
    assert.ok(READ.includes(reply.id));
    assert.match(String(reply.id), /^\d+$/, "the monitor script still finds an id");
    assert.equal(k.db.prepare("SELECT COUNT(*) AS n FROM kanban_items").get().n, before);
    assert.equal(k.get(reply.id).lane, "inbox");
    assert.equal(lastEvent(reply.id).event_type, "source_reopened");
    // While open, a further repeat is recorded on it.
    later(HOUR);
    const again = (await t.kanban_add({ product: "a-house-divided", title: tr.title, detail: tr.detail, kind: "bug", actor: "turn-hold-monitor", force: true })).o;
    assert.equal(again.id, reply.id);
    assert.equal(lastEvent(reply.id).event_type, "alert_repeated");
    // It clears again on the next good run after the repeat.
    units.set("ahd-turn-hold-monitor.service", { loaded: true, active_state: "inactive", result: "success", exit_status: 0, exited_at: clock.toISOString() });
    later(60_000);
    units.get("ahd-turn-hold-monitor.service").exited_at = clock.toISOString();
    assert.deepEqual((await run()).by_source, { alert: { completed: 1 } });
    // After the reopen window, a repeat files a new card.
    later(4 * DAY);
    const fresh = (await t.kanban_add({ product: "a-house-divided", title: tr.title, detail: tr.detail, kind: "bug", actor: "turn-hold-monitor", force: true })).o;
    assert.ok(!READ.includes(fresh.id));
  });

  it("a cleared alert card someone is working is kept, noted", async () => {
    const c = k.add({ product: "ahd", title: "Service FAILED: rag-reindex", detail: "Status: no status file", kind: "ops" }, { actor: "backup-alert" });
    later(HOUR);
    k.report({ id: c.id, event: "started", summary: "Looking at why the index build exits 1", actor: "claude:idx" });
    units.set("rag-reindex.service", { loaded: true, active_state: "inactive", result: "success", exit_status: 0, exited_at: new Date(clock.getTime() + 60_000).toISOString() });
    later(2 * HOUR);
    const out = await run();
    assert.deepEqual(out.by_source, { alert: { follow_up: 1 } });
    assert.equal(k.get(c.id).lane, "now");
    assert.match(lastEvent(c.id).summary, /Work was reported on this card after the alert, so it stays open/);
  });

  it("kanban_alert_clear closes the alert's open cards", async () => {
    const c = k.add({ product: "ahd", title: "Disk nearly full", alert_key: "disk:root" }, { actor: "disk-monitor" });
    const out = (await tools().kanban_alert_clear({ alert_key: "disk:root", summary: "usage back under 80%", actor: "disk-monitor" })).o;
    assert.deepEqual(out.closed.map((x) => x.id), [c.id]);
    assert.match(lastEvent(c.id).summary, /^Alert disk:root cleared: usage back under 80%\./);
  });
});

describe("one pass for every source", () => {
  beforeEach(() => { fresh(); R = readers(); });

  it("tickets, pull requests and alerts reconcile together, and twice changes nothing", async () => {
    const tickets = { records: [{ ticketNumber: 1852, status: "resolved", resolvedAt: "2026-11-21T11:00:00Z", statusHistory: [{ status: "resolved", at: "2026-11-21T11:00:00Z" }], resolution: { message: "Fixed." } }] };
    const reader = createTicketStatusReader({ getDb: async () => ({ collection: () => ({ find: (q) => ({ toArray: async () => tickets.records.filter((r) => q.ticketNumber.$in.includes(r.ticketNumber)) }) }) }), now: () => clock.getTime() });
    const a = k.add({ product: "ahd", title: "Tech prices unreachable (ticket 1852)", lane: "next", assigned_to: "keir" }, { actor: "keir" });
    const b = k.add({ product: "ahd", title: "Ratio refresh", lane: "backlog", pull_request: "lakesidegamedev/AHDGame#1" }, { actor: "codex" });
    const c = k.add({ product: "ahd", title: "Backup unit FAILED: ahd-us-prod-backup", kind: "ops" }, { actor: "backup-alert" });
    gh.prs.set("lakesidegamedev/AHDGame#1", merged("2026-11-21T11:00:00Z"));
    units.set("ahd-us-prod-backup.service", { loaded: true, active_state: "inactive", result: "success", exit_status: 0, exited_at: "2026-11-21T11:00:00Z" });
    later(2 * HOUR);
    const first = await run({ reader });
    assert.deepEqual(first.by_source, { ticket: { completed: 1 }, pull_request: { completed: 1 }, alert: { completed: 1 } });
    for (const id of [a.id, b.id, c.id]) assert.equal(k.get(id).events[0].event_type, "source_closed");
    const second = await run({ reader });
    assert.equal(second.changed, 0);
  });

  it("the dry run reports and changes nothing", async () => {
    const b = k.add({ product: "ahd", title: "Ratio refresh", lane: "backlog", pull_request: "lakesidegamedev/AHDGame#1" }, { actor: "codex" });
    gh.prs.set("lakesidegamedev/AHDGame#1", merged("2026-11-21T11:00:00Z"));
    const dry = await run({ dryRun: true });
    assert.equal(dry.changes[0].action, "completed");
    assert.equal(k.get(b.id).lane, "backlog");
  });
});

describe("lanes mean what they say", () => {
  beforeEach(() => { fresh(); R = readers(); });

  it("start:true needs someone to be working it", async () => {
    const r = await tools().kanban_add({ product: "ahd", title: "Something", start: true });
    assert.equal(r.ok, false);
    assert.match(r.m, /start:true puts the card in Now/);
    assert.equal(k.add({ product: "ahd", title: "Something", start: true }, { actor: "claude:s1" }).assigned_to, "claude:s1");
  });

  it("brief and list count parked and unassigned cards per lane", () => {
    k.add({ product: "ahd", title: "Old idea", lane: "backlog" }, { actor: "claude" });
    k.add({ product: "ahd", title: "Committed", lane: "next", assigned_to: "codex" }, { actor: "claude" });
    later(15 * DAY);
    k.add({ product: "ahd", title: "Fresh inbox card", lane: "inbox" }, { actor: "claude" });
    const lanes = k.brief({}).lanes;
    assert.deepEqual(lanes.backlog, { cards: 1, no_activity_14d: 1, unassigned: 1 });
    assert.deepEqual(lanes.next, { cards: 1, no_activity_14d: 1, unassigned: 0 });
    assert.deepEqual(lanes.inbox, { cards: 1, no_activity_14d: 0, unassigned: 1 });
    assert.deepEqual(k.list({ product: "ahd" }).lanes.backlog, lanes.backlog);
  });
});
