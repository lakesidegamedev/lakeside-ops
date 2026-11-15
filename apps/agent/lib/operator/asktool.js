"use strict";
// Keir 10 (W3): the Ask bridge.
//
// In November Ask refused nearly every question and Keir kept sending players to
// it, then flip-flopped about whether it was fixed. The `ask` tool answers three
// things from Ask itself:
//   health  is Ask answering, and what share of the last day's answers were refusals
//   history what Ask told this ticket's reporter recently (reporter only)
//   query   ask Ask a question as the support desk and read the answer (never posted)
// health and history call two read-only endpoints on the Ask service
// (/api/keir-ask/health and /api/keir-ask/history, same shared secret as the
// existing /api/keir-ask/answer). Without the secret the tool says so and falls
// back to the public /healthz probe, so "is Ask even up" still has an answer.

const { doneEvent } = require("./fastlane");

const TIMEOUT_MS = 20000;
const QUERY_TIMEOUT_MS = 150000;

function createAskTool({ config = {}, fetcher = fetch, resolveIdentity = null, staff = () => false, now = () => Date.now() } = {}) {
  const base = String(config.askUrl || "").replace(/\/+$/, "");
  const secret = config.askSecret || null;

  async function post(route, body, signal, timeoutMs = TIMEOUT_MS) {
    const res = await fetcher(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body || {}), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
    if (!res.ok) throw new Error(`ask ${res.status}`);
    return res;
  }

  async function health(job, input, signal) {
    if (!base) return { reachable: null, status: "unknown", note: "Ask is not configured on this host." };
    let reachable = false;
    try { reachable = (await fetcher(`${base}/healthz`, { signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) })).ok; } catch {}
    if (!reachable) return { reachable: false, status: "down", instruction: "Ask is not answering at all. Do not send the player there; say it is unavailable right now." };
    if (!secret) return { reachable: true, status: "unknown", note: "Ask is up, but its answer quality cannot be read without the shared secret (KEIR_ASK_SECRET)." };
    try {
      const stats = await (await post("/api/keir-ask/health", { hours: Math.min(Math.max(Number(input.hours) || 24, 1), 168) }, signal)).json();
      const instruction = stats.status === "failing" ? `Ask is failing: ${Math.round(stats.refusalRate * 100)}% of its last ${stats.total} answers were refusals. Do not redirect players to Ask; answer from your own reads.`
        : stats.status === "degraded" ? "Ask is refusing a noticeable share of questions. Redirect only after a query check shows it answers this one."
        : stats.status === "quiet" ? "Too few recent Ask answers to judge. Use query to test this question before redirecting." : "Ask is answering normally.";
      return { reachable: true, ...stats, instruction };
    } catch (e) {
      return { reachable: true, status: "unknown", note: `Ask is up, but its statistics could not be read (${String(e.message || e).slice(0, 80)}).` };
    }
  }

  async function history(job, input, signal) {
    if (!secret || !base) return { note: "Ask history is not configured on this host." };
    const keys = [];
    if (staff(job) && Array.isArray(input.userKeys) && input.userKeys.length) keys.push(...input.userKeys.map(String).slice(0, 4));
    else {
      // Reporter only: the ticket's own author, plus the linked game account when it resolves.
      if (!job.ticket) throw new Error("ask history needs an assigned ticket");
      if (/^\d{5,25}$/.test(String(job.source?.authorId || ""))) keys.push(`discord:${job.source.authorId}`);
      const who = resolveIdentity ? await resolveIdentity(job, signal).catch(() => null) : null;
      if (who?.private?.userId) keys.push(`ahd:${who.private.userId}`);
      if (who?.private?.discordId && `discord:${who.private.discordId}` !== keys[0]) keys.push(`discord:${who.private.discordId}`);
    }
    if (!keys.length) return { count: 0, asks: [], note: "No Ask identity could be tied to this reporter." };
    const out = await (await post("/api/keir-ask/history", { userKeys: keys, limit: Math.min(Number(input.limit) || 10, 20), days: Math.min(Number(input.days) || 14, 30) }, signal)).json();
    if (out.error) throw new Error(String(out.error).slice(0, 160));
    const refused = (out.asks || []).filter((a) => a.outcome !== "answered").length;
    return { ...out, refused, instruction: refused ? `${refused} of these Ask turns refused or came back empty. Do not tell the player Ask will answer it; read it yourself or say what you could not confirm.` : "Ask answered these. Say what it told them only if it matters to this ticket." };
  }

  async function query(job, input, signal) {
    if (job.role === "player") throw new Error("players cannot run Ask queries through Keir");
    if (!secret || !base) return { note: "Ask queries are not configured on this host (KEIR_ASK_SECRET)." };
    const question = String(input.question || "").trim().slice(0, 1500);
    if (question.length < 8) throw new Error("query needs the question to put to Ask");
    const res = await post("/api/keir-ask/answer", { question, discordId: String(job.actorId || job.source?.authorId || "keir-desk"), discordUsername: "keir-desk", convId: `keir-query-${job.id || "task"}-${Math.floor(now() / 3600000)}` }, signal, QUERY_TIMEOUT_MS);
    const { done, error } = doneEvent(await res.text());
    if (!done) return { answered: false, error: String(error?.error || error?.message || "no answer").slice(0, 160), instruction: "Ask returned nothing for this question; do not redirect the player to it." };
    const answer = String(done.answer || "").trim();
    const issues = (done.validation?.issues || []).slice(0, 6);
    const refused = !answer || issues.some((i) => /refus|insufficient/.test(i));
    return { answered: !refused, refused, answer: answer.slice(0, 4000), issues, instruction: refused ? "Ask refused or could not ground this. Do not redirect the player to it." : "This is Ask's own answer for the desk. It is not posted anywhere; check it before using it." };
  }

  async function call(job, input, signal) {
    const action = String(input.action || "");
    if (action === "health") return health(job, input, signal);
    if (action === "history") return history(job, input, signal);
    if (action === "query") return query(job, input, signal);
    throw new Error("action must be health, history or query");
  }

  return { call, health };
}

module.exports = { createAskTool };
