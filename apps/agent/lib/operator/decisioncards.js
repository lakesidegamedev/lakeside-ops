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
const { JOB_TERMINAL } = require("./machines");

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

function createDecisionCards({ ledger, mcp, config = {}, now = () => Date.now(), log = () => {}, readTicket = null, perTick = PER_TICK }) {
  const d = ledger.data;
  function release(card, at) {
    for (const j of Object.values(d.jobs || {})) for (const r of j.raisedToDevelopers || []) if (Number(r.id) === card && !r.releasedAt) r.releasedAt = at;
  }
  async function tick() {
    let n = 0, closed = 0;
    for (const x of Object.values(d.decisions || {})) {
      const card = cardOf(x);
      if (!card || x.state === "pending" || x.cardClosedAt || x.cardLeftOpen) continue;
      if ((x.cardRetryAt || 0) > now()) continue;
      if (n++ >= perTick) break;
      try {
        const item = await mcp.call("ops-knowledge", "kanban_get", { id: card }, false);
        if (!item || Number(item.id) !== card) throw new Error("card unreadable");
        const summary = outcomeLine(x, config);
        if (item.lane === "done") { x.cardClosedAt = now(); release(card, now()); continue; }
        const taken = ["now", "blocked"].includes(item.lane) || !OWN.has(String(item.assigned_to || "").toLowerCase());
        if (taken) {
          // Someone else is working it: say what was decided, leave the card with them.
          await mcp.call("ops-knowledge", "work_report", { id: card, event: "progress", actor: "keir", summary, idempotency_key: `decision-card:${x.id}:note` }, true);
          x.cardLeftOpen = now(); ledger.audit("decision_card_noted", { decision: x.id, card, lane: item.lane });
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
    const status = new Map();
    for (const x of Object.values(d.decisions || {})) {
      if (x.state !== "pending" || !cardOf(x)) continue;
      const job = d.jobs?.[x.jobId];
      const ticket = Number(x.ticket || job?.ticket || 0);
      let ended = !job || JOB_TERMINAL.includes(job.state) || job.channelClosed || job.resolved;
      if (!ended && ticket && readTicket) {
        if (!status.has(ticket)) {
          if (reads++ >= maxReads) continue;
          status.set(ticket, await readTicket(ticket).then((t) => String(t?.status || "")).catch(() => null));
        }
        ended = ["closed", "resolved"].includes(status.get(ticket));
      }
      if (!ended) continue;
      x.state = "withdrawn"; x.withdrawnReason = "the ticket was closed"; withdrawn++;
      ledger.audit("decision_withdrawn_ticket_closed", { decision: x.id, ticket: ticket || null });
    }
    if (withdrawn) ledger.save();
    return { withdrawn, reads };
  }
  return { tick, sweepClosedTickets };
}

module.exports = { createDecisionCards, cardOf, outcomeLine };
