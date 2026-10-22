"use strict";

// Lakeside company knowledge, served by the ops-knowledge MCP since the MCP
// fleet consolidation (2026-10-22). It replaced the separate company-knowledge
// MCP (lakeside-agency, :9761, SQLite) and keeps its tool names, arguments and
// answers, so its callers, including the lakeside-agency shift workers, can
// point at /mcp/company-knowledge on this server and see no difference.
//
// The store stays separate from ops_knowledge on purpose, as it was: company
// strategy is not an ops runbook. Two collections in the ops store mirror the
// two SQLite tables, with the same field names, so a row reads the same.

const { z } = require("zod");

const KINDS = ["company", "strategy", "product", "decision", "research", "people"];
const ENTRIES = "company_knowledge";
const VERSIONS = "company_knowledge_versions";

function slugify(value) {
  return String(value || "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function cleanKind(kind) {
  const value = String(kind || "company");
  if (!KINDS.includes(value)) throw new Error(`unknown knowledge kind: ${value}`);
  return value;
}

// A row as SQLite returned it: every column, in table order, no Mongo _id.
const COLUMNS = ["id", "slug", "kind", "title", "summary", "body", "tags", "version", "created_at", "created_by", "updated_at", "updated_by", "archived_at"];
const VERSION_COLUMNS = ["version", "title", "summary", "body", "tags", "saved_at", "saved_by"];
function shape(doc, columns = COLUMNS) {
  if (!doc) return null;
  const out = {};
  for (const c of columns) out[c] = c === "tags" ? (Array.isArray(doc.tags) ? doc.tags : []) : (doc[c] === undefined ? null : doc[c]);
  return out;
}

function createCompanyStore(db, now = () => new Date().toISOString()) {
  const entries = db.collection(ENTRIES);
  const versions = db.collection(VERSIONS);

  async function ensureIndexes() {
    await entries.createIndex({ slug: 1 }, { unique: true });
    await entries.createIndex({ id: 1 }, { unique: true });
    await entries.createIndex({ kind: 1, archived_at: 1, updated_at: -1 });
    await versions.createIndex({ knowledge_id: 1, version: -1 });
  }

  async function get(slug) {
    return shape(await entries.findOne({ slug: slugify(slug), archived_at: null }));
  }

  async function list({ kind = null, limit = 100, includeArchived = false } = {}) {
    const filter = {};
    if (kind) filter.kind = cleanKind(kind);
    if (!includeArchived) filter.archived_at = null;
    const n = Math.max(1, Math.min(Number(limit) || 100, 500));
    return (await entries.find(filter).sort({ updated_at: -1 }).limit(n).toArray()).map((d) => shape(d));
  }

  async function search(text, { kind = null, limit = 12 } = {}) {
    const query = String(text || "").trim().toLowerCase();
    if (!query) return list({ kind, limit });
    const terms = [...new Set(query.split(/[^a-z0-9]+/).filter((t) => t.length > 1))].slice(0, 12);
    const rows = await list({ kind, limit: 500 });
    return rows.map((row) => {
      const fields = {
        slug: row.slug.toLowerCase(),
        title: row.title.toLowerCase(),
        summary: String(row.summary || "").toLowerCase(),
        tags: row.tags.join(" ").toLowerCase(),
        body: row.body.toLowerCase(),
      };
      let score = fields.slug === slugify(query) ? 20 : 0;
      for (const term of terms) {
        if (fields.title.includes(term)) score += 7;
        if (fields.tags.includes(term)) score += 5;
        if (fields.summary.includes(term)) score += 4;
        if (fields.slug.includes(term)) score += 3;
        if (fields.body.includes(term)) score += 1;
      }
      return { ...row, score };
    }).filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at))
      .slice(0, Math.max(1, Math.min(Number(limit) || 12, 50)));
  }

  async function nextId() {
    const top = await entries.find({}, { projection: { id: 1 } }).sort({ id: -1 }).limit(1).toArray();
    return (top[0]?.id || 0) + 1;
  }

  async function save(entry, { actor = "system", expectedVersion = null } = {}) {
    const slug = slugify(entry.slug || entry.title);
    const title = String(entry.title || "").trim();
    const body = String(entry.body || "").trim();
    if (!slug || !title || !body) throw new Error("knowledge needs slug, title, and body");
    const existing = await get(slug);
    if (expectedVersion != null && (!existing || existing.version !== Number(expectedVersion))) {
      throw new Error(`version conflict for ${slug}; current version is ${existing ? existing.version : "missing"}`);
    }
    const ts = now();
    const tags = [...new Set((Array.isArray(entry.tags) ? entry.tags : []).map(slugify).filter(Boolean))].slice(0, 20);
    const by = String(actor).slice(0, 80);
    if (existing) {
      // The version check and the bump are one conditional update, so two
      // writers cannot both pass the check (SQLite had a transaction here).
      const updated = await entries.findOneAndUpdate(
        { id: existing.id, version: existing.version },
        { $set: { kind: cleanKind(entry.kind || existing.kind), title: title.slice(0, 240), summary: String(entry.summary || "").slice(0, 600),
          body: body.slice(0, 50000), tags, updated_at: ts, updated_by: by, archived_at: null }, $inc: { version: 1 } },
      );
      if (!updated) throw new Error(`version conflict for ${slug}; it changed while saving`);
      await versions.insertOne({ knowledge_id: existing.id, version: existing.version, title: existing.title, summary: existing.summary,
        body: existing.body, tags: existing.tags, saved_at: existing.updated_at, saved_by: existing.updated_by });
    } else {
      await entries.insertOne({ id: await nextId(), slug, kind: cleanKind(entry.kind), title: title.slice(0, 240),
        summary: String(entry.summary || "").slice(0, 600), body: body.slice(0, 50000), tags, version: 1,
        created_at: ts, created_by: by, updated_at: ts, updated_by: by, archived_at: null });
    }
    return get(slug);
  }

  async function archive(slug, { actor = "system" } = {}) {
    const entry = await get(slug);
    if (!entry) return false;
    const ts = now();
    const r = await entries.updateOne({ id: entry.id }, { $set: { archived_at: ts, updated_at: ts, updated_by: String(actor).slice(0, 80) } });
    return r.modifiedCount > 0;
  }

  async function history(slug) {
    const entry = await get(slug);
    if (!entry) return null;
    const previous = (await versions.find({ knowledge_id: entry.id }).sort({ version: 1 }).toArray()).map((d) => shape(d, VERSION_COLUMNS));
    return { entry, versions: [...previous, { ...entry, saved_at: entry.updated_at, saved_by: entry.updated_by }] };
  }

  async function stats() {
    const rows = await entries.aggregate([{ $match: { archived_at: null } }, { $group: { _id: "$kind", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
    return { total: rows.reduce((sum, row) => sum + row.n, 0), byKind: Object.fromEntries(rows.map((r) => [r._id, r.n])) };
  }

  return { ensureIndexes, get, list, search, save, archive, history, stats, kinds: KINDS };
}

function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function error(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// Same tools, descriptions and arguments as lakeside-agency's
// bin/company-knowledge-mcp.js. The old server enforced no scope at all (it
// was loopback-only with no token); here reads need any valid token and the
// two tools that change the store need a write-scoped one.
function registerCompanyTools(server, { auth, store }) {
  const canWrite = !!auth && auth.scopes && auth.scopes.write === true;
  const denied = () => error("write-scoped token required");

  server.tool(
    "company_context",
    "Explain the Lakeside company knowledge scope and return its current inventory. Call this first when company strategy, product context, decisions, research, or owner preferences matter. Ops procedures and infrastructure runbooks belong in ops-knowledge instead.",
    {},
    async () => json({
      purpose: "Lakeside company strategy and institutional memory on this box",
      includes: ["company facts", "strategy", "product context", "decisions", "research", "people and owner preferences"],
      excludes: ["infrastructure runbooks", "incidents", "deploy procedures", "server operations"],
      stats: await store.stats(),
    }),
  );

  server.tool(
    "company_search",
    "Search Lakeside company knowledge by title, summary, tags, and body. This store is separate from ops-knowledge.",
    {
      text: z.string().describe("Natural language or keywords"),
      kind: z.enum(KINDS).optional(),
      limit: z.number().int().min(1).max(50).optional().default(12),
    },
    async ({ text, kind, limit }) => json(await store.search(text, { kind, limit })),
  );

  server.tool(
    "company_get",
    "Read one Lakeside company knowledge entry by slug.",
    { slug: z.string() },
    async ({ slug }) => {
      const entry = await store.get(slug);
      return entry ? json(entry) : error("not found");
    },
  );

  server.tool(
    "company_list",
    "List Lakeside company knowledge entries, newest first.",
    {
      kind: z.enum(KINDS).optional(),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async ({ kind, limit }) => json(await store.list({ kind, limit })),
  );

  server.tool(
    "company_save",
    "Create or update durable Lakeside company knowledge. Use for strategy, product context, owner decisions, verified research, and stable preferences. Do not save ops runbooks here. Existing entries keep version history.",
    {
      slug: z.string().describe("Stable kebab-case name"),
      kind: z.enum(KINDS),
      title: z.string(),
      summary: z.string().optional(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      actor: z.string().optional().default("agency-agent"),
      expectedVersion: z.number().int().optional(),
    },
    async ({ actor, expectedVersion, ...entry }) => {
      if (!canWrite) return denied();
      try {
        return json(await store.save(entry, { actor, expectedVersion }));
      } catch (e) {
        return error(e.message);
      }
    },
  );

  server.tool(
    "company_history",
    "Read the version history of one Lakeside company knowledge entry.",
    { slug: z.string() },
    async ({ slug }) => {
      const history = await store.history(slug);
      return history ? json(history) : error("not found");
    },
  );

  server.tool(
    "company_archive",
    "Archive a company knowledge entry that is no longer true or useful. History remains recoverable.",
    { slug: z.string(), actor: z.string().optional().default("agency-agent") },
    async ({ slug, actor }) => {
      if (!canWrite) return denied();
      return (await store.archive(slug, { actor })) ? json({ ok: true }) : error("not found");
    },
  );
}

/**
 * Load the SQLite export (company-knowledge-export/company_knowledge.json)
 * into the two collections. Idempotent: rows already present by id are left
 * alone, so a re-run after the cutover cannot overwrite newer saves.
 */
async function importCompanyExport(db, exported) {
  const entries = db.collection(ENTRIES);
  const versions = db.collection(VERSIONS);
  const parseTags = (t) => { try { const v = JSON.parse(t || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  let inserted = 0, versionRows = 0;
  for (const row of exported.company_knowledge) {
    if (await entries.findOne({ id: row.id })) continue;
    await entries.insertOne({ ...shape({ ...row, tags: parseTags(row.tags) }) });
    inserted++;
    for (const v of exported.company_knowledge_versions.filter((x) => x.knowledge_id === row.id)) {
      await versions.insertOne({ knowledge_id: v.knowledge_id, ...shape({ ...v, tags: parseTags(v.tags) }, VERSION_COLUMNS) });
      versionRows++;
    }
  }
  return { inserted, versionRows };
}

module.exports = { createCompanyStore, registerCompanyTools, importCompanyExport, KINDS, slugify };
