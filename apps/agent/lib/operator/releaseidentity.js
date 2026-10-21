"use strict";
const fs = require("node:fs");
const path = require("node:path");
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/i;

function releaseIdentity(value) {
  return value && VERSION.test(value.version || "") && SHA.test(value.sha || "")
    ? { version: value.version, sha: value.sha.toLowerCase() } : null;
}
function readRelease(file = path.join(__dirname, "../../RELEASE")) {
  try { const [sha, version] = fs.readFileSync(file, "utf8").trim().split(/\s+/); return releaseIdentity({ sha, version }); }
  catch { return null; }
}
function readReleaseHistory(file, directory) {
  const history = [];
  try { if (file) history.push(...fs.readFileSync(file, "utf8").split("\n").flatMap(line => {
    try { const row = JSON.parse(line); return releaseIdentity(row) ? [row] : []; } catch { return []; }
  })); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { if (directory) for (const name of fs.readdirSync(directory)) {
    const release = readRelease(path.join(directory, name, "RELEASE"));
    if (release) history.push(release);
  } } catch (error) { if (error.code !== "ENOENT") throw error; }
  return history;
}

// Return only identities and timestamps from the event sink. No event payload or
// player text is needed to bind a usage row to its actual operator process.
function readReleaseEvents(file) {
  if (!file || !fs.existsSync(file)) return [];
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT at, attempt_id AS job, release AS sha, payload FROM events WHERE kind IN ('audit:cli_activation', 'audit:rust_activation') AND release IS NOT NULL ORDER BY at").all().map(row => {
    let attempt = null; try { attempt = JSON.parse(row.payload).attempt || null; } catch { /* identity may still be usable */ }
    return { at: row.at, job: row.job, sha: row.sha, attempt };
  }); } finally { db.close(); }
}

function attributeReleases(rows, history = [], events = []) {
  const bySha = new Map(history.filter(releaseIdentity).map(row => [row.sha.toLowerCase(), releaseIdentity(row)]));
  const byJob = new Map();
  for (const event of events) {
    if (!event.job || !bySha.has(String(event.sha).toLowerCase()) || !Number.isFinite(event.at)) continue;
    (byJob.get(event.job) || byJob.set(event.job, []).get(event.job)).push(event);
  }
  return rows.map(row => {
    const explicit = releaseIdentity(row.release);
    if (explicit) return { ...row, release: explicit, releaseSource: row.releaseSource || "usage-record" };
    const at = Date.parse(row.at);
    const matches = (byJob.get(row.job) || []).filter(event => Math.abs(event.at - at) <= 2000
      && !(row.attempt && event.attempt && row.attempt !== event.attempt));
    // Conflicting process identities are unknown, never guessed from a flip
    // timestamp: a staged release need not be the release actually running.
    const shas = new Set(matches.map(event => event.sha.toLowerCase()));
    return { ...row, release: shas.size === 1 ? bySha.get([...shas][0]) : null,
      releaseSource: shas.size === 1 ? "event-sink" : "unknown" };
  });
}

module.exports = { releaseIdentity, readRelease, readReleaseHistory, readReleaseEvents, attributeReleases };
