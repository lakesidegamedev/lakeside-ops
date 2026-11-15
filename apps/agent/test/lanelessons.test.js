"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { lessonsFor, tag, laneOfText, saveLaneLesson } = require("../lib/operator/lanelessons");

const notebook = (notes) => ({ all: () => notes, remember: (n) => { notes.push({ id: String(notes.length + 1), at: notes.length, ...n }); return notes.at(-1); } });

test("lessons are served by lane, newest first, without the tag", () => {
  const nb = notebook([
    { id: "a", kind: "lesson", at: 1, text: "[lane:bug] Read the code before calling it a fault.", ticket: 11 },
    { id: "b", kind: "lesson", at: 3, text: "[lane:bug] File one item per defect." },
    { id: "c", kind: "lesson", at: 2, text: "[lane:question] Say when a unit is not unlocked yet." },
    { id: "d", kind: "lesson", at: 4, text: "No lane here, stays general." },
    { id: "e", kind: "mechanic", at: 5, text: "[lane:bug] not a lesson kind" },
  ]);
  assert.deepEqual(lessonsFor(nb, "bug").map((l) => l.text), ["File one item per defect.", "Read the code before calling it a fault."]);
  assert.equal(lessonsFor(nb, "bug")[1].ticket, 11);
  assert.equal(lessonsFor(nb, "question").length, 1);
  assert.deepEqual(lessonsFor(nb, "outage"), []);
  assert.deepEqual(lessonsFor(nb, "nope"), []);
  assert.equal(lessonsFor(nb, "bug", 1).length, 1);
});

test("saveLaneLesson tags the text and rejects an unknown lane", () => {
  const notes = [], nb = notebook(notes);
  saveLaneLesson(nb, { lane: "outage", text: "[lane:bug] Merge the second report into the incident.", ticket: 9 });
  assert.equal(notes[0].text, "[lane:outage] Merge the second report into the incident.");
  assert.equal(laneOfText(notes[0].text), "outage");
  assert.throws(() => saveLaneLesson(nb, { lane: "x", text: "long enough sentence" }), /lane must be/);
  assert.equal(tag("idea", "Capture the idea once."), "[lane:idea] Capture the idea once.");
});
