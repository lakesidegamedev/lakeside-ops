"use strict";
// Keir 10.4: what the rest of the team is already doing about a ticket or topic.
//
// Ticket 1852 (2026-11-17): the owner wrote "I'm fixing" in the channel, the coordinator had a kanban card
// open and a fix worker running, and Keir still posted "Answered, no fix needed" and self-corrections,
// because none of that was visible to it. This read gathers four sources into one capped digest:
//   1. staff messages in the ticket channel since Keir's last post
//   2. kanban cards in now/next/blocked that mention the ticket or topic
//   3. running headless agent workers on this box (claude-*, keir-worker-*)
//   4. open pull requests on the two repos that match the ticket or topic
// Each source degrades to "unavailable: <reason>" and never throws. Cached 60 s per (ticket, topic).

const fs = require("node:fs");
const { keywords } = require("./evidencepack");

const CACHE_MS = 60000;
const MAX_CHARS = 2500;
const LANES = ["now", "next", "blocked", "inbox"];
const REPOS = ["lakesidegamedev/AHDGame", "lakesidegamedev/lakeside-ops"];
const UNIT_RE = /^(claude-[\w.@-]+|keir-worker-[\w.@-]+)\.service$/;
// What a staff member says when they have taken the work themselves.
const STAFF_FIXING = /\b(?:i(?:'|’)?m|i am|we(?:'|’)?re|we are|i(?:'|’)?ll|i will|we(?:'|’)?ll|we will|im)\s+(?:\w+\s+){0,2}(?:fix(?:ing)?|on it|working on|looking into|handling|patching|shipping|taking (?:this|it))|\b(?:fix(?:ing)? (?:is )?(?:in progress|underway|coming)|already (?:fixing|on it|working))/i;

const oneLine = (v, max) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1)}...` : s; };
const ageOf = (ms) => ms < 3600000 ? `${Math.max(0, Math.round(ms / 60000))}m` : ms < 86400000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`;
const asList = (v) => Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : [];
const reason = (e) => oneLine(e?.message || e, 120) || "error";

// A topic matches text when most of its (at most five) main words appear. Topic matches are advisory only:
// the PR text in AHDGame never carries a ticket number, so a topic hit says "probably related", not "covered".
function topicTest(topic) {
  const words = keywords(topic, 5);
  if (!words.length) return null;
  const need = Math.min(words.length, 3);
  return (text) => { const t = String(text || "").toLowerCase(); return words.filter((w) => t.includes(w)).length >= need; };
}
function ticketTest(ticket) {
  if (!ticket) return null;
  const re = new RegExp(`(?:ticket|#|channel|tkt)[\\s#-]*${Number(ticket)}\\b|\\bticket-${Number(ticket)}\\b`, "i");
  return (text) => re.test(String(text || ""));
}

function createTeamActivity({ config = {}, discord, mcp, exec, ledger, isModerator = () => false, now = () => Date.now(), readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const cache = new Map();

  async function channelFor(job, ticket) {
    if (job?.channelId && (!ticket || !job.ticket || Number(ticket) === Number(job.ticket))) return job.channelId;
    const d = ledger?.data;
    const seen = d?.jobs?.[d?.seen?.[`ticket:${ticket}`]];
    return seen?.channelId || null;
  }

  async function staffMessages(job, ticket, signal) {
    if (!ticket) return { skipped: "no ticket" };
    if (!discord) return { error: "no Discord access" };
    const channelId = await channelFor(job, ticket);
    if (!channelId) return { error: "ticket channel not known" };
    const rows = await discord("GET", `/channels/${channelId}/messages?limit=50`);
    if (!Array.isArray(rows)) return { error: "channel unreadable" };
    const ordered = rows.slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    let lastBot = -1;
    ordered.forEach((m, i) => { if (m.author?.id === config.botId) lastBot = i; });
    const owner = config.ownerId, staff = new Set(config.staffIds || []), juniors = new Set(config.juniorIds || []);
    const out = [];
    for (const m of ordered.slice(lastBot + 1)) {
      const id = m.author?.id;
      if (!id || m.author.bot || !String(m.content || "").trim()) continue;
      const role = id === owner ? "owner" : juniors.has(id) ? "junior dev" : staff.has(id) ? "staff" : (isModerator(id) ? "mod" : null);
      if (role) out.push({ role, text: oneLine(m.content, 280), at: m.timestamp });
    }
    return { messages: out.slice(-6), sinceBotPost: lastBot >= 0 };
  }

  async function cards(ticket, topic, signal) {
    const byTicket = ticketTest(ticket), byTopic = topicTest(topic);
    if (!byTicket && !byTopic) return { skipped: "no ticket or topic" };
    if (!mcp) return { error: "no MCP access" };
    const found = new Map(); let failed = 0, lastErr = "";
    await Promise.all(LANES.map(async (lane) => {
      try {
        const res = await mcp.call("ops-knowledge", "kanban_list", { lane, limit: 100 }, false, signal);
        for (const c of asList(res)) if (c?.id != null) found.set(c.id, c);
      } catch (e) { failed++; lastErr = reason(e); }
    }));
    if (failed === LANES.length) return { error: lastErr };
    const strength = (c) => byTicket && byTicket(`${c.title} ${c.detail_excerpt || ""} ${c.progress_summary || ""}`) ? "ticket" : byTopic && byTopic(`${c.title} ${c.detail_excerpt || ""}`) ? "topic" : null;
    const rows = [...found.values()].map((c) => ({ c, by: strength(c) })).filter((x) => x.by).sort((a, b) => (a.by === "ticket" ? 0 : 1) - (b.by === "ticket" ? 0 : 1)).slice(0, 4).map(({ c, by }) => ({
      by, id: c.id, lane: c.lane, title: oneLine(c.title, 110), owner: c.assigned_to || "unassigned", handback: require("./handback").isHandback(c),
      progress: oneLine(String(c.progress_summary || "").split("\n").filter(Boolean).at(-1) || "", 140),
      age: c.created_at ? ageOf(now() - Date.parse(c.created_at)) : null,
    }));
    return { cards: rows, partial: failed > 0 };
  }

  // The first sentence of the brief a claude-* worker was launched with, or its unit description.
  function goalOf(unit, description) {
    try {
      const script = /(\/[^\s\]]+\.sh)\b/.exec(description || "")?.[1];
      const body = script ? readFile(script) : "";
      const briefPath = /(\/root\/misc\/archive\/[^\s"')]*brief[^\s"')]*\.md)/.exec(body)?.[1];
      if (briefPath) {
        const text = readFile(briefPath);
        const at = text.indexOf("PROBLEM");
        const slice = at >= 0 ? text.slice(at + 7) : text.split("\n").find((l) => l.trim() && !/^(?:rules?|you are|work only|stage|do not|never)\b/i.test(l.trim())) || "";
        const goal = oneLine(slice.replace(/^[\s:\-]+/, ""), 300);
        if (goal) return goal;
      }
    } catch { /* fall through to the description */ }
    return oneLine(description, 160) || unit;
  }

  async function workers(ticket, signal) {
    if (!exec) return { error: "no shell access" };
    const out = await exec("systemctl", ["list-units", "--type=service", "--state=running", "--no-legend", "--plain", "--no-pager"], { timeout: 10000, signal });
    const units = [];
    for (const line of String(out || "").split("\n")) {
      const [name, , , , ...desc] = line.trim().split(/\s+/);
      if (UNIT_RE.test(name || "")) units.push({ unit: name.replace(/\.service$/, ""), description: desc.join(" ") });
    }
    const runs = Object.values(ledger?.data?.codingWorkers?.runs || {});
    const rows = [];
    for (const u of units.slice(0, 8)) {
      let started = null;
      try { started = String(await exec("systemctl", ["show", `${u.unit}.service`, "-p", "ActiveEnterTimestamp", "--value"], { timeout: 5000, signal })).trim() || null; } catch { /* leave blank */ }
      const run = u.unit.startsWith("keir-worker-") ? runs.find((r) => r.unit === u.unit) : null;
      const goal = run ? oneLine(run.title || run.summary || `ticket ${run.ticket || "?"} worker`, 200) : goalOf(u.unit, u.description);
      const byTicket = ticketTest(ticket);
      const strong = Boolean(ticket && (Number(run?.ticket) === Number(ticket) || (byTicket && byTicket(goal))));
      rows.push({ unit: u.unit, started, goal, by: strong ? "ticket" : null });
    }
    return { workers: rows };
  }

  async function prs(ticket, topic, signal) {
    const byTicket = ticketTest(ticket), byTopic = topicTest(topic);
    if (!byTicket && !byTopic) return { skipped: "no ticket or topic" };
    if (!exec) return { error: "no shell access" };
    const rows = [], errors = [];
    await Promise.all(REPOS.map(async (repo) => {
      try {
        const raw = await exec("/usr/bin/gh", ["pr", "list", "-R", repo, "--state", "open", "--limit", "60", "--json", "number,title,body,isDraft,headRefName,statusCheckRollup"], { timeout: 30000, signal });
        for (const p of JSON.parse(raw || "[]")) {
          const text = `${p.title} ${p.body || ""} ${p.headRefName || ""}`;
          const by = byTicket && byTicket(text) ? "ticket" : byTopic && byTopic(`${p.title} ${p.body || ""}`) ? "topic" : null;
          if (!by) continue;
          const checks = Array.isArray(p.statusCheckRollup) ? p.statusCheckRollup : [];
          const bad = checks.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(c.conclusion || c.state));
          const wait = checks.some((c) => c.status && c.status !== "COMPLETED" || c.state === "PENDING");
          rows.push({ by, repo: repo.split("/")[1], number: p.number, title: oneLine(p.title, 100), checks: !checks.length ? "none yet" : bad ? "failing" : wait ? "running" : "passing", ...(p.isDraft ? { draft: true } : {}) });
        }
      } catch (e) { errors.push(`${repo.split("/")[1]}: ${reason(e)}`); }
    }));
    if (errors.length === REPOS.length) return { error: errors.join("; ") };
    return { prs: rows.slice(0, 5), ...(errors.length ? { partialError: errors.join("; ") } : {}) };
  }

  const section = async (fn) => { try { return await fn(); } catch (e) { return { error: reason(e) }; } };

  function render({ ticket, topic, s1, s2, s3, s4 }) {
    const lines = [`team activity${ticket ? ` for ticket ${ticket}` : ""}${topic ? ` (topic: ${oneLine(topic, 60)})` : ""}`];
    const head = (n, label, s, body) => {
      if (s.skipped) return;
      if (s.error) lines.push(`${n}. ${label}: unavailable: ${s.error}`);
      else if (!body.length) lines.push(`${n}. ${label}: none`);
      else { lines.push(`${n}. ${label}:`); lines.push(...body); }
    };
    head(1, "staff messages since Keir's last post", s1, (s1.messages || []).map((m) => `- ${m.role}: ${m.text}`));
    head(2, "kanban cards (now/next/blocked)", s2, (s2.cards || []).map((c) => `- #${c.id} [${c.lane}]${c.by === "topic" ? " (topic match)" : ""} ${c.title} | ${c.owner}${c.progress ? ` | ${c.progress}` : ""}${c.age ? ` | ${c.age} old` : ""}`));
    head(3, "running agent workers", s3, (s3.workers || []).map((w) => `- ${w.unit}${w.by === "ticket" ? " (this ticket)" : ""} since ${w.started || "?"}: ${w.goal}`));
    head(4, "open PRs", s4, (s4.prs || []).map((p) => `- ${p.repo}#${p.number}${p.by === "topic" ? " (topic match)" : ""} ${p.title} (checks ${p.checks}${p.draft ? ", draft" : ""})`));
    let text = lines.join("\n");
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 24).trimEnd()}\n[cut at ${MAX_CHARS} chars]`;
    return text;
  }

  async function call(job, input = {}, signal) {
    const ticket = Number(input.ticket) || Number(job?.ticket) || null;
    const topic = oneLine(input.topic, 300);
    const key = `${ticket || ""}|${topic.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.result;
    const [s1, s2, s3, s4] = await Promise.all([section(() => staffMessages(job, ticket, signal)), section(() => cards(ticket, topic, signal)), section(() => workers(ticket, signal)), section(() => prs(ticket, topic, signal))]);
    const staffSaid = (s1.messages || []).filter((m) => STAFF_FIXING.test(m.text));
    const strong = (list) => (list || []).some((x) => x.by === "ticket");
    // 2026-11-23 (1886): a card covers the ticket only when someone has claimed it (in progress, assigned to a person or
    // agent other than Keir). Cards Keir filed for itself and nobody picked up made stalled tickets look covered.
    // A card whose note says HANDOFF TO KEIR was handed back: Keir owns the ticket, whoever the card still names.
    const claimed = (s2.cards || []).some((c) => c.by === "ticket" && c.lane === "now" && c.owner !== "unassigned" && !/^keir\b/i.test(c.owner) && !c.handback);
    const covered = Boolean(staffSaid.length || claimed || strong(s3.workers) || strong(s4.prs));
    const possible = !covered && Boolean((s2.cards || []).length || (s4.prs || []).length);
    const result = {
      ticket, topic: topic || null, covered,
      ...(staffSaid.length ? { staffSaidFixing: true } : {}),
      ...(possible ? { possibleMatch: true } : {}),
      report: render({ ticket, topic, s1, s2, s3, s4 }),
      instruction: covered
        ? "Someone on the team is already on this (staff said so, or a card, worker or PR names this ticket). Do not post 'no fix needed', 'answered' or a correction, and do not argue the rule. Tell the player in plain words that a fix is in progress and who is on it (the team, or a developer), with no internal names, hosts, card ids or unit names, then stop investigating that part."
        : possible ? "Cards or PRs match by topic only. Read the closest one to confirm it covers this exact issue before you say a fix is in progress; if it does, treat it as covered."
        : "Nothing found that covers this. That does not prove nobody is on it; it only means you can continue.",
    };
    cache.set(key, { at: now(), result });
    return result;
  }

  return { call, _sections: { staffMessages, cards, workers, prs } };
}

module.exports = { createTeamActivity, STAFF_FIXING, topicTest, ticketTest };
