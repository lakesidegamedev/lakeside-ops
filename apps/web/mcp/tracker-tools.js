"use strict";

// The long-running tracker's MCP tools, served by the ops-knowledge MCP since
// the MCP fleet consolidation (2026-10-22). Ported from the Rust
// lakeside-tracker (lakeside-code rust/bins/lakeside-tracker, tools.rs,
// store.rs, item.rs) with the same names, arguments, scopes and answers.
//
// lakeside-tracker keeps running as the ops dashboard's board backend
// (:9741 /board/api/board) and still reads tracker_items, so every write here
// keeps the Rust document shape. In particular `order`, `created_at` and
// `updated_at` are written as 64-bit integers: the board reads `order` only as
// an integer, and a JavaScript number past 2^31 would land as a double and
// read back as 0.

const { z } = require("zod");
const { Long } = require("mongodb");

const COLLECTION = "tracker_items";
const KINDS = ["project", "goal", "task", "check", "note"];
const STATUSES = ["open", "active", "blocked", "done_branch", "done_dev", "done_prod", "done", "dropped"];
const OPEN = ["open", "active", "blocked", "done_branch", "done_dev"];
const COMPLETE = new Set(["done_branch", "done_dev", "done_prod", "done"]);
const STATUS_ALIASES = { branch: "done_branch", dev: "done_dev", prod: "done_prod", production: "done_prod" };

function parseKind(s) { return KINDS.includes(s) ? s : null; }
function parseStatus(s) { return STATUSES.includes(s) ? s : (STATUS_ALIASES[s] || null); }

// Item::slug: lowercase, non-ASCII-alphanumerics to single dashes, trimmed, 60 chars.
function slug(project, title) {
  const base = String(title).toLowerCase().replace(/[^a-z0-9]/g, "-");
  let out = "";
  let lastDash = false;
  for (const c of base) {
    if (c === "-") { if (!lastDash && out) out += "-"; lastDash = true; }
    else { out += c; lastDash = false; }
  }
  out = [...out.replace(/^-+|-+$/g, "")].slice(0, 60).join("");
  return project ? `${project}/${out}` : out;
}

function regexEscape(s) { return String(s).replace(/[\\^$.|?*+()[\]{}]/g, "\\$&"); }

// Values arrive unpromoted (promoteValues: false), so Int32, Int64 and Double
// are distinguishable, as they are to the Rust reader.
const bsonType = (v) => (v && typeof v === "object" && v._bsontype) || null;

// timestamp_from_doc: Int64, Int32, or a whole, safe Double; else 0.
function timestamp(v) {
  const t = bsonType(v);
  if (t === "Long") return v.toNumber();
  if (t === "Int32") return v.value;
  if (t === "Double") return Number.isSafeInteger(v.value) ? v.value : 0;
  return 0;
}

// get_i64 or get_i32, else 0: a Double order is not read.
function order(v) {
  const t = bsonType(v);
  if (t === "Long") return v.toNumber();
  if (t === "Int32") return v.value;
  return 0;
}

// The fields bag as plain JSON, as serde_json::to_value(Bson) gives it.
function plain(v) {
  const t = bsonType(v);
  if (t === "Long") return v.toNumber();
  if (t === "Int32" || t === "Double") return v.value;
  if (t === "Decimal128") return v.toString();
  if (t === "ObjectId") return { $oid: v.toHexString() };
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object" && !t) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

// from_doc + serde: the Rust Item's JSON, keys in struct order, optionals omitted.
function itemJson(d) {
  if (!d || typeof d.id !== "string") return null;
  const out = {
    id: d.id,
    kind: parseKind(d.kind) || "task",
    title: typeof d.title === "string" ? d.title : "",
    status: parseStatus(d.status) || "open",
  };
  for (const k of ["project", "realm", "phase", "issue", "parent"]) if (typeof d[k] === "string") out[k] = d[k];
  const tags = Array.isArray(d.tags) ? d.tags.filter((t) => typeof t === "string") : [];
  if (tags.length) out.tags = tags;
  for (const k of ["body", "blocked_by"]) if (typeof d[k] === "string") out[k] = d[k];
  out.order = order(d.order);
  if (d.fields && typeof d.fields === "object" && !Array.isArray(d.fields) && !bsonType(d.fields)) {
    const keys = Object.keys(d.fields).sort();
    if (keys.length) out.fields = Object.fromEntries(keys.map((k) => [k, plain(d.fields[k])]));
  }
  if (typeof d.updated_by === "string") out.updated_by = d.updated_by;
  out.created_at = timestamp(d.created_at);
  out.updated_at = timestamp(d.updated_at);
  return out;
}

function createTrackerStore(db) {
  const items = db.collection(COLLECTION);
  const opts = { promoteValues: false };

  async function get(id) { return itemJson(await items.findOne({ id }, opts)); }

  async function find(filter, sort, limit) {
    const n = Math.max(1, Math.min(Number(limit) || 1, 500));
    return (await items.find(filter, opts).sort(sort).limit(n).toArray()).map(itemJson).filter(Boolean);
  }

  async function upsert(patch, now) {
    const { id, ...set } = patch;
    set.updated_at = Long.fromNumber(now);
    await items.updateOne({ id }, { $set: set, $setOnInsert: { id, created_at: Long.fromNumber(now) } }, { upsert: true });
    const item = await get(id);
    if (!item) throw new Error(`item vanished immediately after write: ${id}`);
    return item;
  }

  async function list(q) {
    const filter = {};
    if (q.project) filter.project = q.project;
    if (q.realm) filter.realm = q.realm;
    if (q.phase) filter.phase = q.phase;
    if (q.kind) filter.kind = q.kind;
    if (q.status) filter.status = q.status;
    if (q.open_only) filter.status = { $in: OPEN };
    if (q.parent) filter.parent = q.parent;
    if (q.tag) filter.tags = q.tag;
    if (q.text) {
      const re = regexEscape(q.text);
      filter.$or = [{ title: { $regex: re, $options: "i" } }, { body: { $regex: re, $options: "i" } }];
    }
    return find(filter, { order: 1, updated_at: -1 }, q.limit);
  }

  async function children(parent, limit) { return find({ parent }, { order: 1, created_at: 1 }, limit); }

  async function summary(project) {
    const out = [];
    for (const status of STATUSES) out.push([status, await items.countDocuments(project ? { project, status } : { status })]);
    return out;
  }

  return { get, upsert, list, children, summary };
}

function ok(value) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
function fail(text) { return { content: [{ type: "text", text }], isError: true }; }

function registerTrackerTools(server, { auth, store, now = () => Date.now() }) {
  const canWrite = !!auth && auth.scopes && auth.scopes.write === true;
  const denied = () => ({ content: [{ type: "text", text: "not permitted for this token" }], isError: true });
  const s = (v) => (typeof v === "string" ? v : undefined);

  server.tool(
    "track_upsert",
    "Create or update a tracked project, goal, task, check or note. Keyed on id, so calling it twice with the same id updates rather than duplicating. Omit id and one is derived from the title, which makes a re-run idempotent.",
    {
      id: z.string().optional().describe("Stable id. Derived from title+project when omitted."),
      kind: z.enum(KINDS).optional(),
      title: z.string().optional().describe("Required to create. Omit when updating an existing id."),
      status: z.enum(STATUSES).optional().describe("Completion says WHERE: done_branch, done_dev and done_prod are different facts. Use plain done only for work with no pipeline."),
      project: z.string().optional().describe("Which body of work, e.g. a-house-divided."),
      realm: z.string().optional().describe("Top-level grouping: a game, or a realm like infrastructure. What the board splits on."),
      phase: z.string().optional().describe("A named stage within a project, e.g. seed audit, reset, post-launch."),
      issue: z.string().optional().describe("A GitHub issue, as owner/repo#123 or #123."),
      parent: z.string().optional().describe("id of the item this hangs under."),
      tags: z.array(z.string()).optional(),
      body: z.string().optional().describe("Longer detail, markdown by convention."),
      blocked_by: z.string().optional().describe("Why it cannot proceed. Say this whenever status is blocked."),
      order: z.number().int().optional().describe("Sort order within a parent. Checklists have an order and losing it loses meaning."),
      fields: z.record(z.any()).optional().describe("Anything the schema did not anticipate. Kept rather than dropped."),
      updated_by: z.string().optional().describe("Who or what is writing, e.g. an agent name."),
    },
    async (args) => {
      if (!canWrite) return denied();
      const title = s(args.title);
      let id = s(args.id);
      if (!id) {
        if (title === undefined) return fail("supply an id to update, or a title to create");
        id = slug(s(args.project), title);
      }
      const exists = !!(await store.get(id).catch(() => null));
      if (!exists && title === undefined) return fail(`no item ${id} exists, and creating one needs a title`);
      // Only what was supplied is written: flipping a status must not blank a body.
      const patch = { id };
      if (title !== undefined) patch.title = title;
      if (args.kind !== undefined) patch.kind = args.kind;
      else if (!exists) patch.kind = "task";
      if (args.status !== undefined) patch.status = parseStatus(args.status);
      for (const k of ["project", "realm", "phase", "issue", "parent", "body", "blocked_by", "updated_by"]) {
        if (s(args[k]) !== undefined) patch[k] = args[k];
      }
      if (Number.isInteger(args.order)) patch.order = Long.fromNumber(args.order);
      if (Array.isArray(args.tags)) patch.tags = args.tags.filter((t) => typeof t === "string");
      if (args.fields && typeof args.fields === "object") patch.fields = args.fields;
      try {
        return ok({ ok: true, item: await store.upsert(patch, now()) });
      } catch (e) {
        return fail(`could not save: ${e.message}`);
      }
    },
  );

  server.tool(
    "track_list",
    "List tracked items. Filter by project, kind, status, parent, tag or free text. Defaults to things that still want attention.",
    {
      project: z.string().optional(),
      kind: z.enum(KINDS).optional(),
      status: z.enum(STATUSES).optional(),
      realm: z.string().optional(),
      phase: z.string().optional(),
      parent: z.string().optional().describe("List the children of this item, in order."),
      tag: z.string().optional(),
      text: z.string().optional().describe("Case-insensitive match on title or body."),
      open_only: z.boolean().optional().describe("Only open, active and blocked. Default true when no status is given."),
      limit: z.number().int().optional().describe("Default 50, maximum 500."),
    },
    async (args) => {
      const status = args.status ? parseStatus(args.status) : null;
      try {
        const items = await store.list({
          project: s(args.project), kind: args.kind ? parseKind(args.kind) : null, status,
          open_only: typeof args.open_only === "boolean" ? args.open_only : status === null,
          realm: s(args.realm), phase: s(args.phase), parent: s(args.parent), tag: s(args.tag), text: s(args.text),
          limit: Number.isInteger(args.limit) ? args.limit : 50,
        });
        return ok({ count: items.length, items });
      } catch (e) {
        return fail(`could not list: ${e.message}`);
      }
    },
  );

  server.tool(
    "track_get",
    "Fetch one item with its children in order. Use this to read a checklist.",
    { id: z.string() },
    async ({ id }) => {
      let item;
      try { item = await store.get(id); } catch (e) { return fail(`could not read: ${e.message}`); }
      if (!item) return fail(`no such item: ${id}`);
      const kids = await store.children(id, 500).catch(() => []);
      return ok({
        item,
        children: kids,
        progress: {
          done: kids.filter((k) => COMPLETE.has(k.status)).length,
          in_production: kids.filter((k) => k.status === "done_prod").length,
          total: kids.length,
        },
      });
    },
  );

  server.tool(
    "track_note",
    "Append a dated note to an item — progress, a finding, a decision. Notes are items too, so they can be listed and searched like anything else.",
    {
      parent: z.string().describe("The item this note is about."),
      body: z.string(),
      updated_by: z.string().optional(),
    },
    async ({ parent, body, updated_by }) => {
      if (!canWrite) return denied();
      const ts = now();
      const id = `${parent}#note-${ts}`;
      const title = [...(body.split("\n")[0] ?? "note")].slice(0, 90).join("");
      const patch = { id, kind: "note", status: "done", title, body, parent, order: Long.fromNumber(ts) };
      if (typeof updated_by === "string") patch.updated_by = updated_by;
      const p = await store.get(parent).catch(() => null);
      if (p && p.project) patch.project = p.project;
      try {
        return ok({ ok: true, item: await store.upsert(patch, ts) });
      } catch (e) {
        return fail(`could not save: ${e.message}`);
      }
    },
  );

  server.tool(
    "track_summary",
    "Counts by status, plus the projects and blocked items that want attention. This is what the ops dashboard reads.",
    { project: z.string().optional().describe("Omit for everything.") },
    async ({ project }) => {
      let counts;
      try { counts = await store.summary(s(project)); } catch (e) { return fail(`could not summarise: ${e.message}`); }
      const projects = await store.list({ kind: "project", open_only: true, limit: 100, project: s(project) }).catch(() => []);
      const blocked = await store.list({ status: "blocked", limit: 50, project: s(project) }).catch(() => []);
      return ok({ counts: counts.map(([status, count]) => ({ status, count })), projects, blocked });
    },
  );
}

module.exports = { createTrackerStore, registerTrackerTools, itemJson, slug, regexEscape };
