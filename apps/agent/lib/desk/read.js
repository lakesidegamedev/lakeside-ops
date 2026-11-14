"use strict";
// Plain-language views over a loaded state object: { now, active, release, ledger, usage }.
// Pure. No ids beyond ticket numbers, no player Discord ids, no hidden reasoning, under 1800 characters.
const MAX = 1800;
const TERMINAL = new Set(["done", "dismissed", "closed", "superseded", "failed", "expired", "cancelled"]);
const USAGE_LIMIT = /usage[ _-]?limit|limit exceeded|rate.?limit|quota|too many requests|\b429\b|insufficient (?:credit|balance)|out of credit/i;
const AUTH_FAILED = /authentication_failed|failed to authenticate|oauth|not logged in|\/login|invalid (?:api[ _-]?key|bearer)/i;

const clean = (s) => String(s ?? "")
  .replace(/<@[!&]?\d+>|<#\d+>/g, "").replace(/\b\d{17,20}\b/g, "").replace(/[–—]/g, ",").replace(/\s+/g, " ").trim();
const cap = (s) => (s.length <= MAX ? s : `${s.slice(0, MAX - 3).trimEnd()}...`);

function span(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}
const ago = (state, at) => (at ? `${span(state.now - at)} ago` : "never");
const stamp = (v) => (typeof v === "number" ? v : Date.parse(v || "")) || 0;

const jobsOf = (state) => Object.values(state.ledger?.jobs || {});
const ticketOf = (job) => Number(job.ticket) || 0;
const isTicketJob = (job) => job.kind === "ticket" && ticketOf(job);
const open = (job) => isTicketJob(job) && !TERMINAL.has(job.state);
const touched = (job) => job.updatedAt || job.at || 0;
const pendingActions = (state, job) => Object.values(state.ledger?.actions || {}).filter((a) => a.jobId === job.id && (a.state === "pending" || (a.state === "approved" && !(a.expiresAt <= state.now))));
const cooledRoutes = (state) => Object.entries(state.ledger?.routeCooldown || {}).filter(([, until]) => until > state.now).map(([runner, until]) => ({ runner, until }));
const lastOk = (state) => (state.usage || []).filter((u) => u.outcome === "ok" && u.provider !== "ask-keir").map((u) => stamp(u.at)).reduce((a, b) => Math.max(a, b), 0);
const ticketPosts = (state, n) => state.ledger?.ticketPosts?.[n] || [];

function category(state, job) {
  if (job.state === "running") return "progress";
  if (job.state === "queued") return "progress";
  if (job.state === "deferred") return "staff";
  if (pendingActions(state, job).length) return "staff";
  const kind = job.waitingFor?.kind;
  if (kind === "developer_reply") return "staff";
  if (kind === "player_reply") return "player";
  return job.state === "waiting" || job.state === "blocked" ? "other" : "progress";
}

function lastError(state, job) {
  const bad = (state.usage || []).filter((u) => u.job === job.id && u.outcome && u.outcome !== "ok").at(-1);
  const audit = (state.ledger?.audit || []).filter((a) => a.job === job.id && /usage_limit|auth_failure|scan-error|error|failed/.test(a.kind || "")).at(-1);
  const text = `${bad?.error || ""} ${bad?.outcome || ""} ${audit?.kind || ""} ${audit?.error || ""}`;
  if (!bad && !audit) return null;
  const when = ago(state, bad ? stamp(bad.at) : audit.at);
  if (USAGE_LIMIT.test(text)) return `The model provider reported a usage limit (${when}).`;
  if (AUTH_FAILED.test(text)) return `The model login failed (${when}).`;
  if (bad?.outcome === "timeout") return `The model did not answer in time (${when}).`;
  if (bad?.outcome === "interrupted") return `The last activation was interrupted, probably by a restart (${when}).`;
  if (bad) return `The last activation ended with an error (${clean(bad.outcome)}, ${when}).`;
  return `Keir logged a problem (${clean(audit.kind).slice(0, 60)}, ${when}).`;
}

// Why is this task not moving, and who or what has to act.
function diagnose(state, job) {
  const n = ticketOf(job), pend = pendingActions(state, job), route = job.provider?.runner;
  const cool = cooledRoutes(state).find((c) => c.runner === route);
  const since = job.waitingFor?.since || touched(job);
  const dur = span(state.now - since);
  if (state.ledger?.paused) return { step: "Keir is paused", waits: "someone to resume it", help: "A junior dev or dev can run /keir resume." };
  if (job.state === "running") {
    const run = state.now - (job.startedAt || touched(job));
    if (run > 20 * 60000) return { step: `running an activation for ${span(run)}`, waits: "a model reply or a tool that has not come back", help: "That is longer than normal. A dev can check the operator; a nudge or restart usually clears it." };
    return { step: `working on it now (${span(run)})`, waits: "nothing, it is moving", help: "Nothing to do." };
  }
  if (pend.length) {
    const who = "the owner";
    return { step: `holding a repair for approval (${dur})`, waits: `an approval from ${who}${pend.some((a) => a.state === "approved") ? ", approved but not run yet" : ""}${cool ? `; its model route (${clean(route)}) is also capped for ${span(cool.until - state.now)}` : ""}`, help: `Ask ${who} to answer the approval card. Nothing runs until they do.${cool ? " The cap clears on its own, or a dev can pick another model." : ""}` };
  }
  if (job.state === "queued") {
    if (cool) return { step: `queued for ${dur}`, waits: `its model route (${clean(route)}) to cool down: provider cap or rate limit, ${span(cool.until - state.now)} left`, help: "It resumes on its own, or moves to a fallback route. A dev can pick another model." };
    return { step: `queued for ${dur}`, waits: "a free worker slot", help: "It starts by itself. If this stays long, a dev can check the queue." };
  }
  if (job.state === "deferred") return { step: `handed to staff (${dur})`, waits: "a person on staff to handle the ticket", help: "A moderator or dev should reply in the ticket." };
  const kind = job.waitingFor?.kind;
  if (kind === "player_reply") return { step: `waiting for the player (${dur})`, waits: "the player's answer", help: "Nothing on our side. If it is urgent, ping the player in the ticket." };
  if (kind === "developer_reply") return { step: `waiting for a developer (${dur})`, waits: "a developer's answer", help: "A developer should answer in the ticket." };
  if (job.turnWatch) return { step: `watching for the next game turn (${dur})`, waits: "the next turn to finish", help: "It wakes after the turn. A dev can check turn status if turns look stuck." };
  if (Object.keys(job.ciWatch || {}).length) return { step: `watching a build or deploy (${dur})`, waits: "checks or a deploy to finish", help: "It wakes when they finish. A dev can look at the PR checks." };
  if (job.promotionHoldUntil > state.now) return { step: `holding for a release freeze (${dur})`, waits: `the hold to end in ${span(job.promotionHoldUntil - state.now)}`, help: "It continues by itself." };
  if (["waiting", "blocked"].includes(job.state)) {
    if (cool) return { step: `${job.state} for ${dur}`, waits: `its model route (${clean(route)}) to cool down, ${span(cool.until - state.now)} left`, help: "It resumes on its own, or a dev can pick another model." };
    const wake = job.wakeAt > state.now ? ` It looks again in ${span(job.wakeAt - state.now)}.` : "";
    return { step: `${job.state} for ${dur}`, waits: job.state === "blocked" ? "a fix for what blocked it" : "its scheduled recheck", help: `${job.state === "blocked" ? "A dev should read the last error and unblock it. " : ""}A nudge makes it look again.${wake}` };
  }
  return { step: `${job.state} (${dur})`, waits: "nothing recorded", help: n ? "Nothing to do." : "" };
}

function doctor(state, ticket) {
  const n = Number(ticket) || 0;
  if (!n) {
    const jobs = jobsOf(state).filter(open), queued = jobs.filter((j) => j.state === "queued"), waiting = jobs.filter((j) => j.state === "waiting" || j.state === "blocked");
    const oldest = waiting.slice().sort((a, b) => touched(a) - touched(b))[0];
    const cooled = cooledRoutes(state);
    const lines = [
      `Keir is ${state.active ? (state.killSwitch ? `STOPPED by the kill switch (${state.killSwitch.reason})` : state.ledger?.paused ? "on but paused" : "on") : "OFF (the service is not running)"}${state.release ? `, release ${clean(String(state.release).split(/\s+/).filter((x) => !/^[0-9a-f]{12,}$/.test(x)).join(" ") || state.release)}` : ""}.`,
      `${queued.length} queued, ${jobs.length} open tickets in all.`,
      oldest ? `Oldest waiting: ticket ${ticketOf(oldest)}, ${span(state.now - touched(oldest))}.` : "Nothing is waiting.",
      cooled.length ? `Provider: ${cooled.map((c) => `${clean(c.runner)} is capped for another ${span(c.until - state.now)}`).join("; ")}.` : "Provider: no route is capped.",
      `Last successful answer: ${ago(state, lastOk(state))}.`,
    ];
    if (!state.active) lines.push("A developer can bring it back once it is cleared to run.");
    return cap(lines.join("\n"));
  }
  const jobs = jobsOf(state).filter((j) => ticketOf(j) === n).sort((a, b) => touched(b) - touched(a));
  if (!jobs.length) return `Keir has no task on ticket ${n}. It may never have seen it, or the record is gone.`;
  const job = jobs.find(open) || jobs[0];
  if (!open(job)) return cap(`Keir finished its work on ticket ${n} (${clean(job.state)}, ${ago(state, touched(job))}). Nothing is pending.`);
  const d = diagnose(state, job), err = lastError(state, job);
  const lines = [`Ticket ${n}: ${!state.active ? "Keir is OFF. " : state.killSwitch ? `Keir is stopped by the kill switch (${state.killSwitch.reason}), so nothing runs until a developer releases it. ` : ""}${d.step}.`, `Waiting on: ${state.killSwitch && state.active ? "the kill switch to be released" : d.waits}.`];
  if (err) lines.push(`Last error: ${err}`);
  if (state.killSwitch) lines.push("What you can do: a developer reviews why it stopped, then releases the kill switch; queued work then starts by itself.");
  else if (d.help) lines.push(`What you can do: ${d.help}`);
  return cap(lines.join("\n"));
}

function status(state) {
  const jobs = jobsOf(state).filter(open);
  const by = (c) => jobs.filter((j) => category(state, j) === c).length;
  const latest = (state.usage || []).filter((u) => u.model).at(-1);
  const route = jobs.map((j) => j.provider).filter(Boolean).at(-1);
  const model = clean(route?.model || latest?.model || "unknown"), provider = clean(route?.runner || latest?.provider || "unknown");
  return cap([
    `Keir is ${state.active ? (state.killSwitch ? `STOPPED by the kill switch (${state.killSwitch.reason})` : state.ledger?.paused ? "on but paused" : "on") : "OFF"}${state.release ? `, release ${clean(String(state.release).split(/\s+/).filter((x) => !/^[0-9a-f]{12,}$/.test(x)).join(" ") || state.release)}` : ""}.`,
    `Model: ${model} via ${provider}.`,
    `Open tickets: ${jobs.length}. In progress: ${by("progress")}. Waiting on staff: ${by("staff")}. Waiting on the player: ${by("player")}.${by("other") ? ` Parked or blocked: ${by("other")}.` : ""}`,
  ].join("\n"));
}

function waiting(state) {
  const rows = jobsOf(state).filter(open).map((j) => ({ j, c: category(state, j) })).filter((r) => r.c === "staff" || r.c === "player")
    .sort((a, b) => touched(a.j) - touched(b.j));
  if (!rows.length) return "No ticket is waiting on a person right now.";
  const lines = rows.map(({ j, c }) => {
    const who = pendingActions(state, j).length ? "the owner (approval)" : j.state === "deferred" ? "staff" : c === "player" ? "the player" : "a developer";
    return `Ticket ${ticketOf(j)}: ${who}, since ${span(state.now - (j.waitingFor?.since || touched(j)))} ago`;
  });
  const out = [`${rows.length} waiting on a person:`];
  let size = out[0].length;
  for (let i = 0; i < lines.length; i++) {
    if (size + lines[i].length + 30 > MAX) { out.push(`...and ${lines.length - i} more.`); break; }
    out.push(lines[i]); size += lines[i].length + 1;
  }
  return cap(out.join("\n"));
}

function why(state, ticket) {
  const n = Number(ticket) || 0;
  if (!n) return "Give a ticket number.";
  const ids = new Set(jobsOf(state).filter((j) => ticketOf(j) === n).map((j) => j.id));
  const ev = [];
  for (const p of ticketPosts(state, n)) {
    const from = /^\s*from:[^\n]{0,80}/im.exec(p.text || "")?.[0] || clean(p.text).slice(0, 70);
    ev.push({ at: p.at, line: `posted${p.kind ? ` (${clean(p.kind)})` : ""}: ${clean(from)}` });
  }
  for (const a of state.ledger?.audit || []) {
    if (!(a.ticket === n || ids.has(a.job))) continue;
    const kind = String(a.kind || "");
    if (/refus/i.test(kind)) {
      // Say what was refused in a few words: the tool and the start of the refusal, not the audit kind.
      const what = clean(a.error || a.reason || a.why || "").replace(/^Not (?:posted|finished):\s*/i, "").split(/[.;:]/)[0].slice(0, 70);
      ev.push({ at: a.at, line: `refused${a.tool ? ` ${clean(a.tool).replace(/_/g, " ")}` : ""}: ${what || clean(kind).replace(/_/g, " ")}` });
    }
    else if (/escalat|raise|handoff|investigation_dispatched/i.test(kind)) ev.push({ at: a.at, line: `escalated: ${clean(kind.replace(/[_-]/g, " "))}` });
  }
  if (!ev.length) return `Nothing recorded for ticket ${n} in the last day.`;
  ev.sort((a, b) => a.at - b.at);
  // Repeats in a row collapse into one line with a count, so a refusal loop reads as one event.
  const rows = [];
  for (const e of ev) { const last = rows.at(-1); if (last && last.line === e.line) { last.n++; last.at = e.at; } else rows.push({ ...e, n: 1 }); }
  return cap([`Ticket ${n}, newest last:`, ...rows.slice(-12).map((e) => `${ago({ now: state.now }, e.at)}: ${e.line}${e.n > 1 ? ` (x${e.n})` : ""}`)].join("\n"));
}

module.exports = { doctor, status, waiting, why };
