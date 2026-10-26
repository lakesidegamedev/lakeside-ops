// Ops Knowledge MCP server.
//
// A standalone HTTP MCP endpoint that lets remote agents read/write the shared
// knowledge store (docs | skills | memory) over the Model Context Protocol's
// Streamable HTTP transport. Every request is authenticated with a scoped
// bearer token issued by the dashboard Agents page.
//
// It shares the Mongo store with the dashboard via ../knowledge-store.js and
// ../agent-tokens.js. Heavy deps (express, mongodb, @xenova/transformers,
// dotenv) resolve up from the dashboard's node_modules — only the MCP SDK and
// zod live in mcp/node_modules.
//
// Run:  MONGODB_URI=... node mcp/server.js      (default port 9725)

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { createServer } = require("../packages/mcp-server");

const store = require("../knowledge-store");
const tokens = require("../agent-tokens");
const { buildGettingStarted } = require("../mcp-catalog");
const { registerKanbanTools } = require("./kanban-tools");
const { registerCwTelemetryTools } = require("./cw-telemetry-tools");
const { registerFleetTools } = require("./fleet-tools");
// Absorbed in the MCP fleet consolidation (2026-10-22). Each also answers under
// its old name at /mcp/<old-name>, with its old server name and only its tools.
const { registerReportTools, buildReportServer } = require("./report-publish-server");
const { createCompanyStore, registerCompanyTools } = require("./company-tools");
const { createTrackerStore, registerTrackerTools } = require("./tracker-tools");
const { summarizeEntry } = require("../ollama-summarize");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.MCP_PORT || "9725", 10);
// Optional server-wide default project. Left unset so reads span every repo
// (open shared brain) and agents opt into siloing by passing `project`.
const DEFAULT_PROJECT = process.env.KNOWLEDGE_DEFAULT_PROJECT || null;
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || "https://mcp.lakesidegames.net/mcp";
const MONGODB_URI = process.env.MONGODB_URI;
const WORKTREE_FLEET_REPORT = process.env.WORKTREE_FLEET_REPORT || path.join(__dirname, "..", "data", "worktree-fleet-latest.json");

// ─── codebase retrieval (the Ask index) ─────────────────────────────────────
// The retriever lives in the ask-site checkout and opens the SQLite index the
// rag-reindex timer rewrites every 15 minutes (it reopens on signature change).
// Loaded on first use so this server stays up when ask-site or the index is
// absent; retrieve.js reads its index path from the environment at load time,
// so it is pinned right before the require.
const ASK_SITE_DIR = process.env.ASK_SITE_DIR || "/root/projects/ask-site";
const ASK_RAG_DB = process.env.ASK_RAG_DB || "/root/misc/ask-remediation/index-v2.db";
// A second index tracks the development branch for agents working on this box
// (rebuilt every 4 hours, never shipped to Ask). Agents default to it; when it
// has not been built yet the tools fall back to the prod index and say so.
const ASK_RAG_DB_DEV = process.env.ASK_RAG_DB_DEV || "/root/misc/ask-remediation/index-dev.db";
const DEV_INDEX = { id: "ahd-dev", ragDb: ASK_RAG_DB_DEV };
function indexFor(source) {
  const wantDev = source !== "prod";
  const devReady = wantDev && require("fs").existsSync(ASK_RAG_DB_DEV);
  return { game: devReady ? DEV_INDEX : null, source: devReady ? "dev" : "prod", fallback: wantDev && !devReady };
}
let _askRetrieve = null;
function askRetrieve() {
  if (_askRetrieve) return _askRetrieve;
  process.env.RAG_DB = process.env.RAG_DB || ASK_RAG_DB;
  _askRetrieve = require(require("path").join(ASK_SITE_DIR, "retrieve.js"));
  return _askRetrieve;
}
if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI is required");
  process.exit(1);
}

// ─── embedding pipeline (mirrors server.js: bge-small-en-v1.5, 384-dim) ──────
let _embedPipeline = null;
async function embedText(text, isQuery = false) {
  if (!_embedPipeline) {
    const { pipeline } = await import("@xenova/transformers");
    _embedPipeline = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
    console.log("[mcp] embed pipeline ready (bge-small-en-v1.5, 384-dim)");
  }
  // bge wants a query prefix for retrieval; documents are embedded bare.
  const prefix = isQuery ? "Represent this sentence for searching relevant passages: " : "";
  const out = await _embedPipeline(prefix + String(text).slice(0, 7500), {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(out.data);
}

async function main() {
  const db = await store.getDb(MONGODB_URI);
  await store.ensureIndexes(db);
  await tokens.ensureIndexes(db);
  const companyStore = createCompanyStore(db);
  await companyStore.ensureIndexes();
  const trackerStore = createTrackerStore(db);


  // Build a per-request MCP server bound to the authenticated token's scopes.
  function buildServer(auth) {
    const server = new McpServer({ name: "ops-knowledge", version: "1.0.0" });

    server.tool(
      "worktree_fleet_status",
      "Read the latest fleet-wide Git worktree lifecycle report. Use this before creating a worktree or ending an agent session. Dirty and unlanded entries require delivery or explicit recovery; only proof-backed prune classes are automatically removable.",
      {
        repository: z.string().optional().describe("Substring filter for repository path"),
        classification: z.enum(["dirty", "unlanded", "safe-prune", "delivered-prune", "patch-equivalent-prune", "obsolete-prune", "open-pr", "post-merge-review", "unverifiable"]).optional(),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      async ({ repository, classification, limit }) => {
        let report;
        try {
          report = JSON.parse(fs.readFileSync(WORKTREE_FLEET_REPORT, "utf8"));
        } catch (error) {
          return errorResult(`worktree fleet report unavailable: ${error.message}`);
        }
        const matches = report.repositories.flatMap(repo => repo.worktrees
          .filter(tree => !tree.primary)
          .filter(tree => !repository || repo.repository.includes(repository))
          .filter(tree => !classification || tree.classification === classification)
          .map(tree => ({ repository: repo.repository, base: repo.base, ...tree })))
          .slice(0, limit);
        return jsonResult({ generatedAt: report.generatedAt, summary: report.after || report.before, matches, truncated: matches.length === limit });
      }
    );

    server.tool(
      "knowledge_query",
      "Semantic + keyword search over the Ops knowledge base (docs, skills, memory). Returns the most relevant entries with their bodies. Omit `project` to search across every repo (open shared brain); pass a project (e.g. \"metroforge\", \"a-house-divided\") to scope to that repo plus the always-shared entries.",
      {
        text: z.string().describe("Natural-language query"),
        collection: z.enum(["docs", "skills", "memory"]).optional()
          .describe("Restrict to one collection; omit to search all the token can read"),
        project: z.string().optional()
          .describe('Scope to a repo + shared entries (e.g. "metroforge"). Omit or "all" to search every project.'),
        limit: z.number().int().min(1).max(25).optional().default(8),
      },
      async ({ text, collection, project, limit }) => {
        const kinds = collection ? [collection] : auth.scopes.collections;
        const allowed = kinds.filter((k) => tokens.canRead(auth, k));
        if (!allowed.length) return errorResult("token has no read scope for the requested collection(s)");
        const proj = project ?? DEFAULT_PROJECT;
        const qEmbed = await embedText(text, true);
        let hits = [];
        for (const kind of allowed) {
          const r = await store.query(db, { kind, text, queryEmbedding: qEmbed, limit, project: proj });
          hits = hits.concat(r);
        }
        hits.sort((a, b) => b.score - a.score);
        const final = hits.slice(0, limit);
        const ids = final.map((h) => h.id);
        // Reinforcement + curation: count what was surfaced, and flag anything
        // read while stale (>7d) for the next review pass. Fire-and-forget.
        store.recordHits(db, ids).catch(() => {});
        store.flagStaleOnRead(db, ids).catch(() => {});
        return jsonResult(final);
      }
    );

    server.tool(
      "knowledge_get",
      "Fetch a single knowledge entry by collection + name, with its graph neighbors (what it links to and what links back).",
      {
        collection: z.enum(["docs", "skills", "memory"]),
        name: z.string().describe("kebab-case slug"),
        project: z.string().optional().describe('Scope lookup to a repo + shared; omit to match any project'),
      },
      async ({ collection, name, project }) => {
        if (!tokens.canRead(auth, collection)) return errorResult(`no read scope for ${collection}`);
        const proj = project ?? DEFAULT_PROJECT;
        const entry = await store.get(db, collection, name, { project: proj });
        if (!entry) return errorResult("not found");
        // Curation: reading a stale entry flags it for the next review pass.
        store.flagStaleOnRead(db, [entry._id]).catch(() => {});
        const neighbors = await store.neighbors(db, collection, name, { project: proj }).catch(() => null);
        return jsonResult(neighbors ? { ...entry, neighbors } : entry);
      }
    );

    server.tool(
      "knowledge_list",
      "List entries in a collection (titles + descriptions, no bodies). Page with offset; use order \"name\" for a stable full walk.",
      {
        collection: z.enum(["docs", "skills", "memory"]),
        project: z.string().optional().describe('Scope to a repo + shared; omit to list every project'),
        limit: z.number().int().min(1).max(500).optional().default(100),
        offset: z.number().int().min(0).max(100000).optional().default(0),
        order: z.enum(["updated", "name"]).optional().default("updated").describe("updated: newest first (default); name: stable order for paging"),
      },
      async ({ collection, project, limit, offset, order }) => {
        if (!tokens.canRead(auth, collection)) return errorResult(`no read scope for ${collection}`);
        return jsonResult(await store.list(db, collection, { limit, offset, order, project: project ?? DEFAULT_PROJECT }));
      }
    );

    server.tool(
      "knowledge_history",
      "Show an entry's version timeline (every save snapshots the prior revision, for docs/skills/memory alike) and a line diff between two revisions. Defaults to the diff of the two most recent versions.",
      {
        collection: z.enum(["docs", "skills", "memory"]),
        name: z.string().describe("kebab-case slug"),
        fromVersion: z.number().int().optional().describe("older version to diff from (default: the one before `toVersion`)"),
        toVersion: z.number().int().optional().describe("newer version to diff to (default: current)"),
        diff: z.boolean().optional().default(true).describe("include the line diff, not just the timeline"),
      },
      async ({ collection, name, fromVersion, toVersion, diff }) => {
        if (!tokens.canRead(auth, collection)) return errorResult(`no read scope for ${collection}`);
        const h = await store.history(db, collection, name);
        if (!h) return errorResult("not found");
        const timeline = h.versions.map((v) => ({ version: v.version, updatedBy: v.updatedBy, updatedAt: v.updatedAt, current: !!v.current }));
        const out = { name: h.name, kind: h.kind, currentVersion: h.currentVersion, versions: timeline };
        if (diff && h.versions.length >= 2) {
          const byV = (v) => h.versions.find((x) => x.version === v);
          const to = toVersion != null ? byV(toVersion) : h.versions[h.versions.length - 1];
          const from = fromVersion != null ? byV(fromVersion) : h.versions[h.versions.indexOf(to) - 1] || h.versions[h.versions.length - 2];
          if (from && to) {
            out.diff = { fromVersion: from.version, toVersion: to.version, patch: store.diffLines(from.body, to.body) };
          }
        }
        return jsonResult(out);
      }
    );

    server.tool(
      "knowledge_related",
      "Traverse the knowledge graph around an entry: the entries it links to ([[links]] in its body), the entries that link back to it, and any dangling links worth writing.",
      {
        collection: z.enum(["docs", "skills", "memory"]),
        name: z.string().describe("kebab-case slug"),
        project: z.string().optional().describe('Scope traversal to a repo + shared; omit for any project'),
      },
      async ({ collection, name, project }) => {
        if (!tokens.canRead(auth, collection)) return errorResult(`no read scope for ${collection}`);
        return jsonResult(await store.neighbors(db, collection, name, { project: project ?? DEFAULT_PROJECT }));
      }
    );

    server.tool(
      "knowledge_bootstrap",
      "Read the master onboarding brief: the shared brain, the full MCP toolbelt, project scope, and how the team works. Call this first on a fresh session to contextualize yourself.",
      {},
      async () => textResult(buildGettingStarted(MCP_PUBLIC_URL))
    );

    server.tool(
      "knowledge_review_queue",
      "List knowledge entries flagged for assessment (auto-flagged when an agent reads something not updated in >7 days). Each item carries a heuristic recommendation: keep / verify (docs & skills — confirm still correct) / ditch (cold, unused memory). Review these and knowledge_save (to update) or knowledge_delete (to prune) as warranted.",
      {
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
      async ({ limit }) => {
        const readable = auth.scopes.collections.filter((k) => tokens.canRead(auth, k));
        const queue = await store.listReviewQueue(db, { limit: 200 });
        const items = queue
          .filter((e) => readable.includes(e.kind))
          .slice(0, limit)
          .map((e) => {
            const a = store.assessEntry(e);
            return { kind: e.kind, name: e.name, title: e.title, flaggedAt: e.reviewFlaggedAt, recommendation: a.recommendation, reason: a.reason, signals: a.signals };
          });
        return jsonResult({ count: items.length, items });
      }
    );

    server.tool(
      "knowledge_feedback",
      "Reinforce the brain: upvote an entry that helped or downvote one that was wrong or stale. This signal ranks entries for every agent over time. Read scope is enough.",
      {
        collection: z.enum(["docs", "skills", "memory"]),
        name: z.string().describe("kebab-case slug"),
        vote: z.enum(["up", "down"]),
        project: z.string().optional().describe('Scope to a repo + shared; omit for any project'),
        note: z.string().optional().describe("optional why (not stored on the entry, for your own trace)"),
      },
      async ({ collection, name, vote, project }) => {
        if (!tokens.canRead(auth, collection)) return errorResult(`no read scope for ${collection}`);
        const r = await store.feedback(db, collection, name, vote, { actor: auth.name, project: project ?? DEFAULT_PROJECT });
        return r ? jsonResult({ ok: true, ...r }) : errorResult("not found");
      }
    );

    server.tool(
      "box_projects",
      "Look up where a project lives on this box and what backs it: canonical path, category (projects/personal/misc), git remote/default branch, worktrees dir, and every systemd unit + port that depends on it. Backed by /root/projects.manifest.json — the single source of truth other tools (finder page, metroforge-mcp, grand-century-mcp) read from too. Omit `name` to list every tracked project.",
      {
        name: z.string().optional().describe('Exact project name (e.g. "a-house-divided", "metroforge"). Omit to list all.'),
      },
      async ({ name }) => {
        delete require.cache[require.resolve("../../../projects.manifest.json")];
        const manifest = require("../../../projects.manifest.json");
        if (!name) {
          return jsonResult(
            Object.entries(manifest.entries).map(([n, e]) => ({ name: n, category: e.category, path: e.path }))
          );
        }
        const entry = manifest.entries[name];
        if (!entry) return errorResult(`no manifest entry named "${name}" — call without \`name\` to list all tracked projects`);
        return jsonResult({ name, ...entry });
      }
    );


    // Codebase retrieval: the same hybrid index Ask answers players from, so an
    // agent grounds a code question the way the product does instead of
    // grepping a checkout. Read scope on any collection is enough.
    const canReadAny = () => (auth.scopes.collections || []).some((k) => tokens.canRead(auth, k));

    server.tool(
      "code_search",
      "Hybrid (semantic + keyword + exact symbol) retrieval over the indexed A House Divided codebase, engineering docs, and player wiki: the index the Ask service answers from. Returns the chunks that would reach an answer model (path, part, source kind, revision, score, text) plus the file list. Ground a code or mechanics question here before reading files by hand; pass subQueries for a multi-part question.",
      {
        question: z.string().describe("Natural-language question, or a symbol or file name"),
        topK: z.number().int().min(1).max(24).optional().default(8),
        maxChars: z.number().int().min(2000).max(120000).optional().default(30000)
          .describe("Character budget for returned chunk text; chunks that do not fit are dropped, as in Ask"),
        claimType: z.enum(["mechanic", "intent", "player_help", "general"]).optional()
          .describe("Which source kind wins conflicts (code for mechanics, docs for intent, wiki for player help); inferred from the question when omitted"),
        fusion: z.enum(["legacy", "v2"]).optional().describe("Fusion mode; legacy is what Ask serves today"),
        source: z.enum(["dev", "prod"]).optional().default("dev")
          .describe("Which index: dev tracks the development branch (default for agents on this box), prod tracks main, which is what Ask serves players"),
        subQueries: z.array(z.string()).max(4).optional().describe("Sub-questions of a multi-part question; each retrieves and the results merge"),
      },
      async ({ question, topK, maxChars, claimType, fusion, source, subQueries }) => {
        if (!canReadAny()) return errorResult("token has no read scope");
        let r;
        try { r = askRetrieve(); } catch (e) { return errorResult(`code index unavailable: ${e.message}`); }
        const idx = indexFor(source);
        const opts = { topK, maxChars, game: idx.game, ...(claimType ? { claimType } : {}), ...(fusion ? { fusion } : {}) };
        const out = subQueries && subQueries.length
          ? await r.searchMulti(question, subQueries, opts)
          : await r.search(question, opts);
        if (!out) return errorResult("code index unavailable or empty");
        return jsonResult({
          index: idx.source, ...(idx.fallback ? { note: "dev index not built yet; served from the prod index" } : {}),
          claimType: out.claimType, count: out.count, files: out.files,
          hits: (out.hits || []).map((h) => ({
            path: h.path, part: h.ord + 1, source: h.source, revision: h.revision,
            score: Number(Number(h.score).toFixed(4)), text: h.text,
          })),
        });
      }
    );

    server.tool(
      "code_exact",
      "Exact-match lookup in the Ask code index for literal symbols, phrases, and paths named in the question (constants, function names, file names). Cheaper and stricter than code_search; use it when you already know the identifier.",
      {
        question: z.string().describe("Text containing the identifiers, phrases, or paths to match literally"),
        limit: z.number().int().min(1).max(20).optional().default(8),
        maxChars: z.number().int().min(2000).max(60000).optional().default(18000),
        source: z.enum(["dev", "prod"]).optional().default("dev").describe("dev (development branch, default) or prod (main)"),
      },
      async ({ question, limit, maxChars, source }) => {
        if (!canReadAny()) return errorResult("token has no read scope");
        let r;
        try { r = askRetrieve(); } catch (e) { return errorResult(`code index unavailable: ${e.message}`); }
        const idx = indexFor(source);
        const out = r.searchExact(question, { limit, maxChars, game: idx.game });
        if (!out) return jsonResult({ index: idx.source, count: 0, files: [], context: "" });
        return jsonResult({ index: idx.source, ...(idx.fallback ? { note: "dev index not built yet; served from the prod index" } : {}), count: out.count, files: out.files, context: out.context });
      }
    );

    server.tool(
      "code_read",
      "Read one indexed source file from the Ask code index by repository path (the `path` a code_search hit reports), reassembled from its chunks in order. Use after code_search to see the whole file rather than the retrieved slice. Code files only; secrets and key material are never indexed.",
      {
        path: z.string().describe("Repository-relative path, e.g. src/lib/turn/billLifecycle/configs/us.ts"),
        maxChars: z.number().int().min(2000).max(120000).optional().default(40000),
        source: z.enum(["dev", "prod"]).optional().default("dev").describe("dev (development branch, default) or prod (main)"),
      },
      async ({ path: filePath, maxChars, source }) => {
        if (!canReadAny()) return errorResult("token has no read scope");
        let r;
        try { r = askRetrieve(); } catch (e) { return errorResult(`code index unavailable: ${e.message}`); }
        const idx = indexFor(source);
        const out = r.readIndexedFile(filePath, { maxChars, game: idx.game });
        if (!out) return errorResult(`not in the ${idx.source} index: ${filePath}`);
        return jsonResult({ index: idx.source, ...(idx.fallback ? { note: "dev index not built yet; served from the prod index" } : {}), path: filePath, count: out.count, files: out.files, context: out.context });
      }
    );

    // Write tools are only exposed when the token carries write scope, so a
    // read-only agent never sees (and can't hallucinate calls to) them.
    if (auth.scopes && auth.scopes.write) {
    server.tool(
      "knowledge_save",
      "Create or update (idempotent upsert by name within a project) an entry. Cross-link related entries in the body with [[other-name]] to build the graph. Title/description are auto-generated if omitted. Prior versions are kept; a materially different overwrite of another agent's entry returns a conflict warning. Pass expectedVersion for a safe optimistic-locked update. Set `project` to silo the entry to a repo (e.g. \"metroforge\"); use \"shared\" for genuinely cross-repo knowledge. Requires write scope.",
      {
        collection: z.enum(["docs", "skills", "memory"]),
        name: z.string().describe("kebab-case slug; existing slug updates in place"),
        project: z.string().optional()
          .describe('Repo this belongs to (e.g. "metroforge", "a-house-divided"). Use "shared" for cross-repo knowledge. Defaults to the entry\'s existing project, else "shared".'),
        title: z.string().optional().describe("auto-generated from body if omitted"),
        description: z.string().optional().describe("one-line summary used for relevance; auto-generated if omitted"),
        body: z.string().describe("markdown body / the fact itself; use [[other-name]] to link related entries"),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.any()).optional(),
        expectedVersion: z.number().int().optional()
          .describe("if set, the write is refused when the stored version differs — re-read and merge first"),
      },
      async ({ collection, name, project, title, description, body, tags, metadata, expectedVersion }) => {
        if (!tokens.canWrite(auth, collection)) return errorResult(`no write scope for ${collection}`);
        // Fill missing title/description/tags via the summarizer (fail-soft).
        let finalTitle = title, finalDescription = description, finalTags = tags;
        if (!finalTitle || !finalDescription || !(finalTags && finalTags.length)) {
          const s = await summarizeEntry({ name, body }).catch(() => null);
          if (s) {
            finalTitle = finalTitle || s.title;
            finalDescription = finalDescription || s.description;
            if (!(finalTags && finalTags.length) && s.tags) finalTags = s.tags;
          }
        }
        const embedding = await embedText(`${finalTitle || name}\n${finalDescription || ""}\n${body}`);
        let saved;
        try {
          saved = await store.save(
            db,
            collection,
            { name, title: finalTitle, description: finalDescription, body, tags: finalTags, metadata, embedding },
            { actor: auth.name, expectedVersion, project: project ?? DEFAULT_PROJECT }
          );
        } catch (e) {
          if (e.code === "VERSION_CONFLICT") return errorResult(e.message);
          throw e;
        }
        const out = {
          ok: true,
          name: saved.name,
          project: saved.project,
          version: saved.version,
          action: saved._action,
          title: saved.title,
          description: saved.description,
          tags: saved.tags || [],
          links: saved.links || [],
        };
        if (saved._conflict) {
          out.warning =
            `Overwrote a materially different entry (was v${saved._prevVersion}` +
            (saved._prevAuthor ? ` by ${saved._prevAuthor}` : "") +
            `, similarity ${saved._similarityToPrev}). The prior version is preserved in history — ` +
            `review and merge if you dropped something.`;
        }
        return jsonResult(out);
      }
    );

    server.tool(
      "knowledge_delete",
      "Soft-delete an entry by name (preserves history). Requires write scope.",
      {
        collection: z.enum(["docs", "skills", "memory"]),
        name: z.string(),
        project: z.string().optional().describe('Scope to a repo + shared; omit to match any project'),
      },
      async ({ collection, name, project }) => {
        if (!tokens.canWrite(auth, collection)) return errorResult(`no write scope for ${collection}`);
        const ok = await store.remove(db, collection, name, { actor: auth.name, project: project ?? DEFAULT_PROJECT });
        return ok ? jsonResult({ ok: true }) : errorResult("not found");
      }
    );
    }

    // Product kanban (same store as the dashboard /kanban page).
    registerKanbanTools(server, { auth, jsonResult, errorResult });
    registerCwTelemetryTools(server, { jsonResult, errorResult });

    // The fleet describing itself, read live from every hosted server.
    registerFleetTools(server, { jsonResult, errorResult });

    // Reports, company knowledge and the tracker (MCP fleet consolidation).
    registerReportTools(server, auth);
    registerCompanyTools(server, { auth, store: companyStore });
    registerTrackerTools(server, { auth, store: trackerStore });

    return server;
  }

  const aliases = {
    "report-publish": buildReportServer,
    "company-knowledge": (auth) => {
      const server = new McpServer({ name: "company-knowledge", version: "1.0.0" });
      registerCompanyTools(server, { auth, store: companyStore });
      return server;
    },
    tracker: (auth) => {
      const server = new McpServer({ name: "lakeside-tracker", version: "0.1.0" });
      registerTrackerTools(server, { auth, store: trackerStore });
      return server;
    },
  };

  // Stateless Streamable HTTP: authenticate, then spin a fresh server+transport
  // per request and dispose on close.
  createServer({
    name: "ops-knowledge-mcp", version: "1.0.0", port: PORT, bind: process.env.MCP_BIND || "127.0.0.1",
    authorize: req => tokens.validate(db, req.headers.authorization), buildServer, aliases,
  });
}

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function textResult(text) {
  return { content: [{ type: "text", text: String(text) }] };
}
function errorResult(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
function rpcError(code, message) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

main().catch((err) => {
  console.error("[mcp] fatal:", err);
  process.exit(1);
});
