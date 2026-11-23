"use strict";

// The code tools as an agent sees them: defaults unchanged for the game,
// internal repositories gated, honest budget and degraded-mode reporting.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const ci = require("./code-index");
const { registerCodeTools } = require("./code-tools");

function index(file, files, { revision = "rev1", visibility, repoVisibility, vectors = null } = {}) {
  const db = new Database(file);
  db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, source_kind TEXT NOT NULL, repository TEXT NOT NULL, revision TEXT NOT NULL,
      path TEXT NOT NULL, ord INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL, dims INTEGER NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE source_revisions(kind TEXT PRIMARY KEY, repository TEXT NOT NULL, revision TEXT NOT NULL, indexed_at TEXT NOT NULL, files INTEGER NOT NULL, chunks INTEGER NOT NULL);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const ins = db.prepare("INSERT INTO chunks(source_kind,repository,revision,path,ord,hash,text,vec,dims,indexed_at) VALUES ('code','r',?,?,0,'h',?,?,?,'now')");
  for (const [p, text] of Object.entries(files)) {
    const v = vectors && vectors[p];
    ins.run(revision, p, `[code] ${p} (part 1/1): x\n${text}`, v ? Buffer.from(Float32Array.from(v).buffer) : Buffer.from([0]), v ? v.length : 1);
  }
  db.prepare("INSERT INTO source_revisions VALUES ('code','r',?,'now',1,1)").run(revision);
  db.prepare("INSERT INTO meta VALUES ('generation','g')").run();
  if (visibility) db.prepare("INSERT INTO meta VALUES ('visibility',?)").run(visibility);
  if (repoVisibility) db.prepare("INSERT INTO meta VALUES ('repo_visibility',?)").run(repoVisibility);
  db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, source_kind UNINDEXED, path UNINDEXED, content='chunks', content_rowid='id', tokenize='unicode61');
    INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);
  db.close();
}

function setup({ grant = false, retrieve, checkout = "off", gameRevision = "gamerev", keirStamp = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-tools-test-"));
  const game = path.join(dir, "index-dev.db");
  index(game, { "src/lib/rules.ts": "export const GAME_RULE = 1; // national chamber rule\n" }, { revision: gameRevision });
  const internal = path.join(dir, "internal");
  fs.mkdirSync(internal);
  index(path.join(internal, "keir.db"), { "apps/agent/lib/brief.js": "const OPENER_TEXT = 'Thanks for the report';\n" }, { revision: "keirrev", visibility: "internal", repoVisibility: keirStamp });
  index(path.join(internal, "accounts.db"), { "lakeside-auth/src/login.ts": "export const LOGIN_SECRET_RULE = 'x';\n" }, { revision: "accrev", visibility: "internal", repoVisibility: "private" });
  const handlers = {};
  const server = { tool: (name, _desc, _schema, fn) => { handlers[name] = fn; } };
  // The grant is by token id; the ungranted token even carries a name that
  // the old name-based list would have matched.
  const auth = grant ? { _id: "tok-dev-1", name: "dev-agent", scopes: { collections: ["docs"] } } : { _id: "tok-keir-1", name: "keir", scopes: { collections: ["docs"] } };
  const env = { CODE_INDEX_INTERNAL_DIR: internal, CODE_INDEX_PRIVATE_READER_IDS: "tok-dev-1", CODE_INDEX_INTERNAL_READERS: "keir", CODE_INDEX_GAME_CHECKOUT_DEV: checkout };
  const calls = [];
  registerCodeTools(server, {
    auth, env,
    tokens: { canRead: (a, k) => a.scopes.collections.includes(k) },
    jsonResult: (o) => ({ json: o }),
    errorResult: (m) => ({ error: m }),
    askRetrieve: () => retrieve || {
      async search(q, opts) {
        calls.push(opts);
        const repo = opts.game && opts.game.ragDb && opts.game.ragDb.includes("keir") ? "keir" : "game";
        return {
          claimType: "general",
          hits: repo === "keir"
            ? [{ path: "apps/agent/lib/brief.js", ord: 0, source: "code", revision: "keirrev", score: 0.9, text: "k".repeat(100) }]
            : [
              { path: "src/lib/rules.ts", ord: 0, source: "code", revision: "gamerev", score: 0.8, text: "a".repeat(3000) },
              { path: "src/lib/big.ts", ord: 0, source: "code", revision: "gamerev", score: 0.7, text: "b".repeat(5000) },
              { path: "src/lib/small.ts", ord: 0, source: "code", revision: "gamerev", score: 0.6, text: "c".repeat(100) },
            ],
        };
      },
    },
    devFallback: () => ({ game: { id: "ahd-dev", ragDb: game }, source: "dev", fallback: false }),
    gameIndexPath: () => game,
    pool: ci.createReaderPool(),
  });
  return { handlers, calls };
}

test("existing callers: no repo means the game, same fields as before", async () => {
  const { handlers, calls } = setup();
  const out = (await handlers.code_search({ question: "chamber", topK: 8, maxChars: 30000, source: "dev" })).json;
  assert.strictEqual(out.repo, "game");
  assert.strictEqual(out.index, "dev");
  assert.strictEqual(out.revision, "gamerev");
  assert.deepStrictEqual(out.files, ["src/lib/rules.ts", "src/lib/big.ts", "src/lib/small.ts"]);
  assert.strictEqual(out.hits[0].repo, "game");
  assert.strictEqual(calls[0].maxChars, 120000, "the budget is applied here so the cut can be reported");
  const exact = (await handlers.code_exact({ question: "GAME_RULE", limit: 8, maxChars: 18000, source: "dev" })).json;
  assert.strictEqual(exact.found, true);
  assert.deepStrictEqual(exact.files, ["src/lib/rules.ts"]);
  assert.match(exact.context, /GAME_RULE/);
  const read = (await handlers.code_read({ path: "src/lib/rules.ts", maxChars: 40000, source: "dev" })).json;
  assert.strictEqual(read.path, "src/lib/rules.ts");
  assert.strictEqual(read.revision, "gamerev");
});

test("code_search reports results cut by the character budget", async () => {
  const { handlers } = setup();
  const out = (await handlers.code_search({ question: "q", topK: 8, maxChars: 4000, source: "dev" })).json;
  assert.deepStrictEqual(out.files, ["src/lib/rules.ts", "src/lib/small.ts"]);
  assert.strictEqual(out.droppedForBudget, 1);
  assert.match(out.budgetNote, /raise maxChars/);
});

test("when semantic retrieval fails the tool serves keyword matches and says it is degraded", async () => {
  const { handlers } = setup({ retrieve: { search: async () => null, searchMulti: async () => null } });
  const out = (await handlers.code_search({ question: "national chamber rule", topK: 8, maxChars: 30000, source: "dev" })).json;
  assert.match(out.degraded, /keyword matches only/);
  assert.strictEqual(out.retryable, true);
  assert.deepStrictEqual(out.files, ["src/lib/rules.ts"]);
});

test("internal repositories are refused without the grant and listed on an unknown name", async () => {
  const { handlers } = setup({ grant: false });
  const denied = await handlers.code_search({ question: "opener", repo: "keir", topK: 8, maxChars: 30000 });
  assert.match(denied.error, /keir: private studio code; this credential has no private-code grant/);
  const deniedExact = await handlers.code_exact({ question: "OPENER_TEXT", repo: "all-internal", limit: 8, maxChars: 18000 });
  assert.match(deniedExact.error, /private studio code/);
  const unknown = await handlers.code_exact({ question: "x1", repo: "website", limit: 8, maxChars: 18000 });
  assert.match(unknown.error, /unknown repo "website"\. Valid: game, keir/);
});

test("with the grant an internal repo is searchable and every result names its repo and revision", async () => {
  const { handlers } = setup({ grant: true });
  const exact = (await handlers.code_exact({ question: "OPENER_TEXT", repo: "keir", limit: 8, maxChars: 18000 })).json;
  assert.strictEqual(exact.repo, "keir");
  assert.strictEqual(exact.revision, "keirrev");
  assert.deepStrictEqual(exact.files, ["apps/agent/lib/brief.js"]);
  const both = (await handlers.code_search({ question: "opener text", repo: ["game", "keir"], topK: 2, maxChars: 30000 })).json;
  assert.deepStrictEqual(both.hits.map((h) => h.repo), ["game", "keir"], "one from each repository in turn, not by incomparable scores");
  assert.deepStrictEqual(both.repos.map((r) => [r.repo, r.revision]), [["game", "gamerev"], ["keir", "keirrev"]]);
  const notBuilt = (await handlers.code_exact({ question: "OPENER_TEXT", repo: ["keir", "client"], limit: 8, maxChars: 18000 })).json;
  assert.strictEqual(notBuilt.unavailable[0].repo, "client");
  assert.strictEqual(notBuilt.unavailable[0].retryable, false);
  const only = await handlers.code_search({ question: "q", repo: "client", topK: 2, maxChars: 30000 });
  assert.match(only.error, /code index not available: client: no index has been built/);
  assert.strictEqual(notBuilt.complete, false, "a repo that could not be read makes the answer incomplete");
});

// A checkout holding the indexed game file and UI strings the index leaves out.
function checkoutRepo() {
  const { execFileSync } = require("child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "code-tools-repo-"));
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q");
  fs.mkdirSync(path.join(repo, "src/lib"), { recursive: true });
  fs.mkdirSync(path.join(repo, "messages/en"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/lib/rules.ts"), "export const GAME_RULE = 1; // national chamber rule\n");
  fs.writeFileSync(path.join(repo, "messages/en/bank.json"), '{ "cooldown": "Another rate change occurred too recently." }\n');
  git("add", "-A");
  git("commit", "-q", "-m", "x");
  return { repo, revision: git("rev-parse", "HEAD").trim() };
}

test("B2: code_exact and code_read reach game files the index leaves out, at the indexed revision", async () => {
  const { repo, revision } = checkoutRepo();
  const { handlers } = setup({ checkout: repo, gameRevision: revision });
  const exact = (await handlers.code_exact({ question: "Another rate change occurred too recently", limit: 8, maxChars: 18000, source: "dev" })).json;
  assert.strictEqual(exact.found, true);
  assert.strictEqual(exact.complete, true);
  assert.deepStrictEqual(exact.files, ["messages/en/bank.json"]);
  assert.strictEqual(exact.results[0].foundBy, "repository scan");
  assert.strictEqual(exact.scope.revision, revision);
  const read = (await handlers.code_read({ path: "messages/en/bank.json", maxChars: 40000, source: "dev" })).json;
  assert.strictEqual(read.inIndex, false);
  assert.match(read.content, /rate change/);
  const missing = await handlers.code_read({ path: "messages/en/none.json", maxChars: 40000, source: "dev" });
  assert.match(missing.error, /no file messages\/en\/none\.json in the dev game repository at revision/);
});

test("B2 opposite: with no checkout the tools say only the indexed files were searched", async () => {
  const { handlers } = setup({ checkout: "off" });
  const exact = (await handlers.code_exact({ question: "Another rate change occurred too recently", limit: 8, maxChars: 18000, source: "dev" })).json;
  assert.strictEqual(exact.found, false);
  assert.strictEqual(exact.complete, false);
  assert.match(exact.scope.searched, /indexed files only/);
  assert.match(exact.results[0].hint, /messages\/<locale>/);
  const read = await handlers.code_read({ path: "messages/en/bank.json", maxChars: 40000, source: "dev" });
  assert.match(read.error, /files the index leaves out were not searched/);
});

test("B3: public repositories are open to any trusted caller and labelled public", async () => {
  const { handlers } = setup({ grant: false, keirStamp: "public" });
  const exact = (await handlers.code_exact({ question: "OPENER_TEXT", repo: "keir", limit: 8, maxChars: 18000 })).json;
  assert.strictEqual(exact.visibility, "public");
  assert.deepStrictEqual(exact.files, ["apps/agent/lib/brief.js"]);
  assert.strictEqual(exact.privateNotice, undefined);
  const search = (await handlers.code_search({ question: "opener", repo: "keir", topK: 2, maxChars: 30000 })).json;
  assert.strictEqual(search.hits[0].visibility, "public");
  // "all-internal" searches what this credential may read and lists the rest.
  const all = (await handlers.code_exact({ question: "OPENER_TEXT", repo: "all-internal", limit: 8, maxChars: 18000 })).json;
  assert.deepStrictEqual(all.repos.map(r => r.repo), ["keir", "client", "discord-bot"].filter(r => r === "keir"));
  assert.match(all.notSearched, /ask, site, accounts, index-tools \(private/);
  assert.strictEqual(all.complete, false);
});

test("B3 opposite: private code is refused without the grant, and labelled private with it", async () => {
  const denied = setup({ grant: false, keirStamp: "public" });
  const r1 = await denied.handlers.code_read({ path: "lakeside-auth/src/login.ts", repo: "accounts", maxChars: 40000 });
  assert.match(r1.error, /accounts: private studio code/);
  // Configured public, but the index says the repository is private now.
  const turned = setup({ grant: false, keirStamp: "private" });
  const r2 = await turned.handlers.code_exact({ question: "OPENER_TEXT", repo: "keir", limit: 8, maxChars: 18000 });
  assert.match(r2.error, /keir: private studio code/);
  const granted = setup({ grant: true });
  const r3 = (await granted.handlers.code_exact({ question: "LOGIN_SECRET_RULE", repo: "accounts", limit: 8, maxChars: 18000 })).json;
  assert.strictEqual(r3.visibility, "private");
  assert.match(r3.privateNotice, /Never quote, paraphrase or describe them to players/);
  const r4 = (await granted.handlers.code_read({ path: "lakeside-auth/src/login.ts", repo: "accounts", maxChars: 40000 })).json;
  assert.match(r4.privateNotice, /players/);
});

// M4: several internal repositories, one query embedding, bounded waits.
function m4Setup({ embedQuery, search }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-tools-m4-"));
  const internal = path.join(dir, "internal");
  fs.mkdirSync(internal);
  const game = path.join(dir, "index-dev.db");
  index(game, { "src/lib/rules.ts": "export const GAME_RULE = 1; // voice rule\n" });
  index(path.join(internal, "keir.db"), { "apps/ios/Voice.swift": "func speak() { deviceVoiceFallback() }\n", "apps/web/x.js": "const unrelated = 1;\n" },
    { visibility: "internal", repoVisibility: "public", vectors: { "apps/ios/Voice.swift": [1, 0], "apps/web/x.js": [0, 1] } });
  index(path.join(internal, "client.db"), { "src/voice.ts": "export function voiceSettings() {}\n", "src/other.ts": "export const other = 2;\n" },
    { visibility: "internal", repoVisibility: "public", vectors: { "src/voice.ts": [0.9, 0.1], "src/other.ts": [0, 1] } });
  const handlers = {};
  registerCodeTools({ tool: (name, _d, _s, fn) => { handlers[name] = fn; } }, {
    auth: { _id: "t", scopes: { collections: ["docs"] } },
    env: { CODE_INDEX_INTERNAL_DIR: internal, CODE_INDEX_GAME_CHECKOUT_DEV: "off", CODE_SEARCH_EMBED_DEADLINE_MS: "150", CODE_SEARCH_DEADLINE_MS: "150" },
    tokens: { canRead: (a, k) => a.scopes.collections.includes(k) },
    jsonResult: (o) => ({ json: o }), errorResult: (m) => ({ error: m }),
    askRetrieve: () => ({ embedQuery, search: search || (async () => null), searchMulti: async () => null }),
    devFallback: () => ({ game: { id: "ahd-dev", ragDb: game }, source: "dev", fallback: false }),
    gameIndexPath: () => game, pool: ci.createReaderPool(),
  });
  return handlers;
}

test("M4: a search over several repositories embeds the question once", async () => {
  let calls = 0;
  const handlers = m4Setup({ embedQuery: async () => { calls++; return [1, 0]; } });
  const out = (await handlers.code_search({ question: "why does the voice fall back", repo: ["keir", "client"], topK: 2, maxChars: 30000 })).json;
  assert.strictEqual(calls, 1);
  assert.strictEqual(out.degraded, undefined);
  assert.deepStrictEqual(out.hits.map((h) => [h.repo, h.path]), [["keir", "apps/ios/Voice.swift"], ["client", "src/voice.ts"]]);
});

test("M4 opposite: a slow embedder or a slow game search falls back to keyword matches within the deadline", async () => {
  const never = () => new Promise(() => {});
  const handlers = m4Setup({ embedQuery: never, search: never });
  const t0 = Date.now();
  const out = (await handlers.code_search({ question: "voice settings", repo: ["game", "keir", "client"], topK: 6, maxChars: 30000 })).json;
  assert.ok(Date.now() - t0 < 1500, `answered in ${Date.now() - t0} ms`);
  assert.match(out.degraded, /keyword matches only/);
  assert.strictEqual(out.retryable, true);
  assert.ok(out.files.includes("src/voice.ts"));
  assert.ok(out.files.includes("src/lib/rules.ts"));
  // A failing embedder (rejection) is the same: keyword matches, not an error.
  const failing = m4Setup({ embedQuery: async () => { throw new Error("embed 402"); } });
  const f = (await failing.code_search({ question: "voice settings", repo: "client", topK: 2, maxChars: 30000 })).json;
  assert.match(f.degraded, /keyword/);
});
