"use strict";
// Runs INSIDE the bubblewrap sandbox (mounted read-only at
// /opt/keir-supervisor/tool.js). It performs the supervisor's structured file
// operations on /workspace/repo, so the host process never opens a path the
// model could have turned into a symlink. Input: one JSON request on stdin.
// Output: one JSON line on stdout.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = process.env.KEIR_SUPERVISOR_REPO_ROOT || "/workspace/repo";
const MAX_READ = 60000;
const MAX_WRITE = 400000;
const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);

function fail(message) { throw Object.assign(new Error(message), { expected: true }); }

function resolveInside(relative, { mustExist = true } = {}) {
  if (typeof relative !== "string" || !relative || relative.length > 500 || relative.includes("\0")) fail("path must be a relative path inside the repository");
  if (path.isAbsolute(relative)) fail("absolute paths are not allowed; use a path relative to the repository root");
  const full = path.resolve(ROOT, relative);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) fail("path leaves the repository");
  const parts = path.relative(ROOT, full).split(path.sep);
  if (parts[0] === ".git") fail("the .git directory is not editable through file tools");
  let probe = full;
  while (!fs.existsSync(probe)) {
    if (mustExist && probe === full) fail(`not found: ${relative}`);
    probe = path.dirname(probe);
  }
  const real = fs.realpathSync(probe);
  const realRoot = fs.realpathSync(ROOT);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) fail("path resolves outside the repository");
  return full;
}

function read({ path: rel, offset = 1, limit = 400 }) {
  const full = resolveInside(rel);
  if (fs.statSync(full).isDirectory()) fail(`${rel} is a directory; use list_files`);
  const text = fs.readFileSync(full, "utf8");
  const lines = text.split("\n");
  const start = Math.max(1, Number(offset) || 1), count = Math.min(2000, Math.max(1, Number(limit) || 400));
  let body = lines.slice(start - 1, start - 1 + count).map((l, i) => `${start + i}\t${l}`).join("\n");
  let cut = false;
  if (body.length > MAX_READ) { body = body.slice(0, MAX_READ); cut = true; }
  return { path: rel, totalLines: lines.length, from: start, to: Math.min(lines.length, start - 1 + count), text: body,
    ...(cut || start - 1 + count < lines.length ? { more: "File continues; read again with a larger offset." } : {}) };
}

function write({ path: rel, content }) {
  if (typeof content !== "string" || content.length > MAX_WRITE) fail(`content must be a string up to ${MAX_WRITE} characters`);
  const full = resolveInside(rel, { mustExist: false });
  if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) fail("refusing to write through a symlink");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return { path: rel, bytes: Buffer.byteLength(content) };
}

function edit({ path: rel, old_string: oldText, new_string: newText, replace_all: all = false }) {
  if (typeof oldText !== "string" || !oldText || typeof newText !== "string") fail("old_string and new_string are required strings");
  const full = resolveInside(rel);
  if (fs.lstatSync(full).isSymbolicLink()) fail("refusing to edit through a symlink");
  const text = fs.readFileSync(full, "utf8");
  const count = text.split(oldText).length - 1;
  if (count === 0) fail("old_string not found; read the file again and copy the exact text");
  if (count > 1 && !all) fail(`old_string occurs ${count} times; add surrounding context or set replace_all`);
  fs.writeFileSync(full, all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText));
  return { path: rel, replaced: all ? count : 1 };
}

function list({ path: rel = ".", depth = 2 }) {
  const base = resolveInside(rel);
  const out = []; const max = Math.min(4, Math.max(1, Number(depth) || 2));
  (function walk(dir, level) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= 800) return;
      if (SKIP.has(e.name)) continue;
      const relPath = path.relative(ROOT, path.join(dir, e.name));
      out.push(e.isDirectory() ? relPath + "/" : relPath);
      if (e.isDirectory() && level < max) walk(path.join(dir, e.name), level + 1);
    }
  })(base, 1);
  return { path: rel, entries: out, ...(out.length >= 800 ? { more: "Listing cut at 800 entries; list a subdirectory." } : {}) };
}

function search({ pattern, path: rel = ".", glob = "" }) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 300) fail("pattern is required (up to 300 characters)");
  let re; try { re = new RegExp(pattern); } catch (e) { fail(`invalid pattern: ${e.message}`); }
  const base = resolveInside(rel);
  const suffix = typeof glob === "string" && /^\*\.[A-Za-z0-9.]{1,12}$/.test(glob) ? glob.slice(1) : null;
  const hits = []; let files = 0;
  (function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= 200 || files > 20000) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || (suffix && !e.name.endsWith(suffix))) continue;
      files++;
      let text; try { const st = fs.statSync(full); if (st.size > 2e6) continue; text = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < 200; i++) if (re.test(lines[i])) hits.push(`${path.relative(ROOT, full)}:${i + 1}: ${lines[i].slice(0, 240)}`);
    }
  })(fs.statSync(base).isDirectory() ? base : path.dirname(base));
  return { pattern, matches: hits, ...(hits.length >= 200 ? { more: "Cut at 200 matches; narrow the pattern or path." } : {}) };
}

function git(args) { return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 8e6 }); }

function diff({ patch = true } = {}) {
  git(["add", "-A"]);
  const files = git(["diff", "--cached", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const stat = git(["diff", "--cached", "--stat", "HEAD"]).trim();
  const out = { files, stat };
  if (patch) {
    const full = git(["-c", "core.quotePath=false", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "HEAD"]);
    out.patch = full;
  }
  return out;
}

const OPS = { read, write, edit, list, search, diff };

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let result;
  try {
    const req = JSON.parse(raw || "{}");
    if (!OPS[req.op]) fail("unknown operation");
    result = { ok: true, result: OPS[req.op](req.args || {}) };
  } catch (error) {
    result = { ok: false, error: error.expected ? error.message : `operation failed: ${String(error.message).slice(0, 400)}` };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
});
