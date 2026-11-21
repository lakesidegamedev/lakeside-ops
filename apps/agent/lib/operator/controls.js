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
  // Fourth pass (review N7): the remaining new behaviours that change what Keir does.
  channelAnswers: { env: "KEIR_CHANNEL_ANSWERS", on: true, what: "record an owner's ticket message as the answer to an open question (reply or named option)" },
  oneAsk: { env: "KEIR_ONE_ASK", on: true, what: "one ask per PR: join, refuse or replace a second ask about the same PR" },
  finishNeedsCondition: { env: "KEIR_FINISH_NEEDS_CONDITION", on: true, what: "refuse a ticket or finding finish that has no closing condition" },
  mergeDeadEnd: { env: "KEIR_MERGE_DEAD_END", on: true, what: "a refused approved merge: repair Keir's own PR description or tell the owner what blocks it" },
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

// Review 4 N2: a file that exists but cannot be used fails safe. A missing file means the defaults. A file that is empty,
// does not parse, is not a JSON object, or cannot be read puts every pass that defaults to on into preview and keeps
// every pass that defaults to off (closes, branch deletes) off, whatever the environment says. A leading byte-order mark
// is dropped first. In a file that parses, an unknown key is ignored and an unusable value fails safe for that one key
// (a pass that defaults to on goes to preview, one that defaults to off stays off, an unusable "preview" means preview);
// each is listed in warnings.
const PROBLEM_KEYS = new Set(["preview", "historyPerRun", "historyDays"]);
const failSafe = (s) => (s.on ? "preview" : "off");

// The settings in force: { switches: {name: mode}, preview, historyPerRun, historyDays, fileProblem, warnings }.
// fileText: the file's text, or null when there is no file. fileError: why an existing file could not be read.
function resolve({ env = {}, fileText = null, fileError = null } = {}) {
  let file = {}, fileProblem = fileError ? `switches file could not be read (${fileError})` : null;
  const warnings = [];
  if (!fileProblem && fileText !== null && fileText !== undefined) {
    const text = String(fileText).replace(/^\uFEFF/, "");
    if (!text.trim()) fileProblem = "switches file is empty";
    else {
      let j;
      try { j = JSON.parse(text); } catch (e) { fileProblem = `switches file does not parse (${String(e.message).slice(0, 120)})`; }
      if (!fileProblem) {
        if (j && typeof j === "object" && !Array.isArray(j)) file = j;
        else fileProblem = `switches file is not a JSON object (${Array.isArray(j) ? "an array" : j === null ? "null" : typeof j})`;
      }
    }
  }
  const switches = {};
  if (fileProblem) {
    for (const [name, s] of Object.entries(SWITCHES)) switches[name] = s.on ? (word(env[s.env]) === "off" ? "off" : "preview") : "off";
    return { switches, preview: true, historyPerRun: HISTORY_PER_RUN, historyDays: HISTORY_DAYS, fileProblem, warnings };
  }
  for (const key of Object.keys(file)) if (!SWITCHES[key] && !PROBLEM_KEYS.has(key)) warnings.push(`unknown key "${String(key).slice(0, 60)}" ignored`);
  for (const [name, s] of Object.entries(SWITCHES)) {
    const has = Object.prototype.hasOwnProperty.call(file, name);
    if (has && !word(file[name])) warnings.push(`${name}: value ${JSON.stringify(file[name]).slice(0, 40)} is not on, off or preview; treated as ${failSafe(s)}`);
    switches[name] = has ? (word(file[name]) || failSafe(s)) : (word(env[s.env]) || (s.on ? "on" : "off"));
  }
  const hasPreview = Object.prototype.hasOwnProperty.call(file, "preview");
  const previewWord = hasPreview ? word(file.preview) : word(env.KEIR_PREVIEW);
  if (hasPreview && !["on", "off"].includes(previewWord)) warnings.push(`preview: value ${JSON.stringify(file.preview).slice(0, 40)} is not true or false; treated as preview on`);
  const preview = hasPreview ? previewWord !== "off" : previewWord === "on";
  for (const k of ["historyPerRun", "historyDays"]) if (Object.prototype.hasOwnProperty.call(file, k) && num(file[k], null) === null) warnings.push(`${k}: value ${JSON.stringify(file[k]).slice(0, 40)} is not a number; default used`);
  return { switches, preview, historyPerRun: num(file.historyPerRun ?? env.KEIR_HISTORY_PER_RUN, HISTORY_PER_RUN), historyDays: num(file.historyDays ?? env.KEIR_HISTORY_DAYS, HISTORY_DAYS), fileProblem: null, warnings };
}

// Reads the file. readFile returns the text, or null (or throws ENOENT) when there is none; any other error is a problem.
function readSwitches(file, readFile) {
  try { const t = readFile(file); return { fileText: t ?? null, fileError: null }; }
  catch (e) { return e?.code === "ENOENT" ? { fileText: null, fileError: null } : { fileText: null, fileError: String(e?.code || e?.message || e).slice(0, 80) }; }
}

// killSwitch: { state() -> { engaged, reason } }. data: the ledger data (paused). prodHold() -> ISO time or null.
// log(line) and audit(kind, detail): told once each time the file's problem or warnings change, and once when they clear.
function createControls({ file = process.env.KEIR_SWITCHES_FILE || DEFAULT_FILE, env = process.env, readFile = (f) => fs.readFileSync(f, "utf8"), now = () => Date.now(), killSwitch = null, data = null, prodHold = () => null, ttlMs = 5000, force = null, log = () => {}, audit = () => {} } = {}) {
  let cached = null, at = -Infinity, told = "";
  function settings() {
    if (cached && now() - at < ttlMs) return cached;
    const read = readSwitches(file, readFile);
    cached = resolve({ env, ...read }); at = now();
    const state = cached.fileProblem || cached.warnings.length ? JSON.stringify([cached.fileProblem, cached.warnings, read.fileText, read.fileError]) : "";
    if (state !== told) {
      if (cached.fileProblem) { log(`switches: ${cached.fileProblem} (${file}); every pass is in preview, closes and branch deletes are off, until the file parses again`); audit("switches_file_unusable", { file, problem: cached.fileProblem }); }
      else if (cached.warnings.length) { log(`switches: ${cached.warnings.join("; ")} (${file})`); audit("switches_file_warnings", { file, warnings: cached.warnings }); }
      else { log(`switches: ${file} is usable again`); audit("switches_file_usable", { file }); }
      told = state;
    }
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

// Review 3 F5: the one precedence rule for a behaviour nested under a parent pass (closes and branch deletes under the
// open-PR pass). The child acts only when the parent acts and the child itself acts. The kill switch and pause stop both;
// a parent that is off stops the child; a parent in preview (its own switch, or global preview) makes the child preview,
// whatever the child's switch says; under an acting parent, a child that is off or in preview (or held by the production
// hold) is previewed.
function nestedGate(parent, child) {
  if (!parent.run) return { run: false, act: false, why: parent.why };
  if (!child.run && /kill switch|paused/.test(child.why || "")) return { run: false, act: false, why: child.why };
  if (!parent.act) return { run: true, act: false, why: parent.why || "the parent pass is in preview" };
  if (!child.run || !child.act) return { run: true, act: false, why: child.why };
  return { run: true, act: true, why: null };
}

// Fixed settings for tests and tools: every switch at its default unless named.
function staticControls(overrides = {}, { held = null, preview = false, prodHold = null, historyPerRun = HISTORY_PER_RUN, historyDays = HISTORY_DAYS } = {}) {
  const base = resolve({});
  const s = { ...base, switches: { ...base.switches, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, word(v) || "off"])) }, preview, historyPerRun, historyDays };
  return createControls({ readFile: () => null, killSwitch: { state: () => (held ? { engaged: true, reason: held } : { engaged: false }) }, prodHold: () => prodHold, force: () => s });
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
  // Preview never writes here (review N7): the first real run must still find the pass unstarted.
  if (act) ((d.controls ||= {}).since ||= {});
  const since = d.controls?.since || {};
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

module.exports = { SWITCHES, resolve, readSwitches, createControls, staticControls, DEFAULT_CONTROLS, preview, history, HISTORY_PER_RUN, HISTORY_DAYS, nestedGate };
