"use strict";
const { JOB_TERMINAL } = require("./machines");
// Keir review sweep: the one tool a review task uses to close its item (lib/operator/reviewsweep.js).
//   resolve      close the Ask item this task was created for (POST /api/keir-ask/review/:kind/:id/resolve, shared secret)
//   lesson       one line into the ticket case file about what went wrong
//   wake_ticket  put one internal note in the live ticket task's inbox, through the same mechanism as 10.4's downvote loop
// A task can only touch the item it was created for: the Ask id, or the ticket, must match job.reviewItem. Nothing here
// posts to a player.

const WAKE_MS = 3600000;
const TERMINAL = new Set(JOB_TERMINAL);
const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);

function createReviewItemTool({ config = {}, fetcher = fetch, ledger, now = () => Date.now() }) {
  const base = String(config.askUrl || "").replace(/\/+$/, "");

  async function resolve(job, item, input, signal) {
    if (item.source !== "ask") throw new Error("this review item is a Keir item; resolve applies to Ask items");
    if (!base || !config.askSecret) return { resolved: false, note: "Ask is not configured on this host (KEIR_ASK_SECRET)." };
    const kind = String(input.kind || item.kind);
    if (kind !== item.kind || String(input.id || item.id) !== String(item.id)) throw new Error(`this task may only resolve ${item.kind} ${item.id}`);
    const body = { note: clip(input.note, 500) };
    if (kind === "doc_conflict") {
      if (input.outcome !== "dismissed" && input.outcome !== "fixed") throw new Error("outcome must be fixed or dismissed");
      // Keir 11.2: until its PR is merged and a deploy receipt shows it live, the item is "fix in review", not fixed; a PR
      // closed without merging reopens it (prtruth.js reviewFix).
      if (input.outcome === "fixed" && !job.reviewFixLive) {
        ledger.audit("review_fix_not_live", { job: job.id, item: item.key, pr: job.reviewFix?.pr || null, state: job.reviewFix?.state || null });
        throw new Error(job.reviewFix?.state === "reopened"
          ? `Not fixed: fix PR #${job.reviewFix.pr} was closed without merging, so this item is open again. Prepare a new fix or dismiss it with the reason.`
          : "Not fixed yet: this item is \"fix in review\" until its PR is merged and a deploy receipt shows it live. Call github where on your fix PR and wait for fixLive; leave the item open meanwhile.");
      }
      body.action = input.outcome;
    }
    else { if (!["good", "bad"].includes(input.verdict)) throw new Error("verdict must be good or bad"); body.verdict = input.verdict; }
    const res = await fetcher(`${base}/api/keir-ask/review/${kind}/${item.id}/resolve`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.askSecret}` }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });
    // Already closed by someone else counts as done.
    if (res.status === 404) return { resolved: true, already: true };
    if (!res.ok) throw new Error(`ask ${res.status}`);
    const out = await res.json().catch(() => ({}));
    if (kind === "doc_conflict" && input.outcome === "fixed") job.reviewFix = { ...(job.reviewFix || {}), pr: job.reviewFixLive?.number ?? job.reviewFix?.pr ?? null, state: "fixed", at: now() };
    ledger.audit("review_item_resolved", { job: job.id, item: item.key, status: out.status || null }); ledger.save();
    return { resolved: true, status: out.status || null };
  }

  function lesson(job, item, input) {
    const ticket = Number(input.ticket || item.ticket);
    if (!ticket || ticket !== Number(item.ticket)) throw new Error("a lesson goes on the ticket this review item is about");
    const lessons = require("./ticketcase").addLesson(ledger.data, ticket, input.text, now());
    if (!lessons) throw new Error("text must be a real one-line lesson (at least 8 characters)");
    ledger.audit("review_lesson", { job: job.id, ticket }); ledger.save();
    return { saved: true, ticket };
  }

  function wakeTicket(job, item, input) {
    const ticket = Number(input.ticket || item.ticket);
    if (!ticket || ticket !== Number(item.ticket)) throw new Error("only the ticket this review item is about can be woken");
    const d = ledger.data, at = now();
    const q = (d.reviewQueue ||= {}); q.wakes ||= {};
    if (at - (q.wakes[ticket] || 0) < WAKE_MS) return { woken: false, why: "this ticket was woken in the last hour" };
    const root = d.jobs?.[d.seen?.[`ticket:${ticket}`]] || Object.values(d.jobs || {}).find((j) => j && j.kind === "ticket" && j.ticket === ticket && !j.codingParent && !TERMINAL.has(j.state));
    if (!root || TERMINAL.has(root.state) || root.channelClosed) return { woken: false, why: "ticket not live" };
    q.wakes[ticket] = at;
    (root.inbox ||= []).push({ role: "system", authorId: "review-sweep", at: new Date(at).toISOString(), feedback: true,
      content: `Internal review of this ticket found an answer the player is still owed: ${clip(input.note, 400) || "re-read the Player asked items in the case file and answer the open one"}. Read the case file's lessons, then answer what the player asked, in their own words, before anything else.` });
    if (["waiting", "blocked", "queued"].includes(root.state)) { root.state = "queued"; root.wakeAt = at; delete root.recoveryReviewRequired; }
    root.updatedAt = at;
    ledger.audit("review_ticket_wake", { job: job.id, ticket, target: root.id }); ledger.save();
    return { woken: true, ticket };
  }

  async function call(job, input = {}, signal) {
    const item = job.reviewItem;
    if (!item) throw new Error("review_item is only for review tasks");
    const action = String(input.action || "");
    if (action === "resolve") return resolve(job, item, input, signal);
    if (action === "lesson") return lesson(job, item, input);
    if (action === "wake_ticket") return wakeTicket(job, item, input);
    throw new Error("action must be resolve, lesson or wake_ticket");
  }
  return { call };
}

module.exports = { createReviewItemTool };
