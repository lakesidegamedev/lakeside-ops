"use strict";
// Keir 10 weekly builder: turn the top ranked capability gaps into one brief for
// one headless coding worker. Pure: no files, no launches. The shell wrapper
// (deploy/keir-builder.sh) makes the worktree, runs the worker and posts the digest.
const { rank } = require("./capabilitygaps");

const REPOS = { "lakeside-code": "/root/projects/lakeside-code", "lakeside-ops": "/root/projects/lakeside-ops" };

// Where a gap is fixed. A read tool that fails or is missing belongs to the Rust
// gamestate MCP; a read Keir is simply not allowed to call belongs to Keir's allowlist.
function repoFor(gap) {
  return /allowlist|outside (?:support|quick read) scope|not allowed|closed to support reads/i.test(`${gap.title} ${gap.sig}`) ? "lakeside-ops" : "lakeside-code";
}

function planBuilder(data, { top = 5, date = new Date().toISOString().slice(0, 10), failures = [] } = {}) {
  const gaps = rank(data, top);
  if (!gaps.length) return null;
  const groups = {};
  for (const g of gaps) (groups[repoFor(g)] ||= []).push(g);
  // One worker, one repo: the repo with the most gaps (ties go to lakeside-code, where most read gaps live).
  const repo = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length || (a === "lakeside-code" ? -1 : 1))[0];
  const take = groups[repo], deferred = gaps.filter((g) => !take.includes(g));
  const lines = take.map((g) => `- Gap ${g.rank}${g.kanbanId ? `, board card ${g.kanbanId}` : ""}: ${g.title} [${g.sig}]. ${g.hits} hits, weighted ${g.weighted} (${g.lowHits} from tickets that went badly), ${g.tasks} tasks in 7 days.`);
  const prompt = [
    `# Keir weekly builder, ${date}`, "",
    `Keir, the support agent for A House Divided, keeps hitting these gaps in its read tools. Close as many as you safely can in this repository (${repo}) in ONE pull request: add the purpose-built read the tasks were missing, fix the argument shape that keeps failing, or allow the read for support tasks when the data is safe for players' ticket channels.`, "",
    "Gaps, ranked:", ...lines, "",
    ...(failures.length ? ["Keir's own most frequent reasoning and tool failures this week (context, fix what is in this repository if it is a tool or read gap; see the board for the rest):", ...failures.slice(0, 5).map((f) => `- ${f.class}/${f.kind}: ${String(f.title).slice(0, 140)} (${f.count} times, ${f.tickets} tickets)`), ""] : []),
    "Rules:",
    "- Work only in this worktree. Read the board card for each gap (ops-knowledge kanban_get) for the examples Keir collected.",
    "- Read-only capabilities only. Never add a write, never open access to account, sign-in, payment or contact data.",
    "- Add a focused test per change. Run only the focused tests and lint for files you touched. Do not run a full typecheck, full test suite or build.",
    "- Conventional commit messages, stage explicit files. Open a pull request against the default branch and stop. Do not merge, deploy or restart anything.",
    "- No em dashes or en dashes anywhere. Plain words in any text players could see.",
    "- If a gap cannot be closed safely, skip it and say why in the pull request description.",
    "- When done, write the pull request URL and one line per gap (built, allowlisted or skipped) to the last lines of your final message.", "",
    ...(deferred.length ? ["Not in this run (other repository): " + deferred.map((g) => g.title).join("; "), ""] : []),
  ].join("\n");
  const digest = `Keir builder ${date}: ${take.length} gap${take.length === 1 ? "" : "s"} sent to a worker in ${repo}${deferred.length ? `, ${deferred.length} left for the other repository` : ""}: ${take.map((g) => g.title).join("; ").slice(0, 300)}`;
  return { repo, repoPath: REPOS[repo], gaps: take, deferred, prompt, digest, cardId: take.find((g) => g.kanbanId)?.kanbanId || null };
}

module.exports = { planBuilder, repoFor, REPOS };
