"use strict";
// Keir 11.1: a ticket answer carries Keir's staged evidence chart on its first
// message. The support service verifies the presentation against the live
// ticket and its own store, posts once, and keeps the link off the public
// receipt timeline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { maybePostTicketChannelUpdate, retryPendingTicketUpdates } = require("./ticket-ship-notify");
const { prepareEvidence } = require("./ticket-evidence-attach");

const CH = "777777777777777777";
const ID = "0123456789abcdef0123456789abcdef";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
process.env.EVIDENCE_PUBLIC_BASE = "https://lakesidegames.net";

function store({ id = ID, ticket = 9, channel = CH, link = true, visibility = "ticket", metaTicket = ticket, attachBy = Date.now() + 600000, png = PNG, meta = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-evidence-")); dirs.push(dir);
  const base = path.join(dir, id);
  fs.mkdirSync(base);
  if (png) fs.writeFileSync(path.join(base, "chart.png"), png);
  fs.writeFileSync(path.join(base, "delivery.json"), JSON.stringify({ id, version: 1, ticket, channel, visibility, link, jobId: "abcdefabcdef", attachBy: new Date(attachBy).toISOString() }));
  if (meta) {
    fs.writeFileSync(path.join(base, "meta.json"), JSON.stringify({ id, visibility, ticket: visibility === "ticket" ? metaTicket : null, kind: "report" }));
    fs.writeFileSync(path.join(base, "snap-0001.json"), JSON.stringify({ n: 1, rows: [] }));
  }
  return dir;
}

// Enough of Mongo's update semantics for the claims this path makes.
function fakeDb(ticket) {
  const find = (list, q) => (list || []).find((e) => Object.entries(q).every(([k, v]) => e[k] === v));
  const set = (target, dotted, value) => { const keys = dotted.split("."); let t = target; for (const k of keys.slice(0, -1)) t = t[k] = t[k] || {}; t[keys.at(-1)] = value; };
  const collection = {
    findOne: async () => ticket,
    find: () => ({ limit: () => ({ toArray: async () => [ticket] }) }),
    updateOne: async (filter, update) => {
      if (update.$push?.publicUpdates) {
        if (find(ticket.publicUpdates, { key: update.$push.publicUpdates.key })) return { matchedCount: 0, modifiedCount: 0 };
        ticket.publicUpdates.push(update.$push.publicUpdates);
      }
      if (update.$push?.evidenceDeliveries) {
        if (find(ticket.evidenceDeliveries, { presentation: update.$push.evidenceDeliveries.presentation })) return { matchedCount: 0, modifiedCount: 0 };
        (ticket.evidenceDeliveries ||= []).push(update.$push.evidenceDeliveries);
      }
      for (const [p, value] of Object.entries(update.$set || {})) {
        let m = /^publicUpdates\.\$\.(.+)$/.exec(p);
        if (m) { const key = filter["publicUpdates.key"] || filter.publicUpdates?.$elemMatch?.key; const e = find(ticket.publicUpdates, { key }); if (e) set(e, m[1], value); continue; }
        m = /^evidenceDeliveries\.\$\.(.+)$/.exec(p);
        if (m) { const q = filter.evidenceDeliveries.$elemMatch; const e = find(ticket.evidenceDeliveries, q); if (!e) return { matchedCount: 0, modifiedCount: 0 }; set(e, m[1], value); continue; }
        set(ticket, p, value);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return { collection: () => collection };
}
const ticketRow = (over = {}) => ({ _id: "t", ticketNumber: 9, discordChannelId: CH, category: "gameplay", publicUpdates: [], ...over });
function recorder({ fileStatus = null, attachmentId = "880000000000000001" } = {}) {
  const sent = [];
  return {
    sent,
    postChannel: async (_c, content, opts) => { sent.push({ content, nonce: opts.nonce, file: false }); return { posted: true, id: `99000000000000000${sent.length}`, channel: CH }; },
    postWithFile: async (_c, content, opts) => {
      if (fileStatus) return { error: `discord ${fileStatus}: refused`, status: fileStatus };
      sent.push({ content, nonce: opts.nonce, file: true, filename: opts.filename, size: opts.file.length });
      return { posted: true, id: `99000000000000000${sent.length}`, channel: CH, attachments: [{ id: attachmentId, filename: opts.filename }] };
    },
  };
}
const base = (dir, r, over = {}) => ({ ticketNumber: 9, key: "progress:1", kind: "progress", deliveryMode: "reply", message: "Here are your operating numbers for the last three turns.", partGapMs: 0,
  evidence: ID, postChannel: r.postChannel, postWithFile: r.postWithFile, prepareEvidence: (o) => prepareEvidence({ ...o, dir }), stripRows: async () => {}, ...over });

test("the answer and the chart go out as ONE message; the link stays off the public receipt", async () => {
  const dir = store(), t = ticketRow(), r = recorder();
  const out = await maybePostTicketChannelUpdate(fakeDb(t), base(dir, r));
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].file, true); assert.equal(r.sent[0].filename, "ahd-evidence-chart.png"); assert.equal(r.sent[0].size, PNG.length);
  assert.equal(r.sent[0].content, `Here are your operating numbers for the last three turns.\n\nFull table: https://lakesidegames.net/support/evidence/${ID} (sign in at lakesidegames.net with the account linked to your Discord)`);
  assert.equal(t.publicUpdates[0].message, "Here are your operating numbers for the last three turns.", "receipt text has no link");
  assert.doesNotMatch(JSON.stringify(t.publicUpdates), /support\/evidence|evidence/);
  assert.equal(t.publicUpdates[0].delivery.status, "posted");
  assert.deepEqual({ ...t.evidenceDeliveries[0], at: undefined, receipt: { ...t.evidenceDeliveries[0].receipt, at: undefined } },
    { presentation: ID, updateKey: "progress:1", status: "attached", at: undefined, receipt: { status: "attached", messageId: "990000000000000001", attachmentId: "880000000000000001", link: true, at: undefined } });
  assert.equal(out.evidence.status, "attached"); assert.equal(out.evidence.attachmentId, "880000000000000001");
  assert.doesNotMatch(out.content, /support\/evidence/, "the returned receipt content has no link either");
});

test("duplicates: a presentation rides one reply; a replay is a no-op and another update gets text only", async () => {
  const dir = store(), t = ticketRow(), r = recorder(), db = fakeDb(t);
  await maybePostTicketChannelUpdate(db, base(dir, r));
  const replay = await maybePostTicketChannelUpdate(db, base(dir, r));
  assert.equal(replay.alreadyPosted, true);
  const other = await maybePostTicketChannelUpdate(db, base(dir, r, { key: "progress:2", message: "One more thing." }));
  assert.equal(r.sent.length, 2); assert.equal(r.sent[1].file, false); assert.equal(r.sent[1].content, "One more thing.");
  assert.equal(other.evidence.reason, "already_shown");
  assert.equal(t.evidenceDeliveries.length, 1);
});

test("a failed first attempt is retried by the support loop with its chart, posted once", async () => {
  const dir = store(), t = ticketRow(), db = fakeDb(t);
  let fail = true;
  const r = recorder();
  const flaky = { ...r, postWithFile: async (...a) => (fail ? { error: "network" } : r.postWithFile(...a)) };
  const first = await maybePostTicketChannelUpdate(db, base(dir, flaky));
  assert.equal(first.delivery.status, "failed");
  assert.equal(t.evidenceDeliveries[0].status, "pending");
  fail = false;
  t.publicUpdates[0].at = new Date(Date.now() - 11 * 60000);
  const out = await maybePostTicketChannelUpdate(db, base(dir, flaky));
  assert.equal(out.evidence.status, "attached");
  assert.equal(r.sent.length, 1); assert.equal(r.sent[0].file, true);
});

test("retryPendingTicketUpdates resends a pending answer with the chart it was staged with", async () => {
  const dir = store(), t = ticketRow();
  t.publicUpdates.push({ key: "progress:1", kind: "progress", deliveryMode: "reply", message: "Here are your numbers.", at: new Date(Date.now() - 11 * 60000), delivery: { status: "failed", attempts: 1 } });
  t.evidenceDeliveries = [{ presentation: ID, updateKey: "progress:1", status: "pending" }];
  const prev = process.env.EVIDENCE_PAGES_DIR; process.env.EVIDENCE_PAGES_DIR = dir;
  const calls = [];
  const realFetch = global.fetch;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  global.fetch = async (url, init) => { calls.push({ url, multipart: init.body instanceof FormData }); return { ok: true, json: async () => ({ id: "990000000000000001", attachments: [{ id: "880000000000000002", filename: "ahd-evidence-chart.png" }] }) }; };
  try {
    const out = await retryPendingTicketUpdates(fakeDb(t));
    assert.equal(out.posted, 1);
    assert.equal(calls.filter((c) => /\/channels\/\d+\/messages$/.test(c.url)).length, 1);
    assert.equal(calls[0].multipart, true, "posted as one multipart message with the chart");
    assert.equal(t.evidenceDeliveries[0].status, "attached");
  } finally { global.fetch = realFetch; delete process.env.DISCORD_BOT_TOKEN; if (prev === undefined) delete process.env.EVIDENCE_PAGES_DIR; else process.env.EVIDENCE_PAGES_DIR = prev; }
});

test("failover: Discord refuses the upload, the answer goes as text in the same message slot", async () => {
  const dir = store(), t = ticketRow(), r = recorder({ fileStatus: 413 });
  const out = await maybePostTicketChannelUpdate(fakeDb(t), base(dir, r));
  assert.equal(r.sent.length, 1); assert.equal(r.sent[0].file, false);
  assert.equal(r.sent[0].content, "Here are your operating numbers for the last three turns.", "no link without its chart");
  assert.equal(out.delivery.status, "posted");
  assert.equal(out.evidence.status, "not_attached"); assert.equal(out.evidence.reason, "discord_413");
  assert.equal(t.evidenceDeliveries[0].status, "not_attached");
});

test("private confinement: another ticket, another channel, a stale stage or a bad file is never attached", async () => {
  const cases = [
    ["other_ticket", store({ ticket: 10 })],
    ["other_channel", store({ channel: "777777777777777700" })],
    ["expired", store({ attachBy: Date.now() - 3600000 })],
    ["chart_missing", store({ png: null })],
    ["chart_invalid", store({ png: Buffer.from("<svg onload=alert(1)>") })],
  ];
  for (const [reason, dir] of cases) {
    const t = ticketRow(), r = recorder();
    const out = await maybePostTicketChannelUpdate(fakeDb(t), base(dir, r));
    assert.equal(r.sent.length, 1, reason); assert.equal(r.sent[0].file, false, reason);
    assert.doesNotMatch(r.sent[0].content, /support\/evidence/, reason);
    assert.equal(out.evidence.reason, reason);
  }
  // A link to the chart file through a symlink, a path id or an investigation ticket.
  const dir = store();
  fs.renameSync(path.join(dir, ID, "chart.png"), path.join(dir, "elsewhere.png"));
  fs.symlinkSync(path.join(dir, "elsewhere.png"), path.join(dir, ID, "chart.png"));
  assert.equal(prepareEvidence({ ticket: ticketRow(), presentation: ID, dir }).reason, "chart_invalid");
  assert.equal(prepareEvidence({ ticket: ticketRow(), presentation: "../" + ID.slice(3), dir }).reason, "invalid_id");
  assert.equal(prepareEvidence({ ticket: ticketRow({ category: "investigation" }), presentation: ID, dir: store() }).reason, "private_investigation");
});

test("the report link needs explicit configuration and a page in the store that matches the ticket", async () => {
  assert.equal(prepareEvidence({ ticket: ticketRow(), presentation: ID, dir: store({ metaTicket: 10 }) }).line, null, "private page of another ticket");
  assert.equal(prepareEvidence({ ticket: ticketRow(), presentation: ID, dir: store({ meta: false }) }).line, null, "no page written");
  assert.equal(prepareEvidence({ ticket: ticketRow(), presentation: ID, dir: store({ link: false }) }).line, null, "Keir staged no link");
  assert.equal(prepareEvidence({ ticket: ticketRow(), presentation: ID, dir: store({ visibility: "public_aggregate" }) }).line, `Full table: https://lakesidegames.net/support/evidence/${ID}`);
  const prev = process.env.EVIDENCE_PUBLIC_BASE; delete process.env.EVIDENCE_PUBLIC_BASE;
  try {
    const p = prepareEvidence({ ticket: ticketRow(), presentation: ID, dir: store() });
    assert.equal(p.ok, true); assert.equal(p.line, null, "the chart still goes; the link waits for the route");
  } finally { process.env.EVIDENCE_PUBLIC_BASE = prev; }
});

test("a long answer is split as usual; the chart and link ride the first message only", async () => {
  const dir = store(), t = ticketRow(), r = recorder();
  const message = "Your California plants were mothballed at turn 675 and still make nothing. That is why revenue fell.\n\nReactivating them restarts output the next turn. The loss counter does not reset, so expect one more weak turn before it clears.\n\nCheck your sector page after the next turn ends.";
  await maybePostTicketChannelUpdate(fakeDb(t), base(dir, r, { message }));
  assert.ok(r.sent.length >= 2);
  assert.equal(r.sent.filter((s) => s.file).length, 1); assert.equal(r.sent[0].file, true);
  assert.match(r.sent[0].content, /support\/evidence/);
  assert.ok(r.sent.slice(1).every((s) => !/support\/evidence/.test(s.content)));
  assert.equal(new Set(r.sent.map((s) => s.nonce)).size, r.sent.length);
});

test("card updates never carry evidence", async () => {
  const dir = store(), t = ticketRow({ intake: { cardMessageId: "123456789012345678" } }), r = recorder();
  const out = await maybePostTicketChannelUpdate(fakeDb(t), base(dir, r, { deliveryMode: "card", editCard: async () => ({ posted: true, via: "intake-card", id: "c", channel: CH }) }));
  assert.equal(r.sent.length, 0);
  assert.equal(out.evidence.reason, "card_update");
  assert.equal(t.evidenceDeliveries, undefined);
});

// --- link-only presentations, stable keys and reply targets -------------------------

const { supportUpdateKey, verifyReplyTarget } = require("./ticket-evidence-attach");
const Q = "888888888888888801", Q2 = "888888888888888802", OTHER_CH = "777777777777777700";
const ANSWER = "All 27 markets cleared this turn. Steel and oil were the only ones short.";
const STABLE = "progress:keir-0123456789abcdef01234567";
// A dated 27-market report: written by Keir with chart false (manifest v2), page and snapshot present.
const linkOnly = (over = {}) => {
  const dir = store({ png: null, visibility: "public_aggregate", ...over });
  const file = path.join(dir, ID, "delivery.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version: 2, chart: false, answerTo: Q, ...(over.manifest || {}) }));
  return dir;
};

// Mock Discord at the HTTP layer: the real postDiscordBot and verifyReplyTarget run, nothing leaves the box.
function mockDiscord({ messages = { [Q]: { id: Q, channel_id: CH, author: { id: "1", bot: false } } }, postFails = 0 } = {}) {
  const calls = [];
  let n = 0;
  const realFetch = global.fetch, prevToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = "test-token-not-real";
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.host, "discord.com", "only the Discord API is addressed (and it is mocked)");
    const method = init.method || "GET";
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof FormData ? JSON.parse(init.body.get("payload_json")) : null;
    calls.push({ method, path: u.pathname, body, multipart: init.body instanceof FormData });
    const m = /^\/api\/v10\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(u.pathname);
    if (method === "GET" && m && m[2]) {
      const msg = messages[m[2]];
      return msg ? { ok: true, json: async () => msg } : { ok: false, status: 404, text: async () => "Unknown Message" };
    }
    if (method === "POST" && m && !m[2]) {
      if (postFails > 0) { postFails--; throw new Error("fetch failed (ECONNRESET)"); }
      n++;
      return { ok: true, json: async () => ({ id: `99000000000000010${n}`, channel_id: m[1], content: body.content, attachments: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  return { calls, posts: () => calls.filter((c) => c.method === "POST"), restore() { global.fetch = realFetch; if (prevToken === undefined) delete process.env.DISCORD_BOT_TOKEN; else process.env.DISCORD_BOT_TOKEN = prevToken; } };
}
const live = (dir, over = {}) => ({ ticketNumber: 9, key: STABLE, kind: "progress", deliveryMode: "reply", message: ANSWER, partGapMs: 0, evidence: ID, replyTo: Q,
  prepareEvidence: (o) => prepareEvidence({ ...o, dir }), stripRows: async () => {}, ...over });

test("one link-only 27-market report to mock Discord: one message, answer then link, threaded under the verified request, receipt linked", async () => {
  const dir = linkOnly(), t = ticketRow(), d = mockDiscord();
  try {
    const out = await maybePostTicketChannelUpdate(fakeDb(t), live(dir));
    const posts = d.posts();
    assert.equal(posts.length, 1, "exactly one message: no separate link post");
    const [{ path: route, body, multipart }] = posts;
    assert.equal(route, `/api/v10/channels/${CH}/messages`); assert.equal(multipart, false); assert.equal(body.attachments, undefined);
    assert.equal(body.content, `${ANSWER}\n\nFull table: https://lakesidegames.net/support/evidence/${ID}`, "answer first, then the minted link");
    assert.deepEqual(body.message_reference, { message_id: Q, channel_id: CH, fail_if_not_exists: false });
    assert.ok(body.nonce); assert.equal(body.enforce_nonce, true);
    // The request was verified in the ticket channel before the post; nothing interleaved.
    assert.deepEqual(d.calls.map((c) => `${c.method} ${c.path}`), [`GET /api/v10/channels/${CH}/messages/${Q}`, `POST /api/v10/channels/${CH}/messages`]);
    assert.deepEqual(out.evidence, { presentation: ID, status: "linked", messageId: "990000000000000101", link: true });
    assert.equal(t.evidenceDeliveries[0].status, "linked"); assert.equal(t.evidenceDeliveries[0].receipt.messageId, "990000000000000101");
    assert.equal(t.publicUpdates[0].message, ANSWER); assert.doesNotMatch(JSON.stringify(t.publicUpdates), /support\/evidence/);
    assert.doesNotMatch(out.content, /support\/evidence/);
  } finally { d.restore(); }
});

test("retry and suppression: the stable key resumes one update; a replay never posts again and reports the stored receipt", async () => {
  const dir = linkOnly(), t = ticketRow(), db = fakeDb(t), d = mockDiscord({ postFails: 1 });
  try {
    const first = await maybePostTicketChannelUpdate(db, live(dir));
    assert.equal(first.delivery.status, "failed"); assert.equal(first.evidence.status, "pending");
    // A concurrent attempt still in flight: the broker's retry with the same update_key is suppressed.
    t.publicUpdates[0].delivery.status = "pending"; t.publicUpdates[0].at = new Date();
    const busy = await maybePostTicketChannelUpdate(db, live(dir));
    assert.equal(busy.skipped, "delivery in progress"); assert.equal(busy.evidence.status, "pending");
    assert.equal(d.posts().length, 1, "suppressed: nothing posted");
    // The failed attempt is resumed by the same key, same nonce.
    t.publicUpdates[0].at = new Date(Date.now() - 11 * 60000);
    const second = await maybePostTicketChannelUpdate(db, live(dir));
    assert.equal(second.evidence.status, "linked");
    const replay = await maybePostTicketChannelUpdate(db, live(dir));
    assert.equal(replay.alreadyPosted, true); assert.equal(replay.evidence.status, "linked"); assert.equal(replay.evidence.messageId, second.evidence.messageId);
    const posts = d.posts();
    assert.equal(posts.length, 2, "one failed attempt, one delivered message");
    assert.equal(posts[0].body.nonce, posts[1].body.nonce, "same nonce: Discord drops a duplicate of a stored message");
    assert.equal(t.publicUpdates.length, 1); assert.equal(t.evidenceDeliveries.length, 1);
    // An unrelated later answer is not deduplicated: fresh key, plain text.
    const later = await maybePostTicketChannelUpdate(db, live(dir, { key: supportUpdateKey("progress", undefined, 1), message: "One more thing.", evidence: null, replyTo: null }));
    assert.equal(later.delivery.status, "posted"); assert.equal(d.posts().at(-1).body.content, "One more thing.");
  } finally { d.restore(); }
});

test("support update keys: stable only for a broker evidence key, fresh otherwise", () => {
  assert.equal(supportUpdateKey("progress", "keir-0123456789abcdef01234567", 1), "progress:keir-0123456789abcdef01234567");
  assert.equal(supportUpdateKey("progress", "keir-0123456789abcdef01234567", 2), "progress:keir-0123456789abcdef01234567");
  assert.equal(supportUpdateKey("progress", undefined, 1), "progress:1");
  assert.notEqual(supportUpdateKey("progress", undefined, 1), supportUpdateKey("progress", undefined, 2));
  assert.equal(supportUpdateKey("progress", "progress:1", 5), "progress:5", "anything else is not a stable key");
  const src = fs.readFileSync(path.join(__dirname, "mcp/support-server.js"), "utf8");
  assert.match(src, /const updateKey = require\("\.\.\/ticket-evidence-attach"\)\.supportUpdateKey\(update_kind, update_key\);/);
});

test("links disabled: a link-only presentation is refused, the answer goes once as plain text, no site is named", async () => {
  const prev = process.env.EVIDENCE_PUBLIC_BASE; delete process.env.EVIDENCE_PUBLIC_BASE;
  const dir = linkOnly(), t = ticketRow(), d = mockDiscord();
  try {
    assert.deepEqual(prepareEvidence({ ticket: ticketRow(), presentation: ID, dir }), { ok: false, reason: "links_disabled" });
    const out = await maybePostTicketChannelUpdate(fakeDb(t), live(dir));
    const posts = d.posts();
    assert.equal(posts.length, 1); assert.equal(posts[0].body.content, ANSWER);
    assert.doesNotMatch(JSON.stringify(posts), /https?:\/\/|lakesidegames/);
    assert.equal(out.evidence.status, "not_attached"); assert.equal(out.evidence.reason, "links_disabled");
    assert.equal(out.evidence.messageId, undefined, "no linked receipt");
  } finally { d.restore(); process.env.EVIDENCE_PUBLIC_BASE = prev; }
});

test("an independent tenant's link and sign-in note name its own host", () => {
  const prev = process.env.EVIDENCE_PUBLIC_BASE; process.env.EVIDENCE_PUBLIC_BASE = "https://support.example.org";
  try {
    const p = prepareEvidence({ ticket: ticketRow(), presentation: ID, dir: store() });
    assert.equal(p.line, `Full table: https://support.example.org/support/evidence/${ID} (sign in at support.example.org with the account linked to your Discord)`);
    assert.doesNotMatch(p.line, /lakesidegames/);
  } finally { process.env.EVIDENCE_PUBLIC_BASE = prev; }
});

test("reply targets: only a verified human request in this ticket's channel, and with evidence only the staged one", async () => {
  const cases = [
    ["another channel", { [Q]: { id: Q, channel_id: OTHER_CH, author: { id: "1", bot: false } } }, {}],
    ["a bot message", { [Q]: { id: Q, channel_id: CH, author: { id: "1", bot: true } } }, {}],
    ["a webhook", { [Q]: { id: Q, channel_id: CH, author: { id: "1" }, webhook_id: "5" } }, {}],
    ["unknown", {}, {}],
    ["not the staged request", { [Q2]: { id: Q2, channel_id: CH, author: { id: "1", bot: false } } }, { replyTo: Q2 }],
  ];
  for (const [label, messages, over] of cases) {
    const dir = linkOnly(), t = ticketRow(), d = mockDiscord({ messages });
    try {
      await maybePostTicketChannelUpdate(fakeDb(t), live(dir, over));
      const posts = d.posts();
      assert.equal(posts.length, 1, label); assert.equal(posts[0].body.message_reference, undefined, label);
      if (label === "not the staged request") assert.equal(d.calls.filter((c) => c.method === "GET").length, 0, "a mismatched target is never even looked up");
    } finally { d.restore(); }
  }
  // Without evidence a reply still threads under a verified request in the ticket channel.
  const t = ticketRow(), d = mockDiscord();
  try {
    await maybePostTicketChannelUpdate(fakeDb(t), live(store(), { evidence: null, key: "progress:2" }));
    assert.deepEqual(d.posts()[0].body.message_reference, { message_id: Q, channel_id: CH, fail_if_not_exists: false });
  } finally { d.restore(); }
  // Malformed ids never reach Discord.
  assert.equal(await verifyReplyTarget(CH, "123", { fetchImpl: () => assert.fail("no lookup") }), null);
  assert.equal(await verifyReplyTarget(CH, "100000000000000000", { fetchImpl: () => assert.fail("no lookup") }), null, "older than the channel");
});

test("chart-only (links disabled) still attaches the chart and threads the reply", async () => {
  const prev = process.env.EVIDENCE_PUBLIC_BASE; delete process.env.EVIDENCE_PUBLIC_BASE;
  const dir = store(), t = ticketRow(), d = mockDiscord();
  const file = path.join(dir, ID, "delivery.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), answerTo: Q }));
  global.fetch = ((inner) => async (url, init = {}) => {
    const r = await inner(url, init);
    if (init.body instanceof FormData) return { ok: true, json: async () => ({ id: "990000000000000201", attachments: [{ id: "880000000000000201", filename: "ahd-evidence-chart.png" }] }) };
    return r;
  })(global.fetch);
  try {
    const out = await maybePostTicketChannelUpdate(fakeDb(t), live(dir));
    const posts = d.posts();
    assert.equal(posts.length, 1); assert.equal(posts[0].multipart, true);
    assert.equal(posts[0].body.content, ANSWER); assert.deepEqual(posts[0].body.message_reference, { message_id: Q, channel_id: CH, fail_if_not_exists: false });
    assert.deepEqual(out.evidence, { presentation: ID, status: "attached", messageId: "990000000000000201", attachmentId: "880000000000000201", link: false });
  } finally { d.restore(); process.env.EVIDENCE_PUBLIC_BASE = prev; }
});
