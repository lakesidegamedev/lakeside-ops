"use strict";
// Keir 4.0 related tickets and incidents (owner, 2026-10-14).
//
// A new ticket is compared, in one bundled Jev call, with the other open
// tickets from the last day. A clear match (85% or more) is the same problem.
//
//  - Related but not severe: the newer ticket merges into the older one.
//  - Three or more related, and severe (outage class: the game, turns,
//    logins, money or the economy broken for many players, or lost data):
//    Keir proposes an incident in the staff channel, pinging moderators and
//    developers. Any of them reacts ✅ to open it or ❌ to decline. If nobody
//    answers in ten minutes Keir opens it. Every ticket in the cluster then
//    merges into the incident. Declined: they merge into the oldest ticket.
//  - Public chatter: a spike of problem reports on one topic in the watched
//    channels, not covered by an incident, becomes a proposal too. That one
//    opens only on a staff ✅.
//
// Everything fails open: no key, no verdict or a refused write means the
// tickets are worked as usual.

const JEV = "/root/bin/lib/jev.mjs";
const { randomBytes } = require("node:crypto");
const defaultAsk = (spec) => (process.env.KEIR_JEV === "off" ? Promise.resolve(null) : import(JEV).then((m) => m.ask(spec)));
const SAME = 0.85;
const SEVERE = 0.7;
const WINDOW_MS = 24 * 3600000;
const AUTO_OPEN_MS = 10 * 60000;
const CHATTER_WINDOW_MS = 30 * 60000;
const CHATTER_MIN = 4;
const TERMINAL = ["done", "dismissed", "cancelled"];
const YES = "✅", NO = "❌";

const clean = (t) => String(t || "").replace(/[–—]/g, ",").replace(/\s+/g, " ").trim().slice(0, 90);
const reportOf = (j) => [j.source, ...(j.requestInbox || [])].filter(Boolean).slice(0, 3).map((s) => String(s.content || "")).join("\n").slice(0, 900);

function createSurge({ ledger, mcp, discord, config, now = () => Date.now(), ask = defaultAsk, log = () => {} }) {
  const d = ledger.data;
  const channel = config.incidentChannel;
  const pingRoles = config.incidentPingRoles || [];
  const approverRoles = new Set([...(config.incidentApproverRoles || pingRoles)]);
  const proposals = () => (d.incidentProposals ||= {});
  const ticketJob = (n) => d.jobs[d.seen[`ticket:${n}`]];

  // Other open ticket tasks from the last day that a report could duplicate.
  function openTickets(job) {
    return Object.values(d.jobs).filter((j) => j !== job && j.kind === "ticket" && j.ticket && j.ticket !== job.ticket && !TERMINAL.includes(j.state)
      && !j.mergedInto && !j.internalProbe && now() - (Date.parse(j.at) || j.at || 0) < WINDOW_MS && !(d.channels?.[j.channelId]?.category === "incident" || ["moderation", "investigation"].includes(d.channels?.[j.channelId]?.category)))
      .sort((a, b) => a.ticket - b.ticket).slice(-12);
  }

  async function related(job, others) {
    if (!others.length) return [];
    const questions = Object.fromEntries(others.map((o) => [`t${o.ticket}`, {
      type: "noul",
      instructions: `Is the new report the same problem as ticket #${o.ticket}? Ticket #${o.ticket}: ${reportOf(o)}`.slice(0, 1200),
      criteria: { true: "Both describe the same broken behaviour, outage or error in the same part of the game, even in different words.", false: "Different problems, different parts of the game, or only loosely similar." },
    }]));
    const out = await ask({ state: { report: reportOf(job), ticket: job.ticket }, questions, timeoutMs: 8000 }).catch(() => null);
    if (!out?.answers) return [];
    return others.map((o) => ({ job: o, p: Number(out.answers[`t${o.ticket}`]?.noul) })).filter((x) => Number.isFinite(x.p) && x.p >= SAME).map((x) => x.job);
  }

  async function severity(jobs) {
    const out = await ask({ state: { reports: jobs.map((j) => `#${j.ticket}: ${reportOf(j).slice(0, 500)}`).join("\n\n").slice(0, 4000) }, timeoutMs: 8000, questions: {
      severe: { type: "noul", instructions: "Several players reported this problem. Is it outage class?",
        criteria: { true: "The game, turn processing, logins, money or the economy is broken or badly wrong for many players, or player data was lost.", false: "A narrower bug, a display problem, a balance complaint or a question." } },
    } }).catch(() => null);
    const p = Number(out?.answers?.severe?.noul);
    return { severe: Number.isFinite(p) && p >= SEVERE, p: Number.isFinite(p) ? p : null };
  }

  // Jev reads, it does not write: the title is the oldest report's own title.
  async function titleFor(jobs) {
    for (const j of jobs) {
      const t = await mcp.call("support", "support_get", { kind: "ticket", number: j.ticket }, false).catch(() => null);
      if (t?.title) return clean(t.title);
    }
    return clean(String(reportOf(jobs[0] || {}).split("\n").find((l) => l.trim().length > 8) || "Many players report the same problem"));
  }

  async function mergeJob(src, target, { requireIncident, reason, signal }) {
    const r = await mcp.call("support", "support_merge", { source_number: src.ticket, target_number: target, reason: String(reason).slice(0, 500), merged_by: "keir", require_incident: requireIncident }, true, signal);
    src.mergedInto = target; src.state = "done"; src.channelClosed = true; src.updatedAt = now();
    src.summary = `Merged into ${requireIncident ? "incident" : "ticket"} #${target}: ${String(reason).slice(0, 200)}`;
    ledger.audit(requireIncident ? "merged_into_incident" : "merged_related", { job: src.id, ticket: src.ticket, target, by: "keir", steps: r?.steps || null });
    ledger.save();
    return r;
  }

  async function post(content, { roles = [] } = {}) {
    if (!channel) throw new Error("no incident channel configured");
    return discord("POST", `/channels/${channel}/messages`, { content: content.slice(0, 1900), allowed_mentions: { roles } });
  }
  const edit = (p, content) => p.messageId && discord("PATCH", `/channels/${channel}/messages/${p.messageId}`, { content: content.slice(0, 1900), allowed_mentions: { parse: [] } }).catch(() => {});

  async function propose({ tickets = [], title, summary, severe, source, fingerprint }) {
    // A failed staff delivery may retry; do not mint a second proposal for
    // the same watch finding or open an incident without a staff answer.
    const prior = fingerprint && Object.values(proposals()).find((p) => p.fingerprint === fingerprint && p.state === "proposed");
    if (prior?.messageId && !prior.postError) return prior;
    const id = prior?.id || `inc-${now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const p = { id, tickets, title: title || "Many players report the same problem", summary, severe, source, at: now(), state: "proposed" };
    if (fingerprint) p.fingerprint = fingerprint;
    proposals()[id] = p;
    const pings = pingRoles.map((r) => `<@&${r}>`).join(" ");
    const lines = [
      `${pings} Keir proposes an incident: **${p.title}**`,
      tickets.length ? `Related tickets: ${tickets.map((n) => `#${n}`).join(", ")}.` : null,
      summary ? summary.slice(0, 600) : null,
      severe && source !== "watch" ? `React ${YES} to open it now or ${NO} to decline. If nobody answers in 10 minutes, Keir opens it.` : `React ${YES} to open it or ${NO} to decline.`,
    ].filter(Boolean);
    try {
      const m = await post(lines.join("\n"), { roles: pingRoles });
      p.messageId = m?.id || null;
      if (p.messageId) for (const e of [YES, NO]) await discord("PUT", `/channels/${channel}/messages/${p.messageId}/reactions/${encodeURIComponent(e)}/@me`).catch(() => {});
    } catch (e) { p.postError = String(e.message).slice(0, 200); }
    ledger.audit("incident_proposed", { proposal: id, tickets, severe, source });
    ledger.save();
    return p;
  }

  // Called once per new ticket, after the open-incident check found nothing.
  async function checkTicket(job, signal) {
    const others = openTickets(job);
    const same = await related(job, others);
    ledger.audit("related_checked", { job: job.id, ticket: job.ticket, compared: others.length, related: same.map((j) => j.ticket) });
    if (!same.length) return null;
    // Already proposed: join the pending proposal.
    const pending = Object.values(proposals()).find((p) => p.state === "proposed" && same.some((j) => p.tickets.includes(j.ticket)));
    if (pending) { if (!pending.tickets.includes(job.ticket)) pending.tickets.push(job.ticket); ledger.save(); return { proposal: pending.id }; }
    const cluster = [...same, job].sort((a, b) => a.ticket - b.ticket);
    if (cluster.length >= 3) {
      const s = await severity(cluster);
      if (s.severe) {
        const p = await propose({ tickets: cluster.map((j) => j.ticket), title: await titleFor(cluster), summary: `Jev rates this outage class (${Math.round((s.p || 0) * 100)}%).`, severe: true, source: "tickets" });
        return { proposal: p.id };
      }
    }
    // Not severe: the newer tickets join the oldest.
    const oldest = cluster[0];
    for (const j of cluster.slice(1)) {
      try { await mergeJob(j, oldest.ticket, { requireIncident: false, reason: `same problem as ticket #${oldest.ticket}`, signal }); }
      catch (e) { ledger.audit("merge_related_failed", { job: j.id, ticket: j.ticket, target: oldest.ticket, error: String(e.message).slice(0, 200) }); }
    }
    return { merged: job.mergedInto === oldest.ticket, target: oldest.ticket };
  }

  async function approver(messageId, emoji) {
    const users = await discord("GET", `/channels/${channel}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=25`).catch(() => []);
    for (const u of users || []) {
      if (u.bot || u.id === config.botId) continue;
      if (u.id === config.ownerId) return u.id;
      const m = await discord("GET", `/guilds/${config.guildId}/members/${u.id}`).catch(() => null);
      if ((m?.roles || []).some((r) => approverRoles.has(r))) return u.id;
    }
    return null;
  }

  async function open(p, by) {
    const tickets = p.tickets.map(ticketJob).filter(Boolean);
    const description = [p.summary, tickets.length ? `Reported in tickets ${p.tickets.map((n) => `#${n}`).join(", ")}.` : null, ...tickets.slice(0, 3).map((j) => `> ${reportOf(j).slice(0, 300)}`)].filter(Boolean).join("\n\n").slice(0, 4800) || p.title;
    const r = await mcp.call("support", "support_create_ticket", { category: "incident", title: p.title.slice(0, 200), description }, true);
    const n = Number(r?.ticketNumber);
    if (!n) throw new Error(`incident not created: ${JSON.stringify(r).slice(0, 200)}`);
    p.state = "opened"; p.incident = n; p.openedBy = by; p.openedAt = now();
    for (const j of tickets) {
      if (TERMINAL.includes(j.state) || j.mergedInto) continue;
      try { await mergeJob(j, n, { requireIncident: true, reason: `part of incident #${n}: ${p.title}` }); }
      catch (e) { ledger.audit("merge_into_incident_failed", { job: j.id, ticket: j.ticket, target: n, error: String(e.message).slice(0, 200) }); }
    }
    ledger.audit("incident_opened", { proposal: p.id, incident: n, by, tickets: p.tickets });
    await edit(p, `Incident #${n} opened: **${p.title}** (${by === "keir" ? "no answer in 10 minutes, so Keir opened it" : `approved by <@${by}>`}). ${p.tickets.length ? `Merged tickets ${p.tickets.map((t) => `#${t}`).join(", ")}.` : ""}`);
    ledger.save();
  }

  // Every minute: settle proposals from reactions or the severe timeout.
  async function tick() {
    for (const p of Object.values(proposals())) {
      if (p.state !== "proposed") continue;
      try {
        const no = p.messageId && await approver(p.messageId, NO);
        if (no) {
          p.state = "declined"; p.declinedBy = no; p.decidedAt = now();
          ledger.audit("incident_declined", { proposal: p.id, by: no });
          const jobs = p.tickets.map(ticketJob).filter((j) => j && !TERMINAL.includes(j.state)).sort((a, b) => a.ticket - b.ticket);
          for (const j of jobs.slice(1)) await mergeJob(j, jobs[0].ticket, { requireIncident: false, reason: `same problem as ticket #${jobs[0].ticket}` }).catch(() => {});
          await edit(p, `Declined by <@${no}>: no incident for **${p.title}**.${jobs.length > 1 ? ` The related tickets were merged into #${jobs[0].ticket}.` : ""}`);
          ledger.save(); continue;
        }
        const yes = p.messageId && await approver(p.messageId, YES);
        if (yes) { await open(p, yes); continue; }
        if (p.severe && p.source !== "watch" && now() - p.at >= AUTO_OPEN_MS) { await open(p, "keir"); continue; }
        if ((!p.severe || p.source === "watch") && now() - p.at >= 6 * 3600000) { p.state = "expired"; ledger.audit("incident_proposal_expired", { proposal: p.id }); await edit(p, `No answer on **${p.title}**; Keir did not open an incident.`); ledger.save(); }
      } catch (e) { p.lastError = String(e.message).slice(0, 200); ledger.save(); log(`incident proposal ${p.id}: ${e.message}`); }
    }
  }

  // Public chatter: problem reports in watched channels that became
  // candidates. Four or more from different players on one topic in half an
  // hour, with no incident or proposal covering them, become a proposal.
  async function chatterTick() {
    const recent = Object.values(d.jobs).filter((j) => j.kind === "candidate" && now() - (Date.parse(j.at) || j.at || 0) < CHATTER_WINDOW_MS && !j.chatterProposal);
    const authors = new Set(recent.map((j) => j.source?.authorId).filter(Boolean));
    if (recent.length < CHATTER_MIN || authors.size < CHATTER_MIN) return null;
    if (Object.values(proposals()).some((p) => p.state === "proposed" && p.source === "chatter")) return null;
    const out = await ask({ state: { reports: recent.slice(-12).map((j, i) => `${i + 1}. ${reportOf(j).slice(0, 300)}`).join("\n") }, timeoutMs: 8000, questions: {
      same: { type: "noul", instructions: "Are most of these players reporting the same problem right now?", criteria: { true: "Most messages describe one broken thing (an outage, an error, a failing feature).", false: "Mixed or unrelated complaints." } },
    } }).catch(() => null);
    const p = Number(out?.answers?.same?.noul);
    if (!(p >= SAME)) return null;
    for (const j of recent) j.chatterProposal = true;
    const title = clean(`Players report: ${String(recent[0]?.source?.content || "the same problem").split("\n")[0]}`);
    return propose({ title, summary: `${recent.length} problem reports from ${authors.size} players in the last 30 minutes look like the same thing.`, severe: false, source: "chatter" });
  }

  return { checkTicket, tick, chatterTick, propose, open };
}

module.exports = { createSurge, SAME, SEVERE, AUTO_OPEN_MS };
