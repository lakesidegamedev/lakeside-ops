"use strict";
// Keir 8.4: change classification and the owner-approval guard.
//
// Owner, 2026-11-06: while the owner is away Keir may ship bug and display fixes and documented data
// heals through the normal pipeline. Rule, balance and economy-behaviour changes wait for the owner.
//
// The classification field is `changeClass` on the github tool's merge and promote actions (and
// `Change-class: <class>` on its own line in a PR body). Allowed values:
//   bugfix | display | data-heal | rule | balance | economy-behaviour
// `rule`, `balance` and `economy-behaviour` are OWNER_GATED. A change whose class is not declared is
// classified from its files (blastradius.classify): economy paths are economy-behaviour, copy
// paths are display, and any other logic change must be declared (CHANGE_CLASS_REQUIRED).
// Other spellings (bug_fix, rule_change, economy_change ...) are aliases, see ALIASES.
// A bugfix/display declaration whose PR title announces a rebalance, nerf, buff or rule change is gated anyway. Declaring a gated class can never be
// bypassed; declaring bugfix on economy paths is allowed only with the existing exact approval flow.
// A gated change ships only with a recorded approval from the owner's approval card (his own button, or the
// cofounder's on his behalf as before). A task's opening message and Keir itself are never approval.
const CLASSES = Object.freeze(["bugfix", "display", "data-heal", "rule", "balance", "economy-behaviour"]);
const OWNER_GATED = Object.freeze(new Set(["rule", "balance", "economy-behaviour"]));

// Spellings accepted on input so old ledger rows, decisions and PR bodies written with the other vocabulary
// (bug_fix, display_fix, data_heal, rule_change, balance_change, economy_change) still classify. Output is always CLASSES.
const ALIASES = Object.freeze({
  "bug-fix": "bugfix", fix: "bugfix", bug: "bugfix",
  "display-fix": "display", copy: "display",
  "data-heal": "data-heal", heal: "data-heal",
  "rule-change": "rule",
  "balance-change": "balance",
  economy: "economy-behaviour", economic: "economy-behaviour", "economy-change": "economy-behaviour", "economy-behavior": "economy-behaviour",
});
function normalizeClass(value) {
  const v = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  const cls = ALIASES[v] || v;
  return CLASSES.includes(cls) ? cls : null;
}
const requiresOwner = (value) => OWNER_GATED.has(normalizeClass(value));
// For tool input: empty is null, an unknown value is an error.
function parseClass(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const cls = normalizeClass(value);
  if (!cls) throw new Error(`changeClass must be one of ${CLASSES.join(", ")}. Bug and display fixes and documented data heals may ship; a rule, balance or economy-behaviour change waits for the owner.`);
  return cls;
}
function declaredFromBody(body) {
  const m = /^\s*Change-class:\s*([A-Za-z_ -]+?)\s*$/im.exec(String(body || ""));
  return m ? normalizeClass(m[1]) : null;
}
// Titles that announce a balance or rule change regardless of what the author declared.
const BEHAVIOUR_TITLE = /\b(?:re-?balanc\w*|nerf(?:ed|s)?|buff(?:ed|s)?|tuning|rule change|balance (?:change|pass|tweak))\b/i;
// declared: input.changeClass; body/title: the PR; blastClass: blastradius.classify().cls (copy|logic|economy)
function classifyChange({ declared, body, title, blastClass } = {}) {
  const fromInput = normalizeClass(declared), fromBody = declaredFromBody(body);
  // A gated declaration anywhere wins over a softer one elsewhere.
  for (const [cls, source] of [[fromInput, "declared"], [fromBody, "pr-body"]]) if (cls && OWNER_GATED.has(cls)) return { cls, source, gated: true };
  const cls = fromInput || fromBody;
  if (cls) {
    if (["bugfix", "display"].includes(cls) && BEHAVIOUR_TITLE.test(String(title || ""))) return { cls: "balance", source: "title", gated: true };
    return { cls, source: fromInput ? "declared" : "pr-body", gated: false, economyPaths: blastClass === "economy" };
  }
  if (blastClass === "economy") return { cls: "economy-behaviour", source: "paths", gated: true };
  if (blastClass === "copy") return { cls: "display", source: "paths", gated: false };
  // Logic changes can be bug fixes or rule changes; paths cannot tell. The author must say which.
  return { cls: "unclassified", source: "none", gated: false, needsDeclaration: true };
}
// A recorded approval for this exact operation, given through the existing approval card (d.actions): approvedBy is the
// owner id; approvedOnBehalfBy is set when the cofounder pressed the button for him. Keir can never produce one itself.
// Set inPerson to refuse delegate approvals (env KEIR_GATED_OWNER_IN_PERSON=1 in the operator).
// A merge-set approval (several related PRs of one ticket) covers each PR it lists.
function ownerApprovalFor(d, { ownerId, number = null, to = null, action = null, now = Date.now(), maxAgeMs = 24 * 3600000, inPerson = false } = {}) {
  const covers = (a) => {
    const args = a.args || {};
    if (action !== null && args.action === action && (number === null || Number(args.number) === Number(number)) && (to === null || args.to === to)) return true;
    return action === "merge" && args.action === "merge-set" && (args.prs || []).some((p) => Number(p.number) === Number(number));
  };
  return Object.values(d.actions || {}).find((a) => a.kind === "github" && ["approved", "executing", "done"].includes(a.state)
    && a.approvedBy === ownerId && !(inPerson && a.approvedOnBehalfBy) && now - (a.approvedAt || a.at || 0) <= maxAgeMs && covers(a)) || null;
}
function assertShippable(d, { declared, body, title, blastClass, ownerId, action, number, to, now = Date.now(), inPerson = false } = {}) {
  const c = classifyChange({ declared, body, title, blastClass });
  if (c.needsDeclaration) throw Object.assign(new Error(`Refused: say what kind of change this ${action} ships. Pass changeClass as bugfix, display, data-heal, rule, balance or economy-behaviour (or put "Change-class: bugfix" on its own line in the PR description). Rule, balance and economy-behaviour changes need the owner's own approval; bug and display fixes do not.`), { code: "CHANGE_CLASS_REQUIRED" });
  if (!c.gated) return { ...c, approved: null };
  const approval = ownerApprovalFor(d, { ownerId, number, to, action, now, inPerson });
  if (approval) return { ...c, approved: approval.id };
  throw Object.assign(new Error(`Refused: this change is classed ${c.cls} (${c.source}). Rule, balance and economy-behaviour changes ship only with the owner's own recorded approval, and none is on record for this ${action}. Ask the owner through the approval card and finish waiting. Bug and display fixes do not need this: declare changeClass bugfix or display if that is what this is.`), { code: "OWNER_APPROVAL_REQUIRED", changeClass: c.cls });
}
module.exports = { CLASSES, OWNER_GATED, ALIASES, normalizeClass, parseClass, requiresOwner, declaredFromBody, classifyChange, ownerApprovalFor, assertShippable };
