// agent-tokens.js — issue / validate / revoke scoped bearer tokens for the
// Ops MCP. Shared between the dashboard Agents page (issue, list, revoke) and
// the MCP server (validate on every request).
//
// Tokens are high-entropy random strings, so a fast SHA-256 of the raw token is
// the right store — bcrypt exists for low-entropy human passwords, not for 256
// bits of CSPRNG output. The raw token is shown to the admin exactly once at
// creation; only its hash is persisted.

const crypto = require("crypto");

const COLLECTION = "agent_tokens";
const PREFIX = "ahdk_"; // "A House divided Key"
const KINDS = ["docs", "skills", "memory"];

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Index creation is idempotent but still a round trip: do it once per
// connection instead of on every page request.
// MongoClient.db() returns a fresh Db object on every call, so key caches on the
// client (which is stable for the life of the connection).
const indexedClients = new WeakSet();

async function ensureIndexes(db) {
  if (indexedClients.has(db.client)) return;
  const col = db.collection(COLLECTION);
  await col.createIndex({ tokenHash: 1 }, { unique: true });
  await col.createIndex({ revokedAt: 1 });
  indexedClients.add(db.client);
}

// Issue a new token. `collections` limits which knowledge kinds it can touch;
// `write` gates save/update/delete (read is always allowed within scope).
async function issue(db, { name, collections, write = false, actor = "admin" }) {
  const scopeCols = (collections && collections.length ? collections : KINDS).filter((c) =>
    KINDS.includes(c)
  );
  const raw = PREFIX + crypto.randomBytes(24).toString("base64url");
  const record = {
    name: (name || "unnamed-agent").slice(0, 80),
    tokenHash: hashToken(raw),
    display: raw.slice(0, 12) + "…", // safe-to-show fingerprint for the UI
    scopes: { collections: scopeCols, write: !!write },
    createdAt: new Date(),
    createdBy: actor,
    lastUsedAt: null,
    revokedAt: null,
  };
  const res = await db.collection(COLLECTION).insertOne(record);
  invalidateListCache();
  return { raw, id: res.insertedId, record };
}

// Validate an incoming "Authorization: Bearer <token>" header. Returns the
// token record (with scopes) or null. Bumps lastUsedAt as a liveness signal so
// the Agents page can flag stale credentials.
async function validate(db, authHeader) {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const raw = m ? m[1] : authHeader.trim();
  if (!raw.startsWith(PREFIX)) return null;

  const rec = await db.collection(COLLECTION).findOne({ tokenHash: hashToken(raw) });
  if (!rec || rec.revokedAt) return null;

  db.collection(COLLECTION)
    .updateOne({ _id: rec._id }, { $set: { lastUsedAt: new Date() } })
    .catch(() => {});
  return rec;
}

function canRead(rec, kind) {
  return !!rec && rec.scopes.collections.includes(kind);
}
function canWrite(rec, kind) {
  return canRead(rec, kind) && rec.scopes.write === true;
}

// The token list is read on every Agents page render but changes only when a
// token is issued or revoked. Cache it briefly: the game Mongo is reached over
// an SSH tunnel, so an uncached find() can take seconds.
const LIST_TTL_MS = 60_000;
let listCache = null;

function invalidateListCache() {
  listCache = null;
}

async function list(db) {
  if (listCache && listCache.client === db.client && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.value;
  }
  const value = await db
    .collection(COLLECTION)
    .find({}, { projection: { tokenHash: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  listCache = { client: db.client, at: Date.now(), value };
  return value;
}

async function revoke(db, id, { ObjectId }) {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const res = await db
    .collection(COLLECTION)
    .updateOne({ _id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (res.modifiedCount > 0) invalidateListCache();
  return res.modifiedCount > 0;
}

module.exports = {
  hashToken,
  ensureIndexes,
  issue,
  validate,
  canRead,
  canWrite,
  list,
  revoke,
  invalidateListCache,
  COLLECTION,
  PREFIX,
  KINDS,
};
