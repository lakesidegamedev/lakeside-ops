"use strict";
// Keir 8.4 daily trust report. Short, plain language, for the owner who is away: what Keir did, what it
// got wrong, what is waiting on him, and whether the machine stayed up. Built from the ledger only (pure),
// then delivered by the reporter below: an owner DM, a file under the state dir, and an ops-knowledge doc.
const fs = require("node:fs");
const path = require("node:path");
const { trust, contradictedClaims } = require("./trustlog");

const HOUR = 3600000, DAY = 86400000;
const ts = (v) => { const n = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(n) ? n : 0; };
const CLOSED = new Set(["done", "cancelled", "dismissed"]);

// Quick, model-free read of one outgoing reply. It looks for the failures the owner has actually seen.
function reviewReply(text, previous = []) {
  const t = String(text || ""), flags = [];
  if (t.length > 700 || t.split(/(?<=[.!?])\s+/).length > 5) flags.push("too long");
  if (/[–—]/.test(t)) flags.push("uses a dash the house style bans");
  if (/github\.com|\bPRs?\b|pull request|#\d{3,5}\b|\bCI\b|\bstaging\b|\bcommit\b|\bmerge[dg]?\b|`|\b(?:tool_call|function_call)\b|<\/?(?:tool|invoke|function)|\{\s*"(?:tool|name|arguments)"/i.test(t)) flags.push("leaks internals or tool markup");
  if (/\b(?:is|are|now|been)\s+(?:fixed|live|working|gone)\b|\bshould be (?:fixed|gone)\b/i.test(t)) flags.push("says fixed or live");
  if (/\bstill (?:checking|looking|investigating)\b|\bno (?:new )?update\b/i.test(t) && t.length < 220) flags.push("a non-answer");
  const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const a = words(t);
  for (const p of previous) { const b = words(p); let both = 0; for (const w of a) if (b.has(w)) both++; if (a.size && b.size && both / (a.size + b.size - both) >= 0.6) { flags.push("repeats an earlier post"); break; } }
  return { verdict: flags.length ? "needs a look" : "fine", flags };
}

function buildTrustReport({ d, now, windowMs = DAY, ownerId, random = Math.random, guardian = null, killSwitch = null, sample = 3 }) {
  const since = now - windowMs, t = trust(d);
  const jobs = Object.values(d.jobs || {});
  const ticketJobs = jobs.filter((j) => j.kind === "ticket" && j.ticket);
  const byTicket = new Map(ticketJobs.map((j) => [j.ticket, j]));
  const handled = new Set([...t.replies.filter((r) => r.at >= since).map((r) => r.ticket), ...ticketJobs.filter((j) => ts(j.updatedAt) >= since && j.state !== "queued").map((j) => j.ticket)]);
  const resolved = ticketJobs.filter((j) => j.resolved && ts(j.resolutionSubmittedAt) >= since);
  const open = [...byTicket.values()].filter((j) => !j.channelClosed && !j.resolved && !CLOSED.has(j.state));
  const fixes = [...new Set(jobs.filter((j) => ts(j.updatedAt) >= since).flatMap((j) => j.pullRequests || []).filter((u) => typeof u === "string"))];
  const contradicted = contradictedClaims(d, since, now);
  const pending = Object.values(d.decisions || {}).filter((x) => x.state === "pending").map((x) => ({ ticket: ticketJobs.find((j) => j.id === x.jobId)?.ticket || null, ageH: Math.round((now - ts(x.at)) / HOUR), question: String(x.question || "").slice(0, 140) })).sort((a, b) => b.ageH - a.ageH);
  const escalations = Object.entries(t.sweeps).filter(([n, s]) => s.kind === "escalate_owner" && now - s.at < 3 * DAY && (t.progress[n]?.lastSubstantiveAt || 0) < s.at).map(([n, s]) => ({ ticket: Number(n), ageH: Math.round((now - s.at) / HOUR), reason: s.reason }));
  const recent = t.replies.filter((r) => r.at >= since);
  const picks = [...recent].sort(() => random() - 0.5).slice(0, sample).map((r) => ({ ticket: r.ticket, at: r.at, text: r.text.slice(0, 200), ...reviewReply(r.text, t.replies.filter((p) => p.ticket === r.ticket && p.at < r.at).slice(-3).map((p) => p.text)) }));
  const restarts = [...(guardian?.restarts || []).filter((r) => r.at >= since)];
  return { at: now, windowHours: Math.round(windowMs / HOUR), tickets: { handled: handled.size, resolved: resolved.length, open: open.length }, fixes, contradicted, awaitingOwner: { decisions: pending, escalations },
    spotChecks: picks, repliesSent: recent.length, incidents: { restarts, guardianState: guardian?.state || null, giveUps: (guardian?.giveUps || []).filter((g) => g.at >= since), killSwitch: killSwitch?.engaged ? { reason: killSwitch.reason } : null } };
}

function renderTrustReport(r) {
  const L = [];
  L.push(`Keir, last ${r.windowHours} hours. ${r.tickets.handled} tickets handled, ${r.tickets.resolved} resolved, ${r.tickets.open} still open. ${r.repliesSent} replies sent.`);
  L.push(r.fixes.length ? `Fixes shipped (${r.fixes.length}):\n${r.fixes.slice(0, 8).map((u) => `- ${u}`).join("\n")}` : "No fixes shipped.");
  L.push(r.contradicted.length ? `Claims later contradicted (${r.contradicted.length}):\n${r.contradicted.slice(0, 5).map((c) => `- Ticket ${c.ticket}: Keir said "${c.claim}", then the ${c.contradictedBy} said "${c.evidence}"`).join("\n")}` : "No fixed or live claim was contradicted.");
  const wait = [...r.awaitingOwner.decisions.map((x) => `- Ticket ${x.ticket ?? "?"}: your decision, waiting ${x.ageH} h. ${x.question}`), ...r.awaitingOwner.escalations.map((x) => `- Ticket ${x.ticket}: needs a person, flagged ${x.ageH} h ago. ${x.reason}`)];
  L.push(wait.length ? `Waiting on you (${wait.length}):\n${wait.slice(0, 8).join("\n")}` : "Nothing is waiting on you.");
  L.push(r.spotChecks.length ? `Reply spot checks:\n${r.spotChecks.map((s) => `- Ticket ${s.ticket}: ${s.verdict}${s.flags.length ? ` (${s.flags.join(", ")})` : ""}. "${s.text.slice(0, 100)}"`).join("\n")}` : "No replies to spot check.");
  const i = r.incidents;
  const inc = [i.restarts.length ? `${i.restarts.length} automatic restart${i.restarts.length === 1 ? "" : "s"} (${[...new Set(i.restarts.map((x) => x.unit))].join(", ")})` : "", i.giveUps.length ? `Keir stopped restarting ${[...new Set(i.giveUps.map((g) => g.unit))].join(", ")} and needs you` : "", i.killSwitch ? `The kill switch is ENGAGED: ${i.killSwitch.reason}` : ""].filter(Boolean);
  L.push(inc.length ? `Incidents: ${inc.join("; ")}.` : "No restarts or incidents.");
  return L.join("\n\n");
}

function easternDate(at) { return new Date(at).toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function easternHour(at) { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(at))) % 24; }

function createTrustReporter({ ledger, config, now = () => Date.now(), log = () => {}, killSwitch = null, readGuardian = () => null, mcp = null, outDir = path.join(config.stateDir, "trust-reports"), hour = 9 }) {
  const d = ledger.data;
  async function tick({ force = false } = {}) {
    const at = now(), t = trust(d), today = easternDate(at);
    if (!force && (easternHour(at) < hour || t.reports.lastDate === today)) return null;
    const report = buildTrustReport({ d, now: at, ownerId: config.ownerId, guardian: readGuardian(), killSwitch: killSwitch?.state() });
    const text = renderTrustReport(report);
    t.reports.lastDate = today; t.reports.lastAt = at;
    // The owner does not want routine pings (2026-10-12) but asked for this one: the key is outside the quiet list, so it is a DM.
    ledger.notify(`trust-report:${today}`, "owner", text);
    let file = null;
    try { fs.mkdirSync(outDir, { recursive: true, mode: 0o700 }); file = path.join(outDir, `${today}.md`); fs.writeFileSync(file, `# Keir trust report ${today}\n\n${text}\n`, { mode: 0o600 }); t.reports.lastFile = file; } catch (e) { log(`trust report file: ${e.message}`); }
    let knowledge = null;
    if (mcp) try {
      const saved = await mcp.call("ops-knowledge", "knowledge_save", { title: `Keir daily trust report ${today}`, description: "Daily plain-language report of Keir's tickets, fixes, contradicted claims, escalations and incidents.", tags: ["keir", "trust-report", "internal"], body: `# Keir trust report ${today}\n\n${text}\n`, metadata: { kind: "keir-trust-report", date: today } }, true);
      knowledge = saved?.id || saved?.slug || true; t.reports.lastKnowledge = today;
    } catch (e) { log(`trust report knowledge_save: ${String(e.message).slice(0, 160)}`); }
    ledger.audit("trust_report", { date: today, file, knowledge: Boolean(knowledge) });
    ledger.save();
    return { report, text, file, knowledge };
  }
  return { tick };
}

module.exports = { reviewReply, buildTrustReport, renderTrustReport, createTrustReporter };
