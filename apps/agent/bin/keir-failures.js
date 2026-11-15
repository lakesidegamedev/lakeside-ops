#!/usr/bin/env node
"use strict";
// Keir failure groups. Read-only on the live events.db: when the live DB has no failure tables yet, groups are
// computed in memory from its events. Writing needs --write and an explicit --db.
//   node bin/keir-failures.js top [--since 24h] [--class reasoning] [--db FILE]
//   node bin/keir-failures.js new | release [version] | show <fingerprint> [--context 5]
//   node bin/keir-failures.js backfill --days 14 [--write] [--db FILE] [--usage FILE]
const fs = require("node:fs"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const F = require("../lib/operator/failures");
const argv = process.argv.slice(2), cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const stateDir = process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator";
const dbFile = opt("--db", path.join(stateDir, "events.db"));
const usageFile = opt("--usage", path.join(stateDir, "usage.jsonl"));
const DUR = { h: 3600000, d: 86400000, m: 60000 };
const span = (s) => { const m = /^(\d+)([hdm])$/.exec(String(s)); return m ? Number(m[1]) * DUR[m[2]] : 86400000; };
const pad = (v, n) => String(v).padStart(n);
function open() {
  const write = argv.includes("--write");
  const src = new DatabaseSync(dbFile, write ? {} : { readOnly: true });
  if (write) return { src, rec: F.createRecorder({ db: src, stateDir }), mem: false };
  const has = src.prepare("SELECT 1 FROM sqlite_master WHERE name = 'failure_groups'").get();
  if (has) return { src, rec: readerQueries(src), mem: false };
  const mem = new DatabaseSync(":memory:"), rec = F.createRecorder({ db: mem, stateDir });
  F.backfill({ recorder: rec, eventsDb: src, usageFile, since: Date.now() - Number(opt("--days", 14)) * 86400000 });
  return { src, rec, mem: true };
}
function readerQueries(db) {
  const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const map = (g) => ({ ...g, tickets: parse(g.tickets, []), releases: parse(g.releases, {}), providers: parse(g.providers, {}), samples: parse(g.samples, []) });
  return {
    groups: ({ since = null, cls = null, limit = 20, at = Date.now() } = {}) => {
      const rows = since
        ? db.prepare("SELECT g.*, (SELECT count(*) FROM failures f WHERE f.fingerprint = g.fingerprint AND f.at >= ?) AS in_window FROM failure_groups g WHERE (? IS NULL OR g.class = ?) ORDER BY in_window DESC, g.count DESC LIMIT ?").all(at - since, cls, cls, limit)
        : db.prepare("SELECT *, count AS in_window FROM failure_groups WHERE (? IS NULL OR class = ?) ORDER BY count DESC LIMIT ?").all(cls, cls, limit);
      return rows.filter((r) => r.in_window > 0).map(map);
    },
    get: (fp) => { const g = db.prepare("SELECT * FROM failure_groups WHERE fingerprint = ?").get(fp); return g ? map(g) : null; },
    releaseRates: (rel) => {
      const act = db.prepare("SELECT count(*) AS n FROM failure_activations WHERE release = ?").get(rel).n;
      const by = Object.fromEntries(db.prepare("SELECT class, count(*) AS n FROM failures WHERE release = ? GROUP BY class").all(rel).map((r) => [r.class, r.n]));
      return { release: rel, activations: act, failures: by, per100: Object.fromEntries(F.CLASSES.map((c) => [c, act ? Math.round(((by[c] || 0) / act) * 10000) / 100 : null])) };
    },
    releases: () => db.prepare("SELECT release, max(at) AS last FROM failure_activations WHERE release IS NOT NULL GROUP BY release ORDER BY last DESC").all().map((r) => r.release),
  };
}
const line = (g, n) => `${pad(n, 6)}  ${g.class.padEnd(9)} ${g.kind.padEnd(26)} tickets ${pad(g.tickets.length, 3)}  ${g.fingerprint}  ${g.title.slice(0, 70)}`;
function transcriptContext(attempt, n) {
  const p = F.transcriptPath(attempt, { stateDir });
  if (!p) return "  (no transcript found for this attempt)";
  if (p.includes("harness.db#")) {
    const db = new DatabaseSync(p.split("#")[0], { readOnly: true });
    const rows = db.prepare("SELECT seq, kind, payload FROM attempt_events WHERE attempt_id = ? ORDER BY seq").all(attempt);
    const idx = rows.findIndex((r) => /refus|error/i.test(r.payload) && r.kind === "tool_result");
    const from = Math.max(0, (idx < 0 ? rows.length - n : idx - n)), to = idx < 0 ? rows.length : idx + n + 1;
    return `  ${p}\n` + rows.slice(from, to).map((r) => `  [${r.seq}] ${r.kind}: ${String(r.payload).slice(0, 300)}`).join("\n");
  }
  const text = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).filter((l) => !/thinking_delta|signature_delta|input_json_delta|"thinking_tokens"/.test(l));
  const i = text.findIndex((l) => /refus|"is_error":true|Not posted|Not finished/i.test(l));
  const from = Math.max(0, (i < 0 ? text.length - n : i - n)), to = i < 0 ? text.length : i + n + 1;
  return `  ${p}\n` + text.slice(from, to).map((l) => `  ${l.slice(0, 300)}`).join("\n");
}
function main() {
  if (!["top", "new", "release", "show", "backfill"].includes(cmd)) { console.error("usage: keir-failures.js top|new|release|show|backfill"); process.exit(2); }
  const { src, rec, mem } = open();
  if (mem) console.error(`(live DB has no failure tables yet: computed in memory from ${dbFile}, nothing written)`);
  if (cmd === "backfill") {
    if (!argv.includes("--write")) { console.log("dry run (add --write with an explicit --db to store). Groups found:"); }
    else { const r = F.backfill({ recorder: rec, eventsDb: src, usageFile, since: Date.now() - Number(opt("--days", 14)) * 86400000 }); console.log(`backfilled ${r.events} events, ${r.usage} usage rows`); }
    for (const g of rec.groups({ limit: 15 })) console.log(line(g, g.count));
    return;
  }
  if (cmd === "top") {
    const since = span(opt("--since", "24h")), cls = opt("--class", null);
    const rows = rec.groups({ since, cls, limit: Number(opt("--limit", 15)) });
    if (!rows.length) return console.log("No failures in that window.");
    for (const g of rows) console.log(line(g, g.in_window));
  } else if (cmd === "new") {
    const rows = rec.groups({ since: 86400000, limit: 200 }).filter((g) => g.first_seen >= Date.now() - 86400000);
    if (!rows.length) return console.log("No new failure kinds in 24h.");
    for (const g of rows) console.log(line(g, g.count));
  } else if (cmd === "release") {
    const rels = rec.releases(), cur = argv[1] && !argv[1].startsWith("--") ? argv[1] : rels[0], prev = rels[rels.indexOf(cur) + 1];
    for (const r of [cur, prev].filter(Boolean)) { const x = rec.releaseRates(r); console.log(`${x.release}: ${x.activations} activations; per 100: ${F.CLASSES.map((c) => `${c} ${x.per100[c] ?? "-"}`).join(", ")}`); }
  } else if (cmd === "show") {
    const g = rec.get(argv[1]);
    if (!g) { console.error("unknown fingerprint"); process.exit(1); }
    console.log(`${g.title}\n${g.fingerprint}  count ${g.count}  first ${new Date(g.first_seen).toISOString()}  last ${new Date(g.last_seen).toISOString()}`);
    console.log(`tickets: ${g.tickets.join(", ") || "-"}\nreleases: ${JSON.stringify(g.releases)}\nproviders: ${JSON.stringify(g.providers)}\nsamples:`);
    const ctx = Number(opt("--context", 0));
    for (const s of g.samples) { console.log(`- ${new Date(s.at).toISOString()} job ${s.job} ticket ${s.ticket ?? "-"} attempt ${s.attempt || "-"}: ${s.detail}`); if (ctx && s.attempt) console.log(transcriptContext(s.attempt, ctx)); else if (s.attempt) console.log(`  transcript: ${F.transcriptPath(s.attempt, { stateDir }) || "none"}`); }
  }
}
main();
