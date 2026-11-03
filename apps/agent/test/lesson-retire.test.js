"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNotebook } = require("../lib/operator/knowledge");
const { planRetirements, recordMultiplier, recordMultipliers, jaccard } = require("../lib/operator/lessonretire");

const DAY = 86400000, NOW = 100 * DAY;
const lesson = (id, text, extra = {}) => ({ id, kind: "lesson", text, at: NOW - 30 * DAY, ...extra });
const A = "Answer every direct question a player asks in at least one full line";
const A2 = "Answer every direct question a player asks in at least one line";

test("jaccard compares word sets", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["c"])), 0);
});

test("near duplicates retire the less recalled one, then the unverified, then the older", () => {
  const plan = planRetirements({ now: NOW, notes: [lesson("x", A, { recalls: 4 }), lesson("y", A2, { recalls: 1 })] });
  assert.deepEqual(plan.map((p) => [p.id, p.rule]), [["y", "duplicate"]]);
  assert.deepEqual(planRetirements({ now: NOW, notes: [lesson("x", A, { verifiedAt: 1 }), lesson("y", A2)] }).map((p) => p.id), ["y"]);
  assert.deepEqual(planRetirements({ now: NOW, notes: [lesson("x", A, { at: NOW - DAY }), lesson("y", A2)] }).map((p) => p.id), ["y"]);
  assert.deepEqual(planRetirements({ now: NOW, notes: [lesson("x", A), lesson("y", "Never promise a repair will run at a moment Keir does not control")] }), []);
});

test("different players never count as duplicates", () => {
  assert.deepEqual(planRetirements({ now: NOW, notes: [lesson("x", A, { player: "1" }), lesson("y", A2, { player: "2" })] }), []);
});

test("stale only after a failed rewrite; decisions and recently recalled lessons are untouchable", () => {
  const notes = [
    lesson("s1", "Stale lesson about the cache path layout", { invalidatedAt: 1, lastVerificationAttempt: 2, verificationError: "boom" }),
    lesson("s2", "Invalidated but not yet tried by the verifier", { invalidatedAt: 1 }),
    lesson("s3", "Stale lesson recalled yesterday about something", { invalidatedAt: 1, lastVerificationAttempt: 2, verificationError: "boom", lastRecalledAt: NOW - DAY }),
    { id: "d1", kind: "decision", text: "Stale decision about the cache path layout", at: 1, invalidatedAt: 1, lastVerificationAttempt: 2, verificationError: "boom" },
  ];
  assert.deepEqual(planRetirements({ now: NOW, notes }).map((p) => [p.id, p.rule]), [["s1", "stale"]]);
});

test("the unused rule retires, the cap holds and the plan is stable", () => {
  const notes = Array.from({ length: 8 }, (_, i) => lesson(`u${i}`, `Unique lesson number ${i} about topic${i} wording${i} extra${i}`));
  const report = { lessons: notes.map((n) => ({ id: n.id, flags: ["unused"] })) };
  const plan = planRetirements({ now: NOW, notes, report, cap: 5 });
  assert.equal(plan.length, 5);
  assert.ok(plan.every((p) => p.rule === "unused"));
  assert.deepEqual(planRetirements({ now: NOW, notes, report, cap: 5 }), plan);
});

test("record multiplier is bounded, needs three tickets, and rewards a good record", () => {
  const base = { resolved: 0.5, reopened: 0.1, negative: 0.1 };
  assert.equal(recordMultiplier({ tickets: 2, resolved: 1, reopened: 0, negative: 0 }, base), 1);
  assert.equal(recordMultiplier({ tickets: 5, resolved: 1, reopened: 0, negative: 0 }, base), 1.25);
  assert.equal(recordMultiplier({ tickets: 5, resolved: 0, reopened: 1, negative: 1 }, base), 0.8);
  assert.equal(recordMultiplier({ tickets: 5, resolved: 0.5, reopened: 0.1, negative: 0.1 }, base), 1);
  const m = recordMultipliers({ baseline: base, lessons: [{ id: "g", tickets: 4, resolved: 0.75, reopened: 0, negative: 0 }, { id: "n", tickets: 4, resolved: 0.5, reopened: 0.1, negative: 0.1 }] });
  assert.ok(m.get("g") > 1 && m.get("g") <= 1.25 && !m.has("n"));
});

const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retire-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  return createNotebook({ file: path.join(dir, "notebook.json"), exec: () => "", now: () => (clock += 1000) });
};

test("retire is audited, capped per day, never touches decisions, and restore reverses it", (t) => {
  const nb = fixture(t);
  const ids = ["one", "two", "three"].map((w) => nb.remember({ kind: "lesson", text: `Lesson ${w} about wording ${w} that is long enough` }).id);
  const dec = nb.remember({ kind: "decision", text: "A decision that must never be retired by this" });
  const done = nb.retire([{ id: ids[0], rule: "unused", reason: "r1" }, { id: dec.id, rule: "unused", reason: "no" }, { id: ids[1], rule: "duplicate", reason: "r2" }], { dailyCap: 1, backup: false });
  assert.equal(done.length, 1);
  assert.equal(nb.all().some((n) => n.id === ids[0]), false);
  assert.ok(nb.all().some((n) => n.id === dec.id));
  const note = nb.archive().find((n) => n.id === ids[0]);
  assert.deepEqual([note.history.at(-1).op, note.history.at(-1).reason], ["retired", "r1"]);
  assert.equal(nb.retire([{ id: ids[1], rule: "unused", reason: "again" }], { dailyCap: 1, backup: false }).length, 0, "daily cap");
  assert.equal(nb.restore(ids[0]), true);
  assert.ok(nb.all().some((n) => n.id === ids[0]));
  assert.equal(nb.restore(ids[2]), false, "a live lesson cannot be restored");
});

test("a good record lifts a lesson above an equal-scoring one in recall", (t) => {
  const nb = fixture(t);
  const a = nb.remember({ kind: "lesson", text: "Reply with the refund policy wording before closing a billing ticket" });
  const b = nb.remember({ kind: "lesson", text: "Reply with the refund policy wording before escalating a billing ticket" });
  nb.setBoost(new Map([[a.id, 0.8], [b.id, 1.25]]));
  assert.equal(nb.recall("reply refund policy wording billing ticket")[0].id, b.id);
  nb.setBoost(new Map([[a.id, 1.25], [b.id, 0.8]]));
  assert.equal(nb.recall("reply refund policy wording billing ticket")[0].id, a.id);
});
