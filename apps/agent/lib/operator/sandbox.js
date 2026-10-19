"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// Read-only dependency mirrors, kept current by bin/keir-deps-refresh.sh.
const DEPS = { AHDGame: "/root/projects/AHDGame/worktrees/keir-deps/node_modules", AHDClient: "/root/projects/AHDClient/node_modules" };
function createSandbox(root) {
  function deps(repository) {
    const dir = DEPS[repository];
    return dir && fs.existsSync(path.join(dir, ".package-lock.json")) ? dir : null;
  }
  function workspace(id) {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error("invalid task id");
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Bubblewrap maps namespace uid 65534 to the launching uid. Host files
    // remain root-owned; only this directory is writable in the namespace.
    fs.chownSync(dir, process.getuid(), process.getgid());
    return dir;
  }
  // A task's repository is an overlay: one shared read-only checkout per
  // commit (with its git baseline) plus the task's own changes, so a task
  // costs only what it edits instead of a full copy of the repository.
  const overlayDir = (id) => path.join(root, `${id}.ov`);
  function attach(id, base) {
    const dir = workspace(id), ov = overlayDir(id);
    fs.rmSync(ov, { recursive: true, force: true }); fs.rmSync(path.join(dir, "repo"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ov, "upper"), { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(ov, "work"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ov, "base"), base);
  }
  function fork(parentId, childId) {
    const baseFile = path.join(overlayDir(parentId), "base");
    if (!fs.existsSync(baseFile)) throw new Error("Parent has no attached repository snapshot.");
    attach(childId, fs.readFileSync(baseFile, "utf8"));
    fs.cpSync(path.join(overlayDir(parentId), "upper"), path.join(overlayDir(childId), "upper"), { recursive: true });
  }
  function remove(id) {
    if (!/^[a-f0-9]{12}$/.test(id)) return;
    fs.rmSync(path.join(root, id), { recursive: true, force: true }); fs.rmSync(overlayDir(id), { recursive: true, force: true });
  }
  function dependencyMounts(depsDir) {
    if (!depsDir) return [];
    const mounts = ["--ro-bind", depsDir, "/workspace/repo/node_modules"];
    // npm workspaces may install dependencies under the individual package.
    if (depsDir === DEPS.AHDClient) for (const relative of ["apps/desktop", "packages/core", "packages/cli"]) {
      const source = path.join("/root/projects/AHDClient", relative, "node_modules");
      if (fs.existsSync(source)) mounts.push("--ro-bind", source, `/workspace/repo/${relative}/node_modules`);
    }
    return mounts;
  }
  function run(id, command, signal, { archive, deps: depsDir, computer = false, timeoutMs = 60000 } = {}) {
    if (typeof command !== "string" || command.length > 16000) throw new Error("invalid command");
    const dir = workspace(id), ov = overlayDir(id);
    const base = fs.existsSync(path.join(ov, "base")) ? fs.readFileSync(path.join(ov, "base"), "utf8") : null;
    const overlay = base && fs.existsSync(base) ? ["--overlay-src", base, "--overlay", path.join(ov, "upper"), path.join(ov, "work"), "/workspace/repo"] : [];
    const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--uid", "65534", "--gid", "65534",
      "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
      // Pin the trusted operator's Node executable. Hosted runners keep it
      // outside /usr; relying on a distro node breaks evidence and validation.
      "--dir", "/opt/keir-runtime", "--ro-bind", process.execPath, "/opt/keir-runtime/node",
      "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", dir, "/workspace", "--chdir", "/workspace",
      ...(computer ? ["--ro-bind", "/root/projects/AHDGame/node_modules/playwright", "/opt/computer-runtime/node_modules/playwright", "--ro-bind", "/root/projects/AHDGame/node_modules/playwright-core", "/opt/computer-runtime/node_modules/playwright-core", "--ro-bind", "/root/.cache/ms-playwright", "/opt/computer-browsers"] : []),
      ...(archive ? ["--ro-bind", archive, "/source.tar"] : []),
      ...overlay,
      ...(depsDir && (overlay.length || fs.existsSync(path.join(dir, "repo"))) ? dependencyMounts(depsDir) : []),
      "--clearenv", ...(computer ? ["--setenv", "PLAYWRIGHT_BROWSERS_PATH", "/opt/computer-browsers"] : []), "--setenv", "PATH", "/workspace/repo/node_modules/.bin:/opt/keir-runtime:/usr/bin:/bin", "--setenv", "HOME", "/workspace", "--setenv", "LANG", "C.UTF-8", "--setenv", "CI", "1", "--setenv", "GIT_CONFIG_COUNT", "1", "--setenv", "GIT_CONFIG_KEY_0", "safe.directory", "--setenv", "GIT_CONFIG_VALUE_0", "*", "--setenv", "NO_COLOR", "1", "--setenv", "FORCE_COLOR", "0", "--setenv", "NODE_OPTIONS", "--max-old-space-size=1536", "--setenv", "VITEST_CACHE_DIR", "/tmp/vitest",
      // vitest otherwise starts one worker per host core (17 here). Its threads count
      // against the service TasksMax, and two tasks testing at once hit spawn EAGAIN
      // and blocked tickets 1505 and 1506 (2026-10-12): one default run peaks at
      // 86 tasks, 61 with two workers.
      "--setenv", "VITEST_MAX_WORKERS", "2", "--setenv", "UV_THREADPOOL_SIZE", "2",
      "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", "ulimit -u 256; " + command];
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/bwrap", args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: {} });
      let output = "", overflow = false;
      let termination;
      const kill = () => { termination ||= require("./process-tree").terminateTree(child.pid); };
      const timer = setTimeout(kill, timeoutMs);
      const append = (chunk) => { output += chunk.toString(); if (output.length > 100000) { overflow = true; kill(); } };
      child.stdout.on("data", append); child.stderr.on("data", append);
      signal?.addEventListener("abort", kill, { once: true });
      if (signal?.aborted) kill();
      child.on("error", (e) => { clearTimeout(timer); signal?.removeEventListener("abort", kill); reject(e); });
      child.on("close", async (code, sig) => { await termination; clearTimeout(timer); signal?.removeEventListener("abort", kill); resolve({ code, signal: sig, output: output.slice(0, 24000), truncated: overflow || output.length > 24000 }); });
    });
  }
  // Output larger than one run's 24,000-character window (a whole patch):
  // write it to a file outside the repository and read it back in base64
  // chunks, so a reviewable fix is never shrunk to fit a tool (ticket 1514
  // spent four rounds compressing its House fix below the window).
  const CAPTURE = "/workspace/.keir-capture";
  async function capture(id, command, signal, { maxBytes = 2 * 1024 * 1024, chunk = 15000 } = {}) {
    const head = await run(id, `{ ${command} ; } > ${CAPTURE}; s=$?; echo "keir-capture $s $(wc -c < ${CAPTURE})"`, signal);
    const m = /keir-capture (\d+) (\d+)\s*$/.exec(head.output || "");
    if (!m) throw new Error("output capture failed");
    const code = Number(m[1]), size = Number(m[2]);
    if (size > maxBytes) { await run(id, `rm -f ${CAPTURE}`, signal); return { code, output: "", truncated: true, size }; }
    const parts = [];
    for (let off = 0; off < size; off += chunk) {
      const r = await run(id, `tail -c +${off + 1} ${CAPTURE} | head -c ${chunk} | base64 -w0`, signal);
      if (r.code !== 0 || r.truncated) throw new Error("output capture read failed");
      parts.push(Buffer.from(r.output.trim(), "base64"));
    }
    await run(id, `rm -f ${CAPTURE}`, signal);
    const buf = Buffer.concat(parts);
    if (buf.length !== size) throw new Error("output capture size mismatch");
    return { code, output: buf.toString("utf8"), truncated: false, size };
  }
  // Whether the task has a repository at /workspace/repo: an attached snapshot
  // overlay, or a repository placed in the workspace directly (prepared trials).
  const hasRepository = (id) => /^[a-f0-9]{12}$/.test(id) && (fs.existsSync(path.join(overlayDir(id), "base")) || fs.existsSync(path.join(root, id, "repo")));
  return { workspace, run, capture, deps, attach, fork, remove, hasRepository };
}
module.exports = { createSandbox };
