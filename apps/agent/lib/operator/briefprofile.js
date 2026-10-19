"use strict";
// Lean activation context (2026-10-18). Every activation used to carry the whole
// brief, every skill and every tool schema, whatever the job was: a coder child
// read the persona and a finding read the player-chat rules. This module keeps
// a job's brief to the sections its kind needs, replaces skill bodies with a
// short digest, and defers rare tool schemas behind call_tool. Nothing is lost:
// omitted sections, full skills and deferred schemas load through load_context.
// Anything not named below stays in the brief, so a new section defaults to
// included and a renamed one fails test/briefprofile.test.js.

const OWNER_APP = "Owner app and support continuity";
const ALLOW = {
  coder: ["Authority", "Recovery and privacy"],
  investigator: ["Authority", "Capabilities", "Investigate before asking", "Memory and accuracy (Keir 2.0)", "Recovery and privacy"],
  probe: ["Authority", "Capabilities", "Recovery and privacy"],
};
const DROP = {
  finding: ["Character identity: Keir Starmer", "Judgment with players", "Conversation", "Ticket progress card", "Standing support", OWNER_APP, "One ask per approval"],
  quick: ["Findings (Keir 5.0)", "Heals and approvals", "Developer handoffs", "Investigation and delegated coding", "Standing support", "Ticket progress card", OWNER_APP],
  work: ["Findings (Keir 5.0)"],
};
// Paragraphs that only matter for in-character banter, which the quick lane serves.
const BANTER = [/^Your preloaded public backstory/, /^Bring that background/];
const SOURCES = /^Biography sources/;

// Tools a ticket or command rarely needs. Their schemas load on demand and run
// through call_tool; the completion tools and the everyday reads stay direct.
const RARE_TOOLS = ["request_heal", "open_suggestion", "chart", "support_directive", "open_ticket", "sentry", "present_choices", "computer", "idea_suggest",
  "feed_post", "merge_into_incident", "merge_related", "artifact_save", "review_fix", "request_action", "execute_action", "view_page", "discord_search",
  "watch_turn", "goal_update", "task_plan", "local_file", "past_ticket", "similar_reports", "open_channel", "add_to_ticket", "player_note",
  "owner_updates", "support_updates", "operator_roles", "task_progress"];

// One paragraph per skill: the rule that must always apply. The full text loads
// with load_context section skills.
const DIGEST = {
  "verification-before-completion": "No claim of fixed, passing, live or done without fresh evidence from this activation: run the check or read the receipt and quote what it showed. Never infer success from an earlier run, a subagent summary or a clean-looking diff. If you could not verify, say what is unverified.",
  "systematic-debugging": "Find the root cause before proposing a fix. Read the error and the code path, reproduce, compare a working case with the broken one, test one hypothesis at a time with the smallest check. After a failed fix re-read the evidence instead of stacking guesses; after three failures question the approach. Raise a developer decision with raise_to_developers instead of asking a human partner.",
  "ponytail-review": "Before publishing a subworker's patch, list what to delete: speculative options, unused helpers, abstractions for a single use, unrelated reformatting. The smallest complete change wins.",
  "ponytail": "Always on at the full level. Make the smallest complete change: no speculative flexibility, no new abstraction for one use, no drive-by edits. The patch is reviewed by a developer and the repository is public.",
  "test-driven-development": "Run or write a failing focused test first, make it pass with the smallest change, rerun that file. Never delete or weaken a test to pass. If a test is impossible, say why in the PR body. Focused tests only, never the full suite.",
  "frontend-design": "You are fixing a page inside the game's established design system. Reuse its components, tokens, type and density; no new typefaces, palettes or decorative redesign.",
};

function split(text) {
  const parts = String(text).split(/^(?=## )/m);
  const head = parts[0].startsWith("## ") ? "" : parts.shift();
  return { head, sections: parts.map((body) => ({ title: /^## (.+)/.exec(body)[1].trim(), body })) };
}

function profileOf(job, quick) {
  if (job.codingParent) return job.investigation ? "investigator" : "coder";
  if (job.kind === "finding") return "finding";
  if (job.internalProbe || job.kind === "probe") return "probe";
  return quick ? "quick" : "work";
}

function trimBanter(body, profile) {
  if (!/^## Character identity/.test(body)) return body;
  return body.split(/\n\n/).filter((p) => !SOURCES.test(p) && (profile === "quick" || !BANTER.some((re) => re.test(p)))).join("\n\n");
}

// Returns the trimmed brief and the section titles left out.
function trim(briefText, profile, job = {}) {
  const { head, sections } = split(briefText);
  const allow = ALLOW[profile], drop = new Set(DROP[profile] || []);
  if (profile === "work") {
    if (job.role !== "owner") drop.add(OWNER_APP);
    // Automatic support and players cannot request or approve heals; a command has no ticket card.
    if (["support", "player"].includes(job.role)) drop.add("Heals and approvals");
    if (!job.ticket) drop.add("Ticket progress card");
  }
  const kept = [], omitted = [];
  for (const s of sections) (allow ? allow.includes(s.title) : !drop.has(s.title) ) ? kept.push(s) : omitted.push(s);
  const body = kept.map((s) => trimBanter(s.body, profile).replace(/\s+$/, "")).join("\n\n");
  return { text: `${head.replace(/\s+$/, "")}\n\n${body}`, omitted };
}

const LOAD_CONTEXT = {
  name: "load_context",
  description: "Load what the brief left out, only when this task needs it. instructions: omit names to list the omitted sections, or give up to three section titles. skills: omit names to list, or name a skill for its full text. tools: omit names to list deferred tools, or give up to three names for exact schemas, then run one with call_tool. This grants no new authority.",
  input_schema: { type: "object", properties: { section: { type: "string", enum: ["instructions", "skills", "tools"] }, names: { type: "array", maxItems: 3, items: { type: "string" } }, offset: { type: "integer", minimum: 0 } }, required: ["section"], additionalProperties: false },
};
const CALL_TOOL = {
  name: "call_tool",
  description: "Run one deferred tool after reading its schema with load_context section tools. Supply its name and arguments. All broker checks still apply.",
  input_schema: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name", "args"], additionalProperties: false },
};

const PAGE = 10000;
const page = (text, offset = 0) => ({ text: text.slice(offset, offset + PAGE), totalChars: text.length, nextOffset: offset + PAGE < text.length ? offset + PAGE : null });

// Everything agent.js needs for one lean activation, or null when the job runs full.
const CORE_DIRECT = ["finish", "submit_result", "retry_result", "finish_patch", "edit_verify", "checkpoint", "channel_reply", "progress_update", "support_action",
  "calculate", "view_attachment", "read_servers", "read_tools", "read_tool", "ticket_history", "reporter_state", "ticket_record", "handoff",
  // Workspace tools stay direct when the broker, not the model's own tools, works the snapshot.
  "shell", "evidence_batch", "local_file", "repository_snapshot"];
// Workspace tools a hybrid activation replaces with the model's own (sandboxed) tools.
const WORKSPACE_TOOLS = ["shell", "evidence_batch", "local_file"];
function lean({ job, quick, briefText, tools, skills, skillLane, skillsRoot, skillNames, enabled = true, coreText = null, hybrid = false }) {
  if (!enabled || job.voiceMode) return null;
  const profile = coreText ? "core" : profileOf(job, quick);
  if (hybrid) tools = tools.filter((t) => !WORKSPACE_TOOLS.includes(t.name));
  const { text, omitted } = coreText ? { text: coreText.trim(), omitted: split(briefText).sections } : trim(briefText, profile, job);
  const deferTools = ["work", "finding", "quick", "core"].includes(profile);
  // The core profile keeps only everyday and completion tools direct; everything else loads on demand.
  const deferred = !deferTools ? [] : profile === "core" ? tools.filter((t) => !CORE_DIRECT.includes(t.name)) : tools.filter((t) => RARE_TOOLS.includes(t.name));
  const direct = tools.filter((t) => !deferred.includes(t));
  const sessionTools = [...direct, LOAD_CONTEXT, ...(deferred.length ? [CALL_TOOL] : [])];
  const catalog = [];
  if (omitted.length) catalog.push(`Brief sections not loaded for this task: ${omitted.map((s) => s.title).join("; ")}. Read one with load_context section instructions when the task turns on it.`);
  if (deferred.length) catalog.push(`Deferred tools (schemas load on demand, run through call_tool): ${deferred.map((t) => t.name).join(", ")}.`);
  const brief = text + (catalog.length ? `\n\n## Not loaded\n\n${catalog.join("\n\n")}` : "");
  const skillDigest = (names) => names.length ? `\n\n## Skills\n\nRules that always apply; Keir's brief wins where they disagree. Full text: load_context section skills.\n\n${names.map((n) => `- ${n}: ${DIGEST[n] || "Apply as written."}`).join("\n")}` : "";
  const load = async (input) => {
    if (input.section === "instructions") {
      if (!input.names?.length) return { sections: omitted.map((s) => s.title) };
      const wanted = input.names.map((n) => omitted.find((s) => s.title.toLowerCase() === String(n).toLowerCase()));
      if (wanted.includes(undefined)) throw new Error("Unknown section; omit names to list those left out");
      return page(wanted.map((s) => s.body).join("\n\n"), input.offset);
    }
    if (input.section === "skills") {
      if (!input.names?.length) return { skills: skillNames };
      if (input.names.some((n) => !skillNames.includes(n))) throw new Error("Skill is outside this lane's selection");
      return page(skills.prepare(skillLane, skillsRoot, input.names).text, input.offset);
    }
    if (!input.names?.length) return { tools: deferred.map((t) => ({ name: t.name, description: t.description.slice(0, 160) })) };
    return { tools: input.names.map((name) => { const t = deferred.find((x) => x.name === name); if (!t) throw new Error("Not a deferred tool; it is already listed or outside this grant"); return { name, description: t.description, inputSchema: t.input_schema }; }) };
  };
  return { profile, brief, omitted: omitted.map((s) => s.title), skillDigest, session: { tools: sessionTools, availableTools: deferred, load, names: tools.map((t) => t.name) }, deferredNames: deferred.map((t) => t.name) };
}

module.exports = { lean, trim, split, profileOf, ALLOW, DROP, RARE_TOOLS, WORKSPACE_TOOLS, DIGEST, LOAD_CONTEXT, CALL_TOOL };
