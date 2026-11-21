"use strict";
// Keir 11.2 (audit 2026-11-21, P1-4, H10): a decision's kanban card closes with the decision.
//
// raise_to_developers files an owner question on the ops kanban and opens a decision keyed "kanban:<card>". The decision
// ended by a button, the app, a channel answer, a withdrawal or an expiry, but its card stayed in the inbox: on 21 Nov
// nine inbox cards asked the owner about tickets that were already closed. Whenever such a decision is no longer pending,
// in any state and by any route, its card is completed with the outcome. On startup (and every few hours) a pending
// decision whose ticket is closed or resolved is withdrawn, so its card and DMs close too.
//
// Safety: a card someone else picked up (moved to now or blocked, or assigned to anyone but Keir) is never completed;
// it gets one progress note instead. Reads and writes are bounded per pass and retried later on failure.
//
// Third pass (review M8, M7): a card is completed only when the decision really ended: answered, chosen, approved,
// declined, or withdrawn because its ticket closed or its PR merged or closed. An expired or superseded question, or one
// withdrawn for another reason, leaves the card open with one progress note, so the owner's reminder stays. The sweep reads
// the ticket's own status whenever the question has a ticket; a finished or archived task is not "the ticket was closed".
// A card that still backs another open question is left alone. Both passes have switches (KEIR_DECISION_CARDS,
// KEIR_CLOSED_TICKET_SWEEP) and preview, stop under the kill switch or a pause, and take a few historical decisions per run.
const { JOB_TERMINAL } = require("./machines");
const controlsLib = require("./controls");
const REAL_END = new Set(["approve", "reject", "explain", "selected", "answered"]);
const REAL_WITHDRAWAL = /^(?:the ticket was closed|merged on GitHub|closed on GitHub without merging)$/;
function reallyEnded(x) {
  if (x.state === "answered" && !/^ticket_channel_(?:reply|option)$/.test(x.answeredVia || "") && /^ticket_channel/.test(x.answeredVia || "")) return false; // 11.1's loose channel rule
  return REAL_END.has(x.state) || (x.state === "withdrawn" && REAL_WITHDRAWAL.test(String(x.withdrawnReason || "")));
}
// support_get answers as the ticket, or as an MCP content envelope around it.
function ticketStatus(r) {
  if (r && Array.isArray(r.content) && r.status === undefined) { try { r = JSON.parse(r.content.find((c) => c?.type === "text")?.text || "null"); } catch { return null; } }
  return r && typeof r === "object" && r.status ? String(r.status).toLowerCase() : null;
}

const CARD_KEY = /^kanban:(\d+)$/;
const PER_TICK = 5;
const OWN = new Set(["", "keir", "keir-operator"]);

function cardOf(x) { const m = CARD_KEY.exec(String(x?.decisionKey || "")); return m ? Number(m[1]) : null; }

function outcomeLine(x, config = {}) {
  const who = x.answeredBy === config.ownerId ? "Egg" : x.answeredBy && (config.staffIds || []).includes(x.answeredBy) ? "Ariane" : x.answeredBy ? "Staff" : null;
  const where = /^ticket_channel/.test(x.answeredVia || "") ? " in the ticket" : "";
  const q = String(x.question || "").replace(/\s+/g, " ").slice(0, 200);
  const outcome = x.selectedOption ? `${who || "The owner"} chose "${x.selectedOption.label}"${where}.`
    : x.state === "approve" ? `${who || "The owner"} approved it.`
    : x.state === "reject" ? `${who || "The owner"} declined it.`
    : ["explain", "answered"].includes(x.state) ? `${who || "The owner"} answered${where}: ${String(x.answer || x.answerText || "").slice(0, 300)}`
    : x.state === "expired" ? "It expired without an answer."
    : `It was withdrawn${x.withdrawnReason ? ` (${String(x.withdrawnReason).slice(0, 160)})` : ""}.`;
  return `Decision closed. ${outcome} Question: ${q}`.replace(/[–—]/g, ",");
}

function createDecisionCards({ ledger, mcp, config = {}, now = () => Date.now(), log = () => {}, readTicket = null, perTick = PER_TICK, controls = controlsLib.DEFAULT_CONTROLS }) {
  const d = ledger.data;
  const preview = (pass, action, target, reason) => controlsLib.preview(d, pass, action, target, reason, {}, now());
  function release(card, at) {
    for (const j of Object.values(d.jobs || {})) for (const r of j.raisedToDevelopers || []) if (Number(r.id) === card && !r.releasedAt) r.releasedAt = at;
  }
  async function tick() {
    let n = 0, closed = 0;
    const g = controls.gate("decisionCards");
    if (!g.run) return { closed, skipped: g.why };
    const hist = controlsLib.history(d, "decisionCards", { controls, now: now(), act: g.act });
    for (const x of Object.values(d.decisions || {})) {
      const card = cardOf(x);
      if (!card || x.state === "pending" || x.cardClosedAt || x.cardLeftOpen || x.cardHistorical) continue;
      if ((x.cardRetryAt || 0) > now()) continue;
      // Suspicion 6 of the review: one card can back two questions; it stays open while either is.
      if (Object.values(d.decisions).some((y) => y !== x && y.state === "pending" && y.decisionKey === x.decisionKey)) continue;
      const age = hist.check(Number(x.answeredAt || x.reconciledAt || x.withdrawnAt || x.at) || NaN);
      if (age === "later") continue;
      if (age === "too old") { if (g.act) x.cardHistorical = now(); else preview("decision-cards", "leave", `card ${card}`, "ended before the history cutoff"); continue; }
      if (n++ >= perTick) break;
      const real = reallyEnded(x);
      if (!g.act) { preview("decision-cards", real ? "complete card" : "note card", `card ${card}`, outcomeLine(x, config)); continue; }
      try {
        const item = await mcp.call("ops-knowledge", "kanban_get", { id: card }, false);
        if (!item || Number(item.id) !== card) throw new Error("card unreadable");
        const summary = outcomeLine(x, config);
        if (item.lane === "done") { x.cardClosedAt = now(); release(card, now()); continue; }
        const taken = ["now", "blocked"].includes(item.lane) || !OWN.has(String(item.assigned_to || "").toLowerCase());
        if (taken || !real) {
          // Someone else is working it: say what was decided, leave the card with them.
          await mcp.call("ops-knowledge", "work_report", { id: card, event: "progress", actor: "keir", summary, idempotency_key: `decision-card:${x.id}:note` }, true);
          x.cardLeftOpen = now(); ledger.audit("decision_card_noted", { decision: x.id, card, lane: item.lane, why: taken ? "picked up" : x.state });
          continue;
        }
        await mcp.call("ops-knowledge", "work_report", { id: card, event: "completed", actor: "keir", summary, no_evidence_reason: "An owner decision, closed when the decision ended.", idempotency_key: `decision-card:${x.id}:done` }, true);
        x.cardClosedAt = now(); release(card, now()); closed++;
        ledger.audit("decision_card_closed", { decision: x.id, card, state: x.state });
      } catch (e) {
        x.cardCloseErrors = (x.cardCloseErrors || 0) + 1;
        x.cardRetryAt = now() + Math.min(6 * 3600000, 5 * 60000 * 2 ** Math.min(6, x.cardCloseErrors));
        log(`decision card ${card}: ${String(e.message).slice(0, 160)}`);
      }
    }
    if (n) ledger.save();
    return { closed };
  }
  // Pending decisions on tickets that are closed or resolved are withdrawn; tick() then closes their cards and the
  // decision loop edits their DMs. readTicket(number) -> support record or throws; an unreadable record is skipped.
  async function sweepClosedTickets({ maxReads = 20 } = {}) {
    let reads = 0, withdrawn = 0;
    const g = controls.gate("closedTicketSweep");
    if (!g.run) return { withdrawn, reads, skipped: g.why };
    const hist = controlsLib.history(d, "closedTicketSweep", { controls, now: now(), act: g.act });
    const status = new Map();
    for (const x of Object.values(d.decisions || {})) {
      if (x.state !== "pending" || !cardOf(x)) continue;
      const job = d.jobs?.[x.jobId];
      const ticket = Number(x.ticket || job?.ticket || 0);
      // The ticket's own record decides when there is a ticket: the channel closing, the ticket resolved, or the support
      // service saying closed or resolved. Only a question with no ticket at all falls back to its task having ended.
      let reason = null;
      if (ticket) {
        if (job?.channelClosed || job?.resolved) reason = "the ticket was closed";
        else if (readTicket) {
          if (!status.has(ticket)) {
            if (reads++ >= maxReads) continue;
            status.set(ticket, await readTicket(ticket).then(ticketStatus).catch(() => null));
          }
          if (["closed", "resolved"].includes(status.get(ticket))) reason = "the ticket was closed";
        }
      } else if (!job || JOB_TERMINAL.includes(job.state)) reason = "the task that asked it ended";
      if (!reason) continue;
      const age = hist.check(Number(x.at) || NaN, { open: true });
      if (age === "later") continue;
      if (!g.act) { preview("closed-ticket-sweep", "withdraw question", `decision ${x.id}`, `${reason}${ticket ? ` (ticket ${ticket})` : ""}: "${String(x.question || "").replace(/\s+/g, " ").slice(0, 120)}"`); continue; }
      x.state = "withdrawn"; x.withdrawnReason = reason; x.withdrawnAt = now(); withdrawn++;
      ledger.audit("decision_withdrawn_ticket_closed", { decision: x.id, ticket: ticket || null, reason });
    }
    if (withdrawn) ledger.save();
    return { withdrawn, reads };
  }
  return { tick, sweepClosedTickets };
}

module.exports = { createDecisionCards, cardOf, outcomeLine, reallyEnded, ticketStatus };
