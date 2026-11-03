"use strict";
// Keir 8 lesson accounting: recalls are counted and logged, and the report joins them to outcomes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNotebook } = require("../lib/operator/knowledge");
const { buildReport } = require("../lib/operator/lessonreport");

const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lessons-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "notebook.json");
  let clock = 1_000_000;
  return { file, notebook: createNotebook({ file, exec: () => "", now: () => (clock += 1000) }) };
};

test("recall counts each returned note, logs the recall with its job, and the counters survive a restart", (t) => {
  const { file, notebook } = fixture(t);
  notebook.remember({ kind: "lesson", text: "Answer every direct question a player asks in at least one line." });
  notebook.remember({ kind: "lesson", text: "Never promise a repair will run at a moment Keir does not control." });
  const hits = notebook.recall("answer every direct question", { ticket: 1757, job: "j1", via: "context" });
  assert.equal(hits.length, 1);
  const [note] = notebook.all().filter((n) => /Answer every/.test(n.text));
  assert.equal(note.recalls, 1);
  assert.ok(note.lastRecalledAt > 0);
  assert.equal(notebook.all().find((n) => /Never promise/.test(n.text)).recalls, undefined, "an unreturned note is untouched");
  const lines = fs.readFileSync(notebook.recallLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual({ job: lines[0].job, ticket: lines[0].ticket, via: lines[0].via, ids: lines[0].ids }, { job: "j1", ticket: 1757, via: "context", ids: [note.id] });
  notebook.flush();
  const reloaded = createNotebook({ file, exec: () => "" });
  assert.equal(reloaded.all().find((n) => n.id === note.id).recalls, 1, "the counter was saved by flush");
});

test("a recall with no match writes nothing", (t) => {
  const { notebook } = fixture(t);
  notebook.remember({ kind: "lesson", text: "Answer every direct question a player asks in at least one line." });
  assert.deepEqual(notebook.recall("zebra giraffe okapi", { job: "j1" }), []);
  assert.equal(fs.existsSync(notebook.recallLog), false);
});

test("merging lessons keeps the combined recall count", (t) => {
  const { notebook } = fixture(t);
  notebook.remember({ kind: "lesson", text: "Answer every direct question a player asks in at least one line." });
  notebook.remember({ kind: "lesson", text: "Answer direct questions from a player even inside a crowded ticket." });
  notebook.recall("answer direct question player", { job: "j1" });
  notebook.recall("answer direct question player", { job: "j2" });
  const [a, b] = notebook.all();
  const before = (a.recalls || 0) + (b.recalls || 0);
  assert.ok(before >= 2);
  notebook.curate([{ op: "merge", ids: [a.id, b.id], text: "Answer every direct question a player asks, even in a crowded ticket." }], { backup: false });
  const live = notebook.all().filter((n) => n.kind === "lesson");
  assert.equal(live.length, 1);
  assert.equal(live[0].recalls, before);
});

test("report: unused needs a full tracking window; suspect needs enough tickets and a clear gap", () => {
  const DAY = 86400000, now = 100 * DAY;
  const lesson = (id, ageDays, extra = {}) => ({ id, kind: "lesson", text: `lesson ${id}`, at: now - ageDays * DAY, ...extra });
  const notes = [lesson("never", 30), lesson("fresh", 3), lesson("good", 30, { verifiedAt: 1 }), lesson("bad", 30)];
  const recalls = [{ at: now - 20 * DAY, job: "j0", ticket: 1, ids: ["good"] }];
  for (const t of [11, 12, 13, 14]) recalls.push({ at: now - 5 * DAY, job: `j${t}`, ticket: t, ids: ["bad"] });
  for (const t of [21, 22, 23, 24]) recalls.push({ at: now - 4 * DAY, job: `j${t}`, ticket: t, ids: ["good"] });
  const outcomes = {};
  for (const t of [21, 22, 23, 24]) outcomes[`${t}:c`] = { ticket: t, status: "resolved" };
  for (const t of [11, 12, 13, 14]) outcomes[`${t}:c`] = { ticket: t, status: "resolved", reopened: t > 11 };
  const feedback = [11, 12, 13].map((t) => ({ ticket: t, kind: "slow_or_silent" }));
  const r = buildReport({ notes, recalls, outcomes, feedback, now });
  const by = Object.fromEntries(r.lessons.map((l) => [l.id, l]));
  assert.ok(r.summary.enoughData);
  assert.ok(by.never.flags.includes("unused"), "old, never recalled, tracking long enough");
  assert.ok(!by.fresh.flags.includes("unused"), "too young to call unused");
  assert.ok(by.bad.flags.includes("suspect"), "reopened and complained about far above baseline");
  assert.ok(!by.good.flags.includes("suspect"));
  assert.ok(!by.good.flags.includes("unverified") && by.bad.flags.includes("unverified"));
  assert.equal(by.good.tickets, 5);
});

test("report: no flags until tracking is old enough", () => {
  const DAY = 86400000, now = 10 * DAY;
  const r = buildReport({ notes: [{ id: "a", kind: "lesson", text: "x", at: 0 }], recalls: [{ at: now - DAY, job: "j", ticket: 1, ids: ["b"] }], now });
  assert.equal(r.summary.enoughData, false);
  assert.ok(!r.lessons[0].flags.includes("unused"));
});
