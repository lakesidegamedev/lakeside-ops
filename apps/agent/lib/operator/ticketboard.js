"use strict";
const { ticketOf, TERMINAL } = require("./workrecord");
const { keyFor } = require("./ticketoutcomes");

// Staff ticket board: one plain row per open ticket, built from the ledger only
// (jobs, ticketPosts, ticketOutcomes, actions, decisions, status cards). No model
// calls, no player Discord ids, no Keir findings or summaries.
const NO_ANSWER_MS = 2 * 3600000;
const WORKING = ["done", "blocked", "dismissed", "cancelled"];
const ms = (v) => { const n = typeof v === "number" ? v : Date.parse(v || ""); return Number.isFinite(n) && n > 0 ? n : 0; };
const clip = (text, n) => { const t = String(text || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const isCardPost = (p) => (p.kind ? p.kind === "status_card" : String(p.text || "").startsWith("[status card]"));
const nameOf = (author) => clip(typeof author === "string" ? author : author?.global_name || author?.username || author?.name || "", 60) || null;

function playerQuestion(jobs) {
  const first = jobs.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const job of first) {
    const mail = (job.inbox || []).find((m) => m.role !== "system" && !/^(?:handoff|system|keir)/i.test(String(m.authorId || "")) && m.content);
    const text = job.source?.content && !/^Ticket \d+ was explicitly reopened|^Ticket \d+ handed off/.test(job.source.content) ? job.source.content : mail?.content;
    if (text) return clip(text, 160);
  }
  return null;
}

function classify(data, members, card, now) {
  const ids = new Set(members.map((j) => j.id));
  const live = members.filter((j) => !TERMINAL.includes(j.state));
  const decisions = Object.values(data.decisions || {}).some((x) => ids.has(x.jobId) && x.state === "pending");
  const approvals = Object.values(data.actions || {}).some((x) => ids.has(x.jobId) && x.state === "pending");
  const waitKind = (live.find((j) => j.state === "waiting" && j.waitingFor)?.waitingFor?.kind) || "";
  const prs = live.some((j) => (j.pullRequests || []).length || Object.keys(j.ciWatch || {}).length || j.codingParent);
  const investigating = live.some((j) => (j.investigations || []).some((id) => data.jobs[id] && !WORKING.includes(data.jobs[id].state)));
  const stages = (card?.items || []).map((i) => i.stage);
  if (decisions || approvals) return { state: "waiting on the owner", next: "Owner decision or approval needed", owner: "owner" };
  if (stages.length && stages.every((s) => s === "confirmed")) return { state: "fix live and checked", next: "Keir confirms with the player and closes", owner: "Keir" };
  if (live.some((j) => j.state === "blocked") || waitKind === "developer_reply" || live.some((j) => j.state === "deferred" || j.staffActiveUntil > now))
    return { state: "waiting on a developer", next: "A developer or staff member acts next", owner: "developer" };
  if (prs || stages.some((s) => ["written", "tested", "sandbox", "main"].includes(s)))
    return { state: "fix being built", next: stages.includes("main") ? "Check the live fix in game" : "Finish tests and release the fix", owner: "Keir" };
  if (["player_reply", "player"].includes(waitKind)) return { state: "waiting on the player", next: "Player replies", owner: "player" };
  if (investigating || stages.includes("found")) return { state: "investigating", next: "Find the cause and tell the player", owner: "Keir" };
  if (live.some((j) => j.state === "running" || j.state === "queued")) return { state: "answering", next: "Keir answers the player", owner: "Keir" };
  return { state: "investigating", next: "Keir picks it up at the next check", owner: "Keir" };
}

function ticketBoard(data, { now = Date.now(), guildId = null } = {}) {
  const groups = new Map();
  for (const job of Object.values(data.jobs || {})) {
    if (job.internalProbe || job.kind === "notice") continue;
    const n = Number(ticketOf(job));
    if (!n || job.role === "owner") continue;
    (groups.get(n) || groups.set(n, []).get(n)).push(job);
  }
  const tickets = [];
  for (const [number, members] of groups) {
    if (members.every((j) => TERMINAL.includes(j.state))) continue;
    const root = members.filter((j) => j.kind === "ticket").sort((a, b) => (b.at || 0) - (a.at || 0))[0] || members[0];
    const outcome = data.ticketOutcomes?.[keyFor(root)];
    if (outcome && ["resolved", "closed"].includes(outcome.status) && outcome.receiptId && !outcome.superseded) continue;
    const posts = (data.ticketPosts?.[number] || []).filter((p) => !isCardPost(p));
    const lastPlayerAt = Math.max(0, ...members.map((j) => Math.max(ms(j.observedPlayerAt), ms(j.lastPlayerAt))));
    const lastKeirAnswerAt = Math.max(0, ...posts.map((p) => ms(p.at)), ...members.map((j) => ms(j.lastPublishedAt)));
    const channelId = members.find((j) => j.channelId)?.channelId || members.find((j) => j.source?.channelId)?.source.channelId || null;
    const verdict = classify(data, members, data.statusCards?.[number], now);
    const createdAt = Math.min(...members.map((j) => ms(j.at) || now), ms(outcome?.createdAt) || Infinity);
    const unanswered = lastPlayerAt > lastKeirAnswerAt && now - lastPlayerAt > NO_ANSWER_MS;
    tickets.push({ number, category: data.channels?.[channelId]?.category || null, player: nameOf(root.source?.author),
      ageMs: Math.max(0, now - createdAt), question: playerQuestion(members), ...verdict,
      lastPlayerMessageAt: lastPlayerAt || null, lastKeirAnswerAt: lastKeirAnswerAt || null, noAnswerOver2h: unanswered,
      channelUrl: guildId && channelId ? `https://discord.com/channels/${guildId}/${channelId}` : null,
      activityAt: Math.max(lastPlayerAt, lastKeirAnswerAt, ...members.map((j) => ms(j.updatedAt) || ms(j.at))) });
  }
  tickets.sort((a, b) => b.activityAt - a.activityAt);
  return { generatedAt: now, noAnswerAfterMs: NO_ANSWER_MS, tickets };
}
module.exports = { ticketBoard, NO_ANSWER_MS };
