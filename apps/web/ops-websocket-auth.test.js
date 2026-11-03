const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { OpsWebSocketAuth, allowedBrowserOrigin } = require('./ops-websocket-auth');
class Socket extends EventEmitter {
  readyState = 1;
  terminated = 0;
  terminate() { this.terminated++; this.readyState = 3; this.emit('close'); }
}
const initial = { source: 'game', userId: 'a'.repeat(24), role: 'admin' };
const req = { headers: { cookie: 'ops_session=' + 'a'.repeat(64) } };
test('downgrade, deletion and identity switching terminate established connections', async () => {
  for (const result of [null, { ...initial, role: 'moderator' }, { ...initial, role: 'junior_dev' }, { ...initial, userId: 'b'.repeat(24) }]) {
    const guards = new OpsWebSocketAuth(); const ws = new Socket();
    guards.attach(ws, req, initial, async () => result);
    assert.equal(await ws.authorize(), false);
    assert.equal(ws.terminated, 1); assert.equal(guards.connections.size, 0);
  }
});
test('each command check revalidates and failures prevent later commands', async () => {
  const guards = new OpsWebSocketAuth(); const ws = new Socket(); let valid = true, calls = 0;
  guards.attach(ws, req, initial, async () => { calls++; return valid ? initial : null; });
  assert.equal(await ws.authorize(), true);
  valid = false; assert.equal(await ws.authorize(), false);
  assert.equal(await ws.authorize(), false); assert.equal(calls, 2);
});
test('concurrent checks share one lookup without accepting late results after logout', async () => {
  const guards = new OpsWebSocketAuth(); const ws = new Socket(); let finish, calls = 0;
  guards.attach(ws, req, initial, () => { calls++; return new Promise(r => { finish = r; }); });
  const a = ws.authorize(), b = ws.authorize(); await Promise.resolve();
  assert.equal(calls, 1); guards.revoke(req); finish(initial);
  assert.equal(await a, false); assert.equal(await b, false);
});
test('idle sockets close after access is revoked', async () => {
  const guards = new OpsWebSocketAuth({ intervalMs: 5 }); const ws = new Socket();
  guards.attach(ws, req, initial, async () => null);
  await new Promise(resolve => { ws.once('close', resolve); setTimeout(resolve, 100); });
  assert.equal(ws.terminated, 1); assert.equal(guards.connections.size, 0);
});
test('hung and rejected authorization fail closed within a fixed timeout', async () => {
  for (const resolve of [() => new Promise(() => {}), async () => { throw Error('offline'); }]) {
    const guards = new OpsWebSocketAuth({ timeoutMs: 5 }); const ws = new Socket();
    guards.attach(ws, req, initial, resolve);
    assert.equal(await ws.authorize(), false); assert.equal(ws.terminated, 1);
  }
});
test('logout closes matching cookies only, including ambient game connections', () => {
  const guards = new OpsWebSocketAuth();
  const a = new Socket(), b = new Socket(), game = new Socket();
  guards.attach(a, req, initial, async () => initial);
  guards.attach(b, { headers: { cookie: 'ops_session=other' } }, initial, async () => initial);
  guards.attach(game, { headers: { cookie: 'auth-token-main-site=game' } }, initial, async () => initial);
  guards.revoke({ headers: { cookie: req.headers.cookie + '; auth-token-main-site=game' } });
  assert.equal(a.terminated, 1); assert.equal(game.terminated, 1); assert.equal(b.terminated, 0);
  b.terminate(); assert.equal(guards.connections.size, 0);
});
test('only exact trusted HTTPS browser origins may upgrade', () => {
  const hosts = ['ops.example.test', 'code.example.test'];
  const check = (origin, host = 'ops.example.test') => allowedBrowserOrigin({ headers: { origin, host } }, hosts);
  assert.equal(check('https://ops.example.test'), true);
  assert.equal(check('https://code.example.test'), true);
  for (const origin of [undefined, 'null', 'http://ops.example.test', 'https://evil.example.test', 'https://ops.example.test/', 'https://ops.example.test:444', 'https://user@ops.example.test']) assert.equal(check(origin), false);
  assert.equal(check('https://ops.example.test', 'untrusted.example.test'), false);
});
test('real WebSocket closes on access loss and no later command is delivered', async () => {
  const { WebSocketServer, WebSocket } = require('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.once('listening', r));
  const guards = new OpsWebSocketAuth({ intervalMs: 10 }); let valid = true, commands = 0;
  wss.on('connection', ws => {
    guards.attach(ws, req, initial, async () => valid ? initial : null);
    ws.on('message', async () => { if (await ws.authorize()) { commands++; ws.send('accepted'); } });
  });
  const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  try {
    await new Promise(r => client.once('open', r));
    const accepted = new Promise(r => client.once('message', r)); client.send('command'); await accepted;
    valid = false;
    const closed = new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('not revoked')), 1000); client.once('close', () => { clearTimeout(timeout); resolve(); }); });
    client.send('blocked'); await closed;
    assert.equal(commands, 1); assert.equal(guards.connections.size, 0);
  } finally { client.terminate(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); }
});
