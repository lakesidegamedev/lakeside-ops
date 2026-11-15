#!/usr/bin/env node
"use strict";
// Add a lesson to Keir's notebook (Keir 2.0). Used by shadow review whenever a
// public claim had to be corrected, so the next task recalls it.
// Usage: keir-lesson.js "<lesson>" [--ticket N] [--kind lesson|mechanic|decision|resolution] [--path src/...] [--lane question|bug|outage|account|idea]
// --lane files the lesson with that lane's playbook (Keir 10) instead of the general notebook pool.
const fs = require("node:fs");
const argv = process.argv.slice(2), opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const raw = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const lane = opt("--lane");
if (lane && !["question", "bug", "outage", "account", "idea"].includes(lane)) { console.error("lane must be question, bug, outage, account or idea"); process.exit(2); }
const text = raw && lane ? `[lane:${lane}] ${raw}` : raw;
if (!text) { console.error("usage: keir-lesson.js \"<lesson>\" [--ticket N] [--kind lesson] [--path p]"); process.exit(2); }
const env = Object.fromEntries(fs.readFileSync("/etc/keir-operator.env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
fetch(`http://127.0.0.1:${env.KEIR_OPERATOR_PORT || 9765}/notebook`, { method: "POST", headers: { Authorization: `Bearer ${env.KEIR_OPERATOR_ADMIN_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ text, kind: opt("--kind") || "lesson", ticket: opt("--ticket") ? Number(opt("--ticket")) : undefined, path: opt("--path") }) })
  .then(async (r) => { const j = await r.json(); console.log(r.ok ? `saved ${j.saved.id}` : `refused: ${j.error}`); process.exit(r.ok ? 0 : 1); });
