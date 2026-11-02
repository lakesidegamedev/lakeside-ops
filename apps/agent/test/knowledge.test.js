"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { numbersIn, unsupportedNumbers, calculate, updateRecord, ticketRecord, createNotebook } = require("../lib/operator/knowledge");

test("numbers are read with their units", () => {
  const v = numbersIn("cash of £46.4m, margin 31.67%, 1,312,409.79 USD and 2.5bn").map((n) => n.value);
  assert.deepEqual(v, [46400000, 31.67, 1312409.79, 2500000000]);
});

test("a figure nothing supports is caught; rounded and exempt figures pass", () => {
  const evidence = [46240215, 31.67, 15.01];
  assert.deepEqual(unsupportedNumbers("worth about £46.2m, margin 31.67% to 15.01%", evidence), []);
  assert.deepEqual(unsupportedNumbers("it fell to £43.9m", evidence), ["£43.9m".replace("£", "")]);
  assert.deepEqual(unsupportedNumbers("ticket 1522 on turn 148 in 1992, 3 plants at 85%", evidence), [], "ids, turns, years and small round numbers are not checked");
});

test("calculations must start from evidence", () => {
  assert.equal(calculate("1649562.99 / 316.47", [1649562.99, 316.47]).toFixed(2), "5212.38");
  assert.throws(() => calculate("1649562.99 / 316.47", [316.47]), /not in anything you read/);
  assert.throws(() => calculate("process.exit()", []), /only numbers/);
});

test('batched calculations derive intermediate figures without inventing source numbers',()=>{
 const {calculateBatch}=require('../lib/operator/knowledge');
 const evidence=[25000,500,4500,.2,.15,.1,.05,.03,.35];
 const steps=[{id:'perRevenue',expression:'.2/25000+.15/500+.1/4500'},
  {id:'basis',expression:'1/$perRevenue'},
  {id:'liveShare',expression:'.2*2+.1+.05+.2*2+.1+.05+.03'},
  {id:'legacy',expression:'$basis*$liveShare*(1+.35)*7'}];
 const rows=calculateBatch(steps,evidence);
 assert.equal(rows.length,4);assert.ok(Math.abs(rows[2].value-1.13)<1e-14);
 assert.ok(Math.abs(rows[3].value-32337.31494)<.01);
 assert.deepEqual(evidence,[25000,500,4500,.2,.15,.1,.05,.03,.35]);
 assert.throws(()=>calculateBatch([{id:'bad',expression:'1.13*7'}],evidence),/not in anything you read/);
 assert.throws(()=>calculateBatch([{id:'bad',expression:'$missing+1'}],evidence),/unknown.*missing/i);
 assert.throws(()=>calculateBatch([{id:'x',expression:'1'},{id:'x',expression:'2'}],evidence),/unique/i);
 assert.throws(()=>calculateBatch([{id:'x',expression:'process.exit()'}],evidence),/only numbers/);
 assert.throws(()=>calculateBatch([{id:'x',expression:'1/0'}],evidence),/did not produce/);
 assert.throws(()=>calculateBatch(Array.from({length:33},(_,i)=>({id:'x'+i,expression:'1'})),evidence),/1-32/);
});
test('a bounded arithmetic batch can finish the fourteen-step reconciliation seen in real traces',()=>{
 const {calculateBatch}=require('../lib/operator/knowledge');
 const steps=Array.from({length:14},(_,i)=>({id:'step'+i,expression:i?'$step'+(i-1)+'+1':'1'}));
 const result=calculateBatch(steps,[]);assert.equal(result.length,14);assert.equal(result.at(-1).value,14);
});
test('guarded calculations support caps, roots and rounding without shell arithmetic',()=>{
 assert.equal(calculate('round(7*10000*min((1-.15)*1.5,1/(1+.12)))',[10000,.15,1.5,.12]),62500);
 assert.equal(calculate('floor(.7+50874.831763122485*(.2/25000+.15/500+.1/4500)*2/4)',[.7,50874.831763122485,.2,25000,.15,500,.1,4500]),9);
 assert.equal(calculate('min(2,max(.7,sqrt(3200/800)))',[.7,3200,800]),2);
 assert.equal(calculate('70000-62500',[70000,62500]),7500);
 assert.equal(calculate('min(25%,50%)',[]),.25);
 assert.throws(()=>calculate('.73*10000',[10000]),/not in anything you read/);
 assert.throws(()=>calculate('round(process.exit())',[]),/only numbers/);
 assert.throws(()=>calculate('constructor(1)',[]),/only numbers/);
 assert.throws(()=>calculate('sqrt(-1)',[]),/did not produce/);
});
test('calculator function arguments retain literal evidence and prior-step boundaries',()=>{
 const {calculateBatch}=require('../lib/operator/knowledge');
 const results=calculateBatch([{id:'raw',expression:'1.13/.73'},{id:'capped',expression:'min(1.5,max(.7,$raw))'}],[1.13,.73,1.5,.7]);
 assert.equal(results[1].value,1.5);
 assert.equal(calculate('abs(-1234)',[1234]),1234);
 assert.equal(calculate('1,000+2',[1000]),1002);
 assert.equal(calculate('2**3**2',[]),512);
 assert.throws(()=>calculate('min(.73,1)',[]),/not in anything you read/);
 assert.throws(()=>calculate('abs(1,2)',[]),/only numbers/);
 assert.throws(()=>calculate('min(2,1/0)',[]),/did not produce/);
 for(const expr of ['Math.max(1,2)','min.constructor(1)','(function(){return 1})()','max(1,process.exit())','[1][0]','2(3)'])assert.throws(()=>calculate(expr,[]),/only numbers/);
});

test("the ticket record keeps sourced facts, ruled-out ideas and promises", () => {
  const ledger = { data: {}, save() {} };
  updateRecord(ledger, 1522, { id: "j" }, { op: "add", kind: "fact", text: "Iron holds the CA plant at 85%", source: "trace_sector corp 499" });
  updateRecord(ledger, 1522, { id: "j" }, { op: "add", kind: "ruled_out", text: "Real estate shortage: own CA sector covers it" });
  assert.throws(() => updateRecord(ledger, 1522, { id: "j" }, { op: "add", kind: "fact", text: "unsourced" }), /source/);
  const rec = ticketRecord(ledger, 1522);
  assert.equal(rec.facts.length, 1); assert.equal(rec.ruledOut.length, 1);
});

test("notebook recalls relevant notes and flags mechanic notes whose code changed", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nb-")), "nb.json");
  let sha = "aaa";
  const nb = createNotebook({ file, exec: () => sha });
  nb.remember({ kind: "mechanic", text: "Own-company supply only reserves inside one state when freight is on", path: "src/lib/market/internalSupply/clearing.ts" });
  nb.remember({ kind: "lesson", text: "Never call a blended two-product average a sale price for one product" });
  assert.throws(() => nb.remember({ kind: "mechanic", text: "Something about the market without a path" }), /code path/);
  let hits = nb.recall("why is own company supply not reaching my state plant");
  assert.equal(hits[0].kind, "mechanic"); assert.equal(hits[0].stale, undefined);
  sha = "bbb";
  hits = nb.recall("own company supply state");
  assert.match(hits[0].stale, /changed/);
  assert.equal(createNotebook({ file, exec: () => sha }).all().length, 2, "persisted");
});

test("2.1 code check: a draft re-asserting a ruled-out idea is caught; a negated mention is fine", () => {
  const { revivedRuledOut } = require("../lib/operator/knowledge");
  const ruled = [{ text: "Real estate services shortage limits the California plant" }];
  assert.ok(revivedRuledOut("The California plant is limited by a real estate services shortage.", ruled));
  assert.equal(revivedRuledOut("It is not a real estate services shortage limiting the California plant; it is iron.", ruled), null);
});

test("2.3: player notes are private to that player's tickets, and doc notes can be relearned", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nb-")), "nb.json");
  const nb = createNotebook({ file, exec: () => "sha" });
  nb.remember({ kind: "player", player: "12", text: "Ben Harrison mines iron in Minnesota and runs a plant in California" });
  nb.remember({ kind: "knowledge", doc: "ahd-internal-supply-priority", text: "Own supply priority reserves company output for its own plants first" });
  assert.equal(nb.recall("iron plant california minnesota").length, 0, "no player given: player notes hidden");
  assert.equal(nb.recall("iron plant california minnesota", { player: "99" }).length, 0, "another player's ticket: hidden");
  assert.equal(nb.recall("iron plant california minnesota", { player: "12" }).length, 1);
  assert.equal(nb.recall("iron plant california minnesota", { player: "*" }).length, 1, "developer tasks see all");
  assert.equal(nb.notesFor("12").length, 1);
  nb.forgetDoc("ahd-internal-supply-priority");
  assert.equal(nb.all().filter((n) => n.doc).length, 0);
  assert.throws(() => nb.remember({ kind: "player", text: "missing the player id entirely" }), /player it is about/);
});

test("2.4 curation: merges stay within a kind and a player, decisions and lessons are never dropped", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nb-")), "nb.json");
  const nb = createNotebook({ file, exec: () => "sha" });
  const a = nb.remember({ kind: "player", player: "12", text: "Ben Harrison mines iron in Minnesota" });
  const b = nb.remember({ kind: "player", player: "12", text: "Ben Harrison has iron mines in Minnesota and Kanto" });
  const c = nb.remember({ kind: "player", player: "99", text: "Someone else entirely runs media in Ohio" });
  const dcs = nb.remember({ kind: "decision", text: "Owner approved the tech cash floor release" });
  const chat = nb.remember({ kind: "resolution", text: "Ticket 1: still looking into it, nothing yet" });
  const log = nb.curate([
    { op: "merge", ids: [a.id, b.id], text: "Ben Harrison mines iron in Minnesota and Kanto" },
    { op: "merge", ids: [a.id, c.id], text: "cross-player merge must be refused" },
    { op: "drop", id: dcs.id, reason: "x" },
    { op: "drop", id: chat.id, reason: "no lasting value" },
  ]);
  assert.equal(nb.notesFor("12").length, 1); assert.match(nb.notesFor("12")[0].text, /Minnesota and Kanto/);
  assert.equal(nb.notesFor("99").length, 1, "other player untouched");
  assert.ok(nb.all().some((n) => n.id === dcs.id), "decision kept");
  assert.ok(!nb.all().some((n) => n.id === chat.id));
  assert.equal(log.length, 2);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes(".bak-")), "backup written");
});

test("cross-agent handoffs retain escalation criteria beyond the old notebook cutoff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-handoff-"));
  try {
    const nb = createNotebook({ file: path.join(dir, "nb.json"), exec: () => "abc" });
    const text = "Governor handoff: " + "Verify the actual affected sector first. ".repeat(24) + "Escalate a sector revenue change above 5%; only the owner can pause the glide.";
    const note = nb.remember({ kind: "decision", text, source: "cross-agent handoff" });
    assert.equal(note.text, text);
    assert.equal(createNotebook({ file: path.join(dir, "nb.json"), exec: () => "abc" }).all()[0].text, text);
    assert.throws(() => nb.remember({ kind: "decision", text: "x".repeat(4001) }), /document|4000/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a percentage of a fraction that was read is supported, an unrelated percentage is not", () => {
  const { unsupportedNumbers } = require("../lib/operator/knowledge");
  assert.deepEqual(unsupportedNumbers("Your margin was 6.7% at the start.", [0.067]), []);
  assert.deepEqual(unsupportedNumbers("Your margin was 9.3% at the start.", [0.067]), ["9.3%"]);
});
