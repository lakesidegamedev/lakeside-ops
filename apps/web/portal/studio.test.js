"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { handleStudioPortal } = require("./studio");
test("studio Keir proxy authenticates first and pins even absolute request URLs to local upstream", async t => {
  const received = [];
  const agent = http.createServer((req, res) => { received.push({ url: req.url, cookie: req.headers.cookie }); res.setHeader("Content-Type", "application/json"); res.end('{"messages":[]}'); });
  agent.listen(0, "127.0.0.1"); await once(agent, "listening");
  const portal = http.createServer(async (req, res) => {
    const handled = await handleStudioPortal(req, res, new URL(req.url, "http://local").pathname, { authMode: "sso", resolveSession: async req => req.headers.cookie ? { role: "admin" } : null, upstream: `http://127.0.0.1:${agent.address().port}` });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  portal.listen(0, "127.0.0.1"); await once(portal, "listening");
  t.after(async () => { portal.closeAllConnections(); agent.closeAllConnections(); await Promise.all([new Promise(r => portal.close(r)), new Promise(r => agent.close(r))]); });
  function get(requestPath, cookie) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port: portal.address().port, path: requestPath, headers: cookie ? { cookie } : {} }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on("error", reject);
    });
  }
  const signedOut = await get("/api/keir/app/thread");
  assert.equal(signedOut.status, 401); assert.equal(received.length, 0);
  const proxied = await get("http://attacker.invalid/api/keir/app/thread?after=1", "ops_session=owner");
  assert.equal(proxied.status, 200);
  assert.deepEqual(received, [{ url: "/api/keir/app/thread?after=1", cookie: "ops_session=owner" }]);
  const page = await get("/keir/app");
  assert.equal(page.status, 200);
  assert.match(page.body, /id="back-to-ops"/);
  const config = await get("/api/portal/config");
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.body), { mode: "lakeside", auth: "sso", loginOrigins: [] });
  const script = await get("/portal.js");
  assert.equal(script.status, 200);
  assert.match(script.headers["content-type"], /javascript/);
  assert.match(script.body, /back-to-ops/);
  const styles = await get("/portal.css");
  assert.equal(styles.status, 200);
  assert.match(styles.headers["content-type"], /text\/css/);
  assert.match(styles.body, /\.ops-link/);
});
