"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { prefetch } = require("../lib/operator/prefetch");
test("prefetch maps the workspace, reads named and record files first, and respects the budget", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prefetch-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of [["records/cash.json", '{"cash":1}'], ["src/a.ts", "export const a=1;"], ["notes/big.md", "x".repeat(20000)], [".git/HEAD", "ref"], ["ticket.md", "see src/a.ts"]]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body);
  }
  const p = prefetch(root, "Why is src/a.ts wrong?");
  assert.match(p.text, /--- src\/a\.ts/); assert.match(p.text, /--- records\/cash\.json/);
  assert.doesNotMatch(p.text, /--- notes\/big\.md/); assert.doesNotMatch(p.text, /\.git\/HEAD/); assert.doesNotMatch(p.text, /--- ticket\.md/);
  assert.match(p.text, /1\| export const a=1;/);
  assert.equal(prefetch(root, "", { budget: 5 }).files, 0);
});
