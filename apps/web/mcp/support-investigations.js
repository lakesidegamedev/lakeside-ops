"use strict";
// The game owns detection. This adapter reviews its active flags, preserves
// source references and never turns an anomaly into a finding of guilt.
const crypto = require("node:crypto");
const { discord: discordApi } = require("./support-create-ticket");
const filing = new Set();
const TERMINAL = ["closed", "resolved", "wont_fix", "rejected"];
const id = value => String(value || "");
const activeFlags = flags => (flags || []).filter(f => !f.dismissed && !f.reviewedAt);
// Keep only correlation fields needed for review. Raw cookies, IP addresses and
// fingerprint values never cross this adapter's boundary.
function accountCorroboration(flag) {
  const e = flag.evidence || {};
  if (flag.type === "shared_tracking_cookie") return { linkedUserIds: (Array.isArray(e.sharedWith) ? e.sharedWith : []).map(u => id(u.userId)).filter(Boolean).slice(0,30) };
  if (flag.type === "coordinated_login_pattern") return { matches: (Array.isArray(e.matches) ? e.matches : []).slice(0,30).map(m => ({ userId: id(m.otherUserId), username: String(m.otherUsername || ""), overlaps: m.overlapCount, days: m.dayCount })) };
  if (flag.type === "coordinated_party_funding") return { partners: (Array.isArray(e.partnerUsernames) ? e.partnerUsernames : []).map(String).slice(0,30), events: e.eventCount };
  return undefined;
}
function reviewDecision(candidate, now = new Date()) {
  // Severity and the number of sensor labels are not abuse evidence. Repeated
  // automatic payouts, ordinary trading and incomplete ledgers can all be high.
  // Escalate an alt case only when identity, access timing and repeated benefit
  // independently point to the SAME pair. Everything else remains diagnostic.
  const recent = candidate.signals.filter(f => {
    const age = now.getTime() - new Date(f.detectedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age <= 7 * 86400000;
  });
  const linked = new Set(recent.filter(f => f.type === "shared_tracking_cookie").flatMap(f => f.corroboration?.linkedUserIds || []));
  const logins = recent.filter(f => f.type === "coordinated_login_pattern").flatMap(f => f.corroboration?.matches || []);
  const funding = recent.filter(f => f.type === "coordinated_party_funding").map(f => f.corroboration).filter(Boolean);
  const matches = logins.filter(m => m.username && linked.has(m.userId) && Number.isFinite(m.days) && m.days >= 3 && Number.isFinite(m.overlaps) && m.overlaps >= 6 && funding.some(f => Number.isFinite(f.events) && f.events >= 3 && f.partners?.length === 1 && f.partners[0].toLowerCase() === m.username.toLowerCase()));
  if (matches.length) return { needsReview: true, reviewReason: "Same account pair shares a tracking cookie, repeatedly logs in together across multiple days, and repeatedly coordinates funding.", reviewBasis: { kind: "corroborated_account_benefit", relatedUserIds: [...new Set(matches.map(m => m.userId))] } };
  return { needsReview: false, reviewReason: "Sensor observations only. No corroborated account-benefit pattern; money anomalies need balance/ledger reconciliation before escalation.", reviewBasis: null };
}
function auditCandidates(accounts, transactions, now = new Date()) {
  const cases = new Map();
  for (const account of accounts) {
    if (account.dismissed || account.pool === "resolved") continue;
    const suppressed = new Set((account.suppressedFlags || []).filter(f => new Date(f.suppressedUntil) > now).map(f => f.type));
    const flags = (account.flags || []).filter(f => !suppressed.has(f.type));
    if (!flags.length) continue;
    const key = `character:${id(account.characterId)}`;
    cases.set(key, { key, subject: account.characterName || key, userId: id(account.userId),
      signals: flags.map(f => ({ source: "suspiciousCharacters", sourceId: id(account._id), type: f.type,
        severity: f.severity, detail: String(f.detail || "").slice(0, 600), detectedAt: f.detectedAt, corroboration: accountCorroboration(f) })), transactions: [] });
  }
  for (const tx of transactions) {
    const flags = activeFlags(tx.suspectFlags);
    if (!tx.subjectId || !flags.length || !["character", "corporation"].includes(tx.subjectType)) continue;
    const key = `${tx.subjectType}:${id(tx.subjectId)}`;
    const entry = cases.get(key) || { key, subject: tx.subjectName || key, signals: [], transactions: [] };
    entry.signals.push(...flags.map(f => ({ source: "financialTxLog", sourceId: id(tx._id), type: f.type,
      severity: f.severity, detail: String(f.detail || "").slice(0, 600), detectedAt: f.detectedAt })));
    if (entry.transactions.length < 12) entry.transactions.push({ id: id(tx._id), type: tx.type, turn: tx.turn,
      at: tx.createdAt, amount: tx.amount, currency: tx.currencyCode, anchorAmount: tx.anchorAmount,
      counterpartyType: tx.counterpartyType, counterpartyId: id(tx.counterpartyId) });
    cases.set(key, entry);
  }
  return [...cases.values()].map(c => ({ ...c, signals: c.signals.sort((a,b) => ({high:0,medium:1,low:2}[a.severity] ?? 3) - ({high:0,medium:1,low:2}[b.severity] ?? 3)).slice(0, 30),
    severity: c.signals.some(f => f.severity === "high") ? "high" : c.signals.some(f => f.severity === "medium") ? "medium" : "low",
    ...reviewDecision(c, now),
  })).sort((a,b) => Number(b.needsReview) - Number(a.needsReview) || ({high:0,medium:1,low:2}[a.severity] - {high:0,medium:1,low:2}[b.severity]) || a.key.localeCompare(b.key));
}
function investigationSummary(c, at) {
  const evidence = ["Opened by Keir. Private staff investigation. Human review required.", `Audit: ${at}. Subject: ${c.subject} (${c.key}).`,
    `Reason for review: ${c.reviewReason || "Staff-directed review"}`,
    "Evidence from existing game detectors:",
    ...c.signals.map(f => `- ${f.type} [${f.severity}] ${f.detail} (${f.source}/${f.sourceId}; detected ${f.detectedAt || "unknown"})`),
    "Recent flagged transactions (signed amounts in original currency; anchor value only when recorded):",
    ...c.transactions.map(t => `- ${t.id}: turn ${t.turn}, ${t.type}, ${t.amount} ${t.currency || "unknown"}; anchor ${t.anchorAmount ?? "unavailable"}; counterparty ${t.counterpartyType || "unknown"}/${t.counterpartyId || "unknown"}`),
  ].join("\n").slice(0, 3600);
  return evidence + "\n\n" + [
    "Assessment: these are anomaly signals, not proof of abuse or alternate accounts. Shared networks/devices can have innocent explanations. Large gains/losses can reflect legitimate trades, transfers, FX, grants or game bugs. Cash mismatch can reflect missing ledger coverage.",
    "Next steps: review linked accounts and counterparties, compare balance history with both sides of ledger movements, check timing and legitimate explanations, and record a staff disposition. No bans, account changes, money corrections or player contact were performed.",
  ].join("\n");
}
async function scan(db, now = new Date(), { cursor, subjectKey } = {}) {
  const since = new Date(now.getTime() - 14 * 86400000);
  const financialSince = new Date(now.getTime() - 12 * 3600000);
  const game = await db.collection("gameState").findOne({}, { projection: { currentTurn: 1 }, maxTimeMS: 10000 });
  if (!Number.isSafeInteger(game?.currentTurn)) throw new Error("Current game turn is unavailable; audit cannot establish financial freshness");
  const [characters, corporations] = await Promise.all([
    db.collection("characters").find({ userId: { $exists: true, $ne: null } }, { projection: { _id: 1, userId: 1 }, maxTimeMS: 10000 }).limit(2001).toArray(),
    db.collection("corporations").find({ userId: { $exists: true, $ne: null } }, { projection: { _id: 1, userId: 1 }, maxTimeMS: 10000 }).limit(2001).toArray(),
  ]);
  const users = await db.collection("users").find({ _id: { $in: [...characters,...corporations].map(c => c.userId) }, isBanned: { $ne: true } }, { projection: { _id: 1 }, maxTimeMS: 10000 }).toArray();
  const allowedUsers = new Set(users.map(u => id(u._id)));
  const charIds = characters.slice(0,2000).filter(c => allowedUsers.has(id(c.userId))).map(c => c._id);
  const corpIds = corporations.slice(0,2000).filter(c => allowedUsers.has(id(c.userId))).map(c => c._id);
  const allowedCharacters = new Set(charIds.map(id)), allowedCorporations = new Set(corpIds.map(id));
  const subjectIds = subjectKey ? [...charIds,...corpIds].filter(value => id(value) === subjectKey.split(":")[1]) : [...charIds,...corpIds];
  const [accounts, transactions] = await Promise.all([
    db.collection("suspiciousCharacters").find({ characterId: { $in: cursor ? [] : subjectKey ? charIds.filter(value => id(value) === subjectKey.split(":")[1]) : charIds }, pool: { $ne: "resolved" }, dismissed: { $ne: true }, flagCount: { $gt: 0 }, lastUpdated: { $gte: since } },
      { projection: { characterId: 1, characterName: 1, userId: 1, flags: 1, suppressedFlags: 1 }, maxTimeMS: 20000 }).sort({ lastUpdated: -1 }).limit(501).toArray(),
    db.collection("financialTxLog").find({ ...(cursor ? { _id: { $lt: new (require("mongodb").ObjectId)(cursor) } } : {}), subjectId: { $in: subjectIds }, flagged: true, createdAt: { $gte: financialSince }, turn: { $gte: Math.max(0, game.currentTurn - 12), $lte: game.currentTurn }, subjectType: { $in: ["character", "corporation"] } },
      { projection: { subjectId: 1, subjectName: 1, subjectType: 1, suspectFlags: 1, type: 1, turn: 1, createdAt: 1, amount: 1, currencyCode: 1, anchorAmount: 1, counterpartyType: 1, counterpartyId: 1 }, maxTimeMS: 20000 }).sort({ _id: -1 }).limit(10001).toArray(),
  ]);
  const candidates = auditCandidates(accounts.slice(0,500).filter(a => allowedCharacters.has(id(a.characterId))),
    transactions.slice(0,10000).filter(t => (t.subjectType === "character" ? allowedCharacters : allowedCorporations).has(id(t.subjectId))), now);
  return { at: now.toISOString(), eligibilityPolicy: "corroborated-account-benefit-v2", accountLookbackDays: 14, financialLookbackHours: 12, currentTurn: game.currentTurn, accountRecords: Math.min(accounts.length,500), transactionRecords: Math.min(transactions.length,10000),
    nextCursor: transactions.length > 10000 ? id(transactions[9999]._id) : null,
    sourceTruncated: accounts.length > 500 || characters.length > 2000 || corporations.length > 2000,
    truncated: accounts.length > 500 || transactions.length > 10000 || characters.length > 2000 || corporations.length > 2000, candidates };
}
function staffOverwrites(guildId, botId, roles) {
  if (roles.length !== 2 || roles.some(r => !/^\d{15,22}$/.test(r) || r === guildId || r === botId) || roles[0] === roles[1]) throw new Error("Configure distinct developer and moderator role ids before filing investigations");
  return [{ id: guildId, type: 0, allow: "0", deny: "1024" },
    ...roles.map(role => ({ id: role, type: 0, allow: "68608", deny: "0" })),
    { id: botId, type: 1, allow: "11280", deny: "0" }];
}
function registerInvestigations(server, { auth, db, z, jsonResult, errorResult, discordImpl = discordApi, scanImpl = scan }) {
  const discord = discordImpl;
  // These tools include private anti-abuse evidence and require staff write
  // credentials even for inspection. They are not ordinary support reads.
  server.tool("support_audit_accounts", "Staff-only read-only audit of active account/alt and financial anomaly detectors with 14-day account and 12-hour financial lookbacks. Use nextCursor to finish financial pagination with the same at timestamp. Returns evidence, currencies, source ids and uncertainty. No sanctions or tickets are created.", { cursor: z.string().regex(/^[a-f0-9]{24}$/).optional(), at: z.string().datetime().optional() }, async ({ cursor, at } = {}) => {
    if (!auth?.scopes?.write) return errorResult("staff write scope required");
    try {
      const roles = [process.env.DISCORD_DEVELOPER_ROLE_ID || process.env.DISCORD_DEV_TEAM_ROLE_ID, process.env.DISCORD_MODERATOR_ROLE_ID];
      let filingConfigured = roles.every(r => /^\d{15,22}$/.test(r)) && roles[0] !== roles[1] && !!process.env.DISCORD_BOT_API_KEY;
      if (filingConfigured) {
        try {
          const base = process.env.AHD_GAME_API_URL || "https://ahousedividedgame.com";
          const capability = await fetch(`${base}/api/discord-bot/tickets?capabilities=1`, { headers: { "X-Bot-Token": process.env.DISCORD_BOT_API_KEY }, signal: AbortSignal.timeout(10000) });
          filingConfigured = capability.ok && (await capability.json()).investigationIntake === true;
        } catch { filingConfigured = false; }
      }
      return jsonResult({ ...await scanImpl(db, at ? new Date(at) : new Date(), { cursor }), filingConfigured });
    } catch(e) { return errorResult(e.message); }
  });
  const busy = filing;
  server.tool("support_create_investigation", "File a Keir-authored investigation from a freshly re-read audit candidate. Only explicit developer/moderator roles and the bot may view the channel. No subject/reporter access, public receipt, public announcement or player intake. Existing open subject cases are deduplicated.",
    { key: z.string().regex(/^(character|corporation):[a-f0-9]{24}$/) }, async ({ key }) => {
      if (!auth?.scopes?.write) return errorResult("staff write scope required");
      if (busy.has(key)) return errorResult("investigation filing already in progress");
      busy.add(key);
      try {
        const tickets = db.collection("tickets");
        const existing = await tickets.findOne({ category: "investigation", investigationKey: key, status: { $nin: TERMINAL } });
        const audit = await scanImpl(db, new Date(), { subjectKey: key }), candidate = audit.candidates.find(c => c.key === key);
        if (!candidate?.needsReview || candidate.reviewBasis?.kind !== "corroborated_account_benefit") throw new Error("No current candidate warrants staff review for this key");
        const guild = process.env.AHD_GUILD_ID || "1465445442987888743", me = await discord("/users/@me");
        const roleIds = [process.env.DISCORD_DEVELOPER_ROLE_ID || process.env.DISCORD_DEV_TEAM_ROLE_ID, process.env.DISCORD_MODERATOR_ROLE_ID];
        const overwrites = staffOverwrites(guild, me.id, roleIds);
        const roles = await discord(`/guilds/${guild}/roles`);
        if (!roleIds.every(r => roles.some(role => role.id === r))) throw new Error("Investigation staff roles do not exist in this guild");
        const api = process.env.AHD_GAME_API_URL || "https://ahousedividedgame.com", token = process.env.DISCORD_BOT_API_KEY;
        if (!token) throw new Error("DISCORD_BOT_API_KEY is not configured");
        const game = async (path, body) => {
          const r = await fetch(api + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Bot-Token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
          if (!r.ok) throw new Error(`Investigation game API returned ${r.status}; inspect receipts before retrying`);
          return r.json();
        };
        const summaryDigest = crypto.createHash("sha256").update(JSON.stringify([candidate.signals, candidate.transactions])).digest("hex");
        const description = investigationSummary(candidate, audit.at);
        if (existing) {
          const channel = await discord(`/channels/${existing.discordChannelId}`);
          const actual = (channel.permission_overwrites || []).map(o => [o.id,o.type,String(o.allow),String(o.deny)]).sort();
          if (JSON.stringify(actual) !== JSON.stringify(overwrites.map(o => [o.id,o.type,o.allow,o.deny]).sort())) throw new Error("Existing investigation ACL changed; staff inspection required");
          if (existing.investigationDigest !== summaryDigest) {
            for (let start = 0; start < description.length; start += 1900) await discord(`/channels/${channel.id}/messages`, { method: "POST", body: JSON.stringify({ content: description.slice(start,start+1900), allowed_mentions: { parse: [] }, nonce: `inv${existing.ticketNumber}-${summaryDigest.slice(0,12)}-${start}`, enforce_nonce: true }) });
            await tickets.updateOne({ _id: existing._id, category: "investigation" }, { $set: { description, investigationDigest: summaryDigest, updatedAt: new Date() } });
          }
          return jsonResult({ ok: true, duplicate: true, updated: existing.investigationDigest !== summaryDigest, ticketNumber: existing.ticketNumber, channelId: existing.discordChannelId });
        }
        const capability = await fetch(`${api}/api/discord-bot/tickets?capabilities=1`, { headers: { "X-Bot-Token": token }, signal: AbortSignal.timeout(10000) });
        if (!capability.ok || !(await capability.json()).investigationIntake) throw new Error("Game API does not yet support investigation intake; no channel created");
        const channels = await discord(`/guilds/${guild}/channels`);
        if (channels.some(c => c.topic === `keir-investigation:${key}`)) throw new Error("An investigation channel already exists for this subject; inspect its registration before retrying");
        const { ticketNumber } = await game("/api/discord-bot/tickets/reserve", {});
        if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) throw new Error("Invalid ticket reservation");
        const channel = await discord(`/guilds/${guild}/channels`, { method: "POST", body: JSON.stringify({ name: `ticket-investigation-keir-${ticketNumber}`, topic: `keir-investigation:${key}`, type: 0,
          parent_id: process.env.AHD_INVESTIGATION_CATEGORY_ID || process.env.AHD_TICKET_CATEGORY_ID || "1483979826967744534", permission_overwrites: overwrites }) });
        // Verify Discord retained the exact ACL before putting evidence there.
        const verified = await discord(`/channels/${channel.id}`);
        if (JSON.stringify((verified.permission_overwrites || []).map(o => [o.id,o.type,String(o.allow),String(o.deny)]).sort()) !== JSON.stringify(overwrites.map(o => [o.id,o.type,o.allow,o.deny]).sort())) throw new Error(`Investigation channel ${channel.id} ACL verification failed; no evidence delivered`);
        const title = `Investigation: ${candidate.subject}`.slice(0,200);
        await game("/api/discord-bot/tickets", { category: "investigation", investigationKey: key, title, description, ticketNumber, discordChannelId: channel.id,
          discordUserId: me.id, discordUsername: me.username || "Keir", discordDisplayName: "Keir", message: { authorId: me.id, authorName: "Keir", content: description } });
        for (let start = 0; start < description.length; start += 1900) await discord(`/channels/${channel.id}/messages`, { method: "POST", body: JSON.stringify({ content: description.slice(start,start+1900), ...(start === 0 ? { embeds: [{ title: `Investigation #${ticketNumber}`, fields: [{ name: "Category", value: "Investigation" }, { name: "Opened by", value: "Keir" }] }] } : {}), allowed_mentions: { parse: [] }, nonce: `invest${ticketNumber}-${start}`, enforce_nonce: true }) });
        await tickets.updateOne({ ticketNumber, category: "investigation" }, { $set: { investigationDigest: summaryDigest } });
        return jsonResult({ ok: true, ticketNumber, channelId: channel.id, channelUrl: `https://discord.com/channels/${guild}/${channel.id}`, openedBy: "Keir", staffOnly: true });
      } catch(e) { return errorResult(e.message); } finally { busy.delete(key); }
    });
}
module.exports = { reviewDecision, accountCorroboration, auditCandidates, investigationSummary, scan, staffOverwrites, registerInvestigations };
