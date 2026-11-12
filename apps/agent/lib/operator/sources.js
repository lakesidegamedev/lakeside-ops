"use strict";
// Keir 9: verified sources. A player can check a claim only if they can see what it rests on, and the
// source must be written by code from what Keir actually read, never by the model (a model asked to
// cite invents citations). Two jobs: (1) the figures in a ticket reply must come from this ticket's
// reads, including reads from earlier activations; (2) code appends one short "Checked:" line naming,
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
const unsupported = (message, evidence) => knowledge.unsupportedNumbers(message, evidence);

// Player terms. Each entry maps a read to plain words, or null when it cannot be said safely.
const GAME_RULES = () => "the game's rules";
const TABLE = {
  code_search: GAME_RULES,
  code_read: GAME_RULES,
  code_exact: GAME_RULES,
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
  if (obs.tool !== "read_tool") return null;
  const input = parse(obs.input);
  const fn = input && TABLE[input.tool];
  if (!fn) return null;
  let words;
  try { words = fn(input.args && typeof input.args === "object" ? input.args : {}, obs.result); } catch { return null; }
  return words || null;
}

/** The "Checked:" line for a reply, or null when nothing qualifies. */
function checkedLine(message, observations) {
  const text = String(message || "");
  // Checkable figures only: with no evidence at all, exactly those are reported as unsupported.
  const numbers = knowledge.numbersIn(text).filter((n) => knowledge.unsupportedNumbers(n.raw, []).length);
  if (!numbers.length && !ruleLookup.ruleClaim(text)) return null;
  const rows = [...(observations || [])].sort((a, b) => (b.at || 0) - (a.at || 0));
  const named = [];
  const add = (obs) => { const w = obs && describe(obs); if (w && !named.includes(w)) named.push(w); };
  for (const n of numbers) {
    add(rows.find((o) => describe(o) && (knowledge.supported(n, observationValues(o)) || n.percent && knowledge.supported({ ...n, value: n.value / 100 }, observationValues(o)))));
  }
  if (!named.length) add(rows.find((o) => describe(o)));
  if (!named.length) return null;
  let line = "";
  for (let k = Math.min(named.length, MAX_SOURCES); k >= 1; k--) {
    line = `Checked: ${named.slice(0, k).join(" and ")}.`;
    if (line.length <= MAX_LINE) break;
    line = "";
  }
  if (!line || playerLeak(line) || runtimeTalk(line) || /https?:|\/\/|\b[0-9a-f]{12,}\b/i.test(line)) return null;
  return line;
}

/** The reply with the code-written line appended, or unchanged when it does not fit the post shape. */
function appendChecked(message, observations) {
  // A line the model wrote itself is never trusted; only the code-written one is posted.
  const base = String(message || "").replace(/(?:^|\n+)\s*Checked:[^\n]*$/i, "").trimEnd();
  const line = checkedLine(base, observations);
  if (!line) return base;
  const out = `${base}\n\n${line}`;
  if (out.replace(/\s+/g, " ").length > MAX_CHARS || sentences(out).length > MAX_SENTENCES) return base;
  return out;
}

module.exports = { ticketEvidence, unsupported, describe, checkedLine, appendChecked, MAX_REFUSALS, MAX_LINE };
