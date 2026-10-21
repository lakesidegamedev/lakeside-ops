// @ts-check
// Studio panels for a Keir VPS: open support tickets and the kanban queue,
// read through the owner-authenticated desktop gateway's vps_read. Read-only;
// each section fails on its own so one slow service never hides the other.
import { loadVps, readVpsToken } from "../vps-profile.mjs";
import { openVpsClient, vpsEndpoint } from "./vps-client.mjs";

const clean = (/** @type {unknown} */ value, max = 140) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, max);

/** @param {any} result */
function parseToolResult(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((/** @type {any} */ block) => block.type === "text")?.text;
  if (typeof text !== "string") throw Error("Empty tool result");
  // The gateway wraps the remote tool's own text result.
  const outer = JSON.parse(text);
  const inner = outer?.content?.find?.((/** @type {any} */ block) => block.type === "text")?.text;
  return typeof inner === "string" ? JSON.parse(inner) : outer;
}

/**
 * Paseo answers with a short header and then JSON; the gateway may pass it as
 * { text }. Recent, unarchived agents first.
 * @param {any} value
 */
export function summarizeAgents(value) {
  let data = value;
  if (typeof value?.text === "string") {
    const start = value.text.indexOf("{");
    data = start >= 0 ? JSON.parse(value.text.slice(start)) : {};
  }
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  return agents.filter((/** @type {any} */ a) => a && !a.archivedAt)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 8).map((/** @type {any} */ a) => ({
      id: clean(a.shortId || a.id, 12), title: clean(a.title, 70), provider: clean(a.provider, 16), model: clean(a.model, 32),
      status: clean(a.status, 16), attention: a.requiresAttention === true ? clean(a.attentionReason || "needs you", 20) : "", updatedAt: clean(a.updatedAt, 40),
    }));
}

/** @param {any} value */
export function summarizeTickets(value) {
  const items = Array.isArray(value?.items) ? value.items : Array.isArray(value?.tickets) ? value.tickets : [];
  return items.filter((/** @type {any} */ t) => t && Number.isFinite(Number(t.number))).slice(0, 8).map((/** @type {any} */ t) => ({
    number: Number(t.number), title: clean(t.title, 80), category: clean(t.category, 20), status: clean(t.status, 20), updatedAt: clean(t.updatedAt || t.createdAt, 40),
  }));
}

/** @param {any} value */
export function summarizeKanban(value) {
  const pick = (/** @type {string} */ lane) => (Array.isArray(value?.[lane]) ? value[lane] : []).slice(0, 5).map((/** @type {any} */ item) => ({
    id: Number(item.id), title: clean(item.title, 80), lane: clean(item.lane, 12), owner: clean(item.assigned_to, 40), needsOwner: item.needs_owner === true, stale: item.stale === true,
  }));
  return { counts: value?.counts || {}, needsOwner: pick("needs_owner"), now: pick("now"), next: pick("next"), blocked: pick("blocked") };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function loadStudio(env = process.env, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let profile;
  try { profile = loadVps(env); } catch { return { state: "error", detail: "VPS profile is invalid. Run lakeside code vps status." }; }
  if (!profile) return { state: "unconfigured", detail: "Studio panels need a Keir VPS. Run lakeside code vps connect --url HTTPS_ORIGIN --token-file LOCAL_FILE." };
  if (profile.kind !== "keir") return { state: "unsupported", detail: "Studio panels need a Keir VPS connection; this is a generic MCP profile." };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = openVpsClient({ ...vpsEndpoint(profile, readVpsToken(profile.tokenFile)), fetchImpl, signal: controller.signal });
    await client.initialize("lakeside-code-studio");
    const read = async (/** @type {string} */ server, /** @type {string} */ tool, /** @type {object} */ args) =>
      parseToolResult(await client.request("tools/call", { name: "vps_read", arguments: { server, tool, args } }));
    const out = { state: "connected", origin: profile.origin, checkedAt: new Date().toISOString(), tickets: /** @type {any} */ (null), kanban: /** @type {any} */ (null), agents: /** @type {any} */ (null), errors: /** @type {string[]} */ ([]) };
    try { out.tickets = summarizeTickets(await read("support", "support_list", { kind: "ticket", status: "open", limit: 8 })); } catch { out.errors.push("tickets unavailable"); }
    try { out.kanban = summarizeKanban(await read("ops-knowledge", "kanban_brief", {})); } catch { out.errors.push("kanban unavailable"); }
    // Paseo agents are optional: older servers do not expose them to the desktop gateway.
    try { out.agents = summarizeAgents(await read("paseo", "list_agents", {})); } catch { out.agents = null; }
    return out;
  } catch (/** @type {any} */ error) {
    const status = error?.status;
    return { state: "error", detail: status === 401 || status === 403 ? "VPS session expired. Mint a 30-day device token (POST /api/auth/native-session with header x-lakeside-client: cli), save it to the token file and run lakeside code vps connect again." : controller.signal.aborted ? "VPS did not answer in time. Try /reconnect." : "VPS could not be reached." };
  } finally { clearTimeout(timer); }
}
