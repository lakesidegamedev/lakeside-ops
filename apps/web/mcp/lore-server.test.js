"use strict";

// Lore MCP server tests.
//
// The lore corpus is generated from the A House Divided game repo, so these
// tests use a small fixture corpus and check the MCP surface itself: the tools
// an agent can call, the resources it can read, the prompt it can render, and
// the promise that a missing corpus is an explicit error rather than invented
// lore.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const { createLoreServer } = require("./lore-server.js");

const FIXTURE = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  source: { repo: "AHDGame", commit: "fixture", branch: "fixture" },
  presets: ["1953-default"],
  countries: [
    {
      id: "DD",
      name: "East Germany",
      code: "DD",
      flagEmoji: "🇩🇩",
      regionLabel: "Region",
      regionLabelPlural: "Regions",
      status: "coming-soon",
      governmentType: "onePartyState",
      governmentTypeLabel: "One Party State",
      executiveTitle: "General Secretary",
      headOfStateTitle: "Chairman of the Council of State",
      currencyCode: "DDM",
      tagline: "The other Germany - a hard-line SED state.",
      descriptor: "A one-party socialist republic.",
      eras: [
        {
          preset: "1953-default",
          name: "East Germany",
          flagEmoji: "🇩🇩",
          governmentType: "onePartyState",
          governmentTypeLabel: "One Party State",
          executiveTitle: "General Secretary",
          tagline: "The other Germany - a hard-line SED state.",
          descriptor: "A one-party socialist republic.",
        },
      ],
    },
  ],
  worldEntities: [
    {
      entityId: "AL",
      displayName: "Albania",
      presetId: "1953-default",
      status: "sovereign",
      region: "europe",
      simulationTier: "background-macro",
      economicArchetype: "macro",
      parentEntityId: null,
      coParentEntityIds: [],
      exceptionalStatus: null,
      recognitionStatus: "widely-recognized",
      recognitionNotes: "People's Republic; limited Western recognition.",
      unState: "eligible",
      unMemberSinceYear: null,
      unExpectedAdmissionYear: 1955,
      lifecycle: { earliestYear: null, expectedYear: null, latestYear: null },
      authorNotes: ["UN admission Dec 1955."],
      mapFeatureIds: ["008"],
    },
  ],
  organizations: [
    {
      id: "NATO",
      name: "North Atlantic Treaty Organization",
      description: "A transatlantic military alliance.",
      charter: "Article 5 commits each member to collective defence.",
    },
  ],
  historicalEvents: [
    {
      id: "berlin-uprising-1953",
      year: 1953,
      countryId: "DD",
      title: "East German Uprising",
      description: "Strikes over work quotas spread into a nationwide revolt.",
    },
  ],
  wiki: [
    {
      slug: "elections",
      title: "Elections",
      description: "How elections are run in A House Divided.",
      category: "elections",
      tags: ["voting"],
      countryId: null,
      featured: true,
      difficulty: null,
      contentType: null,
      content: "# Elections\n\nEvery office is filled by an election.",
    },
  ],
  glossary: [
    { term: "AP", definition: "Action points.", aliases: ["action points"] },
    { term: "NPP", definition: "New Political Party.", aliases: [] },
  ],
  parties: [{ key: "republican", blurb: "Limited government and free markets.", tips: ["Strong in rural areas"] }],
};

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lore-corpus-"));
  const file = path.join(dir, "lore-corpus.json");
  fs.writeFileSync(file, JSON.stringify(FIXTURE), "utf8");
  return file;
}

async function connect(corpusPath) {
  const server = createLoreServer({ corpusPath });
  const client = new Client({ name: "lore-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test("the lore server exposes its tools, resources and prompt", async () => {
  const file = writeFixture();
  const { client } = await connect(file);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    "lore_countries",
    "lore_country",
    "lore_glossary",
    "lore_historical_events",
    "lore_organizations",
    "lore_overview",
    "lore_parties",
    "lore_wiki_page",
    "lore_wiki_search",
    "lore_world_entities",
    "lore_world_entity",
  ]);

  const resources = await client.listResources();
  assert.deepStrictEqual(resources.resources.map((r) => r.uri).sort(), [
    "lore://countries",
    "lore://glossary",
    "lore://history",
    "lore://overview",
  ]);

  const templates = await client.listResourceTemplates();
  assert.deepStrictEqual(templates.resourceTemplates.map((t) => t.uriTemplate).sort(), [
    "lore://country/{countryId}",
    "lore://organization/{id}",
    "lore://wiki/{slug}",
  ]);

  const prompts = await client.listPrompts();
  assert.deepStrictEqual(prompts.prompts.map((p) => p.name), ["world_brief"]);

  await client.close();
});

test("lore_country returns the game's own profile for a country", async () => {
  const file = writeFixture();
  const { client } = await connect(file);

  const result = payload(await client.callTool({ name: "lore_country", arguments: { country: "DD" } }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.country.name, "East Germany");
  assert.strictEqual(result.country.governmentTypeLabel, "One Party State");
  assert.strictEqual(result.country.eras.length, 1);

  const missing = payload(await client.callTool({ name: "lore_country", arguments: { country: "ZZ" } }));
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /no country matches/);

  await client.close();
});

test("lore_countries can answer for one era", async () => {
  const file = writeFixture();
  const { client } = await connect(file);

  const result = payload(await client.callTool({ name: "lore_countries", arguments: { preset: "1953-default" } }));
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.countries[0].executiveTitle, "General Secretary");

  const none = payload(await client.callTool({ name: "lore_countries", arguments: { q: "nothing matches this" } }));
  assert.strictEqual(none.count, 0);

  await client.close();
});

test("the wiki, glossary, history and organisations answer from the corpus", async () => {
  const file = writeFixture();
  const { client } = await connect(file);

  const search = payload(await client.callTool({ name: "lore_wiki_search", arguments: { q: "election" } }));
  assert.strictEqual(search.count, 1);
  assert.strictEqual(search.pages[0].slug, "elections");

  const page = payload(await client.callTool({ name: "lore_wiki_page", arguments: { slug: "elections" } }));
  assert.match(page.page.content, /Every office is filled by an election/);

  const glossary = payload(await client.callTool({ name: "lore_glossary", arguments: { term: "action points" } }));
  assert.strictEqual(glossary.count, 1);
  assert.strictEqual(glossary.terms[0].term, "AP");

  const history = payload(await client.callTool({ name: "lore_historical_events", arguments: { countryId: "DD" } }));
  assert.strictEqual(history.count, 1);
  assert.strictEqual(history.events[0].title, "East German Uprising");

  const org = payload(await client.callTool({ name: "lore_organizations", arguments: { id: "NATO" } }));
  assert.match(org.organization.charter, /Article 5/);

  await client.close();
});

test("resources read the corpus as documents", async () => {
  const file = writeFixture();
  const { client } = await connect(file);

  const country = await client.readResource({ uri: "lore://country/DD" });
  assert.match(country.contents[0].text, /East Germany/);

  const wiki = await client.readResource({ uri: "lore://wiki/elections" });
  assert.match(wiki.contents[0].text, /Every office is filled by an election/);

  const overview = await client.readResource({ uri: "lore://overview" });
  assert.match(overview.contents[0].text, /"countries": 1/);

  await client.close();
});

test("the world_brief prompt tells the agent how to use the lore tools", async () => {
  const file = writeFixture();
  const { client } = await connect(file);

  const prompt = await client.getPrompt({ name: "world_brief", arguments: { preset: "1953-default" } });
  const text = prompt.messages[0].content.text;
  assert.match(text, /1953-default/);
  assert.match(text, /lore_overview/);

  await client.close();
});

test("a missing corpus is an explicit error, never invented lore", async () => {
  const missing = path.join(os.tmpdir(), "lore-corpus-does-not-exist.json");
  const { client } = await connect(missing);

  const result = await client.callTool({ name: "lore_overview", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /lore corpus not found/);

  await client.close();
});
