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
// A lookup receipt answers the model's question; only a receipt from the ticket's own pull request, a merge this
// ticket owns or a linked developer change may move a card or send a live notice by itself.
function ownMainReceipt(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  return mainCovered(list) && list.some((j) => j && !["cancelled", "dismissed"].includes(j.state)
    && Object.values(j.releaseEvidence || {}).some((r) => r && r.main && r.source !== "lookup"));
}
module.exports = { mainCovered, ownMainReceipt };
