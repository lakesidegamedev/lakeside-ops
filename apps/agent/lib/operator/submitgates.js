"use strict";
// Submit gates (2026-10-18): deterministic checks on a structured player reply
// before it is accepted, so a weaker model gets the same discipline a strong one
// brings unprompted. A refusal names the exact problem; the model fixes it and
// submits again. Gates: player-copy rules, number provenance (every significant
// figure must appear in something read this activation, or in a calculation),
// and one completeness review before the first acceptance.

const DASH = /[–—]/;
const INTERNAL = /\b(?:npps?|ledgers?|seed(?:s|ed|ing)?|config(?:s|uration)?|cohorts?|throttl\w*|headroom|coordinator|status card)\b/i;
const CODE = /`|\b[\w-]+\/[\w./-]+\.[a-z]{1,4}\b|\b[a-z]+[A-Z][A-Za-z]+\b|\b[a-z]+_[a-z_]+\b|\b\w+\.(?:ts|js|cjs|json|md)\b/;
const UNIT = { billion: 1e9, bn: 1e9, b: 1e9, million: 1e6, mn: 1e6, m: 1e6, thousand: 1e3, k: 1e3 };
const MAX_CHARS = 700, SIGNIFICANT = 100;

function numbers(text) {
  const out = [];
  const re = /(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?:\s*(billion|million|thousand|bn|mn|[kmb])\b)?/gi;
  for (const m of String(text).matchAll(re)) {
    const raw = m[0].replace(/\s*(billion|million|thousand|bn|mn|[kmb])$/i, "").replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out.push(m[1] ? n * UNIT[m[1].toLowerCase()] : n);
  }
  return out;
}

function copyProblems(reply) {
  const problems = [];
  if (reply.length > MAX_CHARS) problems.push(`The reply is ${reply.length} characters; the limit is ${MAX_CHARS}. Cut it down to the finding, the key figures and the next step.`);
  if (DASH.test(reply)) problems.push("The reply contains an em or en dash. Rewrite those sentences without dashes.");
  const internal = INTERNAL.exec(reply);
  if (internal) problems.push(`The reply uses the internal word "${internal[0]}". Say it in the words the game shows players.`);
  const template = /\{\{[^{}]{0,60}\}\}/.exec(reply);
  if (template) problems.push(`The reply contains an unrendered placeholder ${template[0]}. Write the number itself, or supply calculations and reference them as {{calc.id}}.`);
  const code = CODE.exec(reply);
  if (code) problems.push(`The reply contains code-style text ("${code[0]}"). Players never see file names, paths or identifiers.`);
  return problems;
}

// A figure is proven when it, or a 1000x/1e6x rescaling of it, appears in the evidence within 0.5%.
function unproven(reply, evidence) {
  const known = numbers(evidence);
  const near = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 0.005);
  return [...new Set(numbers(reply).filter((n) => Math.abs(n) >= SIGNIFICANT))]
    .filter((n) => !known.some((k) => near(n, k) || near(n, k * 1e3) || near(n, k * 1e6)));
}

const REVIEW = "Before this is accepted, re-read the player's message and your evidence once. Check: (1) every question the player asked is answered; (2) each key figure carries its currency or unit and its turn; (3) the cause is stated and nothing ruled out is repeated; (4) the player's next step is clear; (5) nothing is promised that is not approved. Fix anything missing, then submit again. If it is already complete, submit it unchanged.";

// Returns null when the submission may proceed, or a refusal message.
function check(session, result) {
  const gates = session.job.submitGates;
  const reply = typeof result?.reply === "string" ? result.reply : null;
  if (!gates || reply === null) return null;
  const problems = gates.copy === false ? [] : copyProblems(reply);
  if (gates.provenance !== false) {
    const missing = unproven(reply, [session.evidence || "", session.job.gateEvidence || ""].join("\n"));
    if (missing.length) problems.push(`These figures do not appear in anything you read in this activation: ${missing.slice(0, 5).join(", ")}. Read them from the records, or derive them with calculate, or remove them.`);
  }
  if (problems.length) return "Reply not accepted yet. " + problems.join(" ");
  if (gates.review !== false && !session.reviewed) { session.reviewed = true; return REVIEW; }
  return null;
}

// Tool output a session has seen, kept for provenance checks.
function remember(session, text) {
  if (!session.job.submitGates) return;
  session.evidence = ((session.evidence || "") + "\n" + text).slice(-1000000);
}

// Effect guard: a shell command may read, build and test, but it may not take an
// effect on a claimed approval. Approvals are receipts the broker records, never
// arguments a command asserts.
const ASSERTS_APPROVAL = /--(?:approved[-_]?by|approver|override|as[-_]owner|force|skip[-_][\w-]+)\b/i;
const EXEC = /^(?:\S*\/)?(?:node|bash|sh|python3?|npx|npm run)\s+(?!--test\b)\S+/;
const EFFECT = /\b(?:relink|transfer|refund|payout|credit|grant|approve|delete|withdraw|reassign)\b/i;
const SAFE = /--dry-run\b|\bstatus\b|--help\b|\b(?:vitest|jest|mocha|tsc|eslint|prettier|tsx?\s+--test)\b|\.(?:test|spec)\.[cm]?[jt]sx?\b/i;
function effectRefusal(command) {
  for (const segment of String(command).split(/&&|\|\||;|\|/).map((s) => s.trim().replace(/^cd\s+\S+\s*$/, ""))) {
    if (!segment) continue;
    if (ASSERTS_APPROVAL.test(segment) || (EXEC.test(segment) && EFFECT.test(segment) && !SAFE.test(segment)))
      return `Refused before running: "${segment.slice(0, 120)}" would take an effect or assert an approval. A command cannot grant approval; only a verified receipt can. Do not try it to see what happens. Report what the action requires and request the approval instead.`;
  }
  return null;
}

module.exports = { check, remember, copyProblems, unproven, numbers, effectRefusal, REVIEW };
