"use strict";
// Keir 3.0 wiring: who owns the support desk, and the handoff that moves it.
// Until now Keir deferred only to the legacy ticket supervisor's policy
// file, so unpausing Keir while another operator (Codex) ran tickets would
// have had both answering the same players. The owner of support is now an
// explicit ledger fact. While another operator owns support, Keir handles
// owner and developer requests but holds ticket and candidate work, except
// tickets that operator has handed off individually.
//
// A handoff goes through the Handoff Desk: filed with scope, asks and the
// full body (or a backing document), acknowledged at once with a receipt,
// and incorporated when the linked ticket's next activation starts with the
// handoff in its inbox. A handoff transfers ownership; it never grants
// approval authority (effects still go through the normal gates).

const { createHandoffDesk } = require("./handoffs");

function createSupportOwner({ ledger, now = () => Date.now() }) {
  const d = ledger.data;
  const state = () => (d.supportOwner ||= { owner: "keir", since: now(), tickets: {} });
  const desk = createHandoffDesk((d.handoffDesk ||= {}), { now });

  const owner = () => (d.supportOwner ? d.supportOwner.owner : "keir");
  // True when this job's support work belongs to someone else right now.
  // A single ticket can be given to someone else (owner: "another agent is
  // looking at 1522") while Keir keeps the rest of the desk, and vice versa.
  function deferred(job) {
    const perTicket = job?.ticket ? d.supportOwner?.tickets?.[job.ticket] : undefined;
    if (perTicket) return perTicket !== "keir";
    return owner() !== "keir";
  }

  function setTicketOwner(ticket, next, by, options = {}) {
    const n = Number(ticket);
    if (!Number.isInteger(n) || n <= 0) throw new Error("ticket must be a ticket number");
    if (!next || typeof next !== "string") throw new Error("ticket owner must be a name");
    const s = state();
    s.tickets[n] = next;
    const takeover = require("./supporttakeover").record(ledger, n, next, by, options, now());
    ledger.audit("ticket_owner", { ticket: n, owner: next, by: by || null });
    ledger.save();
    return { ticket: n, owner: next, takeover };
  }

  function setOwner(next, by) {
    if (!next || typeof next !== "string") throw new Error("support owner must be a name");
    const s = state();
    s.owner = next; s.since = now(); s.by = by || null;
    // Returning the desk to Keir keeps tickets explicitly held for others.
    if (next === "keir") s.tickets = Object.fromEntries(Object.entries(s.tickets).filter(([, o]) => o !== "keir"));
    ledger.audit("support_owner", { owner: next, by: by || null });
    ledger.save();
    return { ...s };
  }

  // h: { id, from, scope, asks[], body?, document?, evidence?, tickets?[],
  //      releasesSupport? }. Returns the receipt the sender keeps.
  function receive(h, { ensureTicketJob }) {
    const { handoff, duplicate } = desk.file({ ...h, workIds: (h.tickets || []).map((n) => `ticket:${n}`) });
    if (duplicate) return { receipt: receiptOf(handoff), duplicate: true };
    desk.acknowledge(handoff.id, "keir");
    const s = state();
    for (const n of h.tickets || []) {
      s.tickets[n] = "keir";
      // Approvals Keir held on this ticket from before the other operator
      // took over describe a world that has moved on (that operator may have
      // shipped the same change another way). None of them survive the
      // handoff: anything still needed is asked for again, fresh.
      const superseded = [];
      for (const j of Object.values(d.jobs).filter((x) => Number(x.ticket) === Number(n))) {
        for (const a of Object.values(d.actions || {}).filter((x) => x.jobId === j.id && ["pending", "approved"].includes(x.state))) {
          a.state = "superseded"; a.supersededBy = `handoff:${handoff.id}`; superseded.push(a.id);
        }
        for (const x of Object.values(d.decisions || {}).filter((x) => x.jobId === j.id && x.state === "pending")) {
          x.state = "withdrawn"; x.withdrawnReason = `handoff:${handoff.id}`;
        }
      }
      if (superseded.length) ledger.audit("approvals_superseded_by_handoff", { handoff: handoff.id, ticket: n, actions: superseded });
      const job = ensureTicketJob(Number(n));
      if (!job) continue;
      // An explicit handoff transfers the ticket back to Keir. Old claim
      // messages must not reclaim it when history is read on the next run.
      if (job.channelId) {
        const channel = (d.channels[job.channelId] ||= {});
        delete channel.claimedBy;
        channel.claimReleasedAt = now();
      }
      delete job.staffActiveUntil;
      if (job.resolutionReadyAt) ledger.audit("ticket_reopened_by_handoff", { job: job.id, ticket: n, handoff: handoff.id, previousAnswerAt: job.resolutionReadyAt });
      delete job.resolutionReadyAt;
      delete job.waitingFor;
      (job.inbox ||= []).push({ authorId: `handoff:${h.from}`, role: "system", at: new Date(now()).toISOString(),
        content: `Handoff from ${h.from} (receipt ${handoff.id}). Scope: ${handoff.scope}\nAsks:\n${handoff.asks.map((a) => `- ${a}`).join("\n")}`
          + (handoff.body ? `\n\n${handoff.body}` : "") + (handoff.document ? `\n\nFull handoff document: ${handoff.document.name} (digest ${handoff.document.digest}).` : "")
          + "\n\nYou now own this ticket. Verify the stated state against tools and receipts before relying on it; take no action it describes as pending unless the normal approvals allow it." });
      (job.pendingHandoffs ||= []).includes(handoff.id) || job.pendingHandoffs.push(handoff.id);
      // PRs the sending operator opened for this ticket become the ticket's
      // own, so Keir can watch and ship them; every merge gate still applies.
      for (const url of h.pullRequests || []) {
        if (!/^https:\/\/github\.com\/(?:Egg3901|lakesidegamedev)\/(?:AHDGame|AHDClient)\/pull\/\d+$/.test(url)) continue;
        if (!(job.pullRequests ||= []).includes(url)) job.pullRequests.push(url);
      }
      if (["waiting", "blocked", "deferred", "done", "dismissed"].includes(job.state) && !job.channelClosed) job.state = "queued";
    }
    if (h.releasesSupport) setOwner("keir", `handoff:${h.from}`);
    ledger.audit("handoff_received", { handoff: handoff.id, from: h.from, tickets: h.tickets || [], releasesSupport: Boolean(h.releasesSupport) });
    ledger.save();
    return { receipt: receiptOf(desk.get(handoff.id)), duplicate: false };
  }

  // Called when a job's activation starts: handoffs in its inbox are now part
  // of the work it is doing.
  function incorporateFor(job) {
    for (const id of job.pendingHandoffs || []) {
      try { desk.incorporate(id, `ticket:${job.ticket}`, `activation of ${job.id}`); } catch { /* unlinked or unknown */ }
    }
    if (job.pendingHandoffs?.length) { delete job.pendingHandoffs; ledger.save(); }
  }

  const receiptOf = (h) => ({ id: h.id, state: h.state, filedAt: h.filedAt, acknowledgedAt: h.acknowledgedAt || null,
    incorporatedInto: h.incorporatedInto.map((x) => x.workId) });

  // Owner choice of model for one ticket ("have Muse Wonder Full take 1537").
  // Applies from the ticket's next activation: a run in progress is never cut
  // off, and the new model starts from the ticket record and history.
  const RUNNERS = ["codex", "muse", "claude", "agy", "cursor", "ollama", "deepseek"];
  const EFFORTS = ["low", "medium", "high", "xhigh"];
  function assignModel(ticket, spec, by, { ensureTicketJob } = {}) {
    const n = Number(ticket);
    if (!Number.isInteger(n) || n <= 0) throw new Error("ticket must be a ticket number");
    const [head, effort = "medium"] = String(spec || "").split("@"), [runner, model] = head.split(":");
    if (!RUNNERS.includes(runner) || !model || !EFFORTS.includes(effort)) throw new Error("model must be runner:model[@effort], runner one of codex, muse, claude, agy, cursor, ollama, deepseek");
    const job = d.jobs[d.seen[`ticket:${n}`]] || ensureTicketJob?.(n);
    if (!job) throw new Error(`no job for ticket ${n}`);
    job.provider = { lane: "worker", runner, model, effort, at: now(), assignedBy: by || null };
    delete job.effortPin;
    ledger.audit("ticket_model_assigned", { ticket: n, job: job.id, runner, model, effort, by: by || null });
    ledger.save();
    return { ticket: n, job: job.id, runner, model, effort, appliesFrom: job.state === "running" ? "next activation" : "next activation (now)" };
  }

  return { owner, deferred, setOwner, setTicketOwner, assignModel, receive, incorporateFor, status: () => ({ ...state(), overdue: desk.overdue() }),
    handoff: (id) => { const h = desk.get(id); return h ? receiptOf(h) : null; } };
}

module.exports = { createSupportOwner };
