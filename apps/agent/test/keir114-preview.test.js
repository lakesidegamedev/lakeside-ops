"use strict";
// Keir 11.4 (ticket 1875): "can you show us a rendered image of how you would make that distinction clearer?" got
// "I cannot render the page from here". Now the request is real work, the preview tool is offered, and the image is
// posted with its label, without a "with the developers" line and without a source line.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createLedger } = require("../lib/operator/store");
const { createBroker } = require("../lib/operator/broker");
const preview = require("../lib/operator/preview");
const controls = require("../lib/operator/controls");
const { quickQuestion } = require("../lib/operator/conversation");
const briefprofile = require("../lib/operator/briefprofile");

const CH = "777777777777777777", OWNER = "111111111111111111", STAFF = "222222222222222222", BOT = "333333333333333333", PLAYER = "555555555555555555";
const ASK = "can you show us a rendered image of how you would make that distinction clearer? <@333333333333333333>";

function setup({ role = "owner", actorId = OWNER, fail = false, controlsOverride = null, content = ASK } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir114-preview-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const config = { ownerId: OWNER, staffIds: [STAFF], botId: BOT, guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false, stateDir: dir, ...(controlsOverride ? { controls: controlsOverride } : {}) };
  const runs = [];
  const sandbox = {
    workspace: (id) => path.join(dir, "ws", id),
    run: async (id, cmd, signal, opts) => {
      runs.push(opts);
      if (fail) return { code: 1, output: "browser missing" };
      const folder = path.join(dir, "ws", id, ".keir-computer");
      const req = JSON.parse(fs.readFileSync(path.join(folder, "request.json"), "utf8"));
      fs.writeFileSync(path.join(folder, "screen.png"), Buffer.from("png-bytes"));
      fs.writeFileSync(path.join(folder, "result.json"), JSON.stringify({ title: "preview", text: req.html.replace(/<[^>]+>/g, " ") }));
      return { code: 0, output: "" };
    },
  };
  const mcp = { servers: () => ["support"], list: async () => [], call: async () => ({ ok: true, delivery: { posted: true } }) };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox, now: () => Date.now() });
  const job = ledger.createJob("conv", { kind: "command", role, actorId, ticket: 1875, channelId: CH, replyChannel: CH, source: { channelId: CH, channelName: "ticket-bug-fixture-1875", messageId: "1573728600182755459", authorId: actorId, role, content, at: new Date().toISOString() }, deadline: 9e15 });
  job.state = "running"; ledger.data.disclosed = { 1875: { at: 1, posted: true } };
  return { ledger, broker, job, runs, config, d: ledger.data, dir };
}
const HTML = "<html><body><div class='tip'><p>Your plant sold 55% of its output last turn.</p><p>Local market: 20% short of Healthcare services.</p></div></body></html>";

test("a request for a picture is real work, not a quick chat turn", () => {
  assert.equal(quickQuestion(ASK), false);
  assert.equal(quickQuestion("can you show me the mockup?"), false);
  assert.equal(quickQuestion("can you explain the tooltip?"), true, "an ordinary question stays quick");
});

test("the preview tool is offered to the owner or staff who asked for a picture, never because a player asked", () => {
  const f = setup();
  assert.equal(preview.requested(f.job, f.config), true);
  const p = setup({ role: "player", actorId: PLAYER, content: "can you send me a screenshot of what it should look like?" });
  assert.equal(preview.requested(p.job, p.config), false);
  const ticket = { kind: "ticket", role: "support", source: { authorId: PLAYER, content: "here is a screenshot" }, inbox: [{ authorId: STAFF, content: "Keir show us a mockup of the fix" }] };
  assert.equal(preview.requested(ticket, f.config), true);
  assert.ok(!briefprofile.RARE_TOOLS.includes("render_preview"), "not hidden behind call_tool");
});

test("1875: the preview is posted as an image, labelled, with no handoff line and no source line", async () => {
  const f = setup();
  const r = await f.broker.tool(f.job, "render_preview", { html: HTML, caption: "The plant line and the market line, split so they no longer contradict each other." });
  assert.equal(r.posted, true);
  assert.equal(f.runs[0].computer, true, "rendered in the network-isolated computer sandbox");
  const entry = Object.values(f.d.outbox).find((e) => e.preview);
  assert.ok(entry, "queued for delivery");
  assert.ok(entry.content.startsWith(preview.LABEL));
  assert.ok(!/developers|From:/.test(entry.content));
  assert.equal(entry.files.length, 1);
  assert.match(entry.files[0].path, /\/artifacts\/preview-[a-f0-9]{12}-[a-f0-9]{12}\.png$/, "matches the outbox's own-image rule");
  assert.ok(fs.existsSync(entry.files[0].path));
  assert.ok(r.renderedText.includes(preview.LABEL), "the label is drawn into the image itself");
});

test("a caption that deflects is refused before anything is drawn", async () => {
  const f = setup();
  f.job.raisedToDevelopers = [{ id: 255644, workerRun: "cw-1875-59", at: 1 }];
  f.d.codingWorkers = { runs: { "cw-1875-59": { id: "cw-1875-59", ticket: 1875, state: "to_staging", pr: 7084 } } };
  await assert.rejects(f.broker.tool(f.job, "render_preview", { html: HTML, caption: "This is how it would look; it is with the developers now." }), /who asked you directly/);
  assert.equal(f.runs.length, 0);
});

test("a real render failure is said once, specifically, and then the text can go out", async () => {
  const f = setup({ fail: true });
  await assert.rejects(f.broker.tool(f.job, "render_preview", { html: HTML }), /could not be drawn: the preview browser did not start/);
  assert.ok(f.job.previewFailure);
  const truth = require("../lib/operator/handofftruth");
  assert.equal(truth.deflection("I cannot render the preview right now: the preview browser did not start. Here is the wording instead.", { d: f.d, job: f.job, config: f.config, previewFailed: true }), null);
});

test("players and findings cannot draw previews; the switch turns delivery off", async () => {
  const p = setup({ role: "player", actorId: PLAYER });
  await assert.rejects(p.broker.tool(p.job, "render_preview", { html: HTML }), /owner and staff|cannot authorize/);
  const off = setup({ controlsOverride: controls.staticControls({ imageDelivery: "off" }) });
  await assert.rejects(off.broker.tool(off.job, "render_preview", { html: HTML }), /image delivery is off/);
  assert.equal(off.runs.length, 0);
});

test("the label strip is forced on top of whatever the HTML does", () => {
  const out = preview.labelled("<html><body style='margin:0'><h1>x</h1></body></html>");
  assert.ok(out.indexOf(preview.LABEL) < out.indexOf("<h1>"));
  assert.match(out, /z-index:2147483647!important/);
});
