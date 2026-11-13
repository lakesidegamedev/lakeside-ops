"use strict";
// Keir 9: check the player's own page before saying it is fixed. The symptom is the first figure on one of the
// player's pages that Keir cited in an answer, recorded by code from what Keir actually read. After the fix is
// live and a turn has run, code repeats that read. An unchanged figure blocks "fixed"; a changed one does not prove it
// (figures move every turn), so the normal rule still needs Keir to read the player's figures and judge.
const knowledge = require("./knowledge");
const sources = require("./sources");

const MAX_TURNS = 3, MAX_REFUSALS = 2;
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const NOT_PAGES = new Set(["code_search", "code_read", "code_exact", "game_overview", "elections"]);

/** Path of the first numeric leaf equal to value, or null. */
function findPath(node, value, path = "", depth = 0) {
  if (depth > 8 || node == null) return null;
  if (typeof node === "number") return node === value ? path || "$" : null;
  if (typeof node === "string") { const n = Number(node); return node.trim() !== "" && Number.isFinite(n) && n === value ? path || "$" : null; }
  if (typeof node !== "object") return null;
  for (const [k, v] of Object.entries(node).slice(0, 200)) { const p = findPath(v, value, path ? `${path}.${k}` : k, depth + 1); if (p) return p; }
  return null;
}
function atPath(node, path) {
  if (!path || path === "$") return node;
  let cur = node;
  for (const k of path.split(".")) { if (cur == null || typeof cur !== "object" || !(k in cur)) return undefined; cur = cur[k]; }
  return cur;
}
const num = (v) => { const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

/** Is this stored observation a read of one of the player's own pages? */
function isPageRead(obs) {
  if (!obs || obs.tool !== "read_tool" || !sources.describe(obs)) return false;
  const input = parse(obs.input);
  return Boolean(input && !NOT_PAGES.has(input.tool));
}

/**
 * The symptom: the earliest page read whose figure the reply cites. { server, tool, args, field | excerpt, value, at }.
 * Null when no cited figure comes from a page read (nothing to compare later).
 */
function chooseSymptom(message, observations) {
  const cited = knowledge.numbersIn(String(message || "")).filter((n) => knowledge.unsupportedNumbers(n.raw, []).length);
  if (!cited.length) return null;
  const rows = [...(observations || [])].filter(isPageRead).sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const obs of rows) {
    const values = knowledge.numbersIn(obs.result || "").map((n) => n.value);
    const hit = cited.find((n) => knowledge.supported(n, values));
    if (!hit) continue;
    const input = parse(obs.input), body = parse(obs.result);
    const field = body ? findPath(body, hit.value) : null;
    return { server: input.server || "gamestate", tool: input.tool, args: input.args && typeof input.args === "object" ? input.args : {},
      ...(field ? { field } : { excerpt: String(hit.raw).slice(0, 40) }), value: hit.value, at: obs.at || 0 };
  }
  return null;
}

/** "changed" | "unchanged" | "unknown" for a fresh read of the symptom's page. */
function judge(symptom, fresh) {
  if (fresh == null || fresh.isError || fresh.error) return "unknown";
  let text; try { text = typeof fresh === "string" ? fresh : JSON.stringify(fresh); } catch { return "unknown"; }
  if (!text || text.length < 2) return "unknown";
  const body = typeof fresh === "string" ? parse(fresh) : fresh;
  if (symptom.field && body && typeof body === "object") {
    const now = num(atPath(body, symptom.field));
    if (now !== null) return now === symptom.value ? "unchanged" : "changed";
  }
  // Without the field, the old figure still on the page means unchanged; its absence proves nothing (the page may have
  // moved or reshaped), so it is unknown, never "changed".
  return knowledge.numbersIn(text).some((n) => n.value === symptom.value) ? "unchanged" : "unknown";
}

const PLAIN = "The change is out, but your page still shows the old figure. I am checking why and will update you here.";
module.exports = { chooseSymptom, judge, isPageRead, findPath, PLAIN, MAX_TURNS, MAX_REFUSALS };
