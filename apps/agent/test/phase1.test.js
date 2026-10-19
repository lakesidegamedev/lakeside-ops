"use strict";
// Keir 4.0 phase 1: blast radius, player register, receipt-bound status words,
// blocked-on-owner silence, the monologue cap and the event sink. Each case
// is a real failure from the October 2026 transcripts.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const blast = require("../lib/operator/blastradius");
const { playerLeak, runtimeTalk, nameMisuse } = require("../lib/operator/playercopy");
const { openSink, attachSink, taskIdOf } = require("../lib/operator/events");

const dirs = []; test.after(() => dirs.forEach((p) => fs.rmSync(p, { recursive: true, force: true })));
const T = (iso) => Date.parse(iso);

test("blast radius: files decide the class, unknown lists are economy", () => {
  assert.equal(blast.classify(["src/app/corporation/[id]/page.tsx", "src/components/Card.tsx", "README.md"]).cls, "copy");
  assert.equal(blast.classify(["src/app/api/budget/route.ts"]).cls, "logic");
  assert.equal(blast.classify(["src/lib/cabinetNominationLifecycle.ts", "src/lib/cabinet.test.ts"]).cls, "logic");
  assert.equal(blast.classify(["src/lib/market/clearing.ts", "src/app/market/page.tsx"]).cls, "economy");
  assert.equal(blast.classify(["src/lib/turn/cash.ts"]).cls, "economy");
  assert.equal(blast.classify(["railway.worker.toml"]).cls, "economy");
  assert.equal(blast.classify(null).cls, "economy");
  assert.equal(blast.classify(["src/lib/market/clearing.test.ts"]).cls, "logic", "tests alone are not an economy change");
});

test("blast radius: the Node and Rust classifiers share one fixture", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "blast-cases.json"), "utf8"));
  for (const c of cases) assert.equal(blast.classify(c.files).cls, c.class, JSON.stringify(c.files));
});

test("blast radius: economy to main waits for the owner's day, a fresh approval or a night pass", () => {
  const night = T("2026-10-14T06:00:00Z"); // 02:00 Eastern
  const day = T("2026-10-14T18:00:00Z"); // 14:00 Eastern
  assert.equal(blast.inAwakeWindow(night), false);
  assert.equal(blast.inAwakeWindow(day), true);
  assert.equal(blast.nextWindowOpen(night), T("2026-10-14T13:00:00Z"), "09:00 Eastern");
  const held = blast.promotionGate({ cls: "economy", to: "main", now: night, lastOwnerApprovalAt: night - 5 * 3600000 });
  assert.equal(held.allowed, false); assert.equal(held.held, true); assert.equal(held.resumeAt, T("2026-10-14T13:00:00Z"));
  assert.equal(blast.promotionGate({ cls: "economy", to: "main", now: night, lastOwnerApprovalAt: night - 3600000 }).allowed, true, "approval within three hours is awake evidence");
  assert.equal(blast.promotionGate({ cls: "economy", to: "main", now: night, nightPass: true }).allowed, true);
  assert.equal(blast.promotionGate({ cls: "economy", to: "main", now: day }).allowed, true);
  assert.equal(blast.promotionGate({ cls: "economy", to: "staging", now: night }).allowed, true, "the sandbox is not held");
  assert.equal(blast.promotionGate({ cls: "copy", to: "main", now: night }).allowed, true);
  assert.equal(blast.promotionGate({ cls: "logic", to: "main", now: night }).allowed, true);
  assert.equal(blast.hasNightPass("looks good, ship it tonight"), true);
  assert.equal(blast.hasNightPass("approve"), false);
  assert.equal(blast.hasNightPass("night pass for the clearing fix"), true);
});

test("player register: paths, repositories, model names, internal tools and runtime talk are leaks", () => {
  assert.equal(playerLeak("Manage banners at **Place a Banner Ad** on `/player-ads` (`src/app/player-ads/page.tsx`).").kind, "source path");
  assert.equal(playerLeak("That lives in lib/operator/broker.js").kind, "source path");
  for (const owner of ["Egg3901", "lakesidegamedev"]) assert.equal(playerLeak(`The fix is in ${owner}/unlisted-repo now`).kind, "repository");
  assert.equal(playerLeak("this ticket was being handled by a model we were trialling").kind, "model talk");
  assert.equal(playerLeak("Luna could not read the screenshot").kind, "model or provider name");
  assert.equal(playerLeak("I checked with Muse Spark").kind, "model or provider name");
  assert.equal(playerLeak("I ran a heal-ops plan").kind, "internal tool");
  assert.equal(playerLeak("see https://ops.lakesidegames.net/reports/x").kind, "internal URL");
  assert.equal(playerLeak("Your plant sold everything it made last turn; the loss is the input price."), null);
  assert.equal(playerLeak("Nothing is wrong with your sales. The display now shows each product's own price."), null);
  assert.equal(playerLeak("The Spark of the idea is the market itself."), null, "ordinary words are not model names");
  assert.equal(playerLeak("src/x.ts is fine", { strict: false }), null, "developers may talk shop");
  assert.equal(runtimeTalk("I hit an error and stopped on this one. Ask again and I'll pick it back up."), "I hit an error");
  assert.equal(runtimeTalk("Ignore the error message above, nothing was dropped."), "Ignore the error");
  assert.equal(runtimeTalk("The budget page uses your actual sales revenue."), null);
});

test("player register: a player is named exactly or not at all", () => {
  assert.deepEqual(nameMisuse("Simon, your California plant needs real estate services.", ["simonella"]), { used: "Simon", name: "simonella" });
  assert.equal(nameMisuse("Simonella, your California plant needs real estate services.", ["simonella"]), null);
  assert.equal(nameMisuse("Thanks. The plant is fine.", ["simonella"]), null);
  assert.equal(nameMisuse("Found the cause. Fixed it.", ["foundation_x"]), null, "ordinary sentence openers are not names");
  assert.equal(nameMisuse("Hya, the banner is approved.", ["hyawii20"]), null, "under four letters is not a shortening we can judge");
  assert.deepEqual(nameMisuse("Hyaw, the banner is approved.", ["hyawii20"]), { used: "Hyaw", name: "hyawii20" });
  assert.equal(nameMisuse("Hi Egg", ["egg3901"]), null, "short names are left alone");
});

test("event sink: audits and deliveries land with task, attempt and ticket identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-events-")); dirs.push(dir);
  const sink = openSink(path.join(dir, "events.db"), { release: "abc1234", now: () => 42 });
  assert.equal(sink.enabled, true);
  const ledger = attachSink(createLedger(path.join(dir, "ledger.json")), sink);
  const job = ledger.createJob("ticket:1522", { kind: "ticket", role: "support", ticket: 1522, source: {} });
  ledger.audit("status_card_refresh", { job: job.id, ticket: 1522 });
  sink.append("delivery", { taskId: taskIdOf(job, ledger.data.jobs), attemptId: job.id, ticket: 1522, key: "x", chars: 10 });
  assert.equal(sink.count(), 3, "created, audit, delivery");
  const rows = sink.recent({ ticket: 1522 });
  assert.equal(rows[0].kind, "delivery"); assert.equal(rows[0].task_id, "ticket:1522"); assert.equal(rows[0].attempt_id, job.id);
  assert.equal(rows[1].kind, "audit:status_card_refresh"); assert.equal(rows[1].ticket, 1522); assert.equal(rows[1].at, 42);
  assert.equal(ledger.data.audit.at(-1).kind, "status_card_refresh", "the ledger audit still happens");
  const child = ledger.createJob("coding:1", { kind: "coding", role: "support", codingParent: job.id, source: {} });
  assert.equal(taskIdOf(child, ledger.data.jobs), "ticket:1522", "a coding child belongs to its ticket");
  sink.close();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-phase1-")); dirs.push(dir);
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: ["555555555555555555"],
    taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, repositories: {} };
  const calls = [];
  const mcp = { servers: () => ["support"], list: async () => [{ name: "support_public_update", inputSchema: { type: "object", additionalProperties: true } }], call: async (...args) => { calls.push(args); return { ok: true, delivery: { posted: true, delivery: { status: "posted" } } }; } };
  let clock = 5000;
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => clock });
  const ch = "777777777777777777";
  const job = ledger.createJob("ticket:1522", { kind: "ticket", role: "support", ticket: 1522, channelId: ch, replyChannel: ch, deadline: 9999999999999,
    source: { channelId: ch, channelName: "ticket-bug-simonella-1522", content: "New ticket intake", at: new Date(1000).toISOString() } });
  job.state = "running";
  ledger.data.channels[ch] = { ticket: 1522 };
  ledger.data.disclosed = { 1522: { at: 0 } };
  return { ledger, config, mcp, calls, broker, job, ch, tick: (ms) => { clock += ms; } };
}
const say = (f, message) => f.broker.tool(f.job, "channel_reply", { message });

test("ticket posts refuse model names, runtime talk and a fabricated first name", async () => {
  const f = fixture();
  await assert.rejects(say(f, "Sorry for the runaround, this ticket was being handled by a model we were trialling."), /model talk/);
  await assert.rejects(say(f, "Luna could not read your panels, so I am taking over."), /model or provider name/);
  await assert.rejects(say(f, "I hit an error and stopped on this one. Ask again and I will pick it back up."), /Keir's own runtime/);
  await assert.rejects(say(f, "Simon, your California plant needs real estate services from your own sector."), /not this player's name/);
  const ok = await say(f, "Simonella, your California plant needs real estate services, and your own sector makes enough. I am checking what it actually received.");
  assert.equal(ok.published, true); assert.equal(f.calls.length, 1);
});

test("being built needs a coding attempt; written or in testing needs a pull request", async () => {
  const f = fixture();
  await assert.rejects(say(f, "The fix is being built now."), /coding attempt/);
  await assert.rejects(say(f, "Working on a fix for the budget check."), /coding attempt/);
  const coder = f.ledger.createJob("coding:1522", { kind: "coding", role: "support", ticket: 1522, codingParent: f.job.id, source: {}, deadline: 9999999999999 }); coder.state = "running";
  const built = await say(f, "The cause is confirmed and the fix is being built now.");
  assert.equal(built.published, true);
  f.tick(60000);
  await assert.rejects(say(f, "The fix is written and in testing."), /pull request/);
  f.job.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/4100"];
  f.tick(60000);
  assert.equal((await say(f, "The fix is written and going through its checks.")).published, true);
});

test("blocked on the owner: one notice, then silence until the decision or the player", async () => {
  const f = fixture();
  f.ledger.data.decisions = { dec1: { id: "dec1", jobId: f.job.id, state: "pending", at: 4000, question: "Promote the clearing fix?" } };
  assert.equal((await say(f, "This needs the owner's go before it reaches the main server. I will post when it moves.")).published, true);
  f.tick(2 * 3600000);
  await assert.rejects(say(f, "Quick status: still waiting on the owner's call, nothing new on my side."), /waiting on the owner's decision/);
  assert.equal((await say(f, "While we wait, did the loss appear before or after you changed suppliers?")).published, true, "a question to the player is not silence");
  f.job.observedPlayerAt = Date.now() + 10 ** 12; f.tick(60000);
  assert.equal((await say(f, "Thanks, that narrows it to the supplier change. The owner still has the decision.")).published, true, "the player wrote, so Keir may answer");
});

test("monologue cap: three Keir posts with no human reply, then the card only", async () => {
  const f = fixture();
  for (const m of ["The budget check is being investigated against your corporation.", "The mismatch is between two revenue figures the page and the save use.", "Confirmed: the save check reads an older revenue figure than the page."]) {
    f.tick(20 * 60000); assert.equal((await say(f, m)).published, true);
  }
  assert.equal(f.ledger.data.monologue[1522].count, 3);
  await assert.rejects(say(f, "Still looking at the save path for the earlier revenue figure."), /posted 3 times/);
  assert.equal((await say(f, "Does the error appear on the budget page or when you save?")).published, true, "questions pass");
  f.tick(60000);
  f.job.observedPlayerAt = Date.now() + 10 ** 12;
  assert.equal((await say(f, "Thanks. The save path is the culprit and a correction is being investigated.")).published, true, "a human reply resets the run");
  assert.equal(f.ledger.data.monologue[1522].count, 1);
});

test("ticket posts are short, in paragraphs, one per ten minutes, and corrections stay short", async () => {
  const { shapeTicketPost } = require("../lib/operator/playercopy");
  const wall = "Japan's statistics page has two kinds of lines. A handful are measured from the live game each turn and do move. The rest were placeholders set once at the start of the world and copied forward. The page still showed your laws pushing on them. That is our bug. The fix will move them each turn toward where your laws say they should be. It goes to the sandbox first.";
  assert.throws(() => shapeTicketPost(wall), /at most 5 short sentences/);
  const shaped = shapeTicketPost("Plain version of what is going on. Those lines were placeholders copied forward every turn. The page showed your laws pushing on them, which is our bug. The fix moves them each turn toward what your laws say. It goes to the sandbox first.");
  assert.equal(shaped.split("\n\n").length, 2, "two-sentence paragraphs");
  assert.ok(!/^Plain version/.test(shaped), "preamble stripped");
  assert.equal(shapeTicketPost("Found it. Fix is being looked at."), "Found it. Fix is being looked at.");
  assert.equal(shapeTicketPost("- one\n- two\n- three"), "- one\n- two\n- three", "bullets kept");
  const f = fixture();
  assert.equal((await say(f, "Those lines are repeated from the last turn and the law pressure shown next to them is not yet applied. Nothing to change on your end.")).published, true);
  f.tick(60000);
  await assert.rejects(say(f, "Here is the fuller picture. The statistics page has two kinds of lines. The repeated lines were placeholders."), /waits ten minutes/);
  assert.equal((await say(f, "Short follow-up: nothing to change on your end.")).published, true, "a short line is fine");
  f.tick(60000);
  assert.equal((await say(f, "Did the energy security line move at all after your last budget?")).published, true, "questions pass");
  f.tick(11 * 60000);
  f.job.observedPlayerAt = Date.now() + 10 ** 12; // the player wrote back
  await assert.rejects(say(f, "Correction to my message above: the first update stands. Those lines repeat the last turn. The law pressure is not applied yet. Further updates will come here."), /correction is one or two sentences/);
  assert.equal((await say(f, "Correction: the first update stands, nothing to change on your end.")).published, true);
});

test("a progress card does not hold back the answer it announces, and a mechanics question gets no fix card", async () => {
  const f = fixture();
  // A card recorded a minute ago, then the long answer: it goes out.
  (f.ledger.data.ticketPosts ||= {})[1522] = [{ at: Date.now(), jobId: f.job.id, text: "[status card] Checked the records; posting the explanation." }];
  f.tick(60000);
  assert.equal((await say(f, "Your company fell because its main plant lost its supplier. The plant ran at half speed for three turns. Revenue dropped while wages stayed the same.")).published, true);
  // Mechanics questions: no fix-progress card unless Jev read a bug report.
  f.ledger.data.channels[f.ch] = { ticket: 1522, category: "mechanics" };
  f.job.tags = { kind: "other" };
  await assert.rejects(f.broker.tool(f.job, "status_card", { items: [{ name: "Company fall explanation", stage: "found" }] }), /mechanics question/);
  // A mechanics ticket with a fix pull request in flight is a bug and gets its card.
  f.job.pullRequests = ["https://github.com/lakesidegamedev/AHDGame/pull/4106"];
  await assert.doesNotReject(f.broker.tool(f.job, "status_card", { items: [{ name: "Fund sponsorship rule", stage: "testing" }] }).catch((e) => { if (/mechanics question/.test(e.message)) throw e; }));
});

test("telling a player the developers have it needs something that reached them; raise_to_developers is that receipt", async () => {
  const f = fixture();
  await assert.rejects(say(f, "The developers already have this gap to review."), /raise_to_developers/);
  const calls = [];
  f.mcp.call = async (server, tool, args) => { calls.push([server, tool, args]); return tool === "kanban_add" ? { id: 777 } : { ok: true, delivery: { posted: true } }; };
  const r = await f.broker.tool(f.job, "raise_to_developers", { title: "Governor blend pays low-utilization stakes near nameplate", detail: "Plants revenue blends produced-unit revenue with a nameplate baseline, so per-unit pay differs 2.5 to 3.6x between stakes in the same market." });
  assert.equal(r.id, 777);
  const add = calls.find((c) => c[1] === "kanban_add");
  assert.equal(add[0], "ops-knowledge"); assert.match(add[2].title, /\(ticket 1522\)$/);
  f.tick(11 * 60000);
  assert.equal((await say(f, "The developers already have this gap to review.")).published, true);
  assert.equal((await f.broker.tool(f.job, "raise_to_developers", { title: "Governor blend pays low-utilization stakes near nameplate", detail: "Same evidence as before, repeated by mistake in this activation of the task." })).duplicate, true);
});

test("raise_to_developers offers a matching open item first, appends to it on request, and never doubles the ticket label", async () => {
  const f = fixture();
  const calls = [];
  f.mcp.call = async (server, tool, args) => {
    calls.push([tool, args]);
    if (tool === "kanban_list") return { items: [{ id: 900, title: "Players report financial-sector margins collapsing overnight", detail: "Financial sectors margins down about 20% on everything. Raised by Keir.", created_at: new Date(Date.now()).toISOString() }] };
    if (tool === "kanban_add") return { id: 901 };
    return { ok: true };
  };
  const first = await f.broker.tool(f.job, "raise_to_developers", { title: "Financial sector margins squeezed (ticket 1522)", detail: "Financial sector margins fell about 20% over eight turns while input prices rose; corp revenue down, costs up." });
  assert.equal(first.raised, false); assert.equal(first.candidates[0].id, 900);
  const appended = await f.broker.tool(f.job, "raise_to_developers", { title: "Financial sector margins squeezed", detail: "Ticket evidence: revenue down 16%, costs up 8% over turns 182 to 189.", appendTo: 900 });
  assert.equal(appended.appended, true);
  assert.equal(calls.find((c) => c[0] === "work_report")[1].id, 900);
  const forced = await f.broker.tool(f.job, "raise_to_developers", { title: "Spin-off countdown missing (ticket 1522)", detail: "The Structure tab never shows when the next spin-off is allowed; players must submit to find out.", force: true });
  assert.equal(forced.id, 901);
  assert.equal(calls.find((c) => c[0] === "kanban_add")[1].title, "Spin-off countdown missing (ticket 1522)");
});

test("support_action accepts loose tool names and says exactly what is allowed", async () => {
  const f = fixture();
  // A loose name passes the tool check (it then meets the channel check, which this fixture cannot satisfy).
  await assert.rejects(f.broker.tool(f.job, "support_action", { tool: "public_update", args: { message: "x" } }), (e) => !/outside standing permission/.test(e.message));
  await assert.rejects(f.broker.tool(f.job, "support_action", { tool: "post_message", args: { message: "x" } }), /tool must be one of support_public_update/);
});

test("a compensation filing reaches the owner as a decision DM, not only the kanban", async () => {
  const f = fixture();
  const calls = [];
  f.mcp.call = async (server, tool, args) => { calls.push([server, tool, args]); return tool === "kanban_add" ? { id: 888 } : tool === "kanban_list" ? [] : { ok: true }; };
  const detail = "Reporter asks whether the period when funded laws failed to affect Japan's metrics can be compensated by returning money.";
  await assert.rejects(f.broker.tool(f.job, "raise_to_developers", { title: "Compensation for missed metric effects", detail }), /kind: "decision"/);
  assert.equal(calls.filter((c) => c[1] === "kanban_add").length, 0, "nothing filed without the question");
  const r = await f.broker.tool(f.job, "raise_to_developers", { title: "Compensation for missed metric effects", detail, kind: "decision", question: "Deny compensation (recommended), refund funded law costs for the affected turns, or replay missed metric progress?" });
  assert.equal(r.id, 888); assert.ok(r.decision);
  const x = f.ledger.data.decisions[r.decision];
  assert.equal(x.state, "pending"); assert.equal(x.actionId, "kanban:888"); assert.match(x.question, /^Ticket 1522: Compensation for missed metric effects\. Deny compensation/);
  assert.ok(Object.values(f.ledger.data.outbox).some((o) => o.decision === r.decision && o.destination === "owner"), "the DM is queued");
  assert.equal(f.job.ownerDecisionPending, true);
});

test("Keir does not ask the player which bank when the ticket already names their company", async () => {
  const f = fixture();
  const base = f.mcp.call;
  f.mcp.call = async (server, tool, args, ...rest) => tool === "support_get"
    ? { reporter: { corporationName: "The Trump Organization", corporationUrl: "https://www.ahousedividedgame.com/corporation/823" }, intake: { candidatePageUrl: "https://ahousedividedgame.com/corporation/823" }, supportRecentVisits: [{ path: "/corporation/823/sector/6acac90e732972f556a4a192" }] }
    : base(server, tool, args, ...rest);
  f.tick(60000);
  await assert.rejects(say(f, "Which bank's page shows the zero deposit ceiling? Please send its game link."), /The Trump Organization.*corporation\/823/);
  f.tick(60000);
  assert.equal((await say(f, "Which bank's page shows the zero deposit ceiling? Please send its game link.")).published, true, "asking again after checking goes out");
});

test("Keir introduces itself once per player, welcomes returning players with their ticket count, and never introduces itself to staff", async () => {
  const run = async ({ uid, prior, introduced = false, priorDisclosed = false, fail = false, answered = false }) => {
    const f = fixture(), posted = [];
    for (const j of Object.values(f.ledger.data.jobs)) { delete j.lastPublishedAt; delete j.progressMessageId; delete j.channelReplyQueued; }
    delete f.ledger.data.statusCards; delete f.ledger.data.disclosed;
    if (introduced) (f.ledger.data.introduced ||= {})[uid] = 1;
    if (priorDisclosed) (f.ledger.data.disclosed ||= {})[900] = { posted: true };
    const base = f.mcp.call;
    f.mcp.call = async (server, tool, args, ...rest) => {
      if (server === "heal-ops" && tool === "heal_query") {
        if (fail) throw new Error("heal-ops down");
        if (args.filter.ticketNumber === 1522) return { matched: 1, docs: [{ discordUserId: uid, discordDisplayName: "Simonella", ...(answered ? { publicUpdates: [{ key: "progress:1" }] } : {}) }] };
        return { matched: prior, docs: Array.from({ length: prior }, (_, i) => ({ ticketNumber: 900 + i })) };
      }
      if (tool === "support_public_update") { posted.push(args.message); return { ok: true, delivery: { posted: true } }; }
      return base(server, tool, args, ...rest);
    };
    f.tick(60000);
    await say(f, "The fund buys only Austrian bonds because candidates are sorted by country code.");
    return posted[0];
  };
  assert.match(await run({ uid: "888888888888888888", prior: 0 }), /^Hi, I'm Keir.*Thank you for submitting your first ticket\.$/);
  assert.equal(await run({ uid: "888888888888888888", prior: 4, introduced: true }), "Welcome back, Simonella. This is your 5th ticket, thank you for submitting it. I'm looking into it now.");
  assert.match(await run({ uid: "888888888888888888", prior: 2, priorDisclosed: true }), /^Welcome back, Simonella\. This is your 3rd ticket/);
  assert.match(await run({ uid: "888888888888888888", prior: 10 }), /^Hi, I'm Keir.*This is your 11th ticket/, "never introduced before: the introduction, once, with the count");
  const f = fixture();
  assert.equal(await run({ uid: f.config.ownerId, prior: 3 }), "The fund buys only Austrian bonds because candidates are sorted by country code.", "staff: no introduction, the reply is the first post");
  assert.match(await run({ uid: "888888888888888888", prior: 0, fail: true }), /^Hi, I'm Keir/, "lookup failure falls back to the introduction");
  assert.equal(await run({ uid: "888888888888888888", prior: 10, introduced: true, answered: true }), "The fund buys only Austrian bonds because candidates are sorted by country code.", "a ticket someone already answered gets no opening: the reply is the next post");
});

test("a waiting developer sibling cannot silence a newer player question", async () => {
  const f = fixture();
  f.ledger.createJob("cmd:old", { kind: "command", role: "owner", actorId: f.config.ownerId, ticket: 1522,
    source: { authorId: f.config.ownerId, content: "Are you there?", at: new Date(1000).toISOString() } }).state = "waiting";
  f.job.observedPlayerAt = 4000;
  assert.equal((await say(f, "Your open buy order uses the purchase allowance. Cancel it before trying a new purchase.")).published, true);
});

test("a quiet interval permits a new useful answer after three earlier updates", async () => {
  const f = fixture();
  for (const m of ["The price limit is being investigated.", "The cost calculation is different on the bid screen.", "The tender ceiling needs to include those costs."]) {
    await say(f, m); f.tick(20 * 60000);
  }
  assert.equal((await say(f, "You can now submit your bid from the contract page.")).published, true);
});

test("a current developer request retains its reply task", async () => {
  const f = fixture();
  f.ledger.createJob("cmd:new", { kind: "command", role: "owner", actorId: f.config.ownerId, ticket: 1522,
    source: { authorId: f.config.ownerId, content: "Investigate this", at: new Date(4500).toISOString() } }).state = "running";
  f.job.observedPlayerAt = 4000;
  await assert.rejects(say(f, "I have more information about the purchase."), /developer's own task/);
});

// Review 2026-10-19: 1602's player was sent "Let me discover the tools I have
// access to", the model narrating its own start-up.
test("tool-discovery narration is runtime talk; ordinary tool words are not", () => {
  const { runtimeTalk } = require("../lib/operator/playercopy");
  assert.ok(runtimeTalk("I'll start by understanding the available tools and then answer the question."));
  assert.ok(runtimeTalk("Let me discover the tools I have access to."));
  assert.equal(runtimeTalk("Check the tools menu on your corporation page."), null);
  assert.equal(runtimeTalk("I'll start by checking your mine's sales."), null);
});
