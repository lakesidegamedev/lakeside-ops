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
};

function resolveRepos(env = process.env, definitions = DEFINITIONS) {
  const out = {};
  for (const [key, def] of Object.entries(definitions)) {
    if (!KEY.test(key)) continue;
    const explicit = env[def.sourceEnv];
    const fallback = env.PROJECTS_ROOT ? path.join(env.PROJECTS_ROOT, def.projectDir) : null;
    const source = explicit || fallback;
    let reason = null;
    if (!source) reason = `set ${def.sourceEnv} or PROJECTS_ROOT`;
    else if (!path.isAbsolute(source)) reason = `${def.sourceEnv} must be absolute`;
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
