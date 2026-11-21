"use strict";
const conversationTurn = require("./conversationturn");
const evidenceDelivery = require("./evidencedelivery");
const { JOB_TERMINAL } = require("./machines");

const { noDashes, GITHUB_OWNER, GAME_REPO, canonicalRepository, canonicalGithubUrl, repositoryName, pullRequestNumber } = require("./github");
// AHDGame's custom-rules check fails any PR without a ticked "Conflict of
// interest" section, which left promotes blocked. A promote ships commits that
// already passed review, so it never touches a holding of its own.
const { DISCLOSURE: NO_CONFLICT_DISCLOSURE, withDisclosure } = require("./prdisclosure");
// Minutes between checks for a task waiting with nothing subscribed and no
// reply owed: the first is a normal look, then it settles into a slow recheck.
const QUIET_WAITS = [15, 30, 60, 120];
// Refusals that mean "not now" (the player already has enough posts or this exact
// news), not "that answer was wrong". They owe the player nothing new, so they must
// not arm replyRefusedPending: with both armed, Keir could neither post nor finish
// (2026-11-02: 70 refusals across tickets 1749 to 1755).
const trustLimits = require("./limits"), trustlog = require("./trustlog"), changeClassMod = require("./changeclass");
// A post asking the player who they are (ticket 1829: "If you share your character name here").
const ASKS_IDENTITY = /\bwhich (?:character|account)\b[^.!\n]{0,40}\?|\b(?:share|tell me|send|give me|let me know|post|confirm|what(?:'|’)?s|what is|which is)\b[^.?!\n]{0,40}\b(?:(?:your|the) )?(?:character(?:'s|’s)? name|character|in-?game name|username|user name|account(?: name)?|ign)\b/i;
const PACING_REFUSAL = /read the institution configuration|nothing in this ticket has read the game code|your last message to the player is still the newest|the player was already answered \d+ min ago|Keir has posted \d+ times in ticket|this task posted in ticket|already got this update|already has this waiting state|waiting on the owner's decision|another Keir task updated ticket|a developer's own task \([^)]*\) is handling a request|not appear in anything this ticket has read|no code lookup on this ticket has returned anything|nothing Keir read on this ticket contains that|this inclusion check asks at most twice|asks the player who they are|states a fact about the player's account|says the account is not linked or has no character|calls behaviour a bug, fault or defect|tells the player to change a setting|page still shows the old figure|contradicts the checked answer/i;
// Refusals that are about pacing, where the post budget tells the model when and whether a retry can succeed.
const BUDGET_REFUSAL = /this task posted in ticket|Keir has posted \d+ times in ticket|already got this update|another Keir task updated ticket|your last message to the player is still the newest|already has this waiting state|waiting on the owner's decision|told this is live/i;
// A developer wait with only a filed bug report out: nobody owes a reply, so it backs off.
const DEVELOPER_QUIET_WAITS = [360, 720, 1440];
const { createDelegation, childTools } = require("./delegation");
const prMention = require("./prmention");
const ruleLookup = require("./rulelookup");
const readClaim = require("./readclaim");
const priceReport = require("./pricereport");
const bugClaim = require("./bugclaim");
const claimcheck = require("./claimcheck");
const accountClaim = require("./accountclaim");
const settingClaim = require("./settingclaim");
const standdown = require("./standdown");
const closing = require("./closing");
const { isQuick } = require("./conversation");
const { rootJob } = require("./workrecord");
const evidenceLookup = require("./evidencelookup");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { source, snowflake } = require("./gateway");
const { isModerationChannel } = require("./ticketCategory");
const { redactSecrets, parseCommandFooter } = require("../text");
const heal = require("../heal");
const charts = require("../charts");
const { ownerText } = require("./privacy");
const { openDecision, withdrawDecisions } = require("./decisions");
const knowledge = require("./knowledge");
const { ticketClaim } = require("./ticketClaim");
const capabilities = require("./capabilities");
const incidents = require("./incidents");
const blast = require("./blastradius");
const authority = require("./authority");
const musePolicy = require("./ownermuse-policy");
const chain = require("./chain");
const issues = require("./issues");
const { verifyLiveFix: verifyLiveFixWith, liveDeployment: liveDeploymentWith, probeWith } = require("./livefix");
const { createSurge } = require("./surge");
const sharedAnswer = require("./sharedanswer");
const { pendingHandoffs, parkedOnHandoffs } = require("./developerwatch");
const { isAppJob } = require("./appchannel");
const { createSupportDirectives } = require("./supportdirective");
const { MUSE_TOOLS } = require("./appmuse");
const UNANSWERED = /\?|<@!?&?\d+>|^\s*(?:how|what|why|when|where|which|who|can|could|is|are|do|does|if|help)\b/i;
// A filing that asks for an owner call rather than a fix.
// Asking the player which entity or page they mean, or for a link.
const ASKS_WHICH = /\b(?:which|what)\b[^.?!]{0,50}\b(?:bank|corporation|company|corp|sector|plant|page|screen|tab|country|state|party|character|fund|account)\b[^.!]*\?|\b(?:tell|show|let) me (?:which|what|where)\b[^.?!]{0,50}\b(?:page|screen|tab|sector|company|corporation)\b|\b(?:send|share|post|paste|give)\b[^.?!]{0,40}\b(?:link|url|page)\b/i;
const DECISION_WORDS = /\b(?:compensat\w*|refund\w*|reimburs\w*|restitution|make (?:them|the player) whole|owner (?:decision|ruling|approval)|please decide|decide whether|needs? (?:a|an) (?:owner |developer )?(?:decision|ruling))\b/i;
const ordinal = (n) => { const v = n % 100; return `${n}${v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`; };
const DISCLOSURE = [
  "Hi, I'm Keir, the AI support assistant for A House Divided.",
  "- **How I help** I can check game rules and records, investigate bugs, and prepare fixes. If my first reply misses something, tell me what to check. I can still gather evidence that helps the developers fix it faster.",
  "- **When staff step in** Staff handle moderation and changes to account access. Some fixes need their approval before I can apply them.",
  "- **Details that help** Tell me what happened and what you expected. A screenshot or game link helps.",
  "- **Rate a reply** Use the buttons under my answers. Pick ⭐ or 👍 if it helped, 👎 if it missed the mark, or **Report a problem** to flag a specific issue.",
].join("\n");
// Owner, 2026-11-21 (ticket 1855): every new report says up front that replies come from an AI, not only a player's
// first one. A returning player, staff and the owner get this one line instead of the full introduction.
const AI_LINE = "I'm Keir, an AI assistant. Staff review anything that needs a decision.";
const { playerLeak, runtimeTalk, nameMisuse, shapeTicketPost, sentences, isCorrection, ackOnly } = require("./playercopy");

const SUPPORT_READS = {
  support: ["support_get", "support_search", "support_list"],
  // Keir 2.0: runbooks, design docs and Discord history, not just the code index.
  "ops-knowledge": ["code_search", "code_read", "code_exact", "knowledge_query", "knowledge_get", "kanban_get",
    // Keir 11.1: the vetted public dictionary of confusable measures. A player ping may call this one tool and no other ops-knowledge read.
    "support_evidence_lookup"],
  community: ["community_search"],
  // Keir 5.6: raw read-only game records. Ticket tasks filed "developer
  // handoffs" for single-document reads that nobody claimed, and stalled for
  // hours. Guarded below: prod or sandbox, game collections only, no secret fields.
  "heal-ops": ["heal_query", "heal_count", "heal_collections"],
  engine: ["engine_health", "recent_turns", "economy_pulse"],
  turndiag: ["turn_phase_timings", "phase_history", "lock_status", "turn_failure_detail"],
  // Player-facing error refs ("Ref: 584ffe8b") and client crashes, from the read-only Sentry MCP.
  sentry: ["sentry_issues", "sentry_issue", "sentry_event_lookup", "sentry_player_errors", "sentry_new_since"],
  // Corporation and sector traces are the same public game data the corp pages
  // show; without them ticket tasks asked players for screenshots of their own
  // P&L (ticket 1522).
  gamestate: ["entity_search", "legislation_catalog", "elections", "game_overview", "countries", "analytics_catalog", "analytics_query", "fx_quote", "player_wealth_statistics",
    "trace_corp", "trace_sector", "corporation_rankings", "extraction_market",
    // Keir 2.1: the reporter's own history (scoped below), and public approval.
    "trace_character", "trace_account", "character_balance_sheet", "character_wealth_history", "trace_approval",
    // Keir 6 (KBX2/KBX3, 2026-10-28): records the worst real tickets needed but support
    // could not read: corporation ledgers (double charges, 1558), regional workforce
    // and migration (1677), parties and races (1488, 1527), fiscal and map context,
    // and the reporter's own action timings (1658, reporter-scoped below).
    "trace_ledger", "macro_history", "parties", "trace_election", "trace_race", "country_fiscal", "wars", "map_snapshot", "geo_aggregate", "top_players", "trace_actions",
    // Keir 7 (lakeside-code #69, from Keir's own capability requests): live
    // nominations and their vote deadlines, the reporter's shareholdings
    // (reporter-scoped below), and the public commodity market.
    "nomination_records", "character_holdings", "commodity_market",
    // Keir 10 (W3): military forces, the reporter's own bond positions
    // (reporter-scoped via PLAYER_PRIVATE) and a country's closed fiscal years.
    // alt_ring_audit and alt_rank stay staff-only: owner and developer tasks read
    // them through the full server list, automatic player tasks never do.
    "military_roster", "trace_bonds", "country_fiscal_history",
    // Keir 11.1: sourced multi-turn market and economy history (public), and the verified reporter's own
    // operating results and action points (private, bound to the ticket's reporter below).
    "market_history", "reporter_operating_results", "reporter_action_points"],
  // Keir 10 (W3): the game's own lore wiki and glossary, the same public text the
  // player-facing wiki shows. "How do I ..." tickets had no rulebook to read.
  lore: ["lore_wiki_search", "lore_wiki_page", "lore_glossary", "lore_country", "lore_parties", "lore_organizations"],
};
const META_SUMMARY = /\b(no (further|new|additional) (post|reply|response|message)s? (is |was )?(needed|required|necessary)|nothing (further |more )?to (post|add|say)|already (answered|replied|posted|addressed|handled)\b|source channel|the (player|reporter|owner|developer) (was|has been|is) (told|answered|updated)|(task|activation|job) (finished|complete|completed|done))/i;
// Raw game-record reads for support tasks. Account, auth, ticket, payment and
// audit collections stay closed, and so do fields that hold contact details or
// credentials, so nothing private reaches a public ticket channel.
const RAW_READ_CLOSED = /^(users?|accounts?|sessions?|auth.*|.*tokens?|.*secrets?|.*keys?|.*credentials?|.*emails?|.*passwords?|tickets?|ticket.*|suggestions?|support.*|discord.*|payments?|purchases?|subscriptions?|.*audit.*|access.*log.*|request.*log.*|ip.*|devices?|notifications?|messages?|inbox.*|keir.*|admin.*)$/i;
// A refusal has to name the way forward. "read game records
// only" was not one: these collections are game records too, so sign-in
// tickets kept probing users, adminLogs, actionAuditLog and discord_messages
// instead of asking for the account state or escalating it (18 refusals
// across six tasks, 2026-10-25).
// Keir 10.1: account actions Keir cannot perform itself; a handoff about one always needs a person.
const ACCOUNT_ACTION = /\b(?:re-?link|unlink|relinking|unban|ban appeal|lift (?:the |a |their )?(?:ban|block)|registration block|signup block|sign-?up block|device block|blocked from (?:registering|signing)|vpn (?:access|exception|whitelist|allowlist)|account recovery|recover (?:the |their |an |his |her )?(?:old )?account|merge (?:the |their )?accounts|transfer (?:the |their )?account|move (?:the |their )?(?:old )?account|change (?:the |their )?(?:login|email|discord))\b/i;
const RAW_READ_CLOSED_NOTE = "it holds account, sign-in, contact or audit data. On a ticket, read the reporter's character with reporter_state; when the task needs the account record itself, file the exact read with raise_to_developers, kind question and needsHuman true";
// Anchored where a bare substring would hit game fields: "ip" ends ownership,
// membership and leadership; "address" is too broad to match anywhere.
const RAW_FIELD_CLOSED = /(email|password|passhash|hash$|token|secret|apikey|api_key|^ip$|ip_?addr|^lastip|discord|session|phone|^address$|street|postal|mailing)/i;
const RAW_OPERATOR_CLOSED = /^\$(where|function|accumulator)$/;
// Closed fields are also removed from returned documents: a filter check alone
// cannot stop an unprojected read from returning them.
// Keir 10 (2026-11-15, mod-chat): the closed pattern matched "discord" anywhere, so the game setting
// discordLinkRequiredForCharacter was silently cut from a gameConfig read and Keir told staff the requirement
// was off when it was on. A setting is not personal data: a key shaped like a switch, limit or timer whose
// value is a boolean, number or null stays readable. Identifiers, contact details and credentials stay closed.
const RAW_SETTING_SHAPE = /(?:Required|Enabled|Allowed|Disabled|Mode|Stage|Gate|Limit|Timeout|Minutes|Hours|Days|Turns|Size|Count|Verification|Policy)(?:[A-Z]\w*)?$/;
const rawSetting = (k, v) => RAW_SETTING_SHAPE.test(k) && (v === null || ["boolean", "number"].includes(typeof v));
const rawClosed = (k, v) => RAW_FIELD_CLOSED.test(k) && !rawSetting(k, v);
function redactRaw(value, depth = 0, hidden = null) {
  const top = hidden === null; hidden ||= new Set();
  let out;
  if (depth > 12 || !value || typeof value !== "object") out = value;
  else if (Array.isArray(value)) out = value.map((x) => redactRaw(x, depth + 1, hidden));
  else out = Object.fromEntries(Object.entries(value).filter(([k, x]) => { const c = rawClosed(k, x); if (c) hidden.add(k); return !c; }).map(([k, x]) => [k, redactRaw(x, depth + 1, hidden)]));
  // Say what was withheld, by name only, so a hidden field is never read as a missing one.
  if (top && hidden.size && out && typeof out === "object" && !Array.isArray(out)) out = { ...out, withheldFields: [...hidden].slice(0, 20), withheldNote: "These fields exist in the records but are withheld from Keir as private data. Never say they are absent, off or empty; ask a developer if one matters." };
  return out;
}
const oidOf = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$oid === "string" ? v.$oid : null;
// Coerce read arguments to their JSON schema: numbers to strings and numeric
// strings to numbers where the type says so, numbers clamped to min/max.
// Returns the coerced copy, or null when nothing changed.
// Keir 7: argument names models reach for that a schema spells differently
// (2026-10-25 week: trace_corp 13 and turn_anomalies 9 "unrecognized key"
// rejections). An unknown key is renamed only when exactly one schema
// property is its clear counterpart and that property was not already given.
const ARG_SYNONYMS = { limit: ["turns", "count", "n", "max"], turns: ["limit", "window", "last"], since: ["from", "fromTurn", "startTurn", "sinceTurn"], from: ["since", "fromTurn", "startTurn"], until: ["to", "toTurn", "endTurn"], to: ["until", "toTurn", "endTurn"], query: ["q", "text", "question", "search"], text: ["query", "q", "question"] };
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
function renameKeys(args, props) {
  const out = { ...args }, names = Object.keys(props);
  let changed = false;
  for (const k of Object.keys(args || {})) {
    if (props[k]) continue;
    const nk = normKey(k);
    const candidates = names.filter((p) => out[p] === undefined && (() => {
      const np = normKey(p);
      if (np === nk || np + "id" === nk || nk + "id" === np) return true;
      if (np.length >= 4 && nk.length >= 4 && (nk.startsWith(np) || np.startsWith(nk)) && /id$/.test(nk) === /id$/.test(np)) return true;
      return (ARG_SYNONYMS[p] || []).map(normKey).includes(nk);
    })());
    if (candidates.length === 1) { out[candidates[0]] = out[k]; delete out[k]; changed = true; }
  }
  return changed ? out : null;
}
function coerceArgs(args, schema) {
  const props = schema?.properties || {};
  const renamed = renameKeys(args, props);
  const out = { ...(renamed || args) };
  let changed = Boolean(renamed);
  for (const [k, v] of Object.entries(out)) {
    const p = props[k]; if (!p) continue;
    const types = [].concat(p.type || []);
    let next = v;
    if (types.includes("string") && !types.includes("number") && !types.includes("integer") && typeof v === "number") next = String(v);
    else if ((types.includes("number") || types.includes("integer")) && !types.includes("string") && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) next = Number(v);
    if (typeof next === "number") {
      if (types.includes("integer") && !types.includes("number")) next = Math.round(next);
      if (typeof p.minimum === "number" && next < p.minimum) next = p.minimum;
      if (typeof p.maximum === "number" && next > p.maximum) next = p.maximum;
    }
    if (next !== v) { out[k] = next; changed = true; }
  }
  return changed ? out : null;
}
// Keir 6.1.1: $toString on an array field (holderIds, say) failed live with
// "Unsupported conversion from array to string in $convert". Match an array
// field when any element's text form is listed, as a plain query would, and
// never let an unconvertible value fail the whole read.
const asText = (input) => ({ $convert: { input, to: "string", onError: null, onNull: null } });
function idMatch(field, ids) {
  const path = "$" + field;
  return { $cond: [{ $isArray: path },
    { $gt: [{ $size: { $filter: { input: path, cond: { $in: [asText("$$this"), ids] } } } }, 0] },
    { $in: [asText(path), ids] }] };
}
// A record id typed as plain text never matches an ObjectId field, and the
// empty answer read as "nothing exists" (ticket 1742: three live supply
// agreements reported as none, twice). Returns the filter with those values
// as record ids, or null when there are none.
const HEX_ID = /^[0-9a-f]{24}$/i;
function hexIdFilter(filter) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return null;
  const out = {}, fields = [];
  const hex = (x) => typeof x === "string" && HEX_ID.test(x);
  for (const [k, v] of Object.entries(filter)) {
    if (!k.startsWith("$") && hex(v)) { out[k] = { $oid: v }; fields.push(k); }
    else if (!k.startsWith("$") && v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && Array.isArray(v.$in) && v.$in.some(hex)) { out[k] = { $in: v.$in.map((x) => (hex(x) ? { $oid: x } : x)) }; fields.push(k); }
    else out[k] = v;
  }
  return fields.length ? { filter: oidFilter(out), fields } : null;
}
const emptyRead = (r) => Boolean(r) && (Array.isArray(r.docs) ? r.docs.length === 0 : r.count === 0);
function oidFilter(filter) {
  const out = {}, match = [];
  for (const [k, v] of Object.entries(filter)) {
    const id = oidOf(v);
    // Keir 6.1: {$in: [{$oid}, ...]} failed live 13 times in a day ("cannot nest $ under $in").
    const list = !k.startsWith("$") && v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && Array.isArray(v.$in) && v.$in.some(oidOf) ? v.$in.map((x) => oidOf(x) ?? x) : null;
    if (id && !k.startsWith("$")) match.push(idMatch(k, [id]));
    else if (list) match.push(idMatch(k, list.map(String)));
    else out[k] = v;
  }
  if (!match.length) return filter;
  const all = out.$expr ? [out.$expr, ...match] : match;
  out.$expr = all.length === 1 ? all[0] : { $and: all };
  return out;
}
// The test server is a separate world players ask about. Reading it is as safe
// as reading prod; silently swapping it for prod answered a sandbox question
// with production data (ticket 1740), so any other env is refused by name.
const RAW_READ_ENVS = new Set(["prod", "sandbox"]);
function rawReadEnv(env) {
  if (env === undefined || env === null || env === "") return "prod";
  if (!RAW_READ_ENVS.has(env)) throw new Error(`env "${env}" is not readable here: use "prod" for the live game or "sandbox" for the test server`);
  return env;
}
function rawReadArgs(tool, args) {
  const env = rawReadEnv(args.env);
  if (tool === "heal_collections") return { env };
  const collection = String(args.collection || "");
  if (!collection) throw new Error("collection: name the game collection to read; heal_collections lists them");
  if (RAW_READ_CLOSED.test(collection)) throw new Error(`collection "${collection}" is closed to support reads: ${RAW_READ_CLOSED_NOTE}`);
  const walk = (v) => v && typeof v === "object" && Object.entries(v).some(([k, x]) => RAW_FIELD_CLOSED.test(k) && !RAW_SETTING_SHAPE.test(k) || walk(x));
  if (walk(args.filter) || walk(args.projection)) throw new Error("contact, credential and session fields are closed to support reads");
  // Server-side JavaScript is never a read a support task needs.
  const script = (v) => v && typeof v === "object" && Object.entries(v).some(([k, x]) => RAW_OPERATOR_CLOSED.test(k) || script(x));
  if (script(args.filter) || script(args.sort)) throw new Error("server-side script operators are closed to support reads");
  const out = { env, collection, filter: args.filter || {} };
  if (tool === "heal_query") {
    out.limit = Math.min(Math.max(Number(args.limit) || 25, 1), 50);
    if (args.projection) out.projection = args.projection;
    if (args.sort) out.sort = args.sort;
  }
  return out;
}
// Raw collections that a purpose-built read already covers. A raw read of one still works; the note on its result names the
// typed read so the next task starts there (Sentry KEIR-A/D/F/3/P/2, 2026-11-17: Keir reaches for the raw collection first).
const TYPED_READS = {
  corporations: "trace_corp (one corporation) or corporation_rankings (the league table)",
  corporateSectors: "trace_sector (stakes, capacity, margins) or sector_builds (build queue, construction financing, property transition, for-sale flag)",
  ledgerEntries: "trace_ledger (a corporation's or character's ledger)",
  characters: "trace_character (any character, public fields) or reporter_state (the ticket's reporter)",
  macroCountries: "macro_history or country_fiscal",
  statePartyOrg: "map_snapshot with scope country and metric party_org",
  stateResourceCapacity: "extraction_market or map_snapshot with metric sector_specialization",
  producerEconomyAccounts: "trace_account or trace_corp",
  gameState: "game_overview (current turn, preset) or engine_health and turn_status (turn lock and processing state)",
};
// Close spellings of a collection that does not exist: case, a missing or extra trailing s, or one name containing the other.
function nearCollections(name, names, limit = 5) {
  const norm = (x) => String(x).toLowerCase().replace(/s$/, "");
  const n = norm(name);
  if (!n) return [];
  return names.filter((c) => { const k = norm(c); return k === n || (n.length >= 5 && (k.includes(n) || n.includes(k))); }).slice(0, limit);
}
const MAP_WORLD_ONLY = new Set(["players", "parties", "gdp_growth", "inflation_rate", "unemployment_rate", "median_income_anchor", "poverty_rate", "cost_of_living", "wage_growth", "trade_growth", "prime_rate", "debt_to_gdp_ratio"]);
const MAP_COUNTRY_METRICS = "population, approval, lean, economic_lean, social_lean, party_org, house, senate, governor, presidential, sector_specialization, candidate_roster";
function mapSnapshotScopeCheck(args) {
  if (args?.scope !== "country" || !MAP_WORLD_ONLY.has(String(args.metric))) return;
  const extra = args.metric === "parties" ? " For which parties hold a country's regions use metric party_org; for a party list use the parties tool." : args.metric === "players" ? " For player counts by country or state use geo_aggregate." : " For a country's economy use country_fiscal or macro_history.";
  throw new Error(`${args.metric} is a world-scope map layer, not available for country maps.${extra} Country scope metrics: ${MAP_COUNTRY_METRICS}. Or call map_snapshot with scope world.`);
}
// Finding reads are sensor evidence and public game sources only.
// Keir 5.6.2: findings also read raw game records (same guard as tickets).
// Without them a finding filed "please run this query" handoffs that nobody
// claimed overnight (MNM wind-up, unpaid income tax, 2026-10-16).
// Keir's own tools and github actions that models keep sending through read_tool with a guessed server.
const NATIVE_NOT_READ = new Set(["turn_status", "sector_builds", "team_activity", "reporter_state", "check_draft", "player_trail", "resolve_reporter", "request_log", "past_ticket", "similar_reports", "ticket_history", "recent_changes", "source_history", "recall", "ask", "view_page", "view_attachment"]);
const GITHUB_ACTION_NAMES = new Set(["deployed", "where", "status", "ci_failures", "ci_runs", "issues", "history", "watch", "review", "pr_diff"]);
// A refusal that names the way out. The bare "read tool is outside support scope" was repeated up to 13 times per
// ticket because nothing in it told the model which call to make instead.
function outsideScopeMessage(scope, server, tool) {
  if (NATIVE_NOT_READ.has(tool)) return `read tool is outside support scope: ${tool} is one of Keir's own tools, not a ${server} read. Call ${tool} directly as a tool, not through read_tool.`;
  if (server === "github" || GITHUB_ACTION_NAMES.has(tool)) return `read tool is outside support scope: github is not a read_tool server. If this task has the github tool, call it with action "${tool}"; otherwise this task cannot read it.`;
  const allowed = scope[server];
  if (!allowed) return `read tool is outside support scope: ${server} is not a readable server here. Readable servers: ${Object.keys(scope).join(", ")}.`;
  return `read tool is outside support scope: ${tool} is not a ${server} read available to this task. Available on ${server}: ${allowed.join(", ")}.`;
}
const FINDING_READS = {
  "heal-ops": ["heal_list", "heal_detect", ...SUPPORT_READS["heal-ops"]],
  turndiag: [...SUPPORT_READS.turndiag, "turn_anomalies"],
  gamestate: [...SUPPORT_READS.gamestate.filter((n) => !["trace_character", "trace_account", "character_balance_sheet", "character_wealth_history", "character_holdings", "trace_bonds", "reporter_operating_results", "reporter_action_points"].includes(n)), "invariant_check"],
  lore: SUPPORT_READS.lore,
  engine: SUPPORT_READS.engine,
  sentry: SUPPORT_READS.sentry,
  "ops-knowledge": SUPPORT_READS["ops-knowledge"],
};
// Reads that count as looking a person or case up before saying "I can't tell" (clarify.lookupRequiredRefusal).
const LOOKUP_READS = { support: ["support_get", "support_search", "support_list"], gamestate: ["alt_ring_audit", "alt_rank", "trace_account", "trace_character", "trace_corp", "entity_search"] };
const QUICK_OWNER_READS = { ...SUPPORT_READS,
  "ops-knowledge": musePolicy.MCP_READS["ops-knowledge"],
  engine: ["engine_health", "recent_turns", "economy_pulse"],
  turndiag: ["turn_phase_timings", "phase_history", "phase_regressions", "turn_anomalies", "lock_status", "turn_failure_detail"],
};
const gameKnowledge = knowledge.gameKnowledge;
// Reads about one player: automatic tasks may only aim them at the ticket's reporter.
const PLAYER_PRIVATE = new Set(["trace_character", "trace_account", "character_balance_sheet", "character_wealth_history", "trace_actions", "character_holdings", "trace_bonds", "reporter_operating_results", "reporter_action_points"]);
// Keir 11.1: these reads take no identity from the model at all. The broker injects the ticket reporter's character
// and refuses any argument that names someone else, in every context that inherits the ticket (investigators included).
const REPORTER_BOUND = new Set(["reporter_operating_results", "reporter_action_points"]);
const IDENTITY_ARGS = ["character", "characterId", "character_id", "sequentialId", "id", "name", "player", "playerId", "username", "user", "userId", "account", "accountId", "reporter", "ticket"];
const NOT_FOUND_LIKE = /outside support scope|not a \S+ read|unknown tool|tool not found|method not found|not available to this task/i;
const handoffTruth = require("./handofftruth");
const QUICK_TOOLS = ["ticket_command", "conversation_updates", "check_draft", "ticket_performance", "release_efficiency", "chart", "present_evidence", "add_to_ticket", "present_choices", "owner_updates", "support_directive", "read_servers", "read_tools", "read_tool", "ticket_history", "source_history", "view_attachment", "task_progress", "channel_reply", "checkpoint", "finish", "handoff", "recall", "calculate", "recent_changes", "similar_reports", "past_ticket", "turn_status", "ask"];
// Owner-set overnight hold: /var/lib/keir-operator/prod-hold holds an ISO expiry.
// While active, nothing reaches production: no promote to main, no prod heal.
function prodHold() {
  try {
    const until = Date.parse(fs.readFileSync(process.env.KEIR_PROD_HOLD_FILE || "/var/lib/keir-operator/prod-hold", "utf8").trim());
    return until > Date.now() ? new Date(until).toISOString() : null;
  } catch { return null; }
}
const HOLD_NOTE = "Production is on hold while the developers are away. Leave it on development or staging, tell the requester it ships when they are back, and finish waiting.";
function ticketRequested(text) {
  // "open an incident", "get an incident ticket open" (ticket 1590, 2026-10-16).
  return /\b(?:open|create|make|file|raise|log|start)\s+(?:(?:a|an|the|new|another|support|bug|incident)\s+){0,3}(?:ticket|incident)\b|\bticket\s+(?:this|that|it)\b|\bticket\s+(?:open|opened|up)\b/i.test(text || "") &&
    !/\b(?:don['’]t|do not|never|no need to)\s+(?:\w+\s+){0,2}(?:open|create|make|file|raise|log|ticket)\b/i.test(text || "");
}
// Changes here alter turn processing or money for everyone at once.
const { ECONOMY_PATHS } = blast;
const isHugePath = (file) => ECONOMY_PATHS.test(file) || /^src\/lib\/equities\//.test(file) || blast.WORKER_PATHS.test(file) || authority.MIGRATION_PATHS.test(file);
const ticketNumberOf = (name) => Number(/^ticket-.*-(\d+)$/.exec(name || "")?.[1] || 0);
// Internals that must never reach a player's ticket channel.
const TECHNICAL = /github\.com|\bPRs?\b|pull request|#\d{3,5}\b|\bCI\b|\bchecks?\b.*\b(?:green|red|pass|fail|run)|\bshard|\bmerg(?:e|ed|ing)\b|\bstaging\b|\bdevelopment branch|\bbranch\b|\bcommit\b|\bvitest\b|\btest files?\b|\.(?:ts|tsx|js)\b|`|turn worker|\bpromot(?:e|ed|ion)\b|\b(?:decision|approval)\s+(?:DM|inbox)\b|\bdig done\b|\b(?:OAuth2?|redirect_uri|return URI|portal\/env|env mismatch)\b/i;
// Engine and staff vocabulary players never see on a screen (owner, 2026-10-17:
// "the way he explains things to users is SOOO jargony"). Code-style names too.
const JARGON = /\b(?:headroom|sell[- ]through|reachable (?:book|market|demand)|(?:order|demand|supply) book|demand throttle|throttl(?:e|ed|ing)|ratchet(?:s|ed|ing)?|fill (?:rate|ratio|share)|nameplate|run[- ]rate|carry[- ]forwards?|clearing (?:price|records?)|settlement (?:span|phase)|cohorts?|baseline(?:s|d)?|multipliers?|coefficients?|config(?:uration)?|feature flags?|the seed|seeded|turn processing|turn engine|NPPs?|coordinator|status card|ledger|telemetry|heuristics?|invariants?)\b|\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b|\b[a-z]+[A-Z][a-zA-Z]+\b|\b[a-z]+_[a-z_]+\b/;
const SUPPORT_WRITES = ["support_public_update", "support_resolve", "support_set_status", "support_tracker_note", "support_tracker_sync"];
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const run = (command, args, options = {}) => new Promise((resolve, reject) => execFile(command, args, { timeout: 60000, maxBuffer: 2 << 20, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root" }, ...options }, (e, out, err) => e ? reject(new Error(String(err || e.message).slice(0, 2000))) : resolve(out)));

function parseRpc(raw) {
  return JSON.parse(raw.trim().startsWith("{") ? raw : raw.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.replace(/^\S+Z\s/, "")).filter((l) => l.startsWith("data:")).at(-1).slice(5));
}
function validateArguments(value, schema, path = "args") {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: choose ${schema.enum.join(", ")}`);
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: object required`);
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(`${path}.${key}: required by tool schema`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateArguments(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unknown argument; use the discovered tool schema`);
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path}: array required`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path}: too many items`);
    value.forEach((item, index) => validateArguments(item, schema.items || {}, `${path}[${index}]`));
  } else if (type && (type === "integer" ? !Number.isInteger(value) : typeof value !== type)) throw new Error(`${path}: ${type} required`);
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) throw new Error(`${path}: length outside tool schema`);
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`${path}: number outside tool schema`);
}
function validationRejected(result) {
  return result?.code === -32602 || (result?.isError === true && result.content?.some(c => c.type === "text" && /^MCP error -32602: Input validation error:/.test(c.text || "")));
}
function localMcpUrl(value) {
  let url; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) return null;
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.href;
}
// Reads that cannot connect are retried with backoff (about 15 seconds in all, inside the 30 second request budget).
// 2026-11-17: a host reboot left every MCP refusing connections for 11 minutes while Keir was already up, and the single
// 1.5 second retry spent 64 tool calls on "fetch failed". The retries ride out a service restart; a longer outage is
// reported to the model as an unreachable server, not as missing data.
const READ_RETRY_DELAYS_MS = [1500, 4000, 10000];
const CONNECT_CODES = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH"];
function createMcp(configFile, readToken, { gate = null, retryDelays = READ_RETRY_DELAYS_MS } = {}) {
  const listCache = new Map(), LIST_TTL_MS = 5 * 60000;
  const servers = JSON.parse(fs.readFileSync(configFile, "utf8")).mcpServers;
  async function rpc(server, method, params, write = false, signal) {
    const c = servers[server];
    const url = localMcpUrl(c?.url);
    if (!url) throw new Error("unavailable local MCP server");
    // Keir 8.4 kill switch: no write leaves this box while it is engaged, whichever code path made it.
    if (write && gate) gate(`The ${server} write ${params?.name || method}`);
    // Keir 8: a refused or unresolvable connection means the request never left
    // this box, so a write that fails this way provably wrote nothing.
    const send = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: write ? c.headers.Authorization : `Bearer ${readToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
    // A read that failed to connect (an MCP restarting for a deploy) is retried once after a short pause. Writes are never retried,
    // and neither is a read that timed out or was cancelled: those may have reached the server.
    const res = await send().catch(async (e) => {
      const connectFailure = (x) => x?.name === "TypeError" && /fetch failed/i.test(String(x.message)) && CONNECT_CODES.includes(x?.cause?.code || x?.code);
      if (!write && !signal?.aborted && connectFailure(e)) {
        for (const delay of retryDelays) {
          await new Promise((r) => setTimeout(r, delay));
          if (signal?.aborted) break;
          try { return await send(); } catch (e2) { e = e2; if (!connectFailure(e2)) break; }
        }
      }
      const c2 = e?.cause?.code || e?.code;
      if (c2 === "ECONNREFUSED" || c2 === "ENOTFOUND") e.code = "MCP_CONNECT_REFUSED";
      // Name the cause: a bare "fetch failed" gave the model and the failure counter nothing to go on. The words
      // "fetch failed" stay in the message because the lifecycle recovery rules match them to retry the task.
      if (e?.name === "TypeError" && /^fetch failed$/i.test(String(e.message)) && c2) e.message = `fetch failed (${c2} reaching the ${server} MCP server; it may be starting or restarting. An unreachable server says nothing about the data, so do not report records as missing)`;
      throw e; });
    const j = parseRpc(await res.text());
    if (!res.ok || j.error || j.result?.isError) {
      const error = new Error(redactSecrets(JSON.stringify(j.error || j.result || {}).slice(0, 2000)));
      if (res.ok && validationRejected(j.error || j.result)) error.code = "MCP_ARGUMENT_REJECTED";
      throw error;
    }
    return j.result;
  }
  return { identity: (server) => { const c = servers[server]; const endpoint = localMcpUrl(c?.url); if (!endpoint || !c?.headers?.Authorization) throw new Error("MCP destination identity unavailable"); return { server, endpoint, credentialBinding: hash(c.headers.Authorization) }; }, servers: () => Object.entries(servers).filter(([, c]) => localMcpUrl(c.url)).map(([name]) => name), list: async (s, signal) => {
    // Keir 6.1.1: tool catalogs change only on an MCP deploy, yet every ticket
    // activation listed up to eight servers. A short cache keeps them fresh enough.
    const hit = listCache.get(s);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.tools;
    const tools = (await rpc(s, "tools/list", {}, false, signal)).tools;
    if (Array.isArray(tools)) listCache.set(s, { at: Date.now(), tools });
    return tools;
  }, call: async (s, t, a, write, signal) => {
    const r = await rpc(s, "tools/call", { name: t, arguments: a }, write, signal);
    const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let parsed; try { parsed = JSON.parse(text); } catch { return { text }; }
    if (parsed.ok === false) throw new Error(redactSecrets(JSON.stringify(parsed).slice(0, 2000)));
    const images = (r.content || []).filter((c) => c.type === "image" && /^image\/(png|jpeg|webp|gif)$/.test(c.mimeType || "") && c.data?.length <= 5600000).slice(0, 2);
    if (images.length) parsed._images = images.map((c) => ({ type: "base64", media_type: c.mimeType, data: c.data }));
    // A form report whose body is only the platform line is described by its
    // title; Keir told 1584 and 1586 their reports had no text.
    if (t === "support_get" && parsed.title && !String(parsed.description || "").replace(/^Platform:[^\n]*\n*/i, "").trim())
      parsed.reportNote = `The player's report is its title: "${String(parsed.title).slice(0, 300)}". Do not tell them it has no description.`;
    return parsed;
  } };
}

// exec runs git, gh and systemd-run; tests inject it so merge, promote and
// publish paths are exercised without touching GitHub or the host.
// Public copy that states an outcome must be backed by a receipt for it
// (2026-10-12: "we've switched that back" and "will be paid back" were posted
// to ticket 1502 before either was true; "in testing" was overstated on 1498).
const replyPolicy = require("./replypolicy");
const CLAIMS = [
  // Money owed to the player, not game mechanics ("workers are paid less").
  { kind: "money", re: /\bpaid (?:you |it |them )?back\b|\bpay (?:you |it |them )?back\b|\brepa(?:id|y)\b|\brefund(?:ed)?\b|\breimburs(?:ed|ement)\b|\bcompensat(?:ed|ion)\b|\b(?:paid|credited|returned) (?:to )?(?:you|your)\b|\b(?:you|your \w+) (?:\w+ ){0,3}(?:paid|credited|refunded)\b/i },
  { kind: "reverted", re: /\b(?:switched|turned|rolled|changed|put) (?:it |that |this |them |those )?back\b|\breverted\b|\bundone\b/i },
  // KBX4 2026-11-02: "a change that lets higher pay speed hiring went live at the end of last
  // week" was posted from nothing; past-tense release verbs are the same claim.
  // 2026-11-05 (ticket 1763): "The margin fix is now on the main server" was posted an hour before it was.
  { kind: "main", re: /\blive on the main server\b|\b(?:is|are|now|it's) (?:now )?on the main server\b|\breached the live (?:site|game|server)\b|\b(?:is|are|was|were|it's|now) (?:now )?live\b|\b(?:went|gone|go(?:es)?) live\b|\bfix(?:es)? (?:is|are) (?:now )?(?:live|out)\b|\b(?:fix|change|update|patch)(?:es)?\b[^.]{0,60}\b(?:rolled out|was released|were released|shipped)\b/i },
  { kind: "staging", re: /\bon (?:the )?sandbox\b/i },
  // Keir 8.2 (2026-11-05, ticket 1763): "live and working", "should be gone" and "now show"
  // were posted six times from the release alone; each was disproved by the player's next screenshot.
  // A claim that the player's problem is gone needs a game read after a turn ran on the fix.
  // Keir 9 (replay 2026-11-13): "it has since been fixed" and "that rule has since been changed" reached players unchecked.
  { kind: "verified", hedged: true, re: /\b(?:was|were|has been|have been|is|are|got|now) (?:now )?(?:corrected|patched|resolved|repaired)\b|\b(?:in|with|by) (?:the|a|our) (?:current|latest|newest|last|recent) (?:update|patch|release|version)\b|\b(?:fix|fixes|change|correction|update|patch)\b[^.]{0,60}\b(?:has|have) been (?:released|shipped|deployed|pushed out)\b|\b(?:page|panel|tile|screen|display|figure|number|value|label)s? (?:has|have) been (?:changed|updated|corrected|adjusted|reworked)\b|\b(?:has|have|had|was|were) (?:since|recently|already|just|later) (?:been )?(?:fixed|changed|corrected|patched|resolved|repaired|updated|adjusted|reworked)\b|\b(?:rule|behaviou?r|mechanic|limit|formula|requirement|check)s? (?:has|have|was|were) (?:now |recently )?(?:been )?(?:changed|updated|adjusted|reworked|relaxed|loosened)\b|\bnow match(?:es)?\b|\b(?:is|are|it's) now (?:fixed|working|resolved)\b|\b(?:is|are|was|were|has been|have been|had been|it's) (?:now |already |since )?fixed\b|\bnow (?:fixed|resolved)\b|\b(?:live|fix) and working\b|\bnow (?:works|shows?|counts?|includes?|reads?|says?)\b|\bshould (?:now )?(?:be gone|go away|be fixed|be back|work|show|read|count|line up)\b|\bno longer (?:shows?|appears?|reads?|counts?|happens?)\b|\b(?:is|are) back (?:up|to normal)\b|\bworking for you\b/i },
  { kind: "development", re: /\bin testing on dev\b|\bon (?:the )?dev(?:elopment)? server\b|\bon dev\b/i },
  // Keir 4.0: "being built" needs a coding attempt that can write (ticket 1514
  // said it for five hours while every pass was read-only); "written" or "in
  // testing" needs a pull request.
  { kind: "building", re: /\b(?:fix|correction|patch|change) is (?:now )?(?:being |still being )?(?:built|written|prepared|worked on)\b|\bbeing built\b|\b(?:building|writing|preparing) (?:a |the |that |this )?(?:fix|correction|patch)\b|\bworking on (?:a |the |that |this )?(?:fix|correction|patch)\b/i },
  // Keir 4.1.7: "the developers have it" needs something that reached them
  // (ticket 1540 said it with nothing filed).
  { kind: "investigating", re: replyPolicy.INVESTIGATOR },
  { kind: "escalated", re: /\b(?:the )?(?:developers?|devs?|dev team)(?: already)? (?:have|has|are (?:looking at|reviewing|aware of)|got) (?:it|this|that|the)\b|\b(?:it'?s|this is|that is|it is) (?:now )?with the (?:developers?|devs?)\b|\b(?:passed|raised|flagged|sent|reported|put) (?:it |this |that )?(?:on |up )?(?:to|with) the (?:developers?|devs?|dev team)\b|\b(?:developers?|devs?)\b[^.!?]*\b(?:it'?s|it is|that'?s) with them\b|\b(?:passed|raised|flagged|sent|reported|forwarded|handed|given|escalated)\b[^.!?]{0,80}\b(?:to|with) (?:the |our )?(?:developers?|devs?|dev team|staff|moderators?|mods)\b/i },
  // Keir 10.1 (ticket 1834): "the developers will check" and "when the developers reply" promise a person is on it.
  // The future tense does not excuse it: it needs the same proof as "the developers have it".
  { kind: "escalated", always: true, re: /\b(?:the )?(?:developers?|devs?|dev team|staff|moderators?|mods)\b[^.!?]{0,40}\bwill (?:reply|respond|get back|check|look|review|contact|reach out|update)\b|\bwhen (?:the )?(?:developers?|devs?|staff|moderators?|mods) (?:reply|respond|get back|answer)\b/i },
  { kind: "written", re: /\b(?:fix|correction|patch) (?:is|has been|was) (?:now )?(?:written|ready|built|prepared|done)\b|\bhave (?:a|the) (?:fix|correction) (?:ready|written)\b|\b(?:is|are) (?:now )?in testing\b|\bgoing through (?:its |the )?(?:checks|tests)\b|\bpassed (?:its|the|all its) (?:tests|checks)\b/i },
];
// "Should be gone" is the hedge that carried 1763's claims; only these mark a real future step.
// Keir 9 (replay 2026-11-13): "that fault is fixed and takes effect from the next turn" asserts the fix now; a turn
// mention alone no longer makes a fix claim count as future. "will", "once", "when" and the like still do.
const STRICT_FUTURE = /\b(?:will|once|when|after|until|going to)\b|['’]ll\b/i;
const FUTURE = /\b(?:will|won't|once|when|after|until|soon|should|going to|plan(?:ning)?|next|expect|if)\b|['’]ll\b/i;
// KBX4 2026-11-02: "cannot" was not a negation, so "a note cannot authorise a payment, so that
// refund has to come through our own approval" was refused as a money claim four times running.
const NEGATED = /\b(?:not|never|no|nothing|none|neither|nor|cannot|unable|isn't|aren't|wasn't|weren't|hasn't|haven't|didn't|yet)\b|n['’]t\b/i;
// A money sentence about the approval step itself ("the refund is up for approval") describes the
// request, not an outcome; the decision or heal request is its own receipt.
const PENDING_APPROVAL = /\b(?:for|awaiting|needs?|pending|waiting (?:on|for)|up for|through|subject to) (?:an? |the |our (?:own )?|owner['’]s |egg['’]s |his )?(?:approval|decision|sign-?off|review)\b/i;
function outcomeClaims(text) {
  const out = [];
  for (const whole of String(text || "").split(/(?<=[.!?])\s+|\n+/)) {
    // Negation applies to its own clause: "it is not a bug, but it was corrected in the latest update" still claims a fix.
    // Money stays judged on the whole sentence: "the refund is still with the developers, but it has not been
    // approved yet" is a pending status, and splitting at "but" would drop the negation (CI 2026-11-13).
    for (const sentence of whole.split(/,?\s+(?:but|however|though|although)\s+|;\s+/i)) {
    if (NEGATED.test(sentence)) continue;
    for (const c of CLAIMS) {
      if (!c.re.test(sentence)) continue;
      if (c.kind === "money" && (NEGATED.test(whole) || PENDING_APPROVAL.test(whole))) continue;
      // A future word after a past claim does not make the claim future: "a correction has been released, and it reaches
      // your page after the next turn" still says the fix is out (rc3 replay, 2026-11-13). For these claims only the words up
      // to the end of the claim count.
      const m = c.hedged ? c.re.exec(sentence) : null;
      const upTo = m ? sentence.slice(0, m.index + m[0].length) : sentence;
      out.push({ kind: c.kind, future: c.always ? false : (c.hedged ? STRICT_FUTURE : FUTURE).test(upTo), sentence: sentence.trim().slice(0, 160) });
    }
    }
  }
  return out;
}
// Added lines of a public patch must not carry internal hosts, paths or
// personal addresses: AHDGame is public and history is permanent.
const INTERNAL = /\/root\/|\/var\/lib\/|\/etc\/keir|\b167\.86\.68\.67\b|\b46\.224\.28\.26\b|\b(?:127\.0\.0\.1|localhost):97\d\d\b|\bops\.lakesidegames\.net\b|\bcontabo\b|\bhetzner\b|\bahdk_/i;
const EMAIL = /\b[\w.+-]+@(?!(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com)\b)[\w-]+(?:\.[\w-]+)+\b/;
function publicPatchLeak(patch) {
  const line = String(patch).split("\n").find((l) => /^\+(?!\+\+)/.test(l) && (INTERNAL.test(l) || EMAIL.test(l)));
  return line ? line.slice(0, 160) : null;
}
// A schema rejection before execution repeats identically until the adapter
// changes, which needs a restart. Rejections older than this process may retry.
const STARTED_AT = Date.now();
// Measured on the seven-hour Railway loop: paraphrased repeats scored 0.41 to
// 0.79 against an earlier reply, unrelated app replies 0.05 or less.
const APP_REPEAT_SIMILARITY = 0.35;
const words = (t) => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
function createBroker({ killSwitch = null, limits = null, ledger, config, mcp, discord, sandbox, conversation, now = () => Date.now(), exec = run, notebook = null, effectShadow = null, appChannel = null, appComputer = null, appQuestions = null, appMuse = () => null, codingWorkers = () => null }) {
  // Keir 11.2: closing-condition settings (KEIR_QUIET_WAKES and friends); tests may pass config.closing.
  const closingConfig = config.closing || closing.settings(process.env);
  // Keir 11.2 third pass (review M7): the switches for the post budget, the turn rule, quiet-wake escalation and the
  // step-back, read at each use (lib/operator/controls.js; operator.js puts them on config.controls).
  const controlsLib = require("./controls");
  const ctl = () => config.controls || controlsLib.DEFAULT_CONTROLS;
  // Review M6 and the second pass's soft spot: every post a budget, turn or step-back rule holds back is recorded where a
  // person can read it (ledger.data.refusedPosts, printed by bin/keir-preview.js): which ticket, which rule, the text.
  function noteRefused(rule, job, ticketNo, message) {
    const all = (d.refusedPosts ||= {});
    all[ticketNo] = [...(all[ticketNo] || []).filter((r) => now() - r.at < 7 * 86400000), { at: now(), rule, job: job.id, text: String(message || "").slice(0, 400) }].slice(-20);
    for (const n of Object.keys(all)) if (!all[n].some((r) => now() - r.at < 7 * 86400000)) delete all[n];
  }
  // Fourth pass (review N10): where a post rule cannot tell, the post goes out and the doubt is recorded here (printed by
  // bin/keir-preview.js), never a refusal.
  function noteDoubt(rule, job, ticketNo, message) {
    const all = (d.postDoubts ||= {});
    all[ticketNo] = [...(all[ticketNo] || []).filter((r) => now() - r.at < 7 * 86400000), { at: now(), rule, job: job.id, text: String(message || "").slice(0, 400) }].slice(-20);
    for (const n of Object.keys(all)) if (!all[n].some((r) => now() - r.at < 7 * 86400000)) delete all[n];
    ledger.audit("post_rule_doubt", { job: job.id, ticket: ticketNo, rule });
  }
  let guildChannelCache = null;
  const reporterCache = new Map();
  const d = ledger.data;
  async function callSupport(tool, args, write, signal) {
    if (d.privateEvidenceTickets?.[args.number] && ["support_public_update", "support_resolve"].includes(tool)) {
      const tools = await mcp.list("support", signal);
      args = require("./ticketonly").narrowedArgs(args, tools, tool);
    }
    return mcp.call("support", tool, args, write, signal);
  }
  // Deployed-commit probes run through the broker's own exec, like gh.
  const probe = probeWith(exec);
  const verifyLiveFix = (args) => verifyLiveFixWith({ probe, ...args });
  const liveDeployment = (args) => liveDeploymentWith({ probe, ...args });
  const supportDirectives = createSupportDirectives({ledger, config, mcp, discord, now});
  const delegation = createDelegation({ ledger, sandbox, config, now });
  const surge = createSurge({ ledger, mcp, discord, config, now, ...(config.jevAsk ? { ask: config.jevAsk } : {}) });
  let issueFlight = Promise.resolve();
  // Keir 11.4: owner and staff act on tickets by number (ticketcommands.js); authority is checked there from the real author.
  const ticketCommands = require("./ticketcommands").createTicketCommands({ ledger, config, mcp, discord, effect: (...a) => effect(...a), now, ticketOf: (j) => j.ticket || ticketNumberOf(j.source?.channelName), ctl: () => ctl(), publicText: (t) => publicText(t) });
  const ownerDirected = (job) => job.kind === "command" && job.role === "owner" && job.actorId === config.ownerId && job.source?.authorId === config.ownerId;
  const developerTask = (job) => job.kind === "command" && [config.ownerId, ...config.staffIds].includes(job.actorId) && job.source?.authorId === job.actorId && ["owner", "support"].includes(job.role);
  // A ticket a developer opened for their own internal work (its opening request
  // is the developer's own message, not a player report). Its task may read
  // developer sources like Sentry; writes keep their usual approvals (ticket 1514).
  const developerTicket = (job) => job.kind === "ticket" && [config.ownerId, ...config.staffIds].includes(job.actorId) && job.source?.authorId === job.actorId;
  const readScope = (job) => require("./roles").roleOf(job, ledger.data.jobs) === "watchkeeper" ? require("./roles").WATCH_READS : job.kind === "finding" ? FINDING_READS : SUPPORT_READS;
  // Keir 7: whether this task may read a tool through read_tool, mirroring the
  // read_tool scope checks, so ready reads never offer a tool it cannot call.
  const WRITE_LIKE = /(?:^|_)(?:apply|delete|remove|drop|update|set|create|insert|send|post|merge|promote|publish|rollback|reset|write|compensate)(?:_|$)/i;
  const readable = (job, server, tool) => {
    if (WRITE_LIKE.test(String(tool || ""))) return false;
    const watch = require("./roles").roleOf(job, ledger.data.jobs) === "watchkeeper";
    if (isQuick(job) && job.role === "owner") return Boolean(QUICK_OWNER_READS[server]?.includes(tool));
    if (job.role === "player") return server === "gamestate" || (server === "support" && tool === "support_get") || (server === evidenceLookup.SERVER && tool === evidenceLookup.TOOL);
    if (job.role === "owner" || developerTask(job)) return !watch || Boolean(require("./roles").WATCH_READS[server]?.includes(tool));
    return Boolean(readScope(job)[server]?.includes(tool));
  };
  if (process.env.KEIR_READY_READS === "0") config.readyReads = false;
  const readyReads = require("./readyreads").createReadyReads({ mcp, stateDir: config.stateDir, readable, embed: config.embed || null, log: config.log || (() => {}) });
  const readServers = (job) => require("./roles").roleOf(job, ledger.data.jobs) === "watchkeeper" ? Object.keys(require("./roles").WATCH_READS) : job.kind === "finding" ? Object.keys(FINDING_READS) : (job.role === "owner" || developerTask(job)) ? (isQuick(job) ? Object.keys(QUICK_OWNER_READS).filter((s) => mcp.servers().includes(s)) : mcp.servers()) : job.role === "player" ? ["gamestate", "support", evidenceLookup.SERVER] : Object.keys(SUPPORT_READS);
  function active(job, states = ["running"]) {
    // Say why and that the turn is over: the bare phrase kept models calling
    // tools after a merge or finish (replay 2026-10-19: up to 21 calls).
    if (d.paused || job.appPaused) throw new Error("task execution authority is inactive: Keir is paused. Stop now: make no more tool calls.");
    if (!states.includes(job.state)) throw new Error(`task execution authority is inactive: this task is ${job.state}${job.mergedInto ? `, merged into incident ${job.mergedInto}` : ""}. Its turn is over. Stop now: make no more tool calls.`);
    if (job.deadline < now()) throw new Error("task execution authority is inactive: this task's deadline has passed. Stop now: make no more tool calls.");
    require("./supporttakeover").assertCanAct(d, job);
  }
  async function supportAuthority(job, states, { decisionNotice = false } = {}) {
    active(job, states);
    if (config.supportDeferred(job)) throw new Error("another coordinator owns the active support shift");
    // A public update while the owner decides follows the same one-notice rule
    // as channel_reply (guardTicketPost); every other support write still waits.
    if (job.ownerDecisionPending && job.role !== "owner" && !decisionNotice) throw new Error("ticket is awaiting an owner decision; no automatic write or closure");
    if (!job.ticket) throw new Error("task has no assigned ticket");
    const channels = await discord("GET", `/guilds/${config.guildId}/channels`);
    const channel = channels.find((c) => c.id === job.channelId && c.name.endsWith(`-${job.ticket}`));
    if (!channel) throw new Error("ticket channel is absent or no longer matches");
    const messages = await discord("GET", `/channels/${channel.id}/messages?limit=100`);
    // Ownership comes only from the ticket bot's claim message. A developer
    // posting in the channel is collaboration, not a claim.
    const claimant = messages.map((m) => ticketClaim(m, config, d.channels[channel.id]?.claimReleasedAt)).find(Boolean) || d.channels[channel.id]?.claimedBy;
    if (claimant) { d.channels[channel.id] = { ...d.channels[channel.id], claimedBy: claimant }; ledger.save(); }
    if (claimant && !(developerTask(job) && job.actorId === claimant)) throw new Error("staff owns this ticket");
    active(job, states);
    return messages;
  }
  async function effect(job, key, fn, settle = null) {
    active(job);
    const old = job.effects[key];
    if (old?.state === "done") return old.result;
    conversationTurn.check(job);
    // Keir 10.1.13: nothing is said to a player on a ticket that is over (1842 got "still working on it" a minute after it closed).
    if (settle?.kind === "reply" && settle.ticket) { const why = require("./ticketstate").endedReason(d, settle.ticket, job); if (why) { ledger.audit("post_blocked_ticket_ended", { job: job.id, ticket: settle.ticket, why }); throw new Error(`Ticket ${settle.ticket} has ended (${why}). Nothing more is posted to the player. Finish now with no further tool calls.`); } }
    // A merge receipt is settled from GitHub by effectrecovery.js; asking the
    // owner to inspect it pinged them about a race that fixes itself (ticket 1619).
    if (old && old.state !== "rejected") throw new Error(require("./effectrecovery").MERGE_KEY.test(key)
      ? "This merge's outcome is being checked against GitHub automatically within ten minutes. Do not ask the owner about it: finish waiting with a wakeup of about ten minutes, then re-read the PR."
      : "external action outcome is uncertain; owner inspection required");
    if (old?.state === "rejected" && !old.retryable && (old.at || 0) >= STARTED_AT) throw new Error(`This exact call was already rejected by the tool's schema (${String(old.error || "").slice(0, 300)}). Read the tool schema again and change the arguments; repeating it fails the same way.`);
    // Keir 8.4: the kill switch refuses before anything is marked started, so the
    // job keeps no uncertain receipt and nothing needs inspecting when the switch is released.
    killSwitch?.assertClear("This external action");
    job.effects[key] = { state: "started", at: now(), ...(settle ? { settle } : {}) }; ledger.save();
    try {
      require("./supporttakeover").assertCanAct(d, job);
      const result = await fn();
      job.effects[key] = { state: "done", at: now(), result };
      ledger.audit("effect", { job: job.id, key }); ledger.save();
      return result;
    } catch (e) {
      job.effects[key].error = redactSecrets(e.message);
      if (e.code === "GITHUB_MERGE_REFUSED") {
        // GitHub answered with a definite refusal: nothing merged, and a later call may try again.
        delete job.effects[key];
        ledger.audit("effect_rejected", { job: job.id, key, reason: "github refused the merge; nothing merged" }); ledger.save();
        throw e;
      }
      if (["MCP_ARGUMENT_REJECTED", "EXTERNAL_WRITE_REFUSED"].includes(e.code)) {
        job.effects[key].state = "rejected";
        ledger.audit("effect_rejected", { job: job.id, key, reason: e.code === "EXTERNAL_WRITE_REFUSED" ? "remote access refused before execution" : "argument validation before execution" }); ledger.save();
        throw e;
      }
      if (["MCP_CONNECT_REFUSED", "EFFECT_NOT_STARTED"].includes(e.code)) {
        // Keir 8: nothing left this box (connection refused) or nothing was pushed yet
        // (publishing's local steps), so the same call may simply be repeated.
        job.effects[key].state = "rejected"; job.effects[key].retryable = true;
        ledger.audit("effect_rejected", { job: job.id, key, reason: e.code === "MCP_CONNECT_REFUSED" ? "connection refused before the request was sent; nothing written" : "failed before anything was pushed; nothing written" }); ledger.save();
        throw e;
      }
      // Even a network error can follow a committed remote mutation.
      job.state = "blocked"; job.summary = "External action needs receipt inspection: " + redactSecrets(e.message);
      // Merge outcomes are settled from GitHub by effectrecovery.js; no owner DM.
      // Compensation payments are settled from heal-ops the same way (7.0.3).
      if (!require("./effectrecovery").MERGE_KEY.test(key) && !require("./effectrecovery").compensationAction(d, key)) ledger.notify(`effect-error:${job.id}:${key}`, "owner", `Task ${job.id}: ${job.summary}`);
      ledger.save();
      throw e;
    }
  }
  // Keir 8: posts a public comment at most once per marker. GitHub is the receipt: the issue's
  // own comments are read first (a failed read posts nothing), and a comment already carrying the
  // marker settles a receipt that was left "started" by a crash or timeout instead of repeating it.
  async function commentOnce(job, key, read, issueRoute, marker, post) {
    let found = false;
    for (let page = 1; page <= 5 && !found; page++) {
      const rows = await read([`${issueRoute}/comments?per_page=100&page=${page}`]);
      if (!Array.isArray(rows)) throw new Error("could not read the issue's comments; nothing was posted rather than risk a repeat");
      found = rows.some((c) => String(c?.body || "").includes(marker));
      if (!found && rows.length < 100) break;
      if (!found && page === 5) throw new Error("the issue has too many comments to check for an earlier closing note; nothing was posted");
    }
    if (found) {
      const old = job.effects[key];
      if (old && old.state !== "done") {
        job.effects[key] = { ...old, state: "done", at: now(), result: { reconciled: true } };
        ledger.audit("effect_reconciled", { job: job.id, key, outcome: "commented" }); ledger.save();
      }
      return { skipped: "already commented" };
    }
    return effect(job, key, () => post(marker));
  }
  function publicText(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 5000) throw new Error("invalid player text");
    const clean = redactSecrets(value).replace(/\s*[\u2013\u2014]\s*/g, ", ");
    // Keir 8.4 (owner, 2026-11-06): tool calls and the broker's own instructions must never reach a person.
    const leak = require("./toolmarkup").outboundLeak(clean);
    if (leak) { try { ledger.audit("outbound_leak_refused", { kind: leak.kind, match: leak.match }); } catch {} throw new Error(`Not posted: this contains ${leak.kind === "broker_echo" ? "Keir's own tool or refusal text" : "tool-call text"} ("${leak.match}"). Call tools through the tool interface and write only the plain answer for the reader.`); }
    // Keir 9: a dash is replaced, not refused (replay 2026-11-12: a right answer was refused for a dash and the
    // player got nothing). Redacted private details and mentions are still refused.
    if (redactSecrets(value) !== value || /<@|@everyone|@here/.test(clean)) throw new Error("player text contains private details or mentions");
    return clean;
  }
  // Keir's own GitHub account (keir-bot, KEIR_GITHUB_TOKEN): what Keir authors on GitHub (its pushed branch, PR,
  // issues, comments, reviews, closing its own duplicates, promote PRs) shows as Keir. Merges, branch deletion and
  // every read keep using the box's own login, the owner's, behind the owner's approval. No token set: all of it
  // stays on the box login, as before.
  const asKeir = (opts = {}) => (config.githubReviewerToken ? { ...opts, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root", GH_TOKEN: config.githubReviewerToken } } : opts);
  // git uses a stored credential, not GH_TOKEN, so a push as Keir overrides the helper for that command only.
  const keirGit = () => (config.githubReviewerToken ? ["-c", "credential.helper=", "-c", "credential.helper=!f() { echo username=keir-bot; echo \"password=$GH_TOKEN\"; }; f"] : []);
  const isKeirWrite = (args) => { const i = args.indexOf("-X"); return i >= 0 && /^(POST|PATCH)$/i.test(String(args[i + 1])); };
  const ticketOf = (j) => j.ticket || ticketNumberOf(j.source?.channelName);
  // Keir 4.2: the yes that covers this task's ticket, if any. The owner's own
  // request is its own yes.
  const ticketYes = (job) => ownerDirected(job) && authority.isDirection(job.source?.content || "") ? { by: config.ownerId, messageId: job.source.messageId, how: "owner_request" } : (() => { const g = authority.lookup(d, ticketOf(job), now()); return g && authority.granter(config, g.by) ? g : null; })();
  // What Keir can prove about a ticket's outcome, across every task that worked it.
  function ticketEvidence(ticketNo) {
    const jobs = Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo);
    const ids = new Set(jobs.map((j) => j.id));
    const actions = Object.values(d.actions).filter((a) => ids.has(a.jobId) && ["heal", "mcp_write"].includes(a.kind));
    const release = jobs.flatMap((j) => Object.values(j.releaseEvidence || {}));
    const merged = jobs.some((j) => Object.entries(j.effects || {}).some(([k, e]) => k.startsWith("merge:") && e.state === "done"));
    const written = jobs.some((j) => (j.pullRequests || []).length > 0) || merged || release.some((r) => r.development);
    // A coding attempt that exists (any state but cancelled) or a prepared
    // patch is the receipt for "being built". Reading is not building.
    const building = written || jobs.some((j) => (j.kind === "coding" && !["cancelled", "dismissed"].includes(j.state)) || j.patchDigest || j.publishedPatch);
    return {
      money: { done: actions.some((a) => a.state === "done"), agreed: actions.some((a) => ["approved", "executing", "done"].includes(a.state)) },
      reverted: { done: actions.some((a) => a.state === "done") || merged },
      // Owner, 2026-10-14 (ticket 1553): a card said "Cause found" one second
      // after the ticket opened. Found needs three reads of game state or code.
      investigated: { done: jobs.reduce((n, j) => n + (j.investigatedReads || 0), 0) >= 3 || building },
      building: { done: building },
      written: { done: written },
      development: { done: merged || release.some((r) => r.development) },
      staging: { done: release.some((r) => r.staging) },
      main: { done: release.some((r) => r.main) && require("./livecoverage").mainCovered(jobs) },
      mainOwn: { done: require("./livecoverage").ownMainReceipt(jobs, Object.values(d.actions || {})) },
      // "Live, confirmed in game" (review 2026-10-19: 1602's card said it for a
      // change that never moved the player's mine): a turn processed after
      // the fix, then a game read after that turn.
      verified: { done: release.some((r) => r.main) && require("./livecoverage").mainCovered(jobs) && jobs.some((j) => (j.turnChecks || []).some((at) => (j.lastGameReadAt || 0) > at)) },
      // Keir 8.4 (owner, 2026-11-06): "handed to the developers" needs a real queue item, pull request or
      // decision; "handed to an investigator" needs a real investigation job. Nobody-assigned handoffs
      // were posted on 1766 and 1773.
      // Keir 10.1 (ticket 1834): Keir's own self-assigned card reaches nobody, so it is not proof.
      // Keir 11.4 (ticket 1872): a card Keir's own coding worker took, and Keir's own pull request, are Keir's work, not the developers'.
      escalated: { done: handoffTruth.developerReceipts(d, ticketNo, jobs).length > 0 || jobs.some((j) => j.trackerRaised) || Object.values(d.decisions || {}).some((x) => ids.has(x.jobId)) },
      investigating: { done: jobs.some((j) => (j.investigations || []).some((id) => d.jobs[id])) },
    };
  }
  const NEED = {
    money: "a money claim needs the repair to have run: an executed heal for this ticket. A promise needs at least an approved one. Until then say it is being looked at, not that it is paid or will be.",
    reverted: "\"switched back\" or \"reverted\" needs an executed heal or a merged fix for this ticket.",
    building: "\"being built\" needs a coding attempt that can write code for this ticket (delegate_fix or a prepared patch). Reading code is investigating, not building: say it is being investigated.",
    written: "\"written\", \"ready\" or \"in testing\" needs a pull request opened for this ticket (publish_patch). Until then say the fix is being built.",
    development: "\"in testing on dev\" needs the fix merged to development (github where shows it).",
    staging: "\"on sandbox\" needs github where to show the fix on staging.",
    main: "\"live\" needs github where to show the fix on main (and turn-worker/production for turn fixes).",
    verified: "saying it is fixed, working, gone or now shows correctly needs the fix live on main, a turn processed on it, and a read of this player's own figures after that turn and after their last message. Until then say it is released and ask them to check after the next turn, or check it yourself first.",
    investigating: "\"handed to an investigator\" needs a real investigation job: call delegate_investigation with one bounded question first. Until then say you are digging into it yourself.",
    escalated: "\"the developers have it\" needs a handoff a person holds: a raised item no Keir worker took, a question with needsHuman, or an open owner decision. If your own coding worker or pull request has it, say \"I am preparing a fix\" or \"My fix is in testing\" instead.",
  };
  // One public voice per ticket: no near-duplicate updates, and no second task
  // talking over the one that just posted (tickets 1500, 1506, 1507).
  // Keir 2.0: every checkable figure in a public post must come from something
  // read this activation (or a registered calculation over such figures).
  function guardNumbers(job, message) {
    const missing = knowledge.unsupportedNumbers(message, job.evidence || [], job.typedFacts || []);
    if (missing.length) throw new Error(`Not posted: ${missing.slice(0, 5).join(", ")} ${missing.length === 1 ? "does" : "do"} not appear in anything you read this activation. If you worked it out from figures you read, call calculate with that expression (for example "41288610 / 312540") and post the same reply; it then passes. Otherwise read the figure with a tool first or leave it out. Never hand the arithmetic to the player instead.`);
  }
  // Keir 9: ticket posts get the same number check, against everything this ticket has read (earlier
  // activations included). Refused at most twice per ticket, then skipped and audited (no loops, no
  // silenced player).
  function guardTicketNumbers(job, ticketNo, message) {
    const missing = require("./sources").unsupported(message, require("./sources").ticketEvidence(ledger, job, ticketNo), require("./sources").ticketFacts(ledger, job, ticketNo));
    if (!missing.length) return;
    const counts = (d.numberCheckRefused ||= {});
    if ((counts[ticketNo] || 0) >= require("./sources").MAX_REFUSALS) {
      if (!d.numberCheckGaveUp?.[ticketNo]) { (d.numberCheckGaveUp ||= {})[ticketNo] = now(); ledger.audit("number_check_gave_up", { job: job.id, ticket: ticketNo, numbers: missing.slice(0, 5) }); ledger.save(); }
      return;
    }
    counts[ticketNo] = (counts[ticketNo] || 0) + 1; ledger.save();
    throw new Error(`Not posted: ${missing.slice(0, 5).join(", ")} ${missing.length === 1 ? "does" : "do"} not appear in anything this ticket has read. If you worked it out from figures you read, call calculate with that expression and post the same reply; it then passes. Otherwise read the figure with a tool first or leave it out. Never hand the arithmetic to the player instead.`);
  }
  // Keir 2.1: code-only second look (owner, 2026-10-13: no model tokens per
  // post). A draft may not re-assert an idea the ticket record ruled out.
  function secondLook(job, ticketNo, message) {
    const rec = knowledge.ticketRecord(ledger, ticketNo);
    const hit = knowledge.revivedRuledOut(message, rec.ruledOut);
    if (hit) { ledger.audit("second_look_refused", { job: job.id, ticket: ticketNo, idea: hit.idea }); throw new Error(`Not posted: "${hit.sentence}" brings back an idea this ticket already ruled out ("${hit.idea}"). If you have new evidence, record it as a fact first and close the ruled-out entry; otherwise drop the claim.`); }
  }
  // Keir 4.0 (owner, 2026-10-14): the first thing Keir says in a ticket sets
  // expectations before its first real reply. First-time players get the
  // welcome once. Returning players and staff go straight to the reply.
  async function openingFor(n) {
    const one = await mcp.call("heal-ops", "heal_query", { env: "prod", collection: "tickets", filter: { ticketNumber: n }, projection: { discordUserId: 1, discordDisplayName: 1, discordUsername: 1, "publicUpdates.key": 1 }, limit: 1 }, false);
    const t = one?.docs?.[0];
    // Someone already answered in this ticket through the support tools (staff,
    // another operator, an earlier coordinator). An opening "I'm looking into
    // it now" there reads as a restart to a player who has their answer
    // (ticket 1588, 2026-10-16).
    if (Array.isArray(t?.publicUpdates) && t.publicUpdates.length) return { text: null, answered: true };
    if (!t?.discordUserId) return { text: DISCLOSURE };
    const uid = String(t.discordUserId);
    if (uid === config.ownerId || (config.staffIds || []).includes(uid)) return { text: AI_LINE, staff: true };
    const prior = await mcp.call("heal-ops", "heal_query", { env: "prod", collection: "tickets", filter: { discordUserId: uid, ticketNumber: { $lt: n } }, projection: { ticketNumber: 1 }, limit: 200 }, false);
    const count = Number(prior?.matched ?? (prior?.docs || []).length) + 1;
    const introduced = (d.introduced ||= {})[uid] || (prior?.docs || []).some((x) => d.disclosed?.[x.ticketNumber]?.posted);
    const name = String(t.discordDisplayName || t.discordUsername || "").replace(/[*_`~|<>@#]/g, "").trim().slice(0, 40);
    d.introduced[uid] = d.introduced[uid] || now();
    // Owner, 2026-10-29 (ticket 1708): a ticket Keir opened from a chat message
    // was not filed by the player. "This is your 23rd ticket, thank you for
    // submitting it" read as shaming there, so it gets no count and no thanks.
    const keirOpened = Object.values(d.jobs).some((j) => Object.values(j.openedTickets || {}).some((r) => Number(r?.number) === n));
    if (keirOpened) {
      const openedFromChat = "I opened this ticket from your message so it can be tracked here.";
      return { text: introduced ? `${AI_LINE} ${openedFromChat}` : DISCLOSURE.replace("\n", `\n${openedFromChat}\n`) };
    }
    // Review 2026-11-01 (owner): the ticket count and thanks were padding
    // ahead of the answer ("Welcome back, Larry Fink. This is your 58th
    // ticket"). A new player hears the introduction once; a returning player
    // gets no opener, and Keir's first real post is the answer.
    if (!introduced) return { text: DISCLOSURE, count };
    return { text: AI_LINE, returning: true, count };
  }
  async function ensureDisclosure(ticketNo) {
    const n = Number(ticketNo);
    if (!n || (d.disclosed ||= {})[n]) return;
    require("./supporttakeover").assertCanAct(d, { ticket: n });
    const spoke = Boolean(d.statusCards?.[n]?.messageId) || Object.values(d.jobs).some((j) => ticketOf(j) === n && (j.lastPublishedAt || j.progressMessageId || j.channelReplyQueued));
    d.disclosed[n] = { at: now(), posted: !spoke }; ledger.save();
    if (spoke) return;
    let opening = { text: DISCLOSURE };
    try { opening = await openingFor(n); } catch { /* lookup failed: the full introduction is the safe default */ }
    if (!opening.text) { d.disclosed[n] = { at: now(), posted: false, ...(opening.answered ? { answered: true } : opening.returning ? { returning: true, count: opening.count } : { staff: true }) }; ledger.save(); return; }
    try {
      require("./supporttakeover").assertCanAct(d, { ticket: n });
      await callSupport("support_public_update", { kind: "ticket", number: n, message: opening.text, deliver: true, update_kind: "progress", delivery_mode: "reply" }, true);
      d.disclosed[n] = { at: now(), posted: true, ...(opening.count ? { count: opening.count } : {}) }; ledger.save();
      ledger.audit("disclosure_posted", { ticket: n, count: opening.count || null, returning: !opening.text.startsWith("Hi, I'm Keir") });
    } catch (e) { d.disclosed[n] = { at: now(), posted: false, error: String(e.message).slice(0, 200) }; ledger.save(); }
  }
  // Keir 9 (ticket 1763): "fixed" was said six times off a deploy while the player's page still showed the fault.
  // The symptom is the first page figure Keir cited before any fix was live; once the fix is live and a turn has run,
  // code repeats that read. A changed figure lets "fixed" out; an unchanged one refuses it, tells the player plainly
  // once, wakes the task, and after three turns escalates. One re-read per turn.
  const pageChecking = new Map();
  const ticketJobs = (n) => Object.values(d.jobs).filter((j) => ticketOf(j) === n);
  const latestTurnCheck = (n) => Math.max(0, ...ticketJobs(n).flatMap((j) => j.turnChecks || []));
  function notePageSymptom(ticketNo, message) {
    if (!ticketNo || d.ticketSymptoms?.[ticketNo] || ticketEvidence(ticketNo).main.done) return;
    const symptom = require("./pagecheck").chooseSymptom(message, d.ticketObservations?.[ticketNo]);
    if (!symptom) return;
    (d.ticketSymptoms ||= {})[ticketNo] = symptom; ledger.save();
    ledger.audit("page_symptom_recorded", { ticket: ticketNo, tool: symptom.tool, field: symptom.field || null });
  }
  async function pageCheck(ticketNo, signal) {
    const sym = d.ticketSymptoms?.[ticketNo];
    if (!sym || !ticketEvidence(ticketNo).main.done) return null;
    const st = ((d.pageChecks ||= {})[ticketNo] ||= { turns: 0, refusals: 0 });
    const turnAt = latestTurnCheck(ticketNo);
    if (!turnAt || st.checkedFor === turnAt) return st;
    if (pageChecking.has(ticketNo)) return pageChecking.get(ticketNo);
    const run = (async () => {
      const pc = require("./pagecheck");
      let fresh = null; try { fresh = await mcp.call(sym.server, sym.tool, sym.args, false, signal); } catch { /* unknown below */ }
      st.outcome = pc.judge(sym, fresh); st.at = now();
      ledger.audit("page_check", { ticket: ticketNo, outcome: st.outcome, turns: st.turns });
      if (st.outcome === "unknown") { ledger.save(); return st; }
      st.checkedFor = turnAt;
      const jobs = ticketJobs(ticketNo), job = jobs.find((j) => j.kind === "ticket") || jobs[0];
      if (st.outcome === "changed") {
        // Recorded as an observation only: a moved figure is not proof of a fix, so it grants no receipt.
        if (job) require("./investigation-memory").record(ledger, job, "read_tool", { server: sym.server, tool: sym.tool, args: sym.args }, fresh, now());
        ledger.save(); return st;
      }
      st.turns += 1;
      if (!st.plainPosted) {
        st.plainPosted = true;
        try { await callSupport("support_public_update", { kind: "ticket", number: ticketNo, message: pc.PLAIN, deliver: true, update_kind: "progress", delivery_mode: "reply" }, true); }
        catch (e) { st.plainPosted = false; ledger.audit("page_check_post_failed", { ticket: ticketNo, error: String(e.message).slice(0, 160) }); }
      }
      if (job && ["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
      if (job) (job.inbox ||= []).push({ authorId: "page-check", role: "system", content: `The fix is live and a turn has run, but the player's page still shows the old figure (turn check ${st.turns} of ${pc.MAX_TURNS}). Find out why: read the page again, check whether the fix covers this case, and set a turn watch for the next turn. Do not tell the player it is fixed until the figure changes.`, at: new Date(now()).toISOString() });
      if (st.turns >= pc.MAX_TURNS && !st.escalated && job) {
        st.escalated = true;
        try { await tool(job, "raise_to_developers", { kind: "question", title: `Ticket ${ticketNo}: fix is live but the player's page still shows the old figure`, detail: `The fix reached the main server and ${pc.MAX_TURNS} turns have run, but the figure the player complained about is unchanged on their page. Please look at why.`, needsHuman: true, force: true }, signal); }
        catch (e) { st.escalated = false; ledger.audit("page_check_escalation_failed", { ticket: ticketNo, error: String(e.message).slice(0, 160) }); }
      }
      ledger.save(); return st;
    })().finally(() => pageChecking.delete(ticketNo));
    pageChecking.set(ticketNo, run);
    return run;
  }
  async function pageGate(job, ticketNo, message) {
    const sym = d.ticketSymptoms?.[ticketNo];
    if (!sym || !outcomeClaims(message).some((c) => c.kind === "verified" && !c.future) || !ticketEvidence(ticketNo).main.done || !latestTurnCheck(ticketNo)) return;
    const st = await pageCheck(ticketNo);
    if (st?.outcome === "changed" && st.checkedFor === latestTurnCheck(ticketNo)) return;
    if (st) { st.refusals = (st.refusals || 0) + 1; ledger.save(); }
    ledger.audit("page_claim_refused", { job: job.id, ticket: ticketNo, outcome: st?.outcome || "unknown" });
    throw new Error(st?.outcome === "unchanged"
      ? "Not posted: the player's page still shows the old figure after the fix and a turn on it, so it is not fixed. The player has been told the change is out and you are checking why. Find the cause; do not say it is fixed until the figure changes."
      : "Not posted: the player's own page could not be re-read to confirm the fix, so it cannot be called fixed. Say the change is released and ask them to check after the next turn.");
  }
  // Keir 10.4 (ticket 1852): never tell the player "no fix needed" or post a correction while staff, a card, a worker or a PR
  // is already on the issue. Reads team_activity (cached 60 s); a failed read lets the post through. Refused at most three
  // times per ticket, so a post is never stuck on it.
  async function teamCoverGate(job, ticketNo, message, opts = {}, kindOverride = null) {
    if (opts.system || opts.collect || job.kind !== "ticket" || job.role === "player" || !ticketNo) return;
    const teamCover = require("./teamcover"), kind = kindOverride || teamCover.conclusionOf(message);
    if (!kind) return;
    const refused = (d.teamCoverRefusals ||= {});
    if ((refused[ticketNo] || 0) >= 3) return;
    job.teamActivityAt = now();
    const activity = await w3.teamActivity(job, { ticket: ticketNo }).catch((e) => { ledger.audit("team_activity_failed", { job: job.id, ticket: ticketNo, error: String(e.message).slice(0, 200) }); return null; });
    const why = teamCover.refusal(kind, activity);
    if (!why) return;
    refused[ticketNo] = (refused[ticketNo] || 0) + 1; ledger.save();
    ledger.audit("team_cover_refused", { job: job.id, ticket: ticketNo, conclusion: kind, attempt: refused[ticketNo], staffSaidFixing: Boolean(activity.staffSaidFixing) });
    throw new Error(`${why}\n${activity.report}`);
  }
  async function guardTicketPost(job, ticketNo, message, opts = {}) {
    killSwitch?.assertClear("A post to the player");
    { const why = require("./ticketstate").endedReason(d, ticketNo, job); if (why) { ledger.audit("post_blocked_ticket_ended", { job: job.id, ticket: ticketNo, why }); throw new Error(`Ticket ${ticketNo} has ended (${why}). Nothing more is posted to the player. Finish now with no further tool calls.`); } }
    notePageSymptom(ticketNo, message);
    await pageGate(job, ticketNo, message);
    guardTicketNumbers(job, ticketNo, message);
    secondLook(job, ticketNo, message);
    // Keir 9.0.2 (ticket 1829, owner): a linked reporter is never asked who they are. Keir looks the account up itself
    // (reporter_state). Refused at most twice per ticket, then let through, so a post is never stuck on it.
    if (!opts.system && job.kind === "ticket" && ASKS_IDENTITY.test(message)) {
      const reporter = await reporterOf(job).catch(() => null);
      const asked = (d.identityAskRefusals ||= {});
      if ((reporter?.username || reporter?.id) && (asked[ticketNo] || 0) < 2) {
        asked[ticketNo] = (asked[ticketNo] || 0) + 1; ledger.save();
        ledger.audit("identity_ask_refused", { job: job.id, ticket: ticketNo, attempt: asked[ticketNo] });
        throw new Error("Not posted: this asks the player who they are, but their game account is linked to this ticket. Look it up with reporter_state (it returns the linked account and its characters) and never ask a linked player for their character name, username or account. Ask only for what you cannot read.");
      }
    }
    await teamCoverGate(job, ticketNo, message, opts);
    guardTicketPostRules(job, ticketNo, message, opts);
    // Keir 9 (feature B): a draft that contradicts the checked answer already given on the same fault is refused
    // once, with both texts; the next post goes out whether it aligns or explains why this case differs.
    const reuse = !opts.system && d.sharedAnswers?.[ticketNo];
    if (reuse && !reuse.refused) {
      const clash = sharedAnswer.contradiction(message, { ticket: reuse.from, answer: reuse.answer });
      if (clash) { reuse.refused = true; ledger.audit("shared_answer_contradiction_refused", { job: job.id, ticket: ticketNo, from: reuse.from }); ledger.save(); throw Object.assign(new Error(clash), { screened: true }); }
    }
    // Keir 4.0: a typed semantic read of the draft (Jev). Decisive leaks are
    // refused; everything else is a proposed label in the event sink.
    try {
      const screen = await (config.screenOutgoing || require("./jevgate").screenOutgoing)({ text: message, request: String(job.source?.content || "").slice(0, 800), ticket: ticketNo });
      if (screen.labels.length || screen.refuse) ledger.audit("post_screened", { job: job.id, ticket: ticketNo, labels: screen.labels, refused: Boolean(screen.refuse), model: screen.model });
      if (screen.refuse) throw Object.assign(new Error(screen.refuse), { screened: true });
      // Keir 8.2: ten drafts on 2026-11-05 scored 0.95 to 0.97 for asserting an outcome as settled
      // and went out anyway; one was reported wrong by the player. Without a verified receipt, refuse.
      const certain = screen.labels.find((l) => l.label === "certaintyWithoutReceipt" && l.probability >= 0.9);
      if (certain && !ticketEvidence(ticketNo).verified.done && !ticketEvidence(ticketNo).main.done) {
        ledger.audit("certainty_refused", { job: job.id, ticket: ticketNo, probability: certain.probability });
        throw Object.assign(new Error("Not posted: this states an outcome (fixed, live, changed, paid) as settled fact, and this ticket has no release or verification behind it. Say what you found and what happens next, or verify it first."), { screened: true });
      }
    } catch (e) { if (e.screened) throw e; }
    await guardNeedlessClarification(job, ticketNo, message);
    if (!require("./advicerouting").requiresRedirect(job, d)) await ensureDisclosure(ticketNo);
  }
  // Keir 10 claim check: check_draft runs every content guard a real post runs, against a draft, and lists all the problems at
  // once with a fix for each. It posts nothing, records nothing, spends no post budget and leaves every refusal counter as it was,
  // so the answer it gives is the answer the real post will get (the outgoing semantic screen runs only on the real post).
  const DRAFT_STATE = ["ruleLookupRefusals", "ruleLookupRefused", "inclusionRefusals", "readClaimRefusals", "bugClaimRefusals", "accountClaimRefusals", "settingClaimRefusals", "identityAskRefusals", "numberCheckRefused", "numberCheckGaveUp", "sharedAnswers", "ticketSymptoms"];
  const DRAFT_FIXES = {
    length: "Cut it to at most five short sentences: the answer first, then what happens next. The detail goes on the status card note.",
    technical: "Rewrite for the player: what was wrong and where the fix stands, in the words on the game's screens. No PR or issue numbers, links, checks, branches or code.",
    register: "Say what it means for the player in the words the game's own screens use. No paths, hosts, tool names, usernames or Keir's own runtime.",
    numbers: "Read the figure with a tool first, or call calculate with the expression you used, then post the same figure.",
    "outcome claim": "Say only what is verified: what you found and what happens next. Say a fix is live only after the release and the check on a turn.",
    "identity ask": "Look the reporter up with reporter_state; never ask a linked player who they are.",
    "settings claim": "Name a setting only if a read in this ticket shows it controls the behaviour; otherwise say you have not confirmed the cause.",
    "bug claim": "Say it is a bug only when a read marks it a fault, or say plainly that it is not confirmed.",
    "account claim": "Read the reporter's account (reporter_state) before saying anything about their link or characters, or say it was not checked.",
    "read claim": "Quote only what a read of this ticket shows on that page or record, or say it is not confirmed.",
    "rule before code": "Search the game code first (ops-knowledge code_search, claimType mechanic), then answer from what it says, or say plainly the rule is not confirmed.",
    "timid answer": "Read the code that decides it and answer from it instead of hedging.",
    "either/or question": "The ticket already names what is wrong. Investigate each issue it names and answer, instead of asking the player to pick.",
    contradiction: "Start the post with \"Correction:\" and say what changed and why, or drop the claim that clashes with the earlier post.",
    "locked claim": "Say it is not available yet and what it waits on, using the lock you read.",
    pacing: "Wait, or post a one or two sentence correction or a question. See the post budget below.",
    "ruled out": "Record new evidence as a fact and close the ruled-out entry first, or drop the claim.",
  };
  const classifyProblem = (m) => /sentences, \d+ characters/.test(m) ? "length" : /player's ticket channel|PR or issue numbers/.test(m) ? "technical"
    : /do(?:es)? not appear in anything/.test(m) ? "numbers" : /outcome Keir has no receipt|states an outcome|told this is live/.test(m) ? "outcome claim"
    : /asks the player who they are/.test(m) ? "identity ask" : /tells the player to change a setting/.test(m) ? "settings claim"
    : /calls behaviour a bug|bug, fault or defect/.test(m) ? "bug claim" : /account is not linked|fact about the player's account/.test(m) ? "account claim"
    : /says what a page|nothing Keir read on this ticket contains that|page still shows|not appear in anything this ticket has read/.test(m) ? "read claim"
    : /states a game rule or a cause|read the game code|inclusion check/.test(m) ? "rule before code" : /hedg|timid|readable code|guess/i.test(m) ? "timid answer"
    : /already names what is wrong|pick between/.test(m) ? "either/or question" : /contradicts what the player was told|contradicts the checked answer/.test(m) ? "contradiction"
    : /says .* is available, but a read/.test(m) ? "locked claim" : /ruled out/.test(m) ? "ruled out"
    : /posted in ticket|Keir has posted|already got this update|another Keir task|still the newest|waiting on the owner's decision|already has this waiting state|asked the player this|correction is one or two sentences|a developer's own task|still checking/.test(m) ? "pacing"
    : /private details|internal or engine jargon|runtime|Players never see|not this player's name|tool-call text|Keir's own tool/.test(m) ? "register" : "other";
  async function draftCheck(job, input) {
    const raw = input?.message;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("check_draft needs the draft text in message");
    const ticketNo = job.ticket || ticketNumberOf(job.source?.channelName);
    const problems = [], seen = new Set();
    const add = (m, forced) => { const text = String(m).replace(/^Not posted: /, "").trim(); const check = forced || classifyProblem(m); const key = `${check}:${text.slice(0, 80)}`; if (seen.has(key)) return; seen.add(key); problems.push({ check, problem: text.slice(0, 700), fix: DRAFT_FIXES[check] || "Fix what the problem names, then check the draft again." }); };
    const snap = Object.fromEntries(DRAFT_STATE.map((k) => [k, d[k] === undefined ? undefined : JSON.stringify(d[k])]));
    const jobSnap = { unreadContextRefusals: job.unreadContextRefusals, lookupRefusals: job.lookupRefusals };
    const realAudit = ledger.audit, realSave = ledger.save;
    let message = raw, shaped = null;
    // Everything in this block is synchronous, so nothing else can run while the audit and save calls are muted.
    ledger.audit = () => {}; ledger.save = () => {};
    try {
      try { message = publicText(raw); } catch (e) { add(e.message, "register"); message = raw; }
      if (ticketNo) {
        try { shaped = shapeTicketPost(message); message = shaped; } catch (e) { add(e.message, "length"); }
        if (TECHNICAL.test(message)) add("This is the player's ticket channel. Rewrite for the player: no PR or issue numbers, links, CI, checks, merges, branches, commits, file names or code.", "technical");
        try { guardTicketNumbers(job, ticketNo, message); } catch (e) { add(e.message); }
        try { secondLook(job, ticketNo, message); } catch (e) { add(e.message, "ruled out"); }
        const reuse = d.sharedAnswers?.[ticketNo];
        if (reuse && !reuse.refused) { try { const clash = sharedAnswer.contradiction(message, { ticket: reuse.from, answer: reuse.answer }); if (clash) add(clash, "contradiction"); } catch {} }
        const found = []; try { guardTicketPostRules(job, ticketNo, message, { collect: found }); } catch (e) { found.push(e.message); }
        for (const m of found) add(m);
      } else {
        try { guardNumbers(job, message); } catch (e) { add(e.message); }
        try { guardPlayerRegister(job, null, message); } catch (e) { add(e.message); }
      }
    } finally {
      ledger.audit = realAudit; ledger.save = realSave;
      for (const k of DRAFT_STATE) { if (snap[k] === undefined) delete d[k]; else d[k] = JSON.parse(snap[k]); }
      Object.assign(job, jobSnap);
    }
    if (ticketNo) {
      try {
        if (ASKS_IDENTITY.test(message) && job.kind === "ticket") {
          const reporter = await reporterOf(job).catch(() => null);
          if ((reporter?.username || reporter?.id) && (d.identityAskRefusals?.[ticketNo] || 0) < 2) add("Not posted: this asks the player who they are, but their game account is linked to this ticket.", "identity ask");
        }
      } catch { /* the check is advisory */ }
      try {
        const clarify = require("./clarify");
        if (job.role !== "owner" && clarify.isBareEitherOr(message)) {
          const t = await mcp.call("support", "support_get", { kind: "ticket", number: ticketNo }, false).catch(() => null);
          const texts = [job.source?.content, ...(job.requestInbox || []).map((m) => m?.content), ...(job.inbox || []).filter((m) => m && m.role !== "system" && m.role !== "assistant").map((m) => m.content)].filter(Boolean);
          const refusal = clarify.needlessClarification({ message, texts, visits: t?.supportRecentVisits || [] });
          if (refusal) add(refusal, "either/or question");
        }
      } catch { /* the check is advisory */ }
    }
    const budget = ticketNo ? postBudget(job) : null;
    return { ok: problems.length === 0, problems, ...(problems.length === 0 && shaped ? { wouldPost: shaped } : {}), ...(budget ? { postBudget: budget, postBudgetNote: budgetLine(budget) } : {}),
      note: problems.length ? "Fix every problem listed, then check the draft again before posting. Nothing was posted." : "This draft passes every check run here. The outgoing screen runs once more when you post it with channel_reply." };
  }
  // Keir 8.4.1 (owner, ticket 1781): a reply that only asks the player to pick between issues
  // they already raised is not posted. The ticket text, its channel and the page visits are read
  // only when the reply has that shape, so ordinary posts cost nothing.
  async function guardNeedlessClarification(job, ticketNo, message) {
    const clarify = require("./clarify");
    if (job.role === "owner" || !clarify.isBareEitherOr(message)) return;
    const texts = [job.source?.content, ...(job.requestInbox || []).map((m) => m?.content), ...(job.inbox || []).filter((m) => m && m.role !== "system" && m.role !== "assistant").map((m) => m.content),
      ...(d.channelContext?.[job.channelId || job.replyChannel] || []).filter((m) => m.role !== "assistant" && m.authorId !== config.botId).slice(-15).map((m) => m.content)].filter(Boolean);
    const t = await mcp.call("support", "support_get", { kind: "ticket", number: ticketNo }, false).catch(() => null);
    const refusal = clarify.needlessClarification({ message, texts, visits: t?.supportRecentVisits || [] });
    if (!refusal) return;
    ledger.audit("clarification_refused", { job: job.id, ticket: ticketNo });
    throw Object.assign(new Error(refusal), { screened: true });
  }
  // Keir 4.0 phase 1: the player register, checked in code. Paths,
  // repositories, model names and Keir's own runtime never reach a player
  // (tickets 1531, 1522, 1507), and a player is named exactly or not at all.
  const ticketUsername = (ticketNo) => {
    for (const j of Object.values(d.jobs)) {
      const m = /^ticket-[a-z]+-(.+)-(\d+)$/.exec(j.source?.channelName || "");
      if (m && Number(m[2]) === ticketNo) return m[1];
    }
    return null;
  };
  function guardPlayerRegister(job, ticketNo, text) {
    require("./supportblockers").guard(ledger, ticketNo, text, now());
    const publicReports = (d.audit || []).filter((a) => a.kind === "report_published" && a.public).map((a) => a.slug);
    const leak = playerLeak(text, { publicReports });
    if (leak) throw new Error(`Not posted: "${leak.match}" is a ${leak.kind}. Players never see paths, repositories, hosts, model or provider names or internal tools. Say what it means for them instead.`);
    const jg = JARGON.exec(String(text || ""));
    if (jg) throw new Error(`Not posted: "${jg[0]}" is internal or engine jargon. Rewrite it the way you would tell a friend who plays the game: the words on the game's own screens, one idea per sentence, what happened, what it means for them and what they can do.`);
    const rt = runtimeTalk(text);
    if (rt) throw new Error(`Not posted: "${rt}" talks about Keir's own runtime. Players never hear about errors, sessions or limits on Keir's side; post the true stage of their issue, or nothing.`);
    const name = ticketNo ? ticketUsername(ticketNo) : null;
    const nm = nameMisuse(text, name ? [name] : []);
    if (nm) throw new Error(`Not posted: "${nm.used}" is not this player's name. Address them as ${nm.name}, exactly as Discord shows it, or not by name.`);
  }
  // The newest thing a human said in this ticket, across every task on it.
  const humanAt = (ticketNo) => Math.max(0, ...Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo).map((j) => Math.max(j.observedPlayerAt || 0, j.lastPlayerAt || 0)));
  // Keir 10: the text of the latest human message on a ticket, so a bare "Ok." or "thanks" is not treated as owed an answer.
  const lastHumanText = (ticketNo) => {
    let best = null;
    for (const j of Object.values(d.jobs)) {
      if (ticketOf(j) !== ticketNo) continue;
      for (const m of [j.source, ...(j.requestInbox || []), ...(j.inbox || [])]) {
        if (!m || ["system", "assistant"].includes(m.role) || m.investigationResult || m.codingResult || m.bot) continue;
        const at = Date.parse(m.at || "") || 0;
        if (!best || at >= best.at) best = { at, text: m.content || m.text || "" };
      }
    }
    return best?.text || "";
  };
  // Keir 10 (post path): a holding line is not an answer. One test for the finish rule, the refusal flag and the post budget.
  const holdingPost = (text) => isStall(text) || /^hi,? i(?:'|’)?m keir\b/i.test(String(text || "").trim()) || /^i haven(?:'|’)?t got a confirmed answer for you yet/i.test(String(text || "").trim()) || sentences(String(text || "")).length <= 1 && /^(?:i(?:'|’)?m|i am|we(?:'|’)?re|still) (?:looking|checking|digging|investigating|reading)\b|\b(?:will|i(?:'|’)?ll) (?:tell|update|let) you\b/i.test(String(text || "").trim());
  // True when the player's latest message already has a real answer posted (any task on the ticket). With no player message on
  // record, only this job's own earlier real post counts. An extra refused post after that owes the player nothing.
  const playerAnswered = (ticketNo, job) => {
    const h = humanAt(ticketNo);
    return (d.ticketPosts?.[ticketNo] || []).some((p) => !isCardPost(p) && !holdingPost(p.text) && (h > 0 ? p.at >= h : Boolean(job && p.jobId === job.id)));
  };
  // Keir 10: what the post rules will allow on this ticket right now, so the model plans instead of retrying blindly.
  // There is no hard 24 hour count in code: the live limits are the monologue cap (three posts since the player wrote) and
  // ten minutes between long posts from one task. Both are reported here, plus whether the player is owed an answer.
  function postBudget(job) {
    const ticketNo = ticketOf(job);
    if (!ticketNo) return null;
    const human = humanAt(ticketNo), posts = (d.ticketPosts?.[ticketNo] || []).filter((p) => !isCardPost(p));
    const last = posts.at(-1), mine = posts.filter((p) => p.jobId === job.id).at(-1), run = d.monologue?.[ticketNo];
    const owed = !playerAnswered(ticketNo, job) && (human > 0 || Boolean(job.replyRefusedPending));
    const sinceHuman = run && run.humanAt === human ? run.count : 0;
    const capped = sinceHuman >= MONOLOGUE_CAP && now() - run.at < 10 * 60000;
    const longWait = !owed && mine && !(human > mine.at) ? Math.max(0, 10 * 60000 - (now() - mine.at)) : 0;
    return {
      ticket: ticketNo,
      posts24h: posts.filter((p) => now() - p.at < 24 * 3600000).length,
      postsLeftBeforePause: Math.max(0, MONOLOGUE_CAP - sinceHuman),
      pausedForSec: owed || !capped ? 0 : Math.ceil((10 * 60000 - (now() - run.at)) / 1000),
      longPostInSec: Math.ceil(longWait / 1000),
      replyOwed: owed,
      correctionAllowed: owed || !capped,
      lastPost: last ? { ageSec: Math.max(0, Math.round((now() - last.at) / 1000)), text: String(last.text || "").slice(0, 300) } : null,
    };
  }
  function budgetLine(b) {
    if (!b) return "";
    const bits = [b.replyOwed ? "the player is owed an answer, so one corrected post goes out now" : `${b.postsLeftBeforePause} post${b.postsLeftBeforePause === 1 ? "" : "s"} left before a ten minute pause`];
    if (b.pausedForSec) bits.push(`paused for ${b.pausedForSec}s`);
    if (b.longPostInSec) bits.push(`a long post is allowed in ${b.longPostInSec}s (a short line is fine now)`);
    if (b.lastPost) bits.push(`last post ${b.lastPost.ageSec}s ago: "${b.lastPost.text.slice(0, 160)}"`);
    return `Post budget: ${bits.join("; ")}. Do not retry the same text.`;
  }
  // Keir 9: any human in the ticket channel (player, owner, developer, moderator) after a time, from the
  // channel record. Staff addressing Keir are news the same as the player, so the update-spam rule and the
  // finish rule no longer contradict each other (8.4 deadlock).
  const humanInChannelSince = (job, at) => (d.channelContext?.[job.channelId || job.replyChannel] || [])
    .some((r) => ["player", "owner", "support", "moderator"].includes(r.role) && r.authorId !== config.botId && (Date.parse(r.at || "") || r.observedAt || 0) > at);
  // An approved action that ran for this ticket after a time.
  const approvedActionSince = (ticketNo, at) => {
    const ids = new Set(Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo).map((j) => j.id));
    return Object.values(d.actions || {}).some((a) => ids.has(a.jobId) && a.state === "done" && (a.executedAt || 0) > at);
  };
  const MONOLOGUE_CAP = 3;
  const waitingStage = ticketNo => JSON.stringify({ evidence: Object.fromEntries(Object.entries(ticketEvidence(ticketNo)).map(([k,v])=>[k,v.done])), suggestions: Object.values(d.jobs).filter(j=>ticketOf(j)===ticketNo).flatMap(j=>Object.values(j.filedSuggestions||{}).map(s=>s.number)).sort((a,b)=>a-b) });
  // The text of every read on this ticket: this activation's and earlier ones'. Never Keir's own notes, its own earlier posts
  // (ticket_history) or the reporter's words: those are not what a page or record shows.
  const SELF_READS = new Set(["ticket_history", "ticket_record", "reporter_state", "remember", "checkpoint"]);
  function ticketReadTexts(ticketNo, jobs) {
    const live = (jobs || []).flatMap((j) => String(j.evidenceText || "").split(/\n\[([a-z_]+)\] /).slice(1).reduce((acc, v, i, all) => (i % 2 === 0 && !SELF_READS.has(v) ? [...acc, all[i + 1] || ""] : acc), []));
    return [...live, ...(d.ticketObservations?.[ticketNo] || []).filter((o) => !SELF_READS.has(o.tool)).map((o) => o.result)];
  }
  // Keir 10 (replay 2026-11-15): code rarely labels its own bug, so a defect found by reading code could never be named, and Keir
  // told a player "I have not confirmed this is a fault" after confirming it. A filed bug on this ticket plus a recorded fact whose
  // source is a file this ticket actually read backs the label. An opinion about what the rule ought to be still has neither.
  function filedBugBacking(ticketNo, jobs) {
    const filed = Object.values(d.keirIssues || {}).some((x) => x.ticket === ticketNo || x.tickets?.includes(ticketNo)) || (jobs || []).some((j) => (j.issues || []).length);
    if (!filed) return [];
    // Files this ticket read: in the read texts of this activation, and in the evidence receipts, which survive wakes.
    const reads = [ticketReadTexts(ticketNo, jobs).join("\n"), ...(jobs || []).flatMap((j) => (j.evidenceBatches || []).flatMap((b) => (b.queries || []).map((q) => q.path || "")))].join("\n");
    return (knowledge.ticketRecord(ledger, ticketNo).facts || []).filter((f) => !f.closedAt && f.source && f.text).filter((f) => {
      const files = String(f.source).match(/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|json)\b/g) || [];
      return files.some((file) => reads.includes(file));
    }).map((f) => `bug: ${f.text}`);
  }
  const ticketPlayerText = (job) => [job.source?.content, ...(job.requestInbox || []).map((m) => m?.content), ...(job.inbox || []).filter((m) => m && m.role === "player").map((m) => m.content),
    ...(d.channelContext?.[job.channelId || job.replyChannel] || []).filter((m) => m.role !== "assistant" && m.authorId !== config.botId).slice(-15).map((m) => m.content)].filter(Boolean).join(" ");
  // The reads on this ticket that say anything about the reporter's account: reporter_state results and users or characters queries.
  const ACCOUNT_READ = /\b(?:username|sequentialId|discord\w*|userId|purchase\w*|payment\w*|patreon\w*|subscription\w*|refund\w*|entitlement\w*|supporter\w*)\b/i;
  // Keir 9.0.4 (owner): an account fact rests on a read made in THIS activation (job.evidenceText is reset at each
  // activation start), not on an older read or another task's.
  function ticketAccountReads(ticketNo, job) {
    const segs = String(job.evidenceText || "").split(/\n\[([a-z_]+)\] /).slice(1).reduce((acc, v, i, all) => (i % 2 === 0 ? [...acc, [v, all[i + 1] || ""]] : acc), []);
    const reads = segs.filter(([tool, text]) => tool === "reporter_state" || (tool !== "ticket_history" && tool !== "ticket_record" && tool !== "remember" && tool !== "checkpoint" && ACCOUNT_READ.test(text))).map(([, text]) => text);
    const fresh = job.reporterInspection && (!job.activationAt || (job.reporterInspection.at || 0) >= job.activationAt) ? [job.reporterInspection] : [];
    return { reads, inspections: fresh };
  }
  // After the second refusal the clause goes out labelled as unconfirmed, by code, rather than as a recorded fact.
  function softenUnreadClaims(job, ticketNo, message) {
    if ((d.readClaimRefusals?.[ticketNo] || 0) < readClaim.MAX_REFUSALS) return message;
    const bad = readClaim.unbackedClaims(message, ticketReadTexts(ticketNo, Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo)), ticketPlayerText(job));
    if (!bad.length) return message;
    ledger.audit("read_claim_hedged", { job: job.id, ticket: ticketNo, clause: bad[0].clause.slice(0, 160) });
    return readClaim.hedge(message, bad, require("./playercopy").MAX_CHARS);
  }
  // Keir 9.0.4: after two refusals, an account fact with no read in this activation goes out labelled as not checked.
  function softenAccountClaims(job, ticketNo, message) {
    if ((d.accountClaimRefusals?.[ticketNo] || 0) < accountClaim.MAX_REFUSALS) return message;
    const claim = accountClaim.unbackedAccountClaim(message, ticketAccountReads(ticketNo, job));
    if (!claim) return message;
    ledger.audit("account_claim_labelled", { job: job.id, ticket: ticketNo, claim: claim.kind, reason: claim.reason });
    return accountClaim.labelUnchecked(message);
  }
  // Same for a sentence that calls behaviour a bug or says it needs a code change with no read marking it a fault.
  function softenBugClaims(job, ticketNo, message) {
    if ((d.bugClaimRefusals?.[ticketNo] || 0) < bugClaim.MAX_REFUSALS) return message;
    const tj = Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo);
    const claim = bugClaim.unbackedBugClaim(message, [...ticketReadTexts(ticketNo, tj), ...filedBugBacking(ticketNo, tj)], ticketPlayerText(job));
    if (!claim) return message;
    ledger.audit("bug_claim_hedged", { job: job.id, ticket: ticketNo, sentence: claim.sentence.slice(0, 160) });
    return bugClaim.hedge(message, claim, require("./playercopy").MAX_CHARS);
  }
  // Keir 9.0.5 (replay, 2026-11-14): what backs a settings instruction is a read of the game (code, game data), never the
  // player's own report or messages. The ticket record carried the player's "Android ... animations" words, and that let
  // "check your Android accessibility settings" through.
  // Also Keir's own earlier posts inside the ticket record (publicUpdates): one unbacked instruction must not back the next.
  // Matches JSON stored once or twice encoded.
  const PLAYER_RECORD = /\\?"kind\\?"\s*:\s*\\?"ticket\\?"|\\?"reporter\\?"\s*:|\\?"description\\?"\s*:|\\?"authorId\\?"\s*:|\\?"publicUpdates\\?"\s*:/;
  const settingReadTexts = (ticketNo, jobs) => ticketReadTexts(ticketNo, jobs).filter((t) => !PLAYER_RECORD.test(String(t)));
  // Same for an instruction to change a setting that no read on the ticket names (Keir 9.0.4, ticket 1829).
  function softenSettingClaims(job, ticketNo, message) {
    if ((d.settingClaimRefusals?.[ticketNo] || 0) < settingClaim.MAX_REFUSALS) return message;
    const bad = settingClaim.unbackedSettingClaims(message, settingReadTexts(ticketNo, Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo)));
    if (!bad.length) return message;
    ledger.audit("setting_claim_hedged", { job: job.id, ticket: ticketNo, phrase: bad[0].phrase.slice(0, 160) });
    return settingClaim.hedge(message, bad, require("./playercopy").MAX_CHARS);
  }
  // opts.collect (check_draft): every refusal is recorded and the checks carry on, so one call lists all the problems.
  // Without it the first refusal throws, exactly as before.
  function guardTicketPostRules(job, ticketNo, message, opts = {}) {
    const refuse = (text) => { if (opts.collect) { opts.collect.push(String(text)); return; } throw new Error(text); };
    const attempt = (fn) => { try { fn(); } catch (e) { if (!opts.collect) throw e; opts.collect.push(String(e.message)); } };
    attempt(() => require("./advicerouting").guard(job, d, message));
    attempt(() => guardPlayerRegister(job, ticketNo, message));
    // Keir 10.1.14 (live ledger 2026-11-17): nothing-new posts, guessed causes and capability claims in holding lines,
    // incomplete build price verdicts, and "waiting on the owner" after the owner answered in the channel.
    if (!opts.system) {
      const sameJobs = Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo);
      const staffAsked = (job.role === "owner" || developerTask(job)) && Math.max(job.observedPlayerAt || 0, Date.parse(job.source?.at || "") || 0) > (job.lastPublishedAt || 0);
      attempt(() => { const t = standdown.holdingClaimRefusal(message); if (t) { ledger.audit("holding_guess_refused", { job: job.id, ticket: ticketNo }); throw new Error(t); } });
      attempt(() => { const t = standdown.capabilityClaim(message); if (t) { ledger.audit("capability_claim_refused", { job: job.id, ticket: ticketNo }); throw new Error(t); } });
      attempt(() => { const refusals = (d.priceVerdictRefusals ||= {}); if ((refusals[ticketNo] || 0) >= 3) return;
        const t = standdown.priceVerdictRefusal(message, ticketReadTexts(ticketNo, sameJobs)); if (t) { refusals[ticketNo] = (refusals[ticketNo] || 0) + 1; ledger.save(); ledger.audit("price_verdict_refused", { job: job.id, ticket: ticketNo }); throw new Error(t); } });
      // Keir 11.2: "waiting on the owner" needs an open question. GitHub-reconciled decisions (prtruth.js) close when the PR merged or closed.
      attempt(() => { if (standdown.claimsOwnerWait(message) && !Object.values(d.decisions || {}).some((x) => x.state === "pending" && (ticketOf(d.jobs[x.jobId] || {}) === ticketNo || Number(x.ticket) === ticketNo)) && !standdown.ownerAnsweredSince(d, ticketNo)) { ledger.audit("owner_wait_claim_refused", { job: job.id, ticket: ticketNo, reason: "no open question" }); throw new Error("Not posted: nothing on this ticket is waiting on the owner; no question to them is open (a PR it was about may have merged or closed on GitHub). Say what is actually happening now."); } });
      attempt(() => { if (standdown.claimsOwnerWait(message) && standdown.ownerAnsweredSince(d, ticketNo)) { ledger.audit("owner_wait_claim_refused", { job: job.id, ticket: ticketNo }); throw new Error("Not posted: the owner already answered the open decision in this ticket's channel, so it is not waiting on them. Read their message in the channel and act on it, or say what you are doing now."); } });
    }
    // The owner or a developer asking Keir directly in a ticket is owed the answer now. The
    // pacing rules below (another task just posted, the monologue cap, ten-minute spacing)
    // held the owner's answer back on ticket 1757 (2026-11-03) and read as Keir going silent.
    const askedAt = Math.max(job.observedPlayerAt || 0, Date.parse(job.source?.at || "") || 0);
    const answeringStaff = (job.role === "owner" || developerTask(job)) && askedAt > (job.lastPublishedAt || 0);
    // Blocked on the owner means one notice, then silence (ticket 1514 posted
    // "still waiting on your call" three times in four hours). A direct
    // question to the player, or a new player message, is not silence.
    const question = /\?/.test(message);
    const playerSpokeAfter = (at) => humanAt(ticketNo) > at;
    if (!question && require("./supportblockers").unchangedWait(message)) {
      const old = d.supportWaitingNotices?.[ticketNo];
      if (old?.stage === waitingStage(ticketNo) && humanAt(ticketNo) <= old.humanAt)
        refuse("Not posted: the player already has this waiting state. Keep working privately; post a new finding or verified milestone, not another unchanged deployment notice.");
    }
    const pending = Object.values(d.decisions || {}).find((x) => x.state === "pending" && ticketOf(d.jobs[x.jobId] || {}) === ticketNo);
    if (pending) {
      // A status card is edited in place, not a message to the player: it never uses the one
      // notice (KBX5 held-player, 2026-11-03: a card edit after the player's question blocked the answer).
      const noticed = (d.ticketPosts?.[ticketNo] || []).filter((p) => p.at >= pending.at && !isCardPost(p)).at(-1) || (d.monologue?.[ticketNo]?.decisionNoticeAt >= pending.at ? { at: d.monologue[ticketNo].decisionNoticeAt } : null);
      if (noticed && !question && !playerSpokeAfter(noticed.at) &&
          (PENDING_APPROVAL.test(message) || require("./supportblockers").unchangedWait(message)))
        refuse(`Not posted: ticket ${ticketNo} is waiting on the owner's decision (asked ${Math.round((now() - pending.at) / 60000)} min ago) and the player already has one notice about it. Do not repeat this wait; independent findings and answers may still be posted.`);
    }
    // Monologue cap (ticket 1514: 52 Keir messages to 4 human). After three
    // consecutive Keir posts, pause ten minutes instead of silencing the ticket indefinitely.
    // One post per task per ten minutes unless the player wrote or it is a
    // question (ticket 1539: two essays a minute apart). A correction is one
    // or two sentences and is never followed by the long version.
    // The progress card is edited in place and is not a message, so it does not
    // hold back the answer it announces (ticket 1540).
    const mine = (d.ticketPosts?.[ticketNo] || []).filter((p) => p.jobId === job.id && !isCardPost(p)).at(-1);
    // Keir 9.0.2 (ticket 1829): while the player is owed an answer (the unanswered-player rule has refused a finish for
    // their latest message, or an answer to it was refused), pacing never holds the answer back. On 1829 the cause was found,
    // the first draft was refused by the screen, the rewrite was held by both pacing rules, and the player got "no confirmed answer".
    // Keir 10 (ticket 1812): an armed replyRefusedPending means a corrected answer is owed, so pacing lets one through. Once the
    // player's latest message has a real answer, nothing is owed and a refused extra post unlocks nothing.
    const owedNow = (() => { const h = humanAt(ticketNo), rec = d.unansweredFinishes?.[ticketNo];
      if (playerAnswered(ticketNo, job)) return false;
      return Boolean(job.replyRefusedPending) || h > 0 && ((rec && rec.humanAt === h && rec.refused > 0 && !rec.limitationPostedAt) || Object.values(d.jobs).some((j) => ticketOf(j) === ticketNo && (j.replyAttemptRefusedAt || 0) > h)); })();
    if (!answeringStaff && !owedNow && mine && now() - mine.at < 10 * 60000 && !question && !playerSpokeAfter(mine.at) && sentences(message).length >= 3)
      refuse(`Not posted: this task posted in ticket ${ticketNo} ${Math.max(1, Math.round((now() - mine.at) / 60000))} min ago. A short line is fine; anything longer waits ten minutes unless the player writes. If the last post was wrong, say so in one short sentence; the detail goes on the status card note.`);
    // The same question again (1592 asked one question four times in 31
    // hours): asking twice is a reminder, a third time is not progress.
    const asked = repeatedQuestion(ticketNo, message);
    if (asked >= 2) refuse(`Not posted: you have already asked the player this ${asked} times. Do not ask again; work with what you have, say what you will assume, or finish waiting for their reply.`);
    if (isCorrection(message) && sentences(message).length > 2)
      refuse("Not posted: a correction is one or two sentences, what was wrong and what is right. The explanation goes on the status card note, not in the channel.");
    const run = d.monologue?.[ticketNo];
    if (!answeringStaff && !owedNow && run && run.humanAt === humanAt(ticketNo) && run.count >= MONOLOGUE_CAP && now() - run.at < 10 * 60000 && !question)
      refuse(`Not posted: Keir has posted ${run.count} times in ticket ${ticketNo} since the player last wrote. Wait ten minutes before another substantive update unless the player writes or you need to ask them something. Do not claim the answer was delivered by editing a status card.`);
    // A developer asking Keir in the ticket gets one answer, from their own task.
    // The automatic ticket task must not answer it over them (ticket 1510).
    if (job.kind === "ticket") {
      const dev = Object.values(d.jobs).find((j) => j.id !== job.id && j.kind === "command" && j.ticket === ticketNo && [config.ownerId, ...config.staffIds].includes(j.actorId) && !JOB_TERMINAL.includes(j.state) && humanAt(ticketNo) <= (Date.parse(j.source?.at || "") || now()));
      if (dev) refuse(`Not posted: a developer's own task (${dev.id}) is handling a request in ticket ${ticketNo}. Do not answer or refuse developer requests here; leave them to that task. Finish waiting.`);
    }
    // Keir 11.4 (owner, 2026-11-21): "with the developers" only when a person holds it and never to the person who asked;
    // no blanket "I cannot render" or "read-only". Each refusal names the true sentence to use.
    if (!opts.system) {
      const t = handoffTruth.deflection(message, { d, job, ticketNo, jobs: Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo), config, previewFailed: Boolean(job.previewFailure) });
      if (t) { ledger.audit("deflection_refused", { job: job.id, ticket: ticketNo, kind: /render/.test(t) ? "render" : /ticket_command/.test(t) ? "read_only" : "handoff" }); refuse(t); }
    }
    const ev = ticketEvidence(ticketNo);
    const claims = outcomeClaims(message);
    const verifiedNow = ev.verified.done && Object.values(d.jobs).some((j) => ticketOf(j) === ticketNo && (j.lastGameReadAt || 0) > humanAt(ticketNo) && (j.turnChecks || []).some((at) => (j.lastGameReadAt || 0) > at));
    const missing = claims.filter((c) => c.kind === "money" ? !(c.future ? ev.money.agreed : ev.money.done) : c.kind === "verified" ? !c.future && !verifiedNow : !c.future && !ev[c.kind].done);
    if (missing.length) refuse(`Not posted: this states an outcome Keir has no receipt for ("${missing[0].sentence}"). ${[...new Set(missing.map((c) => NEED[c.kind]))].join(" ")} Say only what is verified.`);
    attempt(() => guardTicketQuality(job, ticketNo, message, ev));
    const posts = (d.ticketPosts ||= {})[ticketNo] || [];
    // Keir 8.2 (ticket 1763, 2026-11-05 13:32): two tasks told the player "the fix is live" 20 seconds apart.
    // One release or fix announcement per ticket per 30 minutes, whichever task makes it.
    if (claims.some((c) => (c.kind === "main" || c.kind === "verified") && !c.future)) {
      const said = posts.find((p) => now() - p.at < 30 * 60000 && !isCardPost(p) && outcomeClaims(p.text).some((c) => (c.kind === "main" || c.kind === "verified") && !c.future) && !playerSpokeAfter(p.at));
      if (said) refuse(`Not posted: ticket ${ticketNo} was told this is live ${Math.max(1, Math.round((now() - said.at) / 60000))} min ago ("${said.text.slice(0, 160)}"). Do not announce it again; post only what is new.`);
    }
    attempt(() => guardStall(job, ticketNo, message, posts));
    // Keir 11.2: a step-back activation states the ticket's position in a checkpoint first, then posts at most once.
    // Review N3: only a step-back started by this activation applies; one left open by an activation that ended without
    // finish (turn limit, crash, restart) never refuses a later activation's answer.
    if (!opts.system && closing.stepBackActive(job)) attempt(() => {
      const t = closing.stepBackRefusal(job, { checkpointed: (job.history || []).some((h) => h.kind === "checkpoint" && Date.parse(h.at || "") >= job.stepBack.at) });
      if (t) { ledger.audit("step_back_post_refused", { job: job.id, ticket: ticketNo }); if (!opts.collect) noteRefused("step_back", job, ticketNo, message); throw new Error(t); }
    });
    // Keir 11.2 post budget (postbudget.js): one live announcement per shipped change, turn reports only when the answer
    // changed, and an hourly cap without a new player message whose overflow is one merged correction or answer.
    if (!opts.system && !answeringStaff) {
      const pb = require("./postbudget"), h = humanAt(ticketNo);
      // A rule in force refuses (and the refusal is recorded); a rule in preview records what it would have refused and lets
      // the post through; a rule switched off does nothing.
      const rule = (name, kind, text) => {
        const g = ctl().gate(name);
        if (!g.run) return;
        ledger.audit(kind, { job: job.id, ticket: ticketNo, ...(g.act ? {} : { preview: true }) });
        if (opts.collect) { if (g.act) refuse(text); return; }
        if (!g.act) { controlsLib.preview(d, "post-rules", `would refuse (${kind})`, `ticket ${ticketNo}`, String(message).slice(0, 300), {}, now()); return; }
        noteRefused(kind, job, ticketNo, message);
        refuse(text);
      };
      // Second pass soft spot: what always gets through, in some form, whatever the budget or turn rule says: a correction,
      // the answer to something the player asked since Keir last really answered (holding lines do not count as answers),
      // and a follow-up Keir promised. These three are never refused by the rules below.
      const correction = isCorrection(message);
      const promiseDue = require("./promises").calledFor(d, ticketNo, now()) || owedNow;
      const answerPosts = posts.filter((p) => !isCardPost(p) && !holdingPost(p.text));
      const ls = d.lastSubstantive?.[ticketNo];
      const paceAt = (d.ticketPace?.[ticketNo]?.log || []).filter((p) => !holdingPost(p.text)).at(-1)?.at || 0;
      const lastAnswerAt = Math.max(answerPosts.at(-1)?.at || 0, ls && !ls.holding ? ls.at : 0, paceAt);
      const playerAsked = h > 0 && h > lastAnswerAt;
      if (pb.liveClaim(message) && !correction) {
        const said = pb.liveAlreadySaid({ posts, receipt: pb.mainReceipt(Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo)), humanAt: h });
        if (said) rule("postBudget", "live_repeat_refused", `Not posted: the player was already told this release is live ("${String(said.text).slice(0, 140)}"). Do not announce it again; post only what is new.`);
      }
      // Keir 11.2: one turn rule (postbudget.turnPostRule): turn commentary only when the player asked, a recorded promise is
      // due, or the closing condition calls for that turn's result; and never the same answer twice.
      // An answer the player is owed (owedNow) passes like a due promise: it answers them.
      const root = d.jobs[d.seen?.[`ticket:${ticketNo}`]];
      const calledFor = closing.closingCallsForTurn(d, job, now()) || (root && root !== job && closing.closingCallsForTurn(d, root, now()));
      // Review N10: an open player question this post answers makes it an answer; any open question makes a doubt, not a refusal.
      const ask = require("./ticketcase").openAsk(d, ticketNo, message, now());
      const turnArgs = { posts: answerPosts, humanAt: h, message, correction, promiseDue, calledFor, lastKeirAt: lastAnswerAt, answersAsk: ask.answers, openAsk: ask.open > 0 };
      const turnRule = pb.turnPostRule(turnArgs);
      if (turnRule) rule("turnRule", turnRule.why === "same turn answer" ? "turn_repeat_refused" : "turn_post_not_called_for", turnRule.refusal);
      else if (!opts.collect) { const via = pb.turnPostVia(turnArgs); if (via === "closing") job.turnReportViaClosing = true; else if (via === "promise" && !owedNow) job.turnReportViaPromise = true; else if (via === "doubt" && ctl().gate("turnRule").run) noteDoubt("turn_rule", job, ticketNo, message); } // a report uses up what called for it
      const cap = Number(config.ticketPostsPerHour) || pb.DEFAULT_PER_HOUR;
      const r = pb.hourly({ posts, humanAt: h, now: now(), cap, essential: owedNow || correction || playerAsked || ask.answers || require("./promises").dueNow(d, ticketNo, now()), overflowUsedAt: d.postOverflow?.[ticketNo]?.at || null });
      if (!r.allow) rule("postBudget", "hourly_post_cap_refused", pb.hourlyRefusal(r, cap));
    }
    // Keir 10: a post must not contradict this ticket's earlier posts without saying "Correction:", and must not call something
    // available that a read in this activation says is locked. check_draft runs the same two checks.
    if (!opts.system) {
      const clash = claimcheck.contradiction(message, posts, { now: now() });
      if (clash) { ledger.audit("contradiction_refused", { job: job.id, ticket: ticketNo, pred: clash.pred }); refuse(claimcheck.contradictionRefusal(clash)); }
      const locked = claimcheck.unlockConflict(message, job.evidenceText);
      if (locked) { ledger.audit("unlock_claim_refused", { job: job.id, ticket: ticketNo, noun: locked.noun }); refuse(claimcheck.unlockRefusal(locked)); }
      // Keir 10.3: the durable case file keeps every claim made to the player (ticketPosts only keeps a day), so a reversal
      // of a standing claim is refused unless the post starts "Correction:" (ticket 1852: "reachable", then "not reachable").
      if (!clash) {
        const caseClash = require("./ticketcase").contradiction(d, ticketNo, message, { now: now() });
        if (caseClash) { ledger.audit("case_contradiction_refused", { job: job.id, ticket: ticketNo, claim: caseClash.claimId }); refuse(require("./ticketcase").contradictionRefusal(caseClash)); }
      }
      // Keir 10.4 (ticket 1852): answer what the player asked before anything else. A post that redirects ("the real blocker is")
      // or concludes ("working as intended") without touching an open asked item is refused, at most twice per ticket so it never sticks.
      // Staff-directed tasks answer staff, not the player's open items. check_draft (collect) reports it without spending the budget.
      if (!answeringStaff) {
        const tcase = require("./ticketcase");
        const deflect = tcase.deflectionBudgetLeft(d, ticketNo) ? tcase.deflection(d, ticketNo, message) : null;
        if (deflect) {
          if (!opts.collect) { tcase.noteDeflectionRefusal(d, ticketNo); ledger.save(); }
          ledger.audit("asked_deflection_refused", { job: job.id, ticket: ticketNo, phrase: deflect.phrase, collect: Boolean(opts.collect) || undefined });
          refuse(tcase.deflectionRefusal(deflect));
        }
      }
    }
    const other = answeringStaff || owedNow ? null : posts.filter((p) => p.jobId !== job.id && now() - p.at < 3 * 60000 && !isCardPost(p) && !playerSpokeAfter(p.at)).at(-1);
    if (other) refuse(`Not posted: another Keir task updated ticket ${ticketNo} ${Math.round((now() - other.at) / 1000)}s ago: "${other.text.slice(0, 300)}". Do not repeat or contradict it. If you have something materially new, wait a few minutes and post one message that builds on it, or record it with checkpoint for the ticket task.`);
    // Ticket 1773 (2026-11-05): a developer's ping started a second task that restated the ticket task's
    // answer 15 seconds later (similarity 0.5). Paraphrased repeats measure 0.41 to 0.79 and unrelated
    // replies 0.05 or less, so within five minutes 0.4 is a repeat, whoever is being answered.
    // Keir 10: a post that starts "Correction:" restates the thing it corrects, so it is never a repeat.
    const dup = isCorrection(message) ? null : posts.find((p) => now() - p.at < 30 * 60000 && similarity(p.text, message) >= 0.6 || !isCardPost(p) && now() - p.at < 5 * 60000 && similarity(p.text, message) >= 0.4);
    if (dup) refuse(`Not posted: ticket ${ticketNo} already got this update ${Math.round((now() - dup.at) / 60000)} min ago. Post only something new.`);
    // Keir 8.4 (owner, 2026-11-06): hedging away from readable code, and update spam.
    const timid = replyPolicy.timidRefusal(message, { lookups: Math.max(0, ...Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo).map((j) => j.codeLookups || 0)) });
    if (timid) { ledger.audit("timid_answer_refused", { job: job.id, ticket: ticketNo }); refuse(timid); }
    const lastPost = posts.filter((p) => !isCardPost(p)).at(-1);
    const sameTicketJobs = Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo);
    const spam = opts.system || owedNow ? null : replyPolicy.milestoneRefusal({ message, lastPost, claims, answeringStaff, correction: isCorrection(message),
      playerSpokeAfter: lastPost ? playerSpokeAfter(lastPost.at) : false,
      humanSpokeAfter: lastPost ? humanInChannelSince(job, lastPost.at) : false,
      approvedActionSince: lastPost ? approvedActionSince(ticketNo, lastPost.at) : false,
      newReadSince: lastPost ? sameTicketJobs.some((j) => (j.lastGameReadAt || 0) > lastPost.at || (j.lastCodeReadAt || 0) > lastPost.at) : false });
    if (spam) { ledger.audit("update_spam_refused", { job: job.id, ticket: ticketNo }); refuse(spam); }
    if (!opts.system) {
      const chamber = ruleLookup.chamberRefusal(message, d.ticketObservations?.[ticketNo] || [], job.observedPlayerAt || 0);
      if (chamber) refuse(chamber);
    }
    // Keir 9: a rule or a cause stated before anything in this ticket read the game code is refused once per
    // ticket, so the answer rests on the code and not on the data on screen. Never again after that (no loops).
    // The fast lane posts an Ask answer that is already grounded in the code index, so it is exempt.
    if (!opts.system && !(job.fastLane && !job.fastLane.escalated) && process.env.KEIR_RULE_LOOKUP !== "0"
        && !sameTicketJobs.some((j) => j.lastCodeReadAt || j.codeLookups)) {
      const claim = ruleLookup.ruleClaim(message);
      if (claim) {
        // First refusal: read the code. Second: no successful code read yet, so a rule or cause goes out only if the reply
        // says plainly it is not confirmed. Never a third refusal on one ticket.
        const refusals = (d.ruleLookupRefusals ||= {});
        const n = refusals[ticketNo] || 0;
        const unconfirmed = ruleLookup.statesUnconfirmed(message);
        if (n === 0 || (n === 1 && !unconfirmed)) {
          refusals[ticketNo] = n + 1; (d.ruleLookupRefused ||= {})[ticketNo] = now(); ledger.save();
          ledger.audit("rule_lookup_required", { job: job.id, ticket: ticketNo, claim: claim.kind, pattern: claim.pattern, attempt: n + 1 });
          refuse(n === 0 ? ruleLookup.REFUSAL : ruleLookup.REFUSAL_UNCONFIRMED);
        }
      }
    }
    // Keir 10.2.1 (ticket 1841): a player asking "why does 1 depot cost 22 million dollars" is reporting a suspect number. An
    // explanation or defence of the price needs a live read first, and is refused outright when that read shows the price is out of
    // proportion to the company's cash. Refused at most three times per ticket (no loops); the read-claim gate then hedges it.
    if (!opts.system) {
      const refusals = (d.priceReportRefusals ||= {});
      if ((refusals[ticketNo] || 0) < 3) {
        const playerText = ticketPlayerText(job), texts = ticketReadTexts(ticketNo, sameTicketJobs);
        const text = priceReport.refusal(message, { playerText, reads: texts, gameRead: sameTicketJobs.some((j) => j.lastGameReadAt) || texts.length > 0,
          backed: !readClaim.unbackedClaims(message, texts, playerText).length });
        if (text) { refusals[ticketNo] = (refusals[ticketNo] || 0) + 1; ledger.save(); ledger.audit("price_report_refused", { job: job.id, ticket: ticketNo, attempt: refusals[ticketNo] }); refuse(text); }
      }
    }
    // Keir 9 (replay 2026-11-13): "X already includes Y, so counting both double counts" is refused, at most twice per
    // ticket, when what this ticket read says the inclusion is only partial, or says nothing about it. Same exemptions as above.
    if (!opts.system) {
      const refusals = (d.inclusionRefusals ||= {});
      if ((refusals[ticketNo] || 0) < 2) {
        const texts = [...(ledger.data.ticketObservations?.[ticketNo] || []).map((r) => r.result), ...knowledge.ticketRecord(ledger, ticketNo).facts.filter((f) => !f.closedAt).map((f) => f.text)];
        const refusal = ruleLookup.inclusionRefusal(message, texts);
        if (refusal) { refusals[ticketNo] = (refusals[ticketNo] || 0) + 1; ledger.save(); ledger.audit("inclusion_claim_refused", { job: job.id, ticket: ticketNo, attempt: refusals[ticketNo] }); refuse(refusal); }
      }
    }
    // Keir 9: a sentence that says what a page, record or panel shows must rest on a read of this ticket that contains those
    // words (replay tickets: "the tile reads how much you put up for sale", "your record says inputs held the run back", when
    // the reads showed neither). Refused at most twice per ticket; after that the code labels the clause unconfirmed (see
    // softenUnreadClaims) so the player still gets the answer. Never blocks finishing: the text is in PACING_REFUSAL.
    if (!opts.system) {
      const bad = readClaim.unbackedClaims(message, ticketReadTexts(ticketNo, sameTicketJobs), ticketPlayerText(job));
      const refusals = (d.readClaimRefusals ||= {});
      if (bad.length && (refusals[ticketNo] || 0) < readClaim.MAX_REFUSALS) {
        refusals[ticketNo] = (refusals[ticketNo] || 0) + 1; ledger.save();
        ledger.audit("read_claim_refused", { job: job.id, ticket: ticketNo, attempt: refusals[ticketNo], clause: bad[0].clause.slice(0, 160) });
        refuse(readClaim.REFUSAL(bad[0]));
      }
    }
    // Keir 9 (replay 2026-11-13): "this is a bug" / "needs a code change" is a claim. A sentence that labels behaviour a defect
    // needs a read on this ticket that marks it a fault, or plain "not confirmed" wording; otherwise refused, at most twice per
    // ticket, then labelled unconfirmed by code (softenBugClaims). Never blocks finishing: the text is in PACING_REFUSAL.
    if (!opts.system) {
      const refusals = (d.bugClaimRefusals ||= {});
      if ((refusals[ticketNo] || 0) < bugClaim.MAX_REFUSALS) {
        const claim = bugClaim.unbackedBugClaim(message, [...ticketReadTexts(ticketNo, sameTicketJobs), ...filedBugBacking(ticketNo, sameTicketJobs)], ticketPlayerText(job));
        if (claim) {
          refusals[ticketNo] = (refusals[ticketNo] || 0) + 1; ledger.save();
          ledger.audit("bug_claim_refused", { job: job.id, ticket: ticketNo, attempt: refusals[ticketNo], pattern: claim.pattern });
          refuse(bugClaim.REFUSAL(claim));
        }
      }
    }
    // Keir 9.0.3 (owner, 2026-11-13): a statement about the player's account link or character ("not linked", "no Discord link",
    // "has no character") needs a read on this ticket that shows it. Whoever asked, in any task posting here. Refused once per ticket.
    if (!opts.system) {
      const refusals = (d.accountClaimRefusals ||= {});
      if ((refusals[ticketNo] || 0) < accountClaim.MAX_REFUSALS) {
        const claim = accountClaim.unbackedAccountClaim(message, ticketAccountReads(ticketNo, job));
        if (claim) {
          refusals[ticketNo] = (refusals[ticketNo] || 0) + 1; ledger.save();
          ledger.audit("account_claim_refused", { job: job.id, ticket: ticketNo, claim: claim.kind, reason: claim.reason });
          refuse(accountClaim.REFUSAL(claim));
        }
      }
    }
    // Keir 9.0.4 (ticket 1829): "turn off X in Settings" says what controls the behaviour. It needs a read on this ticket that
    // names that setting; otherwise refused, at most twice per ticket, then labelled unconfirmed by code (softenSettingClaims).
    if (!opts.system) {
      const refusals = (d.settingClaimRefusals ||= {});
      if ((refusals[ticketNo] || 0) < settingClaim.MAX_REFUSALS) {
        const bad = settingClaim.unbackedSettingClaims(message, settingReadTexts(ticketNo, sameTicketJobs));
        if (bad.length) {
          refusals[ticketNo] = (refusals[ticketNo] || 0) + 1; ledger.save();
          ledger.audit("setting_claim_refused", { job: job.id, ticket: ticketNo, attempt: refusals[ticketNo], phrase: bad[0].phrase.slice(0, 160) });
          refuse(settingClaim.REFUSAL(bad[0]));
        }
      }
    }
    if (claims.some((c) => (c.kind === "escalated" || c.kind === "investigating") && !c.future))
      ledger.audit("handoff_claim_backed", { job: job.id, ticket: ticketNo, refs: replyPolicy.handoffRefs(sameTicketJobs, d.jobs) });
    // A status card is edited in place and a human question deserves an answer,
    // so neither holds a reply back (ticket 1602: the owner asked twice, Keir
    // Keir 10.1.14: nothing new from the player and no state change since the last substantive post. Runs after every more
    // specific rule so their refusals read first. Not while an answer is owed, and a human speaking in the channel, an approved
    // action that ran, a new read or a new independent finding counts as new.
    if (!opts.system && !owedNow && !job.replyRefusedPending && !/\?/.test(message)) {
      const lp = d.lastSubstantive?.[ticketNo];
      const something = lp && (humanInChannelSince(job, lp.at) || approvedActionSince(ticketNo, lp.at));
      const newRead = lp && sameTicketJobs.some((j) => (j.lastGameReadAt || 0) > lp.at || (j.lastCodeReadAt || 0) > lp.at);
      if (!something) attempt(() => { const t = standdown.noNewRefusal({ newRead, last: lp, humanAt: humanAt(ticketNo), fp: standdown.stateFingerprint(d, ticketNo), message, answeringStaff, now: now() });
        if (t) { ledger.audit("no_new_post_refused", { job: job.id, ticket: ticketNo }); throw new Error(t); } });
    }
    // drafted twice and stayed silent behind the coordinator's card).
  }
  // Keir 8.2 (ticket 1766, 2026-11-05): seven posts in five hours said "I haven't found what
  // mothballs the plant, so I won't guess" and none found it. The player: "why dont you look for
  // the answer instead of repeating you still havent found it?" A no-progress post is allowed once.
  // The next needs new code reads since the last one or a running investigator; a third needs the investigator.
  const STALL = /\b(?:haven'?t|have not|has not|hasn'?t|not)\s+(?:yet\s+)?(?:found|confirmed|pinned down|traced|worked out|identified|settled|checked)\b|\bwon'?t (?:guess|name a cause|claim a cause|speculate)\b|\bstill (?:checking|tracing|investigating|looking(?: into)?|working (?:out|on)) \b|\bno confirmed cause\b|\bso I won'?t guess\b/i;
  const isStall = (text) => STALL.test(String(text || "")) && !/\?/.test(String(text || "")) && !outcomeClaims(text).length;
  // Keir 10.2 (ticket 1837): the owner DM said only "next investigator to read build dialog pricing". An escalation says what was
  // checked, what it showed, and the specific blocker, so the person starts from findings and not from the player's question.
  const clipText = (t, n) => String(t || "").replace(/\s+/g, " ").slice(0, n);
  function escalationBrief(job, ticketNo, summary) {
    const jobs = Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo);
    return require("./escalationbrief").build({
      ticket: ticketNo, summary,
      playerAsked: String(ticketPlayerText(job) || "").slice(0, 300),
      reads: (d.ticketObservations?.[ticketNo] || []).filter((o) => !SELF_READS.has(o.tool)).map((o) => ({ input: o.input, result: o.result })),
      codeLookups: Math.max(0, ...jobs.map((j) => j.codeLookups || 0)), codeRead: jobs.some((j) => j.lastCodeReadAt),
      posts: (d.ticketPosts?.[ticketNo] || []).filter((p) => !isCardPost(p)).map((p) => p.text),
    });
  }
  function guardStall(job, ticketNo, message, posts) {
    if (!isStall(message)) return;
    // Keir 10.2 (ticket 1837): a "not confirmed" line 3 seconds after an answer contradicts it, and a second holding line 15 seconds
    // later repeated it. Until there are findings the player gets ONE reply per message of theirs: a stall is refused when anything
    // (not the intro, not a card) was already posted since the player last wrote and nothing new was read since that post.
    const since = humanAt(ticketNo);
    const lastReal = posts.filter((p) => !isCardPost(p) && !/^hi,? i(?:'|’)?m keir\b/i.test(String(p.text || "").trim()) && (since ? p.at >= since : p.jobId === job.id)).at(-1);
    if (lastReal && !Object.values(d.jobs).some((j) => ticketOf(j) === ticketNo && Math.max(j.lastGameReadAt || 0, j.lastCodeReadAt || 0) > lastReal.at)) {
      ledger.audit("holding_reply_refused", { job: job.id, ticket: ticketNo });
      throw new Error(`Not posted: the player was already answered ${Math.max(1, Math.round((now() - lastReal.at) / 60000))} min ago ("${String(lastReal.text).slice(0, 140)}") and nothing new has been read since. One reply per player message until you have findings: do not post a second holding or "not confirmed" line. Do the investigation instead (read_tool ops-knowledge code_exact or code_search for the code that decides it), then post what you found. If that earlier post was wrong, start with "Correction:" and give the verified fact.`);
    }
    const recent = posts.filter((p) => !isCardPost(p) && now() - p.at < 24 * 3600000);
    let run = 0; for (let i = recent.length - 1; i >= 0 && isStall(recent[i].text); i--) run++;
    if (!run) return;
    const lastStall = recent.at(-1).at;
    const jobs = Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo);
    // Keir 8.4 (owner, 2026-11-06): the second "still checking" post on the same question is where 1766 went
    // wrong (seven in five hours), so it is allowed only if the player wrote since and Keir has read code since
    // the last one; a running investigator no longer excuses a repeat (the player sees the same words again).
    // A third in a row is never allowed. ticketPosts now keeps 24 hours, so this sees the whole run.
    const playerWroteSince = Object.values(d.jobs).some((j) => ticketOf(j) === ticketNo && Math.max(j.observedPlayerAt || 0, j.lastPlayerAt || 0) > lastStall);
    const codeRead = jobs.some((j) => (j.lastCodeReadAt || 0) > lastStall);
    if (run >= 2 || !codeRead || !playerWroteSince) {
      ledger.audit("stall_refused", { job: job.id, ticket: ticketNo, run });
      throw new Error(`Not posted: the player already has ${run} "still checking, won't guess" post${run === 1 ? "" : "s"} in a row on ticket ${ticketNo}. A second one is not an answer. Do the investigation instead: read_tool ops-knowledge code_exact and code_search (claimType mechanic), rg in the game checkout, and read the player's records, then post what you found. If you cannot find it, raise it to the owner with what you tried (raise_to_developers kind decision, changeClass named) and tell the player once that it is with the owner. If the player gave a lead, follow it and say what it showed.`);
    }
  }
  // Review 2026-11-01 (tickets 1736 to 1747): apologies, third-person talk
  // about the player, unconfirmed "nothing exists" claims, promises with
  // nothing behind them and decisions nobody made (ticketquality.js).
  function guardTicketQuality(job, ticketNo, message, ev = ticketEvidence(ticketNo)) {
    const ids = new Set(Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo).map((j) => j.id));
    const names = config.developerNames || {};
    const answered = Object.values(d.decisions || {}).filter((x) => ids.has(x.jobId) && ["approved", "selected"].includes(x.state));
    const decisionFacts = knowledge.ticketRecord(ledger, ticketNo).facts.filter((f) => !f.closedAt && /\b(?:decided|ruled|approved|decision)\b/i.test(f.text || ""));
    const decided = ev.money.agreed || answered.length > 0 || decisionFacts.length > 0;
    // Who approved: the person who answered the decision (Ariane answering
    // for the owner is Ariane), then developers named in a recorded fact.
    const approvers = [...new Set([
      ...answered.map((x) => names[x.answeredBy]),
      ...decisionFacts.flatMap((f) => Object.values(names).filter((n) => new RegExp(`\\b${n}\\b`, "i").test(f.text || ""))),
    ].filter(Boolean))];
    const hit = require("./ticketquality").refusal(message, { emptyReads: job?.emptyReads || [], escalated: ev.escalated.done, building: ev.building.done, decided, approvers, developers: [...new Set(Object.values(names))] });
    if (!hit) return;
    ledger.audit("ticket_quality_refused", { job: job?.id || null, ticket: ticketNo, kind: hit.kind, sentence: hit.sentence });
    throw new Error(`Not posted: ${hit.reason}`);
  }
  async function finishPublicText(job) {
    if (!job.replyChannel) return null;
    // A developer task's bookkeeping is private even when it was requested
    // inside a player's ticket. Public answers use the explicit reply tool.
    if (ticketOf(job) && job.kind === "command") return null;
    try {
      let text = publicText(job.summary.replace(/[\u2013\u2014]/g, ","));
      const ticketNo = ticketOf(job);
      require("./advicerouting").guard(job, d, text);
      // Keir 5.6: a finish summary that narrates Keir's own bookkeeping ("no
      // further post needed", "already answered in the source channel") is an
      // internal note, not a reply. It leaked into ticket 1575 on 2026-10-16.
      if (META_SUMMARY.test(text) || require("./agent").STEP_LIMIT_TEXT.test(text)) throw new Error("finish summary is an internal note, not a player reply");
      if (ticketNo) {
        text = shapeTicketPost(text);
        if (TECHNICAL.test(text)) throw new Error("Ticket finish copy must use the player's register, without technical release details.");
        await guardTicketPost(job, ticketNo, text);
        recordTicketPost(job, ticketNo, text);
      }
      return text;
    } catch (error) {
      ledger.audit("finish_reply_suppressed", { job: job.id, ticket: ticketOf(job), reason: String(error.message).slice(0, 600) });
      return null;
    }
  }
  // Keir 3.0 status card (statuscard.js): one message per ticket, edited in
  // place. The ticket channel is checked against the ticket on first post.
  const statusCard = require("./statuscard");
  function cardItemsAllowed(ticketNo, items) {
    if (!Array.isArray(items) || !items.length || items.length > 10) throw new Error("a status card lists 1 to 10 fixes");
    const ev = ticketEvidence(ticketNo);
    return items.map((raw) => {
      const item = { name: statusCard.cleanName(raw?.name).slice(0, 120), stage: String(raw?.stage || ""), blocked: raw?.blocked === true, note: String(raw?.note || "").trim().slice(0, 200) };
      if (!item.name) throw new Error("every fix on the card needs a short player-facing name");
      const ok = statusCard.stageAllowed(item.stage, ev);
      if (!ok.ok) throw new Error(`Not posted: ${item.name}: ${ok.reason}.`);
      // Review 2026-11-01: "Supply offer sides: paused" told the player
      // nothing, and 1739's card went Live, Sandbox, Live, Investigating.
      if (item.blocked && !item.note) throw new Error(`Not posted: ${item.name} is paused with no note. Name exactly what it waits on, in the player's words ("waiting on a developer's decision about compensation").`);
      const was = (d.statusCards?.[ticketNo]?.items || []).find((i) => i.name === item.name);
      const back = statusCard.regression(was, item);
      if (back) { ledger.audit("status_card_regression_refused", { ticket: ticketNo, item: item.name, from: was.stage, to: item.stage }); throw new Error(`Not posted: ${item.name}: ${back}`); }
      for (const text of [item.name, item.note]) if (TECHNICAL.test(text)) throw new Error(`Not posted: "${text}" is technical; the card is player-facing (no PRs, CI, branches or code).`);
      for (const text of [item.name, item.note]) if (text) guardPlayerRegister(null, ticketNo, text);
      return item;
    });
  }
  // Keir's own avatar for the card's author line, read once from Discord.
  async function botAvatar() {
    if (d.botAvatarUrl !== undefined) return d.botAvatarUrl;
    try { const me = await discord("GET", "/users/@me"); d.botAvatarUrl = me?.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null; }
    catch { return null; }
    ledger.save(); return d.botAvatarUrl;
  }
  async function upsertCard(effectJob, ticketNo, { items, status = "" }) {
    require("./supporttakeover").assertCanAct(d, effectJob);
    await ensureDisclosure(ticketNo);
    const cards = (d.statusCards ||= {});
    const card = cards[ticketNo] || {};
    const body = statusCard.render({ ticket: ticketNo, items, status, at: now(), avatarUrl: await botAvatar() });
    let messageId = card.messageId, channelId = card.channelId, bumped = false;
    // Owner, 2026-10-14 (ticket 1539): edit in place while the card is still the
    // latest message in the channel. Once other messages have buried it, a
    // genuine update bumps the card: the old one is removed and the card is
    // posted again as the newest message, so the player sees the change
    // without scrolling. An unchanged card is never bumped.
    const changed = JSON.stringify([card.items || [], card.status || ""]) !== JSON.stringify([items, status]);
    if (messageId && changed) {
      let latest = null;
      try { latest = (await discord("GET", `/channels/${channelId}/messages?limit=1`))?.[0]?.id ?? null; } catch {}
      if (latest && latest !== messageId) {
        require("./supporttakeover").assertCanAct(d, effectJob);
        try { await discord("DELETE", `/channels/${channelId}/messages/${messageId}`); } catch {}
        messageId = null; bumped = true;
      }
    }
    if (messageId) {
      require("./supporttakeover").assertCanAct(d, effectJob);
      try { await discord("PATCH", `/channels/${channelId}/messages/${messageId}`, body); }
      catch (e) { if (!/404|unknown message/i.test(e.message)) throw e; messageId = null; } // deleted: post again
    }
    if (!messageId) {
      channelId = effectJob.channelId || d.jobs[d.seen[`ticket:${ticketNo}`]]?.channelId;
      const ch = channelId && await discord("GET", `/channels/${channelId}`);
      if (!ch || ch.guild_id !== config.guildId || ticketNumberOf(ch.name) !== Number(ticketNo)) throw new Error("status card channel does not match this ticket");
      const seq = (card.seq || 0) + 1;
      // Keir 8: the card's message id is written inside the effect, so the same save that closes
      // the receipt also records the card. The receipt lives on a throwaway notice task, so a lost
      // card record used to mean the next update posted a second card. Only the id is recorded here:
      // items and status stay as they were, so a resumed update still sees the change (stage note,
      // live notice) and edits this card in place.
      const sent = await effect(effectJob, `status-card:${ticketNo}:${seq}`, async () => {
        const posted = await discord("POST", `/channels/${channelId}/messages`, { ...body, nonce: `card${ticketNo}-${seq}`, enforce_nonce: true });
        if (posted?.id) cards[ticketNo] = { ...card, messageId: posted.id, channelId, seq };
        return posted;
      });
      messageId = sent.id; card.seq = seq;
    }
    const stageChanged = JSON.stringify((card.items || []).map((i) => [i.name, i.stage, i.blocked])) !== JSON.stringify(items.map((i) => [i.name, i.stage, i.blocked]));
    cards[ticketNo] = { ...card, messageId, channelId, items, status, at: now() };
    ledger.save();
    if (stageChanged) {
      // Keir 8.5.1: a card row that has moved past "Investigating" is a fix state change; a card that still says
      // "Investigating" is not progress and must not reset the sweeper's stall clock.
      if (items.some((i) => i.stage !== "found" && statusCard.stageIndex(i.stage) > statusCard.stageIndex((card.items || []).find((o) => o.name === i.name)?.stage || "found"))) { try { trustlog.markProgress(d, Number(ticketNo), now(), "status card stage"); } catch {} }
      // The public receipt keeps the history the card overwrites.
      const text = items.map((i) => `${i.name}: ${i.blocked ? `paused${i.note ? ` (${i.note})` : ""}` : (i.stage === "confirmed" ? "Live, confirmed in game" : i.stage === "answered" ? "Answered, no fix needed" : statusCard.labelOf(i.stage))}`).join("; ");
      callSupport("support_public_update", { kind: "ticket", number: Number(ticketNo), message: text.slice(0, 1400), deliver: false, update_kind: "progress" }, true).catch(() => {});
      recordTicketPost(effectJob, ticketNo, text, "status_card");
    }
    await liveNotice(effectJob, ticketNo, card.items || [], items);
    return { messageId, channelId, posted: !card.messageId || card.messageId !== messageId, bumped };
  }
  // A card edit sends no notification, so a fix reaching the main server went
  // unnoticed for 6 to 28 hours (review 2026-10-19: 1584, 1590, 1617 missed a
  // contract, 1625, 1628, 1629). The first time a fix is live, a short reply
  // tells the player, unless Keir already said so in the last 15 minutes.
  async function liveNotice(effectJob, ticketNo, before, after) {
    const live = (i) => !i.blocked && (i.stage === "main" || i.stage === "confirmed");
    const card = d.statusCards?.[ticketNo]; if (!card) return false;
    // Keir 8.4: an update_kind "production" post is a claim about the deployed revision. Without the main-release receipt it is not sent.
    const evNow = ticketEvidence(ticketNo);
    if (!evNow.main.done || !evNow.mainOwn.done) { ledger.audit("live_notice_skipped", { job: effectJob.id, ticket: ticketNo, reason: "no main release evidence" }); return false; }
    const pending = card.pendingLiveNotice;
    const told = new Set([...(card.liveNotified || []), ...before.filter(live).map(i => i.name)].map(statusCard.cleanName));
    for (const name of pending?.names || []) told.delete(name);
    const fresh = after.filter((i) => live(i) && !told.has(statusCard.cleanName(i.name)));
    if (!fresh.length) return false;
    const root = d.jobs[d.seen[`ticket:${ticketNo}`]];
    const openAsk = d.ticketCases?.[ticketNo]?.asked?.some(ask => !ask.answeredAt);
    if (root && (conversationTurn.inFlight(root) || root.inbox?.some(m => conversationTurn.human(root, m)) || (openAsk && !pending))) {
      const names = fresh.map(i => statusCard.cleanName(i.name));
      if (!pending || names.some(n => !pending.names.includes(n))) {
        card.pendingLiveNotice = { names, at: pending?.at || now() };
        (root.inbox ||= []).push({ role: "system", authorId: "stage-engine", at: new Date(now()).toISOString(),
          content: "A change is verified live: " + names.join(", ") + ". If relevant, incorporate that in your answer. Verify the player's actual outcome separately." });
        ledger.audit("live_notice_deferred_to_conversation", { job: root.id, ticket: ticketNo });
        ledger.save();
      }
      return false;
    }

    // Keir 11.2: one live notice per ticket per shipped change (main release receipt). A model post that already said it is
    // live for this release counts: the card notice and the model never both announce the same thing (ticket 1868).
    // Fourth pass (review N7): this suppression belongs to the post budget switch; off or in preview the notice goes out as
    // before (preview records that it would have been held).
    const pbGate = ctl().gate("postBudget");
    const receipt = require("./postbudget").mainReceipt(Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo));
    const announcedRaw = receipt && (card.liveReceipts || []).includes(receipt.key);
    const saidSinceRaw = receipt && (d.ticketPosts?.[ticketNo] || []).some((p) => p.at >= receipt.at && !isCardPost(p) && require("./postbudget").liveClaim(p.text));
    if ((announcedRaw || saidSinceRaw) && pbGate.run && !pbGate.act) controlsLib.preview(d, "post-rules", "would hold live notice", `ticket ${ticketNo}`, announcedRaw ? "this release was already announced" : "the model already said it is live", {}, now());
    const announced = pbGate.act && announcedRaw, saidSince = pbGate.act && saidSinceRaw;
    const said = announced || saidSince || (d.ticketPosts?.[ticketNo] || []).some((p) => now() - p.at < 15 * 60000 && !isCardPost(p) && /\blive\b|\b(?:fix|change) is working\b|\bnow works\b|\bis fixed\b|\bworking for you\b/i.test(p.text)); // ticket 1755: "The fix is working for you" then a contradicting live notice
    if (said) { delete card.pendingLiveNotice; card.liveNotified = [...told, ...fresh.map(i => statusCard.cleanName(i.name))].slice(-20); ledger.save(); ledger.audit("live_notice_skipped", { job: effectJob.id, ticket: ticketNo, reason: "already said" }); return false; }
    const names = fresh.map((i) => i.name.replace(/[.\s]+$/, ""));
    const message = (names.length === 1 ? `This is now live on the main server: ${names[0]}.` : `These are now live on the main server:\n${names.map((n) => `- ${n}`).join("\n")}`)
      + "\n\nIf you still see the problem, reply here.";
    try {
      guardPlayerRegister(effectJob, ticketNo, message);
      const key = `live-notice:${ticketNo}:${crypto.createHash("sha1").update(names.join("|")).digest("hex").slice(0, 10)}`;
      await effect(effectJob, key, () => callSupport("support_public_update", { kind: "ticket", number: Number(ticketNo), message, deliver: true, update_kind: "production", delivery_mode: "reply" }, true), { kind: "reply", ticket: Number(ticketNo), text: message });
      delete card.pendingLiveNotice;
      card.liveNotified = [...told, ...fresh.map((i) => statusCard.cleanName(i.name))].slice(-20);
      if (receipt) card.liveReceipts = [...(card.liveReceipts || []), receipt.key].slice(-20);
      effectJob.lastPublishedAt = now(); recordTicketPost(effectJob, ticketNo, message);
      ledger.audit("live_notice", { job: effectJob.id, ticket: ticketNo, items: names.length }); ledger.save();
      return true;
    } catch (error) {
      ledger.audit("live_notice_failed", { job: effectJob.id, ticket: ticketNo, reason: String(error.message).slice(0, 300) }); ledger.save();
      return false;
    }
  }
  // Keir 11.2 (promises.js): after two wakes failed to deliver a promised follow-up, the player gets one plain line from code.
  // Staff ownership, a takeover, the kill switch and an ended ticket all stop it; it is never retried after delivery.
  async function promiseFallback(ticketNo, message) {
    killSwitch?.assertClear("A promise follow-up");
    const n = Number(ticketNo), root = cardOwnership(n);
    const ended = require("./ticketstate").endedReason(d, n, root);
    if (ended) throw new Error(`ticket ended (${ended})`);
    const notice = ledger.createJob(`promise-fallback:${n}:${Math.floor(now() / 3600000)}`, { kind: "notice", role: "support", ticket: n, internalProbe: true, channelId: root.channelId, deadline: now() + 300000, source: {} });
    if (notice.state === "done") return { already: true };
    notice.state = "running";
    try {
      guardPlayerRegister(notice, n, message);
      await effect(notice, `promise-fallback:${n}`, () => callSupport("support_public_update", { kind: "ticket", number: n, message, deliver: true, update_kind: "progress", delivery_mode: "reply" }, true), { kind: "reply", ticket: n, text: message });
      notice.state = "done"; notice.summary = "Promise fallback delivered.";
      recordTicketPost(notice, n, message);
      ledger.audit("promise_fallback_posted", { ticket: n, job: notice.id });
      return { posted: true };
    } catch (e) { notice.state = "blocked"; notice.summary = String(e.message).slice(0, 300); throw e; }
    finally { ledger.save(); }
  }
  // Ownership checks without a running task (admin path and CI waits).
  function cardOwnership(ticketNo) {
    const job = d.jobs[d.seen[`ticket:${ticketNo}`]];
    if (!job) throw new Error(`no task for ticket ${ticketNo}`);
    if (config.supportDeferred(job)) throw new Error("another coordinator owns this ticket");
    require("./supporttakeover").assertCanAct(d, job);
    if (d.channels[job.channelId]?.claimedBy) throw new Error("staff own this ticket");
    return job;
  }
  // Keir 10.1.3 (owner, 2026-11-17, ticket 1836): a returning player gets no opener (owner rule 2026-11-01), so the
  // first thing they saw was the answer, about three minutes after opening, and the owner read it as no response.
  // On a bug ticket's first activation, before preflight, code posts the in-place progress card: one card, not a
  // chat line, so it is not padding. It never counts as Keir's answer (lastPublishedAt is untouched), and the
  // model's own status_card replaces its item.
  async function instantCard(job) {
    const n = ticketOf(job);
    if (!n || job.kind !== "ticket" || job.codingParent || job.internalProbe) return { skipped: "not a ticket task" };
    if (d.statusCards?.[n]?.messageId) return { skipped: "card exists" };
    if (Object.values(d.jobs).some((j) => ticketOf(j) === n && (j.lastPublishedAt || j.progressMessageId || j.channelReplyQueued))) return { skipped: "already spoke" };
    const ch = d.channels?.[job.channelId] || {};
    if (ch.claimedBy) return { skipped: "staff claimed" };
    if (ch.category !== "bug" && job.lane !== "bug") return { skipped: "not a bug ticket" };
    let name = "Your report";
    try {
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: n }, false, AbortSignal.timeout(5000));
      const title = String(t?.title || "").replace(/[*_`~|<>@#]/g, "").trim().slice(0, 80);
      if (title.length >= 4 && !TECHNICAL.test(title) && !JARGON.test(title)) name = title;
    } catch { /* the generic name is fine */ }
    const r = await upsertCard(job, n, { items: [{ name, stage: "found" }], status: "Looking into this now." });
    ledger.audit("instant_card_posted", { job: job.id, ticket: n });
    return { posted: true, ...r };
  }
  async function adminStatusCard(ticketNo, { items, status }) {
    const job = cardOwnership(Number(ticketNo));
    const checked = cardItemsAllowed(Number(ticketNo), items);
    const s = String(status || "").trim().slice(0, 500);
    if (s && TECHNICAL.test(s)) throw new Error("the status line is player-facing; no technical terms");
    const notice = ledger.createJob(`card-admin:${ticketNo}:${now()}`, { kind: "notice", role: "support", ticket: Number(ticketNo), internalProbe: true, deadline: now() + 300000, source: {}, channelId: job.channelId });
    notice.state = "running";
    try { const r = await upsertCard(notice, Number(ticketNo), { items: checked, status: s }); notice.state = "done"; ledger.save(); return r; }
    catch (e) { notice.state = "blocked"; notice.summary = String(e.message).slice(0, 300); ledger.save(); throw e; }
  }

  // Keir 10 wait engine: where code already knows a stage change (a PR merged, a release on the sandbox or the
  // main server), the card moves without a model run. The card's own evidence gate still applies, and a card
  // never moves back here. evidence is only recorded for the audit row.
  async function advanceCardStage(ticketNo, itemName, stage, evidence = {}) {
    const n = Number(ticketNo), card = d.statusCards?.[n];
    if (!card?.items?.length) return { advanced: false, reason: "no card" };
    const item = card.items.find((i) => i.name === itemName);
    if (!item) return { advanced: false, reason: "no such item" };
    if (item.blocked || ["answered", "confirmed"].includes(item.stage) || statusCard.stageIndex(stage) <= statusCard.stageIndex(item.stage)) return { advanced: false, reason: "not forward" };
    const items = card.items.map((i) => (i === item ? { ...i, stage } : i));
    try {
      const r = await adminStatusCard(n, { items, status: card.status || "" });
      ledger.audit("card_stage_advanced", { ticket: n, item: itemName, from: item.stage, to: stage, evidence: JSON.stringify(evidence).slice(0, 200) });
      return { advanced: true, ...r };
    } catch (e) { return { advanced: false, reason: String(e.message).slice(0, 200) }; }
  }
  async function stageTick() {
    const moved = [];
    for (const [n, card] of Object.entries(d.statusCards || {})) {
      const root = d.jobs[d.seen[`ticket:${n}`]];
      if (card.pendingLiveNotice && root && ["queued", "waiting", "blocked"].includes(root.state) &&
          !root.channelClosed && !root.resolved && !root.ticketPaused && !(root.staffActiveUntil > now()) &&
          !root.inbox?.some(m => conversationTurn.human(root, m)) && !d.paused && !config.supportDeferred(root)) {
        // A card that already moved will never advance again. Retry its deferred
        // notice under a stable effect owner after the person has had their turn.
        try {
          cardOwnership(n);
          const pending = card.pendingLiveNotice;
          const notice = ledger.createJob(`live-notice:${n}:${pending.at}`, { kind: "notice", role: "support", ticket: Number(n), internalProbe: true, channelId: root.channelId, source: {} });
          notice.state = "running";
          try { await liveNotice(notice, Number(n), card.items || [], card.items || []); }
          finally { notice.state = "done"; ledger.save(); }
        } catch { /* a staff claim or ownership handoff holds delivery */ }
      }
      // Evidence is per ticket, not per fix, so only a one-fix card moves by itself; a card with several fixes stays with the model.
      if (!root || ["done", "cancelled", "dismissed", "paused"].includes(root.state) || root.channelClosed || root.resolved || !card.messageId || (card.items || []).length !== 1) continue;
      const ev = ticketEvidence(Number(n));
      if (ev.main.done && !ev.mainOwn.done) ev.main = { done: false }; // a lookup of someone else's change is not this ticket's fix (1859)
      const target = statusCard.stageFromEvidence(ev, null);
      if (!target) continue;
      for (const item of card.items || []) {
        const r = await advanceCardStage(n, item.name, target, { stage: target }).catch(() => ({ advanced: false }));
        if (!r.advanced) continue;
        moved.push({ ticket: Number(n), item: item.name, stage: target });
        // Only a fix reaching the main server needs the model: it must check the player's own figures and tell them.
        if (target === "main") {
          root.inbox = [...(root.inbox || []), { role: "system", authorId: "stage-engine", at: new Date(now()).toISOString(), content: `The fix for "${item.name}" is live on the main server. After the next turn, read the player's own figures, then tell them plainly whether it is fixed.` }].slice(-20);
          if (root.state === "waiting") { root.state = "queued"; delete root.wakeAt; }
        }
      }
    }
    if (moved.length) ledger.save();
    return moved;
  }

  async function waitingUpdate(job, info) {
    // With a status card, a CI wait refreshes the card instead of posting.
    const card = job.ticket && d.statusCards?.[job.ticket];
    if (card?.messageId) {
      if (job.state !== "waiting" || job.internalProbe || job.codingParent || d.paused || now() - (card.at || 0) < 10 * 60000) return false;
      try { cardOwnership(job.ticket); } catch { return false; }
      try {
        await discord("PATCH", `/channels/${card.channelId}/messages/${card.messageId}`, statusCard.render({ ticket: job.ticket, items: card.items, status: statusCard.waitNote(info), at: now(), avatarUrl: d.botAvatarUrl || null }));
        card.at = now(); card.status = statusCard.waitNote(info); job.lastPublishedAt = now(); ledger.save();
        ledger.audit("status_card_refresh", { job: job.id, ticket: job.ticket }); return true;
      } catch { return false; }
    }
    if (job.state !== "waiting" || job.internalProbe || job.codingParent || !job.ticket || job.ownerDecisionPending || d.paused) return false;
    // The watched pull request is the receipt behind "the correction is prepared".
    if (info?.repository && info?.number) job.pullRequests = [...new Set([...(job.pullRequests || []), `https://github.com/${info.repository}/pull/${info.number}`])];
    const key = `${info.repository}:${info.number}`;
    const old = job.ciWaitingNotice;
    const sameWait = old?.key === key || old?.key?.startsWith(`${key}:`);
    if (sameWait && old.uncertain) return false;
    // One waiting message per ticket (2026-10-14, ticket 1536 posted it twice
    // when the wait moved from the fix PR to its promotion PR): while the last
    // notice is still the newest public post it is edited in place, whatever
    // PR is now being waited on. After a newer post, a fresh notice may follow
    // once the ticket has been quiet for 30 minutes.
    const latest = Boolean(old && !old.uncertain && old.messageId && (job.lastPublishedAt || 0) <= old.at);
    if (latest && now() - old.at < 15 * 60000) return false;
    if (!latest && now() - (job.lastPublishedAt || 0) < (old ? 30 : 10) * 60000) return false;
    await supportAuthority(job, ["waiting"]);
    // The words follow the stage of the PR being waited on, so a promotion
    // wait never reads as a step back to "prepared". The time is Discord's
    // timestamp markup: every reader sees it in their own time zone.
    const promoting = info.base === "staging" ? "sandbox" : info.base === "main" && canonicalRepository(info.repository) === GAME_REPO ? "main server" : null;
    const checks = promoting ? "Release checks" : "Testing";
    const state = info.queued ? `${checks} ${promoting ? "are" : "is"} still queued` : info.running ? `${checks} ${promoting ? "are" : "is"} still running` : `${checks} ${promoting ? "have" : "has"} not finished`;
    const body = `${promoting ? `The fix is on its way to the ${promoting}` : "The correction is prepared"}. ${state}; I am tracking it while we wait.`;
    const message = `${body} Last checked <t:${Math.floor(now() / 1000)}:t>.`;
    const editing = latest;
    if (editing) { guardNumbers(job, body); secondLook(job, job.ticket, body); }
    else await guardTicketPost(job, job.ticket, body, { system: true });
    const notice = ledger.createJob(`ci-notice:${job.id}:${key}:${editing ? Math.floor(now() / (15 * 60000)) : "first"}`, { kind: "notice", role: "support", ticket: job.ticket, internalProbe: true, deadline: now() + 300000, source: {} });
    notice.state = "running"; ledger.save();
    try {
      const result = await effect(notice, "delivery", () => editing
        ? discord("PATCH", `/channels/${old.channelId}/messages/${old.messageId}`, { content: message, allowed_mentions: { parse: [] } })
        : callSupport("support_public_update", { kind: "ticket", number: job.ticket, message, deliver: true, update_kind: "progress", delivery_mode: "reply" }, true));
      const delivery = result.delivery?.delivery || result.delivery || {};
      const delivered = editing || ["posted", "delivered", "sent", "already_posted"].includes(delivery.status) || result.delivery?.posted === true;
      if (!delivered) throw new Error("Waiting update delivery is unconfirmed; inspect receipt.");
      notice.state = "done"; notice.summary = "Waiting status delivered.";
      job.ciWaitingNotice = { key, at: now(), messageId: editing ? old.messageId : delivery.messageId || result.delivery?.id, channelId: editing ? old.channelId : delivery.channelId || result.delivery?.channel || job.channelId };
      job.lastPublishedAt = now(); job.channelReplyQueued = true; recordTicketPost(job, job.ticket, message);
      ledger.audit("ci_wait_update", { job: job.id, ticket: job.ticket, edited: Boolean(editing), notice: notice.id }); ledger.save(); return true;
    } catch (error) {
      notice.state = "blocked"; notice.summary = String(error.message).slice(0, 400);
      job.ciWaitingNotice = { key, at: now(), uncertain: true, notice: notice.id };
      ledger.audit("ci_wait_delivery_uncertain", { job: job.id, notice: notice.id }); ledger.save(); return false;
    }
  }
  // Questions Keir put to a player, as word sets, kept for a week.
  const questionWords = (text) => new Set(String(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const questionsIn = (text) => sentences(String(text || "")).filter((x) => /\?\s*$/.test(x)).map(questionWords).filter((w) => w.size >= 3);
  const similar = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n >= 3 ? n / Math.max(1, Math.min(a.size, b.size)) : 0; };
  function repeatedQuestion(ticketNo, message) {
    const prior = (d.askedQuestions?.[ticketNo] || []).map((q) => new Set(q.words));
    let most = 0;
    for (const q of questionsIn(message)) most = Math.max(most, prior.filter((p) => similar(q, p) >= 0.5).length);
    return most;
  }
  // Keir 8: a post carries its kind. The old check read a "[status card]" prefix off the text, so a
// reply that happened to start with it was treated as a card. Records without a kind are legacy.
function isCardPost(p) { return p.kind ? p.kind === "status_card" : String(p.text || "").startsWith("[status card]"); }
  // Keir 8.4: true when Keir may not speak to this ticket right now (kill switch engaged).
  function outputBlocked() { return Boolean(killSwitch?.state().engaged); }
  function recordTicketPost(job, ticketNo, message, kind = "reply") {
    const card = kind === "status_card";
    if (!card) {
      // Keir 11.2: the post that goes past the hourly cap is the one merged overflow message for this player message.
      try { const pb = require("./postbudget"), h = humanAt(ticketNo); if (pb.recentRun(d.ticketPosts?.[ticketNo], h, now()).length >= (Number(config.ticketPostsPerHour) || pb.DEFAULT_PER_HOUR)) (d.postOverflow ||= {})[ticketNo] = { at: now(), humanAt: h }; } catch {}
      // Keir 11.2: every follow-up promise Keir makes is recorded with a due time by the post path itself (promises.js).
      if (job.kind !== "notice") { try { const askedAt = Math.max(humanAt(ticketNo), ...Object.values(d.jobs).filter((j) => ticketOf(j) === ticketNo && j.kind === "command" && !j.internalProbe).map((j) => Date.parse(j.source?.at || "") || 0)); const p = require("./promises").notePost(d, ticketNo, job, message, now(), { askedAt }); if (p && p.at === now()) ledger.audit("promise_recorded", { job: job.id, ticket: ticketNo, kind: p.kind, dueAt: p.dueAt, afterTurn: p.afterTurn ?? null }); } catch {} }
      // Keir 11.2: the ticket's pace (posts, corrections) for the step-back threshold; a step-back posts once; a turn
      // report the closing condition called for uses that call up.
      try { closing.notePost(d, ticketNo, message, { now: now(), correction: isCorrection(message) }); } catch {}
      if (closing.stepBackActive(job)) job.stepBack.posted = (job.stepBack.posted || 0) + 1;
      if (job.turnReportViaPromise) { delete job.turnReportViaPromise; require("./promises").keepForReport(d, ticketNo, now()); }
      if (job.turnReportViaClosing) { delete job.turnReportViaClosing; const root = d.jobs[d.seen?.[`ticket:${ticketNo}`]]; for (const j of [job, root]) if (j && closing.closingCallsForTurn(d, j, now())) closing.noteTurnReport(d, j, now()); }
    }
    try { trustlog.recordReply(d, { ticket: ticketNo, jobId: job.id, text: message, at: now(), card }); } catch {}
    try { require("./ticketcase").recordPost(d, job, message, { now: now(), card }); } catch {} // Keir 10.3: durable case file
    if (message === require("./advicerouting").REPLY) job.adviceRedirectedAt = now();
    if (require("./supportblockers").unchangedWait(message)) {
      (d.supportWaitingNotices ||= {})[ticketNo] = { stage: waitingStage(ticketNo), humanAt: humanAt(ticketNo), at: now() };
    }
    if (!card) { try { require("./ticketlearn").notePost(d, ticketNo, message, now()); } catch {}
    if (!card) { try { require("./evidencegap").notePost(d, ticketNo, message, require("./playercopy").isCorrection(message), now()); } catch {} } }
    // Keir 10.1.14: durable record of the last substantive post (ticketPosts is pruned after an hour of silence), with the ticket state it was made in.
    if (!card && !/^hi,? i(?:'|’)?m keir\b/i.test(String(message || "").trim())) { const ls = (d.lastSubstantive ||= {}); ls[ticketNo] = { at: now(), text: String(message || "").slice(0, 800), fp: standdown.stateFingerprint(d, ticketNo), holding: holdingPost(message), question: /\?/.test(String(message || "")) }; for (const n of Object.keys(ls)) if (now() - ls[n].at > 14 * 86400000) delete ls[n]; }
    if (!card) { try { sharedAnswer.noteAnswer(d, ticketNo, message, { at: now(), jobId: job.id }); } catch {} }
    // A reply delivered on this ticket supersedes any over-long draft stored by any of its tasks.
    if (!card) for (const j of Object.values(d.jobs)) if (ticketOf(j) === ticketNo && j.lastTooLongDraft) { delete j.lastTooLongDraft; delete j.lastTooLongDraftAt; }
    if (!card) {
      const qs = questionsIn(message);
      if (qs.length) { const all = (d.askedQuestions ||= {}); all[ticketNo] = [...(all[ticketNo] || []).filter((q) => now() - q.at < 7 * 86400000), ...qs.map((w) => ({ at: now(), words: [...w] }))].slice(-30); }
    }
    if (String(message || "").trim() && !card) { job.lastAskAt = now(); delete job.replyRefusedPending; }
    if (!card && /\blive on the main server\b|\b(?:is|are) (?:now )?live\b/i.test(String(message || ""))) { const live = (d.liveSaid ||= {}); live[ticketNo] = now(); for (const n of Object.keys(live)) if (now() - live[n] > 7 * 86400000) delete live[n]; }
    // Keir 10: a correction means an earlier post was wrong; the failure tracker groups these.
    if (!card && isCorrection(message)) ledger.audit("correction_posted", { job: job.id, ticket: ticketNo, lane: job.lane || null });
    const posts = (d.ticketPosts ||= {});
    // Review M6: a post made by a task answering the owner or a developer is marked, so it never counts against the player's hourly budget.
    const toStaff = job.role === "owner" || developerTask(job);
    posts[ticketNo] = [...(posts[ticketNo] || []).filter((p) => now() - p.at < 24 * 3600000), { at: now(), jobId: job.id, kind, text: message.slice(0, 600), ...(toStaff ? { staff: true } : {}) }].slice(-40);
    for (const n of Object.keys(posts)) if (!posts[n].some((p) => now() - p.at < 3600000)) delete posts[n];
    // Keir 4.0: consecutive Keir posts since the player last spoke, kept
    // beyond the one-hour post window so a slow monologue still counts.
    const runs = (d.monologue ||= {});
    const human = humanAt(ticketNo);
    const cur = runs[ticketNo];
    // Status card edits are neither a message in the monologue run nor the decision notice.
    runs[ticketNo] = { humanAt: human, count: cur && cur.humanAt === human ? cur.count + (card ? 0 : 1) : card ? 0 : 1, at: now(),
      decisionNoticeAt: !card && Object.values(d.decisions || {}).some((x) => x.state === "pending" && ticketOf(d.jobs[x.jobId] || {}) === ticketNo) ? now() : cur?.decisionNoticeAt };
    for (const n of Object.keys(runs)) if (now() - (runs[n].at || 0) > 7 * 86400000) delete runs[n];
  }
  // Keir 9 (feature B): at task start, match this ticket with earlier tickets that have a checked, undisputed answer.
  // Fails open: any error means the task is worked as usual. Tickets are linked, never merged.
  async function sharedAnswerPrecheck(job, signal) {
    if (!job.ticket || job.role === "player" || job.internalProbe) return null;
    const known = d.sharedAnswers?.[job.ticket];
    if (known) return { ticket: known.from, why: known.why, answer: known.answer };
    let hits = [];
    try {
      const q = String(job.source?.content || "").slice(0, 300);
      if (q.length >= 6 && Object.keys(d.checkedAnswers || {}).length) {
        const found = await mcp.call("support", "support_search", { query: q, kind: "ticket", limit: 12 }, false, signal);
        hits = (found?.results || found?.items || []).map((t) => t.number);
      }
    } catch {}
    const match = sharedAnswer.findMatch(d, job, { now: now(), hits });
    if (!match) return null;
    (d.sharedAnswers ||= {})[job.ticket] = { from: match.ticket, answer: { text: match.answer.text, source: match.answer.source, at: match.answer.at }, why: match.why, at: now(), refused: false };
    const links = (d.ticketLinks ||= {});
    const why = match.why.map((w) => w.kind).join(", ");
    for (const [a, b] of [[job.ticket, match.ticket], [match.ticket, job.ticket]]) links[a] = [...(links[a] || []).filter((x) => x.ticket !== b), { ticket: b, at: now(), why, kind: "same-problem" }].slice(-10);
    ledger.audit("shared_answer_matched", { job: job.id, ticket: job.ticket, from: match.ticket, signals: match.why.map((w) => w.kind) });
    ledger.save();
    return { ticket: match.ticket, why: match.why, answer: match.answer };
  }
  function sharedWork() {
    const updates = require("./appupdates");
    return { evidenceOnly: true, ...updates.board(updates.snapshot(d, config, now()), now()), instruction: "Current shared work from Discord and the app. Inspect the canonical ticket/task for full facts. Status, quoted owner instructions and decision references do not transfer action approval; existing execution checks remain authoritative." };
  }
  // Shared ticket state for every task touching the ticket, so a quick reply or
  // an owner summary starts from the coordinator's findings.
  function ticketWork(job) {
    const ticketNo = ticketOf(job);
    if (!ticketNo) return undefined;
    const coordinator = d.jobs[d.seen[`ticket:${ticketNo}`]];
    return { ticket: ticketNo, coordinatorTask: coordinator?.id, youAreCoordinator: coordinator?.id === job.id, coordinatorFindings: coordinator && coordinator.id !== job.id ? coordinator.summary : undefined,
      recentPublicPosts: (d.ticketPosts?.[ticketNo] || []).map((p) => ({ minutesAgo: Math.round((now() - p.at) / 60000), byTask: p.jobId, text: p.text })),
      provenOutcomes: Object.fromEntries(Object.entries(ticketEvidence(ticketNo)).map(([k, v]) => [k, v.done])) };
  }
  // Keir 3.0 shadow: the EffectGate judges every request beside this broker
  // and records agreement; the broker's own decision is what stands.
  function request(job, kind, args, reason, explanation = null) {
    const result = requestLegacy(job, kind, args, reason, explanation);
    if (effectShadow && result?.action) effectShadow.compare(job, kind, args, d.actions[result.action]);
    return result;
  }
  function requestLegacy(job, kind, args, reason, explanation = null) {
    if (musePolicy.origin(d, job).scoped) {
      let sealed;
      try { sealed = musePolicy.seal(d, config, job, kind, args); } catch (error) { return musePolicy.fail(ledger, job, "request_heal", error.message); }
      const exact = JSON.stringify(sealed.policy.scope).replace(/\*/g, "\\u002a").replace(/[^\x20-\x7e]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
      if (musePolicy.hasCredentials(exact)) return musePolicy.fail(ledger, job, "request_heal", "Heal scope contains credential-shaped content; no proposal was created.");
      const question = `Approve this exact ${kind === "github" ? "GitHub operation" : kind === "computer_input" ? "browser input" : "heal"}?\n${exact}\nDigest: ${sealed.policy.digest}`;
      if (question.length > 1500) return musePolicy.fail(ledger, job, "request_heal", "Unsupported heal approval: the exact plan exceeds the app card review limit. Narrow the repair; nothing was applied and no approval card was created.");
      for (const old of Object.values(d.actions)) if (old.jobId === job.id && old.ownerMuse?.digest === sealed.policy.digest && old.expiresAt <= now() && ["pending", "approved"].includes(old.state)) {
        old.state = "expired";
        for (const decision of Object.values(d.decisions || {})) if (decision.actionId === old.id && decision.state === "pending") decision.state = "expired";
        ledger.audit("owner_muse_proposal_expired", { job: job.id, action: old.id });
      }
      let action = Object.values(d.actions).find(a => a.jobId === job.id && a.ownerMuse?.digest === sealed.policy.digest && ["pending", "approved", "done", "rejected"].includes(a.state) && a.expiresAt > now());
      if (action) {
        musePolicy.validate(d, config, job, action, now());
        if (action.state === "pending" && d.decisions?.[action.ownerMuseDecision]?.state !== "pending") {
          const decision = openDecision(ledger, config, { jobId: job.id, actionId: action.id, question });
          action.ownerMuseDecision = decision.id; ledger.save();
        }
        return { action: action.id, ...(action.state === "pending" ? {decision: action.ownerMuseDecision} : {}), state: action.state, digest: action.ownerMuse.digest };
      }
      const human = kind === "github" ? require("./approvalcopy").explanation(explanation, args) : null;
      action = { id: ledger.id(), jobId: job.id, kind, ...(human ? {explanation:human} : {}), args: sealed.args, digest: hash({ kind, args: sealed.args }), ownerMuse: sealed.policy, state: "pending", at: now(), expiresAt: now() + 86400000 };
      d.actions[action.id] = action;
      const decision = openDecision(ledger, config, { jobId: job.id, actionId: action.id, question });
      action.ownerMuseDecision = decision.id;
      if (require("./appcontrols").authorizeYolo(d, config, job, action, decision, now())) {
        for (const entry of Object.values(d.outbox)) if (entry.decision === decision.id) { entry.deliveredAt = now(); entry.skipped = "owner YOLO grant"; }
        ledger.audit("owner_yolo_approval", { job: job.id, action: action.id, digest: action.ownerMuse.digest, authorization: action.ownerMuseApproval.authorization }); ledger.save();
        return { action: action.id, state: "approved", digest: action.ownerMuse.digest, instruction: "The owner's active YOLO setting approved this exact supported action. Execute through execute_action; all target and receipt checks still apply." };
      }

      ledger.audit("owner_muse_proposed", { job: job.id, action: action.id, decision: decision.id, digest: sealed.policy.digest }); ledger.save();
      return { action: action.id, decision: decision.id, digest: sealed.policy.digest, state: "pending", instruction: "An exact approval card is available in the app. Nothing changed. Finish waiting until an authenticated human answers; a preference choice or typed yes is not consent." };
    }
    // Keir 10.1.9: the one exception is the owner's Approve / Decline question about a merge of the finding's own PR.
    const ownPrMerge = kind === "github" && args?.action === "merge" && (job.pullRequests || []).some((u) => Number(/\/pull\/(\d+)\s*$/.exec(String(u))?.[1]) === Number(args.number));
    if (job.kind === "finding" && kind !== "heal" && !ownPrMerge) throw new Error("Keir own findings prepare heals and draft PRs only");
    if (job.kind === "candidate" && !job.ticket) throw new Error("finish intake first; a candidate cannot request privileged execution");
    // 2026-10-12: six heal approvals were re-planned into the same token-shape
    // rejection. Planning again cannot fix a caller bug.
    const rejected = kind === "heal" && Object.values(d.actions).find((x) => x.jobId === job.id && x.kind === "heal" && job.effects[`action:${x.id}`]?.state === "rejected" && (job.effects[`action:${x.id}`].at || 0) >= STARTED_AT);
    if (rejected) throw new Error(`The heal tool rejected this task's last apply before it ran (${String(job.effects[`action:${rejected.id}`].error || "argument validation").slice(0, 300)}). Re-planning repeats the same rejection. Finish blocked with that error so the adapter gets fixed; nothing was changed.`);
    const digest = hash({ kind, args });
    let a = Object.values(d.actions).find((a) => a.jobId === job.id && a.digest === digest);
    if (!a) {
      // Consent remains reviewable for a day. Heal tokens are short-lived,
      // but execute_action always obtains a fresh one for the exact plan.
      const human = kind === "github" ? require("./approvalcopy").explanation(explanation, args) : null;
      a = { id: ledger.id(), jobId: job.id, kind, ...(human ? {explanation:human} : {}), args, digest, state: "pending", at: now(), expiresAt: now() + 86400000 };
      d.actions[a.id] = a;
      // A task's opening message is not consent to every later write in it.
      // Prod heals that move money, change world config or touch many records
      // need an explicit approval naming this action (2026-10-12 audit: a 02:40
      // question auto-approved an economy-wide ramp change and a credit).
      const spec = kind === "heal" ? args.spec || {} : {};
      const risk = kind === "heal" ? args.risk || spec : {};
      // Economy merges and promotions are always their own explicit yes, even
      // inside a task the owner started (2026-10-12: #3895 reached prod on a
      // ticket task's promotion).
      const economy = kind === "github";
      const highImpact = economy || kind === "computer_input" || (kind === "heal" && authority.hugeHeal(risk));
      // Keir 4.2: a ticket Egg (or Ariane) already said yes to does not ask
      // again for a heal that is not huge.
      const yes = kind === "heal" && !ownerDirected(job) && !authority.hugeHeal(risk) && ticketYes(job);
      if (yes) {
        a.state = "approved"; a.approvedBy = config.ownerId; a.approvalMessage = yes.messageId; a.approvedAt = now();
        if (yes.by !== config.ownerId) a.approvedOnBehalfBy = yes.by;
        ledger.audit("ticket_authority_carried", { action: a.id, job: job.id, ticket: ticketOf(job), actionKind: kind, how: yes.how }); ledger.save();
        return { action: a.id, state: a.state, instruction: "This ticket already has the owner's yes and the heal is not high impact. Call execute_action now." };
      }
      if (ownerDirected(job) && highImpact) {
        const what = kind === "computer_input" ? reason : economy ? args.summary : `This changes live game data (${spec.description || "heal"})`;
        // Owner policy 2026-10-12: a decision DM with buttons, escalating to the
        // delegate after three hours. Execution still re-plans and re-checks.
        openDecision(ledger, config, { jobId: job.id, actionId: a.id, question: `${String(what).slice(0, 600)}${job.ticket ? ` (ticket ${job.ticket})` : ""}`, signoff: economy });
        a.expiresAt = now() + 24 * 3600000;
        ledger.audit("requested", { action: a.id, job: job.id, digest, highImpact: true }); ledger.save();
        return { action: a.id, state: a.state, instruction: economy ? "Economy change: the owner has been sent a decision DM. Finish waiting; once approved you are woken, then call the same github action again and it proceeds." : "High impact: the owner has been sent a decision DM. Finish waiting; do not execute or re-request it until you are woken with the answer." };
      }
      if (ownerDirected(job)) {
        // The owner asked for this work directly; asking them again in a DM is noise.
        a.state = "approved"; a.approvedBy = config.ownerId; a.approvalMessage = job.source.messageId; a.approvedAt = now();
        if (kind === "github" && blast.hasNightPass(job.source?.content)) a.nightPass = true;
        ledger.audit("owner_request_approval", { action: a.id, job: job.id, message: job.source.messageId }); ledger.save();
        return { action: a.id, state: a.state, instruction: "The owner's own request authorizes this. Call execute_action now." };
      }
      // Keir 5.0: a finding prepares a heal; only the owner applies it.
      // Keir 10.2 (owner, 2026-11-17): the owner never applies it by hand elsewhere. The prepared repair is an
      // Approve / Decline question; Approve runs the exact plan through execute_action under a fresh plan and token.
      if (job.kind === "finding" && !ownPrMerge) {
        a.state = "pending"; a.expiresAt = now() + 24 * 3600000;
        const spec = JSON.stringify(args.spec?.description || args.spec?.title || "a prepared repair").slice(1, -1);
        openDecision(ledger, config, { jobId: job.id, actionId: a.id, question: `Keir monitoring prepared a repair: ${String(reason).slice(0, 500)} (${spec.slice(0, 160)}). Approve to apply it now with a fresh plan and checks, or Decline to leave game data as it is.`, signoff: true });
        ledger.audit("requested", { action: a.id, job: job.id, digest, prepared: true, decision: true }); ledger.save();
        return { action: a.id, state: a.state, instruction: "The repair is with the owner as an Approve / Decline button. Nothing changed. Finish waiting; on Approve you are woken, then call execute_action with this action id." };
      }
      const label = { heal: "Heal", host_command: "Host command", mcp_write: "Write" }[kind] || kind;
      // A ticket's repair is the owner's call, never the reporter's: it goes to
      // the owner (and the delegate after three hours) as an exact approval.
      if (!(kind === "heal" && job.actorId !== config.ownerId) || kind === "heal" && job.kind === "ticket") {
        // A merge or promotion question shows what it changes (its summary),
        // never just the generic reason: the owner was approving blind.
        const what = kind === "github" && args.summary ? args.summary : reason;
        openDecision(ledger, config, { jobId: job.id, actionId: a.id, question: `${kind === "github" ? "" : `${label}: `}${String(what).slice(0, kind === "github" ? 600 : 1200)}${job.ticket ? ` (ticket ${job.ticket})` : ""}`, signoff: kind === "github" });
        ledger.audit("requested", { action: a.id, job: job.id, digest }); ledger.save();
        return { action: a.id, state: a.state, instruction: "The owner has been sent a decision DM with the exact request. Finish waiting; you are woken with the answer." };
      }
      ledger.notify(`action:${a.id}`, job.actorId, `${label} needs your OK: ${String(reason).slice(0, 500)}\n\`\`\`json\n${JSON.stringify(args, null, 2).slice(0, 3000)}\n\`\`\`\nReply \`Keir approve ${a.id}\` or \`Keir reject ${a.id}\` (expires in ${kind === "heal" ? "9 minutes" : "24 hours"}).`);
      ledger.audit("requested", { action: a.id, job: job.id, digest }); ledger.save();
    }
    return { action: a.id, state: a.state };
  }
  // Opening a development PR is reviewable and reversible: nothing merges or
  // deploys without CI and a human. It no longer waits on an owner DM.
  async function publishPatch(job, a, signal) {
    const patch = fs.readFileSync(a.args.patchFile);
    if (crypto.createHash("sha256").update(patch).digest("hex") !== a.args.patchSha256) throw new Error("frozen patch digest changed");
    const repo = config.repositories[a.args.repository];
    if (!repo) throw new Error("repository is no longer registered");
    const target = a.args.repository === "AHDGame" ? "development" : "main";
    // A revision replaces the open PR's branch content instead of opening a
    // replacement PR (11 of 26 Keir PRs on 2026-10-12 were red replacements).
    const revise = a.args.revise;
    if (revise && pullRequestNumber(a.args.repository, revise.url) !== revise.number) throw new Error("Saved PR belongs to a previous source repository; prepare a new publication instead of revising it");
    const branch = revise ? revise.branch : `keir/task-${job.id}-${a.id}`;
    const local = revise ? `keir/revise-${job.id}-${a.id}` : branch;
    const wt = path.join(repo, "worktrees", `keir-${job.id}-${a.id}`);
    const bodyFile = path.join(config.stateDir, "artifacts", `${a.id}-pr.md`);
    // Keir 8: every step before the first push only touches this box, so a failure
    // there is a definite "nothing written" (the receipt can be retried), not an
    // uncertain write that blocks the task for a person. The leftover worktree
    // and branch are removed so the retry starts clean.
    try {
    await exec("/usr/bin/git", ["-C", repo, "fetch", "--quiet", "origin", target], { signal, timeout: 120000 });
    await exec("/usr/bin/git", ["-C", repo, "worktree", "add", "--no-track", "-b", local, wt, `origin/${target}`], { signal });
    await exec("/usr/bin/git", ["-C", wt, "apply", "--check", a.args.patchFile], { signal }).catch(async (e) => {
      // Nothing was committed or pushed, so this is a clean rejection, not an
      // uncertain write needing owner inspection. Leave no worktree behind.
      try { await exec("/usr/bin/git", ["-C", repo, "worktree", "remove", "--force", wt]); await exec("/usr/bin/git", ["-C", repo, "branch", "-D", local]); } catch {}
      const err = new Error(`The patch does not apply to the latest ${target}: your snapshot is older than the branch. Call repository_snapshot with refresh:true, redo the change on the latest code, then publish again. (${String(e.message).slice(0, 300)})`);
      err.code = "MCP_ARGUMENT_REJECTED"; throw err;
    });
    await exec("/usr/bin/git", ["-C", wt, "apply", "--index", a.args.patchFile], { signal });
    await exec("/usr/bin/git", ["-C", wt, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Keir", "-c", `user.email=${config.keirGitEmail || "keir@localhost"}`, "commit", "-m", a.args.title + "\n\nPrepared by Keir for task " + job.id + "."], { signal });
    a.args.title = noDashes(a.args.title); a.args.body = withDisclosure(noDashes(a.args.body));
    fs.writeFileSync(bodyFile, a.args.body, { mode: 0o600 });
    } catch (e) {
      // child_process errors carry a numeric exit code, so test for our own classes, not for "no code".
      if (!["MCP_ARGUMENT_REJECTED", "EXTERNAL_WRITE_REFUSED"].includes(e.code)) {
        try { await exec("/usr/bin/git", ["-C", repo, "worktree", "remove", "--force", wt]); } catch {}
        try { await exec("/usr/bin/git", ["-C", repo, "branch", "-D", local]); } catch {}
        e.code = "EFFECT_NOT_STARTED";
      }
      throw e;
    }
    let url;
    if (revise) {
      await exec("/usr/bin/git", ["-C", wt, ...keirGit(), "push", "--force", "origin", `HEAD:refs/heads/${branch}`], asKeir({ signal }));
      await exec("/usr/bin/gh", ["api", "-X", "PATCH", `repos/${repositoryName(a.args.repository)}/pulls/${revise.number}`, "-f", `title=${a.args.title}`, "-F", `body=@${bodyFile}`], asKeir({ signal }));
      url = revise.url;
    } else {
      await exec("/usr/bin/git", ["-C", wt, ...keirGit(), "push", "--set-upstream", "origin", branch], asKeir({ signal }));
      url = await exec("/usr/bin/gh", ["pr", "create", "--base", target, "--head", branch, "--title", a.args.title, "--body-file", bodyFile], asKeir({ cwd: wt, signal }));
    }
    // The branch lives on GitHub now; the local worktree and branch are clutter.
    try { await exec("/usr/bin/git", ["-C", repo, "worktree", "remove", "--force", wt]); await exec("/usr/bin/git", ["-C", repo, "branch", "-D", local]); } catch {}
    return { pullRequest: url.trim(), branch, revised: Boolean(revise), nextMove: "Check CI with github status or ci_failures; a ticket task merges its own green PR and promotes green." };
  }
  // One shared, read-only checkout per repository commit, with a git baseline
  // so task diffs work. Built once, atomically; reused by every task on it.
  const building = new Map();
  function baseFor(name, repository, sha) {
    const dir = path.join(config.stateDir, "base", `${name}-${sha.slice(0, 12)}`);
    if (fs.existsSync(path.join(dir, ".git", "keir-ready"))) { fs.utimesSync(dir, new Date(), new Date()); return Promise.resolve(dir); }
    if (building.has(dir)) return building.get(dir);
    const p = (async () => {
      const tmp = `${dir}.tmp-${process.pid}`; fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      const tar = `${tmp}.tar`;
      try {
        await exec("/usr/bin/git", ["-C", repository, "archive", "--format=tar", `--output=${tar}`, sha], { timeout: 120000 });
        await exec("/usr/bin/tar", ["-xf", tar, "-C", tmp], { timeout: 120000 });
        const g = ["-C", tmp, "-c", "user.name=Keir", "-c", `user.email=${config.keirGitEmail || "keir@localhost"}`];
        await exec("/usr/bin/git", ["-C", tmp, "init", "-q"]); await exec("/usr/bin/git", [...g, "add", "-A"], { timeout: 120000 }); await exec("/usr/bin/git", [...g, "commit", "-qm", "baseline"], { timeout: 120000 });
        await exec("/usr/bin/chmod", ["-R", "a+rX", tmp], { timeout: 120000 });
        fs.writeFileSync(path.join(tmp, ".git", "keir-ready"), sha);
        fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
        return dir;
      } finally { fs.rmSync(tar, { force: true }); fs.rmSync(tmp, { recursive: true, force: true }); building.delete(dir); }
    })();
    building.set(dir, p); return p;
  }
  // Keir 2.3: the ticket's reporter (character id and name), read once per task.
  async function reporterOf(job, signal) {
    if (!job.ticket) return null;
    if (!job.reporterCharacter) {
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: job.ticket }, false, signal).catch(() => null);
      job.reporterCharacter = { id: /\/character\/(\d+)/.exec(t?.reporter?.profileUrl || "")?.[1] || null, name: t?.reporter?.characterName || null, username: t?.reporter?.username || null, title: t?.title || null };
    }
    return job.reporterCharacter;
  }
  // The task that owns the ticket for this one: itself, or the nearest ancestor of a coding or investigation child.
  function ticketScopeOf(job) {
    let scope = job;
    for (let i = 0; i < 6 && scope && !scope.ticket; i++) scope = scope.codingParent ? d.jobs[scope.codingParent] : null;
    return scope?.ticket ? scope : null;
  }
  // Keir 11.1: reporter-bound reads (reporter_operating_results, reporter_action_points). No role chooses the identity: the
  // owner, a developer in a public room, a player task, a finding and every inherited child get the ticket's verified reporter
  // injected, and anything that names someone else is refused before a call is made. The game server verifies the pair again.
  async function bindReporterRead(job, tool, args, signal) {
    const scope = ticketScopeOf(job);
    if (!scope) throw new Error(`${tool} reads a ticket's verified reporter and this task has no assigned ticket. Work it from the ticket, or say the figures were not read; do not ask for them.`);
    const rep = await reporterOf(scope, signal);
    const mine = (v) => v !== undefined && v !== null && String(v).trim() !== "" && ((rep.id && String(v) === String(rep.id)) || (rep.name && String(v).trim().toLowerCase() === rep.name.toLowerCase()));
    for (const k of IDENTITY_ARGS) {
      if (args[k] === undefined) continue;
      if (k === "ticket" ? Number(args[k]) !== scope.ticket : !mine(args[k])) throw new Error(`${tool} reads only this ticket's verified reporter (${rep.name || "unknown"}); it takes no ${k}. Call it with the period you need and nothing that names a person.`);
      delete args[k];
    }
    if (!rep.id) throw new Error(`${tool} needs the reporter's linked character, and this ticket has none. Say the figures cannot be read until the account is linked; do not ask for them.`);
    args.character = String(rep.id); args.ticket = scope.ticket;
  }
  // The gamestate tools this task can call right now (live list, inside its read scope), or null when the list cannot be read.
  async function listedGamestate(job, hasTicket, signal) {
    try { return new Set(evidenceLookup.callableTools(await mcp.list("gamestate", signal), { readable: (n) => readable(job, "gamestate", n), hasTicket })); }
    catch { return null; }
  }
  // Keir 10 (W3): ask, player_trail, resolve_reporter, turn_status, request_log.
  const w3 = require("./w3tools").createW3Tools({ config, mcp, ...(config.w3Fetch ? { fetcher: config.w3Fetch } : {}), staff: (job) => job.role === "owner" || developerTask(job), now, log: (m) => config.log?.(m), discord, exec, ledger, isModerator: (id) => conversation?.isModerator?.(id) || false });
  // Keir 2.0: the numbers and text of everything read this activation are the
  // evidence a public post may quote (see guardNumbers and secondLook).
  const NO_EVIDENCE = new Set(["check_draft", "channel_reply", "progress_update", "checkpoint", "finish", "handoff", "task_progress", "ticket_record", "remember"]);
  // Names of the game collections, kept ten minutes: lets an empty raw read say "that collection does not exist, did you mean ..." (KEIR-R read partyBudgets; the collection is partyBudget).
  let collectionCache = null;
  async function rawReadHint(collection, empty, signal) {
    const parts = [];
    if (TYPED_READS[collection]) parts.push(`A purpose-built read covers this: ${TYPED_READS[collection]}. Prefer it; it returns the shaped, public fields.`);
    if (empty && typeof collection === "string" && collection) {
      try {
        if (!collectionCache || Date.now() - collectionCache.at > 600000) {
          const r = await mcp.call("heal-ops", "heal_collections", { env: "prod" }, false, signal);
          const names = (r?.collections || []).map((c) => c?.name).filter(Boolean);
          if (names.length) collectionCache = { at: Date.now(), names };
        }
        const names = collectionCache?.names;
        if (names?.length && !names.includes(collection)) {
          const near = nearCollections(collection, names);
          parts.push(`No collection is named "${collection}", so an empty result means nothing.${near.length ? ` Did you mean: ${near.join(", ")}?` : " Run heal_collections for the exact names."}`);
        }
      } catch {}
    }
    return parts.join(" ") || null;
  }
  async function tool(job, name, input, signal) {
    require("./roles").roleGuard(job, name, input, ledger.data.jobs);
    if (signal?.aborted) throw new Error("activation aborted");
    if (job.appSteering && name !== "owner_updates") throw new Error("The owner changed direction. Call owner_updates before continuing this task.");
    // The owner app shows owner tasks' tool calls live.
    const started = now();
    const callId = appMuse()?.startTool?.(job, name, input);
    const safeLogInput = musePolicy.logInput(input);
    let result;
    try { result = await conversationTurn.forCall(job, () => toolInner(job, name, input, signal)); musePolicy.clearBlocker(ledger, job, name); appMuse()?.noteTool(job, name, safeLogInput, true, now() - started, callId); }
    catch (e) {
      appMuse()?.noteTool(job, name, safeLogInput, false, now() - started, callId);
      // Every refusal is evidence for the nightly self-review (bin/keir-self-review.js).
      if (name === "read_tool") { try { const ctx = NOT_FOUND_LIKE.test(String(e.message)) && input?.server === "gamestate" ? { callable: await listedGamestate(job, true, signal) } : {}; require("./evidencegap").noteRead(d, job, input, null, e.message, now(), ctx); } catch {} }
      try { ledger.audit("tool_refused", { job: job.id, ticket: job.ticket || null, jobKind: job.kind, tool: name, ...(name === "read_tool" && input?.server && input?.tool ? { target: `${input.server}/${input.tool}` } : {}), error: redactSecrets(String(e.message)).slice(0, 240) }); } catch {}
      // Keir 6.1: a refused answer to the player is owed until one is posted
      // (KBX3: Sonnet's reply was refused for length, then it finished done).
      // A reply that can never be delivered (no channel) owes nothing: arming the refused-reply
      // hold there left finish refused too, so an open channel-less ticket could only end
      // blocked (KBX5 channelless--open, 2026-11-03).
      // Keir 9 (Hydrogen replay, 2026-11-13): any refused attempt to answer the player, pacing refusals included, means the
      // player is owed an answer, even before anything was read (the unanswered-player rule at finish keys on it).
      if (job.kind === "ticket" && job.ticket && (name === "channel_reply" || name === "progress_update" || name === "support_action" && input?.tool === "support_public_update")) { job.replyAttemptRefusedAt = now(); try { ledger.save(); } catch {} }
      if (e?.code === "TICKET_POST_TOO_LONG" && e.draft && job.kind === "ticket") { job.lastTooLongDraft = String(e.draft).slice(0, 4000); job.lastTooLongDraftAt = now(); try { ledger.save(); } catch {} }
      if (job.kind === "ticket" && job.ticket && (name === "channel_reply" || name === "progress_update" || name === "support_action" && input?.tool === "support_public_update") && !/authority is inactive|moderation ticket|no authenticated reply channel|ticket channel is absent|channel no longer exists/i.test(String(e.message)) && !PACING_REFUSAL.test(String(e.message)) && !(e.code === "KILL_SWITCH") && !playerAnswered(job.ticket, job)) { job.replyRefusedPending = true; try { ledger.save(); } catch {} }
      // Keir 10: every refusal of a post carries the budget, so the retry is planned and not blind.
      if (job.kind === "ticket" && job.ticket && BUDGET_REFUSAL.test(String(e?.message)) && !/Post budget:/.test(String(e.message)) && ["channel_reply", "progress_update", "support_action"].includes(name)) {
        try { e.message = `${e.message} ${budgetLine(postBudget(job))}`.trim(); } catch {}
      }
      throw e;
    }
    if (name === "read_tool" && !/(?:_catalog|_tools|_servers)$|^heal_collections$/.test(input.tool || "") || name === "ticket_record" && input.op === "read" || name === "evidence_batch" && input.queries?.some(q => q.op !== "catalog")) job.activationFreshRead = true;
    // Review 2026-11-01 (ticket 1742): an empty lookup asked the wrong way
    // became "nothing is signed". Empty reads are remembered so a claim that
    // something does not exist needs a second, differently shaped read.
    if (name === "read_tool" && !NATIVE_NOT_READ.has(input.tool) && config.readyReads !== false && result != null && !require("./ticketquality").emptyResult(result) && !/(?:_catalog|_tools|_servers)$/.test(input.tool || "")) {
      if (!REPORTER_BOUND.has(input.tool) && input.tool !== evidenceLookup.TOOL) { try { readyReads.learn(job, input.server, input.tool); } catch {} }
    }
    // Keir 9 audit: a refused, failed or empty code lookup is not a code read. Only a finished call that returned a result counts.
    if (name === "read_tool" && input?.server === "ops-knowledge" && /^code_/.test(String(input.tool)) && ruleLookup.codeResultHasContent(result)) {
      job.lastCodeReadAt = now();
      if (/^code_(?:search|exact)$/.test(String(input.tool))) job.codeLookups = (job.codeLookups || 0) + 1;
    }
    if ((name === "read_tool" || name === "evidence_batch") && require("./ticketquality").emptyResult(result)) {
      job.emptyReads = [...(job.emptyReads || []), { sig: hash({ name, tool: input?.tool || null, args: input?.args ?? input?.arguments ?? input?.queries ?? null }), tool: input?.tool || name, at: now() }].slice(-20);
    }
    if (!NO_EVIDENCE.has(name) && result != null) {
      // Images carry base64 digits, not evidence; leave them out.
      let text = ""; try { text = typeof result === "string" ? result : JSON.stringify(result, (k, v) => (v && typeof v === "object" && (v.stale || v.conflict || v.supersededBy)) || (k === "image" || k === "_images" || k === "data" && typeof v === "string" && v.length > 2000) ? undefined : v) ?? ""; } catch {}
      job.evidence = [...(job.evidence || []), ...knowledge.numbersIn(text).map((n) => n.value)].slice(-8000);
      job.evidenceText = (String(job.evidenceText || "") + `\n[${name}] ` + text.slice(0, 6000)).slice(-20000);
      if (name === "read_tool") { try { const f = require("./typedfacts").fromRead(input, result); if (f.length) job.typedFacts = [...(job.typedFacts || []), ...f].slice(-200); } catch {} }
    }
    require("./investigation-memory").record(ledger, job, name, input, result, now());
    try { require("./ticketlearn").noteRead(d, job, name, input, result, now()); } catch {}
    if (name === "read_tool") { try { require("./evidencegap").noteRead(d, job, input, result, null, now()); } catch {} }
    return result;
  }
  async function toolInner(job, name, input, signal) {
    // Ending an activation is local bookkeeping. Ownership still fences every
    // read, public reply and action, but must not trap finish behind itself.
    const takeover = name === "finish" && job.state === "running" && ["blocked", "dismissed", "waiting"].includes(input.state)
      ? require("./supporttakeover").held(d, job) : null;
    if (takeover) {
      job.state = job.kind === "command" ? "dismissed" : "deferred"; delete job.wakeAt; delete job.waitingFor;
      job.history = [...(job.history || []), { at: new Date(now()).toISOString(), kind: "finish", state: job.state,
        summary: `Standing down for ticket owner ${takeover.owner}; prior findings preserved.` }].slice(-20);
      ledger.audit("takeover_activation_ended", { job: job.id, ...takeover });
      // A staff or developer request on a held ticket used to end in silence (three of a
      // junior developer's requests on ticket 1757, 2026-11-02). Tell them who holds it
      // and how to hand it back; the channel reply itself stays suppressed.
      if (job.kind === "command" && job.actorId && job.role !== "player" && !job.takeoverNoticeSent) {
        job.takeoverNoticeSent = true;
        ledger.notify(`takeover-notice:${job.id}`, job.actorId, `Ticket ${takeover.ticket} is being handled by ${takeover.owner}, so I'm standing back and didn't act on your request there. To give it back to me, say "Keir, take this ticket back" in the ticket channel.`);
      }
      ledger.save();
      return { state: job.state, takeover };
    }
    active(job);
    if (["channel_reply", "progress_update", "status_card", "support_action", "finish"].includes(name)) knowledge.requireCurrentTicketRecord(ledger, job);
    musePolicy.guard(ledger, config, job, name, input);
    const publicReply = job.replyChannel !== "app" && Boolean(job.ticket || job.source?.channelName) && (name === "channel_reply" || name === "progress_update" || name === "support_action" && input.tool === "support_public_update");
    if (publicReply && job.activationInternalWake && !job.activationFreshRead)
      throw new Error("This activation was woken internally without a new human request. Do not repeat earlier findings. Read current evidence for a changed result, or finish quietly.");
    if (name === "release_efficiency") {
      if (job.role !== "owner") throw new Error("release efficiency requires an owner task");
      const days = input.days ?? 30, until = now();
      if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error("Invalid days");
      return require("./versionefficiency").readVersionEfficiency(d,
        config.usageFile || path.join(config.stateDir, "usage.jsonl"), { since: Math.max(0, until - days * 86400000), until,
          historyFile: config.releaseHistoryFile, releasesDirectory: config.releaseDirectory, eventsFile: path.join(config.stateDir, "events.db") });
    }
    if (name === "ticket_performance") {
      if (job.role !== "owner") throw new Error("ticket performance requires an owner task");
      const days = input.days ?? 30, until = now();
      if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error("days must be between 0 and 3650");
      return require("./ticketperformance").readTicketPerformance(d,
        config.usageFile || path.join(config.stateDir, "usage.jsonl"), { since: Math.max(0, until - days * 86400000), until });
    }
    if (name === "support_updates") return supportDirectives.updates(job);
    if (supportDirectives.held(job)) throw new Error("Support directive is held by an existing approval, staff, category or conversation hold; no tool may bypass it.");
    if ((job.inbox || []).some((r)=>r.directiveId)) throw new Error("New owner guidance arrived from the app. Read support_updates before your next tool or external action.");
    if (conversationTurn.foreground.has(job) && !conversationTurn.foregroundTools.has(name))
      throw new Error("The worker owns this investigation. This activation can answer the current conversation only.");
    if (name === "read_tool" && conversationTurn.foreground.has(job) && !conversationTurn.readAllowed(job, input?.server, input?.tool))
      throw new Error("This quick answer may read only the evidence dictionary (ops-knowledge support_evidence_lookup) and the vetted game reads market_history, commodity_market, reporter_operating_results, reporter_action_points and country_fiscal (gamestate). Anything wider belongs to the worker: say what you could not check and that the investigation is continuing.");
    if (name === "conversation_updates") {
      if (!conversationTurn.eligible(job)) throw new Error("This task has no Discord conversation.");
      const rows = conversationTurn.read(job);
      if (rows.length) {
        if (job.ticket) require("./ticketcase").syncActivation(d, job, { now: now(), ownerId: config.ownerId, botId: config.botId });
        ledger.audit("conversation_interrupted", { job: job.id, count: rows.length });
        ledger.save();
      }
      return { messages: rows, instruction: "Answer the latest person first. Reconcile any correction with your evidence and keep earlier promises open." };
    }
    conversationTurn.check(job);
    if (name === "finish" && conversationTurn.owes(job))
      throw new Error("This person is still waiting for your answer in Discord. Send it with channel_reply before finishing. A private finish summary does not reach them.");
    if (name === "present_choices") {
      if (job.role !== "owner") throw new Error("Owner task required for choices");
      if (job.replyChannel === "app") {
        if (!appQuestions) throw new Error("structured questions unavailable");
        return appQuestions.ask(job, input);
      }
      if (!Array.isArray(input.questions) || input.questions.length !== 1 || input.questions[0].multiple) throw new Error("Discord choices require one single-select question at a time");
      const q = input.questions[0];
      const decision = openDecision(ledger, config, {jobId: job.id, question: q.prompt, options: q.options, decisionKey: "owner-preference"});
      job.ownerDecisionPending = true; ledger.save();
      return {id: decision.id, instruction: "Named choice buttons were sent privately to the owner. Finish waiting. Selection gives direction, never action approval."};
    }
    if (name === "computer") {
      if (!appComputer || !ownerDirected(job) || !isAppJob(job)) throw new Error("computer use requires an authenticated owner app work task");
      if ((input.url || job.appBrowserId) && ["click", "type", "key"].includes(input.action)) {
        return request(job, "computer_input", { input, screen: job.appComputer?.file || null, browser: job.appBrowserId, url: job.appComputer?.url, destination: appComputer.identity?.() }, `Use browser: ${input.action}${input.text ? ` ${String(input.text).slice(0, 100)}` : ""} on ${job.appComputer?.url || input.url || "the current page"}`);
      }
      return appComputer.act(job, input, signal);
    }
    if (name === "owner_updates") {
      if (job.role !== "owner" || job.replyChannel !== "app") throw new Error("owner app task required");
      const messages = job.inbox || [];
      job.requestInbox = [...(job.requestInbox || []), ...messages].slice(-20);
      job.inbox = []; delete job.appSteering;
      ledger.audit("app_steering_read", { job: job.id, messages: messages.length }); ledger.save();
      return { messages, sharedWork: sharedWork(), instruction: "Apply the owner's latest guidance. Existing receipts and approval requirements still apply." };
    }
    if (MUSE_TOOLS.includes(name)) {
      if (!appMuse()) throw new Error(`${name} is unavailable`);
      return appMuse().toolCall(job, name, input);
    }
    if (name === "operator_roles") {
      if (!config.roleSnapshot || !["watchkeeper", "engineering"].includes(require("./roles").roleOf(job, ledger.data.jobs))) throw new Error("Operator role state is restricted to observer and engineering tasks");
      return config.roleSnapshot();
    }
    if (job.kind === "finding" && ["channel_reply", "progress_update", "status_card", "chart", "support_action", "open_ticket", "open_suggestion", "merge_related", "merge_into_incident", "execute_action"].includes(name)
      && !(name === "execute_action" && (() => { const x = ledger.data.actions?.[input.action]; return x && x.jobId === job.id && x.kind === "heal" && x.state === "approved" && x.approvedBy === config.ownerId; })())) throw new Error("finding tasks never post in Discord or execute privileged actions");
    if (job.prMention && !prMention.PR_MENTION_TOOLS.includes(name)) throw new Error("A PR review task only reads the pull request and the code, and posts one review comment on it");
    if (job.codingParent && !childTools(job).includes(name)) throw new Error(job.investigation ? "Investigators only read: code in the snapshot, live game state, history and past tickets. The worker handles fixes, publication and communication." : "Coding subworkers only edit and test their isolated snapshot; the worker handles investigation, publication and communication.");
    if (name === "recent_changes") return capabilities.recentChanges({ days: input.days, query: input.query, path: input.path });
    if (name === "view_page") {
      if (job.role === "player") throw new Error("players cannot render pages through Keir");
      const r = await require("./pageview").render(input);
      return { ...r, image: r.image };
    }
    if (name === "watch_turn") {
      if (job.role === "player") throw new Error("players cannot set turn watches");
      // game_overview.turn is the last processed turn; by default watch the
      // coming one, the next turn the engine will process.
      const turn = Number(input.turn) || Number((await mcp.call("gamestate", "game_overview", {}, false, signal)).turn) + 1;
      job.turnWatch = { turn, note: String(input.note || "").slice(0, 300), since: now() }; ledger.save();
      return { watching: turn, instruction: `Finish waiting now; you are woken once turn ${turn} has been processed, with your note.` };
    }
    if (name === "past_ticket") {
      // Any earlier ticket's public outcome: what that player was told, never who
      // reported it or private notes (Keir 2.1.1: memory beyond the open queue).
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: Number(input.number) }, false, signal);
      if (!t || !t.number) throw new Error("no such ticket");
      return { number: t.number, title: t.title, category: t.category, status: t.status, createdAt: t.createdAt, resolvedAt: t.resolvedAt || t.closedAt || null,
        resolution: t.resolution?.message ? String(t.resolution.message).slice(0, 1500) : null,
        // The whole public timeline, as the receipt page shows it (2.3).
        publicUpdates: (t.publicUpdates || []).filter((u) => u.kind !== "heal").slice(-30).map((u) => ({ at: u.at, message: String(u.message || "").slice(0, 600) })) };
    }
    if (name === "ticket_command") {
      if (input.op === "add_person") {
        const r = await ticketCommands.run(job, input, signal);
        return tool(job, "add_to_ticket", { user: String(input.user || ""), ...(r.ticket ? { ticket: r.ticket } : {}) }, signal);
      }
      return ticketCommands.run(job, input, signal);
    }
    if (name === "merge_into_incident") {
      const target = Number(input.incident);
      // A ticket task merges its own report; a developer task may name one.
      const dev = developerTask(job) || developerTicket(job);
      const source = dev && input.ticket ? Number(input.ticket) : job.ticket;
      if (!source) throw new Error("merge_into_incident is for a ticket task's own report, or a developer task naming one");
      const reason = String(input.reason || "").trim();
      if (reason.length < 8) throw new Error("give a one-line reason: what makes it the same problem");
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: target }, false, signal);
      if (!t || t.category !== "incident") throw new Error(`#${target} is not an incident`);
      if (["resolved", "closed"].includes(t.status)) throw new Error(`incident #${target} is ${t.status}`);
      const subject = source === job.ticket ? job : { ...job, ticket: source };
      const r = await incidents.mergeIntoIncident({ mcp, ledger, job: subject, target, reason, by: dev ? `keir for ${job.actorId}` : "keir", signal });
      if (subject !== job) { const other = d.jobs[d.seen[`ticket:${source}`]]; if (other) { other.state = "done"; other.channelClosed = true; other.mergedInto = target; ledger.save(); } }
      return { merged: true, source, target, steps: r?.steps || [], instruction: source === job.ticket ? "This ticket is merged and its channel is closed. Finish done; do not post again." : "Merged. Carry on with your task." };
    }
    if (name === "raise_to_developers") {
      // Keir 8.4 (owner, 2026-11-06): every escalation is classified so a guard can enforce the autonomy rule
      // without reading prose. Bug fixes, display fixes and documented data heals may ship while the owner is
      // away; a rule, balance or economy behaviour change waits for his answer.
      const changeClass = replyPolicy.normalizeChangeClass(input.changeClass) || (input.kind === "bug" ? "bugfix" : null);
      if (["decision", "enhancement"].includes(input.kind) && !changeClass) throw new Error(`Not raised: say what kind of change this is. Set changeClass to ${replyPolicy.CHANGE_CLASSES.join(", ")}. Bug and display fixes and documented data heals may ship while the owner is away; rule, balance and economy changes wait for his decision.`);
      const ownerRequired = changeClass ? replyPolicy.requiresOwner(changeClass) : false;
      if (changeClass) { job.changeClass = changeClass; job.requiresOwner = ownerRequired || job.requiresOwner === true; }
      if (input.kind === "decision") {
        require("./decisionpolicy").requireRealDecision(`${input.title || ""}. ${input.question || input.detail || ""}`);
        const answered = require("./decisionpolicy").answeredPayment(d, job, `${input.title || ""}. ${input.question || input.detail || ""}`, now());
        if (answered) throw new Error(`Not asked: the owner already answered this payment (${answered.id}, "${answered.label}"). Do not ask again in other words. To make the payment, call request_heal with kind compensation and the exact amount; its approval card is the owner's one sign-off, and once approved you run it with execute_action.`);
        require("./decisions").normalizeOptions(input.options);
        const prompt = `${ticketOf(job) ? `Ticket ${ticketOf(job)}: ` : ""}${String(input.title || "").trim().slice(0, 200)}. ${String(input.question || input.detail || "")}`;
        if (require("./decisions").clean(prompt).length > 450) throw new Error("Keep the decision title and question concise: at most 450 characters together, including the ticket prefix. Put outcomes in the option details.");
      }
      // One broker owns the ledger. Serialize duplicate checks and writes so
      // concurrent findings cannot both search an empty index and file twice.
      const previous = issueFlight;
      let releaseIssue;
      issueFlight = new Promise((resolve) => { releaseIssue = resolve; });
      await previous;
      try {
      // Owner, 2026-10-14: "if they are waiting on me that was never made
      // evident to me". An item that needs an owner call (compensation, a
      // refund, a design or balance ruling) also opens a decision DM, so it
      // shows on the hub as waiting on him instead of sitting on the kanban.
      const askOwner = (id, t, why) => {
        const decision = openDecision(ledger, config, { jobId: job.id, ticket: ticketOf(job) || null, decisionKey: `kanban:${id || t}`, options: input.options, question: `${ticketOf(job) ? `Ticket ${ticketOf(job)}: ` : ""}${t}. ${why}`.slice(0, 900) });
        // Owner policy 2026-11-06: an unanswered owner decision holds. It never expires, is re-asked every 12 hours,
        // and nothing on the ticket is decided or resolved meanwhile (decisions.js tick, resolve guard).
        Object.assign(decision, { ownerHold: true, changeClass: changeClass || null, requiresOwner: ownerRequired, ticket: ticketOf(job) || null });
        job.ownerDecisionPending = true; ledger.save();
        return decision.id;
      };
      // Files the question on the ops kanban, the developers' work queue. This
      // is the receipt for telling a player the developers have it.
      if (job.role === "player" || job.codingParent) throw new Error("only the ticket's own task or a developer task raises items for the developers");
      const n = ticketOf(job);
      const title = String(input.title || "").trim().slice(0, 200), detail = String(input.detail || "").trim().slice(0, 6000);
      const record = (id) => {
        const blocking = (input.kind || "question") === "question";
        if (blocking && !id) throw new Error("developer handoff needs a confirmed queue item");
        if (job.kind === "finding" && job.finding) watch?.linkFinding(job.finding, { item: id });
        else if (n && input.appendTo) watch?.credit({ item: id, fromTicket: true });
        const prior = (job.raisedToDevelopers ||= []).find((r) => r.id === id);
        if (prior) {
          prior.title = title;
          if (changeClass) { prior.changeClass = changeClass; prior.requiresOwner = ownerRequired; }
          if (blocking) { prior.blocking = true; delete prior.releasedAt; }
        } else job.raisedToDevelopers.push({ id, title, at: now(), kind: input.kind || "question", blocking, changeClass, requiresOwner: ownerRequired });
        ledger.audit("raised_to_developers", { job: job.id, ticket: n || null, item: id, title, appended: Boolean(input.appendTo) });
        ledger.save();
      };
      // Keir 10 (ticket 1812): one card was returned for five unrelated titles, which tangled the owner's decision history.
      // A new item that comes back with the id of a card Keir already raised under a different title is a reused card, not a new
      // item. Retry once with a distinguishing title; if the board still hands back the old id, refuse instead of recording a lie.
      // Only an explicit appendTo (handled before this) joins an existing item.
      const takenIds = () => new Map(Object.values(d.jobs).flatMap((j) => (j.raisedToDevelopers || []).filter((x) => x.id).map((x) => [x.id, x.title])));
      async function addDistinctCard(args) {
        let card = await mcp.call("ops-knowledge", "kanban_add", args, true, signal);
        const clash = (c) => { const had = takenIds().get(c?.id); return had !== undefined && similarity(had, title) <= 0.6; };
        if (clash(card)) {
          ledger.audit("kanban_card_reused", { job: job.id, ticket: n || null, item: card.id, title: title.slice(0, 120) });
          card = await mcp.call("ops-knowledge", "kanban_add", { ...args, title: `${args.title} [separate item ${Date.now().toString(36).slice(-4)}]`.slice(0, 300) }, true, signal);
          if (clash(card)) throw new Error(`The board returned item ${card.id}, which already holds a different problem ("${String(takenIds().get(card.id)).slice(0, 80)}"). Nothing was recorded. Each problem gets its own item: if this is the same problem, call raise_to_developers again with appendTo ${card.id}; otherwise retry in a minute.`);
        }
        return card;
      }
      // Keir 4.2: a bug or enhancement is a public AHDGame issue in the house
      // shape, linked from the developers' queue. Questions stay queue-only.
      const gh = async (args) => JSON.parse(await exec("/usr/bin/gh", ["api", ...args], isKeirWrite(args) ? asKeir({ timeout: 60000, signal }) : { timeout: 60000, signal }) || "null");
      const recordIssue = (number, url, appended) => {
        const old = d.keirIssues?.[number];
        (d.keirIssues ||= {})[number] = { ...(old || {}), number, url, ticket: old?.ticket || n || null, tickets: [...new Set([...(old?.tickets || []), ...(old?.ticket ? [old.ticket] : []), ...(n ? [n] : [])])], jobId: job.id, at: old?.at || now(), state: "open" };
        (job.issues ||= []).includes(number) || job.issues.push(number);
        ledger.audit("issue_linked", { job: job.id, ticket: n || null, issue: number, appended }); ledger.save();
        // Keir 5.0 scorecard: a finding's issue, or a ticket joining one.
        if (job.kind === "finding" && job.finding) watch?.linkFinding(job.finding, { issue: number });
        else if (n) watch?.credit({ issue: number, fromTicket: true });
      };
      // Keir 8.5 (owner, 2026-11-06, "bug/display fixes only"): a code bug classed bugfix or display is built, merged,
      // promoted and verified by a coding worker instead of waiting for a developer. The card stays as the receipt.
      async function startWorker(id, issueNumber) {
        if (input.kind !== "bug" || !id) return null;
        const rec = (job.raisedToDevelopers || []).find((x) => x.id === id);
        if (rec && issueNumber) rec.issue = issueNumber;
        const cw = codingWorkers();
        if (!cw) return null;
        let out;
        try { out = await cw.dispatch({ job, cardId: id, title, detail, issue: issueNumber, changeClass, kind: "bug", requiresOwner: ownerRequired }); } catch (e) { out = { skipped: true, reason: String(e.message).slice(0, 160) }; }
        if (out.skipped) { ledger.save(); return null; }
        if (rec) { rec.workerRun = out.run.id; rec.workerSeen = true; }
        ledger.save();
        return { codingWorker: out.run.id, instruction: `Filed, and a coding worker (${out.run.id}) is building the fix now. Keir merges it, promotes it and verifies it live on its own once the required checks are green; you will be woken at each end state. Tell the player in the first person: "I am preparing a fix", not that it is live and never that the developers have it (no developer does). Say it is live only after the wake that says it is live.` };
      }
      async function ensureIssueCard(number, url, issueTitle, fresh = false) {
        const issue = d.keirIssues[number];
        let id = issue.item;
        if (!id) {
          const open = await mcp.call("ops-knowledge", "kanban_list", { product: "a-house-divided", limit: 200 }, false, signal);
          const rows = Array.isArray(open) ? open : open?.items || [];
          id = rows.find((x) => [`${GITHUB_OWNER}/AHDGame#${number}`, `Egg3901/AHDGame#${number}`].includes(x.github) || (x.github_url && url && canonicalGithubUrl(x.github_url) === canonicalGithubUrl(url)))?.id;
        }
        if (!id) {
          const card = await mcp.call("ops-knowledge", "kanban_add", { product: "a-house-divided", title: issueTitle || title, detail: `${detail}\n\nRaised by Keir${n ? ` from ticket ${n}` : ""}.`, kind: input.kind === "enhancement" ? "feature" : "bug", lane: "next", actor: "keir", github: `${GITHUB_OWNER}/AHDGame#${number}` }, true, signal);
          id = card?.id;
          if (!id) throw new Error("GitHub issue exists but its developer card was not confirmed; retry to repair the link");
        }
        issue.item = id; ledger.save(); record(id);
        const worker = fresh ? await startWorker(id, number) : null;
        return { raised: true, id, issue: number, url, instruction: "Filing does not repair stored data. If the fault is in a record, now call request_heal with its collection, exact filter and value; the owner approves it before anything changes.", ...(worker || {}) };
      }
      if (input.issueNumber) {
        const number = Number(input.issueNumber);
        const target = await gh([`repos/${GITHUB_OWNER}/AHDGame/issues/${number}`]);
        if (!target || target.pull_request || target.state !== "open") throw new Error(`#${number} is not an open AHDGame issue`);
        const reporter = await reporterOf(job, signal);
        // Keir 10 (ticket 1829): a public issue never names the reporter, so an unlinked reporter does not block filing it.
        const note = noDashes(issues.render({ kind: input.kind === "enhancement" ? "enhancement" : "bug", fields: { summary: `Another report of this. ${String(input.issue?.summary || "").trim()}`.trim(), expected: input.issue?.expected || "", actual: input.issue?.actual || "", steps: input.issue?.steps, where: input.issue?.where, impact: input.issue?.impact || "Same as above.", notes: input.issue?.notes } }));
        const bad = issues.leak(note, [reporter?.name, job.source?.author, ticketUsername(n)].filter(Boolean));
        if (bad) throw new Error(`AHDGame is public: the comment mentions "${bad}". Remove it and add it again.`);
        await effect(job, `issue-comment:${number}:${hash(note)}`, () => gh(["-X", "POST", `repos/${GITHUB_OWNER}/AHDGame/issues/${number}/comments`, "-f", `body=${note}`]));
        recordIssue(number, target.html_url, true); job.issueEvidenceAdded = true; ledger.save();
        return { ...(await ensureIssueCard(number, target.html_url, target.title)), appended: true };
      }
      let filedIssue = null;
      if (["bug", "enhancement"].includes(input.kind) && (job.repository || "AHDGame") === "AHDGame") {
        if (!input.issue) throw new Error("a bug or enhancement also files a public GitHub issue: add issue (summary, steps, expected, actual, where, impact)");
        if (title.length < 8 || detail.length < 40) throw new Error("give a short title and the evidence: what happens, where in the code or data, and the question for the developers");
        const reporter = await reporterOf(job, signal);
        // Keir 10 (ticket 1829): a public issue never names the reporter, so an unlinked reporter does not block filing it.
        const built = issues.build({ ...input.issue, title, kind: input.kind }, [reporter?.name, job.source?.author, ticketUsername(n)].filter(Boolean), { origin: job.kind === "finding" ? "watch" : "report" });
        built.title = noDashes(built.title); built.body = noDashes(built.body);
        // Keir 5.1: a finding whose root cause already has an open issue joins
        // it. Three findings of one line of credit fault filed #4140, #4141 and
        // #4142 within two minutes (2026-10-14).
        if (job.kind === "finding" && job.finding && watch) {
          const rootIssue = watch.group(job.finding).map((f) => f.issue).filter((x) => d.keirIssues?.[x]?.state === "open").sort((a, b) => a - b)[0];
          if (rootIssue) { const x = d.keirIssues[rootIssue]; recordIssue(x.number, x.url, true); return { ...(await ensureIssueCard(x.number, x.url, x.title)), duplicate: true, sameRootCause: true }; }
        }
        const already = Object.values(d.keirIssues || {}).find((x) => x.state === "open" && similarity(x.title, built.title) > 0.6);
        if (already) { recordIssue(already.number, already.url, true); return { ...(await ensureIssueCard(already.number, already.url, already.title)), duplicate: true }; }
        // GitHub search lags new issues by minutes, so Keir's own recent issues
        // are checked locally and force does not skip them. distinctFrom lists
        // the ones the caller has read and judged a different problem.
        const distinct = new Set((Array.isArray(input.distinctFrom) ? input.distinctFrom : []).map(Number));
        // Keir 10 (replay 2026-11-15): the loose GitHub search (score 0.08) offered back the issue this task had just filed for a
        // different defect on the same ticket. Those are excluded from the search only; the local check above still compares them.
        const ownFiled = new Set((job.issues || []).map(Number));
        const recent = Object.values(d.keirIssues || {}).filter((x) => x.state === "open" && now() - (x.at || 0) < 86400000 && !distinct.has(x.number) && x.title && similarity(x.title, built.title) >= 0.2);
        if (recent.length) return { raised: false, issueCandidates: recent.slice(0, 3).map((x) => ({ number: x.number, title: x.title })), instruction: "Keir filed these issues in the last day and they may be this problem. If one is, call raise_to_developers again with issueNumber set to it. If none is, call again with distinctFrom listing their numbers." };
        if (!input.force) {
          const q = [...words(built.title)].slice(0, 6).join(" ");
          const found = await gh([`search/issues?q=${encodeURIComponent(`repo:${GITHUB_OWNER}/AHDGame is:issue is:open ${q}`)}&per_page=10`]);
          if (!Array.isArray(found?.items)) throw new Error("duplicate search unavailable; retry before filing a public issue");
          const candidates = (found?.items || []).filter((i) => !ownFiled.has(Number(i.number))).map((i) => ({ number: i.number, title: i.title, score: similarity(`${i.title} ${String(i.body || "").slice(0, 600)}`, `${built.title} ${built.body.slice(0, 600)}`) })).filter((i) => i.score >= 0.08).sort((a, b) => b.score - a.score).slice(0, 3);
          if (candidates.length) return { raised: false, issueCandidates: candidates.map(({ number, title }) => ({ number, title })), instruction: "These open GitHub issues may be the same problem. If one is, call raise_to_developers again with issueNumber set to it and your evidence in issue. If none is, call again with force: true." };
        }
        // Keir 8: a hidden marker lets an uncertain filing be found again on GitHub.
        const issueHash = hash({ t: built.title, b: built.body }), issueMarker = `<!-- keir:issue:${issueHash} -->`;
        const created = await effect(job, `issue:${issueHash}`, () => gh(["-X", "POST", `repos/${GITHUB_OWNER}/AHDGame/issues`, "-f", `title=${built.title}`, "-f", `body=${built.body}\n\n${issueMarker}`, ...built.labels.flatMap((l) => ["-f", `labels[]=${l}`])]), { kind: "issue", repo: "AHDGame", marker: issueMarker });
        filedIssue = { number: created.number, url: created.html_url };
        recordIssue(created.number, created.html_url, false);
        d.keirIssues[created.number].title = built.title; ledger.save();
        return ensureIssueCard(created.number, created.html_url, built.title, true);
      }
      // Another report of a problem already raised joins that item (4.1.9:
      // the same financial margin squeeze was filed twice an hour apart).
      if (input.appendTo) {
        await mcp.call("ops-knowledge", "work_report", { id: Number(input.appendTo), event: "progress", summary: `${n ? `Ticket ${n}: ` : ""}${title ? `${title}. ` : ""}${detail}`.slice(0, 3900), actor: "keir" }, true, signal);
        record(Number(input.appendTo));
        const asked = input.kind === "decision" ? askOwner(Number(input.appendTo), title || `Item ${input.appendTo}`, String(input.question || detail).slice(0, 500)) : null;
        return { raised: true, id: Number(input.appendTo), appended: true, ...(asked ? { decision: asked } : {}), instruction: asked ? "Added to the existing item, and the owner has the decision DM. One public notice is allowed; status_card and other support writes wait until the owner answers." : "Added to the existing item for the developers. You can now tell the player it is with them." };
      }
      // Owner, 2026-10-21: MCP capability requests live on their own board.
      // kind "capability" is kanban-only on product lakeside-mcp: no public
      // GitHub issue (tooling is internal), and it never blocks the ticket.
      // File it, note the card, and keep the ticket moving with a workaround.
      if (input.kind === "capability") {
        if (title.length < 8 || detail.length < 40) throw new Error("give a short title and the evidence: which tool or capability is missing, which call failed, and the workaround you are using instead");
        if (!input.force) {
          const open = await mcp.call("ops-knowledge", "kanban_list", { product: "lakeside-mcp", limit: 200 }, false, signal).catch(() => null);
          const items = Array.isArray(open) ? open : open?.items || [];
          const candidates = items.map((k) => ({ id: k.id, title: k.title, score: similarity(`${k.title} ${String(k.detail || "").slice(0, 600)}`, `${title} ${detail.slice(0, 600)}`) })).filter((k) => k.score >= 0.06).sort((a, b) => b.score - a.score).slice(0, 3);
          if (candidates.length) return { raised: false, candidates: candidates.map(({ id, title }) => ({ id, title })), instruction: "These open capability requests may be the same gap. If one is, call raise_to_developers again with appendTo set to its id and your evidence as detail. If none is, call again with force: true." };
        }
        const r = await addDistinctCard({ product: "lakeside-mcp", title, detail: `${detail}\n\nRaised by Keir${n ? ` from ticket ${n}` : ""}.`, kind: "capability", lane: "next", actor: "keir" });
        record(r?.id || null);
        return { raised: true, id: r?.id || null, instruction: "Filed on the MCP capability board (product lakeside-mcp, kind capability). Filing is not a fix: work around it with the tools you have, note the card id on the ticket record, and keep the ticket moving. Do not wait on the card." };
      }
      // Keir 10.2 (owner, 2026-11-17): GitHub housekeeping is Keir's own job, never a card or a "needs a person" DM.
      { const kind = require("./prhousekeeping").housekeepingRequest(`${title} ${detail}`); if (kind && !["bug", "enhancement"].includes(input.kind)) throw new Error(require("./prhousekeeping").INSTRUCTION(kind)); }
      if (title.length < 8 || detail.length < 40) throw new Error("give a short title and the evidence: what happens, where in the code or data, and the question for the developers");
      if (DECISION_WORDS.test(`${title} ${detail}`) && input.kind !== "decision" && input.kind !== "bug")
        throw new Error("This asks for an owner decision (compensation, refund, approval or a ruling). Call again with kind: \"decision\" and a concise question plus options: two to six named choices with the outcome of each in its detail. Preference selection is not execution approval.");
      if (input.kind === "decision" && String(input.question || "").trim().length < 15) throw new Error("a decision needs a concise question and two to six named options, each explaining its outcome");
      // Keir 10.1.9 (owner, 2026-11-17, PR 6680): a request to merge, ship or deploy a PR Keir opened is never plain text.
      // It goes through the github merge action, which puts Approve and Decline buttons in the owner's DMs.
      {
        const text = `${title} ${detail}`;
        if (/\b(?:merge|merged|merging|ship|promote|promotion|deploy|release|ready for merge|approve|approval)\b/i.test(text)) {
          for (const m of text.matchAll(/(?:\bPR\b|pull request|\/pull\/)\s*#?(\d{1,7})/gi)) {
            const num = Number(m[1]);
            const own = Object.values(d.jobs).some((j) => (j.pullRequests || []).some((u) => Number(/\/pull\/(\d+)\s*$/.exec(String(u))?.[1]) === num));
            if (own) throw new Error(`PR ${num} is one Keir opened, and a merge or deploy request for it is never sent as plain text. Call the github tool with action merge and number ${num} (add an explanation once it asks): when its checks are green the owner gets an Approve or Decline button, and the merge runs when they approve. If the checks are not green yet, fix or wait for them first. Do not call raise_to_developers for this.`);
          }
        }
      }
      if ((input.kind || "question") === "question" && input.needsHuman === true
          && (job.reviewItem?.kind === "doc_conflict" || changeClass === "display")) {
        throw new Error("Keep this correction on your task. Use repository_snapshot and shell or delegate_fix to prepare a patch, then publish_patch. Use github merge to ask for exact owner approval once the PR is ready.");
      }
      const prior = (job.raisedToDevelopers || []).find((r) => similarity(r.title, title) > 0.6);
      if (prior) return { raised: true, id: prior.id, duplicate: true };
      if (!input.force && !filedIssue) {
        const open = await mcp.call("ops-knowledge", "kanban_list", { product: "a-house-divided", limit: 200 }, false, signal).catch(() => null);
        const items = (Array.isArray(open) ? open : open?.items || []).filter((k) => /Raised by Keir/.test(String(k.detail || "")) && now() - Date.parse(k.created_at || 0) < 3 * 86400000);
        const candidates = items.map((k) => ({ id: k.id, title: k.title, score: similarity(`${k.title} ${String(k.detail || "").slice(0, 600)}`, `${title} ${detail.slice(0, 600)}`) })).filter((k) => k.score >= 0.06).sort((a, b) => b.score - a.score).slice(0, 3);
        if (candidates.length) return { raised: false, candidates: candidates.map(({ id, title }) => ({ id, title })), instruction: "These open items, raised in the last three days, may be the same problem. If one is, call raise_to_developers again with appendTo set to its id and your evidence as detail. If none is, call again with force: true." };
      }
      const label = n && !new RegExp(`ticket\\s*#?${n}\\b`, "i").test(title) ? ` (ticket ${n})` : "";
      // Keir 5.6 (owner, 2026-10-16): the kanban is Keir's board to organize,
      // not a queue for the owner. A question Keir files is Keir's own work
      // item: it lands in "now", assigned to Keir, and the filing task keeps
      // working it instead of waiting for someone to accept it.
      // Keir 10.1 (ticket 1834, 2026-11-16): an account action Keir cannot perform is never its own to-do,
      // whatever the model set. The handoff DMs the owner once so a person actually sees it.
      const needsHuman = input.needsHuman === true || ((input.kind || "question") === "question" && ACCOUNT_ACTION.test(`${title} ${detail}`));
      const selfOwned = (input.kind || "question") === "question" && !needsHuman;
      const r = await addDistinctCard({ product: "a-house-divided", title: `${title}${label}`, detail: `${detail}\n\nRaised by Keir${n ? ` from ticket ${n}` : ""}.`, kind: input.kind === "bug" ? "bug" : input.kind === "enhancement" ? "feature" : "task", lane: selfOwned ? "now" : "next", actor: "keir", ...(selfOwned ? { assigned_to: "keir", start: true, summary: `Keir is working this${n ? ` for ticket ${n}` : ""}.` } : {}), ...(filedIssue ? { github: `${GITHUB_OWNER}/AHDGame#${filedIssue.number}` } : {}) });
      record(r?.id || null);
      if (selfOwned && r?.id) { const rec = job.raisedToDevelopers.find((x) => x.id === r.id); if (rec) { rec.selfOwned = true; ledger.save(); } }
      if (!selfOwned && (input.kind || "question") === "question" && r?.id) {
        const rec = job.raisedToDevelopers.find((x) => x.id === r.id);
        if (rec) { rec.needsHuman = true; rec.notifiedAt = now(); }
        if (!(n && require("./ticketstate").endedReason(d, n, job))) ledger.notify(`handoff:${r.id}`, "owner", `${n ? `Ticket ${n} needs a person: ` : "Needs a person: "}${title}\n\n${detail.slice(0, 900)}`);
        ledger.save();
      }
      if (input.kind === "decision") {
        const asked = askOwner(r?.id || null, title, String(input.question).trim());
        return { raised: true, id: r?.id || null, decision: asked, ...(d.decisions[asked]?.digestOf ? { digested: true, digestNote: "The owner already has a DM open for this ticket; this question was added to it, so they see every open question in one message. Do not open more decisions for the same ticket." } : {}), instruction: "Filed, and the owner has it as a decision DM. Tell the player the decision is with the developers, without promising the outcome (one public notice is allowed). Until the owner answers, status_card and other support writes are refused, so do not call them; finish waiting. Keep the ticket open: the answer wakes this task, then act on it." };
      }
      const worker = await startWorker(r?.id || null, filedIssue?.number || null);
      if (worker) return { raised: true, id: r?.id || null, ...(filedIssue ? { issue: filedIssue.number, url: filedIssue.url } : {}), ...worker };
      return { raised: true, id: r?.id || null, ...(filedIssue ? { issue: filedIssue.number, url: filedIssue.url } : {}), instruction: (input.kind || "question") === "question" ? "Filed on your own board as your work item (lane now, assigned to you). Nobody else will pick it up: keep working it yourself now. Read the game records you need with the heal-ops read tools (heal_query, heal_count), keep the player updated, and add findings with raise_to_developers appendTo. The card closes with your task. Do not wait on it and do not claim filing fixed the problem. No human sees this card: do not tell the player the developers have it. If the answer needs an account action you cannot do (relink a login, lift a block, unban, VPN access, recovery), call raise_to_developers again with needsHuman true." : "Filed for the developers. Filing is not a fix. Filing does not repair stored data. If the fault is in a record, now call request_heal with its collection, exact filter and value; the owner approves it before anything changes. Verify the reported problem is actually resolved before closing; optional feature proposals may remain on the developer queue." };
      } finally { releaseIssue(); }
    }
    if (name === "merge_related") {
      // Keir 4.0 (owner, 2026-10-14): a ticket about the same problem as an
      // older open ticket joins it, incident or not. The newer one merges.
      const target = Number(input.ticket);
      if (!job.ticket || job.kind !== "ticket") throw new Error("merge_related is for a ticket task's own report");
      if (!target || target === job.ticket) throw new Error("name the older open ticket this one duplicates");
      if (target > job.ticket) throw new Error("the newer ticket merges into the older one; this ticket is the older");
      const reason = String(input.reason || "").trim();
      if (reason.length < 8) throw new Error("give a one-line reason: what makes it the same problem");
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: target }, false, signal);
      if (!t || ["resolved", "closed"].includes(t.status)) throw new Error(`#${target} is not an open ticket`);
      if (["moderation", "investigation"].includes(t.category)) throw new Error("moderation tickets are never merged");
      const r = await incidents.mergeIntoIncident({ mcp, ledger, job, target, reason, by: "keir", requireIncident: t.category === "incident", signal });
      return { merged: true, source: job.ticket, target, steps: r?.steps || [], instruction: "This ticket is merged into the older one and its channel is closed. Finish done; do not post again." };
    }
    if (name === "similar_reports") {
      const q = String(input.text || "").slice(0, 300);
      if (q.length < 6) throw new Error("describe the problem in a few words");
      const hits = await mcp.call("support", "support_search", { query: q, kind: "ticket", limit: 12 }, false, signal).catch(() => ({ results: [] }));
      const tickets = (hits.results || hits.items || []).filter((t) => t.number !== job.ticket).map((t) => ({ number: t.number, title: t.title, status: t.status }));
      const resolved = notebook ? notebook.recall(q, { k: 5 }).filter((n) => n.kind === "resolution") : [];
      return { tickets, pastResolutions: resolved, instruction: "If one of these is the same problem, say so, link the work, and do not re-investigate from scratch." };
    }
    if (name === "calculate") {
      if(input.steps!==undefined){
        if(input.expression!==undefined)throw new Error('Supply expression or steps, not both');
        const steps=knowledge.calculateBatch(input.steps,job.evidence||[]);
        job.evidence=[...(job.evidence||[]),...steps.map(step=>step.value)].slice(-8000);
        return {steps,label:input.label||null};
      }
      const value = knowledge.calculate(input.expression, job.evidence || []);
      job.evidence = [...(job.evidence || []), value];
      return { expression: input.expression, value, label: input.label || null };
    }
    if (name === "recall") {
      if (!notebook) return { notes: [] };
      const player = job.role === "player" ? undefined : (job.role === "owner" || developerTask(job)) ? "*" : (await reporterOf(job, signal))?.id || undefined;
      return { notes: notebook.recall(String(input.query || ""), { ticket: job.ticket, k: 8, player, job: job.id, via: "tool" }) };
    }
    if (name === "player_note") {
      // Keir 2.3 (owner-approved): a private note about this ticket's reporter,
      // recalled on their future tickets. Never posted, never shown to players.
      if (!notebook) throw new Error("notebook unavailable");
      if (job.role === "player") throw new Error("players cannot write player notes");
      const r = await reporterOf(job, signal);
      if (!r?.id) throw new Error("this task has no identified reporter");
      return { saved: notebook.remember({ kind: "player", player: r.id, text: `${r.name || "Player"}: ${String(input.text || "").trim()}`, ticket: job.ticket, by: job.id }) };
    }
    if (name === "remember") {
      if (!notebook) throw new Error("notebook unavailable");
      if (job.role === "player") throw new Error("players cannot write Keir's notebook");
      return { saved: notebook.remember({ kind: input.kind, text: input.text, path: input.path, paths: input.paths, source: input.source, supersedes: input.supersedes, contradicts: input.contradicts, reason: input.reason, ticket: input.ticket || job.ticket, by: job.id }) };
    }
    if (name === "support_directive") return supportDirectives.send(job, input, signal);
    if (name === "ticket_record") {
      const n = input.ticket || job.ticket;
      if (!n) throw new Error("no ticket for this task");
      if (job.role === "player") throw new Error("players cannot edit the ticket record");
      if (input.op === "read") return knowledge.readTicketRecord(ledger, n, job);
      // Legacy app briefs used record notes as delivery. Keep that path honest:
      // accept the same original owner message in the support inbox first.
      // KBX2: several entries in one call (each a full model round before).
      if (input.op === "add" && Array.isArray(input.entries)) {
        if (!input.entries.length || input.entries.length > 8) throw new Error("entries takes 1 to 8 items of {kind, text, source}");
        for (const e of input.entries) knowledge.updateRecord(ledger, n, job, { op: "add", kind: e?.kind, text: e?.text, source: e?.source });
        return knowledge.readTicketRecord(ledger, n, job);
      }
      const receipt = isAppJob(job) && job.role === "owner" ? await supportDirectives.send(job, {ticket:n, context:input.text}, signal) : null;
      knowledge.updateRecord(ledger, n, job, input);
      const record = knowledge.readTicketRecord(ledger, n, job);
      return receipt ? {...record, supportDirective:receipt} : record;
    }
    const participantTools = ["read_servers", "read_tools", "read_tool", "ticket_history", "source_history", "view_attachment", "channel_reply", "checkpoint", "finish", "task_progress", "present_evidence"];
    if (job.role === "player" && !participantTools.includes(name)) throw new Error("players can discuss and supply evidence, but cannot authorize actions");
    if (isQuick(job) && !QUICK_TOOLS.includes(name)) throw new Error("quick conversations cannot execute actions; hand off authenticated work instead");
    if (name === "task_progress") return conversation?.progress(job) || [];
    if (name === "handoff") {
      if (!isQuick(job) || job.role === "player") throw new Error("only an authenticated owner or delegate request can be handed off");
      // Probes and benchmarks are graded on this lane and must never become an
      // owner task (their answers were DMed to the owner, 2026-10-12).
      if (job.internalProbe) throw new Error("internal probe: do not hand off; finish done with the best verified answer you have");
      const worker = ledger.createJob(`handoff:${job.id}`, { kind: "command", role: job.role, actorId: job.actorId,
        channelId: job.channelId, replyChannel: job.replyChannel, ticket: job.ticket, source: job.source,
        inbox: [...(job.requestInbox || []), ...(job.inbox || [])], deadline: job.deadline });
      musePolicy.inherit(ledger, job, worker);
      worker.appThread = job.appThread;
      // App conversation: the owner gets an answer now and the same message is
      // revised with the deeper findings, so the chat never goes quiet. A voice
      // turn that already replied just has that reply marked provisional.
      if (appChannel && isAppJob(job)) {
        // The quick turn may already have queued its answer; that message becomes
        // the provisional one when it lands. Otherwise open the slot now. Clients
        // that cannot render a revision keep the append-only answer.
        const editable = appChannel.answerEdits?.() === true;
        if (job.channelReplyQueued) { if (editable) job.provisionalAnswer = true; }
        else appChannel.handoffAnswer(job, input.answer, worker);
        job.progressMessageId ||= `app-status-${job.id}`;
      }
      job.inbox = []; job.state = "done"; job.summary = "Continuing in the work queue.";
      if (!job.channelReplyQueued && worker.replyChannel && !(appChannel && isAppJob(job))) worker.needsAck = true;
      ledger.save(); return { taskId: worker.id, state: worker.state };
    }
    if (name === "delegate_fix") return delegation.delegate(job, input.instructions, signal);
    if (name === "delegate_investigation") return delegation.investigate(job, input.question);
    if (name === "review_fix") return delegation.review(job, input, signal);
    if (name === "read_servers") return readServers(job);
    if (name === "check_draft") return draftCheck(job, input);
    if (name === "channel_reply") {
      if (job.kind === "ticket" && isModerationChannel(ledger, job.channelId || job.replyChannel)) throw new Error("This is a moderation ticket. Moderators handle it; Keir does not reply in it. Finish without acting.");
      if (!job.replyChannel || job.replyChannel !== job.source?.channelId) throw new Error("no authenticated reply channel");
      if (require("./toolmarkup").leaked(input.message)) throw new Error("This message contains tool-call markup. Call the tool through the tool interface instead of writing it out, then reply with the result.");
      let message = publicText(input.message);
      if (job.startedAt && job.unavailableScreenshotTurn === job.startedAt &&
          /\b(?:should (?:now )?(?:appear|show|see|be visible)|(?:now|currently) (?:lists?|shows?|appears?|displays?)|you(?:'ll| will) see)\b/i.test(message))
        throw new Error("The referenced screenshot is unavailable. Explain what you meant by the earlier reference. Leave the current screen unverified, or check it before claiming what appears there.");
      if (job.replyChannel !== "app" && Boolean(job.ticket || job.source?.channelName) && /\bintake\s+persisted|\b(?:support|ticket['’]s own)\s+task\b|receipt and intake card|intake card delivered/i.test(message))
        throw new Error("Public ticket acknowledgements should give the ticket link in one short sentence. Keep intake bookkeeping and task handoffs private.");
      require("./advicerouting").guard(job, d, message);
      if (!(job.ticket || ticketNumberOf(job.source?.channelName))) {
        const t = handoffTruth.deflection(message, { d, job, config, previewFailed: Boolean(job.previewFailure) });
        if (t) { ledger.audit("deflection_refused", { job: job.id, ticket: null }); throw new Error(t); }
      }
      if (/^(?:i['’]m on it|on it|looking into it|will do)[.!]*$/i.test(message.trim())) return { skipped: "generic acknowledgment suppressed; use progress_update with a specific line" };
      const ticketNo = job.ticket || ticketNumberOf(job.source?.channelName);
      if (ticketNo) message = shapeTicketPost(message); // short, in paragraphs, or refused
      if (!ticketNo) guardNumbers(job, message);
      if (!ticketNo && job.role === "player") guardPlayerRegister(job, null, message);
      // Keir 8.4.2: in staff channels and DMs, asking for names that sit in unopened screenshots or cases is refused.
      if (!ticketNo && job.kind === "conversation" && job.role !== "player" && job.replyChannel !== "app") {
        const refusal = require("./clarify").unreadContextRefusal({ message, images: conversation?.recentImages?.(job) || [], viewed: job.viewedImages || [], cases: job.caseContextOffered || [], refusals: job.unreadContextRefusals || 0 });
        if (refusal) { job.unreadContextRefusals = (job.unreadContextRefusals || 0) + 1; ledger.audit("clarification_refused", { job: job.id, staff: true }); ledger.save(); throw Object.assign(new Error(refusal), { screened: true }); }
        const noLookup = require("./clarify").lookupRequiredRefusal({ question: [job.source?.content, ...(job.requestInbox || []).map((m) => m?.content)].filter(Boolean).join("\n"), message, lookups: job.lookupReads || 0, refusals: job.lookupRefusals || 0 });
        if (noLookup) { job.lookupRefusals = (job.lookupRefusals || 0) + 1; ledger.audit("clarification_refused", { job: job.id, staff: true, lookup: true }); ledger.save(); throw Object.assign(new Error(noLookup), { screened: true }); }
      }
      if (ticketNo) {
        // A ticket channel belongs to the player, whoever asked. Player-register
        // copy only; the technical trail lives in the PR.
        if (TECHNICAL.test(message)) throw new Error("This is the player's ticket channel. Rewrite for the player in one to three sentences: what was wrong and where the fix is (being built / in testing on dev / on sandbox / live on the main server). No PR or issue numbers, links, CI, checks, merges, branches, commits, file names or code.");
        await guardTicketPost(job, ticketNo, message);
        message = softenSettingClaims(job, ticketNo, softenAccountClaims(job, ticketNo, softenBugClaims(job, ticketNo, softenUnreadClaims(job, ticketNo, message))));
        message = require("./sources").appendChecked(message, ledger.data.ticketObservations?.[ticketNo]);
        // Owner, 2026-10-14 (ticket 1553): Keir asked "which bank" when the
        // ticket already named the reporter's company and the page they had open.
        if (ASKS_WHICH.test(message)) {
          const t = await mcp.call("support", "support_get", { kind: "ticket", number: ticketNo }, false, signal).catch(() => null);
          const known = [...new Set([t?.reporter?.corporationUrl, t?.intake?.candidatePageUrl, ...(t?.supportRecentVisits || []).map((v) => v.path)].filter(Boolean))].slice(0, 6);
          if (known.length && !job.askedPlayerWhich) {
            job.askedPlayerWhich = true; ledger.save();
            throw new Error(`Not posted: the ticket already points at ${t?.reporter?.corporationName ? `${t.reporter.corporationName} and ` : ""}these pages: ${known.join(", ")}. Check them before asking the player which one or for a link. If none of them is it, post the question again and it goes out.`);
          }
        }
        if (job.kind !== "conversation") {
          // Substantive updates are sent and attached to the ticket record.
          const args = { kind: "ticket", number: ticketNo, message, deliver: true, update_kind: "progress", delivery_mode: "reply" };
          // Keir 11.1: a chart staged by present_evidence in this activation rides on this answer (the support service verifies and attaches it).
          const evidence = evidenceDelivery.claimTicket(ledger, job, { config, key: `ticket-update:${hash(args)}`, ticket: ticketNo, at: now() });
          // A stable update key for an answer bound to a presentation (a retry lands on the same update), and the verified request it answers.
          const extra = evidenceDelivery.ticketArgs(ledger, job, { key: `ticket-update:${hash(args)}`, evidence });
          let sent;
          try { sent = await effect(job, `ticket-update:${hash(args)}`, () => callSupport("support_public_update", { ...args, ...extra, ...(evidence ? { evidence } : {}) }, true, signal), { kind: "reply", ticket: ticketNo, text: message }); }
          catch (e) { evidenceDelivery.settleTicket(ledger, job, { id: evidence, error: e, at: now() }); throw e; }
          evidenceDelivery.settleTicket(ledger, job, { id: evidence, result: sent, at: now() });
          const delivery = sent.delivery;
          const posted = delivery?.posted === true || delivery?.alreadyPosted === true || ["posted", "sent", "delivered", "already_posted"].includes(delivery?.status) || delivery?.delivery?.status === "posted";
          if (!posted || delivery?.via === "intake-card") throw new Error("Ticket answer delivery is not confirmed as a new channel message. Do not mark the player answered or start closure grace; inspect the delivery receipt first.");
          conversationTurn.answered(job);
          job.channelReplyQueued = true; job.lastPublishedAt = now(); recordTicketPost(job, ticketNo, message);
          const ticketTask = d.jobs[d.seen[`ticket:${ticketNo}`]]; if (ticketTask) ticketTask.lastPublishedAt = now();
          ledger.save();
          return { published: true, attachedToTicket: ticketNo, messages: 1, delivery: sent.delivery?.status || "submitted" };
        }
      }
      // Owner, 2026-10-23: a waiting app task re-posted the same "Railway is
      // still unverified" answer on every 15-minute wake for seven hours. With
      // no new owner message since its last reply, a near-repeat of any of its
      // last five replies is not posted.
      if (job.replyChannel === "app" && !ticketNo) {
        const sent = job.appReplies || [], lastAt = sent.at(-1)?.at || 0;
        const asked = [...(job.requestInbox || []), ...(job.inbox || [])].some((s) => (Date.parse(s?.at) || 0) > lastAt);
        if (sent.length && !asked && sent.some((r) => similarity(r.text, message) >= APP_REPEAT_SIMILARITY)) {
          job.appRepeats = (job.appRepeats || 0) + 1; ledger.save();
          return { skipped: "Nothing materially new since your last reply in this conversation, so it was not posted. Checkpoint or finish; reply again only when something changed or the owner asks." };
        }
        job.appReplies = [...sent, { at: now(), text: message.slice(0, 2000) }].slice(-5); job.appRepeats = 0; job.lastPublishedAt = now();
      }
      conversationTurn.check(job);
      const answerTo = conversationTurn.eligible(job) ? conversationTurn.latestSource(job) : null;
      const key = `channel-reply:${job.id}:${answerTo && answerTo !== job.source?.messageId ? answerTo + ":" : ""}${hash(message)}`;
      if (ticketNo) recordTicketPost(job, ticketNo, message);
      ledger.notify(key, `channel:${job.id}`, message, answerTo ? { answerTo } : {});
      conversationTurn.answered(job);
      job.channelReplyQueued = true; job.channelRepliedAt = now(); ledger.save();
      return { queued: true, delivery: "durable channel outbox" };
    }
    if (name === "read_tools") {
      if (job.role !== "owner" && !developerTask(job) && !readScope(job)[input.server]) throw new Error("read server is outside support scope");
      if (job.role === "player" && !["support", "gamestate", evidenceLookup.SERVER].includes(input.server)) throw new Error("player conversation reads are limited to its ticket and public game state, including the public evidence dictionary");
      if (isQuick(job) && job.role === "owner" && !QUICK_OWNER_READS[input.server]) throw new Error("server is outside quick read scope");
      const list = await mcp.list(input.server);
      const listed = list.filter((t) => (!musePolicy.origin(d, job).scoped || musePolicy.MCP_READS[input.server]?.includes(t.name)) && (job.role !== "player" || input.server !== "support" || t.name === "support_get") && (job.role !== "player" || input.server !== evidenceLookup.SERVER || t.name === evidenceLookup.TOOL) && ((job.role === "owner" || developerTask(job)) ? (!isQuick(job) || QUICK_OWNER_READS[input.server].includes(t.name)) : readScope(job)[input.server].includes(t.name))).map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema }));
      // KBX2: a second listing of the same server in one activation costs a full
      // round and repeats a large schema dump; return the names and point back.
      job.listedTools ||= {};
      if (job.listedTools[input.server]) return { alreadyListed: true, note: "You already have this server's tools from this activation (context.orientation.tools or your earlier read_tools result). Call read_tool directly.", names: listed.map((t) => t.name) };
      job.listedTools[input.server] = true;
      return listed;
    }
    if (name === "read_tool") {
      // 2026-11-17: 33 of 51 "read tool is outside support scope" refusals were DeepSeek calling read_tool
      // turndiag/turn_status (a Keir tool, not a turndiag one) up to 13 times in a row on one ticket, because the
      // refusal never said where the tool lives. turn_status is read-only and already visible to this task, so run it.
      if (input.tool === "turn_status" && job.role !== "player") return await w3.call(job, "turn_status", {}, signal);
      if (input.tool === "team_activity" && require("./w3tools").createVisible(job, "team_activity")) {
        return tool(job, "team_activity", input.args || {}, signal);
      }
      // read_tool is a read path for every role, owner included: write-like tools
      // (heal applies, creates, deletes, sends, merges) go through their own gated
      // tools (request_heal, github, support_action). KBX3 2026-10-28: an owner task
      // replayed a heal confirm token through read_tool heal_adhoc_apply.
      if (/(?:^|_)(?:apply|delete|remove|drop|update|set|create|insert|send|post|merge|promote|publish|rollback|reset|write|compensate)(?:_|$)/i.test(String(input.tool || "")) && !/^(?:heal_plan|heal_adhoc_plan|heal_compensate_plan)$/.test(input.tool))
        throw new Error(`read_tool is read-only; ${input.tool} changes state. Use the gated tool for it (request_heal for repairs, github for merges, support_action for support writes).`);
      const args = { ...(input.args || {}) };
      // knowledge_query takes `text`; models reach for query or question, and
      // every such read failed schema validation (2026-10-23 DeepSeek trace).
      if (input.server === "ops-knowledge" && input.tool === "knowledge_query" && args.text === undefined) {
        const alias = ["query", "question", "q"].find((k) => typeof args[k] === "string");
        if (alias) { args.text = args[alias]; delete args[alias]; }
      }
      // Keir 9: code_search and code_exact take `question`; DeepSeek sends query (2026-11-12 replay: four
      // code searches with the wrong key, so the rule was never found).
      if (input.server === "ops-knowledge" && ["code_search", "code_exact"].includes(input.tool) && args.question === undefined) {
        const alias = ["query", "text", "q", "symbol", "term"].find((k) => typeof args[k] === "string");
        if (alias) { args.question = args[alias]; delete args[alias]; }
        else if (Array.isArray(args.terms) && args.terms.length) { args.question = args.terms.join(" "); }
        delete args.terms;
      }
      // heal-ops passes filters through verbatim, so {"$oid": id} is an unknown
      // operator. Match the id as text instead: ids are stored both ways.
      if (input.server === "heal-ops" && ["heal_query", "heal_count"].includes(input.tool) && args.filter && typeof args.filter === "object") args.filter = oidFilter(args.filter);
      // map_snapshot accepts one metric list for two scopes; the country scope has no world-only layers, and its refusal names
      // none of the valid ones. 43 Sentry events (KEIR-7) were Keir asking for "parties" with scope country. Say what works.
      if (input.server === "gamestate" && input.tool === "map_snapshot") mapSnapshotScopeCheck(args);
      // Keir 7: a raw database read is a workaround for a missing purpose-built
      // read; capabilitygaps.js turns repeats into capability requests.
      if (input.server === "heal-ops" && ["heal_query", "heal_count"].includes(input.tool) && typeof args.collection === "string") { try { ledger.audit("raw_read", { job: job.id, ticket: job.ticket || null, collection: args.collection.slice(0, 80) }); } catch {} }
      // Reading game state, code or data counts as investigating; reading the
      // ticket itself does not. "Cause found" on a card needs some of it.
      if (input.server !== "support") { job.investigatedReads = (job.investigatedReads || 0) + 1; job.lastGameReadAt = now(); }
      // The code-read marks (lastCodeReadAt, codeLookups) are set in tool(), after the call succeeded and returned something.
      // Keir 5.6.2: the spin guard counts distinct reads. Re-reading the same
      // card or record every wake is not progress (a finding re-read its own
      // unassigned handoff 463 times overnight, 2026-10-16).
      { const key = hash([input.server, input.tool, input.args || {}]); const seen = (job.readKeys ||= []);
        if (!seen.includes(key)) { seen.push(key); if (seen.length > 200) seen.shift(); job.distinctReads = (job.distinctReads || 0) + 1; } }
      if (isQuick(job) && job.role === "owner" && !QUICK_OWNER_READS[input.server]?.includes(input.tool)) throw new Error("tool is outside quick read scope");
      if (LOOKUP_READS[input.server]?.includes(input.tool)) job.lookupReads = (job.lookupReads || 0) + 1;
      if (job.role === "player" && !(input.server === "gamestate" || (input.server === "support" && input.tool === "support_get") || (input.server === evidenceLookup.SERVER && input.tool === evidenceLookup.TOOL))) throw new Error("player conversation reads are limited to its ticket and public game state, including the public evidence dictionary");
      // Keir 11.1: the evidence dictionary gets only what the broker builds: scrubbed wording, public identifiers and the live tool list.
      const isLookup = input.server === evidenceLookup.SERVER && input.tool === evidenceLookup.TOOL;
      let lookupCallable = null;
      if (isLookup) {
        const scopeJob = ticketScopeOf(job);
        lookupCallable = await listedGamestate(job, Boolean(scopeJob), signal);
        const rep = scopeJob ? await reporterOf(scopeJob, signal).catch(() => null) : null;
        const built = evidenceLookup.lookupArgs(args, { names: [rep?.name, rep?.username].filter(Boolean), availableTools: lookupCallable ? [...lookupCallable] : undefined });
        for (const k of Object.keys(args)) delete args[k];
        Object.assign(args, built);
      }
      // Keir 11.1: reporter-bound reads take their identity from the broker alone, in every role and in every inherited child task.
      if (input.server === "gamestate" && REPORTER_BOUND.has(input.tool)) await bindReporterRead(job, input.tool, args, signal);
      if (job.role !== "owner" && !developerTask(job)) {
        if (!readScope(job)[input.server]?.includes(input.tool)) throw new Error(outsideScopeMessage(readScope(job), input.server, input.tool));
        if (input.server === "ops-knowledge" && input.tool === "kanban_get") {
          const root = rootJob(job, d.jobs);
          const ownEngineeringCard = root?.operatorRole === "engineering" && args.id === (root.engineeringKanbanId || config.engineeringKanbanId);
          if (!Number.isSafeInteger(args.id) || !(ownEngineeringCard || (job.raisedToDevelopers || []).some((r) => r.id === args.id))) throw new Error("read only this task's own card or confirmed developer handoffs");
          const card = await mcp.call(input.server, input.tool, { id: args.id }, false, signal);
          if (Number(card?.id) !== args.id) throw new Error("developer handoff receipt does not match");
          return Object.fromEntries(["id", "title", "lane", "assigned_to", "progress_summary", "last_progress_at", "evidence_url"].filter((k) => card[k] !== undefined).map((k) => [k, card[k]]));
        }
        if (input.server === "heal-ops" && ["heal_query", "heal_count", "heal_collections"].includes(input.tool)) Object.assign(args, rawReadArgs(input.tool, args));
        if (input.server === "ops-knowledge" && input.tool.startsWith("code_")) args.source = "prod";
        if (input.server === "ops-knowledge" && input.tool.startsWith("knowledge_")) {
          // Keir 2.0 gives support tasks the knowledge base, filtered to game
          // knowledge: never postmortems, security, moderation or ops notes.
          // Keir 5.2: search the game project with headroom, because the filter
          // drops internal rows after ranking and a small limit left nothing.
          const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 12);
          const raw = await mcp.call(input.server, input.tool, { ...args, project: "a-house-divided", collection: "docs", ...(input.tool === "knowledge_query" ? { limit: 25 } : {}) }, false, signal);
          if (signal?.aborted) throw new Error("knowledge read cancelled");
          const kept = knowledge.shapeKnowledge(raw, input.tool, { filter: gameKnowledge, limit });
          return input.tool === "knowledge_get" ? (kept || { error: "not game knowledge; unavailable to support tasks" }) : kept;
        }
        // An investigator reads for its ticket task: same ticket, same reporter, read-only.
        const scope = !job.ticket && job.investigation ? (ticketScopeOf(job) || job) : job;
        if (PLAYER_PRIVATE.has(input.tool)) {
          if (!scope.ticket) throw new Error("player history reads need an assigned ticket");
          await reporterOf(scope, signal);
          // Models name the reporter loosely (sequentialId, characterId, id, name)
          // or not at all; the only readable character is the reporter, so map
          // the aliases to character and default to the reporter. A different
          // character is still refused below (2026-10-19 replay benchmark: 44
          // refused reads in 18 dev runs, all argument shape, none another player).
          if (args.character === undefined) {
            const alias = ["sequentialId", "characterId", "name"].find((k) => args[k] !== undefined) ?? (input.tool === "trace_character" && args.id !== undefined ? "id" : null);
            if (alias) { args.character = args[alias]; delete args[alias]; }
            else if (scope.reporterCharacter?.id) args.character = String(scope.reporterCharacter.id);
          }
          if (args.ticket !== undefined && Number(args.ticket) === scope.ticket && !REPORTER_BOUND.has(input.tool)) delete args.ticket;
          const want = String(args.character || "").trim().toLowerCase(), r = scope.reporterCharacter;
          if (!want || !((r.id && want === String(r.id)) || (r.name && want === r.name.toLowerCase()))) throw new Error(`player history is limited to this ticket's reporter (${r.name || "unknown"}${r.id ? `, id ${r.id}` : ""})`);
        }
        if (input.tool === "support_get") {
          // The assigned ticket is the only readable one: fill it in when omitted.
          if (args.number === undefined && args.ticket !== undefined) args.number = Number(args.ticket);
          delete args.ticket;
          if (args.number === undefined && scope.ticket) args.number = scope.ticket;
          if (args.kind === undefined || args.kind === "bug") args.kind = "ticket";
          if (!scope.ticket || args.kind !== "ticket" || args.number !== scope.ticket) throw new Error("read the assigned ticket only");
        } else if (input.server === "support") {
          // Intake needs summaries for deduplication, never other players' transcripts.
          // support_search caps limit at 40; 60 failed every search (2026-10-23).
          const rows = await mcp.call(input.server, input.tool, { ...args, openOnly: true, limit: input.tool === "support_search" ? 40 : 60 }, false, signal);
          const items = rows.items || rows.results || [];
          return items.map((r) => ({ number: r.number, category: r.category, status: r.status })).slice(0, 60);
        }
      }
      let result, sentArgs = args;
      try { result = await mcp.call(input.server, input.tool, args, false, signal); }
      catch (error) {
        // A schema rejection with the schema attached is fixable in one retry;
        // without it models guessed argument names until the step limit.
        if (!/-32602|Input validation error/.test(String(error.message))) throw error;
        const schema = await mcp.list(input.server, signal).then((list) => list.find((t) => t.name === input.tool)?.inputSchema).catch(() => null);
        // Keir 6.1: most live rejections were a number where the schema wants a
        // string (a character id) or a size under the tool's minimum. Coerce
        // those against the schema and retry once instead of spending a round.
        const fixed = schema ? coerceArgs(args, schema) : null;
        if (fixed) {
          try { result = await mcp.call(input.server, input.tool, fixed, false, signal); sentArgs = fixed; }
          catch (retry) { if (!/-32602|Input validation error/.test(String(retry.message))) throw retry; }
        }
        if (result === undefined) throw new Error(String(error.message).slice(0, 600) + (schema ? ` Expected arguments for ${input.tool}: ${JSON.stringify({ properties: schema.properties, required: schema.required || [] }).slice(0, 1500)}` : ""));
      }
      if (signal?.aborted && input.server === "ops-knowledge" && input.tool.startsWith("knowledge_")) throw new Error("knowledge read cancelled");
      if (input.server === "heal-ops" && ["heal_query", "heal_count"].includes(input.tool)) {
        const hint = await rawReadHint(args.collection, emptyRead(result), signal);
        const withHint = (r) => (hint ? { ...r, collectionNote: hint } : r);
        const asIds = emptyRead(result) ? hexIdFilter(args.filter) : null;
        if (asIds) {
          const again = await mcp.call(input.server, input.tool, { ...args, filter: asIds.filter }, false, signal).catch(() => null);
          const names = asIds.fields.join(", ");
          if (again && !emptyRead(again)) return withHint(redactRaw({ ...again, note: `Nothing matched ${names} as plain text; these rows match it as a record id.` }));
          return withHint(redactRaw({ ...result, note: `Nothing matched, including ${names} read as a record id. Check the filter against a record you know exists before saying none exist.` }));
        }
        return withHint(redactRaw(result));
      }
      if (job.role === "player" && input.server === "support") {
        const cardId = result.intake?.cardMessageId;
        if (!cardId) throw new Error("backend ticket identity is unconfirmed; use the visible ticket history");
        const card = await discord("GET", `/channels/${job.channelId}/messages/${cardId}`);
        if (card.id !== cardId || card.author?.id !== config.botId || card.webhook_id) throw new Error("ticket backend does not match this channel's canonical intake card");
        // Backend notes, assessments and internal resolutions are not public copy.
        return Object.fromEntries(["number", "title", "description", "category", "status"].filter((k) => result[k] !== undefined).map((k) => [k, result[k]]));
      }
      // Whole runbooks for every hit crowded out the rest of the context.
      if (input.server === "ops-knowledge" && ["knowledge_query", "knowledge_get"].includes(input.tool)) return knowledge.shapeKnowledge(result, input.tool, { limit: Number(args.limit) || 8, bodyChars: input.tool === "knowledge_get" ? 20000 : 3000 }) || result;
      if (isLookup) return evidenceLookup.degrade(result, lookupCallable);
      if (input.server === "gamestate") {
        if (REPORTER_BOUND.has(input.tool) && sentArgs.ticket && result && !result.isError && !result.error) {
          // Keep subsequent replies private even across a restart or task handoff.
          (d.privateEvidenceTickets ||= {})[sentArgs.ticket] = true;
          ledger.save();
        }
        // Trackers must remember the authorized scope the MCP actually read.
        const observation = require("./evidencepages").observe(ledger, job, name, { ...input, args: sentArgs }, result, now());
        if (observation && result && typeof result === "object" && !Array.isArray(result)) {
          const instruction = input.tool === "commodity_market" && result.commodities?.length >= 12
            ? "For a market-wide question, call present_evidence now with this observation. It stages the full dated table on your next reply. Lead with the actual shortage/surplus counts and the main exceptions from summary. The market snapshot cannot show who made a profit."
            : "For a trend or a large comparison, stage this observation with present_evidence before channel_reply. Give the finding in the message. A tracker is appropriate only if future turns can answer an open question.";
          return { presentation: { observation, instruction }, ...result };
        }
      }
      return result;
    }
    if (name === "support_tools") {
      if (!job.ticket) throw new Error("task has no assigned ticket");
      return (await mcp.list("support")).filter(t => SUPPORT_WRITES.includes(t.name)).map(t => ({name:t.name, description:t.description, schema:t.inputSchema, assignedTicket:job.ticket}));
    }
    if (name === "reporter_state") {
      if (Object.keys(input).some(k => k !== "ticket") || (input.ticket !== undefined && (!Number.isSafeInteger(input.ticket) || input.ticket <= 0))) throw new Error("invalid reporter_state arguments");
      if (input.ticket !== undefined && input.ticket !== job.ticket && !developerTask(job)) throw new Error("reporter_state arguments cannot select another ticket outside a developer task");
      if (!job.ticket) throw new Error("task has no assigned ticket");
      // Keir 6.1.1: orientation calls this on every ticket activation. A read
      // can use a channel list up to 20s old; writes still fetch it fresh.
      if (!guildChannelCache || now() - guildChannelCache.at > 20000) guildChannelCache = { at: now(), channels: await discord("GET", `/guilds/${config.guildId}/channels`) };
      const channels = guildChannelCache.channels;
      if (!channels.some(c => c.id === job.channelId && c.name.endsWith(`-${job.ticket}`))) {
        if (!channels.some(c => c.id === job.channelId)) throw new Error("this ticket's channel no longer exists (the ticket was closed); finish without posting");
        throw new Error("ticket channel does not match");
      }
      // Keir 6.1.2: the character read below goes through heal-ops, which starts
      // a TypeScript CLI per query (8-11s in production; 6.1.1 ticket preflight
      // was 11.6s, 11.3s of it here). A ticket's reporter identity is stable, so
      // reuse a lookup for 30 minutes and share one that is still in flight.
      const reporterKey = input.ticket || job.ticket, hit = reporterCache.get(reporterKey);
      if (hit?.result && now() - hit.at < 30 * 60000) { job.reporterInspection = { ...hit.inspection }; return { ...hit.result, cached: true }; }
      if (hit?.pending) return hit.pending;
      const pending = (async () => {
      let ticket = await mcp.call("support", "support_get", {kind:"ticket", number:job.ticket}, false, signal);
      const cardId = ticket.intake?.cardMessageId;
      if (!snowflake(cardId)) throw new Error("canonical reporter identity is unconfirmed");
      const card = await discord("GET", `/channels/${job.channelId}/messages/${cardId}`);
      if (card.id !== cardId || card.author?.id !== config.botId || card.webhook_id) throw new Error("canonical intake card does not match this channel");
      const inspectedTicket = input.ticket || job.ticket;
      if (inspectedTicket !== job.ticket) ticket = await mcp.call("support", "support_get", {kind:"ticket",number:inspectedTicket}, false, signal);
      // Keir 9.0.2 (ticket 1829, 2026-11-13): tickets now carry the reporter's linked game username without a character
      // profile link. Resolve the account and its characters from the username (read-only) instead of reporting "not linked",
      // which made Keir ask a linked player for their character name.
      // Keir 10 (W3): an unlinked reporter falls back to the narrow resolver (character link, game
      // username, linked Discord account, repeated visits) instead of "not linked" or raw reads.
      const viaResolver = async (why) => {
        const r = await w3.resolveIdentity(job, signal);
        if (!r.matched || inspectedTicket !== job.ticket) throw new Error(why);
        const account = { linked: true, discordLinked: Boolean(r.account?.discordLinked) };
        const characters = r.current.map((c) => ({ name: c.name, sequentialId: c.id, countryId: c.country, homeState: c.state, currentOffice: c.office }));
        job.reporterInspection = { at: now(), ticket: inspectedTicket, account, characters }; ledger.save();
        return { environment: "prod", ticket: inspectedTicket, checkedAt: now(), account, characters, retiredCharacters: r.retired, matchedBy: r.via, ...w3presented(r) };
      };
      const w3presented = (r) => { const out = require("./resolvereporter").createResolver({ mcp, now }).present(r); return { instruction: out.instruction }; };
      if (!ticket.reporter?.profileUrl && ticket.reporter?.username) {
        const username = String(ticket.reporter.username);
        const users = await mcp.call("heal-ops", "heal_query", {env:"prod", collection:"users", filter:{username}, projection:{_id:1, username:1, discordId:1, discordLinkedAt:1}, limit:2}, false, signal);
        if (users.docs?.length !== 1 || users.docs[0].username !== username) return viaResolver("the ticket's linked game username did not match exactly one account");
        const userId = String(users.docs[0]._id);
        // Keir 9.0.4 (owner): whether the account has a Discord link, and since when. The Discord id itself is never returned.
        const discordLinked = Boolean(users.docs[0].discordId), discordLinkedAt = discordLinked && users.docs[0].discordLinkedAt ? String(users.docs[0].discordLinkedAt).slice(0, 10) : null;
        const account = { username, linked: true, discordLinked, ...(discordLinkedAt ? { discordLinkedAt } : {}) };
        const fields = ["name", "sequentialId", "countryId", "homeState", "currentOffice"];
        const chars = await mcp.call("heal-ops", "heal_query", {env:"prod", collection:"characters", filter:{$expr:{$eq:[{$toString:"$userId"}, userId]}}, projection:Object.fromEntries(fields.map(k => [k,1])), limit:10}, false, signal);
        const characters = (chars.docs || []).map((c) => Object.fromEntries(fields.filter(k => c[k] !== undefined).map(k => [k,c[k]])));
        job.reporterInspection = {at:now(), ticket:inspectedTicket, account, characters};
        // Keir 9.0.3 (replay finding): with exactly one character, it is the reporter for player-private reads, as a profile link was.
        if (characters.length === 1 && inspectedTicket === job.ticket && characters[0].sequentialId) {
          for (const j of [job, ...Object.values(d.jobs).filter((x) => x.ticket === job.ticket && x !== job)]) j.reporterCharacter = { ...(j.reporterCharacter || {}), id: String(characters[0].sequentialId), name: characters[0].name || null, username };
        }
        ledger.save();
        return {environment:"prod", ticket:inspectedTicket, checkedAt:now(), account, characters,
          instruction: characters.length ? "The reporter's linked account and its characters, from the live game. Never ask the player who they are or for their character name." : "The reporter's account is linked but has no current character. Never ask the player who they are; ask only for what you cannot read, if anything."};
      }
      let profile; try { profile = new URL(ticket.reporter?.profileUrl); } catch { return viaResolver("ticket has no linked character profile"); }
      if (!/^https:$/.test(profile.protocol) || !["www.ahousedividedgame.com", "ahousedividedgame.com"].includes(profile.hostname) || !/^\/character\/[1-9]\d*$/.test(profile.pathname)) throw new Error("ticket character profile is not canonical");
      const characterId = Number(profile.pathname.split("/").at(-1));
      if (!Number.isSafeInteger(characterId)) throw new Error("invalid linked character identity");
      const fields = ["name", "sequentialId", "countryId", "homeState", "currentOffice"];
      const result = await mcp.call("heal-ops", "heal_query", {env:"prod", collection:"characters", filter:{sequentialId:characterId}, projection:Object.fromEntries(fields.map(k => [k,1])), limit:1}, false, signal);
      if (result.matched !== undefined && result.matched !== 1) throw new Error("linked character is absent or ambiguous");
      if (result.docs?.length !== 1 || result.docs[0].sequentialId !== characterId) throw new Error("linked character lookup did not match");
      const character = Object.fromEntries(fields.filter(k => result.docs[0][k] !== undefined).map(k => [k,result.docs[0][k]]));
      job.reporterInspection = {at:now(), ticket:inspectedTicket, characterId, character}; ledger.save();
      return {environment:"prod", ticket:inspectedTicket, checkedAt:now(), character, instruction:"Use this actual server state with production code. Ask the player only for remaining client observations; no game data was changed."};
      })();
      reporterCache.set(reporterKey, { pending });
      try { const result = await pending; reporterCache.set(reporterKey, { at: now(), result, inspection: job.reporterInspection }); return result; }
      catch (e) { reporterCache.delete(reporterKey); throw e; }
    }
    if (name === "ticket_history") {
      if (!job.ticket) throw new Error("task has no ticket");
      const rows = await discord("GET", `/channels/${job.channelId}/messages?limit=50`);
      const claimant = rows.map((m) => ticketClaim(m, config, d.channels[job.channelId]?.claimReleasedAt)).find(Boolean);
      if (claimant) d.channels[job.channelId] = { ...d.channels[job.channelId], claimedBy: claimant };
      // Keir 9.0.2 (ticket 1829): only the player's own messages count as the player writing. A staff or owner message
      // ("their account should be linked, is it not?") re-armed the unanswered-player rule and the "no confirmed answer"
      // line was posted a second time.
      const staff = new Set([config.ownerId, ...(config.staffIds || [])].filter(Boolean));
      job.observedPlayerAt = Math.max(job.observedPlayerAt || 0, ...rows.filter((m) => !m.author.bot && !staff.has(m.author.id)).map((m) => Date.parse(m.timestamp) || 0));
      ledger.save();
      return rows.map((m) => ({ id: m.id, author: m.author.username, authorId: m.author.id, bot: Boolean(m.author.bot), content: m.content, embeds: m.embeds, attachments: m.attachments, at: m.timestamp }));
    }
    // 2026-11-03: the owner asked Keir for "a full forensic audit of the taxes ... as a public
    // report link on lakeside ops" and Keir had no way to publish one.
    if (name === "publish_report") {
      if (!(ownerDirected(job) || developerTask(job))) throw new Error("publish_report is for tasks the owner or a developer gave you");
      const slug = String(input.slug || "").trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug)) throw new Error("slug: lowercase letters, digits and hyphens, 2 to 80 characters");
      const title = String(input.title || "").trim(), html = String(input.html || "");
      if (title.length < 3) throw new Error("publish_report needs a title");
      if (html.length < 200) throw new Error("publish_report needs the report HTML (body fragment or full document), with the working shown");
      if (html.length > 2_000_000) throw new Error("report is too large; keep it under 2 MB");
      const wantsPublic = input.public === true;
      if (wantsPublic && !ownerDirected(job)) throw new Error("only the owner's own tasks publish public reports; publish it admin-only and tell the developer");
      const bad = require("./issues").leak(`${title}\n${html}`, []);
      if (bad) throw new Error(`Not published: the report contains "${bad}" (an internal host, path, account id, email or credential). Remove it and publish again.`);
      const args = { slug, title, html, summary: String(input.summary || "").slice(0, 600), public: wantsPublic, author: "keir", category: "Keir reports", icon: "📊" };
      const r = await effect(job, `publish-report:${slug}:${hash(html)}:${wantsPublic}`, () => mcp.call("ops-knowledge", "publish_report", args, true));
      ledger.audit("report_published", { job: job.id, slug, public: wantsPublic, chars: html.length });
      const url = r?.url || r?.liveUrl || `https://ops.lakesidegames.net/reports/${slug}`;
      return { published: true, slug, public: wantsPublic, url, instruction: "Give the requester the URL in one line with the headline finding." };
    }
    if (w3.has(name)) { w3.refreshAskHealth(); if (name === "team_activity") job.teamActivityAt = now(); return w3.call(job, name, input, signal); }
    if (name === "sentry") {
      if (!developerTask(job) && !developerTicket(job) && job.kind !== "finding") throw new Error("Sentry reads are for developer-directed tasks and Keir's own findings");
      const token = process.env.SENTRY_API_TOKEN, base = (process.env.SENTRY_API_URL || "https://sentry.io").replace(/\/$/, ""), org = process.env.SENTRY_ORG;
      if (!token || !org) throw new Error("Sentry is not configured on this host");
      const get = async (route) => {
        const r = await fetch(`${base}/api/0${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
        if (!r.ok) throw new Error(`Sentry ${r.status} for ${route.split("?")[0]}`);
        return r.json();
      };
      if (input.action === "issues") {
        const q = encodeURIComponent(input.query || "is:unresolved"), period = /^\d+[hd]$/.test(input.period || "") ? input.period : "24h";
        const rows = await get(`/organizations/${org}/issues/?query=${q}&statsPeriod=${period}&sort=${input.sort === "new" ? "new" : "freq"}&limit=${Math.min(25, Number(input.limit) || 10)}`);
        return rows.map((i) => ({ id: i.id, shortId: i.shortId, title: i.title, culprit: i.culprit, level: i.level, count: i.count, users: i.userCount, firstSeen: i.firstSeen, lastSeen: i.lastSeen, release: i.lastRelease?.shortVersion, link: i.permalink }));
      }
      if (input.action === "issue") {
        if (!/^\d+$/.test(String(input.id || ""))) throw new Error("issue id must be the numeric Sentry id");
        const [issue, event] = await Promise.all([get(`/organizations/${org}/issues/${input.id}/`), get(`/organizations/${org}/issues/${input.id}/events/latest/`)]);
        const frames = (event.entries || []).filter((e) => e.type === "exception").flatMap((e) => e.data.values || []).map((v) => ({ type: v.type, value: String(v.value || "").slice(0, 500),
          frames: (v.stacktrace?.frames || []).filter((f) => f.inApp).slice(-12).map((f) => ({ file: f.filename, fn: f.function, line: f.lineNo, context: (f.context || []).map((c) => c[1]).join("\n").slice(0, 600) })) }));
        return { id: issue.id, shortId: issue.shortId, title: issue.title, culprit: issue.culprit, count: issue.count, users: issue.userCount, firstSeen: issue.firstSeen, lastSeen: issue.lastSeen,
          release: event.release?.shortVersion || event.release?.version, tags: (event.tags || []).filter((t) => ["environment", "url", "transaction", "runtime"].includes(t.key)), exception: frames, link: issue.permalink };
      }
      // Keir 5.0: manage Sentry. A note links an issue to its GitHub issue or
      // fix; resolve needs the fix PR live on main (and the production turn
      // worker for turn code). Muting stays with humans.
      const send = async (method, route, body) => {
        const r = await fetch(`${base}/api/0${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
        if (r.status === 403) { const error = new Error("Sentry refused the write (403). Check event:write scope and project access; leave the issue unchanged."); error.code = "EXTERNAL_WRITE_REFUSED"; throw error; }
        if (!r.ok) throw new Error(`Sentry ${r.status} for ${route.split("?")[0]}`);
        return r.json().catch(() => ({}));
      };
      if (input.action === "note") {
        if (!/^\d+$/.test(String(input.id || ""))) throw new Error("issue id must be the numeric Sentry id");
        const text = redactSecrets(String(input.text || "")).slice(0, 1500);
        if (text.length < 10) throw new Error("say what the note links: the GitHub issue or fix PR");
        await effect(job, `sentry-note:${input.id}:${hash(text)}`, () => send("POST", `/organizations/${org}/issues/${input.id}/comments/`, { text }));
        const linked = [...text.matchAll(/https:\/\/github\.com\/(?:Egg3901|lakesidegamedev)\/AHDGame\/(?:issues|pull)\/(\d+)/g)].map((m) => Number(m[1]));
        (d.sentryLinks ||= {})[input.id] = [...new Set([...(d.sentryLinks?.[input.id] || []), ...linked])]; ledger.save();
        return { noted: true, id: input.id };
      }
      if (input.action === "resolve") {
        if (!/^\d+$/.test(String(input.id || ""))) throw new Error("issue id must be the numeric Sentry id");
        const fix = Number(input.fix);
        if (!fix) throw new Error("give fix: the merged AHDGame PR that fixed it");
        const gh = async (args) => JSON.parse(await exec("/usr/bin/gh", ["api", ...args], { timeout: 60000 }) || "null");
        const verified = await verifyLiveFix({ api: gh, number: fix, signal });
        if (!verified.live) return { resolved: false, reason: verified.reason || "the fix is not live for players yet" };
        const links = d.sentryLinks?.[input.id] || [];
        if (!links.includes(fix) && !links.some((n) => new RegExp(`\\b(?:refs?|fix(?:e[sd])?|close[sd]?|resolve[sd]?)\\s+#${n}\\b`, "i").test(verified.pr.body || "")) && !new RegExp(`https://[^\\s]*sentry[^\\s]*/issues/${input.id}(?:/|\\b)`, "i").test(verified.pr.body || "")) return { resolved: false, reason: "link this Sentry issue to its GitHub fix with sentry note before resolving" };
        await effect(job, `sentry-resolve:${input.id}:${fix}`, () => send("PUT", `/organizations/${org}/issues/${input.id}/`, { status: "resolved" }));
        await effect(job, `sentry-resolved-note:${input.id}:${fix}`, () => send("POST", `/organizations/${org}/issues/${input.id}/comments/`, { text: `Resolved by Keir: fixed in ${GITHUB_OWNER}/AHDGame#${fix}, live on the main server.` }));
        ledger.audit("sentry_resolved", { job: job.id, issue: input.id, fix });
        return { resolved: true, id: input.id, fix };
      }
      throw new Error("action must be issues, issue, note or resolve");
    }
    if (name === "github") {
      if (job.repository === "adhd-bot" && !input.repository) throw new Error("The Discord bot snapshot is source-only. Use a bot maintainer for bot GitHub work, or name AHDGame explicitly to inspect its API.");
      const readOnly = ["review", "status", "where", "deployed", "ci_failures", "ci_runs", "issues", "watch", "history", "close_issue", "pr_diff"].includes(input.action);
      // A ticket can span the game and the desktop client (1514 does); an
      // explicit repository wins over the task's default.
      if (input.repository && !["AHDGame", "AHDClient"].includes(input.repository)) throw new Error("repository must be AHDGame or AHDClient");
      const desktop = (input.repository || job.repository) === "AHDClient";
      const repo = desktop ? repositoryName("AHDClient") : GAME_REPO;
      const api = async (args) => JSON.parse(await exec("/usr/bin/gh", ["api", ...args], { timeout: 60000 }) || "null");
      // The owner's own button approval of this exact merge (Keir 8.2): the owner's GitHub review is submitted for him.
      let ownerConsent = null;
      const apiKeir = async (args) => JSON.parse(await exec("/usr/bin/gh", ["api", ...args], asKeir({ timeout: 60000 })) || "null");
      if (require("./githubextras").ACTIONS.includes(input.action)) {
        const staffSide = developerTask(job) || ownerDirected(job) || job.prMention || (job.kind === "ticket" && job.role === "support");
        const mine = (n, pr) => ownerDirected(job) || developerTask(job) || (job.pullRequests || []).some((x) => Number(x?.number ?? x) === n) || /^keir\//.test(String(pr?.head?.ref || ""));
        return require("./githubextras").run(input.action, { job, input, repo, api, post: (args) => exec("/usr/bin/gh", ["api", ...args], asKeir({ timeout: 60000 })).then((t) => { try { return JSON.parse(t || "null"); } catch { return null; } }), allowed: input.action === "pr_comment" ? (developerTask(job) || ownerDirected(job)) : input.action === "pr_diff" ? job.role !== "player" : Boolean(staffSide) && job.role !== "player",
          opened: mine, leak: (t) => require("./issues").leak(t, []) || publicPatchLeak(`+${t.replace(/\n/g, "\n+")}`), redactSecrets, noDashes, effect, hash, audit: (k, v) => ledger.audit(k, v) });
      }
      // A PR review asked for by @mention reads that one PR and posts one review on it.
      if (job.prMention) {
        if (!prMention.PR_MENTION_GITHUB.includes(input.action)) throw new Error("A PR review task only reads the pull request and posts one review on it");
        if (input.repository && input.repository !== "AHDGame") throw new Error("A PR review task stays in AHDGame");
        if (["review", "review_comment", "status", "ci_failures"].includes(input.action) && Number(input.number) !== job.prMention.number) throw new Error(`This task reviews pull request ${job.prMention.number} only`);
      }
      // Keir 7.2.1 (2026-11-02): a review a developer asked for is posted on the PR itself.
      // Keir had to say "GitHub is read-only from here" and ask the owner to paste its review.
      // A plain comment: never an approval, a requested change, a merge or a sign-off.
      if (input.action === "review_comment") {
        if (job.role === "player" || !(developerTask(job) || ownerDirected(job) || job.prMention)) throw new Error("review_comment needs a task the owner or a developer gave you");
        if (job.prMention?.posted) throw new Error("The review is already posted on the pull request; finish done");
        const number = Number(input.number);
        if (!number) throw new Error("review_comment needs the PR number");
        const raw = noDashes(String(input.comment || "").trim());
        if (raw.length < 20) throw new Error("review_comment needs the review text in comment");
        if (raw.length > 6000) throw new Error("review_comment is at most 6000 characters; keep the points that matter");
        if (job.prMention && !prMention.VERDICT.test(raw)) throw new Error('End the review with a verdict line: "Verdict: looks good", "Verdict: needs changes" or "Verdict: blocking issue"');
        // Checked before redaction: a leaking review is rewritten, not posted with holes in it.
        const bad = require("./issues").leak(raw, []) || publicPatchLeak(`+${raw.replace(/\n/g, "\n+")}`);
        if (bad) throw new Error(`The repository is public: the review mentions "${bad}". Remove it and post again.`);
        const body = redactSecrets(raw);
        const pr = await api([`repos/${repo}/pulls/${number}`]);
        if (!pr || pr.state !== "open") throw new Error(`PR ${number} is not open`);
        const head = String(pr.head?.sha || "").slice(0, 10);
        const text = `Review from Keir at ${head}:\n\n${body}\n\n_Advice only: this is not an approval._`;
        // Posted as Keir's own GitHub account when its token is configured, so the
        // review does not appear under the shared agent identity.
        const as = config.githubReviewerToken ? { env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/root", GH_TOKEN: config.githubReviewerToken } } : {};
        const posted = await effect(job, `pr-review-comment:${repo}:${number}:${hash(text)}`, async () => JSON.parse(await exec("/usr/bin/gh", ["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${text}`], { timeout: 60000, ...as }) || "null"));
        if (job.prMention) job.prMention.posted = posted?.html_url || true;
        ledger.audit("pr_review_comment", { job: job.id, repository: repo, number, head });
        return { posted: true, number, head, url: posted?.html_url || pr.html_url };
      }
      const ownPrAction = input.action === "close";
      // Keir 10.2 (owner, 2026-11-17): closing a fixed issue is Keir's own housekeeping from every lane (engineering,
      // watch, finding, ticket, coding). The live-fix check below is the guard, not the lane. Players never get it.
      if (input.action === "close_issue" && job.role === "player") throw new Error("close_issue needs a staff-side task");
      // Ticket and developer tasks ship their own fixes (owner rule: agents merge
      // and promote when the gate is green). Failures never merge; only a
      // proven identical staging qualification can bypass duplicate pending checks.
      // Keir 5.0: a finding ships its own fix only when it is display-only
      // (copy, layout, styling); everything else stays a draft PR.
      const ownFindingPr = (number) => (job.pullRequests || []).some((u) => canonicalGithubUrl(u) === `https://github.com/${repo}/pull/${Number(number)}`);
      if (job.kind === "finding" && input.action === "merge" && !ownFindingPr(input.number)) throw new Error("a finding only merges its own exact PR");
      const docReview = job.kind === "finding" && job.reviewItem?.kind === "doc_conflict";
      const findingShip = ["merge", "promote"].includes(input.action) && job.kind === "finding" && Boolean(job.pullRequests?.length);
      const shipsOwnFix = (["merge", "promote"].includes(input.action) && job.kind === "ticket" && Boolean(job.pullRequests?.length)) || findingShip;
      const keirMade = Object.values(d.jobs).some((j) => (j.pullRequests || []).some((u) => canonicalGithubUrl(u) === `https://github.com/${repo}/pull/${Number(input.number)}`));
      // An owner-approval task (ownerwait.js) may ask about the one developer PR it was made for; the merge still needs his button.
      const ownerWaitPr = job.ownerWaitPr && Number(job.ownerWaitPr) === Number(input.number);
      // Keir 11.2: the open-PR pass (keirprs.js) adopts a green Keir PR whose task ended; its one task asks the owner about that PR.
      const adoptedPr = job.adoptedPr && Number(job.adoptedPr) === Number(input.number);
      // Keir 10.1.9 (owner, 2026-11-17, PR 6680): a green PR Keir opened that this task has no standing authority to merge
      // (a watch finding, an engineering task) goes to the owner as an Approve / Decline question, never as plain text.
      const staffSide = job.role !== "player" && ["ticket", "command", "finding"].includes(job.kind);
      const hasStandingAuthority = ownerDirected(job) || shipsOwnFix || Boolean(ownerWaitPr && input.action === "merge");
      let askForAuthority = ["merge", "promote"].includes(input.action) && staffSide && !hasStandingAuthority
        && (input.action === "merge" ? keirMade || Boolean(job.pullRequests?.length) : Boolean(job.pullRequests?.length));
      if (docReview && input.action === "merge") askForAuthority = true;
      if (adoptedPr && input.action === "merge") askForAuthority = true;
      if (input.action === "merge" && !ownerDirected(job) && !keirMade && !ownerWaitPr && !adoptedPr) throw new Error("merge only PRs Keir opened unless the owner asked");
      // Reading where a change is, its checks or its failures is open to every
      // staff-side task: a ticket inherited from another operator has no PRs of
      // its own yet still has to know whether the fix is live (2026-10-13: four
      // tickets stalled on "PR inaccessible"). Players never get it.
      const readAllowed = job.role !== "player" && (developerTask(job) || developerTicket(job) || job.pullRequests?.length || ["ticket", "command", "finding"].includes(job.kind) || input.action === "close_issue");
      // Keir 10.2: closing a superseded bot PR is housekeeping open to every staff-side lane; the checks live in the close branch.
      if (ownPrAction ? job.role === "player" : readOnly ? !readAllowed : !(hasStandingAuthority || askForAuthority)) throw new Error(readOnly || ownPrAction ? "PR tools need a developer task or a task that opened PRs" : "merging and promotion run only on the owner's own request");
      // Every changed file. null means the list could not be read completely,
      // which counts as sensitive: the gate fails closed. PR files page up to
      // 3000; a compare lists at most 300 files, all on its first page.
      async function prFiles(number, details = false) {
        const out = [];
        for (let page = 1; page <= 30; page++) {
          const rows = await api([`repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`]).catch(() => null);
          if (!Array.isArray(rows)) return null;
          out.push(...rows.flatMap((f) => details ? [f] : [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]));
          if (rows.length < 100) return out;
        }
        return null;
      }
      async function rangeFiles(base, head, details = false) {
        const files = (await api([`repos/${repo}/compare/${base}...${head}`]).catch(() => null))?.files;
        return Array.isArray(files) && files.length < 300 ? files.flatMap((f) => details ? [f] : [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]) : null;
      }
      // Keir 8.4: what kind of change this merge or promotion ships (changeclass.js). Set once the file list is known.
      let shipClass = null;
      let findingMergeApproval = null;
      // A doc-review promotion may carry a guide's code-backed copy after the owner
      // approved its exact feature PR. Require every squash commit in the range to
      // be that task's approved work, and keep the ordinary promotion gates.
      async function checkFindingCommits(commits, cap) {
        if (!Array.isArray(commits) || !commits.length || commits.length > cap) throw new Error("finding promotion scope is unverified");
        const approvedDocs = [];
        for (const commit of commits) {
          if ((commit.parents || []).length > 1) continue;
          const prs = await api([`repos/${repo}/commits/${commit.sha}/pulls`]).catch(() => null);
          if (!Array.isArray(prs) || !prs.some((pr) => ownFindingPr(pr.number))) throw new Error("finding promotion carries unrelated changes");
          if (!docReview) continue;
          const approved = prs.find((pr) => ownFindingPr(pr.number) && pr.merged_at && pr.merge_commit_sha === commit.sha
            && Object.values(d.actions).some((a) => a.jobId === job.id && a.kind === "github" && a.state === "approved"
              && a.approvedBy === config.ownerId && a.approvalMessage && a.args.repository === repo
              && a.args.action === "merge" && a.args.number === pr.number && a.args.head === pr.head?.sha
              && a.digest === hash({ kind: a.kind, args: a.args })));
          if (!approved) throw new Error("finding promotion needs the exact approved merge for each correction it carries");
          approvedDocs.push(approved.number);
        }
        if (docReview && approvedDocs.length !== 1) throw new Error("doc review promotion needs exactly one approved correction");
        return approvedDocs[0];
      }
      function diffContents(files) {
        if (!Array.isArray(files) || !files.length) return null;
        const rows = [];
        for (const f of files) {
          if (typeof f.patch !== "string" || f.status !== "modified" || f.previous_filename) return null;
          const lines = f.patch.split("\n").filter(line => /^[+-]/.test(line));
          const added = lines.filter(line => line.startsWith("+")).length;
          if (!lines.length || added !== f.additions || lines.length - added !== f.deletions) return null;
          rows.push([f.filename, lines]);
        }
        return JSON.stringify(rows.sort((a, b) => a[0].localeCompare(b[0])));
      }
      const ownerGuard = () => { if (shipClass) changeClassMod.assertShippable(d, { ...shipClass, now: now(), inPerson: process.env.KEIR_GATED_OWNER_IN_PERSON === "1" }); };
      // Source evidence goes to the worker, never directly into an owner card.
      async function requestGithubApproval(args, reason) {
        const copy=require("./approvalcopy");
        // Keir 11.2: GitHub is the truth before any ask. A PR merged or closed by anyone, or moved to a new head, is not asked about.
        if(args.action==="merge" && Number(args.number)) {
          const live=await api([`repos/${repo}/pulls/${Number(args.number)}`]).catch(()=>null);
          if(!live) throw new Error(`GitHub could not be read for PR ${Number(args.number)}; nothing was sent to the owner. Try again in a few minutes.`);
          if(live.merged || live.merged_at) return { number: Number(args.number), merged: true, already: true, sha: live.merge_commit_sha, nextMove: "Already merged on GitHub. Nothing to ask; treat the merge as done." };
          if(live.state && live.state!=="open") throw new Error(`PR ${Number(args.number)} is closed on GitHub; nothing was sent to the owner.`);
          if(args.head && live.head?.sha && live.head.sha!==args.head) throw new Error(`PR ${Number(args.number)} moved to a new head (${live.head.sha.slice(0,10)}) since it was read; nothing was sent. Re-read it and ask for the current head.`);
        }
        const existing=Object.values(d.actions).find(a=>a.jobId===job.id && a.kind==="github" && JSON.stringify(musePolicy.normalized(a.args))===JSON.stringify(musePolicy.normalized(args)) && a.expiresAt>now());
        if(existing && ["approved","done","rejected"].includes(existing.state)) return request(job,"github",args,reason,existing.explanation);
        const liveQuestion=existing && Object.values(d.decisions||{}).some(x=>x.actionId===existing.id&&x.state==="pending");
        const value=liveQuestion && existing?.explanation ? existing.explanation : input.explanation || existing?.explanation;
        if(!value || value.reviewedHead!==copy.headOf(args)) {
          let evidence;
          if(args.action==="promote") {
            const from=args.from || ({staging:"development",main:"staging"})[args.to];
            const range=await api([`repos/${repo}/compare/${args.to}...${args.head}`]).catch(()=>null);
            const commits=(range?.commits||[]).filter(c=>(c.parents||[]).length<2);
            const sources=[];
            for(const c of commits.slice(0,40)) {
              const prs=await api([`repos/${repo}/commits/${c.sha}/pulls`]).catch(()=>[]);
              sources.push({sha:c.sha,title:c.commit?.message,changes:(Array.isArray(prs)?prs:[]).map(p=>({number:p.number,title:p.title,body:String(p.body||"").slice(0,5000)}))});
            }
            evidence={from,to:args.to,complete:Boolean(range)&&commits.length<=40,changes:sources};
          } else {
            const numbers=args.prs?.map(p=>p.number) || [args.number];
            evidence={changes:await Promise.all(numbers.map(number=>api([`repos/${repo}/pulls/${number}`]).then(p=>({number,title:p.title,body:String(p.body||"").slice(0,6000)})).catch(()=>({number,unavailable:true}))))};
          }
          return {needsExplanation:true,approvalRequired:false,reviewedHead:copy.headOf(args),destination:args.to||"development",evidence,
            instruction:"Nothing was sent for approval. Read these source changes, then call the same github action with explanation: reviewedHead exactly as returned, change (the problem and fix in ordinary language), impact (who notices and how), risk (verified risk or uncertainty). Cover every change in this version. No file paths, formulas, PR numbers, staging/development or developer jargon. Continue preparing now; do not wait for the owner or invent a recommendation."};
        }
        let checksAt, checksGreen;
        if (["merge", "merge-set"].includes(args.action)) {
          const targets = args.prs || [args];
          const verified = [];
          checksGreen = true;
          for (const target of targets) {
            const pr = await api([`repos/${repo}/pulls/${target.number}`]).catch(() => null);
            if (pr?.head?.sha && (pr.head.sha !== target.head || pr.state === "closed")) {
              return { approvalRequired: false, checksReady: false, nextMove: "Review the current open pull request and its exact head." };
            }
            const inspected = pr?.head?.sha ? await inspectChecks(pr).catch(() => null) : null;
            const runs = inspected?.runs || [];
            const times = runs.map(run => run.status === "completed" ? Date.parse(run.completed_at) : NaN);
            const at = times.length && times.every(Number.isFinite) ? Math.min(...times) : null;
            const fresh = require("./appdecision").mergeChecksFresh({ checksAt: at }, now());
            const refresh = job.mergeCheckRefresh;
            if (!fresh && refresh?.repository === repo && refresh.heads.includes(target.head)) {
              refresh.rerun ||= [];
              const workflowRuns = new Set(runs.map(run => /\/actions\/runs\/(\d+)/.exec(run.details_url || "")?.[1]).filter(Boolean));
              for (const id of workflowRuns) {
                if (refresh.rerun.includes(id)) continue;
                const run = await api([`repos/${repo}/actions/runs/${id}`]).catch(() => null);
                if (run?.head_sha !== target.head || run.status !== "completed") continue;
                await api(["-X", "POST", `repos/${repo}/actions/runs/${id}/rerun`]);
                refresh.rerun.push(id); ledger.save();
              }
              return { approvalRequired: false, checksReady: false,
                nextMove: "Wait for the new checks on this exact head, then ask for approval again." };
            }
            if (at) verified.push(at);
            checksGreen &&= Boolean(inspected?.result.ready && !inspected?.result.pending.length);
          }
          if (verified.length === targets.length) checksAt = Math.min(...verified);
        }
        const human=copy.explanation(value,args);
        if(existing?.state==="pending" && (!existing.explanation || !liveQuestion)) {
          for(const old of Object.values(d.decisions||{})) if(old.actionId===existing.id && old.state==="pending") {old.state="withdrawn";old.withdrawnReason="Needs a plain-language explanation";}
          existing.explanation=human;
          if (checksAt) { existing.checksAt = checksAt; existing.checksGreen = checksGreen; }
          const decision=openDecision(ledger,config,{jobId:job.id,actionId:existing.id,question:"Review this change",signoff:true});
          if(existing.ownerMuse) existing.ownerMuseDecision=decision.id;
          ledger.save();return {action:existing.id,decision:decision.id,state:"pending"};
        }
        const proposal = await request(job,"github",args,reason,human);
        const action = d.actions[proposal.action];
        if (action && checksAt) { action.checksAt = checksAt; action.checksGreen = checksGreen; ledger.save(); }
        return proposal;
      }
      const scopedOwner = musePolicy.origin(d, job).scoped;
      let scopedConsent = null;
      if (scopedOwner && ["merge", "promote"].includes(input.action)) {
        const to = input.action === "merge" ? (desktop ? "main" : "development") : input.to;
        const from = {staging:"development", main:"staging"}[to];
        if (input.action === "promote" && (desktop || !from)) throw new Error("promote to staging or main in the game repository");
        const pr = input.action === "merge" ? await api([`repos/${repo}/pulls/${Number(input.number)}`]) : null;
        if (pr?.merged) return { number: pr.number, merged: true, already: true, sha: pr.merge_commit_sha };
        const head = pr ? pr.head?.sha : (await api([`repos/${repo}/commits/${from}`]))?.sha;
        const base = pr ? pr.base?.sha : (await api([`repos/${repo}/commits/${to}`]))?.sha;
        if (pr && pr.base?.ref !== to) throw new Error("This PR targets an unexpected branch");
        const args = { repository: repo, action: input.action, head, base, to, ...(pr ? {number:Number(input.number)} : {from}) };
        const asked = await requestGithubApproval(args, "Exact owner GitHub operation");
        if (asked.needsExplanation || asked.checksReady === false) return asked;
        if (asked.state !== "approved") return asked.needsExplanation || asked.checksReady === false ? asked : { approvalRequired: true, ...asked };
        scopedConsent = d.actions[asked.action];
        musePolicy.validate(d, config, job, scopedConsent, now(), true);
      }
      if (["merge", "promote"].includes(input.action)) {
        // Economy and turn-engine changes move every player's money at once. A
        // promotion carries everything already on its source branch, so the
        // whole range is checked, not just the PR a ticket owns (2026-10-12
        // postmortem). Only the owner decides these, with an explicit yes.
        const to = input.to, from = { staging: "development", main: "staging" }[to];
        if (input.action === "merge" || from) {
          const files = input.action === "merge" ? await prFiles(Number(input.number)) : await rangeFiles(to, from);
          // Keir 8.4: classify the change. A gated class (rule, balance, economy-behaviour) goes to the owner's approval
          // card below even when no economy path matches, and may only execute with the owner's own recorded approval.
          let klass = { gated: false };
          if (!desktop) {
            const prd = input.action === "merge" ? await api([`repos/${repo}/pulls/${Number(input.number)}`]) : null;
            shipClass = { declared: input.changeClass, body: prd?.body, title: prd?.title, blastClass: Array.isArray(files) ? blast.classify(files).cls : "economy", ownerId: config.ownerId, action: input.action, number: input.action === "merge" ? Number(input.number) : null, to };
            klass = changeClassMod.classifyChange(shipClass);
            if (klass.needsDeclaration) { if (input.action === "merge") changeClassMod.assertShippable(d, shipClass); shipClass = null; }
          }
          if (findingShip && input.action === "promote" && files?.length) {
            const range = await api([`repos/${repo}/compare/${to}...${from}`]).catch(() => null);
            await checkFindingCommits(range?.commits, 60);
          }
          const approvedDocPromotion = docReview && input.action === "promote" && blast.classify(files).cls === "copy";
          if (findingShip && !approvedDocPromotion && (blast.classify(files).cls !== "copy" || !blast.displayOnlyDiff(input.action === "merge" ? await prFiles(Number(input.number), true) : await rangeFiles(to, from, true)).allowed)) {
            // Findings outside the automatic display path can ask to merge their own PR.
            if (input.action !== "merge" || !keirMade) throw new Error("Keir's own findings ship only display-only changes (pages, components, styles, text). This one is not: leave the PR as a draft for the developers, raise it with raise_to_developers, and finish.");
            askForAuthority = true;
          }
          // Red or still-running checks never get an approval button: the owner is asked only about a PR that is ready to merge.
          if (askForAuthority && input.action === "merge") {
            const prNow = await api([`repos/${repo}/pulls/${Number(input.number)}`]);
            if (prNow.merged) return { number: prNow.number, merged: true, already: true, sha: prNow.merge_commit_sha };
            if (prNow.state !== "open") throw new Error(`PR ${prNow.number} is ${prNow.state}`);
            const g = await gate(prNow);
            if (!g.ready) await mergeDeadEnd(prNow, g);
            if (!g.ready) return { number: prNow.number, merged: false, url: prNow.html_url, ...g, approvalRequired: false, nextMove: g.failed.length || g.mergeable === false ? "Red or conflicted: investigate and fix. The owner is only asked about a PR whose checks are green." : "Checks are not all green yet: finish waiting with a wakeup of about 10 minutes and call merge again. The owner is only asked once they are green." };
          }
          // A task that judges its own change economy-affecting (prices, money,
          // budgets, procurement, balance) gates it even when no path matches.
          const sensitive = files ? ((input.economy === true || klass.gated) && !files.some(isHugePath) ? files.map((f) => `${f} (${klass.gated ? `${klass.cls} change` : "declared economy change"})`) : files.filter(isHugePath)) : null;
          // Huge changes need an owner approval bound to an exact head. Since
          // 5.1 a promotion carrying only changes approved at their merged
          // heads rides those approvals (chain consent below); anything else
          // in the range still asks.
          let consent = scopedConsent;
          // An empty range ships nothing, so it asks nothing (ticket 1514: a
          // redundant ask then held back the closing message).
          // Keir 10.0.2 (owner, 2026-11-15): a hand promotion of non-sensitive changes ships without a sign-off, like the coding
          // worker path. Economy and turn-engine files still ask (sensitive above); a rule or balance change on this task still asks.
          const shipSignoff = input.action === "promote" && to === "main" && Array.isArray(sensitive) && !sensitive.length && files.length > 0 && job.requiresOwner === true;
          if (!scopedOwner && (!sensitive || sensitive.length || shipSignoff || askForAuthority)) {
            const list = sensitive ? sensitive.slice(0, 6).join(", ") + (sensitive.length > 6 ? ` and ${sensitive.length - 6} more` : "") : "file list unavailable";
            const what = input.action === "merge" ? `PR ${Number(input.number)} changes` : `Promoting ${from} to ${to} carries changes to`;
            const shipWhat = `Ship to the live server${job.ticket ? ` for ticket ${job.ticket}` : ""}.`;
            // Ticket and command tasks alike ask through the consent action below:
            // the owner's (or delegate's) button answer binds to this exact head.
            // Refusing outright made ticket 1519 ask the owner twice and still
            // never merge.
            const head = input.action === "merge" ? (await api([`repos/${repo}/pulls/${Number(input.number)}`])).head.sha : (await api([`repos/${repo}/commits/${from}`])).sha;
            const args = input.action === "merge" ? { repository:repo, action: "merge", number: Number(input.number), head, to:desktop?"main":"development" } : { repository:repo, action: "promote", to, head };
            // Share one question across tasks for this exact step and head.
            // A pending question is only "already asked" while its decision is
            // still live in the owner's DMs and its task is still open; a dead
            // one from a finished task blocked every staging promotion
            // (ticket 1537, 2026-10-14).
            const liveAsk = (a) => !JOB_TERMINAL.includes(d.jobs[a.jobId]?.state)
              && Object.values(d.decisions || {}).some((x) => x.state === "pending" && x.actionId === a.id);
            const same = (a) => a.kind === "github" && a.digest === hash({ kind: a.kind, args: a.args }) && (!docReview || a.args.repository === args.repository) && a.args.action === args.action &&
              a.args.head === head && (args.action === "merge" ? a.args.number === args.number : a.args.to === args.to);
            for (const a of Object.values(d.actions)) {
              if (!same(a) || a.state !== "approved" || a.approvedBy !== config.ownerId || !a.approvalMessage || a.approvalMessage === job.source?.messageId || a.expiresAt < now()) continue;
              if (a.args.head === head) { consent = a; break; }

            }
            const said = shipSignoff && job.ticket && d.shipSignoffs?.[job.ticket];
            if (!consent && said && now() - said.at < 6 * 3600000 && [config.ownerId, ...config.staffIds.slice(0, 1)].includes(said.by)) {
              const signArgs = { ...args, summary: "Ship to the live server, signed off in Discord." };
              const a = { id: ledger.id(), jobId: job.id, kind: "github", args: signArgs, digest: hash({ kind: "github", args: signArgs }), state: "approved", at: now(), expiresAt: now() + 3600000,
                approvedBy: config.ownerId, approvalMessage: said.messageId, approvedAt: said.at, ...(said.by !== config.ownerId ? { approvedOnBehalfBy: said.by } : {}) };
              d.actions[a.id] = a; consent = a; delete d.shipSignoffs[job.ticket];
              // A sign-off DM for the same promotion is no longer needed; the next decision pass deletes it.
              for (const other of Object.values(d.actions)) if (other !== a && same(other) && other.state === "pending") other.state = "superseded";
              ledger.audit("ship_signoff_direct", { action: a.id, job: job.id, by: said.by, head });
            }
            // Keir 4.2: the ticket's one yes (or the owner's own request) ships a
            // change that is not huge without another sign-off DM.
            const yes = !consent && shipSignoff && !authority.hugeCode(files).huge && (ticketYes(job) ||
              // Keir 5.0 (owner): a display-only fix Keir found itself may go all the way.
              (job.kind === "finding" && blast.classify(files).cls === "copy" ? { by: "policy:display-only", messageId: null, how: "display_only" } : null));
            if (yes) {
              const signArgs = { ...args, summary: "Ship to the live server on the ticket's earlier yes." };
              const a = { id: ledger.id(), jobId: job.id, kind: "github", args: signArgs, digest: hash({ kind: "github", args: signArgs }), state: "approved", at: now(), expiresAt: now() + 3600000,
                approvedBy: config.ownerId, approvalMessage: yes.messageId, approvedAt: now(), ...(yes.by !== config.ownerId ? { approvedOnBehalfBy: yes.by } : {}) };
              d.actions[a.id] = a; consent = a;
              for (const other of Object.values(d.actions)) if (other !== a && same(other) && other.state === "pending") other.state = "superseded";
              ledger.audit("ticket_authority_carried", { action: a.id, job: job.id, ticket: ticketOf(job), actionKind: "github", how: yes.how, head });
            }
            // One question per feature (owner, 2026-10-13): related economy PRs on
            // the same ticket are approved together, each at its current head.
            const inSet = (a) => a.kind === "github" && a.args.action === "merge-set" && a.digest === hash({ kind: a.kind, args: a.args }) && (a.args.prs || []).some((p) => p.number === args.number && p.head === head);
            if (!consent && args.action === "merge") consent = Object.values(d.actions).find((a) => inSet(a) && a.state === "approved" && a.approvedBy === config.ownerId && a.approvalMessage && a.expiresAt >= now()) || null;
            if (!consent && args.action === "merge" && job.ticket) {
              const pendingSet = Object.values(d.actions).find((a) => inSet(a) && a.state === "pending" && a.expiresAt >= now() && liveAsk(a));
              if (pendingSet) return { approvalRequired: true, action: pendingSet.id, state: "pending", instruction: "The owner already has this feature's merge question in their DMs. Finish waiting." };
              const numbers = new Set([args.number]);
              for (const j of Object.values(d.jobs)) if (j.ticket === job.ticket) for (const u of j.pullRequests || []) { const n = Number(/\/pull\/(\d+)/.exec(u)?.[1]); if (n) numbers.add(n); }
              const prs = [];
              for (const n of numbers) {
                const pr = n === args.number ? { state: "open", head: { sha: head } } : await api([`repos/${repo}/pulls/${n}`]).catch(() => null);
                if (!pr || pr.state !== "open") continue;
                const f = n === args.number ? files : await prFiles(n);
                if (!f || f.some(isHugePath)) prs.push({ number: n, head: pr.head.sha });
              }
              if (prs.length > 1) {
                const asked = await requestGithubApproval({ repository:repo, action: "merge-set", ticket: job.ticket, prs, summary: `Ticket ${job.ticket}: ${prs.length} related economy PRs (${prs.map((p) => "#" + p.number).join(", ")}) change the turn engine or economy, including ${list}.` }, "economy feature merge");
                return asked.needsExplanation || asked.checksReady === false ? asked : { approvalRequired: true, ...asked };
              }
            }
            // Keir 5.1 chain consent (owner, 2026-10-15): a promotion that carries
            // only economy changes the owner already approved, at their merged
            // heads, rides those approvals instead of asking again per stage.
            if (!consent && input.action === "promote" && sensitive?.length) {
              const range = await api([`repos/${repo}/compare/${to}...${from}`]).catch(() => null);
              const commits = Array.isArray(range?.commits) && range.commits.length <= 60 ? range.commits.filter((c) => (c.parents || []).length < 2) : null;
              const entries = [];
              if (commits) for (const c of commits) {
                const prs = await api([`repos/${repo}/commits/${c.sha}/pulls`]).catch(() => null);
                const merged = Array.isArray(prs) ? prs.filter((p) => p.merged_at) : [];
                const rows = [];
                for (const p of merged) { const f = await prFiles(p.number); rows.push({ number: p.number, head: p.head?.sha, huge: !f || f.some(isHugePath) }); }
                entries.push({ sha: c.sha, prs: rows });
              }
              const verdict = commits ? chain.cover({ entries, approvals: chain.approvedMerges(d.actions, config.ownerId, now()) }) : { covered: false, by: [] };
              if (verdict.covered) {
                const first = verdict.by[0];
                const signArgs = { ...args, summary: `Carries only changes the owner approved (${verdict.by.map((x) => x.id).join(", ")}).` };
                const a = { id: ledger.id(), jobId: job.id, kind: "github", args: signArgs, digest: hash({ kind: "github", args: signArgs }), state: "approved", at: now(), expiresAt: now() + 3600000,
                  approvedBy: config.ownerId, approvalMessage: first.approvalMessage, approvedAt: verdict.oldestApprovedAt, chainedFrom: verdict.by.map((x) => x.id) };
                d.actions[a.id] = a; consent = a;
                for (const other of Object.values(d.actions)) if (other !== a && same(other) && other.state === "pending") other.state = "superseded";
                ledger.audit("chain_consent", { action: a.id, job: job.id, ticket: ticketOf(job), to, head, from: a.chainedFrom });
              } else if (commits) ledger.audit("chain_consent_missed", { job: job.id, to, head, uncovered: verdict.uncovered.slice(0, 5) });
            }
            // Owner yolo covers promotions only (owner, 2026-10-17): with the main
            // thread in yolo under the owner's own grant, a promotion ships on that
            // grant instead of asking. Merges and ticket decisions still ask.
            const grant = d.appThread?.preferences?.main;
            if (!consent && input.action === "promote" && !d.paused && grant?.approvalMode === "yolo" && grant.authorization?.mode === "yolo" && grant.authorization.actor === config.ownerId) {
              const signArgs = { ...args, summary: `Promoted under the owner's yolo grant ${grant.authorization.id}.` };
              const a = { id: ledger.id(), jobId: job.id, kind: "github", args: signArgs, digest: hash({ kind: "github", args: signArgs }), state: "approved", at: now(), expiresAt: now() + 3600000,
                approvedBy: config.ownerId, approvalMessage: `yolo:${grant.authorization.id}`, approvedAt: now(), via: "owner-yolo" };
              d.actions[a.id] = a; consent = a;
              for (const other of Object.values(d.actions)) if (other !== a && same(other) && other.state === "pending") other.state = "superseded";
              ledger.audit("owner_yolo_promotion", { action: a.id, job: job.id, ticket: ticketOf(job), to, head, authorization: grant.authorization.id });
            }
            if (!consent) {
              const open = Object.values(d.actions).find((a) => same(a) && a.state === "pending" && a.expiresAt >= now() && liveAsk(a));
              if (open) return { approvalRequired: true, action: open.id, state: "pending", instruction: "The owner already has this exact merge or promotion question in their DMs. Do not ask again; finish waiting and you are woken with the answer." };
              // The owner must see everything a promotion carries, not only
              // this ticket's fix (2026-10-14: a ticket 1514 promotion to main
              // also carried another agent's NPP engine release, unnamed).
              let carries = "";
              if (input.action === "promote") {
                const range = await api([`repos/${repo}/compare/${to}...${from}`]).catch(() => null);
                const titles = (range?.commits || []).filter((c) => (c.parents || []).length < 2).map((c) => String(c.commit?.message || "").split("\n")[0].slice(0, 110));
                if (titles.length) carries = ` This promotion carries ${titles.length} change${titles.length === 1 ? "" : "s"}: ${titles.slice(0, 8).join("; ")}${titles.length > 8 ? `; and ${titles.length - 8} more` : ""}.`;
              }
              // No file list means the blast radius is unverified, not that it is economy code;
              // say so, or the owner hears "touches the economy" about a badge fix (KBX4 2026-11-02).
              const unverified = !sensitive;
              const summary = askForAuthority && Array.isArray(sensitive) && !sensitive.length ? `${what.replace(/ changes$| carries changes to$/, "")}: Keir found and fixed this itself and every check passed, but Keir has no standing permission to merge it without your yes.${carries} Head ${head.slice(0, 10)}` : shipSignoff ? `${shipWhat}${carries}` : unverified ? `${what.replace(/ changes$| carries changes to$/, "")}: GitHub did not list its changed files, so Keir cannot confirm it stays out of the economy and turn engine.${carries} Head ${head.slice(0, 10)}` : `${what} high-impact code: ${list}.${carries} Head ${head.slice(0, 10)}`;
              const asked = await requestGithubApproval({ ...args, summary }, askForAuthority && Array.isArray(sensitive) && !sensitive.length ? "merge of a green PR Keir opened without standing authority" : shipSignoff ? "ship to the live server" : unverified ? "merge or promotion with an unverified file list" : "economy merge or promotion");
              return asked.needsExplanation || asked.checksReady === false ? asked : { approvalRequired: true, ...(unverified ? { reason: "file_list_unavailable", instruction: "The changed files could not be listed, so this needs the owner's yes. Tell the owner that; do not say it touches the economy." } : {}), ...asked };
            }
            if (consent.approvedBy === config.ownerId && !consent.approvedOnBehalfBy && consent.args?.action === "merge") ownerConsent = consent;
            if (askForAuthority && input.action === "merge") findingMergeApproval = consent;
            ledger.audit(shipSignoff ? "ship_signoff" : "economy_consent", { action: consent.id, job: job.id, approvalMessage: consent.approvalMessage, ...args });
          }
          // Keir 4.0 blast radius (owner, 2026-10-14, after ticket 1498): an
          // economy or turn-worker promotion to the main server runs only in
          // the owner's waking hours, or on an approval less than three hours
          // old, or on an explicit night pass for this promotion.
          if (input.action === "promote" && to === "main") {
            const cls = blast.classify(files);
            if (cls.cls === "economy") {
              const answer = consent && Object.values(d.decisions || {}).find((x) => x.actionId === consent.id && x.state === "approve");
              const nightPass = Boolean(consent?.nightPass) || (ownerDirected(job) && blast.hasNightPass(job.source?.content)) || blast.hasNightPass(answer?.answer);
              const gate = blast.promotionGate({ cls: cls.cls, to, now: now(), lastOwnerApprovalAt: consent?.approvedAt || 0, nightPass });
              if (!gate.allowed) {
                job.promotionHoldUntil = gate.resumeAt;
                ledger.audit("promotion_held_awake_window", { job: job.id, ticket: job.ticket, to, resumeAt: gate.resumeAt, files: cls.reasons });
                ledger.save();
                const when = new Date(gate.resumeAt).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", weekday: "short" });
                return { held: true, resumeAt: new Date(gate.resumeAt).toISOString(), reason: gate.reason,
                  instruction: `Held: this changes the turn engine or economy and it is outside the owner's waking hours. The main-server promotion runs from ${when} Eastern, when you are woken, unless the owner grants a night pass for it. Finish waiting now. If the player needs a word, say the fix is on the sandbox and reaches the main server in the morning.` };
              }
              delete job.promotionHoldUntil;
              ledger.audit("promotion_window_ok", { job: job.id, ticket: job.ticket, to, reason: gate.reason });
            }
          }
        }
      }
      if (input.action === "review") {
        // A developer asks Keir to read their PR. Advisory only: the reply is
        // feedback in chat, never a GitHub approval, a merge or a sign-off.
        const number = Number(input.number);
        if (!number) throw new Error("review needs the PR number");
        const pr = await api([`repos/${repo}/pulls/${number}`]);
        const files = await prFiles(number, true);
        let budget = 60000;
        const changed = (files || []).map((f) => {
          const patch = String(f.patch || "");
          const keep = Math.max(0, Math.min(patch.length, 8000, budget));
          budget -= keep;
          return { file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, ...(f.previous_filename ? { renamedFrom: f.previous_filename } : {}),
            patch: patch.slice(0, keep), ...(keep < patch.length ? { truncated: true } : {}), ...(!patch && f.status !== "removed" ? { note: "binary or too large for an inline diff; read it with code_read on the head branch" } : {}) };
        });
        // A cut-off diff hid code from the review (2026-11-02: a junior developer's fix sat past
        // the 8,000-character cut, so Keir flagged a problem already solved). Attach the whole
        // file at the PR head for every truncated, non-removed file, within a shared budget.
        let fileBudget = 120000;
        for (const c of changed) {
          if (!c.truncated || c.status === "removed" || fileBudget <= 0) continue;
          try {
            const f = await api([`repos/${repo}/contents/${encodeURIComponent(c.file).replace(/%2F/g, "/")}?ref=${pr.head?.sha}`]);
            const text = f?.encoding === "base64" ? Buffer.from(String(f.content || ""), "base64").toString("utf8") : "";
            if (!text) continue;
            const keep = Math.min(text.length, 40000, fileBudget); fileBudget -= keep;
            c.headFile = text.slice(0, keep); if (keep < text.length) c.headFileTruncated = true;
          } catch {}
        }
        return { number, title: pr.title, author: pr.user?.login, state: pr.merged_at ? "merged" : pr.state, draft: Boolean(pr.draft), base: pr.base?.ref, head: pr.head?.ref, headSha: pr.head?.sha,
          body: String(pr.body || "").slice(0, 5000), filesComplete: Array.isArray(files), changed,
          instruction: "Where a diff is truncated, headFile holds the whole file at the PR head: read it before flagging anything as missing. Review the diff for bugs, regressions, missing tests and anything that touches money, economy, elections or turn processing. Give specific, file-referenced feedback in chat, and when the owner or a developer asked for a review, also post it on the PR with github review_comment. This review is advice: it never approves, merges, promotes or signs off the PR; shipping still needs the owner or the delegate." };
      }
      if (input.action === "history") {
        // Who shipped what (2026-10-13: Keir told the owner to run git blame).
        const p = String(input.path || "").replace(/^\/+/, "");
        if (!p || p.length > 300 || /\.\./.test(p)) throw new Error("history needs a repository path");
        const ref = ["main", "development", "staging"].includes(input.ref) ? input.ref : "main";
        const rows = (await api([`repos/${repo}/commits?path=${encodeURIComponent(p)}&sha=${ref}&per_page=40`])) || [];
        const commits = rows.map((c) => ({ sha: c.sha.slice(0, 10), date: c.commit?.author?.date?.slice(0, 10), author: c.author?.login || c.commit?.author?.name,
          pr: Number(/\(#(\d+)\)|Merge pull request #(\d+)/.exec(c.commit?.message || "")?.slice(1).find(Boolean)) || null, message: String(c.commit?.message || "").split("\n")[0].slice(0, 160) }));
        const shared = commits.some((c) => c.author === "Egg3901");
        return { path: p, ref, commits, oldest: commits.at(-1) || null,
          note: shared ? "The Egg3901 account is shared by the owner and every agent, so an Egg3901 commit may be agent work; say so rather than naming the owner." : undefined };
      }
      if (input.action === "watch") {
        // Cheap CI wait (owner, 2026-10-13): the operator polls the checks itself
        // and wakes this task when they finish, instead of a model run per poll.
        const number = Number(input.number);
        if (!number) throw new Error("watch needs the PR number");
        (job.ciWatch ||= {})[number] = { since: now(), repository: repo };
        ledger.save();
        return { watching: number, instruction: "Finish waiting now (any wake time; the watch wakes you as soon as the checks finish). Do not poll CI yourself." };
      }
      if (input.action === "ci_runs") return require("./ciEvidence").readCiEvidence({ api, repo, number: input.number, workflow: input.workflow, runId: input.run });
      if (input.action === "issues") {
        const query = String(input.query || "").trim();
        if (!query || query.length > 180) throw new Error("issues needs a query of 1 to 180 characters, for example: promote staging in:title");
        // Only a scope override is refused. The repository this task may read is
        // fixed, and the search must stay bounded (2026-10-26: the guard treated
        // is: and type: as overrides too, so a reasonable pull request search was
        // refused twelve times across seven tasks and the refusal named nothing
        // the model could change).
        if (/\b(?:repo|org|user):/i.test(query)) throw new Error("issues search is already scoped to this task's repository; remove repo:, org: or user: from the query and keep the plain words with in:, is:, state: or sort:, for example: is:pr is:open promote in:title");
        // A search that asks for pull requests decides the type itself;
        // prefixing is:issue for it would ask for both and match nothing.
        const wantsPr = /(?:^|\s)(?:is|type):pr\b/i.test(query);
        const result = await api([`search/issues?q=${encodeURIComponent(`${wantsPr ? "" : "is:issue "}repo:${repo} ${query}`)}&per_page=20`]);
        return { total: result.total_count, incomplete: Boolean(result.incomplete_results), issues: (result.items || []).slice(0, 20).map((r) => ({ number: r.number, title: r.title, state: r.state, url: r.html_url, pullRequest: Boolean(r.pull_request), assignees: (r.assignees || []).map((a) => a.login) })) };
      }
      if (input.action === "ci_failures") {
        // The actual failing output, so a red check is diagnosed, not guessed.
        const pr = await api([`repos/${repo}/pulls/${Number(input.number)}`]);
        const runs = require("./github").redChecks((await api([`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`])).check_runs || [])
          .sort((a, b) => (a.name === "verify") - (b.name === "verify"));
        const out = [];
        for (const r of runs.slice(0, 4)) {
          const annotations = r.output?.annotations_count ? (await api([`repos/${repo}/check-runs/${r.id}/annotations`])).slice(0, 15).map((a) => `${a.path}:${a.start_line} ${a.message}`.slice(0, 400)) : [];
          let log = "";
          const jobId = /\/job\/(\d+)/.exec(r.details_url || "")?.[1];
          if (jobId) { try { log = (await exec("/usr/bin/gh", ["api", `repos/${repo}/actions/jobs/${jobId}/logs`], { timeout: 60000, maxBuffer: 64 << 20 })).replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.replace(/^\S+Z\s/, "")).filter((l) => /FAIL|Error|error TS|✗|×|AssertionError|expected|Expected|failed/i.test(l)).slice(-60).join("\n").slice(-8000); } catch (e) { log = "log unavailable: " + String(e.message).slice(0, 200); }
          }
          // The check's own report (title and summary) often names the failing test even when
          // there are no annotations and no job log (KBX4 2026-11-02: Keir answered "no log").
          const report = [r.output?.title, r.output?.summary].filter(Boolean).join(": ").slice(0, 1500);
          out.push({ name: r.name, conclusion: r.conclusion, url: r.html_url, ...(report ? { report } : {}), annotations, failingLines: log });
        }
        return { number: pr.number, sha: pr.head.sha.slice(0, 10), failed: out, note: out.length ? "Compare these failures with your change. A failure in code you did not touch, that also fails on the base branch, is pre-existing; otherwise fix it." : "No failed checks on the current head." };
      }
      if (input.action === "close") {
        const pr = await api([`repos/${repo}/pulls/${Number(input.number)}`]);
        if (pr.state !== "open") return { number: pr.number, state: pr.state };
        if (pr.merged) return { number: pr.number, state: "merged" };
        // Keir 10.2 (owner, 2026-11-17): closing a superseded bot or agent PR is Keir's own housekeeping. Never a human's PR.
        const verdict = require("./prhousekeeping");
        const author = String(pr.user?.login || "");
        const ownBranch = /^keir\//.test(String(pr.head?.ref || ""));
        if (!ownBranch && !verdict.botAuthor(pr.user, config.agentLogins)) throw new Error(`PR ${pr.number} is by ${author || "a person"}. Keir closes only its own PRs and superseded PRs from bot or agent accounts, never a person's.`);
        const by = Number(input.supersededBy || input.fix || 0);
        let superseding = null;
        if (by) {
          superseding = await api([`repos/${repo}/pulls/${by}`]);
          if (!superseding?.merged) throw new Error(`PR ${by} is not merged, so it does not supersede PR ${pr.number}`);
          const covered = verdict.sameIssue(pr, superseding) || await (async () => {
            for (const b of ["development", "main"]) {
              try { const c = await api([`repos/${repo}/compare/${encodeURIComponent(b)}...${pr.head.sha}`]); if (["behind", "identical"].includes(c.status)) return true; } catch {}
            }
            return false;
          })();
          if (!covered) throw new Error(`PR ${by} does not cover PR ${pr.number}: they link no common issue and PR ${pr.number}'s changes are not contained in development or main. Check the diff, or leave it open.`);
        } else if (!ownBranch) throw new Error("give supersededBy: the merged PR that covers the same fix. Without one, only Keir's own keir/ PRs can be closed.");
        const note = noDashes(redactSecrets(String(input.comment || "").trim() || verdict.closingComment(pr.number, superseding ? by : null))).slice(0, 2000);
        const text = superseding && !new RegExp(`#${by}\\b`).test(note) ? `${note}\n\nSuperseded by #${by}.` : note;
        await commentOnce(job, `close-pr-comment:${pr.number}`, api, `repos/${repo}/issues/${pr.number}`, `<!-- keir:closed-pr:${pr.number} -->`,
          (marker) => apiKeir(["-X", "POST", `repos/${repo}/issues/${pr.number}/comments`, "-f", `body=${text}\n\n${marker}`]));
        await effect(job, `close-pr:${pr.number}`, () => apiKeir(["-X", "PATCH", `repos/${repo}/pulls/${pr.number}`, "-f", "state=closed"]));
        if (ownBranch) { try { await exec("/usr/bin/gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${pr.head.ref}`]); } catch {} }
        ledger.audit("pr_closed_superseded", { job: job.id, pr: pr.number, by: by || null, author });
        return { number: pr.number, closed: true, ...(superseding ? { supersededBy: by } : {}), branchDeleted: ownBranch };
      }
      // Keir 4.2: close the issues a fix PR references (Refs/Fixes #N in its
      // body, or Keir's own issues for the ticket that opened it) once the fix
      // is live for players. Turn code needs turn-worker/production too.
      async function closeFixedIssues(prNumber, only = null) {
        const verified = await verifyLiveFix({ api, number: prNumber, signal });
        if (!verified.live) return { closed: [], live: false };
        if (job.ownerClosureHold || d.jobs[d.seen[`ticket:${job.ticket}`]]?.ownerClosureHold)
          return { closed: [], live: true, closureHeld: true };
        const { pr, files } = verified;
        const turn = files.some((f) => ECONOMY_PATHS.test(f) || blast.WORKER_PATHS.test(f));
        const referenced = [...String(pr.body || "").matchAll(/\b(?:refs?|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+((?:#\d+(?:,\s*)?)+)/gi)].flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1])));
        // Another author's "Refs" can mean partial work: only Keir's own PRs
        // close what they reference; any PR closes Keir's own issues.
        const keirPr = /^keir\//.test(pr.head?.ref || "");
        if (only && !referenced.includes(only)) throw new Error("the fix PR must explicitly reference this issue");
        const targets = [...new Set(only ? [only] : referenced.filter((x) => keirPr || d.keirIssues?.[x]))];
        const closed = [];
        for (const number of targets) {
          const issue = await api([`repos/${repo}/issues/${number}`]).catch(() => null);
          if (!issue || issue.pull_request || issue.state !== "open") continue;
          // A partial fix keeps its issue open (the repo labels those).
          if ((issue.labels || []).some((l) => /status: partial/i.test(l.name || l))) continue;
          // A reopened issue must not reuse a receipt from its prior closure.
          const generation = issue.updated_at || issue.created_at || "initial";
          // Keir 8: the comment and the close are two receipts. The comment is keyed on the issue
          // and the PR only (it used to include updated_at, which the comment itself changes, so a
          // failed close made the retry post a second comment) and carries a hidden marker that is
          // looked for before posting. Only the close keeps the reopen generation.
          await commentOnce(job, `close-issue-comment:${number}:${prNumber}`, api, `repos/${repo}/issues/${number}`, `<!-- keir:closed:${number}:${prNumber} -->`,
            (marker) => apiKeir(["-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${issues.closingComment({ pr: prNumber, sha: pr.merge_commit_sha })}\n\n${marker}`]));
          await effect(job, `close-issue:${number}:${prNumber}:${generation}`, () => apiKeir(["-X", "PATCH", `repos/${repo}/issues/${number}`, "-f", "state=closed", "-f", "state_reason=completed"]));
          if (d.keirIssues?.[number]) { d.keirIssues[number].state = "closed"; d.keirIssues[number].closedAt = now(); d.keirIssues[number].fixedBy = prNumber; }
          ledger.audit("issue_closed_fixed", { job: job.id, issue: number, pr: prNumber, turn });
          closed.push(number);
        }
        ledger.save();
        return { closed, live: true };
      }
      if (input.action === "close_issue") {
        const number = Number(input.number), fix = Number(input.fix);
        if (!number || !fix) throw new Error("give number (the issue) and fix (the merged PR that fixed it)");
        if (desktop) throw new Error("close_issue is for AHDGame issues");
        const pr = await api([`repos/${repo}/pulls/${fix}`]);
        if (!pr.merged) return { closed: false, reason: `#${fix} is not merged` };
        const where = {};
        for (const b of ["main", "turn-worker/production"]) {
          try { const c = await api([`repos/${repo}/compare/${encodeURIComponent(b)}...${pr.merge_commit_sha}`]); where[b] = ["behind", "identical"].includes(c.status); } catch { where[b] = null; }
        }
        const { closed, closureHeld } = await closeFixedIssues(fix, number);
        if (closureHeld) return { closed: false, issue: number, fix, closureHeld: true, reason: "Issue closure is held by the ticket's explicit owner follow-up. Keep the verified live result and wait for the required outcome evidence." };
        return closed.length ? { closed: true, issue: number, fix } : { closed: false, issue: number, fix, where, reason: "the fix is not live for players yet, the issue is already closed, or it is marked partial. Check again with where after the promotion." };
      }
      if (input.action === "deployed") {
        // The commits production actually runs, from the US box, plus site health.
        if (desktop) throw new Error("Desktop fixes ship as client releases; deployed covers the game servers only.");
        const live = await liveDeployment({ api, signal });
        return { ...live, meaning: "web = commit the main server serves; worker = commit the turn worker runs. A fix is live when its merge commit is an ancestor of the running commit (github where on the PR closes its issues once it is, unless an explicit owner verification hold applies). A null sha means unknown: do not claim anything is live." };
      }
      if (input.action === "where") {
        // Where a change actually is. Turn code reaches players only when
        // turn-worker/production moves, which lags main by up to an hour.
        let sha = input.sha;
        if (input.number) { const pr = await api([`repos/${repo}/pulls/${Number(input.number)}`]); if (!pr.merged) return { number: pr.number, merged: false, state: pr.state }; sha = pr.merge_commit_sha; }
        if (!/^[0-9a-f]{7,40}$/i.test(sha || "")) throw new Error("give a merged PR number or a commit sha");
        const branches = desktop ? ["main"] : ["development", "staging", "main", "turn-worker/production"], out = { sha: sha.slice(0, 10) };
        for (const b of branches) {
          try { const c = await api([`repos/${repo}/compare/${encodeURIComponent(b)}...${sha}`]); out[b] = ["behind", "identical"].includes(c.status); } catch { out[b] = null; }
        }
        out.meaning = desktop ? "main means the desktop fix is merged in source, not necessarily released or installed. Verify a client release before claiming it is live." : "main = merged for web; it is live once github deployed shows the main server running a commit that contains it. turn-worker/production = turn processing source; it is live once github deployed shows the turn worker running it. Web-only fixes are live with main; turn fixes are live only once turn-worker/production contains them. staging = the fix is in the sandbox release line, but the sandbox server is rebuilt by hand and can lag staging by days: never wait for it to update, and do not ask anyone to start it. Once main contains a fix and github deployed shows it running, the sandbox step is done; verify on the main server instead.";
        // Release claims in ticket copy are checked against these receipts.
        // Review 3 F1: owned means this repository and this number, held by the job (not the same number in another repo).
        const ownPr = input.number && require("./livecoverage").jobOwnsPr(d, job, repo, input.number);
        // Review 4 m4: a later lookup of the same commit merges into the receipt; it never drops its PR or turns an owned
        // receipt into a lookup.
        const prior = (job.releaseEvidence ||= {})[out.sha] || {};
        const owned = ownPr || (Number(prior.pr) > 0 && prior.source !== "lookup");
        const receipt = { ...prior, at: now(), development: out.development === true, staging: out.staging === true, main: !desktop && out.main === true, repository: repo, turnWorker: out["turn-worker/production"] === true, ...(input.number ? { pr: Number(input.number) } : {}), source: owned ? prior.source : "lookup" };
        if (!receipt.source) delete receipt.source;
        job.releaseEvidence[out.sha] = receipt;
        ledger.save();
        if (!desktop && input.number && out.main === true && !musePolicy.origin(d, job).scoped) {
          const { closed, live, closureHeld } = await closeFixedIssues(Number(input.number));
          out.fixLive = live;
          if (docReview && ownFindingPr(input.number)) {
            if (live) job.reviewFixLive = { number: Number(input.number), at: now() };
            else if (job.reviewFixLive?.number === Number(input.number)) delete job.reviewFixLive;
            ledger.save();
          }
          if (closureHeld) out.issueClosureHeld = true;
          if (closed.length) out.issuesClosed = closed;
        }
        return out;
      }
      async function gate(pr) { return (await inspectChecks(pr)).result; }
      async function inspectChecks(pr) {
        const runs = (await api([`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`])).check_runs || [];
        const pending = runs.filter((r) => r.status !== "completed").map((r) => r.name);
        const failed = require("./github").redChecks(runs).map((r) => `${r.name}: ${r.conclusion}`);
        if (docReview && input.action === "merge" && !desktop) {
          const required = require("./codingworkers").exactGreen(runs);
          for (const check of required.pending) if (!pending.includes(check)) pending.push(check);
          for (const check of required.failed) if (!failed.some((f) => f.startsWith(`${check}:`))) failed.push(`${check}: ${required.detail[check]}`);
        }
        const qualification = failed.length ? { qualified: false } : await require("./qualification").promotionQualification({ api, pr, runs, repository: repo });
        return { runs, result: { checks: runs.length, pending, failed, mergeable: pr.mergeable, mergeableState: pr.mergeable_state,
          ...(qualification.qualified ? { qualification } : {}),
          ready: runs.length > 0 && (!pending.length || qualification.qualified) && !failed.length && pr.mergeable === true } };
      }
      // Keir 11.2 (audit P1-1, H5): a merge Keir was asked to carry out and GitHub refuses (red check, conflict, missing
      // section) used to end as a silent "probe" dismissal. The owner now gets one plain line per PR, head and reason. When
      // the only blocker is Keir's own PR description, Keir repairs it instead.
      async function mergeDeadEnd(pr, g) {
        try {
          const n = Number(pr.number), head = pr.head?.sha || "";
          const approved = Object.values(d.actions).some((a) => a.kind === "github" && a.args?.action === "merge" && Number(a.args.number) === n && ["approved", "executing"].includes(a.state));
          if (!(job.ownerWaitPr || job.adoptedPr || approved) || repo !== GAME_REPO || input.action !== "merge") return;
          if (!g.failed.length && g.mergeable !== false) return; // still running: not a dead end yet
          const names = g.failed.map((f) => String(f).split(":")[0]);
          const keirPrs = require("./keirprs");
          const why = keirPrs.plainReason(names, g.mergeable);
          // Fourth pass (review N7, m6): a switch (KEIR_MERGE_DEAD_END), preview, and the repair only as Keir's own account.
          const dg = ctl().gate("mergeDeadEnd");
          if (!dg.run) return;
          if (why.key === "custom-rules" && !require("./prdisclosure").hasDisclosure(pr.body)) {
            if (keirPrs.isKeirPr(pr, d) && dg.act && config.githubReviewerToken) {
              await effect(job, `disclosure:${n}:${head}`, async () => JSON.parse(await exec("/usr/bin/gh", ["api", "-X", "PATCH", `repos/${repo}/pulls/${n}`, "-f", `body=${withDisclosure(pr.body)}`], asKeir({ timeout: 60000 })) || "null"), { kind: "github", text: `describe PR ${n}` });
              ledger.audit("keir_pr_description_repaired", { job: job.id, pr: n, head });
              return;
            }
            why.text = keirPrs.isKeirPr(pr, d) ? "its description is missing the Conflict of interest section, and Keir has no token of its own to add it" : "its description is missing the Conflict of interest section, which its author has to add";
          }
          if (!dg.act) { controlsLib.preview(d, "merge-dead-end", "owner line", `#${n}`, `ready but blocked: ${why.text}`, {}, now()); return; }
          ledger.notify(`pr-blocked:${n}:${why.key}:${head}`, "owner", `PR #${n} (${String(pr.title || "").slice(0, 100)}) is ready to merge but blocked: ${why.text}. Nothing was merged.`);
          ledger.audit("merge_dead_end_reported", { job: job.id, pr: n, head, reason: why.key });
        } catch (e) { ledger.audit("merge_dead_end_report_failed", { job: job.id, pr: Number(pr.number), reason: String(e.message).slice(0, 200) }); }
      }
      async function mergeWhenGreen(number, method, expectBase) {
        let pr = await api([`repos/${repo}/pulls/${number}`]);
        if (pr.merged) return { number, merged: true, already: true, sha: pr.merge_commit_sha };
        if (pr.state !== "open") throw new Error(`PR ${number} is ${pr.state}`);
        if (expectBase && pr.base.ref !== expectBase) throw new Error(`PR ${number} targets ${pr.base.ref}, expected ${expectBase}`);
        if (pr.mergeable === null) { await new Promise((r) => setTimeout(r, 3000)); pr = await api([`repos/${repo}/pulls/${number}`]); }
        if (findingMergeApproval && findingMergeApproval.args.head !== pr.head.sha) throw new Error("The PR changed after approval. Review the current head before merging.");
        if (findingShip && !askForAuthority) {
          const files = await prFiles(number, true);
          let approvedDoc = null;
          let displayAllowed;
          if (input.action === "promote") {
            const commits = await api([`repos/${repo}/pulls/${number}/commits?per_page=100`]);
            approvedDoc = await checkFindingCommits(commits, 99);
            if (approvedDoc) {
              const diff = diffContents(files);
              displayAllowed = Boolean(diff && diff === diffContents(await prFiles(approvedDoc, true)));
            }
          }
          const latest = await api([`repos/${repo}/pulls/${number}`]);
          if (!(approvedDoc ? displayAllowed : blast.displayOnlyDiff(files).allowed) || latest.head?.sha !== pr.head.sha || latest.base?.sha !== pr.base.sha) throw new Error("Finding diff changed or is not in the approved display scope; inspect the current PR before shipping");
        }
        if (scopedConsent) {
          musePolicy.validate(d, config, job, scopedConsent, now(), true);
          if (pr.head.sha !== scopedConsent.args.head || pr.base.sha !== scopedConsent.args.base || pr.base.ref !== scopedConsent.args.to) throw new Error("The PR changed since approval. Review its current source and target commits.");
        }
        // Owner, 2026-11-05: "We literally have approval buttons built in." AHDGame's custom-rules
        // needs a maintainer's GitHub review on the exact head. When the owner pressed Approve on this
        // merge at this head, submit that review as him (the box's gh identity is the owner) and re-run
        // the check, instead of sending him to GitHub. Ariane answering on his behalf does not count.
        if (ownerConsent && !desktop && Number(ownerConsent.args.number) === number && ownerConsent.args.head === pr.head.sha) {
          const reviews = await api([`repos/${repo}/pulls/${number}/reviews?per_page=100`]).catch(() => []);
          const me = (await api(["user"]).catch(() => null))?.login;
          // GitHub forbids approving your own PR. The exact local owner approval
          // still binds this action; let the unchanged GitHub gates decide readiness.
          if (me && me.toLowerCase() !== String(pr.user?.login || "").toLowerCase() && !(reviews || []).some((r) => r.user?.login === me && r.state === "APPROVED" && r.commit_id === pr.head.sha)) {
            await effect(job, `owner-review:${number}:${pr.head.sha}`, () => api(["-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "-f", `commit_id=${pr.head.sha}`, "-f", "event=APPROVE", "-f", "body=Approved by the owner from Keir's approval button."]), { kind: "github", text: `approve PR ${number}` });
            const runs = (await api([`repos/${repo}/commits/${pr.head.sha}/check-runs?check_name=custom-rules&per_page=20`]).catch(() => null))?.check_runs || [];
            const red = runs.filter((r) => r.status === "completed" && r.conclusion !== "success").sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
            if (red) await api(["-X", "POST", `repos/${repo}/actions/jobs/${red.id}/rerun`]).catch(() => null);
            ledger.audit("owner_review_submitted", { job: job.id, pr: number, head: pr.head.sha, action: ownerConsent.id, rerun: Boolean(red) });
            return { number, merged: false, url: pr.html_url, ownerReviewSubmitted: true, nextMove: "The owner's approval is now on the PR and custom-rules is re-running. Finish waiting with wakeAfterMinutes 10, then call merge again under the same approval." };
          }
        }
        const g = await gate(pr);
        if (!g.ready) await mergeDeadEnd(pr, g);
        if (!g.ready) return { number, merged: false, url: pr.html_url, ...g, nextMove: g.failed.length || g.mergeable === false ? "Red or conflicted: investigate and fix, do not merge." : g.pending.length ? "Checks still running: finish waiting with a wakeup of about 10 minutes and call this again." : g.checks ? "Every check finished green, but GitHub has not reported this PR as mergeable yet. Finish waiting about 5 minutes and call merge again; do not tell the owner checks are running." : "No checks have reported on this head yet: finish waiting about 10 minutes and call this again." };
        const mergeOnce = () => api(["-X", "PUT", `repos/${repo}/pulls/${number}/merge`, "-f", `merge_method=${method}`, "-f", `sha=${pr.head.sha}`]);
        // 405/409/422 are GitHub refusing the merge: nothing merged. "Base branch
        // was modified" is a race with another merge landing first (ticket 1619
        // asked the owner to inspect one); re-read and retry once on the same head.
        const refused = (e) => /\(HTTP (?:405|409|422)\)/.test(String(e?.message || ""));
        const result = await effect(job, `merge:${number}:${pr.head.sha}`, async () => {
          try { return await mergeOnce(); } catch (first) {
            if (!refused(first)) throw first;
            let last = first;
            await new Promise((r) => setTimeout(r, config.mergeRetryMs ?? 5000));
            const latest = await api([`repos/${repo}/pulls/${number}`]);
            if (latest?.merged && latest.head?.sha === pr.head.sha) return { merged: true, sha: latest.merge_commit_sha };
            if (latest?.state === "open" && latest.head?.sha === pr.head.sha && /base branch was modified/i.test(first.message)) {
              try { return await mergeOnce(); } catch (second) { if (!refused(second)) throw second; last = second; }
            }
            const error = new Error(`GitHub refused the merge and nothing merged (${redactSecrets(String(last.message)).slice(0, 200)}). Re-read the PR; once it is green and mergeable at the same head, call merge again under the same approval. This needs no owner inspection.`);
            error.code = "GITHUB_MERGE_REFUSED";
            await mergeDeadEnd(latest || pr, { failed: [`merge: ${String(last.message).slice(0, 80)}`], mergeable: latest?.mergeable ?? pr.mergeable });
            throw error;
          }
        });
        if (scopedConsent && result?.merged) { scopedConsent.state = "done"; scopedConsent.completedAt = now(); ledger.save(); }
        if (method === "squash" && !scopedOwner) { try { await exec("/usr/bin/gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${pr.head.ref}`]); } catch {} }
        // Keir told the owner each promotion of an approved economy fix "needs its
        // own approval" (ticket 1619). Chain consent (5.1) carries it; say so here.
        const next = result?.merged && method === "squash" && expectBase === "development"
          ? { nextMove: "Merged to development. Promote it with github promote to staging, then main. A promotion carrying only changes the owner already approved rides those approvals and asks nothing; never tell the owner each promotion needs its own approval." } : {};
        return { number, merged: Boolean(result?.merged), sha: result?.sha, url: pr.html_url, ...next };
      }
      if (input.action === "status") {
        const pr = await api([`repos/${repo}/pulls/${Number(input.number)}`]);
        return { number: pr.number, title: pr.title, state: pr.merged ? "merged" : pr.state, base: pr.base.ref, head: pr.head.ref, url: pr.html_url, ...(pr.state === "open" ? await gate(pr) : {}) };
      }
      if (input.action === "merge") { ownerGuard(); return mergeWhenGreen(Number(input.number), "squash", desktop ? "main" : "development"); }
      if (input.action === "promote") {
        if (desktop) throw new Error("Desktop fixes use main and client releases, not the game promotion pipeline.");
        const to = input.to, from = { staging: "development", main: "staging" }[to];
        if (to === "main" && prodHold()) throw new Error(HOLD_NOTE);
        if (!from) throw new Error("promote to staging or main");
        const ahead = await api([`repos/${repo}/compare/${to}...${from}`]);
        if (!ahead.ahead_by) return { promoted: false, reason: `${from} has nothing new for ${to}` };
        ownerGuard();
        // Keir 8.4: at most N promotions to production per rolling day (default 3), idempotent per source head.
        if (to === "main" && limits) {
          const key = `promote-main:${ahead.merge_base_commit?.sha || from}`, cap = trustLimits.checkCounter(d, "deploy", key, now(), limits.get());
          if (!cap.ok) { ledger.audit("deploy_cap", { job: job.id, count: cap.count, limit: cap.limit }); ledger.save(); throw Object.assign(new Error(cap.reason), { code: "DEPLOY_CAP" }); }
          trustLimits.recordCounter(d, "deploy", key, now()); ledger.save();
        }
        let pr = (await api([`repos/${repo}/pulls?state=open&base=${to}&head=${GITHUB_OWNER}:${from}`]))[0];
        if (!pr) pr = await effect(job, `promote-pr:${from}:${to}:${ahead.merge_base_commit?.sha}`, () => apiKeir(["-X", "POST", `repos/${repo}/pulls`, "-f", `title=chore: promote ${from} to ${to}`, "-f", `head=${from}`, "-f", `base=${to}`, "-f", `body=Promotion requested by the owner via Keir. ${ahead.ahead_by} commits.\n\n${(ahead.commits || []).slice(-30).map((c) => "- " + c.commit.message.split("\n")[0]).join("\n")}${NO_CONFLICT_DISCLOSURE}`]));
        const result = await mergeWhenGreen(pr.number, "merge", to);
        return { ...result, from, to, commits: ahead.ahead_by, nextMove: result.merged ? (to === "staging" ? "Promote to main once staging looks right." : "Check with github deployed that the main server (and the turn worker for turn code) runs the new commit, then tell the requester.") : result.nextMove };
      }
      throw new Error("action must be status, merge or promote");
    }
    // Owner, 2026-10-19 (incident 1628): "Add enigma here" got "I can't add
    // people to this channel myself". A developer can now have Keir add a
    // player to a ticket or incident channel by name.
    if (name === "add_to_ticket") {
      const staffAsk = [config.ownerId, ...config.staffIds].includes(job.actorId) && job.source?.authorId === job.actorId && job.role !== "player";
      if (!developerTask(job) && !(job.kind === "conversation" && staffAsk) && ticketCommands.refusal(job)) throw new Error("only the owner or a developer can have someone added to a ticket channel");
      const ticketNo = Number(input.ticket) || ticketOf(job) || ticketNumberOf(d.jobs[job.id]?.source?.channelName);
      if (!ticketNo) throw new Error("name the ticket number to add them to");
      const channelId = (job.channelId && snowflake(job.channelId) && ticketNumberOf((await discord("GET", `/channels/${job.channelId}`))?.name) === ticketNo) ? job.channelId
        : d.jobs[d.seen[`ticket:${ticketNo}`]]?.channelId;
      const ch = channelId && await discord("GET", `/channels/${channelId}`);
      if (!ch || ch.guild_id !== config.guildId || ticketNumberOf(ch.name) !== ticketNo) throw new Error(`no open channel found for ticket ${ticketNo}`);
      const raw = String(input.user || "").trim();
      const id = /^<@!?(\d{17,20})>$/.exec(raw)?.[1] || (/^\d{17,20}$/.test(raw) ? raw : null);
      let member;
      if (id) member = await discord("GET", `/guilds/${config.guildId}/members/${id}`);
      else {
        const q = raw.replace(/^@/, "");
        if (q.length < 2) throw new Error("give the player's Discord name");
        const found = await discord("GET", `/guilds/${config.guildId}/members/search?query=${encodeURIComponent(q)}&limit=10`) || [];
        const names = (m) => [m.user?.username, m.user?.global_name, m.nick].filter(Boolean).map((x) => x.toLowerCase());
        const exact = found.filter((m) => names(m).includes(q.toLowerCase()));
        const pick = exact.length === 1 ? exact : found.length === 1 ? found : exact.length ? exact : found;
        if (pick.length !== 1) throw new Error(pick.length ? `several members match "${q}": ${pick.slice(0, 6).map((m) => `${m.user.username}${m.user.global_name ? ` (${m.user.global_name})` : ""}`).join(", ")}. Ask which one.` : `no server member matches "${q}"`);
        member = pick[0];
      }
      const uid = member?.user?.id; if (!uid) throw new Error("that member could not be found");
      if (member.user.bot) throw new Error("bots are not added to tickets");
      const allow = String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 15n));
      await effect(job, `add-to-ticket:${ticketNo}:${uid}`, async () => {
        await discord("PUT", `/channels/${channelId}/permissions/${uid}`, { type: 1, allow, deny: "0" });
        return discord("POST", `/channels/${channelId}/messages`, { content: `<@${uid}> has been added to this ticket.`, allowed_mentions: { users: [uid] } });
      });
      ledger.audit("added_to_ticket", { job: job.id, ticket: ticketNo, user: uid, by: job.actorId }); ledger.save();
      return { added: member.user.username, ticket: ticketNo };
    }
    if (name === "open_channel") {
      if (!developerTask(job) || !job.replyChannel) throw new Error("only a developer's channel task can open a channel to players");
      const minutes = Math.max(5, Math.min(240, Number(input.minutes) || 30));
      if (input.minutes === 0) { delete d.summonedChannels[job.replyChannel]; ledger.save(); return { closed: true }; }
      d.summonedChannels[job.replyChannel] = { actorId: job.actorId, at: now(), until: now() + minutes * 60000 };
      ledger.audit("open_channel", { job: job.id, channel: job.replyChannel, minutes }); ledger.save();
      return { open: true, minutes, instruction: "Players addressing you in this channel get replies until then." };
    }
    if (name === "present_evidence") {
      // Keir 11.1: a chart built only from a game read this ticket received, attached under Keir's answer,
      // plus a dated report or 24 h tracker page for dense data. The model names an observation, nothing else.
      // Private pages are pinned to the ticket's original reporter from the support service's own ticket row.
      return require("./evidencepages").present({ ledger, config, job, input: input || {}, now: now(),
        readTicket: (number) => mcp.call("support", "support_get", { kind: "ticket", number }, false, signal) });
    }
    if (name === "chart") {
      // An AHD house-style chart, posted where the conversation is happening.
      if (job.role === "player") throw new Error("charts are for developer and support work");
      const { caption, ...spec } = input || {};
      const rendered = await charts.render(spec);
      const dir = path.join(config.stateDir, "artifacts"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `chart-${job.id}-${hash(spec).slice(0, 12)}.png`);
      fs.writeFileSync(file, rendered.png, { mode: 0o600 });
      const text = caption ? publicText(caption) : rendered.title;
      const destination = job.replyChannel ? `channel:${job.id}` : job.actorId === config.ownerId ? "owner" : job.actorId;
      const key = `chart:${job.id}:${hash(spec).slice(0, 16)}`;
      ledger.notify(key, destination, text.slice(0, 1800));
      if (d.outbox[key]) { d.outbox[key].files = [{ path: file, name: "ahd-chart.png", chart: true }]; d.outbox[key].chart = true; }
      if (job.replyChannel) job.channelReplyQueued = true;
      ledger.save();
      return { posted: true, description: rendered.description, rows: rendered.rows };
    }
    if (name === "status_card") {
      if (require("./advicerouting").requiresRedirect(job, d)) throw new Error(`Advice requests need a short redirect to Ask, not an investigation card: ${require("./advicerouting").REPLY}`);
      const ticketNo = ticketOf(job);
      if (!ticketNo) throw new Error("status cards are for ticket tasks; use progress_update elsewhere");
      // A mechanics question gets an answer, not a fix-progress card ("Cause
      // found, fix being written" on a question misleads; ticket 1540). Only a
      // mechanics ticket that turned out to be a bug report may carry one.
      // A mechanics ticket with a fix in flight (a pull request) is a bug too.
      if (d.channels?.[job.channelId]?.category === "mechanics" && job.tags?.kind !== "bug_report" && !(job.pullRequests || []).length && !developerTask(job))
        throw new Error("Not posted: this is a mechanics question, so it gets a direct answer in the channel, not a fix-progress card. If you found a real bug, say so in your answer and work it as a bug.");
      await supportAuthority(job, ["running"]);
      const items = cardItemsAllowed(ticketNo, input.items);
      const status = String(input.status || "").trim().slice(0, 500);
      if (status && TECHNICAL.test(status)) throw new Error("Not posted: the status line is player-facing; no PRs, CI, branches or code.");
      if (status) guardPlayerRegister(job, ticketNo, status);
      for (const text of [status, ...items.map((i) => i.note), ...items.map((i) => i.name)]) {
        if (!text) continue;
        const jg = JARGON.exec(text);
        if (jg) throw new Error(`Not posted: "${jg[0]}" on the progress card is internal or engine jargon. Card names and notes use the words the game shows the player.`);
        guardNumbers(job, text); secondLook(job, ticketNo, text);
        const ev = ticketEvidence(ticketNo);
        const claim = outcomeClaims(text).find((c) => c.kind === "money" ? !(c.future ? ev.money.agreed : ev.money.done) : !c.future && !ev[c.kind].done);
        if (claim) throw new Error(`Not posted: "${claim.sentence}" states an outcome Keir has no receipt for. ${NEED[claim.kind]}`);
      }
      if (items.some((i) => i.stage === "answered")) await teamCoverGate(job, ticketNo, "answered, no fix needed", {}, "no_fix");
      const r = await upsertCard(job, ticketNo, { items, status });
      job.lastPublishedAt = now(); ledger.save();
      return { [r.posted ? "posted" : "updated"]: true, bumped: r.bumped, fixes: items.length };
    }
    if (name === "progress_update") {
      if (!job.replyChannel) return { skipped: "no channel for this task; just do the work" };
      const message = publicText(input.message);
      require("./advicerouting").guard(job, d, message);
      if ((job.ticket || ticketNumberOf(job.source?.channelName)) && TECHNICAL.test(message)) throw new Error("This status line is in a player's ticket: keep it plain, no PRs, CI, merges or code.");
      const statusTicket = ticketOf(job);
      if (statusTicket || job.role === "player") guardPlayerRegister(job, statusTicket, message);
      if (statusTicket) {
        const ev = ticketEvidence(statusTicket);
        const claim = outcomeClaims(message).find((c) => c.kind === "money" ? !(c.future ? ev.money.agreed : ev.money.done) : !c.future && !ev[c.kind].done);
        if (claim) throw new Error(`Not posted: "${claim.sentence}" states an outcome Keir has no receipt for. ${NEED[claim.kind]}`);
      }
      if (appChannel && isAppJob(job)) {
        // The app thread shows this line under the answer being revised.
        appChannel.updateStatus(job, message);
        if (!job.progressMessageId) job.progressMessageId = `app-status-${job.id}`;
        job.needsAck = false; job.progressAt = now(); ledger.save(); return { updated: true };
      }
      if (!job.progressMessageId) {
        // First use is the acknowledgement: it becomes the single status message.
        if (d.outbox[`ack:${job.id}`]) return { queued: true };
        if (statusTicket) await ensureDisclosure(statusTicket);
        ledger.notify(`ack:${job.id}`, `channel:${job.id}`, message.slice(0, 1900)); job.needsAck = false; job.progressAt = now(); ledger.save();
        return { posted: true };
      }
      await discord("PATCH", `/channels/${job.replyChannel}/messages/${job.progressMessageId}`, { content: message.slice(0, 1900), allowed_mentions: { parse: [] } });
      job.progressAt = now(); ledger.save(); return { updated: true };
    }
    if (name === "discord_search") {
      if (!developerTask(job)) throw new Error("channel history search is for developer-directed tasks");
      const watched = (await discord("GET", `/guilds/${config.guildId}/channels`)).filter((c) => config.watched(c)).map((c) => ({ id: c.id, name: c.name, lastMessageId: c.last_message_id }));
      if (!input.channelId) return { channels: watched.filter((c) => c.lastMessageId).map(({ id, name }) => ({ id, name })), instruction: "Call again per channel with channelId and hours. Page older with before. Skip channels whose names show no player traffic." };
      if (!watched.some((c) => c.id === input.channelId)) throw new Error("channelId must be a public guild channel (not a ticket)");
      const cutoff = now() - Math.min(720, Math.max(1, Number(input.hours) || 24)) * 3600000;
      const q = input.query ? String(input.query).toLowerCase() : null;
      let before = input.before, rows = [], exhausted = false;
      for (let page = 0; page < (input.query ? 25 : 5) && !exhausted; page++) {
        const batch = await discord("GET", `/channels/${input.channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
        if (!batch.length) { exhausted = true; break; }
        for (const m of batch) { if (Date.parse(m.timestamp) < cutoff) { exhausted = true; break; } rows.push(m); }
        before = batch.at(-1).id;
      }
      const out = rows.filter((m) => !m.author?.bot && !m.webhook_id && (!q || (m.content || "").toLowerCase().includes(q)))
        .map((m) => ({ id: m.id, author: m.author.global_name || m.author.username, authorId: m.author.id, at: m.timestamp, replyTo: m.message_reference?.message_id,
          content: (m.content || "").slice(0, 400), images: (m.attachments || []).filter((a) => /^image\//.test(a.content_type || "")).length }));
      return { channelId: input.channelId, count: out.length, messages: out.reverse(), nextBefore: exhausted ? null : before };
    }
    if (name === "source_history") {
      if (appChannel && isAppJob(job)) return appChannel.history(20, job.appThread || "main");
      if (!config.watched({ id: job.source.channelId, name: job.source.channelName, type: 0 }) && job.replyChannel !== job.source.channelId) throw new Error("source channel is outside the public watch list");
      const rows = await discord("GET", `/channels/${job.source.channelId}/messages?around=${job.source.messageId}&limit=20`);
      return rows.map((m) => ({ id: m.id, author: m.author.username, authorId: m.author.id, bot: Boolean(m.author.bot), content: m.content, attachments: m.attachments, at: m.timestamp }));
    }
    if (name === "view_attachment") {
      if (isAppJob(require("./appcontrols").rootOf(d, job))) {
        if (!appChannel?.uploads) throw new Error("Private uploads unavailable");
        return appChannel.uploads.inspect(job, input.index, input.page ?? null);
      }
      // Screenshots uploaded with the ticket form live on the ticket record,
      // not on a Discord message. A ticket task whose source is a chat message
      // used to reach only that message, so Keir told 1621 it could not open
      // screenshots that were attached to the report.
      const reportImage = async () => {
        const report = await tool(job, "read_tool", {server:"support",tool:"support_get",args:{kind:"ticket",number:job.ticket}}, signal);
        return report._images?.[Number(input.index)] || null;
      };
      if (!snowflake(job.source.messageId) && job.ticket) {
        const image = await reportImage();
        if (!image) throw new Error("No viewable image on this assigned ticket; continue investigating its report and metadata.");
        return {image};
      }
      // Keir 8.4.2: an image posted earlier in this channel (context.recentImages) can be opened by its message id.
      const earlier = input.messageId && input.messageId !== job.source.messageId;
      if (earlier && !(conversation?.recentImages?.(job) || []).some((i) => i.messageId === input.messageId && i.index === Number(input.index))) throw new Error("messageId is not one of context.recentImages");
      const original = await discord("GET", `/channels/${job.source.channelId}/messages/${earlier ? input.messageId : job.source.messageId}`).catch(error => {
        if (!/\b404\b/.test(String(error.message))) throw error;
        job.unavailableScreenshotTurn = job.startedAt;
        throw new Error("The original Discord screenshot is unavailable. If the person is challenging an earlier claim about what they can see, say what you meant and withdraw any unverified claim. Ask for the missing evidence only if it would change your answer.");
      });
      const a = original.attachments?.[Number(input.index)];
      if (!a && job.ticket) {
        const image = await reportImage();
        if (image) return {image, from: "ticket report"};
      }
      if (!a || !/^image\/(png|jpeg|webp|gif)$/.test(a.content_type || "") || a.size > 4 * 1024 * 1024) throw new Error("no supported bounded source image");
      const url = new URL(a.url);
      if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) throw new Error("attachment host is untrusted");
      const r = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!r.ok || !/^image\/(png|jpeg|webp|gif)$/.test(r.headers.get("content-type") || "")) throw new Error("image download failed");
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length > 4 * 1024 * 1024) throw new Error("image is oversized");
      delete job.unavailableScreenshotTurn;
      (job.viewedImages ||= []).includes(original.id) || job.viewedImages.push(original.id);
      return { image: { type: "base64", media_type: a.content_type, data: bytes.toString("base64") } };
    }
    if (name === "open_suggestion") {
      try { return await require("./suggestionintake").openSuggestion({ ledger, config, mcp, discord, effect, supportAuthority, job, input, signal }); }
      catch (error) {
        if (job.kind === "ticket" && !/authority is inactive|staff owns|existing support owner|coordinator owns/.test(error.message)) {
          require("./supportblockers").report(ledger, job.ticket, error.message, now());
          throw new Error(`${error.message}. This support failure was flagged privately to the owner. Repair the cause or raise an internal repair task; do not repeat the failure to the player.`);
        }
        throw error;
      }
    }
    // Proactive support (owner, 2026-10-19): a confirmed finding that hit a
    // specific player opens a normal bug ticket for them, so no player is the
    // first to notice and they can reply. The Discord account is resolved here
    // from the game records and never shown to the model. Bounded per finding
    // and per day; one ticket per player per finding.
    if (name === "open_affected_ticket") {
      if (job.kind !== "finding") throw new Error("Only a confirmed finding task opens a ticket for an affected player.");
      if (!(job.raisedToDevelopers || []).length) throw new Error("Raise the finding to the developers first (raise_to_developers), so the ticket can say where the fix stands.");
      const seq = Number(input.character);
      if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error("character: the affected character's id (sequentialId) from the records you read.");
      const title = publicText(input.title || "").slice(0, 200), description = publicText(input.description || "").slice(0, 1500);
      if (title.length < 8 || description.length < 40) throw new Error("Give a short title and a plain description: what went wrong for this player, what you found in their records, and where the fix stands.");
      if (TECHNICAL.test(`${title} ${description}`)) throw new Error("Ticket text is for the player: no PR or issue numbers, links, CI, branches, commits or code.");
      guardPlayerRegister(job, null, description);
      const p = (d.proactive ||= { opened: {}, days: {} }), day = new Date(now()).toISOString().slice(0, 10), key = `${job.finding || job.id}:${seq}`;
      if (p.opened[key]) return { opened: false, already: true, ticket: p.opened[key].ticket, instruction: "This player already has a ticket for this finding." };
      const perFinding = Object.keys(p.opened).filter((k) => k.startsWith(`${job.finding || job.id}:`)).length;
      if (perFinding >= (config.proactivePerFinding || 10)) throw new Error("This finding already opened its limit of player tickets; propose an incident to staff for the rest.");
      if ((p.days[day] || 0) >= (config.proactivePerDay || 20)) throw new Error("Today's limit of proactive tickets is reached; propose an incident to staff instead.");
      const rows = (r) => r?.docs || r?.items || r?.results || [];
      const character = rows(await mcp.call("heal-ops", "heal_query", { env: "prod", collection: "characters", filter: { sequentialId: seq }, projection: { userId: 1 }, limit: 1 }, false, signal))[0];
      if (!character?.userId) throw new Error(`No character ${seq} in the game records.`);
      const user = rows(await mcp.call("heal-ops", "heal_query", { env: "prod", collection: "users", filter: { $expr: { $eq: [{ $toString: "$_id" }, String(character.userId)] } }, projection: { discordId: 1 }, limit: 1 }, false, signal))[0];
      if (!snowflake(user?.discordId)) throw new Error("This player has no linked Discord account; leave them to the incident or announcement.");
      const result = await effect(job, `proactive-ticket:${key}`, () => mcp.call("support", "support_create_ticket", { discord_user_id: user.discordId, category: "bug", title,
        description: `${description}\n\nKeir opened this ticket because our monitoring found the problem on your account. You do not need to do anything unless you want to reply.` }, true, signal));
      const number = result?.ticketNumber || result?.number || result?.ticket?.number;
      if (!number) throw new Error("ticket API did not return a number; inspect receipt");
      p.opened[key] = { ticket: number, at: now(), finding: job.finding || null }; p.days[day] = (p.days[day] || 0) + 1;
      ledger.audit("proactive_ticket", { job: job.id, finding: job.finding || null, ticket: number }); ledger.save();
      return { opened: true, ticket: number, instruction: "The ticket is open; its own ticket task follows up with the player. Do not post in it from this finding." };
    }
    if (name === "open_ticket") {
      if (isAppJob(job)) return require("./ownerintake").openOwnerTicket({ ledger, config, mcp, effect, job, input, signal, now });
      const commanded = job.kind === "command" && ["owner", "support"].includes(job.role);
      // Staff asking for an incident from inside a ticket is the normal way an
      // outage is noticed; the ticket stays, the incident is new (ticket 1590).
      const incidentAsk = commanded && input.category === "incident";
      if ((!commanded && job.kind !== "candidate") || (job.ticket && !incidentAsk)) throw new Error("use this ticket's existing investigation; new intake needs an automatic report or an authenticated ticket request");
      if (config.supportDeferred()) throw new Error("another coordinator owns support intake; retain the request and retry later");
      let reportId = job.source.messageId, requestMessageId, reportChannelId = job.source.channelId, reportChannelName = job.source.channelName;
      const swept = commanded && developerTask(job) && input.channelId && input.reportMessageId;
      if (swept) {
        // A developer asked for a sweep or named a report elsewhere: re-fetch their
        // own instruction for provenance, then the report from its real channel.
        const actual = await discord("GET", `/channels/${job.source.channelId}/messages/${job.source.messageId}`);
        if (actual.webhook_id || actual.author?.id !== job.actorId) throw new Error("ticket requester provenance changed or request was revoked");
        const channel = await discord("GET", `/channels/${input.channelId}`);
        if (channel.guild_id !== config.guildId || /^ticket-/.test(channel.name || "")) throw new Error("report channel must be a public channel in the game guild");
        requestMessageId = job.source.messageId; reportId = input.reportMessageId; reportChannelId = channel.id; reportChannelName = channel.name;
      } else if (commanded) {
        const expectedRole = job.actorId === config.ownerId ? "owner" : config.staffIds.includes(job.actorId) ? "support" : null;
        if (expectedRole !== job.role || !job.replyChannel || job.replyChannel !== job.source.channelId) throw new Error("ticket requester authority is unconfirmed");
        const requests = [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter((s) => s.authorId === job.actorId && s.channelId === job.source.channelId && ticketRequested(s.content));
        const request = requests.at(-1); requestMessageId = request?.messageId;
        if (!request || !snowflake(request.messageId)) throw new Error("no authenticated request to open a ticket");
        const actual = await discord("GET", `/channels/${request.channelId}/messages/${request.messageId}`);
        const meta = actual.interaction_metadata || actual.interaction || {};
        const slash = actual.author?.id === config.botId && meta.user?.id === job.actorId &&
          parseCommandFooter(actual.embeds?.[0]?.footer?.text) === "start" && (meta.type === 2 || /^summon\b/.test(meta.name || actual.interaction?.name || ""));
        if (actual.webhook_id || (!slash && (actual.author?.bot || actual.author?.id !== job.actorId)) ||
            !ticketRequested(slash ? actual.embeds[0].description : actual.content)) throw new Error("ticket requester provenance changed or request was revoked");
        const channel = await discord("GET", `/channels/${job.source.channelId}`);
        if (channel.guild_id !== config.guildId) throw new Error("ticket report channel is outside the configured guild");
        reportId = input.reportMessageId || job.source.replyTo || request.messageId;
      } else if (input.reportMessageId && input.reportMessageId !== reportId) throw new Error("automatic intake cannot change its reporter");
      if (!snowflake(reportId)) throw new Error("select an actual source-channel report message");
      const original = await discord("GET", `/channels/${reportChannelId}/messages/${reportId}`);
      if (original.id !== reportId || original.webhook_id || !original.author || original.author.bot || !snowflake(original.author.id) || (!commanded && original.author.id !== job.source.authorId)) throw new Error("reporter provenance changed");
      if (!commanded && !problemReport(original.content) && !original.attachments?.some((a) => /^image\//.test(a.content_type || ""))) throw new Error("no concrete problem phrase or screenshot in source; dismiss or ask owner to review");
      if (incidentAsk) {
        // An incident is a staff catch-all: no reporter channel to reuse, no
        // per-player intake. Repeat tickets join it with merge_into_incident.
        const incidentMarker = requestMessageId ? `Request message: ${requestMessageId}` : null;
        const result = await effect(job, `incident:${requestMessageId}`, () => mcp.call("support", "support_create_ticket", { category: "incident", title: publicText(input.title).slice(0, 200),
          description: `${publicText(input.description).slice(0, 4900)}${incidentMarker ? `\n\n${incidentMarker}` : ""}`, source_channel_id: job.source.channelId }, true, signal),
        incidentMarker ? { kind: "ticket", marker: incidentMarker, needsChannel: false } : null);
        const number = result.ticketNumber || result.number || result.ticket?.number;
        if (!number) throw new Error("ticket API did not return a number; inspect receipt");
        ledger.audit("incident_opened", { job: job.id, ticket: number, by: job.actorId, from: job.ticket || null });
        return { ...result, number, instruction: `Incident #${number} is open. Merge every open ticket reporting this same problem into it with merge_into_incident (incident ${number}, ticket N, a one-line reason); leave tickets about other problems open and say so. Then tell the requester in one line which tickets joined, and finish.` };
      }
      const reportSource = source(original, { id: reportChannelId, name: reportChannelName });
      function attachCommandTicket(number, channelId) {
        if (developerTask(job) && authority.grant(d, config, number, { by: job.actorId, messageId: job.source?.messageId, how: "directed", at: now() })) ledger.audit("ticket_authority_granted", { ticket: number, by: job.actorId, job: job.id, how: "directed" });
        let child = d.jobs[d.seen[`ticket:${number}`]];
        if (!child || JOB_TERMINAL.includes(child.state)) {
          child = ledger.createJob(`requested-ticket:${job.id}:${reportId}`, { kind: "ticket", role: "support", actorId: original.author.id,
            ticket: number, channelId, source: reportSource, deadline: now() + config.taskLifetimeMs });
          d.seen[`ticket:${number}`] = child.id;
        } else {
          if (child.source?.messageId !== reportId && !(child.inbox || []).some((s) => s.messageId === reportId)) (child.inbox ||= []).push(reportSource);
          delete child.resolutionReadyAt;
          if (child.state === "waiting") child.state = "queued";
        }
        // The developer's own words tell the ticket task what to look at.
        if (job.source?.content && !(child.inbox || []).some((x) => x.messageId === job.source.messageId)) (child.inbox ||= []).push({ ...job.source, developerRequest: true });
        if (child.state === "waiting") child.state = "queued";
        const receipt = { number, channelId, supportTaskId: child.id, requestMessageId };
        (job.openedTickets ||= {})[reportId] = receipt; ledger.save(); return receipt;
      }
      if (commanded && job.openedTickets?.[reportId]) { job.openedTickets[reportId].requestMessageId = requestMessageId; ledger.save(); return job.openedTickets[reportId]; }
      const channels = await discord("GET", `/guilds/${config.guildId}/channels`);
      // Conservative per-reporter deduplication; a second issue belongs in the existing channel.
      // Incident channels are excluded: merging a player into an incident adds
      // them to its channel, so every player ever merged into #1600 had all
      // later reports folded into it (2026-10-19: Simonella, then Moist, on an
      // owner's direct request).
      const existing = channels.find((c) => /^ticket-.*-\d+$/.test(c.name) && !/^ticket-incident-/.test(c.name) && d.channels[c.id]?.category !== "incident" && c.permission_overwrites?.some((p) => p.id === original.author.id && p.type === 1));
      if (existing) {
        const number = Number(/-(\d+)$/.exec(existing.name)[1]);
        if (commanded) return { ...attachCommandTicket(number, existing.id), existingChannel: existing.id, instruction: `This report is already tracked in ticket #${number} (<#${existing.id}>) and was added to it. Post one short line here pointing to it unless the developer asked for something else in this channel, then finish done; the ticket's support task carries it on there.` };
        const previous = d.jobs[d.seen[`ticket:${number}`]];
        if (previous && previous.id !== job.id) {
          (previous.inbox ||= []).push(reportSource);
          if (previous.state === "waiting") previous.state = "queued";
          job.state = "dismissed"; job.summary = `Report attached to existing task ${previous.id}, ticket ${number}.`;
        } else {
          job.ticket = number; job.channelId = existing.id; job.kind = "ticket"; d.seen[`ticket:${number}`] = job.id;
        }
        ledger.save();
        return { existingChannel: existing.id, number, instruction: "Continue in the existing ticket; this source report is preserved in the task. Do not create another channel." };
      }
      d.intake = d.intake.filter((x) => now() - x.at < 3600000);
      const directedIntake = d.intake.filter((x) => x.directed).length, autoIntake = d.intake.length - directedIntake;
      if (developerTask(job) ? directedIntake >= 15 : autoIntake >= config.maxIntakePerHour) throw new Error("intake rate limit reached; continue with the remaining reports after the next wakeup");
      const quote = redactSecrets(original.content || "").replace(/<@!?\d+>/g, "[mention]").replace(/@everyone|@here/g, "[mention]").replace(/[\u2013\u2014]/g, ",");
      const description = `${publicText(input.description)}\n\nPlayer report: ${quote}\nSource: https://discord.com/channels/${config.guildId}/${reportChannelId}/${original.id}`.slice(0, 5000);
      const args = { discord_user_id: original.author.id, title: publicText(input.title).slice(0, 200), description,
        category: ["bug", "account", "gameplay", "other"].includes(input.category) ? input.category : "bug", source_channel_id: reportChannelId,
        image_urls: (original.attachments || []).filter((a) => /^image\//.test(a.content_type || "")).map((a) => a.url).slice(0, 10) };
      d.intake.push({ at: now(), source: original.id, directed: developerTask(job) }); ledger.save();
      const result = await effect(job, commanded ? `intake:${reportId}` : "intake", () => mcp.call("support", "support_create_ticket", args, true, signal),
        original.id && args.description.includes(`/${original.id}`) ? { kind: "ticket", marker: `/${reportChannelId}/${original.id}`, needsChannel: true } : null);
      const number = result.ticketNumber || result.number || result.ticket?.number;
      const channelId = result.channelId || result.channel?.id || result.discordChannelId;
      if (!number || !channelId) throw new Error("ticket API did not return a number and channel; inspect receipt");
      if (commanded) attachCommandTicket(number, channelId);
      else { job.ticket = number; job.channelId = channelId; job.kind = "ticket"; d.seen[`ticket:${number}`] = job.id; ledger.save(); }
      if (["intakePersisted", "intakeCardDelivered", "announcementDelivered"].some((key) => result[key] === false)) {
        ledger.notify(`intake-delivery:${job.id}`, "owner", `Ticket ${number} was created, but its intake card, backend intake details or source-channel announcement needs delivery inspection.`); ledger.save();
      }
      const announced = result.announcementDelivered !== false;
      return commanded ? { ...result, ...job.openedTickets[reportId], instruction: `Ticket #${number} created for the verified reporter. Move the conversation to the ticket: do not stay in this channel. ${announced ? "The source channel already shows the ticket link, so post nothing more here" : `Post one short line here pointing to it, e.g. \"Opened #${number}, picking it up in <#${channelId}>.\"`} unless the developer also asked for something else in this channel; answer only that. Then finish done. The ticket's support task investigates and talks to the player there.` } : result;
    }
    if (name === "support_action") {
      if (job.kind === "ticket" && isModerationChannel(ledger, job.channelId)) throw new Error("This is a moderation ticket. Moderators handle it; Keir does not reply, update or close it. Finish without acting.");
      // Weaker models name the tool loosely ("public_update", an MCP prefix,
      // `name` instead of `tool`); map those, and say exactly what is allowed
      // (ticket 1542: Spark was refused twice and the answer waited).
      // Keir 10 (replay 2026-11-15): Muse sent the whole call one level down, {args: {tool, args}}; unwrap it.
      if (!input.tool && !input.name && input.args && typeof input.args === "object" && (input.args.tool || input.args.name)) { const inner = input.args; for (const k of Object.keys(input)) delete input[k]; Object.assign(input, inner); }
      { const want = String(input.tool || input.name || "").replace(/^mcp__\w+__/, "").trim();
        input.tool = SUPPORT_WRITES.includes(want) ? want : SUPPORT_WRITES.includes(`support_${want}`) ? `support_${want}` : want; }
      if (!SUPPORT_WRITES.includes(input.tool)) throw new Error(`support write is outside standing permission: tool must be one of ${SUPPORT_WRITES.join(", ")}. To answer the player: tool "support_public_update", args {"message": "..."}.`);

      const rows = await supportAuthority(job, undefined, { decisionNotice: input.tool === "support_public_update" });
      if (input.tool === "support_resolve" && (job.ownerClosureHold || d.jobs[d.seen[`ticket:${job.ticket}`]]?.ownerClosureHold)) throw new Error("Ticket closure is held by an explicit owner follow-up. Continue investigating and communicating; do not resolve or close it.");
      const args = { ...(input.args || {}), number: job.ticket };
      delete args.evidence; delete args.update_key; delete args.reply_to; // Keir 11.1: only the broker names a staged chart, an update key or a reply target, never the model.
      if (input.tool !== "support_resolve") args.kind = "ticket";
      // Models name the update text loosely ("body", "text"); the service needs `message`.
      if (input.tool === "support_public_update" && args.message === undefined) for (const k of ["body", "text", "content"]) if (typeof args[k] === "string") { args.message = args[k]; delete args[k]; break; }
      if (input.tool === "support_public_update" && !String(args.message || "").trim()) throw new Error('support_public_update needs the player-facing text in args.message: {"tool": "support_public_update", "args": {"message": "..."}}');
      const definition = (await mcp.list("support")).find(t => t.name === input.tool);
      if (!definition?.inputSchema) throw new Error("support write schema unavailable; discover support_tools and retry later");
      if (input.tool === "support_resolve" && definition.inputSchema.properties?.attribution) {
        args.attribution = { agent: "keir", jobId: job.id, evidence: `Keir resolution submitted by job ${job.id}` };
      }
      // Ticket identity is always broker-bound; all remaining arguments must match the live schema.
      if (args.message) args.message = publicText(args.message);
      if (input.tool === "support_public_update" && TECHNICAL.test(args.message || "")) throw new Error("Ticket updates are for the player: no PR or issue numbers, links, CI, merges, branches, commits or code. Say what was wrong and where the fix is (being built / in testing on dev / on sandbox / live on the main server).");
      if (args.followUp) args.followUp = publicText(args.followUp);
      if (args.actions) args.actions = args.actions.map(publicText);
      if (input.tool === "support_public_update") { args.deliver = true; args.delivery_mode = "reply"; args.update_kind = "progress"; args.message = shapeTicketPost(args.message || ""); await guardTicketPost(job, job.ticket, args.message); args.message = softenSettingClaims(job, job.ticket, softenAccountClaims(job, job.ticket, softenBugClaims(job, job.ticket, softenUnreadClaims(job, job.ticket, args.message)))); args.message = require("./sources").appendChecked(args.message, ledger.data.ticketObservations?.[job.ticket]); }
      if (input.tool === "support_set_status" && !["open", "triaging", "in_progress", "blocked", "parked"].includes(args.status)) {
        // Models reach for "waiting_on_player" or "answered", which are not statuses
        // at all; calling them terminal sent them round again (replay 2026-10-19: 15 runs).
        if (!/^(?:resolved|closed|rejected|done|fixed|complete[d]?|wont_?fix|duplicate)$/i.test(String(args.status || ""))) throw new Error(`"${String(args.status || "").slice(0, 40)}" is not a ticket status; use open, triaging, in_progress, blocked or parked. Waiting on the player needs no status: finish waiting with waitFor "player_reply".`);
        throw new Error("terminal statuses require a resolution receipt");
      }
      if (input.tool === "support_resolve") {
        require("./advicerouting").guardResolution(job, d, args);
        // Keir 8.4 (owner, 2026-11-06): a rule that works as designed but hurts the player is an owner decision, not a closure.
        {
          const ticketJobIds = new Set(Object.values(d.jobs).filter((j) => ticketOf(j) === job.ticket).map((j) => j.id));
          const mine = Object.values(d.decisions || {}).filter((x) => ticketJobIds.has(x.jobId));
          const ev = ticketEvidence(job.ticket);
          const lastPost = (d.ticketPosts?.[job.ticket] || []).filter((p) => !isCardPost(p)).at(-1);
          const category = d.channels?.[job.channelId]?.category;
          const refuse = replyPolicy.resolveRefusal({
            pendingDecision: mine.some((x) => x.state === "pending"),
            decided: mine.some((x) => x.type !== "approval" && ["approved", "selected"].includes(x.state)),
            fixed: ev.written.done || ev.main.done || ev.money.done,
            texts: category === "suggestion" ? [] : [args.message, args.followUp, ...(args.actions || []), lastPost?.text] });
          if (refuse) { ledger.audit("resolve_refused_policy", { job: job.id, ticket: job.ticket, category: category || null }); throw new Error(refuse); }
        }
        // Keir 10.4.1 (ticket 1845): only the player's own messages count, the same rule ticket_history uses for
        // observedPlayerAt (9.0.2). An owner or staff line ("hello") is never recorded there, so it refused every close.
        // Any ticket job may have read the player's newest message, not only this one.
        const closeStaff = new Set([config.ownerId, ...(config.staffIds || [])].filter(Boolean));
        const recent = rows.filter((m) => !m.author.bot && !closeStaff.has(m.author.id)).sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).at(-1);
        if (recent && Date.parse(recent.timestamp) > Math.max(job.observedPlayerAt || 0, job.lastPlayerAt || 0, humanAt(job.ticket))) throw new Error("new player reply must be investigated before closure");
        // Keir 4.1.10 (owner, ticket 1542): a question or a call for staff
        // that nobody answered is still open, however long the silence. The
        // last human word must not be an unanswered question or ping.
        const ordered = rows.slice().sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
        const lastHuman = ordered.filter((m) => !m.author.bot).at(-1);
        if (lastHuman && lastHuman.author.id !== config.ownerId && !config.staffIds.includes(lastHuman.author.id)) {
          const answered = ordered.some((m) => BigInt(m.id) > BigInt(lastHuman.id) && (m.author.bot || m.author.id === config.ownerId || config.staffIds.includes(m.author.id)));
          if (!answered && UNANSWERED.test(String(lastHuman.content || ""))) throw new Error(`Not closed: the player's last message is still unanswered ("${String(lastHuman.content).slice(0, 160)}"). Answer it first. If they called for staff and no one replied within fifteen minutes, answer it yourself.`);
        }
        const coordinator = ownerDirected(job) && d.jobs[d.seen[`ticket:${job.ticket}`]];
        const sharedAnswerAt = coordinator?.kind === "ticket" && coordinator.ticket === job.ticket && coordinator.channelId === job.channelId ? coordinator.resolutionReadyAt || 0 : 0;
        const answerAt = sharedAnswerAt || job.resolutionReadyAt;
        // Keir 11.1.1: a reply delivered to this ticket's channel by another job or an operator, cross-checked against Discord,
        // only stops this job from posting a recap or a close notice. It never licenses closure: a progress note proves a message
        // was sent, not that it solved the case. Closure still needs this ticket's own answer mark or a player confirmation.
        if (!answerAt) {
          const ticket = await mcp.call("support", "support_get", { kind: "ticket", number: job.ticket }, false, signal).catch(() => null);
          const receipt = require("./answerreceipt").verifiedAnswerAfterRequest({ ticket, number: job.ticket, channelId: job.channelId, rows,
            isAnswerSide: (m) => Boolean(m.author?.bot) || closeStaff.has(m.author?.id), isHolding: holdingPost });
          if (receipt) {
            ledger.audit("ticket_answer_receipt_seen", { job: job.id, ticket: job.ticket, messageId: receipt.messageId, key: receipt.key, at: receipt.at, complete: receipt.complete });
            throw new Error("Not closed: the player already has a delivered reply after their latest message, but nothing confirms it solved their question. Do not post another recap or a notice that you will close. Finish waiting with waitFor \"player_reply\"; close only after the player confirms or you hold a verified outcome for this request.");
          }
        }
        // The task wakes when the grace ends, not on a long reply wait (ticket 1755 was due to
        // close two hours after its fix and slept nine).
        if (!answerAt) throw new Error("give the player the final answer and wait for the closure grace period");
        if (now() - answerAt < config.closeGraceMs) {
          job.closeReadyAt = answerAt + config.closeGraceMs;
          throw new Error("The player already has the final answer. Wait silently for the closure grace period or a new player reply.");
        }
        // Review 2026-10-19: 1610 resolved one minute after "live", 1611 52
        // minutes after (the player's deliveries had fallen), 1630 before the
        // change shipped. After a fix goes live the player gets a turn to see
        // it; a player reply since then is handled by the rule above.
        const liveAt = d.liveSaid?.[job.ticket] || 0;
        const liveGrace = config.liveGraceMs ?? 2 * 3600000;
        const playerSince = lastHuman && lastHuman.author.id !== config.ownerId && !config.staffIds.includes(lastHuman.author.id) && Date.parse(lastHuman.timestamp) > liveAt;
        if (liveAt && now() - liveAt < liveGrace && !playerSince) job.closeReadyAt = Math.max(job.closeReadyAt || 0, liveAt + liveGrace);
        if (liveAt && now() - liveAt < liveGrace && !playerSince) throw new Error(`Not closed: a fix went live ${Math.round((now() - liveAt) / 60000)} minutes ago. Give the player at least ${Math.round(liveGrace / 60000)} minutes and a turn to see it, then check their numbers before resolving.`);
      }
      validateArguments(args, definition.inputSchema);
      if (input.tool === "support_tracker_note") {
        const ticket = await mcp.call("support", "support_get", {kind:"ticket", number:job.ticket}, false, signal);
        if (!ticket.trackerItemId) throw new Error("Ticket has no linked tracker item. Use support_tracker_sync first, then support_tracker_note with body; investigation and public updates can continue meanwhile.");
      }
      if (input.tool === "support_tracker_sync" && args.status && !["open", "active", "blocked"].includes(args.status)) throw new Error("terminal tracker statuses require a resolution receipt");
      // Keir 11.1: a delivered reply carries a chart staged in this activation; a card edit never does.
      const effectKey = hash({ tool: input.tool, args });
      const evidence = input.tool === "support_public_update" && args.deliver === true && (args.delivery_mode || "reply") === "reply"
        ? evidenceDelivery.claimTicket(ledger, job, { config, key: effectKey, ticket: job.ticket, at: now() }) : null;
      const extra = input.tool === "support_public_update" && args.deliver === true && (args.delivery_mode || "reply") === "reply" ? evidenceDelivery.ticketArgs(ledger, job, { key: effectKey, evidence }) : {};
      let result;
      try {
        result = await effect(job, effectKey, () => callSupport(input.tool, { ...args, ...extra, ...(evidence ? { evidence } : {}) }, true, signal),
          input.tool === "support_public_update" && args.kind === "ticket" && typeof args.message === "string" && args.message.trim() ? { kind: "reply", ticket: Number(job.ticket), text: args.message } : null);
      } catch (e) { evidenceDelivery.settleTicket(ledger, job, { id: evidence, error: e, at: now() }); throw e; }
      evidenceDelivery.settleTicket(ledger, job, { id: evidence, result, at: now() });
      if (["support_tracker_sync", "support_tracker_note"].includes(input.tool)) { job.trackerRaised = true; ledger.save(); }
      if (input.tool === "support_public_update") {
        const delivered = ["sent", "delivered", "posted", "already_posted"].includes(result.delivery?.status) || result.delivery?.alreadyPosted === true || result.delivery?.posted === true || result.delivery?.delivery?.status === "posted";
        if (delivered) { conversationTurn.answered(job); job.channelReplyQueued = true; job.lastPublishedAt = now(); recordTicketPost(job, job.ticket, args.message || ""); }
        else ledger.notify(`delivery:${job.id}:${hash(args)}`, "owner", `Ticket ${job.ticket}: public update delivery needs verification.`);
      }
      if (input.tool === "support_resolve") {
        if (result?.ok !== true) throw new Error("support resolution was not confirmed; no success recorded");
        job.resolutionSubmitted = true; job.resolutionSubmittedAt ||= now();
        require("./ticketstate").closeTicketJobs(ledger, job.ticket, "resolved", { except: job });
        if (result.receipt?.receiptId) job.resolutionReceiptId = result.receipt.receiptId;
        if (result.receipt?.receiptId) {
          require("./ticketoutcomes").observeTicket(d, job, { number: job.ticket, status: result.status || "resolved",
            resolution: result.receipt, resolutionAttribution: { agent: "keir", jobId: job.id, evidence: "keir-resolution-submission" },
            conversation: { channelId: job.channelId } }, now());
        }
        // Keir 2.0: every resolution becomes a recallable note.
        // Keir 9: and at most one verified mechanic (plus a lesson after a retraction) from the code the ticket read.
        try { require("./ticketlearn").keep({ d, notebook, ticket: job.ticket, audit: (k, v) => ledger.audit(k, v) }); } catch {}
        try { const r = await reporterOf(job, signal).catch(() => null); require("./evidencegap").settle({ d, notebook, ticket: job.ticket, reporter: r?.id || null, audit: (k, v) => ledger.audit(k, v), now }); } catch {}
        try { notebook?.remember({ kind: "resolution", text: `Ticket ${job.ticket}: ${String(args.message || job.summary || "").slice(0, 600)}`, ticket: job.ticket, by: job.id }); } catch {}
        try { const r = await reporterOf(job, signal); if (r?.id) notebook?.remember({ kind: "player", player: r.id, text: `${r.name || "Player"} raised ticket ${job.ticket}${r.title ? ` ("${String(r.title).slice(0, 80)}")` : ""}; resolved: ${String(args.message || job.summary || "").slice(0, 400)}`, ticket: job.ticket, by: job.id }); } catch {}
      }
      ledger.save(); return result;
    }
    if (name === "edit_verify" || name === "finish_patch") {
      const wantsComplete=name === "finish_patch" || input.complete === true;
      if (isQuick(job) || job.role === "player" || job.investigation) throw new Error("Scoped coding worker required");
      if(input.complete !== undefined && typeof input.complete !== "boolean") throw new Error("complete must be boolean");
      if(wantsComplete && (job.codingContract?.allowCompleteOnPass !== true || job.resultSchema)) throw new Error("This trusted coding contract does not permit automatic completion; provide the full result through finish");
      const checked=await require("./edit-verify").createEditVerify({sandbox,ledger,now}).apply(job,input,signal);
      if(wantsComplete && checked.passed){
        const summary=String(input.summary||"Scoped patch passed the configured focused validation.").slice(0,4000);
        const finished=await tool(job,"finish",{state:"done",summary},signal);
        return {...checked,finished:{state:finished.state,summary}};
      }
      return checked;
    }
    if (name === "local_file") return require("./ownermuse-files").localFile(sandbox, job, input, signal);
    if (name === "evidence_batch") {
      if (isQuick(job) || job.role === "player") throw new Error("Evidence batches require an authenticated worker task");
      // Workspace queries read /workspace/repo. Without a snapshot the batch
      // failed as "narrow the query" (replay 2026-10-19: 37 runs); load main first.
      if (sandbox.hasRepository?.(job.id) === false && (input.queries || []).some((q) => ["list", "read", "search"].includes(q?.op))) {
        try { await tool(job, "repository_snapshot", { repository: "AHDGame", ref: "main" }, signal); }
        catch (e) { throw new Error(`Workspace queries need a repository snapshot and loading one failed (${String(e.message).slice(0, 200)}). Call repository_snapshot first, or send only service queries.`); }
      }
      return require("./workflow-evidence").createWorkflowEvidence({ sandbox, stateDir: config.stateDir, ledger, now,
        read: (task, args, scopeSignal) => tool(task, "read_tool", args, scopeSignal),
        readTools: (task, args, scopeSignal) => tool(task, "read_tools", args, scopeSignal),
      }).collect(job, input, signal);
    }
    if (name === "shell") return sandbox.run(job.id, input.command, signal, { deps: job.repository && sandbox.deps?.(job.repository), timeoutMs: Math.min(300, Math.max(10, Number(input.timeoutSeconds) || 60)) * 1000 });
    if (name === "repository_snapshot") {
      const repository = config.repositories[input.repository];
      const developer = developerTask(job) || developerTicket(job);
      const botSupport = input.repository === "adhd-bot" && job.role !== "player" && (developer || job.kind === "ticket" && Boolean(job.ticket));
      if (!repository || (job.role !== "owner" && input.repository !== "AHDGame" && !(input.repository === "AHDClient" && developer) && !botSupport)) throw new Error("unknown repository; registered: " + Object.keys(config.repositories).join(", "));
      const branch = input.repository === "AHDGame" ? (input.ref === "development" ? "development" : "main") : "main";
      if (job.repository === input.repository && job.repositoryRef?.branch === branch && !input.refresh) {
        // A task's snapshot does not follow the branch. Say when it has moved so a
        // patch is not built on stale code (ticket 1507 failed twice this way).
        await exec("/usr/bin/git", ["-C", repository, "fetch", "--quiet", "origin", branch], { timeout: 120000 }).catch(() => {});
        const head = String(await exec("/usr/bin/git", ["-C", repository, "rev-parse", `origin/${branch}`]).catch(() => "")).trim();
        if (head && !head.startsWith(job.repositoryRef.commit)) return { path: "/workspace/repo", ...job.repositoryRef, reused: true, stale: true, remoteCommit: head.slice(0, 10),
          instruction: `${branch} has moved since this snapshot (now ${head.slice(0, 10)}). Before publishing a patch, call repository_snapshot with refresh:true (this discards your edits in /workspace/repo) and redo the change on the latest code.` };
        return { path: "/workspace/repo", ...job.repositoryRef, reused: true, instruction: "The snapshot is already loaded in /workspace/repo and matches the branch head." };
      }
      // Always read the remote branch: the shared checkout's local refs go stale
      // for weeks and are not what production or development run.
      await exec("/usr/bin/git", ["-C", repository, "fetch", "--quiet", "origin", branch], { timeout: 120000 });
      const ref = `origin/${branch}`;
      if (input.repository === "AHDGame" && !musePolicy.origin(d, job).scoped) execFile("/usr/bin/systemd-run", ["--no-block", "--collect", "--unit=keir-deps-refresh", "--property=MemoryMax=6G", path.join(__dirname, "../../bin/keir-deps-refresh.sh")], () => {});
      const [sha, committed] = (await exec("/usr/bin/git", ["-C", repository, "log", "-1", "--format=%H %cI", ref])).trim().split(" ");
      sandbox.attach(job.id, await baseFor(input.repository, repository, sha));
      job.repository = input.repository; job.repositoryRef = { branch, commit: sha.slice(0, 10), committedAt: committed }; ledger.save();
      const deps = sandbox.deps?.(input.repository);
      // KBX2: a compact map of the tree so the model does not spend rounds on ls/find.
      const files = String(await exec("/usr/bin/git", ["-C", repository, "ls-tree", "-r", "--name-only", sha]).catch(() => "")).split("\n").filter(Boolean);
      const map = require("./repomap").repoMap(files);
      return { path: "/workspace/repo", ...job.repositoryRef, ...(map ? { map } : {}), dependencies: deps ? "node_modules is mounted read-only (no need to inspect it). Focused test: `node_modules/.bin/vitest run <file> --configLoader runner`; types: `npx tsc --noEmit -p <tsconfig>`; format: `node_modules/.bin/prettier --write <files>`. The snapshot is a fresh clone of the branch: git log, remotes and branches need no checking." : "dependencies unavailable for this repository",
        instruction: "This is the live remote branch, newer than the code index. Treat it as the source of truth for what is deployed (main) or about to deploy (development). Edit here; the host is untouched." };
    }
    if (name === "request_heal") {
      // Owner, 2026-11-01: "It should allow it if I approve it." A ticket task
      // may propose a huge repair; only the owner's exact approval runs it.
      if (!developerTask(job) && job.kind !== "finding" && job.kind !== "ticket") throw new Error("a live heal needs an authenticated developer task or a ticket");
      const checked = heal.validateRequest(input);
      if (!checked.ok) throw new Error(checked.error);
      if (musePolicy.origin(d, job).scoped) { try { musePolicy.operation(checked.spec); } catch (error) { return musePolicy.fail(ledger, job, "request_heal", error.message); } }
      if (checked.spec.env === "prod" && prodHold()) throw new Error(HOLD_NOTE);
      const spec = checked.spec;
      const risk = { ...spec };
      if (spec.kind === "ledger") {
        const detectors = await mcp.call("heal-ops", "heal_list", {}, false, signal).catch(() => null);
        const detector = detectors?.defects?.find((x) => x.id === spec.defectId);
        // Missing detector metadata never makes a native money repair small.
        // Not minting does not mean no money moves. Native ledger repairs
        // need fresh approval unless the detector explicitly rules both out.
        if (!detector || detector.mintsMoney !== false || detector.touchesMoney !== false) risk.touchesMoney = true;
        if (detector?.collection === "gameConfig") risk.collection = "gameConfig";
      }
      if (!developerTask(job) && job.kind !== "finding" && job.kind !== "ticket" && authority.hugeHeal(risk)) throw new Error("huge heals require an authenticated developer task");
      const call = heal.planCall(spec, `Discord developer ${job.actorId} via Keir`);
      const plan = await mcp.call("heal-ops", call.name, call.args, false, signal);
      const refusal = heal.planRefusal(plan);
      risk.expectedMax = Math.max(Number(spec.expectedMax || 0), heal.affectedOf(plan));
      if (plan.plan?.touchesMoney || plan.plan?.mintsMoney || Number(plan.plan?.moneyDelta || 0) !== 0) risk.touchesMoney = true;
      if (plan.plan?.collection === "gameConfig") risk.collection = "gameConfig";
      if (!developerTask(job) && job.kind !== "finding" && job.kind !== "ticket" && authority.hugeHeal(risk)) throw new Error("huge heals require an authenticated developer task");
      if (refusal) throw new Error(`Heal plan refused: ${refusal}`);
      const proposed = request(job, "heal", {spec, risk, affected:heal.affectedOf(plan), planDigest:musePolicy.origin(d, job).scoped ? musePolicy.digest(plan.plan) : hash(heal.planIdentity(plan.plan)), ...(musePolicy.origin(d, job).scoped ? { destination: mcp.identity?.("heal-ops"), plan: plan.plan } : {})}, `Developer-directed heal in ${spec.env}: ${spec.description || spec.defectId}. Dry run affects ${heal.affectedOf(plan)} records. Review this exact plan before applying.`);
      return {...proposed, plan:plan.plan, guards:plan.guards, warnings:plan.warnings, instruction:proposed.instruction || "The owner or delegate can confirm this exact action with Keir approve <action-id>. No game data has changed."};
    }
    if (name === "request_action") {
      if (JSON.stringify(input.args).length > 6000) throw new Error("privileged arguments exceed the reviewable request limit");
      if (input.kind === "host_command") {
        if (!Array.isArray(input.args?.argv) || !input.args.argv.length || !input.args.argv.every((x) => typeof x === "string") || !input.args.argv[0].startsWith("/")) throw new Error("host commands need an absolute executable and literal argv array");
        if (input.args.argv.some((x) => x.includes(path.join(config.stateDir, "workspaces")))) throw new Error("mutable workspace files cannot be executed on the host; publish a frozen patch instead");
      } else if (input.kind === "mcp_write") {
        if (!input.args?.server || !input.args.tool || typeof input.args.args !== "object") throw new Error("invalid MCP write request");
      } else if (input.kind === "turn_lock_reset") {
        return w3.turnLockReset(job, input, signal, (spec) => toolInner(job, "request_heal", spec, signal));
      } else throw new Error("unknown privileged action kind");
      return request(job, input.kind, input.args, input.reason);
    }
    if (name === "publish_patch") {
      if (job.repository === "adhd-bot") throw new Error("Discord bot patches require a maintainer to publish from arle-bina/adhd-bot. Give them the exact patch and test results.");
      if (!job.repository) throw new Error("load a repository snapshot first");
      if (typeof input.title !== "string" || !/^(fix|feat|chore|docs|refactor|test)(\([^\n]+\))?: .{3,150}$/.test(input.title) || typeof input.body !== "string" || input.body.length > 6000) throw new Error("use a conventional commit title and bounded PR description");
      // Format changed files the way CI checks them, so formatting never turns
      // a fix red. prettier respects the repository's .prettierignore.
      const formatted = await sandbox.run(job.id, "cd repo && git add -A && f=$(git diff --cached --name-only --diff-filter=ACMR HEAD); if [ -n \"$f\" ] && [ -x node_modules/.bin/prettier ]; then node_modules/.bin/prettier --write --ignore-unknown $f >/dev/null; fi", signal, { deps: sandbox.deps?.(job.repository), timeoutMs: 120000 });
      if (formatted.code !== 0) throw new Error(`prettier could not format the change, usually a syntax error: ${String(formatted.output).slice(-1500)}`);
      const diff = await (sandbox.capture ? sandbox.capture.bind(sandbox) : sandbox.run.bind(sandbox))(job.id, "cd repo && git add -A && git --no-pager diff --no-ext-diff --no-textconv --cached --binary HEAD", signal);
      if (diff.code !== 0 || diff.truncated || !diff.output.trim()) throw new Error("patch is absent, invalid or too large for this bounded publisher");
      const patch = diff.output;
      if (ownerText(patch) !== patch || /(?:new file mode|new mode) 120000|GIT binary patch/.test(patch)) throw new Error("credentials, symlinks and binary patches are not publishable");
      const leak = publicPatchLeak(patch);
      if (leak) throw new Error(`The repository is public: this patch adds an internal host, path or personal address (${leak}). Remove it and publish again.`);
      // Owner review and green CI both passed #3895, which still broke worlds
      // seeded without a market-mode stamp. Economy patches carry the world
      // cases they were tested against, so review can see what was covered.
      const economyFiles = [...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]).filter((f) => ECONOMY_PATHS.test(f));
      if (job.repository === "AHDGame" && economyFiles.length && !/^#{2,3}\s*World validation\b[\s\S]{80,}/im.test(input.body || "")) throw new Error(`This patch changes the turn engine or economy (${economyFiles.slice(0, 4).join(", ")}). Before publishing, add tests that run it against the world states it will meet: existing and newly founded sector cohorts, worlds seeded without the stamps or flags your code reads, and the first turn after the switch. Then add a "## World validation" section to the PR body listing each case and its result. The owner approves economy changes; promotion to the main server waits for the owner's waking hours unless they grant a night pass.`);
      const dir = path.join(config.stateDir, "artifacts"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const digest = crypto.createHash("sha256").update(patch).digest("hex");
      const patchFile = path.join(dir, `${job.id}-${digest}.patch`);
      fs.writeFileSync(patchFile, patch, { mode: 0o600, flag: "w" });
      const title = publicText(input.title);
      let body = redactSecrets(input.body);
      if (body !== input.body) throw new Error("PR description contains private details; the repository is public");
      // Keir 4.2: the ticket's open issues are referenced, never auto-closed by
      // the development merge; Keir closes them once the fix is live.
      if (job.repository === "AHDGame") {
        const ticketNo = ticketOf(job);
        const linked = Object.values(d.keirIssues || {}).filter((x) => x.state === "open" && ((ticketNo && (x.ticket === ticketNo || x.tickets?.includes(ticketNo))) || (job.issues || []).includes(x.number))).map((x) => x.number).filter((x) => !new RegExp(`#${x}\\b`).test(body));
        // A ticket's fix carries its issue (2026-10-19 ticket bench: 2 in 5 runs
        // published a patch without ever filing or linking one, so the report
        // never reached the existing issue). raise_to_developers first; its
        // duplicate check finds the open issue to add evidence to.
        const anyIssue = Object.values(d.keirIssues || {}).some((x) => (ticketNo && (x.ticket === ticketNo || x.tickets?.includes(ticketNo))) || (job.issues || []).includes(x.number));
        if (ticketNo && !anyIssue && !/#\d+/.test(body)) throw new Error("This ticket has no GitHub issue yet. File the bug, or add your evidence to the open issue that already covers it, with raise_to_developers (kind bug), then publish the patch; it will reference that issue.");
        // An explicit issue reference in the body means the author chose which
        // issues this PR fixes; otherwise it carries the ticket's open issues.
        const refs = /\b(?:refs?|fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+/i.test(body) ? "" : issues.refsLine(linked);
        if (refs) body = `${body.trimEnd()}\n\n${refs}`;
        body = body.replace(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi, "Refs #$1");
      }
      // Keir 11.2: every PR Keir opens carries the Conflict of interest section custom-rules requires (prdisclosure.js).
      body = withDisclosure(body);
      // Revise the open PR for this work unless the change is a genuinely
      // separate fix. That PR may belong to another task on the same ticket
      // (2026-10-12: ticket 1506's ticket task and a developer task each
      // opened a PR for the same tech cost floor).
      let revise = null;
      if (!input.separateFix) {
        const ticketNo = ticketOf(job);
        // Keir 5.1: findings sharing a root cause share one draft (2026-10-14:
        // #4143 and #4144 were two drafts of the same line of credit fix).
        const siblings = job.kind === "finding" && job.finding && watch ? watch.groupJobs(job.finding).filter((id) => id !== job.id) : [];
        const candidates = [...(job.pullRequests || []), ...(ticketNo ? Object.values(d.jobs).filter((j) => j.id !== job.id && ticketOf(j) === ticketNo).flatMap((j) => j.pullRequests || []) : []),
          ...siblings.flatMap((id) => d.jobs[id]?.pullRequests || [])];
        for (const url of [...new Set(candidates)].reverse()) {
          const number = pullRequestNumber(job.repository, url);
          if (!number) continue;
          const pr = await exec("/usr/bin/gh", ["api", `repos/${repositoryName(job.repository)}/pulls/${number}`], { signal }).then(JSON.parse).catch(() => null);
          if (pr?.state === "open" && /^keir\//.test(pr.head?.ref || "")) { revise = { number, branch: pr.head.ref, url: pr.html_url }; break; }
        }
      }
      const args = { repository: job.repository, patchFile, patchSha256: digest, title, body, ...(revise ? { revise } : {}) };
      const a = { id: ledger.id(), jobId: job.id, kind: "publish_patch", args, digest: hash({ kind: "publish_patch", args }), state: "executing", at: now(), expiresAt: now() + 86400000, approvedBy: "policy:auto-pr" };
      d.actions[a.id] = a; ledger.audit("auto_publish", { action: a.id, job: job.id, digest }); ledger.save();
      const result = await effect(job, `action:${a.id}`, () => publishPatch(job, a, signal));
      a.state = "done"; if (!result.revised) job.pullRequests = [...(job.pullRequests || []), result.pullRequest]; ledger.save();
      return { ...result, instruction: result.revised ? "Your open PR now carries this version; CI reruns on it. Do not open another PR for the same fix." : `The PR is open against ${job.repository === "AHDGame" ? "development" : "main"}. Track its own checks and merge under the existing gates; a desktop source merge is not proof of a released client.` };
    }
    if (name === "execute_action") {
      const a = d.actions[input.action];
      try { musePolicy.validate(d, config, job, a, now(), true); } catch (error) { return musePolicy.fail(ledger, job, "execute_action", error.message); }
      if (a?.ownerMuse && a.kind === "heal" && musePolicy.digest(a.args.destination) !== musePolicy.digest(mcp.identity?.("heal-ops"))) throw new Error("Heal account or endpoint changed since approval");
      const approvedDeveloperHeal = a?.kind === "heal" && developerTask(job) && authority.granter(config, a.approvedBy);
      if (!a || a.jobId !== job.id || a.state !== "approved" || (!approvedDeveloperHeal && a.approvedBy !== config.ownerId) || a.expiresAt < now() || a.digest !== hash({ kind: a.kind, args: a.args })) throw new Error("no valid exact owner approval");
      // A merge or promotion approval is consumed by the github tool's gate,
      // not run here; falling through ran it as a host command and spent the
      // sign-off (ticket 1514, 2026-10-14).
      if (a.kind === "github") return { action: a.id, state: a.state, instruction: `This approval is recorded. Call the github tool again with action ${a.args.action}${a.args.to ? ` to ${a.args.to}` : a.args.number ? ` for PR ${a.args.number}` : ""}; its gate finds this approval and proceeds.` };
      let healApply;
      if (a.kind === "heal") {
        const exactOwnerApproval = job.kind === "ticket" && a.exactApproval && a.approvedBy === config.ownerId;
        if (!developerTask(job) && !exactOwnerApproval && !(job.kind === "ticket" && ticketYes(job) && !authority.hugeHeal(a.args.risk || a.args.spec) && a.args.affected <= 25)) throw new Error("heal execution lost developer provenance or ticket authority");
        if (a.args.spec.env === "prod" && prodHold()) throw new Error(HOLD_NOTE);
        const call = heal.planCall(a.args.spec, `Discord developer ${a.approvedBy} via Keir`);
        const plan = await mcp.call("heal-ops", call.name, call.args, false, signal);
        const refusal = heal.planRefusal(plan);
        // Actions created before plan identities still carry a whole-plan digest.
        const samePlan = a.ownerMuse ? musePolicy.digest(plan.plan) === a.args.planDigest : [hash(heal.planIdentity(plan.plan)), hash(plan.plan)].includes(a.args.planDigest);
        if (refusal || heal.affectedOf(plan) !== a.args.affected || !samePlan) {
          // The approval can never run again, so it is withdrawn: an approved action is a wake
          // reason (subscription below), and leaving it approved woke the task every 15 minutes
          // for nothing after the fresh plan ran (KBX5 approval--superseded, 2026-11-03).
          a.state = "withdrawn"; a.withdrawnReason = "plan changed since confirmation"; a.withdrawnAt = now();
          ledger.audit("action_withdrawn", { job: job.id, action: a.id, reason: "plan_changed" }); ledger.save();
          throw new Error("Heal target or plan changed since confirmation; create and confirm a fresh plan.");
        }
        healApply = heal.applyCall(a.args.spec, plan.token, `Discord developer ${a.approvedBy} via Keir`);
      }
      if (a.kind === "computer_input") {
        if (!appComputer || !ownerDirected(job) || !isAppJob(job) || job.appComputer?.file !== a.args.screen || job.appBrowserId !== a.args.browser || job.appComputer?.url !== a.args.url || a.ownerMuse && musePolicy.digest(appComputer.identity?.()) !== musePolicy.digest(a.args.destination)) throw new Error("Browser screen or worker changed since approval; review a fresh action.");
      }
      if (musePolicy.origin(d, job).scoped) {
        musePolicy.validate(d, config, job, a, now(), true);
        if (a.kind === "heal" && musePolicy.digest(a.args.destination) !== musePolicy.digest(mcp.identity?.("heal-ops"))) throw new Error("Heal account or endpoint changed since approval");
        active(job);
        if (signal?.aborted) throw new Error("activation aborted");
        if (supportDirectives.held(job)) throw new Error("Support directive is held");
        if (a.kind === "heal" && a.args.spec.env === "prod" && prodHold()) throw new Error(HOLD_NOTE);
      }
      // Keir 8.4: kill switch before the action is marked executing, so a refusal leaves it approved, not stuck.
      killSwitch?.assertClear("This approved action");
      // Keir 8.4: at most N production heals per rolling day (default 5), idempotent per approved action.
      if (a.kind === "heal" && a.args.spec.env === "prod" && limits) {
        const cap = trustLimits.checkCounter(d, "heal", a.id, now(), limits.get());
        if (!cap.ok) { ledger.audit("heal_cap", { job: job.id, action: a.id, count: cap.count, limit: cap.limit }); ledger.save(); throw Object.assign(new Error(cap.reason), { code: "HEAL_CAP" }); }
        trustLimits.recordCounter(d, "heal", a.id, now()); ledger.save();
      }
      // Persist this state with the effect's started receipt in one snapshot.
      a.state = "executing";
      const result = await effect(job, `action:${a.id}`, async () => {
        if (a.kind === "computer_input") { const result = await appComputer.act(job, a.args.input, signal); delete result.image; return result; }
        if (a.kind === "heal") return mcp.call("heal-ops", healApply.name, healApply.args, true, signal);
        if (a.kind === "mcp_write") return mcp.call(a.args.server, a.args.tool, a.args.args, true, signal);
        if (a.kind === "publish_patch") return publishPatch(job, a, signal);
        const unit = `keir-action-${a.id}`;
        const stop = () => { execFile("/usr/bin/systemctl", ["stop", unit], { timeout: 10000 }, () => {}); };
        signal?.addEventListener("abort", stop, { once: true });
        try {
          if (signal?.aborted) throw new Error("task was cancelled before host execution");
          return { output: await exec("/usr/bin/systemd-run", ["--wait", "--pipe", "--collect", `--unit=${unit}`, "--property=RuntimeMaxSec=300", "--setenv=HOME=/root", "--setenv=PATH=/usr/local/bin:/usr/bin:/bin", "--property=KillMode=control-group", "--property=MemoryMax=2G", "--property=CPUQuota=100%", "--", ...a.args.argv], { signal, timeout: 305000 }) };
        } finally { signal?.removeEventListener("abort", stop); if (signal?.aborted) stop(); }
      }).catch((e) => {
        // A rejected argument proves nothing ran; the action is spent, not in flight.
        if (job.effects[`action:${a.id}`]?.state === "rejected") { a.state = "failed"; ledger.save(); }
        throw e;
      });
      a.state = "done"; a.executedAt = now(); ledger.save(); return result;
    }
    if (name === "checkpoint") {
      if (require("./toolmarkup").hasToolMarkup(input.summary)) throw new Error("Tool-call markup is not a checkpoint. Call tools through their interface and preserve the last verified conclusion.");
      if (input.completionMinutes !== undefined) {
        if (!Number.isInteger(input.completionMinutes) || input.completionMinutes < 1 || input.completionMinutes > 1440 || !String(input.estimateBasis || "").trim()) throw new Error("A task forecast needs 1-1440 remaining minutes and an evidence basis");
        job.completionForecast = { at: now(), expectedAt: now() + input.completionMinutes * 60000, basis: String(input.estimateBasis).slice(0, 400), kind: "worker-estimate" };
      }
      job.summary = String(input.summary).slice(0, 4000);
      job.history = [...(job.history || []), { at: new Date(now()).toISOString(), kind: "checkpoint", summary: job.summary }].slice(-20);
      job.lastPlayerAt = job.observedPlayerAt || job.lastPlayerAt || 0;
      if (input.finalAnswerDelivered) {
        if (!job.lastPublishedAt) throw new Error("no verified delivered public update");
        job.resolutionReadyAt = job.lastPublishedAt;
      }
      ledger.save(); return { saved: true };
    }
    if (name === "finish") {
      // Keir 11.2: after the state and timer are settled, record the wait for the code check and escalate quiet waits once.
      const settleClosing = () => {
        if (job.stepBack && !job.stepBack.done) job.stepBack.done = true;
        const startedAt = job.startedAt || job.lastRunStartedAt || 0;
        const acted = (job.lastPublishedAt || 0) >= startedAt || Object.values(job.effects || {}).some((e) => (e?.at || 0) >= startedAt)
          || Object.values(d.decisions || {}).some((x) => x.jobId === job.id && (x.at || x.createdAt || 0) >= startedAt);
        // Third pass (review M7): quiet-wake escalation and parking have a switch; off or in preview the wait is still
        // recorded for the code check, but nothing escalates or parks (preview records that it would have).
        const qg = ctl().gate("quietWakes");
        const out = closing.afterFinish(d, job, { acted, now: now(), config: qg.act ? closingConfig : { ...closingConfig, quietWakes: Infinity } });
        if (!qg.act && qg.run && (job.closing?.quietWakes || 0) >= closingConfig.quietWakes) controlsLib.preview(d, "quiet-wakes", "escalate or park", `job ${job.id}`, `${job.closing.quietWakes} quiet wakes waiting on ${String(job.closing.waitingOn || "").slice(0, 160)}`, {}, now());
        if (out?.effects) require("./lifecycle").applyEffects(ledger, out.effects);
      };
      if (conversationTurn.foreground.has(job)) {
        if (input.state !== "waiting" || input.needsOwner) throw new Error("Finish waiting for the delegated worker.");
        if (!(job.lastPublishedAt >= job.startedAt)) throw new Error("Answer the current question before yielding to the worker.");
        job.state = job.inbox?.length ? "queued" : "waiting";
        delete job.wakeAt;
        job.history = [...(job.history || []), { at: new Date(now()).toISOString(), kind: "finish", state: job.state, summary: String(input.summary || "").slice(0, 1000) }].slice(-20);
        ledger.audit("conversation_yielded_to_worker", { job: job.id });
        ledger.save();
        return { state: job.state };
      }
      if (input.needsOwner) { const hk = require("./prhousekeeping").housekeepingRequest(input.summary); if (hk) throw new Error(require("./prhousekeeping").INSTRUCTION(hk)); }
      if (input.needsOwner && !job.ownerMuseBlocker && !d.channels?.[job.channelId]?.claimedBy && !appQuestions?.list(job.appThread||"main").some(q=>q.jobId===job.id&&q.state==="pending") && !Object.values(d.decisions||{}).some(x=>x.jobId===job.id&&x.state==="pending")) throw new Error("Prepare a readable owner request first: use github merge/promote with explanation for an action, or present_choices/raise_to_developers with named policy options. A technical finish summary is not an approval request.");
      if (require("./toolmarkup").hasToolMarkup(input.summary)) throw new Error("Tool-call markup is not a completion summary. Call tools through their interface and preserve the last verified conclusion.");
      if (job.ownerMuseBlocker) {
        job.state = "blocked"; job.summary = job.ownerMuseBlocker.message;
        job.history = [...(job.history || []), { at: new Date(now()).toISOString(), kind: "finish", state: "blocked", summary: job.summary }].slice(-20);
        if (job.codingParent) delegation.complete(job);
        else if (isAppJob(job)) ledger.notify(`finish:${job.id}:${job.rounds}`, `channel:${job.id}`, job.summary);
        ledger.audit("owner_muse_blocked", { job: job.id, capability: job.ownerMuseBlocker.capability }); ledger.save();
        return { state: "blocked", blocker: job.ownerMuseBlocker };
      }
      const state = input.state;
      if (["done", "dismissed"].includes(state) && require("./voiceturn").voiceRoot(d, job) && !require("./voiceturn").finalReplyQueued(d, job)) throw new Error("This voice turn needs its own reply. Call channel_reply with the answer or a specific blocker before finishing. An earlier turn's answer or a handoff acknowledgement does not count.");
      if (state === "done" && job.codingContract) await require("./edit-verify").createEditVerify({sandbox,ledger,now}).assertFresh(job,signal);
      if (state === "done" && job.resultSchema) validateArguments(input.result, job.resultSchema, "result");
      // Ticket 1757 (2026-11-03): a worker wrote and tested the bond-interest deduction, finished
      // done "left uncommitted for the supervisor", and housekeeping deleted the workspace with it.
      if (state === "done" && job.repository && !job.codingParent && !Object.values(d.actions || {}).some((a) => a.jobId === job.id && a.kind === "publish_patch" && a.state === "done")) {
        const dirty = await sandbox.run(job.id, "cd repo 2>/dev/null && git status --porcelain --untracked-files=normal | head -20", signal, { timeoutMs: 30000 }).catch(() => null);
        if (dirty?.code === 0 && String(dirty.output || "").trim()) throw new Error(`Not finished: the repository snapshot has unpublished changes (${String(dirty.output).trim().split("\n").slice(0, 4).map((l) => l.trim()).join("; ")}). Finishing done deletes them. No other agent will commit them for you: publish them now with publish_patch, which opens a PR and never merges or deploys. If the change is not wanted, revert it with shell (git checkout -- . && git clean -fd) and finish dismissed with the reason.`);
      }
      if (isAppJob(job) && ["done", "dismissed"].includes(state)) {
        const questionPending = appQuestions?.list(job.appThread || "main").some((q) => q.jobId === job.id && q.state === "pending");
        const approvalPending = Object.values(d.actions || {}).some((a) => a.jobId === job.id && ["pending", "executing"].includes(a.state)) || Object.values(d.decisions || {}).some((x) => x.jobId === job.id && x.state === "pending");
        const effectUncertain = Object.values(job.effects || {}).some((e) => e.state === "started");
        if (questionPending || approvalPending || effectUncertain) throw new Error("This app task has unresolved questions, approvals or action results. Preserve them and finish waiting or blocked; verify the result before reporting completion.");
      }
      if (developerTask(job) && ["done", "waiting", "blocked"].includes(state) && /offered (?:a |the )?patch|waiting for (?:her|his|their|your) (?:answer|reply).*patch|(?:ask|asking).*(?:whether|if).*(?:prepare|write|make).*(?:patch|fix)/i.test(input.summary || "") && !Object.values(d.actions).some(a => a.jobId === job.id && a.state === "pending")) throw new Error("Prepare the reviewable patch and focused validation now. Patch preparation already has developer authorization; use publish_patch for exact review before publication. Do not wait merely for permission to prepare it.");
      if (!["done", "waiting", "blocked", "dismissed"].includes(state)) throw new Error("invalid task state");
      // Keir 11.2 (closing.js): a ticket or finding waits only with a stated closing condition and what it waits on.
      // Fourth pass (review N7): the refusal has its own switch (KEIR_FINISH_NEEDS_CONDITION). Off or in preview the finish is
      // never refused (the condition is derived from the summary); preview records that it would have been.
      { const fg = ctl().gate("finishNeedsCondition"), pendingDecision = Object.values(d.decisions || {}).some((x) => x.state === "pending" && x.jobId === job.id);
        if (fg.run && !fg.act && closing.fromFinish(d, JSON.parse(JSON.stringify(job)), input, now(), { pendingDecision })) controlsLib.preview(d, "finish-condition", "would refuse finish", `job ${job.id}`, "finish without closesWhen and waitingOn", {}, now());
        const why = closing.fromFinish(d, job, input, now(), { pendingDecision, refuse: fg.act });
        if (why) { ledger.audit("closing_condition_refused", { job: job.id, ticket: job.ticket || null }); throw new Error(why); } }
      // Keir 8.3 (owner, 2026-11-05: "tickets just sitting"): tickets 1766, 1773 and 1774 filed an issue,
      // told the player the cause was not yet found, and parked on developer_reply for hours. While
      // Keir's own last word is "haven't found it", the cause is Keir's job: an investigator must be on it.
      if (state === "waiting" && input.waitFor === "developer_reply" && ticketOf(job)) {
        const tn = ticketOf(job), last = (d.ticketPosts?.[tn] || []).filter((p) => !isCardPost(p)).at(-1);
        const investigating = Object.values(d.jobs).some((j) => ticketOf(j) === tn && (j.investigations || []).some((id) => d.jobs[id] && !["done", "blocked", "dismissed", "cancelled"].includes(d.jobs[id].state)));
        if (last && isStall(last.text) && !investigating)
          throw new Error("Not finished: your last post told the player the cause is not found yet, and nobody is looking for it. A filed issue is not an investigation. Hand the question to an investigator (delegate_investigation) or keep reading the code and records yourself, then wait.");
      }
      // Ticket playbooks: a support ticket finishes done only with its required steps recorded.
      if (!developerTask(job) && !developerTicket(job) && !ownerDirected(job)) { const why = require("./playbooks").finishRefusal(job, d, state); if (why) throw new Error(why); }
      // KBX4 2026-11-02: a watch finding that an open issue already covers finished done with
      // nothing added, so the issue never learned it is still happening. Ask once.
      const citedIssue = /#(\d{3,6})\b/.exec(String(input.summary || ""))?.[1];
      if (state === "done" && job.kind === "finding" && citedIssue && !job.issueEvidenceAdded && !(job.raisedToDevelopers || []).length && !job.findingEvidenceAsked) {
        job.findingEvidenceAsked = true; ledger.save();
        throw new Error(`Not finished: open issue #${citedIssue} already covers this finding, but nothing from it was added there. Add this finding's new evidence (counts, users, versions, timing) with raise_to_developers issueNumber ${citedIssue}, then finish done. If it is noise, finish dismissed with the reason instead.`);
      }
      // Keir 10.2 (ticket 1837): the task finished "blocked on reading the build dialog in the next activation" after 3 minutes, then
      // "next investigator to read build dialog pricing", with no code read at all. A bug or data ticket whose finish names the read it
      // has not done must do that read now. Refused twice per activation; after that the finish goes through (never a loop).
      if (job.kind === "ticket" && job.ticket && !job.codingParent && ["bug", "data_repair", "outage"].includes(job.lane) && ["waiting", "blocked", "done"].includes(state)
          && require("./escalationbrief").namesUnfinishedWork(input.summary)
          && !(job.codeLookups || job.lastCodeReadAt && job.lastCodeReadAt >= (job.activationAt || job.lastRunStartedAt || 0))) {
        const rec = job.namedWorkRefusals = job.namedWorkRefusals?.at === job.lastRunStartedAt ? job.namedWorkRefusals : { at: job.lastRunStartedAt || 0, n: 0 };
        if (rec.n < 2) {
          rec.n += 1; ledger.save(); ledger.audit("named_work_finish_refused", { job: job.id, ticket: job.ticket, attempt: rec.n });
          throw new Error(`Not finished: your summary names work you have not done ("${clipText(input.summary, 160)}"). Do it now in this task, it is yours and not the next activation's or the owner's: read_tool ops-knowledge code_search (claimType mechanic, source dev) or code_exact for the symbol, then code_read the file that decides it, then post what the code shows. Escalate only with what you read and the specific thing that stopped you.`);
        }
      }
      // Waiting on the player needs a post they can answer. Models finished
      // "asked the player" after the question was refused, or never posted
      // one (replay 2026-10-19), leaving the player with nothing to answer.
      // Keir 10 (ticket 1812): a real answer posted since the player last wrote (by this or another task) settles it, so the
      // flag clears instead of holding the finish behind a refused extra post.
      if (job.replyRefusedPending && job.kind === "ticket" && job.ticket && playerAnswered(job.ticket, job)) { delete job.replyRefusedPending; ledger.save(); }
      if (["done", "waiting"].includes(state) && job.replyRefusedPending && job.kind === "ticket" && job.ticket && !job.codingParent) throw new Error(`Not finished: your last answer to the player was refused and nothing has been posted since, so they have no answer. Fix what the refusal named (at most five short sentences, only figures you read or calculated) and post it, then finish. ${budgetLine(postBudget(job))}`);
      // Keir 9 (replay 2026-11-12, audit finding 3): models found the answer and then finished waiting with nothing
      // posted. The obligation is per ticket and persists across tasks: while the reporter has had no real answer since
      // they last wrote (a holding line is not one), finishing done or waiting is refused twice. The third attempt
      // posts a plain limitation and escalates, then lets the task finish. Waits on a developer or the owner count too.
      // Only once something on the ticket has been read: an ordinary wait before any investigation is the wait
      // rules' business (the full suite on CI, 2026-11-13: five wait and handoff tests broke without this).
      if (["done", "waiting"].includes(state) && job.kind === "ticket" && job.ticket && !job.codingParent && !developerTask(job) && !developerTicket(job) && !ownerDirected(job)
          && !require("./ticketstate").endedReason(d, ticketOf(job), job)
          && Object.values(d.jobs).some((j) => ticketOf(j) === ticketOf(job) && (j.lastGameReadAt || j.lastCodeReadAt || j.replyAttemptRefusedAt))
          && process.env.KEIR_UNANSWERED_GUARD !== "0") {
        const tn = ticketOf(job), last = (d.ticketPosts?.[tn] || []).filter((p) => !isCardPost(p)).at(-1), human = humanAt(tn);
        // A holding line ("looking into it") is not an answer (Muse replay 2026-11-12: two tickets got only
        // "looking into it" and the task parked).
        // The code-written introduction ("Hi, I'm Keir, the support assistant ...") is not an answer either (Hydrogen replay, 2026-11-13:
        // a refused first answer, then a wait for the player behind the introduction alone).
        // Keir 9.0.4 (ticket 1829): one test for "is this post a holding line", used for the owed check and for the limitation
        // line. A real answer anywhere since the player last wrote means they are not owed one, whatever was posted after it.
        const holdingText = holdingPost;
        const holdingOnly = last && holdingText(last.text);
        // Keir 9.0.3 (live ticket, 2026-11-13): a real answer that ends "I will update you here once it is live" is not a
        // holding line; only a one-sentence post counts by that wording. The limitation line followed a real answer by a minute.
        // A wait for the player's own reply has its own, stricter "nothing posted" refusal below; only a holding line is added here.
        const realAnswered = human > 0 && ((d.ticketPosts?.[tn] || []).some((p) => !isCardPost(p) && p.at >= human && !holdingText(p.text)) || Boolean(d.lastSubstantive?.[tn] && d.lastSubstantive[tn].at >= human && !d.lastSubstantive[tn].holding));
        // Keir 10 (replay 2026-11-15): "Ok." after a real answer asked nothing; forcing a reply produced "Got it, glad that helped".
        const ackAfterAnswer = !realAnswered && human > 0 && ackOnly(lastHumanText(tn)) && (d.ticketPosts?.[tn] || []).some((p) => !isCardPost(p) && !holdingText(p.text));
        if (ackAfterAnswer) ledger.audit("ack_not_owed", { job: job.id, ticket: tn });
        const owed = !ackAfterAnswer && !realAnswered && human > 0 && (input.waitFor === "player_reply" ? Boolean(last && last.at >= human && holdingOnly) : (!last || human > last.at || holdingOnly));
        if (owed) {
          const all = (d.unansweredFinishes ||= {});
          let rec = all[tn];
          if (!rec || rec.humanAt !== human) rec = all[tn] = { humanAt: human, refused: 0 };
          if (rec.refused < 2) {
            rec.refused += 1; ledger.save();
            ledger.audit("unanswered_finish_refused", { job: job.id, ticket: tn, refusals: rec.refused });
            throw new Error("Not finished: the player has had no answer since they last wrote. Post what you found to them now (channel_reply, at most five short sentences, only what you read), or tell them plainly what you could not confirm, then finish. Waiting on the developers or the owner does not excuse a missing answer.");
          }
          // Keir 9.0.4 (ticket 1829): an answer attempt refused in the last 15 minutes means a reshaped answer is on its way
          // (the first draft was refused by the outgoing screen, the rewrite by pacing, then the limitation line went out).
          // Tell Keir to post it now, at most twice per player message; after that the limitation line is allowed.
          const recentRefusal = Object.values(d.jobs).some((j) => ticketOf(j) === tn && (j.replyAttemptRefusedAt || 0) > human && now() - j.replyAttemptRefusedAt < 15 * 60000);
          if (!rec.limitationPostedAt && recentRefusal && (rec.reshapeRefused || 0) < 2) {
            rec.reshapeRefused = (rec.reshapeRefused || 0) + 1; ledger.save();
            ledger.audit("unanswered_reshape_refused", { job: job.id, ticket: tn, refusals: rec.reshapeRefused });
            throw new Error("Not finished: an answer to the player was refused a few minutes ago and nothing has been posted since. Post your reshaped answer now, short and in the player's words, with no file or code names, then finish.");
          }
          if (!rec.limitationPostedAt) {
            // Third attempt: the code answers for the task so the player is never left with silence.
            let escalated = false;
            try {
              const r = await tool(job, "raise_to_developers", { kind: "question", title: `Ticket ${tn}: no confirmed answer for the player`, detail: escalationBrief(job, tn, input.summary), needsHuman: true, force: true }, signal);
              escalated = r?.raised === true;
            } catch { escalated = false; }
            // Keir 10.2: the player already has a reply since they last wrote (ticket 1837 got three in 20 seconds), so the code adds no fourth.
            const alreadyReplied = (d.ticketPosts?.[tn] || []).some((p) => !isCardPost(p) && !/^hi,? i(?:'|’)?m keir\b/i.test(String(p.text || "").trim()) && p.at >= human);
            rec.escalated = escalated;
            if (alreadyReplied) { rec.limitationPostedAt = now(); ledger.audit("unanswered_limitation_skipped", { job: job.id, ticket: tn, escalated }); ledger.save(); }
          }
          if (!rec.limitationPostedAt) {
            // Keir 10.1.14 (ticket 1836, 2026-11-17): "I've passed it to the developers" went out when nothing was filed for the open
            // question. It needs a developer-visible raise_to_developers receipt made for the player's current message.
            const receipt = standdown.currentQuestionReceipt(Object.values(d.jobs).filter((j) => ticketOf(j) === tn), human, { since: job.startedAt || 0 });
            let escalated = rec.escalated === true && Boolean(receipt);
            const message = standdown.limitationLine(escalated ? receipt : null);
            // No new player message and no state change since the last substantive post: nothing is posted, the finish is allowed.
            if (standdown.noNewRefusal({ last: d.lastSubstantive?.[tn], humanAt: human, fp: standdown.stateFingerprint(d, tn), message, now: now() })) {
              rec.limitationPostedAt = now(); ledger.audit("unanswered_limitation_skipped", { job: job.id, ticket: tn, escalated, why: "nothing_new" }); ledger.save();
            }
          }
          if (!rec.limitationPostedAt) {
            let escalated = rec.escalated === true;
            const receipt = standdown.currentQuestionReceipt(Object.values(d.jobs).filter((j) => ticketOf(j) === tn), human, { since: job.startedAt || 0 });
            escalated = escalated && Boolean(receipt);
            const message = standdown.limitationLine(escalated ? receipt : null);
            const args = { kind: "ticket", number: tn, message, deliver: true, update_kind: "progress", delivery_mode: "reply" };
            const sent = await effect(job, `ticket-update:${hash(args)}`, () => callSupport("support_public_update", args, true, signal), { kind: "reply", ticket: tn, text: message });
            const dl = sent?.delivery;
            const posted = dl?.posted === true || dl?.alreadyPosted === true || ["posted", "sent", "delivered", "already_posted"].includes(dl?.status) || dl?.delivery?.status === "posted";
            if (!posted) throw new Error("Not finished: the limitation message to the player was not confirmed as delivered. Retry the finish.");
            job.channelReplyQueued = true; job.lastPublishedAt = now(); recordTicketPost(job, tn, message);
            rec.limitationPostedAt = now(); rec.escalated = escalated;
            (job.history ||= []).push({ at: new Date(now()).toISOString(), kind: "unanswered_limitation", ticket: tn, escalated });
            ledger.audit("unanswered_limitation_posted", { job: job.id, ticket: tn, escalated }); ledger.save();
          }
        }
      }
      // An unrelated later post must not erase work Keir still owes. The
      // latest-message guard alone misses partial answers and saved promises.
      if (state === "waiting" && input.waitFor === "player_reply" && job.kind === "ticket" && job.ticket && !job.codingParent) {
        const summary = String(input.summary || "");
        const unfinished = /\b(?:unexplained|unchecked|untraced|unverified|unresolved|still (?:to )?(?:check|trace|investigate)|not yet (?:checked|traced|verified|explained))\b/i.test(summary);
        const promises = knowledge.ticketRecord(ledger, job.ticket).promises.filter(p => !p.closedAt);
        if (unfinished || promises.length) throw new Error("Not finished: unfinished investigation is still yours, not the player's. Complete the remaining check and answer it, or finish waiting without player_reply and with a short wakeup for your own work. Close a saved promise only after recording what fulfilled it.");
      }
      // Ticket 1759 (2026-11-03): "I am still checking what stopped the buying", then a six-hour
      // wait for the player. A promise of more work is not something the player can answer.
      if (state === "waiting" && input.waitFor === "player_reply" && job.kind === "ticket" && job.ticket && !(Number.isFinite(input.wakeAfterMinutes) && input.wakeAfterMinutes <= 30)) {
        const last = (d.ticketPosts?.[job.ticket] || []).filter((p) => p.jobId === job.id && p.at >= (job.startedAt || 0)).at(-1);
        if (last && !/\?/.test(last.text) && /\b(?:I am|I'm|I will|I'll)\s+(?:still\s+)?(?:checking|looking into|investigating|tracing|finding out|working out|come back|report back|check)\b|\bbefore I (?:say|give)\b/i.test(last.text))
          throw new Error("Not finished: you just told the player you are still checking something, so a wait for their reply would leave that promise hanging. Do the check now, or finish waiting with wakeAfterMinutes of 30 or less.");
      }
      // Keir 10 (replay 2026-11-15): three "Thanks." got three filler posts; a bare acknowledgement after a real answer owes nothing.
      const ackOwesNothing = job.kind === "ticket" && job.ticket && ackOnly(lastHumanText(ticketOf(job))) && (d.ticketPosts?.[ticketOf(job)] || []).some((p) => !isCardPost(p) && !holdingPost(p.text));
      if (state === "waiting" && input.waitFor === "player_reply" && job.kind === "ticket" && job.ticket && !job.codingParent && !outputBlocked(job) && !ackOwesNothing && ((job.lastAskAt || 0) < (job.lastPlayerAt || 0) || (!job.lastAskAt && !job.lastPublishedAt && (job.observedPlayerAt || 0) > 0))) throw new Error("Not finished: you are waiting for the player's reply, but nothing has been posted to them since they last wrote. If a post was refused, fix it and post it (support_action support_public_update, at most five short sentences), then finish again.");
      // Keir 5.6.2: one open question must not stall a ticket's other fixes.
      // Ticket 1577 (2026-10-16) waited six hours on "which page is the logo
      // on?" while three buildable display fixes sat paused on its card. The
      // check asks once per set of idle fixes, so a genuine wait still finishes.
      // Keyed on names only: re-noting or re-staging an item, as the refusal
      // asks, re-armed it (replay 2026-10-19: 49 runs, median 3 refusals).
      if (state === "waiting" && job.kind === "ticket" && !job.codingParent && job.ticket) {
        const items = d.statusCards?.[job.ticket]?.items || [];
        const working = Object.values(d.jobs).some((c) => c.codingParent === job.id && !JOB_TERMINAL.includes(c.state)) || Object.keys(job.ciWatch || {}).length > 0;
        const idle = items.filter((i) => !["main", "confirmed", "answered"].includes(i.stage) && (i.blocked || (!working && ["found", "written"].includes(i.stage))));
        const key = hash(idle.map((i) => i.name).sort());
        // KBX3: the review can ride on the finish itself (idleReason), saving the refused round.
        const reviewed = typeof input.idleReason === "string" && input.idleReason.trim().length >= 20;
        if (idle.length && reviewed) { job.idleItemsReview = key; (job.history ||= []).push({ at: new Date(now()).toISOString(), kind: "idle_review", items: idle.map((i) => i.name), reason: input.idleReason.trim().slice(0, 400) }); ledger.save(); }
        if (idle.length && job.idleItemsReview !== key) {
          job.idleItemsReview = key; ledger.save();
          throw new Error(`Not finished: your progress card has ${idle.length} fix${idle.length > 1 ? "es" : ""} not moving: ${idle.map((i) => `"${i.name}" (${i.blocked ? "paused" : i.stage})`).join("; ")}. A wait on one answer does not pause the others. For each one, either advance it now (investigate it, delegate_fix it, or carry its PR forward; display-only fixes need no developer), or, if it genuinely waits on something, make its card note name exactly what. Then finish again.`);
        }
      }
      if (state === "done" && job.kind === "command" && !job.ticket) {
        const request = [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter((s) => s?.authorId === job.actorId && ticketRequested(s.content)).at(-1);
        if (request && !Object.values(job.openedTickets || {}).some((r) => r.requestMessageId === request.messageId)) throw new Error("the authenticated ticket request is not fulfilled; open or attach its ticket, or retain it waiting with a concrete next step");
      }
      // A direct message from the owner or a developer always gets an answer in the channel,
      // even "nothing has changed". Ticket 1763 (2026-11-05): the owner asked for a resolution
      // check and the task finished twice with "nothing posted", which read as Keir ignoring him.
      if (["waiting", "done"].includes(state) && job.replyChannel && !job.appThread && !job.codingParent) {
        const staff = [config.ownerId, ...(config.staffIds || [])];
        // Ticket 1778 (2026-11-05): "sorry, i will unban and add a note" was the owner talking to the
        // player, not to Keir, and the forced reply narrated Keir's bookkeeping in the player's channel.
        // Only a message that names or mentions Keir, or asks a question, is owed an answer.
        // Only a message that names, mentions or replies to Keir is owed an answer; a bare "?" counts only in a ticket (Keir 8.4.2: mod chat chatter is not a question to Keir).
        const addressed = (m) => new RegExp(`<@!?${config.botId}>|\\b(?:keir|keith|starmer)\\b${job.kind === "ticket" ? "|\\?" : ""}`, "i").test(String(m.content || "")) || m.mentioned === true;
        const asked = [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter((m) => m && staff.includes(m.authorId) && addressed(m)).map((m) => Date.parse(m.at || "") || 0);
        const askedAt = asked.length ? Math.max(...asked) : 0;
        const published = typeof job.lastPublishedAt === "number" ? job.lastPublishedAt : Date.parse(job.lastPublishedAt || "") || 0;
        // Keir 8.4.2 (mod chat, 2026-11-06): the same addressed question was "owed" again after Keir had
        // answered it in the channel, because only job.lastPublishedAt counted. Keir's own row in the
        // channel record after the question also settles it, and a reply to that message never repeats.
        const channelRows = d.channelContext?.[job.channelId || job.replyChannel] || [];
        const repliedAt = Math.max(0, ...channelRows.filter((r) => r.role === "assistant" || r.authorId === config.botId).map((r) => Date.parse(r.at || "") || r.observedAt || 0));
        const answered = job.repliedToAddressedAt === askedAt || Math.max(repliedAt, job.channelRepliedAt || 0) >= askedAt;
        if (askedAt && published < askedAt && !answered && job.staffReplyOwed !== askedAt) {
          job.staffReplyOwed = askedAt; ledger.save();
          throw new Error("Not finished: the owner or a developer addressed you directly and you have not replied in the channel since. Reply with what you found and your next step, then finish again.");
        }
        if (askedAt && answered) job.repliedToAddressedAt = askedAt;
      }
      if (input.result !== undefined) {
        job.result = input.result;
        job.resultReceipt = { sha256: hash(input.result), at: now() };
        ledger.audit("structured_result", { job: job.id, ...job.resultReceipt });
      }
      conversationTurn.check(job);
      if (["done", "dismissed"].includes(state) && job.kind === "ticket" && !job.resolved && !job.channelClosed) {
        // The model can finish a turn, but unresolved tickets stay owned.
        // Keir 10.0.4 (ticket 1833, 2026-11-16): a finished ticket where Keir spoke last is answered,
        // even when the model never checkpointed finalAnswerDelivered. Without this the task woke every
        // 15 minutes for 12 hours (39 activations, two repeat posts) and never entered the closing grace.
        const ms = (v) => (typeof v === "number" ? v : Date.parse(v || "") || 0);
        const posted = ms(job.lastPublishedAt);
        const heard = Math.max(ms(job.observedPlayerAt), ms(job.lastPlayerAt));
        if (!job.resolutionReadyAt && posted && posted >= heard && !(job.inbox || []).length && !pendingHandoffs(job).length) {
          job.resolutionReadyAt = posted;
          ledger.audit("ticket_answer_inferred", { job: job.id, ticket: job.ticket, at: posted });
        }
        job.state = "waiting"; job.wakeAt = now() + (job.resolutionReadyAt ? 3600000 : 15 * 60000);
      } else if (state === "done" && pendingHandoffs(job).length && !job.resolved && !job.channelClosed) {
        // Filing a blocking question is not an accepted or completed handoff.
        job.state = "waiting"; job.wakeAt = now() + 6 * 3600000;
      } else { job.state = state; }
      job.summary = String(input.summary || "").slice(0, 4000);
      job.history = [...(job.history || []), { at: new Date(now()).toISOString(), kind: "finish", state, summary: job.summary }].slice(-20);
      // Once a ticket carries the work, this channel no longer holds the conversation.
      if (["done", "dismissed"].includes(state) && Object.keys(job.openedTickets || {}).length && d.conversations?.[job.channelId]?.actorId === job.actorId) delete d.conversations[job.channelId];
      if (job.inbox?.length && ["done", "waiting"].includes(state)) job.state = "queued";
      // Reply waits are event driven with a bounded safety check. Other waits
      // honor the requested interval; unresolved support work is not a reason
      // to rerun the model every fifteen minutes when nothing can change.
      const pendingQuestion = appQuestions?.list(job.appThread || "main").some((q) => q.jobId === job.id && q.state === "pending");
      const pendingDecision = Object.values(d.decisions || {}).some((x) => x.state === "pending" && x.jobId === job.id);
      // An action the owner approved but this task has not run yet is something to do, not
      // a reason to sleep: ticket 1749's approved bank repair (2026-11-02 22:05Z) was parked
      // for twelve hours behind a quiet developer wait after the player was told "after this turn".
      const subscription = job.turnWatch || Object.keys(job.ciWatch || {}).length || job.promotionHoldUntil > now() || pendingDecision || pendingQuestion || Object.values(d.actions || {}).some((a) => a.jobId === job.id && (["pending", "executing"].includes(a.state) || (a.state === "approved" && !(a.expiresAt <= now()))));
      // Keir 5.6: a developer_reply wait needs someone else to reply. Keir's
      // own cards have no other owner, so waiting on them stalls forever.
      const openCards = (job.raisedToDevelopers || []).filter((r) => r.blocking && !r.releasedAt);
      if (state === "waiting" && input.waitFor === "developer_reply" && openCards.length && openCards.every((r) => r.selfOwned))
        throw new Error("No developer owns an open item for this task: your filed questions are your own work items. Keep investigating with your read tools, or wait for the player instead.");
      // A filed bug report is not a handoff anybody answers (ticket 1749 woke every six hours on
      // an unassigned issue and told the player nothing had changed). With no blocking handoff
      // out, a developer_reply wait is a quiet wait: the interval grows, and the developer watch
      // or a player message wakes it early.
      const developerHandoff = openCards.some((r) => !r.selfOwned);
      const replyWait = state === "waiting" && ["player_reply", "developer_reply"].includes(input.waitFor) && !subscription;
      const quietDeveloperWait = replyWait && input.waitFor === "developer_reply" && !developerHandoff;
      const playerAt = (t) => (typeof t === "number" ? t : Date.parse(t) || 0);
      const owedAt = Math.max(playerAt(job.lastPlayerAt), playerAt(job.observedPlayerAt));
      delete job.waitingFor;
      if (state === "waiting") {
        const requested = input.wakeAfterMinutes;
        // A wait with nothing subscribed and no reply owed has nothing to
        // check. Tickets 1651 and 1663 re-read the same deployment every
        // fifteen minutes for hours (2026-10-23), so the interval escalates
        // and resets as soon as the player writes, the task posts or an
        // effect lands.
        const acted = Object.values(job.effects || {}).some((e) => (e.at || 0) >= (job.startedAt || 0));
        const stamp = `${owedAt}:${job.lastPublishedAt || 0}:${acted ? job.startedAt : 0}`;
        if (job.quietStamp !== stamp) { job.quietStamp = stamp; job.quietWaits = 0; }
        const quiet = (!subscription && !replyWait) || quietDeveloperWait;
        if (quiet) job.quietWaits = (job.quietWaits || 0) + 1;
        const minutes = quietDeveloperWait && !Number.isFinite(requested)
          ? DEVELOPER_QUIET_WAITS[Math.min(job.quietWaits - 1, DEVELOPER_QUIET_WAITS.length - 1)]
          : Number.isFinite(requested) ? requested : replyWait ? 360 : quiet ? QUIET_WAITS[Math.min(job.quietWaits - 1, QUIET_WAITS.length - 1)] : 15;
        job.wakeAt = now() + Math.max(1, Math.min(minutes, replyWait && !quietDeveloperWait ? 360 : 1440)) * 60000;
      }
      // A reply wait, long requested wait or vision run leaving the player unanswered hands back to
      // the driver instead of sleeping (ticket 1542 waited fifteen minutes).
      // Once per player message. Ticket 1643 (2026-10-23) re-ran every 89
      // seconds for hours: the model had decided the message needed no reply,
      // and this hand-back fired again on every wait.
      const owedOnce = state === "waiting" && ["ticket", "command", "conversation"].includes(job.kind) && owedAt > (job.lastPublishedAt || 0) && job.replyOx !== owedAt;
      if (owedOnce && (job.provider?.vision || replyWait || Number.isFinite(input.wakeAfterMinutes) && input.wakeAfterMinutes > 15)) { job.wakeAt = now() + 60000; job.replyOx = owedAt; }
      // A ticket waiting out its closure grace wakes when the grace ends.
      if (state === "waiting" && job.closeReadyAt > now() && job.wakeAt > job.closeReadyAt + 60000) job.wakeAt = job.closeReadyAt + 60000;
      // A promotion held for the owner's waking hours wakes when the window opens, not every quarter hour.
      if (state === "waiting" && job.promotionHoldUntil > now()) job.wakeAt = Math.max(job.wakeAt || 0, job.promotionHoldUntil);
      // Each wake that had nothing new to tell the owner doubles the next wait.
      if (state === "waiting" && job.appRepeats > 0 && job.wakeAt) job.wakeAt = now() + Math.min(1440 * 60000, (job.wakeAt - now()) * 2 ** Math.min(job.appRepeats, 6));
      // Turn and CI watches wake their task; no timer polling meanwhile.
      if (["waiting", "blocked"].includes(state) && job.turnWatch) job.wakeAt = Math.max(job.wakeAt || 0, now() + 8 * 3600000);
      if (job.state === "waiting" && pendingHandoffs(job).length && !(job.inbox?.length) && Math.max(playerAt(job.lastPlayerAt), playerAt(job.observedPlayerAt)) <= (job.lastPublishedAt || 0)) job.wakeAt = Math.max(job.wakeAt || 0, now() + 6 * 3600000);
      // 5.6.2: every blocker is an unclaimed handoff already past its one
      // overdue retry. Nothing changes until a developer or the player acts,
      // and both wake the task, so it sleeps until the owner's brief.
      if (job.state === "waiting" && parkedOnHandoffs(job) && !(job.inbox?.length) && Math.max(playerAt(job.lastPlayerAt), playerAt(job.observedPlayerAt)) <= (job.lastPublishedAt || 0)) {
        job.wakeAt = Math.max(job.wakeAt || 0, now() + 12 * 3600000); job.parkedForBrief = job.parkedForBrief || now();
      }
      // A task watching CI is woken by the watch, not by a timer.
      if (["waiting", "blocked"].includes(state) && job.ciWatch && Object.keys(job.ciWatch).length) job.wakeAt = Math.max(job.wakeAt || 0, now() + 3 * 3600000);
      // Back off approval-only polling, not a separate recorded investigation.
      const record = d.ticketRecords?.[job.ticket];
      const investigationOpen = ["questions", "promises"].some(kind => record?.[kind]?.some(item => !item.closedAt));
      if (!investigationOpen && ["waiting", "blocked"].includes(state) && Object.values(d.decisions || {}).some((x) => x.state === "pending" && x.jobId === job.id)) job.wakeAt = Math.max(job.wakeAt || 0, now() + 6 * 3600000);
      if (["waiting", "blocked"].includes(state) && pendingQuestion) job.wakeAt = Math.max(job.wakeAt || 0, now() + 6 * 3600000);
      // While a developer's own task holds this ticket, the ticket task only
      // comes back in half an hour (or sooner if the player writes); it was
      // waking every minute to be refused (ticket 1518).
      if (job.kind === "ticket" && ["waiting", "done", "dismissed"].includes(state) && Object.values(d.jobs).some((j) => j.id !== job.id && j.kind === "command" && j.ticket === job.ticket && [config.ownerId, ...config.staffIds].includes(j.actorId) && !JOB_TERMINAL.includes(j.state) && humanAt(job.ticket) <= (Date.parse(j.source?.at || "") || now()))) job.wakeAt = Math.max(job.wakeAt || 0, now() + 30 * 60000);
      // Claimed automatic tickets stay dormant; only the claiming developer's
      // own command may continue their work. Never turn a model "done" into
      // another scheduled investigation of the same staff-owned ticket.
      if (job.kind === "ticket" && job.role !== "owner" && d.channels[job.channelId]?.claimedBy) {
        job.state = "deferred"; job.deferredBy = "claim"; delete job.wakeAt; delete job.ciWatch; delete job.turnWatch;
      }
      if (job.codingParent) { delegation.complete(job); ledger.save(); return { state: job.state }; }
      // Keir 8.5.1 (ticket 1785): an activation that ends with the cause still unverified (an open question card of
      // his own, or a summary that says so) hands the investigation to a worker now, not at the sweeper's six hours.
      if (job.kind === "ticket" && job.ticket && ["waiting", "blocked"].includes(job.state) && input.waitFor !== "player_reply") {
        const cw = codingWorkers();
        if (cw?.dispatchInvestigation) {
          try {
            const out = await cw.dispatchInvestigation({ job, reason: "the task ended its activation with the cause still unverified" });
            if (!out.skipped) ledger.audit("investigation_dispatched", { job: job.id, ticket: job.ticket, run: out.run.id });
          } catch (e) { ledger.audit("investigation_dispatch_failed", { job: job.id, ticket: job.ticket, error: String(e.message).slice(0, 160) }); }
        }
      }
      if (!["waiting", "blocked"].includes(job.state)) withdrawDecisions(ledger, job.id, `task finished ${job.state}`);
      if (replyWait && job.state === "waiting" && !(job.inbox?.length) && Math.max(playerAt(job.lastPlayerAt), playerAt(job.observedPlayerAt)) <= (job.lastPublishedAt || 0)) {
        job.waitingFor = { kind: input.waitFor, since: now(), deadline: job.wakeAt };
        ledger.audit("reply_wait", { job: job.id, ticket: job.ticket || null, waitFor: input.waitFor, deadline: job.wakeAt });
      }
      if (job.state === "deferred") {
        withdrawDecisions(ledger, job.id, "staff owns this ticket");
        ledger.audit("checkpoint", { job: job.id, state: job.state }); ledger.save(); return { state: job.state };
      }
      // Only a real owner decision pages the owner. Other blockers stay with the
      // developer who asked, or wait quietly for new evidence on automatic work.
      if (state === "blocked" && !input.needsOwner) {
        if (job.kind === "command" && job.actorId !== config.ownerId) {
          if (!job.channelReplyQueued) {
            const safe = await finishPublicText(job);
            if (safe || !ticketOf(job)) ledger.notify(`finish:${job.id}:${job.rounds}`, safe ? `channel:${job.id}` : job.actorId, safe || job.summary);
          }
        } else if (job.kind === "command" && !job.channelReplyQueued && !job.internalProbe) {
          // Keir 6.1: the owner's own request that ends blocked said nothing back
          // (KBX3 owner-merge-red: "merge it" against a red check went silent).
          const safe = await finishPublicText(job);
          if (safe) ledger.notify(`finish:${job.id}:${job.rounds}`, `channel:${job.id}`, safe);
        } else if (job.kind !== "command") { job.state = "waiting"; job.wakeAt = now() + (pendingHandoffs(job).length ? 6 : 1) * 3600000; }
      } else if (state === "waiting" && job.kind === "command" && job.role === "owner" && job.actorId === config.ownerId && !job.channelReplyQueued && !job.internalProbe && !pendingDecision) {
        // KBX4 2026-11-02: "merge N" with checks still running finished waiting on a watch and
        // said nothing, so the owner could not tell it was handled. Say what it waits on, once.
        const safe = await finishPublicText(job);
        if (safe) { job.channelReplyQueued = true; ledger.notify(`finish:${job.id}:${job.rounds}`, `channel:${job.id}`, safe); }
      } else if (!job.internalProbe && job.role !== "player" && ((state === "done" && !job.channelReplyQueued) || state === "blocked")) {
        const safe = job.role === "owner" && !job.channelReplyQueued ? await finishPublicText(job) : null;
        if (safe) { ledger.notify(`finish:${job.id}:${job.rounds}`, `channel:${job.id}`, safe); settleClosing(); ledger.audit("checkpoint", { job: job.id, state: job.state }); ledger.save(); return { state: job.state }; }
        // Tasks born from replies to Keir's old approval DMs report in the digest, not by DM.
        const to = job.noOwnerDm ? null : job.role === "owner" && job.replyChannel ? null : job.kind === "command" && job.role !== "owner" ? job.actorId : job.replyChannel && state !== "blocked" ? null : "owner";
        // Automatic and ticket work never DMs the owner; it raises a quiet alert.
        // A genuine owner decision is a DM with Approve / Reject / Explain buttons.
        if (to === "owner" && state === "blocked" && pendingDecision) { settleClosing(); ledger.save(); return {state: job.state}; }
        if (to === "owner" && state === "blocked") {
          // Keir 5.1.1: when the question is about one of this task's own PRs,
          // the yes binds to that PR's current head (chain consent can use it).
          const own = new Set((job.pullRequests || []).map((u) => Number(/\/(?:Egg3901|lakesidegamedev)\/AHDGame\/pull\/(\d+)$/.exec(u)?.[1])).filter(Boolean));
          const named = [...new Set([...String(job.summary || "").matchAll(/(?:#|\/pull\/|\bPR\s*)(\d{3,6})\b/gi)].map((m) => Number(m[1])))].filter((n) => own.has(n));
          let binds = null;
          if (named.length === 1) {
            const pr = await exec("/usr/bin/gh", ["api", `repos/${GITHUB_OWNER}/AHDGame/pulls/${named[0]}`], { timeout: 30000 }).then((o) => JSON.parse(o || "null")).catch(() => null);
            if (pr?.state === "open" && pr.head?.sha) binds = { number: named[0], head: pr.head.sha };
          }
          const prefix = job.ticket && !String(job.summary || "").startsWith(`Ticket ${job.ticket}`) ? `Ticket ${job.ticket}: ` : "";
          if (!binds) throw new Error("An owner choice needs named options: use present_choices or raise_to_developers kind decision with options. For execution approval, request the exact action first.");
          openDecision(ledger, config, { jobId: job.id, binds, question: `${prefix}${job.summary}${binds ? `\n\nApproving covers PR ${binds.number} at ${binds.head.slice(0, 10)} and its promotions; a later change asks again.` : ""}` });
        }
        else if (to && !(to === "owner" && job.kind !== "command")) ledger.notify(`finish:${job.id}:${job.rounds}`, to, job.summary);
      }
      settleClosing();
      ledger.audit("checkpoint", { job: job.id, state: job.state }); ledger.save(); return { state: job.state };
    }
    throw new Error("unknown broker tool");
  }
  // Keir 4.0: decisive incident matches merge before the model runs.
  async function incidentPrecheck(job, signal) {
    const open = await incidents.openIncidents(mcp, { now: now(), signal });
    if (!open.length) return null;
    const m = await (config.matchIncident || incidents.matchIncident)({ job, incidents: open });
    ledger.audit("incident_checked", { job: job.id, ticket: job.ticket, open: open.length, best: m.best, candidates: m.candidates.map((c) => [c.number, Number(c.p.toFixed(2))]) });
    if (!m.best) return { candidates: m.candidates };
    await incidents.mergeIntoIncident({ mcp, ledger, job, target: m.best.number, reason: `same problem as incident #${m.best.number} (matched ${Math.round(m.best.p * 100)}%)`, by: "keir", signal });
    return { merged: true, target: m.best.number };
  }
  // Keir 4.2 backstop: hourly, every merged Keir PR from the last two weeks
  // is checked with github where, which closes the open issues it references
  // once live. Issues still close when no task asks where after shipping.
  // Keir 5.1: Keir issues whose findings share a root cause collapse into the
  // lowest-numbered one; the rest are closed with a pointer to it.
  async function closeDuplicateIssues(job) {
    if (!watch) return [];
    const groups = new Map();
    for (const x of Object.values(d.keirIssues || {})) {
      if (x.state !== "open" || !x.jobId) continue;
      const f = watch.findingByJob(x.jobId);
      const root = f && watch.rootOf(f.fp);
      if (!root) continue;
      groups.set(root.fp, [...(groups.get(root.fp) || []), x.number]);
    }
    const closed = [];
    for (const [rootFp, numbers] of groups) {
      const sorted = [...new Set(numbers)].sort((a, b) => a - b);
      if (sorted.length < 2) continue;
      const canonical = sorted[0];
      const root = watch.rootOf(rootFp); if (root) root.issue = canonical;
      for (const number of sorted.slice(1)) {
        const gh = (args) => exec("/usr/bin/gh", ["api", ...args], isKeirWrite(args) ? asKeir({ timeout: 60000 }) : { timeout: 60000 }).then((o) => JSON.parse(o || "null"));
        const issue = await gh([`repos/${GITHUB_OWNER}/AHDGame/issues/${number}`]).catch(() => null);
        if (issue && issue.state === "open" && !issue.pull_request) {
          await commentOnce(job, `close-duplicate-comment:${number}:${canonical}`, gh, `repos/${GITHUB_OWNER}/AHDGame/issues/${number}`, `<!-- keir:duplicate:${number}:${canonical} -->`,
            (marker) => gh(["-X", "POST", `repos/${GITHUB_OWNER}/AHDGame/issues/${number}/comments`, "-f", `body=Same root cause as #${canonical}, which tracks the fix. Closing this one as a duplicate.\n\n${marker}`]));
          await effect(job, `close-duplicate:${number}:${canonical}`, () => gh(["-X", "PATCH", `repos/${GITHUB_OWNER}/AHDGame/issues/${number}`, "-f", "state=closed", "-f", "state_reason=not_planned"]));
        }
        if (!issue || issue.state !== "open" || job.effects?.[`close-duplicate:${number}:${canonical}`]?.state === "done") {
          d.keirIssues[number].state = "closed"; d.keirIssues[number].closedAt = now(); d.keirIssues[number].duplicateOf = canonical;
          ledger.audit("issue_closed_duplicate", { issue: number, canonical, root: rootFp });
          closed.push(number);
        }
      }
    }
    ledger.save();
    return closed;
  }
  async function issueSweep() {
    const open = Object.values(d.keirIssues || {}).filter((x) => x.state === "open");
    if (!open.length || d.paused) return { checked: 0 };
    if (watch && open.length > 1) {
      const dupJob = ledger.createJob(`issue-dedupe:${Math.floor(now() / 3600000)}`, { kind: "command", role: "support", internalProbe: true, repository: "AHDGame", deadline: now() + 15 * 60000, source: {} });
      dupJob.state = "running"; ledger.save();
      try { await closeDuplicateIssues(dupJob); dupJob.state = "done"; dupJob.summary = "Duplicate issue sweep."; }
      catch (e) { dupJob.state = "blocked"; dupJob.summary = String(e.message).slice(0, 300); }
      ledger.save();
    }
    const done = (d.issueSweepDone ||= {});
    // Keir 5.1.1: a fix from any author counts. Merged PRs that cross-reference
    // an open Keir issue join the sweep, not only PRs Keir opened.
    const referencing = [];
    for (const x of open.slice(0, 20)) {
      const events = await exec("/usr/bin/gh", ["api", `repos/${GITHUB_OWNER}/AHDGame/issues/${x.number}/timeline?per_page=100`], { timeout: 30000 }).then((o) => JSON.parse(o || "[]")).catch(() => []);
      for (const e of Array.isArray(events) ? events : []) {
        const src = e?.event === "cross-referenced" ? e.source?.issue : null;
        if (src?.pull_request?.merged_at && (!src.repository || canonicalRepository(src.repository.full_name) === GAME_REPO)) referencing.push(src.number);
      }
    }
    const pending = [...new Set([...Object.values(d.jobs).flatMap((j) => j.pullRequests || []).filter((u) => /\/(?:Egg3901|lakesidegamedev)\/AHDGame\/pull\/\d+$/.test(u)).map((u) => Number(/(\d+)$/.exec(u)[1])), ...referencing])].filter((n) => !done[n]).sort((a, b) => a - b);
    const cursor = d.issueSweepCursor || 0;
    const prs = [...pending.filter((n) => n > cursor), ...pending.filter((n) => n <= cursor)].slice(0, 25);
    if (!prs.length) return { checked: 0 };
    const job = ledger.createJob(`issue-sweep:${Math.floor(now() / 3600000)}`, { kind: "command", role: "support", internalProbe: true, repository: "AHDGame", deadline: now() + 15 * 60000, source: {} });
    job.state = "running"; ledger.save();
    let checked = 0;
    try {
      for (const number of prs) {
        const out = await toolInner(job, "github", { action: "where", number, repository: "AHDGame" }).catch(() => null);
        checked++;
        d.issueSweepCursor = number;
        if (out?.fixLive === true) done[number] = now();
      }
      for (const k of Object.keys(done)) if (now() - done[k] > 30 * 86400000) delete done[k];
      job.state = "done"; job.summary = `Issue sweep checked ${checked} PRs.`;
    } catch (e) { job.state = "blocked"; job.summary = String(e.message).slice(0, 300); }
    ledger.save();
    return { checked };
  }
  let watch = null;
  return { ticketCommandAllowed: (job) => !ticketCommands.refusal(job), askHealthRefresh: () => w3.refreshAskHealth(), turnStatus: () => w3.turnStatus(), resolveReporter: (job, signal) => w3.resolveIdentity(job, signal), postBudget, draftCheck, pageCheckAfterTurn: (job) => { const n = ticketOf(job); return n ? pageCheck(n).catch(() => null) : Promise.resolve(null); }, warmReadyReads: () => config.readyReads === false ? Promise.resolve(0) : readyReads.warm(mcp.servers()), readyReads: (job) => config.readyReads === false ? Promise.resolve([]) : readyReads.pick(job, { servers: readServers(job) }).catch(() => []), readable, caseRead: (tool, args, signal) => { if (!/^support_(?:search|list)$/.test(tool)) throw new Error("case lookup reads support search and list only"); return mcp.call("support", tool, args, false, signal); }, recentImages: (job) => conversation?.recentImages?.(job) || [], voiceReads: (job, signal) => require("./voiceturn").voiceRoot(d, job) ? require("./voiceturn").readSchemas(mcp, signal) : Promise.resolve([]), supportDirective: supportDirectives.send, supportDirectiveTick: supportDirectives.tick, supportDirectiveHeld: supportDirectives.held, setWatch: (w) => { watch = w; }, issueSweep, closeDuplicateIssues, reporterOf, notebook, tool, active, incidentPrecheck, relatedPrecheck: (job, signal) => surge.checkTicket(job, signal), sharedAnswerPrecheck, sharedAnswerContext: (ticket) => { const k = d.sharedAnswers?.[ticket]; return k ? sharedAnswer.contextFor({ ticket: k.from, answer: k.answer, why: k.why }) : undefined; }, surgeTick: () => surge.tick(), proposeIncident: (p) => surge.propose(p), chatterTick: () => surge.chatterTick(), adminStatusCard, instantCard, advanceCardStage, liveNotice, stageTick, promiseFallback, codingComplete: delegation.complete, delegationTick: delegation.tick, waitingUpdate, supportAuthority, effect, ticketWork, servers: readServers, appContext: (job) => job.role === "owner" ? { ...appMuse()?.context(job), sharedWork: sharedWork() } : undefined, context: (job) => {
      const root = require("./appcontrols").rootOf(d, job);
      return isAppJob(root) && appChannel ? { channelId: "app", thread: root.appThread || "main", evidenceOnly: true,
        attachments: (root.appAttachments || []).map((a, index) => ({ index, name: a.name, type: a.type, sourceMessageId: a.messageId })),
        messages: appChannel.history(30, root.appThread || "main") } : conversation?.snapshot(job);
    }, progress: (job) => conversation?.progress(job) || [] };
}
function problemReport(text) { return /\b(bug|broken|error|crash|missing|disappeared|stuck|failed|not loading|not working|lost my|won't load|doesn't work|cannot|can't)\b/i.test(text || ""); }
module.exports = { outsideScopeMessage, mapSnapshotScopeCheck, nearCollections, TYPED_READS, SUPPORT_READS, FINDING_READS, PLAYER_PRIVATE, coerceArgs, oidFilter, hexIdFilter, outcomeClaims, similarity, localMcpUrl, validateArguments, validationRejected, createBroker, createMcp, QUICK_TOOLS, hash, parseRpc, run, rawReadArgs, redactRaw, META_SUMMARY };
