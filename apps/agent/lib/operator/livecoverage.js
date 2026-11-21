"use strict";
// Keir 10.1.12 (ticket 1842): one merged change on a two-change ticket made "main" true for the whole ticket, so a
// live notice went out for a change that was still on its way and was corrected three minutes later. A ticket counts
// as live on main only when the releases that reached main cover every pull request the ticket has.
function mainCovered(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const prs = new Set();
  const shas = new Set();
  for (const j of list) {
    if (!j || ["cancelled", "dismissed"].includes(j.state)) continue;
    for (const p of j.pullRequests || []) if (p) prs.add(String(p));
    for (const [sha, r] of Object.entries(j.releaseEvidence || {})) if (r && r.main) shas.add(sha);
  }
  if (!shas.size) return false;
  return shas.size >= prs.size;
}
// Keir 10.5.2 (ticket 1859, 03:16): the task ran a "where" lookup on the change that fixed ticket 1857; the lookup
// left a main receipt on 1859, the card moved to "live", and the player was told their own unfixed bug was live.
// Keir 11.2 fifth pass (review 3, F1): a count of receipts is not proof either; a receipt for another number (a ticket
// number read as a PR, an older commit) covered a one-PR ticket by count. Code declares a ticket live only when every
// pull request the ticket's own records tie to its fix (opened by its jobs, or an approved merge of theirs) has a main
// receipt written for that exact PR and its merge commit. With no such PR, only a named developer change (dev-merges,
// recorded per ticket) counts. A number in wait text, a ticket number or a message is never a PR.
const repoName = (r) => String(r || "AHDGame").replace(/^.*\//, "");
const prRef = (u) => { const m = /github\.com\/[^/\s]+\/([^/\s]+)\/pull\/(\d+)\s*$/.exec(String(u || "")); return m ? `${m[1]}#${Number(m[2])}` : null; };
const LIVE_JOB = (j) => j && !["cancelled", "dismissed"].includes(j.state);
function mergeOf(a) {
  const x = a?.args || {}, inner = x.args || {};
  if (a?.kind === "github" && x.action === "merge" && Number(x.number)) return `${repoName(x.repository)}#${Number(x.number)}`;
  if (inner.action === "merge" && Number(inner.number)) return `${repoName(inner.repository)}#${Number(inner.number)}`;
  return null;
}
// "Repo#N" for every PR the given jobs own. actions: the ledger's actions (approved, executing or done merges count).
function ownedPrs(jobs, actions = []) {
  const list = (Array.isArray(jobs) ? jobs : []).filter(LIVE_JOB), ids = new Set(list.map((j) => j.id)), out = new Set();
  for (const j of list) for (const u of j.pullRequests || []) out.add(prRef(u) || `?${u}`);
  for (const a of actions || []) if (a && ids.has(a.jobId) && ["approved", "executing", "done"].includes(a.state) && mergeOf(a)) out.add(mergeOf(a));
  return out;
}
function jobOwnsPr(d, job, repo, n) {
  return ownedPrs([job], Object.values(d?.actions || {})).has(`${repoName(repo)}#${Number(n)}`);
}
function ownMainReceipt(jobs, actions = []) {
  const list = (Array.isArray(jobs) ? jobs : []).filter(LIVE_JOB);
  const owned = ownedPrs(list, actions);
  const receipts = list.flatMap((j) => Object.values(j.releaseEvidence || {})).filter((r) => r && r.main && r.source !== "lookup" && Number(r.pr) > 0);
  const have = new Set(receipts.map((r) => `${repoName(r.repository)}#${Number(r.pr)}`));
  if (!owned.size) return receipts.some((r) => r.source === "dev-merges");
  return [...owned].every((k) => have.has(k));
}
module.exports = { mainCovered, ownMainReceipt, ownedPrs, jobOwnsPr, prRef };
