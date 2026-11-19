"use strict";
const { JOB_TERMINAL } = require("./machines");
// Keir 10.3 shift log. A short world summary (about 1,500 characters) for every ticket activation, so a task that starts
// cold knows what the owner decided today, what is being fixed, what shipped, how the turn is doing and what is already a
// known bug. Refreshed by a model-free collector every 10 minutes (operator.js ticker) and read from the ledger snapshot by
// activations; a stale or missing snapshot is rebuilt in the activation within a short timeout. Every section is collected on
// its own and degrades to "unavailable" on error, so one dead source never costs the rest. Nothing here throws. No player
// names: only counts, ticket numbers, card titles, release and PR titles.

const SHIFT_CHARS = 1600;
const TTL_MS = 10 * 60000;
const TERMINAL = new Set(JOB_TERMINAL);
const clip = (t, n) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
const parse = (v) => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return null; } } if (v && typeof v === "object" && typeof v.content === "string") return parse(v.content); return v ?? null; };
const rowsOf = (v) => { const p = parse(v); return Array.isArray(p) ? p : p?.items || p?.results || p?.turns || p?.cards || []; };
const noDash = (t) => String(t || "").replace(/[\u2013\u2014]/g, "-");
const withTimeout = (p, ms) => { let t; return Promise.race([Promise.resolve().then(p), new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(t)); };

// Midnight of the current America/New_York day, as epoch ms.
function startOfEasternDay(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(now));
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  return now - ((v.hour % 24) * 3600 + v.minute * 60 + v.second) * 1000;
}

// Words of a title, for grouping near-identical bug reports.
const TSTOP = new Set("the a an is are was to of in on for and or my not does do no it its with when why how can cant cannot i me our".split(" "));
const tw = (t) => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !TSTOP.has(w)).map((w) => w.replace(/s$/, "")));
const jaccard = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n || 1); };
// Group by title similarity; largest groups first.
function groupTitles(items, { threshold = 0.4, top = 5 } = {}) {
  const groups = [];
  for (const it of items) {
    const words = tw(it.title);
    if (!words.size) continue;
    const g = groups.find((x) => jaccard(x.words, words) >= threshold);
    if (g) { g.tickets.push(it.number); for (const w of words) g.words.add(w); } else groups.push({ title: clip(it.title, 70), words: new Set(words), tickets: [it.number] });
  }
  return groups.sort((a, b) => b.tickets.length - a.tickets.length).slice(0, top).map((g) => ({ title: g.title, tickets: g.tickets }));
}

// Each source returns an array of short lines, or throws. `sources` are injected so tests stub them.
function sourcesFor({ ledger, mcp, api, releasesFile, repo = "lakesidegamedev/AHDGame", now = () => Date.now() }) {
  const d = () => ledger.data;
  const call = (server, tool, args) => mcp.call(server, tool, args, false);
  return {
    decisions: async () => {
      const since = startOfEasternDay(now());
      const rows = Object.values(d().decisions || {}).filter((x) => x.state && x.state !== "pending" && (x.answeredAt || x.at || 0) >= since)
        .sort((a, b) => (a.answeredAt || a.at || 0) - (b.answeredAt || b.at || 0)).slice(-5);
      return rows.map((x) => `${clip(x.tldr || x.question, 70)} -> ${clip(x.answerText || x.answer || x.state, 40)}`);
    },
    fixes: async () => {
      const own = Object.values(d().jobs || {}).filter((j) => j.kind === "coding" && !j.investigation && !TERMINAL.has(j.state)).slice(-4).map((j) => {
        const parent = d().jobs?.[j.codingParent];
        const prs = (j.pullRequests || []).map((p) => `#${String(p?.number || p).split("/").pop()}`).slice(-2).join(" ");
        return `Keir worker, ticket ${parent?.ticket || "?"}: ${clip(j.summary || j.title || "fix", 60)}${prs ? ` (PR ${prs})` : ""}`;
      });
      let cards = [];
      try { cards = rowsOf(await call("ops-knowledge", "kanban_list", { product: "a-house-divided", lane: "now", limit: 8 })).filter((c) => c.product === "a-house-divided" || !c.product).slice(0, 5).map((c) => `card ${c.id}: ${clip(c.title, 70)}`); } catch { cards = ["kanban unavailable"]; }
      return [...own, ...cards];
    },
    releases: async () => {
      // Game first: the per-section budget would otherwise drop it behind Keir's own releases.
      const lines = [];
      const day = now() - 24 * 3600000;
      try {
        const commits = await api([`repos/${repo}/commits?sha=main&per_page=10&since=${encodeURIComponent(new Date(day).toISOString())}`]);
        const list = Array.isArray(commits) ? commits : [];
        lines.push(`game main: ${list.length} commit${list.length === 1 ? "" : "s"} in 24h${list.length ? `, latest "${clip(String(list[0]?.commit?.message || "").split("\n")[0], 70)}"` : ""}`);
      } catch { lines.push("game main unavailable"); }
      try {
        const rows = require("node:fs").readFileSync(releasesFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.at >= day);
        for (const r of rows.slice(-2)) lines.push(`Keir ${r.version || String(r.sha || "").slice(0, 7)} (${clip(r.reason || r.kind, 50)})`);
      } catch { lines.push("Keir releases unavailable"); }
      return lines;
    },
    turn: async () => {
      const turns = rowsOf(await call("engine", "recent_turns", { limit: 5 }));
      if (!turns.length) throw new Error("no turns");
      const latest = turns[0], failed = turns.filter((t) => t.success === false || (t.failedPhases || []).length);
      const bits = [`current turn ${latest.turn}${latest.success === false ? " FAILED" : " ok"}`];
      if (failed.length) bits.push(`failed phases: ${[...new Set(failed.flatMap((t) => (t.failedPhases || []).map((p) => (typeof p === "string" ? p : p?.phase || p?.name || "?"))))].slice(0, 4).join(", ") || "unnamed"} (turns ${failed.map((t) => t.turn).slice(0, 3).join(", ")})`);
      return [bits.join("; ")];
    },
    // Model-free: read from the ledger copy the review sweep keeps (reviewsweep.js). One full line, not a list.
    review: async () => { const line = require("./reviewsweep").shiftLine(ledger, now()); return line ? [line] : []; },
    bugs: async () => {
      const items = rowsOf(await call("support", "support_list", { kind: "ticket", status: "open", limit: 60 })).filter((t) => !t.category || t.category === "bug");
      const groups = groupTitles(items);
      return groups.map((g) => `${g.tickets.length > 1 ? `${g.tickets.length} tickets` : "1 ticket"} (${g.tickets.slice(0, 3).map((n) => `#${n}`).join(", ")}): ${g.title}`);
    },
  };
}

const SECTIONS = [["decisions", "Owner decisions today"], ["fixes", "Fixes in flight"], ["releases", "Shipped, last 24h"], ["turn", "Turn"], ["bugs", "Known bugs (open tickets)"], ["review", "Review queue"]];

// Collect every section; a failed or empty section reads "unavailable" or "none". Returns { text, at, sections }.
async function collect(sources, { now = () => Date.now(), timeoutMs = 6000, cap = SHIFT_CHARS } = {}) {
  const results = await Promise.all(SECTIONS.map(async ([key]) => {
    try { const lines = await withTimeout(() => sources[key](), timeoutMs); return { key, lines: (Array.isArray(lines) ? lines : []).map((l) => noDash(clip(l, 140))).filter(Boolean), ok: true }; }
    catch { return { key, lines: [], ok: false }; }
  }));
  const per = Math.floor((cap - 200) / (SECTIONS.length - 1));
  const blocks = results.map((r, i) => {
    const title = SECTIONS[i][1];
    if (!r.ok) return `${title}: unavailable`;
    if (!r.lines.length) return `${title}: none`;
    if (SECTIONS[i][0] === "review") return r.lines[0];
    let body = ""; for (const l of r.lines) { if ((body + l).length + 4 > per + (i === 1 || i === 4 ? 80 : 0)) break; body += `\n- ${l}`; }
    return `${title}:${body}`;
  });
  const head = "Shift log (internal context, refreshed every 10 minutes; do not quote it to players, verify before relying on it):";
  const text = [head, ...blocks].join("\n").slice(0, cap);
  return { text, at: now(), sections: Object.fromEntries(results.map((r) => [r.key, r.ok ? r.lines.length : "unavailable"])) };
}

function createShiftLog({ ledger, mcp, api, releasesFile = "/opt/keir/releases.jsonl", now = () => Date.now(), log = () => {}, sources = null, ttlMs = TTL_MS }) {
  const src = sources || sourcesFor({ ledger, mcp, api, releasesFile, now });
  let inflight = null;
  async function refresh() {
    if (inflight) return inflight;
    inflight = collect(src, { now }).then((snap) => { try { (ledger.data.shiftLog = snap); ledger.save?.(); } catch { /* the snapshot also lives in memory */ } return snap; })
      .catch((e) => { log(`shiftlog: ${e.message}`); return null; }).finally(() => { inflight = null; });
    return inflight;
  }
  // The snapshot for an activation: the ledger copy while fresh, otherwise a rebuild bounded by waitMs.
  async function get({ waitMs = 8000 } = {}) {
    try {
      const snap = ledger.data.shiftLog;
      if (snap?.text && now() - snap.at < ttlMs * 2) return snap.text;
      const fresh = await withTimeout(() => refresh(), waitMs).catch(() => null);
      return fresh?.text || snap?.text || null;
    } catch { return null; }
  }
  return { refresh, get, ttlMs };
}

module.exports = { createShiftLog, collect, sourcesFor, groupTitles, startOfEasternDay, SHIFT_CHARS, TTL_MS };
