"use strict";

// Durable ticket history (Keir slim-down, stage 1).
//
// Discord deletes a ticket channel when the ticket closes, and several ticket
// fields are rewritten in place (a reopen drops the resolution, a delivered
// private reply has its text cleared). This module keeps an append-only record
// of everything that happened on a ticket, in the same database as the
// tickets, so an agent can search past tickets and read any of them in full.
//
// Two collections:
//   ticketHistory         one document per event (player message, staff
//                         message, support post, status change, finding,
//                         fix, resolution, reopen, merge, refused post)
//   ticketHistoryDigests  one document per ticket, for search by words
//                         (text index) and by meaning (embedding)
//
// Events are derived from the ticket record by eventsFromTicket(), which is
// deterministic: the same ticket always yields the same event ids. Backfill,
// the live recorder (change streams on tickets and ticketPrivateReplies) and
// the periodic sweep therefore all converge on one copy of each event, and an
// event is never deleted or overwritten once stored. A direct hook in
// support_public_update adds who posted and the exact text of a ticket-only
// reply, which the ticket record does not keep.

const crypto = require("node:crypto");

const HISTORY = "ticketHistory";
const DIGESTS = "ticketHistoryDigests";
const STATE = "ticketHistoryState";
const PRIVATE_REPLIES = "ticketPrivateReplies";

const TEXT_CAP = 20000; // one event
const DIGEST_TEXT_CAP = 200000; // words index per ticket
const EMBED_TEXT_CAP = 8000; // meaning index per ticket

const sha = (s, n = 12) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, n);
const ms = (d) => {
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : null;
};
const asDate = (d) => {
  const t = ms(d);
  return t == null ? null : new Date(t);
};
const clip = (s, n = TEXT_CAP) => {
  const v = s == null ? "" : String(s);
  return v.length > n ? v.slice(0, n) : v;
};
const idList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

function configFromEnv(env = process.env) {
  return {
    staffIds: new Set([...idList(env.TICKET_HISTORY_STAFF_IDS), ...idList(env.KEIR_OWNER_ID), ...idList(env.KEIR_SUPPORT_DELEGATES)]),
    agentBotIds: new Set(idList(env.TICKET_HISTORY_AGENT_BOT_IDS)),
    embedUrl: env.TICKET_HISTORY_EMBED_URL || "",
    embedModel: env.TICKET_HISTORY_EMBED_MODEL || "",
    recorder: env.TICKET_HISTORY_RECORDER !== "0",
    sweepMinutes: Math.max(1, Number(env.TICKET_HISTORY_SWEEP_MINUTES) || 15),
  };
}

function messageRole(ticket, m, cfg) {
  const id = String(m.authorId || "");
  if (id && id === String(ticket.discordUserId || "")) return "player";
  if (id === "discord-bot" || /^system/i.test(id)) return "system";
  if (cfg.agentBotIds.has(id)) return "agent";
  if (cfg.staffIds.has(id)) return "staff";
  return "participant";
}

const MESSAGE_KIND = { player: "player_message", staff: "staff_message", participant: "participant_message", system: "system_message", agent: "agent_message" };

/**
 * Every event a ticket record implies. Pure and deterministic.
 * Returns [{ _id, ticketNumber, at, kind, actor, text, meta }].
 */
function eventsFromTicket(ticket, cfg = configFromEnv()) {
  const n = Number(ticket && ticket.ticketNumber);
  if (!Number.isInteger(n)) return [];
  const out = [];
  const add = (key, at, kind, actor, text, meta) => {
    out.push({ _id: `${n}:${key}`, ticketNumber: n, at: asDate(at) || asDate(ticket.createdAt) || new Date(0), kind, actor: actor || null, text: clip(text), meta: meta || {} });
  };
  const reporter = { id: ticket.discordUserId || null, name: ticket.discordUsername || ticket.reporter?.username || null, role: "player" };

  add("opened", ticket.createdAt, "opened", reporter, [ticket.title, ticket.description].filter(Boolean).join("\n\n"), {
    title: ticket.title || null,
    category: ticket.category || null,
    platform: ticket.platform || null,
    character: ticket.reporter?.characterName || null,
    corporation: ticket.reporter?.corporationName || null,
    images: Array.isArray(ticket.imageUrls) ? ticket.imageUrls.length : 0,
  });

  for (const m of Array.isArray(ticket.messages) ? ticket.messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = messageRole(ticket, m, cfg);
    const t = ms(m.createdAt);
    add(`msg:${t}:${m.authorId || "?"}:${sha(m.content || "", 10)}`, m.createdAt, MESSAGE_KIND[role], { id: m.authorId || null, name: m.authorName || null, role }, m.content || "", m.attachments ? { attachments: m.attachments.length } : {});
  }

  for (const u of Array.isArray(ticket.publicUpdates) ? ticket.publicUpdates : []) {
    if (!u || !u.key) continue;
    if (u.kind === "resolution") continue; // recorded once, from the resolution receipt
    add(`post:${u.key}`, u.at, "support_post", { id: null, name: u.by || null, role: "support" }, u.message || "", {
      updateKind: u.kind || null,
      deliveryMode: u.deliveryMode || null,
      delivered: u.delivery?.status || null,
      ticketOnly: u.ticketOnly === true || undefined,
      supersededAt: u.supersededAt || undefined,
    });
  }

  for (const s of Array.isArray(ticket.statusHistory) ? ticket.statusHistory : []) {
    if (!s || !s.status) continue;
    add(`status:${ms(s.at)}:${s.status}:${sha([s.by, s.source, s.note].join("|"), 8)}`, s.at, "status", { id: null, name: s.by || null, role: s.source === "bot" ? "system" : "support" }, s.note || "", { status: s.status, source: s.source || null });
  }

  const receipts = [...(Array.isArray(ticket.resolutionHistory) ? ticket.resolutionHistory : []), ...(ticket.resolution ? [ticket.resolution] : [])];
  for (const r of receipts) {
    if (!r || !(r.message || r.receiptId)) continue;
    const key = r.receiptId || sha([r.message, r.createdAt].join("|"));
    const actions = Array.isArray(r.actions) ? r.actions.map((a) => (typeof a === "string" ? a : a?.label)).filter(Boolean) : [];
    const text = [r.message, actions.length ? "What we did:\n- " + actions.join("\n- ") : "", r.followUp || ""].filter(Boolean).join("\n\n");
    add(`resolution:${key}`, r.resolvedAt || r.createdAt || ticket.resolvedAt || ticket.closedAt, "resolution", { id: null, name: r.closedBy || r.attribution?.agent || null, role: "support" }, text, {
      receiptId: r.receiptId || null,
      source: r.source || null,
      delivered: r.channelDelivery?.status || r.delivery?.status || null,
      creditedTo: r.attribution?.agent || (r === ticket.resolution ? ticket.resolutionAttribution?.agent : null) || null,
      evidence: r.attribution?.evidence || (r === ticket.resolution ? ticket.resolutionAttribution?.evidence : null) || null,
    });
  }

  if (ticket.opsFindingsText) add(`finding:${sha(ticket.opsFindingsText)}`, ticket.opsFindingsPostedAt || ticket.updatedAt, "finding", { id: null, name: null, role: "support" }, ticket.opsFindingsText, {});
  if (ticket.opsHealRequestText) add(`heal_request:${sha(ticket.opsHealRequestText)}`, ticket.opsHealRequestedAt || ticket.updatedAt, "heal_request", { id: null, name: null, role: "support" }, ticket.opsHealRequestText, { reason: ticket.opsHealRequestReason || null, env: ticket.opsHealRequestEnv || null });
  if (ticket.prUrl || ticket.prNumber) {
    add(`fix_pr:${ticket.prNumber || sha(ticket.prUrl)}`, ticket.opsTldrPostedAt || ticket.trackerUpdatedAt || ticket.updatedAt, "fix", { id: null, name: null, role: "support" }, ticket.prUrl || `PR ${ticket.prNumber}`, { prNumber: ticket.prNumber || null, prUrl: ticket.prUrl || null, headSha: ticket.prHeadSha || null });
  }

  for (const c of Array.isArray(ticket.conversationHistory) ? ticket.conversationHistory : []) {
    if (!c) continue;
    add(`reopen:${c.requestId || ms(c.replacedAt)}`, c.replacedAt, "reopen", { id: null, name: c.by || null, role: "support" }, c.reason || "", { oldChannelId: c.channelId || null });
  }

  if (ticket.mergedInto != null) add(`merged_into:${ticket.mergedInto}`, ticket.mergedAt || ticket.updatedAt, "merge", { id: null, name: ticket.mergedBy || null, role: "support" }, `Merged into ticket ${ticket.mergedInto}`, { mergedInto: ticket.mergedInto });
  for (const m of Array.isArray(ticket.mergedTickets) ? ticket.mergedTickets : []) {
    const other = typeof m === "object" ? m?.ticketNumber ?? m?.number : m;
    if (other == null) continue;
    add(`merged_from:${other}`, (typeof m === "object" && (m.mergedAt || m.at)) || ticket.updatedAt, "merge", { id: null, name: (typeof m === "object" && m.by) || null, role: "support" }, `Ticket ${other} merged into this one`, { mergedFrom: other });
  }

  for (const r of Array.isArray(ticket.copyRefusals) ? ticket.copyRefusals : []) {
    if (!r) continue;
    add(`refused:${ms(r.at)}:${sha([r.tool, r.match, r.kind].join("|"), 8)}`, r.at, "refused_post", { id: null, name: r.by || null, role: "support" }, `${r.tool || "post"} refused: "${r.match || ""}" is ${r.kind || "not allowed"}`, { tool: r.tool || null });
  }

  return out;
}

/** A ticket-only reply keeps its exact text only until Discord has it. */
function eventFromPrivateReply(doc) {
  if (!doc || doc.text == null || !doc.key) return null;
  const n = Number(doc.ticketNumber);
  if (!Number.isInteger(n)) return null;
  return { _id: `${n}:post:${doc.key}`, ticketNumber: n, at: asDate(doc.createdAt) || new Date(), kind: "support_post", actor: { id: null, name: null, role: "support" }, text: clip(doc.text), meta: { updateKind: doc.kind || null, deliveryMode: doc.deliveryMode || null, ticketOnly: true } };
}

const SEARCHABLE = new Set(["opened", "player_message", "staff_message", "participant_message", "agent_message", "support_post", "resolution", "finding", "heal_request", "reopen"]);
// Status notes written by the system say nothing about the problem.
const ROUTINE_NOTE = /^(resolution receipt recorded|discord-ticket-|closed; earlier resolution receipt kept|ticket channel|auto|$)/i;
// The standard greeting is on nearly every ticket and would dominate meaning.
const GREETING = /^Hi, I'm Keir\b/;

/** Searchable text of one event: what was said, plus any evidence note. */
function eventWords(e) {
  if (e.kind === "status") return ROUTINE_NOTE.test(String(e.text || "").trim()) ? "" : e.text;
  if (!SEARCHABLE.has(e.kind)) return "";
  return [e.text, e.meta?.evidence].filter(Boolean).join("\n");
}

function digestFromTicket(ticket, events) {
  const n = Number(ticket.ticketNumber);
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const words = ordered.map(eventWords).filter(Boolean).join("\n");
  const playerEarly = ordered.filter((e) => e.kind === "player_message").slice(0, 4).map((e) => e.text);
  const lastResolution = ordered.filter((e) => e.kind === "resolution").pop();
  const finding = ordered.filter((e) => e.kind === "finding").pop();
  // The latest substantive replies usually name the cause.
  const latestReplies = ordered.filter((e) => e.kind === "support_post" && e.text && !GREETING.test(e.text) && e.text.length > 80).slice(-2).map((e) => e.text);
  const meaning = clip([
    ticket.title, ticket.category ? `Category: ${ticket.category}` : "", ticket.description, ...playerEarly,
    finding ? `Finding: ${finding.text}` : "", ...latestReplies.map((t) => `Reply: ${t}`),
    lastResolution ? `Outcome: ${[lastResolution.text, lastResolution.meta?.evidence].filter(Boolean).join("\n")}` : "",
  ].filter(Boolean).join("\n"), EMBED_TEXT_CAP);
  return {
    _id: n,
    ticketNumber: n,
    title: ticket.title || null,
    category: ticket.category || null,
    status: ticket.status || null,
    reporter: ticket.discordUsername || ticket.reporter?.username || null,
    character: ticket.reporter?.characterName || null,
    createdAt: asDate(ticket.createdAt),
    closedAt: asDate(ticket.resolvedAt || ticket.closedAt),
    mergedInto: ticket.mergedInto ?? null,
    eventCount: ordered.length,
    lastEventAt: ordered.length ? ordered[ordered.length - 1].at : asDate(ticket.createdAt),
    text: clip(words, DIGEST_TEXT_CAP),
    embedText: meaning,
    embedHash: sha(meaning, 16),
  };
}

async function ensureIndexes(db) {
  await db.collection(HISTORY).createIndex({ ticketNumber: 1, at: 1 }, { name: "ticket_at" });
  await db.collection(HISTORY).createIndex({ kind: 1, at: -1 }, { name: "kind_at" });
  await db.collection(DIGESTS).createIndex({ title: "text", text: "text" }, { name: "words", weights: { title: 5, text: 1 }, default_language: "english" });
  await db.collection(DIGESTS).createIndex({ lastEventAt: -1 }, { name: "recent" });
}

/** Store events. Existing events are never overwritten. */
async function storeEvents(db, events, source) {
  if (!events.length) return { inserted: 0 };
  const now = new Date();
  // What was said, by whom and when is written once. meta carries state that
  // legitimately moves later (delivery status, superseded), so it is refreshed.
  const ops = events.map(({ meta, ...e }) => {
    const live = Object.entries(meta || {}).filter(([, v]) => v !== undefined);
    const update = { $setOnInsert: { ...e, source, recordedAt: now, ...(live.length ? {} : { meta: {} }) } };
    if (live.length) update.$set = Object.fromEntries(live.map(([k, v]) => [`meta.${k}`, v]));
    return { updateOne: { filter: { _id: e._id }, update, upsert: true } };
  });
  let inserted = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const r = await db.collection(HISTORY).bulkWrite(ops.slice(i, i + 500), { ordered: false });
    inserted += r.upsertedCount || 0;
  }
  return { inserted };
}

async function embed(texts, cfg, fetchImpl = globalThis.fetch) {
  if (!cfg.embedUrl || !texts.length) return null;
  const res = await fetchImpl(cfg.embedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(cfg.embedModel ? { model: cfg.embedModel } : {}), input: texts }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`embedder answered ${res.status}`);
  const body = await res.json();
  const vectors = body.embeddings || (Array.isArray(body.data) ? body.data.map((d) => d.embedding) : null);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error("embedder returned the wrong number of vectors");
  return { model: body.model || cfg.embedModel || "unknown", vectors };
}

/** Write one ticket's digest; embed it when its meaning text changed. */
async function storeDigest(db, ticket, cfg, { embedNow = true } = {}) {
  const events = await db.collection(HISTORY).find({ ticketNumber: Number(ticket.ticketNumber) }).toArray();
  const digest = digestFromTicket(ticket, events);
  const col = db.collection(DIGESTS);
  const prior = await col.findOne({ _id: digest._id }, { projection: { embeddedHash: 1, embedModel: 1 } });
  await col.updateOne({ _id: digest._id }, { $set: { ...digest, updatedAt: new Date() } }, { upsert: true });
  if (!embedNow || !cfg.embedUrl) return { embedded: false };
  if (prior && prior.embeddedHash === digest.embedHash && prior.embedModel) return { embedded: false };
  try {
    const r = await embed([digest.embedText], cfg);
    await col.updateOne({ _id: digest._id, embedHash: digest.embedHash }, { $set: { embedding: r.vectors[0], embedModel: r.model, embeddedHash: digest.embedHash, embeddedAt: new Date() } });
    return { embedded: true };
  } catch (e) {
    return { embedded: false, error: e.message };
  }
}

async function recordTicket(db, ticket, cfg = configFromEnv(), source = "live") {
  const r = await storeEvents(db, eventsFromTicket(ticket, cfg), source);
  const d = await storeDigest(db, ticket, cfg);
  return { ...r, ...d };
}

/**
 * Direct hook for support_public_update: who posted, and the exact text even
 * when the ticket record only keeps generic text for a ticket-only reply.
 */
async function notePost(db, { ticketNumber, key, by, text, updateKind, deliveryMode, ticketOnly, at = new Date() }) {
  const n = Number(ticketNumber);
  if (!Number.isInteger(n) || !key) return;
  await db.collection(HISTORY).updateOne(
    { _id: `${n}:post:${key}` },
    {
      $set: { "actor.name": by || null, "actor.role": "support", ...(text ? { text: clip(text) } : {}), "meta.exact": true },
      $setOnInsert: { ticketNumber: n, at: asDate(at) || new Date(), kind: "support_post", "actor.id": null, "meta.updateKind": updateKind || null, "meta.deliveryMode": deliveryMode || null, ...(ticketOnly ? { "meta.ticketOnly": true } : {}), source: "hook", recordedAt: new Date() },
    },
    { upsert: true },
  );
}

/**
 * Backfill every ticket and every still-unsent private reply. Bulk writes
 * throughout: the database can be a long round trip away.
 */
async function backfill(db, cfg = configFromEnv(), { log = () => {}, embedBatch = 32 } = {}) {
  await ensureIndexes(db);
  const started = new Date();
  const tickets = await db.collection("tickets").find({}).toArray();
  const derived = tickets.flatMap((t) => eventsFromTicket(t, cfg));
  const { inserted } = await storeEvents(db, derived, "backfill");
  log(`events derived ${derived.length}, newly stored ${inserted}`);
  const privates = (await db.collection(PRIVATE_REPLIES).find({ text: { $type: "string" } }).toArray()).map(eventFromPrivateReply).filter(Boolean);
  const privateNew = (await storeEvents(db, privates, "backfill")).inserted;
  log(`private replies with text still held: ${privates.length}, ${privateNew} new`);
  // Digests from everything stored, so hook-only events count too.
  const stored = new Map();
  for await (const e of db.collection(HISTORY).find({}, { projection: { recordedAt: 0, source: 0 } })) {
    if (!stored.has(e.ticketNumber)) stored.set(e.ticketNumber, []);
    stored.get(e.ticketNumber).push(e);
  }
  const now = new Date();
  const ops = tickets.map((t) => {
    const d = digestFromTicket(t, stored.get(Number(t.ticketNumber)) || []);
    return { updateOne: { filter: { _id: d._id }, update: { $set: { ...d, updatedAt: now } }, upsert: true } };
  });
  for (let i = 0; i < ops.length; i += 200) await db.collection(DIGESTS).bulkWrite(ops.slice(i, i + 200), { ordered: false });
  log(`digests written ${ops.length}`);
  // The live recorder's first sweep then covers only what changed since.
  await db.collection(STATE).updateOne({ _id: "sweep" }, { $set: { at: new Date(started.getTime() - 60000), tickets: tickets.length, by: "backfill" } }, { upsert: true });
  const embedded = await embedMissing(db, cfg, { batch: embedBatch, log });
  return { tickets: tickets.length, events: derived.length, inserted, privateNew, embedded };
}

async function embedMissing(db, cfg, { batch = 32, log = () => {} } = {}) {
  if (!cfg.embedUrl) return 0;
  const col = db.collection(DIGESTS);
  const model = (await embed(["model check"], cfg)).model;
  const todo = await col.find({ $or: [{ embedding: { $exists: false } }, { embedModel: { $ne: model } }, { $expr: { $ne: ["$embedHash", "$embeddedHash"] } }] }, { projection: { embedText: 1, embedHash: 1 } }).toArray();
  let done = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const r = await embed(slice.map((d) => d.embedText || " "), cfg);
    await col.bulkWrite(slice.map((d, j) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { embedding: r.vectors[j], embedModel: r.model, embeddedHash: d.embedHash, embeddedAt: new Date() } } } })));
    done += slice.length;
    log(`embedded ${done}/${todo.length}`);
  }
  return done;
}

/**
 * Live recorder: change streams on tickets and private replies, resumable
 * across restarts, plus a periodic sweep that catches anything a stream
 * missed (stream down longer than the oplog window, tunnel drop).
 */
function startRecorder(db, cfg = configFromEnv(), { log = console.error } = {}) {
  if (!cfg.recorder) return { stop() {} };
  let stopped = false;
  const streams = [];
  const State = db.collection(STATE);
  const pending = new Map();
  const flush = async (n) => {
    pending.delete(n);
    const t = await db.collection("tickets").findOne({ ticketNumber: n });
    if (t) await recordTicket(db, t, cfg, "live");
  };
  const schedule = (n) => {
    if (!Number.isInteger(n) || pending.has(n)) return;
    pending.set(n, setTimeout(() => flush(n).catch((e) => log(`[ticket-history] record ${n}: ${e.message}`)), 2000));
  };

  async function watch(name, onChange) {
    let backoff = 1000;
    while (!stopped) {
      const saved = await State.findOne({ _id: `resume:${name}` }).catch(() => null);
      let stream;
      try {
        stream = db.collection(name).watch([], { fullDocument: "updateLookup", ...(saved?.token ? { resumeAfter: saved.token } : {}) });
        streams.push(stream);
        for await (const change of stream) {
          backoff = 1000;
          await onChange(change).catch((e) => log(`[ticket-history] ${name} change: ${e.message}`));
          await State.updateOne({ _id: `resume:${name}` }, { $set: { token: change._id, at: new Date() } }, { upsert: true });
          if (stopped) break;
        }
      } catch (e) {
        if (stopped) break;
        log(`[ticket-history] ${name} stream: ${e.message}`);
        // A token older than the oplog cannot resume: start fresh, then sweep.
        if (/resume|ChangeStreamHistoryLost|oplog/i.test(e.message || "")) {
          await State.deleteOne({ _id: `resume:${name}` }).catch(() => {});
          sweep().catch(() => {});
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      } finally {
        stream?.close().catch(() => {});
      }
    }
  }

  async function sweep() {
    const since = (await State.findOne({ _id: "sweep" }))?.at || new Date(0);
    const started = new Date();
    const changed = await db.collection("tickets").find({ $or: [{ updatedAt: { $gte: since } }, { updatedAt: { $exists: false } }] }).toArray();
    for (const t of changed) await recordTicket(db, t, cfg, "sweep");
    for (const p of await db.collection(PRIVATE_REPLIES).find({ text: { $type: "string" } }).toArray()) {
      const e = eventFromPrivateReply(p);
      if (e) await storeEvents(db, [e], "sweep");
    }
    if (cfg.embedUrl) await embedMissing(db, cfg).catch((e) => log(`[ticket-history] embed: ${e.message}`));
    await State.updateOne({ _id: "sweep" }, { $set: { at: new Date(started.getTime() - 60000), tickets: changed.length } }, { upsert: true });
  }

  ensureIndexes(db).catch((e) => log(`[ticket-history] indexes: ${e.message}`));
  watch("tickets", async (c) => {
    const n = c.fullDocument?.ticketNumber;
    if (Number.isInteger(n)) schedule(n);
  });
  watch(PRIVATE_REPLIES, async (c) => {
    const e = eventFromPrivateReply(c.fullDocument);
    if (e) await storeEvents(db, [e], "live");
  });
  const timer = setInterval(() => sweep().catch((e) => log(`[ticket-history] sweep: ${e.message}`)), cfg.sweepMinutes * 60000);
  timer.unref?.();
  sweep().catch((e) => log(`[ticket-history] sweep: ${e.message}`));
  return {
    sweep,
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const t of pending.values()) clearTimeout(t);
      for (const s of streams) s.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- reading

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Reciprocal rank fusion of ranked lists of ticket numbers. */
function fuse(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((n, i) => score.set(n, (score.get(n) || 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([n, s]) => ({ ticketNumber: n, score: s }));
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "was", "are", "not", "but", "why", "how", "what", "when", "did", "does", "has", "have", "into", "about"]);
function queryTerms(query) {
  return [...new Set(String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 8);
}

function snippet(text, query, width = 240) {
  const t = String(text || "");
  const terms = queryTerms(query);
  // Word-start matches only ("turn" must not match "returns"), and the window
  // holding the most distinct query words wins.
  const hits = [];
  for (const w of terms) {
    const re = new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}`, "gi");
    let m;
    while ((m = re.exec(t)) && hits.length < 2000) hits.push({ i: m.index, w });
  }
  hits.sort((a, b) => a.i - b.i);
  let best = -1, bestCount = 0;
  for (let a = 0; a < hits.length; a++) {
    const seen = new Set();
    for (let b = a; b < hits.length && hits[b].i - hits[a].i < width - 40; b++) seen.add(hits[b].w);
    if (seen.size > bestCount) { bestCount = seen.size; best = hits[a].i; }
  }
  const start = Math.max(0, best < 0 ? 0 : best - 60);
  return (start > 0 ? "..." : "") + t.slice(start, start + width).replace(/\s+/g, " ").trim() + (start + width < t.length ? "..." : "");
}

function digestFilter({ status, category, since, until, exclude } = {}) {
  const f = {};
  if (status) f.status = status;
  if (category) f.category = category;
  if (since || until) f.createdAt = { ...(since ? { $gte: new Date(since) } : {}), ...(until ? { $lte: new Date(until) } : {}) };
  if (exclude != null) f._id = { $ne: Number(exclude) };
  return f;
}

async function searchHistory(db, { query, mode = "both", limit = 10, cfg = configFromEnv(), fetchImpl, ...filters }) {
  const col = db.collection(DIGESTS);
  const base = digestFilter(filters);
  const pool = Math.max(limit * 3, 30);
  const notes = [];
  let words = [];
  if (mode !== "meaning") {
    const byScore = (search) => col.find({ ...base, $text: { $search: search } }, { projection: { _id: 1, score: { $meta: "textScore" } } }).sort({ score: { $meta: "textScore" } }).limit(pool).toArray();
    // Tickets that contain every word come first, then any word.
    const terms = queryTerms(query);
    const every = terms.length > 1 ? await byScore(terms.map((t) => `"${t}"`).join(" ")) : [];
    const seen = new Set(every.map((d) => d._id));
    words = [...every, ...(await byScore(String(query))).filter((d) => !seen.has(d._id))].slice(0, pool);
  }
  let meaning = [];
  if (mode !== "words") {
    if (!cfg.embedUrl) notes.push("search by meaning is not configured; words only");
    else {
      try {
        const q = await embed([String(query)], cfg, fetchImpl);
        const docs = await col.find({ ...base, embedModel: q.model }, { projection: { _id: 1, embedding: 1 } }).toArray();
        meaning = docs.map((d) => ({ _id: d._id, sim: cosine(q.vectors[0], d.embedding || []) })).sort((a, b) => b.sim - a.sim).slice(0, pool);
        if (!docs.length) notes.push("no ticket has a meaning index for the current embedder yet; words only");
      } catch (e) {
        notes.push(`search by meaning failed (${e.message}); words only`);
      }
    }
  }
  const ranked = fuse([words.map((d) => d._id), meaning.map((d) => d._id)].filter((l) => l.length)).slice(0, limit);
  const byId = new Map((await col.find({ _id: { $in: ranked.map((r) => r.ticketNumber) } }, { projection: { embedding: 0, embedText: 0 } }).toArray()).map((d) => [d._id, d]));
  const wordHit = new Set(words.map((d) => d._id));
  const sims = new Map(meaning.map((d) => [d._id, d.sim]));
  const results = ranked.map((r) => {
    const d = byId.get(r.ticketNumber) || {};
    return {
      ticket: r.ticketNumber,
      title: d.title || null,
      status: d.status || null,
      category: d.category || null,
      opened: d.createdAt || null,
      closed: d.closedAt || null,
      mergedInto: d.mergedInto ?? null,
      events: d.eventCount || 0,
      matchedWords: wordHit.has(r.ticketNumber),
      similarity: sims.has(r.ticketNumber) ? Math.round(sims.get(r.ticketNumber) * 1000) / 1000 : null,
      snippet: snippet(d.text, query),
    };
  });
  return { query, mode, results, ...(notes.length ? { notes } : {}) };
}

const WHO = (e) => {
  const a = e.actor || {};
  if (a.role === "player") return `player ${a.name || ""}`.trim();
  if (a.role === "staff") return `staff ${a.name || ""}`.trim();
  if (a.role === "participant") return `other person ${a.name || ""}`.trim();
  if (a.role === "agent") return `support bot ${a.name || ""}`.trim();
  if (a.role === "system") return "system";
  return a.name ? `support (${a.name})` : "support";
};

async function readHistory(db, number, { offset = 0, limit = 200, maxChars = 60000, kinds } = {}) {
  const n = Number(number);
  const digest = await db.collection(DIGESTS).findOne({ _id: n }, { projection: { embedding: 0, embedText: 0, text: 0 } });
  const filter = { ticketNumber: n, ...(Array.isArray(kinds) && kinds.length ? { kind: { $in: kinds } } : {}) };
  const total = await db.collection(HISTORY).countDocuments(filter);
  const rows = await db.collection(HISTORY).find(filter).sort({ at: 1, _id: 1 }).skip(offset).limit(limit).toArray();
  let used = 0;
  const events = [];
  for (const e of rows) {
    const text = String(e.text || "");
    if (used + text.length > maxChars && events.length) break;
    used += text.length;
    events.push({ at: e.at, kind: e.kind, who: WHO(e), text, ...(Object.keys(e.meta || {}).length ? { meta: e.meta } : {}) });
  }
  const next = offset + events.length;
  return {
    ticket: n,
    found: Boolean(digest) || total > 0,
    ...(digest ? { title: digest.title, status: digest.status, category: digest.category, reporter: digest.reporter, character: digest.character, opened: digest.createdAt, closed: digest.closedAt, mergedInto: digest.mergedInto } : {}),
    totalEvents: total,
    events,
    ...(next < total ? { nextOffset: next } : {}),
  };
}

function registerHistoryTools(server, { db, z, jsonResult, errorResult, cfg = configFromEnv() }) {
  server.tool(
    "support_history_search",
    "Search every past support ticket by words and by meaning, including closed tickets whose Discord channel is gone. Searches what the player wrote, staff and support replies, findings and resolutions. Returns ticket numbers, titles, status, dates and a matching snippet; read one in full with support_history_get.",
    {
      query: z.string().min(2).max(500),
      mode: z.enum(["both", "words", "meaning"]).optional().default("both"),
      limit: z.number().int().min(1).max(30).optional().default(10),
      status: z.string().max(40).optional(),
      category: z.string().max(60).optional(),
      since: z.string().max(40).optional().describe("only tickets opened on or after this date (ISO)"),
      until: z.string().max(40).optional().describe("only tickets opened on or before this date (ISO)"),
      exclude: z.number().int().optional().describe("leave out this ticket, usually the one being worked"),
    },
    async (args) => {
      try { return jsonResult(await searchHistory(db, { ...args, cfg })); }
      catch (e) { return errorResult(`history search failed: ${e.message}`); }
    },
  );
  server.tool(
    "support_history_get",
    "Read one past ticket in full from the durable ticket history, in time order: what the player wrote, staff and other people in the channel, every support post (including ticket-only replies), status changes, findings, fixes, resolutions, reopens, merges and refused posts. Works after the Discord channel is deleted. Page with offset when nextOffset is returned.",
    {
      number: z.number().int(),
      offset: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(500).optional().default(200),
      kinds: z.array(z.string().max(40)).max(20).optional().describe("only these event kinds, e.g. player_message, support_post, resolution"),
    },
    async ({ number, offset, limit, kinds }) => {
      try {
        const r = await readHistory(db, number, { offset, limit, kinds });
        if (!r.found) return errorResult(`ticket #${number} has no history`);
        return jsonResult(r);
      } catch (e) { return errorResult(`history read failed: ${e.message}`); }
    },
  );
}

module.exports = {
  HISTORY, DIGESTS, STATE,
  configFromEnv, eventsFromTicket, eventFromPrivateReply, digestFromTicket,
  ensureIndexes, storeEvents, storeDigest, recordTicket, notePost, backfill, embedMissing, startRecorder,
  cosine, fuse, snippet, queryTerms, eventWords, searchHistory, readHistory, registerHistoryTools,
};
