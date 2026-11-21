"use strict";
// Keir 11.2 third pass (review M7): one switch per new unattended behaviour, a preview mode, and a bounded first start.
//
// Every pass added in 11.2 asks this module before it acts. Settings are plain configuration read at each pass, so they
// change without a code change or a restart:
//
//   file  <state dir>/switches.json   {"openPrCloses": "on", "preview": true}
//   env   KEIR_OPEN_PR_CLOSES=on, KEIR_PREVIEW=1, ...
//
// The file beats the environment, which beats the default. Each switch is "on", "off" or "preview". "preview" (or the
// global preview setting) makes the pass work out exactly what it would do and record it, with the reason, in one place
// (ledger.data.preview, printed by bin/keir-preview.js) without doing any of it.
//
// Every pass also stops entirely while the kill switch is engaged or Keir is paused. Closing pull requests and deleting
// branches additionally wait while the production hold file is active.
//
// First start: a pass handles at most a few historical items (from before its first real run) per run, and none older
// than the history cutoff, unless the item is still open.
const fs = require("node:fs");

const SWITCHES = Object.freeze({
  openPrPass: { env: "KEIR_OPEN_PR_PASS", on: true, what: "open Keir pull request pass: asks, description repairs, owner lines" },
  openPrCloses: { env: "KEIR_OPEN_PR_CLOSES", on: false, what: "open Keir pull request pass: closing pull requests" },
  openPrBranchDeletes: { env: "KEIR_OPEN_PR_BRANCH_DELETES", on: false, what: "open Keir pull request pass: deleting branches of closed pull requests" },
  githubReconcile: { env: "KEIR_GITHUB_RECONCILE", on: true, what: "GitHub reconcile: close or withdraw questions and mark approvals done from the pull request's real state" },
  promiseWakes: { env: "KEIR_PROMISE_WAKES", on: true, what: "promise keeper: wakes for due promises and the plain fallback post" },
  postBudget: { env: "KEIR_POST_BUDGET", on: true, what: "ticket post budget: one live notice per change and the hourly cap" },
  turnRule: { env: "KEIR_TURN_RULE", on: true, what: "turn rule: turn reports only when asked for, promised or called for" },
  decisionCards: { env: "KEIR_DECISION_CARDS", on: true, what: "complete a decision's kanban card when the decision ends" },
  closedTicketSweep: { env: "KEIR_CLOSED_TICKET_SWEEP", on: true, what: "withdraw open questions on closed tickets" },
  quietWakes: { env: "KEIR_QUIET_WAKE_CHECK", on: true, what: "quiet-wake check in code, escalation and parking" },
  stepBack: { env: "KEIR_STEP_BACK", on: true, what: "step-back activation on long tickets" },
  findingExpiry: { env: "KEIR_FINDING_EXPIRY", on: true, what: "close stale findings" },
  reviewGate: { env: "KEIR_REVIEW_ITEM_GATE", on: true, what: "review items stay fix in review until live; reopen on an unmerged close" },
  ownerAnswerNotice: { env: "KEIR_OWNER_ANSWER_NOTICE", on: true, what: "tell the owner once when a ticket message was not taken as an answer" },
});
const DEFAULT_FILE = "/var/lib/keir-operator/switches.json";
const HISTORY_PER_RUN = 3;
const HISTORY_DAYS = 7;
const PREVIEW_MAX = 400;
const DAY = 86400000;

const word = (v) => {
  if (v === true) return "on";
  if (v === false) return "off";
  const s = String(v ?? "").trim().toLowerCase();
  if (["1", "on", "true", "yes"].includes(s)) return "on";
  if (["0", "off", "false", "no"].includes(s)) return "off";
  if (["preview", "dry-run", "dryrun"].includes(s)) return "preview";
  return null;
};
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== "" && v !== null && v !== undefined ? Number(v) : d);

// The settings in force: { switches: {name: mode}, preview, historyPerRun, historyDays }.
function resolve({ env = {}, fileText = null } = {}) {
  let file = {};
  if (fileText) { try { const j = JSON.parse(fileText); if (j && typeof j === "object") file = j; } catch {} }
  const switches = {};
  for (const [name, s] of Object.entries(SWITCHES)) switches[name] = word(file[name]) || word(env[s.env]) || (s.on ? "on" : "off");
  const preview = (word(file.preview) || word(env.KEIR_PREVIEW)) === "on";
  return { switches, preview, historyPerRun: num(file.historyPerRun ?? env.KEIR_HISTORY_PER_RUN, HISTORY_PER_RUN), historyDays: num(file.historyDays ?? env.KEIR_HISTORY_DAYS, HISTORY_DAYS) };
}

// killSwitch: { state() -> { engaged, reason } }. data: the ledger data (paused). prodHold() -> ISO time or null.
function createControls({ file = process.env.KEIR_SWITCHES_FILE || DEFAULT_FILE, env = process.env, readFile = (f) => fs.readFileSync(f, "utf8"), now = () => Date.now(), killSwitch = null, data = null, prodHold = () => null, ttlMs = 5000, force = null } = {}) {
  let cached = null, at = -Infinity;
  function settings() {
    if (cached && now() - at < ttlMs) return cached;
    let text = null; try { text = readFile(file); } catch {}
    cached = resolve({ env, fileText: text }); at = now();
    if (force) cached = force(cached);
    return cached;
  }
  // "off", "preview" or "on" for one behaviour.
  function mode(name) {
    const s = settings();
    const m = s.switches[name] || "off";
    return m === "on" && s.preview ? "preview" : m;
  }
  // Why every new pass must stop now, or null.
  function held() {
    const k = killSwitch?.state?.();
    if (k?.engaged) return `kill switch engaged (${k.reason || "no reason"})`;
    if (data?.paused) return "Keir is paused";
    return null;
  }
  // { run, act, why }: run false means do nothing at all; act false means work it out and record it, do not do it.
  function gate(name, { destructive = false } = {}) {
    const h = held();
    if (h) return { run: false, act: false, why: h };
    const m = mode(name);
    if (m === "off") return { run: false, act: false, why: `${name} is off` };
    if (m === "preview") return { run: true, act: false, why: settings().preview ? "preview mode" : `${name} is in preview` };
    const hold = destructive ? prodHold() : null;
    if (hold) return { run: true, act: false, why: `production hold until ${hold}` };
    return { run: true, act: true, why: null };
  }
  return { settings, mode, held, gate };
}

// Fixed settings for tests and tools: every switch at its default unless named.
function staticControls(overrides = {}, { held = null, preview = false, prodHold = null, historyPerRun = HISTORY_PER_RUN, historyDays = HISTORY_DAYS } = {}) {
  const base = resolve({});
  const s = { ...base, switches: { ...base.switches, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, word(v) || "off"])) }, preview, historyPerRun, historyDays };
  return createControls({ readFile: () => { throw new Error("none"); }, killSwitch: { state: () => (held ? { engaged: true, reason: held } : { engaged: false }) }, prodHold: () => prodHold, force: () => s });
}
const DEFAULT_CONTROLS = staticControls();

// The preview record: one row per (pass, action, target), with the reason and how often it would have happened.
function preview(d, pass, action, target, reason, extra = {}, now = Date.now()) {
  const p = (d.preview ||= { items: {} });
  p.items ||= {};
  const key = `${pass}:${action}:${target}`;
  const row = p.items[key];
  if (row) { row.lastAt = now; row.count = (row.count || 1) + 1; row.reason = String(reason).slice(0, 400); Object.assign(row, extra); }
  else p.items[key] = { pass, action, target: String(target), reason: String(reason).slice(0, 400), firstAt: now, lastAt: now, count: 1, ...extra };
  p.updatedAt = now;
  const keys = Object.keys(p.items);
  if (keys.length > PREVIEW_MAX) for (const k of keys.sort((a, b) => p.items[a].lastAt - p.items[b].lastAt).slice(0, keys.length - PREVIEW_MAX)) delete p.items[k];
  return p.items[key];
}

// First start. since: when the pass first ran for real (set on that run). An item is historical when it happened before
// that. A historical item older than the cutoff is left alone unless the caller says it is still open; the rest are taken
// at most perRun at a time. In preview mode the first real run is assumed to be now, so the preview shows what it would do.
function history(d, pass, { controls = DEFAULT_CONTROLS, now = Date.now(), act = true } = {}) {
  const s = controls.settings();
  const since = ((d.controls ||= {}).since ||= {});
  if (act && !since[pass]) since[pass] = now;
  const start = since[pass] || now;
  let left = s.historyPerRun;
  const cutoff = now - s.historyDays * DAY;
  return {
    since: start,
    // at: when the item happened. open: still open and relevant. Returns "new", "take", "later" or "too old".
    check(at, { open = false } = {}) {
      if (!Number.isFinite(at) || at >= start) return "new";
      if (at < cutoff && !open) return "too old";
      if (left <= 0) return "later";
      left--; return "take";
    },
  };
}

module.exports = { SWITCHES, resolve, createControls, staticControls, DEFAULT_CONTROLS, preview, history, HISTORY_PER_RUN, HISTORY_DAYS };
