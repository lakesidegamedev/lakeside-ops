"use strict";

// Exact lookup, file reads, the swap-safe reader, repository selection and the
// budget report for the agent code tools. Each test builds a small index with
// the same schema the Ask builder publishes.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const ci = require("./code-index");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "code-index-test-"));
}

// files: { path: { text, source?, parts? } }. Text is split into `parts`
// zero-overlap chunks, each prefixed with a context header like the builder's.
function buildIndex(file, files, { generation = "g1", revision = "rev1", header = (p, i, n) => `[code] ${p} (part ${i + 1}/${n}): summary mentions FakeHeaderSymbol` } = {}) {
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, source_kind TEXT NOT NULL, repository TEXT NOT NULL, revision TEXT NOT NULL,
      path TEXT NOT NULL, ord INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL, dims INTEGER NOT NULL,
      indexed_at TEXT NOT NULL, UNIQUE(source_kind, path, ord));
    CREATE TABLE source_revisions(kind TEXT PRIMARY KEY, repository TEXT NOT NULL, revision TEXT NOT NULL, indexed_at TEXT NOT NULL, files INTEGER NOT NULL, chunks INTEGER NOT NULL);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const insert = db.prepare("INSERT INTO chunks(source_kind,repository,revision,path,ord,hash,text,vec,dims,indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const [p, spec] of Object.entries(files)) {
    const text = spec.text;
    const parts = spec.parts || 1;
    // Split on line boundaries, as the v2 chunker does.
    const lines = text.split(/(?<=\n)/);
    const per = Math.ceil(lines.length / parts);
    const pieces = [];
    for (let i = 0; i < lines.length; i += per) pieces.push(lines.slice(i, i + per).join(""));
    pieces.forEach((piece, i) => insert.run(spec.source || "code", "AHDGame", revision, p, i, `${p}#${i}`,
      `${header(p, i, pieces.length)}\n${piece}`, Buffer.alloc(8), 2, "now"));
  }
  db.prepare("INSERT INTO source_revisions VALUES ('code','AHDGame',?, 'now', 1, 1)").run(revision);
  db.prepare("INSERT INTO meta VALUES ('generation', ?)").run(generation);
  db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, source_kind UNINDEXED, path UNINDEXED, content='chunks', content_rowid='id', tokenize='unicode61');
    INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);
  db.close();
}

const GAME_FILES = {
  "src/lib/countries/us/elections/billLifecycle.ts": { text: "import x from 'y';\n\nexport const US_NATIONAL_CONFIG = {\n  chamber: 'house',\n};\n", parts: 2 },
  "src/lib/billLifecycle.ts": { text: "export { US_NATIONAL_CONFIG } from './countries/us/elections/billLifecycle';\n" },
  "src/lib/turn/engine.test.ts": { text: "import { US_NATIONAL_CONFIG } from '../billLifecycle';\nexpect(US_NATIONAL_CONFIG).toBeTruthy();\n" },
  "src/lib/market/rules.ts": { text: "type Policy = {\n  ownSitesFirst?: boolean;\n};\nconst ownSitesFirstPolicy = 1;\nexport function pick(p) { return p.ownSitesFirst; }\n" },
  "src/app/ForSalePanel.tsx": { text: "<p>This company Cannot be merged yet.</p>\n" },
  "src/lib/turn/billLifecycle/configs/us.ts": { text: "// Forwarder.\nexport * from '../../../countries/us/elections/billLifecycle';\n" },
  "src/lib/other/us.ts": { text: "export const other = 1;\n" },
  "design/bills.md": { text: "US_NATIONAL_CONFIG holds the US rules.\n", source: "docs" },
};

function gameGen(dir = tmpDir()) {
  const file = path.join(dir, "index.db");
  buildIndex(file, GAME_FILES);
  return { gen: ci.createGenerationReader(file).get(), file, dir };
}

test("parseExactQuery separates symbols, phrases, paths and ignored words", () => {
  assert.deepStrictEqual(ci.parseExactQuery("US_NATIONAL_CONFIG").terms, [{ term: "US_NATIONAL_CONFIG", kind: "symbol" }]);
  assert.deepStrictEqual(ci.parseExactQuery("calculate").terms, [{ term: "calculate", kind: "symbol" }]);
  assert.deepStrictEqual(ci.parseExactQuery("cannot be merged yet").terms, [{ term: "cannot be merged yet", kind: "phrase" }]);
  assert.deepStrictEqual(ci.parseExactQuery('the "Launch Operations Delta" unit').terms, [{ term: "Launch Operations Delta", kind: "phrase" }]);
  const mixed = ci.parseExactQuery("outputResponseRules.ts buildRunReport unitOwnSiteCharge");
  assert.deepStrictEqual(mixed.terms.map(t => [t.term, t.kind]), [["outputResponseRules.ts", "path"], ["buildRunReport", "symbol"], ["unitOwnSiteCharge", "symbol"]]);
  const prose = ci.parseExactQuery("Hawaii forward base ownPortWorks BASING_FACTOR overseas base");
  assert.deepStrictEqual(prose.terms.map(t => t.term), ["ownPortWorks", "BASING_FACTOR"]);
  assert.ok(prose.ignored.includes("Hawaii"));
  assert.deepStrictEqual(ci.parseExactQuery("src/app/corporation/[id]/page.tsx:42").terms, [{ term: "src/app/corporation/[id]/page.tsx", kind: "path" }]);
});

test("a symbol is found as a whole identifier, with its definition first and real line numbers", () => {
  const { gen } = gameGen();
  const out = ci.exactLookup(gen, "US_NATIONAL_CONFIG");
  const r = out.results[0];
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.complete, true);
  assert.strictEqual(r.totalFiles, 4); // three code files and one doc
  assert.strictEqual(r.files[0].path, "src/lib/countries/us/elections/billLifecycle.ts");
  assert.deepStrictEqual(r.definitions[0], { path: "src/lib/countries/us/elections/billLifecycle.ts", line: 3, kind: "declaration", text: "export const US_NATIONAL_CONFIG = {", source: "code" });
  assert.strictEqual(r.files.find(f => f.path.endsWith(".test.ts")).test, true);
  assert.deepStrictEqual(r.files.map(f => f.source), ["code", "code", "docs", "code"], "code first, then docs, then tests");
  assert.strictEqual(out.files[0], "src/lib/countries/us/elections/billLifecycle.ts");
});

test("whole-identifier matching ignores longer names and the model-written chunk header", () => {
  const { gen } = gameGen();
  const r = ci.exactLookup(gen, "ownSitesFirst").results[0];
  assert.strictEqual(r.totalFiles, 1);
  assert.strictEqual(r.totalOccurrences, 2); // the property and the use, not ownSitesFirstPolicy
  assert.strictEqual(r.definitions[0].kind, "property");
  const header = ci.exactLookup(gen, "FakeHeaderSymbol").results[0];
  assert.strictEqual(header.found, false, "header text is not file content");
  assert.strictEqual(header.complete, true);
});

test("a missing literal is a complete not-found, and the FTS prefilter agrees with a full scan", () => {
  const { gen } = gameGen();
  for (const term of ["capacityUtilizationPct", "US_NATIONAL_CONFIG", "ownSitesFirst", "chamber"]) {
    const fast = ci.exactLookup(gen, term).results[0];
    process.env.RAG_EXACT_SCAN = "1";
    const scan = ci.exactLookup(gen, term).results[0];
    delete process.env.RAG_EXACT_SCAN;
    assert.strictEqual(fast.totalFiles, scan.totalFiles, term);
    assert.strictEqual(fast.totalOccurrences, scan.totalOccurrences, term);
  }
  const none = ci.exactLookup(gen, "capacityUtilizationPct");
  assert.strictEqual(none.found, false);
  assert.strictEqual(none.complete, true);
  assert.strictEqual(none.count, 0);
});

test("a short sentence is one phrase, matched case-insensitively when the exact case is absent", () => {
  const { gen } = gameGen();
  const r = ci.exactLookup(gen, "cannot be merged yet").results[0];
  assert.strictEqual(r.kind, "phrase");
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.caseInsensitive, true);
  assert.strictEqual(r.files[0].path, "src/app/ForSalePanel.tsx");
  assert.strictEqual(ci.exactLookup(gen, "put marines ashore").results[0].found, false);
});

test("a listing cut by the limit says so and keeps the exact total", () => {
  const { gen } = gameGen();
  const r = ci.exactLookup(gen, "US_NATIONAL_CONFIG", { limit: 1 }).results[0];
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.totalFiles, 4);
  assert.strictEqual(r.files.length, 1);
  assert.match(r.truncated, /4 files contain this; 1 are listed/);
});

test("a path returns that file whole; a bare file name resolves or lists the candidates", () => {
  const { gen } = gameGen();
  const exact = ci.exactLookup(gen, "src/lib/turn/billLifecycle/configs/us.ts").results[0];
  assert.strictEqual(exact.found, true);
  assert.match(exact.content, /^\/\/ Forwarder\./);
  const bare = ci.exactLookup(gen, "ForSalePanel.tsx").results[0];
  assert.strictEqual(bare.files[0].path, "src/app/ForSalePanel.tsx");
  const ambiguous = ci.exactLookup(gen, "us.ts").results[0];
  assert.strictEqual(ambiguous.ambiguous, true);
  assert.strictEqual(ambiguous.totalFiles, 2);
  assert.strictEqual(ci.exactLookup(gen, "src/nope.ts").results[0].found, false);
});

test("readFile reassembles every chunk and pages by line", () => {
  const { gen } = gameGen();
  const whole = ci.readFile(gen, "src/lib/countries/us/elections/billLifecycle.ts");
  assert.strictEqual(whole.content, GAME_FILES["src/lib/countries/us/elections/billLifecycle.ts"].text);
  assert.strictEqual(whole.complete, true);
  const page = ci.readFile(gen, "src/lib/countries/us/elections/billLifecycle.ts", { startLine: 3, endLine: 3 });
  assert.strictEqual(page.content, "export const US_NATIONAL_CONFIG = {");
  assert.match(page.more, /startLine: 4/);
  assert.strictEqual(ci.readFile(gen, "src/missing.ts"), null);
  assert.ok(ci.readFile(gen, "../etc/passwd").error);
});

test("the reader serves a new generation after a rename swap and keeps the old one when the new is broken", () => {
  const dir = tmpDir();
  const file = path.join(dir, "index.db");
  buildIndex(file, GAME_FILES, { generation: "g1" });
  const reader = ci.createGenerationReader(file);
  assert.strictEqual(reader.get().generation, "g1");

  // Publish the way the builder does: build aside, rename over.
  buildIndex(`${file}.building`, GAME_FILES, { generation: "g2" });
  fs.renameSync(`${file}.building`, file);
  assert.strictEqual(reader.get().generation, "g2");

  // A broken or empty replacement must not displace a working generation.
  fs.writeFileSync(`${file}.building`, "not a database");
  fs.renameSync(`${file}.building`, file);
  const kept = reader.get();
  assert.strictEqual(kept.generation, "g2");
  assert.strictEqual(kept.servedFrom, "current");
  assert.ok(ci.exactLookup(kept, "US_NATIONAL_CONFIG").results[0].found);
});

test("with nothing in hand the reader falls back to .previous, then reports a retryable error", () => {
  const dir = tmpDir();
  const file = path.join(dir, "index.db");
  buildIndex(`${file}.previous`, GAME_FILES, { generation: "old" });
  const reader = ci.createGenerationReader(file);
  const gen = reader.get();
  assert.strictEqual(gen.generation, "old");
  assert.strictEqual(gen.servedFrom, "previous");

  // Once the current file appears it takes over.
  buildIndex(file, GAME_FILES, { generation: "new" });
  assert.strictEqual(reader.get().generation, "new");

  const empty = ci.createGenerationReader(path.join(dir, "absent.db"));
  assert.throws(() => empty.get(), (e) => e instanceof ci.IndexUnavailableError && e.retryable === true && /temporarily unavailable/.test(e.message));
});

test("a write lock during the in-place file-map step is waited out, not reported as missing", () => {
  const dir = tmpDir();
  const file = path.join(dir, "index.db");
  buildIndex(file, GAME_FILES, { generation: "g1" });
  let calls = 0;
  // First open attempt of the changed file fails as SQLITE_BUSY would.
  const reader = ci.createGenerationReader(file, {
    open: (f, o) => {
      calls++;
      if (calls === 2) { const e = new Error("database is locked"); e.code = "SQLITE_BUSY"; throw e; }
      const db = new Database(f, { readonly: true, fileMustExist: true, timeout: o.busyTimeoutMs });
      return db;
    },
  });
  assert.strictEqual(reader.get().generation, "g1");
  // Touch the file so its signature changes (the file map writes in place).
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const during = reader.get();
  assert.strictEqual(during.generation, "g1", "kept serving the open generation");
  assert.strictEqual(reader.get().generation, "g1", "reopened once the lock cleared");
  assert.strictEqual(calls, 3);
});

test("repo argument: game by default, lists and all-internal expand, unknown names list the valid ones", () => {
  assert.deepStrictEqual(ci.resolveRepos(undefined), { repos: ["game"] });
  assert.deepStrictEqual(ci.resolveRepos(""), { repos: ["game"] });
  assert.deepStrictEqual(ci.resolveRepos(["keir", "client"]), { repos: ["keir", "client"] });
  assert.deepStrictEqual(ci.resolveRepos("game,keir"), { repos: ["game", "keir"] });
  assert.deepStrictEqual(ci.resolveRepos("all-internal").repos, Object.keys(ci.INTERNAL_REPOS));
  const bad = ci.resolveRepos("nope");
  assert.match(bad.error, /unknown repo "nope"\. Valid: game, keir, client, discord-bot/);
});

test("internal repositories need an explicit grant", () => {
  assert.strictEqual(ci.canReadInternal(null), false);
  assert.strictEqual(ci.canReadInternal({ name: "ask", scopes: { collections: ["docs"] } }, {}), false);
  assert.strictEqual(ci.canReadInternal({ name: "x", scopes: { collections: [], internalCode: true } }, {}), true);
  assert.strictEqual(ci.canReadInternal({ name: "keir", scopes: { collections: ["docs"] } }, { CODE_INDEX_INTERNAL_READERS: "keir, claude-box" }), true);
  assert.strictEqual(ci.canReadInternal({ name: "keir-public", scopes: { collections: ["docs"] } }, { CODE_INDEX_INTERNAL_READERS: "keir" }), false);
});

test("internal index files live outside the Ask index directory", () => {
  const p = ci.internalIndexPath("keir", {});
  assert.strictEqual(p, "/var/lib/lakeside-code-index/internal/keir.db");
  assert.ok(!p.startsWith("/root/misc/ask-remediation"));
  assert.throws(() => ci.internalIndexPath("game", {}));
});

test("applyBudget keeps rank order, skips what does not fit and counts it", () => {
  const hits = [{ path: "a", text: "x".repeat(50) }, { path: "b", text: "x".repeat(80) }, { path: "c", text: "x".repeat(10) }];
  const out = ci.applyBudget(hits, 70);
  assert.deepStrictEqual(out.files, ["a", "c"]);
  assert.strictEqual(out.droppedForBudget, 1);
});

test("keywordSearch serves keyword matches from a readable index", () => {
  const { gen } = gameGen();
  const out = ci.keywordSearch(gen, "which config holds the national chamber", { topK: 3 });
  assert.ok(out.files.includes("src/lib/countries/us/elections/billLifecycle.ts"));
});
