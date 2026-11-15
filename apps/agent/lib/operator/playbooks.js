"use strict";
// Ticket playbooks (2026-10-19): one checklist per kind of ticket, computed
// from state the broker already records, so every model works a ticket the
// same way. Each activation sees its playbook (where it stands and the next
// step); finishing a ticket done is refused while a required step is open.
// Steps read only broker-recorded facts, never the model's own claims.

const step = (id, label, done, required = true) => ({ id, label, done: Boolean(done), required });

// What the broker knows about this ticket's work so far.
function facts(job, d) {
  const card = d.statusCards?.[job.ticket]?.items || [];
  const jobs = Object.values(d.jobs || {}).filter((j) => j.id === job.id || j.codingParent === job.id);
  return {
    posted: (job.lastAskAt || 0) > 0,
    answeredSincePlayer: (job.lastAskAt || 0) >= (job.lastPlayerAt || 0) && (job.lastAskAt || 0) > 0,
    reads: jobs.reduce((n, j) => n + (j.investigatedReads || 0), 0),
    reporter: Boolean(job.reporterCharacter?.id || job.reporterCharacter?.name),
    raised: (job.raisedToDevelopers || []).length > 0,
    pr: (job.pullRequests || []).length > 0,
    merged: Boolean(job.mergedInto),
    answeredCard: card.some((i) => i.stage === "answered"),
    liveCard: card.length > 0 && card.every((i) => ["main", "confirmed", "answered"].includes(i.stage)),
    heal: Object.values(d.actions || {}).some((a) => a.jobId === job.id),
    suggestion: Boolean(job.suggestionOpened || job.suggestions?.length),
    adviceRedirect: Boolean(job.adviceRedirectedAt && job.adviceRedirectedAt >= (job.lastPlayerAt || 0)),
  };
}

// The kind comes from intake tagging, then the channel category.
function kindOf(job, d) {
  const tag = job.tags?.kind, cat = d.channels?.[job.channelId]?.category;
  if (require("./advicerouting").bugFollowup(job)) return "bug_report";
  if (require("./advicerouting").requiresRedirect(job, d)) return "gameplay_advice";
  if (job.incidentCandidates?.length && tag !== "mechanics_question") return "incident_candidate";
  if (["bug_report", "mechanics_question", "data_repair", "design_feedback", "feature_request"].includes(tag)) return tag;
  if (cat === "mechanics" || cat === "gameplay") return "mechanics_question";
  if (cat === "bug") return "bug_report";
  return null;
}

const PLAYBOOKS = {
  bug_report: (f) => [
    step("read_reporter", "Read the reporter's live records (character, corporation, sector) before saying anything about cause", f.reporter && f.reads >= 1),
    step("find_cause", "Find the cause from live data and the deployed code (at least three investigative reads)", f.reads >= 3),
    step("route", "Route it: attach to or file the GitHub issue (raise_to_developers), merge into an open incident, open a fix, or mark the card answered when nothing is broken", f.raised || f.merged || f.pr || f.answeredCard),
    step("tell_player", "Tell the player the cause in plain words and where the fix stands, after their last message", f.answeredSincePlayer),
  ],
  data_repair: (f) => [
    step("read_reporter", "Read the reporter's live records", f.reporter && f.reads >= 1),
    step("verify_loss", "Verify the loss from the ledger or history (trace_account, character history); never take the player's number on trust", f.reads >= 3),
    step("route", "Propose the repair with request_heal (the owner approves it) and raise the code bug that caused it; never promise money", f.heal || f.raised || f.merged || f.answeredCard),
    step("tell_player", "Tell the player what was verified and that the repair is with the developers, after their last message", f.answeredSincePlayer),
  ],
  gameplay_advice: (f) => [
    step("redirect", `Send the short Ask redirect (${require("./advicerouting").URL}); do not research investments or create a progress card`, f.adviceRedirect),
    step("route_if_bug", "Retain any separately verified broken screen, wrong figures or missing transaction as bug work", true, false),
  ],
  mechanics_question: (f) => [
    step("check_rule", "Check the rule in game knowledge and the code, and the player's live numbers", f.reads >= 2),
    step("answer", "Answer directly in the channel (no progress card), after their last message", f.answeredSincePlayer),
    step("route_if_bug", "If it turned out to be a bug, raise it", true, false),
  ],
  design_feedback: (f) => [
    step("explain", "Explain how the rule works now, from knowledge or code", f.reads >= 1),
    step("record", "Record the idea for the developers (open_suggestion) when it is a real proposal", f.suggestion || f.raised, false),
    step("answer", "Reply to the player, after their last message", f.answeredSincePlayer),
  ],
  feature_request: (f) => [
    step("check_exists", "Check it does not exist already (knowledge, code)", f.reads >= 1),
    step("record", "Record it for the developers (open_suggestion or raise_to_developers kind enhancement)", f.suggestion || f.raised),
    step("answer", "Reply to the player, after their last message", f.answeredSincePlayer),
  ],
  incident_candidate: (f) => [
    step("confirm_same", "Confirm it is the same problem as the open incident from the reporter's own records", f.reads >= 1),
    step("merge_or_route", "Merge into the incident, or route it as its own bug if it differs", f.merged || f.raised || f.pr || f.answeredCard),
    step("answer", "Tell the player (a merge moves them to the incident channel)", f.merged || f.answeredSincePlayer),
  ],
};

// Keir 10 lanes (ticketlanes.js). The lane, once routed, picks the playbook; the
// older kind-from-tags path stays for jobs that were never routed.
Object.assign(PLAYBOOKS, {
  // The question lane ends when every question is answered; no card, no owner decision.
  question: (f) => [
    step("check_rule", "Check the rule in game knowledge and the code, and the player's live numbers", f.reads >= 2),
    step("answer", "Answer every question the player asked, directly in the channel (no progress card), after their last message", f.answeredSincePlayer),
    step("spin_out", "If a real defect or an unrelated new problem turned up, spin it out: raise the bug or open a separate ticket with open_ticket; do not widen this one", true, false),
  ],
  // An outage is one incident: read the live turn state, attach, tell. No reporter records.
  outage: (f) => [
    step("read_live", "Read the live turn state (turndiag lock_status, engine recent_turns) before saying anything about cause", f.reads >= 1),
    step("attach", "Attach it to the open incident or raise it once as one outage; never open a second report for the same outage", f.merged || f.raised || f.pr || f.answeredCard),
    step("tell_player", "Tell the player what is known and when they will hear next, after their last message", f.merged || f.answeredSincePlayer),
  ],
  people: (f) => [
    step("check_record", "Read the support record and the account facts the case turns on; never decide a ban or an appeal yourself", f.reads >= 1),
    step("route", "Send what needs staff to staff (support_action or raise_to_developers); do what the broker allows and nothing more", f.raised || f.answeredCard || f.heal, false),
    step("answer", "Tell the player the outcome or the next step in plain words, after their last message", f.answeredSincePlayer),
  ],
  idea: (f) => [
    step("explain", "Explain how the rule works now, from knowledge or code", f.reads >= 1),
    step("record", "Record the idea for the developers (open_suggestion) when it is a real proposal", f.suggestion || f.raised, false),
    step("answer", "Reply to the player, after their last message", f.answeredSincePlayer),
  ],
});
// Lane -> the playbook key it follows.
const LANE_PLAYBOOK = { question: "question", bug: "bug_report", data_repair: "data_repair", outage: "outage", people: "people", idea: "idea", advice: "gameplay_advice" };

function playbookFor(job, d) {
  if (job.kind !== "ticket" || !job.ticket || job.codingParent || job.role === "player") return null;
  const kind = (job.lane && !job.laneDefaulted && LANE_PLAYBOOK[job.lane]) || kindOf(job, d);
  if (!kind) return null;
  const steps = PLAYBOOKS[kind](facts(job, d));
  const next = steps.find((s) => s.required && !s.done) || null;
  return { kind, lane: job.lane || null, steps, next: next ? next.id : null, complete: !next };
}

// For the activation context: compact, ordered, with the next step named.
function contextFor(job, d) {
  const p = playbookFor(job, d);
  if (!p) return undefined;
  const lanes = require("./ticketlanes");
  return { kind: p.kind, lane: p.lane || undefined, exit: lanes.LANES[p.lane]?.exit, steps: p.steps.map((s) => `${s.done ? "[x]" : "[ ]"} ${s.label}${s.required ? "" : " (if it applies)"}`), next: p.next ? p.steps.find((s) => s.id === p.next).label : "All required steps are done: finish when the player has what they need.",
    instruction: "Work the ticket in this order. Steps are checked from what the broker recorded, not from your summary." };
}

// Finishing done is refused while a required step is open (developer and owner tickets are exempt).
function finishRefusal(job, d, state) {
  if (state !== "done") return null;
  const p = playbookFor(job, d);
  if (!p || p.complete) return null;
  const s = p.steps.find((x) => x.id === p.next);
  return `Not finished: this ${p.kind.replace(/_/g, " ")} still needs: ${s.label}. Do that step, then finish. If the ticket genuinely cannot get there (the player left, staff took it over), finish waiting or blocked and say why.`;
}

module.exports = { playbookFor, contextFor, finishRefusal, kindOf, PLAYBOOKS, LANE_PLAYBOOK, facts };
