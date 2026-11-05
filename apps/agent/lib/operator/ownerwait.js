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

function createOwnerWait({ ledger, api, ownerLogin = "Egg3901", now = () => Date.now(), log = () => {}, drain = () => {} }) {
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
      // Owner, 2026-11-05: "We literally have approval buttons built in." A link to GitHub meant opening
      // the app and reviewing there. Keir reads the change and asks through the approval card instead;
      // the Approve button submits the owner's review at this exact head and merges.
      // Not an owner message: the task has no owner authority of its own, so only the button approves.
      ledger.createJob(`ownerwait:${key}`, { kind: "command", role: "support", internalProbe: true, repository: "AHDGame", ownerWaitPr: pr.number, deadline: now() + 6 * 3600000,
        source: { at: new Date(now()).toISOString(), content: `Developer pull request ${pr.number} ("${pr.title}" by ${pr.user?.login || "a developer"}) has passed every check except the owner's approving review, at head ${head}. Read the change (github pr ${pr.number}), then call github merge for it. That sends the owner an approval card with your plain-language explanation; his Approve submits his review and merges. Do not send him a GitHub link, do not post in any channel, and do not push to the branch.` } });
      drain();
      log(`ownerwait: asked about #${pr.number} at ${head.slice(0, 8)}`);
    }
    for (const k of Object.keys(d.ownerWait)) if (now() - d.ownerWait[k].at > 14 * 86400000) delete d.ownerWait[k];
  }
  return { tick };
}
module.exports = { createOwnerWait, latestByName };
