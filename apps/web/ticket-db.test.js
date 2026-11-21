// Where a process reads ticket records from (ticket-db.js).
// Run: node --test ticket-db.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ticketDbConfig, createTicketDb } = require("./ticket-db");

function envFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-db-"));
  const file = path.join(dir, "game.env");
  fs.writeFileSync(file, text);
  return file;
}

// Records how the client was built and which database was asked for.
function fakeClient() {
  const seen = { built: [], dbs: [] };
  class Client {
    constructor(uri, options) { seen.built.push({ uri, options }); }
    async connect() { return this; }
    db(name) { seen.dbs.push(name); return { databaseName: name }; }
    async close() {}
  }
  return { Client, seen };
}

describe("ticket database configuration", () => {
  it("reads the game database URI from the same env file the dashboard loads", async () => {
    const file = envFile("MONGODB_URI=mongodb://reader:pw@127.0.0.1:27999/?authSource=admin\nMONGODB_DIRECT_CONNECTION=true\nOTHER=x\n");
    const { Client, seen } = fakeClient();
    const t = createTicketDb({ TICKETS_MONGODB_ENV_FILE: file }, { MongoClient: Client, fallback: { getDb: async () => { throw new Error("fallback used"); } } });
    assert.equal(t.error, null);
    assert.equal(t.source, `MONGODB_URI from ${file}, database a-house-divided`);
    assert.doesNotMatch(t.source, /pw|reader/, "the credential is never in what is shown");
    const db = await t.getDb();
    assert.equal(db.databaseName, "a-house-divided");
    assert.equal(seen.built[0].uri, "mongodb://reader:pw@127.0.0.1:27999/?authSource=admin");
    assert.equal(seen.built[0].options.directConnection, true);
    await t.getDb();
    assert.equal(seen.built.length, 1, "one client per process");
  });

  it("accepts the URI directly and a database name", () => {
    const c = ticketDbConfig({ TICKETS_MONGODB_URI: "mongodb://h:1", TICKETS_DB_NAME: "tickets-copy" });
    assert.deepEqual(c, { uri: "mongodb://h:1", dbName: "tickets-copy", directConnection: undefined, source: "TICKETS_MONGODB_URI" });
  });

  it("says exactly what is missing instead of guessing", () => {
    const none = createTicketDb({});
    assert.equal(none.getDb, null);
    assert.match(none.error, /^no ticket database configured: set TICKETS_MONGODB_ENV_FILE to the env file whose MONGODB_URI is the game database/);
    const missing = createTicketDb({ TICKETS_MONGODB_ENV_FILE: "/nonexistent/game.env" });
    assert.equal(missing.getDb, null);
    assert.match(missing.error, /TICKETS_MONGODB_ENV_FILE \/nonexistent\/game\.env could not be read \(ENOENT\)/);
    const empty = createTicketDb({ TICKETS_MONGODB_ENV_FILE: envFile("OTHER=1\n") });
    assert.match(empty.error, /has no MONGODB_URI/);
  });

  it("uses the caller's own database only when nothing is configured", async () => {
    const fallback = { getDb: async () => ({ databaseName: "own" }), source: "this server's MONGODB_URI" };
    const t = createTicketDb({}, { fallback });
    assert.equal(t.source, "this server's MONGODB_URI");
    assert.equal((await t.getDb()).databaseName, "own");
  });
});
