#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { readVersionEfficiency } = require("../lib/operator/versionefficiency");
const [ledger, usage, historyFile, eventsFile, releasesDirectory] = process.argv.slice(2);
if (!ledger || !usage) {
  console.error("Usage: keir-efficiency.js ledger.json usage.jsonl [releases.jsonl] [events.db] [releases-directory]");
  process.exitCode = 2;
} else {
  const data = JSON.parse(fs.readFileSync(ledger, "utf8"));
  readVersionEfficiency(data, usage, { historyFile, eventsFile, releasesDirectory })
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
