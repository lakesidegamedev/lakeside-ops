"use strict";
// Keir 10 (W3): find the game account behind a ticket's reporter.
//
// Ticket 1829: the reporter was a linked player but the ticket carried no
// character link, reporter_state said "not linked", and the task went to raw
// reads of users and sessions. This is the narrow, purpose-built read: it
// projects only names, ids, country, office and the match method, and never
// returns an email, a session, an IP or the Discord id itself.
//
// The internal result keeps the account id for other tools (player_trail, ask
// history). resolve() returns it under `private`; present() never does.

const CHAR_FIELDS = { name: 1, sequentialId: 1, countryId: 1, homeState: 1, currentOffice: 1 };
const RETIRED_FIELDS = { characterId: 1, retiredAt: 1, reason: 1, "snapshot.name": 1, "snapshot.countryId": 1, "snapshot.currentOffice": 1 };
const TTL_MS = 30 * 60000;
const SAFE_NAME = /^[A-Za-z0-9_.\- ]{1,64}$/;

function characterIdFrom(profileUrl) {
  try {
    const u = new URL(profileUrl);
    if (!/^(?:www\.)?ahousedividedgame\.com$/.test(u.hostname)) return null;
    return /^\/character\/([1-9]\d*)$/.exec(u.pathname)?.[1] || null;
  } catch { return null; }
}

// Pages the reporter opened that name one character, visited more than once.
// Weak: a player also opens other people's profiles.
function visitedCharacter(ticket) {
  const counts = {};
  for (const v of ticket?.supportRecentVisits || []) { const id = /^\/character\/([1-9]\d*)(?:\/|$)/.exec(String(v.path || ""))?.[1]; if (id) counts[id] = (counts[id] || 0) + 1; }
  const top = Object.entries(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  return top.length === 1 ? top[0][0] : null;
}

function createResolver({ mcp, now = () => Date.now() }) {
  const query = (collection, filter, projection, limit, signal, extra = {}) =>
    mcp.call("heal-ops", "heal_query", { env: "prod", collection, filter, projection, limit, ...extra }, false, signal).then((r) => r?.docs || []);

  async function resolve(job, signal) {
    if (!job.ticket) throw new Error("resolve_reporter needs an assigned ticket");
    const cached = job.reporterIdentity;
    if (cached && now() - cached.at < TTL_MS) return cached;
    const ticket = await mcp.call("support", "support_get", { kind: "ticket", number: job.ticket }, false, signal);
    const via = [], userIds = new Map(); // userId -> methods
    const add = (id, method, confidence) => { if (!id) return; const k = String(id); userIds.set(k, [...(userIds.get(k) || []), method]); via.push({ method, confidence }); };
    let ticketCorp = null;

    const characterId = characterIdFrom(ticket?.reporter?.profileUrl);
    if (characterId) {
      const [c] = await query("characters", { sequentialId: Number(characterId) }, { userId: 1 }, 1, signal).catch(() => []);
      if (c?.userId) { add(c.userId, "character link on the ticket", "strong"); ticketCorp = ticket.reporter.corporationName || null; }
    }
    const username = String(ticket?.reporter?.username || "");
    if (username && SAFE_NAME.test(username)) {
      const users = await query("users", { username }, { _id: 1 }, 2, signal).catch(() => []);
      if (users.length === 1) add(users[0]._id, "game username on the ticket", "strong");
    }
    const discordId = String(job.source?.authorId || "");
    if (/^\d{5,25}$/.test(discordId)) {
      const users = await query("users", { discordId }, { _id: 1 }, 2, signal).catch(() => []);
      if (users.length === 1) add(users[0]._id, "linked Discord account", "strong");
    }
    const visited = visitedCharacter(ticket);
    if (visited && !userIds.size) {
      const [c] = await query("characters", { sequentialId: Number(visited) }, { userId: 1 }, 1, signal).catch(() => []);
      if (c?.userId) add(c.userId, "repeated visits to one character page", "weak");
    }

    const ids = [...userIds.keys()];
    const out = { at: now(), ticket: job.ticket, matched: false, via, ambiguous: ids.length > 1, current: [], retired: [], private: { userId: null } };
    if (ids.length !== 1) { job.reporterIdentity = out; return out; }
    const userId = ids[0];
    const owned = { $expr: { $eq: [{ $toString: "$userId" }, userId] } };
    const [current, retired, userDoc] = await Promise.all([
      query("characters", owned, CHAR_FIELDS, 10, signal).catch(() => []),
      query("retiredCharacters", owned, RETIRED_FIELDS, 10, signal, { sort: { retiredAt: -1 } }).catch(() => []),
      query("users", { _id: { $oid: userId } }, { username: 1, discordId: 1 }, 1, signal).catch(() => []),
    ]);
    out.matched = true;
    out.private = { userId, discordId: userDoc[0]?.discordId ? String(userDoc[0].discordId) : null };
    out.account = { linked: true, discordLinked: Boolean(userDoc[0]?.discordId) };
    out.current = current.map((c) => ({ name: c.name, id: c.sequentialId, country: c.countryId, state: c.homeState || null, office: c.currentOffice || null, ...(ticketCorp && characterId && String(c.sequentialId) === characterId ? { corporation: ticketCorp } : {}) }));
    out.retired = retired.map((r) => ({ name: r.snapshot?.name, country: r.snapshot?.countryId || null, office: r.snapshot?.currentOffice || null, retiredAt: r.retiredAt ? String(r.retiredAt).slice(0, 10) : null, reason: r.reason || null }));
    // One current character is the reporter for player-private reads, as a profile link would make it.
    if (out.current.length === 1 && out.current[0].id && !job.reporterCharacter?.id) job.reporterCharacter = { ...(job.reporterCharacter || {}), id: String(out.current[0].id), name: out.current[0].name || null, username: username || null };
    job.reporterIdentity = out;
    return out;
  }

  // What the model sees: no account id, no Discord id.
  function present(r) {
    if (!r.matched) return { matched: false, ambiguous: r.ambiguous, via: r.via, instruction: r.ambiguous ? "The ticket's identity clues point at different accounts. Do not pick one; say what you could not confirm." : "No account could be tied to this reporter from the ticket, the linked Discord account or recent visits. Ask the player only for what you cannot read." };
    const weakOnly = r.via.every((v) => v.confidence === "weak");
    return { matched: true, via: r.via, account: r.account, current: r.current, retired: r.retired,
      instruction: weakOnly ? "Weak match only: treat it as a lead and confirm before stating it to the player." : "The reporter's account and characters, from the live game. Never ask the player who they are or for their character name." };
  }

  return { resolve, present };
}

module.exports = { createResolver, characterIdFrom, visitedCharacter };
