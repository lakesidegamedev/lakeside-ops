"use strict";

// program-tracker.js: one page per long-running program (/programs/<slug>).
//
// A program is a GitHub tracker issue with native sub-issues, a milestone, an
// integration branch and a kanban project card. This module owns all of it:
// the config (PROGRAMS), the snapshot loader, the pure derivations and the
// view. server.js only wires the route and the stale-while-refresh cache.
//
// The loader never throws. A GitHub or kanban outage becomes an error on its
// section of the snapshot, and a failed GitHub refresh keeps the last good
// GitHub data with a note, so the page degrades instead of going blank.
//
// Delivery stages follow the tracker rail: 1 on the integration branch, 2 in
// development, 3 in main (live). A merged PR only advances when its merge
// commit is an ancestor of the next branch, checked through the compare API.

const PROGRAMS = {
  "reset-2027": {
    slug: "reset-2027",
    name: "2027 world",
    outcome: "Launch a coherent January 2027 world and keep the major systems playable through December 2050.",
    repo: "lakesidegamedev/AHDGame",
    trackerIssue: 5687,
    milestone: "1.20 / 2027 world",
    branch: "release/1.20-2027",
    devBranch: "development",
    liveBranch: "main",
    kanbanCard: 255145,
  },
};

const REFRESH_MS = 5 * 60 * 1000;
const MAX_NODES = 150;
const MAX_DEPTH = 4;
const MAX_COMPARES = 30;
const MAX_CHECKED_PRS = 10;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ─── Pure parts ─────────────────────────────────────────────────────

// Task-list boxes outside fenced code. A box quoted in a code sample is an
// example, not work.
function parseCheckboxes(body) {
  let done = 0;
  let total = 0;
  let fenced = false;
  for (const line of String(body || "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(line);
    if (!m) continue;
    total += 1;
    if (m[1] !== " ") done += 1;
  }
  return { done, total };
}

// Issue numbers a PR points at: "Refs #12", "Fixes #3, #4", "Part of o/r#9".
// Cross-repo references count only when they name this repo.
function parseRefs(text, repo) {
  const out = new Set();
  const re = /\b(?:refs?|references|fix(?:es|ed)?|close[sd]?|resolve[sd]?|part of)\b\s*:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*(?:,|and)\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;
  let m;
  while ((m = re.exec(String(text || "")))) {
    for (const ref of m[1].matchAll(/([\w.-]+\/[\w.-]+)?#(\d+)/g)) {
      if (ref[1] && repo && ref[1].toLowerCase() !== repo.toLowerCase()) continue;
      out.add(Number(ref[2]));
    }
  }
  return [...out].sort((a, b) => a - b);
}

// stage: 0 not merged, 1 on branch, 2 in development, 3 live.
function prStage(pr) {
  if (!pr || !pr.merged_at) return 0;
  if (pr.live) return 3;
  if (pr.onDev) return 2;
  return 1;
}

const STATES = ["open", "in_progress", "blocked", "on_branch", "on_dev", "live", "done"];
const STATE_LABEL = {
  open: "Open", in_progress: "In progress", blocked: "Blocked", on_branch: "On branch",
  on_dev: "On dev", live: "Live", done: "Done",
};

// One state per workstream. Blocked wins while open, because a blocked item
// hiding behind "in progress" is the failure this page exists to show. A
// closed issue is placed by its least delivered merged PR: work is live only
// when all of it is.
function deriveState({ issue, card, prs }) {
  const labels = (issue && issue.labels) || [];
  const merged = (prs || []).filter((p) => p.merged_at);
  if (issue && issue.state === "closed") {
    if (!merged.length) return "done";
    const least = Math.min(...merged.map(prStage));
    return least >= 3 ? "live" : least === 2 ? "on_dev" : "on_branch";
  }
  if (labels.some((l) => /block/i.test(l)) || (card && card.lane === "blocked")) return "blocked";
  const boxes = (issue && issue.checkboxes) || { done: 0 };
  if ((card && card.lane === "now") || (prs || []).length || boxes.done > 0) return "in_progress";
  return "open";
}

function flatten(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ node: n, depth });
    flatten(n.children, depth + 1, out);
  }
  return out;
}

// Everything the view needs, computed once from the raw snapshot.
function summarize(snapshot) {
  const gh = (snapshot && snapshot.github) || {};
  const kb = (snapshot && snapshot.kanban) || {};
  const prs = gh.prs || [];
  const cardsByIssue = new Map();
  for (const c of kb.cards || []) if (c.github && c.github.number) cardsByIssue.set(c.github.number, c);

  const rows = flatten(gh.tree || []).map(({ node, depth }) => {
    const linked = prs.filter((p) => (p.refs || []).includes(node.number));
    const card = cardsByIssue.get(node.number) || null;
    return { issue: node, depth, card, prs: linked, state: deriveState({ issue: node, card, prs: linked }) };
  });
  // Kanban children with no GitHub issue in the tree still belong on the page.
  const treeNumbers = new Set(rows.map((r) => r.issue.number));
  for (const c of kb.children || []) {
    if (c.github && treeNumbers.has(c.github.number)) continue;
    const state = c.lane === "done" ? "done" : c.lane === "blocked" ? "blocked" : c.lane === "now" ? "in_progress" : "open";
    rows.push({ issue: null, depth: 0, card: c, prs: [], state });
  }

  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of rows) counts[r.state] += 1;
  const issues = rows.filter((r) => r.issue);
  const closed = issues.filter((r) => r.issue.state === "closed").length;
  const merged = prs.filter((p) => p.merged_at);
  return {
    rows,
    counts,
    total: issues.length,
    closed,
    merged: merged.length,
    openPrs: prs.filter((p) => !p.merged_at && p.state === "open"),
    mergedPrs: merged.slice().sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at)),
  };
}

function activity(snapshot, limit = 25) {
  const kb = (snapshot && snapshot.kanban) || {};
  const gh = (snapshot && snapshot.github) || {};
  const out = [];
  for (const e of kb.events || []) {
    out.push({ at: e.created_at, kind: "kanban", title: e.title, text: e.summary, actor: e.actor, href: `/kanban#item-${e.item_id}`, type: e.event_type });
  }
  for (const p of gh.prs || []) {
    if (p.merged_at) out.push({ at: p.merged_at, kind: "pr", title: `#${p.number} ${p.title}`, text: "Merged into the integration branch", href: p.url, type: "merged" });
  }
  return out.filter((a) => a.at && Number.isFinite(Date.parse(a.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── Loader ─────────────────────────────────────────────────────────

function makeGh({ token, fetchImpl = fetch, timeoutMs = 8000 }) {
  let calls = 0;
  async function get(path) {
    calls += 1;
    const r = await fetchImpl(`https://api.github.com/${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "lakeside-ops", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status} on ${path.split("?")[0]}`);
    return r.json();
  }
  get.calls = () => calls;
  return get;
}

function slimIssue(i) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    url: i.html_url,
    labels: (i.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
    checkboxes: parseCheckboxes(i.body),
    closed_at: i.closed_at || null,
    children: [],
  };
}

async function loadTree(get, repo, number, budget, depth = 1) {
  if (depth > MAX_DEPTH || budget.left <= 0) return [];
  const subs = await get(`repos/${repo}/issues/${number}/sub_issues?per_page=100`);
  const out = [];
  for (const s of subs || []) {
    if (budget.left-- <= 0) break;
    const node = slimIssue(s);
    const nested = s.sub_issues_summary ? s.sub_issues_summary.total > 0 : true;
    if (nested) node.children = await loadTree(get, repo, s.number, budget, depth + 1);
    out.push(node);
  }
  return out;
}

// Ancestry is permanent on protected branches, so a sha found in development
// or main stays there. Remembered across refreshes to keep the call count flat.
const containment = new Map();
async function contains(get, repo, base, sha, budget) {
  const key = `${repo}|${base}|${sha}`;
  if (containment.get(key) === true) return true;
  if (budget.left-- <= 0) return null;
  const c = await get(`repos/${repo}/compare/${encodeURIComponent(base)}...${sha}`);
  const yes = c.status === "behind" || c.status === "identical";
  if (yes) containment.set(key, true);
  return yes;
}

async function loadGithub(program, { get }) {
  const { repo, trackerIssue, branch, devBranch, liveBranch } = program;
  const issue = await get(`repos/${repo}/issues/${trackerIssue}`);
  const tree = await loadTree(get, repo, trackerIssue, { left: MAX_NODES });

  let milestone = null;
  if (issue.milestone && issue.milestone.title === program.milestone) milestone = issue.milestone;
  else {
    const all = await get(`repos/${repo}/milestones?state=all&per_page=100`);
    milestone = (all || []).find((m) => m.title === program.milestone) || null;
  }

  const raw = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await get(`repos/${repo}/pulls?base=${encodeURIComponent(branch)}&state=all&per_page=100&page=${page}`);
    raw.push(...(batch || []));
    if (!batch || batch.length < 100) break;
  }
  const prs = raw.filter((p) => p.state === "open" || p.merged_at).map((p) => ({
    number: p.number,
    title: p.title,
    url: p.html_url,
    state: p.state,
    draft: Boolean(p.draft),
    merged_at: p.merged_at || null,
    merge_sha: p.merge_commit_sha || null,
    head_sha: p.head && p.head.sha,
    refs: parseRefs(`${p.title}\n${p.body || ""}`, repo),
    onDev: false,
    live: false,
    checks: null,
  }));

  const compare = await get(`repos/${repo}/compare/${encodeURIComponent(devBranch)}...${encodeURIComponent(branch)}`);
  const branchInDev = compare.ahead_by === 0;
  const budget = { left: MAX_COMPARES };
  for (const pr of prs.filter((p) => p.merged_at && p.merge_sha)) {
    pr.onDev = branchInDev || (await contains(get, repo, devBranch, pr.merge_sha, budget)) === true;
    if (pr.onDev) pr.live = (await contains(get, repo, liveBranch, pr.merge_sha, budget)) === true;
  }

  // Check status for open PRs: one call each, capped.
  for (const pr of prs.filter((p) => !p.merged_at && p.head_sha).slice(0, MAX_CHECKED_PRS)) {
    try {
      const runs = await get(`repos/${repo}/commits/${pr.head_sha}/check-runs?per_page=100`);
      pr.checks = checkSummary(runs.check_runs || []);
    } catch { pr.checks = null; }
  }

  return {
    tracker: { number: issue.number, title: issue.title, state: issue.state, url: issue.html_url },
    tree,
    milestone: milestone ? { number: milestone.number, title: milestone.title, open: milestone.open_issues, closed: milestone.closed_issues, url: milestone.html_url } : null,
    prs,
    compare: { ahead_by: compare.ahead_by, behind_by: compare.behind_by, status: compare.status, branchInDev },
  };
}

function checkSummary(runs) {
  const out = { pass: 0, fail: 0, pending: 0 };
  for (const r of runs) {
    if (r.status !== "completed") out.pending += 1;
    else if (["success", "neutral", "skipped"].includes(r.conclusion)) out.pass += 1;
    else out.fail += 1;
  }
  return out;
}

// The program card, its children, and any card linked to an issue on the tree
// (cards for nested sub-issues are not always children of the program card).
function loadKanban(program, store, numbers) {
  const card = store.get(program.kanbanCard, { events: 0 });
  const { items: children } = store.list({ parent_id: card.id, include_done: true, limit: 500 });
  const cards = [...children];
  const seen = new Set([card.id, ...children.map((c) => c.id)]);
  if (numbers.length) {
    const linked = store.db.prepare(`SELECT id FROM kanban_items WHERE github_repo = ? AND github_number IN (${numbers.map(() => "?").join(",")})`)
      .all(program.repo, ...numbers);
    for (const { id } of linked) if (!seen.has(id)) { seen.add(id); cards.push(store.get(id, { events: 0 })); }
  }
  const ids = [...seen];
  const events = store.db.prepare(`SELECT e.item_id, i.title, e.event_type, e.actor, e.summary, e.evidence_url, e.created_at
    FROM kanban_events e JOIN kanban_items i ON i.id = e.item_id WHERE e.item_id IN (${ids.map(() => "?").join(",")})
    ORDER BY e.created_at DESC, e.id DESC LIMIT 40`).all(...ids);
  return { card, children, cards, events };
}

async function loadProgramSnapshot(program, { token, kanban, fetchImpl, previous = null, now = () => new Date() } = {}) {
  const snapshot = { slug: program.slug, refreshedAt: now().toISOString(), github: null, kanban: null };
  if (!token) snapshot.github = { error: "No GitHub token is configured for the dashboard." };
  else {
    try {
      snapshot.github = await loadGithub(program, { get: makeGh({ token, fetchImpl }) });
    } catch (cause) {
      const error = String((cause && cause.message) || cause);
      const prev = previous && previous.github && !previous.github.error ? previous.github : null;
      snapshot.github = prev ? { ...prev, staleError: error, staleSince: previous.github.staleSince || previous.refreshedAt } : { error };
    }
  }
  try {
    const tree = (snapshot.github && snapshot.github.tree) || [];
    snapshot.kanban = loadKanban(program, kanban(), flatten(tree).map((r) => r.node.number));
  } catch (cause) {
    snapshot.kanban = { error: String((cause && cause.message) || cause) };
  }
  return snapshot;
}

// ─── View ───────────────────────────────────────────────────────────

const CSS = `
.pg-wrap{max-width:1120px;margin:0 auto;padding:var(--s-5,24px) var(--s-4,16px);display:flex;flex-direction:column;gap:16px}
.pg-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.pg-head h1{font-size:1.4rem;font-weight:700;letter-spacing:-.02em;margin:0}
.pg-out{color:var(--text-2);font-size:.88rem;margin-top:4px;max-width:70ch}
.pg-links{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.pg-link{padding:3px 9px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--text-2);font-size:.74rem;font-weight:600;white-space:nowrap}
.pg-link:hover{color:var(--text);border-color:var(--border-2,var(--border))}
.pg-fresh{color:var(--text-3);font-size:.76rem;text-align:right;font-variant-numeric:tabular-nums}
.pg-card{border:1px solid var(--border);border-radius:13px;background:var(--surface);padding:14px 15px}
.pg-card > h2{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin:0 0 10px}
.pg-big{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.pg-big .n{font-size:1.9rem;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.pg-big .l{color:var(--text-3);font-size:.84rem}
.pg-bar{height:10px;border-radius:999px;background:var(--glass-3,var(--border));overflow:hidden;display:flex}
.pg-bar > i{display:block;height:100%}
.pg-bar.thin{height:5px;min-width:60px}
.pg-fill{background:var(--accent)}
.pg-seg{margin-top:10px}
.pg-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--text-3);font-size:.74rem}
.pg-legend span{display:inline-flex;align-items:center;gap:5px}
.pg-legend b{width:9px;height:9px;border-radius:3px;display:inline-block}
.pg-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px;margin-top:14px}
.pg-stat{border:1px solid var(--border);border-radius:11px;padding:9px 11px;background:var(--glass-1,transparent)}
.pg-stat .n{font-size:1.3rem;font-weight:700;font-variant-numeric:tabular-nums}
.pg-stat .l{color:var(--text-3);font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.pg-row{display:grid;grid-template-columns:minmax(0,1fr) 92px 120px minmax(0,1.1fr) 46px auto;gap:12px;align-items:center;padding:9px 0;border-top:1px solid var(--border)}
.pg-row.hd{border-top:0;padding-top:0;color:var(--text-3);font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.pg-t{min-width:0;font-size:.86rem}
.pg-t .tt{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-t .num{color:var(--text-3);font-size:.74rem;font-variant-numeric:tabular-nums}
.pg-row.d1 .pg-t{padding-left:18px}.pg-row.d2 .pg-t{padding-left:36px}.pg-row.d3 .pg-t{padding-left:54px}
.pg-row.d1 .pg-t::before,.pg-row.d2 .pg-t::before,.pg-row.d3 .pg-t::before{content:"└";color:var(--text-3);margin-right:6px;float:left}
.pg-box{display:flex;align-items:center;gap:7px;color:var(--text-3);font-size:.72rem;font-variant-numeric:tabular-nums}
.pg-box .pg-bar{flex:1}
.pg-kb{min-width:0;font-size:.78rem;color:var(--text-2)}
.pg-kb .p{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3)}
.pg-num{font-variant-numeric:tabular-nums;color:var(--text-2);font-size:.8rem;text-align:center}
.pg-acts{display:flex;gap:5px;justify-content:flex-end}
.pg-chip{padding:2px 8px;border-radius:999px;border:1px solid var(--border);background:var(--glass-2,var(--surface));color:var(--text-3);font-size:.66rem;font-weight:700;white-space:nowrap;justify-self:start}
.pg-chip.s-in_progress{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.pg-chip.s-blocked{color:#ffd79a;border-color:color-mix(in srgb,#f5a623 45%,var(--border));background:color-mix(in srgb,#f5a623 10%,var(--surface))}
.pg-chip.s-on_branch{color:#c4b5fd;border-color:color-mix(in srgb,#a371f7 45%,var(--border))}
.pg-chip.s-on_dev{color:#93c5fd;border-color:color-mix(in srgb,#58a6ff 45%,var(--border))}
.pg-chip.s-live,.pg-chip.s-done{color:#7ee2af;border-color:color-mix(in srgb,#34d399 45%,var(--border))}
.pg-chip.lane{font-weight:600}
.pg-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pg-pr{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--border);font-size:.84rem}
.pg-pr:first-of-type{border-top:0}
.pg-pr .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-pr .m{color:var(--text-3);font-size:.72rem;white-space:nowrap;font-variant-numeric:tabular-nums}
.pg-rail{display:flex;gap:3px}
.pg-rail i{display:block;width:22px;height:5px;border-radius:999px;background:var(--border-2,var(--border))}
.pg-rail i.on{background:var(--accent)}
.pg-rail i.on.live{background:#34d399}
.pg-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:.84rem}
.pg-kv dt{color:var(--text-3)}
.pg-kv dd{margin:0;font-variant-numeric:tabular-nums}
.pg-ck{font-size:.72rem;font-variant-numeric:tabular-nums}
.pg-ck .f{color:#ffb4b4}.pg-ck .ok{color:#7ee2af}.pg-ck .w{color:var(--text-3)}
.pg-act{display:grid;grid-template-columns:62px 18px minmax(0,1fr);gap:8px;padding:7px 0;border-top:1px solid var(--border);font-size:.82rem}
.pg-act:first-of-type{border-top:0}
.pg-act .w{color:var(--text-3);font-size:.72rem;font-variant-numeric:tabular-nums}
.pg-act .k{font-size:.72rem;color:var(--text-3)}
.pg-act .x{min-width:0}
.pg-act .x a{font-weight:600}
.pg-act .s{display:block;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-empty{padding:14px 0;color:var(--text-3);font-size:.84rem;text-align:center}
.pg-down{border:1px solid color-mix(in srgb,#e5484d 45%,var(--border));background:color-mix(in srgb,#e5484d 9%,var(--surface));color:#ffb4b4;padding:10px 13px;border-radius:11px;font-size:.84rem}
.pg-warn{border:1px solid color-mix(in srgb,#f5a623 45%,var(--border));background:color-mix(in srgb,#f5a623 9%,var(--surface));color:#ffd79a;padding:10px 13px;border-radius:11px;font-size:.84rem}
@media(max-width:860px){.pg-grid{grid-template-columns:1fr}}
@media(max-width:700px){
  .pg-row.hd{display:none}
  .pg-row{grid-template-columns:minmax(0,1fr) auto;gap:6px 10px}
  .pg-row .pg-box,.pg-row .pg-kb{grid-column:1/-1}
  .pg-row .pg-num{display:none}
  .pg-row.d1 .pg-t,.pg-row.d2 .pg-t,.pg-row.d3 .pg-t{padding-left:12px}
  .pg-fresh{text-align:left}
}
`;

const STATE_COLOR = {
  open: "var(--border-3,#555)", in_progress: "var(--accent)", blocked: "#f5a623",
  on_branch: "#a371f7", on_dev: "#58a6ff", live: "#34d399", done: "#2f855a",
};

function rail(stage) {
  return `<span class="pg-rail">${["On the integration branch", "In development", "Live in main"].map((title, i) => {
    const on = stage >= i + 1 ? " on" : "";
    const live = i === 2 && stage >= 3 ? " live" : "";
    return `<i class="${(on + live).trim()}" title="${title}"></i>`;
  }).join("")}</span>`;
}

function chip(state) {
  return `<span class="pg-chip s-${esc(state)}">${esc(STATE_LABEL[state] || state)}</span>`;
}

function bar(done, total, cls = "") {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `<span class="pg-bar ${cls}" role="img" aria-label="${done} of ${total}"><i class="pg-fill" style="width:${pct}%"></i></span>`;
}

function cleanText(s, max = 220) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t || /^[{[]/.test(t)) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstSentence(s) {
  const t = cleanText(s, 400);
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  return cleanText(m ? m[1] : t, 160);
}

function laneLabel(lane) {
  return { now: "Now", next: "Next", blocked: "Blocked", inbox: "Inbox", backlog: "Backlog", done: "Done" }[lane] || lane || "";
}

function workRow(r, now) {
  const i = r.issue;
  const c = r.card;
  const title = i
    ? `<span class="tt" title="${esc(i.title)}">${esc(i.title)}</span><span class="num">#${i.number}${i.labels.length ? ` · ${esc(i.labels.slice(0, 3).join(", "))}` : ""}</span>`
    : `<span class="tt" title="${esc(c.title)}">${esc(c.title)}</span><span class="num">Kanban only</span>`;
  const boxes = i && i.checkboxes.total
    ? `${bar(i.checkboxes.done, i.checkboxes.total, "thin")}<span>${i.checkboxes.done}/${i.checkboxes.total}</span>`
    : `<span>${i ? "No checklist" : ""}</span>`;
  const kb = c
    ? `<span class="pg-chip lane">${esc(laneLabel(c.lane))}</span>${c.assigned_to ? ` <span class="num">${esc(c.assigned_to)}</span>` : ""}<span class="p" title="${esc(cleanText(c.progress_summary, 600))}">${esc(firstSentence(c.progress_summary)) || "No progress reported"}${c.last_progress_at ? ` · ${esc(ago(c.last_progress_at, now))}` : ""}</span>`
    : `<span class="p">No kanban card</span>`;
  const links = [
    i ? `<a class="pg-link" href="${esc(i.url)}" target="_blank" rel="noreferrer noopener">GitHub</a>` : "",
    c ? `<a class="pg-link" href="/kanban#item-${esc(c.id)}">Card</a>` : "",
    c && c.evidence_url ? `<a class="pg-link" href="${esc(c.evidence_url)}" target="_blank" rel="noreferrer noopener">Evidence</a>` : "",
  ].join("");
  return `<div class="pg-row d${Math.min(r.depth, 3)}" data-state="${esc(r.state)}">
    <span class="pg-t">${title}</span>
    ${chip(r.state)}
    <span class="pg-box">${boxes}</span>
    <span class="pg-kb">${kb}</span>
    <span class="pg-num" title="Linked pull requests">${r.prs.length}</span>
    <span class="pg-acts">${links}</span>
  </div>`;
}

function prRow(pr, now) {
  return `<div class="pg-pr">
    ${rail(prStage(pr))}
    <a class="tt" href="${esc(pr.url)}" target="_blank" rel="noreferrer noopener" title="${esc(pr.title)}">#${pr.number} ${esc(pr.title)}</a>
    <span class="m">${esc(ago(pr.merged_at, now))}</span>
  </div>`;
}

function checks(c) {
  if (!c) return `<span class="pg-ck"><span class="w">checks unknown</span></span>`;
  const parts = [];
  if (c.fail) parts.push(`<span class="f">${c.fail} failing</span>`);
  if (c.pending) parts.push(`<span class="w">${c.pending} running</span>`);
  if (c.pass) parts.push(`<span class="ok">${c.pass} passed</span>`);
  return `<span class="pg-ck">${parts.join(" · ") || '<span class="w">no checks</span>'}</span>`;
}

function loadingBody(program) {
  return `<div class="pg-wrap">
    <div class="pg-head"><h1>${esc(program.name)}</h1></div>
    <div class="pg-empty" id="pgLoading" role="status">Loading the program from GitHub and the kanban...</div>
    <button id="pgRetry" type="button" hidden onclick="location.reload()">Try again</button>
  </div>
  <script>(function(){
    var attempts=0;
    async function check(){
      try{
        var r=await fetch('/api/programs/${esc(program.slug)}/cache-status',{cache:'no-store'});
        if(r.ok){var s=await r.json();if(s.ready){location.reload();return;}}
      }catch(e){}
      if(++attempts>=60){document.getElementById('pgLoading').textContent='The program data is still loading or unavailable.';document.getElementById('pgRetry').hidden=false;return;}
      setTimeout(check,1000);
    }
    setTimeout(check,700);
  })();</script>`;
}

function makeProgramBody(program, snapshot, { now = Date.now() } = {}) {
  if (!snapshot) return { extraCss: CSS, body: loadingBody(program) };
  const gh = snapshot.github || {};
  const kb = snapshot.kanban || {};
  const sum = summarize(snapshot);
  const [owner, name] = program.repo.split("/");
  const base = `https://github.com/${owner}/${name}`;
  const milestoneUrl = gh.milestone && gh.milestone.url
    ? gh.milestone.url
    : `${base}/issues?q=${encodeURIComponent(`milestone:"${program.milestone}"`)}`;
  const links = [
    [`${base}/issues/${program.trackerIssue}`, `Tracker #${program.trackerIssue}`, true],
    [milestoneUrl, `Milestone ${program.milestone}`, true],
    [`${base}/compare/${program.devBranch}...${program.branch}`, `${program.branch} vs ${program.devBranch}`, true],
    [`/kanban#item-${program.kanbanCard}`, `Kanban card ${program.kanbanCard}`, false],
  ].map(([href, label, ext]) => `<a class="pg-link" href="${esc(href)}"${ext ? ' target="_blank" rel="noreferrer noopener"' : ""}>${esc(label)}</a>`).join("");

  const notices = [
    gh.error ? `<div class="pg-down"><strong>GitHub data is unavailable.</strong> ${esc(gh.error)}</div>` : "",
    gh.staleError ? `<div class="pg-warn">GitHub refresh failed (${esc(gh.staleError)}). Showing data from ${esc(ago(gh.staleSince, now))}.</div>` : "",
    kb.error ? `<div class="pg-down"><strong>Kanban data is unavailable.</strong> ${esc(kb.error)}</div>` : "",
  ].join("");

  const pct = sum.total ? Math.round((sum.closed / sum.total) * 100) : 0;
  const segTotal = sum.rows.length;
  const segments = segTotal
    ? STATES.filter((s) => sum.counts[s]).map((s) => `<i style="width:${(sum.counts[s] / segTotal) * 100}%;background:${STATE_COLOR[s]}" title="${STATE_LABEL[s]}: ${sum.counts[s]}"></i>`).join("")
    : "";
  const legend = STATES.filter((s) => sum.counts[s]).map((s) => `<span><b style="background:${STATE_COLOR[s]}"></b>${STATE_LABEL[s]} ${sum.counts[s]}</span>`).join("");
  const counters = [["open", "Open"], ["in_progress", "In progress"], ["on_branch", "On branch"], ["on_dev", "On dev"], ["live", "Live"], ["blocked", "Blocked"]]
    .map(([k, l]) => `<div class="pg-stat"><div class="n">${sum.counts[k]}</div><div class="l">${l}</div></div>`).join("");
  const ms = gh.milestone ? `<span class="l">Milestone: ${gh.milestone.closed} closed, ${gh.milestone.open} open</span>` : "";

  const rows = sum.rows.length
    ? `<div class="pg-row hd"><span>Workstream</span><span>State</span><span>Checklist</span><span>Kanban</span><span>PRs</span><span></span></div>${sum.rows.map((r) => workRow(r, now)).join("")}`
    : `<div class="pg-empty">${gh.error ? "No workstreams while GitHub is unavailable." : "The tracker issue has no sub-issues yet."}</div>`;

  const deliveries = sum.mergedPrs.length
    ? sum.mergedPrs.map((p) => prRow(p, now)).join("")
    : `<div class="pg-empty">Nothing merged into ${esc(program.branch)} yet.</div>`;

  const cmp = gh.compare;
  const lastMerge = sum.mergedPrs[0];
  const health = cmp
    ? `<dl class="pg-kv">
        <dt>Ahead of ${esc(program.devBranch)}</dt><dd>${cmp.ahead_by} commit${cmp.ahead_by === 1 ? "" : "s"}</dd>
        <dt>Behind ${esc(program.devBranch)}</dt><dd>${cmp.behind_by} commit${cmp.behind_by === 1 ? "" : "s"}</dd>
        <dt>In ${esc(program.devBranch)}</dt><dd>${cmp.branchInDev ? "Yes, fully merged" : "Not yet"}</dd>
        <dt>Last merge</dt><dd>${lastMerge ? `${esc(ago(lastMerge.merged_at, now))} · #${lastMerge.number}` : "None"}</dd>
      </dl>`
    : `<div class="pg-empty">No branch data.</div>`;
  const openPrs = sum.openPrs.length
    ? sum.openPrs.map((p) => `<div class="pg-pr"><span class="pg-chip">${p.draft ? "Draft" : "Open"}</span><a class="tt" href="${esc(p.url)}" target="_blank" rel="noreferrer noopener" title="${esc(p.title)}">#${p.number} ${esc(p.title)}</a>${checks(p.checks)}</div>`).join("")
    : `<div class="pg-empty">No open PRs into the branch.</div>`;

  const acts = activity(snapshot);
  const recent = acts.length
    ? acts.map((a) => `<div class="pg-act"><span class="w">${esc(ago(a.at, now))}</span><span class="k" title="${a.kind === "pr" ? "Pull request" : "Kanban"}">${a.kind === "pr" ? "PR" : "KB"}</span><span class="x"><a href="${esc(a.href)}"${a.kind === "pr" ? ' target="_blank" rel="noreferrer noopener"' : ""}>${esc(a.title)}</a><span class="s" title="${esc(cleanText(a.text, 600))}">${esc(a.type)}${a.actor ? ` · ${esc(a.actor)}` : ""}${cleanText(a.text) ? ` · ${esc(cleanText(a.text, 180))}` : ""}</span></span></div>`).join("")
    : `<div class="pg-empty">No recent activity.</div>`;

  const body = `<div class="pg-wrap">
  <div class="pg-head">
    <div>
      <h1>${esc(program.name)}</h1>
      <div class="pg-out">${esc(program.outcome)}</div>
      <div class="pg-links">${links}</div>
    </div>
    <div class="pg-fresh">Refreshed ${esc(ago(snapshot.refreshedAt, now))}<br>${esc(String(snapshot.refreshedAt || "").replace("T", " ").slice(0, 16))} UTC<br>Updates every 5 minutes</div>
  </div>
  ${notices}
  <section class="pg-card">
    <h2>Overall progress</h2>
    <div class="pg-big"><span class="n">${sum.closed}/${sum.total}</span><span class="l">workstreams closed (${pct}%) · ${sum.merged} PR${sum.merged === 1 ? "" : "s"} merged</span>${ms}</div>
    ${bar(sum.closed, sum.total)}
    <div class="pg-bar pg-seg">${segments}</div>
    <div class="pg-legend">${legend}</div>
    <div class="pg-stats">${counters}</div>
  </section>
  <section class="pg-card"><h2>Workstreams</h2>${rows}</section>
  <div class="pg-grid">
    <section class="pg-card"><h2>Delivery: branch, dev, live</h2>${deliveries}</section>
    <section class="pg-card"><h2>Branch health: ${esc(program.branch)}</h2>${health}<h2 style="margin-top:14px">Open PRs into the branch</h2>${openPrs}</section>
  </div>
  <section class="pg-card"><h2>Recent activity</h2>${recent}</section>
</div>`;
  return { extraCss: CSS, body };
}

module.exports = {
  PROGRAMS,
  REFRESH_MS,
  parseCheckboxes,
  parseRefs,
  prStage,
  deriveState,
  summarize,
  activity,
  ago,
  checkSummary,
  loadProgramSnapshot,
  makeProgramBody,
};
