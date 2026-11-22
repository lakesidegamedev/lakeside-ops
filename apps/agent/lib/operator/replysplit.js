"use strict";
// Keir guardrails (owner decision 2026-11-22, audit D5): one reply is ONE Discord message. The 8.4.1 chat-style split put
// each sentence in its own message about three seconds apart (four or five pings per answer, 350 progress messages across
// 23 tickets). A reply is split only when it passes Discord's 2000 character limit, at a paragraph, line or space boundary,
// never mid-word, never losing or reordering text. Fenced code stays whole while it fits.

const DISCORD_LIMIT = 2000;
const SINGLE_MAX = DISCORD_LIMIT;
const GAP_MS = 1400;
// Cut one overlong run at a line or space so a chunk never passes the limit.
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

// Paragraphs are packed into as few messages as fit under the limit.
function splitReply(text, { limit = DISCORD_LIMIT } = {}) {
  const whole = String(text || "").trim();
  if (!whole) return [];
  if (whole.length <= limit) return [whole];
  const out = [];
  let cur = "";
  for (const para of whole.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const next = cur ? `${cur}\n\n${para}` : para;
    if (next.length <= limit) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = para;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => hardCut(c, limit)).filter((c) => c.trim());
}

module.exports = { splitReply, hardCut, SINGLE_MAX, DISCORD_LIMIT, GAP_MS };
