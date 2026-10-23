"use strict";
// Some API models (DeepSeek v4-pro, 2026-10-17) occasionally print their tool
// calls as text instead of calling the tool. That text is never an answer.
const MARKUP = /<\/?(?:tool_calls?|invoke|function_calls)\b|<parameter name=|<\｜tool▁calls|<[｜|]+DSML[｜|]+|\bmcp__keir__[a-z_]+["']?>/i;
// Planning narration is not an answer either ("I'll start by understanding the
// available tools...", posted to ticket 1602 on 2026-10-17).
const NARRATION = /^\s*(?:I(?:'|’)ll|I will|Let me|First,? I(?:'|’)ll)\s+(?:start|begin|first|discover|look at the (?:available )?tools|understand(?:ing)? the (?:available tools|current state))/i;
const leaked = (text) => MARKUP.test(String(text || "")) || NARRATION.test(String(text || ""));
module.exports = { leaked };
