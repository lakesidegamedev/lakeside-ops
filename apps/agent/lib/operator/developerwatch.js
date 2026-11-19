"use strict";
const { JOB_TERMINAL } = require("./machines");
// A filed question is not an accepted handoff. Track the queue receipt until
// somebody owns it, and wake the originating task on progress or a missed SLA.
// These observations never grant execution authority or resolve a ticket.
const ACK_MS = 30 * 60000, PROGRESS_MS = 2 * 3600000, POLL_MS = 5 * 60000;
const pendingHandoffs = (job) => (job.raisedToDevelopers || []).filter((r) => r.blocking && r.id && !r.releasedAt && !r.selfOwned);
// Keir 5.6.2: an unaccepted handoff gets one overdue wake (do it yourself),
// then parks for the owner's morning brief. Overnight 2026-10-16 tasks polled
// unclaimed cards for six hours, and woke on their own progress notes.
const parkedOnHandoffs = (job) => { const p = pendingHandoffs(job); return p.length > 0 && p.every((r) => r.watch?.parkedAt && !r.watch?.acceptedAt); };
const KEIR_ACTORS = new Set(["keir", "keir-operator"]);
const timestamp = (value) => typeof value === "number" ? value : Date.parse(value) || 0;

function createDeveloperWatch({ ledger, mcp, now = () => Date.now(), held = () => false, log = () => {} }) {
  const d = ledger.data;
  function tell(job, r, key, content, alert = false) {
    const w = (r.watch ||= {});
    if ((w.delivered ||= []).includes(key)) return;
    w.delivered = [...w.delivered, key].slice(-20);
    (job.inbox ||= []).push({ authorId: "developer-watch", role: "system", at: new Date(now()).toISOString(), content });
    if (["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
    if (alert) ledger.notify(`recovery:developer-handoff:${job.id}:${r.id}:${key}`, "owner", content);
    ledger.audit("developer_handoff_wake", { job: job.id, item: r.id, reason: key, alert });
  }
  async function tick() {
    if (d.paused) return;
    const reads = new Map();
    let count = 0;
    for (const job of Object.values(d.jobs)) {
      // Keir's own cards (5.6): never chase them as someone else's handoff.
      // Close them on Keir's board when the task that owns them ends.
      for (const r of (job.raisedToDevelopers || []).filter((x) => x.selfOwned && !x.releasedAt)) {
        const ended = JOB_TERMINAL.includes(job.state) || job.resolved || job.channelClosed;
        if (!ended) continue;
        if (count++ >= 5) { ledger.save(); return; }
        try {
          await mcp.call("ops-knowledge", "work_report", { id: r.id, event: "completed", actor: "keir", summary: String(job.summary || "Task finished.").slice(0, 1500), idempotency_key: `keir-self:${r.id}:${job.id}` }, true);
          r.releasedAt = now(); ledger.audit("developer_handoff_self_closed", { job: job.id, item: r.id });
        } catch (e) { log(`self-owned card ${r.id}: ${String(e.message).slice(0, 200)}`); }
      }
      if (["done", "dismissed", "cancelled", "deferred"].includes(job.state) || job.resolved || job.channelClosed || held(job) ||
        Object.values(job.effects || {}).some((e) => e.state === "started")) continue;
      // Old ledgers identify a blocking question by its explicit reply wait.
      // Do not infer blocking work from arbitrary historical issue filings.
      if (job.waitingFor?.kind === "developer_reply") for (const r of job.raisedToDevelopers || []) {
        if (r.blocking === undefined && r.kind === undefined && r.id) r.blocking = true;
      }
      for (const r of pendingHandoffs(job)) {
        const w = (r.watch ||= {});
        if (w.checkedAt != null && now() - w.checkedAt < POLL_MS) continue;
        if (count++ >= 5) { ledger.save(); return; }
        w.checkedAt = now();
        let item;
        try {
          if (!reads.has(r.id)) reads.set(r.id, mcp.call("ops-knowledge", "kanban_get", { id: r.id }, false));
          item = await reads.get(r.id);
          if (!item || Number(item.id) !== Number(r.id)) throw new Error("developer queue returned no matching item");
          w.errors = 0; delete w.errorSince;
        } catch (e) {
          if (!w.errors) w.errorSince = now();
          w.errors = (w.errors || 0) + 1;
          log(`developer handoff ${r.id}: ${String(e.message).slice(0, 200)}`);
          if (w.errors >= 3) tell(job, r, `unreadable:${w.errorSince}`, `Developer handoff #${r.id} could not be read three times. Inspect its receipt and route the work; do not claim it was accepted or resolved.`, true);
          continue;
        }
        const progressAt = timestamp(item.last_progress_at);
        const summary = String(item.progress_summary || "").trim().replace(/\s+/g, " ").toLowerCase();
        const version = JSON.stringify([item.lane, item.assigned_to || null, summary, item.evidence_url || null]);
        const changed = w.version !== version;
        // Keir's own notes on the card are not a developer's progress.
        const selfEdit = changed && KEIR_ACTORS.has(String(item.events?.[0]?.actor || "").toLowerCase()) && !item.assigned_to;
        if (changed) {
          if (!selfEdit) w.meaningfulAt = w.version ? now() : Math.max(r.at, Math.min(now(), progressAt));
          w.version = version; w.changedAt = now();
        }
        if (item.lane === "done") {
          if (item.evidence_url) {
            r.releasedAt = now();
            tell(job, r, `completed:${version}`, `Developer handoff #${r.id} is marked complete with evidence: ${item.evidence_url}. Re-read the result and verify the actual outcome and deployment before resolving the original problem.`);
          } else {
            // A closed card is no longer pending, evidence or not. Keeping it
            // pending re-woke the task and paged the owner on every card edit,
            // and nobody adds evidence to a closed card.
            r.releasedAt = now();
            tell(job, r, "no-evidence", `Developer handoff #${r.id} was closed without evidence. It is no longer pending. Verify the outcome yourself with your own tools. If you cannot, tell the requester plainly what is still unknown and finish. Do not raise the same request to developers again.`, true);
          }
          continue;
        }
        const accepted = item.lane === "now" && Boolean(item.assigned_to) && progressAt >= r.at;
        if (accepted && !w.acceptedAt) {
          w.acceptedAt = now();
          tell(job, r, `accepted:${version}`, `Developer handoff #${r.id} was accepted by ${item.assigned_to}. It is still in progress; filing or acceptance alone is not a verified resolution.`);
        } else if (changed && !selfEdit && w.lastProgressAt != null) {
          tell(job, r, `progress:${version}`, `Developer handoff #${r.id} has new progress. Read its current result before choosing the next step.`);
        }
        w.lastProgressAt = progressAt;
        const baseline = accepted ? Math.max(r.at, w.meaningfulAt) : r.at;
        const budget = accepted ? PROGRESS_MS : ACK_MS;
        // One alert per stage, not one per card edit: a re-planning task that
        // rewrote the card used to page the owner every few minutes (5.6).
        if (now() - baseline >= budget) {
          tell(job, r, `overdue:${accepted ? "progress" : "ack"}`, `Developer handoff #${r.id} ${accepted ? "has had no progress for two hours" : "has not been accepted within thirty minutes"}. Do not wait on it. If it asked for game records, read them yourself with the heal-ops read tools (heal_query, heal_count). Otherwise tell the player plainly what is still unknown and continue with what you can verify. Do not file a duplicate or finish merely because the item exists. If you still cannot advance it, finish waiting: the item is parked for the owner's morning brief, and only a developer's progress or a player message wakes you.`, true);
          if (!accepted && !w.parkedAt) { w.parkedAt = now(); ledger.audit("developer_handoff_parked", { job: job.id, item: r.id }); }
        }
      }
    }
    ledger.save();
  }
  return { tick };
}
module.exports = { createDeveloperWatch, pendingHandoffs, parkedOnHandoffs, ACK_MS, PROGRESS_MS, POLL_MS };
