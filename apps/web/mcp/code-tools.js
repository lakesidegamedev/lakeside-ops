"use strict";

// The agent code tools on ops-knowledge: code_search, code_exact, code_read.
//
// The game index is the one Ask answers players from (prod tracks main, dev
// tracks development). Semantic search still goes through Ask's retriever so
// agents ground a question the way the product does. Exact lookup and file
// reads go through ./code-index, which scans the indexed text literally and
// survives the 15-minute publish swap.
//
// Internal repositories (Keir, the client, the Discord bot, the sites) have
// their own index files outside everything Ask and the cloud sync read, and
// are served only to tokens explicitly allowed to read private code.

const path = require("path");
const { z } = require("zod");
const ci = require("./code-index");

const REPO_DESCRIPTION = [
  `Which code to search. Default "game": A House Divided (the game's code, engineering docs and player wiki).`,
  ...Object.entries(ci.INTERNAL_REPOS).map(([name, r]) => `"${name}": ${r.describe}`),
  `"${ci.ALL_INTERNAL}": every internal repository above. Pass a list to search several. Internal repositories need a token allowed to read private code.`,
].join(" ");

const repoArg = z.union([z.string(), z.array(z.string()).max(8)]).optional().describe(REPO_DESCRIPTION);

function registerCodeTools(server, {
  auth, tokens, jsonResult, errorResult,
  askRetrieve, gameIndexPath, devFallback,
  pool = defaultPool(), env = process.env,
}) {
  const canReadAny = () => (auth.scopes.collections || []).some((k) => tokens.canRead(auth, k));

  // Resolve the repo argument and enforce the internal-code grant.
  function repos(repo) {
    const r = ci.resolveRepos(repo);
    if (r.error) return r;
    const internal = r.repos.filter((name) => name !== ci.GAME);
    if (internal.length && !ci.canReadInternal(auth, env)) {
      return { error: `this token may not read internal repositories (${internal.join(", ")}). Search the game (the default) or ask for the internal-code grant.` };
    }
    return r;
  }

  // One index location per (repo, source).
  function target(name, source) {
    if (name === ci.GAME) {
      const idx = devFallback(source);
      return { repo: ci.GAME, file: gameIndexPath(idx.source), source: idx.source, fallback: idx.fallback, game: idx.game };
    }
    const file = ci.internalIndexPath(name, env);
    return { repo: name, file, source: "main", fallback: false, game: { id: `internal-${name}`, ragDb: file } };
  }

  function generation(t) {
    return pool.reader(t.file).get();
  }

  function indexInfo(t, gen) {
    return {
      repo: t.repo,
      index: t.repo === ci.GAME ? t.source : "default-branch",
      revision: gen ? ci.revisionOf(gen) : null,
      generation: gen ? gen.generation : null,
      ...(notes(t, gen).length ? { note: notes(t, gen).join("; ") } : {}),
    };
  }

  function notes(t, gen) {
    const out = [];
    if (t.fallback) out.push("dev index not built yet; served from the prod index");
    if (gen && gen.servedFrom === "previous") out.push("served from the previous index generation while the current one is being replaced");
    return out;
  }

  function unavailable(t, error) {
    return { repo: t.repo, error: error.message, retryable: error.retryable !== false };
  }

  server.tool(
    "code_search",
    "Hybrid (semantic + keyword + exact symbol) retrieval over indexed code. By default it searches A House Divided (code, engineering docs and player wiki: the index Ask answers players from); `repo` selects other studio code. Returns the chunks (repo, path, part, source kind, revision, score, text) plus the file list, and says when results were cut to fit maxChars. Ground a code or mechanics question here before reading files by hand; pass subQueries for a multi-part question.",
    {
      question: z.string().describe("Natural-language question, or a symbol or file name"),
      topK: z.number().int().min(1).max(24).optional().default(8),
      maxChars: z.number().int().min(2000).max(120000).optional().default(30000)
        .describe("Character budget for returned chunk text; results that do not fit are dropped and counted in droppedForBudget"),
      claimType: z.enum(["mechanic", "intent", "player_help", "general"]).optional()
        .describe("Which source kind wins conflicts (code for mechanics, docs for intent, wiki for player help); inferred from the question when omitted"),
      fusion: z.enum(["legacy", "v2"]).optional().describe("Fusion mode; legacy is what Ask serves today"),
      source: z.enum(["dev", "prod"]).optional().default("dev")
        .describe("Game only. dev tracks the development branch (default for agents on this box), prod tracks main, which is what Ask serves players"),
      subQueries: z.array(z.string()).max(4).optional().describe("Sub-questions of a multi-part question; each retrieves and the results merge"),
      repo: repoArg,
    },
    async ({ question, topK, maxChars, claimType, fusion, source, subQueries, repo }) => {
      if (!canReadAny()) return errorResult("token has no read scope");
      const chosen = repos(repo);
      if (chosen.error) return errorResult(chosen.error);
      let r;
      try { r = askRetrieve(); } catch (e) { return errorResult(`code search unavailable (retryable): ${e.message}`); }
      const all = [], indexes = [], failures = [];
      let degraded = null, claim = null;
      for (const name of chosen.repos) {
        const t = target(name, source);
        let gen = null;
        try { gen = generation(t); } catch (e) { failures.push(unavailable(t, e)); continue; }
        indexes.push(indexInfo(t, gen));
        // Ask's retriever applies the budget itself; ask it for everything and
        // apply the caller's budget here so the cut can be reported.
        const opts = { topK, maxChars: 120000, game: t.game, ...(claimType ? { claimType } : {}), ...(fusion ? { fusion } : {}) };
        let out = null;
        try {
          out = subQueries && subQueries.length ? await r.searchMulti(question, subQueries, opts) : await r.search(question, opts);
        } catch { out = null; }
        if (out && out.hits) {
          claim = claim || out.claimType;
          for (const h of out.hits) all.push({ ...h, repo: t.repo });
          continue;
        }
        // The retriever returns nothing when the query embedding fails or the
        // index could not be opened at that instant. The index is readable
        // (we hold a generation), so serve keyword matches and say so.
        const kw = ci.keywordSearch(gen, [question, ...(subQueries || [])].join(" "), { topK, maxChars: 120000 });
        degraded = "semantic search was unavailable for this request (embedding service error or index swap); these are keyword matches only. Retry for full results.";
        for (const h of kw.hits) all.push({ ...h, repo: t.repo, revision: h.revision || ci.revisionOf(gen) });
      }
      if (!all.length && failures.length) {
        return errorResult(`code index temporarily unavailable, retry in a minute: ${failures.map((f) => `${f.repo}: ${f.error}`).join("; ")}`);
      }
      const ranked = chosen.repos.length > 1 ? [...all].sort((a, b) => b.score - a.score).slice(0, topK) : all.slice(0, topK);
      const budgeted = ci.applyBudget(ranked, maxChars);
      return jsonResult({
        ...(chosen.repos.length === 1 ? indexes[0] || { repo: chosen.repos[0] } : { repos: indexes }),
        index: indexes[0]?.index, // back-compat: "dev" | "prod" for the game
        ...(degraded ? { degraded, retryable: true } : {}),
        ...(failures.length ? { unavailable: failures } : {}),
        claimType: claim, count: budgeted.count, files: budgeted.files,
        ...(budgeted.droppedForBudget ? { droppedForBudget: budgeted.droppedForBudget, budgetNote: `${budgeted.droppedForBudget} more result(s) did not fit maxChars=${maxChars}; raise maxChars to see them. Fewer results here does not mean fewer matches exist.` } : {}),
        hits: budgeted.hits.map((h) => ({
          repo: h.repo, path: h.path, part: h.ord + 1, source: h.source, revision: h.revision,
          score: Number(Number(h.score).toFixed(4)), text: h.text,
        })),
      });
    }
  );

  server.tool(
    "code_exact",
    "Exact lookup of literal symbols, phrases and paths. A single word or identifier (US_NATIONAL_CONFIG, ownSitesFirst) is matched as a whole identifier; a short sentence with no identifiers (an error message or UI text) is matched as one phrase; quoted text is a phrase; a path or file name returns that file. For every term it reports the definition sites with line numbers, the files that use it ranked definitions first, and whether the listing is complete. found:false with complete:true means the literal occurs in no indexed file at that revision. Default repo is the game; `repo` selects other studio code.",
    {
      question: z.string().describe("Identifiers, a quoted phrase, an error message, or a repository path"),
      limit: z.number().int().min(1).max(50).optional().default(8).describe("Files listed per term"),
      maxChars: z.number().int().min(2000).max(60000).optional().default(18000),
      source: z.enum(["dev", "prod"]).optional().default("dev").describe("Game only: dev (development branch, default) or prod (main)"),
      repo: repoArg,
    },
    async ({ question, limit, maxChars, source, repo }) => {
      if (!canReadAny()) return errorResult("token has no read scope");
      const chosen = repos(repo);
      if (chosen.error) return errorResult(chosen.error);
      const perRepo = [], failures = [];
      for (const name of chosen.repos) {
        const t = target(name, source);
        let gen;
        try { gen = generation(t); } catch (e) { failures.push(unavailable(t, e)); continue; }
        const out = ci.exactLookup(gen, question, { limit, maxChars: Math.floor(maxChars / chosen.repos.length) });
        perRepo.push({ ...indexInfo(t, gen), ...out });
      }
      if (!perRepo.length) return errorResult(`code index temporarily unavailable, retry in a minute: ${failures.map((f) => `${f.repo}: ${f.error}`).join("; ")}`);
      if (perRepo.every((p) => !p.terms.length)) return errorResult("no searchable literal in the question: give an identifier, a quoted phrase, or a path");
      if (perRepo.length === 1 && !failures.length) return jsonResult(perRepo[0]);
      const files = [];
      for (const p of perRepo) for (const f of p.files) files.push(`${p.repo}:${f}`);
      return jsonResult({
        repos: perRepo, files, count: files.length,
        found: perRepo.some((p) => p.found), complete: perRepo.every((p) => p.complete) && !failures.length,
        ...(failures.length ? { unavailable: failures } : {}),
      });
    }
  );

  server.tool(
    "code_read",
    "Read one indexed file by repository path (the `path` a code_search or code_exact hit reports), reassembled whole from its chunks, with its line count. Pass startLine/endLine to page through a long file; the response says when more remains. Default repo is the game; `repo` selects other studio code. Secrets and key material are never indexed.",
    {
      path: z.string().describe("Repository-relative path, e.g. src/lib/turn/billLifecycle/configs/us.ts (a unique file name also works)"),
      maxChars: z.number().int().min(2000).max(120000).optional().default(40000),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
      source: z.enum(["dev", "prod"]).optional().default("dev").describe("Game only: dev (development branch, default) or prod (main)"),
      repo: z.string().optional().describe(`One repository (default "game"). ${Object.keys(ci.INTERNAL_REPOS).join(", ")} are internal.`),
    },
    async ({ path: filePath, maxChars, startLine, endLine, source, repo }) => {
      if (!canReadAny()) return errorResult("token has no read scope");
      const chosen = repos(repo);
      if (chosen.error) return errorResult(chosen.error);
      if (chosen.repos.length !== 1) return errorResult("code_read takes one repo");
      const t = target(chosen.repos[0], source);
      let gen;
      try { gen = generation(t); } catch (e) { return errorResult(`code index temporarily unavailable, retry in a minute: ${e.message}`); }
      if (/(?:^|\/)\.env|\.(?:pem|key|p12|pfx)$/i.test(filePath)) return errorResult("secret files are never indexed");
      const out = ci.readFile(gen, filePath, { maxChars, startLine, endLine });
      if (!out) return errorResult(`not in the ${t.repo === ci.GAME ? t.source + " " : ""}${t.repo} index at revision ${ci.revisionOf(gen) || "unknown"}: ${filePath}`);
      if (out.error) return errorResult(out.error);
      if (out.ambiguous) return errorResult(`several indexed files match ${filePath}: ${out.ambiguous.join(", ")}`);
      // Back-compat fields: files/count/context as before.
      return jsonResult({ ...indexInfo(t, gen), ...out, files: [out.path], count: 1, context: out.content });
    }
  );
}

let _pool = null;
function defaultPool() {
  if (!_pool) _pool = ci.createReaderPool({ log: (m) => console.error(m) });
  return _pool;
}

module.exports = { registerCodeTools, REPO_DESCRIPTION };
