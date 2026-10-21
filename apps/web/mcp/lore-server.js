// Lore MCP — the A House Divided world, as read-only lore an agent can ask
// questions about.
//
// The corpus is generated from the game repo itself (AHDGame
// scripts/exportLoreCorpus.ts) and read from a JSON artifact on disk, so every
// answer is the game's own authored prose: country taglines and descriptors per
// era, the world entity registry (recognition notes, UN records, author notes),
// international organisation charters, the authored historical crisis entries,
// the player wiki, the glossary and the major-party blurbs.
//
// This server reads a file. It does not touch the game database, so it cannot
// slow a turn down or write anything a player would see.
//
// Streamable HTTP + scoped bearer-token auth.
//   node mcp/lore-server.js   (default :9750)
require("dotenv").config({ quiet: true, path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const express = require("express");
const { z } = require("zod");
const { McpServer, ResourceTemplate } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const store = require("../knowledge-store");
const tokens = require("../agent-tokens");

const PORT = parseInt(process.env.LORE_MCP_PORT || "9750", 10);
const CORPUS_PATH = process.env.LORE_CORPUS_PATH || "/root/misc/lore/lore-corpus.json";

// ─── Corpus ──────────────────────────────────────────────────────────────────
// Reloaded when the file changes on disk, so a refreshed corpus is picked up
// without a restart. A missing corpus is an explicit, loud error: the server
// says the corpus is absent rather than answering with invented lore.
function createCorpusReader(corpusPath) {
  let cached = null;
  let cachedMtime = 0;
  let cachedPath = null;
  return {
    path: corpusPath,
    load() {
      let stat;
      try {
        stat = fs.statSync(corpusPath);
      } catch {
        return { error: `lore corpus not found at ${corpusPath}. Regenerate it with: npx tsx scripts/exportLoreCorpus.ts --out ${corpusPath}` };
      }
      if (cached && cachedPath === corpusPath && cachedMtime === stat.mtimeMs) return { corpus: cached };
      try {
        const parsed = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
        cached = parsed;
        cachedMtime = stat.mtimeMs;
        cachedPath = corpusPath;
        return { corpus: parsed };
      } catch (e) {
        return { error: `lore corpus at ${corpusPath} could not be parsed: ${e.message}` };
      }
    },
  };
}

function corpusError(message) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }, null, 2) }], isError: true };
}

function text(s) {
  return String(s || "").toLowerCase();
}

function scoreMatch(haystack, needle) {
  if (!needle) return 0;
  const h = text(haystack);
  const n = text(needle);
  if (!h.includes(n)) return 0;
  // Title-ish match first, then body.
  return h === n ? 3 : 2;
}

function countryById(corpus, id) {
  const key = String(id || "").trim().toUpperCase();
  return corpus.countries.find((c) => c.id.toUpperCase() === key || c.code.toUpperCase() === key || c.name.toUpperCase() === key) || null;
}

function wikiBySlug(corpus, slug) {
  const key = String(slug || "").trim().toLowerCase();
  return corpus.wiki.find((p) => p.slug.toLowerCase() === key) || null;
}

function organizationById(corpus, id) {
  const key = String(id || "").trim().toUpperCase();
  return corpus.organizations.find((o) => o.id.toUpperCase() === key || o.name.toUpperCase() === key) || null;
}

function entityById(corpus, entityId, preset) {
  const key = String(entityId || "").trim().toUpperCase();
  const rows = corpus.worldEntities.filter((e) => e.entityId.toUpperCase() === key);
  if (!rows.length) return null;
  if (preset) {
    const exact = rows.find((e) => e.presetId === preset);
    if (exact) return exact;
  }
  return rows[0];
}

function entitySummary(e) {
  return {
    entityId: e.entityId,
    displayName: e.displayName,
    presetId: e.presetId,
    status: e.status,
    region: e.region,
    simulationTier: e.simulationTier,
    exceptionalStatus: e.exceptionalStatus,
    recognitionStatus: e.recognitionStatus,
    recognitionNotes: e.recognitionNotes,
    unState: e.unState,
    unMemberSinceYear: e.unMemberSinceYear,
    authorNotes: e.authorNotes,
  };
}

function countrySummary(c, preset) {
  const era = preset ? c.eras.find((e) => e.preset === preset) : null;
  return {
    id: c.id,
    name: era ? era.name : c.name,
    flagEmoji: era ? era.flagEmoji : c.flagEmoji,
    regionLabel: c.regionLabel,
    status: c.status,
    governmentType: era ? era.governmentType : c.governmentType,
    governmentTypeLabel: era ? era.governmentTypeLabel : c.governmentTypeLabel,
    executiveTitle: era ? era.executiveTitle : c.executiveTitle,
    currencyCode: c.currencyCode,
    tagline: era ? era.tagline : c.tagline,
    descriptor: era ? era.descriptor : c.descriptor,
  };
}

function jsonResult(o) {
  return { content: [{ type: "text", text: JSON.stringify(o, null, 2) }] };
}

function textResult(body, mime = "text/markdown") {
  return { content: [{ type: "text", text: body }], mimeType: mime };
}

function createLoreServer(options = {}) {
  const reader = createCorpusReader(options.corpusPath || CORPUS_PATH);
  const withCorpus = (fn) => {
    const { corpus, error } = reader.load();
    if (error) return corpusError(error);
    return fn(corpus);
  };
  const server = new McpServer({ name: "ops-lore", version: "1.0.0" });

  // ── Tools ────────────────────────────────────────────────────────────────
  server.tool(
    "lore_overview",
    "What this lore corpus contains and how to use it: source game commit, the eras (presets) it covers, and the counts of countries, world entities, organisations, historical events, wiki pages, glossary terms and party blurbs. Start here.",
    {},
    async () => withCorpus((corpus) => jsonResult({
      ok: true,
      source: corpus.source,
      generatedAt: corpus.generatedAt,
      presets: corpus.presets,
      counts: {
        countries: corpus.countries.length,
        worldEntities: corpus.worldEntities.length,
        organizations: corpus.organizations.length,
        historicalEvents: corpus.historicalEvents.length,
        wiki: corpus.wiki.length,
        glossary: corpus.glossary.length,
        parties: corpus.parties.length,
      },
      guide: [
        "lore_countries lists the playable and background countries with their one-line description.",
        "lore_country gives one country's full profile, including the per-era description.",
        "lore_world_entities covers the wider world: dependencies, disputed polities, UN status.",
        "lore_organizations gives the blocs and treaties (NATO, Warsaw Pact, UN, COMECON).",
        "lore_historical_events gives the authored history of the era.",
        "lore_wiki_search and lore_wiki_page give the player-facing codebook and country guides.",
        "lore_glossary explains the game's jargon; lore_parties gives party blurbs.",
      ],
    }))
  );

  server.tool(
    "lore_countries",
    "List the world's countries with their one-line tagline and a sentence describing their political system. Filter by era (preset) or a search term.",
    {
      preset: z.string().optional().describe('era preset id, e.g. "1953-default". Omit for the era-neutral entry.'),
      q: z.string().optional().describe("optional search term matched against name, tagline, descriptor and code"),
      limit: z.number().int().min(1).max(200).optional().default(100),
    },
    async ({ preset, q, limit }) => withCorpus((corpus) => {
      const rows = corpus.countries
        .map((c) => countrySummary(c, preset))
        .filter((c) => {
          if (!q) return true;
          return scoreMatch(`${c.name} ${c.id} ${c.tagline} ${c.descriptor}`, q) > 0;
        })
        .slice(0, limit);
      return jsonResult({ ok: true, preset: preset || null, count: rows.length, countries: rows });
    })
  );

  server.tool(
    "lore_country",
    "One country's full lore profile: institutions, government type, executive title, currency, tagline and description, plus the per-era description for every era the country appears in.",
    {
      country: z.string().describe("country id, code or name, e.g. US, DD, \"East Germany\""),
    },
    async ({ country }) => withCorpus((corpus) => {
      const c = countryById(corpus, country);
      if (!c) return jsonResult({ ok: false, error: `no country matches "${country}"`, known: corpus.countries.map((x) => x.id) });
      const wiki = corpus.wiki.filter((p) => p.countryId && p.countryId.toUpperCase() === c.id.toUpperCase());
      return jsonResult({
        ok: true,
        country: {
          id: c.id,
          name: c.name,
          code: c.code,
          flagEmoji: c.flagEmoji,
          regionLabel: c.regionLabel,
          regionLabelPlural: c.regionLabelPlural,
          status: c.status,
          governmentType: c.governmentType,
          governmentTypeLabel: c.governmentTypeLabel,
          executiveTitle: c.executiveTitle,
          headOfStateTitle: c.headOfStateTitle,
          currencyCode: c.currencyCode,
          tagline: c.tagline,
          descriptor: c.descriptor,
          eras: c.eras,
        },
        wikiPages: wiki.map((p) => ({ slug: p.slug, title: p.title, description: p.description, category: p.category })),
      });
    })
  );

  server.tool(
    "lore_world_entities",
    "The wider world beyond the playable countries: dependencies, contested polities, macro powers, their diplomatic recognition, UN status and the author's notes on how each is modelled.",
    {
      preset: z.string().optional().describe('era preset id, e.g. "1953-default"'),
      region: z.string().optional().describe("region: europe, americas, africa, asia, pacific"),
      status: z.string().optional().describe("entity status: sovereign, dependent, emergent, dissolved"),
      q: z.string().optional().describe("optional search term"),
      limit: z.number().int().min(1).max(500).optional().default(200),
    },
    async ({ preset, region, status, q, limit }) => withCorpus((corpus) => {
      const rows = corpus.worldEntities
        .filter((e) => (!preset || e.presetId === preset))
        .filter((e) => (!region || String(e.region || "").toLowerCase() === region.toLowerCase()))
        .filter((e) => (!status || e.status === status))
        .filter((e) => (!q || scoreMatch(`${e.entityId} ${e.displayName} ${e.recognitionNotes || ""} ${e.authorNotes.join(" ")}`, q) > 0))
        .slice(0, limit)
        .map(entitySummary);
      return jsonResult({ ok: true, count: rows.length, entities: rows });
    })
  );

  server.tool(
    "lore_world_entity",
    "One world entity's record: status, region, tier, parent or administering powers, exceptional status, recognition notes, UN record and the author's modelling notes.",
    {
      entity: z.string().describe("entity id, e.g. AL, SAH, SOM"),
      preset: z.string().optional().describe("era preset id; defaults to the entity's first era"),
    },
    async ({ entity, preset }) => withCorpus((corpus) => {
      const e = entityById(corpus, entity, preset);
      if (!e) return jsonResult({ ok: false, error: `no world entity matches "${entity}"` });
      const sameEra = corpus.worldEntities.filter((x) => x.entityId === e.entityId && x.presetId !== e.presetId).map(entitySummary);
      return jsonResult({ ok: true, entity, ...entitySummary(e), lifecycle: e.lifecycle, mapFeatureIds: e.mapFeatureIds, otherEras: sameEra });
    })
  );

  server.tool(
    "lore_organizations",
    "The world's international organisations and blocs (NATO, Warsaw Pact, UN, COMECON, Commonwealth, EU, Non-Aligned): what each is for and the terms of its charter.",
    {
      id: z.string().optional().describe("organisation id or name, e.g. NATO"),
    },
    async ({ id }) => withCorpus((corpus) => {
      if (id) {
        const org = organizationById(corpus, id);
        if (!org) return jsonResult({ ok: false, error: `no organisation matches "${id}"`, known: corpus.organizations.map((o) => o.id) });
        return jsonResult({ ok: true, organization: org });
      }
      return jsonResult({ ok: true, count: corpus.organizations.length, organizations: corpus.organizations });
    })
  );

  server.tool(
    "lore_historical_events",
    "The authored history of the eras: the crises and turning points the game itself is built around, with the year, the country and what happened.",
    {
      countryId: z.string().optional().describe("country id, e.g. DD"),
      yearFrom: z.number().int().optional(),
      yearTo: z.number().int().optional(),
      q: z.string().optional().describe("optional search term"),
    },
    async ({ countryId, yearFrom, yearTo, q }) => withCorpus((corpus) => {
      const rows = corpus.historicalEvents
        .filter((e) => (!countryId || String(e.countryId || "").toUpperCase() === countryId.toUpperCase()))
        .filter((e) => (yearFrom === undefined || e.year >= yearFrom))
        .filter((e) => (yearTo === undefined || e.year <= yearTo))
        .filter((e) => (!q || scoreMatch(`${e.title} ${e.description}`, q) > 0));
      return jsonResult({ ok: true, count: rows.length, events: rows });
    })
  );

  server.tool(
    "lore_wiki_search",
    "Search the player-facing wiki: the codebook (elections, legislatures, parties, economy, military, the turn loop) and the per-country guides. Returns page summaries; use lore_wiki_page for the full text.",
    {
      q: z.string().optional().describe("search term"),
      category: z.string().optional().describe("category filter, e.g. Economy & Finance"),
      countryId: z.string().optional().describe("country id filter"),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ q, category, countryId, limit }) => withCorpus((corpus) => {
      const rows = corpus.wiki
        .filter((p) => (!category || text(p.category).includes(text(category))))
        .filter((p) => (!countryId || String(p.countryId || "").toUpperCase() === countryId.toUpperCase()))
        .filter((p) => (!q || scoreMatch(`${p.title} ${p.description} ${p.tags.join(" ")} ${p.content}`, q) > 0))
        .slice(0, limit)
        .map((p) => ({ slug: p.slug, title: p.title, description: p.description, category: p.category, tags: p.tags, countryId: p.countryId, featured: p.featured }));
      return jsonResult({ ok: true, count: rows.length, pages: rows });
    })
  );

  server.tool(
    "lore_wiki_page",
    "One wiki page in full: the player-facing text for a slug from lore_wiki_search.",
    { slug: z.string().describe("wiki page slug") },
    async ({ slug }) => withCorpus((corpus) => {
      const page = wikiBySlug(corpus, slug);
      if (!page) return jsonResult({ ok: false, error: `no wiki page with slug "${slug}"` });
      return jsonResult({ ok: true, page });
    })
  );

  server.tool(
    "lore_glossary",
    "The game's jargon, defined: action points, political influence, NPP, GOTV, FPTP, RCV and the rest.",
    { term: z.string().optional().describe("term or alias to look up; omit for the whole glossary") },
    async ({ term }) => withCorpus((corpus) => {
      if (!term) return jsonResult({ ok: true, count: corpus.glossary.length, terms: corpus.glossary });
      const key = text(term);
      const rows = corpus.glossary.filter((g) => text(g.term) === key || text(g.aliases.join(" ")).includes(key));
      return jsonResult({ ok: true, count: rows.length, terms: rows });
    })
  );

  server.tool(
    "lore_parties",
    "The major parties' character: what each stands for, where it is strong, who it draws from.",
    { key: z.string().optional().describe("party key, e.g. republican, labour; omit for all") },
    async ({ key }) => withCorpus((corpus) => {
      if (!key) return jsonResult({ ok: true, count: corpus.parties.length, parties: corpus.parties });
      const needle = text(key);
      const rows = corpus.parties.filter((p) => text(p.key).includes(needle) || scoreMatch(p.blurb, needle) > 0);
      return jsonResult({ ok: true, count: rows.length, parties: rows });
    })
  );

  // ── Resources ────────────────────────────────────────────────────────────
  // The fleet's first MCP resources: lore as documents an agent can read
  // whole, rather than only as tool output.
  server.registerResource(
    "lore-overview",
    "lore://overview",
    { title: "Lore corpus overview", description: "What the lore corpus holds, where it came from and how to query it.", mimeType: "application/json" },
    async (uri) => {
      const { corpus, error } = reader.load();
      if (error) return { contents: [{ uri: uri.href, text: error, mimeType: "text/plain" }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify({ source: corpus.source, generatedAt: corpus.generatedAt, presets: corpus.presets, counts: { countries: corpus.countries.length, worldEntities: corpus.worldEntities.length, organizations: corpus.organizations.length, historicalEvents: corpus.historicalEvents.length, wiki: corpus.wiki.length, glossary: corpus.glossary.length, parties: corpus.parties.length } }, null, 2), mimeType: "application/json" }] };
    }
  );

  server.registerResource(
    "lore-countries",
    "lore://countries",
    { title: "Every country", description: "All countries with their tagline and political-system description.", mimeType: "application/json" },
    async (uri) => {
      const { corpus, error } = reader.load();
      if (error) return { contents: [{ uri: uri.href, text: error, mimeType: "text/plain" }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify(corpus.countries.map((c) => countrySummary(c, null)), null, 2), mimeType: "application/json" }] };
    }
  );

  server.registerResource(
    "lore-history",
    "lore://history",
    { title: "The authored history", description: "The authored crises and turning points of the eras.", mimeType: "application/json" },
    async (uri) => {
      const { corpus, error } = reader.load();
      if (error) return { contents: [{ uri: uri.href, text: error, mimeType: "text/plain" }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify(corpus.historicalEvents, null, 2), mimeType: "application/json" }] };
    }
  );

  server.registerResource(
    "lore-glossary",
    "lore://glossary",
    { title: "The glossary", description: "Every game term defined.", mimeType: "application/json" },
    async (uri) => {
      const { corpus, error } = reader.load();
      if (error) return { contents: [{ uri: uri.href, text: error, mimeType: "text/plain" }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify(corpus.glossary, null, 2), mimeType: "application/json" }] };
    }
  );

  server.registerResource(
    "lore-country",
    new ResourceTemplate("lore://country/{countryId}", { list: undefined }),
    { title: "One country", description: "A country's full lore profile, including every era's description.", mimeType: "application/json" },
    async (uri, variables) => {
      const { corpus, error } = reader.load();
      if (error) return { contents: [{ uri: uri.href, text: error, mimeType: "text/plain" }] };
      const c = countryById(corpus, variables.countryId);
      if (!c) return { contents: [{ uri: uri.href, text: `no country matches "${variables.countryId}"`, mimeType: "text/plain" }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify(c, null, 2), mimeType: "application/json" }] };
    }
  );

  server.registerResource(
    "lore-wiki-page",
    new ResourceTemplate("lore://wiki/{slug}", { list: undefined }),
    { title: "A wiki page", description: "One player-facing wiki page in full.", mimeType: "text/markdown" },
    async (uri, variables) => {
      const { corpus, error } = reader.load();
      if (error) return { contents: [{ uri: uri.href, text: error, mimeType: "text/plain" }] };
      const page = wikiBySlug(corpus, variables.slug);
      if (!page) return { contents: [{ uri: uri.href, text: `no wiki page with slug "${variables.slug}"`, mimeType: "text/plain" }] };
      return { contents: [{ uri: uri.href, text: page.content, mimeType: "text/markdown" }] };
    }
  );

  server.registerResource(
    "lore-organization",
    new ResourceTemplate("lore://organization/{id}", { list: undefined }),
    { title: "An international organisation", description: "One organisation's description and charter.", mimeType: "application/json" },
    async (uri, variables) => {
      const { corpus, error } = reader.load();
      if (error) return { contents: [{ uri: uri.href, text: error, mimeType: "text/plain" }] };
      const org = organizationById(corpus, variables.id);
      if (!org) return { contents: [{ uri: uri.href, text: `no organisation matches "${variables.id}"`, mimeType: "text/plain" }] };
      return { contents: [{ uri: uri.href, text: JSON.stringify(org, null, 2), mimeType: "application/json" }] };
    }
  );

  // ── Prompts ──────────────────────────────────────────────────────────────
  server.registerPrompt(
    "world_brief",
    {
      title: "Brief me on this world",
      description: "A briefing on the A House Divided world, drawn from the lore corpus.",
      argsSchema: {
        preset: z.string().optional().describe('era preset id, e.g. "1953-default"'),
        focus: z.string().optional().describe("what to focus on: a country, a region, the blocs, or the mechanics"),
      },
    },
    ({ preset, focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Brief me on the A House Divided world${preset ? ` as it stands in ${preset}` : ""}${focus ? `, focusing on ${focus}` : ""}.`,
              "",
              "Use the lore tools: lore_overview first, then lore_countries, lore_world_entities, lore_organizations, lore_historical_events and lore_wiki_search as the question needs them.",
              "Keep it in plain words, say which era you are describing, and name the game source (country, era, wiki page) behind each claim.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  return server;
}

async function main() {
  const opsDb = await store.getDb(process.env.MONGODB_URI);
  await tokens.ensureIndexes(opsDb);
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const healthReader = createCorpusReader(CORPUS_PATH);

  app.get("/healthz", (_q, r) => {
    const { corpus, error } = healthReader.load();
    r.json({
      ok: !error,
      service: "lore-mcp",
      port: PORT,
      corpusPath: CORPUS_PATH,
      corpusError: error || null,
      source: corpus ? corpus.source : null,
      generatedAt: corpus ? corpus.generatedAt : null,
      counts: corpus
        ? {
            countries: corpus.countries.length,
            worldEntities: corpus.worldEntities.length,
            organizations: corpus.organizations.length,
            historicalEvents: corpus.historicalEvents.length,
            wiki: corpus.wiki.length,
            glossary: corpus.glossary.length,
            parties: corpus.parties.length,
          }
        : null,
    });
  });


  app.post("/mcp", async (req, res) => {
    const auth = await tokens.validate(opsDb, req.headers["authorization"]);
    if (!auth) { res.status(401).json(rpcErr(-32001, "invalid or missing bearer token")); return; }
    const server = createLoreServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (e) {
      console.error("[lore-mcp] error:", e);
      if (!res.headersSent) res.status(500).json(rpcErr(-32603, "internal error"));
    }
  });

  app.listen(PORT, process.env.MCP_BIND || "127.0.0.1", () => console.log(`[lore-mcp] on :${PORT} (corpus ${CORPUS_PATH})`));
}

function rpcErr(code, message) { return { jsonrpc: "2.0", error: { code, message }, id: null }; }

if (require.main === module) {
  main().catch((e) => { console.error("[lore-mcp] fatal:", e); process.exit(1); });
}

module.exports = { CORPUS_PATH, createLoreServer, createCorpusReader, countryById, entitySummary, countrySummary };
