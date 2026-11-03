const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { opsStaffRole, juniorDeveloperRequestAllowed, guardJuniorDeveloperRequest } = require('./ops-staff-role');

test('dashboard Junior Developer is independent of game role and flags', () => {
  const user = { role: 'player', isAdmin: false, isModerator: false, opsRole: 'junior_dev' };
  assert.equal(opsStaffRole(user), 'junior_dev');
  assert.equal(user.role, 'player');
  assert.equal(user.isAdmin, false);
  for (const value of [undefined, 'admin', 'junior-dev', true, {}, ['junior_dev']]) {
    assert.equal(opsStaffRole({ ...user, opsRole: value }), null);
  }
  assert.equal(opsStaffRole({ ...user, isBanned: true }), null);
  assert.equal(opsStaffRole({ ...user, isAdmin: true }), 'admin');
  assert.equal(opsStaffRole({ isModerator: true }), 'moderator');
});

test('Junior Developer has explicit read views, logout and scoped task collaboration', () => {
  for (const path of ['/', '/kanban', '/api/kanban', '/api/kanban/items/12', '/project-guide',
    '/api/project-guide', '/reports', '/commodity-report', '/reports/extraction-capacity',
    '/api/extraction-audit', '/engine', '/api/me']) {
    assert.equal(juniorDeveloperRequestAllowed('GET', path), true, path);
    assert.equal(juniorDeveloperRequestAllowed('HEAD', path), true, path);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(juniorDeveloperRequestAllowed(method, path), false, `${method} ${path}`);
    }
  }
  assert.equal(juniorDeveloperRequestAllowed('POST', '/api/logout'), true);
  assert.equal(juniorDeveloperRequestAllowed('POST', '/api/kanban/items/12/collaborate'), true);
  assert.equal(juniorDeveloperRequestAllowed('POST', '/api/kanban/items/12/report'), false);
  assert.equal(juniorDeveloperRequestAllowed('DELETE', '/api/kanban/items/12/collaborate'), false);
});

test('HTTP guard denies private, production and unknown routes before dispatch', async () => {
  for (const path of ['/settings/credentials', '/api/settings/credentials', '/inbox', '/api/keir/inbox',
    '/studio', '/api/keir/app/send', '/db', '/api/collections', '/backups', '/scheduler',
    '/api/kanban/items/12/report', '/api/reports/launch', '/reports/private-diary',
    '/api/daily-reports', '/code', '/api/ask/log', '/api/ask', '/security', '/future-admin-tool']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      let status;
      assert.equal(await guardJuniorDeveloperRequest({ method }, {}, path, {
        resolveSession: async () => ({ role: 'junior_dev' }),
        json: (_, code) => { status = code; },
      }), true, `${method} ${path}`);
      assert.equal(status, 403);
    }
  }
  for (const role of ['admin', 'moderator', null]) {
    assert.equal(await guardJuniorDeveloperRequest({ method: 'GET' }, {}, '/inbox', {
      resolveSession: async () => role ? { role } : null,
      json: () => assert.fail('existing roles keep their own route checks'),
    }), false);
  }
});

test('real sign-in staff resolver reads the dashboard role and still checks bans', async () => {
  const text = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const start = text.indexOf('async function resolveStaffFromAhdUser(');
  const end = text.indexOf('// Cache only an already verified', start);
  let user = { email: 'dev@example.test', opsRole: 'junior_dev', isAdmin: false };
  const context = { require, opsStaffRole, getDb: async () => ({ collection: () => ({
    findOne: async (_, options) => { assert.equal(options.projection.opsRole, 1); return user; },
  }) }) };
  vm.runInNewContext(text.slice(start, end) + '\nthis.resolve = resolveStaffFromAhdUser;', context);
  assert.equal((await context.resolve('a'.repeat(24))).role, 'junior_dev');
  user = { ...user, isBanned: true };
  assert.equal(await context.resolve('a'.repeat(24)), null);
  user = { email: user.email, isAdmin: false };
  assert.equal(await context.resolve('a'.repeat(24)), null);
});

test('Junior Developer navigation does not advertise private or production tools', () => {
  const { renderShell } = require('./ops-shell');
  const html = renderShell({ role: 'junior_dev', body: '<h1>Junior Developer</h1>' });
  for (const path of ['/kanban', '/project-guide', '/reports', '/engine']) assert.ok(html.includes(`href="${path}"`));
  for (const path of ['/inbox', '/db', '/settings/credentials', '/code', '/scheduler', '/ask']) {
    assert.ok(!html.includes(`href="${path}"`), path);
  }
});


test('the admin hub does not replace or expose its views to Junior Developers', async () => {
  const { handleHubRoute } = require('./hub/routes');
  for (const pathname of ['/', '/kanban', '/reports', '/engine', '/reports/extraction-capacity']) {
    const handled = await handleHubRoute({ method: 'GET', headers: {} }, {}, new URL(pathname, 'https://ops.example.test'), {
      resolveSession: async () => ({ role: 'junior_dev' }),
      getDb: () => assert.fail('admin hub must not read data for Junior Developers'),
    });
    assert.equal(handled, false, pathname);
  }
});
