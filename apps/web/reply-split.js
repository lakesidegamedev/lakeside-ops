"use strict";
// Port of apps/agent/lib/operator/replysplit.js (apps/web is released without
// apps/agent, so it cannot import it). Keep the two in step: the rules and
// constants are identical except GAP_MS. Used at the delivery layer so any
// caller of a reply-mode ticket update reads like chat, not a wall of text.
// It only turns text into an ordered list; it knows nothing about tickets.
//
// Rules:
//  - a reply that already fits a chat line (SINGLE_MAX) stays one message;
//  - paragraphs are the first boundary; a paragraph over CHUNK_TARGET is cut at
//    sentence ends, never mid-sentence unless one sentence alone is too long;
//  - fenced code, and a list with the line that introduces it, stay in one
//    message (a numbered or bulleted list the player asked for is not chopped);
//  - at most MAX_CHUNKS messages: the tail is merged rather than dropped;
//  - no message passes DISCORD_LIMIT; text is never lost or reordered.

const SINGLE_MAX = 220;
const CHUNK_TARGET = 200;
const MAX_CHUNKS = 4;
const DISCORD_LIMIT = 1900;
const GAP_MS = 1200;

const FENCE = /^\s*```/;
const LIST_LINE = /^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)/;

// Blocks: fenced code, lists (with their lead-in line) and plain paragraphs.
function blocks(text) {
  const out = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let para = [], fence = null;
  const flush = () => { if (para.length) out.push({ kind: "para", text: para.join("\n").trim() }); para = []; };
  for (const line of lines) {
    if (fence) {
      fence.push(line);
      if (FENCE.test(line)) { out.push({ kind: "keep", text: fence.join("\n") }); fence = null; }
      continue;
    }
    if (FENCE.test(line)) { flush(); fence = [line]; continue; }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  if (fence) out.push({ kind: "keep", text: fence.join("\n") });
  flush();
  return out.filter((b) => b.text).map((b) => (b.kind === "para" && b.text.split("\n").some((l) => LIST_LINE.test(l)) ? { kind: "keep", text: b.text } : b));
}

function sentenceList(text) {
  return String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).filter(Boolean);
}

// Cut one overlong run at whitespace so a chunk never passes the limit.
function hardCut(text, limit = DISCORD_LIMIT) {
  const out = [];
  let rest = String(text);
  while (rest.length > limit) {
    let at = rest.lastIndexOf("\n", limit);
    if (at < limit / 2) at = rest.lastIndexOf(" ", limit);
    if (at < limit / 2) at = limit;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function paragraphChunks(text) {
  if (text.length <= CHUNK_TARGET) return [text];
  const out = [];
  let cur = "";
  for (const s of sentenceList(text)) {
    if (cur && (cur + " " + s).length > CHUNK_TARGET) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

function splitReply(text, { single = SINGLE_MAX, maxChunks = MAX_CHUNKS, limit = DISCORD_LIMIT } = {}) {
  const whole = String(text || "").trim();
  if (!whole) return [];
  if (whole.length <= single && !FENCE.test(whole)) return [whole];
  let chunks = [];
  for (const b of blocks(whole)) {
    if (b.kind === "keep") chunks.push(b.text);
    else chunks.push(...paragraphChunks(b.text));
  }
  // A short line followed by a list or code block it introduces travels with it.
  const merged = [];
  for (const c of chunks) {
    const prev = merged.at(-1);
    if (prev && /:\s*$/.test(prev) && prev.length < CHUNK_TARGET && (LIST_LINE.test(c) || FENCE.test(c))) merged[merged.length - 1] = `${prev}\n${c}`;
    else merged.push(c);
  }
  chunks = merged;
  // Too many messages is a wall of pings: fold the tail into the last allowed one.
  while (chunks.length > maxChunks) {
    const last = chunks.pop();
    chunks[chunks.length - 1] = `${chunks.at(-1)}\n\n${last}`;
  }
  return chunks.flatMap((c) => hardCut(c, limit)).filter((c) => c.trim());
}

module.exports = { splitReply, hardCut, SINGLE_MAX, CHUNK_TARGET, MAX_CHUNKS, DISCORD_LIMIT, GAP_MS };
