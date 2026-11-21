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
  assert.equal(p.controls?.since?.cards, undefined, "a preview run does not start the clock");
  assert.deepEqual(p, {}, "and writes nothing at all to the ledger (review N7)");
});

// Review 4 N2 (the reviewer's gates.js): a switches file that exists but cannot be used fails safe, is logged once per
// change, and clears as soon as the file parses again.
test("review 4 N2: an empty, malformed, non-object or unreadable switches file puts every pass in preview and keeps closes off", () => {
  const env = { KEIR_OPEN_PR_CLOSES: "on", KEIR_OPEN_PR_BRANCH_DELETES: "on" };
  const cases = [["empty", ""], ["blank", "  \n"], ["trailing comma", '{"preview": true,}'], ["array", "[]"], ["null", "null"], ["string", '"on"'], ["unreadable", { code: "EACCES" }]];
  for (const [label, text] of cases) {
    const lines = [], audits = [];
    const c = createControls({ env, readFile: () => { if (typeof text === "object") throw Object.assign(new Error("denied"), text); return text; }, log: (l) => lines.push(l), audit: (k, d) => audits.push({ k, ...d }) });
    for (const [name, sw] of Object.entries(SWITCHES)) {
      const g = c.gate(name, { destructive: !sw.on });
      assert.equal(g.act, false, `${label}: ${name} must not act`);
      assert.equal(g.run, sw.on, `${label}: ${name} ${sw.on ? "previews" : "stays off"}`);
    }
    assert.ok(c.settings().fileProblem, label);
    assert.equal(lines.length, 1, `${label}: logged once`);
    assert.match(lines[0], /every pass is in preview/);
    assert.equal(audits[0].k, "switches_file_unusable");
  }
  // A leading byte-order mark is not a problem: the file says preview, and it is read as preview.
  const bom = createControls({ readFile: () => "﻿{\"preview\": false}" });
  assert.equal(bom.settings().fileProblem, null);
  assert.equal(bom.gate("githubReconcile").act, true);
});

test("review 4 N2: the problem is logged once per change of the file and clears as soon as the file parses again", () => {
  let text = '{"preview": true,}', clock = 0;
  const lines = [];
  const c = createControls({ env: {}, readFile: () => text, now: () => clock, log: (l) => lines.push(l) });
  for (let i = 0; i < 5; i++) { clock += 10000; c.gate("promiseWakes"); }
  assert.equal(lines.length, 1, "the same bad file is told once");
  text = "[]"; clock += 10000; c.gate("promiseWakes");
  assert.equal(lines.length, 2, "a different bad file is told again");
  // The opposite: a valid file takes effect at the next pass, with no restart, and the problem is gone.
  text = '{"promiseWakes": "on"}'; clock += 10000;
  assert.equal(c.gate("promiseWakes").act, true);
  assert.equal(c.settings().fileProblem, null);
  assert.match(lines[2], /usable again/);
  clock += 10000; c.gate("promiseWakes");
  assert.equal(lines.length, 3);
  // A missing file is normal: the defaults, and nothing logged.
  const quiet = [];
  const missing = createControls({ env: {}, readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, log: (l) => quiet.push(l) });
  for (const [name, sw] of Object.entries(SWITCHES)) assert.equal(missing.mode(name), sw.on ? "on" : "off");
  assert.equal(missing.settings().fileProblem, null);
  assert.deepEqual(quiet, []);
});

test("review 4 N2: in a file that parses, an unknown key or unusable value is ignored with a warning, never read as on", () => {
  const lines = [];
  const c = createControls({ env: { KEIR_OPEN_PR_CLOSES: "on" }, readFile: () => JSON.stringify({ bogus: 1, githubReconcile: "enabled", openPrCloses: "yes please", historyDays: "a week", promiseWakes: "off" }), log: (l) => lines.push(l) });
  const s = c.settings();
  assert.equal(s.fileProblem, null);
  assert.equal(s.switches.githubReconcile, "preview", "an unusable value on a pass that defaults on previews");
  assert.equal(s.switches.openPrCloses, "off", "an unusable value on a destructive pass is off, even with the environment on");
  assert.equal(s.switches.promiseWakes, "off", "a good value next to bad ones still counts");
  assert.equal(s.switches.decisionCards, "on", "untouched switches keep their default");
  assert.equal(s.historyDays, 7);
  assert.equal(s.warnings.length, 4);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /unknown key "bogus" ignored/);
  // An unusable preview value means preview.
  assert.equal(resolve({ fileText: '{"preview": "enabled"}' }).preview, true);
  assert.equal(resolve({ fileText: '{"preview": false}', env: { KEIR_PREVIEW: "1" } }).preview, false, "a file that parses can still turn preview off");
});
