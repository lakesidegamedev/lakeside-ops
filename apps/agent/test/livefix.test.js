"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyLiveFix } = require("../lib/operator/livefix");
const { displayOnlyDiff } = require("../lib/operator/blastradius");

const WEB = "a".repeat(40), WORKER = "b".repeat(40), GH_WEB = "c".repeat(40);
function fixture({ worker = false, fileError = false, laterWorker = false, probe = { web: WEB, worker: WORKER }, compare = {}, health = { status: 200, body: { status: "ok" } }, deployments = {} } = {}) {
  const calls = [], probes = [];
  const api = async ([route]) => {
    calls.push(route);
    if (/pulls\/7$/.test(route)) return { merged: true, merge_commit_sha: "abc1234" };
    if (/\/files\?/.test(route)) {
      if (fileError) throw new Error("GitHub offline");
      const page = Number(new URL(`https://example.com/${route}`).searchParams.get("page"));
      if (laterWorker && page === 1) return Array.from({ length: 100 }, () => ({ filename: "src/components/Test.tsx" }));
      return [{ filename: worker || laterWorker ? "scripts/turn-worker.ts" : "src/components/Test.tsx" }];
    }
    if (/\/deployments\?/.test(route)) {
      const env = decodeURIComponent(new URL(`https://example.com/${route}`).searchParams.get("environment"));
      const d = deployments[env];
      return d ? [{ id: 11, sha: d.sha }] : [];
    }
    if (/\/deployments\/11\/statuses/.test(route)) {
      const d = Object.values(deployments)[0];
      return [{ state: d.state }];
    }
    if (/compare\//.test(route)) {
      const base = route.split("/compare/")[1].split("...")[0];
      return { status: compare[base] || "behind" };
    }
    throw new Error(`unexpected ${route}`);
  };
  const probeFn = async (service) => { probes.push(service); return probe[service] || null; };
  const fetchImpl = async () => { if (health.throws) throw new Error("offline"); return { status: health.status, json: async () => health.body }; };
  return { calls, probes, run: () => verifyLiveFix({ api, number: 7, probe: probeFn, fetchImpl }) };
}

test("closure needs the running commit to contain the fix and a healthy site", async () => {
  const ok = await fixture().run();
  assert.equal(ok.live, true);
  assert.deepEqual(ok.deployment, { web: { sha: WEB, source: "live-probe" } });
  assert.equal((await fixture({ compare: { [WEB]: "ahead" } }).run()).live, false);
  assert.equal((await fixture({ compare: { [WEB]: "diverged" } }).run()).live, false);
  assert.equal((await fixture({ probe: {} }).run()).reason, "the main server deployed commit unavailable");
  assert.equal((await fixture({ health: { status: 503, body: { status: "ok" } } }).run()).live, false);
  assert.equal((await fixture({ health: { status: 200, body: { status: "degraded" } } }).run()).live, false);
  assert.equal((await fixture({ health: { throws: true } }).run()).live, false);
  assert.equal((await fixture({ fileError: true }).run()).live, false);
});

test("worker files after the first page require the turn worker commit", async () => {
  const f = fixture({ laterWorker: true, compare: { [WORKER]: "ahead" } });
  const out = await f.run();
  assert.equal(out.live, false);
  assert.equal(out.reason, "the fix is not deployed on the turn worker");
  assert.ok(f.calls.some((r) => r.includes("page=2")));
  assert.deepEqual(f.probes, ["web", "worker"]);
  assert.equal((await fixture({ worker: true, probe: { web: WEB } }).run()).live, false);
  const both = await fixture({ worker: true }).run();
  assert.equal(both.live, true);
  assert.deepEqual(Object.keys(both.deployment), ["web", "worker"]);
  // Web-only fixes never consult the worker.
  const web = fixture();
  await web.run();
  assert.deepEqual(web.probes, ["web"]);
});

test("a successful US box GitHub deployment wins over the probe; anything else falls back", async () => {
  const gh = fixture({ deployments: { "box/ahd-us-web": { sha: GH_WEB, state: "success" } } });
  const out = await gh.run();
  assert.equal(out.live, true);
  assert.deepEqual(out.deployment.web, { sha: GH_WEB, source: "github-deployment" });
  assert.deepEqual(gh.probes, []);
  assert.ok(gh.calls.some((r) => r.includes("environment=box%2Fahd-us-web")));
  assert.ok(!gh.calls.some((r) => /environment=production\b/.test(r)));
  const pending = fixture({ deployments: { "box/ahd-us-web": { sha: GH_WEB, state: "in_progress" } } });
  assert.deepEqual((await pending.run()).deployment.web, { sha: WEB, source: "live-probe" });
  assert.deepEqual(pending.probes, ["web"]);
});

const row = (filename, before, after) => ({ filename, status: "modified", additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-${before}\n+${after}` });
test("unattended display changes reject transaction logic, service workers, renames and missing diffs", () => {
  assert.equal(displayOnlyDiff([row("src/components/Price.tsx", "  <p>Loading</p>", "  <p>Price unavailable</p>")]).allowed, true);
  assert.equal(displayOnlyDiff([row("src/app/page.tsx", "const amount = Number(input);", "const amount = Number(input) * 100;")]).allowed, false);
  assert.equal(displayOnlyDiff([row("src/components/Trade.tsx", "  <button disabled>Buy</button>", "  <button>Buy</button>")]).allowed, false);
  assert.equal(displayOnlyDiff([row("public/service-worker.js", "fetch('/api');", "fetch('https://outside.test');")]).allowed, false);
  assert.equal(displayOnlyDiff([{ filename: "src/app/page.tsx" }]).allowed, false);
  assert.equal(displayOnlyDiff([{ ...row("src/app/page.tsx", "<p>A</p>", "<p>B</p>"), previous_filename: "src/lib/money.ts" }]).allowed, false);
  assert.equal(displayOnlyDiff([row("src/app/globals.css", "p { color: red; }", "p { color: blue; }")]).allowed, true);
});
