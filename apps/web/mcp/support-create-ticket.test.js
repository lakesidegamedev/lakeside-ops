"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { registerCreateTicket, sendWithRetry, createSupportTicket, findGuildMemberByUsername } = require("./support-create-ticket");

const chain = new Proxy({}, { get: () => () => chain });
const z = { string: () => chain, enum: () => chain, array: () => chain };

function createHarness({ reserveStatus = 200 } = {}) {
  const calls = [];
  let handler;
  const server = { tool: (_name, _description, _schema, fn) => { handler = fn; } };
  const originalFetch = global.fetch;
  const originalEnv = {
    DISCORD_BOT_API_KEY: process.env.DISCORD_BOT_API_KEY,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    AHD_GAME_API_URL: process.env.AHD_GAME_API_URL,
  };
  Object.assign(process.env, {
    DISCORD_BOT_API_KEY: "test-key",
    DISCORD_BOT_TOKEN: "test-token",
    AHD_GAME_API_URL: "https://game.example",
  });
  global.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: target.toString(), method: init.method || "GET", body });
    if (target.hostname === "discord.com") {
      if (target.pathname.endsWith("/members/bot-id")) {
        return response({ user: { id: "bot-id", username: "StarmerBot", global_name: "Keir" }, nick: null });
      }
      if (target.pathname.endsWith("/members/reporter-id")) {
        return response({ user: { id: "reporter-id", username: "reporter", global_name: "Reporter" }, nick: null });
      }
      if (target.pathname === "/api/v10/guilds/1465445442987888743/channels" && !init.method) {
        return response([{
          id: "old-channel",
          name: "ticket-bug-example-1438",
          type: 0,
          parent_id: "ticket-category",
          permission_overwrites: [{ id: "1465445442987888743", type: 0, allow: "0", deny: "1024" }],
        }]);
      }
      if (target.pathname === "/api/v10/users/@me") return response({ id: "bot-id" });
      if (target.pathname === "/api/v10/guilds/1465445442987888743/channels" && init.method === "POST") {
        return response({ id: "new-channel", name: body.name });
      }
      if (target.pathname === "/api/v10/channels/new-channel/messages" && init.method === "POST") {
        return response({ id: "opening-card", embeds: body.embeds });
      }
      if (target.pathname === "/api/v10/channels/new-channel/messages/opening-card" && init.method === "PATCH") {
        return response({ id: "opening-card", embeds: body.embeds, components: body.components });
      }
      if (target.pathname.startsWith("/api/v10/channels/new-channel/messages/opening-card/reactions/") && init.method === "PUT") {
        return response({});
      }
      if (target.pathname === "/api/v10/channels/source-channel/messages" && init.method === "POST") {
        return response({ id: `source-${calls.length}` });
      }
      throw new Error(`Unexpected Discord call: ${init.method || "GET"} ${target.pathname}`);
    }
    if (target.pathname.endsWith("/tickets/reserve")) {
      return new Response(reserveStatus === 200 ? JSON.stringify({ ticketNumber: 1439 }) : "unavailable", { status: reserveStatus });
    }
    if (target.pathname.endsWith("/tickets") && init.method === "POST") return response({ ticketNumber: 1439, contextQuestions: ["Confirm platform and app version."], id: "backend-id" });
    if (target.pathname.endsWith("/tickets") && !init.method) return response({ ticketNumber: 1439, discordUserId: "reporter-id", intakeSuggestion: { candidatePageUrl: "https://ahousedividedgame.com/market", platformLabel: "Windows laptop Edge", gameVersion: "1.13.0", clientVersion: null } });
    if (target.pathname.endsWith("/tickets") && init.method === "PATCH") return response({ ok: true });
    throw new Error(`Unexpected API call: ${target}`);
  };
  registerCreateTicket(server, {
    auth: { scopes: { write: true } },
    Tickets: {},
    z,
    jsonResult: (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
    errorResult: (message) => ({ isError: true, content: [{ type: "text", text: message }] }),
    ticketPublicUrl: (number) => `https://ops.example/t/${number}`,
  });
  return {
    calls,
    run: (values = {}) => handler({
      discord_user_id: "reporter-id",
      category: "bug",
      title: "Market is broken",
      description: "The market page fails.",
      source_channel_id: "source-channel",
      ...values,
    }),
    restore() {
      global.fetch = originalFetch;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("sendWithRetry", () => {
  it("retries an ambiguous message response with the same enforced nonce", async () => {
    const attempts = [];
    const send = async (_path, init) => {
      attempts.push(JSON.parse(init.body));
      if (attempts.length === 1) throw new Error("connection reset after Discord accepted message");
      return { id: "message-id" };
    };
    const wait = async () => {};

    assert.equal(
      await sendWithRetry("ticket-channel", { content: "Your support receipt" }, "t1439-receipt", send, wait),
      true,
    );
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], {
      content: "Your support receipt",
      nonce: "t1439-receipt",
      enforce_nonce: true,
    });
    assert.deepEqual(attempts[1], attempts[0]);
  });
});

describe("support_create_ticket", () => {
  it("reserves before channel creation and puts the receipt and intake controls on one persistent card", async () => {
    const harness = createHarness();
    try {
      const result = await harness.run();
      const reserveAt = harness.calls.findIndex((call) => call.url.endsWith("/tickets/reserve"));
      const channelAt = harness.calls.findIndex((call) => call.method === "POST" && call.url.includes("/guilds/") && call.url.endsWith("/channels"));
      assert.ok(reserveAt >= 0 && reserveAt < channelAt, "reservation must precede channel creation");
      assert.equal(harness.calls[reserveAt].body.discordFloor, 1438);
      assert.match(harness.calls[channelAt].body.name, /-1439$/);
      const registered = harness.calls.find((call) => call.url.endsWith("/api/discord-bot/tickets"));
      assert.equal(registered.body.ticketNumber, 1439);
      assert.equal(registered.body.discordChannelId, "new-channel");
      const sent = harness.calls.filter((call) => call.method === "POST" && call.url.endsWith("/messages")).map((call) => call.body);
      assert.ok(sent.some((body) => (body.content || "").includes("Starmer opened a ticket on behalf of")));
      assert.ok(sent.find((body) => body.content?.startsWith("Starmer opened a ticket"))?.enforce_nonce);
      const embedFields = sent.find((body) => body.embeds)?.embeds[0].fields;
      assert.ok(embedFields.find((field) => field.name === "Opened by").value.includes("<@bot-id>"));
      assert.ok(embedFields.find((field) => field.name === "Reporter").value.includes("<@reporter-id>"));
      assert.ok(embedFields.find((field) => field.name === "Affected page / issue"));
      assert.ok(embedFields.find((field) => field.name === "Platform and versions").value.includes("Platform unknown"));
      const editedCard = harness.calls.find((call) => call.method === "PATCH" && call.url.endsWith("/messages/opening-card"));
      assert.equal(editedCard.body.embeds[0].fields.find((field) => field.name === "Receipt").value, "[View ticket receipt](https://ops.example/t/1439)");
      assert.match(editedCard.body.embeds[0].fields.find((field) => field.name === "Affected page / issue").value, /\/market/);
      assert.equal(editedCard.body.embeds[0].fields.find((field) => field.name === "Platform and versions").value, "Desktop browser\nGame: 1.13.0\nClient: version unknown\nStatus: please confirm");
      assert.equal(editedCard.body.components[1].components[0].custom_id, "ticket_intake:confirm_page:1439");
      assert.equal(harness.calls.some((call) => call.method === "POST" && call.body.content?.startsWith("Your support receipt:")), false);
      assert.equal(harness.calls.some((call) => call.method === "POST" && call.body.content?.startsWith("Please confirm these details")), false);
      const intakeSeed = harness.calls.find((call) => call.method === "PATCH" && call.url.endsWith("/tickets"));
      assert.equal(intakeSeed.body.action, "intake");
      assert.equal(intakeSeed.body.intake.cardMessageId, "opening-card");
      assert.match(result.content[0].text, /"receiptDelivered":true/);
    } finally {
      harness.restore();
    }
  });

  it("fails closed when shared reservation is unavailable", async () => {
    const harness = createHarness({ reserveStatus: 503 });
    try {
      const result = await harness.run();
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /no channel was created/);
      assert.equal(harness.calls.some((call) => call.method === "POST" && call.url.endsWith("/channels")), false);
    } finally {
      harness.restore();
    }
  });
});

describe("incident tickets", () => {
  it("opens an incident with no reporter, as the bot, without the page and platform intake controls", async () => {
    const h = createHarness();
    try {
      const out = await h.run({ discord_user_id: undefined, category: "incident", title: "Turns stalled", description: "Several players report turns not processing.", source_channel_id: undefined });
      assert.ok(!out.isError, out.content?.[0]?.text);
      const created = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/guilds/1465445442987888743/channels"));
      assert.match(created.body.name, /^ticket-incident-starmerbot-1439$/);
      const registered = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/discord-bot/tickets"));
      assert.equal(registered.body.category, "incident");
      assert.equal(registered.body.discordUserId, "bot-id");
      const edit = h.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/opening-card"));
      assert.equal(edit.body.components.length, 1, "claim and close only");
      assert.ok(!h.calls.some((c) => c.url.includes("/reactions/")), "no page confirmation reactions");
    } finally { h.restore(); }
  });

  it("still requires a reporter for a player ticket", async () => {
    const h = createHarness();
    try {
      const out = await h.run({ discord_user_id: undefined, category: "bug" });
      assert.ok(out.isError);
    } finally { h.restore(); }
  });
});

describe("web form tickets", () => {
  it("opens as the bot with the routing fields, a web channel name and no intake controls", async () => {
    const h = createHarness();
    try {
      const out = await createSupportTicket({
        category: "other", title: "TEST web", description: "From the site", openedVia: "Opened from lakesidegames.net",
        channelLabel: "web", extraFields: [{ name: "Product", value: "Ask", inline: true }],
        ticketPublicUrl: (n) => `https://ops.example/t/${n}`,
      });
      assert.equal(out.ticketNumber, 1439);
      const created = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/guilds/1465445442987888743/channels"));
      assert.equal(created.body.name, "ticket-other-web-1439");
      assert.equal(created.body.permission_overwrites.filter((o) => o.id === "bot-id").length, 1, "no duplicate bot overwrite");
      const card = h.calls.find((c) => c.method === "POST" && c.body.embeds);
      const fields = card.body.embeds[0].fields;
      assert.equal(fields.find((f) => f.name === "Opened by").value, "Opened from lakesidegames.net");
      assert.equal(fields.find((f) => f.name === "Reporter").value, "No Discord account linked");
      assert.equal(fields.find((f) => f.name === "Product").value, "Ask");
      const edit = h.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/opening-card"));
      assert.equal(edit.body.components.length, 1, "claim and close only");
      const names = edit.body.embeds[0].fields.map((f) => f.name);
      for (const prompt of ["Intake", "Affected page / issue", "Platform and versions", "Details needed"]) assert.ok(!names.includes(prompt), `${prompt} is hidden without a reporter`);
      assert.ok(names.includes("Receipt"));
      assert.equal(edit.body.embeds[0].footer.text, "ahousedividedgame.com");
      const registered = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/api/discord-bot/tickets"));
      assert.equal(registered.body.discordUserId, "bot-id");
    } finally { h.restore(); }
  });

  it("grants a matched member channel access like a normal reporter", async () => {
    const h = createHarness();
    try {
      await createSupportTicket({ discordUserId: "reporter-id", category: "moderation", title: "Report", description: "x", openedVia: "Opened from lakesidegames.net" });
      const created = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/guilds/1465445442987888743/channels"));
      assert.ok(created.body.permission_overwrites.some((o) => o.id === "reporter-id" && o.type === 1));
      assert.match(created.body.name, /^ticket-moderation-reporter-1439$/);
    } finally { h.restore(); }
  });

  it("matches Discord members by exact username only", async () => {
    const send = async () => [
      { user: { id: "1", username: "player_one", bot: false } },
      { user: { id: "2", username: "player", bot: false } },
    ];
    assert.equal((await findGuildMemberByUsername("@Player", send)).user.id, "2");
    assert.equal(await findGuildMemberByUsername("playe", send), null);
    assert.equal(await findGuildMemberByUsername("bad name!", send), null);
  });
});
