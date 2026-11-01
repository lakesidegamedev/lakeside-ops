"use strict";

// Heals requested by a summoned agent.
//
// The agent only holds a read-only MCP token, so it cannot write to any game
// database itself. It asks this service for a heal; this service runs the dry
// run through heal-ops (so the numbers on the confirmation card come from
// heal-ops, not from the agent), posts the card, and applies only after a
// developer reacts ✅. The apply re-plans first and refuses if the affected set
// moved since the card was posted.

const ENVS = ["prod", "sandbox", "dev"];
const ENV_LABEL = { prod: "the main server", sandbox: "sandbox", dev: "dev" };
const MAX_ADHOC_AFFECTED = 200;

function createHealOps({ url, token, fetchImpl = fetch }) {
  async function call(name, args) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`heal-ops ${name}: HTTP ${res.status}`);
    const raw = await res.text();
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine ? dataLine.slice(6) : raw);
    if (payload.error) throw new Error(`heal-ops ${name}: ${payload.error.message}`);
    const textPart = ((payload.result && payload.result.content) || []).find((c) => c.type === "text");
    if (!textPart) return {};
    try {
      return JSON.parse(textPart.text);
    } catch {
      return { ok: false, error: textPart.text.slice(0, 500) };
    }
  }
  return { call };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate what the agent asked for. Returns { ok, spec } or { ok: false, error }. */
function validateRequest(body) {
  const b = isPlainObject(body) ? body : {};
  if (!ENVS.includes(b.env)) return { ok: false, error: `env must be one of ${ENVS.join(", ")}` };

  if (b.kind === "ledger") {
    if (typeof b.defectId !== "string" || !/^[\w.-]{1,80}$/.test(b.defectId)) {
      return { ok: false, error: "defectId is required (see heal_list)" };
    }
    const spec = { kind: "ledger", env: b.env, defectId: b.defectId };
    if (b.ticket !== undefined) {
      const n = Number(b.ticket);
      if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "ticket must be a positive integer" };
      spec.ticket = n;
    }
    return { ok: true, spec };
  }

  if (b.kind === "adhoc") {
    const description = String(b.description || "").trim();
    if (description.length < 10) return { ok: false, error: "description is required: what you are repairing and why" };
    if (typeof b.collection !== "string" || !/^[\w.-]{1,80}$/.test(b.collection)) {
      return { ok: false, error: "collection is required" };
    }
    if (!isPlainObject(b.filter) || !Object.keys(b.filter).length) {
      return { ok: false, error: "filter is required and must not be empty" };
    }
    const action = b.action;
    if (!isPlainObject(action) || !["set", "unset", "delete"].includes(action.kind)) {
      return { ok: false, error: 'action must be {kind:"set", set:{...}}, {kind:"unset", unset:[...]} or {kind:"delete"}' };
    }
    if (action.kind === "delete") return { ok: false, error: "deletes are not available through Keir; ask a developer to run it" };
    const expectedMax = Number(b.expectedMax);
    if (!Number.isInteger(expectedMax) || expectedMax <= 0 || expectedMax > MAX_ADHOC_AFFECTED) {
      return { ok: false, error: `expectedMax must be a whole number from 1 to ${MAX_ADHOC_AFFECTED}` };
    }
    const spec = {
      kind: "adhoc",
      env: b.env,
      description: description.slice(0, 500),
      collection: b.collection,
      filter: b.filter,
      action,
      expectedMax,
    };
    if (b.touchesMoney === true) spec.touchesMoney = true;
    if (b.ticket !== undefined) spec.ticket = String(b.ticket);
    return { ok: true, spec };
  }

  // Paying a corporation back. Never an ad-hoc liquidCapital set: heal-ops'
  // compensation credits the exact amount once and writes the ledger receipt.
  if (b.kind === "compensation") {
    const description = String(b.description || "").trim();
    if (description.length < 10) return { ok: false, error: "description is required: who is owed what and why" };
    const credits = Array.isArray(b.credits) ? b.credits : [];
    if (!credits.length || credits.length > MAX_ADHOC_AFFECTED) return { ok: false, error: `credits must list 1 to ${MAX_ADHOC_AFFECTED} corporations` };
    const clean = [];
    for (const c of credits) {
      if (!isPlainObject(c) || !/^[0-9a-f]{24}$/.test(String(c.corporationId || ""))) return { ok: false, error: "each credit needs a corporationId (24 hex characters)" };
      const amount = Number(c.amountLocal);
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "each credit needs a positive amountLocal in the corporation's own currency" };
      clean.push({ corporationId: c.corporationId, amountLocal: amount, ...(c.basis ? { basis: String(c.basis).slice(0, 300) } : {}) });
    }
    const spec = { kind: "compensation", env: b.env, mode: "credit", description: description.slice(0, 500), credits: clean, expectedMax: clean.length, touchesMoney: true };
    if (b.ticket !== undefined) spec.ticket = String(b.ticket);
    return { ok: true, spec };
  }

  return { ok: false, error: 'kind must be "ledger", "adhoc" or "compensation"' };
}

function specFields(spec) {
  // touchesMoney is Keir's own approval signal; compensation always moves money.
  const { kind, ...rest } = spec;
  if (kind === "compensation") delete rest.touchesMoney;
  return rest;
}
const PLAN_TOOL = { ledger: "heal_plan", adhoc: "heal_adhoc_plan", compensation: "heal_compensate_plan" };
const APPLY_TOOL = { ledger: "heal_apply", adhoc: "heal_adhoc_apply", compensation: "heal_compensate_apply" };

function planCall(spec, operator) {
  return {
    name: PLAN_TOOL[spec.kind],
    args: { ...specFields(spec), operator },
  };
}

function applyCall(spec, token, operator) {
  // heal-ops returns the minted token as {id, expiresAt, ...}; apply takes the id.
  const id = typeof token === "string" ? token : token && token.id;
  if (typeof id !== "string" || !id) throw new Error("heal-ops plan returned no usable confirm token id");
  return {
    name: APPLY_TOOL[spec.kind],
    args: {
      ...specFields(spec),
      token: id,
      operator,
      confirmAdminApply: true,
      ...(spec.env === "prod" ? { confirmProd: true } : {}),
    },
  };
}

/** Why heal-ops would not mint a token, in one line. */
function planRefusal(result) {
  if (!result) return "heal-ops did not answer";
  if (result.ok === false) return result.error || "heal-ops refused the plan";
  if (result.token) return null;
  return (result.guards && result.guards.refusal) || result.tokenWithheld || "heal-ops did not issue a confirm token";
}

function affectedOf(result) {
  return Number((result && result.plan && result.plan.affected) || 0);
}

// What an approval actually covers. A compensation plan restates its credits
// in the anchor currency at the current exchange rate, so its summary, anchor
// amounts and money delta move every turn while the payment itself does not.
// Ticket 1730 (2026-11-01): an approval given after a turn processed was
// refused as "plan changed" and the owner was asked again. A compensation is
// identified by who is paid what in their own currency; every other plan by
// its whole dry run.
function planIdentity(plan) {
  const credits = plan && plan.payload && Array.isArray(plan.payload.credits) ? plan.payload.credits : null;
  if (!credits) return plan;
  return {
    kind: "compensation",
    affected: Number(plan.affected || 0),
    missing: plan.payload.missing || [],
    credits: credits.map((c) => ({ corporationId: String(c.corporationId), amountLocal: Number(c.amountLocal), currencyCode: c.currencyCode || null })),
  };
}

/** The confirmation card. Plain words; the numbers come from heal-ops' dry run. */
function cardText({ spec, plan, requester, people }) {
  const what = spec.kind === "ledger" ? (plan.plan && plan.plan.summary) || spec.defectId : spec.description;
  const money = Number((plan.plan && plan.plan.moneyDelta) || 0);
  const pings = people.map((p) => `<@${p.id}>`).join(" ");
  return [
    `**Heal request** (asked by ${requester})`,
    what,
    `Where: ${ENV_LABEL[spec.env]} · Records changed: ${affectedOf(plan)}${money ? ` · Money moved: ${money}` : ""}`,
    `${pings} react ✅ to apply or ❌ to cancel. Expires in 9 minutes.`,
  ].join("\n");
}

module.exports = {
  planIdentity,
  ENV_LABEL,
  createHealOps,
  validateRequest,
  planCall,
  applyCall,
  planRefusal,
  affectedOf,
  cardText,
};
