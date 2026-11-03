"use strict";
// After a Keir release, retry the owner's own recent requests that ended blocked, once per
// release: the blocker is often a missing tool the release just added. The owner's public
// tax report (2026-11-03) stayed unpublished after publish_report shipped, because nothing
// re-ran the blocked task.
const DAY = 86400000;
function retryBlockedOwnerWork(data, { ownerId, releaseId, now = Date.now() }) {
  if (!releaseId) return [];
  const retried = [];
  for (const job of Object.values(data.jobs || {})) {
    if (job.state !== "blocked" || job.kind !== "command" || job.role !== "owner" || job.actorId !== ownerId) continue;
    if (job.retriedRelease === releaseId || now - (job.updatedAt || job.startedAt || 0) > DAY) continue;
    if (job.ownerDecisionPending || Object.values(data.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending")) continue;
    job.retriedRelease = releaseId; job.state = "queued"; job.wakeAt = 0;
    (job.inbox ||= []).push({ role: "system", authorId: "release-retry", at: new Date(now).toISOString(),
      content: `Keir was updated (release ${String(releaseId).slice(0, 12)}). Your earlier blocker may be resolved: retry the remaining step once, then finish. If it is still blocked, say so in one line.` });
    retried.push(job.id);
  }
  return retried;
}
module.exports = { retryBlockedOwnerWork };
