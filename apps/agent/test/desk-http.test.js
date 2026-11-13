"use strict";
// The desk's loopback HTTP endpoint for the game bot's /keir command.
const test = require("node:test"), assert = require("node:assert"), { spawn } = require("node:child_process"), path = require("node:path"), fs = require("node:fs"), os = require("node:os");
const PORT = 19791, SECRET = "test-secret-not-real";
const MOD = "1483975767703552111";
function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-http-"));
  fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({ jobs: {}, audit: [] }));
  const p = spawn(process.execPath, [path.join(__dirname, "../bin/keir-desk.js"), "--http"], { env: { ...process.env, ASK_API_SECRET: SECRET, KEIR_DESK_PORT: String(PORT), KEIR_STATE_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => p.stdout.on("data", (d) => /listening/.test(String(d)) && resolve(p)));
}
const post = (body, secret) => fetch(`http://127.0.0.1:${PORT}/api/keir/desk/command`, { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-ask-secret": secret } : {}) }, body: JSON.stringify(body) });
test("desk http: secret required, roles enforced, actions not available yet, replies capped", async (t) => {
  const p = await start(); t.after(() => p.kill());
  assert.equal((await post({ command: "keir", sub: "status", member: { roles: [MOD] } })).status, 401);
  assert.equal((await post({ command: "keir", sub: "status", member: { roles: [MOD] } }, "wrong")).status, 401);
  const ok = await post({ command: "keir", sub: "status", member: { id: "123456789012345678", roles: [MOD] } }, SECRET);
  assert.equal(ok.status, 200); const body = await ok.json();
  assert.equal(typeof body.content, "string"); assert.ok(body.content.length <= 1900); assert.equal(body.ephemeral, true);
  const none = await (await post({ command: "keir", sub: "doctor", member: { roles: [] } }, SECRET)).json();
  assert.match(none.content, /do not have a role/);
  const dev = "1470571508689535188";
  const act = await (await post({ command: "keir", sub: "nudge", options: { ticket: 5 }, member: { roles: [dev] } }, SECRET)).json();
  assert.match(act.content, /not available yet/);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/other`, { method: "POST" })).status, 404);
});
