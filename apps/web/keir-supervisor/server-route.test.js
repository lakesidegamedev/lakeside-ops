"use strict";
// Boots the real server.js and reaches /api/keir/supervisor/* through it, with
// the support operator absent (its app upstream points at a closed port).
// Sessions are pre-seeded the way the server persists them.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HASH = "$2b$10$abcdefghijklmnopqrstuuJ8H0aV3o3Qe5xk3wF3m9zD0b1c2d3e4";
const OWNER = "discord_42@discord.local";

async function boot(t, extraEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "keir-sup-boot-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tokens = { owner: crypto.randomBytes(32).toString("hex"), staff: crypto.randomBytes(32).toString("hex") };
  const version = crypto.createHash("sha256").update(HASH).digest("hex");
  const sessionsFile = path.join(home, "sessions.json");
  fs.writeFileSync(sessionsFile, JSON.stringify({
    [tokens.owner]: { created: Date.now(), email: OWNER, role: "admin", source: "local", credentialVersion: version },
    [tokens.staff]: { created: Date.now(), email: "staff@example.com", role: "admin", source: "local", credentialVersion: version },
  }));
  const env = { PATH: process.env.PATH, HOME: home, PORT: String(port), OPS_PASSIVE: "1", OPS_USERS: `${OWNER}:admin:${HASH},staff@example.com:admin:${HASH}`,
    MONGODB_URI: "mongodb://127.0.0.1:1/ops-boot-test", OPS_SESSIONS_FILE: sessionsFile, KEIR_OWNER_ID: "42",
    KEIR_APP_BASE_URL: "http://127.0.0.1:1", KEIR_GUARDIAN_DIR: path.join(home, "no-guardian"), KEIR_SUPERVISOR_CLAUDE_BIN: path.join(home, "no-claude"), ...extraEnv(home) };
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { cwd: path.join(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(home, { recursive: true, force: true }); });
  let output = "";
  await new Promise((resolve, reject) => {
    const onData = (chunk) => { output += chunk; if (/listening on/.test(output)) resolve(); };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.on("close", (code) => reject(new Error(`server exited ${code}:\n${output.slice(-2000)}`)));
  });
  const req = (p, { who, method = "GET", body } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method,
    headers: { ...(who ? { cookie: `ops_session=${tokens[who]}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { req, home, port, tokens };
}

test("real server: owner-only supervisor routes work with the support operator down", { timeout: 90000 }, async (t) => {
  const { req, home, port, tokens } = await boot(t, (h) => ({ KEIR_SUPERVISOR_DIR: path.join(h, "supervisor") }));
  const ownerProfile = await (await req("/api/me", { who: "owner" })).json();
  assert.equal(ownerProfile.ownerSupervisor, true);
  assert.equal(ownerProfile.ownerSupervisorReady, false);
  assert.match(ownerProfile.ownerSupervisorIssue, /CLI not installed/);
  assert.equal((await (await req("/api/me", { who: "staff" })).json()).ownerSupervisor, false);
  assert.equal((await req("/api/keir/supervisor/thread")).status, 401);
  assert.equal((await req("/api/keir/supervisor/thread", { who: "staff" })).status, 403);
  const empty = await (await req("/api/keir/supervisor/thread", { who: "owner" })).json();
  assert.deepEqual(empty.messages, []);
  const posted = await req("/api/keir/supervisor/messages", { who: "owner", method: "POST", body: { text: "Is the operator up?", clientId: "boot-test-01" } });
  assert.equal(posted.status, 202);
  const { message } = await posted.json();
  const later = await (await req(`/api/keir/supervisor/thread?after=${message.seq}&wait=10`, { who: "owner" })).json();
  assert.equal(later.messages[0].kind, "error");
  assert.match(later.messages[0].text, /could not start on this server/);
  const status = await (await req("/api/keir/supervisor/status", { who: "owner" })).json();
  assert.equal(status.configured, true);
  assert.equal(status.executor.available, false);
  assert.equal(status.guardian.available, false);
  assert.equal(status.repos[0].key, "lakeside-ops");
  assert.equal(status.repos[0].available, false);
  assert.ok(fs.existsSync(path.join(home, "supervisor", "state.json")));
  // Raw image upload through the real server, owner only, then served back owner only.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
  const upload = (who) => fetch(`http://127.0.0.1:${port}/api/keir/supervisor/uploads`, { method: "POST", body: png,
    headers: { ...(who ? { cookie: `ops_session=${tokens[who]}` } : {}), "content-type": "image/png", "x-filename": "shot.png", "x-keir-thread": "main" } });
  assert.equal((await upload(null)).status, 401);
  assert.equal((await upload("staff")).status, 403);
  const up = await upload("owner");
  assert.equal(up.status, 201);
  const file = await up.json();
  assert.equal((await req(file.url, { who: "staff" })).status, 403);
  const served = await req(file.url, { who: "owner" });
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(png));
});

test("real server: unconfigured supervisor says so instead of guessing a state location", { timeout: 90000 }, async (t) => {
  const { req } = await boot(t, () => ({}));
  assert.equal((await req("/api/keir/supervisor/thread", { who: "staff" })).status, 403);
  const r = await req("/api/keir/supervisor/thread", { who: "owner" });
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.configured, false);
  assert.deepEqual(body.missing, ["KEIR_SUPERVISOR_DIR"]);
});
