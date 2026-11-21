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

function index(file, files, { revision = "rev1", visibility } = {}) {
  const db = new Database(file);
  db.exec(`CREATE TABLE chunks(id INTEGER PRIMARY KEY, source_kind TEXT NOT NULL, repository TEXT NOT NULL, revision TEXT NOT NULL,
      path TEXT NOT NULL, ord INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, vec BLOB NOT NULL, dims INTEGER NOT NULL, indexed_at TEXT NOT NULL);
    CREATE TABLE source_revisions(kind TEXT PRIMARY KEY, repository TEXT NOT NULL, revision TEXT NOT NULL, indexed_at TEXT NOT NULL, files INTEGER NOT NULL, chunks INTEGER NOT NULL);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const ins = db.prepare("INSERT INTO chunks(source_kind,repository,revision,path,ord,hash,text,vec,dims,indexed_at) VALUES ('code','r',?,?,0,'h',?,x'00',1,'now')");
  for (const [p, text] of Object.entries(files)) ins.run(revision, p, `[code] ${p} (part 1/1): x\n${text}`);
  db.prepare("INSERT INTO source_revisions VALUES ('code','r',?,'now',1,1)").run(revision);
  db.prepare("INSERT INTO meta VALUES ('generation','g')").run();
  if (visibility) db.prepare("INSERT INTO meta VALUES ('visibility',?)").run(visibility);
  db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(text, source_kind UNINDEXED, path UNINDEXED, content='chunks', content_rowid='id', tokenize='unicode61');
    INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);
  db.close();
}

function setup({ grant = false, retrieve } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-tools-test-"));
  const game = path.join(dir, "index-dev.db");
  index(game, { "src/lib/rules.ts": "export const GAME_RULE = 1; // national chamber rule\n" }, { revision: "gamerev" });
  const internal = path.join(dir, "internal");
  fs.mkdirSync(internal);
  index(path.join(internal, "keir.db"), { "apps/agent/lib/brief.js": "const OPENER_TEXT = 'Thanks for the report';\n" }, { revision: "keirrev", visibility: "internal" });
  const handlers = {};
  const server = { tool: (name, _desc, _schema, fn) => { handlers[name] = fn; } };
  const auth = { name: grant ? "keir" : "someone", scopes: { collections: ["docs"] } };
  const env = { CODE_INDEX_INTERNAL_DIR: internal, CODE_INDEX_INTERNAL_READERS: "keir" };
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
  assert.match(denied.error, /may not read internal repositories \(keir\)/);
  const deniedExact = await handlers.code_exact({ question: "OPENER_TEXT", repo: "all-internal", limit: 8, maxChars: 18000 });
  assert.match(deniedExact.error, /may not read internal/);
  const unknown = await handlers.code_exact({ question: "x1", repo: "website", limit: 8, maxChars: 18000 });
  assert.match(unknown.error, /unknown repo "website"\. Valid: game, keir/);
});

test("with the grant an internal repo is searchable and every result names its repo and revision", async () => {
  const { handlers } = setup({ grant: true });
  const exact = (await handlers.code_exact({ question: "OPENER_TEXT", repo: "keir", limit: 8, maxChars: 18000 })).json;
  assert.strictEqual(exact.repo, "keir");
  assert.strictEqual(exact.revision, "keirrev");
  assert.deepStrictEqual(exact.files, ["apps/agent/lib/brief.js"]);
  const both = (await handlers.code_search({ question: "q", repo: ["game", "keir"], topK: 2, maxChars: 30000 })).json;
  assert.deepStrictEqual(both.hits.map((h) => h.repo), ["keir", "game"]);
  assert.deepStrictEqual(both.repos.map((r) => [r.repo, r.revision]), [["game", "gamerev"], ["keir", "keirrev"]]);
  const notBuilt = (await handlers.code_exact({ question: "OPENER_TEXT", repo: ["keir", "client"], limit: 8, maxChars: 18000 })).json;
  assert.strictEqual(notBuilt.unavailable[0].repo, "client");
  assert.strictEqual(notBuilt.complete, false, "a repo that could not be read makes the answer incomplete");
});
