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
  const capture = (kind, payload) => {
    const entry = { at: new Date(ctx.now()).toISOString(), kind, ...payload };
    ctx.effects.push(entry);
    try { ctx.onEffect?.(entry); } catch { /* observers never break a tool */ }
  };
  const ruleCtx = (kind) => ({ kind, now: ctx.now(), category: st().category || null, state: st(), names: ctx.playerNames(), ownerNames: ctx.cfg.ownerNames, ownerPrivateNames: ctx.cfg.ownerPrivateNames, killed: ctx.killSwitch.state().engaged });
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
        if (!check.ok) {
          ctx.ruleHits.push(...check.problems.map((p) => ({ ...p, tool: "post_reply", at: new Date(ctx.now()).toISOString() })));
          // Held only by the 30 minute limit: wake again the moment it clears, so the answer is not lost.
          if (check.problems.every((p) => /posts in the last 30 minutes/.test(p.match))) {
            const s = st();
            const window = s.posts.filter((p) => p.delivered !== false && p.kind !== "resolution" && ctx.now() - Date.parse(p.at) < 30 * 60000).map((p) => Date.parse(p.at)).sort((x, y) => x - y);
            const minutes = Math.max(5, Math.ceil(((window[0] || ctx.now()) + 30 * 60000 - ctx.now()) / 60000) + 1);
            s.reminder = { after: `${minutes} minutes`, minutes, reason: "Post the answer the 30 minute limit held back", setAt: new Date(ctx.now()).toISOString() };
            save(s);
            return { ...refuse(check.problems), heldUntil: `${minutes} minutes`, note: `Held by the 30 minute limit. You will be woken in ${minutes} minutes to post it; record the answer in ticket state now and finish.` };
          }
          return refuse(check.problems);
        }
        const delivered = await ctx.adapters.post({ ticket: ctx.ticket, text: shaped, kind });
        save(S.recordPost(st(), { text: shaped, kind, delivered: delivered?.delivered !== false }, ctx.now()));
        capture("post", { text: shaped, postKind: kind, basis: String(basis).slice(0, 1000), delivery: delivered });
        return { posted: true, delivery: delivered };
      }),
    tool("resolve_ticket", "Close the ticket with a receipt the player reads. Only when the problem is dealt with AND the player is done: they confirmed it (quote them in player_confirmed), they asked to close (quote them in player_asked_to_close), or 24 hours passed after your last post with no word from them. After posting that a fix is live, set a 24 hour reminder and wait.",
      obj({ message: str("plain summary for the player"), actions: strList("what was done, in player words", 8), follow_up: str("what they should do next, if anything"), basis: str("the reads and receipts behind it"),
        player_confirmed: str("the player's own words, written after your last post, confirming it is sorted"),
        player_asked_to_close: str("the player's own words asking to close the ticket") }, ["message", "basis"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const quiet = await resolveAllowed(a);
        if (!quiet.ok) return { resolved: false, note: quiet.why };
        // A ticket already resolved is never resolved (and its receipt never sent) again from here.
        let current = null;
        try { current = await ctx.adapters.readTicket(ctx.ticket); } catch { /* unreadable: the support service still guards */ }
        if (current && ["resolved", "closed"].includes(String(current.status || "").toLowerCase())) return { resolved: false, note: "This ticket is already resolved. Nothing was sent." };
        const text = rules.shape([a.message, ...(a.actions || []), a.follow_up || ""].join("\n"));
        const check = rules.checkPost(text, ruleCtx("resolution"));
        if (!check.ok) { ctx.ruleHits.push(...check.problems.map((p) => ({ ...p, tool: "resolve_ticket", at: new Date(ctx.now()).toISOString() }))); return refuse(check.problems); }
        const result = await ctx.adapters.resolve({ ticket: ctx.ticket, message: rules.shape(a.message), actions: (a.actions || []).map(rules.shape), followUp: a.follow_up ? rules.shape(a.follow_up) : undefined });
        const s = S.recordPost(st(), { text, kind: "resolution", delivered: result?.delivered !== false }, ctx.now());
        s.closed = true; save(s);
        capture("resolve", { message: a.message, actions: a.actions || [], followUp: a.follow_up || null, basis: a.basis });
        return { resolved: true, result };
      }),
    tool("mod_summary", "Moderation tickets only: post a short neutral summary for the moderators in their channel: what was reported, what you checked (for example alt_ring_audit), and what it showed. Name characters, never accuse; no IP addresses, emails or account ids. You never ban or act on an account; moderators decide.",
      obj({ text: str("the summary, a few plain sentences") }, ["text"]),
      async ({ text }) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const s = st();
        if (s.category !== "moderation") throw new Error("mod_summary is only for moderation tickets.");
        const sent = (s.modSummaries || []).length;
        if (sent >= 2) return { posted: false, note: "Two summaries already went to the moderators for this ticket. Record anything new in ticket state." };
        const problems = [];
        for (const key of ["discordId", "email", "ip", "path", "host"]) { const m = rules.RX[key].exec(text); if (m) problems.push(`"${m[0].trim()}" must not go in a moderator summary.`); }
        const accuse = rules.accusation(text);
        if (accuse) problems.push(`"${accuse}" accuses someone. Say what was checked and what it showed; moderators decide.`);
        if (problems.length) return { posted: false, problems, note: "Fix these and post again." };
        const r = await ctx.adapters.modPost({ ticket: ctx.ticket, text: rules.shape(text) });
        s.modSummaries = [...(s.modSummaries || []), { at: new Date(ctx.now()).toISOString(), text: text.slice(0, 600) }];
        save(s);
        capture("mod_summary", { text });
        return r;
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
    tool("promotion_status", "Where a merged game fix is on its way to players: in development, staging or main, the open promote pull requests, and whether the auto-promoter is held. Use it to track a fix to live.",
      obj({ pr: str("the fix's pull request url or number") }, ["pr"]),
      async ({ pr }) => watchLive(await ctx.adapters.promotionStatus({ pr }))),
    tool("deploy_status", "Is a merged game fix live for players? Compares the fix with what is deployed on the game's web and worker. If it is not live yet, you are woken the moment it is.",
      obj({ pr: str("the fix's pull request url or number") }, ["pr"]),
      async ({ pr }) => watchLive(await ctx.adapters.deployStatus({ pr }))),
    tool("party_roles", "A character's party roles, for party influence or leadership questions: national party (chair, vice chair, treasurer, committee, campaigner), state party (chair, vice chair, treasurer, campaigner) and caucus (chair, vice chair). By name or character id.",
      obj({ character: str("character name or id") }, ["character"]),
      async (a) => ctx.adapters.partyRoles(a)),
    tool("site_read", "Open a public page of the game (ahousedividedgame.com) as a logged-out visitor sees it, and read its text. Use it to check a fix on the real page. Your shell has no network; use this instead of curl.",
      obj({ path: str("page path, for example /corporation/126"), device: str("desktop, iphone or android", { enum: ["desktop", "iphone", "android"] }) }, ["path"]),
      async (a) => ctx.adapters.siteRead(a)),
    tool("request_promote", "Ask the owner to release a held promotion. Normally the auto-promoter ships a merged fix to players by itself once checks are green: then do not ask, track it with promotion_status. Ask only when the promotion is held (auto-promote off, a held promote pull request) or for a hotfix that must skip the queue (give hotfix_reason). Plain words, no ids or code terms in what, why and risk.",
      obj({ pr: str("the merged pull request url (shown only as a link button)"), what: str("what changes for players, one short sentence"), why: str("at most three short sentences"), risk: str("what could go wrong and who it touches, one sentence"), evidence: str("tests and checks that passed (kept in the record, not shown)"), hotfix_reason: str("only for a hotfix that must skip the normal queue: why it cannot wait") }, ["pr", "what", "why", "risk", "evidence"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        let status;
        try { status = await ctx.adapters.promotionStatus({ pr: a.pr }); }
        catch (e) { return { requested: false, note: `Could not check the promotion (${e.message}). Do not ask the owner on a guess: set a reminder and check promotion_status again.` }; }
        if (status.inMain) return { requested: false, status, note: "The fix is already on main. Nothing to approve: wait for the deploy, read the player's numbers, then tell them." };
        if (!status.held && !String(a.hotfix_reason || "").trim()) return { requested: false, status, note: "Auto-promote ships this by itself once checks are green. Do not ask the owner. Track it with promotion_status and a reminder, and tell the player when it is live and you have read their numbers." };
        const problems = ownercopy.checkOwnerCopy({ what: a.what, why: a.why, risk: a.risk });
        if (problems.length) return { requested: false, problems, note: "The owner reads this card: plain words, no ids or code terms. Fix the copy and ask again." };
        return approval("promote", { summary: `Put live: ${a.what}`, ...a, holds: status.holds || [] });
      }),
    tool("request_compensation", "Ask the owner to approve a payment to the player. Payment runs only through the owner. The owner is not technical: plain words, no ids or code terms.",
      obj({ amount: str("amount with currency"), recipient: str("character or company to pay"), basis: str("how the amount was worked out, one or two sentences"), evidence: str("what happened to the player, at most three short sentences") }, ["amount", "recipient", "basis", "evidence"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const problems = ownercopy.checkOwnerCopy({ why: a.evidence, what: a.basis });
        if (problems.length) return { requested: false, problems, note: "The owner reads this card: plain words, no ids or code terms. Fix the copy and ask again." };
        return approval("compensation", { summary: `Pay ${a.amount} to ${a.recipient}`, why: a.evidence, ...a });
      }),
    tool("open_pr", "Open a pull request to development from this ticket's checkout, with the fix you built and tested there. It first checks GitHub for an open or merged pull request from the last 48 hours on the same files or this ticket, and stops if one exists. The text is public: no player names, ids or internal details.",
      obj({ title: str("conventional commit style title"), body: str("what changes and why, and the tests run"), tests: str("the focused tests you ran and their result"), related_checked: str("after a first refusal listed related pull requests: why none of them already fixes this") }, ["title", "body", "tests"]),
      async (a) => {
        const blocked = writesStopped(); if (blocked) throw new Error(blocked);
        const problems = checkPublicText(`${a.title}\n${a.body}`, ctx.playerNames());
        if (problems.length) return { opened: false, problems, note: "The pull request text is public. Remove these and try again." };
        // Someone may already have fixed it: an open or merged PR from the last 48 hours on the same files or this ticket.
        let found;
        try { found = await ctx.adapters.duplicatePrs({ ticket: ctx.ticket, files: await ctx.adapters.changedFiles(ctx.ticket), now: ctx.now() }); }
        catch (e) { return { opened: false, note: `Could not check for an existing fix (${e.message}). Do not open a second one on a guess: set a reminder and try again.` }; }
        if (found.strong?.length) return { opened: false, duplicates: found.strong, note: "A fix for this already exists. Do not open another: track that one to players with promotion_status, record it in ticket state, and tell the player only what it changes for them." };
        if (found.related?.length && !String(a.related_checked || "").trim()) return { opened: false, related: found.related, note: "Recent pull requests change some of the same code. Read them. If one already fixes this, do not open another. If not, call open_pr again with related_checked saying why your fix is different." };
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

  // The owner's rule: resolve only once the player is done. They confirmed after the last post, asked to close, or stayed
  // quiet for 24 hours after it. A quote must really be in one of the player's own messages.
  async function resolveAllowed(a) {
    const s = st();
    const lastPost = [...s.posts].reverse().find((p) => p.kind !== "resolution" && p.delivered !== false);
    let said = [];
    try { said = ((await ctx.adapters.historyRead({ number: ctx.ticket, limit: 300, kinds: ["player_message"] }))?.events || []).map((e) => ({ at: Date.parse(e.at), text: String(e.text || "") })); } catch { /* unreadable */ }
    const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
    const quoted = (q, after) => q && norm(q).length >= 2 && said.some((m) => m.at > after && norm(m.text).includes(norm(q)));
    if (a.player_asked_to_close) return quoted(a.player_asked_to_close, -Infinity) ? { ok: true } : { ok: false, why: "That quote is not in any of the player's messages. Resolve only on their real words, a confirmation after your last post, or 24 quiet hours." };
    if (!lastPost) return { ok: false, why: "Post the answer or the fix to the player first, then wait for them." };
    const postedAt = Date.parse(lastPost.at);
    if (a.player_confirmed) return quoted(a.player_confirmed, postedAt) ? { ok: true } : { ok: false, why: "That confirmation is not in a player message written after your last post. Wait for the player or for 24 quiet hours." };
    const lastPlayer = Math.max(Date.parse(s.lastPlayerAt || 0) || 0, ...said.map((m) => m.at));
    if (lastPlayer > postedAt) return { ok: false, why: "The player wrote after your last post. Answer them first; resolve when they confirm or after 24 quiet hours." };
    const hours = (ctx.now() - postedAt) / 3600000;
    if (hours < 24) return { ok: false, why: `Only ${hours.toFixed(1)} hours since your last post. Set a reminder (set_reminder, 1440 minutes) and resolve after 24 quiet hours or when the player confirms.` };
    return { ok: true };
  }

  // A merged fix that is not live yet is watched: the service wakes this ticket the moment it is.
  function watchLive(status) {
    if (!status?.merged || status.live || !status.mergeSha) return status;
    const s = st();
    s.liveWatch = (s.liveWatch || []).filter((w) => w.pr !== status.pr);
    s.liveWatch.push({ pr: status.pr, mergeSha: status.mergeSha, since: new Date(ctx.now()).toISOString() });
    save(s);
    return { ...status, watching: true, note: `${status.note || ""} You will be woken the moment it is live; finish now and wait for that.`.trim() };
  }

  async function approval(kind, payload) {
    const { state, approval: a } = S.addApproval(st(), kind, payload, ctx.now());
    save(state);
    const sent = await ctx.adapters.approval({ ticket: ctx.ticket, kind, id: a.id, payload });
    capture(`request_${kind}`, { id: a.id, payload, sent });
    return { requested: true, id: a.id, note: "The ticket now waits on the owner. Tell the player only that it is with the team." };
  }
}

module.exports = { buildTools, checkPublicText, GAME_SERVERS, WRITE_LIKE };
