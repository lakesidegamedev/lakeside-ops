"use strict";

// Product kanban tools for the ops-knowledge MCP. Same store the dashboard's
// /kanban page uses (../kanban-store.js, OPS_KANBAN_DB). Reads need any valid
// token; writes need a token with write scope.

const { z } = require("zod");
const { sharedKanban, OPEN_LANES, LANES, REPORT_EVENTS } = require("../kanban-store");

const PRODUCT_HELP = 'Product slug or alias, e.g. "a-house-divided" (aliases: ahd, AHDGame, adhd-bot), "margin-of-victory" (mov), "metroforge" (mf), "grand-century" (gc), "foreshore", "verdigris", "lakeside-mcp" (mcp: MCP/tool capability requests, kind capability).';

function registerKanbanTools(server, { auth, jsonResult, errorResult, store = sharedKanban }) {
  const canWrite = auth && auth.scopes && auth.scopes.write === true;
  const actorFor = (actor) => String(actor || (auth && auth.name) || "agent").slice(0, 120);

  async function guarded(fn, { write = false } = {}) {
    if (write && !canWrite) return errorResult("this token has no write scope");
    try {
      return jsonResult(await fn(store()));
    } catch (error) {
      if (error.code === "BAD_INPUT" || error.code === "NOT_FOUND") return errorResult(error.message);
      console.error("[kanban-mcp]", error);
      return errorResult(`kanban error: ${error.message}`);
    }
  }

  server.tool(
    "kanban_brief",
    "Product kanban brief: what needs the owner, what is in progress (now), blocked, up next, what is stale, and recent progress. Start product work here.",
    {
      product: z.string().optional().describe(`${PRODUCT_HELP} Omit for every product.`),
      limit: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ product, limit }) => guarded((k) => k.brief({ product, limit })),
  );

  server.tool(
    "kanban_list",
    "List kanban items with updated_at, age_days, stale and needs_owner flags. Open lanes by default; filter by product, lane, staleness, needs_owner or text.",
    {
      product: z.string().optional().describe(PRODUCT_HELP),
      lane: z.enum(LANES).optional().describe("now | next | blocked | backlog | done (done = closed history)"),
      stale: z.boolean().optional().describe("true: only stale items (in now with no update for 5+ days, or flagged); false: exclude them"),
      needs_owner: z.boolean().optional(),
      q: z.string().optional().describe("Substring match on title, detail, progress"),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async (args) => guarded((k) => k.list(args)),
  );

  server.tool(
    "kanban_get",
    "Fetch one kanban item with full detail and recent event history. Accepts legacy Lakeside Hub ids (merged duplicates resolve to the survivor).",
    { id: z.number().int().positive() },
    async ({ id }) => guarded((k) => k.get(id, { events: 40 })),
  );

  server.tool(
    "kanban_add",
    "Add a kanban item. Set start:true to add it straight into now, assigned to you, with a started event (one call instead of add + work_report).",
    {
      product: z.string().describe(PRODUCT_HELP),
      title: z.string().min(1).max(300),
      detail: z.string().max(20000).optional(),
      lane: z.enum(OPEN_LANES).optional().default("backlog"),
      impact: z.enum(["high", "medium", "low"]).optional().default("medium"),
      kind: z.string().max(40).optional().describe("feature | bug | ops | audit | task | capability (capability: an MCP/tool capability request on product lakeside-mcp) ..."),
      github: z.string().optional().describe("Link a GitHub issue: owner/repo#N or the issue URL"),
      evidence_url: z.string().url().optional(),
      assigned_to: z.string().optional(),
      start: z.boolean().optional().describe("Add and mark started in one call"),
      summary: z.string().max(4000).optional().describe("Started summary when start:true"),
      actor: z.string().optional().describe("Who you are (claude, codex, muse...); recorded on events"),
    },
    // Agents never flag owner decisions here: the owner is asked in chat and the
    // answer is recorded on the card afterwards (owner rule, 2026-10-17).
    async ({ actor, ...input }) => guarded((k) => k.add({ ...input, needs_owner: false }, { actor: actorFor(actor) }), { write: true }),
  );

  server.tool(
    "kanban_update",
    "Edit or move a kanban item: title, detail, lane, impact, assigned_to, evidence_url, github link, product. needs_owner can only be cleared (false). Any update clears a stale flag; stale:true re-flags it.",
    {
      id: z.number().int().positive(),
      title: z.string().max(300).optional(),
      detail: z.string().max(20000).optional(),
      lane: z.enum(LANES).optional(),
      impact: z.enum(["high", "medium", "low"]).optional(),
      kind: z.string().max(40).optional(),
      needs_owner: z.boolean().optional(),
      assigned_to: z.string().optional(),
      evidence_url: z.string().optional().describe("http(s) URL, or empty string to clear"),
      github: z.string().optional().describe("owner/repo#N or issue URL; empty string unlinks"),
      product: z.string().optional(),
      stale: z.boolean().optional(),
      actor: z.string().optional(),
    },
    async ({ id, actor, ...patch }) => guarded((k) => k.update(id, patch.needs_owner === true ? { ...patch, needs_owner: undefined } : patch, { actor: actorFor(actor) }), { write: true }),
  );

  server.tool(
    "work_report",
    "Report work on a kanban item. started -> lane now and assigned to you; progress -> summary only; blocked -> lane blocked; decision_requested -> progress note only (ask the owner in chat, never via the kanban); completed -> done. Pass evidence_url (PR, deploy, report) whenever you have one. idempotency_key makes retries safe.",
    {
      id: z.number().int().positive(),
      event: z.enum(REPORT_EVENTS),
      summary: z.string().min(1).max(4000),
      evidence_url: z.string().url().optional(),
      actor: z.string().optional(),
      idempotency_key: z.string().max(200).optional(),
    },
    async ({ actor, ...input }) => guarded((k) => k.report(input.event === "decision_requested"
      ? { ...input, event: "progress", summary: `Decision pending with the owner in chat: ${input.summary}`.slice(0, 4000), actor: actorFor(actor) }
      : { ...input, actor: actorFor(actor) }), { write: true }),
  );

  server.tool(
    "kanban_github_sync",
    "Pull GitHub issues into the kanban now (the timer also runs every 15 minutes): new open issues land in backlog, closed linked issues move to done.",
    { repo: z.string().optional().describe("owner/name; omit for every source repo") },
    async ({ repo }) => guarded(async (k) => ({ synced: await k.syncGithub({ repo: repo || null }) }), { write: true }),
  );
}

module.exports = { registerKanbanTools };
