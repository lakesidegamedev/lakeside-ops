"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNotebook, noteSources, revivedRuledOut } = require("../lib/operator/knowledge");
const dirs = [];
test.after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-memory-")); dirs.push(dir);
  const files = { "src/rule.ts": { sha: "one", body: "const taxRate = 0.20;" }, "src/limits.ts": { sha: "limit1", body: "const taxLimit = 5000;" } };
  let time = 1000;
  const exec = (_cmd, args) => {
    const spec = args.at(-1), name = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : null;
    if (!name) return "commit1";
    if (!files[name]) throw new Error("missing file");
    return args.includes("show") ? files[name].body : files[name].sha;
  };
  const file = path.join(dir, "notebook.json");
  const notebook = createNotebook({ file, exec, now: () => time });
  return { notebook, files, file, exec, tick: () => { time += 3600001; } };
}

test("a large freshness scan lets the event loop run before the scan completes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-memory-responsive-")); dirs.push(dir);
  let reads = 0;
  const n = createNotebook({ file: path.join(dir, "notebook.json"), exec: () => { reads++; return "sha"; } });
  for (let i = 0; i < 80; i++) n.remember({ kind: "mechanic", text: `Verified production rule number ${i}`, path: "src/rule.ts" });
  reads = 0;
  let finished = false;
  const observed = [];
  function heartbeat() {
    if (finished) return;
    observed.push(reads);
    setImmediate(heartbeat);
  }
  setImmediate(heartbeat);
  try { await n.refresh(async () => { throw new Error("No verification was requested"); }, { limit: 0 }); }
  finally { finished = true; }
  assert.ok(observed.some(count => count > 0 && count < reads), "the event loop must make progress during freshness work");
});

test("a note superseded during a freshness scan stays archived without being invalidated", async () => {
  const f = fixture(), n = f.notebook;
  n.remember({ kind: "mechanic", text: "First production rule needs verification", path: "src/rule.ts" });
  const old = n.remember({ kind: "mechanic", text: "Second production rule needs verification", path: "src/rule.ts" });
  f.files["src/rule.ts"].sha = "two";
  const replaced = new Promise(resolve => setImmediate(() => {
    n.remember({ kind: "mechanic", text: "Second production rule has current evidence", path: "src/rule.ts", supersedes: [old.id], reason: "Current code supersedes the old note" });
    resolve();
  }));
  await n.refresh(async () => { throw new Error("No verification was requested"); }, { limit: 0 });
  await replaced;
  const archived = n.archive().find(note => note.id === old.id);
  assert.ok(archived.supersededBy);
  assert.equal(archived.invalidatedAt, undefined);
});

test("merged mechanics keep all code, doc and ticket dependencies; changing either file makes the note stale", () => {
  const f = fixture(), n = f.notebook;
  const a = n.remember({ kind: "mechanic", text: "Tax rate is twenty percent of company profits", path: "src/rule.ts", ticket: 1503, doc: "tax-rules", docVersion: 2 });
  const b = n.remember({ kind: "mechanic", text: "Tax liability is limited to five thousand", path: "src/limits.ts", ticket: 1507, doc: "tax-limits", docVersion: 3 });
  n.curate([{ op: "merge", ids: [a.id, b.id], text: "Tax rate is twenty percent, limited to five thousand" }]);
  const hit = n.recall("tax rate limited thousand")[0];
  assert.deepEqual(new Set(hit.sources.filter(s => s.type === "code").map(s => s.path)), new Set(["src/rule.ts", "src/limits.ts"]));
  assert.deepEqual(hit.sources.filter(s => s.type === "ticket").map(s => s.number), [1503, 1507]);
  assert.equal(hit.sources.filter(s => s.type === "doc").length, 2);
  f.files["src/limits.ts"].sha = "limit2";
  assert.ok(n.recall("tax rate limited thousand")[0].stale);
  assert.equal(n.archive().length, 1); assert.equal(n.archive()[0].text, b.text);
  n.forgetDoc("tax-limits"); assert.equal(n.all().length, 0);
});

test("a stale formula is replaced only with exact code evidence, and the old formula stays archived", async () => {
  const f = fixture(), n = f.notebook;
  const old = n.remember({ kind: "mechanic", text: "Tax rate is twenty percent of company profits", path: "src/rule.ts", ticket: 1503 });
  f.files["src/rule.ts"] = { sha: "two", body: "const taxRate = 0.25;" };
  assert.equal(n.queueStale(), 1);
  const result = await n.refresh(async ({ sources }) => { assert.equal(sources[0].sha, "two"); return { status: "replaced", text: "Tax rate is twenty five percent of company profits", reason: "Production rate changed", evidence: [{ path: "src/rule.ts", quote: "const taxRate = 0.25;" }] }; });
  assert.equal(result[0].status, "replaced");
  const hit = n.recall("tax rate company profits")[0]; assert.ok(!hit.stale); assert.notEqual(hit.id, old.id);
  assert.deepEqual(hit.supersedes, [old.id]); assert.match(hit.replacementReason, /changed/);
  assert.equal(n.archive()[0].supersededBy, hit.id); assert.equal(n.archive()[0].text, old.text);
  assert.equal(createNotebook({ file: f.file, exec: f.exec }).recall("tax rate company profits").length, 1);
});

test("missing evidence, deleted dependencies, and source changes during verification never clear stale status", async () => {
  for (const scenario of ["wrong-quote", "deleted-file", "race", "missing-quote"]) {
    const f = fixture(), n = f.notebook;
    n.remember({ kind: "mechanic", text: "Tax rate applies to company profits", paths: ["src/rule.ts", "src/limits.ts"] });
    f.files["src/rule.ts"].sha = "two";
    if (scenario === "deleted-file") delete f.files["src/limits.ts"];
    const result = await n.refresh(async () => {
      if (scenario === "race") f.files["src/rule.ts"].sha = "three";
      return { status: "confirmed", evidence: [{ path: "src/rule.ts", quote: scenario === "wrong-quote" ? "const taxRate = 0.95;" : "const taxRate = 0.20;" }, ...(scenario === "missing-quote" ? [] : [{ path: "src/limits.ts", quote: "const taxLimit = 5000;" }])] };
    });
    assert.equal(result[0].status, "pending", scenario); assert.ok(n.recall("tax rate company profits")[0].stale, scenario);
  }
});

test("confirmed notes update every dependency while preserving original source receipts", async () => {
  const f = fixture(), n = f.notebook;
  n.remember({ kind: "mechanic", text: "Tax rate applies to company profits", path: "src/rule.ts", doc: "tax-rules", docVersion: 2 });
  f.files["src/rule.ts"].sha = "two";
  await n.refresh(async () => ({ status: "confirmed", evidence: [{ path: "src/rule.ts", quote: "const taxRate = 0.20;" }] }));
  assert.ok(!n.recall("tax rate company profits")[0].stale);
  assert.equal(n.all()[0].history[0].sources.find(s => s.type === "code").sha, "one");
  assert.equal(noteSources(n.all()[0]).find(s => s.type === "code").sha, "two");
});

test("source-bound conflicts stay visible until a sourced replacement supersedes both old answers", () => {
  const f = fixture(), n = f.notebook;
  const a = n.remember({ kind: "resolution", text: "Company cash flow issue was caused by iron shortage", ticket: 1522 });
  const b = n.remember({ kind: "mechanic", text: "Company cash flow issue was caused by real estate shortage", path: "src/rule.ts", contradicts: [a.id], reason: "Prior answers disagree" });
  assert.ok(n.recall("company cash flow shortage").every(h => h.conflict));
  assert.throws(() => n.remember({ kind: "mechanic", text: "Company cash flow comes from iron shortage", path: "src/rule.ts", supersedes: [b.id] }), /reason and a source/);
  const resolved = n.remember({ kind: "mechanic", text: "Company cash flow issue was caused by iron supply shortage", path: "src/rule.ts", supersedes: [a.id, b.id], reason: "Current source and state trace agree" });
  const hits = n.recall("company cash flow shortage"); assert.equal(hits.length, 1); assert.equal(hits[0].id, resolved.id); assert.ok(!hits[0].conflict);
});

test("deduplication never crosses players, stale sources cannot be rewritten into freshness, and curation is batch scoped", () => {
  const f = fixture(), n = f.notebook;
  n.remember({ kind: "player", player: "1", text: "This player owns iron mines in California" });
  n.remember({ kind: "player", player: "2", text: "This player owns iron mines in California" });
  assert.equal(n.notesFor("1").length, 1); assert.equal(n.notesFor("2").length, 1);
  const a = n.remember({ kind: "mechanic", text: "Tax rate applies to company profits", path: "src/rule.ts" });
  f.files["src/rule.ts"].sha = "two";
  assert.equal(n.curate([{ op: "rewrite", id: a.id, text: "Tax rate is definitely verified and current" }]).length, 0);
  const lesson = n.remember({ kind: "lesson", text: "Never misread a blended average as a product sale price" });
  assert.equal(n.curate([{ op: "rewrite", id: lesson.id, text: "An unrelated fabricated note replaces this lesson" }], { allowedIds: [a.id] }).length, 0);
});

test("KB mechanic notes require code verification even when a doc names a currently existing path", () => {
  const { notebook: n } = fixture();
  n.remember({ kind: "mechanic", text: "Tax rate is ninety percent according to an outdated doc", path: "src/rule.ts", doc: "tax-rules", by: "kb-learner" });
  assert.ok(n.recall("tax rate outdated doc")[0].stale);
});

test("a ruled-out hypothesis may only return after the ticket record explicitly closes it", () => {
  const draft = "The California plant is limited by a real estate services shortage.";
  assert.ok(revivedRuledOut(draft, [{ text: draft }]));
  assert.equal(revivedRuledOut(draft, [{ text: draft, closedAt: "2026-10-13" }]), null);
});


test("curation cannot change a currency or turn a blended average into a different figure", () => {
  const { notebook: n } = fixture();
  const note = n.remember({ kind: "lesson", text: "The blended two-product average is £2500, never a product sale price" });
  assert.equal(n.curate([{ op: "rewrite", id: note.id, text: "The blended two-product average is $2500, never a product sale price" }]).length, 0);
  assert.equal(n.curate([{ op: "rewrite", id: note.id, text: "The blended two-product average is £2800, never a product sale price" }]).length, 0);
  assert.equal(n.curate([{ op: "rewrite", id: note.id, text: "The blended two-product average is 2500 GBP; do not quote it as a product sale price" }]).length, 1);
});

test("invalidating a merged document queues every lost document for relearning", () => {
  const { notebook: n } = fixture();
  const a = n.remember({ kind: "knowledge", text: "Company profits are taxed by the treasury", doc: "tax-rules" });
  const b = n.remember({ kind: "knowledge", text: "Company tax is capped by treasury limits", doc: "tax-limits" });
  n.meta().kb = { "tax-rules": 1, "tax-limits": 2 };
  n.curate([{ op: "merge", ids: [a.id, b.id], text: "Company profits are taxed by the treasury, with a cap" }]);
  n.forgetDoc("tax-rules");
  assert.equal(n.meta().kb["tax-rules"], undefined); assert.equal(n.meta().kb["tax-limits"], undefined);
});


test("failed doc replacements preserve old receipts while invalidating their authority", () => {
  const { notebook: n, file, exec } = fixture();
  const original = n.remember({ kind: "knowledge", text: "Tax rate from the prior treasury document", doc: "tax-rules", docVersion: 1 });
  n.meta().kb = { "tax-rules": 1 };
  n.invalidateDoc("tax-rules", 2);
  assert.throws(() => n.replaceDoc("tax-rules", 2, [{ text: "New rate has a missing code dependency", path: "src/deleted.ts" }]), /not on origin/);
  assert.equal(n.all()[0].id, original.id); assert.ok(n.recall("tax rate treasury document")[0].stale);
  assert.ok(createNotebook({ file, exec }).recall("tax rate treasury document")[0].stale);
  n.replaceDoc("tax-rules", 2, [{ text: "New treasury document describes tax rate caps" }]);
  assert.equal(n.all().length, 1); assert.ok(!n.recall("tax rate treasury document")[0].stale);
  assert.equal(n.archive()[0].id, original.id); assert.equal(n.meta().kb["tax-rules"], 2);
});


test("background replacement retains unresolved conflicts with other active sources", async () => {
  const { notebook: n, files } = fixture();
  const old = n.remember({ kind: "mechanic", text: "Tax rate applies to company profits at twenty percent", path: "src/rule.ts" });
  const other = n.remember({ kind: "knowledge", text: "Tax rate applies to company profits at ninety percent", doc: "tax-rules", contradicts: [old.id], reason: "Code and doc disagree" });
  files["src/rule.ts"].sha = "two";
  await n.refresh(async () => ({ status: "replaced", text: "Tax rate remains twenty percent of company profits", reason: "Fresh code confirms the actual rate", evidence: [{ path: "src/rule.ts", quote: "const taxRate = 0.20;" }] }));
  const hits = n.recall("tax rate company profits");
  assert.equal(hits.length, 2); assert.ok(hits.every(h => h.conflict));
  assert.ok(hits.find(h => h.id !== other.id).conflictsWith.includes(other.id));
});
