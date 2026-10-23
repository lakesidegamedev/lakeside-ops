"use strict";
// The Ops widget: one short line from Keir every thirty minutes, in his own
// voice, drawn from what the studio is actually doing. The line is generated
// by the configured DeepSeek route (the same quick lane Keir already runs on)
// and kept in the app thread so the phone shows the last line even while the
// provider is slow or unreachable. Swiping the widget shows the live work.
//
// The line is a private owner-facing note. It may mention counts and public
// work, never a player's name, a credential or a ticket's private content.
const path = require("node:path");
const { threadOf } = require("./appchannel");

const INTERVAL_MS = 30 * 60000;
const RETRY_MS = 10 * 60000;
const REFRESH_FLOOR_MS = 60 * 1000;
const MAX = 240;
const CLOSED = ["done", "dismissed", "cancelled"];
const DEFAULT_ROUTE = "ollama:deepseek-v4.1-flash@low";

const BRIEF = `You write one short line as Keir, the private studio operator for A House Divided.
It appears on the owner's phone under an animated 8-bit portrait of Keir Starmer.
Write one or two sentences, at most 240 characters, in a dry, warm, concrete voice.
It can be about the game, a confident general fact, something pressing in the
studio, or what you are working on. Use only the supplied facts for anything
about the studio; never invent a number, a player, a ticket or an outcome.
Never name a player, quote a ticket, give advice that sounds like game strategy,
or include a URL, a credential, a code block, an em dash or an en dash.
Do not repeat a recent line or start with "Just" or "Here is". No preamble,
no quotation marks, no label. Output only the line.`;

function eastern(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", weekday: "long" })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour) % 24, weekday: parts.weekday };
}

function clean(text) {
  const value = String(text == null ? "" : text)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^(keir|starmer)\s*:\s*/i, "")
    .trim();
  if (!value || value.length < 20 || value.length > MAX) return null;
  if (/https?:|www\.|@everyone|@here|```/i.test(value)) return null;
  if (/[—–]/.test(value)) return null;
  return value;
}

function route(spec) {
  const raw = String(spec || DEFAULT_ROUTE).trim();
  const at = raw.lastIndexOf("@");
  const head = at > 0 ? raw.slice(0, at) : raw;
  const effort = at > 0 ? raw.slice(at + 1) : "low";
  const colon = head.indexOf(":");
  if (colon < 0) return { runner: "ollama", model: head, effort };
  return { runner: head.slice(0, colon), model: head.slice(colon + 1), effort };
}

function createStarmer({ ledger, config, app, now = () => Date.now(), generate, stateDir = config?.stateDir, log = () => {} }) {
  const d = ledger.data;
  const t = () => threadOf(d);

  function state() {
    const thread = t();
    thread.starmer ||= { at: 0, nextAt: 0, text: null, history: [], failures: 0 };
    thread.starmer.history ||= [];
    return thread.starmer;
  }

  function openWork() {
    const jobs = Object.values(d.jobs || {}).filter((j) => !CLOSED.includes(j.state));
    const mine = jobs.filter((j) => j.role === "owner" || j.ticket || j.operatorRole).sort((a, b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0));
    return { all: jobs, mine };
  }

  function working() {
    const { mine } = openWork();
    const running = mine.filter((j) => j.state === "running");
    const waiting = mine.filter((j) => j.state === "waiting");
    const items = [...running, ...waiting].slice(0, 5).map((j) => ({
      id: j.id,
      title: String(j.ticket ? `#${j.ticket} ` : "") + String(j.summary || j.source?.content || j.kind || "work").replace(/\s+/g, " ").slice(0, 140),
      state: j.state,
      ticket: j.ticket || null,
      since: j.at || j.updatedAt || null,
    }));
    const first = items[0];
    return {
      headline: first ? (first.state === "waiting" ? "Waiting on you" : "On the move") : "All clear",
      detail: first ? first.title : "Nothing is running; Keir is ready for the next question.",
      running: running.length,
      waiting: waiting.length,
      queued: Math.max(0, mine.length - running.length - waiting.length),
      items,
    };
  }

  function view() {
    const s = state();
    return { at: s.at || null, text: s.text || "Keir is settling in. The first line lands shortly.", nextAt: s.nextAt || 0, working: working() };
  }

  function facts() {
    const s = state();
    const { all, mine } = openWork();
    const decisions = Object.values(d.decisions || {}).filter((x) => x.state === "pending").length;
    const tickets = all.filter((j) => j.kind === "ticket").length;
    const recent = (t().feed || []).filter((f) => f.kind !== "update").slice(0, 5).map((f) => String(f.title || "").slice(0, 120)).filter(Boolean);
    const goals = Object.values(t().goals || {}).filter((g) => g.status === "active").map((g) => String(g.title || "").slice(0, 100)).slice(0, 3);
    const release = require("./releaseidentity").readRelease();
    const e = eastern(now());
    return {
      time: { weekday: e.weekday, hour: e.hour, zone: "America/New_York" },
      release: release ? release.version : null,
      work: { running: mine.filter((j) => j.state === "running").length, waiting: mine.filter((j) => j.state === "waiting").length, openTickets: tickets, decisionsWaiting: decisions },
      activeGoals: goals,
      recent: recent,
      previous: s.history.slice(-6).map((h) => String(h.text || "")),
      angles: ["the game", "a confident general fact", "something pressing in the studio", "what you are working on"],
      pick: s.history.length % 4,
    };
  }

  async function generateLine(input) {
    const spec = route(config?.starmerProvider || config?.quickProvider || DEFAULT_ROUTE);
    const invoke = require("./cli-runner").invokeCli;
    const result = await invoke({
      kind: "generation", runner: spec.runner, model: spec.model, effort: spec.effort, brief: BRIEF,
      prompt: JSON.stringify(input), tools: [], url: "http://127.0.0.1:1", maxTurns: 1, maxOutputTokens: 220,
      timeoutMs: 90000, stateDir: path.join(stateDir || process.env.KEIR_OPERATOR_STATE_DIR || "/tmp/keir", "starmer"),
      job: { id: "starmer-line" }, lane: "reflection", signal: (input.signal || new AbortController().signal),
    });
    if (result.is_error) throw new Error("starmer generation incomplete");
    const text = clean(result.result);
    if (!text) throw new Error("starmer line rejected");
    return text;
  }

  async function produce() {
    const s = state();
    if (d.paused || s.running) return view();
    if (now() < (s.nextAt || 0)) return view();
    s.running = true;
    try {
      const text = await (generate || generateLine)(facts());
      const value = clean(text);
      if (!value) throw new Error("starmer line rejected");
      if (s.history.slice(-12).some((h) => String(h.text).toLowerCase() === value.toLowerCase())) throw new Error("starmer line repeated");
      s.text = value;
      s.at = now();
      s.nextAt = now() + INTERVAL_MS;
      s.failures = 0;
      s.history = [...s.history, { at: s.at, text: value }].slice(-40);
      ledger.audit("app_starmer_line", { at: s.at });
    } catch (e) {
      s.failures = (s.failures || 0) + 1;
      s.nextAt = now() + RETRY_MS;
      // The line's text and the provider error can contain private context;
      // the counter is the only durable trace.
      log(`starmer line failed (${s.failures})`);
    } finally {
      s.running = false;
      ledger.save();
    }
    return view();
  }

  async function tick() { return produce(); }

  // Owner-pressed refresh: one generation at most per minute.
  async function refresh() {
    const s = state();
    if (now() - (s.at || 0) < REFRESH_FLOOR_MS) return { ...view(), throttled: true };
    s.nextAt = 0;
    return produce();
  }

  return { view, tick, refresh, working, state: state() };
}

module.exports = { createStarmer, clean, route, INTERVAL_MS, RETRY_MS };
