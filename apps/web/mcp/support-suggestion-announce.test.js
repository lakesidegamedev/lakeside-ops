"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isSuggestionDone, requestSuggestionAnnouncement } = require("./support-suggestion-announce");

test("done statuses cover the site and support tooling spellings", () => {
  assert.equal(isSuggestionDone("completed"), true);
  assert.equal(isSuggestionDone("implemented"), true);
  assert.equal(isSuggestionDone("planned"), false);
});

test("calls the game announce endpoint with the bot token", async () => {
  let call;
  const fetchImpl = async (url, init) => {
    call = { url, init };
    return { ok: true, json: async () => ({ posted: 3 }) };
  };
  const out = await requestSuggestionAnnouncement({ fetchImpl, gameApi: "https://game.test", botApiKey: "k" });
  assert.deepEqual(out, { posted: 3 });
  assert.equal(call.url, "https://game.test/api/discord-bot/suggestions/announce");
  assert.equal(call.init.headers["X-Bot-Token"], "k");
});

test("reports failures without throwing", async () => {
  const bad = await requestSuggestionAnnouncement({
    fetchImpl: async () => ({ ok: false, status: 500 }),
    gameApi: "https://game.test",
    botApiKey: "k",
  });
  assert.deepEqual(bad, { error: "game returned 500" });
  assert.deepEqual(await requestSuggestionAnnouncement({ botApiKey: "" }), {
    error: "DISCORD_BOT_API_KEY is not configured",
  });
});
