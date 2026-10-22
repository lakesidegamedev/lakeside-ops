"use strict";

// Needs a disposable Mongo: TRACKER_TEST_MONGODB_URI. Skipped without one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient, Long, Double, Int32 } = require("mongodb");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createTrackerStore, registerTrackerTools, itemJson, slug } = require("./tracker-tools");

const URI = process.env.TRACKER_TEST_MONGODB_URI;

test("slugs match the Rust tracker's", () => {
  assert.equal(slug("a-house-divided", "Verify Google sign-in works"), "a-house-divided/verify-google-sign-in-works");
  assert.equal(slug(null, "Bretton Woods / Gold Standard / de-colonization"), "bretton-woods-gold-standard-de-colonization");
  assert.equal(slug(null, "  spaced  out  "), "spaced-out");
});

test("an item reads the way the Rust reader reads it", () => {
  const item = itemJson({ id: "x", kind: "wat", status: "prod", title: "t", order: new Double(5), created_at: new Double(1789918604541), updated_at: Long.fromNumber(2), tags: [] });
  assert.equal(item.kind, "task");
  assert.equal(item.status, "done_prod", "status aliases parse");
  assert.equal(item.order, 0, "a double order is not read");
  assert.equal(item.created_at, 1789918604541, "a whole double timestamp is read");
  assert.equal("tags" in item, false, "empty tags are omitted");
  assert.equal(itemJson({ order: new Int32(3), id: "y" }).order, 3);
  assert.equal(itemJson({ title: "no id" }), null);
});

function call(server, name, args) {
  return server._registeredTools[name].handler(args, {});
}
const parse = (r) => JSON.parse(r.content[0].text);

test("upsert, note, get, list and summary against Mongo", { skip: !URI }, async () => {
  const client = await MongoClient.connect(URI);
  const db = client.db(`tracker_test_${process.pid}`);
  try {
    const store = createTrackerStore(db);
    let clock = 3_000_000_000_000;
    const server = new McpServer({ name: "t", version: "1" });
    registerTrackerTools(server, { auth: { scopes: { write: true } }, store, now: () => ++clock });
    const reader = new McpServer({ name: "r", version: "1" });
    registerTrackerTools(reader, { auth: { scopes: {} }, store });

    assert.equal((await call(reader, "track_upsert", { title: "nope" })).isError, true, "a read token cannot write");
    assert.equal((await call(server, "track_upsert", { status: "open" })).isError, true);
    const created = parse(await call(server, "track_upsert", { title: "Reset board", project: "ahd", kind: "project", body: "b" }));
    assert.equal(created.item.id, "ahd/reset-board");
    // An update writes only what it is given.
    const flipped = parse(await call(server, "track_upsert", { id: "ahd/reset-board", status: "blocked", blocked_by: "#1" }));
    assert.equal(flipped.item.body, "b");
    assert.equal(flipped.item.kind, "project", "kind is not reset on update");
    await call(server, "track_upsert", { title: "Child", parent: "ahd/reset-board", order: 2, status: "done_prod" });
    const note = parse(await call(server, "track_note", { parent: "ahd/reset-board", body: "line one\nline two" }));
    assert.equal(note.item.project, "ahd", "a note inherits its parent's project");
    assert.equal(note.item.title, "line one");
    // The Rust board reads order as an integer: it must be stored as one.
    const raw = await db.collection("tracker_items").findOne({ id: note.item.id }, { promoteValues: false });
    assert.equal(raw.order._bsontype, "Long");
    assert.equal(raw.created_at._bsontype, "Long");
    assert.equal(note.item.order, clock);
    const got = parse(await call(reader, "track_get", { id: "ahd/reset-board" }));
    assert.equal(got.children.length, 2);
    assert.deepEqual(got.progress, { done: 2, in_production: 1, total: 2 });
    const open = parse(await call(reader, "track_list", { project: "ahd" }));
    assert.deepEqual(open.items.map((i) => i.id), ["ahd/reset-board"], "open_only by default");
    const text = parse(await call(reader, "track_list", { text: "LINE (", open_only: false }));
    assert.equal(text.count, 0, "text is escaped, not a regex");
    const summary = parse(await call(reader, "track_summary", {}));
    assert.equal(summary.counts.find((c) => c.status === "blocked").count, 1);
    assert.equal(summary.blocked[0].id, "ahd/reset-board");
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
