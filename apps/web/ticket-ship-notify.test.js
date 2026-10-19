"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractTicketNumber,
  coerceTicketNumber,
  summarizeFix,
  formatOpsTldr,
  formatOpsPrOnTheWay,
  formatProductionRecheck,
  formatDevelopmentNotice,
  formatHealAppliedNotice,
  formatResolutionNotice,
  formatContextRequestNotice,
  playerUpdateFromPr,
  buildShipPrompt,
  ticketShipAppendix,
  isTicketRepairOpsPr,
} = require("./ticket-ship-notify");

test("extractTicketNumber prefers ticket-N branch and title forms", () => {
  assert.equal(extractTicketNumber("code-agent/ticket-998-repair-cs_abc"), 998);
  assert.equal(extractTicketNumber("fix(ticket-997): badge clip"), 997);
  assert.equal(extractTicketNumber("Auto-fix ticket #1001"), 1001);
  assert.equal(extractTicketNumber("Ticket #42 — broken toggle"), 42);
  assert.equal(extractTicketNumber("https://github.com/Egg3901/a-house-divided/pull/3735"), null);
});

test("coerceTicketNumber accepts explicit numeric ticket references", () => {
  assert.equal(coerceTicketNumber("1325"), 1325);
  assert.equal(coerceTicketNumber(1325), 1325);
  assert.equal(coerceTicketNumber("repair for ticket #1325"), 1325);
});

test("summarizeFix strips conventional commits and falls back to body", () => {
  assert.equal(summarizeFix({ title: "fix(ticket-998): toggle thumb left" }), "toggle thumb left");
  assert.match(
    summarizeFix({
      body: "## Summary\n\nRoot cause: CSS transform was wrong.\n\nFix: keep the knob inside the pill track.\n\n## Test plan\n\n- x",
    }),
    /keep the knob inside the pill track/
  );
  assert.doesNotMatch(
    summarizeFix({
      body: "## Summary\n\nRoot cause: CSS transform was wrong.\n\nFix: keep the knob inside the pill track.\n\n## Test plan\n\n- x",
    }),
    /Root cause/
  );
});

test("summarizeFix prefers What changed over findings-style diagnosis", () => {
  const text = summarizeFix({
    body: [
      "## Summary",
      "",
      "Players looked erased from races.",
      "",
      "## What changed",
      "",
      "Added VOTE_REACH_FLOOR in swing-flow and legacy distributors.",
      "",
      "Unit tests cover PI=0 still receiving votes.",
      "",
      "## Test plan",
      "",
      "- [x] vitest",
    ].join("\n"),
  });
  assert.match(text, /VOTE_REACH_FLOOR/);
  assert.match(text, /Unit tests/);
  assert.doesNotMatch(text, /Players looked erased/);
});

test("formatOpsTldr matches the operations-channel pattern", () => {
  const prev = process.env.DISCORD_DEVELOPER_ROLE_ID;
  process.env.DISCORD_DEVELOPER_ROLE_ID = "1470571508689535188";
  const msg = formatOpsTldr({
    prUrl: "https://github.com/Egg3901/a-house-divided/pull/3735",
    ticketNumber: 998,
    summary: "Settings toggles keep the knob inside the pill.\n\nVerified with the settings panel regression.",
  });
  assert.match(msg, /^<@&1470571508689535188>\nhttps:\/\/github\.com\/Egg3901\/a-house-divided\/pull\/3735/);
  assert.match(msg, /TL;DR: Ticket #998\n\nSettings toggles keep the knob inside the pill\./);
  assert.match(msg, /Verified with the settings panel regression\./);
  if (prev === undefined) delete process.env.DISCORD_DEVELOPER_ROLE_ID;
  else process.env.DISCORD_DEVELOPER_ROLE_ID = prev;
});

test("formatOpsTldr can omit the developers ping", () => {
  const msg = formatOpsTldr({
    prUrl: "https://github.com/Egg3901/a-house-divided/pull/3735",
    ticketNumber: 998,
    summary: "noop",
    pingDevelopers: false,
  });
  assert.match(msg, /^https:\/\/github\.com/);
  assert.doesNotMatch(msg, /<@&/);
});

test("formatOpsHealRequest asks an admin to run the heal", () => {
  const prev = process.env.DISCORD_DEVELOPER_ROLE_ID;
  process.env.DISCORD_DEVELOPER_ROLE_ID = "1470571508689535188";
  const { formatOpsHealRequest } = require("./ticket-ship-notify");
  const msg = formatOpsHealRequest({
    ticketNumber: 1034,
    title: "players removed from races",
    reason: "Three senate candidates still have PI=0 and need a one-time floor backfill.",
    plan: "heal_adhoc on electionCandidates for the three ids",
    env: "prod",
  });
  assert.match(msg, /Admin DB heal required — ticket #1034/);
  assert.match(msg, /An admin should run this heal/);
  assert.match(msg, /agents must not apply/i);
  if (prev === undefined) delete process.env.DISCORD_DEVELOPER_ROLE_ID;
  else process.env.DISCORD_DEVELOPER_ROLE_ID = prev;
});

test("formatOpsPrOnTheWay posts findings before the PR", () => {
  const prev = process.env.DISCORD_DEVELOPER_ROLE_ID;
  process.env.DISCORD_DEVELOPER_ROLE_ID = "1470571508689535188";
  const msg = formatOpsPrOnTheWay({
    ticketNumber: 998,
    title: "settings toggle",
    findings: "Root cause: CSS transform. Fixed the thumb offset.",
  });
  assert.match(msg, /^<@&1470571508689535188>\nTicket #998 — settings toggle/);
  assert.match(msg, /Root cause: CSS transform/);
  assert.match(msg, /PR on the way\./);
  assert.doesNotMatch(msg, /https:\/\/github/);
  if (prev === undefined) delete process.env.DISCORD_DEVELOPER_ROLE_ID;
  else process.env.DISCORD_DEVELOPER_ROLE_ID = prev;
});

test("isTicketRepairOpsPr allows development ticket fixes only", () => {
  assert.equal(
    isTicketRepairOpsPr({
      baseRef: "development",
      headRef: "code-agent/ticket-1004-repair-cs-c0f4e35e",
      title: "fix(corporations): pause blocks founding + expand (ticket-1004)",
    }),
    true
  );
  assert.equal(
    isTicketRepairOpsPr({
      baseRef: "staging",
      headRef: "development",
      title: "sync: development → staging (ticket-1004 pause gate)",
    }),
    false
  );
  assert.equal(
    isTicketRepairOpsPr({
      baseRef: "master",
      headRef: "staging",
      title: "sync: staging → master (ticket-1004 pause gate)",
    }),
    false
  );
  assert.equal(
    isTicketRepairOpsPr({
      baseRef: "development",
      headRef: "promote/staging-to-master-2026-08-08",
      title: "promote staging to master",
    }),
    false
  );
});

test("formatProductionRecheck asks reporter to verify and does not close", () => {
  const msg = formatProductionRecheck({
    ticketNumber: 998,
    summary: "the buggy switch animation",
  });
  assert.match(msg, /shipped to production/i);
  assert.match(msg, /hard-refresh/i);
  assert.match(msg, /leave this ticket open/i);
  assert.doesNotMatch(msg, /closed|closing/i);
});

test("player milestone messages use plain language", () => {
  assert.match(formatDevelopmentNotice(), /test environment/i);
  assert.doesNotMatch(formatDevelopmentNotice(), /PR|commit|promotion|pipeline/i);
  assert.match(formatHealAppliedNotice(), /corrected the affected game data/i);
  assert.doesNotMatch(formatHealAppliedNotice(), /Mongo|heal_run|defect/i);
  assert.match(formatResolutionNotice({ followUp: "Please refresh and reply if needed." }), /Please refresh/);
  assert.doesNotMatch(formatResolutionNotice(), /closed the ticket/i);
});

test("player milestone carries the cause and fix from the PR's player update", () => {
  const summary = playerUpdateFromPr("## Incident\nInternal details\n\n## Player update\nThe sector change broke corporation turns. We restored the previous sector rules.\n\n## Verification\nDone");
  assert.equal(summary, "The sector change broke corporation turns. We restored the previous sector rules.");
  assert.match(formatDevelopmentNotice({ summary }), /sector change broke corporation turns/);
  assert.match(formatProductionRecheck({ summary }), /restored the previous sector rules/);
  assert.equal(playerUpdateFromPr("## Fix\nInternal details"), null);
});

test("missing-context notices are player-facing and specific", () => {
  const msg = formatContextRequestNotice({ needed: ["discord", "corporation", "page"] });
  assert.match(msg, /Link your Discord account to the game/);
  assert.match(msg, /corporation's in-game link/);
  assert.match(msg, /affected page's in-game link/);
  assert.doesNotMatch(msg, /Jev|OpenRouter|contextRequest|triage/i);
});

test("ship prompts include ticket follow-up appendix for ticket work", () => {
  const { prompt, label } = buildShipPrompt("pipeline", 998);
  assert.match(label, /Full pipeline/i);
  assert.match(prompt, /ticket #998/i);
  assert.match(prompt, /support_resolve/i);
  assert.match(prompt, /Promotion PRs do not create player messages/i);
  assert.match(prompt, /ops dashboard posts/i);
  assert.match(ticketShipAppendix(998), /#operations/);
  assert.match(ticketShipAppendix(998), /support_resolve/);
  assert.equal(ticketShipAppendix(null), "");
});

test("receipt links appear only on opening and resolution channel messages", async () => {
  const { maybePostTicketChannelUpdate } = require("./ticket-ship-notify");
  const db = { collection: () => ({
    findOne: async () => ({ _id: "test-ticket", ticketNumber: 42, publicUpdates: [] }),
    updateOne: async () => ({ modifiedCount: 1 }),
  }) };
  for (const kind of ["opening", "resolution", "progress", "development", "production", "heal", "context"]) {
    const result = await maybePostTicketChannelUpdate(db, {
      ticketNumber: 42, key: `${kind}:test`, kind,
      message: "Player-facing milestone", receiptUrl: "https://example.com/t/opaque",
    });
    assert.equal(result.content.includes("View your support receipt:"), ["opening", "resolution"].includes(kind), kind);
    assert.ok(result.content.startsWith("Player-facing milestone"));
  }
});

test("progress edits the existing card and preserves the actual stage caveat", async () => {
  const { editTicketIntakeCard } = require("./ticket-ship-notify");
  const previousToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (!init.method) return new Response(JSON.stringify({
      id: "1558123456789012345",
      components: [{ type: 1, components: [{ type: 2, custom_id: "ticket_intake:confirm_page:1440" }] }],
      embeds: [{ title: "Ticket #1440", fields: [
        { name: "Status", value: "Assessment complete", inline: false },
        { name: "Affected page / issue", value: "https://ahousedividedgame.com/market", inline: false },
      ] }],
    }), { status: 200 });
    return new Response(JSON.stringify({ id: "1558123456789012345" }), { status: 200 });
  };
  try {
    const result = await editTicketIntakeCard({
      discordChannelId: "1558123000000000001",
      intake: { cardMessageId: "1558123456789012345" },
    }, {
      kind: "development",
      updateKey: "development:trial",
      message: `${"Detailed investigation progress ".repeat(40)} It is not live for everyone yet.`,
    });
    assert.equal(result.posted, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].init.method, "PATCH");
    const fields = calls[1].body.embeds[0].fields;
    assert.equal(fields.find((field) => field.name === "Status").value, "Assessment complete");
    assert.equal(fields.find((field) => field.name === "Progress").value, "Fix in testing");
    assert.match(fields.find((field) => field.name === "Latest update").value, /not live for everyone yet/i);
    assert.equal(calls[1].body.components[0].components[0].custom_id, "ticket_intake:confirm_page:1440");
  } finally {
    global.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = previousToken;
  }
});

test("an explicit ticket reply posts a new message even when the ticket has an intake card", async () => {
  const { maybePostTicketChannelUpdate } = require("./ticket-ship-notify");
  const ticket = { _id: "visible-reply", ticketNumber: 42, discordChannelId: "111111111111111111", intake: { cardMessageId: "222222222222222222" }, publicUpdates: [] };
  const writes = [], posts = [];
  const db = { collection: () => ({ findOne: async () => ticket, updateOne: async (q, update) => { writes.push(update); return { modifiedCount: 1 }; } }) };
  const result = await maybePostTicketChannelUpdate(db, { ticketNumber: 42, key: "reply:test", kind: "progress", message: "The fix is in testing. I will confirm when it reaches the main server.", deliveryMode: "reply",
    postChannel: async (...args) => { posts.push(args); return { posted: true, via: "bot", id: "new-message", channel: ticket.discordChannelId }; },
    editCard: async () => ({ posted: true, via: "intake-card", id: ticket.intake.cardMessageId }),
  });
  assert.equal(posts.length, 1, "a reply must create visible channel activity");
  assert.equal(result.via, "bot"); assert.equal(result.delivery.messageId, "new-message");
  assert.equal(writes.find(w => w.$push).$push.publicUpdates.deliveryMode, "reply");
  assert.ok(posts[0][2].nonce);
});

test("final resolutions create a new channel message instead of editing the intake card", async () => {
  const { maybePostTicketChannelUpdate } = require("./ticket-ship-notify");
  const ticket = { _id: "final-reply", ticketNumber: 42, discordChannelId: "111111111111111111", intake: { cardMessageId: "222222222222222222" }, publicUpdates: [] };
  let posts = 0, edits = 0;
  const db = { collection: () => ({ findOne: async () => ticket, updateOne: async () => ({ modifiedCount: 1 }) }) };
  const result = await maybePostTicketChannelUpdate(db, { ticketNumber: 42, key: "resolution:fixture", kind: "resolution", message: "The fix is live and verified.",
    postChannel: async () => { posts++; return { posted: true, id: "visible-resolution" }; },
    editCard: async () => { edits++; return { posted: true, via: "intake-card" }; },
  });
  assert.equal(posts, 1); assert.equal(edits, 0); assert.equal(result.delivery.messageId, "visible-resolution");
});
