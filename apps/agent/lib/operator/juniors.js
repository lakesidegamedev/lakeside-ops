"use strict";
// Junior developers come from a Discord role, not a hand-kept id list: give
// someone the role and Keir treats them as a developer within a few minutes.
// They join config.staffIds after the configured staff, so the delegate
// (staffIds[0]) never changes and every delegate-only power (heal approvals,
// sign-offs, decisions on the owner's behalf) stays out of their reach. Merge
// and promotion already need the owner's own request. config.staffIds is
// rebuilt in place because many modules hold a reference to that array.

const PAGE = 1000;

function createJuniorRoster({ config, discord, log = () => {} }) {
  const base = [...config.staffIds];
  config.juniorIds = config.juniorIds || [];
  const apply = (ids) => {
    const juniors = [...new Set(ids)].filter((id) => id !== config.ownerId && id !== config.botId && !base.includes(id));
    config.juniorIds.splice(0, config.juniorIds.length, ...juniors);
    config.staffIds.splice(0, config.staffIds.length, ...base, ...juniors);
    return juniors;
  };
  async function refresh() {
    if (!config.juniorRoleId) return apply([]);
    const ids = [];
    let after = "0";
    for (let page = 0; page < 20; page++) {
      const rows = await discord("GET", `/guilds/${config.guildId}/members?limit=${PAGE}&after=${after}`);
      if (!Array.isArray(rows)) throw new Error("member list unreadable");
      for (const m of rows) if ((m.roles || []).includes(config.juniorRoleId) && !m.user?.bot) ids.push(m.user.id);
      if (rows.length < PAGE) {
        const before = config.juniorIds.join(",");
        const juniors = apply(ids);
        if (juniors.join(",") !== before) log(`junior developers: ${juniors.length ? juniors.join(", ") : "none"}`);
        return juniors;
      }
      after = rows[rows.length - 1].user.id;
    }
    // A partial list would silently drop people; keep the last good roster.
    throw new Error("member list too long to read completely");
  }
  return { refresh, isJunior: (id) => config.juniorIds.includes(id) };
}

module.exports = { createJuniorRoster };
