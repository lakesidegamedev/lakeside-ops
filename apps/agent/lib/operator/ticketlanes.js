"use strict";
// Keir 10 ticket lanes. A ticket is routed to ONE lane before the model runs, and
// the lane decides which playbook it follows, how large its context is, which
// read tools are offered up front and what counts as finished. The router is
// deterministic code over intake tags, the channel category, the player's words,
// incident candidates and (for "the turn is stuck" tickets) a live turn check.
// This module is named ticketlanes.js because lanes.js already holds the
// admission lanes (execution slots), a different idea.
//
// The old playbook kinds map onto lanes like this: mechanics_question -> question,
// bug_report -> bug, data_repair -> data_repair, incident_candidate and turn
// trouble -> outage, moderation and account trouble -> people, design_feedback and
// feature_request -> idea, gameplay_advice -> advice.

const HOUR = 3600000;

const LANES = Object.freeze({
  question: {
    playbook: "question", maxRounds: 10, fullFirst: false, skills: false,
    extraSections: [], directTools: ["open_ticket", "raise_to_developers"],
    readServers: ["ops-knowledge", "gamestate", "support"],
    exit: "Every question the player asked is answered or redirected, from game knowledge and the code. No progress card and no owner decision unless a real defect turned up; then it is spun out as its own ticket.",
  },
  bug: {
    playbook: "bug_report", maxRounds: 16, fullFirst: true, skills: true,
    extraSections: ["Ticket progress card", "Investigation and delegated coding", "Heals and approvals", "Developer handoffs"], directTools: ["status_card", "raise_to_developers", "merge_into_incident", "github", "delegate_fix", "publish_patch"],
    readServers: null,
    exit: "The cause is found from live data and code and the player is told it, and the defect is raised, merged into an incident, fixed or ruled out.",
  },
  data_repair: {
    playbook: "data_repair", maxRounds: 16, fullFirst: true, skills: true,
    extraSections: ["Ticket progress card", "Heals and approvals", "Developer handoffs"], directTools: ["status_card", "raise_to_developers", "request_heal", "request_action"],
    readServers: null,
    exit: "The loss is verified from the ledger, a repair is proposed for the owner to approve, the cause is raised, and the player knows where it stands. No money is promised.",
  },
  outage: {
    playbook: "outage", maxRounds: 12, fullFirst: true, skills: true,
    extraSections: ["Ticket progress card", "Developer handoffs"], directTools: ["status_card", "raise_to_developers", "merge_into_incident", "watch_turn"],
    readServers: ["turndiag", "engine", "gamestate", "railway", "support", "ops-knowledge"],
    exit: "The live turn state is read, the report is attached to the one incident (or a new one is opened), and the player is told what is known and when they will hear next. Reporter records are not needed.",
  },
  people: {
    playbook: "people", maxRounds: 10, fullFirst: false, skills: false,
    extraSections: ["Recovery and privacy"], directTools: ["support_action", "raise_to_developers"],
    readServers: ["support", "gamestate", "ops-knowledge"],
    exit: "The account, moderation or recovery case is checked against the support record and the player is told the outcome or the next step. Decisions that belong to staff go to staff, not to a guess.",
  },
  idea: {
    playbook: "idea", maxRounds: 8, fullFirst: false, skills: false,
    extraSections: ["Developer handoffs"], directTools: ["open_suggestion", "raise_to_developers"],
    readServers: ["ops-knowledge", "gamestate", "support"],
    exit: "How it works today is explained, a real proposal is recorded for the developers, and the player is thanked and told what happens to it.",
  },
  advice: {
    playbook: "gameplay_advice", maxRounds: 4, fullFirst: false, skills: false,
    extraSections: [], directTools: [],
    readServers: [],
    exit: "The short Ask redirect is sent. Any separately verified broken screen is handled as bug work.",
  },
});
const LANE_IDS = Object.freeze(Object.keys(LANES));

const PLAYBOOK_LANE = { mechanics_question: "question", bug_report: "bug", data_repair: "data_repair", incident_candidate: "outage", design_feedback: "idea", feature_request: "idea", gameplay_advice: "advice" };

// A ticket about the turn itself: not advancing, stuck, overdue.
const TURN_TEXT = /\bturn\b[\s\S]{0,80}\b(?:stuck|frozen|overdue|late|processing|not\s+(?:advanc|process|run|mov|tick|happen)|(?:has|have|had|is|are|does|did)(?:n.?t|\s+not)\s+(?:advanc|process|run|mov|tick|happen)|hasn.?t\s+(?:advanc|process|run|mov))|\b(?:stuck|frozen|overdue)\b[\s\S]{0,40}\bturn\b|\bturn\s*\d+\b[\s\S]{0,30}\boverdue\b|\bgame\b[\s\S]{0,40}\b(?:frozen|down|not\s+updating)\b/i;
const PEOPLE_TEXT = /\b(?:ban(?:ned)?|unban|appeal|suspend(?:ed)?|locked\s+out|account\s+recovery|recover(?:y)?\s+(?:my\s+)?account|hacked|password\s+reset|can.?t\s+log\s*in|cannot\s+log\s*in|harass(?:ment|ing|ed)?|cheat(?:ing|er)|report(?:ing)?\s+(?:a\s+)?player|multi.?account|alt\s+account)\b/i;

// A how-to or where-is question with no symptom of something broken. Players often file these in the bug channel
// (replay 2026-11-15: "Where can I see how much tax my company owes" went to the full bug lane).
const HOWTO_TEXT = /^\s*(?:how (?:do|can|should|would) (?:i|we|you)|how to|where (?:do|can|is|are|would) (?:i|we|you|the|my)?|what (?:does|do|is|are) (?:a |an |the )?\w+|what's|which (?:unit|branch|office|page|tab|button)|can i\b|is there (?:a|any) way|is it possible|is it better|should i\b|what(?:'s| is) the best|which is (?:better|best)|why (?:can't|cannot|don't|doesn't) i see)/im;
const SYMPTOM_TEXT = /\b(?:bug|broken|error|crash\w*|glitch\w*|stuck|frozen|wrong|incorrect|missing|disappear\w*|vanish\w*|not (?:working|showing|loading|saving|updating)|doesn'?t (?:work|show|load|save|update)|won'?t (?:work|load|let)|can'?t (?:click|load|open|save)|keeps? (?:failing|resetting)|lost|charged|double|negative|nan|undefined|refund)\b/i;
const latest = (job) => [job.source, ...[...(job.requestInbox || []), ...(job.inbox || [])].filter((m) => m && m.role !== "system")].filter(Boolean);
const textOf = (job) => [job.source?.title, ...latest(job).slice(-4).map((m) => m.content)].filter(Boolean).join("\n").slice(0, 4000);

// Is the engine's turn overdue or its lock stale? live comes from gatherLive.
function turnTrouble(live) {
  if (!live || live.error) return null;
  const lock = live.lock || {}, turns = Array.isArray(live.turns) ? live.turns : [];
  const verdict = String(lock.verdict || "");
  if (/stale|stuck|overdue|dead|hung|wedged/i.test(verdict)) return `the turn lock reports "${verdict}"`;
  if (Number(lock.overdueMin) >= 10) return `the turn is ${Math.round(lock.overdueMin)} minutes overdue`;
  if (lock.isProcessing && Number(lock.heartbeatAgeSec) > 300) return `the turn lock heartbeat is ${Math.round(lock.heartbeatAgeSec)} seconds old`;
  if (lock.isProcessing && Number(lock.runningMin) > 30) return `the turn has been processing for ${Math.round(lock.runningMin)} minutes`;
  if (turns[0] && turns[0].success === false) return `the latest turn (${turns[0].turn}) failed`;
  return null;
}

// The deterministic router. route(job, data, live) -> { lane, reason, signals }.
function route(job, d = {}, live = null) {
  const tag = job.tags?.kind, cat = d.channels?.[job.channelId || job.replyChannel]?.category, text = textOf(job);
  const out = (lane, reason) => ({ lane, reason, signals: { tag: tag || null, category: cat || null, turnText: TURN_TEXT.test(text), live: live ? (live.error ? "unavailable" : turnTrouble(live) ? "trouble" : "healthy") : "not checked" } });
  const advice = require("./advicerouting");
  if (advice.bugFollowup(job)) return out("bug", "a broken-screen follow-up on an advice ticket");
  if (advice.requiresRedirect(job, d)) return out("advice", "strategy or investment advice belongs in Ask");
  if (TURN_TEXT.test(text)) {
    const trouble = turnTrouble(live);
    if (trouble) return out("outage", `the ticket is about the turn and ${trouble}`);
    if (!live || live.error) { if (job.tags?.urgency === "outage" || job.incidentCandidates?.length) return out("outage", "the ticket is about the turn, the live check was unavailable and intake tagged it an outage"); }
    else if (!(job.incidentCandidates?.length)) return out(tag === "mechanics_question" ? "question" : "bug", "the ticket is about the turn but the live turn check is healthy");
  }
  if (job.incidentCandidates?.length && tag !== "mechanics_question") return out("outage", "it may be the same problem as an open incident");
  if (job.tags?.urgency === "outage" && tag !== "mechanics_question" && !["moderation"].includes(tag)) return out("outage", "intake tagged it an outage");
  if (tag === "moderation" || ["moderation", "investigation", "account", "appeal"].includes(cat)) return out("people", "moderation or account matter");
  if (tag !== "data_repair" && PEOPLE_TEXT.test(text) && !["bug_report"].includes(tag)) return out("people", "the ticket is about an account, ban or conduct matter");
  if (tag === "data_repair") return out("data_repair", "someone asks for live data to be corrected");
  if (tag !== "bug_report" && HOWTO_TEXT.test(text) && !SYMPTOM_TEXT.test(text)) return out("question", "a how-to or where-is question that reports nothing broken");
  if (tag === "bug_report" || cat === "bug") return out("bug", cat === "bug" && tag !== "bug_report" ? "bug channel" : "intake tagged it a bug");
  if (["design_feedback", "feature_request"].includes(tag)) return out("idea", "an idea or design argument");
  if (tag === "mechanics_question" || cat === "mechanics" || cat === "gameplay" || cat === "question") return out("question", tag === "mechanics_question" ? "intake tagged it a how-to question" : "mechanics channel");
  if (tag === "gameplay_advice") return out("advice", "intake tagged it gameplay advice");
  if (PEOPLE_TEXT.test(text)) return out("people", "the ticket is about an account, ban or conduct matter");
  return { ...out("bug", "no clear signal, so the full investigation lane"), defaulted: true };
}

// Record the lane on the job. A lane changes later only with an explicit reason,
// which is kept in job.laneHistory. Returns the lane.
function assign(job, decision, { at = Date.now() } = {}) {
  if (!LANES[decision.lane]) throw new Error(`unknown lane ${decision.lane}`);
  if (job.lane === decision.lane) return job.lane;
  const entry = { at, from: job.lane || null, to: decision.lane, reason: String(decision.reason || "").slice(0, 200) };
  job.laneHistory = [...(job.laneHistory || []), entry].slice(-10);
  job.lane = decision.lane; job.laneReason = entry.reason; job.laneAt = at;
  // A lane chosen only as the fallback gets the full context but no lane playbook gate.
  if (decision.defaulted) job.laneDefaulted = true; else delete job.laneDefaulted;
  return job.lane;
}
// A later move: refused without a reason.
function change(job, lane, reason, opts) {
  if (!String(reason || "").trim()) throw new Error("a lane change needs a reason");
  return assign(job, { lane, reason }, opts);
}

const laneOf = (job) => (job.lane && LANES[job.lane] ? job.lane : null);
const def = (job) => LANES[laneOf(job)] || null;
const isTicketJob = (job) => job.kind === "ticket" && Boolean(job.ticket) && !job.codingParent && job.role !== "player" && job.role !== "owner" && !job.internalProbe;

// A short live check: the turn lock and the recent turns. call(server, tool, args)
// resolves to the parsed read. Anything slow or broken leaves { error }.
async function gatherLive(call, { timeoutMs = 4000 } = {}) {
  const guarded = (p) => { let timer; const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), timeoutMs); }); return Promise.race([Promise.resolve().then(p), late]).finally(() => clearTimeout(timer)); };
  const [lock, turns] = await Promise.allSettled([guarded(() => call("turndiag", "lock_status", {})), guarded(() => call("engine", "recent_turns", {}))]);
  const parse = (v) => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } } return v?.content && typeof v.content === "string" ? parse(v.content) : v; };
  const out = { lock: lock.status === "fulfilled" ? parse(lock.value) : null, turns: turns.status === "fulfilled" ? parse(turns.value) : null };
  if (!out.lock && !out.turns) return { error: String(lock.reason?.message || turns.reason?.message || "unreadable").slice(0, 120) };
  if (!Array.isArray(out.turns)) out.turns = Array.isArray(out.turns?.turns) ? out.turns.turns : [];
  return out;
}

// Wake-time review, deterministic: a hint that the lane should change, never a silent move.
function rethink(job, d, live) {
  if (!laneOf(job)) return null;
  const next = route(job, d, live);
  return next.lane !== job.lane ? next : null;
}

// Soft limit for a question lane: eight player questions or a day in one ticket.
const QUESTION_LIMIT = Object.freeze({ messages: 8, ms: 24 * HOUR });
function questionLimit(job, now = Date.now()) {
  if (job.lane !== "question") return null;
  const humans = [job.source, ...(job.requestInbox || []), ...(job.playerMessages || [])].filter((m) => m && !["system", "assistant"].includes(m.role) && !m.investigationResult && !m.codingResult);
  const count = Math.max(job.playerMessageCount || 0, new Set(humans.map((m) => m.messageId || m.content)).size);
  const age = now - (Date.parse(job.source?.at || "") || job.at || now);
  if (count < QUESTION_LIMIT.messages && age < QUESTION_LIMIT.ms) return null;
  return { questions: count, hours: Math.round(age / HOUR), instruction: "This ticket has run long (eight questions or a day). Answer what is open now and close it. For anything new, tell the player to open a fresh ticket, or open one yourself with open_ticket. Do not start new investigations here." };
}

// The compact ticket brief: the core brief, the lane's extra sections from the full
// manual, and a short lane block. Everything else stays loadable (load_context).
function laneBrief(job, briefText, config = {}, { read = (f) => require("node:fs").readFileSync(f, "utf8") } = {}) {
  const lane = def(job);
  if (!lane) return null;
  let core;
  try { core = read(config.coreBriefFile || require("node:path").join(require("node:path").dirname(config.briefFile || ""), "KEIR-CORE.md")); } catch { return null; }
  const { sections } = require("./briefprofile").split(briefText);
  const extra = sections.filter((s) => lane.extraSections.includes(s.title)).map((s) => s.body.trim());
  const block = `## Lane: ${job.lane}\n\nThis ticket is routed to the ${job.lane} lane${job.laneReason ? ` (${job.laneReason})` : ""}. It is finished when: ${lane.exit}\n\nWork the steps in context.playbook. context.caseFile holds what is known, what the player was told and promised, and what is open; context.whatChanged leads a wake. Never repeat a post the case file shows you made, and never ask the player for what the case file, the channel or their records already show. Each separate problem gets its own row on the progress card and its own raise_to_developers; never put two problems in one issue.`;
  return [core.trim(), ...extra, block].join("\n\n");
}

module.exports = { HOWTO_TEXT, SYMPTOM_TEXT, laneBrief, textOf, LANES, LANE_IDS, PLAYBOOK_LANE, TURN_TEXT, QUESTION_LIMIT, route, assign, change, laneOf, def, isTicketJob, gatherLive, turnTrouble, rethink, questionLimit };
