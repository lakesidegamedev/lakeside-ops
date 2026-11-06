"use strict";
// Some API models (DeepSeek v4-pro, 2026-10-17) occasionally print their tool
// calls as text instead of calling the tool. That text is never an answer.
const MARKUP = /<\/?(?:tool_calls?|invoke|function_calls?|function|tool_use|tool_result)\b|<parameter name=|<\｜tool▁calls|<\/?[｜|]+DSML[｜|]+|\bmcp__keir__[a-z_]+["']?>/i;
// Keir 8.4 (owner, 2026-11-06): the owner reported tool calls leaking into player-visible text.
// The markup test above only covered some provider dialects, and only the reply, checkpoint and
// finish tools ran it. These shapes are caught on every public path (broker publicText and the
// public outbox): other dialects, a tool call printed as JSON or a fenced block, a tool name, and
// the broker's own refusal and instruction text echoed back at the player.
const DIALECT = /\bantml:|\btool_use\b|\btool_use_id\b|<\|(?:tool|python_tag|im_start|im_end)|\[TOOL_CALLS?\]|\bmcp__[a-z0-9-]+__[a-z0-9_]+/i;
const JSON_CALL = /["'](?:tool|tool_name|function|name|recipient_name)["']\s*:\s*["'][A-Za-z0-9_.:-]{2,60}["'][^]{0,400}?["'](?:args|arguments|input|parameters)["']\s*:\s*[{[]|["'](?:args|arguments|input|parameters)["']\s*:\s*[{[][^]{0,600}?["'](?:tool|tool_name)["']\s*:\s*["'][A-Za-z0-9_.:-]{2,60}["']/i;
const FENCED_CALL = /```(?:json|tool_call|tool_code|xml)?\s*[{<][^]{0,800}?(?:"tool"|"tool_name"|"args"|"arguments"|<invoke|<function)/i;
// What the broker tells the model when it refuses a call. Quoted to a player it is leaked machinery.
const ECHO = /\bNot posted:|\bmake no more tool calls\b|\btask execution authority is inactive\b|\bCall the tool through the tool interface\b|\b(?:support_action|channel_reply|progress_update|raise_to_developers|delegate_investigation|read_tool|submit_result|load_context|status_card)\b/i;
// Planning narration is not an answer either ("I'll start by understanding the
// available tools...", posted to ticket 1602 on 2026-10-17).
const NARRATION = /^\s*(?:I(?:'|’)ll|I will|Let me|First,? I(?:'|’)ll)\s+(?:start|begin|first|discover|look at the (?:available )?tools|understand(?:ing)? the (?:available tools|current state))/i;
const hasToolMarkup = (text) => MARKUP.test(String(text || ""));
const leaked = (text) => hasToolMarkup(text) || NARRATION.test(String(text || ""));
// Any shape of tool-call text or broker machinery in text that a person outside Keir will read.
function outboundLeak(text) {
  const t = String(text || "");
  const checks = [["tool_markup", MARKUP], ["tool_dialect", DIALECT], ["tool_json", JSON_CALL], ["tool_fence", FENCED_CALL], ["broker_echo", ECHO]];
  for (const [kind, re] of checks) { const m = re.exec(t); if (m) return { kind, match: m[0].slice(0, 80) }; }
  return null;
}
module.exports = { leaked, hasToolMarkup, outboundLeak };
