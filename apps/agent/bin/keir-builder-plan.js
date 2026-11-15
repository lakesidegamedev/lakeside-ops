#!/usr/bin/env node
"use strict";
// Prints the weekly builder plan as JSON (repo, brief, digest line). Read-only.
//   node bin/keir-builder-plan.js [--ledger FILE] [--top 5]
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const file = opt("--ledger") || path.join(process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator", "ledger.json");
let data;
try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`cannot read ledger ${file}: ${e.message}`); process.exit(1); }
const plan = require("../lib/operator/builderplan").planBuilder(data, { top: Math.max(1, Math.min(10, Number(opt("--top")) || 5)) });
console.log(JSON.stringify(plan));
