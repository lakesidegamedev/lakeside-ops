"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { makeHome, removeHome, homesInUse, sweepStaleHomes } = require("./claude-home");

function state(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "keir-homes-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function age(dir, ms) { const when = new Date(Date.now() - ms); fs.utimesSync(dir, when, when); }

test("removeHome deletes the home but not what its credentials link points at, and ignores other paths", (t) => {
  const dir = state(t), secret = path.join(dir, "credentials-target"); fs.writeFileSync(secret, "keep");
  const home = makeHome(dir); fs.symlinkSync(secret, path.join(home, ".claude/.credentials.json"));
  assert.equal(removeHome(home), true);
  assert.equal(fs.existsSync(home), false); assert.equal(fs.readFileSync(secret, "utf8"), "keep");
  const other = path.join(dir, "ledger-dir"); fs.mkdirSync(other);
  assert.equal(removeHome(other), false); assert.ok(fs.existsSync(other));
});

test("the sweep removes only old homes that no process uses", (t) => {
  const dir = state(t), proc = fs.mkdtempSync(path.join(os.tmpdir(), "keir-proc-")); t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  const oldHome = makeHome(dir), busy = makeHome(dir), young = makeHome(dir), keepFile = path.join(dir, "claude-home-notadir"); fs.writeFileSync(keepFile, "x");
  age(oldHome, 3 * 86400000); age(busy, 3 * 86400000); age(young, 3600000);
  fs.mkdirSync(path.join(proc, "123")); fs.writeFileSync(path.join(proc, "123", "environ"), `PATH=/bin\0HOME=${busy}\0LANG=C\0`);
  const out = sweepStaleHomes({ stateDir: dir, procDir: proc });
  assert.deepEqual([out.removed, out.inUse, out.young], [1, 1, 1]);
  assert.equal(fs.existsSync(oldHome), false); assert.ok(fs.existsSync(busy)); assert.ok(fs.existsSync(young)); assert.ok(fs.existsSync(keepFile));
});

test("an unreadable process table means nothing is removed", (t) => {
  const dir = state(t), home = makeHome(dir); age(home, 5 * 86400000);
  const out = sweepStaleHomes({ stateDir: dir, procDir: path.join(dir, "no-such-proc") });
  assert.match(out.skipped, /process table/); assert.ok(fs.existsSync(home));
  assert.equal(homesInUse(dir, { procDir: path.join(dir, "no-such-proc") }), null);
});
