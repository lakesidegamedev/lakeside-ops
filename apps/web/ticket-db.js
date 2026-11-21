"use strict";

// Where a process reads the support ticket records from.
//
// The dashboard reads tickets (ticket context, receipts, the ticket hub)
// from its MONGODB_URI, database "a-house-divided" (server.js getDb). In a
// studio deployment that URI comes from the game database env file the
// dashboard and the support tool server both load. A process whose own
// MONGODB_URI points somewhere else (the ops-knowledge tool server reads the
// ops store) names the ticket database separately, without copying a
// credential:
//
//   TICKETS_MONGODB_ENV_FILE  an env file whose MONGODB_URI (and optional
//                             MONGODB_DIRECT_CONNECTION) is the ticket
//                             database: the same file the dashboard loads.
//                             Read with dotenv.parse, never printed.
//   TICKETS_MONGODB_URI       the URI itself (instead of the file).
//   TICKETS_DB_NAME           the database name (default "a-house-divided",
//                             the name the dashboard uses).
//
// With neither set, the caller's fallback is used (a standalone install's
// single database). Whatever is used, the ticket reader checks that the
// database really has a tickets collection, so a wrong database reads as
// "ticket status unknown", never as a wrong status.

const fs = require("node:fs");

const DEFAULT_DB_NAME = "a-house-divided";
const HOW_TO_CONFIGURE = "set TICKETS_MONGODB_ENV_FILE to the env file whose MONGODB_URI is the game database (the file the ops dashboard and support tool server load), or TICKETS_MONGODB_URI";

function flag(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

// -> { uri, dbName, directConnection, source } | { error } | null (not set).
function ticketDbConfig(env = process.env) {
  const dbName = String(env.TICKETS_DB_NAME || "").trim() || DEFAULT_DB_NAME;
  if (env.TICKETS_MONGODB_URI) {
    return { uri: env.TICKETS_MONGODB_URI, dbName, directConnection: flag(env.TICKETS_MONGODB_DIRECT_CONNECTION), source: "TICKETS_MONGODB_URI" };
  }
  if (env.TICKETS_MONGODB_ENV_FILE) {
    const file = env.TICKETS_MONGODB_ENV_FILE;
    let parsed;
    try {
      parsed = require("dotenv").parse(fs.readFileSync(file));
    } catch (error) {
      return { error: `TICKETS_MONGODB_ENV_FILE ${file} could not be read (${error.code || error.message})` };
    }
    if (!parsed.MONGODB_URI) return { error: `TICKETS_MONGODB_ENV_FILE ${file} has no MONGODB_URI` };
    return { uri: parsed.MONGODB_URI, dbName, directConnection: flag(parsed.MONGODB_DIRECT_CONNECTION), source: `MONGODB_URI from ${file}` };
  }
  return null;
}

// -> { getDb, source, error, close }. getDb is null when nothing usable is
// configured; error then says exactly what is missing.
// fallback: { getDb, source } used when no TICKETS_* setting is present.
function createTicketDb(env = process.env, { fallback = null, MongoClient = null } = {}) {
  const config = ticketDbConfig(env);
  if (!config) {
    if (fallback && fallback.getDb) return { getDb: fallback.getDb, source: fallback.source || "fallback", error: null, close: async () => {} };
    return { getDb: null, source: null, error: `no ticket database configured: ${HOW_TO_CONFIGURE}`, close: async () => {} };
  }
  if (config.error) return { getDb: null, source: null, error: `${config.error}: ${HOW_TO_CONFIGURE}`, close: async () => {} };
  const Client = MongoClient || require("mongodb").MongoClient;
  let client = null;
  let connecting = null;
  async function getDb() {
    if (!client) {
      if (!connecting) {
        const options = { maxPoolSize: 2, serverSelectionTimeoutMS: 8_000 };
        if (config.directConnection !== undefined) options.directConnection = config.directConnection;
        const next = new Client(config.uri, options);
        connecting = next.connect().then(() => { client = next; return next; }).finally(() => { connecting = null; });
      }
      await connecting;
    }
    return client.db(config.dbName);
  }
  return { getDb, source: `${config.source}, database ${config.dbName}`, error: null, close: async () => { if (client) await client.close().catch(() => {}); client = null; } };
}

module.exports = { ticketDbConfig, createTicketDb, HOW_TO_CONFIGURE, DEFAULT_DB_NAME };
