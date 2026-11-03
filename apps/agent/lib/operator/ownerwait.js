"use strict";
const { GAME_REPO } = require("./github");
// Owner, 2026-11-03: when a developer's pull request is green except for the owner's own
// approval (custom-rules fails until the owner approves the exact head), Keir says so in
// the owner's Discord DMs. Four junior pull requests sat for hours behind one button
// nobody told the owner about. One DM per pull request head; a new push is a new head.
const READY = ["verify", "dependency-review"];

function latestByName(runs) {
  const out = new Map();
  for (const r of runs || []) {
    const prior = out.get(r.name);
    if (!prior || String(r.started_at || "") >= String(prior.started_at || "")) out.set(r.name, r);
  }
  return out;
}

function createOwnerWait({ ledger, api, ownerLogin = "Egg3901", now = () => Date.now(), log = () => {} }) {
  const d = ledger.data;
  async function tick() {
    d.ownerWait ||= {};
    const prs = await api([`repos/${GAME_REPO}/pulls?state=open&base=development&per_page=50`]);
    for (const pr of Array.isArray(prs) ? prs : []) {
      const head = pr.head?.sha, key = `${pr.number}:${head}`;
      if (!head || pr.draft || pr.user?.login === ownerLogin || d.ownerWait[key]) continue;
      const runs = latestByName((await api([`repos/${GAME_REPO}/commits/${head}/check-runs?per_page=100`]))?.check_runs);
      if (!READY.every((n) => runs.get(n)?.conclusion === "success")) continue;
      // Anything else red or still running means the author is not done; only the owner gate may be open.
      const others = [...runs.values()].filter((r) => r.name !== "custom-rules" && r.status === "completed" && !["success", "neutral", "skipped", "cancelled"].includes(r.conclusion));
      const running = [...runs.values()].some((r) => r.name !== "custom-rules" && r.status !== "completed");
      if (others.length || running || runs.get("custom-rules")?.conclusion === "success") continue;
      const full = await api([`repos/${GAME_REPO}/pulls/${pr.number}`]);
      if (full?.mergeable === false) continue; // a conflict needs the author first
      const reviews = await api([`repos/${GAME_REPO}/pulls/${pr.number}/reviews?per_page=100`]);
      if ((reviews || []).some((r) => r.user?.login === ownerLogin && r.state === "APPROVED" && r.commit_id === head)) continue;
      d.ownerWait[key] = { at: now() };
      ledger.notify(`ownerwait:${key}`, "owner",
        `Waiting on you: ${pr.user?.login || "a developer"}'s pull request #${pr.number} "${pr.title}" has passed every check except your approval. ` +
        `Open it, press Review changes, choose Approve and submit. Do not let anyone push to it afterwards, because a new push cancels the approval.\n${pr.html_url}`);
      log(`ownerwait: asked about #${pr.number} at ${head.slice(0, 8)}`);
    }
    for (const k of Object.keys(d.ownerWait)) if (now() - d.ownerWait[k].at > 14 * 86400000) delete d.ownerWait[k];
  }
  return { tick };
}
module.exports = { createOwnerWait, latestByName };
