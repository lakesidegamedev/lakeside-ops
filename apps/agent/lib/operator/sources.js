"use strict";
// Keir 9: verified sources. A player can check a claim only if they can see what it rests on, and the
// source must be written by code from what Keir actually read, never by the model (a model asked to
// cite invents citations). Two jobs: (1) the figures in a ticket reply must come from this ticket's
// reads, including reads from earlier activations; (2) code appends one short "From:" line naming,
// in player terms, the reads behind the reply. Unknown tools are omitted, never shown raw.
const knowledge = require("./knowledge");
const { playerLeak, runtimeTalk, sentences, MAX_CHARS, MAX_SENTENCES } = require("./playercopy");
const ruleLookup = require("./rulelookup");

const MAX_LINE = 120, MAX_SOURCES = 2, MAX_REFUSALS = 2;

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const clean = (v) => String(v ?? "").replace(/[^\p{L}\p{N} '&.-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
const title = (s) => clean(s).replace(/[_-]+/g, " ");

/** Numbers in one stored observation. */
const observationValues = (obs) => knowledge.numbersIn(obs.result || "").map((n) => n.value);

/** Every figure this ticket's reads support: this activation plus every stored observation. */
function ticketEvidence(ledger, job, ticketNo) {
  const rows = ledger.data.ticketObservations?.[ticketNo] || [];
  return [...(job.evidence || []), ...rows.flatMap(observationValues)];
}

/** Figures in a ticket draft that nothing read for this ticket supports. */
const unsupported = (message, evidence, facts) => knowledge.unsupportedNumbers(message, evidence, facts);

/** Typed facts from this activation's reads and every stored public read of this ticket. */
function ticketFacts(ledger, job, ticketNo) {
  const typed = require("./typedfacts");
  const rows = ledger.data.ticketObservations?.[ticketNo] || [];
  const stored = rows.filter((o) => o.tool === "read_tool").flatMap((o) => {
    const input = parse(o.input), result = parse(o.result);
    return input && result ? typed.fromRead(input, result) : [];
  });
  return [...(job.typedFacts || []), ...stored];
}

// Player terms. Each entry maps a read to plain words, or null when it cannot be said safely.
// Keir 11.4 (ticket 1872, owner 2026-11-21): a code read is not a rule lookup. "From: the game's rules" was appended to a
// page crash diagnosed from the page's code and a live check of the page. A code read is now named by the files it read:
// interface code is "the page's code", game logic is "the game's rules", and a read whose files cannot be told apart (or
// that names no file) gives no line at all. A wrong label is worse than none.
const PAGE_LABEL = "the page's code", RULES_LABEL = "the game's rules", LIVE_LABEL = "a live check of the page";
const UI_FILE = /\.(?:tsx|jsx|css|scss|vue|svelte)$|(?:^|\/)(?:components|pages|views|ui|hooks|styles|app)\//i;
const RULES_FILE = /(?:^|\/)(?:lib|simulation|engine|turn|market|economy|constants|rules|server|services|models|wiki|docs)\/.*\.(?:ts|js|mjs|cjs|json|md)$/i;
function fileKind(file) {
  const f = String(file || "");
  if (!f) return null;
  if (UI_FILE.test(f)) return PAGE_LABEL;
  if (RULES_FILE.test(f)) return RULES_LABEL;
  return null;
}
// Files a code read touched, top hit first: the path it asked for, then the files its result names.
function codeFiles(args, result) {
  const out = [];
  const push = (v) => { if (typeof v === "string" && v && !out.includes(v)) out.push(v); };
  push(args?.path);
  const r = typeof result === "string" ? parse(result) : result;
  const scan = (v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 3) return;
    push(v.path);
    for (const f of Array.isArray(v.files) ? v.files : []) push(typeof f === "string" ? f : f?.path);
    for (const k of ["hits", "results", "chunks", "matches", "items"]) for (const x of Array.isArray(v[k]) ? v[k] : []) scan(x, depth + 1);
  };
  scan(r);
  return out;
}
function codeLabel(args, result) {
  for (const f of codeFiles(args, result)) { const k = fileKind(f); if (k) return k; }
  return null;
}
const CODE_TOOLS = new Set(["code_search", "code_read", "code_exact"]);
const TABLE = {
  code_search: (a, result) => codeLabel(a, result),
  code_read: (a, result) => codeLabel(a, result),
  code_exact: (a, result) => codeLabel(a, result),
  trace_sector: (a) => {
    const sector = title(a.sector || a.sectorId || a.name), region = title(a.region || a.regionId);
    if (sector && region) return `your ${sector} page in ${region}`;
    return sector ? `your ${sector} page` : "your sector page";
  },
  trace_corp: () => "your corporation's page",
  game_overview: (a, result) => {
    const turn = Number(/"(?:currentTurn|turnNumber|turn)"\s*:\s*(\d{1,6})\b/.exec(result || "")?.[1] || a.turn);
    return Number.isInteger(turn) && turn > 0 ? `turn ${turn}` : "the current game status";
  },
  elections: () => "the election results",
  countries: () => "the country's page",
  country_fiscal: () => "the country's budget page",
};

/** Plain words for one observation, or null (not a game read, or not nameable). */
function describe(obs) {
  if (obs.tool === "view_page") return LIVE_LABEL;
  if (obs.tool === "evidence_batch") {
    // A batch of code reads is named like a single one: by the first file whose kind is clear.
    const input = parse(obs.input), result = parse(obs.result);
    const queries = (input?.queries || []).filter((q) => CODE_TOOLS.has(q?.tool));
    if (!queries.length) return null;
    for (const [i, q] of queries.entries()) { const k = codeLabel(q.args, result?.results?.[i] ?? null); if (k) return k; }
    for (const x of result?.results || []) { const k = codeLabel(null, x); if (k) return k; }
    return null;
  }
  if (obs.tool !== "read_tool") return null;
  const input = parse(obs.input);
  const fn = input && TABLE[input.tool];
  if (!fn) return null;
  let words;
  try { words = fn(input.args && typeof input.args === "object" ? input.args : {}, obs.result); } catch { return null; }
  return words || null;
}

/** The "From:" line (where the figures were read, not a claim they were verified) for a reply, or null when nothing qualifies. */
// Keir 11.4 (ticket 1875): Keir's own voice carries no source. A proposal, a mockup, an opinion, an apology, a status
// update or a question is not "from the game's rules"; those sentences are left out before anything is sourced.
const OWN_VOICE = /\b(?:i(?:'|’)?d|i would|we(?:'|’)?d|we would) (?:suggest|propose|recommend|change|make|split|write|word|use|show|put|move|rename|add|drop|prefer)\b|\b(?:my|our) (?:suggestion|proposal|recommendation|mock-?up|draft)\b|\b(?:here(?:'|’)?s|here is|this is) (?:how|what|a|the|my) (?:it|this|that|proposed|suggested|mock-?up|preview|draft|wording|version)\b|\b(?:proposed|suggested) (?:wording|copy|text|layout|line|version|change)\b|\bmock-?up\b|\bpreview of\b|\bcould (?:read|say)\b|\bwould (?:read|say)\b|\bi think\b|\bin my view\b|\bsorry\b|\bapologi[sz]e\b|\b(?:i(?:'|’)?m|i am) (?:preparing|working on|checking|looking)\b|\bmy fix\b/i;
// A message that opens as a preview, mockup or proposal is Keir's own work as a whole: no line at all.
const OWN_MESSAGE = /^\s*(?:preview of|mock-?up\b|(?:here(?:'|’)?s|here is) (?:how i would|the proposed|my proposal|my suggestion|a mock)|my (?:suggestion|proposal)\b|(?:i(?:'|’)?d|i would) (?:suggest|propose))/i;
function factual(message) {
  if (OWN_MESSAGE.test(String(message || ""))) return "";
  const text = String(message || "").replace(/"[^"\n]*"|“[^”\n]*”/g, " ");
  return text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x && !/\?\s*$/.test(x) && !OWN_VOICE.test(x)).join(" ");
}

function checkedLine(message, observations) {
  const text = factual(message);
  // Checkable figures only: with no evidence at all, exactly those are reported as unsupported.
  const numbers = knowledge.numbersIn(text).filter((n) => knowledge.unsupportedNumbers(n.raw, []).length);
  if (!numbers.length && !ruleLookup.ruleClaim(text)) return null;
  const rows = [...(observations || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
  const named = [];
  const add = (obs) => { const w = obs && describe(obs); if (w && !named.includes(w)) named.push(w); };
  for (const n of numbers) {
    add(rows.find((o) => describe(o) && (knowledge.supported(n, observationValues(o)) || n.percent && knowledge.supported({ ...n, value: n.value / 100 }, observationValues(o)))));
  }
  // Audit 2026-11-13: never cite an unrelated read for a rule or cause. With no number matched, a rule or cause is
  // sourced only from a code read on this ticket ("the game's rules"); otherwise there is no line.
  // Keir 11.4: the newest code read whose files are clearly page code or game logic, and a live check of the page when
  // the claim is about a page (never beside the game's rules, and never a read that cannot be told apart).
  if (!named.length && ruleLookup.ruleClaim(text)) {
    const code = rows.find((o) => /"tool"\s*:\s*"code_(?:search|read|exact)"/.test(String(o.input || "")) && describe(o));
    add(code);
    if (!code || describe(code) === PAGE_LABEL) add(rows.find((o) => o.tool === "view_page"));
  }
  if (!named.length) return null;
  let line = "";
  for (let k = Math.min(named.length, MAX_SOURCES); k >= 1; k--) {
    line = `From: ${named.slice(0, k).join(" and ")}.`;
    if (line.length <= MAX_LINE) break;
    line = "";
  }
  if (!line || playerLeak(line) || runtimeTalk(line) || /https?:|\/\/|\b[0-9a-f]{12,}\b/i.test(line)) return null;
  return line;
}

/** The reply with the code-written line appended, or unchanged when it does not fit the post shape. */
function appendChecked(message, observations) {
  // A line the model wrote itself is never trusted; only the code-written one is posted.
  const base = String(message || "").replace(/(?:^|\n+)\s*(?:Checked|From|Source|Sources):[^\n]*$/i, "").trimEnd();
  const line = checkedLine(base, observations);
  if (!line) return base;
  const out = `${base}\n\n${line}`;
  if (out.replace(/\s+/g, " ").length > MAX_CHARS || sentences(out).length > MAX_SENTENCES) return base;
  return out;
}

module.exports = { factual, codeFiles, fileKind, PAGE_LABEL, RULES_LABEL, LIVE_LABEL, ticketFacts, ticketEvidence, unsupported, describe, checkedLine, appendChecked, MAX_REFUSALS, MAX_LINE };
