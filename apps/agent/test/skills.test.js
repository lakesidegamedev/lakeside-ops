"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const skills = require("../lib/operator/skills");

test("each lane gets its skills with Keir notes; quick gets none", () => {
  const worker = skills.forLane("worker"), coder = skills.forLane("coder"), inv = skills.forLane("investigator");
  assert.match(worker, /### Skill: verification-before-completion/);
  assert.match(worker, /### Skill: ponytail-review/);
  assert.doesNotMatch(worker, /### Skill: frontend-design/);
  assert.match(inv, /### Skill: systematic-debugging[\s\S]*finish blocked with the question/);
  assert.match(coder, /### Skill: ponytail\n/);
  assert.match(coder, /### Skill: frontend-design[\s\S]*no serif type, no beige/);
  assert.match(coder, /### Skill: test-driven-development/);
  assert.equal(skills.forLane("quick"), "");
  assert.doesNotMatch(coder, /^---\nname:/m, "front matter stripped");
  // Bounded: the skills must not swamp the brief.
  for (const t of [worker, coder, inv]) assert.ok(t.length < 40000, `${t.length} chars`);
});

test("laneOf routes coding children and investigators", () => {
  assert.equal(skills.laneOf({}, true), "quick");
  assert.equal(skills.laneOf({}, false), "worker");
  assert.equal(skills.laneOf({ codingParent: "x", investigation: true }, false), "investigator");
  assert.equal(skills.laneOf({ codingParent: "x" }, false), "coder");
});

test("every manifest skill is vendored with a license", () => {
  const fs = require("node:fs"), path = require("node:path");
  const { manifest } = skills.load();
  for (const [name, s] of Object.entries(manifest.skills)) {
    assert.match(s.sha, /^[0-9a-f]{40}$/, name);
    assert.ok(skills.ADAPT[name], `${name} has a Keir note`);
  }
  const vendor = path.join(__dirname, "..", "skills", "vendor");
  assert.ok(fs.existsSync(path.join(vendor, "LICENSE-ponytail-MIT")));
  assert.ok(fs.existsSync(path.join(vendor, "LICENSE-superpowers-MIT")));
  assert.ok(fs.existsSync(path.join(vendor, "frontend-design", "LICENSE.txt")));
});

const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const dirs = [];
test.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixtureRoot(manifest = { skills: { good: {}, missing: {} }, lanes: { worker: ["good", "missing"] } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keir-skills-")); dirs.push(root);
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest));
  fs.mkdirSync(path.join(root, "vendor", "good"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor", "good", "SKILL.md"), "\uFEFF---\r\nname: good\r\n---\r\nKeep the verified skill body.\r\n");
  return root;
}

test("partial vendor releases retain healthy skills and recover on the next activation", () => {
  const root = fixtureRoot(), first = skills.prepare("worker", root);
  assert.deepEqual(first.names, ["good"]);
  assert.match(first.text, /Keep the verified skill body/);
  assert.doesNotMatch(first.text, /name: good|\uFEFF|\r|undefined/);
  assert.equal(first.errors[0].skill, "missing");
  fs.mkdirSync(path.join(root, "vendor", "missing"));
  fs.writeFileSync(path.join(root, "vendor", "missing", "SKILL.md"), "Recovered skill.");
  const second = skills.prepare("worker", root);
  assert.deepEqual(second.names, ["good", "missing"]);
  assert.deepEqual(second.errors, []);
});

test("missing or malformed manifests and lane entries degrade to a bounded diagnostic", () => {
  const root = fixtureRoot();
  for (const body of ["{", "null", '{"skills":{},"lanes":[]}', '{"skills":{},"lanes":{"worker":42}}']) {
    fs.writeFileSync(path.join(root, "manifest.json"), body);
    const result = skills.prepare("worker", root);
    assert.equal(result.text, ""); assert.ok(result.errors.length);
    assert.ok(result.errors[0].error.length <= 200);
  }
  fs.unlinkSync(path.join(root, "manifest.json"));
  assert.equal(skills.forLane("worker", root), "");
  assert.equal(skills.laneOf({ codingParent: "x" }, true), "coder");
  assert.equal(skills.laneOf({ codingParent: "x", investigation: true }, true), "investigator");
});

test("every permitted native runner receives lane skills and audits fallback without losing support", async () => {
  const { createAgent } = require("../lib/operator/agent");
  const { EventEmitter } = require("node:events");
  for (const runner of ["claude", "codex", "agy", "rust"]) {
    for (const broken of [false, true]) {
      const root = fixtureRoot({ skills: { good: {} }, lanes: { worker: ["good"] } });
      if (broken) fs.unlinkSync(path.join(root, "manifest.json"));
      const audits = [], delivered = [];
      const ledger = { data: { actions: {}, jobs: {}, channels: {} }, save() {}, audit: (event, data) => audits.push({ event, ...data }) };
      const job = { id: "skills-job", kind: "command", role: "support", internalProbe: true, source: { content: "Check this", at: new Date().toISOString() }, rounds: 0 };
      ledger.data.jobs[job.id] = job;
      const agent = createAgent({ ledger, broker: { tool: async (j, name) => { if (name === "finish") j.state = "done"; } },
        config: { leanContext: false, stateDir: root, skillsRoot: root, briefFile: path.join(__dirname, "../KEIR.md"), model: "test", workerProvider: runner === "rust" ? "claude" : runner, rustRunnerLanes: runner === "rust" ? ["worker", "probe"] : [], maxRounds: 2, maxTurnMs: 5000 },
        spawnImpl: (cmd, args, opts) => {
          const c = new EventEmitter(); c.pid = 999999; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
          if (runner === "claude") delivered.push(args[args.indexOf("--system-prompt") + 1]);
          if (runner === "agy") delivered.push(fs.readFileSync(path.join(opts.cwd, "task.md"), "utf8"));
          if (runner === "rust") delivered.push(fs.readFileSync(args[args.indexOf("--brief-file") + 1], "utf8"));
          if (runner === "codex") fs.writeFileSync(args[args.indexOf("-o") + 1], "Checked.");
          c.stdin = { end(input) {
            if (runner === "codex") delivered.push(input);
            setImmediate(() => {
              const output = runner === "claude" || runner === "rust" ? JSON.stringify({ type: "result", subtype: "success", result: "Checked." }) + "\n"
                : runner === "agy" ? JSON.stringify({ status: "SUCCESS", response: "Checked." }) : "Checked.";
              c.stdout.emit("data", output); c.emit("close", 0);
            });
          } };
          return c;
        } });
      await agent.run(job, new AbortController().signal);
      assert.equal(job.state, "done", `${runner} broken=${broken}`);
      assert.equal(delivered.length, 1);
      if (broken) assert.doesNotMatch(delivered[0], /Keep the verified skill body/);
      else assert.match(delivered[0], /Keep the verified skill body/);
      const activation = audits.find((e) => e.event === "activation_skills");
      assert.equal(activation.lane, "worker"); assert.equal(activation.degraded, broken);
      assert.equal(activation.skillChars > 0, !broken);
      assert.equal(audits.some((e) => e.event === "skills_unavailable"), broken);
    }
  }
});
