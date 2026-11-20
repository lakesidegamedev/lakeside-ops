"use strict";

const allMarkets = /\b(?:all|every|each)\s+(?:the\s+)?(?:sectors?|markets?|commodit(?:y|ies))\b/i;
const followup = /\b(?:full depth|full detail|full report|same depth|like (?:you did|freight)|audit|aduit)\b/i;
const skip = /\b(?:stop|nevermind|never mind|skip|no need|do not|don't|don’t|no (?:report|link|table)|instead)\b/i;

function requestScope(message, history) {
  const text = String(message?.content || "");
  if (!message?.messageId || !message.authorId || skip.test(text)) return null;
  let question = text;
  if (!allMarkets.test(text)) {
    if (!followup.test(text)) return null;
    const at = Date.parse(message.at);
    const prior = (history || []).filter(row => row.authorId === message.authorId && row.id !== message.messageId &&
      row.messageId !== message.messageId && at >= Date.parse(row.at) && at - Date.parse(row.at) < 15 * 60000).at(-1);
    if (!allMarkets.test(prior?.content) || skip.test(prior.content)) return null;
    question = prior.content + "\n" + text;
  }
  // A foreground read is an optimization for an explicitly named market.
  // Comparisons, historical periods and ambiguous geography go through normal investigation.
  if (/\b(?:versus|vs\.?|compare countries|both countries|other countries)\b/i.test(question)) return null;
  const aliases = { US: /\bUS\b|\bUnited States\b/, UK: /\bUK\b|\bUnited Kingdom\b/, CA: /\bCA\b|\bCanada\b/,
    AU: /\bAU\b|\bAustralia\b/, FR: /\bFR\b|\bFrance\b/, DE: /\bDE\b|\bGermany\b/, JP: /\bJP\b|\bJapan\b/ };
  const codes = Object.keys(aliases).filter(code => aliases[code].test(question));
  const world = /\b(?:worldwide|global|world market)\b/i.test(question);
  if (codes.length + Number(world) !== 1 || /\b(?:yesterday|last week|previous|since|between|from turn|over time|turns)\b/i.test(question)) return null;
  const turns = [...question.matchAll(/\bturn\s+#?(\d+)\b/gi)].map(m => Number(m[1]));
  if (new Set(turns).size > 1) return null;
  return { args: world ? {} : { country: codes[0] }, turn: turns[0] ?? null };
}

async function prepare({ broker, ledger, job, message, signal }) {
  if (!["ticket", "conversation"].includes(job.kind) || job.replyChannel === "app" || job.marketBriefSource === message?.messageId) return null;
  const channel = job.channelId || job.replyChannel;
  if (!channel || message?.channelId !== channel || !broker.readable?.(job, "gamestate", "commodity_market")) return null;
  const scope = requestScope(message, ledger.data.channelContext?.[channel]);
  if (!scope) return null;
  const result = await broker.tool(job, "read_tool", { server: "gamestate", tool: "commodity_market", args: scope.args }, signal);
  if (!result?.presentation?.observation || !Number.isSafeInteger(result.marketTurn) ||
      (scope.args.country ? result.scope !== "country" || result.country !== scope.args.country : result.scope !== "world")) return null;
  if (scope.turn !== null && scope.turn !== result.marketTurn) return { requestedTurn: scope.turn, availableTurn: result.marketTurn, instruction: "This snapshot is for a different turn. Do not use it to answer the historical question." };
  const brief = { scope: result.country || result.scope, asOfTurn: result.marketTurn, summary: result.summary, instruction: "Give the measured market finding in the first sentence, including shortages and surpluses. The scoped snapshot is already read. Explain what still requires investigation." };
  if (result.commodities?.length >= 12) {
    try {
      const p = await broker.tool(job, "present_evidence", { observation: result.presentation.observation }, signal);
      brief.report = p.report;
    } catch { brief.report = "unavailable"; }
  }
  job.marketBriefSource = message.messageId;
  ledger.save();
  return brief;
}

module.exports = { requestScope, prepare };
