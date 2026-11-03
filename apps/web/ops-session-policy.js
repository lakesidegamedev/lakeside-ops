const { opsStaffRole } = require('./ops-staff-role');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const TTL = 86400000;
const NATIVE_TTL = 30 * TTL;
const sessionLifetime = (session) => session?.native === true ? NATIVE_TTL : TTL;
function credentialVersion(hash) {
  return crypto.createHash('sha256').update(hash).digest('hex');
}
function sessionToken(req) {
  const values = (req.headers.cookie || '').split(';').map(c => c.trim())
    .filter(c => c.startsWith('ops_session=')).map(c => c.slice(12));
  return values.length === 1 && /^[a-f0-9]{64}$/.test(values[0]) ? values[0] : null;
}
function localUsers(env = process.env) {
  const users = new Map();
  for (const entry of (env.OPS_USERS || '').split(',')) {
    const parts = entry.trim().split(':');
    const email = parts.shift()?.toLowerCase();
    const role = parts.length >= 2 ? parts.shift().toLowerCase() : 'admin';
    const hash = parts.join(':');
    if (email && hash && ['admin', 'moderator'].includes(role)) users.set(email, { hash, role });
  }
  const email = (env.OPS_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  if (!users.has(email) && env.OPS_PASSWORD_HASH) users.set(email, { hash: env.OPS_PASSWORD_HASH, role: 'admin' });
  return users;
}
async function authorizeOpsSession(session, { getDb, users, allowLocal = true, onUnavailable = null, now = Date.now() }) {
  if (!session || !Number.isFinite(session.created) || session.created > now || now - session.created >= sessionLifetime(session)) return null;
  if (session.source === 'local') {
    if (!allowLocal) return null;
    const user = users.get(session.email);
    if (!user || !['admin', 'moderator'].includes(user.role) || session.credentialVersion !== credentialVersion(user.hash)) return null;
    return { ...session, role: user.role };
  }
  if (session.source !== 'game' || !/^[a-f0-9]{24}$/i.test(session.userId || '')) return null;
  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ _id: new ObjectId(session.userId) },
      { projection: { email: 1, isAdmin: 1, isModerator: 1, opsRole: 1, isBanned: 1, authRevokedAt: 1 }, maxTimeMS: 5000 });
    if (!user || user.isBanned === true) return null;
    const revoked = user.authRevokedAt == null ? 0 : new Date(user.authRevokedAt).getTime();
    if (!Number.isFinite(revoked) || revoked !== session.revocationVersion || revoked >= session.created) return null;
    const role = opsStaffRole(user);
    return role ? { ...session, email: user.email, role } : null;
  } catch { onUnavailable?.(); return null; }
}
module.exports = { sessionLifetime, NATIVE_TTL, authorizeOpsSession, credentialVersion, sessionToken, localUsers };
