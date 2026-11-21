"use strict";

// Bounded literal scan of the files a code index leaves out.
//
// The game index holds only some file types and sizes, and its coverage
// contract drops whole directories (messages/ with every UI string,
// scripts/, content/changelog). A "not found" over the index alone is not a
// "not found" in the game. When code_exact misses in the index, this scans
// the other text files of the same repository AT THE INDEXED REVISION: it
// reads the commit's tree from the object store of the checkout the index is
// built from (git grep and git cat-file against the commit, never the working
// tree, never anything outside that repository), with a time and size bound.
//
// If the checkout does not hold the indexed commit, the scan is skipped and
// the caller says so. Nothing here writes to the repository.

const { execFile, spawn } = require("child_process");
const path = require("path");

const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svg|psd|mp3|mp4|m4a|wav|ogg|mov|webm|pdf|zip|gz|tgz|bz2|xz|7z|tar|jar|apk|aab|ipa|dmg|exe|dll|so|dylib|wasm|node|db|sqlite3?|woff2?|ttf|otf|eot|bin|dat|pb|keystore|jks|p8|p12|pfx|pem|key|crt|cer|der|lockb|map)$/i;
const SECRET_NAME = /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.env|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials?(?:\..*)?|secrets?\.(?:json|ya?ml|toml))$/i;

function run(cmd, args, { cwd, timeoutMs, maxBuffer = 4 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer, encoding: "utf8", killSignal: "SIGKILL" }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout });
      if (error.killed || error.signal) return resolve({ code: null, timedOut: true, stdout: stdout || "" });
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: null, overflow: true, stdout: stdout || "" });
      resolve({ code: typeof error.code === "number" ? error.code : null, stdout: stdout || "", error });
    });
  });
}

// Reads blobs "<rev>:<path>" through one git cat-file --batch, within a byte
// and time budget. Returns Map(path -> text) and whether the budget cut it.
function readBlobs(gitDir, revision, paths, { timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const out = new Map();
    if (!paths.length) return resolve({ texts: out, cut: false });
    const child = spawn("git", ["-C", gitDir, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let size = 0, cut = false;
    const timer = setTimeout(() => { cut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => {
      chunks.push(d); size += d.length;
      if (size > maxBytes) { cut = true; child.kill("SIGKILL"); }
    });
    child.on("error", () => { clearTimeout(timer); resolve({ texts: out, cut: true }); });
    child.on("close", () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const p of paths) {
        const nl = buf.indexOf(10, pos);
        if (nl === -1) { cut = true; break; }
        const header = buf.slice(pos, nl).toString();
        if (header.endsWith("missing")) { pos = nl + 1; continue; }
        const n = Number(header.split(" ")[2]);
        if (nl + 1 + n > buf.length) { cut = true; break; }
        const body = buf.slice(nl + 1, nl + 1 + n);
        if (!body.includes(0)) out.set(p, body.toString("utf8"));
        pos = nl + 1 + n + 1;
      }
      resolve({ texts: out, cut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(paths.map(p => `${revision}:${p}`).join("\n") + "\n");
  });
}

/**
 * One scanner per (checkout, revision, set of indexed paths).
 *   gitDir     the checkout the index is built from
 *   revision   the full commit the index records
 *   indexed    Set of repository paths that are in the index
 */
function createCheckoutScanner({ gitDir, revision, indexed, timeoutMs = 4000, maxCandidates = 200, maxBytes = 16 * 1024 * 1024, maxFileBytes = 1024 * 1024 }) {
  let prepared = null;

  async function prepare() {
    if (prepared) return prepared;
    if (!gitDir || !revision) return (prepared = { ok: false, reason: "no checkout is configured for this index" });
    const has = await run("git", ["-C", gitDir, "cat-file", "-e", `${revision}^{commit}`], { timeoutMs });
    if (has.code !== 0) return (prepared = { ok: false, reason: `the checkout ${path.basename(gitDir)} does not hold the indexed revision ${String(revision).slice(0, 10)}` });
    const tree = await run("git", ["-C", gitDir, "ls-tree", "-r", "-l", "-z", revision], { timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    if (tree.code !== 0) return (prepared = { ok: false, reason: `could not list the tree at ${String(revision).slice(0, 10)}${tree.timedOut ? " (timed out)" : ""}` });
    const all = [], unindexed = [], skipped = { binary: 0, large: 0, secretName: 0 };
    for (const entry of tree.stdout.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [, type, , size] = entry.slice(0, tab).split(/\s+/);
      const p = entry.slice(tab + 1);
      if (type !== "blob") continue;
      all.push(p);
      if (indexed.has(p)) continue;
      if (BINARY_EXT.test(p)) { skipped.binary++; continue; }
      if (SECRET_NAME.test(p)) { skipped.secretName++; continue; }
      if (Number(size) > maxFileBytes) { skipped.large++; continue; }
      unindexed.push(p);
    }
    prepared = { ok: true, all: new Set(all), unindexed, skipped, categories: categories(unindexed) };
    return prepared;
  }

  /**
   * Candidate files for `needle` (a whitespace-free piece of the literal,
   * matched as a case-insensitive substring, so a superset of the files that
   * hold the literal) among the unindexed text files, with their text. The
   * caller confirms the exact match.
   * Returns { status: "scanned" | "truncated" | "skipped", reason?, candidates: [{ path, text }] }.
   */
  async function find(needle) {
    const p = await prepare();
    if (!p.ok) return { status: "skipped", reason: p.reason, candidates: [] };
    if (!p.unindexed.length) return { status: "scanned", candidates: [], filesScanned: 0 };
    const started = Date.now();
    // Pathspecs go on the command line; keep each call well under ARG_MAX.
    const groups = [[]];
    let len = 0;
    for (const f of p.unindexed) {
      if (len + f.length > 400_000) { groups.push([]); len = 0; }
      groups[groups.length - 1].push(f); len += f.length + 1;
    }
    const prefix = `${revision}:`;
    const candidates = [];
    for (const group of groups) {
      const budget = timeoutMs - (Date.now() - started);
      if (budget < 200) return { status: "truncated", reason: `the repository scan hit its ${timeoutMs} ms time limit`, candidates: [] };
      const grep = await run("git", ["--literal-pathspecs", "-C", gitDir, "grep", "-l", "-I", "-i", "-F", "-z", "-e", needle, revision, "--", ...group],
        { timeoutMs: budget, maxBuffer: 2 * 1024 * 1024 });
      if (grep.timedOut) return { status: "truncated", reason: `the repository scan hit its ${timeoutMs} ms time limit`, candidates: [] };
      if (grep.overflow) return { status: "truncated", reason: "the repository scan found too many candidate files", candidates: [] };
      if (grep.code !== 0 && grep.code !== 1) return { status: "skipped", reason: "git grep failed", candidates: [] };
      for (const s of grep.stdout.split("\0")) if (s) candidates.push(s.startsWith(prefix) ? s.slice(prefix.length) : s);
    }
    const checked = candidates.slice(0, maxCandidates);
    const left = Math.max(500, timeoutMs - (Date.now() - started));
    const { texts, cut } = await readBlobs(gitDir, revision, checked, { timeoutMs: left, maxBytes });
    const found = checked.filter(f => texts.has(f)).map(f => ({ path: f, text: texts.get(f) }));
    const truncated = candidates.length > checked.length || cut;
    return {
      status: truncated ? "truncated" : "scanned",
      ...(truncated ? { reason: candidates.length > checked.length ? `${candidates.length} candidate files; only ${checked.length} were checked` : "the repository scan hit its size or time limit" } : {}),
      candidates: found, filesScanned: p.unindexed.length,
    };
  }

  /** A path (or a unique file name) among the files the index leaves out. */
  async function read(filePath) {
    const p = await prepare();
    if (!p.ok) return { status: "skipped", reason: p.reason };
    let hit = p.all.has(filePath) ? filePath : null;
    if (!hit) {
      const tail = "/" + filePath.replace(/^\/+/, "");
      const matches = p.unindexed.filter(x => x.endsWith(tail));
      if (matches.length > 1) return { status: "ambiguous", paths: matches.slice(0, 50) };
      hit = matches[0] || null;
    }
    if (!hit) return { status: "absent" };
    if (!p.unindexed.includes(hit)) return { status: "excluded", path: hit, reason: "binary, key material or over the size limit; not readable here" };
    const { texts } = await readBlobs(gitDir, revision, [hit], { timeoutMs, maxBytes: maxFileBytes + 4096 });
    if (!texts.has(hit)) return { status: "skipped", reason: "could not read the file at the indexed revision" };
    return { status: "found", path: hit, text: texts.get(hit) };
  }

  return { prepare, find, read, gitDir, revision };
}

// Where the unindexed files are, by top-level directory, for the scope note.
function categories(paths) {
  const counts = new Map();
  for (const p of paths) {
    const parts = p.split("/");
    const key = parts.length > 2 ? parts.slice(0, 2).join("/") + "/" : parts.length === 2 ? parts[0] + "/" : "(top level)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([dir, files]) => ({ dir, files }));
}

module.exports = { createCheckoutScanner, readBlobs, categories };
