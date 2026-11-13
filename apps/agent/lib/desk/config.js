"use strict";
// Staff role table for the Keir desk. Every id can be overridden by a comma list in the environment.
const LEVELS = { mod: 1, junior: 2, dev: 3 };

function roleTable(env = process.env) {
  const pick = (name, fallback) => (env[name] ? env[name].split(",").map((s) => s.trim()).filter(Boolean) : fallback);
  return {
    dev: pick("KEIR_DESK_DEV_ROLES", ["1470571508689535188", "1465491487440502804"]),
    junior: pick("KEIR_DESK_JUNIOR_ROLES", ["1566829201523347497"]),
    mod: pick("KEIR_DESK_MOD_ROLES", ["1483975767703552111", "1509177704329511103"]),
  };
}

// Highest level the member holds, 0 for none. The member comes from the interaction payload, never from the client.
function levelOf(member, table = roleTable()) {
  const roles = new Set((member?.roles || []).map(String));
  let best = 0;
  for (const [name, ids] of Object.entries(table)) if (ids.some((id) => roles.has(id))) best = Math.max(best, LEVELS[name]);
  return best;
}

// Minimum level per subcommand.
const REQUIRED = { doctor: 1, status: 1, waiting: 1, why: 1, nudge: 2, release: 2, pause: 2, resume: 2, model: 3, on: 3, off: 3 };

const GUILD_DEFAULT = "1465445442987888743";
const settings = (env = process.env) => ({
  guildId: env.KEIR_GUILD_ID || GUILD_DEFAULT,
  stateDir: env.KEIR_STATE_DIR || "/var/lib/keir-operator",
  releaseFile: env.KEIR_RELEASE_FILE || "/opt/keir/current/RELEASE",
  unit: env.KEIR_OPERATOR_UNIT || "keir-operator",
});

module.exports = { LEVELS, REQUIRED, roleTable, levelOf, settings };
