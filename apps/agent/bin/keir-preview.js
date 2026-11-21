#!/usr/bin/env node
"use strict";
// Keir 11.2 third pass (review M7): what the new unattended passes would do right now, read only.
//
//   node bin/keir-preview.js                 read the live ledger and GitHub, print the preview
//   node bin/keir-preview.js --json          the same as JSON
//   node bin/keir-preview.js --no-github     do not contact GitHub; say what could not be checked
//   node bin/keir-preview.js --state-dir D   another state directory (default KEIR_OPERATOR_STATE_DIR or /var/lib/keir-operator)
//
// It loads a copy of the ledger in memory, runs each new pass in preview mode against that copy, and prints every action
// each pass would take with its reason, using the switches as they are set now. Nothing is written: not the ledger, not
// GitHub, not Discord, not the kanban. GitHub is read with the box's existing gh login, GET requests only; nothing else is
// contacted (kanban cards and support tickets are not read, and the report says so). The kill switch and pause are shown
// but ignored, so the report shows what would happen once they are released.
const fs = require("node:fs");
const path = require("node:path");
const controlsLib = require("../lib/operator/controls");

function parseArgs(argv) {
  const out = { json: false, github: true, stateDir: process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--no-github") out.github = false;
    else if (argv[i] === "--state-dir") out.stateDir = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

// GET only: any argument that would make gh write is refused before gh runs. Large buffer, as in the service (ghlist.js).
function ghRead(args, { timeoutMs = 20000 } = {}) {
  return require("../lib/operator/ghlist").ghApi({ readOnly: true, timeoutMs, home: process.env.HOME || "/root" })(args);
}

async function buildPreview({ data, settings, api, now = Date.now(), env = process.env }) {
  const notes = [], unchecked = new Set(), extra = [];
  const live = data.preview?.items ? Object.values(data.preview.items) : [];
  data.preview = { items: {} };
  // The switches as set, with preview forced on, and no kill switch or pause.
  const controls = controlsLib.createControls({ readFile: () => { throw new Error("none"); }, force: () => ({ ...settings, preview: true }) });
  const ledger = {
    data,
    save() {}, audit() {},
    notify(key, dest, content) { extra.push({ pass: "other", action: `tell ${dest}`, target: key, reason: String(content).slice(0, 300) }); },
    createJob(key, fields) { extra.push({ pass: "other", action: "start job", target: key, reason: String(fields?.source?.content || "").slice(0, 200) }); return { id: "preview", state: "queued" }; },
  };
  const log = (line) => { notes.push(line); if (/unreadable|skipped|failed|not checked|could not/i.test(line)) unchecked.add(line); };
  const readApi = async (args) => { try { return await api(args); } catch (e) { unchecked.add(`GitHub ${String(args[0]).split("?")[0]}: ${String(e.message).split("\n")[0].slice(0, 160)}`); throw e; } };
  const write = async () => { throw new Error("the report never writes"); };
  const run = async (name, fn) => { try { await fn(); } catch (e) { unchecked.add(`${name}: ${String(e.message).slice(0, 200)}`); } };

  await run("open pull requests", () => require("../lib/operator/keirprs").createKeirPrs({ ledger, api: readApi, write, log, controls, now: () => now,
    config: { keirGitEmail: env.KEIR_GIT_EMAIL || "keir@localhost", githubReviewerToken: "" },
    staleDays: Number(env.KEIR_STALE_PR_DAYS || 5), graceHours: Number(env.KEIR_PR_CLOSE_GRACE_HOURS || 48) }).tick());
  await run("GitHub reconcile", () => require("../lib/operator/prtruth").createPrTruth({ ledger, api: readApi, log, controls, now: () => now }).tick());
  const cards = require("../lib/operator/decisioncards").createDecisionCards({ ledger, mcp: { call: async () => { throw new Error("kanban not read by the report"); } }, log, controls, now: () => now,
    readTicket: async (n) => { unchecked.add(`support ticket ${n}: status not read by the report (only closed channels and resolved tickets in the ledger count)`); throw new Error("not read"); } });
  await run("decision cards", () => cards.tick());
  await run("closed-ticket sweep", () => cards.sweepClosedTickets());
  await run("promises", () => require("../lib/operator/promises").createPromises({ ledger, log, controls, now: () => now, held: () => null, post: async () => { throw new Error("the report never posts"); } }).tick());
  const closing = require("../lib/operator/closing");
  const closingSettings = closing.settings(env);
  await run("finding expiry", async () => closing.expireFindings(ledger, { now, config: closingSettings, controls }));
  // Quiet wakes: every waiting job whose timer is due, checked on a copy.
  if (controls.gate("quietWakes").run) {
    for (const job of Object.values(data.jobs || {})) {
      if (job.state !== "waiting" || !job.closing || !(job.wakeAt <= now) || job.inbox?.length) continue;
      const shadow = JSON.parse(JSON.stringify(job));
      const q = closing.quietWake(data, shadow, now, closingSettings);
      if (q?.quiet) controlsLib.preview(data, "quiet-wakes", shadow.closing?.parked ? "park" : "stay quiet", `job ${job.id}`, `nothing changed in ${shadow.closing?.on?.kind || "its wait"}: ${String(shadow.closing?.waitingOn || "").slice(0, 160)}`, {}, now);
    }
  }
  // Owner DMs the decision loop would edit on its next ticks (already ended questions whose copies still have buttons).
  const newAnswer = (x) => x.state !== "answered" || /^ticket_channel_(?:reply|option)$/.test(x.answeredVia || "");
  for (const x of Object.values(data.decisions || {})) {
    if (["withdrawn", "expired", "superseded", "revoked", "cancelled", "approve", "reject", "explain", "selected", "answered"].includes(x.state) && newAnswer(x)
      && Object.values(x.sent || {}).some((s) => s.messageId && !s.deleted && !s.edited)) {
      controlsLib.preview(data, "decision-dms", "edit owner DM", `decision ${x.id}`, `${x.state}${x.withdrawnReason ? ` (${x.withdrawnReason})` : ""}: "${String(x.question || "").replace(/\s+/g, " ").slice(0, 120)}"`, {}, now);
    }
  }
  const items = [...Object.values(data.preview.items), ...extra];
  const refused = Object.entries(data.refusedPosts || {}).flatMap(([ticket, rows]) => rows.map((r) => ({ ticket: Number(ticket), ...r })));
  const doubts = Object.entries(data.postDoubts || {}).flatMap(([ticket, rows]) => rows.map((r) => ({ ticket: Number(ticket), ...r })));
  // Waits that are parked or slowed now, with what wakes them and what the player is owed (review N1).
  const parked = Object.values(data.jobs || {}).filter((j) => j.closing?.parked || j.closing?.slowed).map((j) => ({ job: j.id, ticket: j.ticket || null, ...require("../lib/operator/closing").describe(j) }));
  return { items, unchecked: [...unchecked], live, refused, doubts, parked, notes };
}

function render({ items, unchecked, live, refused, doubts = [], parked = [] }, { settings, killSwitch, paused, github }) {
  const out = [];
  out.push(`Keir preview, ${new Date().toISOString()}. Nothing was changed.`);
  out.push("");
  out.push("Switches (file, then environment, then default):");
  for (const [name, sw] of Object.entries(controlsLib.SWITCHES)) out.push(`  ${name.padEnd(20)} ${settings.switches[name].padEnd(8)} ${sw.env.padEnd(28)} ${sw.what}`);
  out.push(`  preview mode: ${settings.preview ? "on" : "off"}; first start: ${settings.historyPerRun} historical items per run, none older than ${settings.historyDays} days`);
  out.push(`  kill switch: ${killSwitch}; paused: ${paused ? "yes" : "no"} (ignored for this report)`);
  out.push(`  GitHub: ${github ? "read with the box's gh login" : "not contacted (--no-github)"}`);
  const byPass = new Map();
  for (const x of items) { if (!byPass.has(x.pass)) byPass.set(x.pass, []); byPass.get(x.pass).push(x); }
  out.push("");
  out.push(items.length ? `What the passes would do (${items.length}):` : "The passes would do nothing right now.");
  for (const [pass, rows] of byPass) {
    out.push(`  ${pass}:`);
    for (const r of rows.sort((a, b) => String(a.action).localeCompare(String(b.action)))) out.push(`    - ${r.action} ${r.target}: ${r.reason}`);
  }
  if (live.length) {
    out.push("");
    out.push(`Recorded by the running service in preview (${live.length}):`);
    for (const r of live.slice(-50)) out.push(`  - [${r.pass}] ${r.action} ${r.target} (x${r.count}, last ${new Date(r.lastAt).toISOString().slice(0, 16)}): ${r.reason}`);
  }
  if (refused.length) {
    out.push("");
    out.push(`Posts refused by the post rules in the last 7 days (${refused.length}):`);
    for (const r of refused.slice(-50)) out.push(`  - ticket ${r.ticket}, ${new Date(r.at).toISOString().slice(0, 16)}, ${r.rule}: ${String(r.text).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  if (doubts.length) {
    out.push("");
    out.push(`Posts let through with a doubt in the last 7 days (${doubts.length}):`);
    for (const r of doubts.slice(-50)) out.push(`  - ticket ${r.ticket}, ${new Date(r.at).toISOString().slice(0, 16)}, ${r.rule}: ${String(r.text).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  if (parked.length) {
    out.push("");
    out.push(`Parked or slowed waits (${parked.length}):`);
    for (const p of parked) out.push(`  - ${p.ticket ? `ticket ${p.ticket}` : `job ${p.job}`}: ${p.parked ? `parked since ${p.parked.since.slice(0, 16)}, wakes when ${p.parked.wakesWhen || "something changes"}` : `slowed: ${p.slowed.why}`}; waiting on ${String(p.waitingOn).slice(0, 120)}${p.parked?.owed ? `; the player is owed ${p.parked.owed}` : ""}`);
  }
  out.push("");
  out.push(unchecked.length ? `Could not check (${unchecked.length}):` : "Everything the passes needed was read.");
  for (const u of unchecked) out.push(`  - ${u}`);
  return out.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n"); return; }
  const file = path.join(args.stateDir, "ledger.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let switchesText = null; try { switchesText = fs.readFileSync(process.env.KEIR_SWITCHES_FILE || path.join(args.stateDir, "switches.json"), "utf8"); } catch {}
  const settings = controlsLib.resolve({ env: process.env, fileText: switchesText });
  let killSwitch = "released";
  try { const k = require("../lib/operator/killswitch").parseKillSwitch(fs.readFileSync(process.env.KEIR_KILL_SWITCH_FILE || path.join(args.stateDir, "kill-switch"), "utf8")); if (k.engaged) killSwitch = `engaged (${k.reason})`; } catch {}
  const api = args.github ? ghRead : async () => { throw new Error("not contacted (--no-github)"); };
  const result = await buildPreview({ data, settings, api });
  if (args.json) process.stdout.write(JSON.stringify({ settings, killSwitch, paused: Boolean(data.paused), ...result, notes: undefined }, null, 2) + "\n");
  else process.stdout.write(render(result, { settings, killSwitch, paused: data.paused, github: args.github }) + "\n");
}

if (require.main === module) main().catch((e) => { process.stderr.write(`keir-preview: ${e.message}\n`); process.exit(1); });
module.exports = { buildPreview, render, ghRead, parseArgs };
