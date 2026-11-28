"use strict";
// Owner approval cards: a short line, an embed and buttons, the way old Keir's
// decision cards worked. The buttons use old Keir's custom ids
// (keir_decision:<verb>:<id>); the game's Discord bot handles the click and
// appends a verdict line to the message text, which owner-dm.js reads back.
// The approval id lives only in the button ids, never in visible text.
//
// Copy rules for the owner: the question first, plain words a non-technical
// owner understands, at most three short sentences of why, options with the
// recommended one first, no internal ids or code terms.

const rules = require("./rules");

const CODE_TERMS = /(?:\b(?:src|content|lib|apps)\/|\b[\w.-]+\.(?:tsx?|jsx?|rs|md|json)\b|\b[a-f0-9]{10,40}\b|\b(?:decision|promote|compensation)-[0-9a-f]{6,}\b|\b(?:staging|development branch|multipliers?|limiter|clampedPrice|runtime|pipeline|CI|endpoint|schema|config|ledger|NPP|cohort|throttle|headroom|diffusion|retirement checks?|era gate|feature flag|migration|enum|boolean|null)\b|\bPR\s*#?\d+|\b[a-z]+[A-Z][a-zA-Z]+\b|\b[a-z]+_[a-z_]+\b)/;

function sentencesOf(text) { return rules.sentences(text).length; }

/** Problems with copy the owner will read. Empty when it is fine. */
function checkOwnerCopy({ question, why, options = [], what, risk } = {}) {
  const problems = [];
  const visible = [question, why, what, risk, ...options.flatMap((o) => [o.label, o.detail])].filter(Boolean).join("\n");
  const terms = [...new Set([...visible.matchAll(new RegExp(CODE_TERMS.source, "g"))].map((m) => m[0]))];
  for (const term of terms.slice(0, 6)) problems.push(`"${term}" is an internal id or code term. Say it the way the owner sees the game.`);
  const leak = rules.checkPost(visible, { state: { posts: [], receipts: { fixLive: [], paid: [] } }, kind: "resolution" }).problems.filter((p) => p.rule.startsWith("leak_"));
  for (const p of leak) problems.push(`"${p.match}": ${p.fix}`);
  if (why && sentencesOf(why) > 3) problems.push("The why is at most three short sentences.");
  if (question && question.length > 200) problems.push("The question is at most 200 characters; ask it plainly.");
  for (const o of options) {
    if (!o.label || o.label.length > 60) problems.push("Each option needs a short label, at most 60 characters.");
    if (o.detail && o.detail.length > 160) problems.push("Each option's description is one line, at most 160 characters.");
  }
  return problems;
}

const LETTER = (i) => String.fromCharCode(65 + i);
const optionLabel = (o) => (typeof o === "string" ? o : o?.label || "");
const optionDetail = (o) => (typeof o === "string" ? "" : o?.detail || "");

/** The Discord message for an approval request: { content, embeds, components }. */
/**
 * The id in a button's custom_id. The game bot accepts only 12 hex characters there
 * (keir_decision:<verb>:<12 hex>) and ignores anything else, so Discord shows "didn't respond".
 * The bot only echoes it back; the answer is read from the card's text, so a stable hash is enough.
 */
function buttonId(id) {
  return require("node:crypto").createHash("sha256").update(String(id)).digest("hex").slice(0, 12);
}

function renderCard({ ticket, kind, id, payload }) {
  const bid = buttonId(id);
  const title = kind === "decision" ? payload.question : kind === "promote" ? `Put this fix live? ${payload.what}` : `Pay ${payload.amount} to ${payload.recipient}?`;
  const content = `**Keir needs you** on ticket ${ticket}`;
  const fields = [];
  if (kind === "decision") {
    (payload.options || []).forEach((o, i) => fields.push({ name: `${LETTER(i)}. ${optionLabel(o)}${i === 0 ? " (recommended)" : ""}`.slice(0, 256), value: (optionDetail(o) || "\u200b").slice(0, 1024) }));
  } else if (kind === "promote") {
    if (payload.risk) fields.push({ name: "Risk", value: String(payload.risk).slice(0, 1024) });
  } else if (kind === "compensation") {
    if (payload.basis) fields.push({ name: "How the amount was worked out", value: String(payload.basis).slice(0, 1024) });
  }
  const embed = { title: String(title).slice(0, 256), description: String(payload.why || "").slice(0, 1200), color: kind === "decision" ? 0x3b82f6 : kind === "promote" ? 0x22c55e : 0xf59e0b, fields, footer: { text: kind === "decision" ? "Pick a button, or reply with a letter." : "Pick a button, or reply yes or no." } };
  const components = [];
  if (kind === "decision") {
    const opts = payload.options || [];
    for (let i = 0; i < opts.length; i += 3) components.push({ type: 1, components: opts.slice(i, i + 3).map((o, j) => ({ type: 2, style: i + j === 0 ? 1 : 2, label: `${LETTER(i + j)}. ${optionLabel(o)}`.slice(0, 80), custom_id: `keir_decision:choose${i + j + 1}:${bid}` })) });
    components.push({ type: 1, components: [{ type: 2, style: 2, label: "Ask a question / other answer", custom_id: `keir_decision:explain:${bid}` }] });
  } else {
    const row = [
      { type: 2, style: 3, label: kind === "promote" ? "Put it live" : "Approve payment", custom_id: `keir_decision:approve:${bid}` },
      { type: 2, style: 4, label: "Decline", custom_id: `keir_decision:reject:${bid}` },
      { type: 2, style: 2, label: "Ask a question", custom_id: `keir_decision:explain:${bid}` },
    ];
    if (kind === "promote" && /^https:\/\/github\.com\//.test(String(payload.pr || ""))) row.push({ type: 2, style: 5, label: "See the change", url: payload.pr });
    components.push({ type: 1, components: row });
  }
  return { content, embeds: [embed], components };
}

// The verdict the game bot appends to the card's text (same format as old Keir).
const VERDICT = /\n\n\*\*Decision:\*\* (✅ Approved|❌ Rejected|💬 Explain|🔹 Selected [1-6]) (?:by|from) <@(\d{15,22})>(?: <t:\d+:R>)?(?::\s*([\s\S]*))?$/;

/** Read a clicked verdict from a card's current text. */
function verdictFrom(body, sentContent, approval) {
  const text = String(body || "");
  if (!sentContent || !text.startsWith(sentContent)) return null;
  const v = VERDICT.exec(text.slice(sentContent.length));
  if (!v) return null;
  const extra = (v[3] || "").trim();
  let answer;
  if (v[1].startsWith("🔹 Selected ")) {
    const i = Number(v[1].slice(-1)) - 1;
    const o = approval?.payload?.options?.[i];
    answer = { status: "answered", text: `${LETTER(i)}) ${optionLabel(o) || `option ${i + 1}`}${extra ? ` (${extra})` : ""}` };
  } else if (v[1] === "✅ Approved") answer = { status: "approved", text: extra || "approved" };
  else if (v[1] === "❌ Rejected") answer = { status: "declined", text: extra || "declined" };
  else answer = { status: "answered", text: extra || "the owner asked a question about this request" };
  return { actor: v[2], ...answer };
}

/** Word overlap between two questions, 0 to 1. */
function similarity(a, b) {
  const words = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0; for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}

module.exports = { checkOwnerCopy, renderCard, buttonId, verdictFrom, similarity, optionLabel, VERDICT };
