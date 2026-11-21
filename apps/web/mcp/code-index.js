"use strict";

// Code index access for the agent code tools (code_search, code_exact,
// code_read on the ops-knowledge server).
//
// Three jobs live here, kept out of server.js so they can be tested alone:
//
// 1. Swap-safe readers. The game index is rebuilt every ~15 minutes and the
//    new generation is renamed over the old file; a later step of the same
//    build writes the file map into the published file in place. A reader
//    must never turn either moment into "index unavailable": it opens the new
//    generation before releasing the old one, waits out a short write lock,
//    keeps serving the generation it already holds when the new one cannot be
//    opened, and falls back to the kept `<db>.previous` generation when it
//    holds nothing. Only when no generation at all can be read does it raise
//    IndexUnavailableError, which callers report as a retryable error that is
//    distinct from "no results".
//
// 2. Exact lookup. A literal scan of the indexed chunk text, with the chunk
//    headers (which carry model-written summaries) stripped first, so a
//    "not found" means the literal does not occur in any indexed file at the
//    indexed revision. Files are reassembled from their zero-overlap chunks so
//    every occurrence carries a real line number.
//
// 3. Repository selection. The game index stays the default. Internal
//    repositories (Keir, the client, the Discord bot, the sites) live in their
//    own per-repository index files in a directory the Ask pipeline and the
//    cloud sync never read, and are only served to tokens that are allowed to
//    read private code.

const fs = require("fs");
const path = require("path");

class IndexUnavailableError extends Error {
  constructor(message, { retryable = true, cause = null } = {}) {
    super(message);
    this.name = "IndexUnavailableError";
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

// ── swap-safe generation reader ────────────────────────────────────────────

function defaultOpen(file, { busyTimeoutMs }) {
  const Database = require("better-sqlite3");
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
  db.pragma("query_only = true");
  return db;
}

function signatureOf(stat) {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

// Opens and validates one generation. Throws on any problem so the caller can
// decide whether to keep the current handle or fall back.
function openGeneration(file, { open, busyTimeoutMs, stat }) {
  const db = open(file, { busyTimeoutMs });
  try {
    const columns = db.prepare("PRAGMA table_info(chunks)").all().map(c => c.name);
    if (!columns.includes("text") || !columns.includes("path")) throw new Error("not a code index (no chunks table)");
    if (!db.prepare("SELECT 1 FROM chunks LIMIT 1").get()) throw new Error("index has no chunks");
    const meta = Object.fromEntries(
      (hasTable(db, "meta") ? db.prepare("SELECT k, v FROM meta").all() : []).map(r => [r.k, r.v]),
    );
    const revisions = hasTable(db, "source_revisions")
      ? db.prepare("SELECT * FROM source_revisions").all()
      : [];
    return {
      db, file, signature: stat ? signatureOf(stat) : null,
      sourceAware: columns.includes("source_kind"),
      generation: meta.generation || null,
      publishedAt: meta.published_at || null,
      visibility: meta.visibility || "public",
      meta,
      revisions,
    };
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name);
}

/**
 * A reader for one index path that survives the publish swap.
 *
 * get() returns the live generation handle ({ db, generation, servedFrom, ... })
 * or throws IndexUnavailableError. It never returns an empty or half-written
 * generation: a candidate is validated before it replaces the one in use.
 */
function createGenerationReader(file, {
  open = defaultOpen, statSync = fs.statSync, busyTimeoutMs = 1500, now = Date.now, log = () => {},
} = {}) {
  let current = null;          // validated generation in use
  let lastFailureAt = 0;
  let lastFailure = null;

  function tryOpen(candidate) {
    let stat;
    try { stat = statSync(candidate); } catch (error) { throw new Error(`${path.basename(candidate)} missing (${error.code || error.message})`); }
    return openGeneration(candidate, { open, busyTimeoutMs, stat });
  }

  function currentStillReadable() {
    if (!current) return false;
    try { current.db.prepare("SELECT 1 FROM chunks LIMIT 1").get(); return true; } catch { return false; }
  }

  function get() {
    let stat = null;
    try { stat = statSync(file); } catch {}
    if (current && current.servedFrom === "current" && stat && signatureOf(stat) === current.signature) return current;

    // The file changed (new generation published, file map written, or it is
    // missing). Open the replacement first; release the old one only after the
    // new one has been validated.
    if (stat) {
      try {
        const next = tryOpen(file);
        next.servedFrom = "current";
        const old = current;
        current = next;
        if (old) { try { old.db.close(); } catch {} }
        return current;
      } catch (error) {
        lastFailure = error; lastFailureAt = now();
        log(`[code-index] could not open ${file}: ${error.message}`);
      }
    }

    // Keep serving what we hold: an open handle on a replaced file still reads
    // the generation it was opened on.
    if (currentStillReadable()) return current;

    // Nothing usable in hand: the generation the pipeline keeps as .previous.
    try {
      const prev = tryOpen(`${file}.previous`);
      prev.servedFrom = "previous";
      const old = current;
      current = prev;
      if (old) { try { old.db.close(); } catch {} }
      return current;
    } catch (error) {
      lastFailure = lastFailure || error; lastFailureAt = now();
    }
    if (!stat && !current) {
      let previousExists = true;
      try { statSync(`${file}.previous`); } catch { previousExists = false; }
      if (!previousExists) {
        throw new IndexUnavailableError(`no index has been built at ${path.basename(file)} yet`, { retryable: false });
      }
    }
    throw new IndexUnavailableError(
      `code index temporarily unavailable (${path.basename(file)}: ${lastFailure ? lastFailure.message : "missing"}); retry in a minute`,
    );
  }

  function close() {
    if (current) { try { current.db.close(); } catch {} }
    current = null;
  }

  return { get, close, file, status: () => ({ file, generation: current?.generation || null, servedFrom: current?.servedFrom || null, lastFailure: lastFailure?.message || null, lastFailureAt }) };
}

// ── chunk text helpers ─────────────────────────────────────────────────────

// Context headers ("[code] path (part 2/5): model one-liner") are prepended to
// every chunk before embedding. They are not file content and must never count
// as an occurrence.
const CHUNK_HEADER = /^\[[a-z]+\] [^\n]*\n/;
function chunkBody(text) {
  const value = String(text || "");
  const m = CHUNK_HEADER.exec(value);
  return m ? value.slice(m[0].length) : value;
}

// Whole file text from its chunks. The v2 chunker emits zero-overlap chunks
// that concatenate back to the exact file, so line numbers are real.
function fileText(db, filePath, { sourceKind = null } = {}) {
  const rows = sourceKind
    ? db.prepare("SELECT ord, text FROM chunks WHERE source_kind=? AND path=? ORDER BY ord").all(sourceKind, filePath)
    : db.prepare("SELECT ord, text FROM chunks WHERE path=? ORDER BY ord").all(filePath);
  if (!rows.length) return null;
  return rows.map(r => chunkBody(r.text)).join("");
}

// ── query parsing for exact lookup ─────────────────────────────────────────

const FILE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|md|mdx|rs|swift|py|sh|css|scss|html|yml|yaml|toml|sql|kt|go)";
const PATH_RE = new RegExp(`(?:[\\w@.\\[\\]()-]+/)*[\\w@.\\[\\]()-]+\\.${FILE_EXT}(?::\\d+)?(?![\\w])`, "g");
const PHRASE_RE = /"([^"]{2,200})"|'([^']{2,200})'|`([^`]{2,200})`/g;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const STOP = new Set(("the a an and or but if is are was were be been do does did of to in on for with what how why when where which who " +
  "that this these those it its as at by from can could should would will my me i you your our we they them there here about into out " +
  "up down over under so than then now also just only more most some any all no not").split(" "));

function identifierShaped(word) {
  return /_/.test(word) || /[a-z][A-Z]/.test(word) || /^[A-Z][A-Z0-9]{2,}$/.test(word) || /\d/.test(word) && /[A-Za-z]/.test(word) || /^\$/.test(word);
}

/**
 * Split a code_exact question into literal terms.
 *  - quoted text is one phrase;
 *  - repository paths and bare file names are path terms;
 *  - identifier-shaped words (snake_case, camelCase, CONSTANT_CASE, digits) are symbols;
 *  - a short question with no identifiers or paths is one phrase (an error
 *    message or UI string), e.g. "cannot be merged yet";
 *  - a single bare word is a symbol, whatever its shape.
 * Ordinary words next to identifiers are reported as ignored, never searched.
 */
function parseExactQuery(question) {
  let rest = String(question || "").trim();
  const terms = [];
  const push = (term, kind) => {
    const t = term.trim();
    if (t.length < 2) return;
    if (!terms.some(x => x.term === t && x.kind === kind)) terms.push({ term: t, kind });
  };
  rest = rest.replace(PHRASE_RE, (_, a, b, c) => { push(a || b || c, "phrase"); return " "; });
  rest = rest.replace(PATH_RE, (m) => { push(m.replace(/:\d+$/, "").replace(/^\.\//, ""), "path"); return " "; });
  const words = rest.match(IDENT_RE) || [];
  const plain = rest.trim();
  if (!terms.length && words.length === 1) {
    push(words[0], "symbol");
    return { terms, ignored: [] };
  }
  const idents = words.filter(identifierShaped);
  if (!terms.length && !idents.length && words.length >= 2 && words.length <= 12 && plain.length <= 200) {
    push(plain.replace(/\s+/g, " "), "phrase");
    return { terms, ignored: [] };
  }
  for (const w of idents) push(w, "symbol");
  const ignored = [...new Set(words.filter(w => !identifierShaped(w) && !STOP.has(w.toLowerCase())))];
  return { terms: terms.slice(0, 8), ignored };
}

// ── exact lookup ───────────────────────────────────────────────────────────

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What separates two words of a phrase as a person quotes it: any run of
// whitespace (a wrapped line, indentation, two spaces), or the {" "} that
// Prettier writes into JSX text at a line break.
const PHRASE_GAP = String.raw`(?:\s|\{\s*["'\x60]\s*["'\x60]\s*\})+`;

function occurrenceRegex(term, kind, { caseInsensitive = false } = {}) {
  const body = kind === "phrase" ? term.trim().split(/\s+/).map(escapeRe).join(PHRASE_GAP) : escapeRe(term);
  // Symbols match whole identifiers only: ownSitesFirst must not match ownSitesFirstPolicy.
  const pattern = kind === "symbol" ? `(?<![\\w$])${body}(?![\\w$])` : body;
  return new RegExp(pattern, caseInsensitive ? "gi" : "g");
}

function isTestPath(p) {
  return /(?:\.test|\.spec)\.[cm]?[jt]sx?$|\/__tests__\/|\/__fixtures__\/|\/__snapshots__\/|(?:^|\/)tests?\//i.test(p);
}

function definitionKind(line, term) {
  const t = escapeRe(term);
  if (new RegExp(`\\b(?:const|let|var|function\\*?|class|interface|type|enum|namespace|def|fn|struct|trait|impl|func|protocol|extension|case)\\s+${t}(?![\\w$])`).test(line)) return "declaration";
  if (new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:static\\s+)?(?:readonly\\s+)?(?:public\\s+|private\\s+|protected\\s+)?${t}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`).test(line)) return "method";
  if (new RegExp(`^\\s*(?:readonly\\s+)?["']?${t}["']?\\s*\\??\\s*:`).test(line)) return "property";
  if (new RegExp(`^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+)?${t}\\s*(?::[^=]+)?=(?![=>])`).test(line)) return "assignment";
  return null;
}

const SOURCE_RANK = { code: 0, wiki: 1, docs: 2 };

/**
 * Literal lookup of each term in one index generation.
 *
 * Symbols: candidate chunks come from the full-text index (or an exact
 * instr() scan), then each is confirmed with a whole-identifier match on the
 * header-stripped text. A symbol cannot span lines, so chunk-level
 * confirmation is exact.
 *
 * Phrases: a phrase can be wrapped across lines or split between two chunks,
 * so candidates are whole files (every file holding the phrase holds each of
 * its words), and each candidate file is reassembled and matched with a
 * whitespace-flexible pattern. Exact case first, then case-insensitive.
 *
 * Up to maxFiles matching files are reassembled for line numbers; beyond
 * that the response says the listing is truncated.
 */
async function exactLookup(gen, question, { limit = 8, maxChars = 18000, maxFiles = 300, maxLinesPerFile = 6, kinds = null, scanner = null, timeBudgetMs = 3000 } = {}) {
  const { sourceAware } = gen;
  const parsed = parseExactQuery(question);
  const kindFilter = sourceAware && kinds && kinds.length ? ` AND source_kind IN (${kinds.map(() => "?").join(",")})` : "";
  const kindArgs = sourceAware && kinds && kinds.length ? kinds : [];
  const projection = sourceAware ? "path, ord, text, source_kind source, revision, repository" : "path, ord, text, 'code' source, '' revision, '' repository";
  // The work runs inside the shared MCP process: bound it so one broad
  // question cannot stall every other tool.
  const deadline = Date.now() + timeBudgetMs;
  const scan = scanner ? await scanner.prepare().catch((e) => ({ ok: false, reason: e.message })) : null;
  const results = [];

  for (const { term, kind } of parsed.terms) {
    if (kind === "path") { results.push(await pathLookup(gen, term, { maxChars, kinds, scanner: scan && scan.ok ? scanner : null })); continue; }
    const found = kind === "phrase"
      ? phraseFiles(gen, term, { kindFilter, kindArgs, maxFiles, deadline })
      : symbolFiles(gen, term, { projection, kindFilter, kindArgs, maxFiles, deadline });
    // The files the index leaves out, at the same revision.
    let scanned = null;
    if (scan && scan.ok) scanned = await scanUnindexed(scanner, term, kind, found.caseInsensitive);
    results.push(describeTerm(term, kind, found, scanned, { limit, maxLinesPerFile, coverage: coverageOf(gen, scan) }));
  }
  return finishExact(gen, parsed, results, { maxChars, scope: scopeOf(gen, scan) });
}

// A whitespace-free piece of the literal that every match contains verbatim
// (the longest one, so the scan's candidate list stays short).
function scanNeedle(term, kind) {
  if (kind === "symbol") return term;
  return term.trim().split(/\s+/).sort((x, y) => y.length - x.length)[0];
}

// Scans the unindexed files. When the index already matched in exact case,
// only exact-case matches count here too, so the two lists agree.
async function scanUnindexed(scanner, term, kind, indexMatchedIgnoringCase) {
  const out = await scanner.find(scanNeedle(term, kind));
  const passes = indexMatchedIgnoringCase === false ? [false] : [false, true];
  let files = [], caseInsensitive = false;
  for (const ci of passes) {
    const re = occurrenceRegex(term, kind, { caseInsensitive: ci });
    files = [];
    for (const c of out.candidates) {
      const { hits, occurrences } = hitsIn(c.text, re, term, kind);
      if (hits.length) files.push({ path: c.path, source: "code", hits, occurrences, test: isTestPath(c.path), inIndex: false });
    }
    if (files.length) { caseInsensitive = ci; break; }
  }
  return { status: out.status, reason: out.reason, files, caseInsensitive };
}

const fileKey = (r) => `${r.source}\u0000${r.path}`;
const fileOrder = (a, b) => (SOURCE_RANK[a.source] ?? 3) - (SOURCE_RANK[b.source] ?? 3) || isTestPath(a.path) - isTestPath(b.path) || a.path.localeCompare(b.path);

// Line-level hits of `re` in a whole file text. A phrase match that crosses
// a line break is reported at the line it starts on.
function hitsIn(text, re, term, kind) {
  const hits = [];
  let occurrences = 0;
  re.lastIndex = 0;
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineAt = (index) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; } return lo; };
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === "") { re.lastIndex++; continue; }
    occurrences++;
    const ln = lineAt(m.index);
    const last = hits[hits.length - 1];
    if (last && last.line === ln + 1) continue;
    const lineText = text.slice(starts[ln], (starts[ln + 1] ?? text.length + 1) - 1);
    hits.push({
      line: ln + 1, text: lineText.trim().slice(0, 240),
      definition: kind === "symbol" ? definitionKind(lineText, m[0]) : null,
      ...(m[0].includes("\n") ? { spansLines: true } : {}),
    });
  }
  return { hits, occurrences };
}

// Confirms candidate files with exact case first, then case-insensitively.
// Stops reassembling files at the deadline; the caller reports the cut.
function confirmFiles(gen, term, kind, candidates, { maxFiles, deadline = Infinity, passes = [false, true] }) {
  const ordered = [...candidates].sort(fileOrder);
  const texts = [];
  for (const f of ordered.slice(0, maxFiles)) {
    if (Date.now() > deadline) break;
    texts.push(fileText(gen.db, f.path, gen.sourceAware ? { sourceKind: f.source } : {}) || "");
  }
  const scanned = ordered.slice(0, texts.length);
  const cutBy = texts.length < Math.min(maxFiles, ordered.length) ? "time" : ordered.length > maxFiles ? "files" : null;
  for (const caseInsensitive of passes) {
    const re = occurrenceRegex(term, kind, { caseInsensitive });
    const files = [];
    let occurrences = 0;
    scanned.forEach((f, i) => {
      const { hits, occurrences: n } = hitsIn(texts[i], re, term, kind);
      if (!hits.length) return;
      occurrences += n;
      files.push({ ...f, hits, occurrences: n, test: isTestPath(f.path) });
    });
    if (files.length || caseInsensitive || passes.length === 1) {
      return { files, occurrences, caseInsensitive: caseInsensitive && files.length > 0, candidates: ordered.length, scanned: scanned.length, cutBy };
    }
  }
}

const MAX_CANDIDATE_CHUNKS = 5000;
function symbolFiles(gen, term, { projection, kindFilter, kindArgs, maxFiles, deadline }) {
  const rows = candidateRows(gen, term, "symbol", { projection, kindFilter, kindArgs, limit: MAX_CANDIDATE_CHUNKS });
  // A very common word: the totals are not known, only that it is everywhere.
  const capped = rows.length >= MAX_CANDIDATE_CHUNKS;
  // Chunk-level confirmation (a symbol never spans lines). Exact case first;
  // a name typed from a screenshot or a player's message in another case is
  // then matched ignoring case, and the result says which one matched.
  for (const caseInsensitive of [false, true]) {
    const re = occurrenceRegex(term, "symbol", { caseInsensitive });
    const byFile = new Map();
    for (const r of rows) {
      re.lastIndex = 0;
      if (re.test(chunkBody(r.text)) && !byFile.has(fileKey(r))) byFile.set(fileKey(r), { path: r.path, source: r.source, revision: r.revision, repository: r.repository });
    }
    if (byFile.size || caseInsensitive) {
      const out = confirmFiles(gen, term, "symbol", [...byFile.values()], { maxFiles, deadline, passes: [caseInsensitive] });
      if (capped) return { ...out, totalFiles: null, scanned: out.scanned, candidates: out.candidates + 1, cutBy: "chunks", caseInsensitive: caseInsensitive && byFile.size > 0 };
      return { ...out, totalFiles: byFile.size, caseInsensitive: caseInsensitive && byFile.size > 0 };
    }
  }
}

// Every file that holds the phrase holds each of its words somewhere, so the
// intersection of the files holding its rarest words is a superset of the
// answer. Words at the very start of the phrase may be the tail of a longer
// word in the source, so they are not used; the last word is matched as a
// prefix for the same reason. FTS (unicode61) ignores case, whitespace and
// line breaks, so the same candidates serve the case-insensitive retry.
const WORD_RE = /[\p{L}\p{N}]+/gu;
function phraseWordQueries(term) {
  const out = [];
  for (const m of term.matchAll(WORD_RE)) {
    const boundedLeft = m.index > 0;
    const boundedRight = m.index + m[0].length < term.length;
    if (boundedLeft && boundedRight) out.push(`"${m[0]}"`);
    else if (boundedLeft) out.push(`"${m[0]}"*`);
  }
  return [...new Set(out)];
}

function phraseFiles(gen, term, { kindFilter, kindArgs, maxFiles, deadline }) {
  const { db, sourceAware } = gen;
  const queries = hasFts(gen) && process.env.RAG_EXACT_SCAN !== "1" ? phraseWordQueries(term) : [];
  const src = sourceAware ? "c.source_kind" : "'code'";
  const cols = sourceAware ? "c.revision, c.repository" : "'' revision, '' repository";
  let candidates = null;
  if (queries.length) {
    try {
      const counted = queries.map(q => ({ q, n: db.prepare("SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH ?").get(q).n }))
        .sort((x, y) => x.n - y.n).slice(0, 3);
      for (const { q } of counted) {
        const rows = db.prepare(`SELECT DISTINCT c.path, ${src} source, ${cols} FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?${kindFilter.replace(/source_kind/g, "c.source_kind")}`).all(q, ...kindArgs);
        const here = new Map(rows.map(r => [fileKey(r), r]));
        candidates = candidates ? new Map([...candidates].filter(([k]) => here.has(k))) : here;
        if (!candidates.size) break;
      }
    } catch { candidates = null; }
  }
  if (!candidates) {
    // No usable word (one partial word, or no FTS table): a literal scan, which
    // is exact for text that does not contain whitespace.
    const needle = term.trim().split(/\s+/)[0];
    const rows = db.prepare(`SELECT DISTINCT path, ${sourceAware ? "source_kind source, revision, repository" : "'code' source, '' revision, '' repository"} FROM chunks WHERE instr(lower(text), lower(?)) > 0${kindFilter}`).all(needle, ...kindArgs);
    candidates = new Map(rows.map(r => [fileKey(r), r]));
  }
  const out = confirmFiles(gen, term, "phrase", [...candidates.values()], { maxFiles, deadline });
  return { ...out, totalFiles: out.scanned < out.candidates ? null : out.files.length };
}

// Builds the per-term result: ranked listing, definitions, completeness.
//
// "complete" is true only when every text file of the repository at this
// revision was searched (the index, plus the scan of what it leaves out) and
// nothing was cut by a limit. A miss over the indexed files alone is reported
// as found: false, complete: false with the reason.
function describeTerm(term, kind, found, scan, { limit, maxLinesPerFile, coverage }) {
  const { occurrences, candidates, scanned: scannedCount, cutBy } = found;
  let caseInsensitive = found.caseInsensitive;
  let scanned = found.files;
  let totalFiles = found.totalFiles;
  const reasons = [];
  // Merge the scan of the unindexed files. Same-case rule: exact-case matches
  // anywhere win over case-insensitive ones.
  if (scan && scan.files.length) {
    if (!scanned.length || (caseInsensitive && !scan.caseInsensitive)) {
      scanned = scan.files; totalFiles = totalFiles === 0 || caseInsensitive ? scan.files.length : totalFiles; caseInsensitive = scan.caseInsensitive;
    } else if (scan.caseInsensitive === caseInsensitive) {
      scanned = [...scanned, ...scan.files];
      totalFiles = totalFiles != null ? totalFiles + scan.files.length : null;
    }
  }
  const definitions = [];
  for (const f of scanned) for (const h of f.hits) if (h.definition) definitions.push({ path: f.path, line: h.line, kind: h.definition, text: h.text, source: f.source });
  // Rank files: definition sites (non-test) first, then code uses by count, then tests and docs.
  const score = f => (f.hits.some(h => h.definition) && !f.test ? 1000 : 0) + (f.test ? -500 : 0) - (SOURCE_RANK[f.source] ?? 3) * 100 + Math.min(f.hits.length, 50);
  const ranked = [...scanned].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
  const listed = ranked.slice(0, Math.max(1, limit));
  const allScanned = scannedCount === candidates;
  const knownTotal = totalFiles != null ? totalFiles : scanned.length;
  if (!allScanned) reasons.push(cutBy === "time"
    ? `the lookup hit its time limit after checking ${scannedCount} of ${candidates} candidate files`
    : cutBy === "chunks" ? `this occurs in more than ${MAX_CANDIDATE_CHUNKS} indexed chunks; only the first ${scannedCount} files were checked. Narrow the term`
    : `${candidates} candidate files; only the first ${scannedCount} were checked`);
  if (allScanned && totalFiles != null && listed.length < totalFiles) reasons.push(`${knownTotal} files contain this; ${listed.length} are listed. Raise limit to see more, or narrow the term`);
  if (scan && scan.status === "truncated") reasons.push(`scan of the files the index leaves out was cut: ${scan.reason}`);
  const searchedAll = coverage.repository && !!scan && scan.status === "scanned";
  const complete = allScanned && totalFiles != null && listed.length === totalFiles && searchedAll && !reasons.length;
  const why = coverage.repository && scan && scan.status === "skipped" ? `only the indexed files were searched; the repository scan was skipped: ${scan.reason}` : coverage.why;
  const fromScan = scanned.filter(f => f.inIndex === false).length;
  const foundBy = knownTotal > 0 ? (fromScan === 0 ? "index" : fromScan === scanned.length ? "repository scan" : "index and repository scan") : null;
  return {
    term, kind, found: knownTotal > 0,
    ...(foundBy ? { foundBy } : {}),
    caseInsensitive: caseInsensitive || undefined,
    ...(knownTotal > 0 ? { matchedCase: caseInsensitive ? "case-insensitive" : "exact" } : {}),
    totalFiles: totalFiles != null ? totalFiles : undefined,
    totalOccurrences: allScanned && totalFiles === scanned.length ? scanned.reduce((n, f) => n + (f.occurrences ?? f.hits.length), 0) : undefined,
    complete,
    ...(reasons.length ? { truncated: reasons.join("; ") } : {}),
    ...(!complete && !reasons.length && why ? { incomplete: why } : {}),
    ...(knownTotal === 0 ? { notFoundIn: complete ? coverage.allText : coverage.indexOnly } : {}),
    ...(knownTotal === 0 && !complete && kind === "phrase" && coverage.phraseHint ? { hint: coverage.phraseHint } : {}),
    definitions: definitions.filter(d => listed.some(f => f.path === d.path)).slice(0, 20),
    files: listed.map(f => ({
      path: f.path, source: f.source, test: f.test || undefined,
      ...(f.inIndex === false ? { inIndex: false } : {}),
      occurrences: f.hits.length,
      lines: f.hits.slice(0, maxLinesPerFile),
    })),
  };
}

// What a lookup in this generation covers. The game is AHDGame plus the
// engineering docs; a repository scan (scan.ok) covers the AHDGame files the
// index leaves out. Internal repositories record what they excluded.
function coverageOf(gen, scan) {
  const rev = revisionOf(gen);
  const short = rev ? String(rev).slice(0, 10) : "unknown";
  if (scan && scan.ok) {
    return {
      repository: true,
      allText: `every text file of the repository at revision ${short} (the index plus a scan of the files it leaves out)`,
      indexOnly: `the indexed files at revision ${short}`,
      why: null,
    };
  }
  const excluded = excludedSummary(gen);
  const isGame = !gen.visibility || gen.visibility === "public";
  return {
    repository: false,
    allText: null,
    indexOnly: `the indexed files at revision ${short} only`,
    why: isGame
      ? `only the indexed files were searched; ${GAME_INDEX_OMITS} were not${scan && scan.reason ? ` (repository scan skipped: ${scan.reason})` : ""}`
      : `only the indexed files were searched; ${excluded.total} files of this repository are not indexed (${excluded.text}) and were not searched`,
    phraseHint: isGame
      ? "This looks like on-screen text. The game's UI strings live in messages/<locale>/*.json, which this index does not include and which were not searched, so this is not evidence that the game never shows it."
      : excluded.total ? `Text can also live in the ${excluded.total} files this index leaves out (${excluded.text}); not finding it here is not evidence that it does not exist.` : null,
  };
}

const GAME_INDEX_OMITS = "files the game index leaves out (messages/ with the UI strings, scripts/, content/changelog, migrations, .mjs, CSS, shell and workflow files, files over 400 KB)";

function excludedSummary(gen) {
  if (gen._excluded) return gen._excluded;
  let rows = [];
  try { if (hasTable(gen.db, "excluded")) rows = gen.db.prepare("SELECT reason, COUNT(*) n FROM excluded GROUP BY reason").all(); } catch {}
  const byCategory = new Map();
  for (const r of rows) {
    const key = String(r.reason).replace(/\s*\([^)]*\)\s*$/, "").replace(/^possible secret: .*/, "possible secrets").replace(/^larger than .*/, "large files");
    byCategory.set(key, (byCategory.get(key) || 0) + r.n);
  }
  const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
  gen._excluded = { total, categories: Object.fromEntries(byCategory), text: [...byCategory].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(", ") || "none recorded" };
  return gen._excluded;
}

function scopeOf(gen, scan) {
  const rev = revisionOf(gen);
  const files = (() => { try { return gen.db.prepare("SELECT COUNT(DISTINCT path) n FROM chunks").get().n; } catch { return null; } })();
  const scope = { revision: rev, indexedFiles: files };
  if (scan && scan.ok) {
    scope.searched = `the ${files} indexed files, and a literal scan of the ${scan.unindexed.length} other text files of the repository at this revision (read from the commit, not a working tree)`;
    scope.notSearched = `binary and media files (${scan.skipped.binary}), files over 1 MB (${scan.skipped.large}), files named like credentials (${scan.skipped.secretName})`;
    scope.unindexedWhere = scan.categories.slice(0, 8).map(c => `${c.dir} (${c.files})`).join(", ");
  } else if (!gen.visibility || gen.visibility === "public") {
    scope.searched = `the ${files} indexed files only`;
    scope.notSearched = GAME_INDEX_OMITS + (scan && scan.reason ? `; the repository scan was skipped: ${scan.reason}` : "");
  } else {
    const ex = excludedSummary(gen);
    scope.searched = `the ${files} indexed files only`;
    scope.notSearched = `${ex.total} files excluded from this index (${ex.text})`;
  }
  return scope;
}

// Candidate chunks for one symbol. The FTS index is a prefilter: unicode61
// splits identifiers on the same characters that bound them (any
// non-alphanumeric, including "_" and "$"), so every chunk holding the whole
// identifier also holds its token sequence, and the phrase query returns a
// superset (in any case) that the exact regex then confirms. RAG_EXACT_SCAN=1
// forces a case-insensitive instr() scan (the test suite checks the two agree).
function candidateRows(gen, term, kind, { projection, kindFilter, kindArgs, limit = MAX_CANDIDATE_CHUNKS }) {
  const { db } = gen;
  if (kind === "symbol" && /^[\w$]+$/.test(term) && /[A-Za-z0-9]/.test(term) && process.env.RAG_EXACT_SCAN !== "1" && hasFts(gen)) {
    const cols = projection.split(",").map(c => "c." + c.trim().replace(/^'([^']*)'/, "'$1'")).map(c => c.replace(/^c\.'/, "'")).join(", ");
    try {
      return db.prepare(`SELECT ${cols} FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ?${kindFilter.replace(/source_kind/g, "c.source_kind")} LIMIT ?`)
        .all(`"${term.replace(/"/g, '""')}"`, ...kindArgs, limit);
    } catch { /* fall through to the scan */ }
  }
  return db.prepare(`SELECT ${projection} FROM chunks WHERE instr(lower(text), lower(?)) > 0${kindFilter} LIMIT ?`).all(term, ...kindArgs, limit);
}

function hasFts(gen) {
  if (gen._hasFts === undefined) gen._hasFts = hasTable(gen.db, "chunks_fts");
  return gen._hasFts;
}

async function pathLookup(gen, term, { maxChars, kinds, scanner = null }) {
  const { db, sourceAware } = gen;
  const kindFilter = sourceAware && kinds && kinds.length ? ` AND source_kind IN (${kinds.map(() => "?").join(",")})` : "";
  const kindArgs = sourceAware && kinds && kinds.length ? kinds : [];
  const exact = db.prepare(`SELECT DISTINCT path${sourceAware ? ", source_kind source" : ", 'code' source"} FROM chunks WHERE path=?${kindFilter}`).all(term, ...kindArgs);
  const candidates = exact.length
    ? exact
    : db.prepare(`SELECT DISTINCT path${sourceAware ? ", source_kind source" : ", 'code' source"} FROM chunks WHERE (path LIKE ? ESCAPE '\\')${kindFilter} ORDER BY path LIMIT 50`)
      .all(`%/${term.replace(/[\\%_]/g, m => "\\" + m)}`, ...kindArgs);
  if (!candidates.length) {
    // Not indexed: read it from the indexed revision when the repository can be scanned.
    if (scanner) {
      const r = await scanner.read(term);
      if (r.status === "found") {
        const truncated = r.text.length > maxChars;
        return {
          term, kind: "path", found: true, foundBy: "repository scan", totalFiles: 1, complete: true, definitions: [],
          files: [{ path: r.path, source: "code", inIndex: false, lines: undefined }],
          content: truncated ? r.text.slice(0, maxChars) : r.text,
          contentTruncated: truncated ? `file is ${r.text.length} characters; ${maxChars} shown. Use code_read with startLine to page.` : undefined,
          lineCount: r.text.split("\n").length,
          note: "this file is not in the index; it was read from the repository at the indexed revision",
        };
      }
      if (r.status === "ambiguous") return { term, kind: "path", found: true, foundBy: "repository scan", ambiguous: true, totalFiles: r.paths.length, complete: r.paths.length < 50, definitions: [], files: r.paths.map(p => ({ path: p, source: "code", inIndex: false })) };
      if (r.status === "excluded") return { term, kind: "path", found: true, foundBy: "repository scan", totalFiles: 1, complete: true, definitions: [], files: [{ path: r.path, source: "code", inIndex: false }], note: `the file exists at this revision but is ${r.reason}` };
      if (r.status === "absent") return { term, kind: "path", found: false, totalFiles: 0, complete: true, notFoundIn: `every path of the repository at revision ${String(revisionOf(gen) || "").slice(0, 10)}`, definitions: [], files: [] };
      return { term, kind: "path", found: false, totalFiles: 0, complete: false, incomplete: `not in the index; the repository scan was skipped: ${r.reason}`, definitions: [], files: [] };
    }
    return { term, kind: "path", found: false, totalFiles: 0, complete: false, notFoundIn: "the indexed files only", incomplete: "not in the index, and the files the index leaves out were not searched", definitions: [], files: [] };
  }
  if (candidates.length > 1) {
    return {
      term, kind: "path", found: true, ambiguous: true, totalFiles: candidates.length, complete: candidates.length < 50,
      definitions: [], files: candidates.map(c => ({ path: c.path, source: c.source })),
    };
  }
  const only = candidates[0];
  const text = fileText(db, only.path, sourceAware ? { sourceKind: only.source } : {}) || "";
  const truncated = text.length > maxChars;
  return {
    term, kind: "path", found: true, totalFiles: 1, complete: true,
    definitions: [],
    files: [{ path: only.path, source: only.source, lines: undefined }],
    content: truncated ? text.slice(0, maxChars) : text,
    contentTruncated: truncated ? `file is ${text.length} characters; ${maxChars} shown. Use code_read with startLine to page.` : undefined,
    lineCount: text.split("\n").length,
  };
}

function finishExact(gen, parsed, results, { maxChars, scope = null }) {
  // Ranked union of files for callers that only read `files`.
  const files = [];
  for (const r of results) for (const f of r.files) if (!files.includes(f.path)) files.push(f.path);
  // Compact readable context within the character budget.
  const blocks = [];
  let budget = maxChars;
  for (const r of results) {
    let block;
    if (r.kind === "path" && r.content != null) block = `--- ${r.files[0].path} (whole file, ${r.lineCount} lines) ---\n${r.content}`;
    else if (!r.found) block = `--- "${r.term}": not found in ${r.notFoundIn || "the indexed files"}${r.complete ? "" : `. NOT a complete search: ${r.incomplete || r.truncated}`} ---${r.hint ? `\n${r.hint}` : ""}`;
    else {
      const lines = r.files.map(f => `${f.path}${f.test ? " (test)" : ""}${f.source && f.source !== "code" ? ` [${f.source}]` : ""}: ${f.occurrences} line(s)\n` +
        (f.lines || []).map(h => `  ${h.line ?? "?"}${h.definition ? ` [${h.definition}]` : ""}: ${h.text}`).join("\n"));
      const caseNote = r.caseInsensitive ? ", no exact-case match, matched ignoring case" : "";
      block = `--- "${r.term}" (${r.kind}): ${r.totalFiles ?? "at least " + r.files.length} file(s)${caseNote}${r.complete ? ", complete" : ", truncated"} ---\n${lines.join("\n")}`;
    }
    if (block.length > budget) { blocks.push(block.slice(0, Math.max(0, budget))); budget = 0; break; }
    blocks.push(block); budget -= block.length;
  }
  const contextCut = budget === 0;
  // The structured listing is bounded too: line samples shrink before files go.
  let linesTrimmed;
  if (JSON.stringify(results).length > maxChars * 3) {
    for (const r of results) for (const f of r.files) if (f.lines) f.lines = f.lines.slice(0, 1);
    linesTrimmed = "line samples cut to one per file to fit maxChars; occurrences counts are unchanged";
  }
  const truncated = [...new Set(results.map(r => r.truncated).filter(Boolean))];
  if (contextCut) truncated.push("the readable listing was cut to fit maxChars");
  return {
    terms: results.map(r => r.term),
    ignoredWords: parsed.ignored.length ? parsed.ignored : undefined,
    complete: results.every(r => r.complete) && !contextCut,
    ...(truncated.length ? { truncated: truncated.join("; ") } : {}),
    found: results.some(r => r.found),
    ...(scope ? { scope } : {}),
    count: files.length,
    files,
    results,
    context: blocks.join("\n\n"),
    contextTruncated: contextCut ? "raise maxChars to see the whole listing" : undefined,
    linesTrimmed,
  };
}

/** Read one whole indexed file, optionally a line range. */
function readFile(gen, filePath, { maxChars = 40000, startLine = null, endLine = null } = {}) {
  const key = String(filePath || "").trim().replace(/^\.\//, "").replace(/:\d+$/, "");
  if (!key || key.includes("..") || key.startsWith("/")) return { error: "path must be repository-relative" };
  const { db, sourceAware } = gen;
  let rows = db.prepare(`SELECT DISTINCT path${sourceAware ? ", source_kind source" : ", 'code' source"} FROM chunks WHERE path=?`).all(key);
  if (!rows.length) rows = db.prepare(`SELECT DISTINCT path${sourceAware ? ", source_kind source" : ", 'code' source"} FROM chunks WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 20`).all(`%/${key.replace(/[\\%_]/g, m => "\\" + m)}`);
  if (!rows.length) return null;
  if (rows.length > 1 && !rows.every(r => r.path === rows[0].path)) return { ambiguous: rows.map(r => r.path) };
  const row = rows.find(r => r.source === "code") || rows[0];
  const text = fileText(db, row.path, sourceAware ? { sourceKind: row.source } : {}) || "";
  return { path: row.path, source: row.source, ...pageText(text, { maxChars, startLine, endLine }) };
}

/** One page of a file's text by line range and character budget. */
function pageText(text, { maxChars = 40000, startLine = null, endLine = null } = {}) {
  const lines = text.split("\n");
  const from = Math.max(1, Number(startLine) || 1);
  const to = Math.min(lines.length, Number(endLine) || lines.length);
  let body = lines.slice(from - 1, to).join("\n");
  const truncated = body.length > maxChars;
  if (truncated) body = body.slice(0, maxChars);
  const shownTo = truncated ? from - 1 + body.split("\n").length : to;
  return {
    lineCount: lines.length, startLine: from, endLine: shownTo,
    complete: !truncated && from === 1 && to === lines.length,
    ...(truncated || to < lines.length ? { more: `lines ${shownTo + 1}-${lines.length} not shown; call again with startLine: ${shownTo + 1}` } : {}),
    content: body,
  };
}

/** Keyword-only retrieval used when the embedding service is down. */
function keywordSearch(gen, question, { topK = 8, maxChars = 30000 } = {}) {
  const { db, sourceAware } = gen;
  const words = [...new Set((String(question).match(/[A-Za-z_][\w]{2,}/g) || []).filter(w => !STOP.has(w.toLowerCase())))].slice(0, 12);
  if (!words.length) return { hits: [], files: [], count: 0 };
  const match = words.map(w => `"${w.replace(/"/g, '""')}"`).join(" OR ");
  const projection = sourceAware ? "c.path, c.ord, c.text, c.source_kind source, c.revision" : "c.path, c.ord, c.text, 'code' source, '' revision";
  let rows = [];
  try {
    rows = db.prepare(`SELECT ${projection}, bm25(chunks_fts) rank FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, topK * 6);
  } catch { rows = []; }
  const perFile = new Map();
  const hits = [];
  for (const r of rows) {
    const n = perFile.get(r.path) || 0;
    if (n >= 2) continue;
    perFile.set(r.path, n + 1);
    hits.push({ path: r.path, ord: r.ord, source: r.source, revision: r.revision, score: -r.rank, text: r.text });
    if (hits.length >= topK) break;
  }
  return applyBudget(hits, maxChars);
}

// Applies the caller's character budget in rank order and reports what it cut,
// so a short answer is never mistaken for "only one match exists".
function applyBudget(hits, maxChars) {
  const kept = [];
  let used = 0, dropped = 0;
  for (const h of hits) {
    const size = String(h.text || "").length;
    if (used + size > maxChars) { dropped++; continue; }
    used += size; kept.push(h);
  }
  return { hits: kept, files: [...new Set(kept.map(h => h.path))], count: kept.length, droppedForBudget: dropped, charsUsed: used };
}

// ── repositories ───────────────────────────────────────────────────────────

// The game is the default and is served from the existing Ask-built indexes.
// Internal repositories are one index file each under CODE_INDEX_INTERNAL_DIR.
const INTERNAL_REPOS = {
  keir: { file: "keir.db", github: "lakesidegamedev/lakeside-ops", describe: "Keir itself and the studio ops tooling: apps/agent (Keir, the support operator), apps/web (ops site and these search tools), apps/ios (Keir iPhone app), apps/desktop, apps/cli. Search it for Keir's own behaviour and bugs." },
  client: { file: "client.db", github: "lakesidegamedev/AHDClient", describe: "The A House Divided desktop and mobile client (Tauri). Search it for problems that only happen in the app, not in the browser." },
  "discord-bot": { file: "discord-bot.db", github: "arle-bina/adhd-bot", describe: "The game's Discord bot (maintained by the cofounder; read-only for us). Search it for bot commands, bot messages and Discord-side bugs." },
  ask: { file: "ask.db", github: "lakesidegamedev/ask", describe: "Ask, the player question-answering site and its in-game drawer backend. Search it for wrong or refused Ask answers." },
  site: { file: "site.db", github: "lakesidegamedev/lakeside-landing", describe: "The studio's public website. Search it for problems on the landing pages." },
  accounts: { file: "accounts.db", github: "lakesidegamedev/lakeside-accounts + lakeside-auth + lakeside-status", describe: "Accounts, sign-in and the status page. Search it for login, account and status-page problems." },
  "index-tools": { file: "index-tools.db", github: "lakesidegamedev/LSGD-ops-dash", describe: "The code index builder and ops dashboard tooling. Search it for problems with code search itself." },
};
const GAME = "game";
const ALL_INTERNAL = "all-internal";

function validRepoNames() {
  return [GAME, ...Object.keys(INTERNAL_REPOS), ALL_INTERNAL];
}

/**
 * Normalise the optional `repo` argument (a name, a list, or "all-internal").
 * Returns { repos: [...names] } or { error }.
 */
function resolveRepos(repo) {
  if (repo == null || repo === "" || (Array.isArray(repo) && !repo.length)) return { repos: [GAME] };
  const names = (Array.isArray(repo) ? repo : String(repo).split(",")).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const out = [];
  for (const name of names) {
    if (name === ALL_INTERNAL || name === "all") { for (const k of Object.keys(INTERNAL_REPOS)) if (!out.includes(k)) out.push(k); continue; }
    if (name !== GAME && !INTERNAL_REPOS[name]) {
      return { error: `unknown repo "${name}". Valid: ${validRepoNames().join(", ")}` };
    }
    if (!out.includes(name)) out.push(name);
  }
  return { repos: out };
}

/**
 * May this token read internal (private) repositories? Explicit grant only:
 * the token record carries scopes.internalCode === true, or its name is in
 * CODE_INDEX_INTERNAL_READERS. Everything else, including any public-facing
 * caller, sees the game only.
 */
function canReadInternal(auth, env = process.env) {
  if (!auth) return false;
  if (auth.scopes && auth.scopes.internalCode === true) return true;
  const allow = String(env.CODE_INDEX_INTERNAL_READERS || "").split(",").map(s => s.trim()).filter(Boolean);
  return !!auth.name && allow.includes(auth.name);
}

function internalDir(env = process.env) {
  return env.CODE_INDEX_INTERNAL_DIR || "/var/lib/lakeside-code-index/internal";
}

function internalIndexPath(name, env = process.env) {
  const repo = INTERNAL_REPOS[name];
  if (!repo) throw new Error(`not an internal repo: ${name}`);
  return path.join(internalDir(env), repo.file);
}

// A reader cache: one swap-safe reader per index file for the process.
function createReaderPool(options = {}) {
  const readers = new Map();
  return {
    reader(file) {
      if (!readers.has(file)) readers.set(file, createGenerationReader(file, options));
      return readers.get(file);
    },
    closeAll() { for (const r of readers.values()) r.close(); readers.clear(); },
  };
}

function revisionOf(gen, kind = "code") {
  const row = (gen.revisions || []).find(r => r.kind === kind) || (gen.revisions || [])[0];
  return row ? row.revision : (gen.meta && gen.meta.revision) || null;
}

module.exports = {
  IndexUnavailableError,
  createGenerationReader,
  createReaderPool,
  parseExactQuery,
  exactLookup,
  readFile,
  pageText,
  keywordSearch,
  applyBudget,
  resolveRepos,
  canReadInternal,
  internalIndexPath,
  internalDir,
  revisionOf,
  chunkBody,
  INTERNAL_REPOS,
  GAME,
  ALL_INTERNAL,
  validRepoNames,
};
