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
// their own index files outside everything Ask and the cloud sync read.
// Access is per repository: public repositories (Keir and the ops site, the
// client, the Discord bot) are open to any caller trusted with the game's
// code; private ones need a grant bound to the credential's identity, and
// their results are labelled so a model does not repeat them to players.

const path = require("path");
const { z } = require("zod");
const ci = require("./code-index");
const { createCheckoutScanner } = require("./checkout-scan");

const PUBLIC_REPOS = Object.entries(ci.INTERNAL_REPOS).filter(([, r]) => r.visibility === "public").map(([n]) => n);
const PRIVATE_REPOS = Object.entries(ci.INTERNAL_REPOS).filter(([, r]) => r.visibility !== "public").map(([n]) => n);
const REPO_DESCRIPTION = [
  `Which code to search. Default "game": A House Divided (the game's code, engineering docs and player wiki).`,
  ...Object.entries(ci.INTERNAL_REPOS).map(([name, r]) => `"${name}" (${r.visibility}): ${r.describe}`),
  `"${ci.ALL_INTERNAL}": every repository above this credential may read. Pass a list to search several.`,
  `${["game", ...PUBLIC_REPOS].join(", ")} are public code. ${PRIVATE_REPOS.join(", ")} are private studio code and need a credential with the private-code grant; their results are marked visibility: private and must never be quoted or described to players.`,
].join(" ");

const repoArg = z.union([z.string(), z.array(z.string()).max(8)]).optional().describe(REPO_DESCRIPTION);

function registerCodeTools(server, {
  auth, tokens, jsonResult, errorResult,
  askRetrieve, gameIndexPath, devFallback,
  pool = defaultPool(), env = process.env,
}) {
  const canReadAny = () => (auth.scopes.collections || []).some((k) => tokens.canRead(auth, k));

  // Private-tier code needs an explicit grant bound to this credential's
  // identity (see code-index canReadPrivate). Public-tier repositories are
  // open to anyone this server already trusts with the game's code.
  const privateOk = ci.canReadPrivate(auth, env);
  const refusal = (names) => `${names.join(", ")}: private studio code; this credential has no private-code grant. Without it you can search ${["game", ...PUBLIC_REPOS].join(", ")}.`;

  // Resolve the repo argument. A private repository the caller named is an
  // error; one that only came from "all-internal" is skipped and listed.
  function repos(repo) {
    const r = ci.resolveRepos(repo);
    if (r.error) return r;
    const out = [], skipped = [], refused = [];
    for (const name of r.repos) {
      if (ci.repoTier(name) === "private" && !privateOk) { (r.expanded.has(name) ? skipped : refused).push(name); continue; }
      out.push(name);
    }
    if (refused.length) return { error: refusal(refused) };
    if (!out.length) return { error: refusal(skipped) };
    return { repos: out, skipped };
  }

  // After opening an index: a repository configured public is served as public
  // only while its index says the repository is public on GitHub.
  function admitted(name, gen) {
    const tier = ci.repoTier(name, gen);
    return { ok: tier === "public" || privateOk, tier };
  }

  function accessFields(chosen, tiers) {
    const out = {};
    if (chosen.skipped && chosen.skipped.length) out.notSearched = `${chosen.skipped.join(", ")} (private; this credential has no private-code grant)`;
    if (tiers.includes("private")) out.privateNotice = ci.PRIVATE_NOTICE;
    return out;
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

  // The checkout each game index is built from. Exact lookup scans the files
  // the index leaves out by reading the indexed commit from its object store.
  // "off" disables the scan (lookups then say they covered indexed files only).
  const GAME_CHECKOUTS = {
    prod: env.CODE_INDEX_GAME_CHECKOUT_PROD || "/root/projects/LSGD-ops-dash/ahd-sandbox",
    dev: env.CODE_INDEX_GAME_CHECKOUT_DEV || "/root/projects/LSGD-ops-dash/ahd-sandbox-dev",
  };
  function scannerFor(t, gen) {
    if (t.repo !== ci.GAME || !gen.sourceAware) return null;
    if (gen._scanner !== undefined) return gen._scanner;
    const dir = GAME_CHECKOUTS[t.source];
    const row = (gen.revisions || []).find((r) => r.kind === "code");
    if (!dir || dir === "off" || !row) return (gen._scanner = null);
    const indexed = new Set(gen.db.prepare("SELECT DISTINCT path FROM chunks WHERE repository=?").pluck().all(row.repository));
    gen._scanner = createCheckoutScanner({ gitDir: dir, revision: row.revision, indexed });
    return gen._scanner;
  }

  function indexInfo(t, gen) {
    return {
      repo: t.repo,
      visibility: ci.repoTier(t.repo, gen),
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
    if (gen && gen.stale) out.push(gen.stale);
    return out;
  }

  function unavailable(t, error) {
    return { repo: t.repo, error: error.message, retryable: error.retryable !== false };
  }

  // One message for repositories that could not be read: "not built yet" is
  // permanent until a build runs; anything else is worth a retry.
  function unavailableMessage(failures) {
    const transient = failures.some((f) => f.retryable);
    const detail = failures.map((f) => `${f.repo}: ${f.error}`).join("; ");
    return transient ? `code index temporarily unavailable, retry in a minute: ${detail}` : `code index not available: ${detail}`;
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
      const indexes = [], failures = [], refused = [], tiers = [];
      const opened = [];
      for (const name of chosen.repos) {
        const t = target(name, source);
        let gen = null;
        try { gen = generation(t); } catch (e) { failures.push(unavailable(t, e)); continue; }
        const access = admitted(name, gen);
        if (!access.ok) { refused.push(name); continue; }
        tiers.push(access.tier);
        indexes.push(indexInfo(t, gen));
        opened.push({ t, gen, access });
      }
      if (!indexes.length) return errorResult([refused.length ? refusal(refused) : "", failures.length ? unavailableMessage(failures) : ""].filter(Boolean).join(" "));
      let degraded = null, claim = null;
      const keywordFallback = (o, why) => {
        degraded = why;
        return ci.keywordSearch(o.gen, [question, ...(subQueries || [])].join(" "), { topK, maxChars: 120000 }).hits
          .map((h) => ({ ...h, revision: h.revision || ci.revisionOf(o.gen) }));
      };
      const SLOW = "semantic search was unavailable or too slow for this request (embedding service error, timeout or index swap); these are keyword matches only. Retry for full results.";
      // The game goes through Ask's retriever, as before, but never longer than
      // the deadline: past it the caller gets keyword matches now.
      const game = opened.filter((o) => o.t.repo === ci.GAME);
      const internal = opened.filter((o) => o.t.repo !== ci.GAME);
      const gameLists = game.map(async (o) => {
        const opts = { topK, maxChars: 120000, game: o.t.game, ...(claimType ? { claimType } : {}), ...(fusion ? { fusion } : {}) };
        const out = await withDeadline(subQueries && subQueries.length ? r.searchMulti(question, subQueries, opts) : r.search(question, opts), Number(env.CODE_SEARCH_DEADLINE_MS || SEARCH_DEADLINE_MS));
        if (out && out.hits) { claim = claim || out.claimType; return out.hits; }
        return keywordFallback(o, SLOW);
      });
      // Every internal repository shares ONE query embedding, bounded the same way.
      const internalLists = (async () => {
        if (!internal.length) return [];
        const qv = typeof r.embedQuery === "function" ? await withDeadline(r.embedQuery(question), Number(env.CODE_SEARCH_EMBED_DEADLINE_MS || EMBED_DEADLINE_MS)) : null;
        return internal.map((o) => {
          const out = qv ? ci.hybridSearch(o.gen, qv, [question, ...(subQueries || [])].join(" "), { topK }) : null;
          return out ? out.hits : keywordFallback(o, SLOW);
        });
      })();
      const lists = [...(await Promise.all(gameLists)), ...(await internalLists)];
      const order = [...game, ...internal];
      const tagged = lists.map((list, i) => list.map((h) => ({ ...h, repo: order[i].t.repo, visibility: order[i].access.tier })));
      const ranked = tagged.length > 1 ? ci.interleave(tagged, topK) : (tagged[0] || []).slice(0, topK);
      const budgeted = ci.applyBudget(ranked, maxChars);
      return jsonResult({
        ...(chosen.repos.length === 1 ? indexes[0] || { repo: chosen.repos[0] } : { repos: indexes }),
        index: indexes[0]?.index, // back-compat: "dev" | "prod" for the game
        ...(degraded ? { degraded, retryable: true } : {}),
        ...(failures.length ? { unavailable: failures } : {}),
        ...accessFields({ skipped: [...(chosen.skipped || []), ...refused] }, tiers),
        claimType: claim, count: budgeted.count, files: budgeted.files,
        ...(budgeted.droppedForBudget ? { droppedForBudget: budgeted.droppedForBudget, budgetNote: `${budgeted.droppedForBudget} more result(s) did not fit maxChars=${maxChars}; raise maxChars to see them. Fewer results here does not mean fewer matches exist.` } : {}),
        hits: budgeted.hits.map((h) => ({
          repo: h.repo, visibility: h.visibility, path: h.path, part: h.ord + 1, source: h.source, revision: h.revision,
          score: Number(Number(h.score).toFixed(4)), text: h.text,
        })),
      });
    }
  );

  server.tool(
    "code_exact",
    "Exact lookup of literal symbols, phrases and paths. A single word or identifier (US_NATIONAL_CONFIG, ownSitesFirst) is matched as a whole identifier; a short sentence with no identifiers (an error message or UI text) is matched as one phrase; quoted text is a phrase; a path or file name returns that file. Phrases match across line breaks and spacing; a name in another case is matched ignoring case when the exact case is absent (matchedCase says which). For every term it reports the definition sites with line numbers and the files that use it, ranked definitions first. `scope` states the revision and what was searched. For the game, files the index leaves out (UI strings in messages/, scripts/) are scanned at the same revision and marked inIndex:false. complete:true means every text file of that repository at that revision was searched and nothing was cut; complete:false with found:false is NOT evidence that the text does not exist (read `incomplete` or `truncated`). Default repo is the game; `repo` selects other studio code.",
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
      const perRepo = [], failures = [], refused = [], tiers = [];
      for (const name of chosen.repos) {
        const t = target(name, source);
        let gen;
        try { gen = generation(t); } catch (e) { failures.push(unavailable(t, e)); continue; }
        const access = admitted(name, gen);
        if (!access.ok) { refused.push(name); continue; }
        tiers.push(access.tier);
        const out = await ci.exactLookup(gen, question, { limit, maxChars: Math.floor(maxChars / chosen.repos.length), scanner: scannerFor(t, gen) });
        perRepo.push({ ...indexInfo(t, gen), ...out });
      }
      if (!perRepo.length) return errorResult([refused.length ? refusal(refused) : "", failures.length ? unavailableMessage(failures) : ""].filter(Boolean).join(" "));
      if (perRepo.every((p) => !p.terms.length)) return errorResult("no searchable literal in the question: give an identifier, a quoted phrase, or a path");
      const access = accessFields({ skipped: [...(chosen.skipped || []), ...refused] }, tiers);
      if (perRepo.length === 1 && !failures.length) return jsonResult({ ...perRepo[0], ...access, ...(access.notSearched ? { complete: false } : {}) });
      const files = [];
      for (const p of perRepo) for (const f of p.files) files.push(`${p.repo}:${f}`);
      return jsonResult({
        repos: perRepo, files, count: files.length,
        found: perRepo.some((p) => p.found), complete: perRepo.every((p) => p.complete) && !failures.length && !access.notSearched,
        ...(failures.length ? { unavailable: failures } : {}),
        ...access,
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
      repo: z.string().optional().describe(`One repository (default "game"). Public: ${["game", ...PUBLIC_REPOS].join(", ")}. Private (needs the private-code grant): ${PRIVATE_REPOS.join(", ")}.`),
    },
    async ({ path: filePath, maxChars, startLine, endLine, source, repo }) => {
      if (!canReadAny()) return errorResult("token has no read scope");
      const chosen = repos(repo);
      if (chosen.error) return errorResult(chosen.error);
      if (chosen.repos.length !== 1) return errorResult("code_read takes one repo");
      const t = target(chosen.repos[0], source);
      let gen;
      try { gen = generation(t); } catch (e) { return errorResult(unavailableMessage([unavailable(t, e)])); }
      const access = admitted(t.repo, gen);
      if (!access.ok) return errorResult(refusal([t.repo]));
      const label = access.tier === "private" ? { privateNotice: ci.PRIVATE_NOTICE } : {};
      if (/(?:^|\/)\.env|\.(?:pem|key|p12|pfx)$/i.test(filePath)) return errorResult("secret files are never indexed");
      const out = ci.readFile(gen, filePath, { maxChars, startLine, endLine });
      if (!out) {
        // Not indexed: a game file can still be read from the indexed revision.
        const scanner = scannerFor(t, gen);
        const key = String(filePath || "").trim().replace(/^\.\//, "").replace(/:\d+$/, "");
        if (scanner && key && !key.includes("..") && !key.startsWith("/")) {
          const r = await scanner.read(key);
          if (r.status === "found") {
            const page = ci.pageText(r.text, { maxChars, startLine, endLine });
            return jsonResult({ ...indexInfo(t, gen), path: r.path, source: "code", inIndex: false, note: "this file is not in the index; it was read from the repository at the indexed revision", ...page, files: [r.path], count: 1, context: page.content });
          }
          if (r.status === "ambiguous") return errorResult(`several files match ${filePath}: ${r.paths.join(", ")}`);
          if (r.status === "excluded") return errorResult(`${r.path} exists at revision ${ci.revisionOf(gen)} but is ${r.reason}`);
          if (r.status === "absent") return errorResult(`no file ${filePath} in the ${t.source} game repository at revision ${ci.revisionOf(gen) || "unknown"}`);
        }
        return errorResult(`not in the ${t.repo === ci.GAME ? t.source + " " : ""}${t.repo} index at revision ${ci.revisionOf(gen) || "unknown"}: ${filePath} (files the index leaves out were not searched)`);
      }
      if (out.error) return errorResult(out.error);
      if (out.ambiguous) return errorResult(`several indexed files match ${filePath}: ${out.ambiguous.join(", ")}`);
      // Back-compat fields: files/count/context as before.
      return jsonResult({ ...indexInfo(t, gen), ...label, ...out, files: [out.path], count: 1, context: out.content });
    }
  );
}

// How long an agent waits for semantic search before it gets keyword matches.
// Keir's client gives up at 30 s; its evidence pack allows 6 s.
// Overridable per process with CODE_SEARCH_DEADLINE_MS / CODE_SEARCH_EMBED_DEADLINE_MS.
const SEARCH_DEADLINE_MS = 8000;
const EMBED_DEADLINE_MS = 5000;

// Resolves to the promise's value, or null once `ms` pass (or on rejection).
// The underlying work is not cancelled; the caller simply stops waiting.
function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

let _pool = null;
function defaultPool() {
  if (!_pool) _pool = ci.createReaderPool({ log: (m) => console.error(m) });
  return _pool;
}

module.exports = { registerCodeTools, REPO_DESCRIPTION, withDeadline };
