"use strict";
// Keir 4.0 phase 1: what may never reach a player, and how players are named.
//
// Ticket 1531 (2026-10-13): Keir posted `src/app/player-ads/page.tsx` to a
// player. Ticket 1522: a player was told their ticket "was being handled by a
// model we were trialling", and was called "Simon" from the username
// "Simonella". These are hard failures of player copy, not style notes, so
// they are checked in code before anything posts. Pure: text in, verdict out.

// Source paths, repositories, hosts, model and provider names, internal
// URLs. Hosts and server paths are already redacted by text.js; this is the
// player-register layer on top, and it refuses rather than redacts so the
// model rewrites the line instead of posting "[redacted]".
const LEAKS = [
  { kind: "source path", re: /(?:^|[\s(`'"])(?:src|lib|app|packages|scripts|components|e2e|test|tests|public)\/[\w.\-/\[\]]+\.(?:tsx?|jsx?|[cm]js|json|css|md|mdx|ya?ml|toml|sh)\b/ },
  { kind: "source path", re: /\b[\w\-\[\]]+(?:\/[\w\-\[\]]+)+\.(?:tsx|ts|jsx|mjs|cjs)\b/ },
  { kind: "repository", re: /\b(?:Egg3901|lakesidegamedev)\/[\w.-]+|\bAHDGame\b|\blakeside-operator\b|\bahd-docs-internal\b|\ba-house-divided\b(?=.*\b(?:repo|repository|branch|checkout)\b)/i },
  { kind: "model or provider name", re: /\b(?:Claude|Opus|Sonnet|Haiku|Anthropic|GPT[- ]?\d[\w.]*|OpenAI|Codex|Luna|SOL\b|Muse(?: Spark| Wonder)?|Spark 1\.\d|Wonder Full|Gemini|Antigravity|DeepSeek|Ollama|Kimi|Grok|Devin|Copilot)\b/ },
  // "the model" alone is left out: the game has pricing and economic models.
  { kind: "model talk", re: /\ba model we\b|\bmodel we were\b|\banother model\b|\blanguage model\b|\bLLM\b|\btoken (?:limit|budget|window)\b|\busage (?:limit|window|quota)\b/i },
  { kind: "internal URL", re: /\bops\.lakesidegames\.net\b|\bmcp\.lakesidegames\.net\b|\brailway\.app\b|\bsentry\.io\b|\bglitchtip\b/i },
  { kind: "internal tool", re: /\bheal[-_ ]ops\b|\bworldsim\b|\bturndiag\b|\bgamestate MCP\b|\bMCP\b/ },
];

// strict: player-facing (ticket channels, player conversations). Non-strict
// keeps only the leaks that are wrong in every channel (internal URLs and
// tools stay allowed for developers).
function playerLeak(text, { strict = true } = {}) {
  if (!strict) return null; // developers may talk shop; text.js still redacts secrets and hosts
  const t = String(text || "");
  for (const l of LEAKS) {
    const m = l.re.exec(t);
    if (m) return { kind: l.kind, match: m[0].trim().slice(0, 80) };
  }
  return null;
}

// Runtime trouble is Keir's business, never the player's (ticket 1507:
// "I hit an error and stopped" then "ignore the error message above").
const RUNTIME_TALK = /\bI hit an error\b|\bignore the error\b|\berror message above\b|\bmy (?:previous|last) (?:run|session|activation)\b|\bthis session\b|\bactivation\b|\bturn limit\b|\btimed out on my end\b|\bquota\b|\b(?:the |my )?(?:available )?tools (?:I have|available to me|I can use)\b|\b(?:discover(?:ing)?|understand(?:ing)?) (?:the |my )?(?:available )?tools\b/i;
function runtimeTalk(text) { const m = RUNTIME_TALK.exec(String(text || "")); return m ? m[0] : null; }

// A player is addressed by their Discord username or display name exactly.
// "Simon" for "Simonella" is a fabricated nickname. A word that is a strict
// prefix of a known name, four or more letters, standing as its own
// capitalised word, is flagged. Names shorter than six letters cannot be
// shortened meaningfully, so they are skipped.
function nameMisuse(text, names = []) {
  const t = String(text || "");
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (name.length < 6) continue;
    const lower = name.toLowerCase();
    for (const m of t.matchAll(/\b([A-Z][a-z]{3,})\b/g)) {
      const w = m[1], wl = w.toLowerCase();
      if (wl !== lower && lower.startsWith(wl) && !SAFE_WORDS.has(wl)) return { used: w, name };
    }
  }
  return null;
}
// Ordinary English words that can open a sentence are never a shortened
// name. First names are deliberately absent: "Simon" is exactly the failure.
const SAFE_WORDS = new Set(["the", "this", "that", "with", "from", "your", "there", "their", "when", "what", "have", "here", "also", "then", "than", "them", "they", "been", "were", "will", "just", "like", "into", "over", "only", "some", "more", "most", "much", "many", "once", "each", "both", "such", "very", "well", "back", "even", "still", "after", "before", "found", "fixed", "right", "thanks", "sorry", "yes", "good", "great", "live", "done", "next", "last", "first", "turn", "turns", "player", "players", "game", "market", "sector", "sectors", "ticket"]);

// Shape of a ticket post (owner, 2026-10-14, ticket 1539: two 800-character
// walls of text a minute apart, no paragraphs, a public "Correction to my
// message above"). A ticket post is at most five short sentences and 700
// characters, read on a phone. Longer text is refused, not trimmed: the
// model decides what matters. Text without paragraph breaks is reflowed
// into paragraphs of at most two sentences. Markdown bullets and existing
// line breaks are kept as written.
const MAX_CHARS = 700;
const MAX_SENTENCES = 5;
const PREAMBLE = /^(?:plain version of what is going on[.:]\s*|quick (?:update|status)[.:]\s*|update[.:]\s*|short version[.:]\s*)/i;
function sentences(text) {
  return String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).filter((s) => s.trim());
}
function shapeTicketPost(text) {
  let t = String(text || "").trim().replace(PREAMBLE, "");
  const sents = sentences(t);
  const chars = t.replace(/\s+/g, " ").length;
  if (chars > MAX_CHARS || sents.length > MAX_SENTENCES) {
    const err = new Error(`Not posted: ${sents.length} sentences, ${chars} characters. A ticket post is at most ${MAX_SENTENCES} short sentences and ${MAX_CHARS} characters, read on a phone. Say what it means for the player and the next step; the explanation goes on the status card note or in the PR, not here.`);
    err.code = "TICKET_POST_TOO_LONG"; throw err;
  }
  if (/\n/.test(t)) return t.replace(/\n{3,}/g, "\n\n");
  if (sents.length <= 2) return t;
  const paras = [];
  for (let i = 0; i < sents.length; i += 2) paras.push(sents.slice(i, i + 2).join(" "));
  return paras.join("\n\n");
}
const CORRECTION = /^(?:correction|to correct my (?:last|previous|earlier) message|my (?:last|previous|earlier) message (?:was wrong|above))/i;
const isCorrection = (text) => CORRECTION.test(String(text || "").trim()) || /\bcorrection to my (?:last|previous|earlier)? ?message\b/i.test(String(text || ""));

module.exports = { LEAKS, playerLeak, runtimeTalk, nameMisuse, shapeTicketPost, sentences, isCorrection, MAX_CHARS, MAX_SENTENCES };
