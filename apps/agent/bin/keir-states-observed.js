#!/usr/bin/env node
"use strict";
// Runs the test suite with state tracing on and prints every state move it saw,
// grouped by machine, marking the ones lib/operator/machines.js does not list.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { allowed } = require("../lib/operator/machines");
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keir-states-")), "trace.jsonl");
const run = spawnSync("npm", ["test"], { cwd: path.join(__dirname, ".."), env: { ...process.env, KEIR_STATE_TRACE: file }, stdio: ["ignore", "ignore", "inherit"] });
const seen = new Map();
for (const line of fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []) {
  const { machine, from, to } = JSON.parse(line), key = `${machine} ${from} -> ${to}`;
  seen.set(key, { machine, from: from ?? undefined, to, count: (seen.get(key)?.count || 0) + 1 });
}
for (const [key, m] of [...seen].sort()) console.log(`${allowed(m.machine, m.from, m.to) ? "listed  " : "UNLISTED"} ${key} (${m.count})`);
console.log(`tests exit ${run.status}`);
fs.rmSync(path.dirname(file), { recursive: true, force: true });
