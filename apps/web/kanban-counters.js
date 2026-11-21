"use strict";

// kanban-counters.js: automatic counts that are statistics, not work.
//
// Keir files a card for every kind of raw database read it had no tool for
// ("A read for corporateSectors without raw database queries") and every
// failure alert ("Keir failure spike: ..."), then raises a running count on
// it. On 2026-11-21 these were about 140 of the 612 open cards and almost
// none was ever worked. The owner's decision: these counts live in their own
// list, one row per signature, and become a board card only when a person or
// an agent promotes one deliberately.
//
// Recognition is exact. A call is an automatic counter only when it carries
// every structured field Keir's counter code sends (actor keir, the fixed
// product, kind, lane and area, a title in one of the generated forms, and
// the fixed sentence Keir's detail ends with, or the idempotency key and
// summary form of its repeat report). Anything that differs in any field is
// an ordinary card. Callers are not changed: a routed kanban_add gets back a
// success with id null (Keir then reports the next count as a fresh add), a
// routed work_report gets back a success it ignores.

const GAP_MARKER = "Filed automatically from Keir's failed and workaround reads; repeats raise its count.";
// Failure classes from apps/agent/lib/operator/capabilitygaps.js CLASSES
// ("raw query syntax" has its own title form).
const TOOL_CLASSES = ["wrong argument names", "argument types", "record not found by id", "tool timed out"];
const TARGET = "[\\w.:/@-]{1,120}";
const GAP_TITLES = [
  [new RegExp(`^A read for (${TARGET}) without raw database queries$`), (m) => `raw:${m[1]}`],
  [new RegExp(`^Raw (${TARGET}) queries keep failing: a purpose-built read is missing$`), (m) => `rawsyntax:${m[1]}:raw query syntax`],
  [new RegExp(`^(${TARGET}): (${TOOL_CLASSES.join("|")})$`), (m) => `tool:${m[1]}:${m[2]}`],
];
const SEEN_RE = /Seen (\d+) times across (\d+) tasks in the last 7 days\./;
const NOW_HITS_RE = /^Now (\d+) hits across (\d+) tasks in 7 days\.$/;

function actorName(actor) {
  return String(actor || "").trim().toLowerCase().split(/[:#]/)[0];
}
function isKeir(actor) { return actorName(actor) === "keir"; }
function empty(v) { return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0); }
// Fields a deliberate card might carry and Keir's counter code never sends.
const DELIBERATE_FIELDS = ["github", "ticket", "tickets", "ticket_role", "start", "assigned_to", "parent_id", "evidence_url", "pull_request", "alert_key", "needs_owner", "summary", "class"];
function hasDeliberateField(input) {
  return DELIBERATE_FIELDS.some((f) => !empty(input[f]) && input[f] !== false);
}

function gapSignature(title) {
  const t = String(title || "").trim();
  for (const [re, sig] of GAP_TITLES) {
    const m = t.match(re);
    if (m) return sig(m);
  }
  return null;
}

function samplesFrom(detail) {
  const ex = String(detail || "").split(/\nExamples:\n/)[1];
  if (!ex) return [];
  return ex.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean).slice(0, 3);
}

// Failure alerts: "Keir failure new: <group title>" / "Keir failure spike:
// ..." with detail "Fingerprint <fp>. Total N, last 24 hours M ... Tickets:
// a, b." and "Keir failures regressed: <class> on <release>".
function failureSignature(title, detail) {
  const t = String(title || "").trim();
  const d = String(detail || "");
  if (!/\n\nNext step: /.test(d)) return null;
  const reg = t.match(/^Keir failures regressed: ([\w-]{1,40}) on (\S{1,80})$/);
  if (reg && new RegExp(`^${reg[1]} failures per 100 activations: `).test(d)) return { sig: `failure:regression:${reg[1]}:${reg[2]}`, alert: "regression" };
  const m = t.match(/^Keir failure (new|spike): (.+)$/);
  const fp = d.match(/^Fingerprint (\S{3,200})\. Total (\d+), last 24 hours (\d+)/);
  if (m && fp) {
    const tickets = (d.match(/Tickets: ([\d, ]+)\./) || [])[1];
    return { sig: `failure:${fp[1]}`, alert: m[1], total: Number(fp[2]), last24h: Number(fp[3]), tickets: tickets ? tickets.split(/,\s*/).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [] };
  }
  return null;
}

function failureSamples(detail) {
  const part = String(detail || "").split("\n\nSamples:\n")[1];
  if (!part) return [];
  return part.split("\n\nNext step:")[0].split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).slice(0, 3);
}

// kanban_add input + actor -> a counter observation, or null (a card).
function counterFromAdd(input = {}, actor) {
  if (!isKeir(actor) || hasDeliberateField(input) || input.force) return null;
  const product = String(input.product || "").trim().toLowerCase();
  const lane = input.lane === undefined ? "inbox" : input.lane;
  if (product !== "lakeside-mcp" || lane !== "inbox") return null;
  const kind = String(input.kind || "").trim().toLowerCase();
  const detail = String(input.detail || "");
  if (kind === "capability" && empty(input.area) && detail.trimEnd().endsWith(GAP_MARKER)) {
    const sig = gapSignature(input.title);
    const seen = detail.match(SEEN_RE);
    if (!sig || !seen) return null;
    return {
      signature: sig, family: "tool_gap", product: "lakeside-mcp", reporter: "keir",
      title: String(input.title).trim().slice(0, 280), description: detail.split("\n\n")[0].slice(0, 600),
      window_hits: Number(seen[1]), window_tasks: Number(seen[2]), total: null, tickets: [], samples: samplesFrom(detail),
      impact: input.impact === "high" ? "high" : "medium", via: "kanban_add",
    };
  }
  if (kind === "bug" && String(input.area || "").toLowerCase() === "keir") {
    const f = failureSignature(input.title, detail);
    // Only a spike is a running count. A failure kind never seen before
    // ("new") and a release regression ("regressed") are alerts a person
    // should see: they stay cards.
    if (!f || f.alert !== "spike") return null;
    return {
      signature: f.sig, family: "failure_alert", product: "lakeside-mcp", reporter: "keir",
      title: String(input.title).trim().replace(/^Keir failure (?:new|spike): /, "Keir failure: ").slice(0, 280),
      description: detail.split("\n\n")[0].slice(0, 600),
      window_hits: f.last24h ?? null, window_tasks: null, total: f.total ?? null, tickets: f.tickets || [], samples: failureSamples(detail),
      alert: f.alert, impact: "medium", via: "kanban_add",
    };
  }
  return null;
}

// work_report input + actor -> a counter observation, or null (a report).
// Keir's repeat reports: capability gaps send key gap:<sig>:<hits> and
// "Now N hits across M tasks in 7 days."; failure alerts send key
// failure:<fingerprint>:<6-hour bucket> and the alert title as summary.
function counterFromReport(input = {}, actor) {
  if (!isKeir(actor) || input.event !== "progress" || !empty(input.evidence_url) || !empty(input.ticket) || !empty(input.tickets) || !empty(input.pull_request)) return null;
  const key = String(input.idempotency_key || "");
  const summary = String(input.summary || "").trim();
  const gap = key.match(/^gap:(.+):(\d+)$/);
  const hits = summary.match(NOW_HITS_RE);
  if (gap && hits && gap[2] === hits[1] && /^(?:raw|rawsyntax|tool):/.test(gap[1])) {
    return { signature: gap[1], family: "tool_gap", product: "lakeside-mcp", reporter: "keir", window_hits: Number(hits[1]), window_tasks: Number(hits[2]), total: null, tickets: [], samples: [], via: "work_report", card_id: Number(input.id) || null };
  }
  const fail = key.match(/^failure:(.+):(\d+)$/);
  if (fail && /^Keir failure spike\b/.test(summary)) {
    return { signature: `failure:${fail[1]}`, family: "failure_alert", product: "lakeside-mcp", reporter: "keir", window_hits: null, window_tasks: null, total: null, tickets: [], samples: [], via: "work_report", card_id: Number(input.id) || null };
  }
  return null;
}

// An existing board card that is one of these counters (for the one-time
// migration). Same exact forms; the creator is not required because some
// older counter cards were filed under a shared token name.
function counterFromCard(row) {
  if (!row || row.product !== "lakeside-mcp") return null;
  if (row.kind === "capability" && String(row.detail || "").trimEnd().endsWith(GAP_MARKER)) {
    const sig = gapSignature(row.title);
    const seen = String(row.detail || "").match(SEEN_RE);
    if (sig && seen) return { signature: sig, family: "tool_gap", title: row.title, description: String(row.detail).split("\n\n")[0].slice(0, 600), window_hits: Number(seen[1]), window_tasks: Number(seen[2]), total: null, tickets: [], samples: samplesFrom(row.detail) };
  }
  if (row.kind === "bug") {
    const f = failureSignature(row.title, row.detail);
    if (f && f.alert === "spike") return { signature: f.sig, family: "failure_alert", title: String(row.title).replace(/^Keir failure (?:new|spike): /, "Keir failure: "), description: String(row.detail).split("\n\n")[0].slice(0, 600), window_hits: f.last24h ?? null, window_tasks: null, total: f.total ?? null, tickets: f.tickets || [], samples: failureSamples(row.detail) };
  }
  return null;
}

const COUNTER_SCHEMA = `
CREATE TABLE IF NOT EXISTS kanban_counters (
  signature    TEXT PRIMARY KEY,
  family       TEXT NOT NULL,
  product      TEXT NOT NULL,
  reporter     TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  occurrences  INTEGER NOT NULL DEFAULT 0,
  window_hits  INTEGER,
  window_tasks INTEGER,
  max_tasks    INTEGER NOT NULL DEFAULT 0,
  last_total   INTEGER,
  tickets      TEXT NOT NULL DEFAULT '[]',
  samples      TEXT NOT NULL DEFAULT '[]',
  impact       TEXT NOT NULL DEFAULT 'medium',
  card_id      INTEGER,
  promoted_at  TEXT,
  migrated_cards TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS kanban_counter_hits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  signature    TEXT NOT NULL,
  at           TEXT NOT NULL,
  added        INTEGER NOT NULL DEFAULT 0,
  window_hits  INTEGER,
  window_tasks INTEGER,
  total        INTEGER,
  via          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS kanban_counter_hits_sig ON kanban_counter_hits(signature, at);
`;

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 7;

function parseJsonList(value) {
  try { const v = JSON.parse(value || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

// How many new occurrences an observation adds (prev: the running state
// before it: window_hits, last_seen of that window figure, last_total). Keir reports a running
// 7-day count for gaps and a running total for failures; the difference from
// the last observation is what happened in between. A count that fell
// (old hits left the window) adds nothing; a first observation, or one after
// the window lapsed, adds its whole count.
function occurrencesAdded(prev, obs, atMs) {
  if (obs.total != null) {
    if (!prev || prev.last_total == null) return Math.max(obs.total, 0);
    return Math.max(obs.total - prev.last_total, 0);
  }
  if (obs.window_hits != null) {
    const lapsed = !prev || prev.window_hits == null || atMs - Date.parse(prev.last_seen) >= WINDOW_DAYS * DAY_MS;
    if (lapsed) return Math.max(obs.window_hits, 0);
    return Math.max(obs.window_hits - prev.window_hits, 0);
  }
  // A repeat report with no figures (Keir's failure repeats) says the alert
  // fired again, not how often: it moves last_seen and adds nothing.
  return 0;
}

// The counter store, on the kanban database. `store` gives access to cards
// for promotion and migration.
function createCounters(db, { now, store }) {
  db.exec(COUNTER_SCHEMA);
  const iso = () => now().toISOString();

  // Every observation keeps its raw figures; occurrences are recomputed from
  // them in time order, so a replayed history (migration) and live reports
  // combine without double counting.
  function recompute(signature) {
    const hits = db.prepare("SELECT * FROM kanban_counter_hits WHERE signature = ? ORDER BY at, id").all(signature);
    let prev = null;
    let total = 0;
    let maxTasks = 0;
    const set = db.prepare("UPDATE kanban_counter_hits SET added = ? WHERE id = ?");
    for (const h of hits) {
      const added = occurrencesAdded(prev, h, Date.parse(h.at));
      if (added !== h.added) set.run(added, h.id);
      total += added;
      maxTasks = Math.max(maxTasks, h.window_tasks || 0);
      prev = {
        window_hits: h.window_hits != null ? h.window_hits : prev ? prev.window_hits : null,
        last_total: h.total != null ? h.total : prev ? prev.last_total : null,
        last_seen: h.window_hits != null ? h.at : prev ? prev.last_seen : h.at,
        window_tasks: h.window_tasks != null ? h.window_tasks : prev ? prev.window_tasks : null,
      };
    }
    if (!hits.length) return;
    db.prepare(`UPDATE kanban_counters SET occurrences = ?, first_seen = ?, last_seen = ?, window_hits = ?, window_tasks = ?, last_total = ?, max_tasks = ? WHERE signature = ?`)
      .run(total, hits[0].at, hits[hits.length - 1].at, prev.window_hits, prev.window_tasks, prev.last_total, maxTasks, signature);
  }

  function record(obs, { at = iso() } = {}) {
    return db.transaction(() => {
      const prev = db.prepare("SELECT * FROM kanban_counters WHERE signature = ?").get(obs.signature);
      const tickets = [...new Set([...(prev ? parseJsonList(prev.tickets) : []), ...(obs.tickets || [])])].slice(-50);
      const samples = [...(obs.samples || []), ...(prev ? parseJsonList(prev.samples) : [])].filter((s, i, a) => a.indexOf(s) === i).slice(0, 5);
      if (!prev) {
        db.prepare(`INSERT INTO kanban_counters (signature, family, product, reporter, title, description, first_seen, last_seen, tickets, samples, impact)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(obs.signature, obs.family, obs.product || "lakeside-mcp", obs.reporter || "keir", obs.title || obs.signature, obs.description || "", at, at,
            JSON.stringify(tickets), JSON.stringify(samples), obs.impact || "medium");
      } else {
        const newer = Date.parse(at) >= Date.parse(prev.last_seen);
        db.prepare(`UPDATE kanban_counters SET tickets = ?, samples = ?, title = ?, description = ?, impact = CASE WHEN ? = 'high' THEN 'high' ELSE impact END WHERE signature = ?`)
          .run(JSON.stringify(tickets), JSON.stringify(samples), newer && obs.title ? obs.title : prev.title, newer && obs.description ? obs.description : prev.description, obs.impact || "", obs.signature);
      }
      const info = db.prepare("INSERT INTO kanban_counter_hits (signature, at, added, window_hits, window_tasks, total, via) VALUES (?, ?, 0, ?, ?, ?, ?)")
        .run(obs.signature, at, obs.window_hits ?? null, obs.window_tasks ?? null, obs.total ?? null, obs.via || "");
      recompute(obs.signature);
      const added = db.prepare("SELECT added FROM kanban_counter_hits WHERE id = ?").get(info.lastInsertRowid).added;
      return { added, counter: get(obs.signature) };
    }).immediate();
  }

  function present(row, at = now().getTime()) {
    const since = (days) => new Date(at - days * DAY_MS).toISOString();
    const sum = db.prepare("SELECT COALESCE(SUM(added), 0) AS n FROM kanban_counter_hits WHERE signature = ? AND at >= ?");
    const last7 = sum.get(row.signature, since(7)).n;
    const last30 = sum.get(row.signature, since(30)).n;
    const card = row.card_id ? store.rowById(row.card_id) : null;
    const lastSeen = Date.parse(row.last_seen);
    const closedAt = card && card.lane === "done" ? Date.parse(card.closed_at || card.updated_at) : null;
    // A promoted card that is done and the count has stopped since: addressed.
    const status = !card ? "counting" : card.lane !== "done" ? "card open" : lastSeen > closedAt ? "seen again after its card closed" : "addressed";
    const tickets = parseJsonList(row.tickets);
    return {
      signature: row.signature,
      title: row.title,
      description: row.description,
      family: row.family === "tool_gap" ? "tool gap" : "failure alert",
      product: row.product,
      reporter: row.reporter,
      last_7_days: last7,
      last_30_days: last30,
      occurrences: row.occurrences,
      tasks: row.window_tasks ?? null,
      max_tasks: row.max_tasks || null,
      tickets,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      status,
      card: card ? { id: card.id, title: card.title, lane: card.lane, closed_at: card.closed_at || null } : null,
      samples: parseJsonList(row.samples),
      migrated_from_cards: parseJsonList(row.migrated_cards),
      summary: `${row.title}: ${last7} in the last 7 days, ${last30} in 30${row.window_tasks ? `, across ${row.window_tasks} tasks` : ""}${tickets.length ? `, tickets ${tickets.slice(-5).join(", ")}` : ""}.`,
    };
  }

  function get(signature) {
    const row = db.prepare("SELECT * FROM kanban_counters WHERE signature = ?").get(String(signature || ""));
    return row ? present(row) : null;
  }

  // Most frequent and most recent first.
  function list({ family = null, product = null, status = null, limit = 50, q = null } = {}) {
    const where = [];
    const params = [];
    if (family) { where.push("family = ?"); params.push(family === "tool gap" || family === "tool_gap" ? "tool_gap" : "failure_alert"); }
    if (product) { where.push("product = ?"); params.push(product); }
    if (q) { where.push("(signature LIKE ? OR title LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
    const at = now().getTime();
    const rows = db.prepare(`SELECT * FROM kanban_counters ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`).all(...params).map((r) => present(r, at));
    const filtered = status ? rows.filter((r) => r.status === status) : rows;
    filtered.sort((a, b) => b.last_7_days - a.last_7_days || b.last_30_days - a.last_30_days || Date.parse(b.last_seen) - Date.parse(a.last_seen) || a.signature.localeCompare(b.signature));
    const max = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return { generated_at: new Date(at).toISOString(), total: filtered.length, counters: filtered.slice(0, max) };
  }

  // Turn a counter into one real card, linked back. While that card is
  // open, promoting again returns it instead of filing a second.
  function promote({ signature, title, detail, impact, lane = "inbox", product, area, actor = "agent" } = {}) {
    const row = db.prepare("SELECT * FROM kanban_counters WHERE signature = ?").get(String(signature || ""));
    if (!row) { const e = new Error(`no counter ${signature}`); e.code = "NOT_FOUND"; throw e; }
    if (row.card_id) {
      const card = store.rowById(row.card_id);
      if (card && card.lane !== "done") return { promoted: false, note: `Counter ${row.signature} already has open card #${card.id}; work on that one.`, counter: present(row), item: store.get(card.id, { events: 5 }) };
    }
    const c = present(row);
    const body = `${detail ? `${String(detail).trim()}\n\n` : ""}Promoted from the counter ${row.signature}: ${c.last_7_days} times in the last 7 days, ${c.last_30_days} in 30${row.window_tasks ? `, across ${row.window_tasks} tasks` : ""}.${c.tickets.length ? ` Tickets: ${c.tickets.slice(-10).join(", ")}.` : ""}${row.description ? `\n\n${row.description}` : ""}${c.samples.length ? `\nExamples:\n${c.samples.map((s) => `- ${s}`).join("\n")}` : ""}`;
    const item = store.add({
      product: product || row.product, title: title || (row.family === "tool_gap" ? row.title : `Fix: ${row.title}`), detail: body.slice(0, 19000),
      kind: row.family === "tool_gap" ? "capability" : "bug", lane, impact: impact || row.impact, force: true, ...(area ? { area } : {}),
    }, { actor, fromCounter: true });
    const stamp = iso();
    db.prepare("UPDATE kanban_counters SET card_id = ?, promoted_at = ? WHERE signature = ?").run(item.id, stamp, row.signature);
    store.logEvent({ item_id: item.id, product: item.product, event_type: "promoted", actor: item.events?.[0]?.actor || "agent", summary: `Promoted from the counter ${row.signature} (${c.last_7_days} in 7 days, ${c.last_30_days} in 30). The counter keeps counting and shows this card.`, created_at: stamp });
    return { promoted: true, counter: get(row.signature), item: store.get(item.id, { events: 5 }) };
  }

  // One-time move of the open counter cards into this list. Each card's
  // own history (its filing and every "Now N hits" report) is replayed as
  // observations, then the card is completed with a note saying where it
  // went. A card someone worked on (started, assigned, a report from anyone
  // but Keir or the board's own automation) is left on the board.
  function migrateCards({ dryRun = true, limit = 500, actor = "counter-migration" } = {}) {
    const rows = db.prepare("SELECT * FROM kanban_items WHERE lane != 'done' AND product = 'lakeside-mcp' AND kind IN ('capability', 'bug') ORDER BY id").all();
    const AUTOMATION = /^(keir|system|github-sync|ticket-sync|source-sync|counter-migration|claude:kanban-sweep|unnamed)$/;
    const plans = [];
    const kept = [];
    for (const row of rows) {
      const c = counterFromCard(row);
      if (!c) continue;
      const events = db.prepare("SELECT event_type, actor, summary, created_at FROM kanban_events WHERE item_id = ? ORDER BY created_at, id").all(row.id);
      const worked = events.filter((e) => ["started", "blocked", "completed"].includes(e.event_type)
        || (e.event_type === "progress" && !AUTOMATION.test(e.actor) && !NOW_HITS_RE.test(String(e.summary || "").trim()) && !/^Keir failures? /.test(e.summary || "")));
      if (row.assigned_to || row.github_repo || ["now", "blocked"].includes(row.lane) || worked.length) {
        kept.push({ id: row.id, title: row.title, signature: c.signature, reason: row.assigned_to ? `assigned to ${row.assigned_to}` : row.github_repo ? "linked to a GitHub issue" : worked.length ? `worked on by ${[...new Set(worked.map((e) => e.actor))].join(", ")}` : `in ${row.lane}` });
        continue;
      }
      if (plans.length >= limit) break;
      const observations = [{ ...c, at: row.created_at, via: "migration" }];
      for (const e of events) {
        const m = String(e.summary || "").trim().match(NOW_HITS_RE);
        if (e.event_type === "progress" && m) observations.push({ signature: c.signature, family: c.family, window_hits: Number(m[1]), window_tasks: Number(m[2]), total: null, at: e.created_at, via: "migration" });
        else if (e.event_type === "progress" && c.family === "failure_alert" && /^Keir failures? /.test(e.summary || "")) observations.push({ signature: c.signature, family: c.family, window_hits: null, window_tasks: null, total: null, at: e.created_at, via: "migration" });
      }
      plans.push({ id: row.id, title: row.title, lane: row.lane, signature: c.signature, family: c.family, observations, expect: row.updated_at });
    }
    if (!dryRun) {
      for (const p of plans) {
        const row = store.rowById(p.id);
        if (!row || row.lane === "done" || row.updated_at !== p.expect) { p.skipped = true; continue; }
        const key = `counter-migrate:${p.id}`;
        if (db.prepare("SELECT 1 FROM kanban_events WHERE idempotency_key = ?").get(key)) { p.skipped = true; continue; }
        // Observations replay in time order, so the running counts difference correctly.
        p.observations.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
        for (const o of p.observations) record({ ...o, product: "lakeside-mcp", reporter: "keir" }, { at: o.at });
        const counter = db.prepare("SELECT * FROM kanban_counters WHERE signature = ?").get(p.signature);
        const cards = [...new Set([...parseJsonList(counter.migrated_cards), p.id])];
        db.prepare("UPDATE kanban_counters SET migrated_cards = ? WHERE signature = ?").run(JSON.stringify(cards), p.signature);
        const stamp = iso();
        db.transaction(() => {
          db.prepare("UPDATE kanban_items SET lane = 'done', closed_at = ?, needs_owner = 0, stale_flagged_at = NULL, updated_at = ? WHERE id = ?").run(stamp, stamp, p.id);
          store.logEvent({ item_id: p.id, product: row.product, event_type: "moved_to_counters", actor,
            summary: `Moved to the counter list as ${p.signature}. Automatic counts are not board cards any more: see /kanban/counters or mcp_capability_requests, where repeats keep counting. To build it, promote the counter (kanban_counter_promote), which files one card linked back to it. Lane was ${row.lane}.`,
            idempotency_key: key, created_at: stamp });
        })();
      }
    }
    const bySig = new Map();
    for (const p of plans) bySig.set(p.signature, (bySig.get(p.signature) || 0) + 1);
    return {
      dry_run: Boolean(dryRun),
      cards: plans.length,
      moved: plans.filter((p) => !p.skipped).length,
      signatures: bySig.size,
      by_family: plans.reduce((acc, p) => ({ ...acc, [p.family]: (acc[p.family] || 0) + 1 }), {}),
      merged_duplicates: [...bySig.entries()].filter(([, n]) => n > 1).map(([signature, n]) => ({ signature, cards: n })),
      kept_on_board: kept,
      changes: plans.map((p) => ({ id: p.id, title: p.title, lane: p.lane, signature: p.signature, observations: p.observations.length, ...(p.skipped ? { skipped: true } : {}) })),
    };
  }

  return { record, get, list, promote, migrateCards };
}

module.exports = {
  GAP_MARKER,
  counterFromAdd,
  counterFromReport,
  counterFromCard,
  gapSignature,
  failureSignature,
  occurrencesAdded,
  createCounters,
};
