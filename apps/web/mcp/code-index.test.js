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
const { createCheckoutScanner } = require("./checkout-scan");

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

// The game index plus the checkout it is built from: a git repository holding
// the indexed code files and files the index leaves out (UI strings, a
// script, an image), so exact lookup can scan what the index does not hold.
const UNINDEXED = {
  "messages/en/centralBank.json": '{\n  "rateCooldown": "Another rate change occurred too recently.",\n  "invite": "Invite players with your link"\n}\n',
  "scripts/sim/run.mjs": "export const SIM_ONLY_FLAG = true;\n",
  "scripts/migrations/fix.ts": "const ownSitesFirst = true;\nlog(ownSitesFirst);\nsave(ownSitesFirst);\n",
};
function gameRepo() {
  const { execFileSync } = require("child_process");
  const repo = tmpDir();
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q");
  const files = { ...Object.fromEntries(Object.entries(GAME_FILES).filter(([, v]) => !v.source).map(([k, v]) => [k, v.text])), ...UNINDEXED };
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text); }
  fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  return { repo, revision: git("rev-parse", "HEAD").trim(), git };
}
function gameGenWithRepo() {
  const { repo, revision, git } = gameRepo();
  const file = path.join(tmpDir(), "index.db");
  buildIndex(file, GAME_FILES, { revision });
  const gen = ci.createGenerationReader(file).get();
  const indexed = new Set(Object.keys(GAME_FILES).filter(k => !GAME_FILES[k].source));
  const scanner = createCheckoutScanner({ gitDir: repo, revision, indexed });
  return { gen, scanner, repo, revision, git };
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

test("a symbol is found as a whole identifier, with its definition first and real line numbers", async () => {
  const { gen, scanner } = gameGenWithRepo();
  const out = (await ci.exactLookup(gen, "US_NATIONAL_CONFIG", { scanner }));
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

test("whole-identifier matching ignores longer names and the model-written chunk header", async () => {
  const { gen } = gameGen();
  const r = (await ci.exactLookup(gen, "ownSitesFirst")).results[0];
  assert.strictEqual(r.totalFiles, 1);
  assert.strictEqual(r.totalOccurrences, 2); // the property and the use, not ownSitesFirstPolicy
  assert.strictEqual(r.definitions[0].kind, "property");
  const { gen: g2, scanner } = gameGenWithRepo();
  const header = (await ci.exactLookup(g2, "FakeHeaderSymbol", { scanner })).results[0];
  assert.strictEqual(header.found, false, "header text is not file content");
  assert.strictEqual(header.complete, true);
});

test("a missing literal is a complete not-found, and the FTS prefilter agrees with a full scan", async () => {
  const { gen, scanner } = gameGenWithRepo();
  for (const term of ["capacityUtilizationPct", "US_NATIONAL_CONFIG", "ownSitesFirst", "chamber"]) {
    const fast = (await ci.exactLookup(gen, term)).results[0];
    process.env.RAG_EXACT_SCAN = "1";
    const scan = (await ci.exactLookup(gen, term)).results[0];
    delete process.env.RAG_EXACT_SCAN;
    assert.strictEqual(fast.totalFiles, scan.totalFiles, term);
    assert.strictEqual(fast.totalOccurrences, scan.totalOccurrences, term);
  }
  const none = (await ci.exactLookup(gen, "capacityUtilizationPct", { scanner }));
  assert.strictEqual(none.found, false);
  assert.strictEqual(none.complete, true);
  assert.strictEqual(none.count, 0);
  assert.match(none.results[0].notFoundIn, /every text file of the repository at revision/);
});

test("a short sentence is one phrase, matched case-insensitively when the exact case is absent", async () => {
  const { gen } = gameGen();
  const r = (await ci.exactLookup(gen, "cannot be merged yet")).results[0];
  assert.strictEqual(r.kind, "phrase");
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.caseInsensitive, true);
  assert.strictEqual(r.files[0].path, "src/app/ForSalePanel.tsx");
  assert.strictEqual((await ci.exactLookup(gen, "put marines ashore")).results[0].found, false);
});

test("a listing cut by the limit says so and keeps the exact total", async () => {
  const { gen } = gameGen();
  const r = (await ci.exactLookup(gen, "US_NATIONAL_CONFIG", { limit: 1 })).results[0];
  assert.strictEqual(r.complete, false);
  assert.strictEqual(r.totalFiles, 4);
  assert.strictEqual(r.files.length, 1);
  assert.match(r.truncated, /4 files contain this; 1 are listed/);
});

test("a path returns that file whole; a bare file name resolves or lists the candidates", async () => {
  const { gen } = gameGen();
  const exact = (await ci.exactLookup(gen, "src/lib/turn/billLifecycle/configs/us.ts")).results[0];
  assert.strictEqual(exact.found, true);
  assert.match(exact.content, /^\/\/ Forwarder\./);
  const bare = (await ci.exactLookup(gen, "ForSalePanel.tsx")).results[0];
  assert.strictEqual(bare.files[0].path, "src/app/ForSalePanel.tsx");
  const ambiguous = (await ci.exactLookup(gen, "us.ts")).results[0];
  assert.strictEqual(ambiguous.ambiguous, true);
  assert.strictEqual(ambiguous.totalFiles, 2);
  assert.strictEqual((await ci.exactLookup(gen, "src/nope.ts")).results[0].found, false);
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

test("the reader serves a new generation after a rename swap and keeps the old one when the new is broken", async () => {
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
  assert.ok((await ci.exactLookup(kept, "US_NATIONAL_CONFIG")).results[0].found);
  // m1: serving the replaced generation is reported, not silent.
  assert.match(kept.stale, /could not be opened .*still serving generation g2/);
});

test("m1 opposite: a healthy swap carries no stale note", () => {
  const dir = tmpDir();
  const file = path.join(dir, "index.db");
  buildIndex(file, GAME_FILES, { generation: "g1" });
  const reader = ci.createGenerationReader(file);
  assert.strictEqual(reader.get().stale, undefined);
  buildIndex(`${file}.building`, GAME_FILES, { generation: "g2" });
  fs.renameSync(`${file}.building`, file);
  const next = reader.get();
  assert.strictEqual(next.generation, "g2");
  assert.strictEqual(next.stale, undefined);
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

  const never = ci.createGenerationReader(path.join(dir, "absent.db"));
  assert.throws(() => never.get(), (e) => e instanceof ci.IndexUnavailableError && e.retryable === false && /no index has been built/.test(e.message));

  // A file that exists but cannot be read, with no fallback: retryable.
  fs.writeFileSync(path.join(dir, "broken.db"), "not a database");
  const broken = ci.createGenerationReader(path.join(dir, "broken.db"));
  assert.throws(() => broken.get(), (e) => e instanceof ci.IndexUnavailableError && e.retryable === true && /temporarily unavailable/.test(e.message));
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
  assert.deepStrictEqual(ci.resolveRepos(undefined).repos, ["game"]);
  assert.deepStrictEqual(ci.resolveRepos("").repos, ["game"]);
  assert.deepStrictEqual(ci.resolveRepos(["keir", "client"]).repos, ["keir", "client"]);
  assert.deepStrictEqual(ci.resolveRepos("game,keir").repos, ["game", "keir"]);
  assert.deepStrictEqual([...ci.resolveRepos("keir,all-internal").expanded], ["client", "discord-bot", "ask", "site", "accounts", "index-tools"]);
  assert.deepStrictEqual(ci.resolveRepos("all-internal").repos, Object.keys(ci.INTERNAL_REPOS));
  const bad = ci.resolveRepos("nope");
  assert.match(bad.error, /unknown repo "nope"\. Valid: game, keir, client, discord-bot/);
});

test("M2: the private-code grant is bound to the credential's identity, never its name", () => {
  assert.strictEqual(ci.canReadPrivate(null), false);
  assert.strictEqual(ci.canReadPrivate({ name: "ask", scopes: { collections: ["docs"] } }, {}), false);
  assert.strictEqual(ci.canReadPrivate({ _id: "a1", name: "x", scopes: { collections: [], privateCode: true } }, {}), true);
  assert.strictEqual(ci.canReadPrivate({ _id: "65f0c0ffee", name: "dev-agent", scopes: { collections: ["docs"] } }, { CODE_INDEX_PRIVATE_READER_IDS: "65f0c0ffee, 65f0beef" }), true);
  // An ObjectId-like _id compares by its string form.
  assert.strictEqual(ci.canReadPrivate({ _id: { toString: () => "65f0beef" }, scopes: { collections: [] } }, { CODE_INDEX_PRIVATE_READER_IDS: "65f0beef" }), true);
});

test("M2 opposite: a token name, the old scope flag or an unlisted id grants nothing", () => {
  // A name anyone can give a token, even one that matches a listed id.
  assert.strictEqual(ci.canReadPrivate({ _id: "other", name: "65f0c0ffee", scopes: { collections: ["docs"] } }, { CODE_INDEX_PRIVATE_READER_IDS: "65f0c0ffee" }), false);
  assert.strictEqual(ci.canReadPrivate({ _id: "k1", name: "keir", scopes: { collections: ["docs"] } }, { CODE_INDEX_INTERNAL_READERS: "keir" }), false);
  assert.strictEqual(ci.canReadPrivate({ _id: "k1", name: "keir", scopes: { collections: ["docs"], internalCode: true } }, {}), false);
  assert.strictEqual(ci.canReadPrivate({ _id: "k1", scopes: { collections: ["docs"], privateCode: "true" } }, {}), false, "only the boolean true");
});

test("B3: a repository is public only when configured public and its index says GitHub agrees", () => {
  assert.strictEqual(ci.repoTier("game"), "public");
  assert.strictEqual(ci.repoTier("keir", { meta: { repo_visibility: "public" } }), "public");
  assert.strictEqual(ci.repoTier("keir", { meta: { repo_visibility: "private" } }), "private", "turned private on GitHub");
  assert.strictEqual(ci.repoTier("keir", { meta: {} }), "private", "no stamp: unknown is private");
  assert.strictEqual(ci.repoTier("accounts", { meta: { repo_visibility: "public" } }), "private", "configured private stays private");
  for (const name of ["ask", "site", "accounts", "index-tools"]) assert.strictEqual(ci.INTERNAL_REPOS[name].visibility, "private", name);
  for (const name of ["keir", "client", "discord-bot"]) assert.strictEqual(ci.INTERNAL_REPOS[name].visibility, "public", name);
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

// B1: on-screen text is quoted as one line, but Prettier wraps it, people
// type two spaces, and the chunker can split it between two chunks.
const WRAPPED_FILES = {
  "src/app/about/page.tsx": { text: "<p>\n  Every character starts with a party affiliation,\n  home state and a starting fund.\n</p>\n" },
  "src/components/GranularPollPanel.tsx": { text: "line one\n<p>The share below splits\nbetween you and\nend\n", parts: 2 },
  "src/components/Legend.tsx": { text: "<span>Ranks candidates by{\" \"}\n  these same factors.</span>\n" },
  "src/components/Scrambled.tsx": { text: "// home affiliation party a with\n" },
};

test("B1: a phrase wrapped across lines, split between chunks or re-spaced is found", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "index.db");
  buildIndex(file, WRAPPED_FILES);
  const gen = ci.createGenerationReader(file).get();
  const cases = {
    "with a party affiliation, home": ["src/app/about/page.tsx", 2],
    "below splits between you and": ["src/components/GranularPollPanel.tsx", 2],
    "candidates by these same factors.": ["src/components/Legend.tsx", 1],
    '"party  affiliation"': ["src/app/about/page.tsx", 2],
  };
  for (const [q, want] of Object.entries(cases)) {
    const r = (await ci.exactLookup(gen, q)).results[0];
    if (!want) continue;
    assert.strictEqual(r.found, true, q);
    assert.strictEqual(r.files[0].path, want[0], q);
    assert.strictEqual(r.files[0].lines[0].line, want[1], `${q}: reported at the line it starts on`);
  }
  // The chunk split really is between "splits" and "between".
  const parts = gen.db.prepare("SELECT text FROM chunks WHERE path='src/components/GranularPollPanel.tsx' ORDER BY ord").all().map(r => ci.chunkBody(r.text));
  assert.deepStrictEqual(parts, ["line one\n<p>The share below splits\n", "between you and\nend\n"]);
  // A phrase that starts or ends mid-word is still found.
  assert.strictEqual((await ci.exactLookup(gen, '"arty affiliation, ho"')).results[0].found, true);
});

test("B1 opposite: the same words in another order or apart are not a match", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "index.db");
  buildIndex(file, WRAPPED_FILES);
  const gen = ci.createGenerationReader(file).get();
  const r = (await ci.exactLookup(gen, "with a party home affiliation")).results[0];
  assert.strictEqual(r.found, false);
  const s = (await ci.exactLookup(gen, "you between splits")).results[0];
  assert.strictEqual(s.found, false);
  // Words in the model-written header never count.
  assert.strictEqual((await ci.exactLookup(gen, "summary mentions FakeHeaderSymbol")).results[0].found, false);
});

test("M1: a single word in the wrong case is found ignoring case, and says so", async () => {
  const { gen } = gameGen();
  const r = (await ci.exactLookup(gen, "us_national_config")).results[0];
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.matchedCase, "case-insensitive");
  assert.strictEqual(r.files[0].path, "src/lib/countries/us/elections/billLifecycle.ts");
  assert.strictEqual(r.definitions[0].line, 3);
  assert.match((await ci.exactLookup(gen, "us_national_config")).context, /no exact-case match, matched ignoring case/);
});

test("M1 opposite: an exact-case match is preferred and other-case names are not mixed in", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "index.db");
  buildIndex(file, {
    "src/a.ts": { text: "export const Ordnance = 1;\n" },
    "src/b.ts": { text: "const ordnance = 'shells';\n" },
  });
  const gen = ci.createGenerationReader(file).get();
  const upper = (await ci.exactLookup(gen, "Ordnance")).results[0];
  assert.strictEqual(upper.matchedCase, "exact");
  assert.deepStrictEqual(upper.files.map(f => f.path), ["src/a.ts"]);
  const lower = (await ci.exactLookup(gen, "ordnance")).results[0];
  assert.deepStrictEqual(lower.files.map(f => f.path), ["src/b.ts"]);
  // Whole identifiers only, in either case: ordnanceDepot is not ordnance.
  buildIndex(file, { "src/c.ts": { text: "const ordnanceDepot = 2;\n" } });
  const gen2 = ci.createGenerationReader(file).get();
  assert.strictEqual((await ci.exactLookup(gen2, "ORDNANCE")).results[0].found, false);
});

test("B2: text in files the index leaves out is found by a scan of the indexed revision", async () => {
  const { gen, scanner, revision, git, repo } = gameGenWithRepo();
  // The working tree moves on after the index was built: the scan must read
  // the indexed commit, not the working tree.
  fs.writeFileSync(path.join(repo, "messages/en/centralBank.json"), "{}\n");
  git("commit", "-q", "-am", "later");
  const out = await ci.exactLookup(gen, "Another rate change occurred too recently", { scanner });
  const r = out.results[0];
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.foundBy, "repository scan");
  assert.deepStrictEqual(r.files.map(f => [f.path, f.inIndex, f.lines[0].line]), [["messages/en/centralBank.json", false, 2]]);
  assert.strictEqual(out.scope.revision, revision);
  assert.match(out.scope.searched, /indexed files, and a literal scan of the \d+ other text files/);
  assert.match(out.scope.notSearched, /binary and media files \(1\)/);
  const sym = (await ci.exactLookup(gen, "SIM_ONLY_FLAG", { scanner })).results[0];
  assert.strictEqual(sym.files[0].path, "scripts/sim/run.mjs");
  const p = (await ci.exactLookup(gen, "messages/en/centralBank.json", { scanner })).results[0];
  assert.strictEqual(p.found, true);
  assert.match(p.content, /Invite players with your link/);
  assert.match(p.note, /not in the index/);
  const gone = (await ci.exactLookup(gen, "messages/en/nope.json", { scanner })).results[0];
  assert.strictEqual(gone.found, false);
  assert.strictEqual(gone.complete, true);
});

test("B2 opposite: without a usable scan a miss is never complete, and says what was not searched", async () => {
  const { gen } = gameGen();
  const out = await ci.exactLookup(gen, "Another rate change occurred too recently");
  const r = out.results[0];
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.complete, false);
  assert.strictEqual(out.complete, false);
  assert.match(r.incomplete, /messages\/ with the UI strings/);
  assert.match(r.hint, /on-screen text/);
  assert.match(out.context, /NOT a complete search/);
  assert.strictEqual((await ci.exactLookup(gen, "messages/en/centralBank.json")).results[0].complete, false);
  // A checkout that does not hold the indexed revision is not trusted.
  const { repo } = gameRepo();
  const stale = createCheckoutScanner({ gitDir: repo, revision: "0".repeat(40), indexed: new Set() });
  const s = await ci.exactLookup(gen, "Another rate change occurred too recently", { scanner: stale });
  assert.strictEqual(s.results[0].complete, false);
  assert.match(s.results[0].incomplete, /does not hold the indexed revision/);
  // A listing cut to fit maxChars is truncated, never complete.
  const g = gameGenWithRepo();
  const cut = await ci.exactLookup(g.gen, "US_NATIONAL_CONFIG", { scanner: g.scanner, maxChars: 60 });
  assert.strictEqual(cut.complete, false);
  assert.match(cut.truncated, /cut to fit maxChars/);
});

test("m3: exact lookup stops at its time budget and says the result is truncated", async () => {
  const { gen } = gameGen();
  const r = (await ci.exactLookup(gen, "US_NATIONAL_CONFIG", { timeBudgetMs: -1 })).results[0];
  assert.strictEqual(r.complete, false);
  assert.match(r.truncated, /time limit/);
});

test("B2: a definition in a file the index leaves out ranks after indexed definitions", async () => {
  const { gen, scanner } = gameGenWithRepo();
  const r = (await ci.exactLookup(gen, "ownSitesFirst", { scanner })).results[0];
  assert.deepStrictEqual(r.files.map(f => [f.path, f.inIndex]), [["src/lib/market/rules.ts", undefined], ["scripts/migrations/fix.ts", false]]);
  assert.strictEqual(r.foundBy, "index and repository scan");
  assert.strictEqual(r.complete, true);
});
