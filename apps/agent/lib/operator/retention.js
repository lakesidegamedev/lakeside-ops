"use strict";
// Keir 10: per-run files under the state directory were never cleaned (5k claude homes, 5k streams, 16k attempt
// records). This pass removes the ones older than the keep window, except anything a failure sample or an open
// job still points at. Dry run unless apply is true (KEIR_RETENTION=apply). Never touches ledger, events or usage.
const fs = require("node:fs");
const path = require("node:path");
const DAY = 86400000;

const TARGETS = [
  { dir: "", re: /^claude-home-/, kind: "dir" },
  { dir: "", re: /^claude-stream-(.+)\.jsonl$/, kind: "file" },
  { dir: "", re: /^codex-stream-(.+)\.jsonl$/, kind: "file" },
  { dir: "cli-attempts", re: /^(.+)\.json$/, kind: "file" },
  { dir: "muse-traces", re: /^(.+)\.jsonl$/, kind: "file" },
  { dir: "codex-runs", re: /^[\w-]+$/, kind: "dir" },
];

// protect: Set of attempt ids or job ids that must stay. A name is protected when it contains one of them.
function plan({ stateDir, now = Date.now(), keepMs = 14 * DAY, protect = new Set() }) {
  const out = { candidates: [], kept: 0, protectedCount: 0 };
  const ids = [...protect].filter(Boolean).map(String);
  for (const t of TARGETS) {
    const dir = path.join(stateDir, t.dir);
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = t.re.exec(name); if (!m) continue;
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if ((t.kind === "dir") !== st.isDirectory()) continue;
      if (now - st.mtimeMs < keepMs) { out.kept++; continue; }
      if (ids.some((id) => name.includes(id))) { out.protectedCount++; continue; }
      out.candidates.push(full);
    }
  }
  return out;
}

function run({ stateDir, now = Date.now(), keepMs, protect, apply = false, log = () => {} }) {
  const p = plan({ stateDir, now, keepMs, protect });
  let removed = 0, failed = 0;
  if (apply) for (const f of p.candidates) { try { fs.rmSync(f, { recursive: true, force: true }); removed++; } catch { failed++; } }
  log(`retention ${apply ? "applied" : "dry run"}: ${p.candidates.length} past keep window, ${p.protectedCount} protected, ${p.kept} recent${apply ? `, removed ${removed}, failed ${failed}` : ""}`);
  return { apply, candidates: p.candidates.length, protectedCount: p.protectedCount, kept: p.kept, removed, failed };
}

// Ids to protect: attempts in failure samples plus attempts and ids of jobs that are not finished.
function protectedIds({ db = null, jobs = {} }) {
  const ids = new Set();
  try { if (db) for (const r of db.prepare("SELECT samples FROM failure_groups").all()) for (const s of JSON.parse(r.samples)) { if (s.attempt) ids.add(s.attempt); } } catch {}
  for (const j of Object.values(jobs || {})) {
    if (!j || ["done", "failed", "cancelled", "dismissed"].includes(j.state)) continue;
    ids.add(j.id); if (j.provider?.attempt) ids.add(j.provider.attempt);
  }
  return ids;
}
module.exports = { plan, run, protectedIds };
