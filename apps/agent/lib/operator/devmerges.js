"use strict";
const { GAME_REPO } = require("./github");
// Owner, 2026-10-14: when a developer (Ariane, another session, anyone but
// Keir's own ticket work) ships a change related to an open ticket, Keir
// reports it in that ticket's channel. This watches merged AHDGame pull
// requests, links each to the open tickets it names or plainly matches, and
// tells the ticket task at each stage: development, sandbox, main server.
const REPO = GAME_REPO;
const STAGES = [["development", "in testing on dev"], ["staging", "on the sandbox"], ["main", "live on the main server"]];
const PROMOTE_HEADS = new Set(["development", "staging", "main"]);
// Jev judges whether a change works on a ticket's problem. Calibrated on
// 2026-10-14 merges: true pairs scored 0.46 to 0.78, unrelated ones 0.30 or less.
const RELATED = 0.4;
const MAX_LINKS = 2; // a change that is not named wakes at most two tickets
const JEV = "/root/bin/lib/jev.mjs";
const defaultAsk = (spec) => (process.env.KEIR_JEV === "off" ? Promise.resolve(null) : import(JEV).then((m) => m.ask(spec)));

function createDevMerges({ ledger, api, ask = defaultAsk, now = () => Date.now(), log = () => {} }) {
  const d = ledger.data;
  const openTickets = () => Object.values(d.jobs).filter((j) => j.kind === "ticket" && j.ticket && !["done", "dismissed", "cancelled"].includes(j.state));
  const ownPrs = () => new Set(Object.values(d.jobs).flatMap((j) => (j.pullRequests || []).map((u) => Number(String(u).split("/").pop()))));
  const ticketText = (j) => [String(j.evidenceText || "").slice(0, 600), j.summary].filter(Boolean).join(" ").slice(0, 900);

  // The watch read GitHub itself: a change that names the ticket is a receipt for the stage
  // it reached, the same receipt github where would leave. Without it the line this watch asks
  // for ("a fix is in testing on dev") was refused by the release-claim guard, and the refused
  // reply then blocked finish (KBX5 quiet-wait, 2026-11-03). Unnamed changes get no receipt.
  function receipt(job, sha, stage) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha || "")) return;
    const key = String(sha).slice(0, 10), prior = job.releaseEvidence?.[key] || {};
    (job.releaseEvidence ||= {})[key] = { ...prior, at: now(), development: true, staging: prior.staging === true || stage >= 1, main: prior.main === true || stage >= 2,
      repository: prior.repository || "AHDGame", turnWorker: prior.turnWorker === true, source: prior.source || "dev-merges" };
  }
  function tell(job, text) {
    (job.inbox ||= []).push({ authorId: "dev-merges", role: "system", content: text, at: new Date(now()).toISOString() });
    if (["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
  }

  async function link(pr) {
    const body = `${pr.title}\n${String(pr.body || "").slice(0, 1200)}`;
    const tickets = openTickets();
    const named = tickets.filter((j) => new RegExp(`\\b(?:ticket|tickets)\\s*#?\\s*(?:\\d+\\s*(?:,|and)\\s*#?\\s*)*${j.ticket}\\b`, "i").test(body));
    if (named.length) return named.map((job) => ({ job, named: true }));
    if (!tickets.length) return [];
    const questions = Object.fromEntries(tickets.map((j) => [`t${j.ticket}`, { type: "noul", instructions: `Does this merged code change alter or fix the problem in ticket #${j.ticket}? Ticket #${j.ticket}: ${ticketText(j)}`.slice(0, 1200),
      criteria: { true: "The change works on the same broken behaviour, rule or system the ticket reports, so the player would notice it.", false: "A different part of the game, or only loosely related." } }]));
    const out = await ask({ state: { change: body }, questions, timeoutMs: 8000 }).catch(() => null);
    if (!out?.answers) return [];
    return tickets.map((job) => ({ job, p: Number(out.answers[`t${job.ticket}`]?.noul) })).filter((x) => Number.isFinite(x.p) && x.p >= RELATED)
      .sort((a, b) => b.p - a.p).slice(0, MAX_LINKS).map(({ job }) => ({ job, named: false }));
  }

  async function stageOf(sha) {
    let stage = 0;
    for (let i = 1; i < STAGES.length; i++) {
      const c = await api([`repos/${REPO}/compare/${sha}...${STAGES[i][0]}`]).catch(() => null);
      if (c && ["ahead", "identical"].includes(c.status)) stage = i; else break;
    }
    return stage;
  }

  async function tick() {
    d.devMerges ||= { since: new Date(now() - 3600000).toISOString(), links: {} };
    const state = d.devMerges;
    const prs = (await api([`repos/${REPO}/pulls?state=closed&base=development&sort=updated&direction=desc&per_page=40`])) || [];
    const mine = ownPrs();
    let newest = state.since;
    for (const pr of prs) {
      if (!pr.merged_at || pr.merged_at <= state.since) continue;
      if (pr.merged_at > newest) newest = pr.merged_at;
      if (PROMOTE_HEADS.has(pr.head?.ref) || /\[bot\]$/.test(pr.user?.login || "") || mine.has(pr.number) || state.links[pr.number]) continue;
      const matches = await link(pr);
      if (!matches.length) continue;
      state.links[pr.number] = { title: pr.title, author: pr.user?.login, sha: pr.merge_commit_sha, stage: 0, tickets: matches.map((m) => m.job.ticket), named: matches.filter((m) => m.named).map((m) => m.job.ticket), at: now() };
      for (const { job, named } of matches) {
        if (named) receipt(job, pr.merge_commit_sha, 0);
        tell(job, `A developer change was merged (PR #${pr.number} by ${pr.user?.login}: "${pr.title}"). ${named ? "It names this ticket." : "It looks related to this ticket; check before saying so."} If it changes or fixes what the player reported, tell them in one plain line that a fix is ${STAGES[0][1]}, without PR numbers. If it is unrelated, say nothing. You will hear again as it reaches the sandbox and the main server.`);
        ledger.audit("dev_merge_linked", { pr: pr.number, ticket: job.ticket, named });
      }
    }
    state.since = newest;
    // Stage moves for linked changes still short of the main server.
    for (const [number, l] of Object.entries(state.links)) {
      if (l.stage >= STAGES.length - 1) { if (now() - l.at > 14 * 86400000) delete state.links[number]; continue; }
      const stage = await stageOf(l.sha);
      if (stage <= l.stage) continue;
      l.stage = stage;
      for (const t of l.tickets) {
        const job = openTickets().find((j) => j.ticket === t);
        if (job && l.named?.includes(t)) receipt(job, l.sha, stage);
        if (job) tell(job, `The developer change "${l.title}" is now ${STAGES[stage][1]}. If you told the player about it, update them in one plain line; if it was unrelated, say nothing.${stage === STAGES.length - 1 ? " Once it is live, verify the reported behaviour before calling it fixed." : ""}`);
      }
      ledger.audit("dev_merge_stage", { pr: Number(number), stage: STAGES[stage][0] });
    }
    ledger.save();
  }
  return { tick, link };
}

module.exports = { createDevMerges, STAGES };
