const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authorizeOpsSession: check, credentialVersion, sessionToken, localUsers } = require('./ops-session-policy');
const now = 100000000;
const session = { created: now - 1000, source: 'game', userId: 'a'.repeat(24), email: 'old@example.test', role: 'admin', revocationVersion: 0 };
function options(user) {
  return { now, users: new Map(), getDb: async () => ({ collection: () => ({ findOne: async (filter) => {
    assert.equal(filter._id.toHexString(), session.userId); return user;
  } }) }) };
}
test('existing sessions follow current role and contact changes by immutable ID', async () => {
  const result = await check(session, options({ isModerator: true, email: 'new@example.test' }));
  assert.equal(result.role, 'moderator');
  assert.equal(result.email, 'new@example.test');
});
test('bans, deletion, staff removal and revocation reject existing sessions', async () => {
  for (const user of [null, {}, { isAdmin: true, isBanned: true },
    { isAdmin: true, authRevokedAt: new Date(session.created) },
    { isAdmin: true, authRevokedAt: new Date(now) },
    { isAdmin: true, authRevokedAt: 'invalid' }]) assert.equal(await check(session, options(user)), null);
  assert.ok(await check({ ...session, revocationVersion: session.created - 1 }, options({ isAdmin: true, authRevokedAt: new Date(session.created - 1) })));
});
test('database outage fails closed without destroying session proof', async () => {
  assert.equal(await check(session, { ...options(null), getDb: async () => { throw Error('offline'); } }), null);
  assert.ok(await check(session, options({ isAdmin: true })));
});
test('untyped legacy, malformed, future and expired sessions cannot authorize', async () => {
  for (const value of [null, {}, { ...session, source: undefined }, { ...session, userId: 'bad' },
    { ...session, created: NaN }, { ...session, created: now + 1 }, { ...session, created: now - 86400000 }]) {
    assert.equal(await check(value, options({ isAdmin: true })), null);
  }
});
test('local sessions require current credentials and use current role', async () => {
  const local = { created: now - 1000, source: 'local', email: 'staff@example.test', role: 'admin', credentialVersion: credentialVersion('original-hash') };
  const opts = { now, users: new Map([[local.email, { hash: 'original-hash', role: 'moderator' }]]) };
  assert.equal((await check(local, opts)).role, 'moderator');
  assert.equal(await check(local, { ...opts, allowLocal: false }), null);
  opts.users.set(local.email, { hash: 'changed-hash', role: 'admin' });
  assert.equal(await check(local, opts), null);
  opts.users.clear(); assert.equal(await check(local, opts), null);
});
test('cookie parser refuses duplicates, malformed and prototype-like tokens', () => {
  const token = 'a'.repeat(64);
  assert.equal(sessionToken({ headers: { cookie: `ops_session=${token}` } }), token);
  for (const cookie of ['', 'ops_session=__proto__', 'ops_session=', `ops_session=${token}; ops_session=${token}`, `ops_session=${token}x`]) {
    assert.equal(sessionToken({ headers: { cookie } }), null);
  }
});
test('local configuration does not turn an unknown role into admin', () => {
  const users = localUsers({ OPS_USERS: 'a@example.test:typo:hash,b@example.test:moderator:hash', OPS_ADMIN_EMAIL: 'c@example.test', OPS_PASSWORD_HASH: 'fallback' });
  assert.equal(users.has('a@example.test'), false);
  assert.equal(users.get('b@example.test').role, 'moderator');
  assert.equal(users.get('c@example.test').hash, 'fallback');
});
test('backdated revocation changes also invalidate an established session', async () => {
  assert.equal(await check(session, options({ isAdmin: true, authRevokedAt: new Date(session.created - 100) })), null);
});
test('Ops and Docs route existing sessions through the shared policy', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const token = 'a'.repeat(64);
  const req = { headers: { cookie: `ops_session=${token}` } };
  for (const filename of ['server.js', 'docs-app/server.js']) {
    const source = fs.readFileSync(require.resolve(`./${filename}`), 'utf8');
    const isOps = filename === 'server.js';
    const start = source.indexOf(isOps ? 'async function checkSession(req)' : 'async function opsSessionStrategy(');
    const end = source.indexOf(isOps ? '// ─── Cross-subdomain' : 'const STRATEGIES', start);
    let calls = 0;
    const context = { sessionToken, sessions: new Map([[token, session]]), USERS: new Map(), getDb: async () => null,
      AUTH_MODE: 'sso', OPS_AUTH_MODE: 'sso',
      localUsers: () => new Map(), readOpsSessions: () => ({ [token]: session }),
      authorizeOpsSession: async (s) => { calls++; assert.equal(s, session); return null; } };
    vm.runInNewContext(source.slice(start, end) + `\nthis.check = ${isOps ? 'checkSession' : 'opsSessionStrategy'};`, context);
    assert.equal(await (isOps ? context.check(req) : context.check({}, req)), null);
    assert.equal(calls, 1);
  }
});
test('SSO mode does not accept a direct game cookie as an ops session', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const start = source.indexOf('async function resolveSession(req)');
  const end = source.indexOf('function addSecurityHeaders', start);
  let gameChecks = 0;
  const context = {
    AUTH_MODE: 'sso',
    checkSession: async () => null,
    checkGameSession: async () => { gameChecks++; return { role: 'admin' }; },
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.resolve = resolveSession;', context);
  assert.equal(await context.resolve({ headers: { cookie: 'auth-token-main-site=valid' } }), null);
  assert.equal(gameChecks, 0);
});

test('native sessions remain valid after a day while web sessions still expire', async () => {
  const created = now - 1000;
  const opts = { ...options({ isAdmin: true }), now: now + 2 * 86400000 };
  assert.ok(await check({ ...session, native: true, created }, opts));
  assert.equal(await check({ ...session, created }, opts), null);
  assert.equal(await check({ ...session, native: true, created }, { ...opts, now: created + 30 * 86400000 }), null);
});
test('an identity-store outage is distinguishable from an invalid session', async () => {
  let unavailable = false;
  await check(session, { ...options(null), onUnavailable: () => { unavailable = true; }, getDb: async () => { throw Error('offline'); } });
  assert.equal(unavailable, true);
});


test('Junior Developer grants, removal and revocation follow current account state', async () => {
  const junior = { ...session, role: 'junior_dev' };
  const user = { opsRole: 'junior_dev', isAdmin: false, email: session.email };
  assert.equal((await check(junior, options(user))).role, 'junior_dev');
  assert.equal(await check(junior, options({ ...user, opsRole: undefined })), null);
  assert.equal(await check(junior, options({ ...user, isBanned: true })), null);
  assert.equal(await check(junior, options({ ...user, authRevokedAt: new Date(now) })), null);
  assert.equal(await check(junior, options(null)), null);
  assert.equal((await check(session, options(user))).role, 'junior_dev');
});
