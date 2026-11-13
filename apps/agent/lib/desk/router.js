"use strict";
// handle({ command, sub, options, member }) -> { content, ephemeral }. Role check first. Private unless options.share.
const { REQUIRED, roleTable, levelOf, settings } = require("./config");
const read = require("./read");

// Part 2 modules may not exist yet. Absent or broken means "not available yet".
function optional(name) {
  try { return require(name); } catch { return null; }
}

const ACTION_SUBS = new Set(["nudge", "release", "pause", "resume"]);
const MODEL_SUBS = new Set(["model", "on", "off"]);

async function handle({ command = "keir", sub, options = {}, member } = {}, deps = {}) {
  const reply = (content, shared = false) => ({ content: String(content).slice(0, 1900), ephemeral: !(shared && options.share === true) });
  if (command !== "keir" || !(sub in REQUIRED)) return reply("Unknown command.");
  const level = levelOf(member, deps.roles || roleTable());
  if (level < REQUIRED[sub]) return reply("You do not have a role that can use this command.");
  const loadState = deps.loadState || (() => require("./state").loadState(settings()));
  const ticket = options.ticket != null ? Number(options.ticket) : undefined;
  let state;
  try { state = loadState(); } catch { return reply("Keir's state could not be read right now. Try again in a moment."); }
  if (sub === "doctor") return reply(read.doctor(state, ticket), true);
  if (sub === "status") return reply(read.status(state), true);
  if (sub === "waiting") return reply(read.waiting(state), true);
  if (sub === "why") return reply(read.why(state, ticket), true);
  const mod = ACTION_SUBS.has(sub) ? (deps.actions !== undefined ? deps.actions : optional("./actions")) : MODEL_SUBS.has(sub) ? (deps.models !== undefined ? deps.models : optional("./models")) : null;
  const fn = mod && (typeof mod[sub] === "function" ? mod[sub] : typeof mod.run === "function" ? (a) => mod.run(sub, a) : null);
  if (!fn) return reply("That command is not available yet.");
  try {
    const out = await fn({ options, member, level, state });
    return reply(typeof out === "string" ? out : out?.content ?? "Done.", true);
  } catch (e) {
    return reply(`The command failed: ${String(e?.message || e).replace(/\b\d{17,20}\b/g, "").slice(0, 200)}`);
  }
}

module.exports = { handle };
