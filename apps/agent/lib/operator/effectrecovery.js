"use strict";
// Keir 5.6.3: settle uncertain GitHub merge receipts from GitHub itself.
// A merge call that errors after GitHub accepted it ("Merge already in
// progress", a timeout) left its effect "started" forever. That held the task
// for owner inspection, and every guard that skips in-flight writes (spin
// guard, handoff watch, shutdown) then ignored the task: ticket 1578 carried
// one from 05:14 to 13:23 UTC on 2026-10-16 for a PR that had merged.
// A merge key names the PR and its exact head, so the outcome is checkable:
// merged at that head is done; still open at that head, or closed, is a merge
// that did not happen. Anything else stays held. This never merges.
//
// Keir 7.0.3: compensation payments are settled the same way. heal-ops marks
// each paid corporation, so a fresh dry run of the same payment reports
// nobody still owed once it has landed (ticket 1730, 2026-11-01: a
// $1,306,621 credit succeeded, the call timed out, and the task sat "stuck"
// in the owner's app for an hour). Still owed means it did not land and a
// later approved call may run it. Anything else stays held. This never pays.
//
// Keir 8: uncertain public writes are settled the same way. A write that can
// be read back carries a small "settle" descriptor on its receipt (a reply's
// text, an issue's or ticket's hidden marker). Settling is only ever a READ:
// found means done, provably absent means a retry is safe, anything else stays
// held and is audited once. Nothing here posts, files or creates.
const { repositoryName } = require("./github");
const heal = require("../heal");
const MERGE_KEY = /^merge:(\d+):([0-9a-f]{40})$/;
const ACTION_KEY = /^action:([0-9a-f]+)$/;
const compensationAction = (d, key) => { const id = ACTION_KEY.exec(key)?.[1]; const a = id && d.actions?.[id]; return a?.kind === "heal" && a.args?.spec?.kind === "compensation" ? a : null; };
const SETTLE_MS = 10 * 60000;
const norm = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
const flat = (x) => norm(x).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const POSTED = new Set(["posted", "sent", "delivered", "already_posted"]);
const REPOS = ["AHDGame", "AHDClient"];

function createEffectRecovery({ ledger, api, mcp = null, now = () => Date.now(), running = () => false, log = () => {} }) {
  const d = ledger.data;
  async function settle(job, key, e, number, head) {
    for (const name of REPOS) {
      let pr;
      try { pr = await api(`repos/${repositoryName(name)}/pulls/${number}`); } catch { continue; }
      if (pr?.head?.sha !== head) continue; // another repo's PR with this number
      if (pr.merged) {
        job.effects[key] = { ...e, state: "done", at: now(), result: { merged: true, sha: pr.merge_commit_sha, reconciled: true } };
        return "merged";
      }
      if (pr.state === "closed" || (pr.state === "open" && !pr.merged)) {
        // Verified not merged: a later call may try again.
        job.effects[key] = { ...e, state: "rejected", at: now(), error: `verified not merged (${pr.state}): ${String(e.error || "").slice(0, 200)}` };
        return "not-merged";
      }
    }
    return null;
  }
  async function settlePayment(job, key, e, action) {
    if (!mcp) return null;
    let plan;
    try { const call = heal.planCall(action.args.spec, "Keir effect recovery (dry run)"); plan = await mcp.call("heal-ops", call.name, call.args, false); } catch { return null; }
    // Only an explicit dry-run answer counts; a failed or empty call proves nothing.
    if (!plan || plan.ok === false || !plan.plan || !Number.isFinite(Number(plan.plan.affected))) return null;
    const owed = Number(plan.plan.affected);
    if (owed === 0) {
      job.effects[key] = { ...e, state: "done", at: now(), result: { paid: true, reconciled: true } };
      action.state = "done";
      return "paid";
    }
    if (owed === action.args.affected) {
      job.effects[key] = { ...e, state: "rejected", at: now(), error: `verified not paid: ${String(e.error || "").slice(0, 200)}` };
      return "not-paid";
    }
    return null;
  }
  // Reads whether a public reply is in the ticket's own record. Exact text only:
  // a near match (edited, truncated) proves nothing either way.
  async function settleReply(job, key, e) {
    if (!mcp) return { held: "no support connection" };
    const s = e.settle;
    let t; try { t = await mcp.call("support", "support_get", { kind: "ticket", number: Number(s.ticket) }, false); } catch { return { held: "ticket read failed" }; }
    if (!t || !Array.isArray(t.publicUpdates)) return { held: "ticket read gave no update list" };
    const want = norm(s.text);
    if (!want) return { held: "no text recorded" };
    const rows = t.publicUpdates.filter((u) => u && u.kind !== "heal");
    const exact = rows.find((u) => norm(u.message) === want);
    if (exact) {
      if (!POSTED.has(exact.delivery?.status)) return { held: `recorded on the ticket but delivery is ${exact.delivery?.status || "unknown"}` };
      job.effects[key] = { ...e, state: "done", at: now(), result: { ok: true, reconciled: true, delivery: exact.delivery } };
      return { outcome: "posted" };
    }
    const head = flat(want).slice(0, 40);
    if (rows.some((u) => { const m = flat(u.message); return m && (m.includes(head) || (m.length >= 20 && flat(want).includes(m))); })) return { held: "a similar but not identical update exists" };
    job.effects[key] = { ...e, state: "rejected", retryable: true, at: now(), error: `verified not posted: ${String(e.error || "").slice(0, 200)}` };
    return { outcome: "not-posted" };
  }
  // Reads Keir's own recent issues for the hidden marker the issue body carries.
  async function settleIssue(job, key, e) {
    const s = e.settle;
    let list; try { list = await api(`repos/${repositoryName(s.repo || "AHDGame")}/issues?state=all&sort=created&direction=desc&per_page=50`); } catch { return { held: "issue list read failed" }; }
    if (!Array.isArray(list)) return { held: "issue list read gave no list" };
    const found = list.find((i) => i && !i.pull_request && String(i.body || "").includes(s.marker));
    if (found) {
      job.effects[key] = { ...e, state: "done", at: now(), result: { ...found, reconciled: true } };
      return { outcome: "filed" };
    }
    // Absence only counts when the list reaches back past the write.
    const oldest = list.length ? Date.parse(list[list.length - 1].created_at) : NaN;
    if (!Number.isFinite(oldest) || oldest > (e.at || 0) - 60000) return { held: "issue list does not reach back past the write" };
    job.effects[key] = { ...e, state: "rejected", retryable: true, at: now(), error: `verified not filed: ${String(e.error || "").slice(0, 200)}` };
    return { outcome: "not-filed" };
  }
  // A created ticket carries the source message in its description. Found is
  // settled; a search that finds nothing proves nothing (search lags), so an
  // absent ticket stays held for a person.
  async function settleTicket(job, key, e) {
    if (!mcp) return { held: "no support connection" };
    const s = e.settle;
    let hits; try { hits = await mcp.call("support", "support_search", { query: s.marker, kind: "ticket", limit: 10 }, false); } catch { return { held: "ticket search failed" }; }
    const rows = hits?.results || hits?.items || hits?.tickets;
    if (!Array.isArray(rows)) return { held: "ticket search gave no list" };
    for (const row of rows.slice(0, 5)) {
      const n = Number(row?.number ?? row?.ticketNumber); if (!n) continue;
      let t; try { t = await mcp.call("support", "support_get", { kind: "ticket", number: n }, false); } catch { continue; }
      if (!String(t?.description || "").includes(s.marker)) continue;
      const channelId = t.conversation?.channelId || t.discordChannelId || t.channelId;
      if (s.needsChannel && !channelId) return { held: `ticket ${n} exists but its channel is not readable` };
      job.effects[key] = { ...e, state: "done", at: now(), result: { ok: true, reconciled: true, ticketNumber: n, number: n, ...(channelId ? { channelId } : {}) } };
      return { outcome: "created", ticket: n };
    }
    return { held: "no ticket with the marker found; search is not proof of absence" };
  }
  async function settleWrite(job, key, e) {
    const kind = e.settle?.kind;
    if (kind === "reply") return settleReply(job, key, e);
    if (kind === "issue") return settleIssue(job, key, e);
    if (kind === "ticket") return settleTicket(job, key, e);
    return { held: "unknown settle kind" };
  }
  async function tick() {
    let changed = false;
    for (const job of Object.values(d.jobs)) {
      if (running(job)) continue;
      const uncertain = Object.entries(job.effects || {}).filter(([k, e]) => e?.state === "started" && (MERGE_KEY.test(k) || compensationAction(d, k) || e.settle?.kind) && now() - (e.at || 0) >= SETTLE_MS);
      for (const [key, e] of uncertain) {
        const merge = MERGE_KEY.exec(key);
        if (e.settle?.kind && !merge) {
          const r = await settleWrite(job, key, e);
          if (r.outcome) {
            changed = true;
            ledger.audit("effect_reconciled", { job: job.id, key, outcome: r.outcome, ...(r.ticket ? { ticket: r.ticket } : {}) });
            log(`effect recovery: ${job.id} ${key} ${r.outcome}`);
          } else if (e.settleHeld !== r.held) {
            // One audit row per distinct reason, so a held receipt is explained without a row every pass.
            e.settleHeld = r.held; changed = true;
            ledger.audit("effect_settle_held", { job: job.id, key, reason: r.held });
          }
          continue;
        }
        const outcome = merge ? await settle(job, key, e, Number(merge[1]), merge[2]) : await settlePayment(job, key, e, compensationAction(d, key));
        if (!outcome) continue;
        changed = true;
        ledger.audit("effect_reconciled", { job: job.id, key, outcome });
        log(`effect recovery: ${job.id} ${key} ${outcome}`);
      }
      // A task held only for receipt inspection resumes once nothing is uncertain.
      if (uncertain.length && job.state === "blocked" && !Object.values(job.effects || {}).some((x) => x?.state === "started")) {
        (job.inbox ||= []).push({ role: "system", authorId: "effect-recovery", at: new Date(now()).toISOString(),
          content: "The uncertain receipt on this task was checked against GitHub, heal-ops or the support record and settled (see effect_reconciled). A write found there (payment, reply, issue, ticket) is not repeated; do not repeat a merge that is already done. Re-read the current state, then continue from your last checkpoint." });
        job.state = "queued"; changed = true;
      }
    }
    if (changed) ledger.save();
  }
  return { tick };
}
module.exports = { createEffectRecovery, MERGE_KEY, SETTLE_MS, compensationAction };
