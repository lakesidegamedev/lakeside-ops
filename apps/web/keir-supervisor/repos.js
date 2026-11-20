"use strict";
// Fixed repository allowlist for the private owner supervisor. Requests and
// the model choose a repository KEY only; the source path, base ref, mounted
// dependency directories and publish target come from this file plus server
// env. Nothing a client or model sends can name an absolute path.
const fs = require("node:fs");
const path = require("node:path");

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

const DEFINITIONS = {
  "lakeside-ops": {
    sourceEnv: "KEIR_SUPERVISOR_LAKESIDE_OPS_SOURCE",
    projectDir: "lakeside-ops",
    base: "main",
    github: "lakesidegamedev/lakeside-ops",
    // Read-only dependency mounts from the source checkout, relative paths
    // only, so focused tests can load installed packages without network.
    deps: ["apps/web/node_modules", "apps/agent/node_modules", "apps/cli/node_modules"],
    note: "Lakeside Ops: web dashboard (apps/web), Keir operator (apps/agent), CLI, desktop and iOS apps.",
  },
  "ahd-game": { projectDir: "AHDGame", base: "development", github: "lakesidegamedev/AHDGame", deps: ["node_modules"], note: "A House Divided game, mechanics, web app and turn worker." },
  "ahd-client": { projectDir: "AHDClient", base: "main", github: "lakesidegamedev/AHDClient", deps: ["node_modules"], note: "A House Divided Tauri client." },
  "ahd-native": { projectDir: "AHDNative", base: "main", github: "lakesidegamedev/AHDNative", deps: [], note: "A House Divided native client." },
  metroforge: { projectDir: "metroforge", base: "master", github: "lakesidegamedev/metroforge", deps: ["node_modules"], note: "MetroForge game and services." },
  "metroforge-native": { projectDir: "metroforge-native", base: "master", github: "lakesidegamedev/metroforge-native", deps: ["node_modules"], note: "MetroForge native client." },
  "grand-century": { projectDir: "grand-century", base: "master", github: "lakesidegamedev/grand-century", deps: ["node_modules"], note: "Grand Century game and web app." },
  "margin-of-victory": { projectDir: "MOVGame-native", base: "main", github: "lakesidegamedev/MOVGame-native", deps: ["node_modules"], note: "Margin of Victory native game." },
  "lakeside-code": { projectDir: "lakeside-code", base: "main", github: "lakesidegamedev/lakeside-code", deps: [], note: "Lakeside Rust MCP services including game data." },
};

function resolveRepos(env = process.env, definitions = DEFINITIONS) {
  const ops = env.KEIR_SUPERVISOR_LAKESIDE_OPS_SOURCE;
  const root = env.KEIR_SUPERVISOR_PROJECTS_ROOT || env.PROJECTS_ROOT ||
    (ops && path.isAbsolute(ops) && path.basename(ops) === "lakeside-ops" ? path.dirname(ops) : null);
  const out = {};
  for (const [key, def] of Object.entries(definitions)) {
    if (!KEY.test(key)) continue;
    const explicit = def.sourceEnv && env[def.sourceEnv];
    const fallback = root ? path.join(root, def.projectDir) : null;
    const source = explicit || fallback;
    let reason = null;
    if (!source) reason = "studio source directory is not configured";
    else if (!path.isAbsolute(source)) reason = "studio source directory must be absolute";
    else if (!fs.existsSync(path.join(source, ".git"))) reason = "source checkout not found";
    out[key] = {
      key, source: reason ? null : path.resolve(source), base: def.base, github: def.github || null,
      deps: (def.deps || []).filter((d) => !path.isAbsolute(d) && !d.split(/[\\/]/).includes("..")),
      note: def.note || "", available: !reason, reason,
    };
  }
  return out;
}

function publicRepo(repo, publishEnabled) {
  return { key: repo.key, available: repo.available, reason: repo.reason, base: `origin/${repo.base}`,
    publish: publishEnabled && repo.github ? "enabled" : "disabled", note: repo.note };
}

module.exports = { DEFINITIONS, KEY, resolveRepos, publicRepo };
