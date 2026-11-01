"use strict";
// Keir 7: failed reads and raw-database workarounds are requests for a missing
// tool (owner, 2026-11-01: "We should treat failed tools or weird hacking of
// MCPs as signs MCPs need to be expanded"). Over the week of 2026-10-25 Keir
// hit 678 refused calls; the largest group was raw heal_query reads failing on
// query syntax because no purpose-built read covered the question.
//
// Hourly, the audit trail is grouped by signature: the server/tool and kind of
// failure, or the collection a raw read had to reach into. A signature seen at
// least MIN_HITS times across at least MIN_TASKS tasks becomes one capability
// request on the lakeside-mcp board, and later hits update that same card with
// the running count, so the most repeated gaps rise to the top. Policy refusals
// (copy guards, scope, inactive tasks) say nothing about missing tools and are
// ignored. Filing is read and write to the kanban only.

const WINDOW_MS = 7 * 86400000;
const MIN_HITS = 3, MIN_TASKS = 2;
const REFILE_MS = 24 * 3600000;

// Failures that mean the tool could not do what was asked.
const CLASSES = [
  ["wrong argument names", /unrecognized_key|unrecognized key|Unrecognized key/i],
  ["argument types", /invalid_type|Expected .* received|must be (?:a|an) /i],
  ["raw query syntax", /cannot nest \$|unknown operator|Cannot do exclusion|Unsupported conversion|PlanExecutor/i],
  ["record not found by id", /could not be found|not found/i],
  ["tool timed out", /timed? ?out|aborted due to timeout|This operation was aborted/i],
];
// Refusals that are policy, not missing capability.
const POLICY = /Not posted|authority is inactive|outside (?:support|quick read) scope|closed to support reads|read the assigned ticket only|own card|reporter|channel no longer exists|channels\/null|copy|owner decision/i;

function signatureOf(event) {
  if (event.kind === "raw_read" && event.collection) return { sig: `raw:${event.collection}`, title: `A read for ${event.collection} without raw database queries`, what: `Tasks had to read the ${event.collection} collection through heal-ops raw queries because no purpose-built read covers it.` };
  if (event.kind !== "tool_refused" || event.tool !== "read_tool" && !event.target) return null;
  const error = String(event.error || "");
  if (POLICY.test(error)) return null;
  const cls = CLASSES.find(([, re]) => re.test(error));
  if (!cls) return null;
  const target = event.target || /tool (\w+)/.exec(error)?.[1] || "read_tool";
  const isRaw = cls[0] === "raw query syntax";
  return { sig: `${isRaw ? "rawsyntax" : "tool"}:${target}:${cls[0]}`,
    title: isRaw ? `Raw ${target} queries keep failing: a purpose-built read is missing` : `${target}: ${cls[0]}`,
    what: isRaw ? `Tasks wrote raw database queries through ${target} and they failed (${cls[0]}). Each one is a question no purpose-built read answers.` : `Calls to ${target} failed with ${cls[0]}. Either the tool should accept what tasks send (aliases, both id forms) or a better-shaped read is missing.` };
}

function createCapabilityGaps({ ledger, mcp, events = null, now = () => Date.now(), log = () => {} }) {
  const d = ledger.data;
  // The ledger keeps only recent audits; the event store keeps the week.
  const recent = (since) => events?.enabled && events.byKind
    ? [...events.byKind("audit:tool_refused", since), ...events.byKind("audit:raw_read", since)]
    : (d.audit || []).filter((a) => a.at >= since);
  async function tick() {
    const since = now() - WINDOW_MS;
    const groups = new Map();
    for (const a of recent(since)) {
      if (a.at < since) continue;
      const s = signatureOf(a);
      if (!s) continue;
      const g = groups.get(s.sig) || { ...s, hits: 0, tasks: new Set(), samples: [] };
      g.hits++; if (a.job) g.tasks.add(a.job);
      if (g.samples.length < 3 && a.error) g.samples.push(String(a.error).replace(/\s+/g, " ").slice(0, 200));
      groups.set(s.sig, g);
    }
    const state = (d.capabilityGaps ||= {});
    let filed = 0;
    for (const g of [...groups.values()].sort((a, b) => b.hits - a.hits)) {
      if (g.hits < MIN_HITS || g.tasks.size < MIN_TASKS) continue;
      const known = state[g.sig];
      if (known && known.hits === g.hits) continue;
      if (known?.at && now() - known.at < REFILE_MS && g.hits < (known.hits || 0) * 2) continue;
      const detail = `${g.what}\n\nSeen ${g.hits} times across ${g.tasks.size} tasks in the last 7 days.${g.samples.length ? `\nExamples:\n${g.samples.map((x) => `- ${x}`).join("\n")}` : ""}\n\nFiled automatically from Keir's failed and workaround reads; repeats raise its count.`;
      try {
        if (known?.kanbanId) {
          await mcp.call("ops-knowledge", "work_report", { id: known.kanbanId, event: "progress", summary: `Now ${g.hits} hits across ${g.tasks.size} tasks in 7 days.`, idempotency_key: `gap:${g.sig}:${g.hits}` }, true);
        } else {
          const card = await mcp.call("ops-knowledge", "kanban_add", { product: "lakeside-mcp", kind: "capability", lane: "next", impact: g.hits >= 10 ? "high" : "medium", title: g.title.slice(0, 280), detail: detail.slice(0, 19000) }, true);
          state[g.sig] = { ...(state[g.sig] || {}), kanbanId: Number(card?.id) || null };
        }
        state[g.sig] = { ...state[g.sig], hits: g.hits, tasks: g.tasks.size, at: now() };
        ledger.audit("capability_gap_filed", { sig: g.sig, hits: g.hits, tasks: g.tasks.size, kanbanId: state[g.sig].kanbanId });
        filed++;
      } catch (e) { log(`capability gaps: ${e.message}`); }
    }
    if (filed) ledger.save();
    return { groups: groups.size, filed };
  }
  return { tick };
}

module.exports = { createCapabilityGaps, signatureOf, MIN_HITS, MIN_TASKS };
