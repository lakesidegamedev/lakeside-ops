"use strict";
// Keir 8.4.2: who counts as a moderator comes from the guild's own roles, not a hand-kept list.
// A role is a moderator role when it grants moderation permissions (administrator, kick, ban,
// timeout, manage messages) or is named like one; config.modRoleIds adds roles by id. This is a
// LABEL for the conversation record ("moderator", not "player"). It grants no developer powers:
// config.staffIds still decides heals, approvals and tools. Member roles are cached with a TTL.

const ADMINISTRATOR = 1n << 3n, KICK = 1n << 1n, BAN = 1n << 2n, MANAGE_MESSAGES = 1n << 13n, MODERATE = 1n << 40n;
const MOD_BITS = ADMINISTRATOR | KICK | BAN | MANAGE_MESSAGES | MODERATE;
const MOD_NAME = /\b(?:mod|mods|moderator|moderators|admin|admins|administrator|staff)\b/i;

function createModRoster({ config, discord, log = () => {}, now = () => Date.now(), rolesTtlMs = 10 * 60000, memberTtlMs = 10 * 60000 }) {
  let roles = { at: 0, ids: new Set() };
  const members = new Map();
  const extra = () => new Set(config.modRoleIds || []);
  const permBits = (p) => { try { return BigInt(p || 0); } catch { return 0n; } };
  async function modRoles() {
    if (roles.at && now() - roles.at < rolesTtlMs) return roles.ids;
    const rows = await discord("GET", `/guilds/${config.guildId}/roles`);
    if (!Array.isArray(rows)) throw new Error("guild roles unreadable");
    const ids = new Set(rows.filter((r) => r.id !== config.guildId && !r.managed && ((permBits(r.permissions) & MOD_BITS) !== 0n || MOD_NAME.test(r.name || ""))).map((r) => r.id));
    for (const id of extra()) ids.add(id);
    roles = { at: now(), ids };
    return ids;
  }
  const judge = (memberRoles, ids) => (memberRoles || []).some((r) => ids.has(r));
  // Roles the gateway already attached to a message are free; remember them.
  function observe(message) {
    const id = message?.author?.id;
    if (id && Array.isArray(message.member?.roles)) members.set(id, { at: now(), roles: message.member.roles });
  }
  // Synchronous answer from what is cached; false until the member has been looked up once.
  function isModerator(id) {
    const m = members.get(id);
    if (!m || now() - m.at > memberTtlMs) return false;
    const ids = new Set([...roles.ids, ...extra()]);
    return judge(m.roles, ids);
  }
  async function ensure(id) {
    const m = members.get(id);
    if (!m || now() - m.at >= memberTtlMs) {
      const row = await discord("GET", `/guilds/${config.guildId}/members/${id}`);
      members.set(id, { at: now(), roles: Array.isArray(row?.roles) ? row.roles : [] });
    }
    await modRoles();
    return isModerator(id);
  }
  return { observe, isModerator, ensure, modRoles, _members: members };
}
module.exports = { createModRoster, MOD_BITS };
