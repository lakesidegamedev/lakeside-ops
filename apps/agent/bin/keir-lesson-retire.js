#!/usr/bin/env node
"use strict";
// Lesson retirement (Keir 8.x). Dry run by default.
//   node bin/keir-lesson-retire.js [--apply] [--cap=5] | --restore <id>
// State comes from KEIR_STATE_DIR (default /var/lib/keir-operator). Retirements are capped, recorded in the
// note's history (op "retired" with a reason) and in meta.retireLog, and reversible with --restore.
const fs = require("node:fs"), path = require("node:path");
const { createNotebook } = require("../lib/operator/knowledge");
const { planRetirements, reportFor } = require("../lib/operator/lessonretire");
const dir = process.env.KEIR_STATE_DIR || "/var/lib/keir-operator", args = process.argv.slice(2);
const file = path.join(dir, "notebook.json");
const notebook = createNotebook({ file, repo: process.env.KEIR_NOTEBOOK_REPO || "/root/projects/AHDGame" });
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const restoreAt = args.indexOf("--restore");
if (restoreAt >= 0) {
  const id = args[restoreAt + 1];
  console.log(id && notebook.restore(id) ? `restored ${id}` : `nothing to restore for ${id || "(no id)"}`);
  process.exit(0);
}
let ledgerData = {};
try { ledgerData = JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")); } catch { /* no ledger */ }
const cap = Number(flag("cap")) || 5;
const notes = [...notebook.all()];
const report = reportFor({ notes, recallLog: notebook.recallLog, ledgerData });
const plan = planRetirements({ notes, report, cap });
console.log(`${args.includes("--apply") ? "applying" : "dry run"}: ${plan.length} of ${notes.filter((n) => n.kind === "lesson").length} live lessons`);
for (const p of plan) console.log(`  ${p.id}  ${p.rule.padEnd(9)} ${p.reason}  |  ${p.text.slice(0, 80).replace(/\s+/g, " ")}`);
if (args.includes("--apply")) console.log(`retired ${notebook.retire(plan, { dailyCap: cap }).length}`);
