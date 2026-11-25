"use strict";
// The slim Keir tool set. Reads are broad; writes are few and bound to this
// ticket. Every outside effect goes through an adapter, so replay mode can
// capture effects instead of performing them.

const S = require("./state");
const rules = require("./rules");
const ownercopy = require("./ownercopy");

// Read-only data servers: game state, engine and turn health, lore, production errors.
const GAME_SERVERS = ["gamestate", "engine", "turndiag", "lore", "sentry"];
const WRITE_LIKE = /(?:^|_)(?:patch|apply|write|set|update|delete|send|create|run|heal|post|resolve|merge|promote|reset|grant|pay)(?:_|$)/i;
const KANBAN_READS = ["kanban_brief", "kanban_list", "kanban_get"];
const CODE_READS = ["code_search", "code_exact", "code_read"];
const KNOWLEDGE_READS = ["knowledge_query", "knowledge_get", "knowledge_related"];

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const strList = (description, maxItems = 20) => ({ type: "array", items: { type: "string" }, maxItems, description });

function tool(name, description, input_schema, handler) {
  return { name, description, input_schema, handler };
}

/** Text that will be public (a pull request on a public repository). */
function checkPublicText(text, names = []) {
  const problems = [];
  for (const key of ["discordId", "email", "ip", "host", "path"]) {
    const m = rules.RX[key].exec(String(text));
    if (m && !(key === "path" && !/\/(?:root|opt|var|etc|srv|home)\//.test(m[0]))) problems.push(`${key}: ${m[0].trim()}`);
  }
  for (const n of names.filter((x) => x && x.length > 2)) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(text))) problems.push(`player name: ${n}`);
  return problems;
}

function buildTools(ctx) {
  const st = () => ctx.store.load(ctx.ticket);
  const save = (s) => ctx.store.save(s);
  const capture = (kind, payload) => ctx.effects.push({ at: new Date(ctx.now()).toISOString(), kind, ...payload });
  const ruleCtx = (kind) => ({ kind, state: st(), names: ctx.playerNames(), ownerNames: ctx.cfg.ownerNames, ownerPrivateNames: ctx.cfg.ownerPrivateNames, killed: ctx.killSwitch.state().engaged });
  const refuse = (problems) => ({ posted: false, problems, note: "Nothing was posted. Fix every problem listed and post again, or finish without posting." });
  const writesStopped = () => {
    const s = st();
    if (ctx.killSwitch.state().engaged) return "Everything is stopped by the kill switch. Do not change anything; finish and wait.";
    if (s.paused) return `This ticket is paused by ${s.paused.by}. Do not change anything; finish and wait.`;
    return null;
  };

  return [
    // ---------------------------------------------------------------- reads
    tool("ticket_read", "Read this ticket: what the player reported, the conversation so far, screenshots and its status.", obj({}), async () => ctx.adapters.readTicket(ctx.ticket)),
    tool("history_search", "Search every past support ticket by words and meaning, including closed tickets. Returns ticket numbers, titles, dates and a matching snippet.",
      obj({ query: str("what to look for, in plain words"), mode: str("both, words or meaning", { enum: ["both", "words", "meaning"] }), limit: { type: "integer", minimum: 1, maximum: 20 }, since: str("ISO date"), until: str("ISO date") }, ["query"]),
      async (a) => ctx.adapters.historySearch({ ...a, exclude: ctx.ticket })),
    tool("history_read", "Read one past ticket in full, in time order: what the player wrote, staff messages, support posts, findings, fixes and the resolution.",
      obj({ number: { type: "integer" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 300 }, kinds: strList("only these event kinds") }, ["number"]),
      async (a) => ctx.adapters.historyRead(a)),
    tool("game_tools", `List the read-only game data and production error tools on a server (${GAME_SERVERS.join(", ")}) with their arguments.`,
      obj({ server: str("server", { enum: GAME_SERVERS }) }, ["server"]),
      async ({ server }) => (await ctx.adapters.mcpList(server)).filter((t) => !WRITE_LIKE.test(t.name)).map((t) => ({ name: t.name, description: String(t.description || "").slice(0, 400), args: t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [] }))),
    tool("game_read", "Call one read-only game data or production error tool (sentry: errors players hit, by time or reference). Use game_tools first to see names and arguments.",
      obj({ server: str("server", { enum: GAME_SERVERS }), tool: str("tool name"), args: { type: "object", description: "the tool's arguments" } }, ["server", "tool"]),
      async ({ server, tool: name, args }) => {
        if (WRITE_LIKE.test(name)) throw new Error(`${name} is not a read`);
        return ctx.adapters.mcpCall(server, name, args || {});
      }),
    tool("code_search", "Search the game's code, engineering docs and player wiki by meaning. Returns matching chunks with paths.",
      obj({ question: str("what you want to know"), source: str("dev (development) or prod (live)", { enum: ["dev", "prod"] }), topK: { type: "integer", minimum: 1, maximum: 12 } }, ["question"]),
      async (a) => ctx.adapters.mcpCall("ops-knowledge", "code_search", { maxChars: 12000, topK: 6, source: "prod", ...a })),
    tool("code_exact", "Find an exact symbol or path in the game's code.",
      obj({ question: str("symbol or repository path"), source: str("dev or prod", { enum: ["dev", "prod"] }), limit: { type: "integer", minimum: 1, maximum: 10 } }, ["question"]),
      async (a) => ctx.adapters.mcpCall("ops-knowledge", "code_exact", { maxChars: 12000, limit: 4, source: "prod", ...a })),
    tool("code_read", "Read a file (or part) from the indexed game code.",
      obj({ path: str("repository path"), source: str("dev or prod", { enum: ["dev", "prod"] }), startLine: { type: "integer" }, endLine: { type: "integer" } }, ["path"]),
      async (a) => ctx.adapters.mcpCall("ops-knowledge", "code_read", { source: "prod", ...a })),
    tool("kanban_read", "Read the work board: brief, a list, or one card.",
      obj({ tool: str("which read", { enum: KANBAN_READS }), args: { type: "object" } }, ["tool"]),
      async ({ tool: name, args }) => ctx.adapters.mcpCall("ops-knowledge", name, args || {})),
    tool("knowledge_read", "Read operations notes and runbooks.",
      obj({ tool: str("which read", { enum: KNOWLEDGE_READS }), args: { type: "object" } }, ["tool", "args"]),
      async ({ tool: name, args }) => ctx.adapters.mcpCall("ops-knowledge", name, args)),
    tool("github_read", "Read GitHub (GET only): pull requests, issues, checks, commits. Path relative to the API, for example repos/OWNER/REPO/pulls/123.",
      obj({ path: str("API path starting with repos/", { pattern: "^repos/[A-Za-z0-9._/?=&,-]+$" }) }, ["path"]),
      async ({ path }) => ctx.adapters.githubGet(path)),
    tool("ticket_state", "Read this ticket's state record (what is established, ruled out, promised, next, approvals, receipts).", obj({}), async () => ({ text: S.render(st()), state: st() })),

    // ---------------------------------------------------------------- writes
    tool("update_state", "Keep the ticket state current. Established facts need their source read. Promises you made to the player go here. next is your next step and what it waits on.",
      obj({
        established: { type: "array", maxItems: 12, items: obj({ fact: str("the fact"), source: str("the read that shows it") }, ["fact", "source"]) },
        ruled_out: { type: "array", maxItems: 12, items: obj({ idea: str("the idea"), why: str("why it is ruled out") }, ["idea", "why"]) },
        promises: { type: "array", maxItems: 6, items: obj({ id: str("existing promise id to update"), text: str("what was promised"), due: str("when"), status: str("open, kept or dropped", { enum: ["open", "kept", "dropped"] }) }) },
        next: obj({ step: str("next step"), waits_on: str("what it waits on") }, ["step"]),
      }),
      async (a) => { const blocked = writesStopped(); if (blocked) throw new Error(blocked); save(S.applyUpdate(st(), a, ctx.now())); return { ok: true, state: S.render(st()) }; }),
    tool("record_receipt", "Record proof behind an outcome claim. fix_live: the fix is live in the game AND you read this player's own data after it (say which read and what it showed). paid: a payment record exists (the ledger entry).",
      obj({ kind: str("fix_live or paid", { enum: ["fix_live", "paid"] }), what: str("what was fixed or paid"), pr: str("pull request url, for a fix"), verified_read: str("the read of the player's own data after the fix, and what it showed"), amount: str("amount with currency, for a payment"), ledger_ref: str("the ledger entry, for a payment") }, ["kind", "what"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        if (a.kind === "fix_live" && !String(a.verified_read || "").trim()) throw new Error("A fix receipt needs verified_read: the read of this player's own data after the fix was live.");
        if (a.kind === "paid" && !(a.amount && a.ledger_ref)) throw new Error("A payment receipt needs amount and ledger_ref from the payment record.");
        save(S.addReceipt(st(), a.kind === "paid" ? "paid" : "fixLive", a.kind === "paid" ? { what: a.what, amount: a.amount, ledgerRef: a.ledger_ref } : { what: a.what, pr: a.pr || null, verifiedRead: a.verified_read }, ctx.now()));
        return { ok: true };
      }),
    tool("post_reply", "Post a message to the player in this ticket's channel. Check the draft against the style guide first. basis: where each fact in the post comes from. If refused, every problem is listed; fix them all and post again.",
      obj({ text: str("the message, as the player will read it"), kind: str("answer, update or question", { enum: ["answer", "update", "question"] }), basis: str("self-review: the reads behind each fact, or 'no facts'") }, ["text", "kind", "basis"]),
      async ({ text, kind, basis }) => {
        if (String(basis || "").trim().length < 4) throw new Error("basis is your self-review: list the reads behind each fact in the post, or say 'no facts'.");
        const shaped = rules.shape(text);
        const check = rules.checkPost(shaped, ruleCtx(kind));
        if (!check.ok) { ctx.ruleHits.push(...check.problems.map((p) => ({ ...p, tool: "post_reply", at: new Date(ctx.now()).toISOString() }))); return refuse(check.problems); }
        const delivered = await ctx.adapters.post({ ticket: ctx.ticket, text: shaped, kind });
        save(S.recordPost(st(), { text: shaped, kind, delivered: delivered?.delivered !== false }, ctx.now()));
        capture("post", { text: shaped, postKind: kind, basis: String(basis).slice(0, 1000), delivery: delivered });
        return { posted: true, delivery: delivered };
      }),
    tool("resolve_ticket", "Close the ticket with a receipt the player reads: what happened, what was done, anything they should do. Only when the reported problem is dealt with.",
      obj({ message: str("plain summary for the player"), actions: strList("what was done, in player words", 8), follow_up: str("what they should do next, if anything"), basis: str("the reads and receipts behind it") }, ["message", "basis"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const text = rules.shape([a.message, ...(a.actions || []), a.follow_up || ""].join("\n"));
        const check = rules.checkPost(text, ruleCtx("resolution"));
        if (!check.ok) { ctx.ruleHits.push(...check.problems.map((p) => ({ ...p, tool: "resolve_ticket", at: new Date(ctx.now()).toISOString() }))); return refuse(check.problems); }
        const result = await ctx.adapters.resolve({ ticket: ctx.ticket, message: rules.shape(a.message), actions: (a.actions || []).map(rules.shape), followUp: a.follow_up ? rules.shape(a.follow_up) : undefined });
        const s = S.recordPost(st(), { text, kind: "resolution", delivered: result?.delivered !== false }, ctx.now());
        s.closed = true; save(s);
        capture("resolve", { message: a.message, actions: a.actions || [], followUp: a.follow_up || null, basis: a.basis });
        return { resolved: true, result };
      }),
    tool("request_decision", "Ask the owner one plain multiple choice question. Before asking, check this ticket's history and state for an owner or staff decision on the same question: if they already decided, use it and do not ask. The owner is not technical: the question first, plain words, no ids or code terms. Two to four options, your recommendation first, each a short label and a one-line description. The ticket waits on the answer.",
      obj({
        question: str("the question, plain words, at most 200 characters"),
        options: { type: "array", minItems: 2, maxItems: 4, description: "recommended first", items: obj({ label: str("short label, at most 60 characters"), detail: str("one line: what this choice means for players, at most 160 characters") }, ["label", "detail"]) },
        why: str("at most three short sentences: what happened and why you recommend the first option"),
        change_class: str("bugfix, display, rule, balance, economy, data", { enum: ["bugfix", "display", "rule", "balance", "economy", "data"] }),
        owner_messages_checked: str("after a first refusal listed owner and staff messages: why none of them already answers this question"),
      }, ["question", "options", "why"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const options = (a.options || []).map((o) => (typeof o === "string" ? { label: o, detail: "" } : o));
        if (options.length < 2) throw new Error("Give two to four options, your recommendation first.");
        // Already answered on this ticket? Then it is decided.
        const answered = st().approvals.find((x) => x.kind === "decision" && x.status !== "pending" && ownercopy.similarity(x.summary, a.question) >= 0.5);
        if (answered) return { requested: false, alreadyDecided: { question: answered.summary, answer: answered.answer }, note: "The owner already answered this. Use that answer; do not ask again." };
        const pending = st().approvals.find((x) => x.kind === "decision" && x.status === "pending" && ownercopy.similarity(x.summary, a.question) >= 0.5);
        if (pending) return { requested: false, pending: { id: pending.id, question: pending.summary }, note: "This question is already with the owner. Wait for the answer." };
        // Owner or staff may have decided it in the channel already.
        if (!String(a.owner_messages_checked || "").trim()) {
          let said = [];
          try {
            const h = await ctx.adapters.historyRead({ number: ctx.ticket, limit: 300, kinds: ["staff_message"] });
            said = (h?.events || []).map((e) => ({ at: e.at, who: e.who, text: String(e.text || "").slice(0, 600) })).slice(-12);
          } catch { /* history unreadable: the state check above still applied */ }
          if (said.length) return { requested: false, ownerAndStaffMessages: said, note: "Before asking the owner: these owner and staff messages are on this ticket. If one already answers your question, treat it as decided (record it with update_state as established, with the message as its source) and do not ask. If none does, call request_decision again with owner_messages_checked saying why none answers it." };
        }
        const problems = ownercopy.checkOwnerCopy({ question: a.question, why: a.why, options });
        if (problems.length) return { requested: false, problems, note: "The owner reads this card. Fix the copy and ask again." };
        return approval("decision", { summary: a.question, question: a.question, options, why: a.why, changeClass: a.change_class || null });
      }),
    tool("request_promote", "Ask the owner to put a merged fix live. Only the owner's approval starts it. The owner is not technical: plain words, no ids or code terms in what, why and risk.",
      obj({ pr: str("the merged pull request url (shown only as a link button)"), what: str("what changes for players, one short sentence"), why: str("at most three short sentences"), risk: str("what could go wrong and who it touches, one sentence"), evidence: str("tests and checks that passed (kept in the record, not shown)") }, ["pr", "what", "why", "risk", "evidence"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const problems = ownercopy.checkOwnerCopy({ what: a.what, why: a.why, risk: a.risk });
        if (problems.length) return { requested: false, problems, note: "The owner reads this card: plain words, no ids or code terms. Fix the copy and ask again." };
        return approval("promote", { summary: `Put live: ${a.what}`, ...a });
      }),
    tool("request_compensation", "Ask the owner to approve a payment to the player. Payment runs only through the owner. The owner is not technical: plain words, no ids or code terms.",
      obj({ amount: str("amount with currency"), recipient: str("character or company to pay"), basis: str("how the amount was worked out, one or two sentences"), evidence: str("what happened to the player, at most three short sentences") }, ["amount", "recipient", "basis", "evidence"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const problems = ownercopy.checkOwnerCopy({ why: a.evidence, what: a.basis });
        if (problems.length) return { requested: false, problems, note: "The owner reads this card: plain words, no ids or code terms. Fix the copy and ask again." };
        return approval("compensation", { summary: `Pay ${a.amount} to ${a.recipient}`, why: a.evidence, ...a });
      }),
    tool("open_pr", "Open a pull request to development from this ticket's checkout, with the fix you built and tested there. The text is public: no player names, ids or internal details.",
      obj({ title: str("conventional commit style title"), body: str("what changes and why, and the tests run"), tests: str("the focused tests you ran and their result") }, ["title", "body", "tests"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const problems = checkPublicText(`${a.title}\n${a.body}`, ctx.playerNames());
        if (problems.length) return { opened: false, problems, note: "The pull request text is public. Remove these and try again." };
        const result = await ctx.adapters.openPr({ ticket: ctx.ticket, ...a });
        if (result?.url) save(S.applyUpdate(st(), { prs: [{ url: result.url, state: "open", what: a.title }] }, ctx.now()));
        capture("open_pr", { title: a.title, body: a.body, tests: a.tests, result });
        return result;
      }),
    tool("merge_to_development", "Merge this ticket's pull request into development once its required checks are green. Refused otherwise.",
      obj({ pr: str("the pull request url") }, ["pr"]),
      async ({ pr }) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        if (!st().prs.some((p) => p.url === pr)) throw new Error("Only this ticket's own pull requests can be merged.");
        const result = await ctx.adapters.mergeToDevelopment({ ticket: ctx.ticket, pr });
        if (result?.merged) save(S.applyUpdate(st(), { prs: [{ url: pr, state: "merged" }] }, ctx.now()));
        capture("merge_to_development", { pr, result });
        return result;
      }),
    tool("set_reminder", "Ask to be woken again: after the next game turn, or after some minutes. One reminder at a time; a new one replaces the old.",
      obj({ after: str("next_turn or minutes", { enum: ["next_turn", "minutes"] }), minutes: { type: "integer", minimum: 5, maximum: 1440 }, reason: str("why") }, ["after", "reason"]),
      async (a) => {
        const s = st();
        s.reminder = { after: a.after === "minutes" ? `${a.minutes || 30} minutes` : "next turn", minutes: a.after === "minutes" ? a.minutes || 30 : null, reason: String(a.reason).slice(0, 300), setAt: new Date(ctx.now()).toISOString() };
        save(s);
        capture("reminder", s.reminder);
        return { ok: true };
      }),
    tool("record_owner_answer", "Record the owner's answer to one of your pending approval requests, when the owner gave it in this ticket's channel during this wake. Use their words; never infer an answer they did not give.",
      obj({ approval_id: str("the pending approval id"), status: str("approved, declined or answered", { enum: ["approved", "declined", "answered"] }), answer: str("the owner's answer in their words") }, ["approval_id", "status", "answer"]),
      async (a) => {
        if (!ctx.ownerSpoke) throw new Error("Only when the owner wrote in this ticket during this wake. Otherwise the answer comes from their reply to the approval card.");
        const { state, approval: ap } = S.answerApproval(st(), a.approval_id, { status: a.status, text: a.answer }, ctx.now());
        if (!ap) throw new Error(`no approval ${a.approval_id} on this ticket`);
        save(state);
        capture("owner_answer", { id: ap.id, status: ap.status, answer: ap.answer });
        return { ok: true, approval: { id: ap.id, status: ap.status, answer: ap.answer } };
      }),
    tool("finish", "End this wake. Name the next step and what it waits on. Call it exactly once, last.",
      obj({ next_step: str("your next step"), waits_on: str("what it waits on: the player, the owner, a turn, a check") }, ["next_step", "waits_on"]),
      async (a) => {
        if (!writesStopped()) save(S.applyUpdate(st(), { next: { step: a.next_step, waits_on: a.waits_on } }, ctx.now()));
        ctx.finished = { state: "waiting", summary: `${a.next_step} (waits on ${a.waits_on})` };
        return { state: "waiting", note: "Finished. Issue no more tools." };
      }),
  ];

  async function approval(kind, payload) {
    const { state, approval: a } = S.addApproval(st(), kind, payload, ctx.now());
    save(state);
    const sent = await ctx.adapters.approval({ ticket: ctx.ticket, kind, id: a.id, payload });
    capture(`request_${kind}`, { id: a.id, payload, sent });
    return { requested: true, id: a.id, note: "The ticket now waits on the owner. Tell the player only that it is with the team." };
  }
}

module.exports = { buildTools, checkPublicText, GAME_SERVERS, WRITE_LIKE };
