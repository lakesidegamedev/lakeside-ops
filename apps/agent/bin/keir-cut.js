#!/usr/bin/env node
"use strict";
// Cut the open release at train time: move CHANGELOG `## Unreleased` under a
// version heading and set that version in package.json, package-lock.json,
// rust/Cargo.toml and rust/Cargo.lock. Feature PRs never bump versions; the
// next train's version stays open for every fix until this runs.
//   bin/keir-cut.js <X.Y.Z> [YYYY-MM-DD]   then commit, PR, merge, deploy/release.sh
const fs = require("node:fs");
const path = require("node:path");

const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const CRATES = ["harness-core", "harness-runner", "harness-store", "lakeside"];

// files: { changelog, pkg, lock, cargo, cargoLock } as text. Returns updated texts.
function cut(files, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("version must be X.Y.Z");
  const current = JSON.parse(files.pkg).version;
  if (!newer(version, current)) throw new Error(`${version} is not newer than ${current}`);
  const m = /^## Unreleased\n([\s\S]*?)(?=^## )/m.exec(files.changelog);
  if (!m) throw new Error("CHANGELOG has no ## Unreleased section");
  const body = m[1].replace(/<!--[\s\S]*?-->\n?/g, "").trim();
  if (!body) throw new Error("nothing under ## Unreleased to release");
  const changelog = files.changelog.replace(m[0], `## Unreleased\n\n## ${version} (${date})\n\n${body}\n\n`);
  const pkg = files.pkg.replace(`"version": "${current}"`, `"version": "${version}"`);
  let n = 0;
  const lock = files.lock.replace(new RegExp(`"version": "${current.replace(/\./g, "\\.")}"`, "g"), (s) => (n++ < 2 ? `"version": "${version}"` : s));
  const cargo = files.cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  let cargoLock = files.cargoLock;
  for (const c of CRATES) cargoLock = cargoLock.replace(new RegExp(`(name = "${c}"\\nversion = )"[^"]+"`), `$1"${version}"`);
  return { changelog, pkg, lock, cargo, cargoLock };
}

module.exports = { cut, newer };

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const [version, date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })] = process.argv.slice(2);
  const paths = { changelog: "CHANGELOG.md", pkg: "package.json", lock: "package-lock.json", cargo: "rust/Cargo.toml", cargoLock: "rust/Cargo.lock" };
  const files = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, fs.readFileSync(path.join(root, p), "utf8")]));
  const out = cut(files, version, date);
  for (const [k, p] of Object.entries(paths)) fs.writeFileSync(path.join(root, p), out[k]);
  console.log(`cut ${version} (${date}); commit, PR, merge, then deploy/release.sh origin/main`);
}
