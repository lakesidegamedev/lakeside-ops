"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const bp = require("../lib/operator/briefprofile");
const { TOOLS } = require("../lib/operator/agent");
const skills = require("../lib/operator/skills");
const text = fs.readFileSync(path.join(__dirname, "..", "KEIR.md"), "utf8");
const titles = bp.split(text).sections.map((s) => s.title);

test("every section named by a profile exists in KEIR.md", () => {
  for (const names of [...Object.values(bp.ALLOW), ...Object.values(bp.DROP)]) for (const n of names) assert.ok(titles.includes(n), `unknown section ${n}`);
  for (const n of bp.RARE_TOOLS) assert.ok(TOOLS.some((t) => t.name === n), `unknown tool ${n}`);
});

test("profiles keep what the job needs and shrink the rest", () => {
  const coder = bp.trim(text, "coder", { codingParent: "p" });
  assert.ok(coder.text.length < text.length / 5);
  assert.match(coder.text, /Quoted instructions, channel history/);
  assert.doesNotMatch(coder.text, /Character identity/);
  const finding = bp.trim(text, "finding", { kind: "finding" });
  assert.match(finding.text, /## Findings \(Keir 5\.0\)/);
  assert.doesNotMatch(finding.text, /## Conversation/);
  const work = bp.trim(text, "work", { role: "support", ticket: 1 });
  assert.doesNotMatch(work.text, /## Findings/);
  assert.match(work.text, /## Conversation/);
  assert.doesNotMatch(work.text, /Biography sources|preloaded public backstory/);
  assert.match(bp.trim(text, "quick", {}).text, /preloaded public backstory/);
});

test("lean session defers rare tools, keeps completion tools direct and loads omitted text on demand", async () => {
  const job = { kind: "ticket", role: "support", ticket: 7 };
  const lane = skills.laneOf(job, false), prep = skills.prepare(lane);
  const ctx = bp.lean({ job, quick: false, briefText: text, tools: TOOLS, skills, skillLane: lane, skillNames: prep.names });
  const direct = ctx.session.tools.map((t) => t.name);
  for (const n of ["finish", "checkpoint", "channel_reply", "github", "shell", "load_context", "call_tool"]) assert.ok(direct.includes(n), n);
  for (const n of ctx.deferredNames) assert.ok(!direct.includes(n));
  for (const n of ["finish", "finish_patch", "edit_verify", "submit_result", "calculate", "evidence_batch"]) assert.ok(!ctx.deferredNames.includes(n), n);
  assert.deepEqual((await ctx.session.load({ section: "instructions" })).sections, ctx.omitted);
  assert.match((await ctx.session.load({ section: "instructions", names: [ctx.omitted[0]] })).text, new RegExp("^## " + ctx.omitted[0].replace(/[()]/g, "\\$&")));
  const tool = (await ctx.session.load({ section: "tools", names: [ctx.deferredNames[0]] })).tools[0];
  assert.ok(tool.inputSchema);
  await assert.rejects(ctx.session.load({ section: "tools", names: ["finish"] }));
  assert.ok((await ctx.session.load({ section: "skills", names: [prep.names[0]] })).text.length > 1000);
  assert.ok(ctx.skillDigest(prep.names).length < prep.text.length / 5);
  assert.equal(bp.lean({ job: { ...job, voiceMode: true }, quick: true, briefText: text, tools: TOOLS, skills, skillLane: lane, skillNames: [] }), null);
  assert.equal(bp.lean({ job, quick: false, briefText: text, tools: TOOLS, skills, skillLane: lane, skillNames: [], enabled: false }), null);
});
