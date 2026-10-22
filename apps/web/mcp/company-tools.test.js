"use strict";

// Needs a disposable Mongo: TRACKER_TEST_MONGODB_URI. Skipped without one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient } = require("mongodb");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createCompanyStore, registerCompanyTools, importCompanyExport } = require("./company-tools");

const URI = process.env.TRACKER_TEST_MONGODB_URI;
const call = (server, name, args) => server._registeredTools[name].handler(args, {});
const parse = (r) => JSON.parse(r.content[0].text);

test("company knowledge keeps the SQLite store's behaviour", { skip: !URI }, async () => {
  const client = await MongoClient.connect(URI);
  const db = client.db(`company_test_${process.pid}`);
  try {
    let t = 0;
    const store = createCompanyStore(db, () => `2026-10-22T00:00:0${t++}.000Z`);
    await store.ensureIndexes();
    const imported = await importCompanyExport(db, {
      company_knowledge: [{ id: 4, slug: "cold-war", kind: "research", title: "Cold War", summary: "s", body: "b", tags: "[\"war\"]", version: 2,
        created_at: "2026-09-01", created_by: "a", updated_at: "2026-09-02", updated_by: "a", archived_at: null }],
      company_knowledge_versions: [{ id: 1, knowledge_id: 4, version: 1, title: "Cold", summary: null, body: "old", tags: "[]", saved_at: "2026-09-01", saved_by: "a" }],
    });
    assert.deepEqual(imported, { inserted: 1, versionRows: 1 });
    assert.deepEqual(await importCompanyExport(db, { company_knowledge: [{ id: 4 }], company_knowledge_versions: [] }), { inserted: 0, versionRows: 0 }, "idempotent");

    const writer = new McpServer({ name: "w", version: "1" });
    registerCompanyTools(writer, { auth: { scopes: { write: true } }, store });
    const reader = new McpServer({ name: "r", version: "1" });
    registerCompanyTools(reader, { auth: { scopes: {} }, store });

    const got = parse(await call(reader, "company_get", { slug: "Cold War" }));
    assert.deepEqual(Object.keys(got), ["id", "slug", "kind", "title", "summary", "body", "tags", "version", "created_at", "created_by", "updated_at", "updated_by", "archived_at"]);
    assert.deepEqual(got.tags, ["war"]);
    assert.equal((await call(reader, "company_save", { slug: "x", kind: "company", title: "X", body: "y", actor: "a" })).isError, true, "a read token cannot write");
    const saved = parse(await call(writer, "company_save", { slug: "cold-war", kind: "research", title: "Cold War II", body: "new", actor: "me", expectedVersion: 2 }));
    assert.equal(saved.version, 3);
    const conflict = await call(writer, "company_save", { slug: "cold-war", kind: "research", title: "T", body: "b", actor: "me", expectedVersion: 2 });
    assert.match(conflict.content[0].text, /version conflict for cold-war; current version is 3/);
    const history = parse(await call(reader, "company_history", { slug: "cold-war" }));
    assert.deepEqual(history.versions.map((v) => v.version), [1, 2, 3]);
    const created = parse(await call(writer, "company_save", { slug: "Brand New", kind: "strategy", title: "Brand", body: "z", tags: ["A B", "a-b"], actor: "me" }));
    assert.equal(created.id, 5);
    assert.deepEqual(created.tags, ["a-b"]);
    const found = parse(await call(reader, "company_search", { text: "cold", limit: 12 }));
    assert.equal(found[0].slug, "cold-war");
    assert.equal(parse(await call(reader, "company_context", {})).stats.total, 2);
    assert.deepEqual(parse(await call(writer, "company_archive", { slug: "brand-new", actor: "me" })), { ok: true });
    assert.equal((await call(reader, "company_get", { slug: "brand-new" })).isError, true);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
