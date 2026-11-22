"use strict";
// Keir guardrails before re-enable (owner decision 2026-11-22, audit 2026-11-22 sections 4 and 6).
//
// Pure functions only. The broker, the agent context builder and the outbox call these; nothing here reads the
// ledger, the network or the clock except through arguments.
//
//   1. Incident context (D3): open incidents and turn failures of the last 24 hours go into every ticket job's
//      context, and nobody says "recovered" until two clean turns follow the last failure.
//   2. Evidence-gated claims (D2): a causal or outcome claim about money, cash, production, sales, payments or
//      "running/fixed/live/paid" is refused unless this activation read a record showing that figure for the
//      player's own entity. When a failure overlaps the period, the claim names the turn range.
//   4. Scope (D6): ticket lanes do not change balance, offer to build features or quote the owner's intentions.
//   5. Escalation (D10): a challenge from the player, two corrections, or a wake cap hit hands the ticket to staff.

const DAY = 24 * 3600000;
const CLEAN_TURNS_REQUIRED = 2;

const parse = (v) => {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } }
  if (v && typeof v === "object" && typeof v.content === "string") return parse(v.content);
  return v ?? null;
};
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const when = (v) => { if (!v) return null; const t = typeof v === "object" && v.$date ? Date.parse(v.$date) : Date.parse(v); return Number.isFinite(t) ? t : null; };

// ---------------------------------------------------------------------------------------------------------------
// 1. Incident context

// Turn rows from engine recent_turns (or any list with a turn number, a success flag or status, and a time).
function turnRows(raw) {
  const v = parse(raw);
  const list = Array.isArray(v) ? v : Array.isArray(v?.turns) ? v.turns : Array.isArray(v?.items) ? v.items : [];
  return list.map((r) => {
    const turn = num(r?.turn ?? r?.turnNumber ?? r?.number);
    const status = String(r?.status ?? (r?.success === false ? "failed" : r?.success === true ? "ok" : r?.outcome ?? "")).toLowerCase();
    const phases = (r?.failedPhases || []).length || (r?.abortedPhases || []).length;
    const failed = r?.success === false || phases > 0 || /fail|error|stuck|abort|timed?out/.test(status);
    const finished = Boolean(r?.finishedAt ?? r?.completedAt ?? r?.endedAt);
    const clean = !failed && (r?.success === true || /^(ok|success|succeeded|completed?|clean|done)$/.test(status) || (r?.success === undefined && !status && finished));
    return { turn, status: status || "unknown", failed, clean, at: when(r?.finishedAt ?? r?.completedAt ?? r?.endedAt ?? r?.realTime ?? r?.at ?? r?.startedAt) };
  }).filter((r) => r.turn !== null);
}
// Failed attempts from turndiag turn_failure_detail ({ turn, attempts: [{ success, realTime, failedPhases }] }).
function failureRows(raw) {
  const v = parse(raw);
  const turn = num(v?.turn);
  return (Array.isArray(v?.attempts) ? v.attempts : []).filter((a) => a && a.success === false).map((a) => ({ turn: num(a.turn) ?? turn, status: "failed", failed: true, clean: false, at: when(a.realTime ?? a.at), phase: (a.failedPhases || [])[0] || null }))
    .filter((r) => r.turn !== null);
}

// What every ticket job is told about the engine. `rows` are turn rows (turnRows + failureRows), newest or oldest first.
function incidentContext({ incidents = [], rows = [], now = Date.now(), readable = true } = {}) {
  const recent = rows.filter((r) => r.at === null || now - r.at <= DAY);
  const failures = recent.filter((r) => r.failed);
  const lastFailureTurn = failures.length ? Math.max(...failures.map((r) => r.turn)) : null;
  const cleanSince = lastFailureTurn === null ? null : new Set(rows.filter((r) => r.clean && r.turn > lastFailureTurn).map((r) => r.turn)).size;
  const failedTurns = [...new Set(failures.map((r) => r.turn))].sort((a, b) => a - b);
  const recoveryAllowed = lastFailureTurn === null ? !incidents.length : cleanSince >= CLEAN_TURNS_REQUIRED;
  const range = failedTurns.length ? (failedTurns.length === 1 ? `turn ${failedTurns[0]}` : `turns ${failedTurns[0]} to ${failedTurns.at(-1)}`) : null;
  return {
    readable,
    openIncidents: incidents.slice(0, 8).map((i) => ({ number: i.number, title: String(i.title || "").slice(0, 120) })),
    turnFailures24h: failedTurns.map((t) => { const r = failures.find((x) => x.turn === t); return { turn: t, status: r.status, ...(r.phase ? { phase: r.phase } : {}) }; }),
    failedTurnRange: range, lastFailureTurn, cleanTurnsSinceLastFailure: cleanSince, recoveryAllowed,
    instruction: !readable ? "The turn and incident records could not be read. Do not say anything about whether the game or an incident has recovered."
      : !incidents.length && !failedTurns.length ? "No incident is open and no turn failed in the last 24 hours."
      : `${incidents.length ? `Open incidents: ${incidents.slice(0, 8).map((i) => `#${i.number}`).join(", ")}. ` : ""}${range ? `Turn failures in the last 24 hours: ${range}. ` : ""}Figures you read for a period that overlaps these turns may be stale or incomplete: name the turn range when you quote one. Never say "recovered", "resolved" or "back to normal" until ${CLEAN_TURNS_REQUIRED} clean turns have run after the last failure${lastFailureTurn !== null ? ` (turn ${lastFailureTurn}; ${cleanSince} clean so far)` : ""}.`,
  };
}

const RECOVERY = /\b(?:recovered|recovery (?:is )?complete|back to normal|back up and running|fully (?:resolved|restored|working)|(?:the )?(?:incident|outage|problem|issue) (?:is|has been|was) (?:now )?(?:resolved|over|fixed|closed)|turns? (?:are|is) (?:running|processing) (?:normally|again)|(?:is|are) (?:now )?(?:running|processing|working) normally|all clear|(?:it|that|this|everything|all of it) (?:is|has been|was) (?:now )?(?:resolved|sorted|fixed|recovered))\b/i;
const NOT_RECOVERY = /\b(?:not|never|no|until|before|once|when|if|has not|have not|hasn't|haven't|won't|cannot|can't)\b/i;
function recoveryClaim(text) {
  return String(text || "").split(/(?<=[.!?])\s+|\n+/).find((s) => RECOVERY.test(s) && !NOT_RECOVERY.test(s)) || null;
}
// Refusal text, or null. `ctx` is incidentContext() output stored on the job.
function recoveryRefusal(ctx, text) {
  if (!ctx) return null;
  const claim = recoveryClaim(text);
  if (!claim) return null;
  if (!ctx.readable) return "Not posted: this says something has recovered, but the turn and incident records could not be read just now. Say you could not confirm it.";
  if (ctx.recoveryAllowed) return null;
  if (ctx.lastFailureTurn === null) return `Not posted: this says something has recovered, but incident ${ctx.openIncidents.map((i) => `#${i.number}`).join(", ")} is still open. Say it is still open; staff close incidents.`;
  return `Not posted: this says something has recovered, but only ${ctx.cleanTurnsSinceLastFailure} clean turn${ctx.cleanTurnsSinceLastFailure === 1 ? "" : "s"} ran after the last failure (turn ${ctx.lastFailureTurn}) and ${CLEAN_TURNS_REQUIRED} are required. Say the last failed turn and that you are waiting for more clean turns.`;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Evidence-gated claims

const TOPIC = /\b(?:money|cash|funds?|revenue|income|profits?|losses|loss|earnings?|sales?|sold|selling|payments?|paid|pay(?:ing|s)?|payouts?|salar(?:y|ies)|dividends?|wages?|production|produced?|producing|output|plants?|factor(?:y|ies)|mines?|clinics?|depots?|sites?|offices?|stores?|companies|company|balance|spending|costs?|prices?|demand|inventory|stock)\b/i;
// Outcomes that need a record whoever they are about ("clinics are running", "payments went through", "it is fixed").
const OUTCOME = /\b(?:fixed|live|paid(?: out)?|credited|refunded|processed|restored|resolved|running|operating|up and running|went through|came through)\b/i;
// Softer outcomes and causes count only when they are about the player's own side: "your revenue fell because ...".
const OUTCOME_LOOSE = /\b(?:working|works|(?:are|is) (?:now )?(?:selling|producing|earning|profitable)|(?:was|were|is|are) (?:up|down|higher|lower)|rose|fell|dropped|climbed|grew|increased|decreased)\b/i;
const OWN = /\b(?:your|you|you(?:'|’)re|yours|yourself)\b/i;
const CAUSAL = /\b(?:because|because of|due to|caused by|caused|the reason|reason (?:is|was)|thanks to|led to|result of|resulted in|as a result|did it|drove|driven by|explains?|explained by|that is why|that's why|the cause|the culprit|comes from|came from|owing to|down to)\b/i;
const NEGATED = /\b(?:not|no|never|none|nothing|cannot|can't|couldn't|unable|isn't|aren't|wasn't|weren't|hasn't|haven't|didn't|doesn't|don't|unconfirmed|unverified)\b|n['’]t\b/i;
const HEDGED = /\b(?:may|might|could|possibly|perhaps|probably|likely|seems?|appears?|suspect|suspected|guess|unclear|if|whether|would|should)\b/i;
const FUTURE = /\b(?:will|going to|once|when|after the next|next turn|soon)\b|['’]ll\b/i;
const STATUS = /^\s*(?:i(?:'|’)?m|i am|i(?:'|’)?ll|i will|let me|i(?:'|’)?ve (?:checked|looked|read)|i checked|i looked|i read|i cannot|i can't)\b/i;
const FIGURE = /\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbB]n?\b|million|billion|thousand)?/g;

function claimSentences(text) {
  return String(text || "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean).filter((s) => {
    if (/\?\s*$/.test(s) || STATUS.test(s) || NEGATED.test(s) || HEDGED.test(s) || FUTURE.test(s)) return false;
    return TOPIC.test(s) && (OUTCOME.test(s) || (OWN.test(s) && (OUTCOME_LOOSE.test(s) || CAUSAL.test(s) || figuresIn(s).length > 0)));
  });
}
const digits = (s) => String(s).replace(/[^0-9.]/g, "");
function figuresIn(sentence) {
  const bare = String(sentence).replace(/\bturns?\s+\d+(?:\s*(?:to|-|through|and)\s*\d+)?/gi, " ");
  return [...bare.matchAll(FIGURE)].map((m) => m[0].trim()).filter((f) => digits(f).replace(".", "").length >= 2 && !/^(?:19|20)\d\d$/.test(digits(f)));
}
// True when a read in this activation names the player's own character (name, username or id as a field value).
function entityRead(evidence, reporter) {
  const ev = String(evidence || "").toLowerCase();
  if (!ev || !reporter) return false;
  for (const n of [reporter.name, reporter.username]) if (n && String(n).length >= 3 && ev.includes(String(n).toLowerCase())) return true;
  if (reporter.id && new RegExp(`(?:character|characterid|sequentialid|ownerid|owner|"?id"?)\\W{0,6}${String(reporter.id).replace(/\W/g, "")}\\b`, "i").test(ev)) return true;
  return false;
}
const NAMES_TURNS = /\bturns?\s+\d+\b/i;
// [{ sentence, why }] problems, [] when every claim is backed. evidence: text of the reads this activation made.
function claimProblems({ message, evidence, reporter, incident = null, ownRead = false }) {
  const problems = [];
  const overlap = Boolean(incident && incident.readable !== false && (incident.turnFailures24h?.length || incident.openIncidents?.length));
  for (const sentence of claimSentences(message)) {
    // Figures are checked against this activation's reads by the broker's own number guard (guardNumbers); this gate asks
    // whether the player's own record was read at all, and whether a failure overlaps the period.
    if (!ownRead && !entityRead(evidence, reporter)) { problems.push({ sentence, why: "entity" }); continue; }
    if (overlap && !NAMES_TURNS.test(message)) problems.push({ sentence, why: "turn range", detail: incident.failedTurnRange || "the open incident's turns" });
  }
  return problems;
}
function claimRefusal(problems) {
  if (!problems.length) return null;
  const p = problems[0], s = `"${p.sentence.slice(0, 140)}"`;
  const way = "Say only what you read: the figure, which record it came from and which turn. Or say you have not confirmed it.";
  if (p.why === "entity") return `Not posted: ${s} is a claim about money, production, sales or whether something is running or fixed, and no read in this activation shows a record for this player's own character or company. Read their own record first (reporter_state, then the record that holds the figure). ${way}`;
  return `Not posted: ${s} covers a period with a turn failure or an open incident (${p.detail}). Name the turn range the figure covers, or say it may be incomplete for those turns.`;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. Scope: no design or balance work from tickets

const BALANCE_PATH = /(?:^|\/)(?:balance|recipes?|rates?|constants?|gameConfig|economyConfig|tuning|multipliers?|caps?)\b[^/]*\.(?:ts|js|json)$/i;
const BALANCE_WORDS = /\b(?:rebalanc\w*|nerf\w*|buff\w*|(?:cut|raise|lower|reduce|increase|rescale|retune|tune|adjust|change|set)\s+(?:the\s+)?(?:\w+\s+){0,3}(?:rates?|recipes?|caps?|multipliers?|prices?|costs?|inputs?|outputs?|yields?|margins?|tax(?:es)?|interest|demand|production|salar(?:y|ies)|wages?)\b|balance (?:change|pass|tweak)|economy (?:change|tweak|rework)|recipe (?:change|rescale|rework)|rate (?:change|cut|rise|increase))/i;
// A patch or card for a ticket lane that touches balance. files: repo paths; texts: title, body, instructions.
function balanceChange({ files = [], texts = [], economyPaths = null, workerPaths = null } = {}) {
  const hit = files.find((f) => BALANCE_PATH.test(f) || (economyPaths && economyPaths.test(f)) || (workerPaths && workerPaths.test(f)));
  if (hit) return `it changes ${hit}`;
  const t = texts.filter(Boolean).join("\n");
  const w = BALANCE_WORDS.exec(t);
  return w ? `its description says "${w[0].slice(0, 60)}"` : null;
}
const OFFER = /\b(?:(?:i|we)(?:'ll| will| can| could)?\s+(?:build|add|implement|create|design|make|ship|develop)\s+(?:you\s+)?(?:a|an|the|this|that|it|one)\b|say the word and i|want me to (?:build|add|make|design|implement)|(?:i|we) (?:could|can) (?:build|add|design) (?:a|an|the)|(?:i(?:'|’)?ll|let me) (?:draft|mock ?up|design)\b|here(?:'|’)?s a (?:mock ?up|design|proposal)|(?:a|the) (?:feature|system|mock ?up|design) (?:i|we) (?:can|could|would) (?:build|add))\b/i;
const INTENT = /\b(?:egg|the owner|owner|the developers?|the devs?|the team)\s+(?:has |have |had )?(?:said|says|told|decided|settled|wants?|wanted|intends?|intended|plans?|planned|chose|chosen|prefers?)\b|\b(?:the owner(?:'s|’s)|owner(?:'s|’s)|egg(?:'s|’s)) (?:intent|intention|plan|view|position)\b|\bby design\b|\bworking as intended\b|\bas (?:the owner|egg) intended\b/i;
const FEATURE_NOTICE = "Not posted: this offers to build or design something for the player. Ticket lanes investigate and answer; they do not offer features or mockups. Say what you found, and that staff will review the request.";
const INTENT_NOTICE = "Not posted: this quotes or describes what the owner, the developers or staff intend or decided. Do not narrate anyone's intentions to a player. Say what the game does, from a read, and that staff will review it if the player disagrees.";
function scopeProblem(text) {
  const t = String(text || "");
  if (OFFER.test(t)) return { kind: "offer", refusal: FEATURE_NOTICE };
  const sentence = t.split(/(?<=[.!?])\s+|\n+/).find((s) => INTENT.test(s) && !NEGATED.test(s));
  if (sentence) return { kind: "intent", refusal: INTENT_NOTICE, sentence: sentence.slice(0, 160) };
  return null;
}
const STAFF_REVIEW_LINE = "I have passed this to staff for review. They decide balance and design changes, so I will not change or promise anything here.";
function ownerCardBody({ ticket, why, detail }) {
  return {
    title: `Ticket ${ticket}: owner decision, ${String(why).slice(0, 80)}`,
    detail: `${String(detail || "").slice(0, 3000)}\n\nA ticket lane may not change balance, rates, recipes or turn-engine numbers, offer features, or speak for the owner. Filed once per ticket for the owner to decide. Evidence above is what the lane read; nothing was shipped or promised to the player.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Auto-escalation

const CHALLENGE = /\b(?:are you sure|you(?:'re| are) wrong|that(?:'s| is) (?:wrong|not true|false|incorrect|not right)|that is not true|not true|wrong answer|you didn(?:'|’)?t (?:answer|read|listen|understand|help)|you did not (?:answer|read|listen|understand)|didn(?:'|’)?t answer (?:my|the) question|not what i asked|stop (?:lying|guessing)|you (?:keep|are) (?:guessing|lying|repeating)|useless|dumb (?:ai|bot)|stupid (?:ai|bot)|i want (?:a )?(?:human|person|staff|a mod|a developer)|talk to (?:a )?(?:human|person|staff|someone)|bot (?:is|keeps) (?:wrong|useless|broken)|(?:this|that) (?:is|was) (?:wrong|incorrect|bullshit|nonsense)|doesn(?:'|’)?t make sense)\b/i;
function challenge(text) { const m = CHALLENGE.exec(String(text || "")); return m ? m[0] : null; }
const CORRECTIONS_LIMIT = 2;
const STAFF_REVIEWING = "Staff are reviewing this ticket. I have stopped replying here so a person can pick it up.";
// Decide whether to hand the ticket to staff. input: { playerText, corrections, wakeCapped, already }.
function escalation({ playerText = "", corrections = 0, wakeCapped = false, already = false } = {}) {
  if (already) return null;
  const c = challenge(playerText);
  if (c) return { why: "player_challenge", detail: `the player wrote "${c}"` };
  if (corrections >= CORRECTIONS_LIMIT) return { why: "repeated_corrections", detail: `Keir corrected itself ${corrections} times on this ticket` };
  if (wakeCapped) return { why: "wake_cap", detail: "the ticket hit its wake cap" };
  return null;
}

module.exports = { incidentContext, turnRows, failureRows, recoveryClaim, recoveryRefusal, claimSentences, claimProblems, claimRefusal, entityRead, balanceChange, scopeProblem, ownerCardBody, challenge, escalation, STAFF_REVIEW_LINE, STAFF_REVIEWING, CLEAN_TURNS_REQUIRED, CORRECTIONS_LIMIT, FEATURE_NOTICE, INTENT_NOTICE };
