"use strict";
// Jev picks each activation's reasoning effort from what the task actually is.
// It is advisory and bounded: unsure or unavailable means medium, a task that
// just ran out of turns or had its completion refused never drops below high,
// and each runner is clamped to the levels its CLI accepts.
const JEV = "/root/bin/lib/jev.mjs";
// Keir 9: Muse Code accepts max (its tuned top tier); every other runner is clamped below it.
const ORDER = ["low", "medium", "high", "xhigh", "max"];
const RUNNER_MAX = { agy: "high", muse: "max", claude: "xhigh" };
const DECISIVE = 0.35;

const CRITERIA = {
  low: "A greeting, thanks, acknowledgement or a single obvious fact; no investigation or reconciling of numbers.",
  medium: "A normal question, status check or routine ticket follow-up that needs a few tool reads and a short answer.",
  high: "A bug investigation, figures that must be reconciled, anything about money or a player's losses, or a previous attempt that was wrong, corrected or ran out of time.",
  xhigh: "Writing, rebasing or reviewing code, a multi-file fix, economy or turn-engine reasoning, or a heal, merge or promotion decision.",
};

// Gemini at high effort ran past the 90s conversation budget 4 times in the
// 2026-10-12 benchmark; at medium it finished. Cap it there in that lane.
const QUICK_MAX = { agy: "medium" };
const clamp = (level, runner, quick = false) => ORDER[Math.min(ORDER.indexOf(level), ORDER.indexOf(RUNNER_MAX[runner] || "high"), quick && QUICK_MAX[runner] ? ORDER.indexOf(QUICK_MAX[runner]) : 99)];

async function chooseEffort(job, { quick, runner, jev = (spec) => process.env.KEIR_JEV === "off" ? Promise.resolve(null) : import(JEV).then((m) => m.choose(spec)) } = {}) {
  const recent = (job.history || []).slice(-4);
  const struggled = recent.some((h) => ["turn-limit", "refused"].includes(h.kind));
  const request = [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter(Boolean).slice(-4).map((s) => String(s.content || "").slice(0, 600));
  const criteria = quick ? { low: CRITERIA.low, medium: CRITERIA.medium, high: CRITERIA.high } : CRITERIA;
  let level = "medium", via = "default", confidence = null;
  // Keir 4.0: the intake tags already say how hard this is; no second call.
  const TAGGED = { trivial: "low", simple: "medium", moderate: "high", hard: "xhigh" };
  if (job.tags?.complexity && TAGGED[job.tags.complexity]) { level = job.tags.kind === "banter" ? "low" : TAGGED[job.tags.complexity]; via = "tags"; }
  else try {
    const r = await jev({
      state: { lane: quick ? "conversation" : "worker", kind: job.kind, requester: job.role, ticket: job.ticket || null, request, currentSummary: String(job.summary || "").slice(0, 800),
        hasOpenPullRequests: Boolean(job.pullRequests?.length), previousActivations: recent.map((h) => `${h.kind}: ${String(h.summary || "").slice(0, 160)}`) },
      instruction: "How much reasoning effort does the assistant's next step on this task need? Pick the lowest level that will get it right.",
      criteria, timeoutMs: quick ? 6000 : 10000,
    });
    if (r?.choice && (r.confidence === null || r.confidence >= DECISIVE)) { level = r.choice; via = "jev"; confidence = r.confidence; }
  } catch {}
  if (struggled && ORDER.indexOf(level) < ORDER.indexOf("high")) { level = "high"; via += "+floor"; }
  return { effort: clamp(level, runner, quick), via, confidence };
}

// Keir 9: for a ticket the operator override is a ceiling, not a fixed value. Code-only:
// a plain first-time rules question runs at medium, everything else stays at the ceiling.
const MONEY = /\$|£|€|\bmoney\b|\bcash\b|\blost\b|\blosses?\b|\bloss\b|\bbalance\b|\bfunds?\b|\brefund|\bcharged?\b|\bmissing\b|\d[\d,.]{2,}|\d\s*%/i;
const FAULT = /\bbug\b|\bglitch|\bbroken\b|\bcrash|\berror\b|\bturn\b|\boutage\b|\bdown\b|\bstuck\b|\bnot working\b|\bdoesn'?t work\b/i;
const DISPUTE = /\b(wrong|incorrect|not (right|true|correct)|that'?s not|isn'?t (right|true|correct)|still (wrong|broken|not|happening)|you('re| are) (wrong|mistaken)|doesn'?t (match|add up)|disagree|didn'?t (help|answer)|try again)\b/i;
const QUESTION = /\bhow (do|does|can|should|to)\b|\bwhat (is|are|does|happens)\b|\bwhy (is|are|does|do|can'?t)\b|\bcan i\b|\bis it possible\b|\bwhere (do|can|is)\b|\bwhen (does|do|can)\b|\?/i;

function ticketEffort(job, ceiling) {
  const playerText = [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter(Boolean).map((s) => String(s.content || "")).join("\n");
  const history = job.history || [];
  const reason = (r) => ({ level: ceiling, reason: r });
  if ((job.history || []).some((h) => ["turn-limit", "refused", "retracted", "correction"].includes(h.kind))) return reason("earlier attempt refused, retracted or out of steps");
  if (DISPUTE.test(playerText) || (job.inbox || []).some((m) => m.disputed)) return reason("player disputed an answer");
  if (history.length || (job.requestInbox || []).some((m) => m.role === "assistant")) return reason("not the first activation");
  const kind = job.tags?.kind;
  if (kind && kind !== "mechanics_question") return reason(`intake kind ${kind}`);
  if (["moderate", "hard"].includes(job.tags?.complexity)) return reason(`intake complexity ${job.tags.complexity}`);
  if (job.incidentCandidates?.length) return reason("incident candidate");
  if (MONEY.test(playerText)) return reason("money or figures");
  if (FAULT.test(playerText)) return reason("bug, turn or outage");
  if (kind !== "mechanics_question" && !QUESTION.test(playerText)) return reason("not plainly a rules question");
  return { level: "medium", reason: "first-time rules question" };
}

async function activationEffort(job, { config, quick, runner }) {
  if (ORDER.includes(config.effortOverride) && job.ticket) {
    const { level, reason } = ticketEffort(job, config.effortOverride);
    const effort = ORDER[Math.min(ORDER.indexOf(level), ORDER.indexOf(config.effortOverride))];
    return { effort: clamp(effort, runner, quick), via: `operator-override:${effort === config.effortOverride ? "ceiling" : "lowered"}:${reason}` };
  }
  if (ORDER.includes(config.effortOverride)) return { effort: clamp(config.effortOverride, runner, quick), via: "operator-override" };
  // Route defaults are model choices, not manual reasoning overrides. Jev owns
  // effort unless an explicit benchmark or task effort override says otherwise.
  if (job.internalProbe && job.effortPin) return { effort: clamp(job.effortPin, runner, quick), via: "benchmark" };
  if (ORDER.includes(job.effortOverride)) return { effort: clamp(job.effortOverride, runner, quick), via: "owner-override" };
  // A spoken answer is short by contract and anything deeper is handed off, so
  // voice skips the effort classifier call and runs at the lowest level.
  if (quick && job.voiceMode && !job.codingParent) return { effort: clamp("low", runner, quick), via: "voice" };
  if (config.dynamicEffort === false) return { effort: "medium", via: "fixed" };
  const chosen = await (config.chooseEffort || chooseEffort)(job, { quick, runner });
  return capToRoute(job, chosen, { config, quick, runner });
}

// Keir 6.1.1: a route's effort (runner:model@low) is the level that route was
// benchmarked at. Jev's tags overrode it upward, so production ran DeepSeek at
// high where KeirBench measured low/medium: 6.0 ticket activations took twice
// the rounds and time the bench showed. The route effort is now a ceiling.
// Jev may still pick lower, and a task that just hit its turn limit or had a
// completion refused may go one level above. KEIR_ROUTE_EFFORT_CEILING=0 reverts.
function capToRoute(job, chosen, { config = {}, quick = false, runner } = {}) {
  if (config.routeEffortCeiling === false) return chosen;
  const route = job.provider?.routeEffort || job.effortPin;
  if (!ORDER.includes(route) || !ORDER.includes(chosen.effort)) return chosen;
  const struggled = (job.history || []).slice(-4).some((h) => ["turn-limit", "refused"].includes(h.kind));
  const cap = ORDER[Math.min(ORDER.indexOf(route) + (struggled ? 1 : 0), ORDER.length - 1)];
  if (ORDER.indexOf(chosen.effort) <= ORDER.indexOf(cap)) return chosen;
  return { ...chosen, effort: clamp(cap, runner, quick), via: `${chosen.via}+route-cap` };
}
module.exports = { chooseEffort, activationEffort, ticketEffort, capToRoute, CRITERIA, clamp };
