"use strict";
// Keir 11.2 third pass (review M7): the read-only report command prints what the new passes would do, writes nothing,
// and says what it could not check when GitHub is unreachable.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { buildPreview, render } = require("../bin/keir-preview");
const { resolve } = require("../lib/operator/controls");

const NOW = Date.parse("2026-11-21T03:00:00Z"), H = 3600000;
function ledgerData() {
  return {
    version: 1, paused: false, seen: { "ticket:1868": "j1868" }, outbox: {}, audit: [], channels: {},
    jobs: {
      j1868: { id: "j1868", kind: "ticket", ticket: 1868, state: "blocked", channelId: "c" },
      f1: { id: "f1", kind: "finding", state: "blocked", at: NOW - 400 * H, stateAt: NOW - 200 * H, summary: "old finding", effects: {} },
    },
    actions: {},
    decisions: {
      a: { id: "a", jobId: "j1868", state: "approve", answeredBy: "o", answeredAt: NOW - 2 * H, decisionKey: "kanban:255573", question: "Ship it?", sent: { o: { messageId: "m1" } } },
    },
    ticketPromises: { 1868: [{ id: "1868-x", at: NOW - 3 * H, jobId: "j1868", state: "open", wakes: 0, kind: "plain", text: "I'll check this again and tell you.", dueAt: NOW - H }] },
    refusedPosts: { 1845: [{ at: NOW - H, rule: "hourly_post_cap_refused", job: "j", text: "Update five." }] },
  };
}

test("the report lists every pass's would-be actions with reasons, from a copy, and changes nothing", async () => {
  const data = ledgerData();
  const before = JSON.stringify(data);
  const pr = { number: 7001, title: "PR 7001", user: { login: "keir-bot" }, draft: false, state: "open", created_at: "2026-11-01T00:00:00Z", head: { ref: "keir/task-a", sha: "h", repo: { full_name: "lakesidegamedev/AHDGame" } }, body: "x\n\n## Conflict of interest\n\n- [x] no", mergeable: true };
  const api = async ([route]) => {
    if (/pulls\?state=open/.test(route)) return [pr];
    if (/pulls\?state=closed/.test(route)) return [];
    if (/check-runs/.test(route)) return { check_runs: [{ name: "verify", status: "completed", conclusion: "failure" }] };
    if (/pulls\/7001\/commits/.test(route)) return [{ commit: { author: { email: "keir@localhost" }, committer: { email: "keir@localhost" } }, parents: [{}] }];
    if (/pulls\/7001$/.test(route)) return pr;
    if (/matching-refs/.test(route)) return [];
    throw new Error("HTTP 404");
  };
  const out = await buildPreview({ data, settings: resolve({}), api, now: NOW, env: {} });
  const actions = out.items.map((x) => `${x.pass}:${x.action}`);
  assert.ok(actions.includes("open-prs:owner line"), actions.join(","));
  assert.ok(actions.includes("decision-cards:complete card"));
  assert.ok(actions.includes("promises:wake"));
  assert.ok(actions.includes("finding-expiry:close finding"));
  assert.ok(actions.includes("decision-dms:edit owner DM"));
  assert.equal(out.refused[0].rule, "hourly_post_cap_refused");
  assert.equal(data.jobs.j1868.state, "blocked", "the promise wake was only previewed");
  assert.equal(data.jobs.f1.state, "blocked", "the finding was only previewed");
  assert.equal(JSON.parse(before).decisions.a.cardClosedAt, undefined);
  const text = render(out, { settings: resolve({}), killSwitch: "released", paused: false, github: true });
  assert.match(text, /openPrCloses\s+off\s+KEIR_OPEN_PR_CLOSES/);
  assert.match(text, /Posts refused by the post rules in the last 7 days \(1\):\n  - ticket 1845/);
  assert.doesNotMatch(text, /[–—]/);
});

test("the command runs against a state directory read only, and says what it could not check without GitHub", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-preview-"));
  const file = path.join(dir, "ledger.json");
  fs.writeFileSync(file, JSON.stringify(ledgerData()));
  fs.chmodSync(file, 0o400);
  const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const h0 = hash(), m0 = fs.statSync(file).mtimeMs;
  const out = execFileSync(process.execPath, [path.join(__dirname, "../bin/keir-preview.js"), "--no-github", "--state-dir", dir], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } });
  assert.match(out, /Nothing was changed\./);
  assert.match(out, /Could not check \(\d+\):/);
  assert.match(out, /not contacted \(--no-github\)/);
  assert.equal(hash(), h0);
  assert.equal(fs.statSync(file).mtimeMs, m0);
  assert.deepEqual(fs.readdirSync(dir), ["ledger.json"], "no file written next to the ledger");
  const json = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "../bin/keir-preview.js"), "--no-github", "--json", "--state-dir", dir], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } }));
  assert.ok(Array.isArray(json.items) && Array.isArray(json.unchecked));
});
