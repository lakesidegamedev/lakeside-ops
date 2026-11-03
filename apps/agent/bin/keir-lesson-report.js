#!/usr/bin/env node
"use strict";
// Lesson accounting report (Keir 8). Read-only: joins the notebook's recall log to ticket outcomes and feedback.
//   node bin/keir-lesson-report.js [--json] [--days=14]
// State comes from KEIR_STATE_DIR (default /var/lib/keir-operator).
const fs = require("node:fs"), path = require("node:path");
const { buildReport } = require("../lib/operator/lessonreport");
const dir = process.env.KEIR_STATE_DIR || "/var/lib/keir-operator", args = process.argv.slice(2);
const json = args.includes("--json"), days = Number((args.find((a) => a.startsWith("--days=")) || "").split("=")[1]) || 14;
const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return fallback; } };
const nb = read("notebook.json", { notes: [] }), ledger = read("ledger.json", {});
let recalls = [];
try { recalls = fs.readFileSync(path.join(dir, "notebook.json.recalls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* no log yet */ }
const report = buildReport({ notes: nb.notes || [], recalls, outcomes: ledger.ticketOutcomes || {}, feedback: ledger.feedbackLog || [], jobs: ledger.jobs || {}, minTrackingDays: days });
if (json) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }
const pct = (x) => (x == null ? "  -" : `${Math.round(x * 100)}%`.padStart(4));
const s = report.summary;
console.log(`tracking ${report.trackingSince ? new Date(report.trackingSince).toISOString().slice(0, 16) + "Z" : "not started"} (${report.trackingDays} days; ${s.enoughData ? "enough" : `needs ${days}`} for retirement flags)`);
console.log(`live lessons ${s.lessons}: recalled at least once ${s.recalledAtLeastOnce}, unused ${s.unused}, suspect ${s.suspect}, never verified ${s.unverified}`);
const b = report.baseline; console.log(`baseline over ${b.tickets} tickets with a recall: resolved ${pct(b.resolved)} reopened ${pct(b.reopened)} negative feedback ${pct(b.negative)} praise ${pct(b.praised)}\n`);
console.log("most recalled:");
for (const l of [...report.lessons].sort((a, c) => c.recalls - a.recalls).slice(0, 8)) console.log(`  ${String(l.recalls).padStart(4)}x ${String(l.tickets).padStart(3)} tickets  res ${pct(l.resolved)} neg ${pct(l.negative)}  ${l.flags.filter((f) => f !== "unverified").join(",") || "ok"}  ${l.text.slice(0, 80).replace(/\s+/g, " ")}`);
for (const flag of ["suspect", "unused"]) { const list = report.lessons.filter((l) => l.flags.includes(flag)); if (list.length) { console.log(`\n${flag} (${list.length}):`); for (const l of list.slice(0, 10)) console.log(`  ${l.id}  ${l.recalls}x  ${l.text.slice(0, 90).replace(/\s+/g, " ")}`); } }
