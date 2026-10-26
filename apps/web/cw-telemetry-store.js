"use strict";

// cw-telemetry-store.js: anonymous market-balance snapshots from Corporate Warfare.
//
// The iOS game posts one snapshot every five game weeks (see cw-telemetry-routes.js). One
// SQLite file shared by the dashboard (ingest) and the ops-knowledge MCP (read tools). The
// default path sits in the release's data/ directory, which links to persistent storage, so
// both processes open the same file without extra configuration; CW_TELEMETRY_DB overrides it.
// Snapshots carry a random install id and game numbers only: no names, account or device data.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cw_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at    TEXT NOT NULL,
  install_id     TEXT NOT NULL,
  app_version    TEXT NOT NULL,
  build          TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  dataset_hash   TEXT NOT NULL,
  scenario       TEXT NOT NULL,
  seed           INTEGER NOT NULL,
  week           INTEGER NOT NULL,
  payload        TEXT NOT NULL,
  UNIQUE (install_id, seed, week)
);
CREATE INDEX IF NOT EXISTS cw_snapshots_received ON cw_snapshots (received_at);
`;

// Oldest rows go once the table passes this many snapshots.
const MAX_ROWS = 250_000;

function defaultDbPath(env = process.env) {
  return path.resolve(env.CW_TELEMETRY_DB || path.join(__dirname, "data", "cw-telemetry.db"));
}

function openTelemetry(dbPath = defaultDbPath(), { now = () => new Date() } = {}) {
  const Database = require("better-sqlite3");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const insert = db.prepare(`INSERT OR IGNORE INTO cw_snapshots
    (received_at, install_id, app_version, build, engine_version, dataset_hash, scenario, seed, week, payload)
    VALUES (@received_at, @install_id, @app_version, @build, @engine_version, @dataset_hash, @scenario, @seed, @week, @payload)`);
  const trim = db.prepare(`DELETE FROM cw_snapshots WHERE id <= (SELECT MAX(id) FROM cw_snapshots) - ?`);

  return {
    db,
    /** Store one validated snapshot. Returns true when new, false for a duplicate. */
    add(envelope) {
      const s = envelope.snapshot;
      const info = insert.run({
        received_at: now().toISOString(),
        install_id: envelope.install_id,
        app_version: envelope.app_version,
        build: envelope.build,
        engine_version: s.engine_version,
        dataset_hash: s.dataset_hash,
        scenario: s.scenario,
        seed: s.seed,
        week: s.week,
        payload: JSON.stringify(s),
      });
      if (info.changes > 0 && info.lastInsertRowid % 1000 === 0) trim.run(MAX_ROWS);
      return info.changes > 0;
    },
    /** Snapshots received in the last `days` days, newest first, parsed. */
    recent({ days = 7, scenario = null, engineVersion = null, limit = 5000 } = {}) {
      const since = new Date(now().getTime() - days * 86_400_000).toISOString();
      const rows = db
        .prepare(`SELECT * FROM cw_snapshots WHERE received_at >= ?
          AND (? IS NULL OR scenario = ?) AND (? IS NULL OR engine_version = ?)
          ORDER BY id DESC LIMIT ?`)
        .all(since, scenario, scenario, engineVersion, engineVersion, limit);
      return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    },
    /**
     * Market balance across recent snapshots: per good, the median of what was made, sold,
     * imported, exported and held, the median asking price against reference, and the share
     * of supply that met domestic demand; plus how many installs and player companies were
     * losing money over their last thirteen weeks.
     */
    balance(options = {}) {
      const rows = this.recent(options);
      const median = (values) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      const goods = new Map();
      for (const row of rows) {
        for (const g of row.payload.goods || []) {
          if (!goods.has(g.id)) goods.set(g.id, { made: [], sold: [], imported: [], exported: [], stock: [], priceVsRefPct: [] });
          const entry = goods.get(g.id);
          entry.made.push(g.made_lots);
          entry.sold.push(g.sold_lots);
          entry.imported.push(g.imported_lots);
          entry.exported.push(g.exported_lots);
          entry.stock.push(g.stock_lots);
          if (g.reference_cents > 0) entry.priceVsRefPct.push(Math.round(((g.median_ask_cents - g.reference_cents) * 100) / g.reference_cents));
        }
      }
      const players = rows.map((row) => row.payload.player).filter(Boolean);
      return {
        snapshots: rows.length,
        installs: new Set(rows.map((row) => row.install_id)).size,
        engineVersions: [...new Set(rows.map((row) => row.engine_version))],
        playersLosing13w: players.filter((p) => p.net_income_13w_cents < 0).length,
        playersReporting: players.length,
        medianPlayerNet13wCents: median(players.map((p) => p.net_income_13w_cents)),
        goods: [...goods.entries()].map(([id, e]) => ({
          id,
          made: median(e.made),
          sold: median(e.sold),
          imported: median(e.imported),
          exported: median(e.exported),
          stock: median(e.stock),
          priceVsRefPct: median(e.priceVsRefPct),
        })),
      };
    },
    close() {
      db.close();
    },
  };
}

let shared = null;
function sharedTelemetry() {
  if (!shared) shared = openTelemetry();
  return shared;
}

module.exports = { openTelemetry, sharedTelemetry, defaultDbPath, MAX_ROWS };
