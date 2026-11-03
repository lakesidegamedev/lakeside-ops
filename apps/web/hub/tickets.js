"use strict";

// hub/tickets.js: the Ticket hub. One page that answers "what is open, who is
// on it, what changed, what shipped, and what happened before":
//   active tickets with their latest step and owner,
//   people and agents active on tickets in the last 14 days,
//   a feed of recent ticket work (status changes and player updates),
//   GitHub pull requests linked to tickets, with live state,
//   and the full searchable ticket history.
// Ticket detail stays at /tickets/<n>, which renders inside the same hub bar.

const { icon } = require("../ui-kit");
const { esc } = require("./shell");

const ACTIVE = ["open", "investigating", "awaiting_player", "in_progress", "reopened"];
const DONE = ["resolved", "closed", "rejected"];

const STATUS = {
  open: { label: "Open", color: "#f59e0b" },
  investigating: { label: "Investigating", color: "#38bdf8" },
  in_progress: { label: "In progress", color: "#818cf8" },
  awaiting_player: { label: "Waiting on player", color: "#fb923c" },
  reopened: { label: "Reopened", color: "#f43f5e" },
  resolved: { label: "Resolved", color: "#34d399" },
  closed: { label: "Closed", color: "#64748b" },
  rejected: { label: "Rejected", color: "#94a3b8" },
};

// Agent and service identities that write ticket history, shown by role.
const AGENTS = [
  [/^triage-worker$/, "Triage agent"],
  [/^ticket-repair-agent$/, "Repair agent"],
  [/^platform-agents-write/, "Keir"],
  [/^codex/, "Codex"],
  [/^claude/, "Claude"],
  [/keir/i, "Keir"],
];
// Only agents and known staff count as "working" on a ticket; a player
// closing their own ticket is not.
function actorName(id, names) {
  const s = String(id || "");
  if (!s) return null;
  for (const [re, n] of AGENTS) if (re.test(s)) return { name: n, agent: true };
  if (names.has(s)) return { name: names.get(s), agent: false };
  return null;
}
// Machine bookkeeping notes are not worth showing in a feed.
function readable(text) {
  const t = String(text || "").trim();
  if (!t || /^[a-z0-9_-]+(:[\w.-]+)+$/i.test(t) || /^discord-[a-z-]+/i.test(t)) return "";
  return t;
}

let prCache = { at: 0, map: new Map() };
let ghCliToken;
// Env token first; if it is missing or rejected, the host's signed-in gh CLI.
function cliToken() {
  if (ghCliToken !== undefined) return ghCliToken;
  try { ghCliToken = require("child_process").execFileSync("gh", ["auth", "token"], {
    timeout: 4000, encoding: "utf8",
    // gh prefers GH_TOKEN/GITHUB_TOKEN when set; ask for its own stored login.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "GH_TOKEN" && k !== "GITHUB_TOKEN")),
  }).trim(); }
  catch { ghCliToken = ""; }
  return ghCliToken;
}
let envTokenRejected = false;
async function prStates(urls) {
  const token = (!envTokenRejected && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) || cliToken();
  if (!token) return prCache.map;
  const fresh = Date.now() - prCache.at < 5 * 60_000;
  const todo = urls.filter((u) => !prCache.map.has(u) || !fresh).slice(0, 30);
  await Promise.all(todo.map(async (u) => {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(u);
    if (!m) return;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const get = (tok) => fetch(`https://api.github.com/repos/${m[1]}/pulls/${m[2]}`, {
        headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "lakeside-ops-hub" }, signal: ctl.signal,
      });
      let r = await get(token);
      if (r.status === 401 && cliToken() && token !== cliToken()) { envTokenRejected = true; r = await get(cliToken()); }
      clearTimeout(t);
      if (!r.ok) return;
      const p = await r.json();
      prCache.map.set(u, { title: p.title, state: p.merged_at ? "merged" : p.state, base: p.base && p.base.ref, author: p.user && p.user.login, updated: p.updated_at, merged: p.merged_at, repo: m[1], number: +m[2] });
    } catch { /* keep the stale value */ }
  }));
  if (todo.length) prCache.at = Date.now();
  return prCache.map;
}

function lastEvent(t) {
  const ev = [];
  for (const h of t.statusHistory || []) ev.push({ at: h.at, kind: "status", status: h.status, by: h.by, note: h.note });
  for (const u of t.publicUpdates || []) ev.push({ at: u.at, kind: "update", text: u.message, by: null, updateKind: u.kind });
  if (t.prUrl && (t.opsTldrPostedAt || t.updatedAt)) ev.push({ at: t.opsTldrPostedAt || t.updatedAt, kind: "pr", pr: t.prUrl, number: t.prNumber });
  return ev.filter((e) => e.at).sort((a, b) => new Date(b.at) - new Date(a.at));
}

function reporterOf(t) {
  return (t.reporter && (t.reporter.characterName || t.reporter.username)) || t.discordDisplayName || t.discordUsername || "Player";
}

async function loadTicketHub(db) {
  const col = db.collection("tickets");
  const since14 = new Date(Date.now() - 14 * 864e5);
  const proj = { messages: 0, embedding: 0, imageUrls: 0, contextRequest: 0, intake: 0, conversationHistory: 0, description: 0 };
  const [active, recent, history] = await Promise.all([
    col.find({ status: { $nin: DONE } }, { projection: { messages: 0, embedding: 0, imageUrls: 0, contextRequest: 0, conversationHistory: 0, description: 0, "intake.interactions": 0, "intake.interactionIds": 0 } }).sort({ updatedAt: -1 }).limit(60).toArray(),
    col.find({ updatedAt: { $gte: since14 } }, { projection: proj }).sort({ updatedAt: -1 }).limit(250).toArray(),
    col.find({}, { projection: { ticketNumber: 1, title: 1, status: 1, category: 1, createdAt: 1, closedAt: 1, resolvedAt: 1, prNumber: 1, prUrl: 1, tags: 1, "reporter.characterName": 1, "reporter.username": 1, discordDisplayName: 1, discordUsername: 1 } }).sort({ ticketNumber: -1 }).limit(5000).toArray(),
  ]);
  // Staff names: Discord ids of admin and moderator accounts.
  const names = new Map();
  const ids = new Set();
  for (const t of recent.concat(active)) for (const h of t.statusHistory || []) if (/^\d{15,20}$/.test(String(h.by || ""))) ids.add(String(h.by));
  if (ids.size) {
    const staff = await db.collection("users").find(
      { $and: [{ $or: [{ discordId: { $in: [...ids] } }, { "discord.id": { $in: [...ids] } }] }, { $or: [{ isAdmin: true }, { isModerator: true }] }] },
      { projection: { username: 1, discordId: 1, "discord.id": 1 }, maxTimeMS: 5000 }).toArray().catch(() => []);
    for (const u of staff) names.set(String(u.discordId || (u.discord && u.discord.id)), u.username || "Staff");
  }

  // People and agents on tickets in the last 14 days.
  const people = new Map();
  const feed = [];
  for (const t of recent) {
    for (const e of lastEvent(t)) {
      if (new Date(e.at) < since14) continue;
      const who = e.by ? actorName(e.by, names) : null;
      if (who) {
        const p = people.get(who.name) || { name: who.name, agent: who.agent, actions: 0, tickets: new Set(), last: e.at };
        p.actions++; p.tickets.add(t.ticketNumber);
        if (new Date(e.at) > new Date(p.last)) p.last = e.at;
        people.set(who.name, p);
      }
      feed.push({ at: e.at, n: t.ticketNumber, title: t.title, kind: e.kind, status: e.status, text: readable(e.text || e.note), who: who && who.name, agent: who && who.agent, pr: e.pr, number: e.number });
    }
  }
  feed.sort((a, b) => new Date(b.at) - new Date(a.at));
  // One entry per ticket and kind in a run: "3 player updates" beats three rows.
  const compact = [];
  for (const e of feed) {
    const prev = compact[compact.length - 1];
    if (prev && prev.n === e.n && prev.kind === e.kind && prev.status === e.status) { prev.count = (prev.count || 1) + 1; continue; }
    compact.push({ ...e });
  }

  const activeRows = active.map((t) => {
    const ev = lastEvent(t);
    const owner = ev.map((e) => e.by && actorName(e.by, names)).find(Boolean);
    const last = ev[0];
    const update = ev.find((e) => e.kind === "update");
    return {
      n: t.ticketNumber, title: t.title, status: t.status, category: t.category, reporter: reporterOf(t),
      created: t.createdAt, updated: t.updatedAt, owner: owner ? owner.name : null, ownerAgent: owner ? owner.agent : false,
      last: last ? { at: last.at, kind: last.kind, text: (last.text || last.note || "").slice(0, 180), status: last.status } : null,
      update: update ? update.text.slice(0, 220) : "", pr: t.prUrl || null, prNumber: t.prNumber || null,
      waiting: !!(t.intake && t.intake.awaitingReply), fixing: !!t.fixSessionId,
    };
  });

  // Linked PRs, newest first, with live GitHub state.
  const prTickets = recent.filter((t) => t.prUrl).slice(0, 24);
  const states = await prStates(prTickets.map((t) => t.prUrl));
  const prs = prTickets.map((t) => ({ n: t.ticketNumber, title: t.title, url: t.prUrl, number: t.prNumber, at: t.opsTldrPostedAt || t.updatedAt, gh: states.get(t.prUrl) || null }));

  // 12 weeks of opened vs closed, plus resolution time.
  const weeks = [];
  const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  for (let k = 11; k >= 0; k--) weeks.push({ from: new Date(start.getTime() - k * 7 * 864e5), opened: 0, closed: 0 });
  const durations = [];
  const since30 = Date.now() - 30 * 864e5;
  for (const t of history) {
    const c = t.createdAt && new Date(t.createdAt);
    const d = (t.resolvedAt || t.closedAt) && new Date(t.resolvedAt || t.closedAt);
    for (let k = weeks.length - 1; k >= 0; k--) {
      if (c && c >= weeks[k].from) { weeks[k].opened++; break; }
    }
    for (let k = weeks.length - 1; k >= 0; k--) {
      if (d && d >= weeks[k].from) { weeks[k].closed++; break; }
    }
    if (c && d && d.getTime() >= since30 && d > c) durations.push((d - c) / 36e5);
  }
  durations.sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const closed7 = history.filter((t) => { const d = t.resolvedAt || t.closedAt; return d && Date.now() - new Date(d) < 7 * 864e5; }).length;

  const hist = history.map((t) => ({
    n: t.ticketNumber, t: t.title, s: t.status, c: t.category || "", r: reporterOf(t),
    o: t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : "", d: (t.resolvedAt || t.closedAt) ? new Date(t.resolvedAt || t.closedAt).toISOString().slice(0, 10) : "",
    p: t.prNumber || 0, g: (t.tags || []).slice(0, 4),
  }));

  return {
    active: activeRows,
    people: [...people.values()].map((p) => ({ ...p, tickets: p.tickets.size })).sort((a, b) => b.actions - a.actions).slice(0, 12),
    feed: compact.slice(0, 30), prs, weeks, median, closed7, total: history.length,
    waiting: activeRows.filter((r) => r.waiting || r.status === "awaiting_player").length,
    hist,
  };
}

function rel(d) {
  if (!d) return "";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  if (s < 86400 * 30) return Math.round(s / 86400) + "d ago";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function initials(n) {
  const p = String(n || "?").split(/[\s._-]+/).filter(Boolean);
  return ((p[0] || "?")[0] + (p[1] ? p[1][0] : (p[0] || "").slice(1, 2))).toUpperCase();
}
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
function statusChip(s) {
  const m = STATUS[s] || { label: s || "Unknown", color: "#94a3b8" };
  return `<span class="tk-st" style="--s:${m.color}"><i></i>${esc(m.label)}</span>`;
}

const TK_CSS = `
.tk{max-width:1480px;margin:0 auto;padding:28px 24px 64px}
.tk-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:18px}
.tk-head h1{margin:4px 0 0;font-size:clamp(1.7rem,3vw,2.3rem);letter-spacing:-.035em;font-weight:800;line-height:1.05}
.tk-head p{margin:6px 0 0;color:var(--text-2);font-size:.92rem}
.tk-eyebrow{font:700 .68rem var(--font);letter-spacing:.14em;text-transform:uppercase;color:#f472b6}
.tk-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr)) minmax(0,1.6fr);gap:10px;margin-bottom:22px}
.tk-kpi{padding:14px 16px;border:1px solid var(--border);border-radius:16px;background:var(--surface);box-shadow:var(--e1),var(--hi)}
.tk-kpi b{display:block;font-size:1.65rem;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.tk-kpi span{font:700 .64rem var(--font);letter-spacing:.09em;text-transform:uppercase;color:var(--text-3)}
.tk-kpi.hot b{color:#f59e0b}
.tk-chart{padding:12px 16px;border:1px solid var(--border);border-radius:16px;background:var(--surface);display:flex;flex-direction:column}
.tk-chart h3{margin:0;display:flex;gap:12px;font:700 .64rem var(--font);letter-spacing:.09em;text-transform:uppercase;color:var(--text-3)}
.tk-chart h3 i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:0}
.tk-chart svg{flex:1;width:100%;min-height:62px;margin-top:6px}
.tk-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:18px;align-items:start}
.tk-panel{border:1px solid var(--border);border-radius:18px;background:var(--surface);box-shadow:var(--e1),var(--hi);overflow:hidden;margin-bottom:18px}
.tk-ph{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)}
.tk-ph h2{margin:0;font-size:.95rem;font-weight:800;letter-spacing:-.02em}
.tk-ph .c{color:var(--text-3);font-weight:600;font-size:.8rem}
.tk-ph .sp{flex:1}
.tk-act{display:flex;flex-direction:column}
.tk-ticket{display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:14px;padding:14px 16px;border-top:1px solid var(--border);transition:background var(--t)}
.tk-ticket:first-child{border-top:0}
.tk-ticket:hover{background:var(--glass-2)}
.tk-num{font:800 .95rem var(--mono);color:var(--text-2)}
.tk-num small{display:block;font:600 .66rem var(--font);color:var(--text-3);margin-top:3px}
.tk-ticket h3{margin:0 0 5px;font-size:.92rem;font-weight:700;letter-spacing:-.015em;color:var(--text)}
.tk-line{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:.74rem;color:var(--text-3)}
.tk-upd{margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--glass-2);font-size:.78rem;color:var(--text-2);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tk-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.tk-st{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font:700 .68rem var(--font);color:var(--s);background:color-mix(in srgb,var(--s) 13%,transparent);white-space:nowrap}
.tk-st i{width:6px;height:6px;border-radius:50%;background:var(--s)}
.tk-own{display:inline-flex;align-items:center;gap:6px;font-size:.72rem;color:var(--text-2);font-weight:600}
.tk-av{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:800 .62rem var(--font);color:#0b1220;background:hsl(var(--h) 70% 72%);flex:none}
.tk-av.agent{border-radius:7px;background:linear-gradient(135deg,#a5b4fc,#67e8f9)}
.tk-av.lg{width:38px;height:38px;font-size:.78rem}
.tk-tag{padding:1px 7px;border-radius:6px;background:var(--glass-2);color:var(--text-2);font-weight:600}
.tk-pr{display:inline-flex;align-items:center;gap:4px;color:var(--accent);font-weight:700}
.tk-flag{color:#fb923c;font-weight:700}
.tk-empty{padding:30px 16px;text-align:center;color:var(--text-3);font-size:.85rem}
.tk-people{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;padding:14px}
.tk-person{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:13px;background:var(--bg-1)}
.tk-person b{display:block;font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk-person span{font-size:.7rem;color:var(--text-3)}
.tk-feed{position:relative;padding:8px 16px 14px;max-height:760px;overflow:auto}
.tk-ev{position:relative;display:grid;grid-template-columns:18px minmax(0,1fr);gap:10px;padding:9px 0}
.tk-ev::before{content:"";position:absolute;left:8px;top:26px;bottom:-9px;width:1px;background:var(--border)}
.tk-ev:last-child::before{display:none}
.tk-dot{width:17px;height:17px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--k) 18%,var(--surface));color:var(--k);margin-top:1px}
.tk-dot i{width:7px;height:7px;border-radius:50%;background:var(--k)}
.tk-ev b{font-size:.8rem;font-weight:700;color:var(--text)}
.tk-ev p{margin:2px 0 0;font-size:.76rem;color:var(--text-2);line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tk-ev .m{font-size:.68rem;color:var(--text-3);margin-top:3px}
.tk-prs{display:flex;flex-direction:column}
.tk-prrow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 16px;border-top:1px solid var(--border);font-size:.8rem}
.tk-prrow:first-child{border-top:0}
.tk-prrow:hover{background:var(--glass-2)}
.tk-prrow b{display:block;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk-prrow span{font-size:.7rem;color:var(--text-3)}
.tk-gh{padding:2px 8px;border-radius:999px;font:700 .66rem var(--font);color:var(--g);background:color-mix(in srgb,var(--g) 14%,transparent);white-space:nowrap}
.tk-hist-tools{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border)}
.tk-hist-tools input,.tk-hist-tools select{height:36px;padding:0 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-1);color:var(--text);font:500 .82rem var(--font)}
.tk-hist-tools input{flex:1;min-width:220px}
.tk-table{width:100%;border-collapse:collapse;font-size:.8rem}
.tk-table th{position:sticky;top:0;text-align:left;padding:9px 14px;background:var(--surface-2);font:700 .64rem var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);cursor:pointer;white-space:nowrap}
.tk-table td{padding:9px 14px;border-top:1px solid var(--border);vertical-align:middle}
.tk-table tr:hover td{background:var(--glass-2)}
.tk-table td.t{max-width:520px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:var(--text)}
.tk-table td.n{font-family:var(--mono);color:var(--text-2)}
.tk-table td.d{color:var(--text-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.tk-scroll{max-height:640px;overflow:auto}
.tk-more{display:flex;justify-content:center;padding:12px;border-top:1px solid var(--border)}
.tk-more button{height:34px;padding:0 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);color:var(--text);font:600 .8rem var(--font);cursor:pointer}
@media(max-width:1180px){.tk-kpis{grid-template-columns:repeat(3,1fr)}.tk-chart{grid-column:1/-1}.tk-cols{grid-template-columns:1fr}}
@media(max-width:600px){.tk{padding:18px 12px 40px}.tk-kpis{grid-template-columns:repeat(2,1fr)}.tk-ticket{grid-template-columns:48px minmax(0,1fr)}.tk-side{grid-column:2;flex-direction:row;align-items:center}}
`;

function chartSvg(weeks) {
  const W = 360, H = 70, n = weeks.length, bw = W / n;
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.opened, w.closed)));
  const bars = weeks.map((w, i) => {
    const ho = (w.opened / max) * (H - 12), hc = (w.closed / max) * (H - 12);
    const x = i * bw;
    return `<rect x="${(x + bw * 0.14).toFixed(1)}" y="${(H - ho).toFixed(1)}" width="${(bw * 0.34).toFixed(1)}" height="${ho.toFixed(1)}" rx="2" fill="#f472b6"><title>Week of ${w.from.toISOString().slice(5, 10)}: ${w.opened} opened</title></rect><rect x="${(x + bw * 0.52).toFixed(1)}" y="${(H - hc).toFixed(1)}" width="${(bw * 0.34).toFixed(1)}" height="${hc.toFixed(1)}" rx="2" fill="#34d399"><title>Week of ${w.from.toISOString().slice(5, 10)}: ${w.closed} closed</title></rect>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Tickets opened and closed per week">${bars}</svg>`;
}

function fmtHours(h) {
  if (h == null) return "n/a";
  if (h < 1) return Math.round(h * 60) + "m";
  if (h < 48) return h.toFixed(h < 10 ? 1 : 0) + "h";
  return (h / 24).toFixed(1) + "d";
}

function avatar(name, agent, lg) {
  return `<span class="tk-av${agent ? " agent" : ""}${lg ? " lg" : ""}" style="--h:${hue(name)}" title="${esc(name)}">${agent ? icon("bot", { size: lg ? 18 : 13 }) : esc(initials(name))}</span>`;
}

function makeTicketHubBody(d) {
  const active = d.active.map((t) => `<a class="tk-ticket" href="/tickets/${t.n}">
<div class="tk-num">#${t.n}<small>${esc(rel(t.created))}</small></div>
<div><h3>${esc(t.title || "Untitled ticket")}</h3>
<div class="tk-line"><span>${esc(t.reporter)}</span>${t.category ? `<span class="tk-tag">${esc(t.category)}</span>` : ""}${t.last ? `<span>Last activity ${esc(rel(t.last.at))}</span>` : ""}${t.waiting ? '<span class="tk-flag">Waiting on player</span>' : ""}${t.fixing ? '<span class="tk-tag">Fix session</span>' : ""}${t.pr ? `<span class="tk-pr">${icon("git-pull-request", { size: 12 })}#${esc(t.prNumber)}</span>` : ""}</div>
${t.update ? `<div class="tk-upd">${esc(t.update)}</div>` : ""}</div>
<div class="tk-side">${statusChip(t.status)}${t.owner ? `<span class="tk-own">${avatar(t.owner, t.ownerAgent)}${esc(t.owner)}</span>` : '<span class="tk-own" style="color:var(--text-3)">Unassigned</span>'}</div></a>`).join("");

  const people = d.people.map((p) => `<div class="tk-person">${avatar(p.name, p.agent, true)}<div style="min-width:0"><b>${esc(p.name)}</b><span>${p.tickets} ticket${p.tickets === 1 ? "" : "s"} · ${p.actions} step${p.actions === 1 ? "" : "s"}<br>${esc(rel(p.last))}</span></div></div>`).join("");

  const KC = { status: "#38bdf8", update: "#f472b6", pr: "#818cf8" };
  const feed = d.feed.map((e) => {
    const many = e.count > 1 ? ` (${e.count})` : "";
    const head = e.kind === "pr" ? `PR #${esc(e.number)} linked` : e.kind === "update" ? `Player update${e.count > 1 ? "s" : ""} sent${many}` : `Marked ${esc((STATUS[e.status] || { label: e.status }).label)}${many}`;
    return `<a class="tk-ev" href="/tickets/${e.n}" style="--k:${KC[e.kind] || "#94a3b8"}"><span class="tk-dot"><i></i></span><div><b>#${e.n} · ${head}</b>${e.text ? `<p>${esc(e.text.slice(0, 200))}</p>` : `<p>${esc(e.title || "")}</p>`}<div class="m">${e.who ? esc(e.who) + " · " : ""}${esc(rel(e.at))}</div></div></a>`;
  }).join("");

  const GH = { merged: "#a78bfa", open: "#34d399", closed: "#f87171" };
  const prs = d.prs.map((p) => {
    const g = p.gh;
    const state = g ? g.state : "linked";
    return `<a class="tk-prrow" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("git-pull-request", { size: 16 })}<div style="min-width:0"><b>${esc(g ? g.title : p.title)}</b><span>Ticket #${p.n} · ${esc(g ? g.repo.split("/")[1] : "")} #${esc(p.number)}${g && g.base ? " into " + esc(g.base) : ""}${g && g.author ? " · " + esc(g.author) : ""} · ${esc(rel(g ? g.updated : p.at))}</span></div><span class="tk-gh" style="--g:${GH[state] || "#94a3b8"}">${esc(state)}</span></a>`;
  }).join("");

  const statuses = [...new Set(d.hist.map((h) => h.s))].sort();
  const cats = [...new Set(d.hist.map((h) => h.c).filter(Boolean))].sort();

  const body = `<div class="tk">
<div class="tk-head"><div><div class="tk-eyebrow">Ticket hub</div><h1>Support, at a glance.</h1><p>What is open, who is on it, what changed and what shipped. Admin only.</p></div></div>
<div class="tk-kpis">
<div class="tk-kpi${d.active.length ? " hot" : ""}"><b>${d.active.length}</b><span>Open now</span></div>
<div class="tk-kpi"><b>${d.waiting}</b><span>Waiting on player</span></div>
<div class="tk-kpi"><b>${d.closed7}</b><span>Closed this week</span></div>
<div class="tk-kpi"><b>${fmtHours(d.median)}</b><span>Median fix time, 30d</span></div>
<div class="tk-kpi"><b>${d.total}</b><span>All-time tickets</span></div>
<div class="tk-chart"><h3><span><i style="background:#f472b6"></i>Opened</span><span><i style="background:#34d399"></i>Closed</span><span style="margin-left:auto">12 weeks</span></h3>${chartSvg(d.weeks)}</div>
</div>
<div class="tk-cols"><div>
<section class="tk-panel"><div class="tk-ph">${icon("life-buoy", { size: 16 })}<h2>Active tickets</h2><span class="c">${d.active.length}</span></div><div class="tk-act">${active || '<div class="tk-empty">No open tickets. Nice.</div>'}</div></section>
<section class="tk-panel"><div class="tk-ph">${icon("git-pull-request", { size: 16 })}<h2>GitHub activity</h2><span class="c">pull requests linked to tickets, 14 days</span></div><div class="tk-prs">${prs || '<div class="tk-empty">No linked pull requests in the last 14 days.</div>'}</div></section>
</div><div>
<section class="tk-panel"><div class="tk-ph">${icon("user", { size: 16 })}<h2>Who is working</h2><span class="c">last 14 days</span></div>${people ? `<div class="tk-people">${people}</div>` : '<div class="tk-empty">Nobody has touched a ticket in 14 days.</div>'}</section>
<section class="tk-panel"><div class="tk-ph">${icon("activity", { size: 16 })}<h2>Recent work</h2></div><div class="tk-feed">${feed || '<div class="tk-empty">No recent ticket activity.</div>'}</div></section>
</div></div>
<section class="tk-panel"><div class="tk-ph">${icon("clock", { size: 16 })}<h2>Ticket history</h2><span class="c" id="tkCount">${d.hist.length}</span></div>
<div class="tk-hist-tools"><input id="tkQ" type="search" placeholder="Search by number, title, player or tag" autocomplete="off">
<select id="tkS"><option value="">Any status</option>${statuses.map((s) => `<option value="${esc(s)}">${esc((STATUS[s] || { label: s }).label)}</option>`).join("")}</select>
<select id="tkC"><option value="">Any category</option>${cats.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
<select id="tkP"><option value="">With or without a PR</option><option value="1">Has a PR</option><option value="0">No PR</option></select></div>
<div class="tk-scroll"><table class="tk-table"><thead><tr><th data-k="n">#</th><th data-k="t">Title</th><th data-k="s">Status</th><th data-k="c">Category</th><th data-k="r">Player</th><th data-k="o">Opened</th><th data-k="d">Closed</th><th data-k="p">PR</th></tr></thead><tbody id="tkBody"></tbody></table></div>
<div class="tk-more" id="tkMore"><button type="button">Show more</button></div></section>
</div>
<script type="application/json" id="tkData">${JSON.stringify({ h: d.hist, st: STATUS }).replace(/</g, "\\u003c")}</script>
<script>${TK_JS}</script>`;
  return { extraCss: TK_CSS, body };
}

const TK_JS = `(function(){
var D=JSON.parse(document.getElementById('tkData').textContent),rows=D.h,ST=D.st,limit=80,sortK='n',dir=-1;
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function chip(s){var m=ST[s]||{label:s,color:'#94a3b8'};return'<span class="tk-st" style="--s:'+m.color+'"><i></i>'+esc(m.label)+'</span>'}
function render(){var q=$('tkQ').value.trim().toLowerCase(),s=$('tkS').value,c=$('tkC').value,p=$('tkP').value;
var list=rows.filter(function(r){if(s&&r.s!==s)return false;if(c&&r.c!==c)return false;if(p==='1'&&!r.p)return false;if(p==='0'&&r.p)return false;
if(q){var h=('#'+r.n+' '+r.n+' '+r.t+' '+r.r+' '+(r.g||[]).join(' ')+' '+r.c).toLowerCase();var w=q.split(/\\s+/);for(var i=0;i<w.length;i++)if(h.indexOf(w[i])<0)return false}return true});
list.sort(function(a,b){var x=a[sortK],y=b[sortK];if(typeof x==='number')return(x-y)*dir;return String(x||'').localeCompare(String(y||''))*dir});
$('tkCount').textContent=list.length+(list.length===rows.length?'':' of '+rows.length);
$('tkBody').innerHTML=list.slice(0,limit).map(function(r){return'<tr data-n="'+r.n+'"><td class="n">#'+r.n+'</td><td class="t" title="'+esc(r.t)+'">'+esc(r.t)+'</td><td>'+chip(r.s)+'</td><td>'+esc(r.c)+'</td><td>'+esc(r.r)+'</td><td class="d">'+esc(r.o)+'</td><td class="d">'+esc(r.d)+'</td><td class="d">'+(r.p?'#'+r.p:'')+'</td></tr>'}).join('')||'<tr><td colspan="8" class="d" style="text-align:center;padding:24px">No tickets match.</td></tr>';
$('tkMore').style.display=list.length>limit?'':'none'}
['tkQ','tkS','tkC','tkP'].forEach(function(id){$(id).addEventListener(id==='tkQ'?'input':'change',function(){limit=80;render()})});
$('tkMore').addEventListener('click',function(){limit+=200;render()});
$('tkBody').addEventListener('click',function(e){var tr=e.target.closest('tr[data-n]');if(tr)location.href='/tickets/'+tr.getAttribute('data-n')});
document.querySelector('.tk-table thead').addEventListener('click',function(e){var th=e.target.closest('th');if(!th)return;var k=th.getAttribute('data-k');if(sortK===k)dir=-dir;else{sortK=k;dir=k==='n'||k==='o'||k==='d'?-1:1}render()});
render();})();`;

module.exports = { loadTicketHub, makeTicketHubBody, ACTIVE, DONE, STATUS, actorName };
