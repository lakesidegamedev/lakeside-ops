"use strict";
// What Keir is running on, from facts rather than memory: the package version
// and release commit of this very process, and the configured models and
// effort per kind of work. Used by the status command and given to every
// activation, so "what version / model are you on?" is answered, not guessed.
const fs = require("node:fs");
const path = require("node:path");
const { codingSpec } = require("./delegation");

const ROOT = path.join(__dirname, "..", "..");
const LABEL = { auto: "Cursor Auto", "gemini-3.8-flash": "Gemini 3.8 Flash", "muse-spark-1.3": "Muse Spark 1.3", "gpt-6.1-sol": "GPT 6.1 SOL", "gpt-6-luna": "GPT 6 Luna", "muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor",
  "muse-wonder-full-1.0": "Muse Wonder Full 1.0", "muse-wonder-1.0": "Muse Wonder 1.0", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-opus-5-5": "Claude Opus 5.5", "deepseek-v4.1-flash": "DeepSeek V4.1 Flash", "deepseek-flash": "DeepSeek V4.1 Flash (1017)" };
const label = (model) => LABEL[model] || model;

function release(root = ROOT) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  // deploy/release.sh writes "<sha> <version>" into every pinned release.
  let commit = null;
  try { commit = fs.readFileSync(path.join(root, "RELEASE"), "utf8").trim().split(/\s+/)[0].slice(0, 7); } catch { /* source checkout */ }
  return { version, commit };
}

// "codex:gpt-6.1-sol@medium,muse:..." -> [{ model, effort }]. A lane with
// several entries rotates: each new task takes the next one and keeps it.
// Route effort suffixes are historical defaults; Jev now chooses each activation.
function lane(spec, config) {
  return String(spec || "claude").split(",").map((x) => x.trim()).filter(Boolean).map((entry) => {
    const [head, pinned] = entry.split("@");
    const [runner, model] = head.split(":");
    return { model: model || (runner === "claude" ? config.model : runner), effort: runner === "cursor" ? "managed by Cursor Auto" : config.dynamicEffort !== false ? "chosen per task" : "medium" };
  });
}

function selfInfo(config, root = ROOT) {
  const { version, commit } = release(root);
  const conversation = lane(config.quickProvider, config), work = lane(config.workerProvider, config);
  const coding = { ...codingSpec(config), effort: config.dynamicEffort !== false ? "chosen per task" : "medium" };
  const effortText = (e) => (e === "chosen per task" ? "effort chosen per task" : `${e} effort`);
  // "GPT 6.1 SOL at medium effort for tickets", or for a rotating lane
  // "tickets alternating between A, B and C at medium effort".
  const clause = (entries, what) => {
    const efforts = [...new Set(entries.map((e) => e.effort))];
    const names = entries.map((e) => label(e.model) + (efforts.length > 1 ? ` (${effortText(e.effort)})` : ""));
    const list = names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    const at = efforts.length === 1 ? ` at ${effortText(efforts[0])}` : "";
    return entries.length > 1 ? `${what} alternating between ${list}${at}` : `${list}${at} for ${what}`;
  };
  const same = JSON.stringify(conversation) === JSON.stringify(work);
  const models = same ? clause(work, "conversations and tickets")
    : `${clause(conversation, "conversations")}, ${clause(work, "tickets and other work")}`;
  const sentence = `Keir is running on lakeside-operator ${version}${commit ? ` (release ${commit})` : ""}, with ${models}, and ${label(coding.model)} at ${effortText(coding.effort)} for coding fixes.`;
  return { version, release: commit, conversation, work, coding, sentence };
}

module.exports = { selfInfo, release, label };
