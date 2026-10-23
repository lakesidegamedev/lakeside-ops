"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createLedger } = require("../lib/operator/store");
const { createStarmer, clean, route, INTERVAL_MS, RETRY_MS } = require("../lib/operator/starmer");

function setup(start = Date.parse("2026-10-23T18:00:00Z")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-starmer-"));
  const ledger = createLedger(path.join(dir, "ledger.json"));
  const clock = { t: start };
  const calls = [];
  let reply = "The turn settled quietly, and the queue is shorter than it was at lunch.";
  const starmer = createStarmer({
    ledger,
    config: { ownerId: "1", stateDir: dir },
    app: null,
    now: () => clock.t,
    generate: async (facts) => { calls.push(facts); return reply; },
    log: () => {},
  });
  return { ledger, starmer, clock, calls, dir, setReply: (v) => { reply = v; } };
}

test("the widget line is generated once and then held for thirty minutes", async () => {
  const { ledger, starmer, clock, calls } = setup();
  const first = await starmer.tick();
  assert.match(first.text, /turn settled quietly/);
  assert.equal(first.at, clock.t);
  assert.equal(first.nextAt, clock.t + INTERVAL_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].release, null);
  assert.ok(Array.isArray(calls[0].previous));
  assert.ok(ledger.data.audit.some((r) => r.kind === "app_starmer_line"));
  clock.t += INTERVAL_MS - 1; await starmer.tick();
  assert.equal(calls.length, 1, "no second line inside the window");
  clock.t += 2; await starmer.tick();
  assert.equal(calls.length, 2);
});

test("a provider failure keeps the last line and retries sooner", async () => {
  const { starmer, clock, setReply, calls } = setup();
  await starmer.tick();
  const held = starmer.view().text;
  setReply("");
  clock.t += INTERVAL_MS;
  const failed = await starmer.tick();
  assert.equal(failed.text, held, "the owner keeps the last line");
  assert.equal(calls.length, 2);
  assert.equal(failed.nextAt, clock.t + RETRY_MS);
});

test("a repeated or unsafe line is refused rather than shown", async () => {
  const { starmer, clock, setReply } = setup();
  await starmer.tick();
  const first = starmer.view().text;
  clock.t += INTERVAL_MS; setReply(first);
  const again = await starmer.tick();
  assert.equal(again.text, first);
  assert.equal(again.nextAt, clock.t + RETRY_MS);
  clock.t += RETRY_MS; setReply("Read more at https://example.com and see the board.");
  const unsafe = await starmer.tick();
  assert.equal(unsafe.text, first);
});

test("clean rejects templates, URLs, line breaks and em dashes", () => {
  assert.equal(clean("A quiet turn leaves room for the next question."), "A quiet turn leaves room for the next question.");
  assert.equal(clean("Keir: A quiet turn leaves room for the next one."), "A quiet turn leaves room for the next one.");
  assert.equal(clean("Short."), null);
  assert.equal(clean("A quiet turn leaves room for the next question.\nAnd another line."), "A quiet turn leaves room for the next question. And another line.");
  assert.equal(clean("A quiet turn, see https://example.com for the rest of it."), null);
  assert.equal(clean("A quiet turn leaves room — and a pause — for the next question."), "A quiet turn leaves room, and a pause, for the next question.");
  assert.equal(clean("x".repeat(241)), null);
  assert.deepEqual(route("deepseek:deepseek-flash@low"), { runner: "deepseek", model: "deepseek-flash", effort: "low" });
  assert.deepEqual(route("ollama:deepseek-v4.1-flash"), { runner: "ollama", model: "deepseek-v4.1-flash", effort: "low" });
});

test("the swipe side reports what Keir is actually working on", async () => {
  const { ledger, starmer } = setup();
  const running = ledger.createJob("owner:running", { kind: "command", role: "owner", state: "running", summary: "Checking the turn timing", at: 1, updatedAt: 2 });
  const waiting = ledger.createJob("ticket:1575", { kind: "ticket", role: "support", ticket: 1575, state: "waiting", summary: "Waiting on the developer", at: 3, updatedAt: 4 });
  const work = starmer.working();
  assert.equal(work.running, 1);
  assert.equal(work.waiting, 1);
  assert.match(work.detail, /#1575|Checking/);
  assert.ok(work.items.some((i) => i.id === running.id));
  assert.ok(work.items.some((i) => i.id === waiting.id));
});

test("paused Keir does not spend a model call, and refresh is throttled", async () => {
  const { ledger, starmer, clock, calls } = setup();
  await starmer.tick();
  assert.equal(calls.length, 1);
  const throttled = await starmer.refresh();
  assert.equal(throttled.throttled, true);
  assert.equal(calls.length, 1);
  clock.t += 61000;
  const held = starmer.view().text;
  ledger.data.paused = true;
  const paused = await starmer.tick();
  assert.equal(paused.text, held, "the last line stays visible while paused");
  assert.equal(calls.length, 1);
});
