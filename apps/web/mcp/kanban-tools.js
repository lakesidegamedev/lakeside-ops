"use strict";

// Product kanban tools for the ops-knowledge MCP. Same store the dashboard's
// /kanban page uses (../kanban-store.js, OPS_KANBAN_DB). Reads need any valid
// token; writes need a token with write scope.

const { z } = require("zod");
const { decorateItem, decorateList, decorateBrief, runReconcile } = require("../kanban-tickets");
const { sharedKanban, OPEN_LANES, LANES, REPORT_EVENTS, KINDS, CLASSES, AREAS, WIP_CAP, RELEASE_DAYS, normalizeActor } = require("../kanban-store");
const AREA_HELP = "Area inside the product. " + Object.entries(AREAS).map(([p, a]) => `${p}: ${Object.keys(a).join("/")}`).join("; ");
const CLASS_HELP = "project (multi-step program; other cards can name it as parent_id), issue (something broken or owed: bug, ticket follow-up, release step) or idea (a proposal nobody committed to)";

const PRODUCT_HELP = 'Product slug or alias, e.g. "a-house-divided" (aliases: ahd, AHDGame, adhd-bot), "margin-of-victory" (mov), "metroforge" (mf), "grand-century" (gc), "foreshore", "verdigris", "lakeside-mcp" (mcp: MCP/tool capability requests, kind capability).';

const TICKET = z.union([z.number().int().positive(), z.array(z.number().int().positive()).max(20)]).optional()
  .describe("The support ticket number (or numbers) this card comes from. Its live status is shown on the card, and the card follows the ticket: see ticket_role.");
const TICKET_ROLE = z.enum(["own", "follow_up"]).optional()
  .describe("own (default while the ticket is open): the ticket's own work or question, closed automatically when the ticket closes. follow_up: work that outlives the ticket; stays open, labelled 'Follow-up from closed ticket N'.");

const PULL_REQUEST = z.union([z.string().max(300), z.array(z.string().max(300)).max(20)]).optional()
  .describe("The pull request this card is the work of: owner/repo#N or its URL (or a list). When it merges the card completes, unless still_owed says what remains; closed without merging, the card goes back to the inbox. Send it when you open the PR.");
const STILL_OWED = z.string().max(200).optional()
  .describe("What remains once the pull request merges, in a few words (\"release\", \"run the migration\", \"device test\"). The card then stays open after the merge, relabelled with it. Empty string clears.");
const ALERT_KEY = z.string().max(160).optional()
  .describe("Monitors: a stable key for the condition (e.g. unit-failed:rag-reindex). The same key again updates or reopens its card instead of filing a new one; kanban_alert_clear closes it.");
const ALERT_CHECK = z.string().max(200).optional()
  .describe("Optional, with alert_key: how the board can tell the condition cleared by itself: systemd:<unit> (its next run succeeded) or pr:owner/repo#N (the pull request is no longer open).");

// ticketStatus: a reader from kanban-tickets.createTicketStatusReader. Without
// one, linked cards say "ticket status unknown" instead of guessing.
// prReader / alertReader (kanban-sources.js) let kanban_reconcile follow pull
// requests and alerts; without them those rules are skipped.
function registerKanbanTools(server, { auth, jsonResult, errorResult, store = sharedKanban, ticketStatus = null, prReader = null, alertReader = null }) {
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
    async ({ product, limit, actor }) => guarded((k) => decorateBrief(k.brief({ product, limit, actor }), ticketStatus)),
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
      area: z.string().optional().describe(AREA_HELP),
      class: z.enum(CLASSES).optional().describe(CLASS_HELP),
      parent_id: z.number().int().positive().optional().describe("Child cards of this project"),
      stale: z.boolean().optional().describe("true: only stale items (in now with no update for 5+ days, or flagged); false: exclude them"),
      needs_owner: z.boolean().optional(),
      q: z.string().optional().describe("Substring match on title, detail, progress"),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
    async (args) => guarded((k) => decorateList(k.list(args), ticketStatus)),
  );

  server.tool(
    "kanban_get",
    "Fetch one kanban item with full detail and recent event history. Accepts legacy Lakeside Hub ids (merged duplicates resolve to the survivor). A card linked to a support ticket shows the ticket's live status (Open or Closed); ticket_warning, when present, comes first and says the ticket is closed while the card is not.",
    { id: z.number().int().positive() },
    async ({ id }) => guarded((k) => decorateItem(k.get(id, { events: 40 }), ticketStatus)),
  );

  server.tool(
    "kanban_add",
    `Add a kanban item: work a person or agent chose to track. start:true puts it straight into now, assigned to you (needs actor; cap ${WIP_CAP} in progress per actor). Name its source (ticket, pull_request, alert_key) and it closes when that source closes, merges or clears. Keir's automatic tool-gap and failure counts are recorded in the counter list instead (the reply has counted:true and id null). lane next needs an owner; without one it lands in inbox. If an open card already covers the same work it is returned with duplicate:true instead of adding a copy (force:true to add anyway). Never file a question for the owner; ask in chat.`,
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
      area: z.string().optional().describe(AREA_HELP),
      class: z.enum(CLASSES).optional().describe(CLASS_HELP),
      parent_id: z.number().int().positive().optional().describe("The project card this belongs to"),
      ticket: TICKET,
      ticket_role: TICKET_ROLE,
      pull_request: PULL_REQUEST,
      still_owed: STILL_OWED,
      alert_key: ALERT_KEY,
      alert_check: ALERT_CHECK,
      force: z.boolean().optional().describe("Add even if a similar open card exists or you are at the in-progress cap"),
      actor: ACTOR,
    },
    // Agents never flag owner decisions here: the owner is asked in chat and the
    // answer is recorded on the card afterwards (owner rule, 2026-10-17).
    async ({ actor, ...input }) => guarded(async (k) => withWarning(await decorateItem(k.add({ ...input, needs_owner: false }, { actor: actorFor(actor) }), ticketStatus), actor), { write: true }),
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
      area: z.string().optional().describe(AREA_HELP + ". Empty string clears."),
      class: z.enum(CLASSES).optional(),
      parent_id: z.number().int().min(0).optional().describe("Project card id; 0 clears"),
      ticket: z.union([z.number().int().positive(), z.array(z.number().int().positive()).max(20)]).optional().describe("Link the card to this support ticket (or tickets); an empty array unlinks"),
      ticket_role: TICKET_ROLE,
      pull_request: z.union([z.string().max(300), z.array(z.string().max(300)).max(20)]).optional().describe("Link the card to the pull request it is the work of; empty string or [] unlinks"),
      still_owed: STILL_OWED,
      alert_key: z.string().max(160).optional().describe("Link the card to a monitor's alert condition; empty string unlinks"),
      alert_check: ALERT_CHECK,
      force: z.boolean().optional().describe("Move into now even at the in-progress cap"),
      actor: ACTOR,
    },
    async ({ id, actor, ...patch }) => guarded(async (k) => withWarning(await decorateItem(k.update(id, patch.needs_owner === true ? { ...patch, needs_owner: undefined } : patch, { actor: actorFor(actor) }), ticketStatus), actor), { write: true }),
  );

  server.tool(
    "work_report",
    `Report work on a kanban item. started -> now, assigned to you (cap ${WIP_CAP} per actor). progress -> a plain sentence people read (no JSON). blocked -> blocked. decision_requested -> progress note only (ask the owner in chat). completed -> done, needs evidence_url or no_evidence_reason. When you open the PR, send pull_request (and still_owed if a release or migration follows the merge) so the card closes when it merges. Cards with no update for ${RELEASE_DAYS} days are released back to next automatically. idempotency_key makes retries safe.`,
    {
      id: z.number().int().positive(),
      event: z.enum(REPORT_EVENTS),
      summary: z.string().min(1).max(4000),
      evidence_url: z.string().url().optional(),
      no_evidence_reason: z.string().max(300).optional().describe("Required on completed when there is no evidence_url: why there is no link"),
      force: z.boolean().optional().describe("started even at the in-progress cap"),
      ticket: TICKET,
      ticket_role: TICKET_ROLE,
      pull_request: PULL_REQUEST,
      still_owed: STILL_OWED,
      actor: ACTOR,
      idempotency_key: z.string().max(200).optional(),
    },
    async ({ actor, ...input }) => guarded((k) => withWarning(k.report(input.event === "decision_requested"
      ? { ...input, event: "progress", summary: `Decision pending with the owner in chat: ${input.summary}`.slice(0, 4000), actor: actorFor(actor) }
      : { ...input, actor: actorFor(actor) }), actor), { write: true }),
  );

  server.tool(
    "kanban_reconcile",
    "Make cards agree with what they were raised from, now (the ops web app also runs this every 10 minutes). Ticket: a ticket's own card closes when the ticket closes; a follow-up stays open, relabelled. Pull request: merged closes the card unless work is still owed after the merge (then it is relabelled with what is owed); closed without merging sends it back to the inbox, unassigned. Alert: the condition cleared closes the card. A Now card with no progress for 24 hours goes back to Next, unassigned. A source that cannot be read is left alone. dry_run (default true here) lists what would change without changing anything.",
    {
      dry_run: z.boolean().optional().default(true),
      limit: z.number().int().min(1).max(500).optional().describe("At most this many cards changed (default 50)"),
    },
    async ({ dry_run, limit }) => guarded((k) => runReconcile({ store: k, reader: ticketStatus, prReader, alertReader, dryRun: dry_run !== false, limit }), { write: dry_run === false }),
  );

  server.tool(
    "kanban_counter_promote",
    "Turn one automatic counter (see mcp_capability_requests, counters section) into a real card, linked back to it: for example the raw:corporateSectors counter into \"Build a read tool for company sectors\". The counter keeps counting. While that card is open, promoting again returns it instead of filing a second.",
    {
      signature: z.string().min(3).max(300).describe("The counter's signature, e.g. raw:corporateSectors"),
      title: z.string().max(300).optional().describe("The card's title; defaults to the counter's"),
      detail: z.string().max(10000).optional().describe("What to build; the counter's figures and examples are appended"),
      impact: z.enum(["high", "medium", "low"]).optional(),
      lane: z.enum(["inbox", "backlog", "next"]).optional().default("inbox"),
      product: z.string().optional().describe(`${PRODUCT_HELP} Defaults to the counter's product.`),
      actor: ACTOR,
    },
    async ({ actor, ...input }) => guarded(async (k) => withWarning(k.counters.promote({ ...input, actor: actorFor(actor) }), actor), { write: true }),
  );

  server.tool(
    "kanban_alert_clear",
    "Monitors: say an alert condition is over. Every open card filed for that alert_key completes with a note. The same key reported again within 72 hours reopens the card.",
    {
      alert_key: z.string().min(3).max(160),
      summary: z.string().max(400).optional().describe("What cleared it, e.g. 'the next run succeeded'"),
      actor: ACTOR,
    },
    async ({ actor, ...input }) => guarded((k) => k.clearAlert({ ...input, actor: actorFor(actor) }), { write: true }),
  );

  server.tool(
    "kanban_github_sync",
    "Pull GitHub issues into the kanban now (the timer also runs every 15 minutes, followed by board hygiene): new open issues land in backlog with an excerpt of the issue body, closed linked issues move to done.",
    { repo: z.string().optional().describe("owner/name; omit for every source repo") },
    async ({ repo }) => guarded(async (k) => ({ synced: await k.syncGithub({ repo: repo || null }) }), { write: true }),
  );
}

module.exports = { registerKanbanTools };
