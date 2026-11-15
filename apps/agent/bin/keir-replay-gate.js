#!/usr/bin/env node
"use strict";
// Small release gate helper (deploy/release.sh --replay-gate). The k10 replay set
// runs once per scenario for the live release and once for the candidate; the
// candidate is refused if any scenario that passed on live now fails.
//   keir-replay-gate.js summarize <results-dir> <release-sha>      prints {sha, at, scenarios:{id:bool}} JSON
//   keir-replay-gate.js compare <baseline.json> <summary.json>     prints regressions, exits 1 on any
//   keir-replay-gate.js sha <baseline.json>                        prints the baseline's release sha
const fs = require("node:fs"), path = require("node:path");

function summarize(dir, sha, now = Date.now()) {
  const file = path.join(dir, "results.jsonl");
  const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const scenarios = {};
  // One run per scenario; if there is more than one, the scenario passes only when every run passed.
  for (const r of rows) scenarios[r.scenario] = (scenarios[r.scenario] ?? true) && Boolean(r.grade?.success) && !r.error;
  return { sha, at: now, scenarios };
}

// A regression is a scenario the baseline passed and the candidate failed. A scenario missing from the candidate counts as failed.
function compare(baseline, candidate) {
  const regressions = Object.entries(baseline.scenarios || {}).filter(([id, ok]) => ok && candidate.scenarios?.[id] !== true).map(([id]) => id);
  const fixed = Object.entries(candidate.scenarios || {}).filter(([id, ok]) => ok && baseline.scenarios?.[id] === false).map(([id]) => id);
  return { regressions, fixed, ok: regressions.length === 0 };
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  if (cmd === "summarize") console.log(JSON.stringify(summarize(a, b)));
  else if (cmd === "sha") console.log(fs.existsSync(a) ? read(a).sha || "" : "");
  else if (cmd === "compare") {
    const r = compare(read(a), read(b));
    console.log(r.ok ? `replay gate: no regressions${r.fixed.length ? `; newly passing: ${r.fixed.join(", ")}` : ""}` : `replay gate: refused, these scenarios passed on the live release and fail now: ${r.regressions.join(", ")}`);
    process.exit(r.ok ? 0 : 1);
  } else { console.error("usage: keir-replay-gate.js summarize <dir> <sha> | compare <baseline> <summary> | sha <baseline>"); process.exit(2); }
}
module.exports = { summarize, compare };
