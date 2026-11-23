"use strict";
const { JOB_TERMINAL } = require("./machines");
const fs = require("node:fs");
const musePolicy = require("./ownermuse-policy");
const path = require("node:path");
const crypto = require("node:crypto");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
// The coding subworker's model is configuration: KEIR_CODING_PROVIDER as
// runner:model@effort. Owner, 2026-10-14: Muse Wonder Full 1.0 codes and
// investigates while Opus 5.5 drives (it was Spark 1.3 Contributor, before
// that GPT 6 Luna). Every runner edits only through Keir's
// shell tool in the isolated snapshot; its own built-in tools are off.
const DEFAULT_CODER = "muse:muse-wonder-full-1.0@medium";
const MAX_DELEGATION_MS = 60 * 60000;
function codingSpec(config = {}) {
  const [head, effort = "xhigh"] = String(config.codingProvider || DEFAULT_CODER).split("@");
  const [runner, model] = head.split(":");
  return { runner, model, effort };
}
// Keir 4.0 (owner, 2026-10-14): Opus drives, Muse Wonder Full codes and
// investigates. An investigator is a read-only child: it digs (code in an
// isolated snapshot, live game reads, history, past tickets) and reports a
// cause with evidence; the driver keeps judgment, player copy and fixes.
const INVESTIGATOR_TOOLS = ["evidence_batch", "shell", "local_file", "view_attachment", "read_servers", "read_tools", "read_tool", "recent_changes", "past_ticket", "similar_reports", "recall", "calculate", "checkpoint", "finish"];
const childTools = (job) => job.investigation ? INVESTIGATOR_TOOLS : ["evidence_batch", ...(job.codingContract ? ["edit_verify", ...(job.codingContract.allowCompleteOnPass ? ["finish_patch"] : [])] : []), "shell", "local_file", "view_attachment", "checkpoint", "finish"];
// Reading a task's patch runs git over the whole snapshot; give it room on a busy host.
const PATCH_READ_MS = 3 * 60000;
// What a failed patch read means, in words the model can act on. Never "split the fix" unless the patch is truly large.
function patchReadError(r) {
  const timedOut = r?.timedOut || r?.signal || /timed out/.test(String(r?.message || ""));
  if (timedOut) return "Reading the patch timed out twice (the host is busy); the patch size is not the problem. Do not shrink or split the fix. Try review_fix or delegate_fix again in a few minutes; if it fails again, finish with the fix described in your summary so the ticket's coding worker can build it.";
  return `The patch could not be read (git exited ${r?.code ?? "with an error"}); the patch size is not the problem. Run git status in your snapshot with shell to see why, then try again.`;
}
function createDelegation({ ledger, sandbox, config, now = () => Date.now() }) {
  const coder = codingSpec(config);
  const investigator = codingSpec({ codingProvider: config.investigatorProvider || config.codingProvider });
  async function diff(job, signal) {
    const read = sandbox.capture ? sandbox.capture.bind(sandbox) : sandbox.run.bind(sandbox);
    // 2026-11-23 (tickets 1886, 1889): a timed-out read was reported as "larger than 2 MB", so the model tried to shrink a
    // small fix, then filed "blocked by delegation errors" cards and the tickets waited all night. Each failure now says
    // what happened, and a slow read gets a longer limit and one retry.
    const once = () => read(job.id, "cd repo && git add -N -- . && git --no-pager diff --no-ext-diff --no-textconv --binary HEAD", signal, { timeoutMs: PATCH_READ_MS });
    let r;
    try { r = await once(); }
    catch (e) { if (signal?.aborted || !/output capture (?:timed out|failed)/.test(e.message)) throw e; r = await once().catch((e2) => { throw new Error(patchReadError(e2)); }); }
    if (r.truncated && (r.size === undefined || r.size > 0)) throw new Error("Coding patch is larger than 2 MB; split the fix rather than compressing it.");
    if (r.code !== 0 || r.truncated) throw new Error(patchReadError(r));
    return r.output;
  }
  async function delegate(parent, instructions, signal) {
    if (parent.codingParent || parent.kind === "conversation" || parent.role === "player") throw new Error("Only the primary investigating worker delegates coding fixes.");
    if (!parent.repository || !parent.repositoryRef) throw new Error("Load and verify the repository snapshot before delegating a concrete fix.");
    if (typeof instructions !== "string" || instructions.trim().length < 20 || instructions.length > 8000) throw new Error("Supply bounded verified findings, exact fix scope and focused test requirements.");
    if ((await diff(parent, signal)).trim()) throw new Error("Delegate before editing the repository; the coding subworker needs the verified clean baseline.");
    const key = `coding:${parent.id}:${digest(JSON.stringify([parent.repositoryRef, instructions]))}`;
    let child = ledger.data.jobs[ledger.data.seen[key]];
    if (!child) {
      child = ledger.createJob(key, { kind: "coding", role: parent.role, actorId: parent.actorId, codingParent: parent.id,
        repository: parent.repository, repositoryRef: { ...parent.repositoryRef }, deadline: parent.deadline,
        provider: { lane: "worker", runner: coder.runner, model: coder.model, effort: coder.effort, at: now() }, effortPin: coder.effort,
        source: { content: `You are the coding subworker. The investigator has verified this issue and supplied the scope below. Implement only this fix in the already attached snapshot and run focused tests. Your own client's environment may report a read-only sandbox or disabled shell and write tools on purpose: you never write files there. Every edit, test run and file write goes through the keir MCP tool \`shell\`, which runs in your writable isolated snapshot (the repository is at /workspace/repo). Never stop or report the environment as read-only because of your own sandbox notice; if \`shell\` itself refuses a write, report its exact error. Do not investigate player state, communicate externally, publish, merge or heal. Finish done with the implementation and exact test results; the investigator will inspect the actual patch, review it and handle publication.\n\n${instructions}`, at: new Date(now()).toISOString() } });
      musePolicy.inherit(ledger, parent, child);
      try { sandbox.fork(parent.id, child.id); }
      catch (error) { child.state = "blocked"; child.summary = "Snapshot fork failed: " + error.message; ledger.save(); throw error; }
      (parent.codingDelegations ||= []).push(child.id);
      ledger.audit("coding_delegated", { job: parent.id, child: child.id, repository: parent.repository }); ledger.save();
    }
    return { taskId: child.id, state: child.state, model: child.provider.model, instruction: "Finish waiting while the coding subworker works. Its completion wakes this task. Then review_fix inspect shows the actual patch and test report; review and apply it before rerunning focused tests and publishing." };
  }
  async function review(parent, { taskId, action, reviewedDigest }, signal) {
    const child = ledger.data.jobs[taskId];
    if (!child || child.codingParent !== parent.id || !(parent.codingDelegations || []).includes(taskId)) throw new Error("This coding task does not belong to your investigation.");
    if (child.state !== "done") return { state: child.state, summary: child.summary, instruction: "Wait for the coding task to finish; do not claim it is reviewed or ready." };
    if (JSON.stringify(parent.repositoryRef) !== JSON.stringify(child.repositoryRef) || parent.repository !== child.repository) throw new Error("Repository baseline changed; delegate again against the current verified snapshot.");
    const patch = await diff(child, signal), hash = digest(patch);
    if (!patch.trim()) throw new Error("The coding subworker returned no repository patch; review its findings and delegate a concrete correction.");
    if (action === "inspect") {
      (parent.codingInspections ||= {})[taskId] = hash; ledger.save();
      return { taskId, digest: hash, patch, testReport: child.summary, instruction: "Review the actual diff, not just the subworker's report. Apply only if it matches the verified fix, then independently run focused tests in your snapshot. Publication and player replies remain your responsibility." };
    }
    if (action !== "apply" || reviewedDigest !== hash || parent.codingInspections?.[taskId] !== hash) throw new Error("Inspect and review this exact patch digest before applying it.");
    if ((await diff(parent, signal)).trim()) throw new Error("Your snapshot has changed since delegation; inspect and reconcile it without overwriting your work.");
    const filename = `.coding-${taskId}.patch`;
    fs.writeFileSync(path.join(sandbox.workspace(parent.id), filename), patch, { mode: 0o600 });
    const result = await sandbox.run(parent.id, `cd repo && git apply --check /workspace/${filename} && git apply /workspace/${filename}`, signal);
    if (result.code !== 0) throw new Error("Reviewed patch did not apply cleanly: " + result.output.slice(-1000));
    parent.codingApplied = { taskId, digest: hash, at: now() }; ledger.audit("coding_patch_applied", { job: parent.id, child: taskId, digest: hash }); ledger.save();
    return { applied: true, taskId, instruction: "Independently run focused tests and review the resulting diff. Only the investigating task may publish or communicate this fix, under the existing approval rules." };
  }
  async function investigate(parent, question) {
    if (parent.codingParent || parent.kind === "conversation" || parent.role === "player") throw new Error("Only the primary worker hands out investigations.");
    if (typeof question !== "string" || question.trim().length < 20 || question.length > 6000) throw new Error("Give the investigator one bounded question with what you already know.");
    const open = (parent.investigations || []).map((id) => ledger.data.jobs[id]).filter((j) => j && !["done", "blocked", "dismissed", "cancelled"].includes(j.state));
    if (open.length >= 2) throw new Error("Two investigations are already running for this task; wait for their reports.");
    const key = `investigate:${parent.id}:${digest(question)}`;
    let child = ledger.data.jobs[ledger.data.seen[key]];
    if (!child) {
      child = ledger.createJob(key, { kind: "coding", investigation: true, role: parent.role, actorId: parent.actorId, codingParent: parent.id,
        repository: parent.repository || null, repositoryRef: parent.repositoryRef ? { ...parent.repositoryRef } : null, deadline: parent.deadline,
        provider: { lane: "worker", runner: investigator.runner, model: investigator.model, effort: investigator.effort, at: now() }, effortPin: investigator.effort,
        source: { content: `You are the investigator for Keir, the support desk of A House Divided. The worker driving this ${parent.ticket ? `ticket (${parent.ticket})` : "task"} asked you one question. Find the cause with evidence: read the code${parent.repositoryRef ? " in the attached snapshot through the keir MCP tool \`shell\` (repository at /workspace/repo; never edit it)" : ""}, read live game state through read_tool, and check recent changes and past tickets. You do not talk to players, publish, merge or heal. Finish done with: the cause in one or two sentences, the evidence (file paths and lines, values you read, with where they came from), what you ruled out, and what you could not verify. If you cannot answer, finish blocked with exactly what is missing.\n\nQuestion:\n${question}`, at: new Date(now()).toISOString() } });
      musePolicy.inherit(ledger, parent, child);
      if (parent.repositoryRef) { try { sandbox.fork(parent.id, child.id); } catch (error) { child.repositoryRef = null; } }
      (parent.investigations ||= []).push(child.id);
      ledger.audit("investigation_delegated", { job: parent.id, child: child.id, model: investigator.model }); ledger.save();
    }
    return { taskId: child.id, state: child.state, model: child.provider.model, instruction: "Finish waiting while the investigator works; its report wakes this task. Check the key evidence yourself before acting on it or telling the player." };
  }
  function complete(child) {
    const parent = ledger.data.jobs[child.codingParent];
    if (!parent || child.codingReported || !["done", "blocked", "dismissed", "cancelled"].includes(child.state) || JOB_TERMINAL.includes(parent.state)) return;
    child.codingReported = true;
    if (child.investigation) {
      (parent.inbox ||= []).push({ content: `Investigation ${child.id} (${child.provider?.model || "investigator"}) finished ${child.state}: ${String(child.summary || "").slice(0, 4000)}. Check the key evidence yourself before acting on it or telling the player.`, at: new Date(now()).toISOString(), investigationResult: child.id });
      if (["waiting", "blocked"].includes(parent.state)) parent.state = "queued";
      ledger.audit("investigation_result_ready", { job: parent.id, child: child.id }); ledger.save();
      return;
    }
    (parent.inbox ||= []).push({ content: `Coding task ${child.id} (${child.provider?.model || "subworker"}) finished ${child.state}: ${String(child.summary || "").slice(0, 2000)}. Use review_fix inspect to review the actual patch and test report before applying or publishing.`, at: new Date(now()).toISOString(), codingResult: child.id });
    if (parent.state === "waiting") parent.state = "queued";
    ledger.audit("coding_result_ready", { job: parent.id, child: child.id }); ledger.save();
  }
  // Also settle children that expire while queued or sleeping. They never
  // reach agent.run's finally callback, so completion must not depend on it.
  function tick() {
    for (const child of Object.values(ledger.data.jobs)) {
      if (!child.codingParent) continue;
      const parent = ledger.data.jobs[child.codingParent];
      if ((!parent || JOB_TERMINAL.includes(parent.state)) && ["queued", "waiting", "blocked"].includes(child.state)) {
        child.state = "cancelled"; child.wakeAt = 0; child.updatedAt = now();
        ledger.audit("delegation_cancelled", { job: child.id, parent: child.codingParent, reason: "parent-terminal-or-missing" }); ledger.save();
      }
      const deadline = Math.min(child.deadline || Infinity, (child.at ?? now()) + MAX_DELEGATION_MS);
      if (["queued", "waiting"].includes(child.state) && now() >= deadline) {
        child.state = "blocked"; child.wakeAt = 0; child.updatedAt = now();
        child.summary = `Delegated task exceeded its one-hour wait budget. Parent must narrow or reschedule the work. Last checkpoint: ${child.summary || "No checkpoint saved."}`.slice(0, 4000);
        ledger.audit("delegation_wait_exhausted", { job: child.id, parent: child.codingParent }); ledger.save();
      }
      complete(child);
    }
  }
  return { delegate, investigate, review, complete, tick };
}
module.exports = { patchReadError, PATCH_READ_MS, codingSpec, createDelegation, childTools, INVESTIGATOR_TOOLS };
