"use strict";
// Keir 11.2 third pass (review M7): one switch per new unattended behaviour, preview mode, hold, bounded first start.
const test = require("node:test");
const assert = require("node:assert");
const { resolve, createControls, staticControls, preview, history, SWITCHES } = require("../lib/operator/controls");

test("defaults: every new behaviour on except pull request closes and branch deletions; preview off", () => {
  const s = resolve({});
  for (const [name, sw] of Object.entries(SWITCHES)) assert.equal(s.switches[name], sw.on ? "on" : "off", name);
  assert.equal(s.switches.openPrCloses, "off");
  assert.equal(s.switches.openPrBranchDeletes, "off");
  assert.equal(s.preview, false);
});

test("the switches file beats the environment, which beats the default, and is read again at each pass", () => {
  let text = JSON.stringify({ openPrCloses: "on", promiseWakes: "preview" });
  let clock = 0;
  const c = createControls({ env: { KEIR_OPEN_PR_CLOSES: "off", KEIR_TURN_RULE: "0" }, readFile: () => text, now: () => clock });
  assert.equal(c.mode("openPrCloses"), "on");
  assert.equal(c.mode("turnRule"), "off");
  assert.equal(c.mode("promiseWakes"), "preview");
  text = JSON.stringify({ preview: true });
  clock += 10000;
  assert.equal(c.mode("openPrCloses"), "off", "file no longer says on; env says off");
  assert.equal(c.mode("githubReconcile"), "preview", "global preview turns every on into preview");
  assert.deepEqual(c.gate("githubReconcile"), { run: true, act: false, why: "preview mode" });
});

test("the kill switch and a pause stop every pass; the production hold stops only destructive writes", () => {
  const killed = staticControls({}, { held: "owner said stop" });
  assert.equal(killed.gate("promiseWakes").run, false);
  assert.match(killed.gate("promiseWakes").why, /kill switch engaged \(owner said stop\)/);
  const paused = createControls({ readFile: () => "{}", data: { paused: true } });
  assert.equal(paused.gate("decisionCards").run, false);
  const hold = staticControls({ openPrCloses: "on" }, { prodHold: "2026-11-22T08:00:00.000Z" });
  assert.deepEqual(hold.gate("openPrCloses", { destructive: true }), { run: true, act: false, why: "production hold until 2026-11-22T08:00:00.000Z" });
  assert.equal(hold.gate("decisionCards").act, true);
});

test("the preview record keeps one row per action and target, with the reason and a count, bounded", () => {
  const d = {};
  preview(d, "open-prs", "close", "#1", "stale", {}, 1);
  preview(d, "open-prs", "close", "#1", "stale again", {}, 2);
  assert.deepEqual(d.preview.items["open-prs:close:#1"], { pass: "open-prs", action: "close", target: "#1", reason: "stale again", firstAt: 1, lastAt: 2, count: 2 });
  for (let i = 0; i < 500; i++) preview(d, "p", "a", String(i), "r", {}, 10 + i);
  assert.equal(Object.keys(d.preview.items).length, 400);
});

test("first start: a few historical items per run, none older than the cutoff unless still open", () => {
  const d = {}, DAY = 86400000, now = 100 * DAY;
  const h = history(d, "cards", { controls: staticControls(), now });
  assert.equal(h.check(now + 1), "new");
  assert.equal(h.check(now - 20 * DAY), "too old");
  assert.equal(h.check(now - 20 * DAY, { open: true }), "take");
  assert.equal(h.check(now - DAY), "take");
  assert.equal(h.check(now - DAY), "take");
  assert.equal(h.check(now - DAY), "later");
  assert.equal(d.controls.since.cards, now);
  const later = history(d, "cards", { controls: staticControls(), now: now + DAY });
  assert.equal(later.since, now, "the first real run is remembered");
  const p = {}; history(p, "cards", { controls: staticControls(), now, act: false });
  assert.equal(p.controls.since.cards, undefined, "a preview run does not start the clock");
});
