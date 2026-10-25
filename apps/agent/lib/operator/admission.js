"use strict";
// Keir 3.0 fast-lane admission. Conversation capacity is reserved and can
// never be consumed by investigation or coding, so a long fix cannot
// monopolize replies. The owner has a reserved slot too, so a correction or
// command never waits behind ticket work. Within each class, aging
// guarantees a starvation bound: priority helps, but any queued item older
// than maxWaitMs outranks everything else in its class. Ordering is a pure
// function of the queue, which makes the queue position an ack quotes true.
//
// Admission also carries the rules drain() and scheduling.nextJob enforce in
// 2.x, so it can replace them without dropping live behavior:
// - support deferral: while the ticket supervisor owns support, non-owner
//   ticket and candidate work is held (another operator owns those tickets)
// - staff claims, an outstanding owner decision, closure grace and an
//   expired deadline hold work; hold() names the reason, the coordinator
//   applies the state change
// - one attempt per work record: a record with running work, or already
//   admitted this pass, is not admitted twice
// - the service budget: the sum of all slots never exceeds the sum of the dedicated capacities
// - one investigation slot prefers support tickets when any are ready

const { workIdForJob, rootJob } = require("./workrecord");

const CLASSES = {
  conversation: { capacity: 2, maxWaitMs: 30000, timeoutMs: 90000 },
  owner: { capacity: 1, maxWaitMs: 60000, timeoutMs: 15 * 60000 },
  investigation: { capacity: 3, maxWaitMs: 15 * 60000, timeoutMs: 15 * 60000 },
  coding: { capacity: 3, maxWaitMs: 30 * 60000, timeoutMs: 15 * 60000 },
  watchkeeper: { capacity: 1, maxWaitMs: 5 * 60000, timeoutMs: 90000 },
  engineering: { capacity: 1, maxWaitMs: 30 * 60000, timeoutMs: 5 * 60000 },
};
// All class capacities fit at once, so background work cannot consume the
// conversation reserve merely by filling the global budget.
const MAX_TOTAL = Object.values(CLASSES).reduce((n, c) => n + c.capacity, 0);
const TERMINAL = ["done", "cancelled", "dismissed"];

function classOf(job) {
  if (["watchkeeper", "engineering"].includes(job.operatorRole)) return job.operatorRole;
  if (job.kind === "conversation") return "conversation";
  if (job.kind === "coding") return job.investigation ? "investigation" : "coding";
  if (job.role === "owner") return "owner";
  return "investigation";
}

const isSupportWork = (job) => job.role !== "owner" && ["ticket", "candidate"].includes(job.kind);

// Why this job may not start now, or null. ctx: { now, supportDeferred
// (boolean, or a per-job function), claimedBy(channelId) }. Mirrors operator.js drain() before nextJob.
function hold(job, { now = Date.now(), supportDeferred = false, claimedBy = () => null } = {}) {
  if (job.ticketPaused) return "owner-ticket-pause";
  const automatic = job.role !== "owner" && !["command", "conversation"].includes(job.kind);
  if (automatic && job.ticket && !TERMINAL.includes(job.state)) {
    if (claimedBy(job.channelId)) return "staff-owned";
    // Staff chatter holds Keir back, but never past a message that named Keir.
    if ((job.staffActiveUntil || 0) > now && !job.addressedPending) return "staff-active";
    if (job.ownerDecisionPending) return "owner-decision";
  }
  if (job.resolutionSubmitted && !job.resolved) return "closure-grace";
  if (job.deadline && job.deadline < now) return "deadline";
  const deferred = typeof supportDeferred === "function" ? supportDeferred(job) : supportDeferred;
  if (deferred && isSupportWork(job)) return "support-deferred";
  return null;
}

// A ticket nobody has answered yet comes before follow-up work on tickets
// that already have a reply: the first response is the clock players feel.
const awaitingFirstReply = (j) => j.kind === "ticket" && !j.lastPublishedAt && !j.resolutionReadyAt;

// Effective rank: first replies, then overdue items (oldest first), then
// owner-directed, then oldest queued. updatedAt is deliberately ignored:
// chatty work must not be able to re-queue itself ahead of quiet old work.
function rank(queued, now, config = CLASSES) {
  const cls = classOf(queued);
  const overdue = now - (queued.queuedAt ?? queued.at ?? now) >= (config[cls]?.maxWaitMs ?? 0);
  return [awaitingFirstReply(queued) ? 0 : 1, overdue ? 0 : 1, queued.role === "owner" ? 0 : 1, queued.queuedAt ?? queued.at ?? 0];
}

function order(jobs, now, config = CLASSES) {
  return [...jobs].sort((a, b) => {
    const ra = rank(a, now, config), rb = rank(b, now, config);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] ||
      (clsPriority(a) - clsPriority(b)) || ra[3] - rb[3];
  });
}
const clsPriority = (job) => job.operatorRole === "engineering" ? Number(job.engineeringPriority || 0) : 0;

// Admit up to each class's free capacity and the total budget. Running jobs
// in `jobs` fill their class slots unless `active` overrides the counts.
// Owner jobs that do not fit the owner slot compete in investigation.
function admit(jobs, { active = null, now = Date.now(), config = CLASSES, maxTotal = MAX_TOTAL,
  supportDeferred = false, claimedBy = () => null, borrowCoding = false } = {}) {
  const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
  const work = (j) => workIdForJob(j, byId);
  const running = jobs.filter((j) => j.state === "running");
  const counts = active || running.reduce((m, j) => ({ ...m, [classOf(j)]: (m[classOf(j)] || 0) + 1 }), {});
  const busyWork = new Set(running.map(work));
  let total = Object.values(counts).reduce((a, b) => a + b, 0);
  // Completion wakes the parent. A periodic wake must not take the same
  // work-record lock ahead of the child it is waiting for. New inbox evidence
  // remains actionable, including owner corrections and cancellation.
  const parentsWithChildren = new Set(jobs.filter(child => child.codingParent &&
    ["queued", "running", "waiting"].includes(child.state)).map(child => child.codingParent));
  const waitingForChild = (j) => !(j.inbox || []).length && parentsWithChildren.has(j.id);
  const held = (j) => hold(j, { now, supportDeferred, claimedBy });
  const queued = jobs.filter((j) => {
    const root = rootJob(j, byId);
    return j.state === "queued" && !waitingForChild(j) && !held(j) &&
      (root === j || (!TERMINAL.includes(root.state) && !held(root)));
  });
  const admitted = [];
  const take = (pool, free) => {
    const picked = [];
    for (const j of pool) {
      if (picked.length >= free || total >= maxTotal) break;
      if (busyWork.has(work(j)) || admitted.includes(j)) continue;
      picked.push(j); busyWork.add(work(j)); total++;
    }
    return picked;
  };
  const freeIn = (cls) => Math.max(0, (config[cls]?.capacity || 0) - (counts[cls] || 0));
  // Conversation first: its capacity is reserved, never borrowed.
  admitted.push(...take(order(queued.filter((j) => classOf(j) === "conversation"), now, config), freeIn("conversation")));
  admitted.push(...take(order(queued.filter((j) => classOf(j) === "owner"), now, config), freeIn("owner")));
  admitted.push(...take(order(queued.filter((j) => classOf(j) === "watchkeeper"), now, config), freeIn("watchkeeper")));
  const investigationPool = order(queued.filter((j) => ["investigation", "owner"].includes(classOf(j))
    && !admitted.includes(j)), now, config);
  let freeInv = freeIn("investigation");
  // Support preference: with tickets ready and none running, the first
  // investigation slot goes to the best support job.
  const supportRunning = running.some(isSupportWork);
  const firstSupport = investigationPool.find(isSupportWork);
  if (freeInv > 0 && firstSupport && !supportRunning) {
    const got = take([firstSupport], 1);
    admitted.push(...got); freeInv -= got.length;
  }
  // One engineering slot can make progress alongside ticket work; it cannot
  // borrow conversation, owner, or Watchkeeper capacity or exceed the total.
  admitted.push(...take(order(queued.filter((j) => classOf(j) === "engineering"), now, config), freeIn("engineering")));
  admitted.push(...take(investigationPool, freeInv));
  const codingQueue = order(queued.filter((j) => classOf(j) === "coding"), now, config);
  admitted.push(...take(codingQueue, freeIn("coding")));
  // An idle coding slot with no coding work waiting lends itself to
  // investigation (ticket bursts), never to conversation or owner overflow
  // beyond what investigation already allows.
  if (!codingQueue.length && freeIn("coding") > 0 && borrowCoding)
    admitted.push(...take(investigationPool.filter((j) => !admitted.includes(j)), freeIn("coding")));
  return admitted;
}

// Position is computed in the same ordering the scheduler admits in, so the
// number an ack quotes is the number that is true.
function queuePosition(jobs, target, { now = Date.now(), config = CLASSES } = {}) {
  const cls = classOf(target);
  const peers = order(jobs.filter((j) => j.state === "queued" && classOf(j) === cls), now, config);
  const index = peers.findIndex((j) => j.id === target.id);
  return index < 0 ? 0 : index; // items ahead in its own class
}

// What the ack may truthfully say: items ahead, and whether a slot in the
// target's class is actually free for it now. Running jobs fill slots.
function ackFacts(jobs, target, { now = Date.now(), config = CLASSES, maxTotal = MAX_TOTAL } = {}) {
  const cls = classOf(target);
  const runningAll = jobs.filter((j) => j.state === "running");
  const running = runningAll.filter((j) => classOf(j) === cls).length;
  const queuedAhead = queuePosition(jobs, target, { now, config });
  const free = Math.min(Math.max(0, (config[cls]?.capacity || 0) - running), Math.max(0, maxTotal - runningAll.length));
  return { queuedAhead, startingNow: queuedAhead < free };
}

module.exports = { CLASSES, MAX_TOTAL, classOf, hold, order, admit, queuePosition, ackFacts };
