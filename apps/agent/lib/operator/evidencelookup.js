"use strict";
// Keir 11.1: the broker's side of ops-knowledge support_evidence_lookup.
//
// The lookup maps a support question to the definition, units and the one gamestate read that answers it. It is
// static, public and read-only, so a player ping may call it (and nothing else in ops-knowledge). What reaches it is
// built here, never taken from the model:
//   question          the model's wording with names, ids, mentions, links and emails removed
//   topic             one of the four seeded topics, or absent
//   identifiers       a two-letter country and a commodity key, nothing else (no character, corporation, turn)
//   availableTools    the gamestate tools this task can really call right now, from the live tools/list
// The answer is re-checked against the same live list, so a tool that is not deployed (or not in this task's scope)
// comes back as a stated gap whatever the server or the model believed.

const SERVER = "ops-knowledge", TOOL = "support_evidence_lookup";
const TOPICS = ["national_gdp", "market_demand", "corp_revenue_profit", "action_points"];
const REPORTER_TOOLS = new Set(["reporter_operating_results", "reporter_action_points"]);
const COMMODITY = /^[a-z][a-z0-9_]{1,59}$/;
const COUNTRY = /^[A-Za-z]{2}$/;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The question with anything that names a person, an account or a place on the web taken out. names: known reporter names. */
function scrub(question, names = []) {
  let q = String(question ?? "");
  q = q.replace(/https?:\/\/\S+/gi, " ").replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, " ")
    .replace(/<@[!&]?\d+>|<#\d+>|@\w{2,32}/g, " ").replace(/\/character\/\d+/gi, " ").replace(/\b\d{15,}\b/g, " ")
    .replace(/\b(character|account|player|user|reporter|corporation|corp|company)\s+(?:id\s*)?#?\d+\b/gi, "$1");
  for (const n of names.filter((x) => typeof x === "string" && x.trim().length >= 3)) q = q.replace(new RegExp(escapeRe(n.trim()), "gi"), " ");
  return q.replace(/\s+/g, " ").trim().slice(0, 600);
}

/** Exactly the arguments the lookup accepts, built from the model's input. Throws a fixable error when nothing usable is left. */
function lookupArgs(input = {}, { names = [], availableTools } = {}) {
  const question = scrub(input.question, names);
  if (question.length < 3) throw new Error("support_evidence_lookup needs the question in the reporter's words (at least a few words, with no names or ids). Ask it as the measure, for example: is GDP the level or the growth, listed or filled demand, revenue or operating profit, action points granted or spent.");
  const out = { question };
  if (TOPICS.includes(input.topic)) out.topic = input.topic;
  const ids = input.identifiers && typeof input.identifiers === "object" ? input.identifiers : {};
  const identifiers = {};
  if (COUNTRY.test(String(ids.country || ""))) identifiers.country = String(ids.country).toUpperCase();
  if (COMMODITY.test(String(ids.commodity || ""))) identifiers.commodity = String(ids.commodity);
  if (Object.keys(identifiers).length) out.identifiers = identifiers;
  if (Array.isArray(availableTools)) out.availableTools = availableTools.slice(0, 200);
  return out;
}

/** Names of the gamestate tools this task can call: listed by the server now and inside this task's read scope. */
function callableTools(listed, { readable, hasTicket }) {
  return (Array.isArray(listed) ? listed : []).map((t) => String(t?.name || "")).filter((n) => n && readable(n) && (hasTicket || !REPORTER_TOOLS.has(n)));
}

const readOf = (rec) => (rec && typeof rec === "object" ? (rec.read && typeof rec.read === "object" ? rec.read : rec) : null);

/**
 * Re-check a lookup answer against the live tool list. callable is a set of tool names, or null when the list could
 * not be read (then every read is marked unknown, never callable). Returns a new object; the input is not changed.
 */
function degrade(result, callable) {
  if (!result || typeof result !== "object" || !Array.isArray(result.results)) return result;
  const known = callable instanceof Set ? callable : null;
  const results = result.results.map((r) => {
    const rec = r?.recommendation;
    const read = readOf(rec);
    if (!read || !read.tool) return r;
    if (!known) return { ...r, recommendation: { ...rec, callable: "unknown", note: "The live tool list could not be read. Try the read; if it is refused or missing, say it was not checked." } };
    if (known.has(read.tool)) return { ...r, recommendation: { ...rec, callable: true } };
    return { ...r, recommendation: { gap: true, wanted: read.tool, callable: false, note: `${read.tool} is not available to this task right now, so that figure was not checked. Say so plainly. Give the definition and what you can read, and never substitute another measure for it.` }, alternatives: (r.alternatives || []).map((a) => ({ ...a, callable: known.has(a.tool) })) };
  });
  return { ...result, results };
}

// The measures a player confuses most, from the historical cases that went unanswered. Used only to hand a quick
// turn a pointer to the lookup; a matching question is offered the read, never forced into it.
const PATTERNS = [
  ["national_gdp", /\bgdp\b|gross domestic|\beconomy (?:is|was|got|fell|dropped|rose|shrank|grew)\b|\b(?:national|country'?s?) (?:growth|economy)\b/i],
  ["market_demand", /\b(?:all|every|each|other)\s+(?:sectors?|commodit\w+|markets?)\b|\bsectors?\b.*\blike you did\b|\b(?:listed|filled|funded|unmet|offered)\b.*\b(?:demand|supply|market)\b|\bdemand\b.*\b(?:listed|filled|funded|unmet)\b|\b(?:sold|offered)\b.*\bcommodit|\bcommodit\w*\b.*\b(?:sold|offered|demand|supply)\b/i],
  ["corp_revenue_profit", /\b(?:revenue|sales|turnover)\b.*\b(?:profit|income|fees?|costs?)\b|\b(?:profit|income)\b.*\b(?:revenue|sales|fees?)\b|\boperating (?:profit|income)\b|\bmy (?:shop|store|site)s?\b.*\b(?:profit|sales|made|earn)/i],
  ["action_points", /action ?points?\b|\bAPs?\b(?! )|\bmy actions\b.*\b(?:gone|missing|lost|spent|used)\b/i],
];
const SMALL_TALK = /^\s*(?:thanks?|thank you|thx|ty|ok(?:ay)?|cheers|great|cool|got it|stop|no more updates|nevermind|never mind|that'?s all|nvm|done|resolved)\b[\s.!,]*(?:thanks?|thank you|everyone|all)?[\s.!]*$/i;

/** The seeded topic a question looks like, or null. Navigation, thanks and stop requests never match. */
function topicFor(question) {
  const q = String(question || "").trim();
  if (q.length < 12 || SMALL_TALK.test(q)) return null;
  if (/^\s*(?:where (?:is|are|can i find|do i find)|how do i (?:find|get to|open)|which (?:page|tab|menu))\b/i.test(q) && !/\b(?:wrong|differ|doesn'?t add|does not add|mismatch|why)\b/i.test(q)) return null;
  const hits = PATTERNS.filter(([, re]) => re.test(q)).map(([id]) => id);
  return hits.length === 1 ? hits[0] : null;
}

/** The quick-turn pointer: a call the model may make first. Null when the wording is not one of the confusable measures. */
function hintFor(question, { available = true } = {}) {
  const topic = available ? topicFor(question) : null;
  if (!topic) return null;
  return { server: SERVER, tool: TOOL, args: { question: "<the question as a measure, no names or ids>", topic }, instruction: "This question names a measure that is easy to confuse. One support_evidence_lookup call gives the definition, units and the exact read for it, and says what cannot be read today. Use it only if you are about to quote a figure or explain a difference; a navigation question, thanks or stop gets a short answer with no lookup." };
}


// A reply that leans on the message before it ("But I don't think I did"). Navigation, refunds, stop requests and thanks
// are never elliptical: they are read on their own and a prior topic is not brought back over them.
const ELLIPTICAL = /^\s*(?:but|and|so|also|hmm+|no|yes|yeah|well|then|still|why|how come|that|those|it|this|i (?:don'?t|do not|didn'?t|did not|dont|still|doubt|think|believe)|are you sure|really|that'?s not)\b/i;
const NOT_A_FOLLOWUP = /\b(?:refund|reimburs|compensat|cancel|stop|unsubscribe|thanks?|thank you|where (?:is|are|do|can)|how do i|which (?:page|tab|menu))\b/i;
const PRESSURE = 400;

/**
 * The foreground (reply-only) turn's pointer. rows: the human messages in this channel, oldest first, each { authorId, content }.
 * The latest message is read on its own first. Only when it names no measure and leans on what came before does the
 * immediately preceding message from the same person supply the topic. Returns null when there is nothing to point at.
 */
function foregroundHint(rows, { available = true } = {}) {
  const list = (rows || []).filter((r) => r && typeof r.content === "string" && r.content.trim());
  const latest = list.at(-1);
  if (!latest || !available) return null;
  let basis = null, topic = topicFor(latest.content);
  if (topic) basis = "latest";
  else if (!SMALL_TALK.test(latest.content) && !NOT_A_FOLLOWUP.test(latest.content) && latest.content.length <= PRESSURE && ELLIPTICAL.test(latest.content)) {
    const prior = list.slice(0, -1).reverse().find((r) => r.authorId === latest.authorId);
    const t = prior && !SMALL_TALK.test(prior.content) ? topicFor(prior.content) : null;
    if (t) { topic = t; basis = "previous"; }
  }
  if (!topic) return null;
  const question = scrub(basis === "previous" ? list.slice(0, -1).reverse().find((r) => r.authorId === latest.authorId).content : latest.content);
  const reads = { national_gdp: "market_history", market_demand: "market_history or commodity_market", corp_revenue_profit: "reporter_operating_results", action_points: "reporter_action_points" }[topic];
  return { server: SERVER, tool: TOOL, args: { question, topic }, basis: basis === "previous" ? "The latest message is a follow-up; the topic comes from this person's previous question." : "From the latest message.",
    allowedReads: "support_evidence_lookup (ops-knowledge) and gamestate market_history, commodity_market, reporter_operating_results, reporter_action_points, country_fiscal. Nothing else can be read in this quick turn.",
    instruction: `Try before you hedge. Call support_evidence_lookup once with this question (read_tool, server ${SERVER}), then make the one read it names (usually ${reads}), then answer from what came back. If a read is refused or not available, say exactly which figure was not checked and why, and that the full investigation continues. Never say "I haven't confirmed it" without having tried. For a sector or commodity sweep ("all sectors"), use market_history or commodity_market the same way you did for the first one. Reporter figures show only in this ticket.` };
}

module.exports = { foregroundHint, SERVER, TOOL, TOPICS, REPORTER_TOOLS, scrub, lookupArgs, callableTools, degrade, topicFor, hintFor };
