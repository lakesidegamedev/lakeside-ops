"use strict";
// Keir's job lifecycle: the scheduling rules that decide when a job runs, waits,
// is held, ends or is adopted. operator.js drain() and scan() call these; they
// were inline there and moved here unchanged. Pure over (data, job, context):
// they mutate the job they are given and return what the caller must record
// (audit rows, owner notices) instead of reaching for the ledger or the clock.
//
// STATES (job.state)
//   queued     ready; admission (admission.js, lanes.js) may start it
//   running    an activation is in flight (set by agent.run, never here)
//   waiting    parked until job.wakeAt, or until a message lands in job.inbox
//   blocked    held for a person: an owner decision, a stalled close, an expired
//              deadline, a failed run, or an uncertain external write
//   deferred   staff claimed the ticket; automatic work is off
//   paused     the owner paused the ticket (ticketpause.js); only a resume leaves it
//   done / cancelled / dismissed   terminal
//
// TRANSITIONS, in the order wakeStep() tries them for each job on every drain
// (every pass, "continue" meaning the later rules are skipped for that job):
//   1. staff claim            any live non-owner ticket job            -> deferred, stop
//   2. owner decision pending live non-owner ticket job, no human msg  -> blocked, stop
//                             with a human message in the inbox        -> blocked, go on
//   3. resolution stall       resolutionSubmitted, not resolved, not done/cancelled/blocked
//                             older than 20 min -> blocked + owner notice, else -> waiting; stop
//   4. dead-end sweep         blocked probe/benchmark > 1 h, or blocked subworker whose
//                             report reached its parent > 30 min     -> dismissed, stop
//   5. directive held         owner directive on the ticket (broker)  -> nothing else runs
//   6. wake                   waiting and (wakeAt reached, or inbox has mail and no
//                             debounceWake)                           -> queued
//                             blocked with mail, no owner decision, not a subworker or
//                             probe, channel open                     -> queued
//                             blocked on an owner decision, ticket, channel open, human
//                             message waiting                         -> queued
//   7. deadline               past job.deadline: first time extended (a waiting job is
//                             queued), second time -> blocked + owner notice
// Run end (onRunError): abort for a pause -> paused; abort for a stop, hold or claim
//   with no write started -> waiting; transient or provider failure -> waiting (see
//   recovery.js); anything else -> blocked + owner notice.
// Scan: a ticket whose channel Discord reports gone (404) -> done; a ticket with no
//   channel whose support record is closed -> done; an open ticket channel with no
//   task -> a new queued ticket job (adoption).
//
// WAKE REASONS: wakeAt reached; a message in the inbox; deadline extension; an
//   owner resume (ticketpause.js); a stall or retry timer from recovery.js.
// HOLDS, strongest first inside wakeStep: staff claim, owner decision (conversation
//   still wakes it), resolution stall, directive. Admission adds its own holds after
//   this (staff active, support deferred, owner pause) in admission.js / operator.js.

const TERMINAL = ["done", "cancelled", "dismissed"];

const humanInbox = (j) => (j.inbox || []).some((m) => m.role !== "system" && !/^(developer-watch|system|engineering-followup)$/.test(String(m.authorId || "")));

const audit = (kind, detail) => ({ type: "audit", kind, detail });
const notify = (key, destination, content) => ({ type: "notify", key, destination, content });

// Record what a rule asked for, in order.
function applyEffects(ledger, effects) {
  for (const e of effects || []) {
    if (e.type === "audit") ledger.audit(e.kind, e.detail);
    else if (e.type === "notify") ledger.notify(e.key, e.destination, e.content);
  }
}

// One job's pass through the wake rules. ctx: { now, config: { taskLifetimeMs },
// claimedBy(channelId), directiveHeld(job) }. Returns the effects to record.
function wakeStep(j, ctx) {
  const { now } = ctx, effects = [];
  if (j.role !== "owner" && !["command", "conversation"].includes(j.kind) && j.ticket && !["done", "cancelled"].includes(j.state)) {
    if (ctx.claimedBy(j.channelId)) { j.state = "deferred"; j.summary = "Staff owns this ticket; automatic work is deferred."; return effects; }
    // A player or staff message still reaches the conversation wake below:
    // a ticket held on an owner decision must still answer its player.
    if (j.ownerDecisionPending && !(j.kind === "ticket" && !j.channelClosed && humanInbox(j))) { j.state = "blocked"; j.summary = "The existing coordinator recorded an outstanding owner decision; automatic changes and closure are held."; return effects; }
    if (j.ownerDecisionPending) j.state = "blocked";
  }
  if (j.resolutionSubmitted && !j.resolved && !["done", "cancelled", "blocked"].includes(j.state)) {
    if (now - j.resolutionSubmittedAt > 20 * 60000) {
      j.state = "blocked"; j.summary = "Resolution is recorded, but the bot has not closed the ticket channel after 20 minutes. Inspect receipt delivery.";
      effects.push(notify(`close-stalled:${j.id}`, "owner", `Ticket ${j.ticket}: ${j.summary}`));
    } else { j.state = "waiting"; }
    return effects;
  }
  // Keir clears its own dead ends. A blocked probe or benchmark run is dismissed
  // after an hour; a blocked subworker whose report already reached its parent
  // is dismissed after half an hour.
  if (j.state === "blocked" && (((j.internalProbe || j.kind === "probe") && now - (j.updatedAt || 0) > 3600000) || (j.codingParent && j.codingReported && now - (j.updatedAt || 0) > 30 * 60000))) {
    j.state = "dismissed"; j.summary = `Dismissed automatically: ${j.codingParent ? "its report already reached the parent task" : "a probe or benchmark left blocked"}. Was: ${String(j.summary || "").slice(0, 300)}`;
    effects.push(audit("job_dismissed", { job: j.id, by: "keir", reason: j.codingParent ? "subworker_reported" : "probe_blocked" }));
    return effects;
  }
  if (ctx.directiveHeld(j)) return effects;
  if (j.state === "waiting" && (j.wakeAt <= now || (j.inbox?.length && !j.debounceWake))) { j.state = "queued"; delete j.debounceWake; }
  // A message that arrived while the task was running (a handoff, a staff
  // note) is still unread when that run settles as blocked; it must wake the
  // task rather than wait for a human.
  else if (j.state === "blocked" && j.inbox?.length && !j.ownerDecisionPending && !j.codingParent && !j.internalProbe && !j.channelClosed) { j.state = "queued"; effects.push(audit("requeued_for_inbox", { job: j.id, ticket: j.ticket || null, messages: j.inbox.length })); }
  // An open owner decision holds writes and closure, never the conversation.
  else if (j.state === "blocked" && j.ownerDecisionPending && j.kind === "ticket" && !j.channelClosed && humanInbox(j)) { j.state = "queued"; effects.push(audit("requeued_for_conversation", { job: j.id, ticket: j.ticket || null })); }
  const expiry = require("./deadline").expireDeadline(j, now, { lifetimeMs: ctx.config.taskLifetimeMs });
  if (expiry === "extended") effects.push(audit("deadline_extended", { job: j.id, ticket: j.ticket || null, until: j.deadline }));
  else if (expiry === "blocked") effects.push(notify(`deadline:${j.id}`, "owner", `Task ${j.id}: ${j.summary}`));
  return effects;
}

// What happens to a job when its activation throws or is aborted. ctx: { now,
// aborted, stopping, paused, startedAt, supportDeferred(job), staffHeld(job),
// claimedBy(channelId), pauseFor(job), staffActiveUntil(job), redact(text) }.
// Returns null when the run already settled the job (nothing to record or save),
// else { effects } and the caller saves.
function onRunError(job, e, ctx) {
  // A self-recovery park sets "waiting" or "blocked" before aborting: not an error.
  if (["done", "cancelled", "queued", "paused"].includes(job.state) || (["waiting", "blocked"].includes(job.state) && /^Self-recovery:/.test(job.summary || ""))) return null;
  const effects = [];
  // Only a write this activation started makes an abort uncertain; an older
  // unsettled receipt is effect recovery's job.
  const startedHere = Object.values(job.effects).some((x) => x.state === "started" && (x.at || 0) >= ctx.startedAt);
  if (ctx.aborted && ctx.pauseFor(job)) { job.state = "paused"; delete job.wakeAt; }
  // A stop counts even when the abort arrived as the CLI child dying
  // before the grace period aborted the controller.
  else if ((ctx.aborted || ctx.stopping) && (ctx.paused || ctx.supportDeferred(job) || ctx.stopping || ctx.staffHeld(job) || (job.kind === "ticket" && job.role !== "owner" && ctx.claimedBy(job.channelId))) && !startedHere) { job.state = "waiting"; job.wakeAt = Math.max(ctx.now + 60000, ctx.staffActiveUntil(job)); }
  else if (require("./recovery").retryReadFailure(job, e, ctx.now)) {
    effects.push(audit("transient_retry", { job: job.id, attempt: job.transientFailures, emptyWaits: job.emptyWaits }));
    // One owner alert an hour while the provider answers with nothing.
    if (/^model request failed: empty activation/.test(e.message)) effects.push(notify(`empty-provider:${Math.floor(ctx.now / 3600000)}`, "owner", `The model provider is returning empty replies (task ${job.id}). Tasks retry every 15 minutes; check the provider login or quota.`));
  }
  else {
    job.state = "blocked"; job.summary = ctx.redact(e.message);
    effects.push(notify(`error:${job.id}:${job.rounds}`, "owner", `Task ${job.id} stopped: ${job.summary}`));
    if (job.kind === "command" && job.replyChannel) effects.push(notify(`error-reply:${job.id}:${job.rounds}`, `channel:${job.id}`, "I hit an error and stopped on this one. Ask again and I'll pick it back up."));
  }
  return { effects };
}

// Scan sweep for one ticket job whose channel is not in the guild list. ctx:
// { liveChannels:Set, readTicket(number), channelGone(channelId) -> true only on
// Discord 404 }. Returns { closed, effects }; when closed the caller aborts any
// activation running on the job.
async function sweepClosedChannel(job, ctx) {
  const none = { closed: false, effects: [] };
  if (!(job.ticket && !ctx.liveChannels.has(job.channelId) && !["done", "cancelled"].includes(job.state))) return none;
  // A ticket adopted from a handoff after its channel was already gone has no
  // channel id, so the Discord check can never return 404. Ask the support record.
  if (!job.channelId) {
    if (!(await require("./channellesstickets").closeIfTicketClosed(job, ctx.readTicket))) return none;
    return { closed: true, effects: [audit("ticket_closed_without_channel", { job: job.id, ticket: job.ticket })] };
  }
  // The guild list is read once at the start of the scan; a channel created
  // since is missing from it without being closed. Only Discord saying the
  // channel is gone closes it.
  if (!(await ctx.channelGone(job.channelId))) return none;
  job.state = "done"; job.channelClosed = true; job.summary = "Ticket channel was closed externally; stopped work.";
  if (job.resolutionSubmitted) {
    job.resolved = true; job.summary = "Resolution receipt recorded and ticket-channel closure verified.";
    // Verified closure is routine; no owner DM.
  }
  return { closed: true, effects: [] };
}

// A live ticket channel in the guild list that has no owner. ctx: { ledger,
// config, now, ticketNumber(name), adoptReopened(number, channel), log(text) }.
async function adoptOpenChannel(ch, ctx) {
  const { ledger, config } = ctx, d = ledger.data;
  const n = ctx.ticketNumber(ch.name);
  if (!n || (["moderation", "incident"].includes(d.channels[ch.id]?.category) && !d.channels[ch.id]?.ownerDirectedAt) || d.channels[ch.id]?.claimedBy) return;
  const known = d.jobs[d.seen[`ticket:${n}`]];
  if (known?.channelClosed && known.channelId !== ch.id) {
    try { await ctx.adoptReopened(n, ch); } catch (e) { ctx.log(`reopened ticket ${n}: ${e.message}`); }
  }
  // A ticket adopted from a handoff before its channel was seen gets it now.
  if (known && (!known.channelId || (!known.replyChannel && known.channelId === ch.id))) {
    known.channelId ||= ch.id;
    known.replyChannel ||= ch.id;
    known.source = { ...known.source, channelId: ch.id, channelName: ch.name };
    ledger.save();
  }
  if (d.seen[`ticket:${n}`]) return;
  // A live task already working this channel may not be filed under the ticket number
  // yet (intake keys it by message first). Adopting again ran two tasks on one ticket;
  // register the existing one instead.
  const holder = require("./channellesstickets").liveTaskForChannel(d.jobs, ch.id);
  if (holder) { d.seen[`ticket:${n}`] = holder.id; ledger.save(); return; }
  const job = ledger.createJob(`ticket:${n}`, { kind: "ticket", role: "support", ticket: n, channelId: ch.id, source: { content: `Open ticket channel #${ch.name} with no Keir task; adopted by the sweep. Read its history and pick it up.`, channelId: ch.id, at: new Date(ctx.now).toISOString() }, deadline: ctx.now + config.taskLifetimeMs });
  ledger.audit("ticket_adopted_by_sweep", { job: job.id, ticket: n }); ledger.save();
}

// First sight of a ticket channel: a newly opened ticket with only the bot's
// intake card gets a support job. `staff` is the adopted claim, if any.
function adoptFromIntake(ledger, ch, rows, { staff, category, number, config, now }) {
  const d = ledger.data;
  if (staff || d.channels[ch.id]?.claimedBy || category === "moderation" || category === "incident" || d.seen[`ticket:${number}`]) return null;
  const card = rows.find((m) => m.author.id === config.botId && m.embeds?.length);
  if (!card) return null;
  const job = ledger.createJob(`ticket:${number}`, { kind: "ticket", role: "support", ticket: number, channelId: ch.id,
    source: { channelId: ch.id, channelName: ch.name, content: "New ticket intake; read support_get and ticket_history before acting.", at: card.timestamp }, deadline: now + config.taskLifetimeMs });
  job.summary = "New ticket needs investigation.";
  return job;
}

module.exports = { TERMINAL, humanInbox, applyEffects, wakeStep, onRunError, sweepClosedChannel, adoptOpenChannel, adoptFromIntake };
