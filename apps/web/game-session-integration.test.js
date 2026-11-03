const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { opsStaffRole } = require('./ops-staff-role');
const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
function opsHarness({ checked, staff, failure } = {}) {
  let calls = 0;
  const context = { process: { env: {} }, crypto, Date, Map,
    verifyProductionGameSession: async () => { calls++; if (failure) throw Error('outage'); return checked; },
    resolveStaffFromAhdUser: async (id, options) => { assert.equal(id, checked.identity.id); assert.equal(options.iat, checked.issuedAt); return staff; } };
  const start = source.indexOf('async function checkGameSession(req,');
  const end = source.indexOf('/** Cookie scope for ops_session.', start);
  vm.runInNewContext('const _gameSessCache = new Map(); const GAME_SESS_TTL_MS = 20000;\n' + source.slice(start, end) + '\nthis.check = checkGameSession; this.cache = _gameSessCache;', context);
  return { context, calls: () => calls };
}
const checked = { identity: { id: 'a'.repeat(24), email: 'staff@example.test' }, issuedAt: 10, expiresAt: Math.floor(Date.now()/1000)+60 };
const req = { headers: { cookie: 'auth-token-main-site=opaque' } };
test('Ops requires issuer identity and current staff authorization', async () => {
  for (const options of [{ checked: null }, { failure: true }, { checked, staff: null }]) {
    assert.equal(await opsHarness(options).context.check(req), null);
  }
  const staff = { role: 'admin', email: 'staff@example.test' };
  const h = opsHarness({ checked, staff });
  assert.equal(await h.context.check(req), staff);
  assert.equal(await h.context.check(req), staff);
  assert.equal(h.calls(), 1);
  assert.ok(!h.context.cache.has('opaque'));
});
test('Ops refuses duplicate or sandbox cookies even with a warm cache', async () => {
  const h = opsHarness({ checked, staff: { role: 'admin' } });
  await h.context.check(req);
  for (const cookie of ['auth-token-sandbox-staging=opaque', 'auth-token-main-site=opaque; auth-token-main-site=other']) {
    assert.equal(await h.context.check({ headers: { cookie } }), null);
  }
  assert.equal(h.calls(), 1);
});
test('Ops cache cannot extend past issuer token expiry', async () => {
  const expiry = Date.now()/1000 + 2;
  const h = opsHarness({ checked: { ...checked, expiresAt: expiry }, staff: { role: 'admin' } });
  await h.context.check(req);
  assert.equal([...h.context.cache.values()][0].exp, expiry * 1000);
});
test('Docs rejects banned, revoked, nonstaff and unavailable issuer sessions', async () => {
  const text = fs.readFileSync(require.resolve('./docs-app/server.js'), 'utf8');
  const start = text.indexOf('async function gameCookieStrategy');
  const end = text.indexOf('// Ops-dashboard session.', start);
  for (const user of [null, { isAdmin: true, isBanned: true }, { isAdmin: true, authRevokedAt: new Date(10000) }, {}]) {
    const context = { opsStaffRole, verifyProductionGameSession: async () => checked, require: () => ({ ObjectId: class { constructor(id) { assert.equal(id, checked.identity.id); } } }) };
    vm.runInNewContext(text.slice(start,end) + '\nthis.check = gameCookieStrategy;', context);
    assert.equal(await context.check({ collection: () => ({ findOne: async () => user }) }, req), null);
  }
});
test('Docs accepts currently authorized staff only after live verification', async () => {
  const text = fs.readFileSync(require.resolve('./docs-app/server.js'), 'utf8');
  const start = text.indexOf('async function gameCookieStrategy');
  const end = text.indexOf('// Ops-dashboard session.', start);
  const context = { opsStaffRole, verifyProductionGameSession: async () => checked, require: () => ({ ObjectId: class {} }) };
  vm.runInNewContext(text.slice(start,end) + '\nthis.check = gameCookieStrategy;', context);
  const db = { collection: () => ({ findOne: async () => ({ isModerator: true, email: 'staff@example.test' }) }) };
  assert.equal((await context.check(db, req)).role, 'moderator');
  context.verifyProductionGameSession = async () => { throw Error('outage'); };
  assert.equal(await context.check(db, req), null);
});
