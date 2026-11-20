"use strict";
// Keir 11.1: evidence rides on Keir's answer, in the same Discord message.
//
// present_evidence (evidencepages.js) stages one chart per presentation for
// this job, this activation and this channel. It posts nothing. This module is
// the transport: it puts that staged chart on the answer itself, using the
// pages module's claim / verify / delivered / release seam.
//
//   ticket tasks   support_public_update gets `evidence: <id>`. Before the
//                  call, a write-once delivery.json (ticket, channel, job,
//                  activation, parent message, attach window) and the chart
//                  go into the shared evidence store. The support service
//                  checks them against the live ticket row and attaches the
//                  chart and report link to the reply's first message
//                  (apps/web/ticket-evidence-attach.js).
//   conversations  the channel_reply or finish outbox entry gets the chart and
//                  the link line just before its first message is posted, as
//                  a reply to the message that asked (operator.js flushOutbox).
//
// When the chart cannot go (takeover, pause, stop, wrong channel, upload
// refused, answer answers another message), the answer goes as text and the
// presentation is released with the reason. A released chart is never sent
// later: there is no delayed follow-up. The model never supplies the id,
// file, link or channel. Audits carry ids and states, never links or text.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ANSWER_KEY = /^(?:channel-reply|finish):/;
const ID = /^[a-f0-9]{32}$/;
const SNOWFLAKE = /^\d{16,20}$/;
const pages = () => require("./evidencepages");
const short = (v, n) => String(v ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const dirOf = (config) => path.resolve(config?.evidencePagesDir || process.env.EVIDENCE_PAGES_DIR || "/var/lib/lakeside-evidence");

function release(ledger, id, reason) { try { return pages().release(ledger, id, reason); } catch { return false; } }
function delivered(ledger, id, receipt) { try { return pages().delivered(ledger, id, receipt); } catch { return false; } }
function suffixOf(claim) { return [claim.caption ? short(claim.caption, 200) : null, claim.line || null].filter(Boolean).join("\n"); }

// --- ticket route ----------------------------------------------------------------

// The support service attaches only what it can verify in its own store: this
// manifest names the ticket, the channel and the attach window, written once.
// `chart` false is a link-only presentation (no chart.png): the support
// service then posts the report link alone, or nothing extra.
function writeManifest(config, job, claim, key, at) {
  if (!ID.test(claim.presentation) || !SNOWFLAKE.test(String(claim.channel || ""))) throw new Error("presentation is not attachable");
  const src = claim.files?.[0]?.path || null;
  if (!src && !claim.line) throw new Error("nothing staged");
  const dir = path.join(dirOf(config), claim.presentation);
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  if (src) {
    const chart = path.join(dir, "chart.png");
    if (!fs.existsSync(chart)) {
      if (!fs.lstatSync(src).isFile()) throw new Error("staged chart missing");
      const tmp = `${chart}.${process.pid}.tmp`;
      fs.copyFileSync(src, tmp); fs.chmodSync(tmp, 0o640); fs.renameSync(tmp, chart);
    }
  }
  const manifest = {
    id: claim.presentation, version: 2, ticket: Number(claim.ticket), channel: String(claim.channel), visibility: claim.visibility,
    chart: Boolean(src), link: Boolean(claim.line), jobId: job.id, activation: job.startedAt || null, answerTo: SNOWFLAKE.test(String(claim.answerTo || "")) ? String(claim.answerTo) : null, key: String(key).slice(0, 120),
    createdAt: new Date(at).toISOString(), attachBy: new Date(at + pages().ANSWER_WAIT_MS).toISOString(),
  };
  const file = path.join(dir, "delivery.json");
  try { fs.writeFileSync(file, JSON.stringify(manifest), { flag: "wx", mode: 0o640 }); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    // A retry of the same answer keeps its manifest; anything else was bound elsewhere.
    if (old.key !== manifest.key || old.jobId !== job.id || old.ticket !== manifest.ticket || old.channel !== manifest.channel) throw new Error("presentation was staged for another answer");
  }
}

// Before a ticket answer goes to the support service. key is the answer's own
// effect key, so a retried call reuses its claim. Returns the id or null.
function claimTicket(ledger, job, { config, key, ticket, at = Date.now() }) {
  let claim = null;
  try {
    if (job.effects?.[key]?.state === "done") return null; // already answered: its stored receipt carries no chart
    claim = pages().claim(ledger, job, { channel: job.channelId, key, at });
    if (!claim) return null;
    if (Number(claim.ticket) !== Number(ticket) || job.kind !== "ticket" || Number(job.ticket) !== Number(ticket)) { release(ledger, claim.presentation, "not this ticket"); return null; }
    writeManifest(config, job, claim, key, at);
    ledger.audit("evidence_attach_claimed", { presentation: claim.presentation, job: job.id, ticket: Number(ticket), via: "support" }); ledger.save();
    return claim.presentation;
  } catch (e) {
    if (claim) release(ledger, claim.presentation, `store: ${short(e.message, 60)}`);
    return null;
  }
}
// Extra support_public_update arguments for a ticket answer, set by the
// broker only (support_action strips them from model input):
//   update_key  stable for an answer bound to a staged presentation, so a
//               retried call (crash, timeout, restart) lands on the same
//               support update instead of a fresh Date.now key and a second
//               post. Answers with no presentation keep the service's own key.
//   reply_to    the request this answer is for: the stage's answerTo, or the
//               newest human message of a ticket task whose source is the
//               ticket channel. The support service verifies it in that
//               channel before threading the reply under it.
function ticketArgs(ledger, job, { key, evidence = null } = {}) {
  const out = {};
  try {
    const p = pages().boundTo(ledger, job, key);
    if (p) out.update_key = `keir-${crypto.createHash("sha256").update(JSON.stringify([p.id, job.id, job.startedAt || null, key])).digest("hex").slice(0, 24)}`;
    const staged = evidence && p && p.id === evidence ? p.staged?.answerTo : null;
    const own = job.kind === "ticket" && SNOWFLAKE.test(String(job.channelId || "")) && job.source?.channelId === job.channelId
      ? require("./conversationturn").latestSource(job) : null;
    const replyTo = evidence ? staged || null : own;
    if (SNOWFLAKE.test(String(replyTo || ""))) out.reply_to = String(replyTo);
  } catch {}
  return out;
}

// After the support call. The support receipt is what Discord stored on the
// message; it decides delivered or released. "attached" needs the message and
// attachment ids; "linked" (report link, no chart) needs the message id of the
// posted message that carried the minted link.
function settleTicket(ledger, job, { id, result = null, error = null, at = Date.now() }) {
  if (!id) return null;
  if (error && !result) { try { ledger.audit("evidence_attach_uncertain", { presentation: id, job: job.id }); ledger.save(); } catch {} return "uncertain"; } // the support claim decides; nothing is resent
  const d = result?.delivery || null;
  const posted = d?.posted === true || d?.alreadyPosted === true || d?.delivery?.status === "posted";
  const ev = d?.evidence || null;
  const messageId = SNOWFLAKE.test(String(ev?.messageId || "")) ? String(ev.messageId) : null;
  if (posted && ev?.status === "attached" && messageId && ev.attachmentId && delivered(ledger, id, { messageId, attachmentId: ev.attachmentId, linked: ev.link === true, at })) return "attached";
  if (posted && ev?.status === "linked" && messageId && ev.link === true && delivered(ledger, id, { messageId, linked: true, at })) return "linked";
  if (!posted && (!ev || ev.status === "pending")) return "pending"; // support retries the same update with its evidence
  release(ledger, id, ev?.reason ? `support: ${ev.reason}` : "support did not confirm delivery");
  return "text_only";
}

// --- outbox route ----------------------------------------------------------------

// Just before an answer's first message is posted. Claims the staged chart
// for this exact outbox key (or verifies an entry that already carries one),
// then mutates the entry so a retry keeps the same attachment and nonce.
function attachOutbox(ledger, key, entry, job, { at = Date.now() } = {}) {
  try {
    if (!job || !entry || entry.deliveredChunks || entry.evidenceFallback) return false;
    if (entry.evidence) {
      const v = pages().verify(ledger, entry.evidence, { job, key, at });
      if (!v.ok) { strip(entry, v.reason); release(ledger, entry.evidence, v.reason); ledger.save(); return false; }
      return true;
    }
    if (!ANSWER_KEY.test(key) || entry.destination !== `channel:${job.id}` || entry.files?.length || entry.components) return false;
    const claim = pages().claim(ledger, job, { channel: job.replyChannel, key, at });
    if (!claim) return false;
    const parent = entry.answerTo || job.source?.messageId || null;
    if (claim.answerTo && parent !== claim.answerTo) { release(ledger, claim.presentation, "answer is for another message"); return false; }
    const suffix = suffixOf(claim);
    const content = suffix ? `${String(entry.content || "").trimEnd()}\n\n${suffix}` : entry.content;
    if (String(content).length > 2000) { release(ledger, claim.presentation, "answer too long for one message"); return false; }
    // Answer first, then caption and link, in one message. A link-only
    // presentation carries no files; the message itself is the delivery.
    Object.assign(entry, { content, ...(claim.files.length ? { files: claim.files, chart: true } : {}), evidence: claim.presentation, evidenceSuffix: suffix || "", evidenceLine: claim.line || "" });
    ledger.audit("evidence_attach_claimed", { presentation: claim.presentation, job: job.id, ticket: claim.ticket || null, via: "outbox" }); ledger.save();
    return true;
  } catch (e) {
    try { ledger.audit("evidence_attach_error", { key, error: short(e.message, 160) }); } catch {}
    return false;
  }
}
function strip(entry, reason) {
  if (entry.evidenceSuffix) { const tail = `\n\n${entry.evidenceSuffix}`; if (String(entry.content).endsWith(tail)) entry.content = String(entry.content).slice(0, -tail.length); }
  delete entry.files; delete entry.chart; entry.evidenceSuffix = ""; entry.evidenceLine = ""; entry.evidenceFallback = short(reason, 80) || "released";
}
// True while an outbox entry still carries its evidence: it goes as one
// message, never split, so the chart or link stays on the answer itself.
function carries(entry) { return Boolean(entry?.evidence && !entry.evidenceFallback); }
// After Discord accepted the first message of an entry that carried evidence.
// `posted` is the exact text sent. A chart needs Discord's attachment id; a
// link-only answer needs Discord's message id and the minted link in the text.
function outboxSent(ledger, key, entry, sent, at = Date.now(), posted = null) {
  if (!carries(entry)) return null;
  const messageId = SNOWFLAKE.test(String(sent?.id || "")) ? String(sent.id) : null;
  const text = String(posted ?? sent?.content ?? "");
  const linked = Boolean(entry.evidenceLine) && text.includes(entry.evidenceLine);
  if (entry.files?.length) {
    const att = (Array.isArray(sent?.attachments) ? sent.attachments : []).find((a) => a?.id);
    if (att && messageId && delivered(ledger, entry.evidence, { messageId, attachmentId: String(att.id), linked, at })) entry.evidenceResult = "attached";
    else { release(ledger, entry.evidence, att ? "discord returned no message id" : "discord kept no attachment"); entry.evidenceResult = "text_only"; }
  } else if (linked && messageId && delivered(ledger, entry.evidence, { messageId, linked: true, at })) entry.evidenceResult = "linked";
  else { release(ledger, entry.evidence, messageId ? "link not on the posted message" : "discord returned no message id"); entry.evidenceResult = "text_only"; }
  return entry.evidenceResult;
}
// After a failed post that has sent nothing yet. A client error (upload
// refused, too large) or a second failure drops the chart and link, so the
// answer itself goes as text on the next pass, same nonce.
function outboxFallback(ledger, key, entry, error, at = Date.now()) {
  if (!carries(entry) || entry.deliveredChunks || !(entry.files?.length || entry.evidenceSuffix)) return false;
  const status = Number(error?.status || 0);
  if (!((status >= 400 && status < 500 && status !== 429) || (entry.attempts || 0) >= 2)) return false;
  const reason = status ? `discord ${status}` : entry.files?.length ? "upload failed twice" : "post failed twice";
  strip(entry, reason); release(ledger, entry.evidence, reason);
  entry.retryAt = at;
  return true;
}

// --- housekeeping ----------------------------------------------------------------

// A staged chart that missed its window is released with the reason, so the
// record says what happened. Nothing is posted.
function sweep(ledger, at = Date.now()) {
  const list = Object.values(ledger.data.evidencePages?.presentations || {});
  let n = 0;
  for (const p of list) {
    const s = p.staged;
    if (!s || s.deliveredAt || s.released) continue;
    if (at - (p.createdAt || s.at || 0) <= pages().ANSWER_WAIT_MS) continue;
    if (release(ledger, p.id, s.claimKey ? "answer not delivered in time" : "no answer in time")) n++;
  }
  return n;
}

module.exports = { claimTicket, ticketArgs, settleTicket, attachOutbox, outboxSent, outboxFallback, carries, sweep, writeManifest };
