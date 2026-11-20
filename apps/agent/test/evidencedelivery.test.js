"use strict";
// Keir 11.1: a staged evidence chart rides on the first real answer, in ONE
// Discord message, through the answer's own delivery path. Ticket answers go
// through the support service (support_public_update + evidence id); channel
// answers go through the durable outbox. Nothing is ever posted on its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createLedger } = require("../lib/operator/store");
const ev = require("../lib/operator/evidencepages");
const delivery = require("../lib/operator/evidencedelivery");
const takeover = require("../lib/operator/supporttakeover");

const TICKET_CH = "777777777777777777", PUBLIC_CH = "555555555555555555", Q = "666666666666666666", Q2 = "666666666666666699";
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-evdelivery-")); dirs.push(dir);
  const file = path.join(dir, "ledger.json");
  const ledger = createLedger(file);
  const config = { stateDir: dir, evidencePagesDir: path.join(dir, "pages"), evidencePublicBase: "https://lakesidegames.net", guildId: "444444444444444444", ownerId: "111111111111111111", staffIds: [] };
  return { dir, file, ledger, config };
}
function ticketJob(f, n = 123, at = Date.now(), fields = {}) {
  const j = f.ledger.createJob(`ticket:${n}`, { kind: "ticket", role: "support", ticket: n, channelId: TICKET_CH, deadline: at + 86400000,
    source: { channelId: TICKET_CH, channelName: `ticket-bug-fixture-${n}`, messageId: Q, authorId: "888888888888888888", at: new Date(at).toISOString() }, ...fields });
  j.state = "running"; j.startedAt = at; j.activationCount = 1;
  f.ledger.data.channels[TICKET_CH] = { name: `ticket-bug-fixture-${n}` };
  return j;
}
function publicJob(f, at = Date.now(), fields = {}) {
  const j = f.ledger.createJob(`ping:${Math.random()}`, { kind: "conversation", role: "support", channelId: PUBLIC_CH, replyChannel: PUBLIC_CH, deadline: at + 86400000,
    source: { channelId: PUBLIC_CH, channelName: "general", messageId: Q, at: new Date(at).toISOString() }, ...fields });
  j.state = "running"; j.startedAt = at; j.activationCount = 1;
  return j;
}
const { market, operating, snapshotMarket } = require("./fixtures/evidence-game");
const readTicket = async (number) => ({ number, kind: "ticket", status: "open", createdAt: "2026-11-01T00:00:00Z",
  reporter: { profileUrl: "https://ahousedividedgame.com/character/7" }, conversation: { channelId: TICKET_CH } });
const read = (f, job, tool, env, args = { commodity: "steel" }) => ev.observe(f.ledger, job, "read_tool", { server: "gamestate", tool, args }, env, Date.now());
const present = (f, job, input = {}) => ev.present({ readTicket, ledger: f.ledger, config: f.config, job, input, now: Date.now() });
const staged = (f, id) => f.ledger.data.evidencePages.presentations[id].staged;

// The real operator delivery loop, as approval-delivery.test.js and evidencepages.test.js run it.
async function flush(f, { respond } = {}) {
  const sent = [], errors = [];
  const source = fs.readFileSync(path.join(__dirname, "../operator.js"), "utf8");
  const start = source.indexOf("async function flushOutbox() {"), end = source.indexOf("\n// Moderation tickets", start);
  const real = { evidencepages: ev, evidencedelivery: delivery, supporttakeover: takeover, toolmarkup: require("../lib/operator/toolmarkup"), conversationturn: require("../lib/operator/conversationturn") };
  const context = { ledger: f.ledger, config: f.config, killSwitch: { state: () => ({ engaged: false }) }, delivering: false, RESUME_HORIZON_MS: 86400000, JOB_TERMINAL: ["done", "failed", "cancelled"],
    require: (p) => real[Object.keys(real).find((k) => p.endsWith(k))], renderDecision: () => "", isAppJob: () => false, ensureDm: async () => "dm", ownerText: (s) => s,
    redactSecrets: require("../lib/text").redactSecrets, chunkMessage: (s) => [s], splitReply: (s) => s.split("\n\n"), snowflake: (s) => /^\d{16,20}$/.test(String(s || "")), replyGapMs: 0,
    discord: async (method, route, body, files = []) => {
      if (method === "GET") return { id: route.split("/").pop(), guild_id: f.config.guildId };
      const r = respond ? respond({ route, body, files, n: sent.length }) : null;
      if (r instanceof Error) throw r;
      sent.push({ route, body, files });
      return r || { id: `90000000000000000${sent.length}`, timestamp: new Date().toISOString(), attachments: files.map((x, i) => ({ id: `80000000000000000${i}`, filename: x.name })) };
    },
    conversation: { record() {} }, decisions: { delivered() {} }, answerFeedback: { components: () => null, delivered: async () => {} }, events: { append() {} }, taskIdOf: () => null, appChannel: {}, log: (e) => errors.push(e) };
  vm.runInNewContext(source.slice(start, end) + "\nthis.flush=flushOutbox;", context);
  await context.flush();
  return { sent, errors };
}
const answer = (f, job, text, extra = {}) => {
  const key = `channel-reply:${job.id}:${Math.random().toString(16).slice(2, 10)}`;
  f.ledger.notify(key, `channel:${job.id}`, text, { answerTo: Q, ...extra });
  return key;
};

test("public ping: the chart and report link go out on the answer itself, one message, threaded, once", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "market_history", market());
  const r = await present(f, j);
  assert.equal(r.chart, "staged");
  assert.equal(Object.keys(f.ledger.data.outbox).length, 0, "present_evidence queues nothing");
  const key = answer(f, j, "Filled demand stayed under listed demand for the whole fortnight.\n\nFunding was flat at 800.");
  const out = await flush(f);
  assert.deepEqual(out.errors, []);
  assert.equal(out.sent.length, 1, "answer, chart and link in ONE message (no split, no follow-up)");
  const [{ route, body, files }] = out.sent;
  assert.equal(route, `/channels/${PUBLIC_CH}/messages`);
  assert.equal(body.message_reference.message_id, Q, "a reply to the message that asked");
  assert.equal(JSON.stringify(body.attachments), JSON.stringify([{ id: 0, filename: "ahd-evidence-chart.png" }]));
  assert.equal(files.length, 1); assert.equal(files[0].path, staged(f, r.presentation).file);
  assert.match(body.content, /^Filled demand stayed under listed demand for the whole fortnight\.\n\nFunding was flat at 800\.\n\nFull table: https:\/\/lakesidegames\.net\/support\/evidence\/[a-f0-9]{32}$/);
  assert.equal(body.nonce, `${f.ledger.data.outbox[key].id}-0`); assert.equal(body.enforce_nonce, true);
  const s = staged(f, r.presentation);
  assert.ok(s.deliveredAt); assert.equal(s.attachmentId, "800000000000000000"); assert.equal(s.messageId, "900000000000000001");
  // A second answer in the same turn is plain text; nothing is reposted.
  answer(f, j, "Anything else, just ask.");
  const again = await flush(f);
  assert.equal(again.sent.length, 1); assert.equal(again.sent[0].files.length, 0); assert.doesNotMatch(again.sent[0].body.content, /support\/evidence/);
  assert.equal((await flush(f)).sent.length, 0);
});

test("failover: Discord refuses the upload, the answer goes as text with the same nonce, the chart is released, never posted later", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "market_history", market());
  const r = await present(f, j);
  const key = answer(f, j, "Demand rose every turn.");
  const refused = Object.assign(new Error("Discord POST /channels/x/messages: 413"), { status: 413 });
  const first = await flush(f, { respond: ({ files }) => files.length ? refused : null });
  assert.equal(first.sent.length, 0);
  const entry = f.ledger.data.outbox[key];
  assert.equal(entry.files, undefined); assert.equal(entry.content, "Demand rose every turn.", "link stripped with the chart");
  assert.equal(staged(f, r.presentation).released, "discord 413");
  const second = await flush(f);
  assert.equal(second.sent.length, 1); assert.equal(second.sent[0].files.length, 0);
  assert.equal(second.sent[0].body.content, "Demand rose every turn.");
  assert.equal(second.sent[0].body.nonce, `${entry.id}-0`, "same nonce: a message Discord did store is not duplicated");
  assert.equal(second.sent[0].body.message_reference.message_id, Q);
  // The sweep records, and posts nothing.
  delivery.sweep(f.ledger, Date.now() + 3600000);
  assert.equal((await flush(f)).sent.length, 0);
  assert.equal(Object.keys(f.ledger.data.outbox).length, 1);
});

test("a network failure retries with the chart; Discord's stored message decides what is recorded", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "market_history", market());
  const r = await present(f, j);
  const key = answer(f, j, "Demand rose every turn.");
  await flush(f, { respond: () => new Error("Discord POST failed after 3 attempt(s) (ECONNRESET)") });
  const entry = f.ledger.data.outbox[key];
  assert.equal(entry.files.length, 1, "kept for a nonce-safe retry"); entry.retryAt = 0;
  // Discord kept the message without the file (or the upload was dropped): recorded, never re-sent separately.
  const out = await flush(f, { respond: () => ({ id: "900000000000000077", attachments: [] }) });
  assert.equal(out.sent.length, 1);
  assert.equal(staged(f, r.presentation).released, "discord kept no attachment");
  assert.equal(entry.evidenceResult, "text_only");
});

test("no answer in the turn: the chart is released by the sweep and nothing is posted", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "market_history", market());
  const r = await present(f, j);
  assert.equal((await flush(f)).sent.length, 0);
  assert.equal(delivery.sweep(f.ledger, Date.now() + ev.ANSWER_WAIT_MS + 1000), 1);
  assert.equal(staged(f, r.presentation).released, "no answer in time");
  answer(f, j, "Late answer.");
  const out = await flush(f);
  assert.equal(out.sent.length, 1); assert.equal(out.sent[0].files.length, 0, "a released chart never rides a later answer");
});

test("an answer to a newer message does not carry a chart staged for the earlier one", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "market_history", market());
  const r = await present(f, j);
  f.ledger.notify(`channel-reply:${j.id}:other`, `channel:${j.id}`, "About your other question.", { answerTo: Q2 });
  const out = await flush(f);
  assert.equal(out.sent[0].files.length, 0);
  assert.equal(staged(f, r.presentation).released, "answer is for another message");
});

test("staff stop: takeover, an owner pause or Keir stop after staging keeps the chart off the answer", async () => {
  for (const stop of ["takeover", "pause", "stopped"]) {
    const f = fixture(), j = ticketJob(f); j.replyChannel = TICKET_CH; j.kind = "conversation";
    read(f, j, "reporter_operating_results", operating(), { reporter: { ticket: 123 } });
    const r = await present(f, j);
    if (stop === "takeover") f.ledger.data.supportOwner = { tickets: { 123: "staff" } };
    if (stop === "pause") f.ledger.data.ticketPauses = { 123: { at: Date.now(), by: "owner" } };
    if (stop === "stopped") f.ledger.data.control = { stopped: true };
    // Ticket route: nothing is claimed for the support call.
    assert.equal(delivery.claimTicket(f.ledger, { ...j, kind: "ticket", effects: {} }, { config: f.config, key: "ticket-update:x", ticket: 123, at: Date.now() }), null, stop);
    assert.ok(staged(f, r.presentation).released, stop);
    // Outbox route: the existing takeover/pause/stop gates hold the answer; no chart goes either way.
    answer(f, j, "Your operating profit rose by one each turn.");
    const out = await flush(f);
    assert.ok(out.sent.every((m) => !m.files.length), stop);
  }
});

test("private confinement: reporter evidence never rides an answer outside its own ticket channel", async () => {
  const f = fixture(), t = ticketJob(f); t.replyChannel = TICKET_CH; t.kind = "conversation";
  read(f, t, "reporter_operating_results", operating(), { reporter: { ticket: 123 } });
  const r = await present(f, t);
  assert.equal(r.visibility, "ticket");
  // Another task in a public channel cannot claim it, by outbox or by support route.
  const p = publicJob(f);
  answer(f, p, "Public answer.");
  const out = await flush(f);
  assert.equal(out.sent.length, 1); assert.equal(out.sent[0].files.length, 0);
  assert.equal(delivery.claimTicket(f.ledger, { ...p, kind: "ticket", ticket: 123, effects: {} }, { config: f.config, key: "k", ticket: 123, at: Date.now() }), null);
  // The ticket's own answer carries it, with the sign-in note on the private link.
  answer(f, t, "Your operating profit rose by one each turn.");
  const own = await flush(f);
  assert.equal(own.sent.length, 1); assert.equal(own.sent[0].route, `/channels/${TICKET_CH}/messages`);
  assert.equal(own.sent[0].files.length, 1);
  assert.match(own.sent[0].body.content, /support\/evidence\/[a-f0-9]{32} \(sign in at lakesidegames\.net with the account linked to your Discord\)$/);
  assert.ok(staged(f, r.presentation).deliveredAt);
  // Nothing private in audits: ids and states only.
  const audit = JSON.stringify(f.ledger.data.audit.filter((a) => /evidence/.test(a.kind)));
  assert.doesNotMatch(audit, /https?:\/\/|Fixture Shop|operating profit/i);
});

test("ticket route: the claim writes a store manifest the support service can verify; its receipt decides delivered or released", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "market_history", market());
  const r = await present(f, j);
  const key = "ticket-update:abc";
  const id = delivery.claimTicket(f.ledger, j, { config: f.config, key, ticket: 123, at: Date.now() });
  assert.equal(id, r.presentation);
  const dir = path.join(f.config.evidencePagesDir, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "delivery.json"), "utf8"));
  assert.equal(manifest.ticket, 123); assert.equal(manifest.channel, TICKET_CH); assert.equal(manifest.jobId, j.id); assert.equal(manifest.key, key);
  assert.equal(manifest.answerTo, Q); assert.equal(manifest.link, true); assert.equal(manifest.activation, j.startedAt);
  assert.ok(fs.readFileSync(path.join(dir, "chart.png")).subarray(1, 4).equals(Buffer.from("PNG")));
  assert.doesNotMatch(JSON.stringify(manifest), /https?:/, "the link is built by the support service, not carried");
  // Retry of the same answer (and after a restart) gets the same id; another answer gets none.
  assert.equal(delivery.claimTicket(createLedger(f.file), createLedger(f.file).data.jobs[j.id], { config: f.config, key, ticket: 123, at: Date.now() }), id);
  assert.equal(delivery.claimTicket(f.ledger, j, { config: f.config, key: "ticket-update:other", ticket: 123, at: Date.now() }), null);
  // A reply already sent (cached effect) never claims a chart it cannot carry.
  const fresh = fixture(), j2 = ticketJob(fresh); read(fresh, j2, "market_history", market()); await present(fresh, j2);
  j2.effects["ticket-update:done"] = { state: "done", result: {} };
  assert.equal(delivery.claimTicket(fresh.ledger, j2, { config: fresh.config, key: "ticket-update:done", ticket: 123, at: Date.now() }), null);
  // Support says posted with the attachment: delivered with Discord's ids.
  assert.equal(delivery.settleTicket(f.ledger, j, { id, result: { delivery: { posted: true, delivery: { status: "posted", messageId: "990000000000000011" }, evidence: { presentation: id, status: "attached", messageId: "990000000000000011", attachmentId: "880000000000000011", link: true } } } }), "attached");
  assert.equal(staged(f, id).attachmentId, "880000000000000011"); assert.equal(staged(f, id).messageId, "990000000000000011");
  // Support posted text only: released with its reason.
  const g = fixture(), k = ticketJob(g); read(g, k, "market_history", market()); const r2 = await present(g, k);
  const id2 = delivery.claimTicket(g.ledger, k, { config: g.config, key, ticket: 123, at: Date.now() });
  assert.equal(delivery.settleTicket(g.ledger, k, { id: id2, result: { delivery: { posted: true, evidence: { status: "not_attached", reason: "other_channel" } } } }), "text_only");
  assert.equal(staged(g, r2.presentation).released, "support: other_channel");
  // An older support service ignores the id: also text only, recorded.
  const h = fixture(), m = ticketJob(h); read(h, m, "market_history", market()); const r3 = await present(h, m);
  const id3 = delivery.claimTicket(h.ledger, m, { config: h.config, key, ticket: 123, at: Date.now() });
  assert.equal(delivery.settleTicket(h.ledger, m, { id: id3, result: { delivery: { posted: true, delivery: { status: "posted" } } } }), "text_only");
  assert.equal(staged(h, r3.presentation).released, "support did not confirm delivery");
});

test("broker channel_reply on a ticket sends the staged id through support_public_update; the model cannot name one", async () => {
  const f = fixture();
  const { createBroker } = require("../lib/operator/broker");
  const calls = [];
  const env = market();
  const supportSchema = { type: "object", properties: { kind: { type: "string" }, number: { type: "integer" }, message: { type: "string" }, deliver: { type: "boolean" }, update_kind: { type: "string" }, delivery_mode: { type: "string" }, evidence: { type: "string" } }, required: ["kind", "number", "message"] };
  const mcp = { servers: () => ["gamestate", "support"], identity: () => ({}),
    list: async (server) => server === "support" ? [{ name: "support_public_update", inputSchema: supportSchema }] : [],
    call: async (server, tool, args) => {
      if (server === "gamestate" && tool === "market_history") return env;
      if (server === "support" && tool === "support_public_update") {
        calls.push(args);
        return { ok: true, delivery: { posted: true, id: "990000000000000001", delivery: { status: "posted", messageId: "990000000000000001" },
          ...(args.evidence ? { evidence: { presentation: args.evidence, status: "attached", messageId: "990000000000000001", attachmentId: "880000000000000001", link: true } } : {}) } };
      }
      if (server === "support" && tool === "support_get") return readTicket(123);
      return { ok: true };
    } };
  const at = Date.now();
  const broker = createBroker({ ledger: f.ledger, config: { ...f.config, botId: "333333333333333333", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, repositories: {} },
    mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => at });
  const j = ticketJob(f, 123, at, { replyChannel: TICKET_CH });
  // Read scope for market_history belongs to the knowledge worker's branch; capture the received envelope directly.
  read(f, j, "market_history", env);
  const r = await broker.tool(j, "present_evidence", { observation: "latest" });
  assert.equal(r.chart, "staged");
  let reply;
  try { reply = await broker.tool(j, "channel_reply", { message: "Here are the steel numbers for the last fourteen turns." }); }
  catch (e) { assert.fail(`channel_reply refused in the fixture: ${e.message}`); }
  assert.equal(reply.published, true);
  // Keir's one-time ticket introduction goes first and never takes the chart; the answer carries it. No third, evidence-only post.
  const answers = calls.filter((c) => c.message === "Here are the steel numbers for the last fourteen turns.");
  assert.equal(answers.length, 1);
  assert.equal(calls.filter((c) => c.evidence).length, 1, "the chart rides exactly one message");
  assert.equal(answers[0].evidence, r.presentation);
  assert.equal(answers[0].delivery_mode, "reply");
  assert.doesNotMatch(answers[0].message, /support\/evidence|https?:/, "the link is never in the receipt text the broker sends");
  assert.equal(Object.keys(f.ledger.data.outbox).length, 0, "nothing queued to Discord besides the support reply");
  assert.equal(staged(f, r.presentation).attachmentId, "880000000000000001");
  // support_action: a model-supplied evidence id is stripped before the call.
  assert.equal(require("node:fs").readFileSync(path.join(__dirname, "../lib/operator/broker.js"), "utf8").includes("delete args.evidence; delete args.update_key; delete args.reply_to; // Keir 11.1: only the broker"), true);
});

// --- link-only presentations (no chart by design) ---------------------------------

// A dated 27-market report at one turn: commodities use different units, so
// there is no single chart. It is dense, so it gets a report page and link.
const COMMODITIES = Array.from({ length: 27 }, (_, i) => `commodity${String(i + 1).padStart(2, "0")}`);
const marketReport = () => {
  const sample = snapshotMarket();
  return { ...sample, summary: { ...sample.summary, traded: COMMODITIES.length }, commodities: COMMODITIES.map((commodity, i) =>
    ({ ...sample.commodities[0], commodity, name: commodity, label: commodity, unit: i % 2 ? "tonnes" : "barrels" })) };
};
const ANSWER = "All 27 markets cleared this turn.\n\nSteel and oil were the only ones short.";

test("link-only report on a public ping: answer first, link after, ONE threaded message, receipt has Discord's message id", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "commodity_market", marketReport(), { country: "Testland" });
  const r = await present(f, j);
  assert.equal(r.chart, "not_chartable"); assert.equal(r.report, "linked");
  const s0 = staged(f, r.presentation);
  assert.equal(s0.file, null); assert.match(s0.line, /^Full table: https:\/\/lakesidegames\.net\/support\/evidence\/[a-f0-9]{32}$/);
  assert.equal(Object.keys(f.ledger.data.outbox).length, 0, "present_evidence queues nothing");
  const key = answer(f, j, ANSWER);
  const out = await flush(f);
  assert.deepEqual(out.errors, []);
  assert.equal(out.sent.length, 1, "answer and link in one message: no split, no separate link post");
  const [{ body, files }] = out.sent;
  assert.equal(files.length, 0); assert.equal(body.attachments, undefined);
  assert.equal(body.content, `${ANSWER}\n\n${s0.line}`, "answer first, then the link");
  assert.equal(body.message_reference.message_id, Q);
  assert.equal(body.nonce, `${f.ledger.data.outbox[key].id}-0`);
  const s = staged(f, r.presentation);
  assert.ok(s.deliveredAt); assert.equal(s.linked, true); assert.equal(s.messageId, "900000000000000001"); assert.equal(s.attachmentId, null);
  assert.equal(f.ledger.data.outbox[key].evidenceResult, "linked");
  // A later answer is plain; a repeat present_evidence does not restage it.
  assert.equal((await present(f, j)).instruction.startsWith("Already shown"), true);
  answer(f, j, "Anything else, just ask.");
  const again = await flush(f);
  assert.equal(again.sent.length, 1); assert.doesNotMatch(again.sent[0].body.content, /support\/evidence/);
  assert.equal((await flush(f)).sent.length, 0);
});

test("link-only: 'linked' needs Discord's stored message id; without it the link is recorded as not delivered", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "commodity_market", marketReport());
  const r = await present(f, j);
  const key = answer(f, j, "All 27 markets cleared.");
  const out = await flush(f, { respond: () => ({ timestamp: new Date().toISOString(), attachments: [] }) });
  assert.equal(out.sent.length, 1);
  assert.equal(staged(f, r.presentation).deliveredAt, undefined);
  assert.equal(staged(f, r.presentation).released, "discord returned no message id");
  assert.equal(f.ledger.data.outbox[key].evidenceResult, "text_only");
  // delivered() itself refuses a link-only receipt without both.
  const g = fixture(), k = publicJob(g); read(g, k, "commodity_market", marketReport()); const r2 = await present(g, k);
  assert.equal(ev.delivered(g.ledger, r2.presentation, { messageId: "900000000000000001" }), false, "no link on the message");
  assert.equal(ev.delivered(g.ledger, r2.presentation, { linked: true }), false, "no message id");
});

test("link-only retry: a network failure retries the same message and nonce; a second failure drops the link, the answer goes once as text", async () => {
  const f = fixture(), j = publicJob(f); read(f, j, "commodity_market", marketReport());
  const r = await present(f, j);
  const key = answer(f, j, ANSWER);
  const down = () => new Error("Discord POST failed after 3 attempt(s) (ECONNRESET)");
  await flush(f, { respond: down });
  const entry = f.ledger.data.outbox[key];
  assert.match(entry.content, /support\/evidence/, "kept for a nonce-safe retry"); entry.retryAt = 0;
  await flush(f, { respond: down });
  assert.equal(entry.content, ANSWER, "second failure: link stripped");
  assert.equal(staged(f, r.presentation).released, "post failed twice");
  const last = await flush(f);
  // Without evidence the answer is split as usual; every part keeps its own nonce, the first keeps the original one.
  assert.equal(last.sent[0].body.nonce, `${entry.id}-0`);
  assert.ok(last.sent.every((m) => !/support\/evidence/.test(m.body.content)));
  assert.equal((await flush(f)).sent.length, 0, "nothing is posted later");
});

test("links disabled or not configured: no link is minted, nothing is staged, no default site", async () => {
  const f = fixture(); delete f.config.evidencePublicBase;
  const j = publicJob(f); read(f, j, "commodity_market", marketReport());
  await assert.rejects(present(f, j), /evidence pages are not enabled/);
  assert.deepEqual(f.ledger.data.evidencePages.presentations, {});
  assert.throws(() => ev.linkFor({}, "a".repeat(32)), /pages are off/);
  answer(f, j, "All 27 markets cleared.");
  const out = await flush(f);
  assert.equal(out.sent.length, 1); assert.doesNotMatch(out.sent[0].body.content, /https?:|lakesidegames/);
  // A chart still goes without its link.
  const g = fixture(); delete g.config.evidencePublicBase;
  const k = publicJob(g); read(g, k, "market_history", market());
  const c = await present(g, k);
  assert.equal(c.chart, "staged"); assert.equal(staged(g, c.presentation).line, null);
  // The operator config has no hardcoded fallback site.
  assert.match(fs.readFileSync(path.join(__dirname, "../operator.js"), "utf8"), /evidencePublicBase: env\.EVIDENCE_PUBLIC_BASE \|\| "",/);
});

test("an independent install's link and sign-in note name its own host, never ours", async () => {
  const f = fixture(); f.config.evidencePublicBase = "https://support.example.org";
  const t = ticketJob(f); t.replyChannel = TICKET_CH; t.kind = "conversation";
  read(f, t, "reporter_operating_results", operating(), { reporter: { ticket: 123 } });
  const r = await present(f, t);
  assert.equal(staged(f, r.presentation).line, `Full table: https://support.example.org/support/evidence/${r.presentation} (sign in at support.example.org with the account linked to your Discord)`);
});

test("ticket route, link only: manifest has no chart, a stable update key across retries and restarts, and the staged request as reply target", async () => {
  const f = fixture(), j = ticketJob(f); read(f, j, "commodity_market", marketReport());
  const r = await present(f, j);
  const key = "ticket-update:abc";
  const id = delivery.claimTicket(f.ledger, j, { config: f.config, key, ticket: 123, at: Date.now() });
  assert.equal(id, r.presentation);
  const dir = path.join(f.config.evidencePagesDir, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "delivery.json"), "utf8"));
  assert.equal(manifest.chart, false); assert.equal(manifest.link, true); assert.equal(manifest.answerTo, Q); assert.equal(manifest.version, 2);
  assert.equal(fs.existsSync(path.join(dir, "chart.png")), false);
  assert.doesNotMatch(JSON.stringify(manifest), /https?:/);
  const a1 = delivery.ticketArgs(f.ledger, j, { key, evidence: id });
  assert.match(a1.update_key, /^keir-[a-f0-9]{24}$/); assert.equal(a1.reply_to, Q);
  // Same answer after a restart: same key. Even once the presentation is released, the retry keeps the key (no second post).
  const reloaded = createLedger(f.file);
  assert.deepEqual(delivery.ticketArgs(reloaded, reloaded.data.jobs[j.id], { key, evidence: id }), a1);
  ev.release(f.ledger, id, "test");
  assert.equal(delivery.claimTicket(f.ledger, j, { config: f.config, key, ticket: 123, at: Date.now() }), null);
  assert.equal(delivery.ticketArgs(f.ledger, j, { key, evidence: null }).update_key, a1.update_key);
  // An unrelated answer is never given that key.
  assert.equal(delivery.ticketArgs(f.ledger, j, { key: "ticket-update:other", evidence: null }).update_key, undefined);
  // Settled as linked only with Discord's message id and the link flag.
  const g = fixture(), k = ticketJob(g); read(g, k, "commodity_market", marketReport()); await present(g, k);
  const id2 = delivery.claimTicket(g.ledger, k, { config: g.config, key, ticket: 123, at: Date.now() });
  assert.equal(delivery.settleTicket(g.ledger, k, { id: id2, result: { delivery: { posted: true, evidence: { presentation: id2, status: "linked", link: true } } } }), "text_only", "no message id");
  const h = fixture(), m = ticketJob(h); read(h, m, "commodity_market", marketReport()); await present(h, m);
  const id3 = delivery.claimTicket(h.ledger, m, { config: h.config, key, ticket: 123, at: Date.now() });
  assert.equal(delivery.settleTicket(h.ledger, m, { id: id3, result: { delivery: { posted: true, evidence: { presentation: id3, status: "linked", messageId: "990000000000000021", link: true } } } }), "linked");
  assert.equal(staged(h, id3).messageId, "990000000000000021"); assert.equal(staged(h, id3).linked, true);
});

test("broker: a retried ticket answer reuses its evidence, update key and reply target; the model cannot set any of them", async () => {
  const f = fixture();
  const { createBroker } = require("../lib/operator/broker");
  const calls = [];
  let refuse = true;
  const supportSchema = { type: "object", properties: { kind: { type: "string" }, number: { type: "integer" }, message: { type: "string" }, deliver: { type: "boolean" }, update_kind: { type: "string" }, delivery_mode: { type: "string" }, evidence: { type: "string" }, update_key: { type: "string" }, reply_to: { type: "string" } }, required: ["kind", "number", "message"] };
  const mcp = { servers: () => ["gamestate", "support"], identity: () => ({}),
    list: async (server) => server === "support" ? [{ name: "support_public_update", inputSchema: supportSchema }] : [],
    call: async (server, tool, args) => {
      if (server === "support" && tool === "support_public_update") {
        calls.push(args);
        if (args.evidence && refuse) { refuse = false; throw Object.assign(new Error("connect ECONNREFUSED"), { code: "MCP_CONNECT_REFUSED" }); }
        return { ok: true, delivery: { posted: true, id: "990000000000000001", delivery: { status: "posted", messageId: "990000000000000001" },
          ...(args.evidence ? { evidence: { presentation: args.evidence, status: "linked", messageId: "990000000000000001", link: true } } : {}) } };
      }
      if (server === "support" && tool === "support_get") return readTicket(123);
      return { ok: true };
    } };
  const at = Date.now();
  const broker = createBroker({ ledger: f.ledger, config: { ...f.config, botId: "333333333333333333", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, repositories: {} },
    mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => at });
  const j = ticketJob(f, 123, at, { replyChannel: TICKET_CH });
  read(f, j, "commodity_market", marketReport());
  const r = await broker.tool(j, "present_evidence", { observation: "latest" });
  assert.equal(r.chart, "not_chartable"); assert.equal(r.report, "linked");
  const text = "All 27 markets cleared this turn; the full table is attached.";
  await assert.rejects(broker.tool(j, "channel_reply", { message: text }));
  const reply = await broker.tool(j, "channel_reply", { message: text });
  assert.equal(reply.published, true);
  const answers = calls.filter((c) => c.message === text);
  assert.equal(answers.length, 2, "one refused before sending, one retry");
  assert.equal(answers[0].evidence, r.presentation); assert.equal(answers[1].evidence, r.presentation);
  assert.match(answers[0].update_key, /^keir-[a-f0-9]{24}$/); assert.equal(answers[1].update_key, answers[0].update_key, "the retry claims the same support update");
  assert.equal(answers[0].reply_to, Q); assert.equal(answers[1].reply_to, Q);
  assert.equal(staged(f, r.presentation).linked, true);
  // Other updates (the one-time introduction) carry no evidence key.
  assert.ok(calls.filter((c) => c.message !== text).every((c) => !c.evidence && !c.update_key));
  // support_action strips broker-only arguments from model input.
  const src = fs.readFileSync(path.join(__dirname, "../lib/operator/broker.js"), "utf8");
  assert.ok(src.includes("delete args.evidence; delete args.update_key; delete args.reply_to;"));
});
