#!/usr/bin/env node
"use strict";
// Slim Keir controls.
//
//   keir-slim stop "reason"          kill switch: stops old and new Keir alike
//   keir-slim start                  release the kill switch
//   keir-slim pause <ticket> "reason" [--by name]
//   keir-slim resume <ticket>        lifts the pause; queued messages reach the next wake
//   keir-slim status [ticket]        ticket state, or every ticket's next step
//   keir-slim answer <ticket> <approval-id> <approved|declined|answered> ["text"]
//
// Pausing a ticket stops Keir only; people keep talking in the channel.

const path = require("node:path");
const { slimConfig } = require("../lib/slim/config");
const S = require("../lib/slim/state");
const { createKillSwitch } = require("../lib/operator/killswitch");

const cfg = slimConfig();
const killSwitch = createKillSwitch({ file: cfg.killSwitchFile });
const store = S.createFileStore(path.join(cfg.stateDir, "tickets"));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest.splice(i, 2)[1] : null; };

function queue(n, event) {
  const fs = require("node:fs");
  const dir = path.join(cfg.stateDir, "pending");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `ticket-${Number(n)}.json`);
  let list = []; try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
  fs.writeFileSync(file, JSON.stringify([...list, event]), { mode: 0o600 });
}

async function main() {
  if (cmd === "stop") { console.log(JSON.stringify(killSwitch.engage({ reason: rest.join(" ") || "stopped", by: process.env.USER || "operator" }))); return; }
  if (cmd === "start") { killSwitch.release ? killSwitch.release() : require("node:fs").rmSync(cfg.killSwitchFile, { force: true }); console.log(JSON.stringify(killSwitch.state())); return; }
  if (cmd === "pause") {
    const by = flag("by") || process.env.USER || "staff";
    const [n, ...why] = rest;
    const s = store.load(n); s.paused = { by, at: new Date().toISOString(), reason: why.join(" ") }; store.save(s);
    console.log(S.render(s)); return;
  }
  if (cmd === "status") {
    if (rest[0]) { console.log(S.render(store.load(rest[0]))); return; }
    console.log(`mode ${cfg.mode}; kill switch ${killSwitch.state().engaged ? "ENGAGED" : "clear"}`);
    for (const n of store.list()) { const s = store.load(n); console.log(`${n}${s.closed ? " closed" : ""}${s.paused ? " PAUSED" : ""}: ${s.next ? `${s.next.step} (waits on ${s.next.waitsOn || "?"})` : "no next step"}; open promises ${s.promises.filter((p) => p.status === "open").length}; pending approvals ${s.approvals.filter((a) => a.status === "pending").length}`); }
    return;
  }
  // Resume and answers are recorded here and reach the session on its next wake.
  if (cmd === "resume") {
    const s = store.load(rest[0]); s.paused = null; if (s.budget) s.budget.alerted = false; store.save(s);
    queue(rest[0], { role: "system", at: new Date().toISOString(), text: "The pause is lifted." });
    console.log(S.render(s)); return;
  }
  if (cmd === "answer") {
    const [n, id, status, ...text] = rest;
    if (!["approved", "declined", "answered"].includes(status)) throw new Error("status must be approved, declined or answered");
    const { state, approval } = S.answerApproval(store.load(n), id, { status, text: text.join(" ") || status });
    if (!approval) throw new Error(`no approval ${id} on ticket ${n}`);
    store.save(state);
    queue(n, { role: "approval", name: process.env.USER || "owner", at: new Date().toISOString(), text: `${approval.kind} ${approval.id} (${approval.summary}): ${approval.status}${approval.answer ? `, ${approval.answer}` : ""}` });
    console.log(S.render(state)); return;
  }
  console.log("usage: keir-slim stop|start|pause|resume|status|answer (see the header of this file)");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
