"use strict";

// kanban-sources.js: what a kanban card was raised from, besides a support
// ticket (ticket-refs.js), and how to read whether that source is finished.
//
// Two kinds live here:
// - a pull request (repo and number): the card is its work. When it merges
//   the card completes, unless the card says work is still owed after the
//   merge (a release, a migration to run, a follow-up fix); when it is closed
//   without merging, the card goes back to the inbox.
// - an alert (a stable key for a monitor's condition, plus an optional check
//   that says when the condition cleared): the card completes when the
//   condition clears, and the same condition reported again reopens it.
//
// Everything that decides is a pure function with tests; the readers take an
// injected runner so tests never reach GitHub or systemd, and they never
// guess: a source that cannot be read comes back "unknown" and nothing acts.

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// Repository names move (Egg3901 -> lakesidegamedev); kanban-store.js owns the
// canonical mapping and passes it in, so this module has no dependency loop.
let canonicalRepo = (repo) => repo;
function setRepoCanonicalizer(fn) { if (typeof fn === "function") canonicalRepo = fn; }

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

function prKey(ref) { return `${ref.repo}#${ref.number}`; }

// "owner/repo#N", "https://github.com/owner/repo/pull/N", { repo, number }.
// Issue URLs are not pull requests and are refused.
function parsePullRequest(input) {
  if (input == null || input === "") return null;
  if (typeof input === "object") {
    const number = Number(input.number);
    const repo = canonicalRepo(String(input.repo || "").trim());
    if (!Number.isSafeInteger(number) || number <= 0) throw badInput("pull_request number must be a positive integer");
    const [owner, name, extra] = repo.split("/");
    if (!owner || !name || extra !== undefined || !NAME_RE.test(owner) || !NAME_RE.test(name)) throw badInput("pull_request repo must look like owner/name");
    return { repo, number };
  }
  const text = String(input).trim();
  const url = text.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (url) return { repo: canonicalRepo(`${url[1]}/${url[2]}`), number: Number(url[3]) };
  const short = text.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (short) return { repo: canonicalRepo(`${short[1]}/${short[2]}`), number: Number(short[3]) };
  throw badInput(`unrecognized pull request "${text.slice(0, 120)}" (use owner/repo#N or a pull request URL)`);
}

function normalizePullRequests(input) {
  if (input == null || input === "") return [];
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const item of list.slice(0, 20)) {
    const ref = parsePullRequest(item);
    if (ref && !out.some((r) => prKey(r) === prKey(ref))) out.push(ref);
  }
  return out;
}

function parsePrRefs(value) {
  try {
    const list = JSON.parse(value || "[]");
    return Array.isArray(list) ? list.filter((r) => r && typeof r.repo === "string" && Number.isSafeInteger(r.number) && r.number > 0) : [];
  } catch {
    return [];
  }
}

// Conservative inference for cards that predate the explicit link: only a
// card whose title names exactly one pull request ("PR #5790", "pull request
// 5778") AND whose evidence link is that same pull request. A pull request
// named only in an evidence link is often one step of a larger program, so
// that alone never links.
function inferPullRequest({ title, evidence_url: evidence }) {
  const named = [...String(title || "").matchAll(/\b(?:PR|pull request)\s*#?(\d{1,6})\b/gi)].map((m) => Number(m[1]));
  const unique = [...new Set(named)];
  if (unique.length !== 1) return [];
  const url = String(evidence || "").match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/);
  if (!url || Number(url[3]) !== unique[0]) return [];
  return [{ repo: canonicalRepo(`${url[1]}/${url[2]}`), number: unique[0] }];
}

// What a card says is still owed once its pull request merges. Returns a
// short phrase ("release", "migration to run") or null. Leans towards
// finding something: a card kept open by mistake costs a glance, one closed
// by mistake loses work.
const OWED_WORDS = [
  [/\bmigrations?\b/i, "migration to run"],
  [/\b(?:release|released|releasing)\b/i, "release"],
  [/\bpromot(?:e|ion|ed|ing)\b/i, "promotion"],
  [/\bdeploy(?:ment|ed|ing)?\b/i, "deploy"],
  [/\bbackfill\b/i, "backfill"],
  [/\brollout|roll[- ]out\b/i, "rollout"],
  [/\b(?:device|production|prod|live|settled) (?:test|check|verification)\b|\bverif(?:y|ication)\b/i, "verification"],
  [/\bfollow[- ]?up (?:fix|pr|work|change)\b/i, "follow-up fix"],
  [/\bsubmission|app store review|testflight\b/i, "store submission"],
];
function owedPhrase(fragment) {
  for (const [re, phrase] of OWED_WORDS) if (re.test(fragment)) return phrase;
  return null;
}
function owedAfterMerge(...texts) {
  for (const raw of texts) {
    const text = String(raw || "").replace(/\s+/g, " ");
    if (!text) continue;
    // "+ follow-ups", "Follow-ups still open: ..." (live card 255354). A
    // mention of follow-ups that says they are finished does not count.
    if (/\bfollow[- ]?ups\b/i.test(text) && !/\bfollow[- ]?ups (?:are |were )?(?:all )?(?:done|complete|completed|closed|shipped|merged|cancelled)\b/i.test(text)) return "follow-ups";
    // "merged, next: release" / "Next step: run the migration"
    const next = text.match(/\bnext(?: step)?s?:\s*([^.;]{2,80})/i);
    if (next) return owedPhrase(next[1]) || next[1].trim().slice(0, 60);
    // "Pending release", "awaiting deployment", "migration ... must be run after the next promote",
    // "Production verification remains pending", "still owed: ..."
    const cue = /\b(?:pending|awaiting|await|waiting (?:on|for)|ready for|the next|needs?|remains?|remaining|still owed|still open|still to|then|after (?:the )?(?:merge|next promote|deploy))\b/i;
    for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
      if (!cue.test(sentence)) continue;
      const phrase = owedPhrase(sentence);
      if (phrase) return phrase;
      const owed = sentence.match(/\bstill owed:?\s*([^.;]{2,60})/i);
      if (owed) return owed[1].trim();
    }
  }
  return null;
}
const OWED_TITLE_RE = /^still owed after (?:pull request|PR)s? /i;

// ── Alerts ─────────────────────────────────────────────────────────────────
// A check says how to tell that an alert's condition cleared:
//   systemd:<unit>   the unit's latest run finished successfully after the
//                    alert was last reported (read-only `systemctl show`)
//   pr:<owner/repo#N> the held pull request is no longer open (merged or closed)
const KEY_RE = /^[\w.@:/#-]{3,160}$/;
function checkFor(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const unit = text.match(/^systemd:([\w@.:-]{1,120})$/);
  if (unit) return `systemd:${unit[1].includes(".") ? unit[1] : `${unit[1]}.service`}`;
  const pr = text.match(/^pr:(.+)$/);
  if (pr) return `pr:${prKey(parsePullRequest(pr[1]))}`;
  throw badInput("alert_check must be systemd:<unit> or pr:owner/repo#N");
}
function alertKeyFor(value) {
  if (value == null || value === "") return null;
  const key = String(value).trim();
  if (!KEY_RE.test(key)) throw badInput("alert_key must be 3-160 characters: letters, digits and . _ - : / # @");
  return key;
}

// The monitors that file cards today send no key. Their structured fields
// (the actor they always send, a fixed title form) name the condition
// exactly, so a key and a check are derived from those, never from loose
// title text. Anything that does not match exactly is an ordinary card.
function alertFromFields({ actor, title, detail, alert_key: key, alert_check: check }) {
  if (key) return { key: alertKeyFor(key), check: checkFor(check), link: "explicit" };
  const who = String(actor || "").trim().toLowerCase();
  const t = String(title || "").trim();
  const d = String(detail || "");
  if (who === "turn-hold-monitor" && t === "AHD turn-hold monitor CANNOT READ production") {
    // The monitor exits non-zero while it cannot read and 0 once it can.
    return { key: "turn-hold-monitor:cannot-read-production", check: "systemd:ahd-turn-hold-monitor.service", link: "derived" };
  }
  if (who === "turn-hold-monitor") {
    const held = t.match(/^AHD turn (\d+) HELD for repair\b/);
    if (held) return { key: `turn-hold-monitor:turn-${held[1]}-held`, check: null, link: "derived" };
  }
  if (who === "backup-alert") {
    const unit = t.match(/^(?:Backup unit|Service) FAILED: ([\w@.:-]{1,120})$/);
    if (unit) return { key: `unit-failed:${unit[1]}`, check: checkFor(`systemd:${unit[1]}`), link: "derived" };
  }
  if (who === "ahd-auto-promote") {
    const hold = t.match(/^Auto-promote held ([\w-]+->[\w-]+) at [0-9a-f]{7,40}: .*?\bPR #(\d+)\b/);
    const url = d.match(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/);
    if (hold && url && url[3] === hold[2]) {
      const ref = { repo: canonicalRepo(`${url[1]}/${url[2]}`), number: Number(hold[2]) };
      return { key: `ahd-auto-promote:${hold[1]}:pr-${hold[2]}`, check: `pr:${prKey(ref)}`, link: "derived" };
    }
  }
  if (who === "claude:maps") {
    const gen = t.match(/^Agent map generator failed: ([\w.-]{1,80})$/);
    if (gen) return { key: `agent-maps:${gen[1]}`, check: null, link: "derived" };
    if (/^AHD docs stale: \d+ problem/.test(t)) return { key: "ahd-doc-freshness:stale", check: null, link: "derived" };
  }
  return null;
}

// Card creators are only on the card's history, so backfill passes the
// creator in as actor.
function alertForCard(row, creator) {
  return alertFromFields({ actor: creator, title: row.title, detail: row.detail });
}

// ── Readers ────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const GH_BIN = process.env.GH_BIN || "gh";
// The same gh CLI the kanban GitHub issue sync uses (kanban-store.js ghJson),
// with the caller's auth. A GraphQL query that names a missing pull request
// fails as a whole but still prints the rest of the data; that data is used.
async function ghGraphql(query, run = execFileAsync) {
  try {
    const { stdout } = await run(GH_BIN, ["api", "graphql", "-f", `query=${query}`], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HOME: process.env.HOME || "/root" } });
    return JSON.parse(stdout);
  } catch (error) {
    const out = error && error.stdout ? String(error.stdout) : "";
    if (out) {
      try { const parsed = JSON.parse(out); if (parsed && parsed.data) return parsed; } catch { /* fall through */ }
    }
    throw error;
  }
}

function prState(node) {
  if (!node) return null;
  const state = String(node.state || "").toUpperCase();
  return {
    state: node.merged || state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : state === "OPEN" ? "open" : "unknown",
    merged_at: node.mergedAt || null,
    closed_at: node.closedAt || node.mergedAt || null,
    merge_commit: node.mergeCommit && node.mergeCommit.abbreviatedOid ? node.mergeCommit.abbreviatedOid : null,
    title: node.title ? String(node.title).slice(0, 200) : null,
    url: node.url || null,
  };
}

// Pull request state, batched (one GraphQL call per 40 pull requests),
// cached briefly. states(refs, { fresh }) -> Map("owner/repo#N" -> { state:
// open | merged | closed | unknown, merged_at, closed_at, merge_commit,
// checked_at, note? }). Never throws.
function createPullRequestReader({ run, ttlMs = 5 * 60_000, timeoutMs = 60_000, now = () => Date.now(), graphql = ghGraphql } = {}) {
  const cache = new Map();
  let lastError = null;
  async function states(refs, { fresh = false } = {}) {
    const list = [];
    for (const r of refs || []) if (r && NAME_RE.test(String(r.repo).split("/")[0] || "") && NAME_RE.test(String(r.repo).split("/")[1] || "") && Number.isSafeInteger(r.number) && !list.some((x) => prKey(x) === prKey(r))) list.push(r);
    const at = now();
    const need = list.filter((r) => { const c = cache.get(prKey(r)); return fresh || !c || at - c.fetchedAt >= ttlMs; });
    const failed = new Map();
    for (let i = 0; i < need.length; i += 40) {
      const chunk = need.slice(i, i + 40);
      const byRepo = new Map();
      chunk.forEach((r) => { if (!byRepo.has(r.repo)) byRepo.set(r.repo, []); byRepo.get(r.repo).push(r); });
      const repos = [...byRepo.entries()];
      const query = `query { ${repos.map(([repo, prs], ri) => {
        const [owner, name] = repo.split("/");
        return `r${ri}: repository(owner: "${owner}", name: "${name}") { ${prs.map((p) => `p${p.number}: pullRequest(number: ${p.number}) { number state merged mergedAt closedAt url title mergeCommit { abbreviatedOid } }`).join(" ")} }`;
      }).join(" ")} }`;
      try {
        const reply = await withTimeout(graphql(query, run), timeoutMs, "GitHub read");
        const data = (reply && reply.data) || {};
        const fetchedAt = now();
        repos.forEach(([repo, prs], ri) => {
          const repoNode = data[`r${ri}`];
          for (const p of prs) {
            const node = repoNode ? repoNode[`p${p.number}`] : null;
            const st = prState(node);
            if (st && st.state !== "unknown") cache.set(prKey(p), { snapshot: st, fetchedAt });
            else failed.set(prKey(p), `GitHub returned no pull request ${prKey(p)}`);
          }
        });
        lastError = null;
      } catch (error) {
        const message = String((error && error.message) || error).replace(/\s+/g, " ").slice(0, 200);
        lastError = { at, message };
        for (const p of chunk) failed.set(prKey(p), `GitHub could not be read (${message})`);
      }
    }
    const out = new Map();
    for (const r of list) {
      const key = prKey(r);
      const c = cache.get(key);
      if (failed.has(key) || !c) {
        out.set(key, { repo: r.repo, number: r.number, state: "unknown", note: failed.get(key) || "not read" });
        continue;
      }
      out.set(key, { repo: r.repo, number: r.number, ...c.snapshot, checked_at: new Date(c.fetchedAt).toISOString(), age_seconds: Math.round(Math.max(0, at - c.fetchedAt) / 1000) });
    }
    return out;
  }
  return { states, lastError: () => lastError, clear: () => cache.clear() };
}

// Read-only unit state: `systemctl show --timestamp=unix`.
async function systemdUnitState(unit, run = execFileAsync) {
  if (!/^[\w@.:-]{1,120}$/.test(unit)) throw new Error(`bad unit name ${unit}`);
  const { stdout } = await run("systemctl", ["show", "--timestamp=unix", "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp", "-p", "LoadState", unit], { timeout: 10_000 });
  const fields = Object.fromEntries(String(stdout).split("\n").filter(Boolean).map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  const ts = /^@(\d+)$/.exec(fields.ExecMainExitTimestamp || "");
  return {
    loaded: fields.LoadState === "loaded",
    active_state: fields.ActiveState || null,
    result: fields.Result || null,
    exit_status: fields.ExecMainStatus === undefined ? null : Number(fields.ExecMainStatus),
    exited_at: ts ? new Date(Number(ts[1]) * 1000).toISOString() : null,
  };
}

// Alert conditions. states(entries [{ id, key, check, since }]) -> Map(id (or key) ->
// { state: clear | firing | unknown, cleared_at?, how? }). An entry whose
// check is missing, or cannot be read, is unknown: such a card closes only
// when its monitor says so (kanban_alert_clear). Never throws.
function createAlertReader({ prReader = null, unitState = null, now = () => Date.now() } = {}) {
  async function states(entries) {
    const out = new Map();
    const prRefs = [];
    for (const e of entries || []) if (e.check && e.check.startsWith("pr:")) { try { prRefs.push(parsePullRequest(e.check.slice(3))); } catch { /* bad check: unknown */ } }
    let prs = new Map();
    if (prRefs.length && prReader) { try { prs = await prReader.states(prRefs, { fresh: true }); } catch { prs = new Map(); } }
    const units = new Map(); // one systemctl read per unit per call
    for (const e of entries || []) {
      const since = Date.parse(e.since || "") || 0;
      let st = { state: "unknown", note: e.check ? "the condition could not be read" : "no check for this alert; it clears when its monitor says so" };
      try {
        if (e.check && e.check.startsWith("systemd:") && unitState) {
          const unit = e.check.slice(8);
          if (!units.has(unit)) units.set(unit, unitState(unit));
          const u = await units.get(unit);
          const exited = Date.parse(u.exited_at || "") || 0;
          if (!u.loaded) st = { state: "unknown", note: `unit ${unit} is not loaded here` };
          else if (u.active_state !== "failed" && u.result === "success" && (u.exit_status === 0 || u.exit_status === null) && exited > since) {
            st = { state: "clear", cleared_at: u.exited_at, how: `${unit} ran successfully at ${u.exited_at.slice(0, 16).replace("T", " ")} UTC` };
          } else if (u.active_state === "failed" || (u.result && u.result !== "success")) st = { state: "firing", note: `${unit} last run: ${u.result || u.active_state}` };
          else st = { state: "firing", note: `${unit} has not finished a run since the alert` };
        } else if (e.check && e.check.startsWith("pr:")) {
          const ref = parsePullRequest(e.check.slice(3));
          const p = prs.get(prKey(ref));
          if (p && p.state === "merged") st = { state: "clear", merged_pr: ref.number, cleared_at: p.merged_at, how: `pull request ${prKey(ref)} was merged${p.merge_commit ? ` (${p.merge_commit})` : ""}` };
          else if (p && p.state === "closed") st = { state: "clear", cleared_at: p.closed_at, how: `pull request ${prKey(ref)} was closed without merging, so nothing is held on it any more` };
          else if (p && p.state === "open") st = { state: "firing", note: `pull request ${prKey(ref)} is still open` };
          else st = { state: "unknown", note: (p && p.note) || "GitHub could not be read" };
        }
      } catch (error) {
        st = { state: "unknown", note: `the condition could not be read (${String((error && error.message) || error).slice(0, 120)})` };
      }
      out.set(e.id ?? e.key, { key: e.key, ...st, checked_at: new Date(now()).toISOString() });
    }
    return out;
  }
  return { states };
}

function badInput(message) {
  const error = new Error(message);
  error.code = "BAD_INPUT";
  return error;
}

module.exports = {
  setRepoCanonicalizer,
  prKey,
  parsePullRequest,
  normalizePullRequests,
  parsePrRefs,
  inferPullRequest,
  owedAfterMerge,
  OWED_TITLE_RE,
  checkFor,
  alertKeyFor,
  alertFromFields,
  alertForCard,
  createPullRequestReader,
  createAlertReader,
  systemdUnitState,
  ghGraphql,
};

// The readers a process uses for the reconcile pass. KANBAN_SOURCE_GITHUB=off
// skips pull request rules; KANBAN_ALERT_SYSTEMD=off skips unit checks. On an
// install without gh or systemctl the reads fail, every such source is
// unknown, and nothing is changed.
function createSourceReaders(env = process.env) {
  const prReader = String(env.KANBAN_SOURCE_GITHUB || "on").toLowerCase() === "off" ? null : createPullRequestReader();
  const unitState = String(env.KANBAN_ALERT_SYSTEMD || "on").toLowerCase() === "off" ? null : (unit) => systemdUnitState(unit);
  return { prReader, alertReader: createAlertReader({ prReader, unitState }) };
}
module.exports.createSourceReaders = createSourceReaders;
