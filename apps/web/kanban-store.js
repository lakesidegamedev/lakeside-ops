"use strict";

// kanban-store.js: the product kanban (admin page + agent MCP tools).
//
// One SQLite file shared by two processes: the dashboard (page and REST API)
// and the ops-knowledge MCP (agent tools). better-sqlite3 is synchronous and
// WAL mode lets both open the same file safely. The path comes from
// OPS_KANBAN_DB so both units point at the same database; the default keeps a
// development checkout self-contained.
//
// Lanes: now | next | blocked | backlog are the open board; done holds closed
// work so history survives. "Needs owner" is a flag, not a lane: the board
// pulls flagged items out of their lane into one section so owner decisions
// are never scattered. "Stale" is derived: an item in `now` with no update for
// STALE_DAYS days, or one explicitly flagged (stale_flagged_at). Any update
// clears the explicit flag.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

// inbox: filed but not picked up (automatic intake). next: committed, has an owner.
const OPEN_LANES = ["now", "next", "blocked", "inbox", "backlog"];
const LANES = [...OPEN_LANES, "done"];
const IMPACTS = ["high", "medium", "low"];
const REPORT_EVENTS = ["started", "progress", "blocked", "decision_requested", "completed"];
const STALE_DAYS = 5;
// Board hygiene (owner, 2026-11-03, from the kanban audit).
const RELEASE_DAYS = 3;     // Now cards with no update for this long go back to Next
const EXPIRE_DAYS = 90;     // untouched local backlog cards close as expired
const INBOX_AFTER_DAYS = 1; // unassigned, untouched Next cards fall back to Inbox
const WIP_CAP = Number(process.env.KANBAN_WIP_CAP || 3);
const WIP_EXEMPT = /^(keir|system|github-sync)\b/;
const MONITOR_EVENT_EVERY_MS = 60 * 60_000;
// Grouping: a card is a project (multi-step program, may have child cards),
// an issue (something broken or owed: a bug, a ticket follow-up, a release
// step) or an idea (a proposal nobody has committed to). Areas group cards
// inside a product.
const CLASSES = ["project", "issue", "idea"];
const AREAS = {
  "a-house-divided": { economy: "Economy & markets", politics: "Elections & politics", turns: "Turn engine & performance", apps: "Apps & native clients", web: "Web pages & UI", support: "Player tickets & support", releases: "Releases & deploys", keir: "Keir", infra: "Infrastructure & tooling", world: "Worlds, seeds & resets" },
  "lakeside-mcp": { keir: "Keir", capabilities: "MCP tools & reads", ops: "Ops & tooling", ask: "Ask" },
  "corporate-warfare": { game: "Game", platforms: "Platforms & release" },
  "margin-of-victory": { game: "Game", platforms: "Platforms & release" },
  metroforge: { game: "Game", platforms: "Platforms & release" },
  "grand-century": { game: "Game", platforms: "Platforms & release" },
  verdigris: { game: "Game" },
  foreshore: { game: "Game" },
};
function areaFor(product, area) {
  const a = String(area || "").trim().toLowerCase();
  if (!a) return null;
  const table = AREAS[product] || { game: "Game" };
  if (!(a in table)) throw badInput(`area for ${product} must be one of ${Object.keys(table).join(", ")}`);
  return a;
}
function classFor(value) {
  const c = String(value || "").trim().toLowerCase();
  if (!c) return null;
  if (!CLASSES.includes(c)) throw badInput(`class must be one of ${CLASSES.join(", ")}`);
  return c;
}
// Fixed kind vocabulary; synonyms map onto it.
const KINDS = ["bug", "feature", "ops", "balance", "support", "capability", "audit", "task", "monitor"];
const KIND_SYNONYMS = { issue: "bug", defect: "bug", enhancement: "feature", operations: "ops", infra: "ops", infrastructure: "ops", economy: "balance", ticket: "support", research: "audit", investigation: "audit", chore: "task", docs: "task" };
function normalizeKind(kind) {
  const k = String(kind || "").trim().toLowerCase();
  if (!k) return "task";
  if (KINDS.includes(k)) return k;
  return KIND_SYNONYMS[k] || "task";
}
// One name per agent: "claude-opus-5-5", "Claude", "opus" all become "claude".
// A session suffix after ":" or "#" is kept so parallel sessions stay apart.
function normalizeActor(actor) {
  const raw = String(actor || "").trim();
  if (!raw) return "";
  if (/@/.test(raw)) return raw.slice(0, 120);
  const [base, ...rest] = raw.split(/[:#]/);
  const b = base.toLowerCase();
  if (/^platform-agents|token|^agent$/.test(b)) return "";
  const name = /^(claude|opus|sonnet|haiku|fable)/.test(b) ? "claude" : /^(codex|gpt)/.test(b) ? "codex" : /^keir/.test(b) ? "keir"
    : /^muse/.test(b) ? "muse" : /^(deepseek|ds-|opencode)/.test(b) ? "deepseek" : b.replace(/[^a-z0-9._-]+/g, "-").slice(0, 40);
  const session = rest.join(":").replace(/[^\w.-]+/g, "").slice(0, 40);
  return session ? `${name}:${session}` : name;
}
// Owner decisions are asked in chat, never filed as cards.
function isDecisionTitle(title) {
  return /^(decision|owner decision|ask (the )?owner)\b/i.test(title) || /\b(or hold|approve|should (we|i)|merge or)\b[^?]*\?\s*$/i.test(title);
}
function looksLikeJson(text) {
  const t = String(text || "").trim();
  return /^[{[]/.test(t) || /^\w[\w ]{0,30}:\s*\{/.test(t) || /"\w+":/.test(t.slice(0, 80));
}
const STOP = new Set(["a", "an", "the", "for", "to", "of", "and", "in", "on", "with", "without", "is", "be"]);
function titleTokens(title) {
  return new Set(String(title || "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").split(" ").filter((w) => w && !STOP.has(w)));
}
function titleRefs(title) {
  return (String(title || "").match(/(?:ticket\s*|#)(\d{2,6})/gi) || []).map((m) => m.replace(/\D/g, ""));
}
function similar(a, b) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}
const DAY_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kanban_products (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  mode        TEXT NOT NULL DEFAULT 'building',
  health      TEXT NOT NULL DEFAULT 'on_track',
  product_url TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
-- Same shape the dashboard's project registry reads (slug, name, mode, health,
-- product_url, archived), so portfolio.hubDbPath can point at this file.
CREATE VIEW IF NOT EXISTS products AS
  SELECT slug, name, mode, health, product_url, archived FROM kanban_products;

CREATE TABLE IF NOT EXISTS kanban_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product          TEXT NOT NULL REFERENCES kanban_products(slug),
  title            TEXT NOT NULL,
  detail           TEXT NOT NULL DEFAULT '',
  lane             TEXT NOT NULL DEFAULT 'backlog' CHECK (lane IN ('now','next','blocked','inbox','backlog','done')),
  impact           TEXT NOT NULL DEFAULT 'medium' CHECK (impact IN ('high','medium','low')),
  kind             TEXT NOT NULL DEFAULT 'task',
  needs_owner      INTEGER NOT NULL DEFAULT 0,
  assigned_to      TEXT,
  progress_summary TEXT NOT NULL DEFAULT '',
  last_progress_at TEXT,
  evidence_url     TEXT,
  source           TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','github')),
  github_repo      TEXT,
  github_number    INTEGER,
  github_url       TEXT,
  github_state     TEXT,
  github_labels    TEXT,
  github_synced_at TEXT,
  stale_flagged_at TEXT,
  legacy_hub_id    INTEGER,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT,
  area             TEXT,
  class            TEXT,
  parent_id        INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS kanban_items_github ON kanban_items(github_repo, github_number) WHERE github_repo IS NOT NULL;
CREATE INDEX IF NOT EXISTS kanban_items_lane ON kanban_items(lane, updated_at);
CREATE INDEX IF NOT EXISTS kanban_items_product ON kanban_items(product, lane);

-- Ids that were folded into another item (duplicates merged at import, or
-- later). Lookups by an alias id resolve to the surviving item.
CREATE TABLE IF NOT EXISTS kanban_item_aliases (
  alias_id INTEGER PRIMARY KEY,
  item_id  INTEGER NOT NULL REFERENCES kanban_items(id) ON DELETE CASCADE,
  reason   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS kanban_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER REFERENCES kanban_items(id) ON DELETE SET NULL,
  product         TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  actor           TEXT NOT NULL DEFAULT 'system',
  summary         TEXT NOT NULL DEFAULT '',
  evidence_url    TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kanban_events_item ON kanban_events(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kanban_events_created ON kanban_events(created_at DESC);

CREATE TABLE IF NOT EXISTS kanban_github_sources (
  repo         TEXT PRIMARY KEY,
  product      TEXT NOT NULL REFERENCES kanban_products(slug),
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_error   TEXT
);
`;

function defaultDbPath(env = process.env) {
  return path.resolve(env.OPS_KANBAN_DB || path.join(__dirname, "data", "kanban.db"));
}

function badInput(message) {
  const error = new Error(message);
  error.code = "BAD_INPUT";
  return error;
}

function clean(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/^[\w.-]+\//, "").replace(/[\s_]+/g, "-");
}

// Historical issue references must resolve to the same kanban item after a transfer.
const TRANSFERRED_REPOS = new Map([
  "AHDGame", "AHDClient", "AHDNative", "a-house-divided", "ahd-client",
  "ahd-android", "adhd-bot", "MOVGame", "MOVGame-native", "metroforge",
  "metroforge-native", "grand-century", "verdigris", "foreshore", "rialto",
  "lakeside-ops", "lakeside-code", "lakeside-operator", "LSGD-ops-dash", "ask",
].map((name) => [name.toLowerCase(), name]));
TRANSFERRED_REPOS.set("ahd-sim", "MOVGame");

function canonicalGithubRepo(repo) {
  const [owner, name] = repo.split("/");
  if (!name) return repo;
  if (!["egg3901", "lakesidegamedev"].includes(owner.toLowerCase())) return repo;
  const canonical = TRANSFERRED_REPOS.get(name.toLowerCase());
  return canonical ? `lakesidegamedev/${canonical}` : repo;
}

// Accepts "lakesidegamedev/AHDGame#123", "https://github.com/Egg3901/AHDGame/issues/123",
// or { repo, number }. Returns { repo, number, url } or null.
function parseGithubRef(input) {
  if (!input) return null;
  if (typeof input === "object" && input.repo && input.number) {
    const number = Number(input.number);
    if (!Number.isInteger(number) || number <= 0) throw badInput("github number must be a positive integer");
    const repo = canonicalGithubRepo(String(input.repo).trim());
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw badInput("github repo must look like owner/name");
    return { repo, number, url: `https://github.com/${repo}/issues/${number}` };
  }
  const text = String(input).trim();
  const url = text.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\b/);
  if (url) {
    const repo = canonicalGithubRepo(url[1]);
    return { repo, number: Number(url[2]), url: text.split(/[?#]/)[0].replace(`/${url[1]}/`, `/${repo}/`) };
  }
  const short = text.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (short) {
    const repo = canonicalGithubRepo(short[1]);
    return { repo, number: Number(short[2]), url: `https://github.com/${repo}/issues/${short[2]}` };
  }
  throw badInput(`unrecognized GitHub reference "${text}" (use owner/repo#N or an issue URL)`);
}

function checkUrl(value, field) {
  const url = clean(value, 2000);
  if (url && !/^https?:\/\//i.test(url)) throw badInput(`${field} must be an http(s) URL`);
  return url;
}

function laneForLabels(labels) {
  const names = new Set(labels.map((label) => String(label).toLowerCase()));
  if (names.has("blocked")) return "blocked";
  if (names.has("in progress") || names.has("in-progress") || names.has("doing")) return "now";
  return "backlog";
}

function kindForLabels(labels) {
  const names = labels.map((label) => String(label).toLowerCase());
  if (names.includes("enhancement") || names.includes("feature")) return "feature";
  if (names.includes("balance")) return "balance";
  return "bug";
}
function issueExcerpt(body) {
  const t = String(body || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "").trim();
  return t.length > 500 ? `${t.slice(0, 497)}...` : t;
}

function impactForLabels(labels) {
  const names = labels.map((label) => String(label).toLowerCase());
  if (names.some((name) => /critical|urgent|p0|p1|high priority/.test(name))) return "high";
  if (names.some((name) => /low priority|p3|p4/.test(name))) return "low";
  return "medium";
}

const execFileAsync = promisify(execFile);
const GH_BIN = process.env.GH_BIN || "gh";

async function ghJson(args, run = execFileAsync) {
  const { stdout } = await run(GH_BIN, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HOME: process.env.HOME || "/root" } });
  return JSON.parse(stdout);
}

async function fetchOpenIssues(repo, run) {
  return ghJson(["issue", "list", "--repo", repo, "--state", "open", "--limit", "1000", "--json", "number,title,url,labels,updatedAt,body"], run);
}

async function fetchIssueState(repo, number, run) {
  const issue = await ghJson(["api", `repos/${repo}/issues/${number}`], run);
  return { state: String(issue.state || "").toLowerCase(), title: issue.title, url: issue.html_url, labels: (issue.labels || []).map((l) => l.name) };
}

// Older databases were created before the inbox lane existed. SQLite cannot
// alter a CHECK constraint, so rebuild the table once (the documented
// create-copy-drop-rename sequence, foreign keys off for the swap).
function migrateLanes(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kanban_items'").get();
  if (!row || row.sql.includes("'inbox'")) return false;
  const create = /CREATE TABLE IF NOT EXISTS kanban_items \(([\s\S]*?)\n\);/.exec(SCHEMA)[0]
    .replace("CREATE TABLE IF NOT EXISTS kanban_items (", "CREATE TABLE kanban_items_new (");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(create);
      db.exec("INSERT INTO kanban_items_new SELECT * FROM kanban_items");
      db.exec("DROP TABLE kanban_items");
      db.exec("ALTER TABLE kanban_items_new RENAME TO kanban_items");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  db.exec(SCHEMA);
  return true;
}

function openKanban(dbPath = defaultDbPath(), { now = () => new Date() } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrateLanes(db);
  const cols = new Set(db.prepare("PRAGMA table_info(kanban_items)").all().map((c) => c.name));
  if (!cols.has("area")) db.exec("ALTER TABLE kanban_items ADD COLUMN area TEXT");
  if (!cols.has("class")) db.exec("ALTER TABLE kanban_items ADD COLUMN class TEXT");
  if (!cols.has("parent_id")) db.exec("ALTER TABLE kanban_items ADD COLUMN parent_id INTEGER");

  const iso = () => now().toISOString();

  function products({ includeArchived = false } = {}) {
    return db.prepare(`SELECT slug, name, aliases, mode, health, product_url, archived FROM kanban_products ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY sort_order, name`)
      .all().map((row) => ({ ...row, aliases: JSON.parse(row.aliases || "[]"), archived: Boolean(row.archived) }));
  }

  function upsertProduct({ slug, name, aliases = [], mode, health, product_url, archived = false, sort_order = 0 }) {
    db.prepare(`INSERT INTO kanban_products (slug, name, aliases, mode, health, product_url, archived, sort_order)
      VALUES (@slug, @name, @aliases, @mode, @health, @product_url, @archived, @sort_order)
      ON CONFLICT(slug) DO UPDATE SET name = excluded.name, aliases = excluded.aliases, mode = excluded.mode,
        health = excluded.health, product_url = excluded.product_url, archived = excluded.archived, sort_order = excluded.sort_order`)
      .run({ slug, name, aliases: JSON.stringify(aliases), mode: mode || "building", health: health || "on_track", product_url: product_url || null, archived: archived ? 1 : 0, sort_order });
  }

  // Slug, display name, or any alias, case-insensitive. "Egg3901/AHDGame"
  // drops the owner prefix first.
  function resolveProduct(input, { required = true } = {}) {
    if (input == null || input === "") {
      if (required) throw badInput("product is required");
      return null;
    }
    const key = normalizeKey(input);
    for (const product of products({ includeArchived: true })) {
      const names = [product.slug, product.name, ...product.aliases].map(normalizeKey);
      if (names.includes(key)) return product.slug;
    }
    throw badInput(`unknown product "${input}". Known: ${products().map((p) => `${p.slug} (${p.aliases.join(", ") || "no aliases"})`).join("; ")}`);
  }

  function resolveId(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw badInput("id must be a positive integer");
    if (db.prepare("SELECT 1 FROM kanban_items WHERE id = ?").get(n)) return n;
    const alias = db.prepare("SELECT item_id FROM kanban_item_aliases WHERE alias_id = ?").get(n);
    if (alias) return alias.item_id;
    const error = new Error(`item ${n} not found`);
    error.code = "NOT_FOUND";
    throw error;
  }

  function present(row, { full = false, at = now().getTime() } = {}) {
    const updated = Date.parse(row.updated_at);
    const ageDays = Number.isFinite(updated) ? Math.floor((at - updated) / DAY_MS) : null;
    const staleByAge = row.lane === "now" && ageDays != null && ageDays >= STALE_DAYS;
    const item = {
      id: row.id,
      product: row.product,
      title: row.title,
      lane: row.lane,
      impact: row.impact,
      kind: row.kind,
      needs_owner: Boolean(row.needs_owner),
      stale: Boolean(row.stale_flagged_at) || staleByAge,
      stale_reason: row.stale_flagged_at ? `flagged ${row.stale_flagged_at.slice(0, 10)}` : staleByAge ? `no update in ${ageDays} days` : null,
      assigned_to: row.assigned_to || null,
      progress_summary: row.progress_summary || "",
      last_progress_at: row.last_progress_at || null,
      evidence_url: row.evidence_url || null,
      source: row.source,
      github: row.github_repo ? { repo: row.github_repo, number: row.github_number, url: row.github_url, state: row.github_state } : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      age_days: ageDays,
      closed_at: row.closed_at || null,
      area: row.area || null,
      class: row.class || null,
      parent_id: row.parent_id || null,
    };
    if (full) {
      item.detail = row.detail;
      item.github_labels = row.github_labels ? JSON.parse(row.github_labels) : [];
      item.legacy_hub_id = row.legacy_hub_id || null;
    } else {
      item.detail_excerpt = row.detail.length > 280 ? `${row.detail.slice(0, 277)}...` : row.detail;
    }
    return item;
  }

  function rowById(id) {
    return db.prepare("SELECT * FROM kanban_items WHERE id = ?").get(id);
  }

  function logEvent({ item_id, product, event_type, actor = "system", summary = "", evidence_url = null, idempotency_key = null, created_at = iso() }) {
    db.prepare(`INSERT INTO kanban_events (item_id, product, event_type, actor, summary, evidence_url, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(item_id, product, event_type, actor, summary, evidence_url, idempotency_key, created_at);
  }

  const STALE_SQL = `(stale_flagged_at IS NOT NULL OR (lane = 'now' AND julianday(?) - julianday(updated_at) >= ${STALE_DAYS}))`;

  function list({ product, lane, lanes, stale, needs_owner, include_done = false, q, source, assigned_to, kind, include_monitors = true, area, class: cls, parent_id, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (product) { where.push("product = ?"); params.push(resolveProduct(product)); }
    const laneList = lanes || (lane ? [lane] : null);
    if (laneList) {
      for (const l of laneList) if (!LANES.includes(l)) throw badInput(`lane must be one of ${LANES.join(", ")}`);
      where.push(`lane IN (${laneList.map(() => "?").join(",")})`);
      params.push(...laneList);
    } else if (!include_done) {
      where.push("lane != 'done'");
    }
    if (stale === true) { where.push(STALE_SQL); params.push(iso()); }
    if (stale === false) { where.push(`NOT ${STALE_SQL}`); params.push(iso()); }
    if (needs_owner === true) where.push("needs_owner = 1");
    if (needs_owner === false) where.push("needs_owner = 0");
    if (source) { where.push("source = ?"); params.push(source); }
    if (assigned_to) { where.push("(assigned_to = ? OR assigned_to LIKE ?)"); const a = normalizeActor(assigned_to) || assigned_to; params.push(a, `${a}:%`); }
    if (kind) { where.push("kind = ?"); params.push(normalizeKind(kind)); }
    if (!include_monitors) where.push("kind != 'monitor'");
    if (area) { where.push("area = ?"); params.push(String(area).toLowerCase()); }
    if (cls) { where.push("class = ?"); params.push(classFor(cls)); }
    if (parent_id) { where.push("parent_id = ?"); params.push(Number(parent_id)); }
    if (q) { where.push("(title LIKE ? OR detail LIKE ? OR progress_summary LIKE ?)"); const like = `%${q}%`; params.push(like, like, like); }
    const max = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const rows = db.prepare(`SELECT * FROM kanban_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE lane WHEN 'now' THEN 0 WHEN 'blocked' THEN 1 WHEN 'next' THEN 2 WHEN 'inbox' THEN 3 WHEN 'backlog' THEN 4 ELSE 5 END,
        CASE impact WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`).all(...params, max + 1);
    const at = now().getTime();
    const truncated = rows.length > max;
    return { items: rows.slice(0, max).map((row) => present(row, { at })), truncated, ...(truncated ? { hint: "More items match. Narrow with product, lane, assigned_to or q, or raise limit." } : {}) };
  }

  function get(id, { events = 25 } = {}) {
    const realId = resolveId(id);
    const item = present(rowById(realId), { full: true });
    item.aliases = db.prepare("SELECT alias_id, reason FROM kanban_item_aliases WHERE item_id = ?").all(realId);
    item.children = db.prepare("SELECT id, title, lane FROM kanban_items WHERE parent_id = ? ORDER BY CASE lane WHEN 'done' THEN 1 ELSE 0 END, id").all(realId);
    item.events = db.prepare("SELECT event_type, actor, summary, evidence_url, created_at FROM kanban_events WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(realId, events);
    return item;
  }

  // Open Now cards (not monitors) held by one actor.
  function heldBy(actor, exceptId = 0) {
    if (!actor) return [];
    return db.prepare("SELECT id, title FROM kanban_items WHERE lane = 'now' AND kind != 'monitor' AND assigned_to = ? AND id != ?").all(actor, exceptId);
  }
  function checkWip(actor, { force, exceptId = 0 } = {}) {
    if (force || !actor || WIP_EXEMPT.test(actor) || /@/.test(actor)) return;
    const held = heldBy(actor, exceptId);
    if (held.length >= WIP_CAP) {
      throw badInput(`${actor} already holds ${held.length} cards in progress (cap ${WIP_CAP}): ${held.map((h) => `#${h.id} ${h.title.slice(0, 60)}`).join("; ")}. Finish one (work_report completed), release one (kanban_update lane next, assigned_to ""), or pass force: true. Parallel sessions should send actor as name:session.`);
    }
  }
  // Open cards in the same product that look like the same work.
  function findDuplicates(product, title) {
    const refs = titleRefs(title);
    return db.prepare("SELECT id, title, lane FROM kanban_items WHERE product = ? AND lane != 'done'").all(product)
      .map((row) => {
        const score = similar(title, row.title);
        const sameRef = refs.length && titleRefs(row.title).some((r) => refs.includes(r));
        return { ...row, score: sameRef ? Math.max(score, 0.9) : score, sameRef };
      })
      .filter((row) => row.score >= 0.85 || (row.sameRef && row.score >= 0.5))
      .sort((a, b) => b.score - a.score).slice(0, 3);
  }

  function add(input = {}, { actor = "agent" } = {}) {
    actor = normalizeActor(actor) || "unnamed";
    const product = resolveProduct(input.product);
    const title = clean(input.title, 300);
    if (!title) throw badInput("title is required");
    if (isDecisionTitle(title)) throw badInput("this reads as a question for the owner. Ask the owner in chat, then file the work (or record the answer on the existing card).");
    if (!input.force) {
      const dupes = findDuplicates(product, title);
      if (dupes.length) {
        const existing = get(dupes[0].id, { events: 5 });
        return { ...existing, duplicate: true, duplicate_of: dupes[0].id,
          note: `An open card already covers this: #${dupes[0].id} "${dupes[0].title}" (${dupes[0].lane}). Returned it instead of adding a copy. Report on it with work_report, or pass force: true to add anyway.` };
      }
    }
    let lane = input.lane || "backlog";
    if (!OPEN_LANES.includes(lane)) throw badInput(`lane must be one of ${OPEN_LANES.join(", ")}`);
    const impact = input.impact || "medium";
    if (!IMPACTS.includes(impact)) throw badInput(`impact must be one of ${IMPACTS.join(", ")}`);
    const github = input.github ? parseGithubRef(input.github) : null;
    if (github) {
      const existing = db.prepare("SELECT id FROM kanban_items WHERE github_repo = ? AND github_number = ?").get(github.repo, github.number);
      if (existing) throw badInput(`${github.repo}#${github.number} is already item ${existing.id}; update that item instead`);
    }
    const start = input.start === true;
    if (start) { lane = "now"; checkWip(actor, { force: input.force }); }
    const stamp = iso();
    const assigned = normalizeActor(clean(input.assigned_to, 120)) || clean(input.assigned_to, 120) || (start ? actor : null);
    let laneNote = "";
    // Next means committed: someone owns it. Unowned filings wait in the inbox.
    if (lane === "next" && !assigned) { lane = "inbox"; laneNote = " (Next needs an owner, so this waits in the inbox)"; }
    const id = db.transaction(() => {
      const parent = input.parent_id ? resolveId(input.parent_id) : null;
      const info = db.prepare(`INSERT INTO kanban_items (product, title, detail, lane, impact, kind, needs_owner, assigned_to, evidence_url,
          github_repo, github_number, github_url, github_state, created_at, updated_at, area, class, parent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(product, title, clean(input.detail, 20000) || "", lane, impact, normalizeKind(input.kind), input.needs_owner ? 1 : 0,
          assigned, checkUrl(input.evidence_url, "evidence_url"), github?.repo || null, github?.number || null, github?.url || null,
          github ? "open" : null, stamp, stamp, areaFor(product, input.area), classFor(input.class), parent);
      const newId = Number(info.lastInsertRowid);
      logEvent({ item_id: newId, product, event_type: "created", actor, summary: `Added to ${lane}${laneNote}`, created_at: stamp });
      if (start) logEvent({ item_id: newId, product, event_type: "started", actor, summary: clean(input.summary, 4000) || "Started", created_at: stamp });
      return newId;
    })();
    return get(id, { events: 5 });
  }

  const UPDATABLE = ["title", "detail", "lane", "impact", "kind", "needs_owner", "assigned_to", "evidence_url", "github", "product", "progress_summary", "stale", "force", "area", "class", "parent_id"];

  function update(id, patch = {}, { actor = "agent" } = {}) {
    actor = normalizeActor(actor) || "unnamed";
    const realId = resolveId(id);
    const row = rowById(realId);
    const changes = {};
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) continue;
      if (!UPDATABLE.includes(key)) throw badInput(`cannot update "${key}"; allowed: ${UPDATABLE.join(", ")}`);
    }
    if (patch.title !== undefined) { const t = clean(patch.title, 300); if (!t) throw badInput("title cannot be empty"); if (isDecisionTitle(t)) throw badInput("ask the owner in chat instead of putting the question in a card title"); changes.title = t; }
    if (patch.detail !== undefined) changes.detail = clean(patch.detail, 20000) || "";
    if (patch.lane !== undefined) {
      if (!LANES.includes(patch.lane)) throw badInput(`lane must be one of ${LANES.join(", ")}`);
      changes.lane = patch.lane;
      changes.closed_at = patch.lane === "done" ? (row.closed_at || iso()) : null;
    }
    if (patch.impact !== undefined) { if (!IMPACTS.includes(patch.impact)) throw badInput(`impact must be one of ${IMPACTS.join(", ")}`); changes.impact = patch.impact; }
    if (patch.kind !== undefined) changes.kind = normalizeKind(patch.kind);
    if (patch.area !== undefined) changes.area = patch.area ? areaFor(patch.product ? resolveProduct(patch.product) : row.product, patch.area) : null;
    if (patch.class !== undefined) changes.class = patch.class ? classFor(patch.class) : null;
    if (patch.parent_id !== undefined) {
      const p = patch.parent_id ? resolveId(patch.parent_id) : null;
      if (p === realId) throw badInput("a card cannot be its own parent");
      changes.parent_id = p;
    }
    if (patch.needs_owner !== undefined) changes.needs_owner = patch.needs_owner ? 1 : 0;
    if (patch.assigned_to !== undefined) changes.assigned_to = normalizeActor(clean(patch.assigned_to, 120)) || clean(patch.assigned_to, 120);
    if (changes.lane === "now" && row.lane !== "now" && row.kind !== "monitor") checkWip(changes.assigned_to || row.assigned_to, { force: patch.force, exceptId: realId });
    if (patch.evidence_url !== undefined) changes.evidence_url = checkUrl(patch.evidence_url, "evidence_url");
    if (patch.progress_summary !== undefined) { changes.progress_summary = clean(patch.progress_summary, 4000) || ""; changes.last_progress_at = iso(); }
    if (patch.product !== undefined) changes.product = resolveProduct(patch.product);
    if (patch.github !== undefined) {
      const github = patch.github ? parseGithubRef(patch.github) : null;
      if (github) {
        const other = db.prepare("SELECT id FROM kanban_items WHERE github_repo = ? AND github_number = ? AND id != ?").get(github.repo, github.number, realId);
        if (other) throw badInput(`${github.repo}#${github.number} is already item ${other.id}`);
      }
      changes.github_repo = github?.repo || null;
      changes.github_number = github?.number || null;
      changes.github_url = github?.url || null;
      changes.github_state = github ? (row.github_repo === github.repo && row.github_number === github.number ? row.github_state : "open") : null;
    }
    // Touching an item is the review the stale flag asks for; `stale: true`
    // re-flags explicitly.
    changes.stale_flagged_at = patch.stale === true ? iso() : null;
    const stamp = iso();
    changes.updated_at = stamp;
    const described = Object.keys(changes).filter((k) => !["updated_at", "closed_at", "stale_flagged_at", "last_progress_at", "github_number", "github_url", "github_state"].includes(k))
      .map((k) => (k === "lane" ? `lane ${row.lane} -> ${changes.lane}` : k === "needs_owner" ? `needs_owner ${changes.needs_owner ? "on" : "off"}` : k === "github_repo" ? "github link" : k));
    if (patch.stale !== undefined) described.push(patch.stale ? "flagged stale" : "stale cleared");
    db.transaction(() => {
      const keys = Object.keys(changes);
      db.prepare(`UPDATE kanban_items SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...changes, id: realId });
      logEvent({ item_id: realId, product: changes.product || row.product, event_type: changes.lane && changes.lane !== row.lane ? "moved" : "updated", actor, summary: described.join(", ") || "touched", created_at: stamp });
    })();
    return get(realId, { events: 5 });
  }

  function report(input) {
    return db.transaction(() => recordReport(input)).immediate();
  }

  function recordReport({ id, event, summary, evidence_url = null, actor = "agent", idempotency_key = null, no_evidence_reason = null, force = false }) {
    if (!REPORT_EVENTS.includes(event)) throw badInput(`event must be one of ${REPORT_EVENTS.join(", ")}`);
    actor = normalizeActor(actor) || "unnamed";
    let text = clean(summary, 4000);
    if (!text) throw badInput("summary is required");
    const realId = resolveId(id);
    const current = rowById(realId);
    if (event === "started" && current.assigned_to && current.assigned_to !== actor && !force) {
      const error = new Error("This task is already assigned; coordinate a handoff with its owner");
      error.status = 409;
      throw error;
    }
    // Monitors are always-on processes: a heartbeat updates the card's status
    // and leaves at most one history event an hour.
    if (current.kind === "monitor" && event === "progress") {
      const stamp = iso();
      db.prepare("UPDATE kanban_items SET progress_summary = ?, last_progress_at = ?, updated_at = ?, stale_flagged_at = NULL WHERE id = ?").run(text, stamp, stamp, realId);
      const last = db.prepare("SELECT created_at FROM kanban_events WHERE item_id = ? AND event_type = 'heartbeat' ORDER BY created_at DESC, id DESC LIMIT 1").get(realId);
      if (!last || Date.parse(stamp) - Date.parse(last.created_at) >= MONITOR_EVENT_EVERY_MS) {
        logEvent({ item_id: realId, product: current.product, event_type: "heartbeat", actor, summary: looksLikeJson(text) ? "Status updated" : text.slice(0, 400), created_at: stamp });
      }
      return { duplicate: false, monitor: true, item: get(realId, { events: 3 }) };
    }
    if (looksLikeJson(text)) throw badInput("summary is read by people: write a plain sentence about what changed, not a JSON status dump");
    if (event === "started") checkWip(actor, { force, exceptId: realId });
    if (event === "completed" && !clean(evidence_url, 2000) && !WIP_EXEMPT.test(actor)) {
      const reason = clean(no_evidence_reason, 300);
      if (!reason) throw badInput("completed needs evidence_url (PR, deploy, report) or no_evidence_reason saying why there is none");
      text = `${text} (No evidence link: ${reason})`.slice(0, 4000);
    }
    const key = clean(idempotency_key, 200);
    if (key) {
      const seen = db.prepare("SELECT item_id FROM kanban_events WHERE idempotency_key = ?").get(key);
      if (seen) return { duplicate: true, item: get(seen.item_id, { events: 5 }) };
    }
    const evidence = checkUrl(evidence_url, "evidence_url");
    const row = current;
    const stamp = iso();
    const set = { updated_at: stamp, stale_flagged_at: null, progress_summary: text, last_progress_at: stamp };
    if (evidence) set.evidence_url = evidence;
    if (event === "started") { set.lane = "now"; set.assigned_to = actor; set.closed_at = null; }
    if (event === "blocked") set.lane = "blocked";
    if (event === "decision_requested") set.needs_owner = 1;
    if (event === "completed") { set.lane = "done"; set.closed_at = stamp; set.needs_owner = 0; }
    db.transaction(() => {
      const keys = Object.keys(set);
      db.prepare(`UPDATE kanban_items SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...set, id: realId });
      logEvent({ item_id: realId, product: row.product, event_type: event, actor, summary: text, evidence_url: evidence, idempotency_key: key, created_at: stamp });
    })();
    return { duplicate: false, item: get(realId, { events: 5 }) };
  }

  // Restricted collaboration uses the authenticated identity, never a supplied
  // assignee. IMMEDIATE keeps the ownership check and mutation atomic across
  // the dashboard, MCP and sync processes sharing this SQLite file.
  function collaborate({ id, action, summary, evidence_url, actor }) {
    actor = normalizeActor(actor);
    if (!actor) throw badInput("A signed-in identity is required");
    if (!["claim", "release", "progress", "blocked", "resume", "completed"].includes(action))
      throw badInput("Unknown collaboration action");
    return db.transaction(() => {
      const row = rowById(resolveId(id));
      const reject = (message, status = 409) => { const error = new Error(message); error.status = status; throw error; };
      if (row.kind === "monitor" || row.lane === "done") reject("This task is not available for collaboration");
      if (action === "claim") {
        if (row.assigned_to && row.assigned_to !== actor) reject("This task is already assigned; coordinate a handoff with its owner");
        return report({ id: row.id, event: "started", summary: summary || "Claimed task", actor });
      }
      if (row.assigned_to !== actor) reject("Claim this task before updating it", 403);
      if (action === "release") {
        report({ id: row.id, event: "progress", summary, evidence_url, actor });
        return { item: update(row.id, { lane: "inbox", assigned_to: "" }, { actor }) };
      }
      return report({ id: row.id, event: action === "resume" ? "started" : action, summary, evidence_url, actor });
    }).immediate();
  }

  // What an agent (or person) needs at the start of work, short: your own
  // cards, what was released for going quiet, what is blocked, what is in
  // progress, what is next, and what shipped. Monitors are one line each.
  function brief({ product, limit = 10, actor = null } = {}) {
    const slug = product ? resolveProduct(product) : null;
    const me = normalizeActor(actor);
    const pick = (opts) => list({ ...opts, product: slug || undefined, include_monitors: false, limit }).items.map(line);
    const line = (it) => ({ id: it.id, title: it.title, product: it.product, lane: it.lane, owner: it.assigned_to, impact: it.impact,
      age_days: it.age_days, stale: it.stale, progress: looksLikeJson(it.progress_summary) ? "" : String(it.progress_summary || "").slice(0, 160), github: it.github ? `${it.github.repo}#${it.github.number}` : null });
    const count = (where, ...params) => db.prepare(`SELECT COUNT(*) AS n FROM kanban_items WHERE ${where} AND kind != 'monitor' ${slug ? "AND product = ?" : ""}`).get(...params, ...(slug ? [slug] : [])).n;
    const since3 = new Date(now().getTime() - 3 * DAY_MS).toISOString();
    const stamp = iso();
    const scoped = slug ? "AND e.product = ?" : "";
    const sp = slug ? [slug] : [];
    return {
      scope: slug || "all products",
      generated_at: stamp,
      rules: `Add with start:true before you write code. Send actor as your name (claude, codex, keir, muse, deepseek), with :session if several run at once. Cap: ${WIP_CAP} cards in progress per actor. Cards quiet ${RELEASE_DAYS} days go back to Next automatically. completed needs evidence_url or no_evidence_reason. Ask the owner in chat, never in a card.`,
      counts: {
        now: count("lane = 'now'"), next: count("lane = 'next'"), blocked: count("lane = 'blocked'"),
        inbox: count("lane = 'inbox'"), backlog: count("lane = 'backlog'"), stale: count(`lane != 'done' AND ${STALE_SQL}`, stamp),
        shipped_3d: count("lane = 'done' AND closed_at >= ?", since3),
      },
      ...(me ? { mine: list({ assigned_to: me, product: slug || undefined, include_monitors: false, limit }).items.filter((it) => it.lane !== "done").map(line) } : {}),
      released: db.prepare(`SELECT e.item_id AS id, i.title, e.summary, e.created_at FROM kanban_events e JOIN kanban_items i ON i.id = e.item_id
        WHERE e.event_type = 'released' AND e.created_at >= ? ${scoped} ORDER BY e.created_at DESC LIMIT ?`).all(since3, ...sp, limit),
      blocked: pick({ lane: "blocked" }),
      now: pick({ lane: "now" }),
      next: pick({ lane: "next" }),
      shipped: db.prepare(`SELECT id, title, product, evidence_url, closed_at FROM kanban_items WHERE lane = 'done' AND closed_at >= ? ${slug ? "AND product = ?" : ""} ORDER BY closed_at DESC LIMIT ?`).all(since3, ...sp, limit),
      monitors: db.prepare("SELECT id, title, last_progress_at FROM kanban_items WHERE kind = 'monitor' AND lane != 'done' ORDER BY title").all()
        .map((m) => ({ id: m.id, title: m.title, last_heartbeat: m.last_progress_at })),
      recent: db.prepare(`SELECT e.item_id, i.title, e.product, e.event_type, e.actor, e.summary, e.evidence_url, e.created_at
        FROM kanban_events e LEFT JOIN kanban_items i ON i.id = e.item_id
        WHERE e.event_type IN ('started','progress','blocked','completed','released') AND (i.kind IS NULL OR i.kind != 'monitor') ${scoped}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(...sp, limit)
        .map((e) => ({ ...e, summary: looksLikeJson(e.summary) ? "" : String(e.summary || "").slice(0, 200) })),
    };
  }

  // Daily hygiene, safe to run often: release quiet Now cards, move unowned
  // untouched Next cards to the inbox, expire long-untouched local backlog,
  // and fold kind synonyms into the fixed vocabulary.
  function maintain({ releaseDays = RELEASE_DAYS, expireDays = EXPIRE_DAYS, inboxAfterDays = INBOX_AFTER_DAYS } = {}) {
    const at = now().getTime();
    const stamp = iso();
    const before = (days) => new Date(at - days * DAY_MS).toISOString();
    const out = { released: 0, inboxed: 0, expired: 0, kinds: 0, monitors: 0 };
    db.transaction(() => {
      // Heartbeat-only cards (30+ progress events in 3 days) are monitors, not work.
      for (const row of db.prepare(`SELECT i.id, i.product FROM kanban_items i JOIN kanban_events e ON e.item_id = i.id
          WHERE i.lane = 'now' AND i.kind != 'monitor' AND e.event_type = 'progress' AND e.created_at >= ? GROUP BY i.id HAVING COUNT(*) >= 30`).all(before(3))) {
        db.prepare("UPDATE kanban_items SET kind = 'monitor' WHERE id = ?").run(row.id);
        logEvent({ item_id: row.id, product: row.product, event_type: "updated", actor: "system", summary: "kind -> monitor (heartbeat card)", created_at: stamp });
        out.monitors += 1;
      }
      for (const row of db.prepare("SELECT * FROM kanban_items WHERE lane = 'now' AND kind != 'monitor' AND updated_at < ?").all(before(releaseDays))) {
        db.prepare("UPDATE kanban_items SET lane = 'next', assigned_to = NULL, updated_at = ?, stale_flagged_at = NULL WHERE id = ?").run(stamp, row.id);
        logEvent({ item_id: row.id, product: row.product, event_type: "released", actor: "system",
          summary: `No update for ${releaseDays}+ days; released from ${row.assigned_to || "nobody"} back to Next.`, created_at: stamp });
        out.released += 1;
      }
      const touched = "SELECT 1 FROM kanban_events e WHERE e.item_id = kanban_items.id AND e.event_type IN ('started','progress','blocked','completed','released')";
      for (const row of db.prepare(`SELECT id, product FROM kanban_items WHERE lane = 'next' AND (assigned_to IS NULL OR assigned_to = '') AND created_at < ? AND NOT EXISTS (${touched})`).all(before(inboxAfterDays))) {
        db.prepare("UPDATE kanban_items SET lane = 'inbox' WHERE id = ?").run(row.id);
        logEvent({ item_id: row.id, product: row.product, event_type: "moved", actor: "system", summary: "lane next -> inbox (no owner, never picked up)", created_at: stamp });
        out.inboxed += 1;
      }
      for (const row of db.prepare("SELECT id, product FROM kanban_items WHERE lane = 'backlog' AND source = 'local' AND updated_at < ?").all(before(expireDays))) {
        db.prepare("UPDATE kanban_items SET lane = 'done', closed_at = ?, updated_at = ? WHERE id = ?").run(stamp, stamp, row.id);
        logEvent({ item_id: row.id, product: row.product, event_type: "expired", actor: "system", summary: `Untouched for ${expireDays}+ days; closed. Reopen by moving it to a lane.`, created_at: stamp });
        out.expired += 1;
      }
      for (const row of db.prepare("SELECT id, kind FROM kanban_items WHERE lane != 'done'").all()) {
        const k = normalizeKind(row.kind);
        if (k !== row.kind) { db.prepare("UPDATE kanban_items SET kind = ? WHERE id = ?").run(k, row.id); out.kinds += 1; }
      }
    })();
    return out;
  }

  function board() {
    const { items } = list({ limit: 1000 });
    const sources = db.prepare("SELECT repo, product, enabled, last_sync_at, last_error FROM kanban_github_sources ORDER BY repo").all();
    return { generated_at: iso(), stale_days: STALE_DAYS, products: products(), items, github_sources: sources };
  }

  // GitHub sync. Open issues in each enabled source repo are upserted (new
  // ones land in backlog, or now/blocked by label); a linked item whose issue
  // is no longer open is confirmed closed per issue before it moves to done.
  // Sync never bumps updated_at for unchanged items, so it cannot mask
  // staleness.
  async function syncGithub({ repo = null, run } = {}) {
    const sources = db.prepare("SELECT * FROM kanban_github_sources WHERE enabled = 1 AND (? IS NULL OR repo = ?) ORDER BY repo").all(repo, repo);
    const results = [];
    for (const source of sources) {
      const result = { repo: source.repo, product: source.product, ok: true, open: 0, added: 0, updated: 0, closed: 0, reopened: 0 };
      try {
        const issues = await fetchOpenIssues(source.repo, run);
        result.open = issues.length;
        const openNumbers = new Set(issues.map((issue) => issue.number));
        const stamp = iso();
        db.transaction(() => {
          for (const issue of issues) {
            const labels = (issue.labels || []).map((label) => label.name);
            const existing = db.prepare("SELECT * FROM kanban_items WHERE github_repo = ? AND github_number = ?").get(source.repo, issue.number);
            if (!existing) {
              const info = db.prepare(`INSERT INTO kanban_items (product, title, detail, lane, impact, kind, source, github_repo, github_number, github_url, github_state, github_labels, github_synced_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'github', ?, ?, ?, 'open', ?, ?, ?, ?)`)
                .run(source.product, issue.title, issueExcerpt(issue.body), laneForLabels(labels), impactForLabels(labels), kindForLabels(labels), source.repo, issue.number, issue.url, JSON.stringify(labels), stamp, stamp, stamp);
              logEvent({ item_id: Number(info.lastInsertRowid), product: source.product, event_type: "created", actor: "github-sync", summary: `Imported open issue ${source.repo}#${issue.number}`, created_at: stamp });
              result.added += 1;
              continue;
            }
            const reopened = existing.github_state !== "open" || existing.lane === "done";
            const titleChanged = existing.source === "github" && existing.title !== issue.title;
            const set = { github_state: "open", github_labels: JSON.stringify(labels), github_synced_at: stamp, github_url: issue.url };
            if (titleChanged) set.title = issue.title;
            if (!existing.detail && issue.body) set.detail = issueExcerpt(issue.body);
            if (reopened) { set.lane = existing.lane === "done" ? "backlog" : existing.lane; set.closed_at = null; }
            if (titleChanged || reopened) set.updated_at = stamp;
            const keys = Object.keys(set);
            db.prepare(`UPDATE kanban_items SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...set, id: existing.id });
            if (reopened) { logEvent({ item_id: existing.id, product: existing.product, event_type: "reopened", actor: "github-sync", summary: `${source.repo}#${issue.number} is open again`, created_at: stamp }); result.reopened += 1; }
            else if (titleChanged) result.updated += 1;
          }
        })();
        const missing = db.prepare("SELECT * FROM kanban_items WHERE github_repo = ? AND lane != 'done' AND github_state = 'open'").all(source.repo)
          .filter((item) => !openNumbers.has(item.github_number));
        for (const item of missing) {
          const state = await fetchIssueState(item.github_repo, item.github_number, run);
          if (state.state === "open") continue;
          closeLinked(item, state.state);
          result.closed += 1;
        }
        db.prepare("UPDATE kanban_github_sources SET last_sync_at = ?, last_error = NULL WHERE repo = ?").run(iso(), source.repo);
      } catch (error) {
        result.ok = false;
        result.error = String(error.message || error).slice(0, 500);
        db.prepare("UPDATE kanban_github_sources SET last_error = ? WHERE repo = ?").run(result.error, source.repo);
      }
      results.push(result);
    }
    // Linked items in repos that are not sync sources (a link added by hand).
    if (!repo) {
      const sourceRepos = new Set(db.prepare("SELECT repo FROM kanban_github_sources").all().map((s) => s.repo));
      const orphans = db.prepare("SELECT * FROM kanban_items WHERE github_repo IS NOT NULL AND lane != 'done' AND github_state = 'open'").all()
        .filter((item) => !sourceRepos.has(item.github_repo));
      for (const item of orphans) {
        try {
          const state = await fetchIssueState(item.github_repo, item.github_number, run);
          if (state.state !== "open") { closeLinked(item, state.state); results.push({ repo: item.github_repo, ok: true, closed: 1, item: item.id }); }
        } catch (error) {
          results.push({ repo: item.github_repo, ok: false, item: item.id, error: String(error.message || error).slice(0, 300) });
        }
      }
    }
    return results;
  }

  function closeLinked(item, state) {
    const stamp = iso();
    db.transaction(() => {
      db.prepare("UPDATE kanban_items SET github_state = ?, lane = 'done', closed_at = ?, needs_owner = 0, updated_at = ?, github_synced_at = ? WHERE id = ?")
        .run(state || "closed", stamp, stamp, stamp, item.id);
      logEvent({ item_id: item.id, product: item.product, event_type: "github_closed", actor: "github-sync", summary: `${item.github_repo}#${item.github_number} is ${state || "closed"} on GitHub`, created_at: stamp });
    })();
  }

  return {
    db,
    path: dbPath,
    close: () => db.close(),
    products,
    upsertProduct,
    resolveProduct,
    resolveId,
    list,
    get,
    add,
    update,
    report,
    collaborate,
    brief,
    maintain,
    board,
    syncGithub,
    logEvent,
  };
}

let shared = null;
// One handle per process, opened lazily so a missing better-sqlite3 build or
// an unwritable path fails the kanban routes, not the whole process.
function sharedKanban() {
  if (!shared) shared = openKanban();
  return shared;
}

module.exports = {
  openKanban,
  sharedKanban,
  defaultDbPath,
  parseGithubRef,
  laneForLabels,
  impactForLabels,
  fetchIssueState,
  OPEN_LANES,
  LANES,
  IMPACTS,
  REPORT_EVENTS,
  KINDS,
  CLASSES,
  AREAS,
  WIP_CAP,
  RELEASE_DAYS,
  normalizeActor,
  normalizeKind,
  isDecisionTitle,
  STALE_DAYS,
};
