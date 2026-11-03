"use strict";

// Product kanban tools for the ops-knowledge MCP. Same store the dashboard's
// /kanban page uses (../kanban-store.js, OPS_KANBAN_DB). Reads need any valid
// token; writes need a token with write scope.

const { z } = require("zod");
const { sharedKanban, OPEN_LANES, LANES, REPORT_EVENTS, KINDS, WIP_CAP, RELEASE_DAYS, normalizeActor } = require("../kanban-store");

const PRODUCT_HELP = 'Product slug or alias, e.g. "a-house-divided" (aliases: ahd, AHDGame, adhd-bot), "margin-of-victory" (mov), "metroforge" (mf), "grand-century" (gc), "foreshore", "verdigris", "lakeside-mcp" (mcp: MCP/tool capability requests, kind capability).';

function registerKanbanTools(server, { auth, jsonResult, errorResult, store = sharedKanban }) {
  const canWrite = auth && auth.scopes && auth.scopes.write === true;
  // The token name is shared by many agents, so it is never used as an actor.
  const actorFor = (actor) => normalizeActor(actor) || "unnamed";
  const ACTOR = z.string().max(120).optional().describe("Who you are: claude, codex, keir, muse or deepseek, plus :session when several run at once (e.g. claude:7f3a). Always send it.");
  const withWarning = (result, actor) => (normalizeActor(actor) ? result : { ...result, warning: "No actor given, so this was recorded as 'unnamed'. Send actor on every write." });

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
    "Start here. Short brief: the board rules, your own open cards (pass actor), cards released for going quiet, blocked, in progress, next, shipped in 3 days, monitor heartbeats and recent progress.",
    {
      product: z.string().optional().describe(`${PRODUCT_HELP} Omit for every product.`),
      limit: z.number().int().min(1).max(50).optional().default(10),
      actor: ACTOR,
    },
    async ({ product, limit, actor }) => guarded((k) => k.brief({ product, limit, actor })),
  );

  server.tool(
    "kanban_list",
    "List kanban items. Open lanes by default (now, next, blocked, inbox, backlog); filter by product, lane, assigned_to, kind, staleness or text. A truncated result includes a hint.",
    {
      product: z.string().optional().describe(PRODUCT_HELP),
      lane: z.enum(LANES).optional().describe("now (in progress) | next (committed, has an owner) | blocked | inbox (filed, not picked up) | backlog | done"),
      assigned_to: z.string().optional().describe("Cards held by this actor (e.g. claude, keir)"),
      kind: z.enum(KINDS).optional(),
      include_monitors: z.boolean().optional().describe("Default true; false hides always-on monitor cards"),
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
    `Add a kanban item. start:true puts it straight into now, assigned to you (cap ${WIP_CAP} in progress per actor). lane next needs an owner; without one it lands in inbox. If an open card already covers the same work it is returned with duplicate:true instead of adding a copy (force:true to add anyway). Never file a question for the owner; ask in chat.`,
    {
      product: z.string().describe(PRODUCT_HELP),
      title: z.string().min(1).max(300),
      detail: z.string().max(20000).optional(),
      lane: z.enum(OPEN_LANES).optional().default("inbox"),
      impact: z.enum(["high", "medium", "low"]).optional().default("medium"),
      kind: z.string().max(40).optional().describe(`One of ${KINDS.join(", ")} (synonyms like issue or enhancement are mapped). capability: an MCP/tool request on product lakeside-mcp.`),
      github: z.string().optional().describe("Link a GitHub issue: owner/repo#N or the issue URL"),
      evidence_url: z.string().url().optional(),
      assigned_to: z.string().optional(),
      start: z.boolean().optional().describe("Add and mark started in one call"),
      summary: z.string().max(4000).optional().describe("Started summary when start:true"),
      force: z.boolean().optional().describe("Add even if a similar open card exists or you are at the in-progress cap"),
      actor: ACTOR,
    },
    // Agents never flag owner decisions here: the owner is asked in chat and the
    // answer is recorded on the card afterwards (owner rule, 2026-10-17).
    async ({ actor, ...input }) => guarded((k) => withWarning(k.add({ ...input, needs_owner: false }, { actor: actorFor(actor) }), actor), { write: true }),
  );

  server.tool(
    "kanban_update",
    "Edit or move a kanban item: title, detail, lane, impact, kind, assigned_to, evidence_url, github link, product. To release a card you will not finish: lane next and assigned_to \"\". Any update clears a stale flag.",
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
      force: z.boolean().optional().describe("Move into now even at the in-progress cap"),
      actor: ACTOR,
    },
    async ({ id, actor, ...patch }) => guarded((k) => withWarning(k.update(id, patch.needs_owner === true ? { ...patch, needs_owner: undefined } : patch, { actor: actorFor(actor) }), actor), { write: true }),
  );

  server.tool(
    "work_report",
    `Report work on a kanban item. started -> now, assigned to you (cap ${WIP_CAP} per actor). progress -> a plain sentence people read (no JSON). blocked -> blocked. decision_requested -> progress note only (ask the owner in chat). completed -> done, needs evidence_url or no_evidence_reason. Cards with no update for ${RELEASE_DAYS} days are released back to next automatically. idempotency_key makes retries safe.`,
    {
      id: z.number().int().positive(),
      event: z.enum(REPORT_EVENTS),
      summary: z.string().min(1).max(4000),
      evidence_url: z.string().url().optional(),
      no_evidence_reason: z.string().max(300).optional().describe("Required on completed when there is no evidence_url: why there is no link"),
      force: z.boolean().optional().describe("started even at the in-progress cap"),
      actor: ACTOR,
      idempotency_key: z.string().max(200).optional(),
    },
    async ({ actor, ...input }) => guarded((k) => withWarning(k.report(input.event === "decision_requested"
      ? { ...input, event: "progress", summary: `Decision pending with the owner in chat: ${input.summary}`.slice(0, 4000), actor: actorFor(actor) }
      : { ...input, actor: actorFor(actor) }), actor), { write: true }),
  );

  server.tool(
    "kanban_github_sync",
    "Pull GitHub issues into the kanban now (the timer also runs every 15 minutes, followed by board hygiene): new open issues land in backlog with an excerpt of the issue body, closed linked issues move to done.",
    { repo: z.string().optional().describe("owner/name; omit for every source repo") },
    async ({ repo }) => guarded(async (k) => ({ synced: await k.syncGithub({ repo: repo || null }) }), { write: true }),
  );
}

module.exports = { registerKanbanTools };
