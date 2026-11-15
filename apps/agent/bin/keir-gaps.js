#!/usr/bin/env node
"use strict";
// Ranked capability gap ledger: the gaps Keir keeps hitting, worst first.
// A hit from a task on a low-scored closed ticket counts double (Keir 10).
//   node bin/keir-gaps.js [--top 10] [--json] [--ledger FILE]
// Reads the ledger file read-only (default $KEIR_OPERATOR_STATE_DIR or /var/lib/keir-operator).
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const file = opt("--ledger") || path.join(process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator", "ledger.json");
const top = Math.max(1, Math.min(50, Number(opt("--top")) || 10));
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`cannot read ledger ${file}: ${e.message}`); process.exit(1); }
const rows = require("../lib/operator/capabilitygaps").rank(data, top);
if (argv.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
if (!rows.length) { console.log("No capability gaps recorded."); process.exit(0); }
console.log("rank  card    weighted  hits  low  tasks  gap");
for (const r of rows) console.log(`${String(r.rank).padStart(4)}  ${String(r.kanbanId ?? "-").padStart(6)}  ${String(r.weighted).padStart(8)}  ${String(r.hits).padStart(4)}  ${String(r.lowHits).padStart(3)}  ${String(r.tasks).padStart(5)}  ${r.title.slice(0, 90)}  [${r.sig}]`);
