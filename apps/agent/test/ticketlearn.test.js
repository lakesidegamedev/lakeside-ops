"use strict";
// Keir 9: what Keir keeps from a closed ticket (fake ledger data and a real notebook with a stubbed git).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { createNotebook } = require("../lib/operator/knowledge");
const learn = require("../lib/operator/ticketlearn");

const FILE = "server/src/engine/supply.ts";
const OTHER = "server/src/ui/inputsPanel.ts";
function notebook() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-learn-"));
  const sha = { current: "a".repeat(40) };
  const exec = (_cmd, args) => { if (args.includes("rev-parse")) return sha.current + "\n"; throw new Error("unexpected git call"); };
  return { nb: createNotebook({ file: path.join(dir, "nb.json"), exec }), sha };
}
const job = { id: "j1", ticket: 5001, role: "support" };
const search = (paths) => ({ index: "dev", files: paths, hits: paths.map((p) => ({ path: p, source: "code", text: "x" })) });
const read = (d, paths, j = job) => learn.noteRead(d, j, "read_tool", { server: "ops-knowledge", tool: "code_search", args: { question: "q" } }, search(paths), 1000);
const RULE = "The inputs panel only lists inputs your plant already has, so a missing supply never shows as a missing input.";

test("a clean close with a code read keeps one mechanic tied to the file", () => {
  const { nb } = notebook(), d = {};
  read(d, [FILE, "docs/readme.md"]);
  learn.notePost(d, 5001, RULE, 2000);
  const out = learn.keep({ d, notebook: nb, ticket: 5001 });
  assert.equal(out.kept, true);
  assert.ok(out.resolution && !out.lesson);
  const notes = nb.all();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, "resolution");
  assert.equal(notes[0].path, FILE);
  assert.match(notes[0].text, /inputs panel only lists inputs/);
  assert.ok(notes[0].sources.some((s) => s.type === "ticket" && s.number === 5001));
  assert.ok(notes[0].sources.some((s) => s.type === "code" && s.path === FILE));
});

test("nothing is kept without a code read, or without a rule answer", () => {
  const { nb } = notebook();
  const d = {};
  learn.notePost(d, 5001, RULE, 2000);
  assert.equal(learn.keep({ d, notebook: nb, ticket: 5001 }).kept, false);
  const d2 = {};
  read(d2, [FILE]);
  learn.notePost(d2, 5001, "Which turn did you first see it?", 2000);
  assert.equal(learn.keep({ d: d2, notebook: nb, ticket: 5001 }).reason, "no rule answer");
  assert.equal(nb.all().length, 0);
  // a wiki-only hit is not a code read
  const d3 = {};
  learn.noteRead(d3, job, "read_tool", { server: "ops-knowledge", tool: "code_search", args: {} }, { files: ["wiki/x"], hits: [{ path: "wiki/x.md", source: "wiki" }] }, 1);
  learn.notePost(d3, 5001, RULE, 2000);
  assert.equal(learn.keep({ d: d3, notebook: nb, ticket: 5001 }).reason, "no code read");
  // a failed read or another server is not a code read
  learn.noteRead(d3, job, "read_tool", { server: "gamestate", tool: "code_search", args: {} }, search([FILE]), 1);
  learn.noteRead(d3, job, "read_tool", { server: "ops-knowledge", tool: "code_search", args: {} }, { error: "x", ...search([FILE]) }, 1);
  assert.equal(learn.keep({ d: d3, notebook: nb, ticket: 5001 }).kept, false);
});

test("a retraction keeps a lesson (wrong, right, file) and the corrected rule", () => {
  const { nb } = notebook(), d = {};
  read(d, [FILE]);
  learn.notePost(d, 5001, "The supply charge is always zero because plants never pay for their own deliveries.", 2000);
  learn.notePost(d, 5001, "Correction: your own plants are charged the supply price on their own deliveries, it just shows on the margin line.", 3000);
  const out = learn.keep({ d, notebook: nb, ticket: 5001 });
  assert.ok(out.lesson && out.resolution);
  const lesson = nb.all().find((n) => n.kind === "lesson");
  assert.match(lesson.text, /Wrong: "The supply charge is always zero/);
  assert.match(lesson.text, /Right: "your own plants are charged/);
  assert.ok(lesson.text.includes(FILE));
  const mech = nb.all().find((n) => n.kind === "resolution");
  assert.doesNotMatch(mech.text, /always zero/);
  assert.match(mech.text, /your own plants are charged/);
});

test("a correction without an earlier rule answer keeps the mechanic but no lesson", () => {
  const { nb } = notebook(), d = {};
  read(d, [FILE]);
  learn.notePost(d, 5001, "Correction: the charge is per delivered unit, not per turn.", 3000);
  const out = learn.keep({ d, notebook: nb, ticket: 5001 });
  assert.ok(out.resolution && !out.lesson);
});

test("de-duplicates on the same file: the newer ticket updates the note", () => {
  const { nb } = notebook();
  const d = {};
  read(d, [FILE]);
  learn.notePost(d, 5001, RULE, 2000);
  const first = learn.keep({ d, notebook: nb, ticket: 5001 });
  // same close again: nothing new
  assert.equal(learn.keep({ d, notebook: nb, ticket: 5001 }).reason, "already kept");
  const d2 = {};
  learn.noteRead(d2, { id: "j2", ticket: 5002, role: "support" }, "read_tool", { server: "ops-knowledge", tool: "code_read", args: { path: FILE } }, { path: FILE, files: [FILE] }, 1);
  learn.notePost(d2, 5002, "The inputs panel shows no missing input because supply is charged on every delivery, including your own plants.", 5000);
  const second = learn.keep({ d: d2, notebook: nb, ticket: 5002 });
  assert.ok(second.resolution && second.resolution !== first.resolution, JSON.stringify(second));
  assert.equal(nb.all().filter((n) => n.kind === "resolution").length, 1);
  assert.equal(nb.all()[0].id, second.resolution);
  assert.equal(nb.archive().find((n) => n.id === first.resolution).supersededBy, second.resolution);
});

test("an existing hand-written note on the file is not overwritten", () => {
  const { nb } = notebook();
  nb.remember({ kind: "mechanic", path: FILE, text: "A hand written note about the supply file.", by: "owner" });
  const d = {};
  read(d, [FILE]);
  learn.notePost(d, 5001, RULE, 2000);
  const out = learn.keep({ d, notebook: nb, ticket: 5001 });
  assert.equal(out.kept, false);
  assert.equal(nb.all().length, 1);
});

test("the kept mechanic goes stale when its file changes", () => {
  const { nb, sha } = notebook(), d = {};
  read(d, [FILE]);
  learn.notePost(d, 5001, RULE, 2000);
  learn.keep({ d, notebook: nb, ticket: 5001 });
  assert.equal(nb.recall("inputs panel missing supply input", {})[0].stale, undefined);
  sha.current = "b".repeat(40);
  assert.match(nb.recall("inputs panel missing supply input", {})[0].stale, /changed/);
});

test("recalled into the next ticket's context by its question", () => {
  const { nb } = notebook(), d = {};
  read(d, [FILE]);
  learn.notePost(d, 5001, RULE, 2000);
  learn.keep({ d, notebook: nb, ticket: 5001 });
  const hits = nb.recall("My plant is idle and the inputs panel does not name any missing input, why?", { ticket: 5009, k: 6 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "resolution");
  assert.match(hits[0].text, /inputs panel only lists inputs/);
  assert.deepEqual(nb.recall("what is the weather", { ticket: 5009 }), []);
});

test("broker wiring: reads and posts are noted, and a resolve keeps the mechanic", async () => {
  const { createLedger } = require("../lib/operator/store");
  const { createBroker } = require("../lib/operator/broker");
  const CH = "777777777777777777";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir9-learn-b-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const { nb } = notebook();
  const config = { ownerId: "111111111111111111", staffIds: ["222222222222222222"], botId: "333333333333333333", guildId: "444444444444444444", scanChannels: [], taskLifetimeMs: 86400000, closeGraceMs: 3600000, maxIntakePerHour: 4, supportDeferred: () => false };
  const mcp = { servers: () => ["support", "ops-knowledge"], list: async () => ["support_public_update", "support_resolve", "code_search"].map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })),
    call: async (_s, tool) => (tool === "code_search" ? search([FILE]) : { ok: true, id: "c", delivery: { posted: true, delivery: { status: "posted" } } }) };
  const broker = createBroker({ ledger, config, mcp, discord: async () => [], sandbox: { run: async () => ({ code: 0, output: "" }) }, now: () => 10 * 3600000, notebook: nb });
  const j = ledger.createJob("t", { role: "support", kind: "ticket", ticket: 5003, channelId: CH, replyChannel: CH, source: { channelId: CH, content: "why" }, deadline: 9e15 });
  j.state = "running"; ledger.data.seen["ticket:5003"] = j.id; ledger.data.disclosed = { 5003: { at: 1, posted: true } };
  await broker.tool(j, "read_tool", { server: "ops-knowledge", tool: "code_search", args: { question: "supply charge", claimType: "mechanic" } });
  assert.deepEqual(ledger.data.ticketLearn["5003"].reads.map((r) => r.path), [FILE]);
  await broker.tool(j, "channel_reply", { message: RULE });
  assert.equal(ledger.data.ticketLearn["5003"].posts.length, 1);
  const out = learn.keep({ d: ledger.data, notebook: nb, ticket: 5003 });
  assert.equal(out.kept, true);
});

test("audit: the kept answer is an unverified resolution, and recall labels it as such", () => {
  const { nb } = notebook(), d = {};
  read(d, [FILE]);
  learn.notePost(d, 5001, RULE, 2000);
  learn.keep({ d, notebook: nb, ticket: 5001 });
  const note = nb.all()[0];
  assert.equal(note.kind, "resolution");
  assert.equal(note.verified, false);
  assert.equal(nb.all().filter((n) => n.kind === "mechanic").length, 0, "never an authoritative mechanic");
  const hit = nb.recall("My plant is idle and the inputs panel does not name any missing input, why?", { ticket: 5009, k: 6 })[0];
  assert.equal(hit.verified, false);
  assert.match(hit.label, /an earlier answer on ticket 5001, not verified; check it against the code before relying on it/);
  assert.match(hit.text, /^\(an earlier answer on ticket 5001, not verified/);
});

test("audit: a retraction lesson's right claim is labelled unless it names what the cited file is about", () => {
  const unlabelled = notebook(), d1 = {};
  read(d1, [FILE]);
  learn.notePost(d1, 5001, "The supply charge is always zero because plants never pay for their own deliveries.", 2000);
  learn.notePost(d1, 5001, "Correction: your own plants are charged the supply price on their own deliveries, it just shows on the margin line.", 3000);
  learn.keep({ d: d1, notebook: unlabelled.nb, ticket: 5001 });
  const settled = unlabelled.nb.all().find((n) => n.kind === "lesson");
  assert.equal(settled.verified, undefined);
  const labelled = notebook(), d2 = {};
  read(d2, [FILE]);
  learn.notePost(d2, 5001, "The charge is always zero because plants never pay for their own deliveries.", 2000);
  learn.notePost(d2, 5001, "Correction: the figure is booked at the end of each period, in your ledger lines.", 3000);
  learn.keep({ d: d2, notebook: labelled.nb, ticket: 5001 });
  const lesson = labelled.nb.all().find((n) => n.kind === "lesson");
  assert.equal(lesson.verified, false);
  assert.match(lesson.text, /Not verified against the code/);
  assert.match(labelled.nb.recall("charge zero plants own deliveries ledger lines", { ticket: 5009 })[0].label, /not verified/);
});
