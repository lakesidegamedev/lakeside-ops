import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { loadPeers, inspectPeer, peerTask, handoff, listHandoffs, reconcileHandoff, cancelHandoff } from "./peers.mjs";
import { createRequire } from "node:module";

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakeside-code-peers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const spec = { goal: "Review the patch", repository: "owner/repo", branch: "feat/search", base: "a91c2e4", scope: "Read only", deliverable: "Findings with paths and lines" };

test("peer configuration is explicit, unique and does not embed credentials in URLs", t => {
  const root = scratch(t);
  assert.deepEqual(loadPeers({ LAKESIDE_CODE_CONFIG_DIR: path.join(root, "empty") }), []);
  const file = path.join(root, "peers.json");
  const read = value => { fs.writeFileSync(file, JSON.stringify(value)); return loadPeers({ LAKESIDE_CODE_PEERS: file }); };
  assert.throws(() => read([{ id: "vps", kind: "keir", url: "http://remote.example" }]), /HTTPS/);
  assert.throws(() => read([{ id: "vps", kind: "keir", url: "https://secret@example.com" }]), /HTTPS/);
  const peer = { id: "local", kind: "opencode", url: "http://127.0.0.1:4096" };
  assert.equal(read([peer])[0].allowSubmit, false);
  assert.throws(() => read([peer, peer]), /unique/);
});

test("peer directories accept explicit Windows worktrees and reject relative or control-character paths", t => {
  const file = path.join(scratch(t), "peers.json");
  const read = directory => {
    fs.writeFileSync(file, JSON.stringify([{ id: "windows", kind: "opencode", url: "http://127.0.0.1:4096", directory }]));
    return loadPeers({ LAKESIDE_CODE_PEERS: file })[0];
  };
  for (const directory of ["C:\\Users\\Owner\\My Project", "D:/worktrees/reviewer", "\\\\workstation\\projects\\review", "/home/owner/worktree"]) assert.equal(read(directory).directory, directory);
  for (const directory of ["relative/project", "C:relative", "\\relative", "C:\\project\nother"]) assert.throws(() => read(directory), /absolute path/);
});

test("real HTTP peers expose activity and completed results with credentials and directory scope", async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/session/status")) res.end(JSON.stringify({ ses_1: { type: "busy" } }));
    else if (req.url.startsWith("/session/ses_1/message")) res.end(JSON.stringify([{ info: { role: "assistant" }, parts: [{ text: "Reviewed" }] }]));
    else if (req.url.startsWith("/session/ses_1")) res.end(JSON.stringify({ id: "ses_1", title: "Review" }));
    else res.end(JSON.stringify([{ id: "ses_1", title: "Review" }]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const peer = { id: "local", name: "Local reviewer", kind: "opencode", url: `http://127.0.0.1:${server.address().port}`, tokenEnv: "TEST_PASSWORD", directory: "/workspace/project" };
  const options = { env: { TEST_PASSWORD: "test-password" } };
  const view = await inspectPeer(peer, options);
  assert.equal(view.state, "connected"); assert.equal(view.tasks[0].state, "busy");
  const result = await peerTask(peer, "ses_1", options);
  assert.equal(result.messages[0].parts[0].text, "Reviewed");
  assert.ok(requests.every(row => row.url.includes("directory=%2Fworkspace%2Fproject")));
  assert.ok(requests.every(row => row.authorization === `Basic ${Buffer.from("opencode:test-password").toString("base64")}`));
});

test("unreachable peers produce offline state without blocking local use", async () => {
  const result = await inspectPeer({ id: "vps", name: "Keir", kind: "keir", url: "https://example.com" }, { fetchImpl: async () => { throw new Error("Unavailable"); } });
  assert.equal(result.state, "offline"); assert.deepEqual(result.tasks, []);
});

test("handoff records intent before network I/O and acceptance never claims completion", async t => {
  const stateDir = scratch(t);
  let sent;
  const receipt = await handoff({ id: "vps", kind: "keir", url: "https://example.com", allowSubmit: true }, spec, { stateDir, fetchImpl: async (_url, options) => {
    const files = fs.readdirSync(stateDir).filter(name => name.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, files[0]))).state, "dispatching");
    sent = JSON.parse(options.body);
    return Response.json({ jobId: "abcdef123456" }, { status: 201 });
  } });
  assert.equal(receipt.state, "accepted"); assert.equal(receipt.taskId, "abcdef123456");
  assert.equal(sent.clientId, receipt.id); assert.match(sent.text, /Base commit: a91c2e4/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, `${receipt.id}.json`))).state, "accepted");
});

test("lost handoff responses remain uncertain and are never automatically retried", async t => {
  let calls = 0;
  const receipt = await handoff({ id: "vps", kind: "keir", url: "https://example.com", allowSubmit: true }, spec, { stateDir: scratch(t), fetchImpl: async () => { calls++; throw new Error("Connection lost after dispatch"); } });
  assert.equal(calls, 1); assert.equal(receipt.state, "uncertain"); assert.equal(receipt.taskId, undefined);
  await assert.rejects(handoff({ id: "readonly", allowSubmit: false }, spec), /read-only/);
  await assert.rejects(handoff({ id: "local", allowSubmit: true, kind: "opencode" }, spec), /explicit peer directory/);
});

test("Keir's real durable app protocol accepts a handoff and returns its completed result", async t => {
  const require = createRequire(import.meta.url);
  const { createRuntime } = require("../agent/lib/standalone/runtime");
  const dir = scratch(t), configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ state_dir: path.join(dir, "state"), default_route: "codex:test-model@medium", projects: [{ id: "test-project", repo_path: dir }] }));
  const runtime = createRuntime({ configFile, execute: async ({ prompt }) => {
    assert.match(prompt, /Base commit: a91c2e4/);
    return { state: "done", outcome: { attempt_id: "test-attempt", result: { summary: "Review complete against a91c2e4; no code changed." } } };
  } });
  await new Promise(resolve => runtime.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { runtime.server.closeAllConnections(); runtime.stop(); });
  const peer = { id: "test-keir", name: "Test Keir", kind: "keir", url: `http://127.0.0.1:${runtime.server.address().port}`, allowSubmit: true };
  const receipt = await handoff(peer, spec, { stateDir: path.join(dir, "handoffs") });
  assert.equal(receipt.state, "accepted");
  let result;
  for (let i = 0; i < 20; i++) {
    result = await peerTask(peer, receipt.taskId);
    if (result.state === "done") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.state, "done");
  assert.match(result.summary, /against a91c2e4/);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "state", "portal", "ledger.json")));
  assert.equal(persisted.jobs[receipt.taskId].state, "done");
});

test("OpenCode handoffs preserve directory, model and message identity through completion", async t => {
  const stateDir = scratch(t), requests = [];
  const peer = { id: "local", kind: "opencode", url: "http://127.0.0.1:4096", directory: "/worktrees/reviewer", model: "provider/model", allowSubmit: true };
  const fetchImpl = async (url, options) => {
    const u = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    assert.equal(u.searchParams.get("directory"), peer.directory);
    requests.push({ path: u.pathname, body, method: options.method });
    if (u.pathname === "/session" && body) return Response.json({ id: "ses_review" });
    if (u.pathname.endsWith("prompt_async")) return new Response(null, { status: 204 });
    if (u.pathname === "/session/status") return Response.json({});
    if (u.pathname.endsWith("/message")) return Response.json([{ info: { role: "assistant", time: { completed: 1 }, finish: "stop" }, parts: [{ type: "text", text: "Reviewed" }] }]);
    return Response.json({ id: "ses_review" });
  };
  const receipt = await handoff(peer, spec, { stateDir, fetchImpl });
  assert.equal(receipt.state, "accepted");
  const prompt = requests.find(row => row.path.endsWith("prompt_async"));
  assert.equal(prompt.body.messageID, receipt.messageId);
  assert.deepEqual(prompt.body.model, { providerID: "provider", modelID: "model" });
  assert.match(prompt.body.parts[0].text, /Base commit: a91c2e4/);
  const result = await reconcileHandoff(peer, receipt.id, { stateDir, fetchImpl });
  assert.equal(result.state, "completed");
  assert.equal(result.summary, "Reviewed");
  assert.equal(listHandoffs({ stateDir })[0].state, "completed");
  assert.equal(requests.filter(row => row.method === "POST").length, 2);
});

test("OpenCode idle without a completed assistant message is never counted as success", async () => {
  const peer = { id: "local", kind: "opencode", url: "http://127.0.0.1:4096" };
  const result = await peerTask(peer, "ses_empty", { fetchImpl: async url => Response.json(new URL(url).pathname.endsWith("/message") ? [] : {}) });
  assert.equal(result.state, "waiting");
});

test("lost OpenCode create responses recover the exact session without resubmitting work", async t => {
  const stateDir = scratch(t);
  const peer = { id: "local", kind: "opencode", url: "http://127.0.0.1:4096", directory: "/worktrees/reviewer", allowSubmit: true };
  let title, posts = 0;
  const receipt = await handoff(peer, spec, { stateDir, fetchImpl: async (_url, options) => {
    posts++; title = JSON.parse(options.body).title; throw new Error("Lost create response");
  } });
  assert.equal(receipt.state, "uncertain");
  const result = await reconcileHandoff(peer, receipt.id, { stateDir, fetchImpl: async (url, options) => {
    if (options.method !== "GET") posts++;
    if (new URL(url).pathname === "/session") return Response.json([{ id: "ses_recovered", title }]);
    return Response.json({}, { status: 404 });
  } });
  assert.equal(result.taskId, "ses_recovered");
  assert.equal(result.state, "uncertain");
  assert.equal(posts, 1);
});

test("explicit Keir recovery reuses its deduplication key and refuses changed targets", async t => {
  const stateDir = scratch(t), peer = { id: "vps", kind: "keir", url: "https://example.com", allowSubmit: true };
  let originalId, recoveredId;
  const receipt = await handoff(peer, spec, { stateDir, fetchImpl: async (_url, options) => { originalId = JSON.parse(options.body).clientId; throw new Error("Lost reply"); } });
  const refreshed = await reconcileHandoff(peer, receipt.id, { stateDir, retry: true, fetchImpl: async (_url, options) => {
    if (options.method === "POST") { recoveredId = JSON.parse(options.body).clientId; return Response.json({ jobId: "abcdef123456" }); }
    return Response.json({ id: "abcdef123456", state: "done", summary: "Review complete" });
  } });
  assert.equal(recoveredId, originalId);
  assert.equal(refreshed.state, "completed");
  await assert.rejects(reconcileHandoff({ ...peer, url: "https://other.example.com" }, receipt.id, { stateDir }), /target changed/);
  const old = { ...receipt, at: "2020-01-01T00:00:00Z" };
  fs.writeFileSync(path.join(stateDir, `${receipt.id}.json`), JSON.stringify(old));
  await assert.rejects(reconcileHandoff(peer, receipt.id, { stateDir, retry: true }), /deduplication window/);
});

test("cancellation requires confirmation and lost replies remain uncertain", async t => {
  const stateDir = scratch(t), peer = { id: "vps", kind: "keir", url: "https://example.com", allowSubmit: true };
  const receipt = await handoff(peer, spec, { stateDir, fetchImpl: async () => Response.json({ jobId: "abcdef123456" }) });
  const uncertain = await cancelHandoff(peer, receipt.id, { stateDir, fetchImpl: async () => { throw new Error("Lost cancel reply"); } });
  assert.equal(uncertain.state, "cancel-uncertain");
  const result = await cancelHandoff(peer, receipt.id, { stateDir, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).pathname, "/api/keir/app/cancel");
    assert.equal(JSON.parse(options.body).taskId, "abcdef123456");
    return Response.json({ state: "cancelled" });
  } });
  assert.equal(result.state, "cancelled");
});

test("VPS status polling keeps actual task metadata without transferring conversation history", async t => {
  const require = createRequire(import.meta.url);
  const { createAppChannel, createAppServer } = require("../agent/lib/operator/appchannel");
  const { createLedger } = require("../agent/lib/operator/store");
  const dir = scratch(t), ledger = createLedger(path.join(dir, "ledger.json"));
  const app = createAppChannel({ ledger, config: { ownerId: "owner", taskLifetimeMs: 3600000 } });
  const { jobId } = app.authenticatedPost("Inspect this project", "fixture-message");
  const job = ledger.data.jobs[jobId];
  for (let i = 0; i < 100; i++) app.deliver(`fixture:${i}`, { content: "PRIVATE_CONVERSATION_HISTORY ".repeat(100) }, job);
  const token = "f".repeat(64);
  const server = createAppServer({ app, artifactsDir: dir, authenticate: async req => req.headers.cookie === `ops_session=${token}` ? "owner" : false });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const full = await (await fetch(url + "/api/keir/app/thread?after=0", { headers: { Cookie: `ops_session=${token}` } })).text();
  let received;
  const view = await inspectPeer({ id: "fixture", kind: "keir", url, tokenEnv: "OWNER_SESSION" }, { env: { OWNER_SESSION: token }, fetchImpl: async (...args) => {
    const response = await fetch(...args); received = await response.clone().text(); return response;
  } });
  assert.equal(view.state, "connected"); assert.equal(view.tasks[0].id, jobId);
  assert.equal((await inspectPeer({ id: "fixture", kind: "keir", url })).errorKind, "auth");
  assert.deepEqual(JSON.parse(received).messages, []);
  assert.doesNotMatch(received, /PRIVATE_CONVERSATION_HISTORY/);
  assert.ok(received.length < full.length / 10, `${received.length} bytes vs ${full.length}`);
});

test("Keir refuses malformed raw session credentials before sending a request", async () => {
  const result = await inspectPeer({ id: "vps", kind: "keir", url: "https://example.com", tokenEnv: "OWNER_SESSION" }, {
    env: { OWNER_SESSION: "session; another_cookie=bad" }, fetchImpl: async () => { assert.fail("Malformed credential sent"); },
  });
  assert.equal(result.state, "offline"); assert.match(result.error, /raw owner session token/);
  assert.doesNotMatch(result.error, /another_cookie/);
});
