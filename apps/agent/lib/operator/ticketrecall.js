"use strict";
// Keir 9 (feature C): what a ticket task asks the notebook. The player's words, plus the names of game files and
// screens the ticket mentions or has already read, so a note about the same file or screen is found even when the
// player never used its words.
const FILE = /[\w./-]*[\w-]\.(?:[cm]?[jt]sx?|rs|py|json)\b/gi;
const SCREEN = /\b([A-Za-z][\w'-]*(?: [A-Za-z][\w'-]*)?) (?:screen|page|tab|panel|menu|dialog|window)\b/gi;

function queryFor({ texts = [], reads = [] } = {}) {
  const text = texts.filter(Boolean).join(" ");
  const names = new Set();
  const addPath = (p) => { for (const part of String(p).split("/").slice(-2)) { const base = part.replace(/\.[a-z]+$/i, ""); names.add(base.toLowerCase()); for (const w of base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/)) if (w.length > 2) names.add(w.toLowerCase()); } };
  for (const m of text.matchAll(FILE)) addPath(m[0]);
  for (const r of reads) addPath(r.path || r);
  for (const m of text.matchAll(SCREEN)) names.add(m[1].toLowerCase());
  return [text, ...names].join(" ");
}

// Keir 9 (feature C replay, 2026-11-13): word overlap alone recalled net worth and autopilot notes into an
// impeachment ticket, and false "the rule has since been changed" claims followed. A note now reaches a ticket only
// when it shares a code file or a game area with the question.
// Path folders that say nothing about the game area.
const GENERIC = new Set("src lib app apps components component api utils util shared types typings hooks pages queries query server client engine turn index data core services service helpers models model worker subhour state rules".split(" "));
// Player words for an area whose folder name players do not use.
const ALIASES = {
  wealth: ["worth", "networth", "rich", "wealth"], npp: ["autopilot", "npc"], corporation: ["company", "companies", "corp", "corps", "subsidiary", "firm"],
  military: ["wing", "wings", "army", "navy", "troops", "carrier", "carriers", "base", "bases", "squadron"], navair: ["wing", "wings", "air", "carrier", "carriers"],
  legislation: ["law", "laws", "bill", "bills"], impeachment: ["impeach", "impeached", "impeaching"], party: ["chair", "chairman"],
  election: ["vote", "votes", "ballot", "race", "races"], market: ["price", "prices", "sell", "selling", "buy", "buying"], equity: ["share", "shares", "stock", "stocks", "ipo"],
};
const stem = (w) => w.toLowerCase().replace(/ies$/, "y").replace(/(?<=[a-z]{3})s$/, "");
const split = (s) => String(s).replace(/\.[a-z]+$/i, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_.-]+/).filter((w) => w.length > 2).map(stem);
function notePaths(n) {
  return [...new Set([...(n.paths || []), ...(n.path ? [n.path] : []), ...(n.sources || []).filter((s) => s.type === "code" && s.path).map((s) => s.path)])];
}
// The game area of a path: its first folder that is not generic, else its file name.
function areaOf(p) {
  const parts = String(p).split("/");
  const dir = parts.slice(0, -1).find((x) => !GENERIC.has(x.toLowerCase()));
  return split(dir || parts.at(-1));
}
/**
 * Returns a predicate: does this note share a code file or a game area with the ticket's question?
 * Areas come from the player's own words only. A file the ticket read counts as an exact file match, never as an
 * area: in the rerun, words from files Keir had opened pulled net worth and autopilot notes into unrelated tickets.
 */
function relevantTo({ texts = [], reads = [] } = {}) {
  const raw = texts.filter(Boolean).join(" ").toLowerCase();
  const read = new Set(reads.map((r) => String(r.path || r).toLowerCase()));
  const words = new Set((raw.match(/[a-z][a-z0-9]{2,}/g) || []).map(stem));
  for (const [area, said] of Object.entries(ALIASES)) if (said.some((w) => words.has(stem(w)))) words.add(area);
  if (/\bnet worth\b/.test(raw)) words.add("wealth");
  return (n) => {
    const paths = notePaths(n);
    if (!paths.length) return false;
    for (const p of paths) {
      const lower = String(p).toLowerCase(), base = lower.split("/").at(-1).replace(/\.[a-z]+$/i, "");
      if (read.has(lower) || raw.includes(lower) || raw.includes(base)) return true;
      if (areaOf(p).some((w) => words.has(w))) return true;
    }
    return false;
  };
}

// Keir 9 (feature C replay, 2026-11-13): notes worded as change ("is now left alone", "has since been fixed") were
// followed by false claims that a rule had changed. Notes are kept and shown in plain present tense: the adverb
// "now" is dropped, and a sentence about change, fixes or updates is dropped whole. Empty means nothing to keep.
const CHANGE = /\b(?:has|have|had) since\b|\bever since\b|\bsince the (?:update|patch|fix|change|release)\b|\bno longer\b|\bused to\b|\bany ?more\b|\b(?:has|have|had|was|were|is|are|got) (?:been )?(?:just |recently |already )?(?:changed|fixed|patched|corrected|updated|reworked|adjusted|reverted|resolved)\b|\b(?:recent|latest|current|newest|last|next) (?:update|patch|release|version|fix)\b|\b(?:before|after|until|with) (?:the|this|that|a) (?:fix|update|patch|change)\b|\bnot yet (?:fixed|live)\b/i;
function plainPresent(text) {
  const kept = [];
  for (const raw of String(text || "").split(/(?<=[.!?])\s+/)) {
    let s = raw.replace(/,\s*now\s*,/gi, ",").replace(/\s+now\b(?!\s+on\b)/gi, "").trim();
    if (/^now\b,?\s+/i.test(s)) s = s.replace(/^now\b,?\s+/i, "").replace(/^[a-z]/, (c) => c.toUpperCase());
    if (s && !CHANGE.test(s)) kept.push(s);
  }
  return kept.join(" ");
}

module.exports = { queryFor, relevantTo, areaOf, plainPresent, CHANGE };
