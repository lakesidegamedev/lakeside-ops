#!/usr/bin/env node
// Ops Dashboard — multi-project ops platform (config-driven tenant/projects).
// Features: backups, database viewer, system health, game metrics
//
// Auth: Password login with bcrypt + session cookies
// DB: MongoDB (read-only, password fields redacted)
// Backups: Lists mongodump archives from local filesystem
//
 // Config: config/dashboard.yaml + env (see .env.example)
//   TENANT_NAME / DASHBOARD_TITLE / PRIMARY_PROJECT_KEY
//   OPS_PASSWORD_HASH, MONGODB_URI, BACKUP_DIR, PORT
//   SSO_BASE_URL / SSO_INTERNAL_TOKEN (aliases: LAKESIDE_AUTH_*)

const http = require("http");
const fs = require("fs");
// Studio-private Learning Center content; see the learn/ loader below.
const LEARN_INSTALLED = fs.existsSync(require("path").join(__dirname, "learn", "learn-data.js"));
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");
const { makeAuditPage } = require("./audit-report");
const { HOST_HEALTH_CSS, hostHealthPanel } = require("./host-health-panel");
const { makeCommodityPage } = require("./commodity-report");
const { icon, faviconFor, THEME_HEAD, themeToggle, THEME_TOGGLE_JS } = require("./ui-kit");
const { getDashboardMetrics, getKumaStatus } = require("./metrics");
const { createStaleRefreshCache, warmUntilReady } = require("./dashboard-snapshot-cache");
const { renderPrometheusMetrics } = require("./prometheus-metrics");
const { verifySignature: verifyGithubSig, reviewPullRequest } = require("./pr-review");
const { startCommunityWorkers, runTriageTick } = require("./triage-worker");
const { notifyDiscord: notifyOpsDiscord, COLORS: OPS_COLORS } = require("./ops-discord");
const { TOKENS_CSS } = require("./design-system");
const { FONT_LINKS, BASE_CSS, escHtml, NAV_CSS, MODVIEW_JS, modviewBanner, SIDEBAR, renderSidebar, renderNavbar, CMDK_CSS, CMDK_JS, renderCommandPalette, renderShell, injectNav, OPS_BAR_H } = require("./ops-shell");
const { getReplayDigest } = require("./replay-analytics");
const { renderReplayDigest } = require("./replay-page");
const { computeExtractionAudit } = require("./extraction-audit");
const { renderExtractionReport } = require("./extraction-report");
const { generateMarkov, buildWordCloud } = require("./community-voice");
const finderFs = require("./finder-fs");
const { makeFinderBody } = require("./finder-page");
const Database = require("better-sqlite3");
const { LakesideAuthClient } = require("./lakeside-auth-client");
const { loadConfig, getConfig } = require("./src/core/config");
const { listStatusServices, getSsoHosts, getTenant, getPrimaryProject } = require("./src/services/projectRegistry");
const { mcpPublicBase, primaryRepoDir, hermesHomeDir, resolveBinary } = require("./src/core/paths");
const { isEnabled } = require("./src/services/featureFlags");
const { makeDownloadPortal } = require("./download-portal");

// Load .env file if present (local development / manual deployments)
try {
  const dotenvPath = path.join(__dirname, ".env");
  if (fs.existsSync(dotenvPath)) {
    require("dotenv").config({ path: dotenvPath });
  }
} catch (e) { /* dotenv not installed or .env missing — fall back to process env */ }

// Tenant / project registry (YAML + env). Must load after dotenv.
const DASHBOARD_CONFIG = loadConfig();
const TENANT = getTenant();

let makeElectionAuditPage = function() { return ""; };
let makeElectionMapPage = function() { return ""; };
try {
  const ea = require("./election-audit");
  makeElectionAuditPage = ea.makeElectionAuditPage || makeElectionAuditPage;
} catch (e) { console.warn("election-audit module failed to load:", e.message); }
try {
  const em = require("./election-map");
  makeElectionMapPage = em.makeElectionMapPage || makeElectionMapPage;
} catch (e) { console.warn("election-map module failed to load:", e.message); }

// Sizes work to a model tier and remembers which providers are out of quota.
const { scoreComplexity } = require("./model-router");

// Read-only MCP access for codebase Q&A. Optional: with no token configured it
// discovers nothing and Ask behaves exactly as it did on source files alone.
let discoverAskTools = async () => ({ tools: [], index: new Map(), skipped: [] });
let discoverPublicAskTools = async () => ({ tools: [], index: new Map(), skipped: [] });
// Discovery costs a round trip to every server in the fleet, and the tool count
// is shown on page load, so it is memoised briefly rather than re-listed per view.
let askCapabilityCache = null;
const ASK_CAPABILITY_TTL_MS = 60_000;
let callAskTool = async () => ({ text: "MCP unavailable", source: null });
let callPublicAskTool = async () => ({ text: "MCP unavailable", source: null });
try {
  const askMcp = require("./ask-mcp");
  discoverAskTools = askMcp.discoverAskTools;
  discoverPublicAskTools = askMcp.discoverPublicAskTools;
  callAskTool = askMcp.callAskTool;
  callPublicAskTool = askMcp.callPublicAskTool;
} catch (e) { console.warn("ask-mcp module failed to load:", e.message); }
const { normalizeAskPreferences, publicAskPolicy, liveSourcePolicy, buildAskIdentityContext, protectPublicAnswer, isPublicAskAuthorized, runPublicAskConversation } = require("./ask-public");
const { getAskSearchRoots, normalizeAskRetrievalQuery, shouldIndexAskDirectory } = require("./ask-retrieval");

const OPS_PASSWORD_HASH = process.env.OPS_PASSWORD_HASH;
const MONGODB_URI = process.env.MONGODB_URI || DASHBOARD_CONFIG.mongodb.uri;
const BACKUP_DIR = DASHBOARD_CONFIG.paths.backupDir;
const PORT = DASHBOARD_CONFIG.port || parseInt(process.env.PORT || "9724", 10);
const PUBLIC_BASE = (DASHBOARD_CONFIG.publicBase || process.env.PUBLIC_BASE || "").replace(/\/+$/, "");
const KIMI_API_KEY = process.env.KIMI_API_KEY || "";
const ASK_API_SECRET = process.env.ASK_API_SECRET || "";
const SANDBOX_DIR = DASHBOARD_CONFIG.paths.sandboxDir;
// The branch codebase Q&A answers from. Explicit rather than "whatever the clone
// is on", because the AHD repo's default branch is released code.
const SANDBOX_BRANCH = DASHBOARD_CONFIG.paths.sandboxBranch || "development";
const dashboardSnapshot = createStaleRefreshCache({
  ttlMs: 30_000,
  load: async () => getDashboardMetrics(await getDb()),
  onError: (error) => console.warn("[dashboard-snapshot] refresh failed:", error.message),
});
// Read-only engine/observatory views re-query Mongo over an SSH tunnel on every
// request. Keep the last scan and refresh it in the background so navigation is
// instant instead of paying 1-2s per visit.
const enginePageSnapshot = createStaleRefreshCache({
  ttlMs: 60_000,
  load: async () => engineHealth(await getDb()),
  onError: (error) => console.warn("[engine-page] refresh failed:", error.message),
});
const observatoryPageSnapshot = createStaleRefreshCache({
  ttlMs: 60_000,
  load: async () => {
    const db = await getDb();
    const [scan, registry] = await Promise.all([
      watchtowerScan(db),
      db.collection(REGISTRY_COLLECTION).find({}).sort({ status: 1, createdAt: -1 }).limit(100).toArray()
        .catch(() => []),
    ]);
    return { scan, registry };
  },
  onError: (error) => console.warn("[observatory-page] refresh failed:", error.message),
});
// Full-codebase search index (TF-IDF over file contents). Declared early so the
// path resolver below can consult it. Populated by buildSearchIndex() once the
// sandbox is available, and rebuilt after each git pull.
let SEARCH_INDEX = { ready: false, N: 0, df: new Map(), files: [] };

// ─── SEMANTIC RERANKING VIA TRANSFORMERS.JS (in-process, ~5ms/embed) ────────
// all-MiniLM-L6-v2: 23MB, 384-dim, downloads once to ~/.cache/huggingface.
// No HTTP overhead — runs ONNX in-process. Much faster than Ollama.
const CHUNK_LINES = 180;
const CHUNK_OVERLAP = 40;
// Cache keyed by `relPath:startLine` → Float32Array
const SEMANTIC_EMBED_CACHE = new Map();
let semanticReady = false;
let _embedPipeline = null;

// bge-small-en-v1.5: 33M params, 384-dim, ~83ms/embed on CPU — fast enough for
// per-query reranking. Only runs in "reasoning" quality mode; fast/standard use
// TF-IDF only so there's no ML overhead on normal queries.
const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
const EMBED_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const EMBED_DOC_PREFIX = "";

async function initTransformers() {
  try {
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = false;
    if (process.env.HF_TOKEN) env.token = process.env.HF_TOKEN;
    _embedPipeline = await pipeline("feature-extraction", EMBED_MODEL);
    semanticReady = true;
    console.log("[semantic] bge-small-en-v1.5 ready (384-dim, ~83ms/embed, reasoning mode only)");
  } catch (e) {
    console.log("[semantic] Transformers.js init failed — TF-IDF only:", e.message);
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// isQuery: true = "search_query: " prefix, false = "search_document: " prefix
async function embedText(text, isQuery = false) {
  if (!_embedPipeline) throw new Error("Embed pipeline not ready");
  const prefix = isQuery ? EMBED_QUERY_PREFIX : EMBED_DOC_PREFIX;
  const out = await _embedPipeline(prefix + text.slice(0, 7500), { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}

// Split file content into overlapping chunks. Each chunk carries its line range
// so we can surface precise hints back to the LLM and user.
function chunkFileContent(content, relPath) {
  const lines = content.split("\n");
  const chunks = [];
  let i = 0;
  while (i < lines.length) {
    const end = Math.min(i + CHUNK_LINES, lines.length);
    chunks.push({
      chunkId: `${relPath}:${i + 1}`,
      text: `${relPath}\n${lines.slice(i, end).join("\n")}`,
      startLine: i + 1,
      endLine: end,
    });
    if (end >= lines.length) break;
    i += CHUNK_LINES - CHUNK_OVERLAP;
  }
  return chunks;
}

// Re-rank TF-IDF candidates using chunk-level cosine similarity.
// Annotates each result with `bestChunk` (startLine, endLine, semanticScore).
// `sseFn` is optional — if provided, emits progress events for the UI.
// Pick the best chunk for a file without embedding: score each chunk by how
// many query terms it contains (fast TF-IDF proxy). Falls back to first chunk.
function bestChunkByTerms(chunks, queryTerms) {
  if (!chunks.length) return null;
  let best = chunks[0], bestScore = 0;
  for (const ch of chunks) {
    const lower = ch.text.toLowerCase();
    let score = 0;
    for (const t of queryTerms) if (lower.includes(t)) score++;
    if (score > bestScore) { bestScore = score; best = ch; }
  }
  return best;
}

// Re-rank TF-IDF candidates using chunk-level semantic similarity.
// Processes files SEQUENTIALLY (one embed per file) to avoid overwhelming
// Ollama, which is single-threaded. Uses TF-IDF term matching to pick the
// most relevant chunk per file before embedding — so it's always 1 embed/file.
async function semanticRerank(candidates, question, sseFn) {
  if (!semanticReady || !candidates.length) return candidates;
  try {
    if (sseFn) sseFn("semantic", { status: "start", total: candidates.length });
    const qEmbed = await embedText(question, true);

    // Normalise query into terms for fast chunk pre-selection
    const queryTerms = question.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    const maxTf = candidates[0].score || 1;
    const results = [];

    for (const c of candidates) {
      let content = "";
      try { content = fs.readFileSync(c.path, "utf8").slice(0, 50000); } catch {}
      const chunks = chunkFileContent(content, c.relPath);

      // Pick best chunk by term overlap — no embedding needed for this step
      const targetChunk = bestChunkByTerms(chunks, queryTerms) || chunks[0];

      let emb;
      if (SEMANTIC_EMBED_CACHE.has(targetChunk.chunkId)) {
        emb = SEMANTIC_EMBED_CACHE.get(targetChunk.chunkId);
      } else {
        emb = await embedText(targetChunk.text);
        SEMANTIC_EMBED_CACHE.set(targetChunk.chunkId, emb);
        if (SEMANTIC_EMBED_CACHE.size > 2000) {
          SEMANTIC_EMBED_CACHE.delete(SEMANTIC_EMBED_CACHE.keys().next().value);
        }
      }

      const sem = cosine(qEmbed, emb);
      const blended = 0.55 * sem + 0.45 * (c.score / maxTf);
      results.push({ ...c, semanticScore: sem, bestChunk: targetChunk, score: blended });
    }

    results.sort((a, b) => b.score - a.score);
    if (sseFn) sseFn("semantic", { status: "done", ranked: results.length });
    return results;
  } catch (e) {
    console.error("[semantic] rerank failed:", e.message);
    if (sseFn) sseFn("semantic", { status: "error", error: e.message });
    return candidates;
  }
}

// ─── Q&A SEMANTIC MEMORY (Feature 3) ─────────────────────────────────
// Saves answered questions with their embeddings to MongoDB so future
// questions can be grounded in what was already discovered.
const QA_MEMORY_COLLECTION = "qa_memory";
const QA_MEMORY_LIMIT = 200; // max entries to keep

async function saveQAMemory(db, { question, answerSummary, files }) {
  if (!semanticReady || !question) return;
  try {
    const embedding = Array.from(await embedText(question, true));
    const entry = {
      _id: crypto.randomUUID(),
      question: question.slice(0, 500),
      answerSummary: (answerSummary || "").slice(0, 800),
      files: (files || []).slice(0, 10),
      embedding,
      createdAt: new Date(),
    };
    await db.collection(QA_MEMORY_COLLECTION).insertOne(entry);
    // Prune oldest if over limit
    const count = await db.collection(QA_MEMORY_COLLECTION).countDocuments();
    if (count > QA_MEMORY_LIMIT) {
      const oldest = await db.collection(QA_MEMORY_COLLECTION)
        .find({}).sort({ createdAt: 1 }).limit(count - QA_MEMORY_LIMIT).toArray();
      if (oldest.length) {
        await db.collection(QA_MEMORY_COLLECTION)
          .deleteMany({ _id: { $in: oldest.map(d => d._id) } });
      }
    }
  } catch (e) {
    console.error("[qa-memory] save failed:", e.message);
  }
}

async function findSimilarQAs(db, questionEmbed, k = 3) {
  if (!semanticReady) return [];
  try {
    const recent = await db.collection(QA_MEMORY_COLLECTION)
      .find({}).sort({ createdAt: -1 }).limit(150).toArray();
    if (!recent.length) return [];
    return recent
      .map(m => ({ ...m, sim: cosine(questionEmbed, new Float32Array(m.embedding)) }))
      .filter(m => m.sim > 0.72) // only include meaningfully similar questions
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);
  } catch { return []; }
}
// Case-insensitive path resolver: Linux filesystems are case-sensitive,
// but LLMs often request paths in all-lowercase. Try exact match first,
// then fall back to case-insensitive match against the file index.
function resolveFilePath(requestedPath, fileIndex) {
  const normalized = requestedPath.replace(/^\/+/, "");
  // 1. Exact match
  const exact = path.resolve(SANDBOX_DIR, normalized);
  if (fs.existsSync(exact) && exact.startsWith(SANDBOX_DIR)) return exact;
  // 2. Case-insensitive match against indexed files
  const lower = normalized.toLowerCase();
  const match = fileIndex?.find(f => f.lowerRelPath === lower);
  if (match) return match.path;
  // 3. Partial case-insensitive match (filename only)
  const partial = fileIndex?.find(f => f.lowerRelPath.endsWith("/" + lower) || f.lowerRelPath === lower);
  if (partial) return partial.path;
  // 4. Fall back to the full sandbox index — covers files the model references
  //    that weren't in the per-question relevant subset (e.g. cross-references).
  if (SEARCH_INDEX.files && SEARCH_INDEX.files.length) {
    const idxMatch = SEARCH_INDEX.files.find(f => f.lowerRelPath === lower) ||
                     SEARCH_INDEX.files.find(f => f.lowerRelPath.endsWith("/" + lower));
    if (idxMatch) return idxMatch.path;
  }
  return null; // not found
}
const LLM_PROVIDER = process.env.LLM_PROVIDER || "ollama-cloud";
const LLM_API_URL = process.env.LLM_API_URL || (
  LLM_PROVIDER === "kimi" ? "https://api.kimi.com/coding/v1/chat/completions" :
  LLM_PROVIDER === "opencode-go" ? (process.env.OPENCODE_GO_API_URL || "https://opencode.ai/zen/go/v1/chat/completions") :
  (process.env.OLLAMA_CLOUD_API_URL || "https://ollama.com/v1/chat/completions")
);
const LLM_API_KEY = process.env.LLM_API_KEY || (
  LLM_PROVIDER === "kimi" ? process.env.KIMI_API_KEY :
  LLM_PROVIDER === "opencode-go" ? process.env.OPENCODE_GO_API_KEY :
  (process.env.OLLAMA_CLOUD_KEY || process.env.OLLAMA_API_KEY)
) || "";
const LLM_MODEL = process.env.LLM_MODEL || (
  LLM_PROVIDER === "kimi" ? "kimi-for-coding" : "deepseek-v4-flash"
);
// Codex is a local CLI runtime, so its model list does not come from the
// OpenAI-compatible provider discovery above. Keep the dashboard's choices in
// one place and default to the same model as ~/.codex/config.toml on this host.
const CODEX_DEFAULT_MODEL = process.env.CODEX_MODEL || "gpt-5.6-luna";
const CODEX_MODELS = [...new Set([
  CODEX_DEFAULT_MODEL,
  ...(process.env.CODEX_MODELS || "gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini")
    .split(",")
    .map(model => model.trim())
    .filter(Boolean),
])];
const modelDiscoveryCache = new Map(); // { name: { models: [], ts: timestamp } }

async function discoverCloudSpawnModels(kind) {
  const cacheKey = `spawn:${kind}`;
  const cached = modelDiscoveryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 300000) return cached.models;

  let modelsUrl;
  let headers = {};
  if (kind === "ollama") {
    modelsUrl = "https://ollama.com/v1/models";
    const key = process.env.OLLAMA_API_KEY || process.env.OLLAMA_CLOUD_KEY || "";
    if (!key) return null;
    headers = { Authorization: `Bearer ${key}` };
  } else if (kind === "opencode") {
    modelsUrl = "https://opencode.ai/zen/go/v1/models";
    const key = process.env.OPENCODE_GO_API_KEY || "";
    if (!key) return null;
    headers = { Authorization: `Bearer ${key}`, "User-Agent": "opencode" };
  } else {
    return null;
  }

  const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const data = await res.json();
  const models = (data?.data || [])
    .map((m) => m.id)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (!models.length) return null;
  modelDiscoveryCache.set(cacheKey, { models, ts: Date.now() });
  return models;
}

const SANDBOX_PULL_INTERVAL = 15 * 60 * 1000; // 15 minutes

// Multi-user support: OPS_USERS env var format: "email1:role1:bcryptHash1,email2:role2:bcryptHash2"
// Roles: "admin" (full access) or "moderator" (Q&A portal only)
// Falls back to single-user mode with OPS_ADMIN_EMAIL + OPS_PASSWORD_HASH for backward compat.
const USERS = new Map(); // email(lowercase) -> { hash, role }
const AUTH_MODE = process.env.OPS_AUTH_MODE || DASHBOARD_CONFIG.auth?.mode || "password";
if (!["password", "sso"].includes(AUTH_MODE)) throw new Error(`Unsupported auth mode: ${AUTH_MODE}`);
if (process.env.OPS_USERS) {
  for (const entry of process.env.OPS_USERS.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length < 2) continue;
    const email = parts[0].toLowerCase();
    // If 3+ parts: email:role:hash  If 2 parts: email:hash (role defaults to admin)
    let role, hash;
    if (parts.length >= 3) {
      role = parts[1].toLowerCase();
      hash = parts.slice(2).join(":"); // re-join in case hash contains colons
      if (role !== "admin" && role !== "moderator") continue;
    } else {
      role = "admin";
      hash = parts[1];
    }
    if (email && hash) USERS.set(email, { hash, role });
  }
}
// Backward compat: single-user mode
const OPS_ADMIN_EMAIL = process.env.OPS_ADMIN_EMAIL || "admin@example.com";
if (!USERS.has(OPS_ADMIN_EMAIL.toLowerCase()) && OPS_PASSWORD_HASH) {
  USERS.set(OPS_ADMIN_EMAIL.toLowerCase(), { hash: OPS_PASSWORD_HASH, role: "admin" });
}

if (USERS.size === 0 && AUTH_MODE === "password") {
  console.error("ERROR: No users configured. Set OPS_USERS or OPS_PASSWORD_HASH");
  console.error("OPS_USERS format: \"email1:role1:bcryptHash1,email2:role2:bcryptHash2\"");
  console.error("Roles: admin (full access), moderator (Q&A portal only)");
  console.error("Generate hash: node -e \"const bcrypt=require('bcryptjs');bcrypt.hash('yourpassword',12).then(console.log)\"");
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error("ERROR: MONGODB_URI environment variable is required");
  process.exit(1);
}

// Production releases use a shared data path so replacing the source tree does
// not sign out everyone. The local default keeps development self-contained.
const { runtimePaths } = require("./src/core/runtimePaths");
const { sessionsFile: SESSIONS_FILE, publishedReportsDir: PUBLISHED_REPORTS_DIR } = runtimePaths(__dirname);
const { sessionLifetime, NATIVE_TTL } = require("./ops-session-policy");
const MAX_SESSIONS = 200;

// Load sessions from disk on startup
const sessions = new Map();
try {
  const data = fs.readFileSync(SESSIONS_FILE, "utf8");
  const parsed = JSON.parse(data);
  const now = Date.now();
  for (const [token, session] of Object.entries(parsed)) {
    // Only restore non-expired sessions
    if (now - session.created < sessionLifetime(session)) {
      sessions.set(token, session);
    }
  }
  console.log(`Restored ${sessions.size} sessions from disk`);
} catch {
  // No file or corrupt — start fresh
  console.log("No saved sessions, starting fresh");
}

// Persist sessions to disk (debounced so we don't hammer fs on every login)
let sessionsDirty = false;
let sessionsSaveTimer = null;
function saveSessions() {
  try {
    const obj = Object.fromEntries(sessions.entries());
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
    sessionsDirty = false;
  } catch (e) {
    console.error("Failed to save sessions:", e.message);
  }
}
function markSessionsDirty() {
  sessionsDirty = true;
  if (!sessionsSaveTimer) {
    sessionsSaveTimer = setTimeout(() => {
      if (sessionsDirty) saveSessions();
      sessionsSaveTimer = null;
    }, 1000);
  }
}

// MongoDB client (lazy connect with a single shared reconnect). Several
// dashboard workers initialize concurrently; allowing each to close and
// replace the client races active queries into "Topology is closed" errors.
let mongoClient = null;
let mongoConnectPromise = null;
async function getDb() {
  if (mongoClient?.topology?.isConnected()) return mongoClient.db("a-house-divided");
  if (!mongoConnectPromise) {
    const staleClient = mongoClient;
    mongoConnectPromise = (async () => {
      // The console fans out many small reads (dashboard snapshot, page data)
      // against a database reached over a tunnel; two sockets serialized them
      // and made ordinary page loads wait behind background refreshes.
      const nextClient = new MongoClient(MONGODB_URI, { maxPoolSize: 6, serverSelectionTimeoutMS: 10000 });
      await nextClient.connect();
      mongoClient = nextClient;
      if (staleClient && staleClient !== nextClient) staleClient.close().catch(() => {});
      return nextClient;
    })().finally(() => { mongoConnectPromise = null; });
  }
  const client = await mongoConnectPromise;
  return client.db("a-house-divided");
}

const { authorizeOpsSession, credentialVersion, sessionToken } = require("./ops-session-policy");
async function checkSession(req) {
  const token = sessionToken(req);
  if (!token) return null;
  return authorizeOpsSession(sessions.get(token), { getDb, users: USERS, allowLocal: AUTH_MODE === "password", onUnavailable: () => { req.opsAuthUnavailable = true; } });
}

// ─── Cross-subdomain SSO with the main game site ─────────────────────
// Login handoff is delegated to lakeside-auth (identity broker). Staff
// authorization (admin/moderator, ban, token revocation) stays HERE and is
// resolved from AHD Mongo after identity comes back — never from the broker.
//
// Ambient game auth uses the issuer's live session check. This service never
// verifies or signs game JWTs. Staff authorization remains local.
// Prefer generic SSO_* names; LAKESIDE_AUTH_* kept as aliases for one release.
const LAKESIDE_AUTH_BASE_URL = DASHBOARD_CONFIG.sso.baseUrl || "";
const LAKESIDE_AUTH_INTERNAL_TOKEN = DASHBOARD_CONFIG.sso.internalToken || "";
if (AUTH_MODE === "sso" && (!isEnabled("sso") || !LAKESIDE_AUTH_BASE_URL || !LAKESIDE_AUTH_INTERNAL_TOKEN)) {
  throw new Error("SSO auth mode requires an enabled identity broker and its credentials");
}
// Optional parent-domain cookie ingress for game JWT ambient auth.
// Undefined when unset, never "": loginUrl() falls back to the auth base URL
// through a default parameter, and a default parameter does not fire for an
// empty string. Coalescing to "" instead sent `new URL("/auth/ahd", "/")` a
// relative base, which throws ERR_INVALID_URL — uncaught, in the request
// handler, so every click on "sign in" killed the whole dashboard process.
// That crashed it 8 times on 2026-07-27 before anyone connected the two.
const LAKESIDE_AUTH_AHD_ORIGIN =
  (DASHBOARD_CONFIG.sso.ahdOrigin || process.env.LAKESIDE_AUTH_AHD_ORIGIN || "").replace(/\/+$/, "") ||
  undefined;
const OPS_SSO_HOSTS = getSsoHosts();

let _lakesideAuthClient = null;
function getLakesideAuthClient() {
  if (!LAKESIDE_AUTH_BASE_URL || !LAKESIDE_AUTH_INTERNAL_TOKEN) return null;
  if (!_lakesideAuthClient) {
    _lakesideAuthClient = new LakesideAuthClient({
      baseUrl: LAKESIDE_AUTH_BASE_URL,
      internalToken: LAKESIDE_AUTH_INTERNAL_TOKEN,
    });
  }
  return _lakesideAuthClient;
}

const { verifyProductionGameSession } = require("./game-session-client");

// Short-TTL cache of *validated* game sessions, keyed by a token digest. One page load
// fans out into many auth checks (HTML render + /api/me + data APIs); without
// this, each re-hits Mongo and a single slow/failed lookup bounces the user to
// "/" (the sign-in flash). Only successes are cached, so a transient failure is
// never sticky; bans/revocations propagate within the TTL.
const _gameSessCache = new Map(); // token digest -> { session, exp }
const GAME_SESS_TTL_MS = 20000;

/**
 * Authoritative staff gate: AHD Mongo users collection.
 * Identity alone (from lakeside-auth or a verified JWT) is never enough.
 * @param {string} userId AHD user id (ObjectId hex)
 * @param {{ iat?: number, emailFallback?: string }} [opts]
 *   iat: issuer-verified issued-at seconds for ambient game sessions.
 *   Broker handoffs have already passed the issuer live session check.
 *   Current ban and staff checks run for both paths.
 * @returns {Promise<{ email: string, role: "admin"|"moderator", source: "game" }|null>}
 */
async function resolveStaffFromAhdUser(userId, opts = {}) {
  if (!userId) return null;
  let db;
  try {
    db = await getDb();
  } catch {
    return null;
  }
  const { ObjectId } = require("mongodb");
  let _id;
  try {
    _id = new ObjectId(userId);
  } catch {
    return null;
  }
  let user;
  try {
    user = await db.collection("users").findOne(
      { _id },
      { projection: { email: 1, isAdmin: 1, isModerator: 1, isBanned: 1, authRevokedAt: 1 } }
    );
  } catch {
    return null;
  }
  if (!user || user.isBanned === true) return null;
  if (user.authRevokedAt && opts.iat && user.authRevokedAt.getTime() >= opts.iat * 1000) return null;
  let role = null;
  if (user.isAdmin === true) role = "admin";
  else if (user.isModerator === true) role = "moderator";
  if (!role) return null;
  return { email: user.email || opts.emailFallback, role, source: "game", userId, revocationVersion: user.authRevokedAt ? new Date(user.authRevokedAt).getTime() : 0 };
}

// Cache only an already verified exact production cookie. Bound by token expiry.
async function checkGameSession(req, { fresh = false } = {}) {
  const cookieName = process.env.AHD_SESSION_COOKIE_NAME || "auth-token-main-site";
  const values = (req.headers.cookie || "").split(";").map(c => c.trim())
    .filter(c => c.startsWith(`${cookieName}=`)).map(c => c.slice(cookieName.length + 1));
  if (values.length !== 1 || !values[0] || values[0].length > 8192) return null;
  const key = crypto.createHash("sha256").update(values[0]).digest("hex");
  const hit = _gameSessCache.get(key);
  if (!fresh && hit && hit.exp > Date.now()) return hit.session;
  _gameSessCache.delete(key);
  let checked;
  try { checked = await verifyProductionGameSession(req.headers.cookie); }
  catch { return null; }
  if (!checked) return null;
  const sess = await resolveStaffFromAhdUser(checked.identity.id, {
    iat: checked.issuedAt, emailFallback: checked.identity.email,
  });
  if (!sess) return null;
  if (_gameSessCache.size > 1000) _gameSessCache.clear();
  _gameSessCache.set(key, { session: sess,
    exp: Math.min(Date.now() + GAME_SESS_TTL_MS, checked.expiresAt * 1000) });
  return sess;
}

/** Cookie scope for ops_session.
 *
 * Without an explicit Domain a cookie is HOST-ONLY: minted on
 * ops.lakesidegames.net it is never sent to docs.lakesidegames.net.
 * That is what made signing in "glitchy" across the
 * Lakeside hosts — each one is a separate sign-in, and docs bounced to the AHD
 * login forever because the game cookie lives on a different registrable
 * domain and never comes back. Scoping to the parent domain makes one sign-in
 * cover every Lakeside surface.
 *
 * Host-derived, because this same process also serves ops.ahousedividedgame.com.
 * Anything else (localhost, an IP) stays host-only, which is the safe default.
 */
function cookieDomainFor(req) {
  const host = String((req && req.headers && req.headers.host) || "").split(":")[0].toLowerCase();
  if (host === "lakesidegames.net" || host.endsWith(".lakesidegames.net")) return "; Domain=.lakesidegames.net";
  if (host === "ahousedividedgame.com" || host.endsWith(".ahousedividedgame.com")) return "; Domain=.ahousedividedgame.com";
  return "";
}
function opsSessionCookie(req, token, maxAge) {
  return `ops_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax${cookieDomainFor(req)}; Max-Age=${maxAge}`;
}

/** Validate a post-sign-in destination. Returns an absolute https URL string or
 * null. Sign-in redirects are the classic open-redirect sink, so this is an
 * allowlist: same registrable domain as the ops hosts, nothing else. A
 * backslash, whitespace or control character is how a redirect target gets
 * smuggled past a naive parser, so reject those before parsing. */
function safeNextUrl(raw) {
  if (!raw || typeof raw !== "string" || raw.length > 512) return null;
  if (/[\\\s]/.test(raw)) return null; // whitespace or backslash: classic redirect-smuggling characters
  for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); if (c < 32 || c === 127) return null; }
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  const ok = h === "lakesidegames.net" || h.endsWith(".lakesidegames.net") ||
             h === "ahousedividedgame.com" || h.endsWith(".ahousedividedgame.com") ||
             OPS_SSO_HOSTS.includes(h);
  return ok ? u.toString() : null;
}
const { OpsLoginTransactions, stateTag } = require("./ops-login-transactions");
const credentialPortal = require("./credential-portal");
const opsLoginTransactions = new OpsLoginTransactions();
function clearNextCookie(req) {
  // Remove the old continuation cookie during the transition.
  return `ops_next=; Path=/; HttpOnly; Secure; SameSite=Lax${cookieDomainFor(req)}; Max-Age=0`;
}
function opsLoginOrigin(req) {
  const host = String(req.headers.host || "").toLowerCase();
  return OPS_SSO_HOSTS.includes(host) ? `https://${host}` : null;
}
// Sign-in failures used to answer with a bare text body and no Content-Type.
// With nosniff set, iOS Safari and in-app web views offer that body as a file
// download named after the path ("callback"), and the back button then walks
// through spent sign-in URLs. Every sign-in failure now renders a page that
// says what happened and restarts sign-in cleanly, and logs why it failed.
const SIGNIN_FAILURE_COPY = {
  origin: ["Sign-in can't start here", "Open ops at its usual address and sign in from there."],
  unavailable: ["Sign-in is unavailable", "The sign-in service did not answer. Try again in a minute."],
  busy: ["Sign-in is busy", "Too many sign-ins are in progress. Try again in a minute."],
  return: ["That sign-in link is not valid", "Start sign-in again from ops."],
  transaction: ["Sign-in did not finish", "Sign-in has to finish in the same browser it started in, within 10 minutes. If you tapped Sign in inside an app, open ops in Safari or Chrome and sign in there."],
};
function signinFailurePage(req, res, status, reason) {
  const ua = String(req.headers["user-agent"] || "");
  const client = /iPhone|iPad/.test(ua) ? (/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua) ? "ios-safari" : "ios-other")
    : /Android/.test(ua) ? "android" : "desktop";
  const hasLoginCookie = /(?:^|;\s*)__Host-ops_login=/.test(String(req.headers.cookie || ""));
  console.warn(`[sso] sign-in failed reason=${reason} status=${status} client=${client} loginCookie=${hasLoginCookie}`);
  const [title, body] = SIGNIN_FAILURE_COPY[reason.split(":")[0]] || SIGNIN_FAILURE_COPY.unavailable;
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f1a;color:#e2e8f0;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:30rem;padding:2rem}h1{font-size:1.35rem;margin:0 0 .5rem}p{color:#94a3b8}
.btn{display:inline-block;margin-top:.5rem;padding:.6rem 1.1rem;border-radius:.5rem;background:#6366f1;color:#fff;text-decoration:none;font-weight:600}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(body)}</p>
<a class="btn" href="/auth/game">Start sign-in again</a></main></body></html>`);
}

function loginSecurityHeaders(res) {
  addSecurityHeaders(res);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function mintOpsSession(res, { email, role, source, userId, revocationVersion }, location = "/", req = null, extraCookies = []) {
  const token = crypto.randomBytes(32).toString("hex");
  if (sessions.size >= MAX_SESSIONS) { const [oldest] = sessions.keys(); sessions.delete(oldest); }
  sessions.set(token, { created: Date.now(), email, role, source, userId, revocationVersion });
  markSessionsDirty();
  res.writeHead(302, {
    "Set-Cookie": [opsSessionCookie(req, token, 86400), ...extraCookies],
    Location: location,
  });
  res.end();
}

// In SSO mode the broker-minted ops session is the only credential path.
async function resolveSession(req) {
  if (AUTH_MODE === "sso") return checkSession(req);
  const game = await checkGameSession(req);
  if (game) return game;
  return checkSession(req);
}

function addSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; script-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://ollama.com https://api.kimi.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com;");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function json(res, status, body) {
  addSecurityHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatNumber(n) {
  if (n === null || n === undefined) return "—";
  if (typeof n === "number") {
    if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(2) + "T";
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toLocaleString();
  }
  return String(n);
}

// Redact password fields from documents
function redactSensitive(obj, depth = 0) {
  if (depth > 10) return "[max-depth]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (obj instanceof Date) return obj.toISOString();

  // Handle MongoDB ObjectId
  if (obj._bsontype === "ObjectId" || (typeof obj.toHexString === "function")) {
    return obj.toHexString();
  }

  // Handle MongoDB Binary / Buffer
  if (obj._bsontype === "Binary" || Buffer.isBuffer(obj)) {
    return "[binary:" + obj.length + " bytes]";
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitive(item, depth + 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("password") || lowerKey.includes("secret") || lowerKey.includes("token") || lowerKey.includes("apikey") || lowerKey.includes("privatekey")) {
      result[key] = "***";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitive(value, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// Rate limit state (simple in-memory)
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

function getClientIP(req) {
  // Trust rightmost X-Forwarded-For entry (set by Caddy) to prevent IP spoofing.
  // Caddy appends the real client IP as the last entry.
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const parts = xff.split(",").map(s => s.trim());
    return parts[parts.length - 1] || req.headers["x-real-ip"] || req.socket.remoteAddress;
  }
  return req.headers["x-real-ip"] || req.socket.remoteAddress;
}

function checkLoginRateLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  if (Date.now() - entry.lastAttempt > LOGIN_LOCKOUT_MS) {
    loginAttempts.delete(ip);
    return true;
  }
  return entry.count < MAX_LOGIN_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count++;
  entry.lastAttempt = Date.now();
  loginAttempts.set(ip, entry);
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// ─── HTML DASHBOARD ──────────────────────────────────────────────

// ─── UPTIME STATUS HISTORY ────────────────────────────────────────
// Persisted in SQLite (better-sqlite3) so uptime data survives restarts.
// In-memory cache is hydrated from DB on startup and flushed after each check.
const STATUS_HISTORY_DAYS = 90;
// 5-minute interval: the status bar only renders a daily aggregate, so 288
// samples/day/service is ample and ~1/5 the external traffic of minute checks.
const STATUS_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Uptime probes from config/dashboard.yaml (statusServices).
const STATUS_SERVICES = listStatusServices();

const STATUS_DB_PATH = path.join(__dirname, "data", "status-history.db");
fs.mkdirSync(path.dirname(STATUS_DB_PATH), { recursive: true });
const statusDb = new Database(STATUS_DB_PATH);
statusDb.exec(`
  CREATE TABLE IF NOT EXISTS status_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    up INTEGER NOT NULL,
    latency_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_status_checks_service_ts ON status_checks(service_id, ts);
`);

const insertCheckStmt = statusDb.prepare(
  "INSERT INTO status_checks (service_id, ts, up, latency_ms) VALUES (?, ?, ?, ?)"
);
const pruneChecksStmt = statusDb.prepare(
  "DELETE FROM status_checks WHERE ts < ?"
);
const loadChecksStmt = statusDb.prepare(
  "SELECT ts, up, latency_ms FROM status_checks WHERE service_id = ? AND ts > ? ORDER BY ts ASC"
);

function pruneOldChecks() {
  const cutoff = new Date(Date.now() - STATUS_HISTORY_DAYS * 86400000).toISOString();
  pruneChecksStmt.run(cutoff);
}

function loadStatusHistory() {
  const history = {};
  const cutoff = new Date(Date.now() - STATUS_HISTORY_DAYS * 86400000).toISOString();
  for (const s of STATUS_SERVICES) {
    const rows = loadChecksStmt.all(s.id, cutoff);
    history[s.id] = rows.map(r => ({
      ts: r.ts,
      up: r.up === 1,
      latencyMs: r.latency_ms,
    }));
  }
  return history;
}

// Collapse raw checks into one entry per calendar day so the public payload is
// ~90 objects/service instead of tens of thousands of raw samples.
function dailyRollups(checks) {
  const byDay = new Map();
  for (const c of checks) {
    const day = c.ts.slice(0, 10); // YYYY-MM-DD
    let r = byDay.get(day);
    if (!r) { r = { date: day, up: 0, total: 0 }; byDay.set(day, r); }
    r.total++;
    if (c.up) r.up++;
  }
  return Array.from(byDay.values())
    .map((r) => ({ date: r.date, pct: r.total ? Math.round((r.up / r.total) * 1000) / 10 : null, total: r.total }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// In-memory cache hydrated from DB
const statusHistory = loadStatusHistory();

// In-memory last-known up/down per service for transition detection.
const lastServiceUp = new Map();
function notifyStatusTransition(svc, up, latencyMs) {
  const prev = lastServiceUp.get(svc.id);
  lastServiceUp.set(svc.id, up);
  if (prev === undefined || prev === up) return; // seed silently / no change
  notifyOpsDiscord({
    kind: "status",
    title: up ? `✅ ${svc.name} is back UP` : `🔴 ${svc.name} is DOWN`,
    description: up
      ? `${svc.name} recovered and is responding again.`
      : `${svc.name} stopped responding to health checks.`,
    url: svc.pageUrl,
    color: up ? OPS_COLORS.green : OPS_COLORS.red,
    fields: [
      { name: "Service", value: svc.name, inline: true },
      { name: "State", value: up ? "up" : "down", inline: true },
      ...(up && latencyMs != null ? [{ name: "Latency", value: latencyMs + "ms", inline: true }] : []),
    ],
    footer: "Uptime monitor",
  }).catch(() => {});
}

async function runStatusChecks() {
  const now = new Date().toISOString();
  for (const s of STATUS_SERVICES) {
    const start = Date.now();
    let up = false;
    let latencyMs = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(s.url, { signal: ctrl.signal });
      clearTimeout(timer);
      latencyMs = Date.now() - start;
      up = r.ok;
    } catch {
      up = false;
      latencyMs = null;
    }
    // Persist to SQLite
    insertCheckStmt.run(s.id, now, up ? 1 : 0, latencyMs);
    // Update in-memory cache
    if (!statusHistory[s.id]) statusHistory[s.id] = [];
    statusHistory[s.id].push({ ts: now, up, latencyMs });
    // Discord on state transition (up→down / down→up), deduped in-memory so we
    // only post on change, never every tick. First observation seeds silently.
    notifyStatusTransition(s, up, latencyMs);
  }
  // Prune old records from DB and memory
  pruneOldChecks();
  const cutoff = Date.now() - STATUS_HISTORY_DAYS * 86400000;
  for (const s of STATUS_SERVICES) {
    statusHistory[s.id] = statusHistory[s.id].filter(e => new Date(e.ts).getTime() > cutoff);
  }
}
// Initial check + interval
runStatusChecks().catch(() => {});
setInterval(() => runStatusChecks().catch(() => {}), STATUS_CHECK_INTERVAL_MS);

// ─── SANDBOX: GIT REPO FOR CODEBASE Q&A ────────────────────────────
// Keeps a shallow clone of the AHD repo for context retrieval.
// Auto-pulls periodically so it stays current without manual intervention.

const { execSync } = require("child_process");

function sandboxGit(args, timeout = 15000) {
  return execSync(`git ${args}`, {
    cwd: SANDBOX_DIR, timeout, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/**
 * Keep the Q&A clone on the branch questions are actually about.
 *
 * This was a bare `git pull --ff-only`, which updates whatever branch the clone
 * was left on. The AHD repo's default is `master` — released code — so a clone
 * made from the default answered from a branch that can sit weeks behind what
 * the asker just merged, and answered confidently, which reads as the model
 * being wrong rather than the checkout being stale.
 *
 * The branch is explicit and re-asserted every cycle, so drift from a manual
 * checkout or a re-clone corrects itself on the next pull.
 */
function sandboxGitPull() {
  try {
    if (!fs.existsSync(path.join(SANDBOX_DIR, ".git"))) {
      console.log("[sandbox] No clone found at", SANDBOX_DIR, "— skipping pull");
      return;
    }
    sandboxGit(`fetch --prune origin ${SANDBOX_BRANCH}`, 30000);
    const current = sandboxGit("rev-parse --abbrev-ref HEAD", 10000);
    if (current === SANDBOX_BRANCH) {
      sandboxGit("merge --ff-only FETCH_HEAD", 30000);
    } else {
      // Nothing edits this clone — it is a read-only retrieval copy — so moving
      // it onto the tracking branch cannot discard anyone's work.
      sandboxGit(`checkout -B ${SANDBOX_BRANCH} origin/${SANDBOX_BRANCH}`, 30000);
      console.log(`[sandbox] Switched from ${current} to ${SANDBOX_BRANCH}`);
    }
    console.log(`[sandbox] Up to date on ${sandboxRevision()?.label || SANDBOX_BRANCH}`);
  } catch (e) {
    console.error("[sandbox] Git sync failed:", e.message?.slice(0, 200) || e);
  }
}

/**
 * The commit answers are being read from, so a citation to a path and line
 * points at something a reader can actually go and check.
 */
function sandboxRevision() {
  try {
    if (!fs.existsSync(path.join(SANDBOX_DIR, ".git"))) return null;
    const branch = sandboxGit("rev-parse --abbrev-ref HEAD", 5000);
    const short = sandboxGit("rev-parse --short HEAD", 5000);
    return { branch, short, label: `${branch}@${short}` };
  } catch {
    return null;
  }
}
sandboxGitPull();
setInterval(() => { sandboxGitPull(); rebuildSandboxIndexes(); }, SANDBOX_PULL_INTERVAL);
// Build the search index + codebase map once at startup. Deferred with
// setImmediate so it runs after the module's later const definitions are
// initialised (the builders reference SANDBOX_IGNORE_DIRS etc. defined below).
setImmediate(() => { rebuildSandboxIndexes(); initTransformers(); });

// Build context snippets from the sandbox for a user question.
// Strategy: extract keywords, find relevant files, return top snippets.
const SANDBOX_IGNORE_DIRS = ["node_modules", ".next", ".git", "coverage", "dist", "out", "e2e", "__tests__", "audit-reports", "docs", "plans", "wiki", "design", "memory", ".claude", "shared", "scripts", "public"];
const SANDBOX_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json"];
const SANDBOX_IGNORE_PATTERNS = [".test.", ".spec.", "__tests__", ".d.ts"];

// Static codebase map — hand-curated fallback used when the sandbox isn't
// available to auto-generate a live map (see buildCodebaseMap below).
// This prevents hallucinated paths and gives instant orientation.
const STATIC_CODEBASE_MAP = `
AHD Codebase Architecture Map
══════════════════════════════
src/app/api/ — API route handlers
  cron/turn/route.ts          → Turn processing (hourly cron)
  auth/                       → NextAuth config + routes
  settings/status-bar/route.ts → Status bar endpoint
src/lib/ — Core game logic (this is where mechanics live)
  turn/                       → Turn pipeline: processTurn, processActionRefresh, processFundGeneration, etc.
  economy/                    → GDP, inflation, taxation, bonds, centralBank
  elections/                  → Election engine, vote tallying, primaries, generals
  campaigns/                  → Campaign actions, canvassing, GOTV, advertising
  parties/                    → Party management, whips, caucuses, analytics
  congress/                   → Bill lifecycle, voting, committees
  budget/                     → Federal/state budgets
  commodity-map/               → Commodity supply/demand pricing
  forex/                       → Currency exchange
  corporation/ && corporations/ → Corporations, stocks, investment funds
  countryState/ && countrySystems/ → Country-level state & systems
  crises/                      → Crisis subsystems (economic, political, military)
  npp/ && npps/                → NPC/NPP behavior
  character/                  → Character creation & state
  policy/                     → Policy effects & approval
  statusBar/                  → Client status bar data
  actions/                    → Available actions system
  db/                         → MongoDB models & connection
  gameConfig/                 → Game constants & configuration
  migrations/                 → Database migrations
src/components/ — React UI components (per domain)
  congress/, elections/, parties/, budget/, etc.
src/hooks/                    → React hooks
src/types/                    → TypeScript type definitions
`.trim();
const MAX_CONTEXT_FILES = 120;
const MAX_CONTEXT_CHARS = 500000;

function extractKeywords(question) {
  const stops = new Set(["what","how","why","the","is","are","does","do","a","an","in","on","at","to","for","of","with","by","from","this","that","it","its","and","or","but","can","could","would","should","i","me","my","we","our","be","been","being","have","has","had","not","no","so","if","then","than","too","very","just","about","also","some","any","all","each","every","which","where","when","who","whom","whose","there","here","these","those","am","was","were","been","did","will","shall","may","might","must","need","dare","ought","used","into","more","most","over","such","after","before","between","under","again","further","once","other","only","same","own","up","down","out","off","through","during","without","against","because","until","while","although","though","even","still","much","many","well","like","really","actually","basically","literally","please","explain","tell","show","describe","works","work","mean","purpose","effect","impact","calculate","computed"]);
  return question.toLowerCase().replace(/[^a-z0-9_\s./-]/g, " ").split(/\s+/).filter(w => w.length > 2 && !stops.has(w));
}

function findRelevantFiles(question) {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return [];

  const results = [];
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!shouldIndexAskDirectory(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!SANDBOX_EXTENSIONS.some(ext => entry.name.endsWith(ext))) continue;
        if (SANDBOX_IGNORE_PATTERNS.some(p => entry.name.includes(p))) continue;
        const relPath = full.replace(SANDBOX_DIR, "").replace(/^\/+/, "");
        const lower = relPath.toLowerCase();
        if (SANDBOX_IGNORE_PATTERNS.some(p => lower.includes(p))) continue;
        let score = 0;
        for (const kw of keywords) {
          if (lower.includes(kw)) score += 2;
        }
        if (lower.includes("/src/")) score += 1;
        if (score > 0) results.push({ path: full, relPath, lowerRelPath: lower, score });
      }
    } catch {}
  }

  walk(SANDBOX_DIR);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, MAX_CONTEXT_FILES);
}

function buildContext(question) {
  return buildContextFromFiles(findRelevantFiles(question));
}

function buildContextFromFiles(files) {
  if (!files || files.length === 0) return "No relevant source files found in the codebase for this question.";

  let total = 0;
  let context = "";
  for (const f of files) {
    try {
      const content = fs.readFileSync(f.path, "utf8");
      const maxFileLen = 100000;
      const snippet = content.length > maxFileLen ? content.slice(0, maxFileLen) + "\n... (truncated)" : content;
      const relPath = f.relPath.replace(/^\/+/, "");
      const header = "\n--- FILE: " + relPath + " ---\n";
      if (total + header.length + snippet.length > MAX_CONTEXT_CHARS) break;
      context += header + snippet + "\n";
      total += header.length + snippet.length;
    } catch {}
  }
  return context || "Could not read any source files.";
}

// Extract the first leading comment line from a source file as a one-line
// description. Returns null if the file doesn't open with a comment.
function firstCommentLine(content) {
  const lines = content.split("\n", 40);
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("//")) return t.replace(/^\/+\s?/, "").slice(0, 90);
    if (t.startsWith("/*") || t.startsWith("*")) {
      const cleaned = t.replace(/^[/*]+\s?/, "").replace(/\*\/\s*$/, "").trim();
      if (cleaned) return cleaned.slice(0, 90);
      continue; // bare "/*" — look at the next line
    }
    return null; // first meaningful line isn't a comment
  }
  return null;
}

// Build a lightweight file index (path + size + description + top exports/types)
// instead of full file contents. This gives the model a map of what's available —
// and enough of a signature to make good read_file decisions — without burning
// tokens on entire files.
function buildFileIndex(files) {
  if (!files || files.length === 0) return "No relevant source files found.";
  let index = "Relevant files (use read_file / read_files to examine):\n";
  for (const f of files) {
    try {
      const relPath = f.relPath.replace(/^\/+/, "");
      const stat = fs.statSync(f.path);
      const sizeKb = Math.round(stat.size / 1024);
      const head = fs.readFileSync(f.path, "utf8").slice(0, 2500);
      index += `  ${relPath} (${sizeKb}KB`;
      // Scan for exports/exports-default for quick orientation
      const exportNames = [];
      const exportMatch = head.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g);
      for (const m of exportMatch) exportNames.push(m[1]);
      const defaultExport = head.match(/export\s+default\s+(?:function\s+)?(\w+)/);
      if (defaultExport) exportNames.unshift(defaultExport[1] + " (default)");
      if (exportNames.length) index += `, exports: ${exportNames.slice(0, 8).join(", ")}${exportNames.length > 8 ? "…" : ""}`;
      index += `)`;
      // Show the most relevant chunk line range when available (from semantic rerank)
      if (f.bestChunk && f.bestChunk.startLine > 1) {
        index += ` [lines ${f.bestChunk.startLine}–${f.bestChunk.endLine} most relevant]`;
      }
      // First-line comment gives the model a human-readable hint of intent
      const desc = firstCommentLine(head);
      if (desc) index += ` — ${desc}`;
      index += `\n`;
    } catch {}
  }
  return index;
}

// ask-public has no source-file tool loop, so inject the reranker's actual best
// chunks. A path-only index makes a tool-less model guess at the implementation.
function buildSourceContext(files, maxChars = 18000) {
  if (!files || !files.length) return null;
  const blocks = [];
  let budget = maxChars;
  for (const f of files) {
    let text = f.bestChunk && f.bestChunk.text;
    let range = "";
    if (text && f.bestChunk.startLine) range = ` (lines ${f.bestChunk.startLine}-${f.bestChunk.endLine})`;
    if (!text) {
      try { text = fs.readFileSync(f.path, "utf8").slice(0, 2400); } catch { continue; }
    }
    if (text.length > 6000) text = text.slice(0, 6000);
    if (text.length > budget) continue;
    budget -= text.length;
    blocks.push(`--- ${f.relPath.replace(/^\/+/, "")}${range} ---\n${text}`);
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

// ─── SEMANTIC RETRIEVAL: TF-IDF OVER FILE CONTENTS ─────────────────
// Keyword scoring on paths alone misses files whose contents are relevant but
// whose name doesn't match the query (e.g. "inflation" lives in gdpGrowth.ts).
// We build a lightweight TF-IDF index over file *contents* and blend it with the
// existing path-name scoring so both signals contribute.
const SEARCH_INDEX_MAX_FILES = 5000;
const SEARCH_INDEX_MAX_FILE_CHARS = 60000;
const SEARCH_INDEX_TERMS_PER_FILE = 140; // cap per-file terms to bound memory
// Common code/English tokens that carry little retrieval signal.
const CODE_STOPWORDS = new Set([
  "the","and","for","this","that","with","from","import","export","const","let","var",
  "function","return","async","await","type","interface","class","enum","extends","implements",
  "public","private","protected","static","readonly","void","null","undefined","true","false",
  "string","number","boolean","object","array","promise","record","partial","new","new",
  "default","case","switch","break","continue","else","catch","try","throw","typeof","instanceof",
  "console","log","error","warn","map","set","get","data","value","name","props","state","react",
  "use","useeffect","usestate","component","children","style","class","classname","div","span",
]);

// Split a camelCase / snake_case identifier into lowercase subterms so that
// "gdpGrowthRate" indexes under gdp, growth, rate (and the whole token).
function splitIdentifier(word) {
  const parts = word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const lower = word.toLowerCase();
  if (parts.length > 1) parts.push(lower); // keep the joined form too
  return parts;
}

// Build the TF-IDF index by walking the sandbox once. Cheap relative to a query
// round-trip, and rebuilt only on startup + after each git pull.
function buildSearchIndex() {
  const files = [];
  const df = new Map();
  const seenFiles = new Set();
  let count = 0;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= SEARCH_INDEX_MAX_FILES) return;
      if (!shouldIndexAskDirectory(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (seenFiles.has(full)) continue;
      if (!SANDBOX_EXTENSIONS.some(ext => entry.name.endsWith(ext))) continue;
      if (SANDBOX_IGNORE_PATTERNS.some(p => entry.name.includes(p))) continue;
      seenFiles.add(full);
      let content;
      try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (content.length > SEARCH_INDEX_MAX_FILE_CHARS) content = content.slice(0, SEARCH_INDEX_MAX_FILE_CHARS);
      const relPath = full.replace(SANDBOX_DIR, "").replace(/^\/+/, "");
      const lower = relPath.toLowerCase();
      if (SANDBOX_IGNORE_PATTERNS.some(p => lower.includes(p))) continue;
      const tf = new Map();
      for (const m of content.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) {
        for (const t of splitIdentifier(m[0])) {
          if (t.length < 3 || CODE_STOPWORDS.has(t)) continue;
          tf.set(t, (tf.get(t) || 0) + 1);
        }
      }
      // Index path tokens too so filename terms count toward content score
      for (const t of splitIdentifier(relPath.replace(/[./-]/g, " "))) {
        if (t.length >= 3 && !CODE_STOPWORDS.has(t)) tf.set(t, (tf.get(t) || 0) + 3);
      }
      let terms = [...tf.entries()];
      if (terms.length > SEARCH_INDEX_TERMS_PER_FILE) {
        terms.sort((a, b) => b[1] - a[1]);
        terms = terms.slice(0, SEARCH_INDEX_TERMS_PER_FILE);
      }
      const tfMap = new Map(terms);
      for (const t of tfMap.keys()) df.set(t, (df.get(t) || 0) + 1);
      files.push({ path: full, relPath, lowerRelPath: lower, tf: tfMap });
      count++;
    }
  }
  for (const root of getAskSearchRoots(SANDBOX_DIR)) walk(root);
  SEARCH_INDEX = { ready: files.length > 0, N: files.length, df, files };
  return SEARCH_INDEX;
}

// Rank relevant files using blended TF-IDF (content) + keyword (path) scoring.
// Falls back to the original path-only walk when the index isn't ready.
function findRelevantFilesRanked(question, limit) {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return [];
  if (!SEARCH_INDEX.ready) return findRelevantFiles(question);

  // Expand query keywords into camelCase/snake subterms to match split tokens.
  const qterms = new Set();
  for (const kw of keywords) for (const t of splitIdentifier(kw)) if (t.length > 2) qterms.add(t);

  const N = SEARCH_INDEX.N;
  const scored = [];
  for (const f of SEARCH_INDEX.files) {
    let content = 0;
    for (const t of qterms) {
      const tf = f.tf.get(t);
      if (!tf) continue;
      const idf = Math.log(1 + N / ((SEARCH_INDEX.df.get(t) || 0) + 1));
      content += Math.log(1 + tf) * idf;
    }
    // Path/name keyword bonus (preserves the prior behaviour's intent)
    let pathScore = 0;
    for (const kw of keywords) if (f.lowerRelPath.includes(kw)) pathScore += 2;
    if (f.lowerRelPath.includes("/src/")) pathScore += 1;
    const score = pathScore * 2 + content;
    if (score > 0) scored.push({ path: f.path, relPath: f.relPath, lowerRelPath: f.lowerRelPath, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || MAX_CONTEXT_FILES);
}

// ─── DYNAMIC CODEBASE MAP ──────────────────────────────────────────
// The static map goes stale as code moves. Generate a live map from the sandbox
// (directory tree + first-line comments) so orientation is always current.
let DYNAMIC_CODEBASE_MAP = null;
function buildCodebaseMap() {
  if (!fs.existsSync(SANDBOX_DIR)) return null;
  const ROOTS = [
    ["src/app/api", "API route handlers"],
    ["src/lib", "Core game logic (mechanics live here)"],
    ["src/components", "React UI components"],
    ["src/hooks", "React hooks"],
    ["src/types", "TypeScript type definitions"],
  ];
  const CAP = 8000;
  let out = "AHD Codebase Architecture Map (auto-generated from sandbox)\n══════════════════════════════\n";
  let chars = out.length;
  for (const [root, desc] of ROOTS) {
    const base = path.join(SANDBOX_DIR, root);
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    out += `${root}/ — ${desc}\n`;
    const subdirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith(".") && !SANDBOX_IGNORE_DIRS.includes(e.name))
      .map(e => e.name).sort();
    for (const d of subdirs) {
      if (chars > CAP) break;
      let info = "";
      try {
        const sub = path.join(base, d);
        const files = fs.readdirSync(sub).filter(n =>
          SANDBOX_EXTENSIONS.some(x => n.endsWith(x)) && !SANDBOX_IGNORE_PATTERNS.some(p => n.includes(p)));
        info = `${files.length} file${files.length === 1 ? "" : "s"}`;
      } catch {}
      const line = `  ${d}/  (${info})\n`;
      out += line; chars += line.length;
    }
    const directFiles = entries
      .filter(e => e.isFile() && SANDBOX_EXTENSIONS.some(x => e.name.endsWith(x)) && !SANDBOX_IGNORE_PATTERNS.some(p => e.name.includes(p)))
      .map(e => e.name).sort().slice(0, 12);
    for (const fn of directFiles) {
      if (chars > CAP) break;
      let cmt = null;
      try { cmt = firstCommentLine(fs.readFileSync(path.join(base, fn), "utf8")); } catch {}
      const line = `  ${fn}${cmt ? ` → ${cmt}` : ""}\n`;
      out += line; chars += line.length;
    }
    if (chars > CAP) { out += "  …(truncated)\n"; break; }
  }
  return out.trim();
}
// Prefer the live map; fall back to the curated static map if generation failed.
function getCodebaseMap() {
  return DYNAMIC_CODEBASE_MAP || STATIC_CODEBASE_MAP;
}

// Rebuild both sandbox-derived artefacts (search index + codebase map).
function rebuildSandboxIndexes() {
  try { buildSearchIndex(); } catch (e) { console.error("[sandbox] search index build failed:", e.message); }
  try { DYNAMIC_CODEBASE_MAP = buildCodebaseMap(); } catch (e) { console.error("[sandbox] codebase map build failed:", e.message); }
  SEMANTIC_EMBED_CACHE.clear(); // invalidate embedding cache after codebase changes
  console.log(`[sandbox] indexes ready: ${SEARCH_INDEX.N} files, codebase map ${DYNAMIC_CODEBASE_MAP ? "live" : "static"}`);
}

// ─── FILE-READ CACHE ───────────────────────────────────────────────
// Mods often ask several questions about the same system, re-reading the same
// files. An LRU cache (keyed by resolved path, invalidated on mtime change)
// cuts both latency and repeated disk I/O across questions.
const FILE_CACHE = new Map();
const FILE_CACHE_MAX = 96;
const READ_MAX_FILE_LEN = 100000;
function readFileCached(resolvedPath) {
  let stat;
  try { stat = fs.statSync(resolvedPath); } catch { return null; }
  const cached = FILE_CACHE.get(resolvedPath);
  if (cached && cached.mtime === stat.mtimeMs) {
    // Touch for LRU recency
    FILE_CACHE.delete(resolvedPath);
    FILE_CACHE.set(resolvedPath, cached);
    return cached;
  }
  let raw;
  try { raw = fs.readFileSync(resolvedPath, "utf8"); } catch { return null; }
  const rawLen = raw.length;
  const content = rawLen > READ_MAX_FILE_LEN ? raw.slice(0, READ_MAX_FILE_LEN) + "\n... (truncated)" : raw;
  const entry = { mtime: stat.mtimeMs, content, rawLen };
  FILE_CACHE.set(resolvedPath, entry);
  if (FILE_CACHE.size > FILE_CACHE_MAX) {
    const oldest = FILE_CACHE.keys().next().value;
    FILE_CACHE.delete(oldest);
  }
  return entry;
}

// Speculative prefetch: warm the cache with small sibling files in the same
// directory. Cheap (bounded count + size, no SSE, not counted as a read) — if
// the model reads draftCharter.ts next it'll likely want signCharter.ts too.
const PREFETCH_MAX_SIBLINGS = 5;
const PREFETCH_MAX_BYTES = 40000;
function prefetchSiblings(resolvedPath) {
  try {
    const dir = path.dirname(resolvedPath);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let warmed = 0;
    for (const e of entries) {
      if (warmed >= PREFETCH_MAX_SIBLINGS) break;
      if (!e.isFile()) continue;
      if (!SANDBOX_EXTENSIONS.some(x => e.name.endsWith(x))) continue;
      if (SANDBOX_IGNORE_PATTERNS.some(p => e.name.includes(p))) continue;
      const full = path.join(dir, e.name);
      if (full === resolvedPath || FILE_CACHE.has(full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.size > PREFETCH_MAX_BYTES) continue;
      readFileCached(full); // populates the LRU cache
      warmed++;
    }
  } catch {}
}

// Resolve + read one file for a tool call, emitting SSE progress events.
// Returns the string content to feed back to the model as the tool result.
function handleFileReadRequest(displayPath, allRelevantFiles, filesRead, sse) {
  const resolvedPath = resolveFilePath(displayPath, allRelevantFiles);
  if (!resolvedPath) {
    const similar = allRelevantFiles.slice(0, 10).map(f => f.relPath).join("\n  ");
    sse("file_error", { path: displayPath, error: "File not found" });
    return `Error: File not found: "${displayPath}".\n\nCheck the codebase map for correct paths. Relevant files:\n  ${similar || "(none found)"}\n\nDo not retry the same path. Use paths from the map or this list.`;
  }
  const entry = readFileCached(resolvedPath);
  if (!entry) {
    sse("file_error", { path: displayPath, error: "Read error" });
    return "Error: Could not read file.";
  }
  filesRead.add(displayPath);
  sse("file_read", { path: displayPath, size: entry.rawLen });
  prefetchSiblings(resolvedPath);
  return entry.content;
}

// Rate limit for /api/ask: 20 requests per session per hour
const askRateLimits = new Map();

// ─── Q&A PERSISTENCE ───────────────────────────────────────────────
// Persist questions + answers + metadata to a dedicated, namespaced collection
// (separate from game data). Best-effort: a logging failure must never break a
// running answer, so every call is guarded and fire-and-forget.
async function logQa(doc) {
  try {
    const db = await getDb();
    await db.collection("ops_qa_log").insertOne({
      _id: doc.id,
      question: doc.question,
      answer: (doc.answer || "").slice(0, 12000),
      mode: doc.mode,
      quality: doc.quality,
      model: doc.model,
      files: doc.files || [],
      usage: doc.usage || {},
      email: doc.email || null,
      feedback: null,
      createdAt: new Date(),
    });
  } catch (e) {
    console.error("[ask] qa log failed:", e.message);
  }
}

// ─── HTML DASHBOARD ──────────────────────────────────────────────
// ─── SHARED UI: FONTS + DESIGN SYSTEM ────────────────────────────
// Single source of truth for the dashboard look & feel. Every page
// composes its <style> from BASE_CSS so radii, shadows, spacing,
// opacity tiers and type scale stay identical across the app.


// ─── APPS LAUNCHER ───────────────────────────────────────────────────
const APPS = [
  { name: "Database Explorer", desc: "Query any collection with redaction, paging and filters.", icon: "database", href: "/db", minRole: "admin" },
  { name: "Backups", desc: "Browse mongodump archives; download BSON / JSON.", icon: "package", href: "/backups", minRole: "admin" },
  { name: "Worktree Lifecycle", desc: "Uncommitted, unlanded, and safely prunable Git checkouts across the fleet.", icon: "git-branch", href: "/worktrees", minRole: "admin" },
  { name: "Event Recovery", desc: "Inspect failed platform events and replay them after repair.", icon: "activity", href: "/events", minRole: "admin" },
  { name: "Credentials", desc: "Send approved credentials to production deployments.", icon: "lock", href: "/settings/credentials", minRole: "admin" },
  { name: "Kanban", desc: "Product kanban: now, next, blocked, backlog, owner decisions and stale work. Agents use the same board over MCP.", icon: "check-square", href: "/kanban", minRole: "admin" },
  { name: "Keir hub", desc: "Live Keir workers, tickets with fix progress, pull requests and CI, issues, kanban and decisions waiting on you.", icon: "activity", href: "/keir", minRole: "admin" },
  { name: "Keir inbox", desc: "Keir conversations across DMs, tickets, channels and threads, with staff replies and reward claims.", icon: "message-square", href: "/inbox", minRole: "admin" },
  { name: "Tracker", desc: "Long-running projects, goals and checklists across every game and realm of work.", icon: "check-square", href: "/tracker", minRole: "admin" },
  { name: "Tickets", desc: "Triage community bug reports with read-only AI assessments.", icon: "life-buoy", href: "/tickets", minRole: "admin" },
  { name: "Suggestions", desc: "Review community feature suggestions with AI assessments.", icon: "lightbulb", href: "/suggestions", minRole: "admin" },
  { name: "Ask", desc: "AI Q&A about the A House Divided codebase.", icon: "message", href: "/ask", minRole: "moderator" },
  ...(LEARN_INSTALLED ? [{ name: "Learning Center", desc: "Interactive game-mechanics & architecture modules.", icon: "graduation-cap", href: "/learn", minRole: "admin" }] : []),
  { name: "Project Guide", desc: "Architecture & systems reference for the codebase.", icon: "book-open", href: "/project-guide", minRole: "admin" },
  { name: "Status", desc: "Public server / uptime status page.", icon: "activity", href: "/status", minRole: "moderator" },
  { name: "Error Tracking", desc: "GlitchTip issues, crashes & breadcrumbs.", icon: "shield-alert", href: "https://ops.lakesidegames.net/errors", minRole: "admin", external: true },
  { name: "Workflows (CI/CD)", desc: "Woodpecker pipelines & build status.", icon: "git-branch", href: "https://workflows.lakesidegames.net", minRole: "admin", external: true },
];

const APPS_CSS = `
.apps-head{padding:var(--s-8) 0 var(--s-6)}
.apps-head h1{font-size:clamp(1.5rem,3vw,2rem);font-weight:800;letter-spacing:-.025em}
.apps-head p{color:var(--text-3);margin-top:.35rem;font-size:.9rem}
.apps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:var(--s-4)}
.app-card{position:relative;display:flex;flex-direction:column;gap:var(--s-3);padding:var(--s-5);border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e1),var(--hi);transition:transform var(--t),border-color var(--t),box-shadow var(--t)}
.app-card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--accent) 50%,var(--border));box-shadow:var(--shadow)}
.app-card .ico{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:var(--r-md);background:var(--accent-soft);color:var(--accent)}
.app-card h3{font-size:1rem;font-weight:700;color:var(--text)}
.app-card p{font-size:.82rem;color:var(--text-3);line-height:1.5;flex:1}
.app-card .go{display:inline-flex;align-items:center;gap:.3rem;color:var(--accent);font-size:.8rem;font-weight:600}
.app-ext{position:absolute;top:var(--s-4);right:var(--s-4);color:var(--text-3)}
`;

function renderAppsPage(role) {
  const visible = APPS.filter((a) => role === "admin" || a.minRole === "moderator");
  const cards = visible
    .map((a) => {
      const ext = a.external ? ` target="_blank" rel="noopener"` : "";
      const extIco = a.external ? `<span class="app-ext">${icon("external-link", { size: 14 })}</span>` : "";
      return `<a class="app-card" href="${a.href}"${ext}>${extIco}<span class="ico">${icon(a.icon, { size: 22 })}</span><h3>${a.name}</h3><p>${a.desc}</p><span class="go">Open ${icon("arrow-right", { size: 14 })}</span></a>`;
    })
    .join("");
  return renderShell({
    title: "Apps",
    active: "/apps",
    role,
    extraCss: APPS_CSS,
    body: `<div class="apps-head"><h1>Apps</h1><p>Operational tools, reports and services for A House Divided.</p></div><div class="apps-grid">${cards}</div>`,
  });
}

// ─── DASHBOARD LANDING (authenticated admins) ────────────────────────
const DASH_CSS = `
.ambient-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--s-4);margin-bottom:var(--s-5)}
.ambient-grid .host-health{margin:0}
.ambient-grid .host-health-ring{max-width:110px}
.ambient-engine{display:flex;flex-direction:column;gap:var(--s-4);padding:clamp(1rem,3vw,1.5rem);border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e1);position:relative;overflow:hidden}
.ambient-engine::before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:var(--green)}
.ambient-engine.warn::before{background:var(--amber)}.ambient-engine.bad::before,.ambient-engine.unknown::before{background:var(--red)}
.ambient-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3)}
.ambient-head h2{font-size:var(--fs-h3);letter-spacing:-.015em}
.ambient-head a{color:var(--accent);font-size:var(--fs-xs);font-weight:650;text-decoration:none}
.ambient-state{font-size:clamp(1.25rem,3vw,1.7rem);font-weight:750;letter-spacing:-.025em;line-height:1.2}
.ambient-state small{display:block;margin-top:.25rem;font-size:var(--fs-xs);font-weight:500;color:var(--text-3);letter-spacing:0}
.ambient-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s-2);margin-top:auto}
.ambient-fact{border-top:1px solid var(--border);padding-top:var(--s-3);min-width:0}
.ambient-fact b{display:block;font:700 var(--fs-h3) var(--mono);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ambient-fact span{display:block;margin-top:.25rem;color:var(--text-3);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.07em}
@media(max-width:920px){.ambient-grid{grid-template-columns:1fr}}
.ops-shortcuts{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:var(--s-3);margin:var(--s-4) 0 var(--s-6)}
.ops-shortcut{display:flex;align-items:center;gap:var(--s-3);padding:var(--s-3) var(--s-4);border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);color:var(--text);font-size:var(--fs-sm);font-weight:650;text-decoration:none;transition:border-color var(--t),background var(--t)}
.ops-shortcut:hover,.ops-shortcut:focus-visible{border-color:var(--accent);background:var(--accent-soft)}
.ops-shortcut svg{color:var(--accent)}
.dash-meta{display:flex;align-items:center;gap:.45rem;color:var(--text-3);font-size:var(--fs-xs);padding:var(--s-5) 0 var(--s-4)}
.dash-meta .live{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 7px var(--ok)}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));gap:var(--s-4);margin-bottom:var(--s-4)}
@media(max-width:1000px){.kpi-row{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.kpi-row{grid-template-columns:1fr}}
.tile{border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e1),var(--hi);padding:var(--s-4) var(--s-5);display:flex;flex-direction:column;min-height:112px}
.tile .tlabel{font-size:var(--fs-2xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);display:flex;align-items:center;gap:.4rem}
.tile .tnum{font-size:1.85rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15;margin-top:.3rem}
.tile .tsub{font-size:var(--fs-xs);color:var(--text-3);margin-top:auto;padding-top:.45rem}
.tile.alert .tnum{color:var(--danger)}
.spark{display:block;width:100%;height:26px;margin-top:.35rem;color:var(--accent)}
a.tile{text-decoration:none;color:inherit;transition:border-color var(--t),transform var(--t)}
a.tile:hover{border-color:var(--border-2);transform:translateY(-1px)}
.dcard h2 .viewlink{margin-left:auto;font-size:var(--fs-2xs);font-weight:600;text-transform:none;letter-spacing:0;color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;gap:.15rem}
.dcard h2 .viewlink:hover{color:var(--accent-hover)}
.dcard h2 .viewlink .icon{color:inherit}
.dash-grid{display:grid;grid-template-columns:repeat(12,1fr);gap:var(--s-4)}
.dcard{border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e1),var(--hi);padding:var(--s-5)}
.dcard h2{font-size:var(--fs-2xs);font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);display:flex;align-items:center;gap:.4rem;margin-bottom:var(--s-4)}
.dcard h2 .icon{color:var(--text-3)}
.col-4{grid-column:span 4}.col-6{grid-column:span 6}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
@media(max-width:860px){.col-4,.col-6,.col-8{grid-column:span 12}}
.up-row{display:flex;align-items:center;justify-content:space-between;padding:.55rem 0;border-bottom:1px solid var(--border);font-size:var(--fs-body)}
.up-row:last-child{border-bottom:none}
.up-name{display:flex;align-items:center;gap:.55rem;color:var(--text-2)}
.up-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.up-dot.ok{background:var(--ok);box-shadow:0 0 6px var(--ok)}.up-dot.bad{background:var(--danger);box-shadow:0 0 6px var(--danger)}
.up-lat{color:var(--text-3);font-family:var(--mono);font-size:var(--fs-xs)}
.rail-row{display:flex;align-items:center;justify-content:space-between;padding:.5rem 0;font-size:var(--fs-body);border-bottom:1px solid var(--border)}
.rail-row:last-child{border-bottom:none}
.pill{font-size:var(--fs-2xs);font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:.18rem .5rem;border-radius:var(--r-full);border:1px solid var(--border);white-space:nowrap}
.pill.ok{color:var(--ok);background:var(--green-soft);border-color:transparent}
.pill.bad{color:var(--danger);background:var(--red-soft);border-color:transparent}
.pill.warn{color:var(--warn);background:var(--amber-soft);border-color:transparent}
.empty-note{color:var(--text-3);font-size:var(--fs-sm);line-height:1.55}
.empty-note code{font-family:var(--mono);font-size:var(--fs-xs);background:var(--glass-2);padding:1px 5px;border-radius:4px;color:var(--text-2)}
.iss-row{display:flex;align-items:center;gap:.5rem;padding:.45rem 0;font-size:var(--fs-sm);border-bottom:1px solid var(--border)}
.iss-row:last-child{border-bottom:none}
.iss-row .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-2)}
.iss-row .n{color:var(--text-3);font-family:var(--mono);font-size:var(--fs-xs)}
.statgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:var(--s-5)}
.statgrid .s{display:flex;flex-direction:column;gap:.18rem}
.statgrid .s .n{font-size:1.4rem;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.1}
.statgrid .s .l{font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:600}
.statgrid .s .d{font-size:var(--fs-xs);color:var(--ok);margin-top:.05rem}
.llm-bar{display:flex;width:100%;height:16px;border-radius:var(--r-full);overflow:hidden;border:1px solid var(--border);background:var(--glass-2)}
.llm-seg{height:100%;transition:width var(--t)}
.llm-seg.kimi{background:var(--accent)}
.llm-seg.ollama{background:var(--warn,#f5a623)}
.llm-legend{display:flex;flex-wrap:wrap;gap:var(--s-5);margin-top:var(--s-4)}
.llm-key{display:flex;align-items:center;gap:.45rem;font-size:var(--fs-sm);color:var(--text-2);font-variant-numeric:tabular-nums}
.llm-dot{width:9px;height:9px;border-radius:3px;flex-shrink:0}
.llm-dot.kimi{background:var(--accent)}
.llm-dot.ollama{background:var(--warn,#f5a623)}
.llm-key b{color:var(--text);font-weight:700}
.triage-btn{margin-left:.6rem;cursor:pointer;background:none;border:none;font:inherit;padding:0;display:inline-flex;align-items:center;gap:.2rem}
.triage-btn:disabled{opacity:.6;cursor:default}
/* ── 3-game health strip (Lakeside portfolio) ── */
.game-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--s-4);margin-bottom:var(--s-4)}
.game-chip{display:flex;align-items:center;gap:.6rem;border:1px solid var(--border);border-left:3px solid var(--gs-accent,var(--accent));border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e1),var(--hi);padding:.65rem var(--s-4);text-decoration:none;color:inherit;transition:border-color var(--t),transform var(--t)}
.game-chip:hover{border-color:var(--border-2);transform:translateY(-1px)}
.game-chip .gname{font-weight:700;font-size:var(--fs-body);color:var(--text)}
.game-chip .gsub{font-size:var(--fs-xs);color:var(--text-3);font-family:var(--mono)}
.game-chip .gdot{width:9px;height:9px;border-radius:50%;flex-shrink:0;margin-left:auto}
.game-chip .gdot.ok{background:var(--ok);box-shadow:0 0 6px var(--ok)}
.game-chip .gdot.bad{background:var(--danger);box-shadow:0 0 6px var(--danger)}
.game-chip .gdot.unk{background:var(--text-3)}
.world-command{position:relative;overflow:hidden;margin-bottom:var(--s-4);padding:clamp(1rem,3vw,1.4rem);border:1px solid var(--border);border-radius:var(--r-lg);background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 6%,var(--surface)),var(--surface) 52%);box-shadow:var(--e1),var(--hi)}
.world-command:before{content:'';position:absolute;inset:0 auto 0 0;width:4px;background:var(--ok)}
.world-command.warn:before{background:var(--warn)}.world-command.bad:before{background:var(--danger)}
.world-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--s-4);margin-bottom:var(--s-4)}
.world-kicker{display:flex;align-items:center;gap:.45rem;color:var(--text-3);font-size:var(--fs-2xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.world-title{font-size:clamp(1.2rem,3vw,1.55rem);font-weight:750;margin-top:.15rem;letter-spacing:-.015em}.world-scope{margin-top:.35rem;color:var(--text-3);font-size:var(--fs-xs)}.world-state{display:flex;align-items:center;gap:.45rem;font-size:var(--fs-xs);font-weight:700;padding:.35rem .65rem;border-radius:var(--r-full);background:var(--green-soft);color:var(--ok);white-space:nowrap}.world-command.warn .world-state{background:var(--amber-soft);color:var(--warn)}.world-command.bad .world-state{background:var(--red-soft);color:var(--danger)}
.world-intelligence{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s-3)}.world-domain{padding:var(--s-4);border:1px solid var(--border);border-radius:var(--r-md);background:var(--glass-1);min-width:0}.world-domain h3{display:flex;align-items:center;gap:.4rem;margin:0 0 var(--s-3);font-size:var(--fs-sm);letter-spacing:.01em}.world-domain-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s-3)}.world-metric b{display:block;font-size:1.15rem;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}.world-metric span{display:block;margin-top:.15rem;color:var(--text-3);font-size:var(--fs-2xs);font-weight:650;text-transform:uppercase;letter-spacing:.045em}.world-list{display:grid;gap:.35rem;margin-top:var(--s-3);padding-top:var(--s-3);border-top:1px solid var(--border)}.world-list-row{display:flex;align-items:center;justify-content:space-between;gap:.7rem;font-size:var(--fs-xs);color:var(--text-2)}.world-list-row b{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.world-list-row .positive{color:var(--ok)}.world-list-row .negative{color:var(--danger)}.world-heartbeat{display:flex;flex-wrap:wrap;gap:var(--s-3);margin-top:var(--s-3);padding-top:var(--s-3);border-top:1px solid var(--border);color:var(--text-3);font-size:var(--fs-xs)}.world-heartbeat b{color:var(--text);margin-right:.2rem}.world-flags{display:flex;flex-wrap:wrap;gap:var(--s-2);margin-top:var(--s-3)}.world-flag{font-size:var(--fs-xs);padding:.3rem .55rem;border-radius:var(--r-sm);background:var(--amber-soft);color:var(--warn)}.world-flag.error{background:var(--red-soft);color:var(--danger)}
.world-events{display:flex;gap:var(--s-2);overflow:auto;margin-top:var(--s-3);padding-top:var(--s-3);border-top:1px solid var(--border)}.world-event{flex:0 0 auto;padding:.35rem .55rem;border-radius:var(--r-sm);background:var(--glass-1);font-size:var(--fs-2xs);color:var(--text-2)}.world-event b{color:var(--text);margin-right:.35rem}.world-event time{color:var(--text-3);margin-left:.35rem}
.briefing-list{display:grid;gap:var(--s-3);margin-bottom:var(--s-4)}.briefing-signal{display:grid;grid-template-columns:5px minmax(0,1fr) auto;gap:var(--s-3);align-items:start;padding:var(--s-4);border:1px solid var(--border);border-radius:var(--r-md);background:var(--glass-1)}.briefing-signal:before{content:'';width:5px;height:100%;min-height:52px;border-radius:var(--r-full);background:var(--text-3)}.briefing-signal.warning:before,.briefing-signal.critical:before{background:var(--danger)}.briefing-signal.watch:before{background:var(--warn)}.briefing-signal.positive:before{background:var(--ok)}.signal-domain{font-size:var(--fs-2xs);font-weight:750;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3)}.signal-title{font-size:var(--fs-body);font-weight:750;margin:.12rem 0}.signal-detail,.signal-cause{font-size:var(--fs-xs);line-height:1.45;color:var(--text-2)}.signal-cause{color:var(--text-3);margin-top:.25rem}.signal-value{font-size:1.25rem;font-weight:750;font-variant-numeric:tabular-nums;white-space:nowrap}.cohort-head{display:flex;justify-content:space-between;gap:var(--s-3);align-items:baseline}.cohort-delta{font-size:var(--fs-xs);font-weight:700}.cohort-delta.bad{color:var(--danger)}.cohort-delta.good{color:var(--ok)}
@media(max-width:900px){.world-intelligence{grid-template-columns:1fr}}@media(max-width:560px){.world-head{flex-direction:column}.world-domain-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.world-heartbeat{display:grid;grid-template-columns:1fr 1fr}}
/* V4 operations workbench: hierarchy before detail. */
.ops-page-lead{display:flex;align-items:end;justify-content:space-between;gap:20px;margin:2px 0 26px}
.ops-page-lead .eyebrow,.ops-section-head .eyebrow{display:block;color:var(--accent);font:700 .66rem var(--mono);letter-spacing:.13em;text-transform:uppercase;margin-bottom:7px}
.ops-page-lead h1{font-size:clamp(1.85rem,3vw,2.65rem);font-weight:780;letter-spacing:-.055em;line-height:1.1}
.ops-page-lead p{color:var(--text-2);font-size:.88rem;margin-top:8px}
.ops-page-lead .dash-meta{white-space:nowrap;margin:0;padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font:600 .72rem var(--mono)}
.ambient-grid{grid-template-columns:minmax(0,1.5fr) minmax(340px,1fr);gap:16px;margin-bottom:27px}
.ambient-engine{min-height:300px;padding:26px 28px;border:0;border-radius:14px;background:#182b40;color:#f6f9fd;box-shadow:0 16px 32px -16px rgba(15,35,64,.45)}
.ambient-engine::before{width:5px;background:#51c4a6}.ambient-engine.warn::before{background:#f0ba64}.ambient-engine.bad::before,.ambient-engine.unknown::before{background:#ff7979}
.ambient-head h2{font:700 .68rem var(--mono);text-transform:uppercase;letter-spacing:.13em;color:#afc4d8}
.ambient-head a{color:#d4e1ff;font-size:.75rem;font-weight:650}
.ambient-state{font-size:clamp(1.65rem,2.6vw,2.4rem);font-weight:760;letter-spacing:-.045em;margin-top:15px}
.ambient-state small{font-size:.76rem;color:#afc4d8;margin-top:6px}
.ambient-facts{gap:16px}
.ambient-fact{border-top:1px solid rgba(229,239,249,.19);padding-top:14px}
.ambient-fact b{color:#fff;font-size:1.2rem}
.ambient-fact:first-child b{font-size:1.7rem;letter-spacing:-.045em}
.ambient-fact span{color:#a8bfd2;font-size:.63rem}
.ambient-grid .host-health{min-height:300px;padding:25px 26px;border-radius:14px;box-shadow:none}
.ambient-grid .host-health-head h2{font-size:1rem;font-weight:750;letter-spacing:-.02em}
.ops-section-head{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:30px 0 15px}
.ops-section-head h2{font-size:1.17rem;font-weight:760;letter-spacing:-.035em}
.ops-section-head a{font-size:.75rem;font-weight:700;color:var(--accent);white-space:nowrap}
.ops-priority{margin-bottom:10px}
.priority-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.priority-card{min-height:138px;display:flex;flex-direction:column;padding:16px 18px;border:1px solid var(--border);border-top:3px solid var(--text-3);border-radius:10px;background:var(--surface)}
.priority-card.critical,.priority-card.warning{border-top-color:var(--red)}.priority-card.watch{border-top-color:var(--amber)}.priority-card.positive{border-top-color:var(--green)}
.priority-card .signal-domain{color:var(--text-3);font-size:.63rem}
.priority-card strong{font-size:.88rem;letter-spacing:-.015em;line-height:1.35;margin:7px 0}
.priority-card p{font-size:.74rem;line-height:1.38;color:var(--text-2);margin-top:auto}
.priority-card .signal-value{font:750 .97rem var(--mono);margin-top:9px}
.priority-empty{grid-column:1/-1;padding:22px;border:1px dashed var(--border-2);border-radius:10px;color:var(--text-2);font-size:.82rem}
.ops-shortcuts{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 31px}
.ops-shortcut{gap:8px;padding:9px 12px;border-radius:8px;font-size:.75rem;background:var(--surface);box-shadow:none}
.ops-shortcut svg{color:var(--text-3)}
.game-strip{gap:10px;margin-bottom:18px}.game-chip{border-left:1px solid var(--border);border-radius:9px;box-shadow:none;padding:12px 14px}
.game-chip:before{content:'';width:4px;height:25px;border-radius:3px;background:var(--gs-accent,var(--accent))}
.tile,.dcard{border-radius:10px;box-shadow:none}.tile{min-height:120px}.tile .tnum{font-size:1.9rem;letter-spacing:-.05em}
.world-command{border-radius:10px;box-shadow:none;background:var(--surface)}.world-command:before{width:3px}
.world-domain,.briefing-signal{border-radius:8px;background:var(--bg-0)}
@media(max-width:1100px){.ambient-grid{grid-template-columns:1fr}.priority-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:680px){.ops-page-lead{align-items:start;flex-direction:column;margin-bottom:20px}.ops-page-lead .dash-meta{font-size:.67rem}.ambient-engine,.ambient-grid .host-health{min-height:0;padding:20px}.ambient-facts{gap:8px}.ambient-fact:first-child b{font-size:1.27rem}.priority-list{grid-template-columns:1fr}.priority-card{min-height:0}.ops-shortcuts{margin:18px 0 24px}.ops-section-head{align-items:start}}
/* Keep the default view focused. Full diagnostics are one deliberate expansion away. */
.ops-page-lead{margin-bottom:20px}
.ambient-grid{margin-bottom:20px}
.ambient-engine,.ambient-grid .host-health{min-height:250px}
.ops-priority{overflow:hidden;border:1px solid var(--border);border-radius:11px;background:var(--surface);margin:0 0 16px}
.ops-priority .ops-section-head{margin:0;padding:17px 20px;align-items:center}
.ops-priority .ops-section-head h2{font-size:1.06rem}
.priority-list{display:block}
.priority-row{display:grid;grid-template-columns:4px minmax(0,1fr) auto;align-items:center;gap:14px;border-top:1px solid var(--border);padding:11px 20px;min-height:67px}
.priority-indicator{width:4px;height:34px;border-radius:3px;background:var(--text-3)}
.priority-row.critical .priority-indicator,.priority-row.warning .priority-indicator{background:var(--red)}
.priority-row.watch .priority-indicator{background:var(--amber)}
.priority-row.positive .priority-indicator{background:var(--green)}
.priority-copy{min-width:0}
.priority-copy .signal-domain{font-size:.6rem;letter-spacing:.09em}
.priority-copy strong{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:.82rem;font-weight:720;line-height:1.3}
.priority-copy p{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--text-3);font-size:.69rem;line-height:1.3}
.priority-value{font:720 .82rem var(--mono);white-space:nowrap;color:var(--text)}
.priority-empty{border:0;border-top:1px solid var(--border);border-radius:0}
.ops-pulse{display:flex;overflow:hidden;border:1px solid var(--border);border-radius:10px;background:var(--surface);margin-bottom:17px}
.ops-pulse a{display:flex;flex:1;align-items:center;gap:11px;min-width:0;padding:16px 19px;color:var(--text);font-size:.78rem;font-weight:620}
.ops-pulse a+a{border-left:1px solid var(--border)}
.ops-pulse a:hover{background:var(--glass-2)}
.ops-pulse strong{font:760 1.25rem var(--mono);letter-spacing:-.05em}
.ops-pulse span{color:var(--text-2)}
.ops-pulse .icon{margin-left:auto;color:var(--text-3)}
.ops-deep-dive{border:1px solid var(--border);border-radius:10px;background:var(--surface);margin-bottom:24px}
.ops-deep-dive>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px}
.ops-deep-dive>summary::-webkit-details-marker{display:none}
.ops-deep-dive>summary strong{display:block;font-size:.82rem}
.ops-deep-dive>summary small{display:block;color:var(--text-3);font-size:.72rem;margin-top:2px}
.ops-deep-dive .deep-chevron{color:var(--text-3);font-size:1.2rem;transition:transform var(--t)}
.ops-deep-dive[open] .deep-chevron{transform:rotate(180deg)}
.ops-deep-body{padding:5px 20px 20px;border-top:1px solid var(--border)}
.ops-deep-body .world-command{margin-top:20px}
@media(max-width:680px){.ops-priority .ops-section-head{padding:15px}.priority-row{padding:11px 15px;gap:9px}.priority-copy p{display:none}.priority-value{font-size:.74rem}.ops-pulse a{flex-direction:column;align-items:flex-start;gap:2px;padding:12px}.ops-pulse .icon{display:none}.ops-pulse span{font-size:.65rem}.ops-deep-body{padding:5px 14px 16px}}
@media(max-width:560px){.ambient-engine{gap:10px}.ambient-grid .host-health{padding:16px}.ambient-grid .host-health-ring{max-width:80px}.ambient-grid .host-health-ring:after{inset:6px}.ambient-grid .host-health-rings{gap:5px}.ambient-grid .host-health-caption{margin-top:7px}}
`;

function dnote(what, hint) {
  return `<p class="empty-note">${what} not wired.${hint ? " " + hint : ""}</p>`;
}
function railClass(s) {
  s = (s || "").toUpperCase();
  if (s === "SUCCESS" || s === "DEPLOYED") return "ok";
  if (s === "FAILED" || s === "CRASHED") return "bad";
  if (["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"].includes(s)) return "warn";
  return "";
}
// Tiny inline-SVG sparkline (no dependency). Inherits color via currentColor.
function sparkline(values) {
  if (!values || values.length < 2) return "";
  const w = 140, h = 26, max = Math.max(...values, 1), min = Math.min(...values, 0), rng = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / rng) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderDashboard(session, m, reports, gamesHealth, warming = false) {
  m = m || {};
  // ── Lakeside 3-game health strip (results cached ~30s in games-config) ──
  const ghByKey = Object.fromEntries((gamesHealth || []).map((r) => [r.key, r]));
  const gameStrip = `<div class="game-strip">${GAMES.map((g) => {
    const r = ghByKey[g.key];
    const dot = r && r.ok != null ? (r.ok ? "ok" : "bad") : "unk";
    const sub = r && r.ok != null ? (r.ok ? "up" : (r.checks.filter((c) => !c.ok).map((c) => c.label + " down").join(", ") || "down")) : "not monitored";
    return `<a class="game-chip" href="/games" style="--gs-accent:${g.accent}" title="${escHtml(g.name)} — open the Games hub"><span class="gname">${escHtml(g.name)}</span><span class="gsub">${escHtml(sub)}</span><span class="gdot ${dot}"></span></a>`;
  }).join("")}</div>`;
  const t = m.traffic, tok = t && t.ok;
  const u = m.users, g = m.glitchtip, r = m.railway;
  // The whole dashboard is admin-only (moderators are redirected at the route),
  // but admin-gate the sensitive widgets defensively so they can never leak.
  const isAdmin = session.role === "admin";

  const engine = m.engine && m.engine.ok !== false ? m.engine : null;
  const engineFlags = engine && Array.isArray(engine.flags) ? engine.flags : [];
  const engineClass = engineFlags.some((flag) => flag.level === "error") ? "bad" : engineFlags.length || (engine && engine.paused) ? "warn" : "";
  const engineState = !engine ? "Engine unavailable" : engineClass === "bad" ? "Action needed" : engine.paused ? "Engine paused" : engineClass === "warn" ? "Attention needed" : "Engine running";
  const formatTurnDuration = (ms) => ms == null ? "—" : ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  const formatNumber = (value, digits = 0) => Number.isFinite(value) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }) : "—";
  const formatCompact = (value) => Number.isFinite(value) ? Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value) : "—";
  const formatPct = (value) => Number.isFinite(value) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%" : "—";
  const nextTurn = engine && engine.schedule && engine.schedule.next ? new Date(engine.schedule.next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const platformEvents = Array.isArray(m.platformEvents) ? m.platformEvents : [];
  const world = m.world || {};
  const players = world.players || {};
  const economy = world.economy || {};
  const markets = world.markets || {};
  const politics = world.politics || {};
  const pendingBills = Object.entries(politics.bills || {}).filter(([status]) => !/passed|enacted|failed|rejected|withdrawn/i.test(status)).reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const signed = (value, suffix = "") => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${formatNumber(value, 1)}${suffix}` : "—";
  const signalRows = (world.signals || []).map((signal) => `<article class="briefing-signal ${escHtml(signal.level)}"><div><div class="signal-domain">${escHtml(signal.domain)}</div><div class="signal-title">${escHtml(signal.title)}</div><div class="signal-detail">${escHtml(signal.detail)}</div>${signal.cause ? `<div class="signal-cause">Driver: ${escHtml(signal.cause)}</div>` : ""}</div><div class="signal-value">${escHtml(signal.value)}</div></article>`).join("");
  const marketRows = (markets.worsening || []).slice(0, 4).map((item) => `<div class="world-list-row"><b>${escHtml(item.label)}</b><span class="${item.deltaPoints < 0 ? "negative" : "positive"}">${formatPct(item.fillPct)} · ${signed(item.deltaPoints, "pp")}</span></div>`).join("");
  const consequenceRows = (politics.recentEvents || []).slice(0, 5).map((event) => `<div class="world-list-row"><b>${escHtml(event.countryId)} · ${escHtml(String(event.title || "").replace(/^Enacted:\s*/i, ""))}</b><span>turn ${escHtml(event.turn)}</span></div>`).join("");
  const cohortCard = (cohort, title) => { const latest = cohort?.latest || {}, change = cohort?.change24 || {}, bad = Number(change.lossRatePoints) > 0; return `<article class="world-domain"><div class="cohort-head"><h3>${icon("trending-up", { size: 15 })} ${title}</h3><span class="cohort-delta ${bad ? "bad" : "good"}">${signed(change.lossRatePoints, "pp")} distress · 24 turns</span></div><div class="world-domain-grid"><div class="world-metric"><b>${formatPct(latest.lossRate)}</b><span>Firms losing</span></div><div class="world-metric"><b>${formatPct(latest.margin)}</b><span>Operating margin</span></div><div class="world-metric"><b>${formatCompact(latest.income)}</b><span>Net income · anchor</span></div><div class="world-metric"><b>${signed(change.revenuePct, "%")}</b><span>Revenue change</span></div><div class="world-metric"><b>${signed(change.marginPoints, "pp")}</b><span>Margin change</span></div><div class="world-metric"><b>${formatNumber(latest.firms)}</b><span>Reporting firms</span></div></div>${cohort?.driver ? `<div class="signal-cause">Largest country contribution: ${escHtml(cohort.driver)}</div>` : ""}${sparkline((cohort?.series || []).map((row) => row.margin).filter(Number.isFinite))}</article>`; };
  const worldPanel = `<section class="world-command ${engineClass}" id="world-briefing" aria-label="Live world status">
    <div class="world-head"><div><div class="world-kicker">${icon("activity", { size: 14 })} World briefing · through turn ${escHtml(engine?.turn ?? "—")}</div><div class="world-title">What changed, and why it matters</div><div class="world-scope">Playable countries only · player-run and NPP-run corporations · monetary values normalized to anchor currency at each turn</div></div><a class="world-state" href="/engine">Technical health ${icon("arrow-right", { size: 13 })}</a></div>
    <div class="briefing-list">${signalRows || `<p class="empty-note">No material movement detected over the available comparison windows.</p>`}</div>
    <div class="world-intelligence">
      <article class="world-domain"><h3>${icon("users", { size: 15 })} Players</h3><div class="world-domain-grid">
        <div class="world-metric"><b>${formatNumber(players.activityTrend?.current)}</b><span>Acted · latest 24 turns</span></div><div class="world-metric"><b>${signed(players.activityTrend?.changePct, "%")}</b><span>Participation change</span></div><div class="world-metric"><b>${formatNumber(players.activityTrend?.currentActions)}</b><span>Actions · 24 turns</span></div><div class="world-metric"><b>${formatNumber(players.active24h)}</b><span>Active 24h</span></div><div class="world-metric"><b>${formatNumber(players.active7d)}</b><span>Active 7d</span></div><div class="world-metric"><b>${formatNumber(players.new7d)}</b><span>New 7d</span></div>
      </div></article>
      ${cohortCard(economy.player, "Player corporations")}
      ${cohortCard(economy.npp, "NPP corporations")}
      <article class="world-domain"><h3>${icon("package", { size: 15 })} Market pressure</h3><div class="world-domain-grid">
        <div class="world-metric"><b>${formatPct(markets.latest?.fillPct)}</b><span>Demand filled</span></div><div class="world-metric"><b>${signed(markets.change24, "pp")}</b><span>Fill change · 24 turns</span></div><div class="world-metric"><b>${formatNumber(markets.latest?.severe)}</b><span>Markets below 50%</span></div><div class="world-metric"><b>${formatNumber(markets.latest?.empty)}</b><span>Zero-fill markets</span></div>
      </div>${marketRows ? `<div class="world-list"><span class="world-kicker">Fastest deterioration · 24 turns</span>${marketRows}</div>` : ""}${sparkline((markets.series || []).map((row) => row.fillPct).filter(Number.isFinite))}</article>
      <article class="world-domain"><h3>${icon("landmark", { size: 15 })} Politics</h3><div class="world-domain-grid">
        <div class="world-metric"><b>${formatNumber(politics.membershipTrend?.current)}</b><span>Player party members</span></div><div class="world-metric"><b>${signed(politics.membershipTrend?.change)}</b><span>Member change · 24 turns</span></div><div class="world-metric"><b>${formatNumber(politics.activeElections)}</b><span>Live elections</span></div><div class="world-metric"><b>${formatNumber(pendingBills)}</b><span>Bills in motion</span></div><div class="world-metric"><b>${formatNumber(politics.enacted24Turns)}</b><span>Laws enacted · 24 turns</span></div>
      </div>${consequenceRows ? `<div class="world-list"><span class="world-kicker">Recent consequences</span>${consequenceRows}</div>` : ""}${politics.membershipTrend?.driver ? `<div class="signal-cause">Largest party movement: ${escHtml(politics.membershipTrend.driver)}</div>` : ""}</article>
    </div>
    ${engineFlags.length ? `<div class="world-flags">${engineFlags.slice(0, 5).map((flag) => `<span class="world-flag ${flag.level === "error" ? "error" : ""}">${escHtml(flag.msg)}</span>`).join("")}</div>` : ""}
    <div class="world-heartbeat" aria-label="Turn processing health"><span>Technical context</span><span><b>${formatTurnDuration(engine?.lastTurn?.durationMs)}</b> last duration</span><span><b>${formatTurnDuration(engine?.recent?.avgMs)}</b> 24-turn average</span><span><b>${escHtml(engine?.recent?.failures ?? "—")}</b> failures</span><span><b>${nextTurn}</b> next run</span></div>
  </section>`;

  // ── KPI tiles ──
  const visTile = `<div class="tile"><div class="tlabel">${icon("eye", { size: 13 })} Visitors today</div><div class="tnum">${tok ? t.uniquesToday.toLocaleString() : "—"}</div>${tok ? sparkline(t.series.map((s) => s.uniques)) : ""}<div class="tsub">${tok ? "Cloudflare · " + t.uniques7d.toLocaleString() + " in 7d" : t && t.reason === "not configured" ? "set CLOUDFLARE_API_TOKEN" : "(" + escHtml((t && t.reason) || "error") + ")"}</div></div>`;
  const pvTile = `<div class="tile"><div class="tlabel">${icon("trending-up", { size: 13 })} Page views · 7d</div><div class="tnum">${tok ? t.pageViews7d.toLocaleString() : "—"}</div><div class="tsub">${tok ? Math.round(t.pageViews7d / 7).toLocaleString() + " / day avg" : "Cloudflare traffic"}</div></div>`;
  const plTile = `<a class="tile" href="/db" title="Browse users in the database"><div class="tlabel">${icon("user", { size: 13 })} Players</div><div class="tnum">${u && u.ok ? u.total.toLocaleString() : "—"}</div><div class="tsub">${u && u.ok ? (u.new7d ? "+" + u.new7d + " this week · " : "") + u.banned + " banned" : ""}</div></a>`;
  const isTile = `<a class="tile ${g && g.ok && g.count > 0 ? "alert" : ""}" href="https://ops.lakesidegames.net/errors" target="_blank" rel="noopener" title="View errors in GlitchTip"><div class="tlabel">${icon("shield-alert", { size: 13 })} Open issues</div><div class="tnum">${g && g.ok ? g.count : "—"}</div><div class="tsub">${g && g.ok ? "GlitchTip unresolved" : g && g.reason === "not configured" ? "set GLITCHTIP_*" : ""}</div></a>`;
  const fmtBig = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : "" + n);
  const reqTile = `<div class="tile"><div class="tlabel">${icon("zap", { size: 13 })} Requests · 7d</div><div class="tnum">${tok ? fmtBig(t.requests7d) : "—"}</div><div class="tsub">${tok ? fmtBig(Math.round(t.requests7d / 7)) + " / day" : "Cloudflare"}</div></div>`;
  const cacheTile = `<div class="tile"><div class="tlabel">${icon("shield", { size: 13 })} Cache hit</div><div class="tnum">${tok && t.cacheHit != null ? t.cacheHit + "%" : "—"}</div><div class="tsub">${tok ? "served from CDN" : "Cloudflare"}</div></div>`;

  // ── Community triage KPIs ──
  const ck = m.tickets || {};
  const otTile = `<a class="tile" href="/tickets" title="Open tickets in triage"><div class="tlabel">${icon("life-buoy", { size: 13 })} Open tickets</div><div class="tnum">${ck.outstandingTickets != null ? ck.outstandingTickets.toLocaleString() : "—"}</div><div class="tsub">awaiting resolution</div></a>`;
  const osTile = `<a class="tile" href="/suggestions" title="Suggestions awaiting review"><div class="tlabel">${icon("lightbulb", { size: 13 })} Open suggestions</div><div class="tnum">${ck.outstandingSuggestions != null ? ck.outstandingSuggestions.toLocaleString() : "—"}</div><div class="tsub">not yet reviewed</div></a>`;
  const ctTile = `<div class="tile"><div class="tlabel">${icon("check-circle", { size: 13 })} Tickets resolved</div><div class="tnum">${ck.completedTickets != null ? ck.completedTickets.toLocaleString() : "—"}</div><div class="tsub">all-time completed</div></div>`;
  const adTile = `<div class="tile"><div class="tlabel">${icon("clock", { size: 13 })} Avg ticket time</div><div class="tnum">${ck.avgDuration || "—"}</div><div class="tsub">create → resolve</div></div>`;

  // ── Detail panels ──
  const up = (m.uptime || [])
    .map((s) => `<div class="up-row"><span class="up-name"><span class="up-dot ${s.ok ? "ok" : "bad"}"></span>${escHtml(s.name)}</span><span class="up-lat">${s.ok ? (s.ms != null ? s.ms + "ms" : "ok") : escHtml(s.reason || "down")}</span></div>`)
    .join("") || dnote("Uptime", "");
  const railBody = r && r.ok
    ? (r.services.length
        ? r.services.map((s) => `<div class="rail-row"><span>${escHtml(s.name)}</span><span class="pill ${railClass(s.status)}">${escHtml((s.status || "none").toLowerCase())}</span></div>`).join("")
        : `<p class="empty-note">No services.</p>`)
    : dnote("Railway", r && r.reason === "not configured" ? "Set <code>RAILWAY_API_TOKEN</code>." : "(" + escHtml((r && r.reason) || "error") + ")");
  const gtBody = g && g.ok
    ? (g.issues.length
        ? g.issues.map((i) => `<div class="iss-row"><span class="pill ${i.level === "error" ? "bad" : i.level === "warning" ? "warn" : ""}">${escHtml(i.level || "info")}</span><span class="t">${escHtml(i.title || "")}</span><span class="n">${i.seen ? "×" + i.seen : ""}</span></div>`).join("")
        : `<p class="empty-note">No unresolved issues.</p>`)
    : dnote("GlitchTip", g && g.reason === "not configured" ? "Set <code>GLITCHTIP_URL</code> + <code>GLITCHTIP_API_TOKEN</code>." : "(" + escHtml((g && g.reason) || "error") + ")");

  // ── LLM usage bar (Kimi vs Ollama, 7d) — admin-only ──
  const lu = m.llmUsage || { kimi: { calls: 0, totalTokens: 0 }, ollama: { calls: 0, totalTokens: 0 }, windowDays: 7 };
  const kTok = (lu.kimi && lu.kimi.totalTokens) || 0;
  const oTok = (lu.ollama && lu.ollama.totalTokens) || 0;
  const kCalls = (lu.kimi && lu.kimi.calls) || 0;
  const oCalls = (lu.ollama && lu.ollama.calls) || 0;
  const sumTok = kTok + oTok;
  const kPct = sumTok ? Math.round((kTok / sumTok) * 100) : 0;
  const oPct = sumTok ? 100 - kPct : 0;
  const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : "" + n);
  const llmBar = isAdmin
    ? `<div class="dcard col-12"><h2>${icon("cpu", { size: 14 })} LLM usage · last ${lu.windowDays || 7}d</h2>
        <div class="llm-bar">
          <div class="llm-seg kimi" style="width:${sumTok ? kPct : 50}%" title="Kimi"></div>
          <div class="llm-seg ollama" style="width:${sumTok ? oPct : 50}%" title="Ollama"></div>
        </div>
        <div class="llm-legend">
          <span class="llm-key"><span class="llm-dot kimi"></span>Kimi · <b>${fmtTok(kTok)}</b> tok · ${kCalls.toLocaleString()} calls · ${kPct}%</span>
          <span class="llm-key"><span class="llm-dot ollama"></span>Ollama · <b>${fmtTok(oTok)}</b> tok · ${oCalls.toLocaleString()} calls · ${oPct}%</span>
        </div></div>`
    : "";

  const gm = m.game;
  const gv = (v) => (v == null ? "—" : v.toLocaleString());
  const gamePanel = `<div class="dcard col-12"><h2>${icon("landmark", { size: 14 })} Game world<a class="viewlink" href="/db">Database →</a></h2><div class="statgrid">
    <div class="s"><span class="n">${u && u.ok ? u.total.toLocaleString() : "—"}</span><span class="l">Players</span>${u && u.ok && u.new7d ? `<span class="d">+${u.new7d} this week</span>` : ""}</div>
    <div class="s"><span class="n">${gm && gm.ok ? gv(gm.characters) : "—"}</span><span class="l">Characters</span></div>
    <div class="s"><span class="n">${gm && gm.ok ? gv(gm.corporations) : "—"}</span><span class="l">Corporations</span></div>
    <div class="s"><span class="n">${gm && gm.ok ? gv(gm.states) : "—"}</span><span class="l">States</span></div>
    <div class="s"><span class="n">${gm && gm.ok ? gv(gm.elections) : "—"}</span><span class="l">Elections</span></div>
  </div></div>`;

  const prioritySignals = (world.signals || []).slice(0, 3).map((signal) => `<article class="priority-row ${escHtml(signal.level)}"><span class="priority-indicator" aria-hidden="true"></span><div class="priority-copy"><span class="signal-domain">${escHtml(signal.domain)}</span><strong>${escHtml(signal.title)}</strong><p>${escHtml(signal.detail)}</p></div><span class="priority-value">${escHtml(signal.value)}</span></article>`).join("");
  const gameDown = (gamesHealth || []).filter((game) => game.ok === false).length;
  const worldAuditReady = fs.existsSync(path.join(PUBLISHED_REPORTS_DIR, "worldsim-audit-program.html"));
  const warmingScript = isAdmin && warming ? `<script>(function(){
    var attempts=0;
    async function check(){
      try{
        var response=await fetch('/api/dashboard/cache-status',{cache:'no-store'});
        if(response.ok){var state=await response.json();if(state.ready){location.reload();return;}}
      }catch(e){}
      attempts++;
      if(attempts>=30){
        var meta=document.getElementById('dashMeta');
        if(meta)meta.textContent='Dashboard values are still loading. Refresh to try again.';
        return;
      }
      setTimeout(check,1000);
    }
    setTimeout(check,500);
  })();</script>` : "";

  const body = `
  <header class="ops-page-lead"><div><span class="eyebrow">Operations / Live overview</span><h1>Platform at a glance</h1><p>Health and changes that need a decision.</p></div><div class="dash-meta" id="dashMeta"><span class="live"></span> Live${m.at ? " · " + new Date(m.at).toLocaleTimeString() : ""}${warming ? " · loading dashboard data" : ""}</div></header>
  <div class="ambient-grid" aria-label="Live operations overview">
    <section class="ambient-engine ${engine ? engineClass : "unknown"}" aria-label="Engine status">
      <div class="ambient-head"><h2>Engine</h2><a href="/engine">Inspect engine →</a></div>
      <div class="ambient-state">${engineState}<small>World turn ${escHtml(engine?.turn ?? "—")} · ${engineFlags.length ? `${engineFlags.length} active signal${engineFlags.length === 1 ? "" : "s"}` : "No active alerts"}</small></div>
      <div class="ambient-facts"><div class="ambient-fact"><b id="turn-countdown" data-next="${escHtml(engine?.schedule?.next || "")}">—</b><span>Next turn</span></div><div class="ambient-fact"><b>${formatTurnDuration(engine?.lastTurn?.durationMs)}</b><span>Last turn</span></div><div class="ambient-fact"><b>${escHtml(engine?.recent?.failures ?? "—")}</b><span>Recent failures</span></div></div>
    </section>
    ${hostHealthPanel()}
  </div>
  <section class="ops-priority" aria-label="Priority world signals"><div class="ops-section-head"><div><span class="eyebrow">World intelligence</span><h2>Signals to review</h2></div><a href="${worldAuditReady ? "/reports/worldsim-audit-program" : "/engine"}">${worldAuditReady ? "World audit" : "Engine details"} →</a></div><div class="priority-list">${prioritySignals || '<p class="priority-empty">No material movement detected in the latest comparison window.</p>'}</div></section>
  <section class="ops-pulse" aria-label="Operational counts">
    ${isEnabled("tickets") ? `<a href="/tickets"><strong>${ck.outstandingTickets != null ? ck.outstandingTickets.toLocaleString() : "—"}</strong><span>Open tickets</span>${icon("arrow-right", { size: 15 })}</a>` : ""}
    <a href="https://ops.lakesidegames.net/errors" target="_blank" rel="noopener"><strong>${g && g.ok ? g.count : "—"}</strong><span>Open issues</span>${icon("arrow-right", { size: 15 })}</a>
    <a href="/games"><strong>${gamesHealth && gamesHealth.length ? gameDown : "—"}</strong><span>Games down</span>${icon("arrow-right", { size: 15 })}</a>
  </section>
  <details class="ops-deep-dive" id="ops-deep-dive"><summary><span><strong>Detailed metrics</strong><small>World trends, portfolio, traffic, and delivery</small></span><span class="deep-chevron" aria-hidden="true">⌄</span></summary><div class="ops-deep-body">
    ${isAdmin ? worldPanel : ""}
    <div class="ops-section-head"><div><span class="eyebrow">Portfolio</span><h2>Products and audience</h2></div><a href="/games">All games →</a></div>
    ${gameStrip}
    <div class="kpi-row">${visTile}${pvTile}${reqTile}${cacheTile}${plTile}${isTile}</div>
    <div class="kpi-row">${otTile}${osTile}${ctTile}${adTile}</div>
    <div class="ops-section-head"><div><span class="eyebrow">Platform</span><h2>Systems and delivery</h2></div><a href="/status">Full status →</a></div>
    <div class="dash-grid">
      ${gamePanel}
      ${llmBar}
      <div class="dcard col-8"><h2>${icon("activity", { size: 14 })} System health<a class="viewlink" href="/status">Full status →</a></h2>${up}</div>
      <div class="dcard col-4"><h2>${icon("git-branch", { size: 14 })} Railway deploys<a class="viewlink" href="https://railway.com/dashboard" target="_blank" rel="noopener">Railway →</a></h2>${railBody}</div>
      <div class="dcard col-12"><h2>${icon("shield-alert", { size: 14 })} Recent errors${isAdmin && isEnabled("codeAgent") ? `<button class="viewlink triage-btn" onclick="triageIssues(this)" title="Launch a code session seeded with the open GlitchTip issues">${icon("sparkles", { size: 13 })} Triage issues →</button>` : ""}<a class="viewlink" href="https://ops.lakesidegames.net/errors" target="_blank" rel="noopener">GlitchTip →</a></h2>${gtBody}</div>
    </div>
    ${isAdmin ? renderReportSummaryCard(reports && reports[0]) : ""}
  </div></details>
  ${isAdmin ? `<script>
function updateTurnCountdown(){var el=document.getElementById('turn-countdown');if(!el)return;var next=Date.parse(el.dataset.next||'');if(!Number.isFinite(next)){el.textContent='—';return}var seconds=Math.ceil((next-Date.now())/1000);var overdue=seconds<0;seconds=Math.abs(seconds);var hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;el.textContent=(overdue?'+':'')+(hours?hours+'h ':'')+String(minutes).padStart(2,'0')+'m '+String(rest).padStart(2,'0')+'s';el.title=overdue?'Turn overdue':'Time until next turn'}updateTurnCountdown();setInterval(updateTurnCountdown,1000);
async function triageIssues(btn){
  var label=btn?btn.innerHTML:'';
  if(btn){btn.disabled=true;btn.textContent='Launching…';}
  try{
    var r=await fetch('/api/issues/triage',{method:'POST'});
    var d=await r.json().catch(function(){return {};});
    if(r.ok&&d.sessionId){location.href='/code/session/'+d.sessionId;return;}
    alert('Triage failed: '+(d.error||('HTTP '+r.status)));
  }catch(e){alert('Triage failed: '+e.message);}
  if(btn){btn.disabled=false;btn.innerHTML=label;}
}
</script>` : ""}${warmingScript}`;
  return renderShell({ title: "Dashboard", active: "/", role: session.role, extraCss: DASH_CSS + REPORT_CSS + SEARCH_CSS + HOST_HEALTH_CSS, body });
}

// Minimal moderator landing — deliberately carries NONE of the admin widgets
// (no usage bar, triage button, DB/game metrics, error internals, ticket/
// suggestion KPIs, code-agent). Moderators only get live status + an Ask entry.
function renderModeratorLanding(session) {
  const body = `
  <div class="dash-meta"><span class="live"></span> Live status</div>
  <div class="dash-grid">
    <a class="dcard col-8" href="/status" style="display:block;text-decoration:none;color:inherit">
      <h2>${icon("activity", { size: 14 })} System status<span class="viewlink">Full status →</span></h2>
      <div style="display:flex;align-items:center;gap:.7rem;margin-top:.3rem">
        <span id="mod-status-dot" style="width:12px;height:12px;border-radius:50%;flex-shrink:0;background:var(--text-3)"></span>
        <div><div class="mod-status-title" style="font-weight:600">Checking status…</div><div class="mod-status-sub" style="color:var(--text-3);font-size:var(--fs-sm);margin-top:.1rem"></div></div>
      </div>
    </a>
    <a class="dcard col-4" href="/ask" style="display:block;text-decoration:none;color:inherit">
      <h2>${icon("message", { size: 14 })} Ask</h2>
      <p class="empty-note">Ask the AI about ${escHtml(getPrimaryProject()?.name || "the primary project codebase")} — formulas, logic, and implementation details.</p>
      <span class="viewlink" style="color:var(--accent);font-weight:600;font-size:var(--fs-sm);display:inline-flex;align-items:center;gap:.2rem;margin-top:.6rem">Open Ask →</span>
    </a>
  </div>
  <script>(async function(){
    try{
      var r=await fetch('/api/status'); if(!r.ok) return;
      var d=await r.json(); var svc=d.services||[];
      var down=svc.filter(function(s){return s.current!=='operational';});
      var dot=document.getElementById('mod-status-dot');
      var title=document.querySelector('.mod-status-title');
      var sub=document.querySelector('.mod-status-sub');
      if(!dot)return;
      if(!down.length){dot.style.background='var(--ok)';title.textContent='All Systems Operational';sub.textContent=svc.length+' services healthy';}
      else if(down.length<svc.length){dot.style.background='var(--warn)';title.textContent='Partial Degradation';sub.textContent=down.map(function(s){return s.name;}).join(', ')+' affected';}
      else{dot.style.background='var(--danger)';title.textContent='System Outage';sub.textContent='Multiple services down';}
    }catch(e){}
  })();</script>`;
  return renderShell({ title: "Dashboard", active: "/", role: session.role, extraCss: DASH_CSS, body });
}

// ─── LANDING PAGE ──────────────────────────────────────────────────
const _primaryProject = getPrimaryProject();
const _loginBrand = {
  title: escHtml(TENANT.dashboardTitle),
  name: escHtml(TENANT.name),
  logoUrl: escHtml(TENANT.logoUrl || "/logo.svg"),
  homeUrl: escHtml(TENANT.homeUrl || "/"),
  subtitle: escHtml(_primaryProject ? `Operations for ${_primaryProject.name}` : "Operations dashboard"),
  homeLabel: escHtml(_primaryProject?.name || TENANT.name),
  homeLink: escHtml(_primaryProject?.publicUrl || TENANT.homeUrl || "/"),
};
const _ssoLoginEnabled = isEnabled("sso") && !!LAKESIDE_AUTH_BASE_URL;
const _ssoLoginBlock = _ssoLoginEnabled
  ? `<a class="btn-game" href="/auth/game"><img src="${_loginBrand.logoUrl}" alt=""> Sign in with ${_loginBrand.name}</a>
    <p class="login-hint">Uses your ${_loginBrand.name} account. Staff roles only.</p>
    ${AUTH_MODE === "password" ? '<div class="login-sep">or use ops credentials</div>' : ""}`
  : "";
const _passwordLoginBlock = AUTH_MODE === "password" ? `<div class="form-group">
      <label for="email">Email</label>
      <input type="email" id="email" class="field" placeholder="you@example.com" autocomplete="username">
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" class="field" placeholder="••••••••" autocomplete="current-password">
    </div>
    <button class="btn" onclick="doLogin()">Sign In</button>` : "";
const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${_loginBrand.title}</title>
${THEME_HEAD}
<link rel="icon" type="image/svg+xml" href="${_loginBrand.logoUrl}">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${FONT_LINKS}
<style>${BASE_CSS}
.container{max-width:980px;position:relative}
#login-view{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--s-5);padding:1.5rem;position:relative;overflow:hidden}
#login-view::before{content:'';position:absolute;inset:0;pointer-events:none;background:radial-gradient(46rem 30rem at 50% -12%,var(--accent-soft),transparent 62%),radial-gradient(34rem 26rem at 12% 108%,color-mix(in srgb,var(--accent-2) 8%,transparent),transparent 58%)}
#login-view::after{content:'';position:absolute;left:50%;top:50%;width:64rem;height:64rem;transform:translate(-50%,-40%);pointer-events:none;border-radius:50%;border:1px solid color-mix(in srgb,var(--accent) 8%,transparent);box-shadow:inset 0 0 0 1px transparent, 0 0 0 9rem color-mix(in srgb,var(--accent) 3%,transparent) inset,0 0 0 19rem color-mix(in srgb,var(--accent) 1.5%,transparent) inset}
.login-card{position:relative;z-index:1;width:100%;max-width:410px;padding:var(--s-8);border-radius:var(--r-xl);background:linear-gradient(180deg,var(--glass-2),var(--glass-1));border:1px solid var(--border);backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);box-shadow:var(--shadow-lg)}
.login-brand{display:flex;justify-content:center;margin:0 auto var(--s-5)}
.login-brand img{display:block;width:64px;height:64px;border-radius:15px;box-shadow:0 14px 30px -12px rgba(0,0,0,.55),0 0 0 1px color-mix(in srgb,var(--accent) 25%,transparent)}
.login-card h1{font-size:1.5rem;font-weight:800;letter-spacing:-.5px;text-align:center;display:flex;align-items:center;justify-content:center;gap:.55rem}
.login-card h1 .ops-chip{font-size:.64rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 38%,transparent);background:var(--accent-soft);border-radius:100px;padding:.16rem .58rem;transform:translateY(1px)}
.login-card .subtitle{color:var(--text-3);font-size:.9rem;text-align:center;margin-top:.35rem;margin-bottom:var(--s-6)}
.form-group{margin-bottom:var(--s-4)}
.form-group label{display:block;font-size:.8125rem;font-weight:500;color:var(--text-2);margin-bottom:.4rem}
.login-error{min-height:1.25rem;color:var(--red);font-size:.8125rem;margin-bottom:var(--s-2);text-align:center}
.login-card .btn{width:100%;margin-top:var(--s-2);padding:.72rem}
.login-sep{display:flex;align-items:center;gap:.8rem;margin:var(--s-5) 0 var(--s-4);color:var(--text-3);font-size:.75rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.login-sep::before,.login-sep::after{content:'';flex:1;height:1px;background:var(--border)}
.btn-game{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;padding:.7rem;border-radius:var(--r-sm);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);background:var(--accent-soft);color:var(--text);font-size:.875rem;font-weight:600;cursor:pointer;text-decoration:none;transition:all var(--t)}
.btn-game:hover{background:color-mix(in srgb,var(--accent) 20%,transparent);border-color:var(--accent);color:var(--text)}
.btn-game img{width:20px;height:20px;border-radius:5px}
.login-hint{font-size:.75rem;color:var(--text-3);text-align:center;margin-top:var(--s-3)}
.login-foot{position:relative;z-index:1;font-size:.8125rem;color:var(--text-3)}
.login-foot a{color:var(--text-2)}
.login-foot a:hover{color:var(--accent)}
.app-header{display:flex;align-items:center;justify-content:space-between;gap:var(--s-4);margin-bottom:var(--s-8);flex-wrap:wrap}
.app-brand{display:flex;align-items:center;gap:var(--s-3)}
.app-brand .mark{display:flex;align-items:center;justify-content:center;width:46px;height:46px;color:var(--accent);border-radius:var(--r-md);background:linear-gradient(180deg,var(--glass-3),var(--glass-1));border:1px solid var(--border)}
.app-brand h1{font-size:1.2rem;font-weight:700;line-height:1.15}
.app-brand .tag{font-size:.8125rem;color:var(--text-3)}
.status-bar{display:flex;align-items:center;gap:var(--s-4);padding:var(--s-4) var(--s-5);margin-bottom:var(--s-8);border-radius:var(--r-lg);border:1px solid var(--border);background:linear-gradient(180deg,var(--glass-2),var(--glass-1));backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.status-dot.ok{background:var(--green);box-shadow:0 0 0 4px var(--green-soft)}
.status-dot.warn{background:var(--amber);box-shadow:0 0 0 4px var(--amber-soft)}
.status-dot.error{background:var(--red);box-shadow:0 0 0 4px var(--red-soft)}
.status-info{flex:1;min-width:0}
.status-title{font-weight:600;font-size:.9rem}
.status-sub{font-size:.8125rem;color:var(--text-3);margin-top:.1rem}
.status-link{font-size:.8125rem;font-weight:500;white-space:nowrap}
.section-label{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);margin-bottom:var(--s-4)}
.directory{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:var(--s-4)}
.dir-card{--c:var(--accent);position:relative;overflow:hidden;display:flex;flex-direction:column;padding:var(--s-6);border-radius:var(--r-lg);border:1px solid var(--border);background:linear-gradient(180deg,var(--glass-2),var(--glass-1));backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);color:var(--text);transition:transform var(--t),border-color var(--t),box-shadow var(--t)}
.dir-card::before{content:'';position:absolute;inset:0;border-radius:inherit;background:radial-gradient(120% 90% at 0% 0%,color-mix(in srgb,var(--c) 14%,transparent),transparent 60%);opacity:0;transition:opacity var(--t);pointer-events:none}
.dir-card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--c) 45%,var(--border));box-shadow:var(--shadow)}
.dir-card:hover::before{opacity:1}
.dir-icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;color:var(--c);border-radius:var(--r-md);background:color-mix(in srgb,var(--c) 15%,transparent);border:1px solid color-mix(in srgb,var(--c) 28%,transparent);margin-bottom:var(--s-4)}
.dir-title{font-size:1.05rem;font-weight:700;margin-bottom:.35rem}
.dir-desc{font-size:.875rem;color:var(--text-2);line-height:1.5;flex:1}
.dir-meta{display:flex;align-items:center;gap:.4rem;margin-top:var(--s-5);padding-top:var(--s-4);border-top:1px solid var(--border);font-size:.75rem;color:var(--text-3);font-weight:500}
.dir-meta b{color:var(--text-2);font-weight:700;font-variant-numeric:tabular-nums}
.dir-meta .arrow{display:inline-flex;margin-left:auto;color:var(--c);transition:transform var(--t)}
.dir-card:hover .dir-meta .arrow{transform:translateX(4px)}
@media(max-width:600px){.directory{grid-template-columns:1fr}}
</style>
</head>
<body>
${themeToggle('fixed')}
<div id="login-view">
  <div class="login-card rise">
    <div class="login-brand"><img src="${_loginBrand.logoUrl}" alt="${_loginBrand.name}"></div>
    <h1>${_loginBrand.name} <span class="ops-chip">Ops</span></h1>
    <p class="subtitle">${_loginBrand.subtitle}</p>
    <div id="login-error" class="login-error"></div>
    ${_ssoLoginBlock}
    ${_passwordLoginBlock}
  </div>
  <div class="login-foot"><a href="${_loginBrand.homeUrl}">${_loginBrand.name}</a></div>
</div>
<div id="app-view" style="display:none">
  <div class="container">
    <div class="app-header rise">
      <div class="app-brand">
        <div class="mark">${icon('landmark', { size: 22 })}</div>
        <div>
          <h1>${_loginBrand.homeLabel}</h1>
          <div class="tag">Operations Dashboard</div>
        </div>
      </div>
      <button class="btn-ghost back-link" onclick="doLogout()">${icon('log-out', { size: 16 })}Sign Out</button>
    </div>
    <a href="/status" class="status-bar rise" style="text-decoration:none;color:inherit">
      <div class="status-dot ok" id="status-dot"></div>
      <div class="status-info">
        <div class="status-title">Checking status…</div>
        <div class="status-sub"></div>
      </div>
      <span class="status-link" style="display:inline-flex;align-items:center;gap:4px">View Status ${icon('arrow-right', { size: 14 })}</span>
    </a>
    <div class="section-label">Tools</div>
    <div class="directory">
      <a href="/backups" class="dir-card rise admin-only" style="--c:#7c8cff">
        <div class="dir-icon">${icon('package', { size: 23 })}</div>
        <div class="dir-title">Backups</div>
        <div class="dir-desc">Browse and download MongoDB backup archives.</div>
        <div class="dir-meta"><b id="backup-count">—</b> backups<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/db" class="dir-card rise admin-only" style="--c:#a78bfa">
        <div class="dir-icon">${icon('database', { size: 23 })}</div>
        <div class="dir-title">Database Explorer</div>
        <div class="dir-desc">Live read-only viewer. Browse collections and documents.</div>
        <div class="dir-meta"><b id="db-count">—</b> collections<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="https://ops.lakesidegames.net/errors/" target="_blank" rel="noopener" class="dir-card rise admin-only" style="--c:#f87171">
        <div class="dir-icon">${icon('shield-alert', { size: 23 })}</div>
        <div class="dir-title">Error Tracking</div>
        <div class="dir-desc">GlitchTip error monitoring and performance traces.</div>
        <div class="dir-meta">GlitchTip<span class="arrow">${icon('external-link', { size: 14 })}</span></div>
      </a>
      <a href="/reports" class="dir-card rise admin-only" style="--c:#f472b6">
        <div class="dir-icon">${icon('clipboard', { size: 23 })}</div>
        <div class="dir-title">Reports</div>
        <div class="dir-desc">Election post-mortem prompts and analysis templates.</div>
        <div class="dir-meta">Prompts<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/status" class="dir-card rise" style="--c:#34d399">
        <div class="dir-icon">${icon('activity', { size: 23 })}</div>
        <div class="dir-title">Status Page</div>
        <div class="dir-desc">Public service status and 90-day uptime history.</div>
        <div class="dir-meta">6 services<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/ask" class="dir-card rise" style="--c:#fbbf24">
        <div class="dir-icon">${icon('message', { size: 23 })}</div>
        <div class="dir-title">Codebase Q&A</div>
        <div class="dir-desc">Ask an AI about game formulas, logic, and implementation details.</div>
        <div class="dir-meta">Read-only sandbox<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/knowledge" class="dir-card rise admin-only" style="--c:#f5a623">
        <div class="dir-icon">${icon('brain-circuit', { size: 23 })}</div>
        <div class="dir-title">Knowledge Base</div>
        <div class="dir-desc">Docs, skills, and memory — the ops knowledge store with search and review tools.</div>
        <div class="dir-meta"><b id="kb-count">—</b> entries<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/knowledge/graph" class="dir-card rise admin-only" style="--c:#34d399">
        <div class="dir-icon">${icon('share-2', { size: 23 })}</div>
        <div class="dir-title">Knowledge Graph</div>
        <div class="dir-desc">Interactive visual map of concepts, docs, community feedback — canvas node-link graph.</div>
        <div class="dir-meta">Drag &amp; zoom<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/graphify" class="dir-card rise admin-only" style="--c:#8b5cf6">
        <div class="dir-icon">${icon('git-graph', { size: 23 })}</div>
        <div class="dir-title">Graphify — Codebase Graph</div>
        <div class="dir-desc">Graphify knowledge graph of the AHD codebase: classes, functions, imports, types — clickable interactive map.</div>
        <div class="dir-meta">8K+ files · force-directed<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      ${LEARN_INSTALLED ? `      <a href="/learn" class="dir-card rise admin-only" style="--c:#f472b6">
        <div class="dir-icon">${icon('graduation-cap', { size: 23 })}</div>
        <div class="dir-title">Learning Center</div>
        <div class="dir-desc">Learn the AHD tech stack: JS, TS, React, Next.js, MongoDB, and packages we use.</div>
        <div class="dir-meta"><b id="learn-progress">—</b> topics<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>` : ""}
      <a href="/project-guide" class="dir-card rise admin-only" style="--c:#60a5fa">
        <div class="dir-icon">${icon('book-open', { size: 23 })}</div>
        <div class="dir-title">Project Guide</div>
        <div class="dir-desc">Auto-updating project guide — architecture, patterns, conventions, and tribal knowledge.</div>
        <div class="dir-meta">Live document<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/demographics" class="dir-card rise admin-only" style="--c:#f59e0b">
        <div class="dir-icon">${icon('sliders', { size: 23 })}</div>
        <div class="dir-title">Demographics Editor</div>
        <div class="dir-desc">Interactive lean map — select country & era, view voter demographics, edit values, export CSV.</div>
        <div class="dir-meta">7 countries · 6 eras<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/audit" class="dir-card rise admin-only" style="--c:#f59e0b">
        <div class="dir-icon">${icon('search', { size: 23 })}</div>
        <div class="dir-title">Codebase Audit</div>
        <div class="dir-desc">Read-only audit report — architecture, issues, technical debt, risk matrix, and remediation plan.</div>
        <div class="dir-meta">10 areas · 14 issues<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/commodity-report" class="dir-card rise admin-only" style="--c:#ef4444">
        <div class="dir-icon">${icon('coins', { size: 23 })}</div>
        <div class="dir-title">Commodity Economy Report</div>
        <div class="dir-desc">Supply/demand analysis, extraction capacity, demand breakdown, and proposed solutions for chronic shortages.</div>
        <div class="dir-meta">29 commodities · 8 critical<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/election-map" class="dir-card rise" style="--c:#f472b6">
        <div class="dir-icon">${icon('map', { size: 23 })}</div>
        <div class="dir-title">Election Map</div>
        <div class="dir-desc">Upload CSV → interactive US presidential election map. Per-state demographics, leans, and EV breakdown. Switch between 1991 and 2019 baselines.</div>
        <div class="dir-meta">CSV upload · 51 states<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="/election-audit" class="dir-card rise" style="--c:#3b82f6">
        <div class="dir-icon">${icon('vote', { size: 23 })}</div>
        <div class="dir-title">Election Demographic Audit</div>
        <div class="dir-desc">State-level demographic lean breakdown: 12 archetypes, 2019 vs 1991 census baselines, EV distribution, and political alignment analysis.</div>
        <div class="dir-meta">51 states · 538 EV<span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>
      </a>
      <a href="https://workflows.lakesidegames.net" target="_blank" rel="noopener" class="dir-card rise" style="--c:#2ea043">
        <div class="dir-icon">${icon('git-branch', { size: 23 })}</div>
        <div class="dir-title">CI / Workflows</div>
        <div class="dir-desc">Woodpecker CI pipelines, build status, and deployment history.</div>
        <div class="dir-meta">Woodpecker CI<span class="arrow">${icon('external-link', { size: 14 })}</span></div>
      </a>
    </div>
    <div class="section-label" style="margin-top:var(--s-8)">Project Guide</div>
    <div id="guide-panel" class="guide-panel rise" style="display:none">
      <div class="guide-header">
        <div class="guide-title">${icon('book-open', { size: 17 })}Live Project Guide</div>
        <div class="guide-meta">
          <span class="guide-dot" id="guideDot"></span>
          <span id="guideStatus">Loading…</span>
          <span id="guideTime" style="margin-left:auto"></span>
        </div>
      </div>
      <div class="guide-body" id="guideBody"></div>
    </div>
  </div>
  <footer class="app-footer"><p>${_loginBrand.homeLabel} · <a href="${_loginBrand.homeLink}">${_loginBrand.homeLabel}</a></p></footer>
</div>
<script>
(function(){
  var sso=new URLSearchParams(location.search).get('sso');
  var err=document.getElementById('login-error');
  var tenantName=${JSON.stringify(TENANT.name)};
  if(sso==='expired') err.textContent='Sign-in expired. Try '+tenantName+' again.';
  else if(sso==='forbidden') err.textContent='That '+tenantName+' account is not ops staff.';
})();
async function doLogin(){
  var email=document.getElementById('email').value;
  var pw=document.getElementById('password').value;
  var err=document.getElementById('login-error');
  err.textContent='';
  if(!email||!pw){err.textContent='Email and password required';return;}
  try{
    var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,password:pw})});
    if(r.ok){var d=await r.json();showApp(d.role||'admin');}
    else{var d=await r.json();err.textContent=d.error||'Invalid credentials';}
  }catch(e){err.textContent='Connection error';}
}
if(document.getElementById('password'))document.getElementById('password').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
if(document.getElementById('email'))document.getElementById('email').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('password').focus();});
async function doLogout(){await fetch('/api/logout',{method:'POST'});location.reload();}
function showApp(role){
  document.getElementById('login-view').style.display='none';
  document.getElementById('app-view').style.display='block';
  if(role==='moderator'){
    document.querySelectorAll('.admin-only').forEach(function(el){el.style.display='none';});
  }
  loadStatus();if(role==='admin')loadCounts();
}
async function loadStatus(){
  try{
    var r=await fetch('/api/status');if(!r.ok)return;
    var data=await r.json();
    var services=data.services||[];
    var down=services.filter(function(s){return s.current!=='operational';});
    var dot=document.getElementById('status-dot');
    var title=document.querySelector('.status-title');
    var sub=document.querySelector('.status-sub');
    if(!down.length){dot.className='status-dot ok';title.textContent='All Systems Operational';sub.textContent=services.length+' services healthy';}
    else if(down.length<services.length){dot.className='status-dot warn';title.textContent='Partial Degradation';sub.textContent=down.map(function(s){return s.name;}).join(', ')+' affected';}
    else{dot.className='status-dot error';title.textContent='System Outage';sub.textContent='Multiple services down';}
  }catch(e){}
}
async function loadCounts(){
  try{var r=await fetch('/api/backups');if(r.ok){var d=await r.json();document.getElementById('backup-count').textContent=d.total||0;}}catch(e){}
  try{var r=await fetch('/api/db/stats');if(r.ok){var d=await r.json();document.getElementById('db-count').textContent=d.collections||0;}}catch(e){}
  try{document.getElementById('learn-progress').textContent='7';}catch(e){}
  loadGuide();
}
var guideContent='';
function simpleMd(md){
  var h=md.replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]});
  h=h.replace(/^###### (.*$)/gim,'<h6>$1</h6>').replace(/^##### (.*$)/gim,'<h5>$1</h5>').replace(/^#### (.*$)/gim,'<h4>$1</h4>').replace(/^### (.*$)/gim,'<h3>$1</h3>').replace(/^## (.*$)/gim,'<h2>$1</h2>').replace(/^# (.*$)/gim,'<h1>$1</h1>');
  h=h.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>');
  h=h.replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>');
  h=h.replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g,'<pre><code>$1</code></pre>');
  h=h.replace(/^\> (.*$)/gim,'<blockquote>$1</blockquote>');
  h=h.replace(/^\- (.*$)/gim,'<li>$1</li>');
  h=h.replace(/\\n/g,'<br>');
  return h;
}
async function loadGuide(){
  var panel=document.getElementById('guide-panel');
  var body=document.getElementById('guideBody');
  var dot=document.getElementById('guideDot');
  var status=document.getElementById('guideStatus');
  var time=document.getElementById('guideTime');
  if(!panel)return;
  try{
    var r=await fetch('/api/project-guide');
    if(r.status===404){panel.style.display='none';return;}
    if(!r.ok)throw new Error('HTTP '+r.status);
    var d=await r.json();
    if(d.content!==guideContent){
      guideContent=d.content;
      body.innerHTML=simpleMd(d.content);
    }
    var mod=new Date(d.lastModified);
    time.textContent=mod.toLocaleString();
    dot.className='guide-dot live';
    status.textContent='Live';
    panel.style.display='block';
  }catch(e){
    dot.className='guide-dot error';
    status.textContent='Error';
    if(!guideContent)panel.style.display='none';
  }
}
setInterval(loadGuide,30000);
// Check existing session on page load
fetch('/api/me').then(function(r){if(r.ok)return r.json();}).then(function(d){if(d)showApp(d.role);});
</script>
${THEME_TOGGLE_JS}
</body>
</html>`;


// ─── BACKUPS PAGE ──────────────────────────────────────────────────
const BACKUPS_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Backups — ${escHtml(TENANT.dashboardTitle)}</title>
${THEME_HEAD}
<link rel="icon" href="${faviconFor('package')}">
${FONT_LINKS}
<style>${BASE_CSS}
.container{max-width:980px}
.backup-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:var(--s-4)}
.backup-card{position:relative;display:flex;flex-direction:column;gap:var(--s-3);padding:var(--s-5);border-radius:var(--r-lg);border:1px solid var(--border);background:linear-gradient(180deg,var(--glass-2),var(--glass-1));backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);cursor:pointer;transition:transform var(--t),border-color var(--t),box-shadow var(--t)}
.backup-card:hover{transform:translateY(-3px);border-color:var(--border-2);box-shadow:var(--shadow)}
.b-top{display:flex;align-items:center;gap:var(--s-3)}
.backup-icon{display:flex;align-items:center;justify-content:center;width:40px;height:40px;color:var(--accent);border-radius:var(--r-md);background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 28%,transparent);flex-shrink:0}
.backup-date{font-size:1rem;font-weight:700}
.backup-meta{display:flex;align-items:center;gap:.4rem;font-size:.8125rem;color:var(--text-2)}
.backup-meta .sep{color:var(--text-3)}
.backup-size{color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}
.backup-card .arrow{margin-left:auto;color:var(--text-3);transition:transform var(--t),color var(--t)}
.backup-card:hover .arrow{transform:translateX(3px);color:var(--accent)}
.detail-view{display:none}.detail-view.active{display:block;animation:rise .4s var(--ease) both}
.detail-header{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--s-4);margin-bottom:var(--s-5);flex-wrap:wrap}
.detail-title{font-size:1.25rem;font-weight:700;margin-top:.45rem}
.search-input{width:280px;max-width:100%}
.table-wrap{border-radius:var(--r-lg);border:1px solid var(--border);overflow:hidden;background:linear-gradient(180deg,var(--glass-2),var(--glass-1));backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
table{width:100%;border-collapse:collapse;font-size:.875rem}
thead th{text-align:left;padding:.7rem 1rem;background:var(--glass-2);color:var(--text-3);font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)}
tbody td{padding:.7rem 1rem;border-bottom:1px solid var(--border);color:var(--text-2);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr{transition:background var(--t)}
tbody tr:hover td{background:var(--glass-1)}
td strong{color:var(--text);font-weight:600}
.mono{font-family:var(--mono);font-size:.8125rem;font-variant-numeric:tabular-nums}
.check{color:var(--green);display:inline-flex}.dash{color:var(--text-3)}
.size-bar-track{height:6px;min-width:80px;background:var(--glass-3);border-radius:var(--r-full);overflow:hidden}
.size-bar{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-2));border-radius:var(--r-full);transition:width .4s var(--ease)}
@media(max-width:640px){.search-input{width:100%}.detail-header{flex-direction:column}}
</style>
</head>
<body>
${themeToggle('fixed')}
<div class="container">
  <div class="topbar">
    <a href="/" class="back-link">${icon('arrow-left', { size: 16 })}Dashboard</a>
    <div class="page-title">${icon('package', { size: 22 })}Backup Archives</div>
  </div>
  <div id="list-view">
    <div id="backups-list">
      <div class="backup-grid">
        <div class="backup-card" style="cursor:default"><div class="b-top"><div class="skeleton" style="width:40px;height:40px;border-radius:var(--r-md)"></div><div style="flex:1"><div class="skeleton" style="height:.9rem;width:65%"></div></div></div><div class="skeleton" style="height:.75rem;width:55%"></div></div>
        <div class="backup-card" style="cursor:default"><div class="b-top"><div class="skeleton" style="width:40px;height:40px;border-radius:var(--r-md)"></div><div style="flex:1"><div class="skeleton" style="height:.9rem;width:55%"></div></div></div><div class="skeleton" style="height:.75rem;width:60%"></div></div>
        <div class="backup-card" style="cursor:default"><div class="b-top"><div class="skeleton" style="width:40px;height:40px;border-radius:var(--r-md)"></div><div style="flex:1"><div class="skeleton" style="height:.9rem;width:70%"></div></div></div><div class="skeleton" style="height:.75rem;width:50%"></div></div>
      </div>
    </div>
  </div>
  <div id="detail-view" class="detail-view">
    <div class="detail-header">
      <div><a href="#" onclick="showList();return false" class="back-link">${icon('arrow-left', { size: 16 })}All backups</a><div class="detail-title" id="detail-title"></div></div>
      <input type="text" class="field search-input" id="coll-search" placeholder="Search collections…" oninput="filterCollections()">
    </div>
    <div class="table-wrap">
      <table><thead><tr><th style="width:48px">#</th><th>Collection</th><th style="width:110px">BSON</th><th style="width:90px">Metadata</th><th style="width:140px">Relative Size</th></tr></thead><tbody id="coll-tbody"></tbody></table>
    </div>
  </div>
</div>
<script>
var allCollections=[],maxSize=0;
function escapeHtml(value){return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

async function loadBackups(){
  var list=document.getElementById('backups-list');
  try{
    var r=await fetch('/api/backups');
    if(r.status===401){window.location.href='/';return;}
    var data=await r.json();
    if(!data.backups||!data.backups.length){list.innerHTML='<div class="empty"><div class="e-ico">${icon('package')}</div>No backups found</div>';return;}
    list.innerHTML='<div class="backup-grid">'+data.backups.map(function(b){
      return '<div class="backup-card rise" data-date="'+escapeHtml(b.date)+'">'+
        '<div class="b-top"><div class="backup-icon">${icon('package', { size: 19 })}</div><div class="backup-date">'+escapeHtml(String(b.date).replace(/_/g,' '))+'</div></div>'+
        '<div class="backup-meta"><span>'+escapeHtml(b.collections)+' collections</span><span class="sep">·</span><span class="backup-size">'+escapeHtml(formatBytes(b.totalBytes))+'</span><span class="arrow">${icon('arrow-right', { size: 15 })}</span></div>'+
      '</div>';
    }).join('')+'</div>';
    list.querySelectorAll('.backup-card').forEach(function(card){
      card.addEventListener('click',function(){showDetail(this.getAttribute('data-date'));});
    });
  }catch(e){list.innerHTML='<div class="empty"><div class="e-ico">${icon('alert-triangle')}</div><span class="err-text">Error: '+escapeHtml(e.message)+'</span></div>';}
}

async function showDetail(date){
  document.getElementById('list-view').style.display='none';
  document.getElementById('detail-view').classList.add('active');
  document.getElementById('detail-title').textContent=date.replace(/_/g,' ');
  var tbody=document.getElementById('coll-tbody');
  tbody.innerHTML='<tr><td colspan="5"><div class="loading"><div class="spinner"></div>Loading collections…</div></td></tr>';
  try{
    var r=await fetch('/api/backups/'+encodeURIComponent(date));
    var data=await r.json();
    allCollections=data.collections||[];
    if(allCollections.length>0){maxSize=Math.max.apply(null,allCollections.map(function(c){return c.bsonBytes||0;}));}
    renderCollections(allCollections);
  }catch(e){tbody.innerHTML='<tr><td colspan="5"><span class="err-text">Error: '+escapeHtml(e.message)+'</span></td></tr>';}
}

function showList(){document.getElementById('list-view').style.display='block';document.getElementById('detail-view').classList.remove('active');}

function filterCollections(){
  var q=document.getElementById('coll-search').value.toLowerCase();
  renderCollections(allCollections.filter(function(c){return c.collection.toLowerCase().indexOf(q)!==-1;}));
}

function renderCollections(collections){
  var tbody=document.getElementById('coll-tbody');
  if(!collections.length){tbody.innerHTML='<tr><td colspan="5"><div class="empty">No collections match your search</div></td></tr>';return;}
  tbody.innerHTML=collections.map(function(c,i){
    var pct=maxSize>0?(c.bsonBytes/maxSize*100):0;
    var hasMeta=c.metadataBytes&&c.metadataBytes>0;
    return '<tr>'+
      '<td class="mono" style="color:var(--text-3)">'+(i+1)+'</td>'+
      '<td><strong>'+escapeHtml(c.collection)+'</strong></td>'+
      '<td class="mono">'+formatBytes(c.bsonBytes||0)+'</td>'+
      '<td>'+(hasMeta?'<span class="check">${icon('check', { size: 16 })}</span>':'<span class="dash">—</span>')+'</td>'+
      '<td><div class="size-bar-track"><div class="size-bar" style="width:'+pct+'%"></div></div></td>'+
    '</tr>';
  }).join('');
}

function formatBytes(bytes){if(!bytes)return'0 B';var k=1024,sizes=['B','KB','MB','GB'],i=Math.floor(Math.log(bytes)/Math.log(k));return parseFloat((bytes/Math.pow(k,i)).toFixed(1))+' '+sizes[i];}

loadBackups();
</script>
${THEME_TOGGLE_JS}
</body>
</html>`;


// ─── DB EXPLORER PAGE ──────────────────────────────────────────────
const DB_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Database Explorer — ${escHtml(TENANT.dashboardTitle)}</title>
${THEME_HEAD}
<link rel="icon" href="${faviconFor('database')}">
${FONT_LINKS}
<style>${BASE_CSS}
.container{max-width:1140px}
#login-view{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.login-card{width:100%;max-width:400px;padding:var(--s-8);border-radius:var(--r-xl);background:linear-gradient(180deg,var(--glass-2),var(--glass-1));border:1px solid var(--border);backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);box-shadow:var(--shadow-lg)}
.login-brand{display:flex;align-items:center;justify-content:center;width:56px;height:56px;color:var(--accent);border-radius:var(--r-lg);background:linear-gradient(180deg,var(--glass-3),var(--glass-1));border:1px solid var(--border);margin:0 auto var(--s-5)}
.login-card h1{font-size:1.4rem;font-weight:700;text-align:center}
.login-card .subtitle{color:var(--text-3);font-size:.9rem;text-align:center;margin-top:.3rem;margin-bottom:var(--s-6)}
.form-group{margin-bottom:var(--s-4)}
.form-group label{display:block;font-size:.8125rem;font-weight:500;color:var(--text-2);margin-bottom:.4rem}
.login-error{min-height:1.25rem;color:var(--red);font-size:.8125rem;margin-bottom:var(--s-2);text-align:center}
.login-card .btn{width:100%;margin-top:var(--s-2);padding:.72rem}
.read-only{margin-left:auto;display:inline-flex;align-items:center;gap:.35rem;font-size:.6875rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:.3rem .65rem;border-radius:var(--r-full);background:var(--accent-soft);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 28%,transparent)}
.collections{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:var(--s-3);margin-bottom:var(--s-6)}
.coll-btn{display:flex;flex-direction:column;gap:.3rem;padding:var(--s-4);border-radius:var(--r-md);border:1px solid var(--border);background:var(--surface);box-shadow:var(--e1),var(--hi);cursor:pointer;text-align:left;color:var(--text);transition:all var(--t)}
.coll-btn:hover{border-color:var(--border-2);transform:translateY(-2px)}
.coll-btn.active{border-color:var(--accent);background:var(--accent-soft);box-shadow:inset 0 0 0 1px var(--accent)}
.coll-name{font-weight:600;font-size:.9rem;word-break:break-word}
.coll-count{color:var(--text-3);font-size:.75rem;font-variant-numeric:tabular-nums}
.doc-viewer{border-radius:var(--r-lg);border:1px solid var(--border);overflow:hidden;background:var(--surface);box-shadow:var(--e1),var(--hi)}
.doc-toolbar{display:flex;align-items:center;gap:var(--s-3);padding:var(--s-4);border-bottom:1px solid var(--border);flex-wrap:wrap}
.doc-toolbar .filter-input{flex:1;min-width:200px}
.doc-toolbar select.field{width:auto;flex:0 0 auto}
.doc-count{margin-left:auto;color:var(--text-3);font-size:.8125rem;font-variant-numeric:tabular-nums;white-space:nowrap}
.doc-content{padding:var(--s-5);max-height:70vh;overflow:auto}
.doc-block{padding:var(--s-4);border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-0);margin-bottom:var(--s-3)}
.doc-block:last-child{margin-bottom:0}
.doc-block-head{font-family:var(--mono);font-size:.6875rem;font-weight:600;color:var(--text-3);margin-bottom:.5rem;letter-spacing:.04em}
.json{font-family:var(--mono);font-size:.8125rem;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:var(--text-2)}
.json .key{color:var(--accent)}.json .string{color:var(--ok)}.json .number{color:var(--info)}.json .bool{color:var(--warn)}.json .null{color:var(--text-3)}.json .redacted{color:var(--text-3);font-style:italic}.json .bracket{color:var(--text-3)}.json .comma{color:var(--text-3)}
.jtog{cursor:pointer;border-radius:3px}
.jtog::before{content:'▾';display:inline-block;width:.85em;margin-left:-.85em;font-size:.7em;color:var(--text-3);transition:transform var(--t)}
.jtog:hover::before{color:var(--text)}
.jnode.collapsed>.jtog::before{transform:rotate(-90deg)}
.jnode>.jsum{display:none;color:var(--text-3);font-style:italic;padding:0 .45em;cursor:pointer}
.jnode.collapsed>.jbody{display:none}
.jnode.collapsed>.jsum{display:inline}
.pagination{display:flex;align-items:center;justify-content:center;gap:var(--s-3);padding:var(--s-4);border-top:1px solid var(--border)}
.pagination button{display:inline-flex;align-items:center;gap:.35rem;padding:.45rem .9rem;background:var(--glass-2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);cursor:pointer;font-size:.8125rem;font-weight:500;transition:all var(--t)}
.pagination button:hover:not(:disabled){background:var(--glass-hover);border-color:var(--border-2)}
.pagination button:disabled{opacity:.4;cursor:not-allowed}
.page-info{color:var(--text-3);font-size:.8125rem;font-variant-numeric:tabular-nums;min-width:120px;text-align:center}
@media(max-width:640px){.collections{grid-template-columns:repeat(2,1fr)}.doc-toolbar{flex-direction:column;align-items:stretch}.doc-toolbar select.field{width:100%}.doc-count{margin-left:0;text-align:center}}
</style>
</head>
<body>
${themeToggle('fixed')}
<div id="login-view">
  <div class="login-card rise">
    <div class="login-brand">${icon('lock', { size: 26 })}</div>
    <h1>Authentication Required</h1>
    <p class="subtitle">Sign in to access the database explorer</p>
    <div id="login-error" class="login-error"></div>
    <div class="form-group">
      <label for="email">Email</label>
      <input type="email" id="email" class="field" placeholder="admin@example.com" autocomplete="username" autofocus>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" class="field" placeholder="••••••••" autocomplete="current-password">
    </div>
    <button class="btn" onclick="doLogin()">Sign In</button>
  </div>
</div>
<div id="app-view" class="container" style="display:none">
  <div class="topbar">
    <a href="/" class="back-link">${icon('arrow-left', { size: 16 })}Dashboard</a>
    <div class="page-title">${icon('database', { size: 22 })}Database Explorer</div>
    <span class="read-only">${icon('shield', { size: 13 })}Read Only</span>
  </div>
  <div id="collections" class="collections">
    <div class="coll-btn" style="cursor:default"><div class="skeleton" style="height:.85rem;width:70%"></div><div class="skeleton" style="height:.65rem;width:50%;margin-top:.4rem"></div></div>
    <div class="coll-btn" style="cursor:default"><div class="skeleton" style="height:.85rem;width:60%"></div><div class="skeleton" style="height:.65rem;width:55%;margin-top:.4rem"></div></div>
    <div class="coll-btn" style="cursor:default"><div class="skeleton" style="height:.85rem;width:75%"></div><div class="skeleton" style="height:.65rem;width:45%;margin-top:.4rem"></div></div>
    <div class="coll-btn" style="cursor:default"><div class="skeleton" style="height:.85rem;width:65%"></div><div class="skeleton" style="height:.65rem;width:50%;margin-top:.4rem"></div></div>
  </div>
  <div id="viewer" class="doc-viewer" style="display:none">
    <div class="doc-toolbar">
      <input type="text" id="filter" class="field filter-input" placeholder="Filter by _id or field…">
      <select id="sort" class="field"><option value="_id">Sort by _id</option><option value="-createdAt">Newest first</option><option value="createdAt">Oldest first</option></select>
      <button class="btn" onclick="loadDocs()">Query</button>
      <span class="doc-count" id="doc-count"></span>
    </div>
    <div class="doc-content" id="doc-content"><div class="empty"><div class="e-ico">${icon('database')}</div>Select a collection to browse documents</div></div>
    <div class="pagination" id="pagination"></div>
  </div>
</div>
<script>
var currentCollection='',currentPage=1,totalPages=1;
var PAGE_LIMIT=20;

async function doLogin(){
  var email=document.getElementById('email').value;
  var pw=document.getElementById('password').value;
  var err=document.getElementById('login-error');
  err.textContent='';
  if(!email||!pw){err.textContent='Email and password required';return;}
  try{
    var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,password:pw})});
    if(r.ok){document.getElementById('login-view').style.display='none';document.getElementById('app-view').style.display='block';loadCollections();}
    else{var data=await r.json();err.textContent=data.error||'Invalid credentials';}
  }catch(e){err.textContent='Connection error';}
}
document.getElementById('email').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('password').focus();});
document.getElementById('password').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});

async function loadCollections(){
  var grid=document.getElementById('collections');
  try{
    var r=await fetch('/api/db/collections');
    if(r.status===401){document.getElementById('login-view').style.display='flex';document.getElementById('app-view').style.display='none';return;}
    var data=await r.json();
    var collections=data.collections||[];
    if(!collections.length){grid.innerHTML='<div class="empty">No collections found</div>';return;}
    grid.innerHTML=collections.map(function(c){
      return '<div class="coll-btn'+(c.name===currentCollection?' active':'')+'" data-name="'+c.name+'">'+
        '<div class="coll-name">'+c.name+'</div>'+
        '<div class="coll-count">'+formatNumber(c.count)+' docs · '+formatBytes(c.size)+'</div>'+
      '</div>';
    }).join('');
    grid.querySelectorAll('.coll-btn').forEach(function(btn){
      btn.addEventListener('click',function(){selectCollection(this.getAttribute('data-name'));});
    });
  }catch(e){grid.innerHTML='<div class="empty"><div class="e-ico">${icon('alert-triangle')}</div><span class="err-text">Error: '+escapeHtml(String(e && e.message || e))+'</span></div>';}
}

function selectCollection(name){
  currentCollection=name;currentPage=1;
  document.querySelectorAll('.coll-btn').forEach(function(b){b.classList.remove('active');});
  var btn=document.querySelector('.coll-btn[data-name="'+name+'"]');
  if(btn)btn.classList.add('active');
  document.getElementById('viewer').style.display='block';
  loadDocs();
}

async function loadDocs(){
  var content=document.getElementById('doc-content');
  var filter=document.getElementById('filter').value;
  var sort=document.getElementById('sort').value;
  content.innerHTML='<div class="loading"><div class="spinner"></div>Loading documents…</div>';
  try{
    var params=new URLSearchParams({page:currentPage,limit:PAGE_LIMIT,sort:sort});
    if(filter)params.set('filter',filter);
    var r=await fetch('/api/db/collections/'+encodeURIComponent(currentCollection)+'?'+params);
    var data=await r.json();
    totalPages=data.totalPages||1;
    document.getElementById('doc-count').textContent=formatNumber(data.total)+' documents';
    if(!data.documents||!data.documents.length){content.innerHTML='<div class="empty"><div class="e-ico">${icon('search')}</div>No documents found</div>';document.getElementById('pagination').innerHTML='';return;}
    var html='';
    data.documents.forEach(function(doc,i){
      var n=(currentPage-1)*PAGE_LIMIT+i+1;
      html+='<div class="doc-block"><div class="doc-block-head">#'+n+'</div><div class="json">'+jsonToHtml(doc,0)+'</div></div>';
    });
    content.innerHTML=html;
    var pag='<button onclick="goPage(-1)"'+(currentPage<=1?' disabled':'')+'>${icon('chevron-right', { size: 15 }).replace('icon"', 'icon" style="transform:rotate(180deg)"')}Prev</button>';
    pag+='<span class="page-info">Page '+currentPage+' of '+totalPages+'</span>';
    pag+='<button onclick="goPage(1)"'+(currentPage>=totalPages?' disabled':'')+'>Next${icon('chevron-right', { size: 15 })}</button>';
    document.getElementById('pagination').innerHTML=pag;
  }catch(e){content.innerHTML='<div class="empty"><div class="e-ico">${icon('alert-triangle')}</div><span class="err-text">Error: '+escapeHtml(String(e && e.message || e))+'</span></div>';}
}

function goPage(delta){currentPage=Math.max(1,Math.min(totalPages,currentPage+delta));loadDocs();}

function jsonToHtml(obj,indent){
  if(obj===null)return'<span class="null">null</span>';
  if(obj===undefined)return'<span class="null">undefined</span>';
  if(typeof obj==='string')return'<span class="string">"'+escapeHtml(obj)+'"</span>';
  if(typeof obj==='number')return'<span class="number">'+obj+'</span>';
  if(typeof obj==='boolean')return'<span class="bool">'+obj+'</span>';
  var pad='',i;
  for(i=0;i<indent+1;i++)pad+='  ';
  if(typeof obj==='object'&&!Array.isArray(obj)){
    var keys=Object.keys(obj);
    if(!keys.length)return'<span class="bracket">{}</span>';
    var coll=indent>=2&&keys.length>6?' collapsed':'';
    var h='<span class="jnode'+coll+'"><span class="jtog" onclick="tj(this)"><span class="bracket">{</span></span><span class="jsum" onclick="tj(this)">'+keys.length+(keys.length===1?' key':' keys')+'</span><span class="jbody">';
    keys.forEach(function(key,idx){
      var lk=key.toLowerCase();
      var val;
      if(lk.indexOf('password')!==-1||lk.indexOf('secret')!==-1||lk.indexOf('token')!==-1){val='<span class="redacted">"***"</span>';}
      else{val=jsonToHtml(obj[key],indent+1);}
      h+='<br>'+pad+'<span class="key">"'+escapeHtml(key)+'"</span>: '+val;
      if(idx<keys.length-1)h+='<span class="comma">,</span>';
    });
    h+='<br>'+'  '.repeat(indent)+'</span><span class="bracket">}</span></span>';
    return h;
  }
  if(Array.isArray(obj)){
    if(!obj.length)return'<span class="bracket">[]</span>';
    var acoll=obj.length>8?' collapsed':'';
    var ah='<span class="jnode'+acoll+'"><span class="jtog" onclick="tj(this)"><span class="bracket">[</span></span><span class="jsum" onclick="tj(this)">'+obj.length+(obj.length===1?' item':' items')+'</span><span class="jbody">';
    obj.forEach(function(item,idx){
      ah+='<br>'+pad+jsonToHtml(item,indent+1);
      if(idx<obj.length-1)ah+='<span class="comma">,</span>';
    });
    ah+='<br>'+'  '.repeat(indent)+'</span><span class="bracket">]</span></span>';
    return ah;
  }
  return String(obj);
}
function tj(el){el.parentNode.classList.toggle('collapsed');
}

function escapeHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function formatNumber(n){if(n==null)return'—';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString();}
function formatBytes(b){if(!b)return'0 B';var k=1024,s=['B','KB','MB','GB'],i=Math.floor(Math.log(b)/Math.log(k));return parseFloat((b/Math.pow(k,i)).toFixed(1))+' '+s[i];}

fetch('/api/db/stats').then(function(r){if(r.ok){document.getElementById('login-view').style.display='none';document.getElementById('app-view').style.display='block';loadCollections();}});
</script>
${THEME_TOGGLE_JS}
</body>
</html>`;

const makeAskPage = require('./ask-page');
const ASK_PAGE = makeAskPage(FONT_LINKS, BASE_CSS, LLM_MODEL);

const makeStatusPage = require('./status-page');
const STATUS_PAGE = makeStatusPage(FONT_LINKS, BASE_CSS);

const makeCodeListPage = require('./code-list-page');
const makeCodeCostsPage = require('./code-costs-page');
const { collectPersistedSessions } = require('./code-session-list');
const makeCodeDetailPage = require('./code-page');
const makeTmuxTerminalPage = require('./tmux-terminal-page');
const { detectLiveStatus, latestActiveTasks, parseLiveTranscript, stripTmuxEscapes } = require('./tmux-live-transcript');
const { claudeSessionState } = require('./claude-session-state');
const { claudeTranscriptFromLog } = require('./claude-log-transcript');
const { collectDeliveryStatus } = require('./code-delivery');
const {
  prepareShipChoice,
  maybePostOpsTldrForPr,
  maybePostDevelopmentNotice,
  maybePostProductionRecheck,
  maybePostTicketResolution,
  maybePostTicketContextRequest,
  retryPendingTicketUpdates,
  postDiscordEmbed,
} = require('./ticket-ship-notify');
const { normalizeResolution } = require('./ticket-receipt');
const { ensureTicketContextRequest } = require('./ticket-context');
const { TtlCache, compactUnchangedSnapshot, fingerprintOutput } = require('./live-agent-cache');
const { resolveAgentModel, resolveAgentUsage } = require('./agent-usage');
const { getCostBreakdownAsync, getCostForKind, getCostOverviewAsync, latestSessionForKind, normalizeBreakdownPeriod, peekCostOverview, startCostRefresher, warmCostOverviewAsync } = require('./agent-cost');
const { agentKindFor, answerPendingQuestion, autoTuneAgent, captureTmuxSession, createAgentGroup, deleteAgentGroup, detectAgentMode, detectAttention, detectModelFromOutput, detectPendingQuestion, detectUsageFromOutput, effortsForProvider, enrichLiveSessions, enqueueMessage, flushTmuxQueues, forceFlushQueue, getLastUserMessage, getQueue, getUserImage, getUserMessageAttachments, getUserMessageHistory, getWrapUpState, isHappyAcpSession, isOutputBusy, listAgentGroups, listProcessAgents, listTmuxSessions, maybeAutoApproveAttention, selectableModelsFor, permissionStateFor, refreshAgentCaptures, refreshWrapUpFromOutput, rememberUserMessage, removeQueuedMessage, renameAgentGroup, requestEndSession, safeTmuxName, selectAgentConfig, seedAgentPrompt, sendTmuxInput, sendTmuxKey, setAgentGroup, setAgentTitle, setPermissionMode, spawnOptionsFor, spawnTmuxAgent, sweepDeadSessions, terminateAgent } = require('./tmux-sessions');
const { happySessionIdForTmux, happyTranscript } = require('./happy-bridge');
const {
  cancelSchedule,
  createSchedule,
  listSchedules,
  processDueSchedules,
} = require('./agent-schedule');
setInterval(() => { Promise.all([flushTmuxQueues(), refreshAgentCaptures(), sweepDeadSessions()]).catch(() => {}); }, 2500);
setInterval(() => {
  getDb()
    .then((db) => processDueSchedules(db, { spawnTmuxAgent, seedAgentPrompt, setAgentTitle }))
    .catch((err) => console.error("[agent-schedule]", err.message || err));
}, 15_000);
const liveTranscriptCache = new TtlCache(10_000, 200);
const liveDeliveryCache = new TtlCache(5_000, 100);
// Relay transcripts for happy ACP sessions. The build returns a Promise —
// TtlCache stores it as-is, so concurrent captures share one in-flight fetch.
const happyRelayTranscriptCache = new TtlCache(4_000, 50);
const CODE_LIST_PAGE = makeCodeListPage(FONT_LINKS, BASE_CSS);
const CODE_COSTS_PAGE = makeCodeCostsPage(FONT_LINKS, BASE_CSS);
const CODE_DETAIL_PAGE = makeCodeDetailPage(FONT_LINKS, BASE_CSS);
function tmuxTerminalPage() {
  return makeTmuxTerminalPage(FONT_LINKS);
}

const { makeTicketsListBody, makeTicketDetailBody, OUTCOME_STATUS_TEXT } = require('./tickets-page');

// ticket-file (box CLI) writes one assessment per support ticket: what the
// classifier decided, which GitHub issues it filed, and which issues/PRs it
// judged related, each with its confidence. The page renders it next to the
// tracker's own assessment. Number is coerced before it touches the path.
const TICKET_ASSESS_DIR = process.env.TICKET_ASSESS_DIR || "/var/lib/lakeside-tickets/assessments";
// What each ticket's channel has already been told. Deliberately kept OUTSIDE
// the assessments directory: assessments are a working file that gets reset,
// and a reset must never re-announce to players who already heard once.
const TICKET_ANNOUNCE_LEDGER = path.join(path.dirname(TICKET_ASSESS_DIR), "announced.json");
// Ticket links are opaque: /t/<token>, never /tickets/<number>, so a link posted
// into a player's channel does not carry the ticket number and cannot be walked
// by counting. Generated by the box filer, which owns the ledger.
const TICKET_LINKS_LEDGER = path.join(path.dirname(TICKET_ASSESS_DIR), "links.json");

// Live state from GitHub, read when the page is viewed so a merged PR or a
// closed issue moves the report without waiting for the next sweep. Cached for
// a minute per ticket; on any failure the record's stored copy is used instead,
// so the page never depends on GitHub being reachable.
const stageCache = new Map();
const GH_HEADERS = () => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ""}`,
  "User-Agent": "lakeside-ops",
});

async function liveArtifacts(number, record) {
  const key = String(number);
  const hit = stageCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.artifacts;
  const l = (record && record.latest) || {};
  const repo = l.repo;
  if (!repo || !(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) return (record && record.artifacts) || null;
  const get = async (path) => {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, { headers: GH_HEADERS(), signal: AbortSignal.timeout(3000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const issueNumbers = [...new Set([...(l.issuesFiled || []), ...(l.relatedIssues || [])].map((i) => Number(i && i.number)).filter(Boolean))].slice(0, 6);
  const prNumbers = [...new Set((l.relatedPrs || []).map((p) => Number(p && p.number)).filter(Boolean))].slice(0, 6);
  const out = { issues: [], prs: [], refreshedAt: Date.now(), live: true };
  for (const n of issueNumbers) {
    const d = await get(`issues/${n}`);
    out.issues.push({ number: n, state: d ? String(d.state || "").toUpperCase() : "UNKNOWN", closedAt: (d && d.closed_at) || null, title: (d && d.title) || null });
  }
  for (const n of prNumbers) {
    const d = await get(`pulls/${n}`);
    out.prs.push({ number: n, state: d ? (d.merged_at ? "MERGED" : String(d.state || "").toUpperCase()) : "UNKNOWN", mergedAt: (d && d.merged_at) || null, title: (d && d.title) || null });
  }
  stageCache.set(key, { at: Date.now(), artifacts: out });
  return out;
}

function linksLedger() {
  try { return JSON.parse(fs.readFileSync(TICKET_LINKS_LEDGER, "utf8")) || {}; } catch { return {}; }
}

function ticketForToken(token) {
  const n = linksLedger().numbers?.[String(token || "")];
  return Number.isInteger(n) ? n : null;
}

// Mint the opaque token for a ticket that has none yet (never swept by the
// box filer). Same shape the filer writes, so either side's token resolves.
function mintTicketToken(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    const led = linksLedger() || {};
    led.tokens = led.tokens || {};
    led.numbers = led.numbers || {};
    if (led.tokens[String(n)]) return led.tokens[String(n)];
    const token = crypto.randomBytes(9).toString("base64url");
    led.tokens[String(n)] = token;
    led.numbers[token] = n;
    fs.mkdirSync(path.dirname(TICKET_LINKS_LEDGER), { recursive: true });
    fs.writeFileSync(TICKET_LINKS_LEDGER, JSON.stringify(led, null, 1));
    return token;
  } catch {
    return null;
  }
}

/** The link to show for a ticket: scrambled when we have a token, numeric if not. */
function opsUrlFor(number) {
  const token = linksLedger().tokens?.[String(number)];
  const base = PUBLIC_BASE || "https://ops.lakesidegames.net";
  return token ? `${base}/t/${token}` : `${base}/tickets/${number}`;
}

// Suggestion links are opaque the same way tickets are: /s/<token>, never
// /suggestions/<number>. A separate ledger file, so suggestion numbers can
// never collide with ticket numbers and neither side's shape has to change.
const SUGGESTION_LINKS_LEDGER = path.join(path.dirname(TICKET_ASSESS_DIR), "suggestion-links.json");

function suggestionLinksLedger() {
  try { return JSON.parse(fs.readFileSync(SUGGESTION_LINKS_LEDGER, "utf8")) || {}; } catch { return {}; }
}

function suggestionForToken(token) {
  const n = suggestionLinksLedger().numbers?.[String(token || "")];
  return Number.isInteger(n) ? n : null;
}

// Mint the opaque token for a suggestion on demand. Same two-way shape as the
// ticket ledger, so either side's token resolves.
function mintSuggestionToken(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    const led = suggestionLinksLedger() || {};
    led.tokens = led.tokens || {};
    led.numbers = led.numbers || {};
    if (led.tokens[String(n)]) return led.tokens[String(n)];
    const token = crypto.randomBytes(9).toString("base64url");
    led.tokens[String(n)] = token;
    led.numbers[token] = n;
    fs.mkdirSync(path.dirname(SUGGESTION_LINKS_LEDGER), { recursive: true });
    fs.writeFileSync(SUGGESTION_LINKS_LEDGER, JSON.stringify(led, null, 1));
    return token;
  } catch {
    return null;
  }
}

function announcedLedger() {
  try { return JSON.parse(fs.readFileSync(TICKET_ANNOUNCE_LEDGER, "utf8")) || {}; } catch { return {}; }
}

// Once per TICKET, not once per outcome. The classifier wobbles on thin
// reports (needs-human / duplicate / filed across three consecutive runs), and
// a player must not get a ping for each wobble. The ledger keeps the history;
// any entry at all means this ticket's channel has heard from us.
function alreadyAnnounced(ticket) {
  return (announcedLedger()[String(ticket)] || []).length > 0;
}

// A ticket whose channel is gone can never be announced; stop retrying it.
function markUnreachable(ticket, reason) {
  try {
    const ledger = announcedLedger();
    if (!ledger[String(ticket)]) ledger[String(ticket)] = [];
    if (!ledger[String(ticket)].includes("unreachable")) ledger[String(ticket)].push(`unreachable: ${String(reason).slice(0, 60)}`);
    fs.writeFileSync(TICKET_ANNOUNCE_LEDGER, JSON.stringify(ledger, null, 1));
  } catch { /* advisory */ }
}

function markAnnounced(ticket, outcome) {
  try {
    const ledger = announcedLedger();
    const list = new Set(ledger[String(ticket)] || []);
    list.add(outcome);
    ledger[String(ticket)] = [...list];
    fs.writeFileSync(TICKET_ANNOUNCE_LEDGER, JSON.stringify(ledger, null, 1));
  } catch (e) { console.error("[tickets] could not record the announcement:", e && e.message); }
}
// Outcomes worth telling the ticket's channel about: something changed for the
// reporter, or a human is now on it. "would-file" is deliberately absent.
const ANNOUNCED_OUTCOMES = new Set(["filed", "linked", "duplicate", "already-fixed", "needs-human"]);

// Player-facing status lives in tickets-page.js (OUTCOME_STATUS_TEXT), shared
// with the public page, so the channel message and the page always agree.
// (Sentence case there; the embed lowercases the first letter to fit the
// "Status" field phrasing.)
function playerStatus(outcome) {
  const text = OUTCOME_STATUS_TEXT[outcome || ""] || outcome || "assessed";
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Post the triage result into the ticket's own Discord channel: a general
 * classification the reporter can read, with the report's own page linked in
 * the embed title. That page is the public /t/ view, so the link is useful to
 * a player; the message itself stays a plain status. Confidences stay on the
 * staff view of the page — they are internals, not something to hand a player.
 */
async function postTicketTriage(num) {
  const record = readTicketAssessment(num);
  if (!record || !record.latest) return { skipped: "no assessment" };
  const db = await getDb();
  const ticket = await db.collection("tickets").findOne({ ticketNumber: num });
  if (ticket?.category === "investigation") return { skipped: "private investigation" };
  // TICKET_TRIAGE_CHANNEL overrides the destination: useful to mirror every
  // triage message into a staff channel, and to exercise this path without
  // writing into a player's channel. Accepts an id or a channel name.
  const channelId = process.env.TICKET_TRIAGE_CHANNEL || (ticket && ticket.discordChannelId);
  if (!channelId) return { skipped: "no channel on the ticket" };

  const l = record.latest;
  // A dry run changed nothing, and "verified, not filed (dry run)" is noise in a
  // player's channel. Only outcomes that actually happened get announced.
  if (!ANNOUNCED_OUTCOMES.has(l.outcome)) {
    console.log(`[tickets] no channel message for #${num}: ${l.outcome} changed nothing`);
    return { skipped: `nothing to announce (${l.outcome})` };
  }
  // Once per outcome, per ticket. A later run reaching the same standing says
  // nothing again, however many times it runs.
  if (alreadyAnnounced(num)) {
    console.log(`[tickets] no channel message for #${num}: already announced`);
    return { skipped: "already announced" };
  }
  const url = opsUrlFor(num);
  const status = playerStatus(l.outcome);
  const fields = [
    { name: "Classification", value: `${l.type || "?"} · ${l.severity || "?"}`, inline: true },
    { name: "Status", value: status, inline: true },
  ];
  // Issue links only when the repository is public — a private one would show
  // the player a link they cannot open.
  const filed = (l.issuesFiled || []).filter((i) => record.publicRepo === true);
  if (filed.length) fields.push({ name: "Filed", value: filed.map((i) => `[${i.repo}#${i.number}](${i.url})`).join("\n") });
  const related = [...(l.relatedIssues || []), ...(l.relatedPrs || [])].filter(() => record.publicRepo === true);
  if (related.length) {
    fields.push({ name: "Related", value: related.slice(0, 4).map((r) => `[${r.repo}#${r.number}](${r.url})`).join("\n") });
  }
  const color = l.severity === "p0" ? 0xb60205 : l.severity === "p1" ? 0xd93f0b : 0x9aa4ae;
  const embed = {
    title: `Ticket #${num} — ${String(ticket.title || l.title || "").slice(0, 120)}`,
    url,
    description: String(ticket.description || "").replace(/\s+/g, " ").slice(0, 280) || undefined,
    color,
    fields,
    footer: { text: "Track this report at the link above — no sign-in needed" },
    timestamp: new Date().toISOString(),
  };
  const result = await postDiscordEmbed(channelId, embed);
  console.log(`[tickets] triage message for #${num}:`, JSON.stringify(result).slice(0, 200));
  // Recorded only after a real post, so a failed one is retried rather than
  // silently swallowed.
  if (result && result.posted) markAnnounced(num, l.outcome);
  else if (result && /Unknown Channel|404/.test(String(result.error || ""))) markUnreachable(num, result.error);
  return result;
}

function readTicketAssessment(num) {
  const n = Number.parseInt(num, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  try { return JSON.parse(fs.readFileSync(path.join(TICKET_ASSESS_DIR, `${n}.json`), "utf8")); } catch { return null; }
}
const { makeAgentsBody } = require('./agents-page');
const { makeKnowledgeBody, makeKnowledgeHome } = require('./knowledge-pages');
const { makeKnowledgeGraphBody } = require('./knowledge-graph');
const { makeGraphifyBody, readGraphHTML } = require('./graphify-viewer');
const { makeIdeasBody } = require('./ideas-page');
const { makeEngineBody } = require('./engine-page');
const { makeTrackerBody } = require('./tracker-page');
const { handleKanbanRoute } = require("./kanban-routes");
const { handleSuggestionSwipeRoute } = require("./suggestion-swipe-routes");
const { handleKeirInboxRoute } = require("./keir-inbox-routes");
const { handleCwTelemetryRoute, makeLimiter: makeCwTelemetryLimiter } = require("./cw-telemetry-routes");
const { sharedTelemetry: sharedCwTelemetry } = require("./cw-telemetry-store");
const cwTelemetryAllow = makeCwTelemetryLimiter();
const { handleKeirHubRoute } = require("./keir-hub-routes");
const { handleSecurityRoute } = require("./security-routes");
async function loadTrackerSnapshot() {
  let board = null;
  let error = null;
  let links = null;
  try {
    const port = process.env.TRACKER_PORT || 9741;
    const response = await fetch(`http://127.0.0.1:${port}/board/api/board`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`tracker returned ${response.status}`);
    board = await response.json();
  } catch (cause) {
    error = String((cause && cause.message) || cause);
    console.warn("[tracker] board refresh failed:", error);
  }

  if (board) {
    try {
      const ids = new Set();
      for (const realm of board.realms || []) {
        for (const project of realm.projects || []) {
          for (const phase of project.phases || []) {
            for (const item of phase.items || []) if (item && item.id) ids.add(item.id);
          }
        }
      }
      if (ids.size) {
        const db = await getDb();
        const docs = await db.collection("tracker_items").find(
          { id: { $in: [...ids] } },
          { projection: { id: 1, fields: 1 } },
        ).toArray();
        const ticketTokens = linksLedger().tokens || {};
        const suggestionTokens = suggestionLinksLedger().tokens || {};
        links = {};
        for (const doc of docs) {
          const kind = doc.fields && doc.fields.supportKind;
          const number = doc.fields && doc.fields.supportNumber;
          if ((kind !== "ticket" && kind !== "suggestion") || !Number.isInteger(number)) continue;
          const href = kind === "ticket"
            ? (ticketTokens[String(number)] ? `/t/${ticketTokens[String(number)]}` : `/tickets/${number}`)
            : (suggestionTokens[String(number)] ? `/s/${suggestionTokens[String(number)]}` : `/suggestions/${number}`);
          links[doc.id] = { href, label: kind };
        }
        if (!Object.keys(links).length) links = null;
      }
    } catch (cause) {
      console.error("[tracker] report-link enrichment failed:", cause && cause.message);
      links = null;
    }
  }

  return { board, error, links };
}
const trackerSnapshot = createStaleRefreshCache({
  ttlMs: 10_000,
  load: loadTrackerSnapshot,
  onError: (error) => console.warn("[tracker] refresh failed:", error.message),
});
const { engineHealth } = require('./engine-health');
const { watchtowerScan, REGISTRY_COLLECTION } = require('./watchtower');
const { makeObservatoryBody } = require('./observatory-page');
const { loadWorktreeReport, makeWorktreeBody } = require('./worktree-page');
const { platformEventToken, publishEvent } = require('./platform-events');
const { createEventConsumers } = require('./event-consumers');
const eventConsumers = createEventConsumers({ notify: notifyOpsDiscord });
const { GAMES, checkGamesHealth, checkGamesHealthCached } = require('./games-config');
const { makeGamesBody } = require('./games-page');
const { renderReportSummaryCard, renderReportsFull, REPORT_CSS } = require('./report-card');
const { renderSearchBox, SEARCH_CSS } = require('./search-box');
const { CATALOG: SERVICE_CATALOG } = require('./services-catalog');
const dailyReport = require('./daily-report');
const dashboardReportsSnapshot = createStaleRefreshCache({
  ttlMs: 60_000,
  load: async () => dailyReport.getReports(await getDb(), 1),
  onError: (error) => console.warn("[dashboard-reports] refresh failed:", error.message),
});
let dashboardGamesHealth = null;
let dashboardGamesHealthAt = 0;
let dashboardGamesHealthRefresh = null;
function getDashboardGamesHealthStale() {
  if (!dashboardGamesHealthRefresh && Date.now() - dashboardGamesHealthAt >= 30_000) {
    dashboardGamesHealthRefresh = checkGamesHealthCached()
      .then((snapshot) => {
        dashboardGamesHealth = snapshot;
        dashboardGamesHealthAt = Date.now();
      })
      .catch((error) => {
        console.warn("[dashboard-games] refresh failed:", error.message);
        dashboardGamesHealth = [];
        dashboardGamesHealthAt = Date.now();
      })
      .finally(() => { dashboardGamesHealthRefresh = null; });
  }
  return dashboardGamesHealth || [];
}
const { makeSchedulerBody } = require('./scheduler-page');
const { enqueueCheck, enqueueWorldSim, schedulerSnapshot } = require('./scheduler-service');

// Curated NPP-sim experiment reports for the "Simulation Experiments" category
// on /reports. Scanned from disk so newly-generated pages appear automatically;
// only files that actually exist are listed (no dead links). Ordered
// most-complete-first.
const SIM_REPORT_META = [
  { slug: "sim-experiment-final1500", icon: "🏁", title: "NPP Sim — Full Run (Turn 1,500)", meta: "trial250 · 1991-default · turns 1405–1500" },
  { slug: "sim-experiment-cp1000", icon: "📍", title: "NPP Sim — Checkpoint (Turn 1,000)", meta: "trial250 · 1991-default · turns 905–1000" },
  { slug: "sim-experiment-audit", icon: "🧪", title: "NPP Sim — 500-Turn Audit", meta: "trial250 · 1991-default · turns 405–500" },
];
function buildSimReportLibrary() {
  const dir = require("path").join(__dirname, "reports");
  const out = [];
  for (const m of SIM_REPORT_META) {
    try {
      require("fs").accessSync(require("path").join(dir, `${m.slug}.html`));
    } catch { continue; } // file not generated yet → skip
    out.push({
      href: `/reports/${m.slug}`, icon: m.icon, title: m.title,
      desc: "Fully-autonomous NPP simulation across 8 countries — per-chamber government-control strips, wealth leaderboard with attribution, corporate league table, and end-of-window balance metrics.",
      badge: "Sim", meta: m.meta,
    });
  }
  return out;
}
// Weekly replay reports are generated on a timer → scan disk so they list
// automatically (newest first), no per-file registration.
function buildReplayReportLibrary() {
  const dir = require("path").join(__dirname, "reports");
  let files = [];
  try {
    files = require("fs").readdirSync(dir).filter((f) => /^replay-weekly-[0-9-]+\.html$/.test(f));
  } catch { return []; }
  return files
    .sort()
    .reverse()
    .slice(0, 12)
    .map((f) => {
      const slug = f.replace(/\.html$/, "");
      const date = slug.replace("replay-weekly-", "");
      return {
        href: `/reports/${slug}`, icon: "📹", title: `Weekly Replay Report — ${date}`,
        desc: "Aggregate OpenReplay signal for the week: top pages, entry points, most-clicked elements, frustration/friction hotspots, device split, hourly traffic, and week-over-week deltas.",
        badge: "Replay", meta: `${date} · 7-day window`,
      };
    });
}
// Agent-published reports (written by the report MCP into reports/published/ +
// manifest.json) are scanned from disk so newly-published pages appear on the
// /reports library and are served generically — no per-report code change.
function readPublishedManifest() {
  try {
    return JSON.parse(require("fs").readFileSync(require("path").join(PUBLISHED_REPORTS_DIR, "manifest.json"), "utf8"));
  } catch { return []; }
}
function buildPublishedReportLibrary() {
  return readPublishedManifest()
    .filter((m) => {
      try { require("fs").accessSync(require("path").join(PUBLISHED_REPORTS_DIR, `${m.slug}.html`)); return true; }
      catch { return false; } // manifest entry without a file → skip (dead link)
    })
    .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
    .map((m) => ({
      href: `/reports/${m.slug}`, icon: m.icon || "📄", title: m.title,
      desc: m.summary || "", badge: m.badge || "Published",
      category: m.category || "Published Reports",
      meta: m.publishedAt ? m.publishedAt.slice(0, 10) : "",
    }));
}
// Serve a published report by slug from disk (admin-only). Returns true if it
// handled the request, false to fall through to built-in report routes.
// 403 page for a published report that exists but is not public. Plain text
// here left link recipients staring at a blank-looking page with only a console
// 403 to go on, so this states the cause and the fix.
function renderReportForbiddenPage(slug, signedIn, host) {
  const e = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // safeNextUrl only accepts an absolute https URL on an allowlisted host, so
  // a bare "/reports/<slug>" would be dropped and the deep link lost.
  const next = encodeURIComponent(`https://${host}/reports/${slug}`);
  const action = signedIn
    ? `<p>You are signed in, but this report is admin-only. Ask an admin to publish it publicly
         and the same link will start working for you.</p>`
    : `<p><a class="btn" href="/auth/game?next=${e(next)}">Sign in</a> if you have an ops account.
         Otherwise ask an admin to publish this report publicly.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report not public — ${e(slug)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0f1a;color:#e2e8f0;font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
  main{max-width:34rem;padding:2rem}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  code{background:#1e293b;padding:.1rem .35rem;border-radius:.25rem;font-size:.9em}
  p{color:#94a3b8}
  .btn{display:inline-block;margin-top:.25rem;padding:.5rem 1rem;border-radius:.5rem;
    background:#6366f1;color:#fff;text-decoration:none;font-weight:600}
  .btn:hover{background:#4f46e5}
</style></head><body><main>
<h1>This report is not public</h1>
<p><code>${e(slug)}</code> exists, but it has not been published publicly, so it is only
   viewable by ops admins.</p>
${action}
<p><a href="/reports" style="color:#818cf8">Back to reports</a></p>
</main></body></html>`;
}

function servePublishedReport(pathname, req, res, session) {
  if (!(req.method === "GET" || req.method === "HEAD")) return false;
  const m = /^\/reports\/([a-z0-9][a-z0-9-]{1,79})$/.exec(pathname);
  if (!m) return false;
  const slug = m[1];
  const file = require("path").join(PUBLISHED_REPORTS_DIR, `${slug}.html`);
  // Traversal guard + existence check (only serve real published files).
  if (!file.startsWith(PUBLISHED_REPORTS_DIR + require("path").sep)) return false;
  let html;
  try { html = require("fs").readFileSync(file, "utf8"); } catch { return false; }
  // Reports flagged `public: true` in the manifest are viewable without a session.
  const isPublic = readPublishedManifest().some((m2) => m2.slug === slug && m2.public === true);
  if (!isPublic && (!session || session.role !== "admin")) {
    // A bare text/plain "Forbidden" reads as a broken page to anyone who was
    // handed the link (advisors, playtesters): the only signal is a console
    // 403. Serve a real page that says what happened and what to do about it.
    const signedIn = !!session;
    addSecurityHeaders(res);
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    const host = (req.headers.host || "").toLowerCase();
    res.end(req.method === "HEAD" ? "" : renderReportForbiddenPage(slug, signedIn, host));
    return true;
  }
  addSecurityHeaders(res);
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  res.end(req.method === "HEAD" ? "" : html);
  return true;
}

const agentTokens = require('./agent-tokens');
const knowledgeStore = require('./knowledge-store');
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || (mcpPublicBase() ? `${mcpPublicBase()}/mcp` : "");
const { makePrReviewsBody, makePrReviewDetailBody } = require('./pr-reviews-page');

// Upsert a pr_reviews doc from a reviewPullRequest() result (shared by the
// webhook handler and the manual re-review endpoint).
async function persistPrReview(db, r) {
  await db.collection("pr_reviews").updateOne(
    { repo: r.repo, prNumber: r.prNumber, headSha: r.headSha },
    { $set: { repo: r.repo, prNumber: r.prNumber, headSha: r.headSha, title: r.title, url: r.prUrl, review: r.review, model: r.model, createdAt: new Date() } },
    { upsert: true }
  );
}

// Fetch the current head sha + title for a PR (used to re-review the latest commit).
async function fetchPrHead(repo, prNumber) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: token ? "Bearer " + token : "",
      Accept: "application/vnd.github+json",
      "User-Agent": "ahd-ops-pr-reviews",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`PR fetch ${r.status}`);
  const d = await r.json();
  return { headSha: d.head?.sha, title: d.title, baseRef: d.base?.ref };
}

// Resolve the live GitHub status (open/draft/merged/closed) for a PR.
async function fetchPrLiveState(repo, prNumber) {
  try {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
    const r = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Authorization: token ? "Bearer " + token : "",
        Accept: "application/vnd.github+json",
        "User-Agent": "ahd-ops-pr-reviews",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return "unknown";
    const d = await r.json();
    if (d.merged || d.merged_at) return "merged";
    if (d.state === "closed") return "closed";
    if (d.draft) return "draft";
    if (d.state === "open") return "open";
    return "unknown";
  } catch {
    return "unknown";
  }
}
const { makeSuggestionsListBody, makeSuggestionDetailBody } = require('./suggestions-page');

// The Learning Center content is studio-private and is not in this repository.
// A deployment can add learn/ to its release; without it /learn is a 404.
let learnModule = null;
try {
  learnModule = { ...require('./learn/learn-page-template'), ...require('./learn/learn-data') };
} catch (e) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
}
const CURRICULUM = learnModule ? learnModule.CURRICULUM : [];
const LEARN_PAGE = learnModule ? learnModule.makeLearnPage(FONT_LINKS, BASE_CSS) : null;
const LEARN_LANDING_PAGE = learnModule ? learnModule.makeLearnLandingPage(FONT_LINKS, BASE_CSS) : null;
const AUDIT_PAGE = makeAuditPage(FONT_LINKS, BASE_CSS);





// Build the seed prompt for a "Launch fix" code-agent session. Includes the
// item, its read-only assessment, and explicit instructions to branch off
// `development`, implement, push, and open a PR.
function buildFixSeedPrompt(kind, item, assessment, branchName) {
  const lines = [];
  const num = kind === "ticket" ? item.ticketNumber : item.issueNumber;
  lines.push(
    `You are implementing a fix for a community ${kind} in the "A House Divided" game (Next.js + TypeScript + MongoDB).`,
    `Work on a fresh branch off \`development\` (the session is already configured to branch from development; aim for a branch name like \`${branchName}\`).`,
    `When done, commit your work and open a pull request targeting \`development\` summarising the change.`,
    ``,
    `## ${kind === "ticket" ? "Ticket" : "Suggestion"} #${num}: ${item.title || "(untitled)"}`,
  );
  if (item.category) lines.push(`Category: ${item.category}`);
  if (kind === "suggestion" && item.gameSystem) lines.push(`Game system: ${item.gameSystem}`);
  lines.push(``, `### Description`, item.description || "(none)");
  if (kind === "suggestion" && item.impact) lines.push(``, `### Impact`, item.impact);
  if (kind === "ticket" && Array.isArray(item.messages) && item.messages.length) {
    lines.push(``, `### Reporter messages`);
    for (const m of item.messages.slice(0, 30)) {
      lines.push(`- ${m.authorName || "user"}: ${m.content || ""}`);
      if (Array.isArray(m.imageUrls) && m.imageUrls.length) lines.push(`  images: ${m.imageUrls.join(", ")}`);
    }
  }
  if (kind === "ticket" && Array.isArray(item.imageUrls) && item.imageUrls.length) {
    lines.push(``, `### Attached images`, item.imageUrls.join("\n"));
  }
  if (assessment && assessment.status !== "error") {
    lines.push(``, `### Prior automated assessment (read-only, for guidance)`);
    if (assessment.summary) lines.push(`Summary: ${assessment.summary}`);
    if (Array.isArray(assessment.affectedFiles) && assessment.affectedFiles.length) lines.push(`Likely affected areas: ${assessment.affectedFiles.join(", ")}`);
    if (assessment.complexity) lines.push(`Estimated complexity: ${assessment.complexity}`);
    if (assessment.risk) lines.push(`Estimated risk: ${assessment.risk}`);
    if (assessment.recommendation) lines.push(`Recommendation: ${assessment.recommendation}`);
  }
  lines.push(``, `Start by exploring the relevant code, confirm the root cause, then implement a focused, well-tested fix.`);
  return lines.join("\n");
}

// Seed prompt for automatic ticket repair. It deliberately makes the agent use
// the support MCP as the source of truth: support_get returns the full captured
// conversation and the image blocks, unlike a URL-only handoff.
function buildAutomatedTicketFixPrompt(ticket, extra = {}) {
  const ticketNumber = ticket.ticketNumber;
  // Inline the full reporter thread + every screenshot URL so the agent sees the
  // complete report even if it never calls support_get. (support_get remains the
  // canonical source and the only way to view the images as vision blocks.)
  const threadLines = [];
  const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
  if (messages.length) {
    threadLines.push("", "### Full reporter thread (captured from Discord)");
    for (const m of messages.slice(0, 40)) {
      threadLines.push(`- ${m.authorName || "user"}: ${m.content || ""}`);
      if (Array.isArray(m.imageUrls) && m.imageUrls.length) threadLines.push(`  images: ${m.imageUrls.join(", ")}`);
    }
  }
  // Superset of top-level + per-message images, plus any collected by the worker.
  const imgSet = new Set();
  if (Array.isArray(ticket.imageUrls)) ticket.imageUrls.forEach((u) => u && imgSet.add(String(u)));
  for (const m of messages) if (Array.isArray(m.imageUrls)) m.imageUrls.forEach((u) => u && imgSet.add(String(u)));
  if (Array.isArray(extra.imageUrls)) extra.imageUrls.forEach((u) => u && imgSet.add(String(u)));
  const imageUrls = [...imgSet];
  if (imageUrls.length) threadLines.push("", "### Attached screenshots (inspect all via support_get)", imageUrls.join("\n"));
  return [
    `You own ticket #${ticketNumber}: ${ticket.title || "(untitled)"}.`,
    "This is an automated coding-ticket repair run.",
    "ONLY attempt a fix if this is a genuine product/code defect (bug in game or site code). If it is moderation, interpersonal/support-policy, account-management, a how-to question, or any other non-coding concern: STOP immediately without opening a PR, without committing, and without posting anywhere — leave a one-line explanation in your final response and exit. Do not waste tokens on non-code work.",
    "",
    "First, use the support MCP tool `support_get` with kind `ticket` and number " + ticketNumber + ". Treat that full record as canonical. It includes all reporter messages and screenshot attachments as viewable images: inspect every supplied image before deciding the fix.",
    "Use the relevant MCPs to investigate live context where useful (ops knowledge first, then game-state/engine/GlitchTip/community as applicable). Read the repository instructions and trace the actual implementation; reproduce or otherwise validate the reported behavior before editing.",
    "You may use Discord MCP `discord_read` only to re-read the ticket channel if needed. Never reply in ticket channels, never DM players, never answer Discord messages, and never call `discord_send` (it is disabled). When the verified work is genuinely resolved, use support MCP `support_resolve` with a plain player-facing summary, actions taken, follow-up, and source `agent`; the bot then delivers the receipt and closes the Discord ticket channel.",
    "",
    "As soon as you have a safe, verified coding fix: run the relevant checks, commit, and prepare the PR. Immediately BEFORE opening the PR, call support MCP `support_notify_ops_findings` with kind `ticket`, number " + ticketNumber + ", and a 1–2 paragraph diagnosis (root cause / what you found — not the code-change summary). That posts to #operations with \"PR on the way.\" Then open the PR in the same turn — do not wait for a human nudge or the 30-minute recheck.",
    "",
    "Implement the smallest complete fix in this isolated worktree. Add or update focused tests, run the relevant checks, inspect the diff, commit, push, and open a non-draft GitHub PR whose base branch is exactly `development`. The PR title/body must mention ticket #" + ticketNumber + " (e.g. `ticket-" + ticketNumber + "`). Include a `## What changed` section with 1–2 short paragraphs describing the code change only — that is what ops posts as the PR-link TL;DR.",
    "",
    "DB heals (hard): NEVER apply database heals yourself (no heal_apply, heal_adhoc_apply, heal_rollback, mongosh writes, or one-off update scripts against prod/sandbox). If live data still needs a heal after/with the code fix, call `support_notify_ops_heal` with the reason and a proposed plan so #operations asks an admin to run it.",
    "",
    "Discord rules (hard): Do NOT post to Discord yourself except via `support_notify_ops_findings` / `support_notify_ops_heal` (ops only). Do not reply in the ticket channel. The dashboard posts a human-facing update once when the fix reaches development and once when it reaches production; staging and other promotion steps are silent. Applied heals also post one human-facing update. If the issue is then verified resolved, call `support_resolve`; it records the receipt, and the bot delivers it and closes the ticket channel. Do not call support_set_status with a terminal status. If you cannot make a safe, verified coding fix or cannot open a PR, leave a concise explanation in your final terminal response instead (still no Discord).",
    "",
    "A later `Ticket recheck` message (~30 minutes after open) may arrive. If you already opened a PR, re-call `support_get`, optionally re-read the ticket channel (read-only), and only then update the PR if new info changes the fix. If you somehow still have no PR by recheck time, finish and open one immediately after the findings notify.",
    "",
    "Ticket context (use support_get for the authoritative complete record, including images as viewable blocks):",
    ticket.description || "(no description)",
    ...threadLines,
  ].join("\n");
}

// Resolve fix_sessions / ticket.fixSessionId whether stored as ObjectId or hex string.
function asMongoObjectId(value) {
  if (!value) return null;
  if (typeof value === "object" && (value._bsontype === "ObjectId" || typeof value.toHexString === "function")) {
    return value;
  }
  const raw = String(value);
  if (!/^[a-f0-9]{24}$/i.test(raw)) return null;
  const { ObjectId } = require("mongodb");
  return new ObjectId(raw);
}

async function findFixSession(db, fixSessionId) {
  const id = asMongoObjectId(fixSessionId);
  if (!id) return null;
  return db.collection("fix_sessions").findOne({ _id: id });
}

// Called by the ticket worker after it atomically claims a coding ticket. The
// worktree is created before tmux starts, so every automatic repair has a fresh
// branch based on development and cannot dirty the shared checkout.
// Ticket repair defaults to Cursor Auto (paseo model id `default` / CLI `auto`).
// Override with PASEO_REPAIR_* / TICKET_REPAIR_* env if needed.
const TICKET_REPAIR_PROVIDER = process.env.TICKET_REPAIR_PROVIDER || "cursor";
const TICKET_REPAIR_MODEL = process.env.TICKET_REPAIR_MODEL || "auto";

// Repairs now launch through the Paseo daemon instead of a tmux pane. Paseo owns
// the agent process, so a launch either returns an agent id or throws — where the
// tmux path could only confirm itself by scraping the pane, and a missed await
// once left orphan READY worktrees while every repair died (#998).
//
// The worktree is still provisioned by codeSessionManager, so the branch naming,
// the delivery convention and the `code_sessions` row the dashboard renders are
// unchanged; Paseo is handed the finished directory.
//
// TICKET_REPAIR_LAUNCHER=tmux restores the old path without a deploy. If the
// daemon is down, a launch falls back to tmux on its own rather than failing the
// ticket — an unrepaired ticket is worse than an unfashionable one.
const TICKET_REPAIR_LAUNCHER = process.env.TICKET_REPAIR_LAUNCHER || "paseo";
// OpenCode + Ox Alpha (free, 1M context): opencode.jsonc already runs with
// permission.edit/bash/webfetch = "allow", so the "build" mode below never
// blocks on a prompt for an unattended repair the way cursor's default did.
const PASEO_REPAIR_PROVIDER = process.env.PASEO_REPAIR_PROVIDER || "opencode";
const PASEO_REPAIR_MODEL = process.env.PASEO_REPAIR_MODEL || "openrouter/stealth/ox-alpha";
// Repair agents run unattended, so they must not stall on a permission prompt
// (e.g. WebFetch of a Discord ticket screenshot, or a web search). Modes are
// provider-specific and the daemon rejects a mismatch outright ("Invalid mode
// 'bypass' for provider 'cursor'"), which killed every auto-repair 2026-08-15.
// claude: "bypass" auto-approves everything; cursor: "agent" is its yolo mode.
const PASEO_REPAIR_MODE_DEFAULTS = { claude: "bypass", cursor: "agent", codex: "full-access" };
const PASEO_REPAIR_MODE =
  process.env.PASEO_REPAIR_MODE || PASEO_REPAIR_MODE_DEFAULTS[PASEO_REPAIR_PROVIDER] || null;
const paseoLauncher = require("./paseo-launcher");

async function launchAutomatedTicketFix({ ticket, context, imageUrls } = {}) {
  if (!codeSessionManager) throw new Error("Code session manager not ready");
  const ticketNumber = ticket.ticketNumber;
  if (!Number.isInteger(ticketNumber)) throw new Error("Ticket has no valid ticket number");

  const db = await getDb();
  const existing = ticket.fixSessionId
    ? await findFixSession(db, ticket.fixSessionId)
    : null;
  if (existing) {
    return {
      fixSessionId: existing._id.toHexString(),
      codeSessionId: existing.codeSessionId,
      tmuxName: existing.tmuxName,
      provider: existing.provider || TICKET_REPAIR_PROVIDER,
    };
  }

  const prompt = buildAutomatedTicketFixPrompt(ticket, { context, imageUrls });
  const usePaseo =
    TICKET_REPAIR_LAUNCHER === "paseo" && (await paseoLauncher.daemonReady());
  const launchProvider = usePaseo ? PASEO_REPAIR_PROVIDER : TICKET_REPAIR_PROVIDER;
  const codeSession = await codeSessionManager.createSessionStub({ provider: launchProvider, baseBranch: "development" });
  const initialized = await codeSessionManager.initializeWorktree(codeSession.sessionId, `ticket-${ticketNumber}-repair-${codeSession.sessionId}`);
  await db.collection("code_sessions").updateOne(
    { sessionId: codeSession.sessionId },
    {
      $set: {
        title: `Auto-fix ticket #${ticketNumber}`,
        seedPrompt: prompt,
        ticketNumber,
        status: "active",
        updatedAt: new Date(),
      },
    }
  );

  let tmux = null;
  let paseoAgentId = null;
  try {
    if (usePaseo) {
      // No seed step: the prompt is the launch argument, so there is no window
      // in which the agent is running without having been told what to do.
      const launched = await paseoLauncher.launchAgent({
        cwd: initialized.worktreePath,
        prompt,
        provider: PASEO_REPAIR_PROVIDER,
        model: PASEO_REPAIR_MODEL,
        mode: PASEO_REPAIR_MODE,
        title: `Auto-fix ticket #${ticketNumber}`,
      });
      paseoAgentId = launched.agentId;
    } else {
      // spawnTmuxAgent / seedAgentPrompt are async — missing await here made
      // tmux a Promise, tmux.name undefined, and every auto-repair die with
      // "Invalid tmux session" while orphan READY worktrees sat idle (#998).
      // "yolo" (cursor: --yolo --trust --approve-mcps) force-allows every tool so
      // an unattended repair never blocks on a permission prompt. "auto"
      // (--auto-review) still gates external calls like WebFetch and stalls.
      tmux = await spawnTmuxAgent(TICKET_REPAIR_PROVIDER, initialized.worktreePath, "yolo", TICKET_REPAIR_MODEL, { prompt });
      // For a happy ACP session the gate is relay registration; for a TUI it is
      // the composer. seedAgentPrompt handles both.
      await seedAgentPrompt(tmux.name, prompt, {
        timeoutMs: 60_000,
        confirmMs: 10_000,
        attempts: 2,
      });
    }
    const fix = await db.collection("fix_sessions").insertOne({
      targetType: "ticket",
      targetId: ticket._id,
      ticketNumber,
      codeSessionId: codeSession.sessionId,
      branch: initialized.branchName,
      tmuxName: tmux?.name || null,
      paseoAgentId,
      launcher: usePaseo ? "paseo" : "tmux",
      provider: usePaseo ? PASEO_REPAIR_PROVIDER : TICKET_REPAIR_PROVIDER,
      model: usePaseo ? PASEO_REPAIR_MODEL : (tmux?.model || TICKET_REPAIR_MODEL),
      status: "running",
      launchedBy: "ticket-triage-worker",
      launchedAt: new Date(),
    });
    return {
      fixSessionId: fix.insertedId.toHexString(),
      codeSessionId: codeSession.sessionId,
      tmuxName: tmux?.name || null,
      paseoAgentId,
      provider: usePaseo ? PASEO_REPAIR_PROVIDER : TICKET_REPAIR_PROVIDER,
    };
  } catch (error) {
    if (tmux?.name) {
      try { terminateAgent(`tmux:${tmux.name}`); } catch { /* best-effort */ }
    }
    if (paseoAgentId) {
      await paseoLauncher.killAgent(paseoAgentId);
    }
    // Remove the worktree + branch this failed launch already created, so a launch
    // that throws after initializeWorktree leaves no empty orphan behind (the
    // 2026-08-15 runaway accumulated ~60 of these). deleteSession also drops the
    // code_sessions row.
    await codeSessionManager.deleteSession(codeSession.sessionId).catch(() => {});
    throw error;
  }
}

async function requestAutomatedTicketRecheck(ticket) {
  const fix = ticket.fixSessionId
    ? await findFixSession(await getDb(), ticket.fixSessionId)
    : null;
  if (!fix?.tmuxName && !fix?.paseoAgentId) {
    throw new Error("No live repair-agent session is recorded for this ticket");
  }
  const ticketNumber = ticket.ticketNumber;
  const message = [
    `Ticket recheck — ticket #${ticketNumber} is now thirty minutes old.`,
    `Call support_get again with kind ticket and number ${ticketNumber}.`,
    "Optionally use Discord MCP discord_read (read-only) to re-read the ticket channel. Inspect every new message and image attachment. Do NOT reply in Discord and do NOT call discord_send.",
    "If a development PR for this ticket already exists: revise only if new info changes the diagnosis, then commit/push/update that PR.",
    "If there is still no PR and this is an open coding defect: call support_notify_ops_findings with your findings (PR on the way), then immediately finish checks, commit, push, and open the non-draft PR targeting development (title/body must mention the ticket).",
    "If it is not a coding fix (moderation, account, question, already resolved): stop without committing or opening a PR.",
  ].join("\n");

  // A Paseo agent takes a real message; the tmux path simulates keystrokes.
  // Branch on what the fix session actually recorded, not on the current
  // launcher setting, or a recheck after a launcher change goes to nothing.
  if (fix.paseoAgentId) {
    await paseoLauncher.sendPrompt(fix.paseoAgentId, message);
    return;
  }
  enqueueMessage(fix.tmuxName, message, { displayText: `Ticket #${ticketNumber} · 30-minute recheck` });
}

// ─── SERVER ──────────────────────────────────────────────────────

// /wiki-export is public: cache the built public bundles briefly so bots can't
// hammer prod Mongo (each rebuild pulls ~1MB through the Railway proxy).
let wikiExportCache = null; // { md, json, builtAt }
const WIKI_EXPORT_CACHE_MS = 10 * 60 * 1000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/settings/credentials") {
    const session = await resolveSession(req);
    if (!session) {
      addSecurityHeaders(res);
      res.writeHead(302, {
        Location: AUTH_MODE === "sso" ? "/auth/game?next=%2Fsettings%2Fcredentials" : "/",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    if (session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : renderShell({
      title: "Credentials", active: "/settings/credentials", role: session.role,
      extraCss: credentialPortal.CSS, body: credentialPortal.BODY,
    }));
    return;
  }

  if (pathname === "/api/settings/credentials") {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    if (!credentialPortal.isOpsOrigin(req.headers.origin, OPS_SSO_HOSTS)) return json(res, 403, { error: "Forbidden" });
    const config = credentialPortal.railwayConfig();
    if (!config) return json(res, 503, { error: "Railway integration is not configured" });
    const submitted = await credentialPortal.readCredentialSubmission(req);
    if (submitted.error) return json(res, submitted.status, { error: submitted.error });
    try {
      await credentialPortal.saveCredential(submitted, config);
      return json(res, 200, { ok: true });
    } catch (error) {
      const stage = ["lookup", "target", "write", "confirmation"].includes(error?.stage) ? error.stage : "unknown";
      console.error(`[credential-portal] Railway save failed at ${stage}`);
      return json(res, 502, { error: "Could not save the key to Railway" });
    }
  }

  function featureDisabled(feature) {
    if (isEnabled(feature)) return false;
    addSecurityHeaders(res);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Feature disabled");
    return true;
  }

  // Retire the browser Code workspace and its manual launch endpoints without
  // deleting historical session records or the ticket repair worker.
  if (!isEnabled("codeAgent") && (
    pathname === "/code" || pathname.startsWith("/code/") ||
    pathname === "/api/code" || pathname.startsWith("/api/code/") ||
    /^\/api\/(tickets|suggestions)\/[^/]+\/launch$/.test(pathname) ||
    pathname === "/api/issues/triage" || pathname === "/api/reports/launch"
  )) { featureDisabled("codeAgent"); return; }

  // POST /api/webhooks/github — automated PR review (public; HMAC-verified)
  if (req.method === "POST" && pathname === "/api/webhooks/github") {
    const chunks = [];
    let tooBig = false;
    req.on("data", (c) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 5 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) { res.writeHead(413); res.end("Payload too large"); return; }
      const raw = Buffer.concat(chunks);
      const sig = req.headers["x-hub-signature-256"];
      if (!verifyGithubSig(raw, sig, process.env.GITHUB_WEBHOOK_SECRET)) {
        addSecurityHeaders(res);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad signature" }));
        return;
      }
      // Ack immediately; review runs async so GitHub's delivery doesn't time out.
      addSecurityHeaders(res);
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      const event = req.headers["x-github-event"];
      // GitHub Actions CI/CD results → #operations (post once per completed run).
      if (event === "workflow_run") {
        let wp;
        try { wp = JSON.parse(raw.toString()); } catch { return; }
        if (wp.action !== "completed") return;
        const run = wp.workflow_run || {};
        const repoFull = wp.repository?.full_name || "";
        const conclusion = String(run.conclusion || "unknown").toLowerCase();
        const branch = run.head_branch || "";
        const prNums = (run.pull_requests || []).map((p) => "#" + p.number).join(", ");
        const colorMap = { success: OPS_COLORS.green, failure: OPS_COLORS.red, timed_out: OPS_COLORS.red, cancelled: OPS_COLORS.grey, action_required: OPS_COLORS.yellow, neutral: OPS_COLORS.grey, skipped: OPS_COLORS.grey };
        const emoji = conclusion === "success" ? "✅" : (conclusion === "failure" || conclusion === "timed_out") ? "❌" : conclusion === "cancelled" ? "⏹️" : "🔧";
        notifyOpsDiscord({
          kind: "cicd",
          title: `${emoji} CI ${conclusion} · ${run.name || "workflow"} · ${repoFull}`.slice(0, 240),
          description: run.display_title || run.head_commit?.message || (branch ? "branch " + branch : "Workflow run"),
          url: run.html_url || undefined,
          color: colorMap[conclusion] || OPS_COLORS.blurple,
          fields: [
            ...(branch ? [{ name: "Branch", value: String(branch), inline: true }] : []),
            ...(prNums ? [{ name: "PR", value: prNums, inline: true }] : []),
            ...(run.run_number ? [{ name: "Run", value: "#" + run.run_number, inline: true }] : []),
          ],
          footer: "GitHub Actions",
        }).catch((e) => console.error("[cicd] github workflow_run failed:", e.message));
        console.log("[cicd] workflow_run", JSON.stringify({ repo: repoFull, run: run.run_number, conclusion, branch }));
        return;
      }
      if (event !== "pull_request") return;
      let payload;
      try { payload = JSON.parse(raw.toString()); } catch { return; }
      const pr = payload.pull_request || {};
      const repoFull = payload.repository?.full_name;
      const prNumber = payload.number || pr.number;
      const prUrl = pr.html_url || (repoFull && prNumber ? `https://github.com/${repoFull}/pull/${prNumber}` : "");
      const isMergedDevelopment = payload.action === "closed"
        && pr.merged === true
        && String(pr.base?.ref || "").toLowerCase() === "development";
      if (!["opened", "synchronize", "reopened", "closed"].includes(payload.action)) return;
      // Ticket-repair ops TL;DR — server-side so agents don't have to remember.
      if (payload.action === "opened" || payload.action === "reopened") {
        getDb()
          .then((db) => maybePostOpsTldrForPr(db, {
            repo: repoFull,
            prNumber,
            title: pr.title,
            body: pr.body,
            headRef: pr.head?.ref,
            headSha: pr.head?.sha,
            baseRef: pr.base?.ref,
            prUrl,
          }))
          .then((r) => console.log("[ticket-ship] ops-tldr", JSON.stringify(r)))
          .catch((e) => console.error("[ticket-ship] ops-tldr failed:", e.message));
      }
      if (isMergedDevelopment) {
        getDb()
          .then((db) => maybePostDevelopmentNotice(db, {
            repo: repoFull,
            prNumber,
            title: pr.title,
            body: pr.body,
            headRef: pr.head?.ref,
            headSha: pr.merge_commit_sha || pr.head?.sha,
            baseRef: pr.base?.ref,
          }))
          .then((r) => console.log("[ticket-ship] development-update", JSON.stringify(r)))
          .catch((e) => console.error("[ticket-ship] development-update failed:", e.message));
      }
      if (payload.action === "closed") return;
      reviewPullRequest({
        repo: repoFull,
        prNumber,
        headSha: pr.head?.sha,
        title: pr.title,
        baseRef: pr.base?.ref,
      })
        .then(async (r) => {
          console.log("[pr-review]", JSON.stringify({ reviewed: r.reviewed, key: r.key, length: r.length, discord: r.discord, skipped: r.skipped }));
          // Persist a record for the PR Reviews page (live status is resolved at view time).
          if (r && r.reviewed) {
            try {
              const db = await getDb();
              await persistPrReview(db, r);
            } catch (e) { console.error("[pr-review] persist failed:", e.message); }
          }
        })
        .catch((e) => console.error("[pr-review] failed:", e.message));
    });
    return;
  }

  // POST /api/webhooks/woodpecker — CI/CD pipeline status → Discord (cicd).
  // Optional shared-secret check via WOODPECKER_WEBHOOK_SECRET (matched against
  // the X-Woodpecker-Token header or ?token= query). Defensive: posts a generic
  // embed from whatever fields exist if the payload shape is unfamiliar.
  if (req.method === "POST" && pathname === "/api/webhooks/woodpecker") {
    const secret = process.env.WOODPECKER_WEBHOOK_SECRET;
    if (secret) {
      const provided = req.headers["x-woodpecker-token"] || url.searchParams.get("token") || "";
      if (provided !== secret) {
        addSecurityHeaders(res);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad token" }));
        return;
      }
    }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e6) { body = ""; req.destroy(); } });
    req.on("end", () => {
      // Ack immediately; notification is best-effort.
      addSecurityHeaders(res);
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      let p = {};
      try { p = JSON.parse(body || "{}"); } catch { /* keep generic */ }
      const pipe = p.pipeline || p.build || {};
      const repo = p.repo || {};
      const status = (pipe.status || p.status || "unknown").toLowerCase();
      const repoName = repo.full_name || repo.name || p.repository || "pipeline";
      const branch = pipe.branch || p.branch || "";
      const link = pipe.link || pipe.link_url || p.link || repo.url || "";
      const colorMap = { success: OPS_COLORS.green, failure: OPS_COLORS.red, error: OPS_COLORS.red, killed: OPS_COLORS.grey, blocked: OPS_COLORS.yellow, pending: OPS_COLORS.yellow, running: OPS_COLORS.blurple };
      const emoji = status === "success" ? "✅" : status === "failure" || status === "error" ? "❌" : "🔧";
      notifyOpsDiscord({
        kind: "cicd",
        title: `${emoji} CI ${status} · ${repoName}`.slice(0, 240),
        description: pipe.message || p.message || (branch ? "branch " + branch : "Pipeline event"),
        url: link || undefined,
        color: colorMap[status] || OPS_COLORS.blurple,
        fields: [
          ...(branch ? [{ name: "Branch", value: String(branch), inline: true }] : []),
          ...(pipe.event || p.event ? [{ name: "Event", value: String(pipe.event || p.event), inline: true }] : []),
          ...(pipe.number ? [{ name: "Pipeline", value: "#" + pipe.number, inline: true }] : []),
        ],
        footer: "Woodpecker CI",
      }).catch(() => {});
    });
    return;
  }

  // The desktop app and direct web link open Keir without the studio dashboard.
  if (await require("./portal/studio").handleStudioPortal(req, res, pathname, {
    resolveSession, authMode: AUTH_MODE,
    loginOrigins: [LAKESIDE_AUTH_BASE_URL, LAKESIDE_AUTH_AHD_ORIGIN].filter(Boolean).map(value => { try { return new URL(value).origin; } catch { return null; } }).filter(Boolean),
    upstream: process.env.KEIR_APP_BASE_URL || "http://127.0.0.1:9768",
  })) return;

  // ── Sign in with A House Divided (via lakeside-auth) ──────────────
  // Both ops hostnames keep the same public URLs. Identity proof is handled
  // by lakeside-auth; this server redeems the code, then runs its own Mongo
  // staff/ban check before minting ops_session.
  //
  //   /auth/game     → redirect to lakeside-auth /auth/ahd (AHD cookie ingress)
  //   /auth/handoff  → compatibility shim (old cross-domain hop); same redirect
  //   /auth/callback → redeem code, resolve staff role, set ops_session
  if (req.method === "GET" && pathname === "/auth/game") {
    loginSecurityHeaders(res);
    const origin = opsLoginOrigin(req);
    if (!origin) { signinFailurePage(req, res, 400, "origin"); return; }
    const client = getLakesideAuthClient();
    if (!client) { signinFailurePage(req, res, 503, "unavailable:client"); return; }
    const next = safeNextUrl(new URL(req.url, "http://x").searchParams.get("next") || "") || "/";
    const transaction = opsLoginTransactions.start(req, origin, next);
    if (!transaction) { signinFailurePage(req, res, 503, "busy"); return; }
    const callback = new URL("/auth/callback", origin);
    callback.searchParams.set("state", transaction.state);
    console.log(`[sso] sign-in start state=${stateTag(transaction.state)} cookieReused=${/(?:^|;\s*)__Host-ops_login=/.test(String(req.headers.cookie || ""))}`);
    let location;
    try {
      location = client.loginUrl("ahd", callback.toString(), LAKESIDE_AUTH_AHD_ORIGIN);
    } catch {
      signinFailurePage(req, res, 503, "unavailable:login-url"); return;
    }
    res.writeHead(302, { Location: location, "Set-Cookie": [transaction.cookie, clearNextCookie(req)] });
    res.end();
    return;
  }
  if (req.method === "GET" && pathname === "/auth/handoff") {
    // Establish the transaction on the callback host so its host-only cookie
    // never needs to cross a sibling domain. Keep old bookmarks usable.
    loginSecurityHeaders(res);
    let ret;
    try { ret = new URL(new URL(req.url, "http://x").searchParams.get("return") || ""); } catch { ret = null; }
    const allowed = ret && ret.protocol === "https:" && ret.pathname === "/auth/callback" &&
      !ret.username && !ret.password && !ret.port && !ret.hash && OPS_SSO_HOSTS.includes(ret.hostname);
    if (!allowed) { signinFailurePage(req, res, 400, "return"); return; }
    res.writeHead(302, { Location: new URL("/auth/game", ret.origin).toString() });
    res.end();
    return;
  }
  if (req.method === "GET" && pathname === "/auth/callback") {
    loginSecurityHeaders(res);
    const query = new URL(req.url, "http://x").searchParams;
    const codes = query.getAll("code");
    const states = query.getAll("state");
    const origin = opsLoginOrigin(req);
    if (!origin || codes.length !== 1 || !codes[0] || codes[0].length > 1024 || states.length !== 1) {
      signinFailurePage(req, res, 400, "transaction:malformed"); return;
    }
    const client = getLakesideAuthClient();
    if (!client) { signinFailurePage(req, res, 503, "unavailable:client"); return; }
    const diagnosis = opsLoginTransactions.diagnose(req, states[0], origin);
    const transaction = opsLoginTransactions.consume(req, states[0], origin);
    if (!transaction) {
      console.warn(`[sso] callback unmatched detail=${diagnosis} state=${stateTag(states[0])}`);
      // A replayed callback (back button, double tap) after a successful
      // sign-in: the browser is already signed in, so go in rather than fail.
      const existing = await resolveSession(req).catch(() => null);
      if (existing) { res.writeHead(302, { Location: "/" }); res.end(); return; }
      signinFailurePage(req, res, 400, "transaction:unmatched"); return;
    }
    let redeemed;
    try {
      redeemed = await client.redeem(codes[0]);
    } catch {
      signinFailurePage(req, res, 503, "unavailable:redeem"); return;
    }
    if (!redeemed || !redeemed.identity || redeemed.identity.provider !== "ahd") {
      console.warn("[sso] sign-in failed reason=redeem-empty status=302");
      res.writeHead(302, { Location: "/?sso=expired" }); res.end(); return;
    }
    // The broker checked the live game session. Staff authorization stays local.
    const staff = await resolveStaffFromAhdUser(redeemed.identity.id, {
      emailFallback: redeemed.identity.email,
    });
    if (!staff) {
      console.warn("[sso] sign-in failed reason=not-staff status=302");
      res.writeHead(302, { Location: "/?sso=forbidden" }); res.end(); return;
    }
    console.log(`[sso] sign-in ok state=${stateTag(states[0])}`);
    mintOpsSession(res, staff, transaction.next, req, [clearNextCookie(req)]);
    return;
  }

  // POST /api/login
  if (req.method === "POST" && pathname === "/api/login") {
    if (AUTH_MODE === "sso") return json(res, 403, { error: "Use Lakeside sign-in" });
    const ip = getClientIP(req);
    if (!checkLoginRateLimit(ip)) {
      addSecurityHeaders(res);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many login attempts. Try again in 15 minutes." }));
      return;
    }
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1e6) { body = ""; res.writeHead(413); res.end("Payload too large"); return; }
    });
    req.on("end", async () => {
      try {
        const { email, password } = JSON.parse(body);
        const lookupEmail = email?.toLowerCase();
        const userRecord = USERS.get(lookupEmail);
        if (!lookupEmail || !userRecord) {
          addSecurityHeaders(res);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid credentials" }));
          return;
        }
        const valid = await bcrypt.compare(password, userRecord.hash);
        if (valid) {
          clearLoginAttempts(ip);
          const token = crypto.randomBytes(32).toString("hex");
          // Evict oldest session if at capacity
          if (sessions.size >= MAX_SESSIONS) {
            const [oldestToken] = sessions.keys();
            sessions.delete(oldestToken);
            markSessionsDirty();
          }
          sessions.set(token, { created: Date.now(), email: lookupEmail, role: userRecord.role, source: "local", credentialVersion: credentialVersion(userRecord.hash) });
          markSessionsDirty();
          addSecurityHeaders(res);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": opsSessionCookie(req, token, 86400),
          });
          res.end(JSON.stringify({ ok: true, role: userRecord.role }));
        } else {
          recordLoginFailure(ip);
          addSecurityHeaders(res);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid credentials" }));
        }
      } catch {
        addSecurityHeaders(res);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      }
    });
    return;
  }

  // POST /api/logout
  if (req.method === "POST" && pathname === "/api/logout") {
    opsWebSocketAuth.revoke(req);
    const cookies = (req.headers["cookie"] || "").split(";").map(c => c.trim());
    const sessionCookie = cookies.find(c => c.startsWith("ops_session="));
    if (sessionCookie) {
      const token = sessionCookie.split("=").slice(1).join("=");
      sessions.delete(token);
      markSessionsDirty();
    }
    addSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": "application/json",
      // Clear both the new parent-domain cookie and any legacy host-only one.
      "Set-Cookie": [opsSessionCookie(req, "", 0), "ops_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"],
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /ahd-logo.png — brand logo (public asset, no auth)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/ahd-logo.png") {
    try {
      const p = path.join(__dirname, "public", "ahd-logo.png");
      const stat = fs.statSync(p);
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": stat.size, "Cache-Control": "public, max-age=86400" });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(p).pipe(res);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // GET /downloads - Public AHDClient desktop download portal.
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/downloads" || pathname === "/downloads/")) {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
    res.end(req.method === "HEAD" ? "" : makeDownloadPortal());
    return;
  }

  // GET /downloads/<file> — build artifacts (alpha APKs etc). Public like the
  // logo: links get shared to testers' phones where an ops login is a wall.
  // Filenames are unlisted, strictly validated, and only read from public/downloads.
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/downloads/")) {
    const dl = /^\/downloads\/([A-Za-z0-9][A-Za-z0-9._-]{0,100})$/.exec(pathname);
    const DOWNLOAD_TYPES = {
      ".apk": "application/vnd.android.package-archive",
      ".appimage": "application/vnd.appimage",
      ".deb": "application/vnd.debian.binary-package",
      ".dmg": "application/x-apple-diskimage",
      ".exe": "application/vnd.microsoft.portable-executable",
      ".json": "application/json; charset=utf-8",
      ".rpm": "application/x-rpm",
      ".zip": "application/zip",
      ".txt": "text/plain; charset=utf-8",
    };
    const dlExt = dl ? path.extname(dl[1]).toLowerCase() : "";
    if (dl && DOWNLOAD_TYPES[dlExt] && !dl[1].includes("..")) {
      try {
        const p = path.join(__dirname, "public", "downloads", dl[1]);
        const stat = fs.statSync(p);
        addSecurityHeaders(res);
        res.writeHead(200, {
          "Content-Type": DOWNLOAD_TYPES[dlExt],
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename="${dl[1]}"`,
          "Cache-Control": "no-cache",
        });
        if (req.method === "HEAD") { res.end(); return; }
        fs.createReadStream(p).pipe(res);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Brand marks and icons (public): the studio mark, the Ops and Keir product
  // marks, and their favicon and home-screen renders.
  const BRAND_ASSETS = {
    "/lakeside-mark.svg": ["lakeside-mark.svg", "image/svg+xml"],
    "/ops-mark.svg": ["ops-mark.svg", "image/svg+xml"],
    "/keir-mark.svg": ["keir-mark.svg", "image/svg+xml"],
    "/favicon.ico": ["favicon.ico", "image/x-icon"],
    "/favicon-32.png": ["favicon-32.png", "image/png"],
    "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
    "/keir-favicon-32.png": ["keir-favicon-32.png", "image/png"],
    "/keir-apple-touch-icon.png": ["keir-apple-touch-icon.png", "image/png"],
  };
  if ((req.method === "GET" || req.method === "HEAD") && BRAND_ASSETS[pathname]) {
    const [file, type] = BRAND_ASSETS[pathname];
    try {
      const p = path.join(__dirname, "public", file);
      const stat = fs.statSync(p);
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "public, max-age=86400" });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(p).pipe(res);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // GET /android — Android app download landing (public, pre-launch distribution)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/android") {
    const APK_VERSION = "0.3.0";
    const APK_FILE = "ahd-android-0.3.0.apk";
    const APK_SHA256 = "299bd45b152d9b3b431cc59bf6cca7b6628ab48bc7bc96439c9f61c2d5d1b7bf";
    let sizeMb = "";
    try { sizeMb = (fs.statSync(path.join(__dirname, "downloads", APK_FILE)).size / (1024 * 1024)).toFixed(1) + " MB"; } catch { /* ignore */ }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    if (req.method === "HEAD") { res.end(); return; }
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A House Divided — Android</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0f172a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:24px; }
  .card { max-width:440px; width:100%; background:#1e293b; border:1px solid #334155; border-radius:16px; padding:32px; text-align:center; }
  img { width:72px; height:72px; border-radius:16px; }
  h1 { font-size:22px; margin:16px 0 4px; }
  .ver { color:#94a3b8; font-size:14px; margin-bottom:24px; }
  a.dl { display:block; background:#2563eb; color:#fff; text-decoration:none; font-weight:600;
    padding:14px 20px; border-radius:10px; font-size:16px; }
  a.dl:hover { background:#1d4ed8; }
  .meta { margin-top:20px; font-size:12px; color:#64748b; word-break:break-all; line-height:1.6; text-align:left; }
  .meta b { color:#94a3b8; }
  ol { text-align:left; color:#94a3b8; font-size:13px; line-height:1.7; padding-left:20px; margin-top:20px; }
</style></head><body>
<div class="card">
  <img src="/ahd-logo.png" alt="AHD">
  <h1>A House Divided</h1>
  <div class="ver">Android v${APK_VERSION}${sizeMb ? " · " + sizeMb : ""}</div>
  <a class="dl" href="/downloads/${APK_FILE}">Download APK</a>
  <ol>
    <li>Tap Download APK above.</li>
    <li>Open the file; allow "install from this source" if prompted.</li>
    <li>Launch A House Divided.</li>
  </ol>
  <div class="meta">
    <b>File:</b> ${APK_FILE}<br>
    <b>SHA-256:</b> ${APK_SHA256}
  </div>
</div>
</body></html>`);
    return;
  }

  // GET /downloads/* — Static file serving for one-off exports
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/downloads/")) {
    const filePath = path.join(__dirname, "downloads", pathname.slice("/downloads/".length));
    // Prevent directory traversal
    if (!filePath.startsWith(path.join(__dirname, "downloads"))) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = { ".csv": "text/csv", ".json": "application/json", ".txt": "text/plain", ".html": "text/html", ".apk": "application/vnd.android.package-archive" };
      const contentType = mimeTypes[ext] || "application/octet-stream";
      const isViewable = [".html", ".txt", ".json"].includes(ext);
      res.writeHead(200, {
        "Content-Type": contentType,
        ...(isViewable ? {} : { "Content-Disposition": `attachment; filename="${path.basename(filePath)}"` }),
        "Content-Length": stat.size,
      });
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404); res.end("Not found");
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/dashboard/cache-status") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    return json(res, 200, {
      ready: dashboardSnapshot.peek() !== null &&
        dashboardReportsSnapshot.peek() !== null &&
        dashboardGamesHealthAt > 0,
    });
  }

  // GET / — HTML dashboard
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
    const session = await resolveSession(req);
    if (session && session.role === "admin") {
      const metrics = dashboardSnapshot.getStale();
      const reports = dashboardReportsSnapshot.getStale() || [];
      const gamesHealth = getDashboardGamesHealthStale();
      const warming = dashboardSnapshot.peek() === null || dashboardReportsSnapshot.peek() === null || dashboardGamesHealthAt === 0;
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderDashboard(session, metrics, reports, gamesHealth, warming));
      return;
    }
    if (session && session.role === "moderator") {
      // Minimal moderator landing — no admin widgets (usage bar, triage button,
      // DB/game metrics, error internals, ticket/suggestion KPIs are all omitted).
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderModeratorLanding(session));
      return;
    }
    // Unauthenticated → login page (bcrypt fallback; SSO admins never reach here).
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(LANDING_PAGE);
    return;
  }

  // GET /apps — Apps launcher (admin sees all tools; moderator sees Ask/Status)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/apps") {
    // Apps page removed — services are surfaced in the nav + the dashboard
    // search. Redirect any old links home.
    addSecurityHeaders(res);
    res.writeHead(302, { Location: "/" });
    res.end();
    return;
  }

  // ─── PUBLIC ROUTES (no auth) ────────────────────────────────────

  // GET /backups — Backup browser (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/backups") {
    if (featureDisabled("backups")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(injectNav(BACKUPS_PAGE, "/backups", session));
    return;
  }

  // GET /db — Database explorer (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/db") {
    if (featureDisabled("dbBrowser")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(injectNav(DB_PAGE, "/db", session));
    return;
  }

  // GET /wiki-export — download the game's full wiki as one file (PUBLIC).
  // Live export from the prod wikiPages collection: default is a single Markdown
  // bundle served as an attachment; ?format=json returns the raw pages.
  // Public callers get exactly what the game shows publicly (published, non-private),
  // served from a 10-minute cache. Admin sessions bypass the cache and also get
  // drafts/private pages, with their status marked inline.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/wiki-export") {
    if (featureDisabled("wikiExport")) return;
    const session = await resolveSession(req);
    const isAdmin = !!(session && session.role === "admin");
    addSecurityHeaders(res);
    const wantJson = url.searchParams.get("format") === "json";
    try {
      let md, json;
      const cacheFresh = wikiExportCache && Date.now() - wikiExportCache.builtAt < WIKI_EXPORT_CACHE_MS;
      if (!isAdmin && cacheFresh) {
        ({ md, json } = wikiExportCache);
      } else {
        const db = await getDb();
        // Mirrors the game's public wiki visibility filter (getWikiPageData.ts).
        const filter = isAdmin ? {} : { status: "published", private: { $ne: true } };
        const pages = await db.collection("wikiPages")
          .find(filter, { projection: { _id: 0, slug: 1, title: 1, description: 1, content: 1, tags: 1, category: 1, countryId: 1, status: 1, private: 1, templateType: 1, updatedAt: 1 } })
          .sort({ countryId: 1, category: 1, slug: 1 })
          .toArray();
        const exportedAt = new Date().toISOString();
        const parts = [`# A House Divided — Wiki Export\n\nExported ${exportedAt} · ${pages.length} pages · https://ahousedividedgame.com/wiki\n`];
        for (const p of pages) {
          const meta = [
            `slug: ${p.slug}`,
            p.countryId ? `country: ${p.countryId}` : null,
            p.category ? `category: ${p.category}` : null,
            p.tags && p.tags.length ? `tags: ${p.tags.join(", ")}` : null,
            p.status && p.status !== "published" ? `status: ${p.status}` : null,
            p.private ? "visibility: PRIVATE (admin-only in game)" : null,
            p.updatedAt ? `updated: ${new Date(p.updatedAt).toISOString().slice(0, 10)}` : null,
          ].filter(Boolean).join(" · ");
          parts.push(`\n---\n\n## ${p.title || p.slug}\n\n> ${meta}\n${p.description ? `\n_${p.description}_\n` : ""}\n${p.content || ""}\n`);
        }
        md = parts.join("");
        json = JSON.stringify({ exportedAt, pageCount: pages.length, pages }, null, 2);
        if (!isAdmin) wikiExportCache = { md, json, builtAt: Date.now() };
      }
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": wantJson ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="ahd-wiki-${stamp}.${wantJson ? "json" : "md"}"`,
        "Cache-Control": "public, max-age=600",
      });
      res.end(req.method === "HEAD" ? "" : wantJson ? json : md);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Wiki export failed: ${e.message}`);
    }
    return;
  }

  // ─── Report voting (PUBLIC, no auth) — powers the shareable suggestions report ───
  // Anonymous, one vote per (voter,itemId), last write wins. Stored per-slug as JSON.
  // Only reports flagged public:true in the manifest accept votes.
  const REPORT_VOTES_DIR = require("path").join(__dirname, "reports", "votes");
  function reportVotesFile(slug) {
    if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(slug || "")) return null;
    const pub = readPublishedManifest().some((m) => m.slug === slug && m.public === true);
    if (!pub) return null;
    return require("path").join(REPORT_VOTES_DIR, `${slug}.json`);
  }
  function readReportVotes(file) {
    try { return JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { return { votes: {} }; }
  }

  // GET /api/report-votes?slug=... — public aggregate tallies
  if (req.method === "GET" && pathname === "/api/report-votes") {
    addSecurityHeaders(res);
    const file = reportVotesFile(url.searchParams.get("slug") || "");
    if (!file) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"unknown report"}'); return; }
    const data = readReportVotes(file);
    const tally = {}; const voters = new Set();
    for (const [voter, items] of Object.entries(data.votes || {})) {
      voters.add(voter);
      for (const [id, v] of Object.entries(items)) {
        tally[id] = tally[id] || { up: 0, down: 0 };
        if (v === "up") tally[id].up++; else if (v === "down") tally[id].down++;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ tally, voterCount: voters.size }));
    return;
  }

  // POST /api/report-votes — public; body {slug, voter, id, vote:"up"|"down"|null}
  if (req.method === "POST" && pathname === "/api/report-votes") {
    addSecurityHeaders(res);
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) { body = ""; req.destroy(); } });
    req.on("end", () => {
      try {
        const p = JSON.parse(body || "{}");
        const file = reportVotesFile(String(p.slug || ""));
        if (!file) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"unknown report"}'); return; }
        const voter = String(p.voter || "").slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "");
        if (!voter) { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"voter required"}'); return; }
        require("fs").mkdirSync(REPORT_VOTES_DIR, { recursive: true });
        const data = readReportVotes(file);
        data.votes = data.votes || {};
        data.votes[voter] = data.votes[voter] || {};
        const incoming = (p.votes && typeof p.votes === "object") ? p.votes : (p.id ? { [p.id]: p.vote } : {});
        let n = 0;
        for (const [id, v] of Object.entries(incoming)) {
          if (!/^[ca]\d{1,4}$/.test(String(id))) continue;
          if (v === "up" || v === "down") { data.votes[voter][id] = v; n++; }
          else if (v === null || v === "clear") { delete data.votes[voter][id]; n++; }
          if (Object.keys(data.votes[voter]).length > 500) break;
        }
        require("fs").writeFileSync(file, JSON.stringify(data));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, saved: n }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /reports/extraction-capacity — live extraction-capacity remediation report (admin)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/extraction-capacity") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    try {
      const audit = await computeExtractionAudit(await getDb());
      const { extraCss, body } = renderExtractionReport(audit);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Extraction Capacity", active: "/reports/extraction-capacity", role: session.role, extraCss, body }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(renderShell({ title: "Extraction Capacity", role: session.role, body: `<div style="max-width:800px;margin:40px auto;padding:20px"><h1>Extraction Capacity</h1><p style="color:#ff8a8a">Audit failed: ${escHtml(e.message)}</p></div>` }));
    }
    return;
  }

  // GET /api/extraction-audit — JSON per-state extraction audit (admin)
  if (req.method === "GET" && pathname === "/api/extraction-audit") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"forbidden"}'); return; }
    addSecurityHeaders(res);
    try {
      const audit = await computeExtractionAudit(await getDb());
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(audit));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /replay — OpenReplay analytics digest (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/replay") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    const w = url.searchParams.get("window");
    const sinceHours = w === "24" ? 24 : w === "168" ? 168 : null;
    try {
      const digest = await getReplayDigest(sinceHours);
      const { extraCss, body } = renderReplayDigest(digest, { window: w || "all" });
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Replay Analytics", active: "/replay", role: session.role, extraCss, body }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(renderShell({ title: "Replay Analytics", active: "/replay", role: session.role, body: `<div style="max-width:800px;margin:40px auto;padding:20px"><h1>Replay Analytics</h1><p style="color:#ff8a8a">Could not reach OpenReplay ClickHouse: ${escHtml(e.message)}</p><p style="color:var(--text-3)">Check that the <code>clickhouse</code> container is up (<code>docker ps</code>).</p></div>` }));
    }
    return;
  }

  // GET /api/replay/digest — JSON aggregates (for scheduled digest / external use)
  if (req.method === "GET" && pathname === "/api/replay/digest") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "application/json" }); res.end('{"error":"forbidden"}'); return; }
    addSecurityHeaders(res);
    const w = url.searchParams.get("window");
    const sinceHours = w === "24" ? 24 : w === "168" ? 168 : null;
    try {
      const digest = await getReplayDigest(sinceHours);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(digest));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /ask — Codebase Q&A sandbox page (admin + moderator)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/ask") {
    const session = await resolveSession(req);
    if (!session) { addSecurityHeaders(res); res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(injectNav(ASK_PAGE, "/ask", session, { rootOffset: ".ask-root" })); // persistent ops sidebar
    return;
  }

  // ─── KANBAN ──────────────────────────────────────────────────────
  // Admin product kanban (/kanban, /api/kanban/*). Store: kanban-store.js.
  if (await handleKanbanRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell })) return;

  // ─── SUGGESTION SWIPE ────────────────────────────────────────────
  // Blind two-person triage of unreviewed suggestions (/suggestions/swipe,
  // /api/suggestions/swipe/*). Must run before the /suggestions/<n> route.
  if (await handleSuggestionSwipeRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell, getDb })) return;

  // ─── CORPORATE WARFARE TELEMETRY ─────────────────────────────────
  // Public, write-only ingest of anonymous market-balance snapshots from the game
  // (/api/cw/telemetry). Validated, size-capped and rate-limited per address.
  if (await handleCwTelemetryRoute(req, res, pathname, { addSecurityHeaders, store: sharedCwTelemetry, allow: cwTelemetryAllow, clientIp: getClientIP })) return;

  // ─── KEIR INBOX ──────────────────────────────────────────────────
  // Admin view of every DM to Keir and the itch.io reward claims (/inbox,
  // /api/keir/inbox/*). Data lives in keir-inbox.service; this proxies to it.
  if (await handleKeirInboxRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell })) return;

  // ─── KEIR HUB ────────────────────────────────────────────────────
  // Live view of Keir: workers, tickets, PRs, issues, kanban (/keir, /api/keir/hub).
  if (await handleKeirHubRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell })) return;

  // ─── SECURITY ────────────────────────────────────────────────────
  // Two-host security posture (/security, /api/security[/reprobe]). Facts come
  // from lakeside-security-probe on each VPS; findings are judged here.
  // NOTE: /security/* belongs to the Semgrep MCP via Caddy — only the exact
  // paths above reach this app.
  if (await handleSecurityRoute(req, res, pathname, { resolveSession, addSecurityHeaders, renderShell })) return;

  // ─── TRACKER ─────────────────────────────────────────────────────
  // Long-running projects, goals and checklists.
  //
  // The store lives in lakeside-tracker (:9741), which serves the same data to
  // off-box agents over MCP. Only the DATA crosses that boundary: the page is
  // rendered here, in this dashboard's design system, because a page that looks
  // like a different application inside this one reads as a mistake however good
  // it looks on its own.
  if (req.method === "GET" && pathname === "/api/tracker/cache-status") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    return json(res, 200, { ready: trackerSnapshot.peek() !== null });
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/tracker") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    const snapshot = trackerSnapshot.getStale();
    const { extraCss, body } = makeTrackerBody(snapshot
      ? { ...snapshot, loading: false }
      : { board: null, error: null, links: null, loading: true });
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(
      req.method === "HEAD"
        ? ""
        : renderShell({ title: "Tracker", active: "/tracker", role: session.role, extraCss, body }),
    );
    return;
  }

  // GET /worktrees — fleet-wide delivery and cleanup state (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/worktrees") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const { extraCss, body } = makeWorktreeBody(loadWorktreeReport());
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Worktrees", active: "/worktrees", role: session.role, extraCss, body }));
    } catch (error) {
      return json(res, 503, { error: `Worktree audit unavailable: ${error.message}` });
    }
    return;
  }

  // GET /code — Session list page (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/code") {
    if (featureDisabled("codeAgent")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(injectNav(CODE_LIST_PAGE, "/code", session, { mobileToggle: false }));
    return;
  }

  // GET /code/costs — CodeBurn spend breakdown (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/code/costs") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(injectNav(CODE_COSTS_PAGE, "/code", session));
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/code/tmux/")) {
    const session = await resolveSession(req);
    const tmuxName = safeTmuxName(decodeURIComponent(pathname.slice("/code/tmux/".length)));
    if (!session || session.role !== "admin" || !tmuxName) {
      addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return;
    }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(tmuxTerminalPage());
    return;
  }

  // GET /code/tmux/:name — live terminal for an existing Codex/Claude tmux session.
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/code/tmux/")) {
    const session = await resolveSession(req);
    const tmuxName = safeTmuxName(decodeURIComponent(pathname.slice("/code/tmux/".length)));
    if (!session || session.role !== "admin" || !tmuxName) {
      addSecurityHeaders(res);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(TMUX_TERMINAL_PAGE);
    return;
  }

  // GET /code/session/:id — Session detail page (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/code/session/")) {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(injectNav(CODE_DETAIL_PAGE, "/code", session, { rootOffset: ".ca-root", mobileToggle: false })); // persistent ops sidebar; app root offset right of it
    return;
  }

  // ─── COMMUNITY: TICKETS + SUGGESTIONS (admin) ──────────────────────
  const COMMUNITY_PAGE_SIZE = 25;
  function denyHtml() { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); }

  // Annotate each list item with its triage assessment summary (complexity/risk/
  // recommendedAction) for the list-row badge. Cheap: one find() with a tight
  // projection scoped to the items shown on the page. Prefers the assessment the
  // item links via `assessmentId`, else the latest complete one for that target.
  async function attachTriage(db, kind, items) {
    if (!items || !items.length) return items;
    const ids = items.map((it) => it._id);
    const assessments = await db.collection("assessments")
      .find({ targetType: kind, targetId: { $in: ids }, status: { $ne: "error" } },
        { projection: { targetId: 1, complexity: 1, risk: 1, recommendedAction: 1, createdAt: 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    const byId = new Map();        // assessment _id hex -> assessment
    const latestByTarget = new Map(); // target _id hex -> latest assessment
    for (const a of assessments) {
      byId.set(a._id.toString(), a);
      latestByTarget.set(a.targetId.toString(), a); // sorted asc, so last write = latest
    }
    for (const it of items) {
      const linked = it.assessmentId && byId.get(it.assessmentId.toString());
      const a = linked || latestByTarget.get(it._id.toString()) || null;
      it.triage = a ? { complexity: a.complexity, risk: a.risk, recommendedAction: a.recommendedAction } : null;
    }
    return items;
  }

  // "Easiest wins": assessed, still-actionable (status not_reviewed) suggestions
  // that are quick to clear. Independent of list pagination. Ranks declines +
  // quick_implements first, then complexity asc, risk asc, confidence desc.
  async function buildEasiestWins(db) {
    const COMPLEXITY_RANK = { trivial: 0, small: 1, medium: 2, large: 3 };
    const RISK_RANK = { low: 0, medium: 1, high: 2 };
    let rows;
    try {
      rows = await db.collection("suggestions").aggregate([
        { $match: { status: "not_reviewed", assessmentId: { $ne: null } } },
        { $lookup: { from: "assessments", localField: "assessmentId", foreignField: "_id", as: "a" } },
        { $unwind: "$a" },
        { $match: { "a.status": "complete", $or: [
          { "a.recommendedAction": { $in: ["decline", "quick_implement"] } },
          { $and: [{ "a.complexity": { $in: ["trivial", "small"] } }, { "a.risk": "low" }] },
        ] } },
        { $project: { _id: 0, issueNumber: 1, title: 1,
          complexity: "$a.complexity", risk: "$a.risk",
          recommendedAction: "$a.recommendedAction", confidence: "$a.confidence" } },
      ]).toArray();
    } catch (e) {
      console.error("[suggestions] easiest-wins query failed:", e.message);
      return [];
    }
    const priority = (ra) => (ra === "decline" || ra === "quick_implement" ? 0 : 1);
    rows.sort((x, y) => {
      const p = priority(x.recommendedAction) - priority(y.recommendedAction);
      if (p) return p;
      const c = (COMPLEXITY_RANK[x.complexity] ?? 9) - (COMPLEXITY_RANK[y.complexity] ?? 9);
      if (c) return c;
      const r = (RISK_RANK[x.risk] ?? 9) - (RISK_RANK[y.risk] ?? 9);
      if (r) return r;
      return (y.confidence ?? 0) - (x.confidence ?? 0);
    });
    return rows.slice(0, 8).map((w) => ({
      issueNumber: w.issueNumber,
      title: w.title,
      complexity: w.complexity,
      risk: w.risk,
      reason: w.recommendedAction === "decline" ? "decline"
        : w.recommendedAction === "quick_implement" ? "quick" : "easy",
    }));
  }

  // GET /tickets — list
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/pr-reviews") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const db = await getDb();
      const raw = await db.collection("pr_reviews").find({}).sort({ createdAt: -1 }).limit(60).toArray();
      // Dedupe by repo+PR (keep the most recent review per PR).
      const seen = new Set();
      const dedup = [];
      for (const r of raw) { const k = r.repo + "#" + r.prNumber; if (seen.has(k)) continue; seen.add(k); dedup.push(r); }
      const top = dedup.slice(0, 30);
      const states = await Promise.all(top.map((r) => fetchPrLiveState(r.repo, r.prNumber)));
      const reviews = top.map((r, i) => ({ ...r, state: states[i] }));
      const { extraCss, body } = makePrReviewsBody({ reviews });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "PR Reviews", active: "/pr-reviews", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // GET /pr-review?repo=<owner/name>&pr=<n> — single-PR review portal (admin).
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/pr-review") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const repo = (url.searchParams.get("repo") || "").trim();
      const prNumber = parseInt(url.searchParams.get("pr") || "", 10);
      if (!repo || !Number.isFinite(prNumber)) {
        addSecurityHeaders(res); res.writeHead(400, { "Content-Type": "text/plain" }); res.end("repo and pr query params required");
        return;
      }
      const db = await getDb();
      const review = await db.collection("pr_reviews")
        .find({ repo, prNumber }).sort({ createdAt: -1 }).limit(1).toArray();
      const latest = review[0] || null;
      const state = await fetchPrLiveState(repo, prNumber);
      const { extraCss, body } = makePrReviewDetailBody({ review: latest, state, repo, prNumber });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "PR #" + prNumber, active: "/pr-reviews", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // POST /api/pr-reviews/re-review — manual re-review of a PR's current head (admin).
  if (req.method === "POST" && pathname === "/api/pr-reviews/re-review") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let rawBody = "";
    req.on("data", (c) => { rawBody += c; if (rawBody.length > 1e5) { rawBody = ""; req.destroy(); } });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(rawBody || "{}");
        const repo = (parsed.repo || "").trim();
        const prNumber = parseInt(parsed.prNumber, 10);
        if (!repo || !Number.isFinite(prNumber)) return jsonResponse(400, { error: "repo and prNumber required" });
        const { headSha, title, baseRef } = await fetchPrHead(repo, prNumber);
        const r = await reviewPullRequest({ repo, prNumber, headSha, title, baseRef, force: true });
        if (!r || !r.reviewed) return jsonResponse(502, { error: "review " + (r && r.skipped ? r.skipped : "failed") });
        try { await persistPrReview(await getDb(), r); } catch (e) { console.error("[pr-review] re-review persist failed:", e.message); }
        jsonResponse(200, { ok: true });
      } catch (e) {
        jsonResponse(500, { error: e.message });
      }
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/agents") {
    if (featureDisabled("agentsPage")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const within = (promise, ms) => {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Agents data timed out")), ms); })])
          .finally(() => clearTimeout(timer));
      };
      const tokenPromise = within((async () => {
        const db = await getDb();
        return agentTokens.list(db);
      })(), 8000).catch(() => null);
      const usagePromise = within(getCostBreakdownAsync("today"), 4000).catch(() => null);
      const paseoPromise = within(paseoLauncher.daemonReadyCached(), 4000).catch(() => null);
      // live status of each hosted MCP (for the directory's health dots)
      // Ports come from the catalogue, so a consolidated or retired server is
      // never probed on a port nobody listens on any more.
      const _mcpPorts = Object.fromEntries(require("./mcp-catalog").MCP_DEFS.filter((d) => d.health && d.connect !== "stdio").map((d) => [d.key, d.health]));
      const status = {};
      await Promise.all(Object.entries(_mcpPorts).map(async ([k, port]) => {
        try { status[k] = (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })).ok; }
        catch { status[k] = false; }
      }));
      let worktrees = null;
      try {
        const report = loadWorktreeReport();
        const counts = (report.after || report.before || {}).classifications || {};
        worktrees = (counts.dirty || 0) + (counts["unlanded"] || 0) + (counts["needs-review"] || 0);
      } catch { /* report is generated by the fleet audit timer */ }
      const [tokens, breakdown, paseo] = await Promise.all([tokenPromise, usagePromise, paseoPromise]);
      const todayTokens = breakdown ? (breakdown.byModel || []).reduce((total, model) => total + (Number(model.totalTokens) || 0), 0) : null;
      const operations = {
        paseo,
        todayCost: breakdown ? breakdown.totals.label : peekCostOverview()?.today?.label,
        todayTokens,
        worktrees,
      };
      const { extraCss, body } = makeAgentsBody({ tokens: tokens || [], tokensUnavailable: tokens === null, mcpUrl: MCP_PUBLIC_URL, status, operations });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Agents", active: "/agents", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // GET /api/search — intelligent service/page search: instant keyword scoring
  // + a DeepSeek (local Ollama) semantic rerank + a one-line intent answer.
  if (req.method === "GET" && pathname === "/api/search") {
    const session = await resolveSession(req);
    if (!session || (session.role !== "admin" && session.role !== "moderator")) return json(res, 403, { error: "Forbidden" });
    const q = (url.searchParams.get("q") || "").trim();
    const { CATALOG, keywordSearch } = require("./services-catalog");
    if (!q) return json(res, 200, { results: [], answer: null });
    const kw = keywordSearch(q);
    let answer = null, semIds = [];
    try {
      if (process.env.OLLAMA_URL) {
        const cat = CATALOG.map((c) => `${c.id}: ${c.name} — ${c.desc} [${(c.keywords || []).join(",")}]`).join("\n");
        const r = await fetch(process.env.OLLAMA_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: process.env.LLM_FALLBACK_MODEL || "deepseek-v4-flash:cloud", temperature: 0.2, stream: false,
            messages: [
              { role: "system", content: 'You route searches on an ops platform. Given the catalog and a query, reply ONLY JSON {"ids":[up to 6 relevant catalog ids, best first],"answer":"one short sentence pointing to the right tool"}.' },
              { role: "user", content: `CATALOG:\n${cat}\n\nQUERY: ${q}` },
            ] }),
          signal: AbortSignal.timeout(6000),
        });
        const d = await r.json();
        const txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
        const m = txt.match(/\{[\s\S]*\}/);
        if (m) { const p = JSON.parse(m[0]); semIds = Array.isArray(p.ids) ? p.ids : []; answer = p.answer || null; }
      }
    } catch { /* semantic layer is best-effort */ }
    const byId = {}; CATALOG.forEach((c) => (byId[c.id] = c));
    const ordered = [];
    semIds.forEach((id) => { if (byId[id] && !ordered.includes(byId[id])) ordered.push(byId[id]); });
    kw.forEach((c) => { if (!ordered.includes(c)) ordered.push(c); });
    return json(res, 200, { answer, results: ordered.slice(0, 8).map((c) => ({ id: c.id, name: c.name, desc: c.desc, url: c.url, icon: c.icon, ext: !!c.ext, group: c.group })) });
  }

  // Public health proxy for the localhost-only ideas service, so external
  // monitors (Uptime Kuma) can check it without exposing port 9728.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/healthz/ideas") {
    let ok = false;
    try { ok = (await fetch("http://127.0.0.1:9728/healthz", { signal: AbortSignal.timeout(4000) })).ok; } catch { /* down */ }
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : JSON.stringify({ service: "ideas", ok }));
    return;
  }

  // Reports — full daily operations reports page (carousel + actions).
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    let reports = [];
    try { reports = await dailyReport.getReports(await getDb(), 30); } catch { /* empty */ }
    const { extraCss, body } = renderReportsFull(reports, { simReports: buildSimReportLibrary(), replayReports: buildReplayReportLibrary(), publishedReports: buildPublishedReportLibrary() });
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : renderShell({ title: "Reports", active: "/reports", role: session.role, extraCss, body }));
    return;
  }

  // GET /reports/<slug> — generic serving of agent-published reports (admin).
  // Placed before the built-in per-report routes; only handles slugs that have a
  // published file on disk, otherwise falls through so built-in routes still win.
  if ((req.method === "GET" || req.method === "HEAD") && /^\/reports\/[a-z0-9][a-z0-9-]{1,79}$/.test(pathname)) {
    const session = await resolveSession(req);
    if (servePublishedReport(pathname, req, res, session)) return;
  }

  // POST /api/reports/launch — spawn a code-agent session seeded with a report's
  // action item (the "launch wizard" on the reports page).
  if (req.method === "POST" && pathname === "/api/reports/launch") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) { body = ""; req.destroy(); } });
    req.on("end", async () => {
      try {
        const db = await getDb();
        const bodyData = JSON.parse(body || "{}");
        const report = await dailyReport.getReport(db, String(bodyData.date || ""));
        const action = report && (report.actions || [])[bodyData.idx];
        if (!action) return json(res, 404, { error: "action not found" });
        const seedPrompt = `Daily operations report action (${report.date}) — investigate & fix in the A House Divided codebase.\n\n**${action.title}**\n${action.detail || ""}\n\n${action.agentPrompt || ""}`;
        const codeSession = await codeSessionManager.createSessionStub({ baseBranch: "development" });
        await db.collection("code_sessions").updateOne(
          { sessionId: codeSession.sessionId },
          { $set: { seedPrompt, title: `Report action: ${String(action.title).slice(0, 60)}`, updatedAt: new Date() } }
        );
        return json(res, 200, { codeSessionId: codeSession.sessionId });
      } catch (e) { return json(res, 500, { error: e.message }); }
    });
    return;
  }

  // Daily Operations Report — list (admin) + generate (admin OR a valid agent
  // token, so the recurring Kimi-code job can POST to regenerate).
  if (pathname === "/api/daily-reports") {
    const session = await resolveSession(req);
    if (req.method === "GET" || req.method === "HEAD") {
      if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
      const reports = await dailyReport.getReports(await getDb(), parseInt(url.searchParams.get("limit") || "30", 10));
      return json(res, 200, { reports });
    }
    if (req.method === "POST") {
      const db = await getDb();
      const tokenAuth = await agentTokens.validate(db, req.headers["authorization"]).catch(() => null);
      if (!(session && session.role === "admin") && !tokenAuth) return json(res, 403, { error: "Forbidden" });
      try {
        const report = await dailyReport.buildAndSave(db);
        dashboardReportsSnapshot.refresh().catch(() => {});
        return json(res, 200, { ok: true, report });
      }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
  }

  // Engine — Game Engine Observatory (simulation health).
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/engine") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const health = await enginePageSnapshot.get();
      const { extraCss, body } = makeEngineBody({ health });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Engine", active: "/engine", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // Observatory — Watchtower anomaly feed + audit registry (read-only page).
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/observatory") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const { scan, registry } = await observatoryPageSnapshot.get();
      const { extraCss, body } = makeObservatoryBody({ scan, registry });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Observatory", active: "/observatory", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // Games — the Lakeside Games hub: one card per game with live health checks.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/games") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      // Fresh (uncached) checks — this page IS the health view. 3s cap each.
      const results = await checkGamesHealth({ timeoutMs: 3000 });
      // MetroForge release info: its API health endpoint reports version/sha.
      const extraInfo = {};
      try {
        const r = await fetch("http://127.0.0.1:3403/api/health", { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j) {
            const bits = [j.version && "v" + j.version, (j.sha || j.gitSha || j.commit) && String(j.sha || j.gitSha || j.commit).slice(0, 8)].filter(Boolean);
            if (bits.length) extraInfo.metroforge = bits.join(" · ");
          }
        }
      } catch { /* info is optional */ }
      const { extraCss, body } = makeGamesBody({ games: GAMES, results, extraInfo });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Games", active: "/games", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/scheduler") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    const { extraCss, body } = makeSchedulerBody();
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : renderShell({ title: "Work Scheduler", active: "/scheduler", role: session.role, extraCss, body }));
    return;
  }

  // Audit registry mutations — track a finding (with a re-check date) or resolve one.
  if (req.method === "POST" && pathname === "/api/observatory/registry") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Forbidden" })); return; }
    try {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 1e5) { req.destroy(); return; } }
      const p = JSON.parse(body || "{}");
      const db = await getDb();
      const { ObjectId } = require("mongodb");
      if (p.resolve) {
        await db.collection(REGISTRY_COLLECTION).updateOne(
          { _id: new ObjectId(String(p.resolve)) },
          { $set: { status: "resolved", resolvedAt: new Date(), resolvedBy: session.email || "admin" } });
        addSecurityHeaders(res); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (!p.title) { addSecurityHeaders(res); res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "title required" })); return; }
      // Default re-check horizon by severity: crit=7d, warn=30d, else 90d.
      const days = p.severity === "crit" ? 7 : p.severity === "warn" ? 30 : 90;
      const doc = {
        title: String(p.title).slice(0, 300),
        severity: ["crit", "warn", "info"].includes(p.severity) ? p.severity : "info",
        source: String(p.source || "watchtower").slice(0, 120),
        code: String(p.code || "").slice(0, 120),
        finding: String(p.finding || "").slice(0, 2000),
        turn: p.turn ?? null,
        entity: p.entity && p.entity.type ? { type: String(p.entity.type).slice(0, 40), id: String(p.entity.id || "").slice(0, 60), name: p.entity.name ? String(p.entity.name).slice(0, 120) : null } : null,
        status: "open",
        createdAt: new Date(),
        createdBy: session.email || "admin",
        expiresAt: new Date(Date.now() + days * 86400000),
      };
      // De-dupe: same code+title already open → don't stack.
      const existing = doc.code ? await db.collection(REGISTRY_COLLECTION).findOne({ code: doc.code, status: "open" }) : null;
      if (existing) { addSecurityHeaders(res); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, deduped: true })); return; }
      await db.collection(REGISTRY_COLLECTION).insertOne(doc);
      addSecurityHeaders(res); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Ideas — semantic search over vectorized Discord messages.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/ideas") {
    if (featureDisabled("ideas")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const db = await getDb();
      // Real indexed count = the HNSW service's live vector count (not the old
      // POC collection). Fall back to the messages collection if it's down.
      let count = 0;
      try { count = (await (await fetch("http://127.0.0.1:9728/healthz")).json()).vectors || 0; } catch {}
      if (!count) { try { count = await db.collection("discord_messages").countDocuments(); } catch {} }
      const { extraCss, body } = makeIdeasBody({ count });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Ideas", active: "/ideas", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // Finder — Mac-style project file browser + text editor (admin only).
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/finder") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const { extraCss, body } = makeFinderBody();
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Finder", active: "/finder", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }
  if (pathname === "/api/finder/list") {
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try {
      const p = url.searchParams.get("path");
      const result = await finderFs.listDir(p == null || p === "" ? null : p, { showHidden: true, includeGit: true });
      if (result.error) return json(res, result.status || 400, { error: result.error });
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (pathname === "/api/finder/read") {
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try {
      const p = url.searchParams.get("path");
      if (!p) return json(res, 400, { error: "path required" });
      const result = await finderFs.readFileSafe(p);
      if (result.error) return json(res, result.status || 400, result);
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (pathname === "/api/finder/write") {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 2e6) { req.destroy(); return json(res, 413, { error: "body too large" }); } }
      const payload = JSON.parse(body || "{}");
      if (!payload.path) return json(res, 400, { error: "path required" });
      const result = await finderFs.writeFileSafe(payload.path, payload.content);
      if (result.error) return json(res, result.status || 400, { error: result.error });
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (pathname === "/api/finder/git") {
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try {
      const p = url.searchParams.get("path");
      if (!p) return json(res, 400, { error: "path required" });
      const result = await finderFs.gitSummary(p);
      if (result.error) return json(res, result.status || 400, { error: result.error });
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // Community Voice — Markov mimicry + word cloud over Discord messages.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/community-voice") {
    if (featureDisabled("discordInsights")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const db = await getDb();
      const total = await db.collection("discord_messages").countDocuments();
      const authors = await db.collection("discord_messages").aggregate([
        { $match: { content: { $exists: true, $ne: "" } } },
        { $group: { _id: "$author", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 100 },
      ]).toArray();
      const channels = await db.collection("discord_messages").aggregate([
        { $group: { _id: "$channelName", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 100 },
      ]).toArray();
      const { makeVoiceBody } = require("./community-voice-page");
      const { extraCss, body } = makeVoiceBody({
        total,
        authors: authors.map((a) => ({ name: a._id, count: a.count })).filter((a) => a.name),
        channels: channels.map((c) => ({ name: c._id, count: c.count })).filter((c) => c.name),
      });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Community Voice", active: "/community-voice", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // Community Voice API
  if (pathname === "/api/community-voice/markov") {
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try {
      const author = (url.searchParams.get("author") || "").trim();
      const seed = (url.searchParams.get("seed") || "").trim();
      const n = Math.min(20, Math.max(1, parseInt(url.searchParams.get("n") || "5", 10) || 5));
      if (!author) return json(res, 400, { error: "author required" });
      const result = await generateMarkov(await getDb(), author, seed, n);
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (pathname === "/api/community-voice/wordcloud") {
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try {
      const channel = (url.searchParams.get("channel") || "").trim();
      const author = (url.searchParams.get("author") || "").trim();
      const result = await buildWordCloud(await getDb(), { channel, author });
      return json(res, 200, result);
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // Knowledge graph — visual node-link map of the web (data via /api/knowledge/graph).
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/knowledge/graph") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    const { extraCss, body } = makeKnowledgeGraphBody();
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : renderShell({ title: "Knowledge graph", active: "/knowledge", role: session.role, extraCss, body }));
    return;
  }

  // Graphify — codebase knowledge graph visualizer (graphify-viewer.js).
  // Serves graph.html as a static file so the iframe loads it, and the shell
  // page at /graphify wraps it in the ops dashboard nav/layout.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/graphify/graph.html") {
    const html = readGraphHTML();
    if (!html) return notFound(res);
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : html);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/graphify") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    const { extraCss, body } = makeGraphifyBody();
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : renderShell({ title: "Graphify", active: "/graphify", role: session.role, extraCss, body }));
    return;
  }

  // Knowledge — unified homepage over docs + skills + memory (search + browse).
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/knowledge" || pathname === "/knowledge/")) {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const db = await getDb();
      await knowledgeStore.ensureIndexes(db);
      const col = db.collection(knowledgeStore.COLLECTION);
      const counts = {};
      await Promise.all(["docs", "skills", "memory"].map(async (k) => {
        counts[k] = await col.countDocuments({ kind: k, deletedAt: null });
      }));
      // Recent entries across all kinds (metadata only; bodies load on click).
      const perKind = await Promise.all(["docs", "skills", "memory"].map((k) =>
        knowledgeStore.list(db, k, { limit: 120 })
      ));
      const entries = perKind.flat()
        .map((e) => ({ kind: e.kind, name: e.name, title: e.title, description: e.description, tags: e.tags || [], updatedAt: e.updatedAt }))
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const { extraCss, body } = makeKnowledgeHome({ counts, entries });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Knowledge", active: "/knowledge", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // Skills + Memories — basic card + search views over the knowledge store.
  // (Docs is intentionally separate: its own subdomain + richer UI.)
  for (const [routePath, kind, title] of [["/skills", "skills", "Skills"], ["/memories", "memory", "Memories"]]) {
    if ((req.method === "GET" || req.method === "HEAD") && pathname === routePath) {
      const session = await resolveSession(req);
      if (!session || session.role !== "admin") return denyHtml();
      try {
        const db = await getDb();
        await knowledgeStore.ensureIndexes(db);
        const entries = await knowledgeStore.list(db, kind, { limit: 300 });
        const { extraCss, body } = makeKnowledgeBody({ kind, entries });
        addSecurityHeaders(res);
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.end(req.method === "HEAD" ? "" : renderShell({ title, active: routePath, role: session.role, extraCss, body }));
      } catch (e) {
        addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
      }
      return;
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/tickets") {
    if (featureDisabled("tickets")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const db = await getDb();
      const status = url.searchParams.get("status");
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const filter = status && status !== "all" ? { status } : {};
      const total = await db.collection("tickets").countDocuments(filter);
      const totalPages = Math.max(1, Math.ceil(total / COMMUNITY_PAGE_SIZE));
      const tickets = await db.collection("tickets").find(filter)
        .sort({ createdAt: -1 }).skip((page - 1) * COMMUNITY_PAGE_SIZE).limit(COMMUNITY_PAGE_SIZE).toArray();
      await attachTriage(db, "ticket", tickets);
      const { extraCss, body } = makeTicketsListBody({ tickets, page, totalPages, status, total });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Tickets", active: "/tickets", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // GET /t/<token> — the one page per ticket. The token IS the capability, so
  // it needs no session; a staff session looking at the same URL unlocks the
  // staff blocks. /tickets/<n> stays as a staff-only alias that redirects to
  // the token URL, so there is exactly one address per ticket and it is the
  // scrambled one.
  const ticketDetail = /^\/tickets\/[^/]+$/.test(pathname) ? pathname.split("/")[2] : (/^\/t\/[^/]+$/.test(pathname) ? pathname.split("/")[2] : null);
  if ((req.method === "GET" || req.method === "HEAD") && ticketDetail !== null && !pathname.startsWith("/tickets/report")) {
    // Resolve the capability token before the session check. Never log it.
    const rawRef = decodeURIComponent(ticketDetail);
    // /t/<token> is looked up; /tickets/<n> is parsed. A bad token is a 404,
    // not a redirect to anything guessable.
    const num = pathname.startsWith("/t/") ? ticketForToken(rawRef) : parseInt(rawRef, 10);
    if (!Number.isInteger(num)) {
      addSecurityHeaders(res); res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Unknown ticket link");
      return;
    }
    const session = await resolveSession(req);
    const isStaff = !!session && session.role === "admin";
    // Staff on the numeric alias go to the one page. The token is minted on
    // demand for tickets the filer has not swept yet.
    const privateInvestigation = isStaff && (await (await getDb()).collection("tickets").findOne({ ticketNumber: num }, { projection: { category: 1 } }))?.category === "investigation";
    if (!pathname.startsWith("/t/") && isStaff && !privateInvestigation) {
      const token = (linksLedger().tokens || {})[String(num)] || mintTicketToken(num);
      if (token) {
        addSecurityHeaders(res);
        res.writeHead(302, { Location: `/t/${token}` });
        res.end();
        return;
      }
      // Minting failed: fall through and render the staff view inline rather
      // than stranding the ticket with no page.
    }
    const publicLink = pathname.startsWith("/t/") && !isStaff;
    if (!pathname.startsWith("/t/") && !isStaff) {
      // Never the bare word "Forbidden" on a ticket link: a reporter who
      // followed something stale deserves to be told what happened and where
      // their own link is, not shown a wall.
      addSecurityHeaders(res);
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket link</title>
        <style>${BASE_CSS}</style></head><body><div class="container">
        <div class="glass" style="padding:var(--s-6);max-width:34rem;margin:10vh auto">
        <h1 class="page-title">This link is for staff</h1>
        <p style="color:var(--text-2);margin-top:var(--s-3)">Reporters get their own link in the ticket channel, and that one opens without signing in.
        This address is the staff view, so it asks for an ops account.</p>
        <p style="margin-top:var(--s-4)"><a href="https://www.ahousedividedgame.com">Back to the game</a></p>
        </div></div></body></html>`);
      return;
    }
    try {
      const { ObjectId } = require("mongodb");
      const db = await getDb();
      const ticket = await db.collection("tickets").findOne({ ticketNumber: num });
      if (!ticket) { addSecurityHeaders(res); res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Ticket not found"); return; }
      if (ticket.category === "investigation" && !isStaff) { addSecurityHeaders(res); res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("Ticket not found"); return; }
      let assessment = null, fixSession = null;
      if (ticket.assessmentId) assessment = await db.collection("assessments").findOne({ _id: ticket.assessmentId });
      if (!assessment) assessment = await db.collection("assessments").findOne({ targetType: "ticket", targetId: ticket._id }, { sort: { createdAt: -1 } });
      if (ticket.fixSessionId) fixSession = await db.collection("fix_sessions").findOne({ _id: ticket.fixSessionId });
      const githubRecord = readTicketAssessment(num);
      const artifacts = githubRecord ? await liveArtifacts(num, githubRecord) : null;
      const github = githubRecord ? { ...githubRecord, artifacts: artifacts || githubRecord.artifacts } : null;
      // Merged tracker state. Read but never required: a missing link or a
      // tracker outage renders the same page as before, without the card.
      let tracked = null;
      if (ticket.trackerItemId) {
        try { tracked = await db.collection("tracker_items").findOne({ id: ticket.trackerItemId }); } catch { tracked = null; }
      }
      if (publicLink) {
        // Context classification is persisted once per ticket. Do it after the
        // page data is ready so a receipt never waits on the model endpoint;
        // the deterministic receipt fallback is visible on this request and a
        // later view uses Jev's durable decision. The notifier is idempotent.
        if (!ticket.contextRequest) {
          ensureTicketContextRequest(db, ticket)
            .then((contextRequest) => maybePostTicketContextRequest(db, { ticketNumber: num, contextRequest }))
            .catch((error) => console.warn(`[ticket-context] ticket #${num}: ${error.message}`));
        }
        // Render the durable player receipt. It shares the ticket's canonical
        // status and safe milestones, but never includes staff tracker data.
        const view = makeTicketDetailBody({ ticket, assessment: null, fixSession: null, github, viewer: "public", tracked });
        addSecurityHeaders(res);
        // A capability URL must not end up in a search index.
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.end(req.method === "HEAD" ? "" : renderShell({ title: ticket.title || "Your report", active: "", role: "public", extraCss: view.extraCss, body: view.body }));
        return;
      }
      const { extraCss, body } = makeTicketDetailBody({ ticket, assessment, fixSession, github, tracked });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Ticket #" + num, active: "/tickets", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // GET /suggestions — list
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/suggestions") {
    if (featureDisabled("tickets")) return;
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const db = await getDb();
      const status = url.searchParams.get("status");
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
      const filter = status && status !== "all" ? { status } : {};
      const total = await db.collection("suggestions").countDocuments(filter);
      const totalPages = Math.max(1, Math.ceil(total / COMMUNITY_PAGE_SIZE));
      const suggestions = await db.collection("suggestions").find(filter)
        .sort({ createdAt: -1 }).skip((page - 1) * COMMUNITY_PAGE_SIZE).limit(COMMUNITY_PAGE_SIZE).toArray();
      await attachTriage(db, "suggestion", suggestions);
      const easiestWins = await buildEasiestWins(db);
      const { extraCss, body } = makeSuggestionsListBody({ suggestions, page, totalPages, status, total, easiestWins });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Suggestions", active: "/suggestions", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // GET /s/<token>: the one page per suggestion. The token IS the capability,
  // so it needs no session; a staff session looking at the same URL unlocks
  // the staff blocks. /suggestions/<n> stays as a staff-only alias that
  // redirects to the token URL, so there is exactly one address per
  // suggestion and it is the scrambled one.
  const suggestionDetail = /^\/suggestions\/[^/]+$/.test(pathname) ? pathname.split("/")[2] : (/^\/s\/[^/]+$/.test(pathname) ? pathname.split("/")[2] : null);
  if ((req.method === "GET" || req.method === "HEAD") && suggestionDetail !== null) {
    // Resolved before the session check so a bad token is a plain 404 and a
    // good one is logged in the server log, whoever is asking.
    const rawRef = decodeURIComponent(suggestionDetail);
    // /s/<token> is looked up; /suggestions/<n> is parsed. A bad token is a
    // 404, not a redirect to anything guessable.
    const num = pathname.startsWith("/s/") ? suggestionForToken(rawRef) : parseInt(rawRef, 10);
    if (!Number.isInteger(num)) {
      console.log(`[suggestions] unknown suggestion link ${pathname}`);
      addSecurityHeaders(res); res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Unknown suggestion link");
      return;
    }
    if (pathname.startsWith("/s/")) console.log(`[suggestions] token ${rawRef} → suggestion ${num}`);
    const session = await resolveSession(req);
    const isStaff = !!session && session.role === "admin";
    // Staff on the numeric alias go to the one page. The token is minted on
    // demand for suggestions nobody has linked yet.
    if (!pathname.startsWith("/s/") && isStaff) {
      const token = (suggestionLinksLedger().tokens || {})[String(num)] || mintSuggestionToken(num);
      if (token) {
        addSecurityHeaders(res);
        res.writeHead(302, { Location: `/s/${token}` });
        res.end();
        return;
      }
      // Minting failed: fall through and render the staff view inline rather
      // than stranding the suggestion with no page.
    }
    const publicLink = pathname.startsWith("/s/") && !isStaff;
    if (!pathname.startsWith("/s/") && !isStaff) {
      // Never the bare word "Forbidden" on a suggestion link: someone who
      // followed something stale deserves to be told what happened and where
      // their own link is, not shown a wall.
      addSecurityHeaders(res);
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1"><title>Suggestion link</title>
        <style>${BASE_CSS}</style></head><body><div class="container">
        <div class="glass" style="padding:var(--s-6);max-width:34rem;margin:10vh auto">
        <h1 class="page-title">This link is for staff</h1>
        <p style="color:var(--text-2);margin-top:var(--s-3)">Suggesters get their own link when there is one to share, and that one opens without signing in.
        This address is the staff view, so it asks for an ops account.</p>
        <p style="margin-top:var(--s-4)"><a href="https://www.ahousedividedgame.com">Back to the game</a></p>
        </div></div></body></html>`);
      return;
    }
    try {
      const db = await getDb();
      const suggestion = await db.collection("suggestions").findOne({ issueNumber: num });
      if (!suggestion) { addSecurityHeaders(res); res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Suggestion not found"); return; }
      let assessment = null, fixSession = null;
      if (suggestion.assessmentId) assessment = await db.collection("assessments").findOne({ _id: suggestion.assessmentId });
      if (!assessment) assessment = await db.collection("assessments").findOne({ targetType: "suggestion", targetId: suggestion._id }, { sort: { createdAt: -1 } });
      if (suggestion.fixSessionId) fixSession = await db.collection("fix_sessions").findOne({ _id: suggestion.fixSessionId });
      // Merged tracker state. Read but never required: a missing link or a
      // tracker outage renders the same page as before, without the card.
      let tracked = null;
      if (suggestion.trackerItemId) {
        try { tracked = await db.collection("tracker_items").findOne({ id: suggestion.trackerItemId }); } catch { tracked = null; }
      }
      if (publicLink) {
        // The same page the staff see, rendered for a suggester: their own
        // words, the status, and the tracked work, with internals left out.
        const view = makeSuggestionDetailBody({ suggestion, assessment: null, fixSession: null, viewer: "public", tracked });
        addSecurityHeaders(res);
        // A capability URL must not end up in a search index.
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.end(req.method === "HEAD" ? "" : renderShell({ title: suggestion.title || "Your suggestion", active: "", role: "public", extraCss: view.extraCss, body: view.body }));
        return;
      }
      const { extraCss, body } = makeSuggestionDetailBody({ suggestion, assessment, fixSession, tracked });
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Suggestion #" + num, active: "/suggestions", role: session.role, extraCss, body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Error: " + e.message);
    }
    return;
  }

  // GET /learn — Learning Center landing or reader (admin only)
  //   /learn              -> landing (module grid)
  //   /learn/?page=<id>   -> reader showing that page
  //   /learn/?module=<id> -> reader showing first page of that module
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === "/learn" || pathname === "/learn/")) {
    if (!LEARN_PAGE) { addSecurityHeaders(res); res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    const hasPage = url.searchParams.has("page");
    const hasModule = url.searchParams.has("module");
    if (hasPage || hasModule) {
      res.end(injectNav(LEARN_PAGE, "/learn", session));
    } else {
      res.end(injectNav(LEARN_LANDING_PAGE, "/learn", session));
    }
    return;
  }

  // GET /audit — Codebase audit report (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/audit") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(injectNav(AUDIT_PAGE, "/audit", session));
    return;
  }

  // GET /demographics — Demographics editor (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/demographics") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = require("fs").readFileSync(require("path").join(__dirname, "reports", "demographics.html"), "utf8");
      // Inject US SVG map path data for the geographic map tab
      let svgData = "{}";
      try {
        svgData = require("fs").readFileSync(require("path").join(__dirname, "election-map-svg.json"), "utf8");
      } catch (e) { /* fall back to empty map */ }
      const injected = html.replace("/*__SVG_MAP__*/", svgData);
      res.end(injected);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load demographics page");
    }
    return;
  }

  // GET /election-map — US election map with CSV upload (public)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/election-map") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(makeElectionMapPage());
    return;
  }

  // GET /commodity-report — Commodity economy analysis (public)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/commodity-report") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    const fontLinks = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">';
    res.end(makeCommodityPage(fontLinks, BASE_CSS));
    return;
  }

  // GET /election-audit — US presidential demographic-lean audit (public)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/election-audit") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    const fontLinks = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">';
    res.end(makeElectionAuditPage(fontLinks, BASE_CSS));
    return;
  }

  // ── Learning Center API ─────────────────────────

  // GET /api/learn/content — Fetch page content by ID
  if (req.method === "GET" && pathname === "/api/learn/content") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    const pageId = url.searchParams.get("page");
    if (!pageId) {
      addSecurityHeaders(res);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing page parameter" }));
      return;
    }
    const allPages = CURRICULUM.flatMap(m => m.pages.map(p => ({ moduleId: m.id, ...p })));
    const page = allPages.find(p => p.id === pageId);
    if (!page) {
      addSecurityHeaders(res);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Page not found" }));
      return;
    }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: page.content, quiz: page.quiz || [] }));
    return;
  }

  // ── Code Agent REST API (admin only) ─────────────────────────

  async function requireAdmin() {
    const s = await resolveSession(req);
    if (!s || s.role !== "admin") return null;
    return s;
  }

  function jsonResponse(code, data) {
    addSecurityHeaders(res);
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  // The Discord bot needs the same opaque capability URL that ops and the
  // ticket notifier use. Keep minting behind the bot credential so ticket
  // numbers never become a public enumeration API.
  const publicLinkMatch = pathname.match(/^\/api\/tickets\/(\d+)\/public-link$/);
  if (req.method === "GET" && publicLinkMatch) {
    const botToken = process.env.DISCORD_BOT_TOKEN || "";
    if (!botToken || req.headers.authorization !== `Bot ${botToken}`) {
      return jsonResponse(403, { error: "Forbidden" });
    }
    const number = Number.parseInt(publicLinkMatch[1], 10);
    const db = await getDb();
    const ticket = await db.collection("tickets").findOne({ ticketNumber: number }, { projection: { _id: 1, category: 1 } });
    if (!ticket || ticket.category === "investigation") return jsonResponse(404, { error: "Ticket not found" });
    const token = (linksLedger().tokens || {})[String(number)] || mintTicketToken(number);
    if (!token) return jsonResponse(500, { error: "Could not mint ticket link" });
    const base = PUBLIC_BASE || "https://ops.lakesidegames.net";
    return jsonResponse(200, { receiptUrl: `${base}/t/${token}` });
  }

  if (req.method === "GET" && pathname === "/api/scheduler") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try { return jsonResponse(200, await schedulerSnapshot()); }
    catch (error) { return jsonResponse(500, { error: error.message }); }
  }

  if (req.method === "POST" && pathname === "/api/scheduler/checks") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let rawBody = "";
    for await (const chunk of req) {
      rawBody += chunk;
      if (rawBody.length > 16_384) return jsonResponse(413, { error: "Body too large" });
    }
    try {
      const payload = JSON.parse(rawBody || "{}");
      const id = await enqueueCheck(payload);
      return jsonResponse(202, { id, state: "queued" });
    } catch (error) {
      return jsonResponse(400, { error: error.message });
    }
  }

  if (req.method === "POST" && pathname === "/api/scheduler/worldsims") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let rawBody = "";
    for await (const chunk of req) {
      rawBody += chunk;
      if (rawBody.length > 16_384) return jsonResponse(413, { error: "Body too large" });
    }
    try {
      const runId = await enqueueWorldSim(JSON.parse(rawBody || "{}"));
      return jsonResponse(202, { runId, status: "queued" });
    } catch (error) {
      return jsonResponse(400, { error: error.message });
    }
  }

  // ── Agents: MCP token management (admin only) ───────────────────────────
  // GET /api/agents/usage — today's spend/tokens for the Agents page. Reads the
  // warm cost cache and reports `pending` instead of waiting on CodeBurn.
  if (req.method === "GET" && pathname === "/api/agents/usage") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const breakdown = await getCostBreakdownAsync("today");
    const tokens = breakdown
      ? (breakdown.byModel || []).reduce((total, model) => total + (Number(model.totalTokens) || 0), 0)
      : null;
    return jsonResponse(200, {
      pending: !breakdown,
      cost: breakdown ? breakdown.totals.label : null,
      tokens,
      generatedAt: breakdown ? breakdown.generatedAt : null,
    });
  }

  // POST /api/agents/tokens — issue a scoped token; raw value returned once.
  if (req.method === "POST" && pathname === "/api/agents/tokens") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let rawBody = "";
    req.on("data", (c) => { rawBody += c; if (rawBody.length > 1e5) { rawBody = ""; req.destroy(); } });
    req.on("end", async () => {
      try {
        const p = JSON.parse(rawBody || "{}");
        const db = await getDb();
        await agentTokens.ensureIndexes(db);
        const { raw, record } = await agentTokens.issue(db, {
          name: (p.name || "").trim() || "unnamed-agent",
          collections: Array.isArray(p.collections) ? p.collections : [],
          write: !!p.write,
          actor: (await resolveSession(req))?.email || "admin",
        });
        jsonResponse(200, { ok: true, token: raw, name: record.name, scopes: record.scopes });
      } catch (e) {
        jsonResponse(500, { error: e.message });
      }
    });
    return;
  }

  // GET /api/knowledge/search?kind=&q= — hybrid keyword+semantic search.
  // Embeds the query with the shared bge-small pipeline; if it's cold we fall
  // back to keyword ranking and warm it for next time.
  if (req.method === "GET" && pathname === "/api/knowledge/search") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const kind = url.searchParams.get("kind");
      const q = (url.searchParams.get("q") || "").trim();
      let qEmbed = null;
      if (q) {
        try { qEmbed = Array.from(await embedText(q, true)); }
        catch (_) { initTransformers().catch(() => {}); }
      }
      const results = await knowledgeStore.query(await getDb(), { kind, text: q, queryEmbedding: qEmbed, limit: 20 });
      jsonResponse(200, { results, semantic: !!qEmbed });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // GET /api/ideas/search?q= — proxied to the HNSW ideas service (scales to the
  // full corpus; sub-ms ANN instead of loading every embedding per query).
  if (req.method === "GET" && pathname === "/api/ideas/search") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return jsonResponse(200, { results: [] });
      const r = await fetch(`http://127.0.0.1:9728/search?q=${encodeURIComponent(q)}&limit=25`);
      const d = await r.json();
      jsonResponse(200, { results: d.results || [], semantic: true, vectors: d.vectors });
    } catch (e) { jsonResponse(500, { error: e.message }); }
    return;
  }

  // POST /api/ideas/ask — RAG over the community corpus (DeepSeek), via the service.
  if (req.method === "POST" && pathname === "/api/ideas/ask") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e4) { body = ""; req.destroy(); } });
    req.on("end", async () => {
      try {
        const r = await fetch("http://127.0.0.1:9728/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: body || "{}" });
        jsonResponse(r.status, await r.json());
      } catch (e) { jsonResponse(500, { error: e.message }); }
    });
    return;
  }

  // GET /api/ideas/graph — sampled semantic network of community ideas.
  if (req.method === "GET" && pathname === "/api/ideas/graph") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const col = (await getDb()).collection("discord_ideas");
      const rows = await col.aggregate([
        { $match: { embedding: { $ne: null } } },
        { $sample: { size: 380 } },
        { $project: { messageId: 1, content: 1, channelName: 1, author: 1, jumpLink: 1, embedding: 1 } },
      ]).toArray();
      const vecs = rows.map((r) => Float32Array.from(r.embedding));
      const nodes = rows.map((r) => ({ id: r.messageId, label: (r.content || "").slice(0, 60), channel: r.channelName, author: r.author, jump: r.jumpLink }));
      const K = 3, THRESH = 0.62, links = [], seen = new Set();
      for (let i = 0; i < rows.length; i++) {
        const sims = [];
        for (let j = 0; j < rows.length; j++) { if (i === j) continue; const s = knowledgeStore.cosine(vecs[i], vecs[j]); if (s > THRESH) sims.push([j, s]); }
        sims.sort((a, b) => b[1] - a[1]);
        for (const [j, s] of sims.slice(0, K)) { const key = i < j ? i + "-" + j : j + "-" + i; if (seen.has(key)) continue; seen.add(key); links.push({ source: rows[i].messageId, target: rows[j].messageId, value: Number(s.toFixed(3)) }); }
      }
      jsonResponse(200, { nodes, links });
    } catch (e) { jsonResponse(500, { error: e.message }); }
    return;
  }

  // GET /api/ideas/meta — DeepSeek storyboard + theme digest + stats (precomputed).
  if (req.method === "GET" && pathname === "/api/ideas/meta") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const doc = await (await getDb()).collection("ideas_meta").findOne({ _id: "latest" });
      jsonResponse(200, { storyboard: doc && doc.storyboard, themes: (doc && doc.themes) || [], stats: doc && doc.stats, generatedAt: doc && doc.generatedAt });
    } catch (e) { jsonResponse(500, { error: e.message }); }
    return;
  }

  // GET /api/knowledge/entry?kind=&name= — full entry body.
  if (req.method === "GET" && pathname === "/api/knowledge/entry") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const entry = await knowledgeStore.get(await getDb(), url.searchParams.get("kind"), url.searchParams.get("name"));
      if (entry) delete entry.embedding;
      jsonResponse(200, { entry });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // GET /api/knowledge/history?kind=&name=&from=&to= — version timeline + diff.
  if (req.method === "GET" && pathname === "/api/knowledge/history") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const h = await knowledgeStore.history(await getDb(), url.searchParams.get("kind"), url.searchParams.get("name"));
      if (!h) return jsonResponse(404, { error: "not found" });
      const versions = h.versions.map((v) => ({ version: v.version, updatedBy: v.updatedBy, updatedAt: v.updatedAt, current: !!v.current }));
      let diff = null;
      if (h.versions.length >= 2) {
        const byV = (v) => h.versions.find((x) => x.version === Number(v));
        const to = url.searchParams.get("to") ? byV(url.searchParams.get("to")) : h.versions[h.versions.length - 1];
        const from = url.searchParams.get("from") ? byV(url.searchParams.get("from")) : h.versions[h.versions.indexOf(to) - 1] || h.versions[h.versions.length - 2];
        if (from && to) diff = { fromVersion: from.version, toVersion: to.version, patch: knowledgeStore.diffLines(from.body, to.body) };
      }
      jsonResponse(200, { kind: h.kind, name: h.name, currentVersion: h.currentVersion, versions, diff });
    } catch (e) { jsonResponse(500, { error: e.message }); }
    return;
  }

  // GET /api/knowledge/review-queue — entries flagged stale-on-read + assessment.
  if (req.method === "GET" && pathname === "/api/knowledge/review-queue") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const queue = await knowledgeStore.listReviewQueue(await getDb(), { limit: 300 });
      const items = queue.map((e) => {
        const a = knowledgeStore.assessEntry(e);
        return { kind: e.kind, name: e.name, title: e.title, flaggedAt: e.reviewFlaggedAt, recommendation: a.recommendation, reason: a.reason, signals: a.signals };
      });
      jsonResponse(200, { count: items.length, items });
    } catch (e) { jsonResponse(500, { error: e.message }); }
    return;
  }

  // POST /api/knowledge/review-action — {kind,name,action:'mark'|'delete',recommendation?}
  if (req.method === "POST" && pathname === "/api/knowledge/review-action") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let rawBody = "";
    req.on("data", (c) => { rawBody += c; if (rawBody.length > 1e5) { rawBody = ""; req.destroy(); } });
    req.on("end", async () => {
      try {
        const p = JSON.parse(rawBody || "{}");
        const db = await getDb();
        const actor = (await resolveSession(req))?.email || "admin";
        if (p.action === "delete") {
          const ok = await knowledgeStore.remove(db, p.kind, p.name, { actor });
          return jsonResponse(200, { ok });
        }
        await knowledgeStore.markReviewed(db, p.kind, p.name, { recommendation: p.recommendation || "keep", actor });
        jsonResponse(200, { ok: true });
      } catch (e) { jsonResponse(500, { error: e.message }); }
    });
    return;
  }

  // GET /api/knowledge/graph — node-link data for the knowledge-web visualizer.
  if (req.method === "GET" && pathname === "/api/knowledge/graph") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const db = await getDb();
      const col = db.collection(knowledgeStore.COLLECTION);
      const all = await col.find({ deletedAt: null }, { projection: { name: 1, kind: 1, title: 1, links: 1, tags: 1, hits: 1, embedding: 1 } }).toArray();
      const names = new Set(all.map((e) => e.name));
      // Docs cross-reference each other by bare topic ([[commodities]]) but are
      // stored under path-prefixed slugs (design-commodities). Resolve a link
      // target to an exact name, else to a UNIQUE entry whose slug ends with it.
      const bySuffix = {};
      for (const e of all) {
        const parts = e.name.split("-");
        for (let i = 0; i < parts.length; i++) {
          const suf = parts.slice(i).join("-");
          (bySuffix[suf] = bySuffix[suf] || []).push(e.name);
        }
      }
      const resolve = (t) => (names.has(t) ? t : (bySuffix[t] && bySuffix[t].length === 1 ? bySuffix[t][0] : null));

      const deg = {}, seen = new Set(), linkEdges = [], danglingCount = {};
      const ek = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
      for (const e of all) {
        for (const raw of e.links || []) {
          const t = resolve(raw);
          if (!t || t === e.name) { if (!t) danglingCount[raw] = (danglingCount[raw] || 0) + 1; continue; }
          const key = ek(e.name, t);
          if (!seen.has(key)) { seen.add(key); linkEdges.push({ s: e.name, t }); deg[e.name] = (deg[e.name] || 0) + 1; deg[t] = (deg[t] || 0) + 1; }
        }
      }
      // shared-tag edges — capped; only tags shared by 2..6 entries stay meaningful.
      const byTag = {};
      for (const e of all) for (const tg of e.tags || []) (byTag[tg] = byTag[tg] || []).push(e.name);
      const tagEdges = [], tseen = new Set();
      outer: for (const tg in byTag) {
        const mem = byTag[tg];
        if (mem.length < 2 || mem.length > 6) continue;
        for (let i = 0; i < mem.length; i++) for (let j = i + 1; j < mem.length; j++) {
          const key = ek(mem[i], mem[j]);
          if (!tseen.has(key) && !seen.has(key)) { tseen.add(key); tagEdges.push({ s: mem[i], t: mem[j] }); }
          if (tagEdges.length >= 600) break outer;
        }
      }
      // semantic edges — each entry's nearest neighbours by meaning. This is what
      // actually weaves docs↔skills↔memory together (link/tag edges rarely cross
      // kinds). Top-2 per node, cosine>0.62, deduped, not already a link edge.
      const emb = all.filter((e) => Array.isArray(e.embedding) && e.embedding.length);
      const vecs = emb.map((e) => Float32Array.from(e.embedding));
      const semanticEdges = [], sseen = new Set();
      for (let i = 0; i < emb.length; i++) {
        const sims = [];
        for (let j = 0; j < emb.length; j++) { if (i === j) continue; const c = knowledgeStore.cosine(vecs[i], vecs[j]); if (c > 0.62) sims.push([j, c]); }
        sims.sort((a, b) => b[1] - a[1]);
        for (const [j] of sims.slice(0, 2)) {
          const a = emb[i].name, b = emb[j].name, key = ek(a, b);
          if (!seen.has(key) && !sseen.has(key)) { sseen.add(key); semanticEdges.push({ s: a, t: b }); }
        }
        if (semanticEdges.length >= 700) break;
      }
      // Feedback woven INTO the web — player suggestions, support tickets, and
      // extracted Discord themes. Each is linked to the knowledge it relates to:
      // top-2 nearest by meaning + an explicit gameSystem->doc topic edge.
      const GS_STEM = { elections: "election", parties: "parties", corporations: "corporation", economy: "economy", npps: "npp", executive: "executive", legislature: "legislat", diplomacy: "diploma", map_geo: "map" };
      const feedbackNodes = [], edgesByKind = { suggestion: [], ticket: [], theme: [] };
      async function weave(coll, kind, cfg) {
        const rows = await db.collection(coll).find({ embedding: { $exists: true }, ...(cfg.filter || {}) }, { projection: cfg.projection }).toArray();
        const seenF = new Set();
        for (const r of rows) {
          if (!Array.isArray(r.embedding) || !r.embedding.length) continue;
          const id = cfg.id(r), sv = Float32Array.from(r.embedding), sims = [];
          for (let j = 0; j < emb.length; j++) { const c = knowledgeStore.cosine(sv, vecs[j]); if (c > 0.35) sims.push([j, c]); }
          sims.sort((a, b) => b[1] - a[1]);
          let d = 0;
          const add = (t) => { if (!t) return; const key = id + "|" + t; if (!seenF.has(key)) { seenF.add(key); edgesByKind[kind].push({ s: id, t }); deg[t] = (deg[t] || 0) + 1; d++; } };
          for (const [j] of sims.slice(0, cfg.topK || 2)) add(emb[j].name);
          const gs = cfg.gameSystem && cfg.gameSystem(r);
          if (gs && GS_STEM[gs]) { const doc = all.find((e) => e.kind === "docs" && e.name.includes(GS_STEM[gs])); if (doc) add(doc.name); }
          feedbackNodes.push({ id, kind, title: cfg.title(r), hits: 0, deg: d, meta: cfg.meta(r) });
        }
      }
      await weave("suggestions", "suggestion", {
        filter: { status: { $ne: "rejected" } }, projection: { issueNumber: 1, title: 1, description: 1, gameSystem: 1, category: 1, status: 1, embedding: 1 },
        id: (s) => "sug-" + s.issueNumber, title: (s) => s.title || ("#" + s.issueNumber), gameSystem: (s) => s.gameSystem,
        meta: (s) => ({ number: s.issueNumber, gameSystem: s.gameSystem || null, status: s.status || null, category: s.category || null, desc: (s.description || "").slice(0, 400), href: "/suggestions" }),
      });
      await weave("tickets", "ticket", {
        projection: { ticketNumber: 1, title: 1, description: 1, category: 1, status: 1, embedding: 1 },
        id: (t) => "tkt-" + (t.ticketNumber || t._id), title: (t) => t.title || ("#" + t.ticketNumber),
        meta: (t) => ({ number: t.ticketNumber || null, status: t.status || null, category: t.category || null, desc: (t.description || "").slice(0, 400), href: "/tickets" }),
      });
      await weave("discord_themes", "theme", {
        projection: { slug: 1, title: 1, summary: 1, sentiment: 1, gameSystem: 1, prevalence: 1, embedding: 1 }, topK: 3,
        id: (t) => "thm-" + t.slug, title: (t) => t.title, gameSystem: (t) => t.gameSystem,
        meta: (t) => ({ sentiment: t.sentiment || null, gameSystem: t.gameSystem || null, prevalence: t.prevalence || null, desc: t.summary || "", href: "/community-voice" }),
      });
      const nodes = all.map((e) => ({ id: e.name, kind: e.kind, title: e.title, hits: e.hits || 0, deg: deg[e.name] || 0 })).concat(feedbackNodes);
      const danglingTotal = Object.values(danglingCount).reduce((a, b) => a + b, 0);
      const danglingTop = Object.entries(danglingCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
      jsonResponse(200, { nodes, linkEdges, tagEdges, semanticEdges, sugEdges: edgesByKind.suggestion, ticketEdges: edgesByKind.ticket, themeEdges: edgesByKind.theme, danglingCount: danglingTotal, danglingTop });
    } catch (e) { jsonResponse(500, { error: e.message }); }
    return;
  }

  // POST /api/agents/tokens/revoke — revoke by id.
  if (req.method === "POST" && pathname === "/api/agents/tokens/revoke") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let rawBody = "";
    req.on("data", (c) => { rawBody += c; if (rawBody.length > 1e5) { rawBody = ""; req.destroy(); } });
    req.on("end", async () => {
      try {
        const { id } = JSON.parse(rawBody || "{}");
        if (!id) return jsonResponse(400, { error: "id required" });
        const { ObjectId } = require("mongodb");
        const ok = await agentTokens.revoke(await getDb(), id, { ObjectId });
        jsonResponse(ok ? 200 : 404, ok ? { ok: true } : { error: "not found or already revoked" });
      } catch (e) {
        jsonResponse(500, { error: e.message });
      }
    });
    return;
  }

  // ── Community: tickets + suggestions JSON API (admin only) ───────────

  // GET /api/tickets?status=&page=  and  GET /api/suggestions?status=&page=
  for (const kind of ["tickets", "suggestions"]) {
    if (req.method === "GET" && pathname === "/api/" + kind) {
      if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
      try {
        const db = await getDb();
        const status = url.searchParams.get("status");
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
        const pageSize = 25;
        const filter = status && status !== "all" ? { status } : {};
        const total = await db.collection(kind).countDocuments(filter);
        const items = await db.collection(kind).find(filter)
          .sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
        return jsonResponse(200, { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
      } catch (e) {
        return jsonResponse(500, { error: e.message });
      }
    }
  }

  // GET /api/tickets/:id  — single ticket + assessment
  if (req.method === "GET" && /^\/api\/tickets\/[^/]+$/.test(pathname)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const { ObjectId } = require("mongodb");
      const db = await getDb();
      const raw = decodeURIComponent(pathname.split("/")[3]);
      const q = /^[a-f0-9]{24}$/i.test(raw) ? { _id: new ObjectId(raw) } : { ticketNumber: parseInt(raw, 10) };
      const ticket = await db.collection("tickets").findOne(q);
      if (!ticket) return jsonResponse(404, { error: "Not found" });
      const assessment = ticket.assessmentId
        ? await db.collection("assessments").findOne({ _id: ticket.assessmentId })
        : await db.collection("assessments").findOne({ targetType: "ticket", targetId: ticket._id }, { sort: { createdAt: -1 } });
      const fixSession = ticket.fixSessionId ? await db.collection("fix_sessions").findOne({ _id: ticket.fixSessionId }) : null;
      return jsonResponse(200, { ticket, assessment, fixSession });
    } catch (e) {
      return jsonResponse(500, { error: e.message });
    }
  }

  // GET /api/suggestions/:id — single suggestion + assessment
  if (req.method === "GET" && /^\/api\/suggestions\/[^/]+$/.test(pathname)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const { ObjectId } = require("mongodb");
      const db = await getDb();
      const raw = decodeURIComponent(pathname.split("/")[3]);
      const q = /^[a-f0-9]{24}$/i.test(raw) ? { _id: new ObjectId(raw) } : { issueNumber: parseInt(raw, 10) };
      const suggestion = await db.collection("suggestions").findOne(q);
      if (!suggestion) return jsonResponse(404, { error: "Not found" });
      const assessment = suggestion.assessmentId
        ? await db.collection("assessments").findOne({ _id: suggestion.assessmentId })
        : await db.collection("assessments").findOne({ targetType: "suggestion", targetId: suggestion._id }, { sort: { createdAt: -1 } });
      const fixSession = suggestion.fixSessionId ? await db.collection("fix_sessions").findOne({ _id: suggestion.fixSessionId }) : null;
      return jsonResponse(200, { suggestion, assessment, fixSession });
    } catch (e) {
      return jsonResponse(500, { error: e.message });
    }
  }

  // POST /api/tickets/:id/launch  and  POST /api/suggestions/:id/launch
  // Human-gated WRITE trigger: seed a code-agent session with the item + its
  // assessment, off `development`, then redirect the admin to watch it.
  {
    const launchMatch = pathname.match(/^\/api\/(tickets|suggestions)\/([^/]+)\/launch$/);
    if (req.method === "POST" && launchMatch) {
      const adminSession = await requireAdmin();
      const db0 = await getDb();
      const tokenAuth = adminSession ? null : await agentTokens.validate(db0, req.headers["authorization"]).catch(() => null);
      if (!adminSession && !tokenAuth) return jsonResponse(403, { error: "Forbidden" });

      // Bearer-token callers (e.g. the Discord bot's /handoff command) pass a
      // `launchedBy` label for the audit trail since they have no admin session.
      let launchedByLabel = adminSession ? (adminSession.email || "admin") : (tokenAuth.name || "agent");
      if (tokenAuth) {
        const rawBody = await new Promise((resolve) => {
          let body = "";
          req.on("data", (c) => { body += c; if (body.length > 1e4) { body = ""; req.destroy(); } });
          req.on("end", () => resolve(body));
          req.on("error", () => resolve(""));
        });
        try {
          const parsed = JSON.parse(rawBody || "{}");
          if (parsed.launchedBy && typeof parsed.launchedBy === "string") {
            launchedByLabel = parsed.launchedBy.slice(0, 120);
          }
        } catch {}
      }

      const kind = launchMatch[1] === "tickets" ? "ticket" : "suggestion";
      const rawId = decodeURIComponent(launchMatch[2]);
      try {
        if (!codeSessionManager) return jsonResponse(503, { error: "Code session manager not ready" });
        const { ObjectId } = require("mongodb");
        const db = db0;
        const coll = db.collection(kind === "ticket" ? "tickets" : "suggestions");
        const numberField = kind === "ticket" ? "ticketNumber" : "issueNumber";
        const q = /^[a-f0-9]{24}$/i.test(rawId) ? { _id: new ObjectId(rawId) } : { [numberField]: parseInt(rawId, 10) };
        const item = await coll.findOne(q);
        if (!item) return jsonResponse(404, { error: "Not found" });
        if (item.fixSessionId) {
          const existing = await db.collection("fix_sessions").findOne({ _id: item.fixSessionId });
          if (existing) {
            return jsonResponse(200, {
              codeSessionId: existing.codeSessionId,
              branch: existing.branch,
              url: `${PUBLIC_BASE}/code/session/${existing.codeSessionId}`,
              reused: true,
            });
          }
        }
        const displayNumber = item[numberField];
        const assessment = item.assessmentId
          ? await db.collection("assessments").findOne({ _id: item.assessmentId })
          : await db.collection("assessments").findOne({ targetType: kind, targetId: item._id }, { sort: { createdAt: -1 } });

        const branchName = `fix/${kind}-${displayNumber}`;
        const seedPrompt = buildFixSeedPrompt(kind, item, assessment, branchName);

        // Create a stub code session off `development` and seed it.
        const codeSession = await codeSessionManager.createSessionStub({ baseBranch: "development" });
        await db.collection("code_sessions").updateOne(
          { sessionId: codeSession.sessionId },
          { $set: { seedPrompt, title: `Fix ${kind} #${displayNumber}`, updatedAt: new Date() } }
        );

        const fixDoc = {
          targetType: kind,
          targetId: item._id,
          assessmentId: assessment ? assessment._id : null,
          codeSessionId: codeSession.sessionId,
          branch: branchName,
          status: "launched",
          launchedBy: launchedByLabel,
          launchedAt: new Date(),
        };
        const fixIns = await db.collection("fix_sessions").insertOne(fixDoc);
        await coll.updateOne({ _id: item._id }, { $set: { fixSessionId: fixIns.insertedId, status: "in_progress", updatedAt: new Date() } });

        return jsonResponse(200, {
          codeSessionId: codeSession.sessionId,
          branch: branchName,
          fixSessionId: fixIns.insertedId.toHexString(),
          url: `${PUBLIC_BASE}/code/session/${codeSession.sessionId}`,
        });
      } catch (e) {
        return jsonResponse(500, { error: e.message });
      }
    }
  }

  // POST /api/issues/triage — admin: seed a code-agent session with the current
  // open GlitchTip issues so the agent can investigate + triage them against the
  // codebase and propose fixes. Same mechanism as /api/{tickets,suggestions}/:id/launch.
  if (req.method === "POST" && pathname === "/api/issues/triage") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      if (!codeSessionManager) return jsonResponse(503, { error: "Code session manager not ready" });

      // Fetch open issues from GlitchTip (same API the dashboard tile / triage worker use).
      const gtUrl = process.env.GLITCHTIP_URL;
      const gtToken = process.env.GLITCHTIP_API_TOKEN;
      const gtOrg = process.env.GLITCHTIP_ORG_SLUG || "ahd";
      if (!gtUrl || !gtToken) return jsonResponse(503, { error: "GlitchTip not configured" });
      let issues = [];
      try {
        const r = await fetch(`${gtUrl.replace(/\/+$/, "")}/api/0/organizations/${gtOrg}/issues/?query=is:unresolved&limit=25`, {
          headers: { Authorization: "Bearer " + gtToken },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return jsonResponse(502, { error: "GlitchTip http " + r.status });
        const payload = await r.json();
        if (Array.isArray(payload)) issues = payload;
      } catch (e) {
        return jsonResponse(502, { error: "GlitchTip fetch failed: " + e.message });
      }

      const top = issues.slice(0, 10).map((i, n) => ({
        n: n + 1,
        title: (i.title || i.culprit || "untitled").slice(0, 200),
        culprit: (i.culprit || "").slice(0, 200),
        count: i.count ?? "?",
        level: i.level || "error",
      }));

      const issueList = top.length
        ? top.map((i) => `${i.n}. [${i.level}] ${i.title}${i.culprit ? `\n   culprit: ${i.culprit}` : ""}\n   events seen: ${i.count}`).join("\n\n")
        : "(GlitchTip returned no open issues right now — confirm via the dashboard before concluding there is nothing to triage.)";

      const seedPrompt = [
        "You are triaging the current open production error issues from GlitchTip for the A House Divided game.",
        "",
        `Here are the top ${top.length} open (unresolved) issues:`,
        "",
        issueList,
        "",
        "For each issue:",
        "1. Locate the relevant code in this repository (search by the error title, culprit, and stack hints).",
        "2. Diagnose the likely root cause and assess severity/blast radius.",
        "3. Propose a concrete fix (and note any that look like noise / non-actionable).",
        "",
        "Start by investigating read-only; do not make changes until you have summarized your triage findings (a prioritized list with root-cause + proposed fix per issue). Then, if asked, implement the safest high-value fixes on this branch.",
      ].join("\n");

      // Create a stub code session off `development` and seed it (same as the launch route).
      const codeSession = await codeSessionManager.createSessionStub({ baseBranch: "development" });
      const db = await getDb();
      await db.collection("code_sessions").updateOne(
        { sessionId: codeSession.sessionId },
        { $set: { seedPrompt, title: `Triage ${top.length} GlitchTip issue${top.length === 1 ? "" : "s"}`, updatedAt: new Date() } }
      );

      return jsonResponse(200, { sessionId: codeSession.sessionId, issueCount: top.length });
    } catch (e) {
      return jsonResponse(500, { error: e.message });
    }
  }

  // POST /api/tickets/:id/retriage  and  POST /api/suggestions/:id/retriage
  // Admin-only: force the triage worker to re-assess this item on its next tick,
  // even if it was already assessed. We reset the triage bookkeeping (leaving the
  // old `assessments` doc in place as history) so the item becomes eligible again.
  {
    const retriageMatch = pathname.match(/^\/api\/(tickets|suggestions)\/([^/]+)\/retriage$/);
    if (req.method === "POST" && retriageMatch) {
      if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
      const kind = retriageMatch[1] === "tickets" ? "ticket" : "suggestion";
      const rawId = decodeURIComponent(retriageMatch[2]);
      try {
        const { ObjectId } = require("mongodb");
        const db = await getDb();
        const coll = db.collection(kind === "ticket" ? "tickets" : "suggestions");
        const numberField = kind === "ticket" ? "ticketNumber" : "issueNumber";
        const q = /^[a-f0-9]{24}$/i.test(rawId) ? { _id: new ObjectId(rawId) } : { [numberField]: parseInt(rawId, 10) };
        const item = await coll.findOne(q);
        if (!item) return jsonResponse(404, { error: "Not found" });
        const now = new Date();
        const set = kind === "ticket"
          ? { status: "open", triageStatus: "pending", reviewAfter: now, updatedAt: now }
          : { triageStatus: "pending" };
        await coll.updateOne(
          { _id: item._id },
          { $set: set, $unset: { assessmentId: "", assessedAt: "", fixSessionId: "", lastTriageAttempt: "", lastTriageError: "" } }
        );
        // Kick the worker NOW so the new assessment lands in seconds, not on the
        // next 60s tick (the UI polls /triage-status and reloads when it's ready).
        runTriageTick(getDb, { launchTicketFix: launchAutomatedTicketFix, requestTicketRecheck: requestAutomatedTicketRecheck }).catch(() => {});
        return jsonResponse(200, { ok: true });
      } catch (e) {
        return jsonResponse(500, { error: e.message });
      }
    }
  }

  // GET /api/{tickets|suggestions}/:id/triage-status — lightweight poll for the
  // re-triage UI: returns triageStatus + current assessmentId so the page can
  // reload exactly when the new assessment is ready.
  {
    const tsMatch = pathname.match(/^\/api\/(tickets|suggestions)\/([^/]+)\/triage-status$/);
    if (req.method === "GET" && tsMatch) {
      if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
      const { ObjectId } = require("mongodb");
      const db = await getDb();
      const coll = db.collection(tsMatch[1]);
      const numberField = tsMatch[1] === "tickets" ? "ticketNumber" : "issueNumber";
      const rawId = decodeURIComponent(tsMatch[2]);
      const q = /^[a-f0-9]{24}$/i.test(rawId) ? { _id: new ObjectId(rawId) } : { [numberField]: parseInt(rawId, 10) };
      const item = await coll.findOne(q, { projection: { triageStatus: 1, assessmentId: 1, lastTriageError: 1 } });
      if (!item) return jsonResponse(404, { error: "Not found" });
      return jsonResponse(200, { triageStatus: item.triageStatus || null, assessmentId: item.assessmentId ? String(item.assessmentId) : null, error: item.lastTriageError || null });
    }
  }

  // POST /api/tickets/:id/close — admin records a resolution receipt and sends
  // one human-facing update to the ticket channel.
  {
    const closeMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/close$/);
    if (req.method === "POST" && closeMatch) {
      if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
      const session = await resolveSession(req);
      const rawId = decodeURIComponent(closeMatch[1]);
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e6) { body = ""; req.destroy(); } });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const resolution = String(parsed.resolution || "").trim();
          if (!resolution) return jsonResponse(400, { error: "resolution message is required" });
          const status = ["resolved", "closed"].includes(String(parsed.status || "")) ? String(parsed.status) : "resolved";
          const actions = Array.isArray(parsed.actions) ? parsed.actions.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [];
          const followUp = String(parsed.followUp || "").trim();
          const source = ["discord", "agent", "ops"].includes(String(parsed.source || "")) ? String(parsed.source) : "ops";
          const { ObjectId } = require("mongodb");
          const db = await getDb();
          const coll = db.collection("tickets");
          const q = /^[a-f0-9]{24}$/i.test(rawId) ? { _id: new ObjectId(rawId) } : { ticketNumber: parseInt(rawId, 10) };
          const ticket = await coll.findOne(q);
          if (!ticket) return jsonResponse(404, { error: "Not found" });
          const now = new Date();
          const by = (session && session.email) || "admin";
          const receipt = normalizeResolution({ message: resolution, actions, followUp, source }, { by, now });
          await coll.updateOne(
            { _id: ticket._id },
            {
              $set: {
                status,
                resolution: receipt,
                ...(status === "closed" ? { closedAt: now, closedBy: by } : { resolvedAt: now, resolvedBy: by }),
                updatedAt: now,
              },
              $push: { statusHistory: { status, at: now, by, source: "ops", note: "resolution receipt recorded" } },
            }
          );
          const notification = await maybePostTicketResolution(db, { ticketNumber: ticket.ticketNumber, resolution: receipt, by });
          return jsonResponse(200, { ok: true, status, receiptUrl: notification.receiptUrl || null, notification });
        } catch (e) {
          return jsonResponse(500, { error: e.message });
        }
      });
      return;
    }
  }

  const tmuxLegacyImageMatch = pathname.match(/^\/api\/code\/tmux\/([^/]+)\/image-file\/(ops-agent-\d+-[a-f0-9]{10}\.(?:png|jpg|webp|gif))$/);
  if (req.method === "GET" && tmuxLegacyImageMatch) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const tmuxName = safeTmuxName(decodeURIComponent(tmuxLegacyImageMatch[1]));
    const imagePath = path.join(require("os").tmpdir(), tmuxLegacyImageMatch[2]);
    if (!tmuxName || !fs.existsSync(imagePath)) return jsonResponse(404, { error: "Image not found" });
    const mimeType = {
      png: "image/png",
      jpg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    }[path.extname(imagePath).slice(1)];
    const stat = fs.statSync(imagePath);
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": stat.size,
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${tmuxLegacyImageMatch[2]}"`,
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(imagePath).pipe(res);
    return;
  }

  const tmuxImageMatch = pathname.match(/^\/api\/code\/tmux\/([^/]+)\/image\/([a-f0-9]{24})$/);
  if (req.method === "GET" && tmuxImageMatch) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const tmuxName = safeTmuxName(decodeURIComponent(tmuxImageMatch[1]));
    const image = tmuxName ? getUserImage(tmuxName, tmuxImageMatch[2]) : null;
    if (!image) return jsonResponse(404, { error: "Image not found" });
    try {
      const stat = fs.statSync(image.path);
      res.writeHead(200, {
        "Content-Type": image.mimeType,
        "Content-Length": stat.size,
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${path.basename(image.name).replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(image.path).pipe(res);
    } catch {
      jsonResponse(404, { error: "Image not found" });
    }
    return;
  }

  const tmuxApiMatch = pathname.match(/^\/api\/code\/tmux\/([^/]+)\/(capture|delivery|input|message|key|question|selection|queue|permissions|ship)$/);
  if (tmuxApiMatch) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const tmuxName = safeTmuxName(decodeURIComponent(tmuxApiMatch[1]));
    if (!tmuxName || !listTmuxSessions().some((entry) => entry.tmuxName === tmuxName)) {
      return jsonResponse(404, { error: "Live agent session not found" });
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "ship") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const kind = parsed.kind === "pipeline" ? "pipeline" : "development";
          const db = await getDb();
          const fix = await db.collection("fix_sessions").findOne({ tmuxName });
          const codeSession = fix?.codeSessionId
            ? await db.collection("code_sessions").findOne({ sessionId: fix.codeSessionId })
            : null;
          const result = await prepareShipChoice(db, { kind, codeSession, tmuxName });
          return jsonResponse(200, result);
        } catch (e) {
          return jsonResponse(500, { error: e.message });
        }
      });
      return;
    }
    if (req.method === "GET" && tmuxApiMatch[2] === "delivery") {
      const tmuxSession = listTmuxSessions().find((entry) => entry.tmuxName === tmuxName);
      const deliveryKey = tmuxSession?.worktreePath || "";
      // Best-effort: if Full pipeline was armed for a ticket repair, notify the
      // ticket channel once commits land on master (never closes the ticket).
      getDb()
        .then(async (db) => {
          const fix = await db.collection("fix_sessions").findOne({ tmuxName });
          const codeSession = fix?.codeSessionId
            ? await db.collection("code_sessions").findOne({ sessionId: fix.codeSessionId })
            : null;
          return maybePostProductionRecheck(db, {
            codeSession,
            tmuxName,
            worktreePath: tmuxSession?.worktreePath,
          });
        })
        .then((r) => {
          if (r && r.posted) console.log("[ticket-ship] production-recheck", JSON.stringify(r));
        })
        .catch((e) => console.error("[ticket-ship] production-recheck failed:", e.message));
      return jsonResponse(200, {
        delivery: liveDeliveryCache.get(
          deliveryKey,
          () => collectDeliveryStatus(tmuxSession?.worktreePath)
        ),
      });
    }
    if (req.method === "GET" && tmuxApiMatch[2] === "capture") {
      try {
        const tmuxSession = listTmuxSessions().find((entry) => entry.tmuxName === tmuxName);
        const provider = agentKindFor(tmuxName)?.kind || "codex";
        // Styled capture (-e) lets the transcript parser tell kimi's dim
        // thinking text apart from responses; every other consumer gets the
        // same plain text as before.
        const styledOutput = captureTmuxSession(tmuxName, 800, { styled: true });
        const output = stripTmuxEscapes(styledOutput);
        const autoApproved = maybeAutoApproveAttention(tmuxName, output);
        const attention = autoApproved ? null : detectAttention(provider, output);
        // A pending question is only ever visible in the pane — the CLI writes
        // the AskUserQuestion record to its session log after it is answered, so
        // the log-backed transcript cannot surface one that is still waiting.
        const pendingQuestion = detectPendingQuestion(provider, output);
        const lastUser = getLastUserMessage(tmuxName);
        let cost = null;
        try {
          cost = {
            today: getCostForKind(provider, "today"),
            session: latestSessionForKind(provider),
          };
        } catch {}
        const userHistory = getUserMessageHistory(tmuxName);
        // Claude runs in the terminal's alternate screen, which has no
        // scrollback — the pane only ever holds the ~25 visible rows. Its
        // conversation is read from the CLI's session log instead, so the
        // snapshot has to change when that log grows even though the pane may
        // have repainted to something identical. Without the log's position in
        // the fingerprint, the client's `unchanged` short-circuit hides new
        // output until the pane happens to differ.
        const claudeState = provider === "claude"
          ? claudeSessionState(tmuxName, tmuxSession?.worktreePath)
          : null;
        const logStamp = claudeState
          ? `${claudeState.logPath}:${claudeState.updatedAt || 0}:${claudeState.tokens || 0}`
          : "";
        // The rendered transcript also depends on dashboard-side prompt
        // history, which can change before the CLI echoes anything to tmux.
        let version = fingerprintOutput(`${styledOutput}\0${lastUser}\0${userHistory.join("\0")}\0${logStamp}`);
        let transcript = liveTranscriptCache.get(
          `${tmuxName}:${version}:${lastUser}:${userHistory.length}`,
          () => {
            const pane = parseLiveTranscript(provider, styledOutput, {
              hintUser: lastUser,
              userHistory,
            });
            if (!claudeState?.logPath) return pane;
            const fromLog = claudeTranscriptFromLog(claudeState.logPath);
            if (!fromLog) return pane;
            // The log owns the conversation. The pane still owns the two things
            // only it can see: whether a turn is running right now, and the text
            // sitting unsent in the composer.
            return { ...fromLog, busy: pane.busy, draft: pane.draft || "" };
          }
        );
        // Happy ACP sessions (kimi/opencode via the happy wrapper) have no TUI:
        // the pane is a status log, and the conversation lives on the happy
        // relay. Swap in the relay transcript and let the pane keep answering
        // the one question it still can — whether a turn is running. The
        // version fingerprint must track the relay, not the pane, or the
        // client's `unchanged` short-circuit would freeze the thread.
        if (isHappyAcpSession(tmuxName)) {
          const happyId = happySessionIdForTmux(tmuxName);
          const relay = happyId
            ? await happyRelayTranscriptCache.get(happyId, () => happyTranscript(happyId).catch(() => null))
            : null;
          if (relay) {
            // The relay knows turn state directly (turn-start without a
            // turn-end); the pane only knows it for ACP status logs, and not
            // at all for codex's inert box UI.
            transcript = { ...relay, busy: relay.busy ?? isOutputBusy(provider, output) };
            const relayStamp = (relay.turns || [])
              .map((turn) => `${turn.user.length}:${turn.blocks.length}:${JSON.stringify(turn.blocks[turn.blocks.length - 1] || "").length}`)
              .join(",");
            version = fingerprintOutput(`${version}\0happy:${relayStamp}`);
          }
        }
        const userAttachments = getUserMessageAttachments(tmuxName).map((item) => ({
          text: item.text,
          images: item.images.map((image) => ({
            ...image,
            url: `/api/code/tmux/${encodeURIComponent(tmuxName)}/image/${image.id}`,
          })),
        }));
        const attachmentByPrompt = new Map(userAttachments.map((item) => [
          String(item.text || "").replace(/\s+/g, " ").trim().toLowerCase(),
          item.images,
        ]));
        for (const turn of transcript.turns || []) {
          const images = attachmentByPrompt.get(String(turn.user || "").replace(/\s+/g, " ").trim().toLowerCase());
          const capturedImages = (turn.imageFiles || []).map((file) => ({
            id: file,
            name: "Attached image",
            mimeType: null,
            url: `/api/code/tmux/${encodeURIComponent(tmuxName)}/image-file/${encodeURIComponent(file)}`,
          }));
          if (images?.length) turn.images = images;
          else if (capturedImages.length) turn.images = capturedImages;
          delete turn.imageFiles;
        }
        const wrapUp = refreshWrapUpFromOutput(tmuxName, output) || getWrapUpState(tmuxName);
        const snapshot = {
          version,
          output,
          transcript,
          userAttachments,
          lastUser,
          session: tmuxSession || null,
          queue: getQueue(tmuxName).map((item) => ({
            ...item,
            images: (item.images || []).map((image) => ({
              ...image,
              url: `/api/code/tmux/${encodeURIComponent(tmuxName)}/image/${image.id}`,
            })),
          })),
          attention,
          pendingQuestion,
          autoApproved: autoApproved || null,
          permissions: permissionStateFor(tmuxName),
          agentMode: detectAgentMode(provider, output),
          model: resolveAgentModel(provider, output, detectModelFromOutput, {
            tmuxName,
            cwd: tmuxSession?.worktreePath,
          }),
          usage: resolveAgentUsage(provider, tmuxSession?.worktreePath, output, detectUsageFromOutput, {
            tmuxName,
          }),
          cost,
          wrapUp: wrapUp || null,
          activeTasks: latestActiveTasks(transcript),
          // Lets the workspace offer a model picker without a second request.
          // Null for providers whose model cannot be changed mid-session.
          modelOptions: agentKindFor(tmuxName)?.supportsConfig
            ? { models: selectableModelsFor(provider), efforts: effortsForProvider(provider) }
            : null,
        };
        return jsonResponse(
          200,
          compactUnchangedSnapshot(snapshot, url.searchParams.get("v"))
        );
      }
      catch (e) { return jsonResponse(502, { error: e.message }); }
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "permissions") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          // `restart: true` is the client's explicit fallback after a cycle that
          // did not land — never taken on the agent's behalf, because it kills
          // the pane and interrupts whatever the agent was doing.
          const permissions = await setPermissionMode(tmuxName, parsed.mode, {
            confirmed: !!parsed.confirmed,
            restart: parsed.restart === true,
          });
          jsonResponse(200, { ok: permissions.landed !== false, permissions });
        } catch (e) {
          const status = e.statusCode || 400;
          jsonResponse(status, {
            error: e.message,
            code: e.code || undefined,
            permissions: e.permissions || undefined,
          });
        }
      });
      return;
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "input") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 20_000) req.destroy(); });
      req.on("end", async () => {
        try { const parsed = JSON.parse(body || "{}"); await sendTmuxInput(tmuxName, parsed.text); jsonResponse(200, { ok: true }); }
        catch (e) { jsonResponse(400, { error: e.message }); }
      });
      return;
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "message") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 9 * 1024 * 1024) req.destroy(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const savedImages = (Array.isArray(parsed.images) ? parsed.images.slice(0, 4) : []).map((image) => {
            const mime = String(image.mimeType || "");
            if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) throw new Error("Unsupported image type");
            const bytes = Buffer.from(String(image.data || "").replace(/^data:[^;]+;base64,/, ""), "base64");
            if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Each image must be under 8 MB");
            const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime];
            const target = path.join(require("os").tmpdir(), `ops-agent-${Date.now()}-${crypto.randomBytes(5).toString("hex")}.${ext}`);
            fs.writeFileSync(target, bytes, { mode: 0o600 });
            return {
              id: crypto.randomBytes(12).toString("hex"),
              name: path.basename(String(image.name || `attachment.${ext}`)).slice(0, 160),
              mimeType: mime,
              path: target,
            };
          });
          const text = String(parsed.text || "").trim();
          if (!text && !savedImages.length) throw new Error("Message or image required");
          const displayText = String(parsed.displayText || "").trim().slice(0, 160)
            || text
            || "Analyze the attached image.";
          const agentText = text || displayText;
          const note = savedImages.length ? `\n\n[Attached image${savedImages.length > 1 ? "s" : ""} for analysis:\n${savedImages.map((image) => image.path).join("\n")}]` : "";
          const queued = enqueueMessage(tmuxName, `${agentText}${note}`, { displayText, images: savedImages });
          setImmediate(() => { flushTmuxQueues().catch(() => {}); });
          jsonResponse(200, { ok: true, images: savedImages.length, queued, lastUser: getLastUserMessage(tmuxName) });
        } catch (e) { jsonResponse(400, { error: e.message }); }
      });
      return;
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "key") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 1000) req.destroy(); });
      req.on("end", () => {
        try { const parsed = JSON.parse(body || "{}"); sendTmuxKey(tmuxName, parsed.key); jsonResponse(200, { ok: true }); }
        catch (e) { jsonResponse(400, { error: e.message }); }
      });
      return;
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "question") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 20_000) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          // Answering used to be a raw single keystroke, which could not express a
          // multi-select (digit toggles, Submit tab commits), could not reach option
          // 10 or higher, and could not carry the text a free-text option asks for.
          jsonResponse(200, {
            ok: true,
            ...await answerPendingQuestion(tmuxName, parsed.options ?? parsed.option, parsed.text),
          });
        } catch (e) {
          jsonResponse(e.statusCode || 400, { error: e.message });
        }
      });
      return;
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "queue") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          if (parsed.force || parsed.forceSend) {
            return jsonResponse(200, await forceFlushQueue(tmuxName, {
              interrupt: parsed.interrupt !== false,
            }));
          }
          if (parsed.clear) {
            while (getQueue(tmuxName).length) removeQueuedMessage(tmuxName, 0);
            return jsonResponse(200, { ok: true, queued: 0 });
          }
          const queued = removeQueuedMessage(tmuxName, Number(parsed.index));
          jsonResponse(200, { ok: true, queued });
        } catch (e) { jsonResponse(e.statusCode || 400, { error: e.message }); }
      });
      return;
    }
    if (req.method === "POST" && tmuxApiMatch[2] === "selection") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 1000) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          jsonResponse(200, { ok: true, ...(await selectAgentConfig(tmuxName, parsed.model, parsed.effort)) });
        } catch (e) { jsonResponse(e.statusCode || 400, { error: e.message }); }
      });
      return;
    }
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // POST /api/code/agents/terminate — Soft wrap-up by default; force=true kills immediately.
  if (req.method === "POST" && pathname === "/api/code/agents/terminate") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        jsonResponse(200, { ok: true, ...requestEndSession(parsed.sessionId, { force: !!parsed.force }) });
      } catch (e) { jsonResponse(400, { error: e.message }); }
    });
    return;
  }

  // PATCH /api/code/agents/title — Rename a live agent card.
  if (req.method === "PATCH" && pathname === "/api/code/agents/title") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        jsonResponse(200, { ok: true, ...setAgentTitle(parsed.sessionId, parsed.title) });
      } catch (e) { jsonResponse(400, { error: e.message }); }
    });
    return;
  }

  // PATCH /api/code/agents/group — Assign a live agent to a group (null clears).
  if (req.method === "PATCH" && pathname === "/api/code/agents/group") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        jsonResponse(200, { ok: true, ...setAgentGroup(parsed.sessionId, parsed.groupId || null) });
      } catch (e) { jsonResponse(400, { error: e.message }); }
    });
    return;
  }

  // GET/POST /api/code/agent-groups — List or create named live-agent groups.
  if (pathname === "/api/code/agent-groups") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    if (req.method === "GET") {
      return jsonResponse(200, { groups: listAgentGroups() });
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          jsonResponse(200, { ok: true, group: createAgentGroup(parsed.name) });
        } catch (e) { jsonResponse(400, { error: e.message }); }
      });
      return;
    }
  }

  // PATCH/DELETE /api/code/agent-groups/:id — Rename or delete a group.
  if (pathname.match(/^\/api\/code\/agent-groups\/[^/]+$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const groupId = decodeURIComponent(pathname.split("/").pop());
    if (req.method === "PATCH") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 2000) req.destroy(); });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          jsonResponse(200, { ok: true, group: renameAgentGroup(groupId, parsed.name) });
        } catch (e) { jsonResponse(400, { error: e.message }); }
      });
      return;
    }
    if (req.method === "DELETE") {
      try {
        jsonResponse(200, deleteAgentGroup(groupId));
      } catch (e) { jsonResponse(400, { error: e.message }); }
      return;
    }
  }

  // POST /api/code/tmux/spawn — Start a new live agent (claude/codex/kimi/cursor/opencode/ollama) in tmux.
  if (req.method === "POST" && pathname === "/api/code/tmux/spawn") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 64_000) req.destroy(); });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const prompt = parsed.prompt == null ? "" : String(parsed.prompt).trim();
        const effort = parsed.effort == null ? "" : String(parsed.effort).trim();
        const result = await spawnTmuxAgent(parsed.provider, parsed.cwd, parsed.permissionMode, parsed.model, { prompt });
        const title = parsed.title == null ? "" : String(parsed.title).trim();
        if (title) {
          try { setAgentTitle(`tmux:${result.name}`, title); } catch { /* best-effort */ }
        }
        let seed = null;
        if (prompt) {
          seed = await seedAgentPrompt(result.name, prompt);
        }
        // Claude, Codex and Kimi ignore a model at launch, so a routed choice
        // has to be typed into the TUI once it is up. After seeding, so the
        // switch does not race the prompt into the same pane.
        let routed = null;
        const wantsAuto = parsed.model === "auto" || (!parsed.model && prompt);
        if (wantsAuto && !result.model) {
          routed = await autoTuneAgent(result.name, parsed.provider, prompt);
        } else if (!result.model && (parsed.model || effort)) {
          // An explicit model/effort from the spawn sheet lands the same way
          // the in-session picker does — after boot, via the TUI.
          try {
            routed = await selectAgentConfig(result.name, parsed.model || undefined, effort || undefined);
          } catch (e) {
            routed = { error: e.message };
          }
        }
        jsonResponse(200, { ok: true, ...result, title: title || null, seed, routed });
      } catch (e) { jsonResponse(400, { error: e.message }); }
    });
    return;
  }

  // GET/POST /api/code/tmux/schedules — List or create one-shot delayed live agents.
  if (pathname === "/api/code/tmux/schedules") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    if (req.method === "GET") {
      try {
        const schedules = await listSchedules(await getDb());
        return jsonResponse(200, { schedules });
      } catch (e) { return jsonResponse(400, { error: e.message }); }
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; if (body.length > 64_000) req.destroy(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const schedule = await createSchedule(await getDb(), parsed);
          jsonResponse(200, { ok: true, schedule });
        } catch (e) { jsonResponse(400, { error: e.message }); }
      });
      return;
    }
  }

  // DELETE /api/code/tmux/schedules/:id — Cancel a pending one-shot schedule.
  if (req.method === "DELETE" && pathname.match(/^\/api\/code\/tmux\/schedules\/[^/]+$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const scheduleId = decodeURIComponent(pathname.split("/").pop());
    try {
      const schedule = await cancelSchedule(await getDb(), scheduleId);
      return jsonResponse(200, { ok: true, schedule });
    } catch (e) { return jsonResponse(400, { error: e.message }); }
  }

  // Alias POST /api/code/tmux/schedule → schedules (singular form from the plan).
  if (req.method === "POST" && pathname === "/api/code/tmux/schedule") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 64_000) req.destroy(); });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const schedule = await createSchedule(await getDb(), parsed);
        jsonResponse(200, { ok: true, schedule });
      } catch (e) { jsonResponse(400, { error: e.message }); }
    });
    return;
  }

  // GET /api/code/tmux/spawn-options?provider=ollama|opencode|…
  // Modes + model catalog for the Live agent spawn modal.
  if (req.method === "GET" && pathname === "/api/code/tmux/spawn-options") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const kind = String(url.searchParams.get("provider") || "").trim();
      if (!kind) {
        const kinds = ["claude", "codex", "kimi", "cursor", "opencode", "ollama"];
        return jsonResponse(200, {
          providers: kinds.map((k) => spawnOptionsFor(k)),
        });
      }
      const options = spawnOptionsFor(kind);
      // Refresh cloud catalogs from /v1/models when credentials are present.
      if (kind === "ollama" || kind === "opencode") {
        const live = await discoverCloudSpawnModels(kind).catch(() => null);
        if (live?.length) {
          options.models = live.map((id) => ({
            id,
            label: id,
            providerModel: kind === "ollama" ? `ollama-cloud/${id}` : `opencode-go/${id}`,
          }));
          if (!options.models.some((m) => m.id === options.defaultModel)) {
            options.defaultModel = options.models[0].id;
          }
          options.discovered = true;
        }
      }
      jsonResponse(200, options);
    } catch (e) { jsonResponse(400, { error: e.message }); }
    return;
  }

  // GET /api/code/sessions — List persisted chats plus live tmux agents.
  if (req.method === "GET" && pathname === "/api/code/sessions") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const persisted = await collectPersistedSessions(codeSessionManager);
      const list = persisted.sessions;
      const costOverview = peekCostOverview();
      if (!costOverview) warmCostOverviewAsync();
      const liveRaw = listTmuxSessions().map((session) => {
        try {
          const tail = captureTmuxSession(session.tmuxName, 60);
          const kind = agentKindFor(session.tmuxName)?.kind || "codex";
          const attention = detectAttention(kind, tail);
          const status = detectLiveStatus(kind, tail);
          let taskExcerpt = String(getLastUserMessage(session.tmuxName) || "").trim();
          if (!taskExcerpt) {
            try {
              const parsed = parseLiveTranscript(kind, tail, {
                hintUser: "",
                userHistory: getUserMessageHistory(session.tmuxName),
              });
              taskExcerpt = String(parsed?.user || "").trim();
            } catch { /* ignore parse failures */ }
          }
          if (taskExcerpt.length > 100) taskExcerpt = `${taskExcerpt.slice(0, 99)}…`;
          const wrapUp = refreshWrapUpFromOutput(session.tmuxName, tail) || getWrapUpState(session.tmuxName);
          return {
            ...session,
            activity: isOutputBusy(kind, tail) ? "working" : "ready",
            needsInput: !!attention,
            attentionExcerpt: attention?.excerpt || null,
            statusLine: status?.text || null,
            statusSource: status?.source || null,
            taskExcerpt: taskExcerpt || null,
            modelDetail: resolveAgentModel(kind, tail, detectModelFromOutput, {
              tmuxName: session.tmuxName,
              cwd: session.worktreePath,
            }),
            usage: resolveAgentUsage(kind, session.worktreePath, tail, detectUsageFromOutput, {
              tmuxName: session.tmuxName,
            }),
            wrapUp: wrapUp || null,
          };
        } catch {
          return session;
        }
      });
      const live = enrichLiveSessions([...liveRaw, ...listProcessAgents()]);
      jsonResponse(200, {
        sessions: [...live, ...list],
        groups: listAgentGroups(),
        costs: costOverview,
        warning: persisted.warning,
      });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // GET /api/code/costs — API-equivalent spend via CodeBurn.
  if (req.method === "GET" && pathname === "/api/code/costs") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const overview = await getCostOverviewAsync();
      if (!overview) return jsonResponse(202, { pending: true, source: "codeburn" });
      jsonResponse(200, overview);
    } catch (e) {
      jsonResponse(502, { error: e.message, source: "codeburn" });
    }
    return;
  }

  // GET /api/code/costs/breakdown — full period breakdown for /code/costs.
  if (req.method === "GET" && pathname === "/api/code/costs/breakdown") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const period = normalizeBreakdownPeriod(url.searchParams.get("period") || "today");
    if (!period) return jsonResponse(400, { error: "period must be today, week, or month" });
    try {
      const breakdown = await getCostBreakdownAsync(period);
      if (!breakdown) return jsonResponse(202, { pending: true, period, source: "codeburn" });
      jsonResponse(200, breakdown);
    } catch (e) {
      jsonResponse(502, { error: e.message, source: "codeburn" });
    }
    return;
  }

  // GET /api/code/questions — List all user questions across all sessions
  if (req.method === "GET" && pathname === "/api/code/questions") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const db = require("./server-db");
      const sessions = db.collection("code_sessions");
      const allSessions = await sessions.find({}, { projection: { sessionId: 1, title: 1, messages: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(100).toArray();
      const questions = [];
      for (const s of allSessions) {
        if (!s.messages || !s.messages.length) continue;
        for (const m of s.messages) {
          if (m.role === "user" && m.content) {
            questions.push({
              sessionId: s.sessionId,
              sessionTitle: s.title || "Untitled",
              content: m.content,
              timestamp: m.timestamp || s.updatedAt,
            });
          }
        }
      }
      // Sort by timestamp desc, limit to 200 most recent
      questions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      jsonResponse(200, { questions: questions.slice(0, 200) });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // GET /api/code/providers — List configured providers/models for model picker
  // Includes auto-discovery of models from provider /v1/models endpoints
  if (req.method === "GET" && pathname === "/api/code/providers") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const fs = require("fs");
      const configPath = require("path").join(require("os").homedir(), ".hermes", "config.yaml");
      let providers = [];
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        const lines = raw.split("\n");
        let inProviders = false;
        let current = null;
        for (const line of lines) {
          if (/^providers:\s*$/.test(line)) { inProviders = true; continue; }
          if (!inProviders) continue;
          // Stop at next top-level key
          if (line && !line.startsWith(" ") && /^[a-z]/.test(line)) break;
          const provM = line.match(/^  (\S.*):\s*$/);
          if (provM) {
            current = { name: provM[1], models: [], baseUrl: "", apiKey: "" };
            providers.push(current);
            continue;
          }
          if (current) {
            const urlM = line.match(/^    base_url:\s*(.+)/);
            if (urlM) current.baseUrl = urlM[1].trim();
            const keyM = line.match(/^    api_key:\s*(.+)/);
            if (keyM) current.apiKey = keyM[1].trim();
            const modelM = line.match(/^    - (.+)/);
            if (modelM) current.models.push(modelM[1].trim());
            const discM = line.match(/^    discover_models:\s*(.+)/);
            if (discM) current.discoverModels = discM[1].trim() !== "false";
          }
        }
      } catch {}
      // Add the active provider first as default
      providers.unshift({ name: LLM_PROVIDER, models: [LLM_MODEL], baseUrl: LLM_API_URL?.replace(/\/chat\/completions$/, ""), isDefault: true, apiKey: LLM_API_KEY });
      // Filter out providers without api_key (can't use them)
      providers = providers.filter(p => p.isDefault || p.apiKey);
      // Codex is an on-box agent runtime, not an OpenAI-compatible HTTP
      // provider. It authenticates through the installed Codex CLI and runs in
      // each code session's isolated worktree.
      providers.unshift({
        name: "codex",
        models: CODEX_MODELS,
        baseUrl: "",
        apiKey: "",
        isCodexRuntime: true,
      });
      // Resolve env var references (e.g. "KIMI_API_KEY" -> process.env.KIMI_API_KEY)
      for (const p of providers) {
        if (p.apiKey && /^[A-Z][A-Z0-9_]+$/.test(p.apiKey) && process.env[p.apiKey]) {
          p.apiKey = process.env[p.apiKey];
        }
      }

      // Discover models for providers that have no models but have a baseUrl
      const discoveryPromises = [];
      for (const p of providers) {
        if (p.models.length > 0 || !p.baseUrl || p.discoverModels === false) continue;
        const cacheKey = p.name;
        const cached = modelDiscoveryCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 300000) {
          p.models = cached.models;
          continue;
        }
        const baseUrl = p.baseUrl.replace(/\/v1\/?$/, "").replace(/\/chat\/completions$/, "");
        const modelsUrl = baseUrl + "/v1/models";
        discoveryPromises.push(
          fetch(modelsUrl, {
            headers: { "Authorization": `Bearer ${p.apiKey || LLM_API_KEY}` },
            signal: AbortSignal.timeout(8000),
          })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data?.data && Array.isArray(data.data)) {
              const models = data.data.map(m => m.id).filter(Boolean).sort();
              if (models.length) {
                p.models = models;
                modelDiscoveryCache.set(cacheKey, { models, ts: Date.now() });
              }
            }
          })
          .catch(() => {})
        );
      }
      if (discoveryPromises.length) {
        await Promise.allSettled(discoveryPromises);
      }

      // Annotate each model with vision support flag
      const VISION_PATTERNS = [
        /^gpt-4o/, /^gpt-4-turbo/, /^gpt-4-vision/,
        /^claude-3/, /^claude-sonnet/, /^claude-opus/, /^claude-haiku/,
        /^gemini/, /^pixtral/, /^llava/, /^bakllava/, /^moondream/,
        /^moonshot.*vision/, /kimi.*vision/, /vision.*kimi/,
        /^qwen.*vl/, /^qwen2.*vl/, /^internvl/, /^cogvlm/,
        /^phi.*vision/, /^idefics/, /^fuyu/, /^bunny/,
        /^mistral.*pixtral/, /^mixtral.*vision/,
        /\bvision\b/, /\bvl\b/, /-vision/, /vision-/,
      ];
      function modelSupportsVision(modelId) {
        const m = (modelId || "").toLowerCase();
        return VISION_PATTERNS.some(re => re.test(m));
      }
      for (const p of providers) {
        p.models = p.models.map(m => ({
          id: m,
          supportsVision: modelSupportsVision(m),
        }));
      }

      jsonResponse(200, {
        providers,
        currentProvider: LLM_PROVIDER,
        currentModel: LLM_MODEL,
        codexDefaultModel: CODEX_DEFAULT_MODEL,
      });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // GET /api/code/branches — List local branches for base branch selection
  if (req.method === "GET" && pathname === "/api/code/branches") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const { execSync } = require("child_process");
      const raw = execSync("git branch --format='%(refname:short)'", {
        cwd: REPO_DIR, encoding: "utf8", timeout: 5000,
      }).trim().split("\n").filter(Boolean);
      jsonResponse(200, { branches: raw });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // POST /api/code/sessions — Create a new session
  if (req.method === "POST" && pathname === "/api/code/sessions") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const session = await codeSessionManager.createSessionStub({
          model: parsed.model,
          provider: parsed.provider,
          baseBranch: parsed.baseBranch,
        });
        jsonResponse(201, { session });
      } catch (e) {
        jsonResponse(500, { error: e.message });
      }
    });
    return;
  }

  // GET /api/code/sessions/:id/workspace — Lightweight workspace + delivery
  // state only (no message history). The session detail page polls this every
  // few seconds for the delivery banner; serving it standalone avoids shipping
  // the full message/event transcript on every poll tick.
  if (req.method === "GET" && pathname.match(/^\/api\/code\/sessions\/[^/]+\/workspace$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    try {
      const session = await codeSessionManager.getSession(sid);
      if (!session) return jsonResponse(404, { error: "Session not found" });
      const delivery = liveDeliveryCache.get(
        session.worktreePath || "",
        () => collectDeliveryStatus(session.worktreePath)
      );
      if (session.awaitingProductionNotify) {
        getDb()
          .then((db) => maybePostProductionRecheck(db, {
            codeSession: session,
            worktreePath: session.worktreePath,
          }))
          .then((r) => {
            if (r && r.posted) console.log("[ticket-ship] production-recheck", JSON.stringify(r));
          })
          .catch((e) => console.error("[ticket-ship] production-recheck failed:", e.message));
      }
      jsonResponse(200, {
        delivery,
        branchName: session.branchName || null,
        worktreePath: session.worktreePath || null,
      });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // POST /api/code/sessions/:id/ship — prepare Land-on-dev / Full-pipeline prompt
  // and arm ticket production-notify when applicable.
  if (req.method === "POST" && pathname.match(/^\/api\/code\/sessions\/[^/]+\/ship$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", async () => {
      try {
        const session = await codeSessionManager.getSession(sid);
        if (!session) return jsonResponse(404, { error: "Session not found" });
        const parsed = body ? JSON.parse(body) : {};
        const kind = parsed.kind === "pipeline" ? "pipeline" : "development";
        const db = await getDb();
        const result = await prepareShipChoice(db, { kind, codeSession: session });
        return jsonResponse(200, result);
      } catch (e) {
        return jsonResponse(500, { error: e.message });
      }
    });
    return;
  }

  // GET /api/code/sessions/:id — Get session detail + history
  if (req.method === "GET" && pathname.startsWith("/api/code/sessions/") && !pathname.endsWith("/ws") && !pathname.endsWith("/pr") && !pathname.endsWith("/messages") && !pathname.endsWith("/workspace")) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    try {
      const session = await codeSessionManager.getSession(sid);
      if (!session) return jsonResponse(404, { error: "Session not found" });
      jsonResponse(200, {
        session,
        workspace: codeSessionManager.getWorkspaceSnapshot(session, {
          fresh: url.searchParams.get("workspace") === "fresh",
        }),
        delivery: collectDeliveryStatus(session.worktreePath),
      });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // POST /api/code/sessions/:id/messages — Append a message to history
  if (req.method === "POST" && pathname.match(/^\/api\/code\/sessions\/[^/]+\/messages$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.role || !data.content) return jsonResponse(400, { error: "role and content required" });
        await codeSessionManager.appendMessage(sid, { role: data.role, content: data.content, timestamp: new Date() });
        jsonResponse(200, { ok: true });
      } catch (e) {
        jsonResponse(500, { error: e.message });
      }
    });
    return;
  }

  // POST /api/code/sessions/:id/commit — Commit the session's current worktree
  if (req.method === "POST" && pathname.match(/^\/api\/code\/sessions\/[^/]+\/commit$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) {
          const error = new Error("Request body too large");
          error.statusCode = 413;
          throw error;
        }
      }
      const parsed = JSON.parse(body || "{}");
      const result = await codeSessionManager.commitChanges(sid, parsed.message);
      jsonResponse(200, result);
    } catch (e) {
      jsonResponse(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  // POST /api/code/sessions/:id/pr — Create a PR from the session's worktree
  if (req.method === "POST" && pathname.match(/^\/api\/code\/sessions\/[^/]+\/pr$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) {
          const error = new Error("Request body too large");
          error.statusCode = 413;
          throw error;
        }
      }
      const parsed = JSON.parse(body || "{}");
      const result = await codeSessionManager.createPR(sid, {
        title: parsed.title,
        body: parsed.body,
        commitMessage: parsed.commitMessage,
      });
      jsonResponse(200, result);
    } catch (e) {
      jsonResponse(e.statusCode || 500, { error: e.message });
    }
    return;
  }

  // DELETE /api/code/sessions/:id — Delete session + cleanup
  if (req.method === "DELETE" && pathname.match(/^\/api\/code\/sessions\/[^/]+$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    try {
      await codeSessionManager.deleteSession(sid);
      jsonResponse(200, { ok: true });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // PATCH /api/code/sessions/:id/permissions — Update permission mode
  if (req.method === "PATCH" && pathname.match(/^\/api\/code\/sessions\/[^/]+\/permissions$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { mode } = JSON.parse(body);
      if (!["auto", "safe", "confirm"].includes(mode)) {
        return jsonResponse(400, { error: "Invalid mode. Use: auto, safe, confirm" });
      }
      await codeSessionManager.updatePermissionMode(sid, mode);
      jsonResponse(200, { ok: true, mode });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // PATCH /api/code/sessions/:id/title — Rename session
  if (req.method === "PATCH" && pathname.match(/^\/api\/code\/sessions\/[^/]+\/title$/)) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const sid = pathname.split("/")[4];
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { title } = JSON.parse(body);
      if (!title || typeof title !== "string" || title.trim().length === 0) {
        return jsonResponse(400, { error: "Title required" });
      }
      await codeSessionManager.updateTitle(sid, title.trim().slice(0, 120));
      jsonResponse(200, { ok: true, title: title.trim().slice(0, 120) });
    } catch (e) {
      jsonResponse(500, { error: e.message });
    }
    return;
  }

  // GET /reports — Reports directory (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "index.html"), "utf8");
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load reports directory");
    }
    return;
  }

  // GET /reports/election-post-mortem — Election post-mortem report (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/election-post-mortem") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "election-post-mortem.html"), "utf8");
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/election-post-mortem-1992 — 1992 Election post-mortem report (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/election-post-mortem-1992") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "election-post-mortem-1992.html"), "utf8");
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/sandbox-economy-audit — Sandbox economy audit report (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/sandbox-economy-audit") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "sandbox-economy-audit.html"), "utf8");
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/production-economy-audit — Production economy audit report (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/production-economy-audit") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "production-economy-audit.html"), "utf8");
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/capacity-emergency-t833 — "The 240-Turn Fuse": emergency
  // assessment of the extraction capacity system (haircut ramp, Diversified
  // congestion, D/S shortages) + three proposed fixes (decaying commodity seed,
  // auto-focus for stuck sectors, window/glut guardrail). Intentionally
  // UNAUTHENTICATED (owner request): static snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/capacity-emergency-t833") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "capacity-emergency-t833.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/knowledge-synthesis — deep cross-source synthesis of the whole
  // knowledge pool (docs+skills+memory+suggestions+tickets+Discord themes). Admin.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/knowledge-synthesis") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    try {
      const body = fs.readFileSync(path.join(__dirname, "reports", "knowledge-synthesis.html"), "utf8");
      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : renderShell({ title: "Knowledge Synthesis", active: "/reports", role: session.role, extraCss: "", body }));
    } catch (e) {
      addSecurityHeaders(res); res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/clearing-collapse-remediation-t879 — "The Market That Ate Its
  // Makers": live-clone A/B autopsy of the clearing-tier equity collapse (−67.7%
  // vs −15.9% ledger), the order-book bookkeeping root cause, Dumb-NPP amplifier,
  // total remediation plan + systems-interaction UI overhaul + NPP AI redesign.
  // Intentionally UNAUTHENTICATED (owner request, matches other market reports):
  // static snapshot of a sandbox clone, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/clearing-collapse-remediation-t879") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "clearing-collapse-remediation-t879.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/market-clearing-impact-t836 — "What happens if we run the rest
  // of the market rework": read-only live-prod model of promoting marketSystemMode
  // to clearing/capital (turn 836). Copper-gated −55% steady state, 240-turn fuse.
  // Intentionally UNAUTHENTICATED (owner request): static snapshot, no live data,
  // no player PII — aggregate economy figures only.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/market-clearing-impact-t836") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "market-clearing-impact-t836.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/market-growth-monetization-t858 — "Competitive Landscape, Growth
  // & Monetization Audit": where AHD sits in the political-sim market, the economic
  // moat, untapped growth channels, and a no-P2W Patreon rebuild. Intentionally
  // UNAUTHENTICATED (owner request): static snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/market-growth-monetization-t858") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "market-growth-monetization-t858.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/healthcare-demand-collapse-t1048 — "The Sector That Can't Sell":
  // turn-1048 forensic on healthcare demand collapse (issue #3137, ticket #938
  // follow-up) + ranked repair plan. UNAUTHENTICATED like the other Public
  // reports: static snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/healthcare-demand-collapse-t1048") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "healthcare-demand-collapse-t1048.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/state-of-the-game-t856 — "State of the Game: Autopsy & Manifesto":
  // turn-856 whole-game health audit (engine, economy, players, community) plus
  // strategic proposals. Intentionally UNAUTHENTICATED (owner request): static
  // snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/state-of-the-game-t856") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "state-of-the-game-t856.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/metrics-system-audit-t822 — "The Numbers Beneath the Numbers":
  // turn-822 metrics-system audit (coverage map, era gating, policy squash paths,
  // approval modifiers, prod DB health). Intentionally UNAUTHENTICATED (owner
  // request): static snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/metrics-system-audit-t822") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "metrics-system-audit-t822.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/sandbox-seed-audit-t101 — "The Reset Button Problem": sandbox
  // seed-readiness audit at turn 101 (frozen commodity prices, clamped inflation,
  // missing federal budget, unresolved elections, dead labour substrate, feature-
  // gate timeline). Intentionally UNAUTHENTICATED (owner request): static
  // snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/sandbox-seed-audit-t101") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "sandbox-seed-audit-t101.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/centralbank-forex-audit-t817 — "The Free-Money Machines":
  // central bank + forex structural audit (rates, savings, LOC, reserves, bands).
  // Intentionally UNAUTHENTICATED (owner request): static snapshot, no live data,
  // no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/centralbank-forex-audit-t817") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "centralbank-forex-audit-t817.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/brand-loyalty-plan — "Brand Loyalty & Premium Positioning":
  // handoff-ready implementation plan (v1 design locked with gameplay-advisors
  // 2026-07-06). Intentionally UNAUTHENTICATED: design spec, no live data, no PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/brand-loyalty-plan") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "brand-loyalty-plan.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/clearing-capital-live-t899 — "Clearing + Capital: the first
  // three live turns": preliminary day-one read of the full market rework on
  // prod (engine health, flow ledger, extraction capacity, advisor feedback).
  // Intentionally UNAUTHENTICATED (owner request pattern): static snapshot,
  // aggregate figures only, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/clearing-capital-live-t899") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "clearing-capital-live-t899.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/political-systems-audit-t809 — "The Machinery of Winning":
  // turn-809 political systems audit (demographics, lean, org/registration, elections).
  // Intentionally UNAUTHENTICATED (owner request): static snapshot, no live data,
  // no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/political-systems-audit-t809") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "political-systems-audit-t809.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/frontier-audit-2026-07 — adversarially-verified research audit of
  // AI-agent memory / LLM observability / multi-agent orchestration tooling vs the
  // ops stack, plus 3 new directions. Intentionally UNAUTHENTICATED (owner request):
  // static snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/frontier-audit-2026-07") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "frontier-audit-2026-07.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/commodity-structural-report-t806 — "Nothing Wants to Sell":
  // turn-806 re-audit + structural diagnosis + four proposed fixes.
  // Intentionally UNAUTHENTICATED (owner request): static snapshot, no live data,
  // no player PII. Every other report route stays admin-gated.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/commodity-structural-report-t806") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "commodity-structural-report-t806.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/market-realization-phase1-t831 — live-data assessment of Tier 1
  // ("realization") of the market rework, 5 turns after production rollout.
  // Companion to the t806 structural report. Intentionally UNAUTHENTICATED
  // (owner request, matches t806): static snapshot, no live data, no player PII.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/market-realization-phase1-t831") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "market-realization-phase1-t831.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/commodity-market-audit-t786 — Commodity market clinical audit.
  // Intentionally UNAUTHENTICATED (owner request): static snapshot, no live data,
  // no player PII. Every other report route stays admin-gated.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/commodity-market-audit-t786") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "commodity-market-audit-t786.html"), "utf8");
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // GET /reports/sim-experiment-* — NPP headless-sim experiment reports (admin only).
  // Generic handler: serves reports/<slug>.html for any sim-experiment page
  // (audit, cp1000, final1500, …) so new run reports need no per-file route.
  // Slug is strictly validated to sim-experiment-[a-z0-9-]+ — no path traversal.
  if ((req.method === "GET" || req.method === "HEAD") && /^\/reports\/sim-experiment-[a-z0-9-]+$/.test(pathname)) {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    const slug = pathname.slice("/reports/".length); // already regex-validated
    addSecurityHeaders(res);
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", `${slug}.html`), "utf8");
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Report not found");
    }
    return;
  }

  // GET /reports/replay-weekly-* — archived weekly OpenReplay analytics snapshots
  // (admin only). Generic handler like the sim reports; slug validated to
  // replay-weekly-[0-9-]+ (date), no path traversal.
  if ((req.method === "GET" || req.method === "HEAD") && /^\/reports\/replay-weekly-[0-9-]+$/.test(pathname)) {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    const slug = pathname.slice("/reports/".length);
    addSecurityHeaders(res);
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", `${slug}.html`), "utf8");
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Report not found");
    }
    return;
  }

  // GET /reports/seed-1953-audit — hostile audit of the 1953-default preset:
  // every seed value assumed wrong until verified. Static snapshot, no live
  // data, no player PII. Intentionally UNAUTHENTICATED (matches other reports).
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/reports/seed-1953-audit") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "reports", "seed-1953-audit.html"), "utf8");
      res.end(req.method === "HEAD" ? "" : html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load report");
    }
    return;
  }

  // Public stream contains event type and timestamp only. Clients fetch the
  // canonical status JSON after each signal; publisher payloads stay private.
  if (req.method === "GET" && pathname === "/api/status/events") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const unsubscribe = eventConsumers.subscribe(event => {
      if (!res.destroyed) res.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": keepalive\n\n"); }, 25000);
    res.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
    return;
  }

  if (req.method === "GET" && pathname === "/api/status/timeline") {
    return json(res, 200, { events: eventConsumers.recent().filter(event => event.type.startsWith("deploy:")) });
  }

  if (req.method === "GET" && pathname === "/api/events/dead-letters") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try { return json(res, 200, { events: await eventConsumers.listDeadLetters() }); }
    catch (error) { return json(res, 503, { error: error.message }); }
  }

  const replayMatch = pathname.match(/^\/api\/events\/dead-letters\/(\d+-\d+)\/replay$/);
  if (req.method === "POST" && replayMatch) {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    if (req.headers["x-requested-with"] !== "ops-dashboard" || req.headers.origin !== `https://${req.headers.host}`) {
      return json(res, 403, { error: "Invalid request origin" });
    }
    try { return json(res, 202, { event: await eventConsumers.replayDeadLetter(replayMatch[1]) }); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/events") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return denyHtml();
    const body = `<h1>Event recovery</h1><p>Failed event deliveries stay here until replayed.</p><div id="event-recovery-list">Loading…</div>
<script>
async function loadDeadLetters(){
  const host=document.getElementById('event-recovery-list');
  try{
    const response=await fetch('/api/events/dead-letters');
    if(!response.ok)throw new Error('Could not load failed events');
    const data=await response.json();
    host.replaceChildren();
    if(!data.events.length){host.textContent='No failed events.';return;}
    for(const event of data.events){
      const row=document.createElement('div');
      row.style.cssText='padding:1rem;border:1px solid var(--border);border-radius:var(--r-md);margin:1rem 0';
      const label=document.createElement('strong');
      label.textContent=(event.type||'Unknown')+' · '+event.streamId;
      const detail=document.createElement('p');
      detail.textContent=event.error||'No error detail';
      const button=document.createElement('button');
      button.textContent='Replay';
      button.onclick=async()=>{
        button.disabled=true;
        try{
          const result=await fetch('/api/events/dead-letters/'+encodeURIComponent(event.streamId)+'/replay',{method:'POST',headers:{'X-Requested-With':'ops-dashboard'}});
          if(!result.ok)throw new Error((await result.json()).error||'Replay failed');
          await loadDeadLetters();
        }catch(error){detail.textContent=error.message;button.disabled=false;}
      };
      row.append(label,detail,button);host.append(row);
    }
  }catch(error){host.textContent=error.message;}
}
loadDeadLetters();
</script>`;
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? "" : renderShell({ title: "Event recovery", active: "/events", role: session.role, body }));
    return;
  }

  // GET /status — Public uptime portal
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/status") {
    if (featureDisabled("statusPage")) return;
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(STATUS_PAGE);
    return;
  }

  // GET /api/status — Public status JSON. Powered by Uptime Kuma (single source
  // of truth); falls back to the built-in checks if Kuma is unreachable.
  if (req.method === "GET" && pathname === "/api/status") {
    let result = null;
    try {
      const k = await getKumaStatus();
      if (k && k.length) {
        const now = Date.now();
        const kumaIds = new Set(k.map(x => String(x.id)));
        result = k.map((s) => {
          const beats = (s.beats || []).map((b) => ({ ts: b.ts, up: b.up }));
          const within = (ms) => beats.filter((b) => new Date(b.ts).getTime() > now - ms);
          const pct = (arr) => (arr.length ? Math.round((arr.filter((b) => b.up).length / arr.length) * 10000) / 100 : null);
          return {
            id: String(s.id), name: s.name, pageUrl: null, category: "service",
            current: s.ok === true ? "operational" : s.ok === false ? "major_outage" : "unknown",
            latencyMs: s.ms ?? null, lastChecked: beats.length ? beats[beats.length - 1].ts : null,
            uptime24h: s.uptime24, uptime7d: pct(within(7 * 86400000)), uptime90d: pct(beats),
            history: dailyRollups(beats),
          };
        });
        // Merge built-in services that Kuma doesn't track (Grand Century, etc.)
        const kumaNames = new Set(k.map(x => x.name.toLowerCase().trim()));
        for (const s of STATUS_SERVICES) {
          if (kumaNames.has(s.name.toLowerCase().trim())) continue;
          if (!statusHistory[s.id]) continue;
          const checks = statusHistory[s.id] || [];
          const last = checks.length ? checks[checks.length - 1] : null;
          const day24 = checks.filter(c => new Date(c.ts).getTime() > now - 86400000);
          const day7  = checks.filter(c => new Date(c.ts).getTime() > now - 7 * 86400000);
          const day90 = checks.filter(c => new Date(c.ts).getTime() > now - 90 * 86400000);
          result.push({
            id: s.id, name: s.name, pageUrl: s.pageUrl, category: s.category,
            current: last ? (last.up ? "operational" : "major_outage") : "unknown",
            latencyMs: last?.latencyMs ?? null,
            lastChecked: last?.ts ?? null,
            uptime24h: day24.length ? Math.round(day24.filter(c => c.up).length / day24.length * 10000) / 100 : null,
            uptime7d:  day7.length  ? Math.round(day7.filter(c => c.up).length  / day7.length  * 10000) / 100 : null,
            uptime90d: day90.length ? Math.round(day90.filter(c => c.up).length / day90.length * 10000) / 100 : null,
            history: dailyRollups(checks),
          });
        }
      }
    } catch { /* Kuma down → built-in fallback */ }
    if (!result) result = STATUS_SERVICES.map(s => {
      const checks = statusHistory[s.id] || [];
      const last = checks.length ? checks[checks.length - 1] : null;
      // Uptime percentage over last 24h, 7d, and 90d
      const now = Date.now();
      const day24 = checks.filter(c => new Date(c.ts).getTime() > now - 86400000);
      const day7  = checks.filter(c => new Date(c.ts).getTime() > now - 7 * 86400000);
      const day90 = checks.filter(c => new Date(c.ts).getTime() > now - 90 * 86400000);
      const up24 = day24.filter(c => c.up).length;
      const up7  = day7.filter(c => c.up).length;
      const up90 = day90.filter(c => c.up).length;
      return {
        id: s.id,
        name: s.name,
        pageUrl: s.pageUrl,
        category: s.category,
        current: last ? (last.up ? "operational" : "major_outage") : "unknown",
        latencyMs: last?.latencyMs ?? null,
        lastChecked: last?.ts ?? null,
        uptime24h: day24.length ? Math.round(up24 / day24.length * 10000) / 100 : null,
        uptime7d:  day7.length  ? Math.round(up7  / day7.length  * 10000) / 100 : null,
        uptime90d: day90.length ? Math.round(up90 / day90.length * 10000) / 100 : null,
        history: dailyRollups(checks), // one entry per day (≤90), not raw samples
      };
    });
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ updated: new Date().toISOString(), services: result }));
    return;
  }

  // Prometheus scrape endpoint. Caddy blocks this path at the public edge.
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/metrics") {
    try {
      const output = await renderPrometheusMetrics(await getDb());
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : output);
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? "" : `metrics unavailable: ${error.message}\n`);
    }
    return;
  }

  // Authenticated intake for publishers outside this host. Redis remains
  // loopback-only; this narrow adapter is the network seam.
  if (req.method === "POST" && pathname === "/api/platform-events") {
    const expected = platformEventToken();
    const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const authorized = expected && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!authorized) return json(res, 401, { error: "Unauthorized" });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) return json(res, 413, { error: "Event payload too large" });
        chunks.push(chunk);
      }
      const event = await publishEvent(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      return json(res, 202, { ok: true, streamId: event.streamId, duplicate: event.duplicate });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  // GET /api/health — Public liveness check (no auth required)
  if (req.method === "GET" && pathname === "/api/health") {
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ status: "ok", checks: { app: "ok", dashboardSnapshot: dashboardSnapshot.peek() ? "ok" : "warming" }, timestamp: new Date().toISOString() }));
    return;
  }

  // GET /api/auth/check — lightweight game-SSO gate for Caddy forward_auth.
  // 2xx = staff (admin/mod) → allow; 401 → deny. Echoes identity headers the
  // upstream app can trust (X-Auth-User / X-Auth-Role) for proxy-based SSO.
  if (req.method === "GET" && pathname === "/api/auth/check") {
    const session = await resolveSession(req);
    addSecurityHeaders(res);
    if (session && (session.role === "admin" || session.role === "moderator")) {
      res.writeHead(200, {
        "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Auth-User": session.email || "", "X-Auth-Role": session.role,
      });
      res.end(JSON.stringify({ ok: true, email: session.email, role: session.role }));
    } else {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  // Admin-only gate for sensitive tools such as session replay. This is kept
  // separate from the staff gate above so moderators cannot inherit access as
  // more applications adopt proxy-based authentication.
  if (req.method === "GET" && pathname === "/api/auth/admin-check") {
    const session = await resolveSession(req);
    if (req.opsAuthUnavailable) return json(res, 503, { error: "Sign-in verification is temporarily unavailable" });
    addSecurityHeaders(res);
    if (session?.role === "admin") {
      res.writeHead(200, {
        "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Auth-User": session.email || "", "X-Auth-Role": session.role,
      });
      res.end(JSON.stringify({ ok: true, email: session.email, role: session.role }));
    } else {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  // POST /internal/player-context — resolve an AHD userId to the identity facts
  // ask.lakesidegames.net needs: entitlement tier, staff role, and who the player
  // actually is in-game. Deliberately lives HERE rather than in ask-site so the
  // public-facing service never holds a Mongo connection. Loopback + shared
  // secret only; there is no browser path to this route.
  if (req.method === "POST" && pathname === "/internal/player-context") {
    const remote = req.socket.remoteAddress || "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLoopback) return json(res, 403, { error: "Forbidden" });
    if (!ASK_API_SECRET || req.headers["x-ask-secret"] !== ASK_API_SECRET) {
      return json(res, 403, { error: "Forbidden" });
    }
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 4096) raw = raw.slice(0, 4096); });
    await new Promise(r => req.on("end", r));
    let p; try { p = JSON.parse(raw || "{}"); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const userId = String(p.userId || "").trim();
    // A Discord question carries no AHD userId, so the same person asking from
    // Discord used to resolve to nobody and be treated as an ordinary player —
    // including the staff whose role is recorded right here on the account.
    // Accept the linked Discord id as an alternative key so the role travels
    // with the person rather than with the surface they asked from.
    const discordId = String(p.discordId || "").trim();
    if (!userId && !discordId) return json(res, 400, { error: "userId or discordId required" });

    try {
      const { ObjectId } = require("mongodb");
      const db = await getDb();
      const projection = {
        username: 1, displayName: 1, role: 1, isAdmin: 1, isBanned: 1,
        patreonTier: 1, patreonExpiresAt: 1, activeCharacterId: 1,
      };
      let user;
      if (userId) {
        let _id; try { _id = new ObjectId(userId); } catch { return json(res, 404, { error: "Unknown user" }); }
        user = await db.collection("users").findOne({ _id }, { projection });
      } else {
        user = await db.collection("users").findOne({ discordId }, { projection });
      }
      if (!user) return json(res, 404, { error: "Unknown user" });

      // Grace window is authoritative: a lapsed pledge keeps benefits until it expires.
      const tier = user.patreonTier || null;
      const exp = user.patreonExpiresAt ? new Date(user.patreonExpiresAt).getTime() : null;
      const tierActive = Boolean(tier) && (exp === null || exp > Date.now());

      let character = null, corporation = null;
      if (user.activeCharacterId) {
        const c = await db.collection("characters").findOne(
          { _id: user.activeCharacterId },
          { projection: { name: 1, sequentialId: 1, countryId: 1, partyId: 1 } }
        );
        if (c) {
          let partyName = null;
          if (c.partyId) {
            const party = await db.collection("parties").findOne(
              { $or: [{ _id: String(c.partyId) }, { sequentialId: c.partyId }] },
              { projection: { name: 1 } }
            ).catch(() => null);
            partyName = party?.name || null;
          }
          character = {
            name: c.name || null, sequentialId: c.sequentialId ?? null,
            country: c.countryId || null, party: partyName,
          };
          // Ownership link is `ceoId` + `ceoType`, and the ticker field is
          // `tickerSymbol`. Getting either wrong silently yields "no corporation",
          // which reads to the player as the assistant not knowing who they are.
          const proj = { projection: { name: 1, tickerSymbol: 1, sequentialId: 1 } };
          let corp = await db.collection("corporations").findOne(
            { ceoId: c._id, ceoType: "character" }, proj).catch(() => null);
          let role = "ceo";
          if (!corp) {
            // Not a CEO — fall back to the largest position they hold, so an
            // ordinary shareholder still gets relevant context.
            corp = await db.collection("corporations").findOne(
              { "shareholders.characterId": c._id }, proj).catch(() => null);
            role = corp ? "shareholder" : null;
          }
          if (corp) {
            corporation = {
              name: corp.name || null,
              ticker: corp.tickerSymbol || null,
              sequentialId: corp.sequentialId ?? null,
              role,
            };
          }
        }
      }

      return json(res, 200, {
        userId: String(user._id),
        username: user.username || user.displayName || null,
        role: user.role || "player",
        isAdmin: user.isAdmin === true || user.role === "admin",
        isModerator: user.role === "moderator",
        isBanned: user.isBanned === true,
        tier, tierActive,
        character, corporation,
      });
    } catch (e) {
      console.error("[player-context]", e?.message || e);
      return json(res, 500, { error: "Lookup failed" });
    }
  }

  // Exchange a freshly authenticated web login for a device session. Browser
  // sessions keep their one-day lifetime; device sessions retain role/ban and
  // revocation checks, are capped at 30 days and can be logged out normally.
  if (req.method === "POST" && pathname === "/api/auth/native-session") {
    const origin = req.headers.origin;
    if (!origin || !OPS_SSO_HOSTS.some((host) => origin === `https://${host}`) || !["ios", "desktop", "cli"].includes(req.headers["x-lakeside-client"])) return json(res, 403, { error: "Forbidden" });
    const session = await resolveSession(req);
    if (req.opsAuthUnavailable) return json(res, 503, { error: "Sign-in verification is temporarily unavailable" });
    if (!session || session.role !== "admin") return json(res, 401, { error: "Unauthorized" });
    // A device session cannot renew itself indefinitely.
    if (session.native) return json(res, 200, { token: sessionToken(req), expiresAt: session.created + NATIVE_TTL });
    const token = crypto.randomBytes(32).toString("hex");
    const created = Date.now();
    if (sessions.size >= MAX_SESSIONS) { const [oldest] = sessions.keys(); sessions.delete(oldest); }
    sessions.set(token, { ...session, created, native: true }); saveSessions();
    return json(res, 200, { token, expiresAt: created + NATIVE_TTL });
  }

  // GET /api/me — Current session info (role, email)
  if (req.method === "GET" && pathname === "/api/me") {
    const session = await resolveSession(req);
    if (req.opsAuthUnavailable) return json(res, 503, { error: "Sign-in verification is temporarily unavailable" });
    if (!session) return json(res, 401, { error: "Unauthorized" });
    return json(res, 200, { email: session.email, role: session.role });
  }

  // POST /api/code-context — engineering-oriented codebase retrieval. Returns the
  // most relevant source files + a code index for a query (reuses the Ask
  // retrieval). Used to GROUND triage assessments and code agents in real code.
  if (req.method === "POST" && pathname === "/api/code-context") {
    if (ASK_API_SECRET && req.headers["x-ask-secret"] !== ASK_API_SECRET) return json(res, 403, { error: "Forbidden" });
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 1e5) body = body.slice(0, 1e5); });
    await new Promise((r) => req.on("end", r));
    let payload; try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const query = String(payload.query || "").trim();
    if (!query) return json(res, 400, { error: "query required" });
    const n = Math.min(10, Math.max(3, payload.limit || 6));
    try {
      const tfidf = findRelevantFilesRanked(query, 14);
      const files = semanticReady ? (await semanticRerank(tfidf, query, () => {})).slice(0, n) : tfidf.slice(0, n);
      // Real code (not just an index) so a tool-less caller (the triage LLM) can ground on it.
      let context = buildFileIndex(files) + "\n";
      for (const f of files) {
        try {
          const rel = String(f.relPath || f.path || "").replace(/^\/+/, "");
          const src = fs.readFileSync(f.path, "utf8");
          let snippet;
          if (f.bestChunk && f.bestChunk.startLine > 1) {
            const lines = src.split("\n");
            snippet = lines.slice(Math.max(0, f.bestChunk.startLine - 6), Math.min(lines.length, f.bestChunk.endLine + 8)).join("\n");
          } else snippet = src.slice(0, 2600);
          context += `\n--- ${rel} ---\n${snippet.slice(0, 3200)}\n`;
        } catch { /* skip unreadable */ }
        if (context.length > 24000) break;
      }
      const paths = files.map((f) => (typeof f === "string" ? f : (f.relPath || f.path || "")));
      return json(res, 200, { files: paths, context: context.slice(0, 26000) });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // POST /api/ask-public — Public codebase Q&A (bot/external callers, no auth)
  // JSON remains the compatibility default. SSE callers also receive progress
  // when the model decides it needs the read-only live-data fleet.
  if (req.method === "POST" && pathname === "/api/ask-public") {
    // Secret token gate: reject unverified traffic (bots, crawlers, randos)
    const providedSecret = req.headers["x-ask-secret"];
    if (!isPublicAskAuthorized(ASK_API_SECRET, providedSecret)) {
      return json(res, 403, { error: "Forbidden — invalid or missing secret" });
    }

    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1e5) body = body.slice(0, 1e5); });
    await new Promise(r => req.on("end", r));

    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const question = String(payload.question || "").trim();
    if (!question || question.length < 3) return json(res, 400, { error: "Question must be at least 3 characters" });
    if (question.length > 2000) return json(res, 400, { error: "Question must be under 2000 characters" });
    if (!LLM_API_KEY) return json(res, 503, { error: "LLM API key not configured" });

    const preferences = normalizeAskPreferences(payload);
    const askPolicy = publicAskPolicy(payload);
    const wantsStream = String(req.headers.accept || "").includes("text/event-stream");
    let streamOpen = false;
    const askEvent = (event, data) => {
      if (!streamOpen || res.writableEnded) return;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };
    if (wantsStream) {
      addSecurityHeaders(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      streamOpen = true;
      askEvent("status", { stage: "thinking" });
    }

    const retrievalQuery = normalizeAskRetrievalQuery(question);
    const tfidfCandidates = findRelevantFilesRanked(retrievalQuery, 12);
    const allRelevantFiles = (semanticReady)
      ? (await semanticRerank(tfidfCandidates, retrievalQuery, () => {})).slice(0, 6)
      : tfidfCandidates;
    const indexContext = buildFileIndex(allRelevantFiles);
    const sourceContext = buildSourceContext(allRelevantFiles) || indexContext;

    const identityContext = buildAskIdentityContext(payload);

    const { tools: askMcpTools, index: askMcpIndex, skipped: askMcpSkipped } = await discoverPublicAskTools();
    if (askMcpSkipped.length) console.warn("[ask-public] MCP unavailable:", askMcpSkipped.join("; "));
    const liveToolPrompt = liveSourcePolicy(askMcpTools.length > 0);

    const systemPrompt = `You are a helpful guide for the A House Divided (AHD) game — a political strategy MMO. You answer questions about how the game works, what features exist, and why things happen the way they do.

CRITICAL RULES:
- Explain everything in plain English. Assume the reader is a player, not a programmer.
- Avoid technical jargon where possible (no "API", "endpoint", "middleware", "schema", "hook", "reducer", etc.).
- NEVER suggest code changes, write code, or provide terminal commands.
- NEVER output tool calls, XML tags, or function invocations like \`<function_calls>\` or \`<invoke>\`.
- NEVER start with meta-commentary like "I'll examine...", "Let me check...", "I need to look...", or "I will search...". Jump straight into the answer.
- Be concise but specific. Ground your answer in the source material provided below.
- When a game mechanic, value, or behavior is derived from a specific file, cite that file by path in parentheses, e.g. (src/server/economy/inflation.ts). Keep citations minimal and relevant.
- If you don't know something, say so plainly — don't guess.
- Use analogies or examples from the game world when they help clarify.
- ${preferences.instruction}
${askPolicy}${identityContext}${liveToolPrompt}

Below is the actual source code of the most relevant parts of the game. Answer from it directly and cite the files you draw from.

${sourceContext}`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ];

    try {
      const reqHeaders = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + LLM_API_KEY,
      };
      if (LLM_PROVIDER === "kimi") reqHeaders["User-Agent"] = "claude-code/1.0";
      if (LLM_PROVIDER === "opencode-go") reqHeaders["User-Agent"] = "opencode";

      const callModel = async (conversation, tools, forceNoReasoning) => {
        const effort = forceNoReasoning ? "none" : preferences.effort;
        const maxTokens = preferences.answerTokens + (forceNoReasoning ? 0 : preferences.reasoningTokens);
        const llmRes = await fetch(LLM_API_URL, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify({
            model: LLM_MODEL,
            messages: conversation,
            ...(tools?.length ? { tools } : {}),
            temperature: 1,
            max_tokens: maxTokens,
            ...(LLM_PROVIDER === "deepseek" ? { reasoning_effort: effort } : {}),
          }),
          signal: AbortSignal.timeout(75000),
        });
        if (!llmRes.ok) {
          const errText = await llmRes.text().catch(() => "");
          console.error("[ask-public] LLM API error:", llmRes.status, errText.slice(0, 500));
          throw new Error("LLM API returned status " + llmRes.status);
        }
        const llmData = await llmRes.json();
        const choice = llmData.choices?.[0] || {};
        return { message: choice.message || {}, usage: llmData.usage || {} };
      };

      let lookupStatusSent = false;
      const result = await runPublicAskConversation({
        messages,
        tools: askMcpTools,
        preferences,
        callModel,
        callTool: (name, args) => callPublicAskTool(askMcpIndex, name, args),
        onLookup: async (toolCalls) => {
          if (lookupStatusSent) return;
          const usesLiveState = toolCalls.some(toolCall =>
            askMcpIndex.get(toolCall.function?.name)?.meta?.kind === "state"
          );
          if (!usesLiveState) return;
          lookupStatusSent = true;
          askEvent("status", { stage: "live_data" });
        },
      });

      const response = {
        answer: protectPublicAnswer(result.answer, question),
        files: allRelevantFiles.map(f => (f.relPath || f.path).replace(/^\/+/, "")),
        sources: result.sources.map(({ kind, label }) => ({ kind, label })),
        liveDataUsed: result.sources.some(source => source.kind === "state"),
        model: LLM_MODEL,
        usage: { input: result.usage.prompt_tokens || 0, output: result.usage.completion_tokens || 0 },
      };
      if (streamOpen) {
        askEvent("result", response);
        res.end();
        return;
      }
      return json(res, 200, response);
    } catch (e) {
      console.error("[ask-public] Request failed:", e);
      const error = e?.name === "AbortError" ? "LLM API timed out" : (e?.message || "Failed to reach LLM API");
      if (streamOpen) {
        askEvent("error", { error });
        res.end();
        return;
      }
      return json(res, 500, { error });
    }
  }

  // Auth check for all API routes
  const session = await resolveSession(req);
  if (!session) {
    return json(res, 401, { error: "Unauthorized" });
  }

  // Role-based access: moderators can only access the Q&A portal endpoints
  const isModerator = session.role === "moderator";
  const moderatorAllowed = pathname === "/api/ask" || pathname === "/api/ask/feedback" ||
                           pathname === "/api/ask/log" || pathname === "/api/ask/file" ||
                           pathname === "/api/ask/capabilities" ||
                           pathname === "/api/sandbox/branches" ||
                           pathname === "/api/logout" || pathname === "/api/me";
  if (isModerator && !moderatorAllowed) {
    return json(res, 403, { error: "Moderators can only access the Q&A portal" });
  }

  // GET /api/ask/capabilities — how many MCP tools Ask can actually reach right
  // now, broken down by server. The count is a live reading, not a constant:
  // a server that is down drops out of it, which is the point — "40 tools
  // available" should stop saying 40 the moment the fleet is degraded.
  if (req.method === "GET" && pathname === "/api/ask/capabilities") {
    try {
      const now = Date.now();
      if (!askCapabilityCache || now - askCapabilityCache.at > ASK_CAPABILITY_TTL_MS) {
        const { tools, index, skipped } = await discoverAskTools();
        const perServer = new Map();
        for (const entry of index.values()) {
          perServer.set(entry.serverKey, (perServer.get(entry.serverKey) || 0) + 1);
        }
        askCapabilityCache = {
          at: now,
          payload: {
            count: tools.length,
            servers: [...perServer.entries()].map(([key, count]) => ({ key, count })),
            degraded: skipped.filter((entry) => !entry.startsWith("tool cap")),
          },
        };
      }
      return json(res, 200, askCapabilityCache.payload);
    } catch (e) {
      return json(res, 200, { count: 0, servers: [], degraded: [e.message] });
    }
  }

  // GET /api/ask/log?id=<id> — fetch a stored Q&A exchange for permalinks/sharing
  if (req.method === "GET" && pathname === "/api/ask/log") {
    const id = url.searchParams.get("id");
    if (!id) return json(res, 400, { error: "id required" });
    try {
      const db = await getDb();
      const doc = await db.collection("ops_qa_log").findOne({ _id: id });
      if (!doc) return json(res, 404, { error: "Not found" });
      return json(res, 200, {
        id: doc._id, question: doc.question, answer: doc.answer,
        mode: doc.mode, quality: doc.quality, model: doc.model,
        files: doc.files || [], usage: doc.usage || {}, createdAt: doc.createdAt,
      });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // POST /api/ask/feedback — record thumbs up/down on a logged answer
  if (req.method === "POST" && pathname === "/api/ask/feedback") {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1e5) { body = ""; } });
    req.on("end", async () => {
      try {
        const { id, rating } = JSON.parse(body || "{}");
        if (!id || (rating !== "up" && rating !== "down" && rating !== null)) {
          return json(res, 400, { error: "id and rating ('up'|'down'|null) required" });
        }
        const db = await getDb();
        await db.collection("ops_qa_log").updateOne(
          { _id: id },
          { $set: { feedback: rating, feedbackAt: new Date(), feedbackBy: session.email } }
        );
        return json(res, 200, { ok: true });
      } catch (e) {
        // Don't surface internal errors; feedback is non-critical
        return json(res, 200, { ok: false });
      }
    });
    return;
  }

  // ─── API: BACKUPS ─────────────────────────────────────────────

  // GET /api/backups
  if (req.method === "GET" && pathname === "/api/backups") {
    try {
      const entries = fs.readdirSync(BACKUP_DIR)
        .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d))
        .sort().reverse()
        .map(date => {
          const dbDir = path.join(BACKUP_DIR, date, "a-house-divided");
          const searchDir = fs.existsSync(dbDir) ? dbDir : path.join(BACKUP_DIR, date);
          const bsonFiles = fs.readdirSync(searchDir).filter(f => f.endsWith(".bson"));
          const totalBytes = bsonFiles.reduce((sum, f) => {
            try { return sum + fs.statSync(path.join(searchDir, f)).size; } catch { return sum; }
          }, 0);
          return { date, collections: bsonFiles.length, totalBytes };
        });
      return json(res, 200, { backups: entries, total: entries.length });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // GET /api/backups/:id
  const backupMatch = pathname.match(/^\/api\/backups\/(\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2})?)$/);
  if (req.method === "GET" && backupMatch) {
    const date = backupMatch[1];
    const dbDir = path.join(BACKUP_DIR, date, "a-house-divided");
    const searchDir = fs.existsSync(dbDir) ? dbDir : path.join(BACKUP_DIR, date);
    if (!fs.existsSync(searchDir)) {
      return json(res, 404, { error: `No backup for ${date}` });
    }
    try {
      const entries = fs.readdirSync(searchDir)
        .filter(f => f.endsWith(".bson"))
        .map(f => {
          const name = f.replace(".bson", "");
          const bsonSize = fs.statSync(path.join(searchDir, f)).size;
          const metaPath = path.join(searchDir, `${name}.metadata.json`);
          const metaSize = fs.existsSync(metaPath) ? fs.statSync(metaPath).size : 0;
          return { collection: name, bsonBytes: bsonSize, metadataBytes: metaSize };
        })
        .sort((a, b) => b.bsonBytes - a.bsonBytes);
      return json(res, 200, { date, collections: entries, total: entries.length });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // GET /api/backups/:id/:collection/:file
  const fileMatch = pathname.match(/^\/api\/backups\/(\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2})?)\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9_.]+)$/);
  if (req.method === "GET" && fileMatch) {
    const date = fileMatch[1];
    const collection = fileMatch[2];
    const file = fileMatch[3];
    if (!file.endsWith(".bson") && !file.endsWith(".json")) {
      return json(res, 400, { error: "Only .bson and .json files" });
    }
    if (file.includes("..") || file.includes("/")) {
      return json(res, 400, { error: "Invalid filename" });
    }
    const dbDir = path.join(BACKUP_DIR, date, "a-house-divided");
    const searchDir = fs.existsSync(dbDir) ? dbDir : path.join(BACKUP_DIR, date);
    const filePath = path.resolve(path.join(searchDir, file));
    if (!filePath.startsWith(path.resolve(searchDir))) {
      return json(res, 400, { error: "Path traversal denied" });
    }
    if (!fs.existsSync(filePath)) {
      return json(res, 404, { error: `File not found: ${file}` });
    }
    const stat = fs.statSync(filePath);
    const contentType = file.endsWith(".bson") ? "application/octet-stream" : "application/json";
    addSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${file}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ─── API: DATABASE ────────────────────────────────────────────

  // GET /api/db/stats
  if (req.method === "GET" && pathname === "/api/db/stats") {
    try {
      const db = await getDb();
      const collections = await db.listCollections().toArray();
      const stats = await db.stats();
      return json(res, 200, {
        collections: collections.length,
        totalDocuments: stats.objects,
        dataSize: stats.dataSize,
        indexSize: stats.indexSize,
      });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // GET /api/db/collections
  if (req.method === "GET" && pathname === "/api/db/collections") {
    try {
      const db = await getDb();
      const collections = await db.listCollections().toArray();
      const results = [];
      for (const coll of collections) {
        const col = db.collection(coll.name);
        const count = await col.estimatedDocumentCount();
        const stats = await db.command({ collStats: coll.name }).catch(() => ({ size: 0 }));
        results.push({ name: coll.name, count, size: stats.size || 0 });
      }
      results.sort((a, b) => b.count - a.count);
      return json(res, 200, { collections: results });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // GET /api/db/collections/:name
  const collMatch = pathname.match(/^\/api\/db\/collections\/(.+)$/);
  if (req.method === "GET" && collMatch) {
    const collName = decodeURIComponent(collMatch[1]);
    if (collName.startsWith("system.")) {
      return json(res, 403, { error: "System collections are not accessible" });
    }
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);
    const filterText = url.searchParams.get("filter") || "";
    const sortParam = url.searchParams.get("sort") || "_id";

    try {
      const db = await getDb();
      const col = db.collection(collName);

      // Build query
      let query = {};
      if (filterText) {
        // Escape regex metacharacters to prevent ReDoS / injection
        const safeFilter = filterText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Try to match _id or any string field
        if (/^[0-9a-f]{24}$/i.test(filterText)) {
          query = { _id: { $in: [filterText, require("mongodb").ObjectId.createFromHexString(filterText)] } };
        } else {
          query = { $or: [
            { name: { $regex: safeFilter, $options: "i" } },
            { slug: { $regex: safeFilter, $options: "i" } },
            { title: { $regex: safeFilter, $options: "i" } },
            { email: { $regex: safeFilter, $options: "i" } },
            { username: { $regex: safeFilter, $options: "i" } },
          ]};
        }
      }

      // Build sort
      let sort = {};
      if (sortParam.startsWith("-")) sort[sortParam.slice(1)] = -1;
      else sort[sortParam] = 1;

      const total = await col.countDocuments(query);
      const skip = (page - 1) * limit;
      const docs = await col.find(query).sort(sort).skip(skip).limit(limit).toArray();

      // Redact sensitive fields
      const safeDocs = docs.map(redactSensitive);

      return json(res, 200, {
        collection: collName,
        documents: safeDocs,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // ─── API: DEMOGRAPHICS ──────────────────────────────────────────

  // GET /api/demographics?country=DE&preset=1991-default
  if (req.method === "GET" && pathname === "/api/demographics") {
    const url = new URL(req.url, "http://localhost");
    const country = url.searchParams.get("country") || "US";
    const preset = url.searchParams.get("preset") || "2019-default";
    const format = url.searchParams.get("format") || "json";
    try {
      const ahdRepo = primaryRepoDir();
      const { execSync } = require("child_process");
      const nodeBin = path.join(hermesHomeDir(), "node", "bin", "node");
      const tsxBin = path.join(ahdRepo, "node_modules", ".bin", "tsx");
      const loader = path.join(ahdRepo, "scripts", "demographics-loader.ts");
      const cmd = `${nodeBin} ${tsxBin} ${loader} ${country} ${preset} 2>/dev/null`;
      const stdout = execSync(cmd, { timeout: 15000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" });
      // dotenvx may print to stdout; extract only the JSON array (starts with \n[)
      const jsonStart = stdout.indexOf("\n[");
      const cleanJson = jsonStart >= 0 ? stdout.slice(jsonStart + 1) : (stdout.startsWith("{") ? stdout : "");
      if (format === "csv") {
        const data = JSON.parse(cleanJson);
        // Build CSV from demographics
        const demos = data.demographics || data.states || [];
        const lines = ["Country,State,Group,Population%,EconomicLean,SocialLean,Turnout%"];
        for (const state of demos) {
          for (const [groupId, group] of Object.entries(state.groups || {})) {
            lines.push(`${country},${state._id},${groupId},${group.population},${group.economicLean},${group.socialLean},${group.turnout}`);
          }
        }
        res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${country}_${preset}_demographics.csv"` });
        res.end(lines.join("\n"));
      } else {
        const data = JSON.parse(cleanJson);
        return json(res, 200, data);
      }
    } catch (e) {
      console.error("[demographics] error:", e);
      return json(res, 500, { error: "Failed to load demographics" });
    }
    return;
  }

  // ─── API: GAME ────────────────────────────────────────────────

  // GET /api/game/summary
  if (req.method === "GET" && pathname === "/api/game/summary") {
    try {
      const db = await getDb();
      const [gameState, characters, corps] = await Promise.all([
        db.collection("gameState").findOne(),
        db.collection("characters").countDocuments({ retired: { $ne: true } }),
        db.collection("corporations").find({ listed: true }).toArray(),
      ]);

      const publicCorps = corps.filter(c => c.listed).length;
      const activePlayers = await db.collection("characters").countDocuments({ retired: { $ne: true }, userId: { $exists: true } });

      return json(res, 200, {
        turn: gameState?.turn || 0,
        year: gameState?.year || 0,
        players: characters,
        activePlayers,
        corporations: corps.length,
        publicCorporations: publicCorps,
      });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // GET /api/game/countries
  if (req.method === "GET" && pathname === "/api/game/countries") {
    try {
      const db = await getDb();
      const countries = await db.collection("countryState").find().toArray();
      const countryData = countries.map(c => ({
        code: c.code || c._id?.toString().slice(0,3) || '??',
        name: c.name || c.code || 'Unknown',
        flag: c.flag || "🏳️",
        inflation: c.inflation?.toFixed(2) || "0.00",
        gdpGrowth: c.gdpGrowth?.toFixed(2) || "0.00",
        primeRate: c.primeRate?.toFixed(2) || "0.00",
        debtGdp: c.debtGdp?.toFixed(1) || "0.0",
        exchangeRate: c.exchangeRate?.toFixed(3) || "0.000",
        corporations: c.corporations || 0,
        players: c.players || 0,
      }));
      return json(res, 200, { countries: countryData });
    } catch (e) {
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // ─── API: REPORTS ─────────────────────────────────────────────

  // GET /api/reports/election-post-mortem — Completed presidential election analysis
  if (req.method === "GET" && pathname === "/api/reports/election-post-mortem") {
    try {
      const db = await getDb();
      const electionId = url.searchParams.get("electionId");

      // If no electionId, list available completed/resolved presidential elections
      if (!electionId) {
        const elections = await db.collection("elections")
          .find({ electionType: "president", status: { $in: ["completed", "resolved"] } })
          .sort({ endTime: -1 })
          .limit(20)
          .project({
            _id: 1, countryId: 1, electionYear: 1, state: 1,
            status: 1, endTime: 1, startTurn: 1, endTurn: 1, cycle: 1
          })
          .toArray();
        return json(res, 200, {
          elections: elections.map(e => ({
            id: e._id.toString(),
            countryId: e.countryId,
            electionYear: e.electionYear,
            state: e.state,
            status: e.status,
            endTime: e.endTime,
            startTurn: e.startTurn,
            endTurn: e.endTurn,
            cycle: e.cycle,
          }))
        });
      }

      // Fetch specific election with full post-mortem data
      const { ObjectId } = require("mongodb");
      let eid;
      try { eid = new ObjectId(electionId); } catch { return json(res, 400, { error: "Invalid electionId" }); }

      const election = await db.collection("elections").findOne({ _id: eid, electionType: "president" });
      if (!election) return json(res, 404, { error: "Election not found" });

      // Get candidates
      const candidates = await db.collection("electionCandidates")
        .find({ electionId: eid })
        .toArray();

      // Get vote tally
      const voteTally = await db.collection("electionVoteTallies")
        .findOne({ electionId: eid });

      // Get campaigns for spending data
      const campaigns = await db.collection("campaigns")
        .find({ electionId: eid })
        .toArray();

      // Get primary results if they exist
      const primaryResults = voteTally?.primaryResults || null;

      // Build candidate performance map
      const candidatePerformance = candidates.map(c => {
        const cid = c._id.toString();
        const campaign = campaigns.find(ca => ca.candidateId.toString() === cid);
        return {
          id: cid,
          name: c.characterName,
          party: c.party,
          status: c.status,
          isIncumbent: c.isIncumbent || false,
          isNpc: c.isNpc || false,
          totalVotes: voteTally?.totalVotes?.[cid] || 0,
          primaryVotes: primaryResults?.voteTotals?.[cid] || 0,
          primaryDelegates: primaryResults?.delegates?.[cid] || 0,
          spending: campaign?.totalSpent || 0,
          groundGame: campaign?.groundGameLevel || 0,
          campaignStrength: campaign?.campaignStrength || 0,
          homeState: c.homeState || null,
          runningMateHomeState: c.runningMateId ? null : null, // resolved below
        };
      });

      // Resolve running mate home states
      const runningMateIds = candidates.filter(c => c.runningMateId).map(c => c.runningMateId);
      if (runningMateIds.length > 0) {
        const rmChars = await db.collection("characters")
          .find({ _id: { $in: runningMateIds } }, { projection: { _id: 1, homeState: 1 } })
          .toArray();
        const rmMap = new Map(rmChars.map(r => [r._id.toString(), r.homeState]));
        for (const cp of candidatePerformance) {
          const c = candidates.find(ca => ca._id.toString() === cp.id);
          if (c?.runningMateId) {
            cp.runningMateHomeState = rmMap.get(c.runningMateId.toString()) || null;
          }
        }
      }

      // State-by-state breakdown from unit votes
      const stateBreakdown = [];
      if (voteTally?.totalVotesByUnit) {
        for (const [unitId, unitVotes] of Object.entries(voteTally.totalVotesByUnit)) {
          const unitTotal = Object.values(unitVotes).reduce((a, b) => a + b, 0);
          const unitResults = Object.entries(unitVotes)
            .map(([cid, votes]) => ({
              candidateId: cid,
              votes: votes,
              pct: unitTotal > 0 ? (votes / unitTotal * 100).toFixed(2) : "0.00",
            }))
            .sort((a, b) => b.votes - a.votes);
          stateBreakdown.push({
            unitId,
            totalVotes: unitTotal,
            winner: unitResults[0] || null,
            results: unitResults,
          });
        }
      }

      // Turn snapshots for trend analysis
      const turnSnapshots = voteTally?.turnSnapshots || [];

      // Get endorsements
      const endorsements = await db.collection("governorEndorsements")
        .find({ electionId: eid, isActive: true })
        .toArray();

      // Get debates
      const debates = await db.collection("debates")
        .find({ electionId: eid })
        .toArray();

      return json(res, 200, {
        election: {
          id: election._id.toString(),
          countryId: election.countryId,
          electionYear: election.electionYear,
          state: election.state,
          status: election.status,
          startTurn: election.startTurn,
          endTurn: election.endTurn,
          cycle: election.cycle,
          endTime: election.endTime,
          startTime: election.startTime,
        },
        candidates: candidatePerformance,
        stateBreakdown,
        turnSnapshots: turnSnapshots.map((ts) => ({
          turn: ts.turn,
          timestamp: ts.timestamp,
          votes: ts.votes,
        })),
        endorsements: endorsements.map(e => ({
          candidateId: e.candidateId.toString(),
          stateId: e.stateId,
          endorserId: e.endorserId?.toString(),
        })),
        debates: debates.map(d => ({
          id: d._id.toString(),
          status: d.status,
          startTime: d.startTime,
          endTime: d.endTime,
        })),
        totalTurns: turnSnapshots.length,
        popularVoteTotal: Object.values(voteTally?.totalVotes || {}).reduce((a, b) => a + b, 0),
      });
    } catch (e) {
      console.error("[election-post-mortem] error:", e);
      return json(res, 500, { error: "Internal server error" });
    }
  }

  // ─── API: HEALTH ──────────────────────────────────────────────

  // GET /api/health
  if (req.method === "GET" && pathname === "/api/health") {
    try {
      const start = Date.now();
      const db = await getDb();
      await db.admin().ping();
      const dbLatency = Date.now() - start;
      const collections = await db.listCollections().toArray();

      // Backup stats
      let backupCount = 0;
      let latestBackup = null;
      let diskUsage = 0;
      try {
        const dirs = fs.readdirSync(BACKUP_DIR).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort().reverse();
        backupCount = dirs.length;
        latestBackup = dirs[0] || null;
        for (const d of dirs) {
          const dbDir = path.join(BACKUP_DIR, d, "a-house-divided");
          const searchDir = fs.existsSync(dbDir) ? dbDir : path.join(BACKUP_DIR, d);
          if (fs.existsSync(searchDir)) {
            const files = fs.readdirSync(searchDir).filter(f => f.endsWith(".bson"));
            for (const f of files) {
              try { diskUsage += fs.statSync(path.join(searchDir, f)).size; } catch {}
            }
          }
        }
      } catch {}

      // Server stats
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      const load = require("os").loadavg()[0];

      return json(res, 200, {
        db: { status: "ok", latency: dbLatency, collections: collections.length },
        backups: { count: backupCount, latest: latestBackup, diskUsage },
        server: {
          uptime: Math.floor(uptime / 3600) + "h " + Math.floor((uptime % 3600) / 60) + "m",
          memory: { used: mem.heapUsed, total: mem.heapTotal },
          load,
        },
      });
    } catch (e) {
      return json(res, 200, {
        db: { status: "error", error: "Internal server error" },
        backups: { count: 0, latest: null, diskUsage: 0 },
        server: { uptime: "—", memory: { used: 0, total: 0 }, load: 0 },
      });
    }
  }

  // ─── API: CODEBASE Q&A ────────────────────────────────────────────

  // GET /api/ask — SSE streaming: proxy questions to Kimi LLM with sandboxed codebase context
  if (req.method === "GET" && pathname === "/api/ask") {
    // Parse question from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const question = (url.searchParams.get("question") || "").trim();
    const mode = url.searchParams.get("mode") || "technical"; // "technical" or "simple"
    // "fast" | "standard" | "reasoning", or "auto" to size it from the question.
    // Ask's depth control previously defaulted every question to the middle
    // setting, so a one-line lookup bought the same budget as a cross-subsystem
    // investigation — the cheap one overpaying and the hard one under-served.
    const requestedQuality = url.searchParams.get("quality") || "standard";
    const askTier = requestedQuality === "auto" ? scoreComplexity(url.searchParams.get("question") || "") : null;
    const quality = askTier
      ? ({ light: "fast", standard: "standard", deep: "reasoning" })[askTier.tier]
      : requestedQuality;
    if (askTier) console.log(`[router] ask: ${askTier.tier} → ${quality} (${askTier.reasons.join(", ")})`);
    const diffBranch = (url.searchParams.get("branch") || "").replace(/[^a-zA-Z0-9/_.-]/g, "").slice(0, 100);
    const diffBase = (url.searchParams.get("base") || "main").replace(/[^a-zA-Z0-9/_.-]/g, "").slice(0, 80);
    if (!question || question.length < 3) {
      return json(res, 400, { error: "Question must be at least 3 characters" });
    }
    if (question.length > 2000) {
      return json(res, 400, { error: "Question must be under 2000 characters" });
    }

    if (!LLM_API_KEY) {
      return json(res, 503, { error: "LLM API key not configured on the server" });
    }

    // Follow-up context: the client sends the last few Q&A pairs so the model can
    // resolve references like "what about the ban path?" without re-explaining.
    let history = [];
    try {
      const raw = url.searchParams.get("history");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          history = parsed.slice(-3).map(p => ({
            q: String(p.q || "").slice(0, 2000),
            a: String(p.a || "").slice(0, 1500),
          })).filter(p => p.q && p.a);
        }
      }
    } catch {}

    // Pinned files: paths the user wants always present in context (useful when
    // debugging one system across several questions). Their full contents are
    // injected up-front so the model never has to spend a read on them.
    let pins = [];
    try {
      const raw = url.searchParams.get("pins");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) pins = parsed.slice(0, 5).map(p => String(p || "").replace(/^\/+/, "")).filter(Boolean);
      }
    } catch {}

    // ── SSE streaming response — open early so retrieval progress events land ──
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let clientConnected = true;
    req.on("close", () => { clientConnected = false; });
    req.on("error", () => { clientConnected = false; });

    function sse(event, data) {
      if (!clientConnected) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        clientConnected = false;
      }
    }

    // Stable id returned to the client immediately so feedback can be attached
    // even if the (best-effort) Mongo write lands later.
    const qaId = crypto.randomUUID();

    try {
    // Build initial context — a file index so the model knows what's available.
    // Retrieval: TF-IDF candidates → semantic rerank via nomic-embed-text (if available).
    // `sse` is now available so semantic rerank can stream progress events.
    const retrievalQuery = history.length ? history.map(p => p.q).join(" ") + " " + question : question;
    // Semantic rerank only in reasoning mode — bge-small at 83ms/embed × 30 files
    // = ~2.5s overhead. Fast/standard use TF-IDF directly (instant).
    const tfidfCandidates = findRelevantFilesRanked(retrievalQuery, quality === "reasoning" ? 30 : 20);
    const allRelevantFiles = (semanticReady && quality === "reasoning")
      ? (await semanticRerank(tfidfCandidates, question, sse)).slice(0, MAX_CONTEXT_FILES)
      : tfidfCandidates;
    const indexContext = buildFileIndex(allRelevantFiles);

    // Feature 3: look up semantically similar past Q&As for cross-session grounding.
    let priorQAContext = "";
    let usedMemory = false;
    if (semanticReady) {
      try {
        const qaDb = await getDb();
        const qEmbed = await embedText(question, true);
        const similar = await findSimilarQAs(qaDb, qEmbed, 3);
        if (similar.length) {
          usedMemory = true;
          priorQAContext = "\n\nRELATED PAST QUESTIONS (from memory — use as additional context, not authoritative answers):\n" +
            similar.map((m, i) =>
              `${i + 1}. Q: ${m.question}\n   A: ${m.answerSummary}`
            ).join("\n\n");
        }
      } catch (e) {
        console.error("[qa-memory] lookup failed:", e.message);
      }
    }

    // Resolve + read pinned files for direct inclusion in the prompt.
    let pinnedContext = "";
    for (const p of pins) {
      const resolved = resolveFilePath(p, allRelevantFiles);
      if (!resolved) continue;
      const entry = readFileCached(resolved);
      if (!entry) continue;
      pinnedContext += `\n--- PINNED FILE: ${p} ---\n${entry.content}\n`;
    }

    // Diff-aware context: if a branch is specified, inject the diff against the base
    let diffContext = "";
    if (diffBranch && fs.existsSync(path.join(SANDBOX_DIR, ".git"))) {
      try {
        const diffStat = execSync(`git diff --stat ${diffBase}...${diffBranch}`, {
          cwd: SANDBOX_DIR, encoding: "utf8", timeout: 10000,
        }).trim();
        const rawDiff = execSync(`git diff ${diffBase}...${diffBranch} -- "*.ts" "*.tsx" "*.js" "*.jsx"`, {
          cwd: SANDBOX_DIR, encoding: "utf8", timeout: 15000,
          maxBuffer: 6 * 1024 * 1024,
        }).trim();
        const truncated = rawDiff.length > 80000 ? rawDiff.slice(0, 80000) + "\n... (diff truncated)" : rawDiff;
        diffContext = `\n\nDIFF CONTEXT — Changes in branch \`${diffBranch}\` relative to \`${diffBase}\`:\n\`\`\`\n${diffStat || "(no stat)"}\n\`\`\`\n\nFull diff:\n\`\`\`diff\n${truncated}\n\`\`\`\n\nWhen the question asks about "what changed" or "this PR" or "this branch", answer relative to this diff.`;
      } catch (e) {
        diffContext = `\n\nNote: Could not load diff for branch '${diffBranch}' vs '${diffBase}': ${e.message?.slice(0, 200)}`;
      }
    }

    // Source files, plus whatever the read-only MCP fleet can answer. Discovered
    // before the prompt is built so the model is only told about tools that are
    // actually reachable this request. Best-effort: a server that is down costs
    // the answer some depth, never the answer itself. See ask-mcp.js.
    const { tools: askMcpTools, index: askMcpIndex, skipped: askMcpSkipped } = await discoverAskTools();
    if (askMcpSkipped.length) console.warn("[ask] MCP unavailable:", askMcpSkipped.join("; "));

    const systemPrompt = `You are an expert analyst for the A House Divided (AHD) game codebase — a political strategy MMO built with Next.js, TypeScript, and MongoDB.

Your role is STRICTLY READ-ONLY analysis. You must NEVER:
- Suggest code changes, edits, or modifications
- Write or modify any code
- Provide commands to run
- Access databases, APIs, or external systems
- Make up information about code you don't see in context

CRITICAL: You MUST be thorough. When asked about a system:
1. FIRST, use the codebase map below to identify the correct directory and files
2. Read the ACTUAL source files with read_file — NEVER guess paths or hallucinate code
3. If a file read fails, check the map for alternate paths (e.g. src/lib/elections/ vs src/lib/electionEngine/)
4. Only say "I don't know" AFTER you have read the relevant files and still lack information
5. Do NOT give up after one failed read — try alternate paths from the map

NEVER fabricate file paths or code details. If you're unsure, read the file first.

${getCodebaseMap()}

${mode === "simple" ? `RESPOND IN SIMPLE MODE: Explain concepts in plain English that a non-technical player could understand. Avoid code references, function names, and implementation details. Focus on WHAT happens and WHY it matters for gameplay, not HOW it's implemented. Use analogies and examples where helpful.` : `Be concise and direct. Use code references like: \`src/lib/economy.ts:42\` when pointing to specific locations.`}

${quality === "reasoning" ? `REASONING MODE: Think step by step. Trace through the actual code paths. Show your reasoning chain: what file you read, what you found, how it connects to the next file. Be exhaustive — read all relevant files before concluding.` : quality === "fast" ? `FAST MODE: Give the shortest answer that's still accurate. Skip elaboration. One paragraph max unless the question demands more.` : `STANDARD MODE: Be concise. Get to the point within 2-4 paragraphs. Use bullet points for lists. Do not over-explain — the reader is a developer.`}
${mode === "simple" ? "" : `
ANSWER GROUNDING (technical mode):
- Cite specific line numbers, not just files: \`src/lib/economy/inflation.ts:42-58\`. The model receives files with their full contents, so count lines and reference the exact range.
- When your answer hinges on a piece of code, inline the relevant 10-15 line snippet in a fenced code block so the reader doesn't have to go find it. Don't paste whole files — just the load-bearing lines.
- Be explicit about uncertainty. If you could NOT find the code behind a claim, say so plainly ("I could not locate the X implementation in the files I read") rather than guessing. Never present an inference as if you read it.`}


RICH RENDERING — MANDATORY FORMAT RULES:
If the question is about how something works, a process or flow, a sequence of steps, state transitions, a lifecycle, or how components relate, you MUST include a mermaid diagram — this is expected by default, not optional, and it applies in EVERY mode (a diagram does NOT count against the "concise"/"one paragraph" limits — include it in addition to the prose). When in doubt, add the diagram.
Wrap every diagram in \`\`\`mermaid code fences:
\`\`\`mermaid
graph TD
    A[Start] --> B[End]
\`\`\`
NEVER output bare mermaid without \`\`\`mermaid fences. NEVER use ASCII art box-drawing (┌─┐ │ └─►). Both render as ugly text.
CRITICAL mermaid syntax — any node or edge label containing special characters MUST be wrapped in double quotes, or the parser crashes. Characters that REQUIRE quoting: { } ( ) [ ] / | < > and anything with <br/>.
  WRONG: B[POST /api/funds/{id}/subscribe]   ← the { is parsed as a new node and the diagram fails
  RIGHT: B["POST /api/funds/{id}/subscribe"]
  WRONG: H[handleRouteError<br/>500 Error]   RIGHT: H["handleRouteError<br/>500 Error"]
  WRONG: D -->|standalone / no replica| E    RIGHT: D -->|"standalone / no replica"| E
When unsure, quote the label. Use real names from the code — never invent file paths.
For comparisons/data: use markdown tables (pipe-delimited).

FOLLOW-UP QUESTIONS — MANDATORY: At the very END of your response, after all prose and diagrams, append on its own final line a hidden marker of the form:
<!--FU:["question one","question two","question three"]-->
It must contain EXACTLY 3 short follow-up questions (each under 12 words) that a developer would naturally ask next about THIS specific topic, answerable from this codebase. Output nothing after the marker. Do not mention the marker in your prose.

read_file rules:
- Prefer read_files to fetch several related files in ONE call (e.g. draftCharter, signCharter, ratifyCharter together) — it's far faster than one-at-a-time. Use read_file for a single file.
- Budget: there's a finite read budget that depletes faster for large files, so read what you need and don't waste it re-reading. Batch with read_files where you can.
- If a read returns an error (file not found), do NOT retry the same path — try an alternate from the map.
- ALWAYS read files before referencing them. Never cite code you haven't read.
- Prioritize reading src/lib/ files — that's where game mechanics live.
${askMcpTools.length ? `
Beyond the source, you may also have read-only platform tools (named like ops-knowledge__…, gamestate__…, engine__…, support__…). Use them when the source alone cannot answer:
- "why did this number move", "what is it right now" → the live state tools, not a guess from the formula.
- "have we hit this before", "what did we decide" → the knowledge tools, which hold runbooks and past decisions.
- Source stays the authority on how the code behaves. These tools tell you what the running system is doing and what the team already learned.
- They are read-only and cannot change anything. Their budget is small and separate from the file budget, so query deliberately, and never call one to confirm something you have already read.
` : ""}
Below is an index of the most relevant files for this question. Use read_file / read_files to examine their contents.

${indexContext}${pinnedContext ? `\n\nThe user has PINNED these files — their full contents are included below, already in context (no need to read them again):\n${pinnedContext}` : ""}${diffContext}${priorQAContext}`;

    // read_file tool definition
    const read_file_tool = {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a single source file from the AHD codebase. Use relative paths like 'src/lib/economy.ts'. Returns the file contents up to 100K chars.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path within the codebase (e.g. 'src/lib/economy.ts')" }
          },
          required: ["path"]
        }
      }
    };

    // read_files tool — fetch multiple files in a single round to cut latency on
    // questions that need cross-referencing several files at once.
    const read_files_tool = {
      type: "function",
      function: {
        name: "read_files",
        description: "Read several source files in one call (up to 5). Much faster than calling read_file repeatedly when a question spans multiple files. Returns each file's contents concatenated.",
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Relative file paths to read (max 5), e.g. ['src/lib/charters/draftCharter.ts','src/lib/charters/signCharter.ts']"
            }
          },
          required: ["paths"]
        }
      }
    };
    const askTools = [read_file_tool, read_files_tool, ...askMcpTools];

      const reqHeaders = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + LLM_API_KEY,
      };
      if (LLM_PROVIDER === "kimi") reqHeaders["User-Agent"] = "claude-code/1.0";
      if (LLM_PROVIDER === "opencode-go") reqHeaders["User-Agent"] = "opencode";

      // Seed with the system prompt, then any prior Q&A pairs (for follow-ups),
      // then the current question.
      const messages = [{ role: "system", content: systemPrompt }];
      for (const pair of history) {
        messages.push({ role: "user", content: pair.q });
        messages.push({ role: "assistant", content: pair.a });
      }
      messages.push({ role: "user", content: question });

      let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
      let answerSent = false;
      let finalAnswer = "";
      const MAX_TOOL_ROUNDS = quality === "reasoning" ? 24 : quality === "fast" ? 10 : 16;
      const filesRead = new Set();
      // Pinned files are already in the prompt — count them as read.
      for (const p of pins) filesRead.add(p);

      // Everything this answer was grounded in, typed so the client can say what
      // kind of evidence each item is rather than listing bare paths. Files are
      // folded in at the end from `filesRead`; non-file sources are appended as
      // they are consulted.
      const askSources = [];
      const askRevision = sandboxRevision();
      // Scaled like the read budget: a deeper question earns more lookups.
      const MAX_MCP_CALLS = quality === "reasoning" ? 12 : quality === "fast" ? 3 : 7;
      let askMcpCalls = 0;
      const noteAskSource = (entry) => {
        if (!entry || !entry.label) return;
        if (askSources.some((s) => s.kind === entry.kind && s.label === entry.label)) return;
        askSources.push(entry);
        sse("source", entry);
      };

      // Read budget measured in *bytes*, not file count: a large file should cost
      // more of the budget than a small one. When exhausted (or the hard file-count
      // cap is hit), we drop the tools from the next request so the model answers
      // with what it has rather than reading indefinitely.
      const READ_BUDGET_BYTES = quality === "reasoning" ? 700000 : quality === "fast" ? 150000 : 380000;
      const MAX_FILE_READS = quality === "reasoning" ? 16 : quality === "fast" ? 6 : 10;
      let bytesRead = 0;

      // Process a single tool call (read_file or read_files), emitting SSE
      // progress and returning the tool-result content string for the model.
      async function processToolCall(tc) {
        const name = tc.function?.name;
        if (askMcpIndex.has(name)) {
          if (askMcpCalls >= MAX_MCP_CALLS) return "Error: lookup budget exhausted — answer from what you already have.";
          askMcpCalls += 1;
          let args;
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
          sse("reading", { path: name.replace("__", " · ") });
          const { text, source } = await callAskTool(askMcpIndex, name, args);
          if (source) noteAskSource(source);
          return text;
        }
        if (name === "read_file") {
          let p;
          try { p = JSON.parse(tc.function.arguments).path; } catch { p = tc.function.arguments; }
          const dp = String(p || "").replace(/^\/+/, "");
          sse("reading", { path: dp });
          const content = handleFileReadRequest(dp, allRelevantFiles, filesRead, sse);
          bytesRead += content.length;
          return content;
        }
        if (name === "read_files") {
          let paths;
          try { paths = JSON.parse(tc.function.arguments).paths; } catch { paths = null; }
          if (!Array.isArray(paths)) paths = [];
          paths = paths.slice(0, 5);
          let combined = "";
          for (const rawP of paths) {
            const dp = String(rawP || "").replace(/^\/+/, "");
            if (!dp) continue;
            sse("reading", { path: dp });
            const content = handleFileReadRequest(dp, allRelevantFiles, filesRead, sse);
            bytesRead += content.length;
            combined += `\n===== FILE: ${dp} =====\n` + content + "\n";
          }
          return combined || "No valid paths provided.";
        }
        return `Error: unknown tool "${name}".`;
      }
      let llmController = new AbortController();
      let llmTimeout = setTimeout(() => {
        llmController.abort();
        sse("error", { error: "LLM API timed out" });
        res.end();
      }, 300000);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // Stream response when using Kimi, but only omit tools on later rounds where
        // we're confident the model will just generate text. Round 0 and any round
        // after tool calls always include tools (non-streaming).
        // If streaming fails (non-SSE response or 400), fall through to non-streaming.
        // Offer tools only while the read budget (bytes) and file-count cap allow
        // more reads. Once exhausted, omit them so the model produces its answer.
        //
        // MCP tools carry their own budget rather than sharing the file one: a
        // question that spends its file reads tracing a code path is exactly the
        // one that then wants to ask the knowledge brain or live state about what
        // it found, and folding them into one counter would cut it off there.
        const canRead = bytesRead < READ_BUDGET_BYTES && filesRead.size < MAX_FILE_READS;
        const canQuery = askMcpCalls < MAX_MCP_CALLS;
        const roundTools = canRead && canQuery ? askTools
          : canRead ? [read_file_tool, read_files_tool]
          : canQuery && askMcpTools.length ? askMcpTools
          : undefined;

        // Kimi's streaming tool-call deltas don't accumulate arguments reliably
        // (paths arrive empty), so only stream on rounds where no tools are
        // offered — i.e. the final answer round. Tool rounds use non-streaming,
        // which parses tool_calls correctly.
        const shouldStream = LLM_PROVIDER === "kimi" && !roundTools;
        let skipStreaming = false; // set true if 400 retry falls back to non-streaming

        let llmRes = await fetch(LLM_API_URL, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify({
            model: LLM_MODEL,
            messages,
            ...(roundTools ? { tools: roundTools } : {}),
            temperature: 1,
            max_tokens: quality === "reasoning" ? 20000 : quality === "fast" ? 3000 : 10000,
            ...(shouldStream ? { stream: true, stream_options: { include_usage: true } } : {}),
          }),
          signal: llmController.signal,
        });

        if (!llmRes.ok) {
          // If streaming request got 400 (Kimi doesn't support stream+tools), retry without streaming
          if (llmRes.status === 400 && shouldStream) {
            console.log(`[ask] Round ${round}: stream request got 400, retrying without streaming`);
            llmController = AbortController ? new AbortController() : new (require("abort-controller"))();
            llmTimeout = setTimeout(() => { llmController.abort(); }, 300000);
            const retryRes = await fetch(LLM_API_URL, {
              method: "POST",
              headers: reqHeaders,
              body: JSON.stringify({
                model: LLM_MODEL,
                messages,
                ...(roundTools ? { tools: roundTools } : {}),
                temperature: 1,
                max_tokens: quality === "reasoning" ? 20000 : quality === "fast" ? 3000 : 10000,
                // No stream: true this time
              }),
              signal: llmController.signal,
            });
            if (!retryRes.ok) {
              const errText2 = await retryRes.text().catch(() => "");
              console.error("[ask] LLM API retry error:", retryRes.status, errText2.slice(0, 500));
              clearTimeout(llmTimeout);
              sse("error", { error: "LLM API returned status " + retryRes.status });
              res.end();
              return;
            }
            // Replace llmRes with the retry response and fall through to non-streaming path
            // We need to continue processing with retryRes instead of llmRes
            llmRes = retryRes;
            skipStreaming = true; // force non-streaming processing
          } else {
            const errText = await llmRes.text().catch(() => "");
            console.error("[ask] LLM API error:", llmRes.status, errText.slice(0, 500));
            clearTimeout(llmTimeout);
            sse("error", { error: "LLM API returned status " + llmRes.status });
            res.end();
            return;
          }
        }

        // ── Streaming path ──
        if (shouldStream && !skipStreaming && llmRes.body && llmRes.headers.get("content-type")?.includes("text/event-stream")) {
          let fullContent = "";
          let fullReasoning = "";
          let currentToolCalls = []; // accumulated tool calls from stream

          // Use Readable.fromWeb() to convert Web ReadableStream to Node stream for async iteration
          const nodeStream = require("stream").Readable.fromWeb(llmRes.body);
          let sseBuffer = "";

          for await (const chunk of nodeStream) {
            if (!clientConnected) break; // Stop streaming if client disconnected
            sseBuffer += chunk.toString();
            // Process complete SSE lines (delimited by \n\n or \n)
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop(); // keep incomplete line in buffer
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const payload = line.startsWith("data: ") ? line.slice(6).trim() : line.slice(5).trim();
              if (payload === "[DONE]") continue;
              let parsed;
              try { parsed = JSON.parse(payload); } catch { continue; }
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;

              // Accumulate tool calls
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.id) {
                    currentToolCalls.push({ id: tc.id, function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" } });
                  } else if (currentToolCalls.length > 0 && tc.function) {
                    if (tc.function.arguments) currentToolCalls[currentToolCalls.length - 1].function.arguments += tc.function.arguments;
                    if (tc.function.name) currentToolCalls[currentToolCalls.length - 1].function.name = tc.function.name;
                  }
                }
              }

              // Forward content tokens to client immediately
              if (delta.content) {
                fullContent += delta.content;
                sse("token", { text: delta.content });
              }

              // Kimi K2.6 reasoning_content = internal thinking, not visible output
              if (delta.reasoning_content) {
                fullReasoning += delta.reasoning_content;
                sse("thinking", { text: delta.reasoning_content });
              }

              if (parsed.usage) {
                totalUsage.prompt_tokens += parsed.usage.prompt_tokens || 0;
                totalUsage.completion_tokens += parsed.usage.completion_tokens || 0;
              }
            }
          }
          // Process any remaining buffer
          if (sseBuffer.startsWith("data:")) {
            const payload = sseBuffer.startsWith("data: ") ? sseBuffer.slice(6).trim() : sseBuffer.slice(5).trim();
            if (payload !== "[DONE]") {
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) { fullContent += delta.content; sse("token", { text: delta.content }); }
                if (delta?.reasoning_content) { fullReasoning += delta.reasoning_content; sse("thinking", { text: delta.reasoning_content }); }
                if (parsed.usage) { totalUsage.prompt_tokens += parsed.usage.prompt_tokens || 0; totalUsage.completion_tokens += parsed.usage.completion_tokens || 0; }
              } catch {}
            }
          }

          // If tool calls were accumulated during stream, handle them
          if (currentToolCalls.length > 0) {
            const fakeMsg = { role: "assistant", content: fullContent || null, reasoning_content: fullReasoning || null, tool_calls: currentToolCalls };
            messages.push(fakeMsg);
            for (const tc of currentToolCalls) {
              const content = await processToolCall(tc);
              messages.push({ role: "tool", tool_call_id: tc.id, content });
            }
            // Continue to next round (tool calls with streaming)
            continue;
          }

          // No tool calls — this is the final streamed answer
          const answer = fullContent || fullReasoning || "No response from model";
          finalAnswer = answer;
          sse("answer", { text: answer, model: LLM_MODEL });
          answerSent = true;
          break;
        }

        // ── Non-streaming path (original) ──
        const llmData = await llmRes.json();
        const msg = llmData.choices?.[0]?.message;
        if (!msg) { clearTimeout(llmTimeout); sse("error", { error: "No response from model" }); res.end(); return; }

        if (llmData.usage) {
          totalUsage.prompt_tokens += llmData.usage.prompt_tokens || 0;
          totalUsage.completion_tokens += llmData.usage.completion_tokens || 0;
        }

        // Check if model wants to call tools
        const toolCalls = msg.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          // Kimi requires reasoning_content in assistant tool-call messages when thinking is enabled
          // If missing from response, set to null (Kimi accepts this for tool-call messages)
          if (!("reasoning_content" in msg)) msg.reasoning_content = null;
          messages.push(msg);

          for (const tc of toolCalls) {
            const content = await processToolCall(tc);
            messages.push({ role: "tool", tool_call_id: tc.id, content });
          }
          // Continue to next round — model will see tool results and decide next action
        } else {
          // Final answer
          const answer = msg.content || msg.reasoning_content || "No response from model";
          finalAnswer = answer;
          sse("answer", { text: answer, model: LLM_MODEL });
          answerSent = true;
          break;
        }
      }

      // If we exhausted all rounds without a final answer
      if (!answerSent && totalUsage.completion_tokens === 0 && !filesRead.size) {
        finalAnswer = "I reached the maximum number of file reads without finding relevant code. Please try rephrasing your question or asking about a specific file.";
        sse("answer", { text: finalAnswer, model: LLM_MODEL });
      }

      clearTimeout(llmTimeout);
      // Persist the exchange (best-effort, namespaced collection) and hand the
      // client the id so feedback can attach to it.
      logQa({
        id: qaId, question, answer: finalAnswer, mode, quality, model: LLM_MODEL,
        files: [...filesRead],
        usage: { input: totalUsage.prompt_tokens, output: totalUsage.completion_tokens },
        email: session?.email,
      });
      // Feature 3: save Q&A to semantic memory for future sessions (best-effort, async)
      if (semanticReady && finalAnswer && finalAnswer.length > 50) {
        const answerSummary = finalAnswer.slice(0, 800);
        getDb().then(qaDb => saveQAMemory(qaDb, { question, answerSummary, files: [...filesRead] })).catch(() => {});
      }
      sse("done", {
        id: qaId,
        usage: { input: totalUsage.prompt_tokens, output: totalUsage.completion_tokens },
        files: [...filesRead],
        quality,
        branch: diffBranch || null,
        semantic: semanticReady,
        memory: usedMemory,
        // Which model answered, and the commit it read. `answer` already carried
        // the model, but a client that renders from `done` — or replays a stored
        // exchange — had no way to show either.
        model: LLM_MODEL,
        revision: askRevision?.label || null,
        sources: [
          ...[...filesRead].map((p) => ({ kind: "file", label: p, path: p })),
          ...askSources,
        ],
      });
      res.end();
      return;
    } catch (e) {
      console.error("[ask] Request failed:", e);
      const msg = e?.name === "AbortError" ? "LLM API timed out" : "Failed to reach LLM API";
      try { sse("error", { error: msg }); res.end(); } catch {}
      return;
    }
  }

  // GET /api/project-guide — Read the dynamic project guide (admin only)
  if (req.method === "GET" && pathname === "/api/project-guide") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") return json(res, 403, { error: "Forbidden" });
    try {
      const fsPromises = require("fs").promises;
      const guidePath = path.join(process.env.HOME || "/root", ".hermes", "docs", "PROJECT_GUIDE.md");
      const content = await fsPromises.readFile(guidePath, "utf-8");
      const stats = await fsPromises.stat(guidePath);
      return json(res, 200, {
        content,
        lastModified: stats.mtime.toISOString(),
        size: stats.size,
      });
    } catch (err) {
      if (err.code === "ENOENT") {
        return json(res, 404, { error: "Project guide not found. Run the project-guide cron job first." });
      }
      return json(res, 500, { error: err.message });
    }
  }

  // GET /project-guide — Project guide reader page (admin only)
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/project-guide") {
    const session = await resolveSession(req);
    if (!session || session.role !== "admin") { addSecurityHeaders(res); res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return; }
    addSecurityHeaders(res);
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    try {
      const html = fs.readFileSync(path.join(__dirname, "pages", "project-guide.html"), "utf8");
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to load project guide page");
    }
    return;
  }

  // ─── NEW FEATURE ENDPOINTS ────────────────────────────────────────

  // GET /api/ask/file?path=... — Read a file from the sandbox for citation viewer (admin + moderator)
  if (req.method === "GET" && pathname === "/api/ask/file") {
    const reqPath = (url.searchParams.get("path") || "").replace(/^\/+/, "").slice(0, 300);
    if (!reqPath) return json(res, 400, { error: "path required" });
    const resolved = resolveFilePath(reqPath, SEARCH_INDEX.files);
    if (!resolved) return json(res, 404, { error: "File not found" });
    const entry = readFileCached(resolved);
    if (!entry) return json(res, 500, { error: "Could not read file" });
    return json(res, 200, { content: entry.content, path: reqPath, lines: entry.content.split("\n").length });
  }

  // GET /api/sandbox/branches — List branches in the sandbox git repo (admin + moderator)
  if (req.method === "GET" && pathname === "/api/sandbox/branches") {
    if (!fs.existsSync(path.join(SANDBOX_DIR, ".git"))) return json(res, 200, { branches: [] });
    try {
      const raw = execSync("git branch -a --format=%(refname:short)", {
        cwd: SANDBOX_DIR, encoding: "utf8", timeout: 10000,
      }).trim();
      const branches = raw.split("\n").map(b => b.trim()).filter(b => b && !b.startsWith("HEAD") && !b.includes("->"));
      return json(res, 200, { branches });
    } catch (e) {
      return json(res, 500, { error: e.message?.slice(0, 200) });
    }
  }

  // GET /api/code/sessions/:id/review — Stream an AI code review of the session's diff (admin only)
  if (req.method === "GET" && /^\/api\/code\/sessions\/[^/]+\/review$/.test(pathname)) {
    if (!codeSessionManager) return json(res, 503, { error: "Session manager not ready" });
    if (!LLM_API_KEY) return json(res, 503, { error: "LLM API key not configured" });
    const reviewSessionId = pathname.split("/")[4];
    try {
      const sessionDoc = await codeSessionManager.getSession(reviewSessionId);
      if (!sessionDoc) return json(res, 404, { error: "Session not found" });
      if (!sessionDoc.worktreePath) return json(res, 400, { error: "No worktree — start a task first" });

      const baseBranch = (sessionDoc.baseBranch || "development").replace(/[^a-zA-Z0-9/_.-]/g, "");
      let diff = "";
      try {
        diff = execSync(`git diff ${baseBranch}...HEAD`, {
          cwd: sessionDoc.worktreePath, encoding: "utf8", timeout: 15000, maxBuffer: 6 * 1024 * 1024,
        }).trim();
      } catch {
        try {
          diff = execSync("git diff HEAD~1..HEAD", {
            cwd: sessionDoc.worktreePath, encoding: "utf8", timeout: 15000, maxBuffer: 6 * 1024 * 1024,
          }).trim();
        } catch { diff = ""; }
      }

      addSecurityHeaders(res);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      let reviewClientConnected = true;
      req.on("close", () => { reviewClientConnected = false; });
      req.on("error", () => { reviewClientConnected = false; });
      const reviewSse = (ev, data) => {
        if (!reviewClientConnected) return;
        try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { reviewClientConnected = false; }
      };

      if (!diff) {
        reviewSse("done", { text: "No changes detected in this session's worktree compared to the base branch. Make some edits first, then request a review." });
        res.end(); return;
      }

      const truncatedDiff = diff.length > 80000 ? diff.slice(0, 80000) + "\n... (diff truncated at 80KB)" : diff;
      const reviewPrompt = `You are a senior code reviewer for the A House Divided (AHD) game — a political strategy MMO built with Next.js, TypeScript, and MongoDB.

Review the following git diff. Focus on:
1. **Correctness bugs** — logic errors, off-by-ones, wrong formulas, race conditions
2. **Game balance** — changes to numeric formulas that could destabilize mechanics
3. **Type safety** — TypeScript issues, missing null checks, unsafe type assertions
4. **MongoDB patterns** — missing await, unindexed queries, wrong update operators
5. **Reuse & simplification** — duplication of existing utilities

For each issue: cite the exact file and line (\`src/lib/foo.ts:42\`), describe the problem, and suggest a fix.
If the changes look good, say so clearly with a brief summary of what was done.

\`\`\`diff
${truncatedDiff}
\`\`\``;

      const reviewHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + LLM_API_KEY };
      if (LLM_PROVIDER === "kimi") reviewHeaders["User-Agent"] = "claude-code/1.0";
      if (LLM_PROVIDER === "opencode-go") reviewHeaders["User-Agent"] = "opencode";

      const llmRes = await fetch(LLM_API_URL, {
        method: "POST", headers: reviewHeaders,
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [{ role: "user", content: reviewPrompt }],
          temperature: 1, max_tokens: 8000,
          ...(LLM_PROVIDER === "kimi" ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!llmRes.ok) { reviewSse("error", { error: "LLM error " + llmRes.status }); res.end(); return; }

      let reviewText = "";
      if (LLM_PROVIDER === "kimi" && llmRes.headers.get("content-type")?.includes("text/event-stream")) {
        const nodeStream = require("stream").Readable.fromWeb(llmRes.body);
        let sseBuf = "";
        for await (const chunk of nodeStream) {
          if (!reviewClientConnected) break;
          sseBuf += chunk.toString();
          const lines = sseBuf.split("\n"); sseBuf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = (line.startsWith("data: ") ? line.slice(6) : line.slice(5)).trim();
            if (payload === "[DONE]") continue;
            try {
              const p = JSON.parse(payload);
              const c = p.choices?.[0]?.delta?.content;
              if (c) { reviewText += c; reviewSse("token", { text: c }); }
            } catch {}
          }
        }
      } else {
        const data = await llmRes.json();
        reviewText = data.choices?.[0]?.message?.content || "";
      }

      reviewSse("done", { text: reviewText, diffLines: diff.split("\n").length });
      res.end(); return;
    } catch (e) {
      console.error("[code-agent] Review failed:", e.message);
      try { res.end(); } catch {}
      return;
    }
  }

  // GET /api/code/memory — List agent memory entries (admin only)
  if (req.method === "GET" && pathname === "/api/code/memory") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    try {
      const db = await getDb();
      const memories = await db.collection("code_agent_memory").find({}).sort({ createdAt: -1 }).limit(50).toArray();
      return json(res, 200, { memories: memories.map(m => ({ id: m._id, content: m.content, sessionId: m.sessionId, createdAt: m.createdAt })) });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // POST /api/code/memory — Save a memory entry (admin only)
  if (req.method === "POST" && pathname === "/api/code/memory") {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    let body = "";
    req.on("data", c => { body += c; if (body.length > 10000) body = body.slice(0, 10000); });
    await new Promise(r => req.on("end", r));
    try {
      const { content, sessionId: memSid } = JSON.parse(body);
      if (!content || typeof content !== "string" || content.trim().length < 5) return json(res, 400, { error: "content required (min 5 chars)" });
      const db = await getDb();
      const entry = { _id: crypto.randomUUID(), content: content.trim().slice(0, 2000), sessionId: memSid || null, createdAt: new Date(), createdBy: session.email };
      await db.collection("code_agent_memory").insertOne(entry);
      return json(res, 200, { ok: true, id: entry._id });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // DELETE /api/code/memory/:id — Delete a memory entry (admin only)
  if (req.method === "DELETE" && pathname.startsWith("/api/code/memory/")) {
    if (!(await requireAdmin())) return jsonResponse(403, { error: "Forbidden" });
    const memId = pathname.slice("/api/code/memory/".length);
    if (!memId) return jsonResponse(400, { error: "id required" });
    try {
      const db = await getDb();
      await db.collection("code_agent_memory").deleteOne({ _id: memId });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // 404
  return json(res, 404, { error: "Not found" });
});

// Clean expired sessions every hour
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions) {
    if (now - session.created >= sessionLifetime(session)) { sessions.delete(token); changed = true; }
  }
  if (changed) saveSessions();
}, 3600000);

// ── Security alerting ───────────────────────────────────────────────
// Push new critical/high host-security findings to Discord. The pull surface
// is /security; this is the half that speaks up when nobody is looking.
// De-duplicated on disk, so restarts and deploys do not re-alert an open issue.
{
  const securityService = require("./security-service");
  const { runAlertCheck } = require("./security-alert");
  const securityAlertTick = () =>
    runAlertCheck({ snapshot: () => securityService.snapshot(), notify: notifyOpsDiscord })
      .then((r) => {
        if (r && (r.fresh || r.resolved)) {
          console.log(`[security] alerts: ${r.fresh} new, ${r.resolved} cleared`);
        }
      })
      .catch((e) => console.error("[security] alert check failed:", e && e.message));
  setTimeout(securityAlertTick, 90_000).unref?.();
  setInterval(securityAlertTick, 5 * 60_000).unref?.();
}

// ── Code Agent (Session-based, Python bridge) ───────────────────
const { createSessionManager } = require('./code-session-manager');
const { spawn } = require("child_process");

const REPO_DIR = primaryRepoDir();
let codeSessionManager = null;
let codeSessionInitTimer = null;
let codeSessionCleanupTimer = null;

// Initialize session manager with DB. Mongo can still be reconnecting during a
// process restart; retry instead of leaving the Code page without saved chats
// until the next dashboard restart.
async function initializeCodeSessionManager() {
  codeSessionInitTimer = null;
  if (codeSessionManager) return;
  try {
    const db = await getDb();
    codeSessionManager = createSessionManager(db, {
      repoDir: REPO_DIR,
      llmProvider: LLM_PROVIDER,
      llmModel: LLM_MODEL,
      llmApiUrl: LLM_API_URL,
      llmApiKey: LLM_API_KEY,
    });
    console.log("[code-agent] Session manager ready");

    if (!codeSessionCleanupTimer) codeSessionCleanupTimer = setInterval(() => {
      codeSessionManager.cleanupOldSessions(7).catch(e =>
        console.error("[code-agent] Cleanup error:", e.message)
      );
    }, 86400000);
  } catch (e) {
    console.error("[code-agent] Session manager init failed:", e.message);
    codeSessionInitTimer = setTimeout(initializeCodeSessionManager, 5000);
    codeSessionInitTimer.unref?.();
  }
}
initializeCodeSessionManager();

// ─── COMMUNITY TRIAGE + GLITCHTIP WORKERS ────────────────────────────
// Read-only LLM triage of new tickets/suggestions + GlitchTip new-issue polling.
// Never crashes the host: each loop is internally wrapped.
if (process.env.OPS_PASSIVE !== "1") {
  try {
    startCommunityWorkers({ getDb, launchTicketFix: launchAutomatedTicketFix, requestTicketRecheck: requestAutomatedTicketRecheck });
  } catch (e) {
    console.error("[triage] failed to start community workers:", e.message);
  }

  // Retry transient player-channel failures without re-announcing successful
  // milestones. Each update has a stable key, delivery state, and retry cap.
  const retryPlayerUpdates = () => getDb()
    .then((db) => retryPendingTicketUpdates(db))
    .then((result) => {
      if (result && result.attempted) console.log("[ticket-ship] player-update retry", JSON.stringify(result));
    })
    .catch((e) => console.error("[ticket-ship] player-update retry failed:", e.message));
  setTimeout(retryPlayerUpdates, 60_000).unref?.();
  setInterval(retryPlayerUpdates, 10 * 60_000).unref?.();
}

// WebSocket upgrade handling for /api/code/sessions/:id/ws
const { OpsWebSocketAuth, allowedBrowserOrigin } = require("./ops-websocket-auth");
const opsWebSocketAuth = new OpsWebSocketAuth();
const OPS_WEBSOCKET_HOSTS = OPS_SSO_HOSTS;
const activeBridges = new Map(); // sessionId → { proc, ws }

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/api\/code\/sessions\/([^/]+)\/ws$/);
  if (!match) return;
  if (!isEnabled("codeAgent")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  if (!allowedBrowserOrigin(req, OPS_WEBSOCKET_HOSTS)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  // Auth — use the SAME resolution as HTTP routes (resolveSession includes the
  // stateless game-JWT path), so a server restart doesn't invalidate live WS
  // sessions and leave the client in a reconnect loop.
  let userSession = null;
  try { userSession = await resolveSession(req); } catch { userSession = null; }
  if (!userSession) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  if (userSession.role !== "admin") {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  // Use the ws library for upgrade
  const { WebSocketServer } = require("ws");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Keep the credential path and identity selected at upgrade fixed.
    const recheck = userSession.created !== undefined
      ? () => checkSession(req)
      : () => checkGameSession(req, { fresh: true });
    const authorize = opsWebSocketAuth.attach(ws, req, userSession, recheck);
    authorize().then(ok => { if (ok) return handleSessionWebSocket(ws, sessionId); })
      .catch(() => ws.terminate());
  });
});

// ── LLM-powered branch naming ────────────────────────────
// Calls the configured LLM to summarize a task into a 3-5 word slug.
// Used before initializeWorktree so branches are named by the model, not sliced prompt.
async function summarizeBranchName(promptText) {
  const messages = [
    { role: "system", content: "You are a task-naming assistant. Given a coding task description, output a concise 3-5 word name suitable for a git branch. Use only lowercase letters, numbers, and hyphens. No punctuation, no quotes, no spaces. Reply with ONLY the branch name, nothing else. Examples: 'fix-gdp-export-calculation', 'add-session-auth-middleware', 'refactor-election-query'." },
    { role: "user", content: promptText },
  ];
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LLM_API_KEY}`,
    };
    // Kimi requires claude-code User-Agent
    if (LLM_PROVIDER === "kimi") {
      headers["User-Agent"] = "claude-code/1.0";
    }
    const res = await fetch(LLM_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        max_tokens: 30,
        temperature: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`LLM status ${res.status}`);
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || "").trim().toLowerCase();
    // Clean to branch-safe slug
    const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return slug || null; // null = fallback to original slugify logic
  } catch (e) {
    console.error("[code-agent] Branch name LLM call failed:", e.message);
    return null; // fallback to slugify in initializeWorktree
  }
}

// Event types persisted to the durable session log (skip token streaming, pings,
// transient thinking/stage, and the bulk history event which is saved separately).
const PERSIST_EVENT_TYPES = new Set(["tool_start", "tool_result", "answer", "file_changes", "error", "session_info", "approval_needed", "approval_cancelled", "cancelled", "model_switched", "usage", "user_message"]);

async function handleSessionWebSocket(ws, sessionId) {
  if (!codeSessionManager) {
    ws.send(JSON.stringify({ type: "error", error: "Session manager not ready" }));
    ws.close();
    return;
  }

  const sessionDoc = await codeSessionManager.getSession(sessionId);
  if (!sessionDoc) {
    ws.send(JSON.stringify({ type: "error", error: "Session not found" }));
    ws.close();
    return;
  }

  if (ws.readyState !== 1 || !await ws.authorize()) return;

  // Check for existing bridge — reattach if still alive, otherwise spawn new
  const existing = activeBridges.get(sessionId);
  if (existing) {
    if (existing.proc && !existing.proc.killed && existing.proc.exitCode === null) {
      // Bridge still running — reattach ws and return
      console.log("[code-agent] Reattaching to running bridge for", sessionId);
      existing.ws = ws;
      // The durable event log (replayed on page load) now restores past work, so
      // we no longer replay the in-memory buffer here — that would double-render
      // on a reload while the agent is still working. Live events stream below.
      existing.eventBuffer = [];
      // Notify frontend that agent is still working
      ws.send(JSON.stringify({ type: "status", status: "working", message: "Agent still working — reconnected" }));
      // Re-setup keepalive ping
      const pingInterval = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
        }
      }, 25000);
      ws.on("close", () => {
        existing.ws = null;
        if (pingInterval) clearInterval(pingInterval);
      });
      // Forward messages from browser to existing bridge
      ws.on("message", async (raw) => {
        if (!await ws.authorize()) return;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "message" && msg.content) {
            codeSessionManager.appendMessage(sessionId, {
              role: "user", content: msg.content, timestamp: new Date()
            }).catch(() => {});
            codeSessionManager.appendEvent(sessionId, { type: "user_message", content: msg.content }).catch(() => {});
            // Codex keeps its own thread context through `exec resume`; it does
            // not consume the dashboard history field. Avoid blocking every
            // follow-up on a redundant MongoDB read.
            if (existing.isCodexRuntime) {
              if (existing.proc.stdin.writable) {
                existing.proc.stdin.write(JSON.stringify(msg) + "\n");
              }
              return;
            }
            // Attach latest history from MongoDB
            codeSessionManager.getSession(sessionId).then(async session => {
              if (!await ws.authorize()) return;
              if (session?.messages?.length) {
                msg.history = session.messages.map(m => {
                  const entry = { role: m.role };
                  if (m.content != null) entry.content = m.content;
                  if (m.tool_calls) entry.tool_calls = m.tool_calls;
                  if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
                  if (m.name) entry.name = m.name;
                  return entry;
                });
              }
              if (existing.proc.stdin.writable) {
                existing.proc.stdin.write(JSON.stringify(msg) + "\n");
              }
            }).catch(async () => {
              if (!await ws.authorize()) return;
              if (existing.proc.stdin.writable) {
                existing.proc.stdin.write(JSON.stringify(msg) + "\n");
              }
            });
            return;
          }
          if (existing.proc.stdin.writable) {
            existing.proc.stdin.write(JSON.stringify(msg) + "\n");
          }
        } catch {}
      });
      return;
    }
    // Bridge dead — clean up and spawn fresh
    try { existing.proc.kill("SIGTERM"); } catch {}
    activeBridges.delete(sessionId);
  }

  // ── Stub session: no worktree yet — wait for first message ──
  if (sessionDoc.status === "stub") {
    ws.send(JSON.stringify({ type: "status", status: "stub" }));

    let initialised = false;

    ws.on("message", async (raw) => {
      if (!await ws.authorize()) return;
      if (initialised) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== "message" || !msg.content?.trim()) return;

        initialised = true;
        const promptText = msg.content.trim();

        // 1. Ask LLM to name the branch
        summarizeBranchName(promptText)
          .then(async branchSlug => {
            if (!await ws.authorize()) throw new Error("Sign-in required");
            // 2. Create worktree + branch
            return codeSessionManager.initializeWorktree(sessionId, branchSlug);
          })
          .then(async (updated) => {
            if (!await ws.authorize()) return;
            ws.send(JSON.stringify({
              type: "session_info",
              title: updated.title || null,
              branchName: updated.branchName || null,
              worktreePath: updated.worktreePath || null,
            }));

            // 3. Persist the first user message (direct stdin write below bypasses
            //    spawnBridge's per-message persistence, so do it explicitly here).
            await codeSessionManager.appendMessage(sessionId, {
              role: "user", content: promptText, timestamp: new Date(),
            }).catch(() => {});
            codeSessionManager.appendEvent(sessionId, { type: "user_message", content: promptText }).catch(() => {});

            // 4. Spawn bridge
            await spawnBridge(ws, sessionId);

            // 5. Forward the original message to the bridge
            const bridge = activeBridges.get(sessionId);
            if (bridge && bridge.proc.stdin.writable && await ws.authorize()) {
              bridge.proc.stdin.write(JSON.stringify({ type: "message", content: promptText }) + "\n");
            } else {
              ws.send(JSON.stringify({ type: "error", error: "Agent failed to start — see server logs." }));
            }
          })
          .catch((e) => {
            console.error("[code-agent] Session init failed:", e.message);
            ws.send(JSON.stringify({ type: "error", error: `Failed to start session: ${e.message}` }));
            ws.send(JSON.stringify({ type: "done" }));
            initialised = false;
          });
      } catch {}
    });

    ws.on("close", () => {
      activeBridges.delete(sessionId);
    });
    return;
  }

  // ── Normal (non-stub) session: spawn bridge immediately ──
  await spawnBridge(ws, sessionId);
}

async function spawnBridge(ws, sessionId) {
  const sessionDoc = await codeSessionManager.getSession(sessionId);
  if (ws.readyState !== 1 || !await ws.authorize()) return;
  if (!sessionDoc) {
    ws.send(JSON.stringify({ type: "error", error: "Session not found" }));
    ws.close();
    return;
  }

  // Update status
  await codeSessionManager.updateSessionStatus(sessionId, "active").catch(() => {});

  if (!await ws.authorize()) return;

  // Codex sessions use the installed Codex CLI through a small NDJSON adapter;
  // legacy/provider sessions continue through the Hermes Python bridge.
  const isCodexRuntime = (sessionDoc.provider || "").toLowerCase() === "codex";
  const bridgePath = path.join(
    __dirname,
    isCodexRuntime ? "codex-agent-bridge.js" : "code-agent-bridge.py"
  );
  const bridgeCommand = isCodexRuntime
    ? process.execPath
    : "/usr/local/lib/hermes-agent/venv/bin/python3";
  const proc = spawn(bridgeCommand, [bridgePath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MONGODB_URI: undefined,
      KIMI_API_KEY: undefined,
      OLLAMA_CLOUD_KEY: undefined,
      OPENCODE_GO_API_KEY: undefined,
      OPS_USERS: undefined,
      LLM_API_KEY: undefined,
      PYTHONPATH: "/usr/local/lib/hermes-agent",
      PYTHONUNBUFFERED: "1",
      CODEX_RUNTIME: isCodexRuntime ? "1" : undefined,
    },
  });

  activeBridges.set(sessionId, { proc, ws, eventBuffer: [], isCodexRuntime });

  // Keepalive ping to prevent proxy/idle timeout
  const pingInterval = setInterval(() => {
    const entry = activeBridges.get(sessionId);
    const currentWs = entry?.ws;
    if (currentWs && currentWs.readyState === 1) {
      try { currentWs.send(JSON.stringify({ type: "ping" })); } catch {}
    }
  }, 25000);

  let buffer = "";
  let ready = false;
  let lastStderr = "";  // tail of stderr, surfaced to the client if the bridge dies

  // Surface a failed spawn (e.g. python interpreter missing) instead of crashing.
  proc.on("error", (err) => {
    console.error("[code-agent] Bridge spawn error:", err.message);
    activeBridges.delete(sessionId);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "error", error: `Failed to start agent: ${err.message}` }));
    }
    codeSessionManager.updateSessionStatus(sessionId, "error").catch(() => {});
  });
  let streamedTokens = "";  // Track partial response for disconnect save
  let pendingUserMessage = null;  // Track last user message for persistence
  let agentWorking = false;  // Track if agent is mid-task

  // Handle stdout (NDJSON events from bridge)
  proc.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "ready") {
          ready = true;
          if (event.hermesSessionId) {
            codeSessionManager.setHermesSessionId(sessionId, event.hermesSessionId).catch(() => {});
          }
        }
        // Track agent state for graceful disconnect
        if (event.type === "thinking" || event.type === "tool_start") {
          agentWorking = true;
        }
        if (event.type === "token") {
          streamedTokens += event.content || "";
          agentWorking = true;
        }
        // Persist answer to MongoDB server-side
        if (event.type === "answer" && event.text) {
          agentWorking = false;
          streamedTokens = "";
        }
        // Store full conversation history (with tool_calls/results) to MongoDB
        if (event.type === "history" && Array.isArray(event.messages)) {
          const cleanMessages = event.messages
            .filter(m => m && m.role)
            .map(m => {
              const entry = { role: m.role };
              if (m.content != null) entry.content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              if (m.tool_calls) entry.tool_calls = m.tool_calls;
              if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
              if (m.name) entry.name = m.name;
              return entry;
            });
          codeSessionManager.saveMessages(sessionId, cleanMessages).catch(() => {});
        }
        // Durable event log — persist meaningful render events so the agent's
        // work survives the bridge dying / a server restart (replayed on reload).
        if (PERSIST_EVENT_TYPES.has(event.type)) {
          codeSessionManager.appendEvent(sessionId, event).catch(() => {});
        }
        // Forward to current ws — buffer if no ws attached (user left tab)
        const currentEntry = activeBridges.get(sessionId);
        const currentWs = currentEntry?.ws;
        if (currentWs && currentWs.readyState === 1) {
          currentWs.send(JSON.stringify(event));
        } else if (currentEntry && event.type !== "ping" && event.type !== "info") {
          // Buffer events for replay on reconnect
          if (!currentEntry.eventBuffer) currentEntry.eventBuffer = [];
          currentEntry.eventBuffer.push(event);
          // Cap buffer at 500 events to prevent unbounded growth
          if (currentEntry.eventBuffer.length > 500) currentEntry.eventBuffer.shift();
        }
      } catch (e) {
        console.error("[code-agent] Bridge parse error:", e.message, line.slice(0, 100));
      }
    }
  });

  // Handle stderr
  proc.stderr.on("data", (data) => {
    const text = data.toString();
    lastStderr = (lastStderr + text).slice(-1200);  // keep a short tail for diagnostics
    console.error("[code-agent] Bridge stderr:", text.trim());
  });

  proc.on("close", (code) => {
    const entry = activeBridges.get(sessionId);
    const currentWs = entry?.ws;
    activeBridges.delete(sessionId);
    if (currentWs && currentWs.readyState === 1) {
      // A clean shutdown (SIGTERM/code 0) after a normal session isn't an error worth showing.
      if (code && code !== 0 && code !== null) {
        const tail = lastStderr.trim();
        const detail = tail ? ` — ${tail.split("\n").slice(-3).join(" ").slice(-300)}` : "";
        currentWs.send(JSON.stringify({ type: "error", error: `Agent stopped unexpectedly (code ${code})${detail}` }));
      }
    }
    codeSessionManager.updateSessionStatus(sessionId, "idle").catch(() => {});

    // Worktree changes remain explicit: a bridge shutdown must never commit,
    // push, or open a PR as a side effect. The session workspace controls show
    // exactly what is dirty and let the admin choose the commit message.
  });

  // Send init config to bridge (with conversation history for context persistence)
  const sessionWithMessages = await codeSessionManager.getSession(sessionId);
  const history = (sessionWithMessages?.messages || []).map(m => {
    const entry = { role: m.role };
    if (m.content != null) entry.content = m.content;
    if (m.tool_calls) entry.tool_calls = m.tool_calls;
    if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
    if (m.name) entry.name = m.name;
    return entry;
  });

  // Fetch agent memories and inject into context
  let agentMemories = [];
  try {
    const db = await getDb();
    const mems = await db.collection("code_agent_memory").find({}).sort({ createdAt: -1 }).limit(20).toArray();
    agentMemories = mems.map(m => m.content);
  } catch {}

  const initMsg = JSON.stringify({
    type: "init",
    workdir: sessionDoc.worktreePath || REPO_DIR,
    model: (sessionDoc.model || LLM_MODEL || ""),
    apiKey: LLM_API_KEY,
    apiUrl: LLM_API_URL,
    provider: (sessionDoc.provider || LLM_PROVIDER || ""),
    hermesSessionId: sessionDoc.hermesSessionId || null,
    codexBin: resolveBinary("codex"),
    history: history,
    permissionMode: sessionDoc.permissionMode || "auto",
    memory: agentMemories,
  });
  proc.stdin.write(initMsg + "\n");

  // Forward messages from browser to bridge
  ws.on("message", async (raw) => {
    if (!await ws.authorize()) return;
    try {
      const rawStr = raw.toString();
      // Image payloads can be large — limit to 8MB per message
      if (rawStr.length > 8 * 1024 * 1024) {
        ws.send(JSON.stringify({ type: "error", error: "Message too large (max 8MB)" }));
        return;
      }
      const msg = JSON.parse(rawStr);
      // Handle attached images: save to temp files in the worktree
      if (msg.type === "message" && msg.images && Array.isArray(msg.images) && msg.images.length > 0) {
        const tmpDir = require("os").tmpdir();
        const savedPaths = [];
        for (const img of msg.images.slice(0, 4)) {
          try {
            const ext = (img.mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
            const tmpFile = path.join(tmpDir, `upload_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
            const data = img.data.replace(/^data:[^;]+;base64,/, "");
            fs.writeFileSync(tmpFile, Buffer.from(data, "base64"));
            savedPaths.push(tmpFile);
          } catch {}
        }
        if (savedPaths.length) {
          const imgNote = savedPaths.length === 1
            ? `\n\n[Attached image saved for your analysis: ${savedPaths[0]}]`
            : `\n\n[Attached images saved for your analysis:\n${savedPaths.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}]`;
          msg.content = (msg.content || "") + imgNote;
        }
        delete msg.images; // don't forward raw base64 to bridge
      }
      // Persist user messages server-side
      if (msg.type === "message" && msg.content) {
        pendingUserMessage = msg.content;
        codeSessionManager.appendMessage(sessionId, {
          role: "user", content: msg.content, timestamp: new Date()
        }).catch(() => {});
        codeSessionManager.appendEvent(sessionId, { type: "user_message", content: msg.content }).catch(() => {});
        // Codex resumes its native thread and ignores `msg.history`, so send
        // immediately while persistence completes in the background.
        if (isCodexRuntime) {
          if (proc.stdin.writable) {
            proc.stdin.write(JSON.stringify(msg) + "\n");
          }
          return;
        }
        // Attach latest history from MongoDB so bridge can recover context
        codeSessionManager.getSession(sessionId).then(async session => {
          if (!await ws.authorize()) return;
          if (session?.messages?.length) {
            msg.history = session.messages.map(m => {
              const entry = { role: m.role };
              if (m.content != null) entry.content = m.content;
              if (m.tool_calls) entry.tool_calls = m.tool_calls;
              if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
              if (m.name) entry.name = m.name;
              return entry;
            });
          }
          if (proc.stdin.writable) {
            proc.stdin.write(JSON.stringify(msg) + "\n");
          }
        }).catch(() => {
          // Fallback: send without history
          if (proc.stdin.writable) {
            proc.stdin.write(JSON.stringify(msg) + "\n");
          }
        });
        return;
      }
      if (proc.stdin.writable) {
        proc.stdin.write(JSON.stringify(msg) + "\n");
      }
    } catch {}
  });

  ws.on("close", () => {
    if (pingInterval) clearInterval(pingInterval);
    // Detach ws but keep bridge running — agent finishes work in background
    const entry = activeBridges.get(sessionId);
    if (entry) {
      entry.ws = null;
    }
    // Save partial progress if agent was mid-stream (as a checkpoint, not final)
    if (agentWorking && streamedTokens.length > 20) {
      console.log("[code-agent] Disconnect during active work — bridge continues in background");
      // Don't save premature "interrupted" message — let agent finish naturally
    }
  });
}

server.listen(PORT, process.env.BIND_HOST || "127.0.0.1", () => {
  console.log(`AHD Ops Dashboard listening on http://0.0.0.0:${PORT}`);
  console.log(`Backup dir: ${BACKUP_DIR}`);
  // Build the expensive cross-service snapshot after database bootstrap. The
  // proxy is promoted only after health reports this snapshot as ready.
  warmUntilReady(dashboardSnapshot);
  warmUntilReady(dashboardReportsSnapshot);
  // CodeBurn costs are expensive to compute (tens of seconds); warm them in the
  // background from the persisted snapshot so usage stats render immediately.
  startCostRefresher();
  // Warm the Agents page's remote reads too: `paseo daemon status` takes ~3s and
  // the token list crosses an SSH tunnel, so the first render should not pay it.
  paseoLauncher.daemonReadyCached().catch(() => {});
  getDb()
    .then(async (db) => { await agentTokens.ensureIndexes(db); await agentTokens.list(db); })
    .catch(() => {});
  const later = setTimeout(() => {
    enginePageSnapshot.refresh().catch(() => {});
    observatoryPageSnapshot.refresh().catch(() => {});
  }, 15_000);
  later.unref?.();
  // Save sessions on startup so the file is created even if no logins happen
  if (sessions.size > 0) saveSessions();
  if (process.env.EVENT_CONSUMER_ENABLED !== "false") {
    eventConsumers.start().catch(error => console.error("[event-consumers] start failed:", error));
  }
});

// Flush sessions to disk on graceful shutdown
function gracefulShutdown(signal) {
  console.log(`${signal} received, saving sessions...`);
  saveSessions();
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
