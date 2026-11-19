"use strict";
// Keir's state machines, declared once.
//
// A job or an approval request moves between a fixed set of states, but the moves
// are made by plain assignments (`job.state = "queued"`) in about fifty files. This
// module is the single place that says which states exist and which moves are
// expected, and it sees every move without those files changing: track() turns the
// record's `state` field into a checked property, so any assignment anywhere runs
// through the table below.
//
// A move the table does not list is NOT refused. It is recorded once per record as
// an `unexpected_transition` audit row and the assignment goes ahead, so this can
// never stop work that ran before it existed. Read the rows, then either add the
// move here (it was legitimate) or fix the caller (it was a bug).
//
// Each record also carries `stateAt` (when it entered its current state) and
// `statePrev` (where it came from), so "how long has this been blocked, and what
// was it doing before" is one read instead of a search through the audit log.
const fs = require("node:fs");

// Jobs. The five live states move freely between each other: which rule makes
// which move is documented in lifecycle.js. What the table pins down is the part
// that matters when something goes wrong:
//   - only a queued, waiting, blocked or deferred job may start running;
//   - a paused job leaves only by a resume (queued), a hold, or an ending;
//   - a finished job comes back only by being reopened, and then only as queued
//     (a reopened ticket, a named incident) or, for done, waiting.
function jobTransitions() {
  const live = ["queued", "running", "waiting", "blocked", "deferred"], ends = ["done", "cancelled", "dismissed"];
  const t = {};
  for (const from of live) t[from] = [...live.filter((to) => to !== from), "paused", ...ends];
  t.paused = ["queued", "blocked", ...ends];
  t.done = ["queued", "waiting"];
  t.cancelled = ["queued"];
  t.dismissed = ["queued"];
  return t;
}

// What each state means, in the words the owner and the agents should use.
const MACHINES = {
  job: {
    states: {
      queued: "ready to run; admission may start it",
      running: "a model run is in flight",
      waiting: "parked until its wake time or until a message arrives",
      blocked: "held for a person: a decision, a failed run or an uncertain write",
      deferred: "staff claimed the ticket; automatic work is off",
      paused: "the owner paused it; only a resume leaves this state",
      done: "finished",
      cancelled: "stopped on request",
      dismissed: "cleared as a dead end",
    },
    terminal: ["done", "cancelled", "dismissed"],
    transitions: jobTransitions(),
  },
  action: {
    states: {
      pending: "waiting for an approver",
      approved: "approved; not executed yet",
      executing: "the write is in flight",
      done: "executed",
      failed: "execution failed",
      rejected: "an approver said no",
      withdrawn: "Keir took the request back",
      expired: "nobody answered in time",
      superseded: "a newer request replaced it",
      cancelled: "stopped on request",
    },
    terminal: ["done", "rejected", "withdrawn", "expired", "superseded", "cancelled"],
    transitions: {
      pending: ["approved", "rejected", "expired", "superseded", "withdrawn", "cancelled"],
      // back to pending: the approval was undone or has to be asked again
      approved: ["executing", "done", "pending", "expired", "superseded", "withdrawn", "cancelled"],
      executing: ["done", "failed"],
      failed: [], done: [], rejected: [], withdrawn: [], expired: [], superseded: [], cancelled: [],
    },
  },
};

const isTerminal = (machine, state) => MACHINES[machine].terminal.includes(state);
const allowed = (machine, from, to) => from === undefined
  ? Object.hasOwn(MACHINES[machine].states, to)
  : (MACHINES[machine].transitions[from] || []).includes(to);

// KEIR_STATE_TRACE=<file> appends every move as one JSON line. `npm run
// states:observed` uses it to list the moves the test suite actually makes.
const traceFile = process.env.KEIR_STATE_TRACE || "";
function trace(machine, from, to) {
  if (!traceFile) return;
  try { fs.appendFileSync(traceFile, `${JSON.stringify({ machine, from: from ?? null, to })}\n`); } catch {}
}

// Make record.state a checked property. onUnexpected(machine, record, from, to)
// is called for a move the table does not list. Idempotent; the field keeps its
// position, so the saved ledger's key order does not change.
function track(record, machine, onUnexpected, now = Date.now) {
  if (!record || typeof record !== "object") return record;
  const existing = Object.getOwnPropertyDescriptor(record, "state");
  if (existing?.set) return record;
  let value = record.state;
  const reported = new Set();
  Object.defineProperty(record, "state", {
    enumerable: true, configurable: true,
    get: () => value,
    set(next) {
      const from = value;
      value = next;
      if (from === next) return;
      record.statePrev = from; record.stateAt = now();
      trace(machine, from, next);
      if (allowed(machine, from, next) || reported.has(`${from}>${next}`)) return;
      reported.add(`${from}>${next}`);
      onUnexpected?.(machine, record, from, next);
    },
  });
  return record;
}

// An approval's stored state does not change when its time runs out or its job
// ends, so "approved" in the ledger can mean "approved an hour ago" or "approved
// last week for a task that no longer exists". This is the state to show and to
// reason from. It never writes; the broker's own expiry checks are unchanged.
function actionStanding(action, job, now = Date.now()) {
  const state = action?.state;
  if (!["pending", "approved", "executing"].includes(state)) return state;
  if (state === "executing") return !job || isTerminal("job", job.state) || action.expiresAt <= now ? "stuck" : "executing";
  if (action.expiresAt <= now) return "expired";
  if (!job || isTerminal("job", job.state)) return "orphaned";
  return state;
}

// One read for people and agents: where a record is, since when, what that means
// and where it can go from here.
function describe(machine, record) {
  const m = MACHINES[machine], state = record?.state;
  return {
    state, meaning: m.states[state] || "unknown state", terminal: m.terminal.includes(state),
    since: record?.stateAt || record?.updatedAt || record?.at || null, previous: record?.statePrev || null,
    next: m.transitions[state] || [],
  };
}

module.exports = { MACHINES, isTerminal, allowed, track, describe, actionStanding };
