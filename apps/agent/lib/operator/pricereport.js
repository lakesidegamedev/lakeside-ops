"use strict";
// Keir 10.2.1 (ticket 1841, after 1837): "why does 1 depot cost 22 million dollars" is a player reporting a number as wrong,
// not asking how pricing works. The fast lane answered it 2 seconds after the intro with a made-up explanation of what the price
// is composed of. A figure question about a cost or a value is routed to the investigating lane, the live value is read before
// any reply, and a price far out of proportion to the company's cash is reported as a possible bug. Pure functions only.

const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
// "$22.2M", "22 million dollars", "3.7billion", "$1,300,000", "4.6M".
const FIGURE = /(?:\$\s*)?(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|trillion|mil|mm|bn|[kmbt])?\b(?!\s*(?:%|percent|turns?|units?|days?|hours?|x\b))/gi;
const COST_Q = /\bwhy\b[^?\n]{0,80}\b(?:costs?|costing|expensive|pric(?:e|ed|ey)|so\s+(?:much|high|low|cheap|little|big|small)|that\s+(?:much|high|low))\b|\b(?:says?|shows?|costs?|quoted?|charg(?:es|ing)|asks?)\s+(?:me\s+)?(?:for\s+|it\s+)?(?:costs?\s+)?\$?\s*\d[\d,.]*\s*(?:thousand|million|billion|mil|mm|bn|[kmb])\b|\b(?:so|too|way|ridiculously|absurdly|insanely)\s+(?:expensive|high|low|cheap)\b/i;
const figuresIn = (text) => {
  const out = [];
  for (const m of String(text || "").matchAll(FIGURE)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const scale = m[2] ? SCALE[m[2].toLowerCase()] : 1;
    const value = n * scale;
    if (m[2] || /\$/.test(m[0]) || value >= 10000) out.push({ value, text: m[0].trim() });
  }
  return out;
};

// Is this player text a report of a suspect number (a cost or value question with a figure in it)?
function isSuspectNumberReport(text) {
  const t = String(text || "");
  return COST_Q.test(t) && figuresIn(t).length > 0;
}
const reportedFigure = (text) => figuresIn(text).sort((a, b) => b.value - a.value)[0] || null;

// The company's cash as read from live data text ("cash": 4600000, cash $4.6M, "cashOnHand").
function cashIn(texts) {
  for (const t of texts || []) {
    const m = /\b(?:cash(?:\s*on\s*hand)?|cashBalance|balance|treasury)["']?\s*[:=]?\s*"?\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|mil|mm|bn|[kmb])?\b/i.exec(String(t || ""));
    if (m) { const v = Number(m[1].replace(/,/g, "")) * (m[2] ? SCALE[m[2].toLowerCase()] : 1); if (Number.isFinite(v) && v > 0) return v; }
  }
  return null;
}
// Out of proportion: one building costing more than the company's whole cash (with a margin for a purchase it could finance).
const OUT_OF_PROPORTION = 2;
const outOfProportion = (figure, cash) => Boolean(figure && cash && figure.value >= cash * OUT_OF_PROPORTION);

// A reply that explains how a price is composed or defends it: "X is the build price for ...", "priced off ...", "A, B and C move it up or down".
const EXPLAINS = /\b(?:is|was)\s+(?:the|a)\s+(?:build\s+|total\s+|base\s+)?(?:price|cost)\s+(?:for|of)\b|\bpric(?:ed|es)\s+(?:off|by|from|at)\b|\b(?:moves?|raises?|lowers?|shifts?|pushes?|drives?)\s+(?:it|the (?:price|cost))\s+(?:up\s+or\s+down|up|down)\b|\b(?:not|isn'?t)\s+a\s+fee\b|\bprice\s+breakdown\b/i;
const explainsPrice = (message) => EXPLAINS.test(String(message || ""));
// What a reply to a suspected wrong number may say before the check is done: that it looks wrong and is being checked.
const LOOKS_WRONG = /\b(?:looks?|seems?|sounds?)\s+(?:wrong|off|too high|too low|out of proportion|far too)\b|\bpossible bug\b|\bchecking (?:it|this|that)\b/i;

const REFUSAL = (figure, why) => `Not posted: the player is reporting ${figure ? figure.text : "a figure"} as a wrong-looking number, not asking how the price is composed. ${why} A reply that explains or defends the price is allowed only after a live read of the value and the company's cash or typical prices shows the number is expected. Read the corporation (gamestate trace_corp or the build quote) and compare. If the price is out of proportion (about 2x the company's cash or far above other sectors), say plainly that it looks wrong and you are checking it as a possible bug, and raise_to_developers with the figures you read.`;

// null when the post is fine, else the refusal text. ctx: { playerText, reads (non-self read texts), gameRead (bool), backed (bool: reads back the explanation) }.
function refusal(message, ctx = {}) {
  if (!isSuspectNumberReport(ctx.playerText) || !explainsPrice(message)) return null;
  const figure = reportedFigure(ctx.playerText);
  if (!ctx.gameRead) return REFUSAL(figure, "Nothing has been read on this ticket yet.");
  const cash = cashIn(ctx.reads);
  if (outOfProportion(figure, cash)) return REFUSAL(figure, `The company's cash read as ${Math.round(cash).toLocaleString("en-US")}, so ${figure.text} is out of proportion.`);
  if (!ctx.backed) return REFUSAL(figure, "No read shows the price is made up the way this says.");
  return null;
}

module.exports = { figuresIn, isSuspectNumberReport, reportedFigure, cashIn, outOfProportion, explainsPrice, refusal, LOOKS_WRONG, OUT_OF_PROPORTION };
