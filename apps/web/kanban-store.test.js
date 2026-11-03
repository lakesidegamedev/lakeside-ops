// Unit tests for the product kanban store, routes and MCP tools.
// Run: node --test kanban-store.test.js
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openKanban, parseGithubRef } = require("./kanban-store");
const { handleKanbanRoute } = require("./kanban-routes");
const { registerKanbanTools } = require("./mcp/kanban-tools");

let clock;
let k;
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-test-"));
  clock = new Date("2026-10-09T12:00:00Z");
  k = openKanban(path.join(dir, "kanban.db"), { now: () => clock });
  k.upsertProduct({ slug: "a-house-divided", name: "A House Divided", aliases: ["ahd", "ahdgame", "adhd-bot"] });
  k.upsertProduct({ slug: "metroforge", name: "MetroForge", aliases: ["mf"] });
  k.db.prepare("INSERT INTO kanban_github_sources (repo, product) VALUES ('lakesidegamedev/AHDGame', 'a-house-divided')").run();
}
const days = (n) => { clock = new Date(clock.getTime() + n * 86_400_000); };

describe("kanban store", () => {
  beforeEach(fresh);

  it("resolves product aliases case-insensitively, including owner/repo", () => {
    for (const name of ["ahd", "AHDGame", "adhd-bot", "lakesidegamedev/AHDGame", "A House Divided", "a-house-divided"]) {
      assert.equal(k.resolveProduct(name), "a-house-divided", name);
    }
    assert.throws(() => k.resolveProduct("nope"), /unknown product/);
  });

  it("add with start:true lands in now, assigned, with a started event", () => {
    const item = k.add({ product: "ahd", title: "Fix the globe", start: true, summary: "on it" }, { actor: "claude" });
    assert.equal(item.lane, "now");
    assert.equal(item.assigned_to, "claude");
    assert.deepEqual(item.events.map((e) => e.event_type).sort(), ["created", "started"]);
    assert.ok(item.updated_at);
  });

  it("work_report events move lanes and set needs_owner; idempotency key dedupes", () => {
    const { id } = k.add({ product: "mf", title: "Station costs" });
    assert.equal(k.report({ id, event: "started", summary: "go", actor: "codex" }).item.lane, "now");
    assert.equal(k.report({ id, event: "blocked", summary: "waiting" }).item.lane, "blocked");
    const asked = k.report({ id, event: "decision_requested", summary: "pick A or B", idempotency_key: "k1" });
    assert.equal(asked.item.needs_owner, true);
    assert.equal(k.report({ id, event: "decision_requested", summary: "again", idempotency_key: "k1" }).duplicate, true);
    const done = k.report({ id, event: "completed", summary: "shipped", evidence_url: "https://github.com/lakesidegamedev/AHDGame/pull/1" });
    assert.equal(done.item.lane, "done");
    assert.equal(done.item.needs_owner, false);
    assert.equal(done.item.evidence_url, "https://github.com/lakesidegamedev/AHDGame/pull/1");
    assert.throws(() => k.report({ id, event: "shipped", summary: "x" }), /event must be one of/);
    assert.throws(() => k.report({ id, event: "progress", summary: "x", evidence_url: "javascript:alert(1)" }), /http/);
  });

  it("derives staleness for now items after 5 days, filters on it, and an update clears it", () => {
    const { id } = k.add({ product: "ahd", title: "Old work", lane: "now" });
    k.add({ product: "ahd", title: "Old backlog", lane: "backlog" });
    days(6);
    assert.deepEqual(k.list({ stale: true }).items.map((i) => i.id), [id]);
    assert.equal(k.list({ stale: false }).items.length, 1);
    k.update(id, { detail: "reviewed" }, { actor: "owner" });
    assert.equal(k.list({ stale: true }).items.length, 0);
    k.update(id, { stale: true });
    assert.equal(k.get(id).stale, true);
  });

  it("brief leads with the rules and leaves monitors out of the lanes", () => {
    k.add({ product: "ahd", title: "Building the casino", lane: "now" }, { actor: "codex" });
    const mon = k.add({ product: "ahd", title: "Watchkeeper heartbeat", lane: "now", kind: "monitor" }, { actor: "keir" });
    const brief = k.brief({ product: "AHDGame", actor: "codex" });
    assert.match(brief.rules, /start:true/);
    assert.equal(brief.counts.now, 1);
    assert.equal(brief.now[0].title, "Building the casino");
    assert.equal(brief.monitors[0].id, mon.id);
    assert.equal(brief.needs_owner, undefined);
  });

  it("Next needs an owner: unowned filings land in the inbox", () => {
    const filed = k.add({ product: "ahd", title: "Keir filed a follow-up", lane: "next" }, { actor: "keir" });
    assert.equal(filed.lane, "inbox");
    const owned = k.add({ product: "ahd", title: "Committed work item", lane: "next", assigned_to: "codex" }, { actor: "owner@example.com" });
    assert.equal(owned.lane, "next");
  });

  it("returns an existing open card instead of adding a near-duplicate", () => {
    const first = k.add({ product: "ahd", title: "Ticket 1757: power output shown as unsold" }, { actor: "keir" });
    const again = k.add({ product: "ahd", title: "Ticket 1757 power output shown as unsold" }, { actor: "keir" });
    assert.equal(again.duplicate, true);
    assert.equal(again.duplicate_of, first.id);
    assert.notEqual(k.add({ product: "ahd", title: "Ticket 1757 power output shown as unsold", force: true }, { actor: "keir" }).id, first.id);
  });

  it("caps cards in progress per actor, exempting keir, with force to override", () => {
    for (let n = 0; n < 3; n += 1) k.add({ product: "ahd", title: `codex task number ${n} alpha`, start: true }, { actor: "codex" });
    assert.throws(() => k.add({ product: "ahd", title: "codex fourth task beta", start: true }, { actor: "Codex" }), /cap 3/);
    assert.equal(k.add({ product: "ahd", title: "codex fourth task beta", start: true, force: true }, { actor: "codex" }).lane, "now");
    for (let n = 0; n < 4; n += 1) k.add({ product: "ahd", title: `keir ticket job ${n} gamma`, start: true }, { actor: "keir" });
  });

  it("normalizes actors, rejects owner questions, JSON progress and evidence-free completion", () => {
    const { id } = k.add({ product: "ahd", title: "Plain work item", start: true }, { actor: "claude-opus-5-5" });
    assert.equal(k.get(id).assigned_to, "claude");
    assert.throws(() => k.add({ product: "ahd", title: "Decision: merge or hold?" }, { actor: "claude" }), /owner/);
    assert.throws(() => k.report({ id, event: "progress", summary: '{"role":{"enabled":true}}', actor: "claude" }), /plain sentence/);
    assert.throws(() => k.report({ id, event: "completed", summary: "done", actor: "claude" }), /evidence/);
    assert.equal(k.report({ id, event: "completed", summary: "done", actor: "claude", no_evidence_reason: "config-only change" }).item.lane, "done");
  });

  it("monitor heartbeats update the card and log at most one event an hour", () => {
    const mon = k.add({ product: "ahd", title: "Engineering monitor", lane: "now", kind: "monitor" }, { actor: "keir" });
    for (let n = 0; n < 5; n += 1) k.report({ id: mon.id, event: "progress", summary: '{"capacity":1}', actor: "keir" });
    const events = k.get(mon.id, { events: 50 }).events.filter((e) => e.event_type === "heartbeat");
    assert.equal(events.length, 1);
  });

  it("maintain releases quiet Now cards and inboxes unowned untouched Next cards", () => {
    const quiet = k.add({ product: "ahd", title: "Quiet card in progress", start: true }, { actor: "muse" });
    const next = k.add({ product: "ahd", title: "Unowned next card", lane: "next", assigned_to: "x" }, { actor: "owner@example.com" });
    k.update(next.id, { assigned_to: "" }, { actor: "owner@example.com" });
    days(4);
    const out = k.maintain();
    assert.ok(out.released >= 1);
    assert.equal(k.get(quiet.id).lane, "next");
    assert.equal(k.get(quiet.id).assigned_to, null);
    assert.equal(k.get(next.id).lane, "inbox");
  });

  it("groups cards by area and class, with child cards under a project", () => {
    const proj = k.add({ product: "ahd", title: "Market rebuild program", class: "project", area: "economy" }, { actor: "claude" });
    const step = k.add({ product: "ahd", title: "Market rebuild phase one relief", parent_id: proj.id, class: "issue", area: "economy" }, { actor: "claude" });
    assert.equal(step.parent_id, proj.id);
    assert.deepEqual(k.get(proj.id).children.map((c) => c.id), [step.id]);
    assert.equal(k.list({ area: "economy", class: "project" }).items[0].id, proj.id);
    assert.throws(() => k.add({ product: "ahd", title: "Bad area card here", area: "nowhere" }, { actor: "claude" }), /area for a-house-divided/);
    assert.equal(k.update(step.id, { parent_id: 0 }, { actor: "claude" }).parent_id, null);
  });

  it("aliases resolve folded ids to the survivor", () => {
    const { id } = k.add({ product: "ahd", title: "Survivor" });
    k.db.prepare("INSERT INTO kanban_item_aliases (alias_id, item_id) VALUES (999999, ?)").run(id);
    assert.equal(k.get(999999).id, id);
    assert.equal(k.update(999999, { lane: "next" }).lane, "next");
  });

  it("parses GitHub refs and rejects duplicates links", () => {
    assert.deepEqual(parseGithubRef("lakesidegamedev/AHDGame#12"), { repo: "lakesidegamedev/AHDGame", number: 12, url: "https://github.com/lakesidegamedev/AHDGame/issues/12" });
    assert.equal(parseGithubRef("https://github.com/lakesidegamedev/AHDGame/issues/7?x=1").number, 7);
    k.add({ product: "ahd", title: "linked", github: "lakesidegamedev/AHDGame#12" });
    assert.throws(() => k.add({ product: "ahd", title: "again", github: "lakesidegamedev/AHDGame#12" }), /already item/);
  });

  it("github sync imports open issues, keeps updated_at on no-op, closes confirmed-closed links", async () => {
    const linked = k.add({ product: "ahd", title: "local twin", lane: "now", github: "lakesidegamedev/AHDGame#5" });
    const calls = [];
    let open = [{ number: 5, title: "tracker", url: "https://github.com/lakesidegamedev/AHDGame/issues/5", labels: [] },
      { number: 9, title: "new bug", url: "https://github.com/lakesidegamedev/AHDGame/issues/9", labels: [{ name: "blocked" }] }];
    const run = async (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "issue") return { stdout: JSON.stringify(open) };
      return { stdout: JSON.stringify({ state: "closed", title: "tracker", html_url: "u", labels: [] }) };
    };
    let [result] = await k.syncGithub({ run });
    assert.equal(result.added, 1);
    const imported = k.list({ q: "new bug" }).items[0];
    assert.equal(imported.lane, "blocked");
    assert.equal(k.get(linked.id).updated_at, linked.updated_at, "sync must not refresh updated_at on a no-op");
    assert.equal(k.get(linked.id).title, "local twin", "sync must not overwrite a local title");
    open = open.filter((i) => i.number !== 5);
    [result] = await k.syncGithub({ run });
    assert.equal(result.closed, 1);
    assert.equal(k.get(linked.id).lane, "done");
    assert.ok(calls.some((c) => c.startsWith("api repos/lakesidegamedev/AHDGame/issues/5")));
  });
});

function fakeRes() {
  return { status: 0, headers: {}, body: "", writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(b) { this.body = b || ""; }, setHeader() {} };
}
function fakeReq({ method = "GET", body, headers = {} } = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : [];
  return { method, headers: { host: "ops.example.com", ...headers }, async *[Symbol.asyncIterator]() { yield* chunks; } };
}

describe("kanban routes", () => {
  beforeEach(fresh);
  const ctx = (session) => ({ resolveSession: async () => session, addSecurityHeaders: () => {}, renderShell: ({ body }) => `<html>${body}</html>`, store: () => k });

  it("redirects signed-out visitors and 404s non-admins", async () => {
    let res = fakeRes();
    await handleKanbanRoute(fakeReq(), res, "/kanban", ctx(null));
    assert.equal(res.status, 302);
    res = fakeRes();
    await handleKanbanRoute(fakeReq(), res, "/kanban", ctx({ role: "moderator" }));
    assert.equal(res.status, 404);
    res = fakeRes();
    await handleKanbanRoute(fakeReq(), res, "/api/kanban", ctx({ role: "moderator" }));
    assert.equal(res.status, 404);
  });

  it("lets Junior Developers read the board and detail but rejects administrative edits", async () => {
    const item = k.add({ product: "ahd", title: "Developer task" });
    for (const path of ["/kanban", "/api/kanban", "/api/kanban/brief", "/api/kanban/items/" + item.id]) {
      const res = fakeRes();
      await handleKanbanRoute(fakeReq(), res, path, ctx({ role: "junior_dev", email: "dev@example.com" }));
      assert.equal(res.status, 200, path);
      if (path === "/kanban") {
        assert.ok(res.body.includes('data-read-only="true"'));
        assert.ok(res.body.includes('hidden disabled'));
      }
    }
    const res = fakeRes();
    await handleKanbanRoute(fakeReq({ method: "POST", body: { lane: "done" }, headers: { "x-requested-with": "ops-dashboard", origin: "https://ops.example.com" } }), res, "/api/kanban/items/" + item.id, ctx({ role: "junior_dev" }));
    assert.equal(res.status, 403);
    assert.equal(k.get(item.id).lane, item.lane);
  });

  it("lets a Junior Developer claim, report, block, resume, release and complete their own task", async () => {
    const item = k.add({ product: "ahd", title: "Shared economy work" });
    const context = ctx({ role: "junior_dev", email: "dev@example.com" });
    const post = async body => {
      const res = fakeRes();
      await handleKanbanRoute(fakeReq({ method: "POST", body, headers: {
        "x-requested-with": "ops-dashboard", origin: "https://ops.example.com",
      } }), res, `/api/kanban/items/${item.id}/collaborate`, context);
      return res;
    };
    assert.equal((await post({ action: "claim" })).status, 200);
    assert.equal(k.get(item.id).assigned_to, "dev@example.com");
    for (const action of ["progress", "blocked", "resume"]) {
      assert.equal((await post({ action, summary: "Verified current receipts" })).status, 200);
    }
    assert.equal((await post({ action: "release", summary: "Remaining query work needs a new owner" })).status, 200);
    assert.equal(k.get(item.id).assigned_to, null);
    assert.equal(k.get(item.id).lane, "inbox");
    await post({ action: "claim" });
    assert.equal((await post({ action: "completed", summary: "Done" })).status, 400);
    assert.equal((await post({ action: "completed", summary: "Verified repair", evidence_url: "https://github.com/example/game/pull/1" })).status, 200);
    assert.equal(k.get(item.id).lane, "done");
    assert.ok(k.get(item.id).events.every(event => event.actor !== "admin"));
  });

  it("rejects taking another owner's task, spoofing fields, and cross-origin collaboration", async () => {
    const item = k.add({ product: "ahd", title: "Claimed work", start: true }, { actor: "codex:other" });
    const headers = { "x-requested-with": "ops-dashboard", origin: "https://ops.example.com" };
    for (const [body, requestHeaders, expected] of [
      [{ action: "claim" }, headers, 409],
      [{ action: "progress", summary: "Mine now" }, headers, 403],
      ...["blocked", "resume", "release", "completed"].map(action => [{ action, summary: "Mine now" }, headers, 403]),
      [{ action: "claim", actor: "codex:other" }, headers, 400],
      [{ action: "claim", force: true }, headers, 400],
      [{ action: "claim", assigned_to: "dev@example.com" }, headers, 400],
      [{ action: "claim" }, { ...headers, origin: "https://attacker.example" }, 403],
    ]) {
      const res = fakeRes();
      await handleKanbanRoute(fakeReq({ method: "POST", body, headers: requestHeaders }), res,
        `/api/kanban/items/${item.id}/collaborate`, ctx({ role: "junior_dev", email: "dev@example.com" }));
      assert.equal(res.status, expected, JSON.stringify(body));
      assert.equal(k.get(item.id).assigned_to, "codex:other");
    }
  });

  it("serializes claims across database connections and MCP started reports cannot steal them", () => {
    const item = k.add({ product: "ahd", title: "Concurrent ownership" });
    const other = openKanban(k.path);
    try {
      k.collaborate({ id: item.id, action: "claim", actor: "dev@example.com" });
      assert.throws(() => other.collaborate({ id: item.id, action: "claim", actor: "other@example.com" }), /already assigned/);
      assert.throws(() => other.report({ id: item.id, event: "started", summary: "Starting", actor: "codex" }), /already assigned/);
      assert.equal(other.get(item.id).assigned_to, "dev@example.com");
    } finally { other.close(); }
  });

  it("does not let collaboration reopen closed tasks, take monitors or bypass the work cap", () => {
    const done = k.add({ product: "ahd", title: "Finished task" });
    k.update(done.id, { lane: "done" });
    const monitor = k.add({ product: "ahd", title: "Continuous health monitor", kind: "monitor" });
    for (const item of [done, monitor]) {
      assert.throws(() => k.collaborate({ id: item.id, action: "claim", actor: "codex:contributor" }), /not available/);
    }
    for (let index = 0; index < 3; index++) {
      const task = k.add({ product: "ahd", title: `Assigned delivery slice ${index}`, force: true });
      k.collaborate({ id: task.id, action: "claim", actor: "codex:contributor" });
    }
    const excess = k.add({ product: "ahd", title: "Fourth delivery slice", force: true });
    assert.throws(() => k.collaborate({ id: excess.id, action: "claim", actor: "codex:contributor" }), /cap/);
    assert.equal(k.get(excess.id).assigned_to, null);
  });

  it("renders for admins and requires the same-origin header to write", async () => {
    k.add({ product: "ahd", title: "<script>x</script>" });
    let res = fakeRes();
    await handleKanbanRoute(fakeReq(), res, "/kanban", ctx({ role: "admin", email: "a@x" }));
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes("<script>x</script>"), "board JSON must not close the script element");
    res = fakeRes();
    await handleKanbanRoute(fakeReq({ method: "POST", body: { product: "ahd", title: "t" } }), res, "/api/kanban/items", ctx({ role: "admin" }));
    assert.equal(res.status, 403);
    res = fakeRes();
    await handleKanbanRoute(fakeReq({ method: "POST", body: { product: "ahd", title: "t" }, headers: { "x-requested-with": "ops-dashboard", origin: "https://ops.example.com" } }), res, "/api/kanban/items", ctx({ role: "admin", email: "a@x" }));
    assert.equal(res.status, 201);
    assert.equal(JSON.parse(res.body).events[0].actor, "a@x");
    assert.equal(await handleKanbanRoute(fakeReq(), fakeRes(), "/tracker", ctx(null)), false);
  });
});

describe("kanban MCP tools", () => {
  beforeEach(fresh);
  function tools(write) {
    const registered = {};
    const server = { tool: (name, _d, _s, fn) => { registered[name] = fn; } };
    registerKanbanTools(server, {
      auth: { name: "test", scopes: { write } },
      jsonResult: (o) => ({ ok: true, o }),
      errorResult: (m) => ({ ok: false, m }),
      store: () => k,
    });
    return registered;
  }

  it("agents cannot flag owner decisions: decision_requested is a progress note", async () => {
    const t = tools(true);
    const added = (await t.kanban_add({ product: "ahd", title: "Pick a rate", needs_owner: true })).o;
    assert.equal(added.needs_owner, false);
    await t.kanban_update({ id: added.id, needs_owner: true });
    await t.work_report({ id: added.id, event: "decision_requested", summary: "A or B?" });
    const row = k.get(added.id).item || k.get(added.id);
    assert.equal(row.needs_owner, false);
    assert.match(JSON.stringify(k.get(added.id)), /Decision pending with the owner in chat: A or B\?/);
  });

  it("registers the agent verbs and gates writes on scope", async () => {
    const t = tools(false);
    assert.deepEqual(Object.keys(t).sort(), ["kanban_add", "kanban_brief", "kanban_get", "kanban_github_sync", "kanban_list", "kanban_update", "work_report"]);
    assert.equal((await t.kanban_add({ product: "ahd", title: "x" })).ok, false);
    assert.equal((await t.kanban_list({})).ok, true);
    const w = tools(true);
    const added = await w.kanban_add({ product: "adhd-bot", title: "x", start: true, actor: "claude" });
    assert.equal(added.o.lane, "now");
    assert.equal((await w.kanban_add({ product: "zzz", title: "x" })).m.includes("unknown product"), true);
  });
});
