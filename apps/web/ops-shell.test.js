const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
// The admin nav assertions cover the studio layout, where tickets are on. The
// standalone example config leaves them off.
process.env.ENABLE_TICKETS ??= 'true';
const { injectNav, renderSidebar, renderShell } = require('./ops-shell');

describe('legacy shell mobile navigation', () => {
  it('can omit the floating trigger when a page supplies an aligned trigger', () => {
    const html = injectNav(
      '<!doctype html><html><head></head><body><main>Page</main></body></html>',
      '/code',
      { role: 'admin' },
      { mobileToggle: false }
    );

    assert.doesNotMatch(html, /class="leg-toggle"/);
    assert.match(html, /class="ahd-sb"/);
    assert.match(html, /__opsSbGesture/);
  });
});

describe('v4 operations navigation', () => {
  it('shows admin recovery and ticket links together', () => {
    const html = renderSidebar('/', 'admin');
    for (const href of ['/tickets', '/worktrees', '/events', '/reports/worldsim-audit-program']) {
      assert.match(html, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    }
    assert.doesNotMatch(html, /href="\/grafana\/"/);
    assert.doesNotMatch(html, /href="\/agents"/);
    assert.doesNotMatch(html, /href="\/code"/);
    assert.match(html, /class="sb-brand-logo"[^>]+src="[^"]+"/);
    assert.match(html, /<details class="sb-group" open><summary class="sb-group-label">Operate/);
    assert.match(html, /<details class="sb-group" ><summary class="sb-group-label">Monitor/);
    assert.match(html, /href="\/tickets"[^>]*>.*?Tickets/);
  });

  it('keeps operational links out of the moderator view', () => {
    const html = renderSidebar('/', 'moderator');
    assert.doesNotMatch(html, /href="\/(?:tickets|worktrees|events|grafana\/|reports\/worldsim-audit-program)/);
  });

  it('keeps search and page context available in the shared shell', () => {
    const html = renderShell({ title: 'Tickets', active: '/tickets', role: 'admin', body: '<p>Ticket list</p>' });
    assert.match(html, /class="tb-section">Operate/);
    assert.match(html, /id="cmdk-trigger"/);
    assert.match(html, /id="cmdk-input"/);
    assert.match(html, /window\.__CMDS=/);
  });
});
