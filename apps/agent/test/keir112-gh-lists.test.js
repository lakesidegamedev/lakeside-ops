"use strict";
// Keir 11.2 fourth pass: the open pull request list of the real repository was larger than the gh child's 1 MiB buffer,
// so the preview report and the live open-PR pass both read nothing ("stdout maxBuffer length exceeded", "open sweep
// skipped"). Lists are now paged with only the fields used, the buffer is large, and a list that cannot be read in full
// is an explicit "could not read, did nothing".
const test = require("node:test");
const assert = require("node:assert");
const { execFile } = require("node:child_process");
const { ghApi, listAll, ListReadError, PR_FIELDS } = require("../lib/operator/ghlist");
const { createKeirPrs } = require("../lib/operator/keirprs");
const { createOwnerWait } = require("../lib/operator/ownerwait");
const { buildPreview, render } = require("../bin/keir-preview");
const { resolve, staticControls } = require("../lib/operator/controls");

// Runs a real child process that prints `bytes` of JSON, with the options ghApi passes (the buffer among them).
const bigExec = (bytes) => (cmd, args, opts, cb) => execFile(process.execPath, ["-e", `process.stdout.write(JSON.stringify([{number:1,body:"x".repeat(${bytes})}]))`], { ...opts, env: process.env }, cb);

test("a reply larger than the old 1 MiB limit is read through a real child process", async () => {
  const api = ghApi({ exec: bigExec(3 << 20) });
  const rows = await api(["repos/x/pulls?state=open"]);
  assert.equal(rows[0].body.length, 3 << 20);
  // The old limit fails the same way production did.
  const old = ghApi({ exec: bigExec(3 << 20), maxBuffer: 1024 * 1024 });
  await assert.rejects(old(["repos/x/pulls"]), /maxBuffer/);
});

test("lists are paged, ask only for the fields used, and stop on a short page", async () => {
  const calls = [];
  const all = Array.from({ length: 230 }, (_, i) => ({ number: i + 1 }));
  const api = async (args) => { calls.push(args); const page = Number(/&page=(\d+)/.exec(args[0])[1]); return all.slice((page - 1) * 100, page * 100); };
  const rows = await listAll(api, "repos/o/r/pulls?state=open&base=development", { jq: PR_FIELDS });
  assert.equal(rows.length, 230);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ["repos/o/r/pulls?state=open&base=development&per_page=100&page=1", "--jq", PR_FIELDS]);
  // Every field the passes read from a list item is in the projection.
  for (const f of ["number", "title", "body", "draft", "created_at", "merged_at", "closed_at", "merge_commit_sha", ".user.login", ".head.ref", ".head.sha", ".head.repo.full_name"]) assert.ok(PR_FIELDS.includes(f), f);
});

test("a truncated or unreadable list is an error, never an empty or partial list", async () => {
  const full = async ([route]) => { const page = Number(/&page=(\d+)/.exec(route)[1]); return Array.from({ length: 100 }, (_, i) => ({ number: page * 1000 + i })); };
  await assert.rejects(listAll(full, "repos/o/r/pulls?state=open", { maxPages: 2 }), (e) => e instanceof ListReadError && e.truncated && /did nothing/.test(e.message));
  // A window list (the most recent N by design) is not an error.
  assert.equal((await listAll(full, "repos/o/r/pulls?state=closed", { maxPages: 2, window: true })).length, 200);
  // A page that is not a list (an error body), or a page that fails to read.
  let n = 0;
  const broken = async () => (++n === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i })) : { message: "Bad credentials" });
  await assert.rejects(listAll(broken, "repos/o/r/pulls"), /could not read repos\/o\/r\/pulls \(page 2\): not a list/);
  await assert.rejects(listAll(async () => { throw new Error("stdout maxBuffer length exceeded"); }, "repos/o/r/pulls"), /could not read .*maxBuffer/);
});

test("the open-PR pass does nothing on an unreadable list, says so, and the preview report prints it", async () => {
  const data = { jobs: {}, actions: {}, decisions: {}, outbox: {}, audit: [], seen: {} };
  const ledger = { data, save() {}, audit(kind, x) { data.audit.push({ kind, ...x }); }, notify() { throw new Error("must not notify"); }, createJob() { throw new Error("must not ask"); } };
  const logs = [];
  const api = async ([route]) => { if (/pulls\?state=open/.test(route)) throw new Error("stdout maxBuffer length exceeded"); return []; };
  const prs = createKeirPrs({ ledger, api, write: async () => { throw new Error("must not write"); }, log: (l) => logs.push(l), controls: staticControls({}) });
  const out = await prs.tick();
  assert.match(out.unread[0], /^open sweep: could not read repos\/lakesidegamedev\/AHDGame\/pulls/);
  assert.ok(logs.some((l) => /open sweep skipped, could not read, did nothing/.test(l)));
  assert.equal(data.audit.filter((a) => a.kind === "keir_pr_list_unread").length, 1);
  const report = await buildPreview({ data: { jobs: {}, decisions: {}, actions: {} }, settings: resolve({}), api, now: Date.parse("2026-11-21T03:00:00Z"), env: {} });
  const text = render(report, { settings: resolve({}), killSwitch: "released", paused: false, github: true });
  assert.match(text, /Could not check \(\d+\):[\s\S]*open sweep skipped, could not read, did nothing/);
});

test("ownerwait pages the open list too, so a developer PR past the first 50 is still seen", async () => {
  const data = { jobs: {}, actions: {}, decisions: {}, seen: {} };
  const created = [];
  const ledger = { data, save() {}, audit() {}, createJob(key) { created.push(key); return { id: key }; } };
  const open = Array.from({ length: 120 }, (_, i) => ({ number: 5000 + i, draft: true, user: { login: "dev" }, head: { sha: `h${i}`, ref: `b${i}` } }));
  open[110].draft = false;
  const api = async ([route]) => {
    const m = /pulls\?state=open&base=development&per_page=(\d+)&page=(\d+)/.exec(route);
    if (m) return open.slice((m[2] - 1) * m[1], m[2] * m[1]);
    if (/check-runs/.test(route)) return { check_runs: [{ name: "verify", status: "completed", conclusion: "success" }, { name: "dependency-review", status: "completed", conclusion: "success" }, { name: "custom-rules", status: "completed", conclusion: "failure" }] };
    if (/pulls\/\d+\/reviews/.test(route)) return [];
    if (/pulls\/\d+$/.test(route)) return { mergeable: true };
    throw new Error(route);
  };
  await createOwnerWait({ ledger, api }).tick();
  assert.deepEqual(created, ["ownerwait:5110:h110"]);
});
