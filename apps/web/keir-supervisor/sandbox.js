"use strict";
// Bubblewrap workspace sandbox for the private owner supervisor. Same isolation
// profile as the Keir operator's proven task sandbox (apps/agent sandbox.js;
// apps/web ships without apps/agent, so it is restated here): every namespace
// unshared (no network), all capabilities dropped, an empty environment, the
// host's /usr and /lib read-only, and only the job's workspace writable. The
// host's /root, /etc, credentials, live checkouts and production state are not
// mounted at all.
//
// The host runs git in a workspace only while preparing it, before any model
// tool has touched it. Afterwards every read, write, diff and command runs
// inside the sandbox, so model-controlled files (hooks, git config, symlinks)
// are never interpreted by a host process.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

const WS_ID = /^w_[a-f0-9]{16}$/;
const TOOL = path.join(__dirname, "sandbox-tool.js");

function run(cmd, args, { cwd, timeout = 60000, env } = {}) {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout, env: env || { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 8e6 },
    (error, stdout, stderr) => error ? reject(Object.assign(new Error(String(stderr || error.message).trim().slice(-600)), { code: error.code })) : resolve(String(stdout))));
}

function createSandbox(root, { bwrap = "/usr/bin/bwrap", nodeBin = process.execPath, hostGit = "/usr/bin/git" } = {}) {
  if (!path.isAbsolute(root)) throw new Error("workspace root must be absolute");
  let probe = null;

  function dirOf(wsId) {
    if (!WS_ID.test(wsId)) throw new Error("invalid workspace id");
    return path.join(root, wsId);
  }
  const exists = (wsId) => WS_ID.test(wsId) && fs.existsSync(path.join(root, wsId, "repo", ".git"));

  async function available() {
    if (probe && Date.now() - probe.at < 60000) return probe.value;
    let value;
    try { fs.accessSync(bwrap, fs.constants.X_OK); fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch (e) { value = { available: false, reason: `bubblewrap unavailable (${e.code || e.message})` }; }
    if (!value) {
      const scratch = fs.mkdtempSync(path.join(root, ".probe-"));
      try {
        const r = await exec(scratch, "echo sandbox-ok", { timeoutMs: 15000, raw: true });
        value = r.code === 0 && /sandbox-ok/.test(r.output) ? { available: true, reason: null } : { available: false, reason: `bubblewrap probe failed: ${r.output.slice(0, 200)}` };
      } catch (e) { value = { available: false, reason: `bubblewrap probe failed: ${e.message}` }; }
      finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    }
    probe = { at: Date.now(), value };
    return value;
  }

  // Clone the allowlisted source at its base commit into a fresh workspace.
  async function prepare(wsId, repo) {
    if (!repo?.available || !repo.source) throw new Error(`repository ${repo?.key} is not configured on this server`);
    const dir = dirOf(wsId);
    if (fs.existsSync(dir)) throw new Error("workspace already exists");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      // Best effort: refresh the remote-tracking base. This updates refs only,
      // never the live checkout's working tree (same as the Code sessions).
      await run(hostGit, ["-C", repo.source, "fetch", "--quiet", "origin", repo.base], { timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).catch(() => {});
      let sha;
      for (const ref of [`refs/remotes/origin/${repo.base}`, `refs/heads/${repo.base}`]) {
        try { sha = (await run(hostGit, ["-C", repo.source, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim(); if (sha) break; } catch { /* try next */ }
      }
      if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error(`base ${repo.base} not found in source`);
      const target = path.join(dir, "repo");
      await run(hostGit, ["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", repo.source, target], { timeout: 180000 });
      await run(hostGit, ["-C", target, "checkout", "--quiet", "-b", `keir-supervisor/${wsId}`, sha], { timeout: 120000 });
      await run(hostGit, ["-C", target, "remote", "remove", "origin"]);
      return { id: wsId, repo: repo.key, base: repo.base, commit: sha };
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  function depMounts(repo) {
    const mounts = [];
    for (const rel of repo?.deps || []) {
      const source = path.join(repo.source, rel);
      if (fs.existsSync(source) && fs.statSync(source).isDirectory()) mounts.push("--ro-bind", source, path.posix.join("/workspace/repo", rel.split(path.sep).join("/")));
    }
    return mounts;
  }

  // One sandboxed process. `wsDir` is bound at /workspace; `/workspace/repo`
  // is the clone. Output is capped; the process tree dies with the sandbox.
  function exec(wsDir, command, { stdin = "", timeoutMs = 120000, repo = null, raw = false, maxOutput = 200000, signal } = {}) {
    if (typeof command !== "string" || !command || command.length > 16000) throw new Error("invalid command");
    const repoDir = path.join(wsDir, "repo");
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--uid", "65534", "--gid", "65534",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", ...(fs.existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
      "--dir", "/opt/keir-runtime", "--ro-bind", nodeBin, "/opt/keir-runtime/node",
      "--dir", "/opt/keir-supervisor", "--ro-bind", TOOL, "/opt/keir-supervisor/tool.js",
      "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--bind", wsDir, "/workspace", "--chdir", raw || !fs.existsSync(repoDir) ? "/workspace" : "/workspace/repo",
      ...(repo && fs.existsSync(repoDir) ? depMounts(repo) : []),
      "--clearenv", "--setenv", "PATH", "/opt/keir-runtime:/usr/bin:/bin", "--setenv", "HOME", "/workspace", "--setenv", "LANG", "C.UTF-8",
      "--setenv", "CI", "1", "--setenv", "NO_COLOR", "1", "--setenv", "FORCE_COLOR", "0", "--setenv", "TMPDIR", "/tmp",
      "--setenv", "GIT_CONFIG_COUNT", "1", "--setenv", "GIT_CONFIG_KEY_0", "safe.directory", "--setenv", "GIT_CONFIG_VALUE_0", "*",
      "--setenv", "GIT_AUTHOR_NAME", "Keir supervisor", "--setenv", "GIT_AUTHOR_EMAIL", "keir-supervisor@localhost",
      "--setenv", "GIT_COMMITTER_NAME", "Keir supervisor", "--setenv", "GIT_COMMITTER_EMAIL", "keir-supervisor@localhost",
      "--setenv", "NODE_OPTIONS", "--max-old-space-size=1536", "--setenv", "UV_THREADPOOL_SIZE", "2",
      "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", "ulimit -u 256; " + command];
    return new Promise((resolve, reject) => {
      const child = spawn(bwrap, args, { stdio: ["pipe", "pipe", "pipe"], env: {}, detached: true });
      let output = "", overflow = false, timedOut = false;
      const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const onAbort = () => kill();
      signal?.addEventListener?.("abort", onAbort, { once: true });
      const add = (chunk) => { output += chunk; if (output.length > maxOutput) { overflow = true; kill(); } };
      child.stdout.on("data", add); child.stderr.on("data", add);
      child.stdin.on("error", () => {});
      child.on("error", (e) => { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); reject(e); });
      child.on("close", (code, sig) => {
        clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort);
        resolve({ code, signal: sig, timedOut, truncated: overflow, output: output.slice(0, maxOutput) });
      });
      child.stdin.end(stdin);
    });
  }

  async function shell(wsId, repo, command, opts = {}) { return exec(dirOf(wsId), command, { ...opts, repo }); }

  // Structured file operation through the in-sandbox helper.
  async function op(wsId, repo, name, args, { signal, timeoutMs = 60000 } = {}) {
    const r = await exec(dirOf(wsId), "/opt/keir-runtime/node /opt/keir-supervisor/tool.js", { stdin: JSON.stringify({ op: name, args }), repo, timeoutMs, maxOutput: 6e6, signal });
    if (r.timedOut) throw new Error(`${name} timed out`);
    const line = r.output.trim().split("\n").filter(Boolean).at(-1);
    let parsed; try { parsed = JSON.parse(line); } catch { throw new Error(`${name} failed: ${r.output.slice(-300)}`); }
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.result;
  }

  function remove(wsId) { fs.rmSync(dirOf(wsId), { recursive: true, force: true }); }

  return { root, available, prepare, exists, shell, op, remove, exec, dirOf };
}

module.exports = { createSandbox, WS_ID };
