"use strict";
// Keir 9: what Keir keeps from a closed ticket. The code, not the model, writes at most one ticket resolution
// (and one lesson when an answer was retracted) from the ticket's own evidence: the game code files read
// during the ticket, the rule in the last answer the player was given, and the ticket number. Nothing here
// checked the answer against the file, so a resolution is stored unverified (kind "resolution", verified
// false) and recall labels it so (audit 2026-11-12). Nothing is kept without a code read. State per ticket lives in ledger.data.ticketLearn.
const { ruleClaim } = require("./rulelookup");
const { isCorrection } = require("./playercopy");

const MAX_POSTS = 8, MAX_READS = 12, MAX_TICKETS = 200, ANSWER_CHARS = 420, CLAIM_CHARS = 200;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|rs|py|json)$/i;
const READ_TOOLS = /^code_(?:search|exact|read)$/;
const BY = "ticket-learn";

const entry = (d, ticket) => {
  const all = (d.ticketLearn ||= {});
  const key = String(ticket);
  if (!all[key]) {
    all[key] = { reads: [], posts: [], at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_TICKETS) for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - MAX_TICKETS)) delete all[k];
  }
  return all[key];
};

// Paths of the game code files one code read returned. Wiki and doc hits are not code.
function pathsOf(input, result) {
  let r = result;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = null; } }
  const out = [];
  const add = (p, source) => { if (typeof p === "string" && p.length < 200 && !/\s/.test(p) && CODE_FILE.test(p) && (!source || source === "code")) out.push(p.replace(/^\.?\//, "")); };
  if (r && typeof r === "object") {
    for (const h of Array.isArray(r.hits) ? r.hits : []) add(h?.path, h?.source);
    if (!Array.isArray(r.hits)) for (const f of Array.isArray(r.files) ? r.files : []) add(f);
    if (r.path) add(r.path);
  }
  if (!out.length && input?.tool === "code_read") add(input?.args?.path);
  return [...new Set(out)];
}

/** Called after every tool result. Remembers which code files a ticket's tasks read. */
function noteRead(d, job, name, input, result, at = Date.now()) {
  if (name !== "read_tool" || !job?.ticket || job.role === "player" || input?.server !== "ops-knowledge" || !READ_TOOLS.test(String(input.tool)) || result == null || result.isError || result.error) return;
  const paths = pathsOf(input, result);
  if (!paths.length) return;
  const e = entry(d, job.ticket);
  e.reads = [...e.reads.filter((x) => !paths.includes(x.path)), ...paths.map((path) => ({ path, at, tool: input.tool }))].slice(-MAX_READS);
}

/** Called for every public post that is not a status card. */
function notePost(d, ticket, text, at = Date.now()) {
  const t = String(text || "").trim();
  if (!t) return;
  const correction = isCorrection(t);
  const rule = !correction && Boolean(ruleClaim(t));
  if (!correction && !rule) return;
  const e = entry(d, ticket);
  e.posts = [...e.posts, { at, text: t.slice(0, 600), correction }].slice(-MAX_POSTS);
}

const wordsOf = (t) => new Set((String(t || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []));
const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
const stripCorrection = (t) => String(t || "").replace(/^\s*(?:correction(?: to my (?:last|previous|earlier) message)?|to correct my (?:last|previous|earlier) message)\s*[:,.\-]?\s*/i, "");

// The files that settled the answer: best word overlap with the answer, newest read first on ties.
function deciding(reads, answer) {
  const aw = wordsOf(answer);
  const scored = reads.map((r, i) => ({ r, i, s: [...wordsOf(r.path)].filter((w) => aw.has(w)).length }));
  scored.sort((a, b) => b.s - a.s || b.i - a.i);
  const picked = scored.slice(0, 1).concat(scored.slice(1, 2).filter((x) => x.s > 0));
  return picked.map((x) => x.r.path);
}

/**
 * Keep what a resolved ticket taught. Returns { resolution, lesson } (note ids) or { kept: false, reason }.
 * `notebook` needs remember() and all(); a failure to write never breaks the close.
 */
function keep({ d, notebook, ticket, audit }) {
  const why = (reason) => { try { audit?.("ticket_learn_skipped", { ticket, reason }); } catch {} return { kept: false, reason }; };
  if (!notebook?.remember || !notebook.all) return why("no notebook");
  const e = d.ticketLearn?.[String(ticket)];
  if (!e || !e.reads.length) return why("no code read");
  if (!e.posts.length) return why("no rule answer");
  // The last correction retracts the rule answer before it; the correction is then the answer.
  const lastCorrection = e.posts.map((p, i) => (p.correction ? i : -1)).filter((i) => i >= 0).pop();
  const final = e.posts.at(-1);
  if (e.keptFor === final.at) return why("already kept");
  const wrong = lastCorrection === undefined ? null : e.posts.slice(0, lastCorrection).filter((p) => !p.correction).pop() || null;
  const answer = clip(final.correction ? stripCorrection(final.text) : final.text, ANSWER_CHARS);
  if (answer.length < 12) return why("answer too short");
  const paths = deciding(e.reads, answer + " " + (wrong?.text || ""));
  if (!paths.length) return why("no deciding file");
  const out = { kept: false };
  const existing = notebook.all().find((n) => (n.kind === "mechanic" || n.kind === "resolution") && (n.path === paths[0] || (n.sources || []).some((s) => s.type === "code" && s.path === paths[0])));
  try {
    if (existing && existing.by !== BY) out.resolutionSkipped = "a note on this file already exists";
    else {
      const note = notebook.remember({ kind: "resolution", verified: false, by: BY, ticket: Number(ticket), paths,
        text: `Answer given to a player in ticket ${ticket}, not checked against the code (the ticket read ${paths.join(", ")}): ${answer}`,
        ...(existing ? { supersedes: [existing.id], reason: `Ticket ${ticket} read the same file and states the rule again` } : {}) });
      out.resolution = note.id; out.kept = true;
    }
  } catch (err) { out.resolutionError = clip(err.message, 160); }
  if (wrong) {
    try {
      const old = notebook.all().find((n) => n.kind === "lesson" && n.by === BY && (n.path === paths[0]));
      const right = clip(stripCorrection(final.correction ? final.text : e.posts[lastCorrection].text), CLAIM_CHARS);
      // The right claim came from a correction. It is only presented as settled by the file when the claim itself
      // names what that file is about; otherwise it is labelled like any other unchecked answer.
      const cited = [...wordsOf(paths[0])].some((w) => wordsOf(right).has(w));
      const note = notebook.remember({ kind: "lesson", by: BY, ticket: Number(ticket), paths: [paths[0]], ...(cited ? {} : { verified: false }),
        text: `Ticket ${ticket}: do not repeat this mistake. A wrong claim was given and later retracted. Wrong: "${clip(wrong.text, CLAIM_CHARS)}" Right: "${right}" ${cited ? `The file that settled it: ${paths[0]}.` : `Not verified against the code; the ticket read ${paths[0]}.`}`,
        ...(old ? { supersedes: [old.id], reason: `Ticket ${ticket} retracted a claim about the same file` } : {}) });
      out.lesson = note.id; out.kept = true;
    } catch (err) { out.lessonError = clip(err.message, 160); }
  }
  if (out.kept) { e.keptFor = final.at; e.keptAt = Date.now(); }
  try { audit?.(out.kept ? "ticket_learned" : "ticket_learn_skipped", { ticket, resolution: out.resolution || null, lesson: out.lesson || null, paths, error: out.resolutionError || out.lessonError || null }); } catch {}
  return out;
}

module.exports = { noteRead, notePost, keep, pathsOf, BY };
