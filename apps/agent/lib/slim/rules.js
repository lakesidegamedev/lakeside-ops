"use strict";
// The hard rules for anything Keir posts to a player. Everything else about a
// post (evidence before claims, consistency, voice, scope) is the session's
// own self-review against the style guide, not a code veto.
//
//  1 leak_internal    paths, hosts, repositories, branches, PRs, CI, tool names
//  2 leak_runtime     models, providers, Keir's own runtime and tooling
//  3 leak_private     account ids, emails, IP addresses
//  4 outcome_receipt  "fixed / live / paid / compensated" needs a receipt
//  5 player_name      addressing the player by a name that is not theirs
//  6 spam_cap         at most 2 posts in a row without a new message from a person
//  7 no_promise       no promises of compensation, refunds or features
//  8 owner_voice      no speaking for the owner's decisions or intentions
//  9 paused           no post while the ticket is paused or the kill switch is on
// 10 own_channel      posts go to this ticket's own channel only (structural:
//                     the post tool has no destination argument)
//
// checkPost returns every problem at once so the session can fix the draft in
// one pass.

const RX = {
  path: /(?:^|[\s("'`])((?:\/(?:root|opt|var|etc|srv|home|usr|tmp)\/[\w.@/-]+)|(?:[\w-]+\/)+[\w-]+\.(?:js|ts|tsx|rs|py|json|md|mjs|cjs|sh|toml|yml|yaml))/i,
  host: /\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.(?:internal|local)\b|ops\.lakesidegames\.net|contabo|hetzner|railway)\b/i,
  repo: /\b(?:lakesidegamedev\/[\w.-]+|github\.com\/[\w.-]+\/[\w.-]+|AHDGame|a-house-divided\b(?=\/|\s+repo)|lakeside-ops)\b/i,
  gitwords: /\b(?:pull request|PR\s*#?\d+|PR\b|merge(?:d)? (?:to|into) (?:main|development|staging)|branch(?:es)?\b|commit(?:s|ted)?\b|CI\b|github actions|worktree|hotfix branch)/i,
  toolname: /\b[a-z]+(?:_[a-z0-9]+){1,4}\b(?=\s*(?:\(|tool|call|returned|says|shows))|\b(?:support|kanban|history|game|code|github)_(?:get|read|search|list|exact|update|resolve|public_update|brief|add)\b/,
  envvar: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{3,}\b/,
  runtime: /\b(?:codex|gpt-?\d|claude|sonnet|opus|haiku|anthropic|openai|deepseek|ollama|gemini|llm|language model|my (?:tools?|prompt|instructions|context window)|tool call|activation|the broker|system prompt|kill switch|keir-[a-z]+)\b/i,
  discordId: /\b\d{17,20}\b/,
  email: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,
  ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
};

// Outcome claims. Negated or future/conditional forms are not claims.
const OUTCOME = [
  { kind: "fixLive", rx: /\b(?:(?:is|has been|was|got|now|been)\s+(?:now\s+)?(?:fixed|resolved|corrected|repaired)|fix(?:es)?\s+(?:is|are)\s+(?:now\s+)?(?:live|out|deployed|in the game)|(?:is|are)\s+(?:now\s+)?live\b|(?:we|I)\s+(?:fixed|repaired|corrected)|fixed\s+(?:it|this|that|the)\b|(?:it|this|that)\s+(?:works|is working)\s+(?:now|again))/i },
  { kind: "paid", rx: /\b(?:(?:has|have)\s+been\s+(?:paid|credited|refunded|compensated|reimbursed)|(?:was|were)\s+(?:paid|credited|refunded|compensated|reimbursed)|(?:we|I)\s+(?:paid|credited|refunded|compensated|reimbursed)|paid\s+(?:into|to)\s+(?:your|you)|(?:is|are)\s+now\s+in\s+your\s+(?:account|treasury|bank|company))/i },
];
const NEGATED = /\b(?:not|n't|never|no longer|isn't|aren't|hasn't|haven't|wasn't|until|once|when|after|before|if|whether|yet)\b[^.!?]{0,40}$/i;

const PROMISE = /\b(?:(?:we|I)(?:'ll| will| are going to| can)\s+(?:make sure you (?:get|receive)|pay|refund|compensate|credit|reimburse|give you|send you|add|build|implement|make)\b|you(?:'ll| will)\s+(?:get|receive|be (?:paid|compensated|refunded|credited|reimbursed))\b|(?:compensation|a refund|reimbursement)\s+(?:is|are)\s+(?:coming|on (?:its|the) way|guaranteed)|guarantee)/i;

function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function firstMatch(rx, text) {
  const m = rx.exec(text);
  return m ? (m[1] || m[0]).trim() : null;
}

/**
 * ctx: {
 *   kind: "answer" | "update" | "question" | "resolution",
 *   state,                      the ticket state record
 *   names: [..],                the player's own names (username, display, character)
 *   ownerNames, ownerPrivateNames,
 *   paused, killed
 * }
 */
function checkPost(text, ctx = {}) {
  const t = String(text || "");
  const problems = [];
  const add = (rule, match, fix) => problems.push({ rule, match: String(match).slice(0, 120), fix });
  const state = ctx.state || {};

  if (ctx.killed) add("paused", "kill switch", "Everything is stopped. Do not post; finish and wait.");
  if (state.paused || ctx.paused) add("paused", "ticket paused", "This ticket is paused. Do not post; finish and wait.");
  if (!t.trim()) add("empty", "", "Write the message.");

  for (const [key, rule, fix] of [
    ["path", "leak_internal", "Players never see file paths. Say what it means for them."],
    ["host", "leak_internal", "Players never see hosts or servers. Say what it means for them."],
    ["repo", "leak_internal", "Players never see repositories. Say what changed in the game."],
    ["gitwords", "leak_internal", "Players never hear about PRs, branches, commits or CI. Say where the fix is: being built, being tested, live."],
    ["toolname", "leak_internal", "That is a tool or code name. Use the words on the game's own screens."],
    ["envvar", "leak_internal", "That is a setting name. Describe the effect instead."],
    ["runtime", "leak_runtime", "Players never hear about models, providers or how Keir works. Write only the answer."],
    ["discordId", "leak_private", "Never post account ids."],
    ["email", "leak_private", "Never post email addresses."],
    ["ip", "leak_private", "Never post IP addresses."],
  ]) {
    const m = firstMatch(RX[key], t);
    if (m) add(rule, m, fix);
  }
  for (const name of [...(ctx.ownerPrivateNames || [])]) {
    if (name && new RegExp(`\\b${escape(name)}\\b`, "i").test(t)) add("leak_private", name, "The owner's own name never goes in a post. Say \"the team\" or \"the developers\".");
  }

  // 4 outcome receipts
  const receipts = state.receipts || { fixLive: [], paid: [] };
  for (const s of sentences(t)) {
    for (const o of OUTCOME) {
      const m = o.rx.exec(s);
      if (!m) continue;
      const before = s.slice(0, m.index);
      if (NEGATED.test(before) || /\b(?:will|would|should|could|might|once|when|after|until|if)\b/i.test(before.split(/[,;]/).pop() || "")) continue;
      const have = o.kind === "paid" ? receipts.paid.length > 0 : receipts.fixLive.some((r) => r.verifiedRead);
      if (!have) {
        add("outcome_receipt", m[0], o.kind === "paid"
          ? "No payment receipt on this ticket. Say the request is with the owner, or wait for the payment record."
          : "No receipt that a fix is live and checked on this player's own records. Say it is being built or tested, or record the receipt (record_receipt) after reading their data on the live game.");
      }
    }
  }

  // 5 player name
  const own = new Set((ctx.names || []).filter(Boolean).flatMap((n) => [n.toLowerCase(), n.toLowerCase().split(/\s+/)[0]]));
  const greet = /^(?:hi|hey|hello|thanks|thank you|sorry|good (?:morning|evening|afternoon))[\s,]+@?([A-Z][\w.'-]{1,30}|[\w.'-]{2,30})(?=[,!.:\s]|$)/i.exec(t.trim());
  const mention = /(?:^|\s)@([\w.'-]{2,32})/.exec(t);
  for (const cand of [greet?.[1], mention?.[1]].filter(Boolean)) {
    const c = cand.toLowerCase();
    if (["there", "all", "everyone", "again", "team", "folks", "for", "so"].includes(c)) continue;
    if (own.size && !own.has(c)) add("player_name", cand, `That is not this player's name. Use one of: ${[...(ctx.names || [])].filter(Boolean).join(", ") || "no name"}, or no name.`);
  }

  // 6 spam cap: two in a row without a person writing, three in any 30 minutes, and never the same ask twice
  if (ctx.kind !== "resolution") {
    const since = require("./state").postsSinceHuman(state);
    if (since.length >= 2) add("spam_cap", `${since.length} posts since anyone wrote`, "Two posts in a row already. Record the update in ticket state and wait for the next message, or post only the resolution.");
    const nowMs = ctx.now || Date.now();
    const recent = (state.posts || []).filter((p) => p.delivered !== false && p.kind !== "resolution" && nowMs - Date.parse(p.at) < 30 * 60000);
    if (recent.length >= 3) add("spam_cap", `${recent.length} posts in the last 30 minutes`, "Three posts in 30 minutes already. Put everything into one considered reply later; record progress in ticket state meanwhile.");
    const earlier = (state.posts || []).filter((p) => p.kind !== "resolution").map((p) => p.text);
    const imageTrouble = (x) => /\b(?:screenshot|image|picture|attachment)s?\b/i.test(x) && /\b(?:couldn.?t|could not|can.?t|cannot|unable to|won.?t|didn.?t|did not|doesn.?t|does not)\s+(?:\w+\s+){0,3}?(?:open|load|see|view|display)\b/i.test(x);
    if (imageTrouble(t) && earlier.some(imageTrouble)) add("spam_cap", "screenshot trouble said again", "You already said the screenshot would not open. Do not say it or ask about it again: work from the text, the page link and the records.");
    const twin = earlier.find((e) => overlap(e, t) >= 0.7);
    if (twin) add("spam_cap", `repeats an earlier post: "${twin.slice(0, 60)}"`, "This repeats something you already posted. Say something new, or wait for the player.");
  }

  // 7 no promises of compensation or features
  const approvedComp = (state.approvals || []).some((a) => a.kind === "compensation" && a.status === "approved");
  for (const s of sentences(t)) {
    const m = PROMISE.exec(s);
    if (!m) continue;
    if (approvedComp && /\b(?:pay|paid|compensat|credit|refund|reimburs)/i.test(s)) continue;
    add("no_promise", m[0], "Never promise money, refunds or features. Compensation goes to the owner with request_compensation; say only that it is with the team.");
  }

  // 8 owner voice
  const answered = (state.approvals || []).some((a) => a.status !== "pending" && a.answer);
  const who = ["owner", "the developers?", "the dev team", "the team", "staff", ...(ctx.ownerNames || []).map(escape)].join("|");
  const voice = new RegExp(`\\b(?:${who})\\s+(?:has\\s+|have\\s+)?(?:decided|wants?|intends?|plans?|agreed|approved|will\\b|is going to|are going to|thinks?|believes?|prefers?|chose)`, "i");
  const vm = voice.exec(t);
  if (vm && !answered) add("owner_voice", vm[0], "Do not speak for the owner. Ask with request_decision and tell the player it is waiting on the team.");

  return { ok: problems.length === 0, problems };
}

function overlap(a, b) {
  const words = (x) => new Set(String(x || "").toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3));
  const x = words(a), y = words(b);
  if (x.size < 6 || y.size < 6) return 0;
  let common = 0; for (const w of y) if (x.has(w)) common++;
  return common / Math.min(x.size, y.size);
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Light shaping that is never a refusal: dashes become plain punctuation. */
function shape(text) {
  return String(text || "")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

module.exports = { checkPost, shape, sentences, RX };
