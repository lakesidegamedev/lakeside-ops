"use strict";
// Staff actions from the Discord desk. The running operator executes them so the ledger has one writer.
// None of them resolves a ticket or posts to a player: they only move a ticket between Keir and people,
// pause or resume it, requeue its current step once, flip the kill switch, or queue a model route for new work.
// Every action writes one audit row (with the Discord user and role) and one line to the staff channel.
const ticketPause = require("./ticketpause");

const ACTION_ROLES = { nudge: ["junior", "dev", "owner"], release: ["junior", "dev", "owner"], pause: ["junior", "dev", "owner"], resume: ["junior", "dev", "owner"], on: ["dev", "owner"], off: ["dev", "owner"], route: ["dev", "owner"] };
const CLOSED = new Set(["done", "cancelled", "dismissed"]);

function createDeskActions({ ledger, config, supportOwner, killSwitch, now = () => Date.now() }) {
  const d = ledger.data;
  const refuse = (message) => ({ ok: false, message });
  const who = (actor) => ({ id: String(actor?.id || "unknown").slice(0, 40), role: String(actor?.role || "unknown").slice(0, 20) });
  const jobFor = (n) => d.jobs[d.seen[`ticket:${n}`]] || null;
  const channelFor = (n, job) => job?.channelId || Object.entries(d.channels || {}).find(([, c]) => c.ticket === n)?.[0] || null;
  function record(kind, actor, detail, line) {
    const a = who(actor);
    ledger.audit("desk_action", { action: kind, actor: a.id, role: a.role, ...detail });
    ledger.notify(`deskaction:${kind}:${now()}:${Math.random().toString(36).slice(2, 8)}`, `channel:${config.incidentChannel}`, line);
    ledger.save();
  }
  function run({ action, ticket, actor, ...rest }) {
    if (!ACTION_ROLES[action]) return refuse(`Unknown action ${String(action).slice(0, 20)}.`);
    const a = who(actor);
    if (!ACTION_ROLES[action].includes(a.role)) return refuse(`${action} needs a ${ACTION_ROLES[action].includes("junior") ? "junior developer" : "developer"} role.`);
    if (action === "off") { const s = killSwitch.engage({ reason: `switched off from the desk by ${a.id}`, by: `desk:${a.id}` }); record("off", actor, {}, `Keir switched OFF from the desk by <@${a.id}>.`); return { ok: true, message: "Keir is off. Nothing will post, merge or heal until it is switched on.", state: s }; }
    if (action === "on") { const s = killSwitch.release(); record("on", actor, {}, `Keir switched ON from the desk by <@${a.id}>.`); return { ok: true, message: "Keir is on.", state: s }; }
    if (action === "route") {
      const { provider, model, effort, override } = rest;
      if (!provider || !model) return refuse("A provider and model are needed.");
      d.pendingRoute = { runner: String(provider), model: String(model), ...(effort ? { effort: String(effort) } : {}), at: now(), by: a.id, override: override === true };
      record("route", actor, { runner: provider, model, effort: effort || null, override: override === true }, `<@${a.id}> queued ${provider}:${model}${effort ? `@${effort}` : ""} for new tickets${override === true ? " (NOT proven, override)" : ""}.`);
      return { ok: true, message: `New tickets will use ${provider}:${model}${effort ? `@${effort}` : ""}. Tickets already in progress keep their model.` };
    }
    const n = Number(ticket);
    if (!Number.isInteger(n) || n <= 0) return refuse("Give a ticket number.");
    const job = jobFor(n);
    if (action === "release") {
      supportOwner.setTicketOwner(n, "staff", `desk:${a.id}`, {});
      record("release", actor, { ticket: n }, `<@${a.id}> took ticket ${n} back from Keir.`);
      return { ok: true, message: `Ticket ${n} is handed back to people. Keir has stopped on it.` };
    }
    if (!job) return refuse(`Keir has no work on ticket ${n}.`);
    if (action === "nudge") {
      if (job.state === "running") return refuse(`Keir is working on ticket ${n} right now. Wait for the step to finish.`);
      if (job.state === "queued") return refuse(`Ticket ${n} is already queued to run.`);
      if (job.state === "paused") return refuse(`Ticket ${n} is paused. Resume it first.`);
      if (job.state === "deferred" || supportOwner.deferred(job)) return refuse(`Ticket ${n} is held by a person, so Keir will not run it.`);
      if (CLOSED.has(job.state)) return refuse(`Ticket ${n} is finished.`);
      if (job.state === "blocked" && Object.values(job.effects || {}).some((e) => e.state === "started")) return refuse(`Ticket ${n} stopped in the middle of a change whose result is unknown. A person has to check it before Keir runs again.`);
      if (!["waiting", "blocked"].includes(job.state)) return refuse(`Ticket ${n} is ${job.state}; nothing to nudge.`);
      job.state = "queued"; delete job.wakeAt;
      record("nudge", actor, { ticket: n, job: job.id }, `<@${a.id}> nudged ticket ${n}; Keir will re-run its current step once.`);
      return { ok: true, message: `Ticket ${n} is queued to run its current step again.` };
    }
    const channelId = channelFor(n, job);
    if (!channelId) return refuse(`No channel is known for ticket ${n}.`);
    const source = { authorId: a.id, messageId: `desk:${now()}`, at: new Date(now()).toISOString() };
    if (action === "pause") {
      if (d.ticketPauses?.[n]) return refuse(`Ticket ${n} is already paused.`);
      ticketPause.setPause(ledger, channelId, n, true, source, now());
      record("pause", actor, { ticket: n }, `<@${a.id}> paused Keir on ticket ${n}.`);
      return { ok: true, message: `Keir is paused on ticket ${n}.` };
    }
    if (!d.ticketPauses?.[n]) return refuse(`Ticket ${n} is not paused.`);
    ticketPause.setPause(ledger, channelId, n, false, source, now());
    record("resume", actor, { ticket: n }, `<@${a.id}> resumed Keir on ticket ${n}.`);
    return { ok: true, message: `Keir is resumed on ticket ${n}.` };
  }
  // The pending route applies to jobs created after it was chosen, never to a ticket already in progress.
  function routeFor(job) {
    const r = d.pendingRoute;
    return r && job && job.at >= r.at ? r : null;
  }
  return { run, routeFor };
}
module.exports = { createDeskActions, ACTION_ROLES };
