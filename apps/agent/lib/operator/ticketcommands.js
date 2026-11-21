"use strict";
// Keir 11.4 (owner, 2026-11-21): the owner and staff direct ticket work across tickets.
//
// The owner asked from the app: "the tickets relating to compressed data are all related, can you merge them and add
// parties to a consolidated incident ticket?" and was told "My ticket access is read-only". Every ticket-changing tool was
// scoped to the task's own ticket, and an owner conversation has none. The coordinator then did it by hand in three calls.
//
// ticket_command acts on tickets by number for an owner or staff request: open an incident, merge named tickets into an
// incident or another ticket (each reporter is added to the target and told where their report went, by support_merge),
// resolve or reopen a ticket, add a person. Authority is checked in code from who really wrote the request: the
// authenticated owner app message, or a Discord message re-read from Discord whose author is the owner or a configured
// staff member. Ticket tasks, findings, players and anything a player's message could steer are refused.
//
// Bulk and destructive steps keep a guard: more than BULK tickets, or closing a ticket whose player is still waiting for
// an answer, is confirmed with the owner once (one choice through the decision path) unless the request named every
// ticket by number. Every step runs through the effect journal, so a retry never merges or closes twice, and is audited.
// The ticket tasks of the affected tickets are told what happened so they stop (merged, closed) or wake (reopened).
const crypto = require("node:crypto");
const { JOB_TERMINAL } = require("./machines");
const { isAppJob } = require("./appchannel");
const controlsLib = require("./controls");

const BULK = 3;
const OPS = ["open_incident", "merge", "resolve", "reopen", "add_person"];
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const SNOWFLAKE = /^\d{15,22}$/;

// Ticket numbers a request text names: "#1872", "1872, 1873 and 1874", "tickets 1872-1874" counts the two ends.
function namedNumbers(texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t || "").matchAll(/(?:^|[^\w.])#?(\d{3,6})(?![\w.])/g)) out.add(Number(m[1]));
  return out;
}

function createTicketCommands({ ledger, config, mcp, discord, effect, now = () => Date.now(), ticketOf = (j) => j.ticket, openDecision = require("./decisions").openDecision, ctl = () => config.controls || controlsLib.DEFAULT_CONTROLS, publicText = (s) => String(s || "") }) {
  const d = ledger.data;
  const staff = () => [config.ownerId, ...(config.staffIds || [])].filter(Boolean);

  // Why this task may not command tickets, or null. Pure: no network.
  function refusal(job) {
    if (!job) return "no task";
    // The owner's private app chat (the supervisor in the ops web app) reaches this through /api/keir/app/ticket-commands.
    // Its request object lives in d.ownerAppCommands, never in d.jobs, so no model activation can carry it.
    if (job.ownerAppCommand) return d.ownerAppCommands?.[job.ownerAppCommand.id] === job && job.actorId === config.ownerId && job.role === "owner" && job.kind === "command" ? null : "This request did not come from the owner's authenticated app session.";
    if (job.kind === "finding") return "Monitoring findings never change tickets.";
    if (job.role === "player" || job.role === "moderator") return "Only the owner or staff can direct ticket changes; a player cannot merge, close or reopen tickets, including their own or someone else's.";
    if (job.codingParent || job.prMention || job.internalProbe || job.investigation) return "Workers and internal checks never change tickets.";
    if (!["command", "conversation"].includes(job.kind)) return "A ticket task works its own ticket (merge_into_incident, merge_related, support_action). Cross-ticket changes come from an owner or staff request.";
    if (!staff().includes(job.actorId)) return "This request did not come from the owner or a configured staff member.";
    const expected = job.actorId === config.ownerId ? "owner" : "support";
    if (job.role !== expected) return "The request's authority does not match its author.";
    if (isAppJob(job)) {
      if (job.actorId !== config.ownerId) return "App requests are the owner's only.";
      const o = require("./ownermuse-policy").origin(d, job);
      if (!o.valid || !o.root || o.actorId !== config.ownerId) return "Start a new authenticated app request to change tickets.";
      return null;
    }
    if (job.source?.authorId !== job.actorId || !SNOWFLAKE.test(String(job.source?.messageId || "")) || !job.replyChannel || job.replyChannel !== job.source?.channelId) return "The request's author could not be confirmed.";
    return null;
  }

  // The authenticated request texts, re-read from their source. Throws when the author cannot be confirmed.
  async function requestTexts(job) {
    if (job.ownerAppCommand) return { texts: [job.ownerAppCommand.text], requestId: job.ownerAppCommand.id };
    if (isAppJob(job)) {
      const o = require("./ownermuse-policy").origin(d, job);
      const receipt = d.ownerMuseOrigins?.[o.root];
      const message = d.appThread?.messages?.find((m) => m.id === receipt?.messageId && m.role === "owner");
      if (!message) throw new Error("The authenticated app request could not be found. Start a new request.");
      const later = [...(job.requestInbox || []), ...(job.inbox || [])].filter((s) => s?.role === "owner" && (s.authorId === config.ownerId || !s.authorId)).map((s) => s.content);
      return { texts: [message.text, ...later], requestId: message.id };
    }
    const actual = await discord("GET", `/channels/${job.source.channelId}/messages/${job.source.messageId}`);
    if (!actual || actual.webhook_id || actual.author?.bot || actual.author?.id !== job.actorId) throw new Error("The request's author could not be confirmed from Discord; ticket changes need the owner's or a staff member's own message.");
    const later = [...(job.requestInbox || []), ...(job.inbox || [])].filter((s) => s?.authorId === job.actorId && s.channelId === job.source.channelId).map((s) => s.content);
    return { texts: [actual.content, ...later], requestId: job.source.messageId };
  }

  // Every live task on ticket n learns what happened, so nothing keeps posting on a merged or closed ticket.
  function settle(job, n, outcome, detail = {}) {
    for (const j of Object.values(d.jobs)) {
      if (j.id === job.id || Number(ticketOf(j)) !== Number(n)) continue;
      const note = { role: "system", authorId: "ticket-command", at: new Date(now()).toISOString(), content: outcome === "merged" ? `Ticket ${n} was merged into ticket ${detail.target} on the ${detail.by} instruction. Its channel is closed. Do not post here again.` : outcome === "closed" ? `Ticket ${n} was closed on the ${detail.by} instruction. Do not post here again.` : `Ticket ${n} was reopened on the ${detail.by} instruction. Read the ticket and continue.` };
      if (outcome === "reopened") {
        if (j.kind === "ticket" && JOB_TERMINAL.includes(j.state) && !j.channelClosed) { j.state = "queued"; j.resolved = false; delete j.resolutionReadyAt; }
        if (!JOB_TERMINAL.includes(j.state)) (j.inbox ||= []).push(note);
        continue;
      }
      if (JOB_TERMINAL.includes(j.state)) continue;
      (j.history ||= []).push({ at: note.at, kind: "ticket_command", summary: note.content });
      j.state = "done"; j.summary = note.content;
      if (outcome === "merged") { j.channelClosed = true; j.mergedInto = detail.target; }
      else j.resolved = true;
    }
    ledger.save();
  }

  const playerWaiting = (n) => Object.values(d.jobs).some((j) => j.kind === "ticket" && Number(j.ticket) === Number(n) && !JOB_TERMINAL.includes(j.state) &&
    Math.max(j.lastPlayerAt || 0, j.observedPlayerAt || 0) > (j.lastPublishedAt || 0));

  // One confirmation with the owner for a batch the request did not name, or a close over a waiting player.
  function confirmation(job, op, list, target, why) {
    const key = `ticket-command:${op}:${hash([list, target || null])}`;
    if (job.ownerAppCommand) return appConfirmation(job, op, list, target, why);
    const done = Object.values(d.decisions || {}).find((x) => x.jobId === job.id && x.decisionKey === key && !["pending"].includes(x.state));
    if (done) {
      if (done.state === "selected" && done.selectedOption?.id === "1") return { ok: true };
      throw new Error(`The owner said no to this ${op} (${list.join(", ")}). Do not do it; tell the requester in one line.`);
    }
    const verb = op === "merge" ? `Merge tickets ${list.join(", ")} into ticket ${target}` : `Close tickets ${list.join(", ")}`;
    const x = openDecision(ledger, config, { jobId: job.id, decisionKey: key, question: `${verb}? ${why}`.slice(0, 440), options: [{ label: "Yes, go ahead", detail: list.join(", ") }, { label: "No, leave them" }] });
    job.ownerDecisionPending = true; ledger.save();
    ledger.audit("ticket_command_confirm", { job: job.id, op, tickets: list, target: target || null, decision: x.id });
    return { ok: false, result: { confirming: true, decision: x.id, tickets: list, instruction: `The owner has one question with the exact list. Tell the requester in one line that you are confirming ${list.length} tickets with the owner, then finish waiting; when the answer arrives, call ticket_command again with the same op and tickets.` } };
  }

  // The app chat cannot show an operator decision card, so the owner confirms in that chat. The confirmation is bound
  // to a digest of the exact operation and list: the supervisor sends it back only when the owner's own message carries
  // the code it showed with that list, and only within an hour. A different list, op or target is a new confirmation.
  function appConfirmation(job, op, list, target, why) {
    const digest = crypto.createHash("sha256").update(JSON.stringify([op, [...list].sort((a, b) => a - b), target || null])).digest("hex");
    const store = (d.ownerAppConfirmations ||= {});
    for (const [k, v] of Object.entries(store)) if (now() - v.at > 86400000) delete store[k];
    const held = store[digest];
    if (job.ownerAppCommand.preconfirmed === digest || (job.ownerAppCommand.confirm === digest && held?.state === "pending" && now() - held.at < 3600000)) {
      if (held) { held.state = "confirmed"; held.confirmedAt = now(); }
      ledger.audit("ticket_command_confirmed", { command: job.ownerAppCommand.id, op, tickets: list, target: target || null }); ledger.save();
      return { ok: true };
    }
    store[digest] = { op, tickets: list, target: target || null, command: job.ownerAppCommand.id, at: now(), state: "pending" };
    ledger.audit("ticket_command_confirm", { command: job.ownerAppCommand.id, op, tickets: list, target: target || null, via: "owner-app" }); ledger.save();
    const verb = op === "merge" ? `Merge tickets ${list.join(", ")} into ${target ? `ticket ${target}` : "a new incident"}` : `Close tickets ${list.join(", ")}`;
    return { ok: false, result: { confirming: true, confirmation: digest, op, tickets: list, target: target || null, question: `${verb}? ${why}`.slice(0, 440) } };
  }

  // One owner command from the private app chat. The HTTP layer has already checked the owner's own sign-in cookie
  // against the ops dashboard (createAuthenticator); this validates the structured command, keeps one durable request
  // record per command id (its effect journal makes a retry or a resend after a restart do nothing twice) and runs it
  // through run(), the same checks, limits, confirmations and records as the operator's own ticket_command tool.
  const COMMAND_ID = /^[A-Za-z0-9_-]{8,80}$/;
  const FIELDS = new Set(["commandId", "op", "tickets", "target", "title", "description", "message", "reason", "user", "request", "confirm"]);
  async function ownerApp(body, { signal, addToTicket } = {}) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("JSON object required");
    const extra = Object.keys(body).filter((k) => !FIELDS.has(k));
    if (extra.length) throw bad(`unknown fields: ${extra.join(", ")}`);
    if (!COMMAND_ID.test(String(body.commandId || ""))) throw bad("commandId must be 8-80 letters, digits, _ or -");
    if (!OPS.includes(body.op)) throw bad(`op must be one of ${OPS.join(", ")}`);
    const req = body.request;
    if (!req || typeof req !== "object" || typeof req.text !== "string" || !req.text.trim() || req.text.length > 8000 || !/^[A-Za-z0-9_-]{4,80}$/.test(String(req.messageId || ""))) throw bad("request must carry the owner's message id and text");
    if (body.tickets !== undefined && (!Array.isArray(body.tickets) || body.tickets.length > 25 || body.tickets.some((n) => !Number.isSafeInteger(n) || n < 1))) throw bad("tickets must be up to 25 ticket numbers");
    if (body.target !== undefined && body.target !== null && (!Number.isSafeInteger(body.target) || body.target < 1)) throw bad("target must be a ticket number");
    for (const k of ["title", "description", "message", "reason", "user"]) if (body[k] !== undefined && (typeof body[k] !== "string" || body[k].length > 4800)) throw bad(`${k} must be text`);
    if (body.confirm !== undefined && !/^[a-f0-9]{64}$/.test(String(body.confirm))) throw bad("confirm must be a confirmation digest");
    const held = ctl().held?.() || (d.paused ? "Keir is paused" : null);
    if (held) return { done: false, refused: `Nothing was changed: ${held === "Keir is paused" ? "Keir is stopped from the app (paused)" : held}. Ticket commands resume when Keir is started again.` };
    const store = (d.ownerAppCommands ||= {});
    for (const [k, v] of Object.entries(store)) if (now() - (v.at || 0) > 7 * 86400000 && v.state !== "running") delete store[k];
    const textHash = hash(req.text);
    let job = store[body.commandId];
    if (job && job.ownerAppCommand.textHash !== textHash) throw Object.assign(new Error("commandId was already used for a different owner message"), { status: 409 });
    // A record left running by a restart is past its deadline; the effect journal then reports any uncertain step honestly.
    if (job?.state === "running" && job.deadline > now()) return { done: false, refused: "This exact command is already running. Wait for its result; nothing will be done twice." };
    if (!job) {
      job = store[body.commandId] = { id: `oac-${body.commandId}`, kind: "command", role: "owner", actorId: config.ownerId, at: now(), effects: {}, history: [],
        source: { channelId: "owner-app-supervisor", messageId: req.messageId, authorId: config.ownerId },
        ownerAppCommand: { id: body.commandId, messageId: req.messageId, text: req.text, textHash } };
    }
    if (["blocked"].includes(job.state)) return { done: false, refused: `An earlier attempt at this exact command ended uncertain (${String(job.summary || "").slice(0, 200)}). Nothing more was done. Check the tickets before asking again.` };
    Object.assign(job, { state: "running", deadline: now() + 10 * 60000 });
    job.ownerAppCommand.confirm = body.confirm || null;
    ledger.save();
    const input = Object.fromEntries(["op", "tickets", "target", "title", "description", "message", "reason", "user"].filter((k) => body[k] !== undefined && body[k] !== null).map((k) => [k, body[k]]));
    try {
      let result;
      if (body.op === "open_incident" && input.tickets?.length) {
        // Opening an incident for named tickets: confirm the merge list first, so nothing opens on a list the owner may refuse.
        const list = [...new Set(input.tickets)];
        const named = namedNumbers([req.text]);
        if (list.length > BULK && !list.every((n) => named.has(n))) {
          const c = confirmation(job, "merge", list, null, "The request did not name them by number.");
          if (!c.ok) return { done: false, ...c.result };
          job.ownerAppCommand.preconfirmed = crypto.createHash("sha256").update(JSON.stringify(["merge", [...list].sort((a, b) => a - b), null])).digest("hex");
        }
        const opened = await run(job, { op: "open_incident", title: input.title, description: input.description || input.reason }, signal);
        const target = opened.incident;
        // The merge list was confirmed (or needed none) against "a new incident"; bind it to the incident just opened.
        if (job.ownerAppCommand.preconfirmed) job.ownerAppCommand.preconfirmed = crypto.createHash("sha256").update(JSON.stringify(["merge", list.filter((n) => n !== target).sort((a, b) => a - b), target])).digest("hex");
        const merged = await run(job, { op: "merge", tickets: list, target, reason: input.reason || input.description || input.title }, signal);
        result = { incident: target, opened: true, ...merged };
      } else if (body.op === "add_person") {
        const r = await run(job, input, signal);
        if (!addToTicket) throw new Error("Adding a person is not available here.");
        result = await addToTicket(job, { user: String(r.user || ""), ...(r.ticket ? { ticket: r.ticket } : {}) });
      } else result = await run(job, input, signal);
      if (result?.confirming) return { done: false, ...result };
      job.history.push({ at: new Date(now()).toISOString(), kind: "ticket_command", op: body.op });
      ledger.audit("ticket_command_owner_app", { command: body.commandId, op: body.op, tickets: input.tickets || [], target: input.target || result?.target || result?.incident || null });
      return { done: true, result: { ...result, instruction: undefined } };
    } catch (e) {
      if (e.status) throw e;
      return { done: false, refused: String(e.message || e).replace(/^Not done: /, "").slice(0, 600) };
    } finally {
      if (job.state === "running") job.state = "done";
      delete job.ownerAppCommand.confirm; delete job.ownerAppCommand.preconfirmed;
      ledger.save();
    }
  }

  async function run(job, input, signal) {
    const why = refusal(job);
    if (why) throw new Error(`Not done: ${why}`);
    const op = String(input.op || "");
    if (!OPS.includes(op)) throw new Error(`op must be one of ${OPS.join(", ")}`);
    const gate = ctl().gate("crossTicketActions");
    if (!gate.run) throw new Error(`Not done: ticket commands are off right now (${gate.why}). Tell the requester exactly that.`);
    const { texts, requestId } = await requestTexts(job);
    const named = namedNumbers(texts);
    const by = job.actorId === config.ownerId ? "owner's" : "staff member's";
    const tickets = [...new Set((input.tickets || (input.ticket ? [input.ticket] : [])).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
    if (!gate.act) {
      controlsLib.preview(d, "ticket-command", op, tickets.join(",") || "new", `requested by ${job.actorId}`, {}, now());
      ledger.save();
      return { preview: true, instruction: "Ticket commands are in preview: nothing was changed. Tell the requester that in one line." };
    }
    const get = (n) => mcp.call("support", "support_get", { kind: "ticket", number: n }, false, signal);

    if (op === "open_incident") {
      const title = publicText(input.title).trim().slice(0, 200), description = publicText(input.description || input.reason || "").trim().slice(0, 4800);
      if (!title || !description) throw new Error("Give the incident a short title and a plain description of the problem.");
      const r = await effect(job, `ticket-command:incident:${requestId}`, () => mcp.call("support", "support_create_ticket", { category: "incident", title, description: `${description}\n\nOpened by Keir on the ${by} instruction.`, ...(SNOWFLAKE.test(String(job.replyChannel || "")) ? { source_channel_id: job.replyChannel } : {}) }, true, signal));
      const number = r?.ticketNumber || r?.number || r?.ticket?.number;
      if (!number) throw new Error("The incident was requested but no ticket number came back. Inspect its receipt before retrying.");
      job.commandIncident = number; ledger.audit("ticket_command_incident", { job: job.id, ticket: number, by: job.actorId }); ledger.save();
      return { opened: true, incident: number, instruction: `Incident ${number} is open. Merge the tickets with ticket_command op merge, target ${number}, then tell the requester in one plain message what was done, with the ticket numbers.` };
    }

    if (op === "add_person") return { delegated: "add_to_ticket", user: input.user, ticket: tickets[0] || null };

    if (!tickets.length) throw new Error("Name the tickets by number.");
    const allNamed = tickets.every((n) => named.has(n)) && (op !== "merge" || !input.target || named.has(Number(input.target)) || Number(input.target) === job.commandIncident);

    if (op === "merge") {
      const target = Number(input.target || job.commandIncident);
      if (!target) throw new Error("Name the ticket or incident to merge into, or open one first with op open_incident.");
      const reason = String(input.reason || "").trim();
      if (reason.length < 8) throw new Error("Give a one-line reason: what makes them the same problem.");
      const list = tickets.filter((n) => n !== target);
      if (list.length > BULK && !allNamed) { const c = confirmation(job, "merge", list, target, `The request did not name them by number. Reason: ${reason}`); if (!c.ok) return c.result; }
      const t = await get(target);
      if (!t?.number || ["resolved", "closed"].includes(t.status)) throw new Error(`Ticket ${target} is not open, so nothing can join it.`);
      if (["moderation", "investigation"].includes(t.category)) throw new Error("Moderation tickets are never merged.");
      const results = [];
      for (const n of list) {
        const s = await get(n).catch(() => null);
        if (!s?.number) { results.push({ ticket: n, merged: false, why: "not found" }); continue; }
        if (Number(s.mergedInto) === target) { results.push({ ticket: n, merged: true, already: true }); settle(job, n, "merged", { target, by }); continue; }
        if (["moderation", "investigation"].includes(s.category)) { results.push({ ticket: n, merged: false, why: "moderation tickets are never merged" }); continue; }
        if (["resolved", "closed"].includes(s.status)) { results.push({ ticket: n, merged: false, why: `already ${s.status}` }); continue; }
        try {
          const r = await effect(job, `ticket-command:merge:${n}:${target}`, () => mcp.call("support", "support_merge", { source_number: n, target_number: target, reason: reason.slice(0, 500), merged_by: `keir for ${job.actorId}`, require_incident: t.category === "incident" }, true, signal));
          results.push({ ticket: n, merged: true, already: Boolean(r?.alreadyMerged) });
          ledger.audit("ticket_command_merged", { job: job.id, ticket: n, target, by: job.actorId, steps: r?.steps || null });
          settle(job, n, "merged", { target, by });
        } catch (e) { results.push({ ticket: n, merged: false, why: String(e.message).slice(0, 160) }); }
      }
      try { require("./incidents").resetIncidentCache(); } catch {}
      return { target, results, instruction: "Tell the requester in one plain message what was done: which tickets joined which ticket (numbers), that each reporter was added there and told, and any that did not merge with the reason. Then finish." };
    }

    if (op === "resolve") {
      const message = publicText(input.message || "").trim();
      if (message.length < 8) throw new Error("Give the player-facing closing message.");
      const waiting = tickets.filter(playerWaiting);
      if ((tickets.length > BULK || waiting.length) && !allNamed) { const c = confirmation(job, "resolve", tickets, null, waiting.length ? `Players are still waiting for an answer on ${waiting.join(", ")}.` : "The request did not name them by number."); if (!c.ok) return c.result; }
      const results = [];
      for (const n of tickets) {
        try {
          await effect(job, `ticket-command:resolve:${n}`, () => mcp.call("support", "support_resolve", { number: n, message, source: "agent", attribution: { agent: "keir", evidence: `Closed on the ${by} instruction`, jobId: job.id } }, true, signal));
          results.push({ ticket: n, closed: true }); ledger.audit("ticket_command_resolved", { job: job.id, ticket: n, by: job.actorId });
          settle(job, n, "closed", { by });
        } catch (e) { results.push({ ticket: n, closed: false, why: String(e.message).slice(0, 160) }); }
      }
      return { results, instruction: "Tell the requester in one line which tickets were closed, and any that were not with the reason." };
    }

    // reopen
    const reason = String(input.reason || "").trim();
    if (reason.length < 8) throw new Error("Give a one-line reason for reopening.");
    const results = [];
    for (const n of tickets) {
      const t = await get(n).catch(() => null);
      const receipt = t?.resolution?.receiptId || t?.receiptId || /\/t\/([\w-]{6,})\/?$/.exec(String(t?.receiptUrl || ""))?.[1];
      if (!t?.number || !receipt) { results.push({ ticket: n, reopened: false, why: "no resolved receipt to reopen from" }); continue; }
      try {
        await effect(job, `ticket-command:reopen:${n}:${receipt}`, () => mcp.call("support", "support_reopen", { number: n, receipt_id: receipt, reason: reason.slice(0, 500) }, true, signal));
        results.push({ ticket: n, reopened: true }); ledger.audit("ticket_command_reopened", { job: job.id, ticket: n, by: job.actorId });
        settle(job, n, "reopened", { by });
      } catch (e) { results.push({ ticket: n, reopened: false, why: String(e.message).slice(0, 160) }); }
    }
    return { results, instruction: "Tell the requester in one line which tickets were reopened, and any that were not with the reason." };
  }

  return { run, ownerApp, refusal, namedNumbers, settle, BULK };
}

module.exports = { createTicketCommands, namedNumbers, BULK, OPS };
