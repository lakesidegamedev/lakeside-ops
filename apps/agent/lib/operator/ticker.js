"use strict";
// Keir 8.4: every periodic job gets a deadline. The old pattern was
//   let busy = false; setInterval(async () => { if (busy) return; busy = true; try { await work(); } finally { busy = false; } }, ms)
// which dies silently for good the first time `work` awaits something that never settles: busy stays
// true, every later interval returns at once, and the process still looks healthy. A ticker races the work
// against `maxMs`; on overrun it releases the guard, counts the overrun, aborts the work's signal and runs
// again on the next interval. State is exposed for /health so a stuck job is visible, not silent.
const TIMED_OUT = Symbol("timed-out");

function createTickers({ now = () => Date.now(), log = () => {}, setIntervalImpl = setInterval, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const entries = new Map();

  async function fire(entry) {
    if (entry.running) {
      if (now() - entry.startedAt < entry.maxMs) { entry.skipped++; return "skipped"; }
      // The race below normally clears this first; this covers a clock jump or a swallowed timer.
      entry.overruns++; entry.lastOverrunAt = now(); entry.running = false;
    }
    const token = ++entry.token, controller = new AbortController();
    entry.running = true; entry.startedAt = now(); entry.runs++;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeoutImpl(() => resolve(TIMED_OUT), entry.maxMs); timer?.unref?.(); });
    try {
      const result = await Promise.race([Promise.resolve().then(() => entry.fn({ signal: controller.signal })), timeout]);
      if (result === TIMED_OUT) {
        controller.abort();
        entry.overruns++; entry.lastOverrunAt = now(); entry.lastError = `exceeded ${Math.round(entry.maxMs / 1000)}s and was abandoned`;
        log(`ticker ${entry.name}: ${entry.lastError}`);
        return "overrun";
      }
      entry.lastOkAt = now(); entry.lastError = null;
      return "ok";
    } catch (e) {
      entry.failures++; entry.lastError = String(e?.message || e).slice(0, 300); entry.lastFailureAt = now();
      log(`ticker ${entry.name}: ${entry.lastError}`);
      return "error";
    } finally {
      clearTimeoutImpl(timer);
      if (entry.token === token) entry.running = false;
    }
  }

  function every(name, intervalMs, fn, { maxMs = 5 * 60000, immediateMs = null } = {}) {
    if (entries.has(name)) throw new Error(`ticker ${name} is already defined`);
    const entry = { name, intervalMs, maxMs, fn, token: 0, running: false, startedAt: 0, runs: 0, skipped: 0, overruns: 0, failures: 0, lastOkAt: null, lastError: null, definedAt: now() };
    entries.set(name, entry);
    const handle = setIntervalImpl(() => { fire(entry); }, intervalMs);
    handle?.unref?.();
    if (immediateMs !== null) { const t = setTimeoutImpl(() => { fire(entry); }, immediateMs); t?.unref?.(); }
    return entry;
  }

  function snapshot(at = now()) {
    return [...entries.values()].map((e) => ({ name: e.name, intervalMs: e.intervalMs, maxMs: e.maxMs, running: e.running, runs: e.runs, skipped: e.skipped, overruns: e.overruns, failures: e.failures,
      lastOkAgeMs: e.lastOkAt === null ? null : at - e.lastOkAt, lastError: e.lastError, stale: isStale(e, at) }));
  }
  // A ticker is stale when it has not completed successfully for three intervals plus its own deadline.
  function isStale(e, at) {
    const grace = 3 * e.intervalMs + e.maxMs;
    return at - (e.lastOkAt ?? e.definedAt) > grace;
  }
  const stale = (at = now()) => snapshot(at).filter((t) => t.stale);
  return { every, fire, snapshot, stale, entries };
}

module.exports = { createTickers };
