"use strict";
// Fast pickup: every few seconds, ask Discord whether a person wrote in an
// open ticket's channel (or the owner's DM) since the last message seen. A new
// human message starts the typing indicator at once and asks the host to run
// intake now, instead of waiting for the slower full poll.

function createFastWatch({ discord, botId, onHuman, now = () => Date.now(), log = () => {} }) {
  const channels = new Map(); // channelId -> { key, last }
  let busy = false;

  /** Watch a channel. key: { ticket } or { dm: true }. */
  function watch(channelId, key) {
    if (!channelId) return;
    const c = channels.get(channelId);
    if (c) { c.key = key; return; }
    channels.set(channelId, { key, last: null });
  }
  function unwatch(channelId) { channels.delete(channelId); }
  function watched() { return [...channels.entries()].map(([id, c]) => ({ channelId: id, ...c.key })); }

  async function tick() {
    if (busy) return [];
    busy = true;
    const found = [];
    try {
      for (const [id, c] of channels) {
        try {
          if (!c.last) {
            const latest = await discord("GET", `/channels/${id}/messages?limit=1`);
            c.last = latest?.[0]?.id || "0";
            continue;
          }
          const msgs = await discord("GET", `/channels/${id}/messages?after=${c.last}&limit=20`);
          const ordered = [...(msgs || [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          for (const m of ordered) {
            c.last = m.id;
            if (m.author?.bot || m.author?.id === botId || m.webhook_id) continue;
            const hit = { channelId: id, ...c.key, messageId: m.id, authorId: m.author?.id || null, at: m.timestamp || new Date(now()).toISOString(), seenAt: new Date(now()).toISOString() };
            found.push(hit);
          }
        } catch (e) {
          if (/ 404$| 403$/.test(e.message)) channels.delete(id); // channel gone or no access: stop watching
          else log(`[keir-slim] fast watch ${id}: ${e.message}`);
        }
      }
    } finally { busy = false; }
    for (const h of found) { try { await onHuman(h); } catch (e) { log(`[keir-slim] fast watch handler: ${e.message}`); } }
    return found;
  }

  return { watch, unwatch, watched, tick };
}

/** A wake limiter where owner and staff wakes jump the queue. */
function createLimiter(max) {
  let running = 0;
  const waiting = [];
  function next() {
    if (running >= max || !waiting.length) return;
    const job = waiting.shift();
    running++;
    job.fn().then(job.resolve, job.reject).finally(() => { running--; next(); });
  }
  function run(fn, { urgent = false } = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, urgent };
      if (urgent) { const i = waiting.findIndex((j) => !j.urgent); i < 0 ? waiting.push(job) : waiting.splice(i, 0, job); }
      else waiting.push(job);
      next();
    });
  }
  return { run, stats: () => ({ running, waiting: waiting.length }) };
}

/**
 * Response-time metrics: from a person's message to typing and to Keir's
 * first post after it. One line per message in <state>/response-times.jsonl.
 */
function createResponseClock({ append, now = () => Date.now() }) {
  const open = new Map(); // ticket -> [{ messageId, at, typingAt }]
  function message(ticket, { messageId, at, typingAt }) {
    const list = open.get(ticket) || [];
    if (!list.some((m) => m.messageId === messageId)) list.push({ messageId, at, typingAt });
    open.set(ticket, list);
  }
  function posted(ticket, postAt = new Date(now()).toISOString()) {
    const list = open.get(ticket) || [];
    for (const m of list) append({ ticket, messageId: m.messageId, messageAt: m.at, typingMs: m.typingAt ? Date.parse(m.typingAt) - Date.parse(m.at) : null, firstPostMs: Date.parse(postAt) - Date.parse(m.at) });
    open.delete(ticket);
  }
  /** A wake ended without a post: record what we have, and keep nothing pending. */
  function wakeEnded(ticket) {
    const list = open.get(ticket) || [];
    for (const m of list) append({ ticket, messageId: m.messageId, messageAt: m.at, typingMs: m.typingAt ? Date.parse(m.typingAt) - Date.parse(m.at) : null, firstPostMs: null, note: "no post in this wake" });
    open.delete(ticket);
  }
  return { message, posted, wakeEnded, pending: (t) => open.get(t) || [] };
}

/**
 * One wake at a time per ticket, and one slot per ticket. Messages that arrive while a ticket's wake waits for a
 * slot join that wake; messages that arrive while it runs make one follow-up wake. A busy ticket can no longer
 * fill every slot and starve the others.
 */
function createTicketQueue({ limiter, run, urgentOf = () => false, log = () => {} }) {
  const active = new Map(); // ticket -> { events, opts, started, buffer, bufferOpts }
  function start(n, events, opts) {
    const entry = { events: [...events], opts, started: false, buffer: null, bufferOpts: null };
    active.set(n, entry);
    return limiter.run(() => { entry.started = true; return run(n, entry.events, entry.opts || {}); }, { urgent: urgentOf(events) })
      .catch((e) => {
        // Never drop messages: a failed delivery is queued again once with what it carried.
        log(`ticket ${n} deliver failed: ${e.message}`);
        if (!entry.retried) { entry.buffer = [...entry.events, ...(entry.buffer || [])]; entry.bufferOpts = entry.bufferOpts || entry.opts; entry.retried = true; }
      })
      .finally(() => {
        active.delete(n);
        if (entry.buffer) start(n, entry.buffer, entry.bufferOpts || {});
      });
  }
  function deliver(n, events, opts) {
    const entry = active.get(n);
    if (!entry) return start(n, events, opts);
    if (!entry.started) { entry.events.push(...events); if (opts?.intro && !entry.opts?.intro) entry.opts = opts; return null; }
    entry.buffer = [...(entry.buffer || []), ...events];
    if (opts?.intro && !entry.bufferOpts?.intro) entry.bufferOpts = opts;
    return null;
  }
  return { deliver, busy: () => [...active.keys()] };
}

module.exports = { createFastWatch, createLimiter, createResponseClock, createTicketQueue };
