#!/usr/bin/env node
"use strict";
// Keir self-review (after Harness², harnessing-level recursion): once a night,
// read the last day's evidence from the operator's event sink (tool refusals,
// blocked tasks), cluster it, and turn the top recurring cause that has not
// been proposed before into one draft pull request written by an external
// coding agent. The owner reviews and merges; nothing here changes live Keir.
//
//   node bin/keir-self-review.js [--dry-run] [--hours 24] [--min 5]
//
// Environment: KEIR_OPERATOR_STATE_DIR (events.db, proposals file),
// KEIR_SELF_REVIEW_REPO (main checkout), KEIR_SELF_REVIEW_MODEL (OpenCode model),
// KEIR_SELF_REVIEW_RUNNER (host launcher).
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");

// Refusal messages differ by numbers, ids and names; the cause does not.
function normalize(message) {
  return String(message || "")
    .replace(/"[^"]{0,120}"/g, '"…"')
    .replace(/\([^)]{0,80}\)/g, "(…)")
    .replace(/#?\b\d[\d,.:]*\b/g, "N")
    .replace(/\b[a-f0-9]{12,}\b/g, "ID")
    .replace(/\s+/g, " ").trim().slice(0, 140);
}

// Group refusals by tool and normalized message; rank by tasks affected, then count.
function clusters(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = `${r.tool}: ${normalize(r.error)}`;
    const c = by.get(key) || { key, tool: r.tool, count: 0, jobs: new Set(), tickets: new Set(), samples: [] };
    c.count++; c.jobs.add(r.job); if (r.ticket) c.tickets.add(r.ticket);
    if (c.samples.length < 4) c.samples.push(String(r.error).slice(0, 240));
    by.set(key, c);
  }
  return [...by.values()].map((c) => ({ ...c, jobs: c.jobs.size, tickets: [...c.tickets] })).sort((a, b) => b.jobs - a.jobs || b.count - a.count);
}

function readEvents(dbFile, sinceMs) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare("SELECT kind, payload FROM events WHERE at > ? AND kind IN ('audit:tool_refused', 'audit:self_recovery') ORDER BY at").all(sinceMs);
  db.close();
  const parse = (p) => { try { return JSON.parse(p); } catch { return {}; } };
  return {
    refusals: rows.filter((r) => r.kind === "audit:tool_refused").map((r) => parse(r.payload)).filter((p) => p.tool && p.error),
    recoveries: rows.filter((r) => r.kind === "audit:self_recovery").length,
  };
}

function briefFor(c) {
  return `You are improving Keir, the A House Divided support operator (lakeside-ops, apps/agent). The model Keir runs on is fixed; you improve its harness.

In the last day Keir's broker refused this tool call ${c.count} times across ${c.jobs} tasks:
  ${c.key}
Samples:
${c.samples.map((s) => `- ${s}`).join("\n")}

Find why. Most refusals are legitimate guards; the fault is usually friction: the model sends a reasonable argument shape the broker does not accept, a refusal message that does not say how to succeed, a rule that re-arms after the model follows it, or a guard that blocks a legitimate step. Read apps/agent/lib/operator/broker.js around the refusal and the tool's description in apps/agent/lib/operator/agent.js.

Then make ONE deterministic fix: accept the reasonable shape, make the refusal name the exact fix, or correct the rule. Never weaken a safety guard (approvals, money, player privacy, public-repo leaks, moderation). If the refusal is correct and the message already says how to succeed, change nothing and say so.

Add or extend a unit test in apps/agent/test that fails before your change and passes after, run it with
  NODE_PATH=/opt/keir/current/node_modules node --test <that file>
and add one line under "## Unreleased" / "### For developers" in apps/agent/CHANGELOG.md. The repository is public: never copy player or character names, ticket numbers, Discord ids or hosts from the samples into code, tests or the changelog; use made-up values. Plain language, no em or en dashes. Do not push or open a pull request.`;
}

function main(argv = process.argv.slice(2)) {
  const o = { hours: 24, min: 5, dryRun: argv.includes("--dry-run") };
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--hours") o.hours = Number(argv[++i]); else if (argv[i] === "--min") o.min = Number(argv[++i]);
  const state = process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator";
  const repo = process.env.KEIR_SELF_REVIEW_REPO || "/root/projects/lakeside-ops";
  const model = process.env.KEIR_SELF_REVIEW_MODEL || "opencode-go/deepseek-v4.1-flash";
  const runner = process.env.KEIR_SELF_REVIEW_RUNNER || "/root/bin/provider-agent-run.sh";
  const proposalsFile = path.join(state, "self-review-proposals.json");
  const proposals = fs.existsSync(proposalsFile) ? JSON.parse(fs.readFileSync(proposalsFile, "utf8")) : { proposed: [] };
  const { refusals, recoveries } = readEvents(path.join(state, "events.db"), Date.now() - o.hours * 3600000);
  const ranked = clusters(refusals);
  const fresh = ranked.filter((c) => c.count >= o.min && c.jobs >= 2 && !proposals.proposed.some((p) => p.key === c.key));
  const report = { at: new Date().toISOString(), hours: o.hours, refusals: refusals.length, selfRecoveries: recoveries, top: ranked.slice(0, 10).map((c) => ({ key: c.key, count: c.count, tasks: c.jobs })) };
  console.log(JSON.stringify(report, null, 2));
  if (!fresh.length) { console.log("self-review: nothing new above the threshold"); return; }
  const c = fresh[0];
  if (o.dryRun) { console.log(`self-review (dry run) would propose: ${c.key}`); return; }

  const git = (args, cwd = repo) => cp.execFileSync("git", args, { cwd, encoding: "utf8" });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const branch = `keir/self-review-${stamp}-${c.tool.replace(/[^a-z0-9]+/gi, "-")}`.slice(0, 80);
  const wt = path.join(repo, "worktrees", branch.replace(/\//g, "-"));
  git(["fetch", "-q", "origin"]);
  git(["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
  const brief = path.join(state, `self-review-${stamp}.md`), log = path.join(state, `self-review-${stamp}.log`);
  fs.writeFileSync(brief, briefFor(c));
  let ok = true;
  try { cp.execFileSync(runner, ["opencode", repo, wt, brief, model, log], { stdio: "ignore", timeout: 45 * 60000 }); } catch { ok = false; }
  const changed = git(["diff", "--name-only", "origin/main"], wt).split("\n").filter(Boolean);
  const entry = { key: c.key, at: report.at, count: c.count, tasks: c.jobs, branch, changed, ok };
  proposals.proposed.push(entry); fs.writeFileSync(proposalsFile, JSON.stringify(proposals, null, 2));
  if (!changed.length || changed.some((f) => !f.startsWith("apps/agent/"))) {
    console.log(`self-review: no admissible change for ${c.key} (${changed.join(", ") || "none"})`);
    git(["worktree", "remove", "--force", wt]); try { git(["branch", "-D", branch]); } catch {}
    return;
  }
  git(["push", "-q", "-u", "origin", branch], wt);
  // Public repository: the scrubbed cluster key only, never raw samples (they can name players).
  const body = `Nightly Keir self-review. In the ${o.hours}h before ${report.at} the broker refused \`${c.key.replace(/`/g, "'")}\` ${c.count} times across ${c.jobs} tasks. A ${model} coding agent proposed this fix with a unit test.\n\nDraft for owner review; nothing ships until merged and released.`;
  const url = cp.execFileSync("gh", ["pr", "create", "-R", "lakesidegamedev/lakeside-ops", "--base", "main", "--head", branch, "--draft", "--title", `fix(keir): self-review: ${c.tool} refusals (${c.count} in ${o.hours}h)`, "--body", body], { encoding: "utf8" }).trim();
  entry.pr = url; fs.writeFileSync(proposalsFile, JSON.stringify(proposals, null, 2));
  git(["worktree", "remove", "--force", wt]);
  console.log(`self-review: opened ${url}`);
}

if (require.main === module) { try { main(); } catch (e) { console.error(e.stack || e.message); process.exitCode = 1; } }
module.exports = { normalize, clusters, briefFor };
