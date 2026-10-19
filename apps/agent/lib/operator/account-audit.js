"use strict";
const crypto = require("node:crypto");
const INTERVAL = 12 * 3600000;
function createAccountAudit({ ledger, mcp, config = {}, now = Date.now }) {
  const d = ledger.data;
  let busy = false;
  const state = () => { const s = d.accountAudits ||= {}; s.cases ||= {}; return s; };
  function status() {
    const s = state();
    return { enabled: config.accountAuditEnabled !== false, busy, intervalHours: 12, lastAttemptAt: s.lastAttemptAt || null,
      lastCompletedAt: s.lastCompletedAt || null, lastReport: s.lastReport || null,
      uncertain: Object.entries(s.cases).filter(([,c]) => c.state === "started" || c.state === "uncertain").map(([key,c]) => ({ key, ...c })) };
  }
  async function sweep({ dryRun = false } = {}) {
    if (busy) throw new Error("An account audit is already running");
    if (d.paused) throw new Error("Keir is stopped");
    if (config.accountAuditEnabled === false) throw new Error("Account auditing is disabled");
    busy = true;
    const s = state(); s.lastAttemptAt = now(); ledger.save();
    try {
      let audit, cursor, at, pages = 0, sourceTruncated = false;
      const candidates = new Map(), started = now();
      do {
        audit = await mcp.call("support", "support_audit_accounts", cursor ? { cursor, at } : {}, true, AbortSignal.timeout(60000));
        if (!Array.isArray(audit?.candidates) || typeof audit.truncated !== "boolean") throw new Error("Invalid account audit receipt");
        at ||= audit.at; pages++; sourceTruncated ||= audit.sourceTruncated === true;
        for (const c of audit.candidates) {
          c.needsReview = c.needsReview === true && c.reviewBasis?.kind === "corroborated_account_benefit";
          const previous = candidates.get(c.key);
          if (previous) {
            c.signals = [...previous.signals,...c.signals].sort((a,b) => ({high:0,medium:1,low:2}[a.severity] ?? 3) - ({high:0,medium:1,low:2}[b.severity] ?? 3)).slice(0,30);
            c.transactions = [...(previous.transactions || []),...(c.transactions || [])].slice(0,12);
            c.needsReview = previous.needsReview || c.needsReview;
            if (previous.needsReview) { c.reviewBasis = previous.reviewBasis; c.reviewReason = previous.reviewReason; }
          }
          candidates.set(c.key,c);
        }
        cursor = audit.nextCursor;
      } while (cursor && pages < 20 && now() - started < 240000 && !d.paused);
      audit.candidates = [...candidates.values()];
      audit.truncated = sourceTruncated || Boolean(cursor) || audit.truncated && !audit.nextCursor;
      if (!dryRun && audit.filingConfigured === false) throw new Error("Investigation staff roles, credentials or game API support are unavailable; preview remains available");
      const review = audit.candidates.filter(c => c.needsReview).sort((a,b) => Number(Boolean(s.cases[a.key])) - Number(Boolean(s.cases[b.key])));
      const report = { at, pages, dryRun, candidates: audit.candidates.length, review: review.length, truncated: audit.truncated,
        opened: [], existing: [], uncertain: [], deferred: 0, signals: {} };
      for (const c of audit.candidates) for (const type of new Set(c.signals.map(f => f.type))) report.signals[type] = (report.signals[type] || 0) + 1;
      let filings = 0;
      for (const c of review) {
        if (dryRun) continue;
        if (d.paused) { report.deferred++; continue; }
        const signature = crypto.createHash("sha256").update(JSON.stringify([c.signals, c.transactions])).digest("hex");
        const prior = s.cases[c.key];
        if (prior?.state === "done" && prior.signature === signature) { report.existing.push({ key: c.key, ticketNumber: prior.ticketNumber }); continue; }
        if (prior && prior.state !== "done") { report.uncertain.push(c.key); continue; }
        if (filings >= 5) { report.deferred++; continue; }
        filings++;
        // Persist BEFORE the external write. A crash or ambiguous response is
        // held for receipt inspection, never automatically replayed.
        s.cases[c.key] = { state: "started", at: now() }; ledger.save();
        try {
          const result = await mcp.call("support", "support_create_investigation", { key: c.key }, true, AbortSignal.timeout(120000));
          if (!result?.ok || !Number.isSafeInteger(result.ticketNumber) || !result.channelId) throw new Error("Missing investigation delivery receipt");
          s.cases[c.key] = { state: "done", signature, at: now(), ticketNumber: result.ticketNumber, channelId: result.channelId };
          (result.duplicate ? report.existing : report.opened).push({ key: c.key, ticketNumber: result.ticketNumber, channelId: result.channelId });
        } catch (e) {
          s.cases[c.key] = { state: "uncertain", at: now(), error: "Filing needs staff receipt inspection" };
          report.uncertain.push(c.key);
        }
        ledger.save();
      }
      if (!dryRun) s.lastCompletedAt = now(); else s.lastPreviewAt = now();
      s.lastReport = report; ledger.audit("account_audit", { dryRun, candidates: report.candidates, review: report.review, opened: report.opened.length, uncertain: report.uncertain.length, truncated: report.truncated }); ledger.save();
      return report;
    } finally { busy = false; }
  }
  async function tick() {
    const s = state();
    if (busy || d.paused || config.accountAuditEnabled === false || s.lastCompletedAt && now() - s.lastCompletedAt < INTERVAL || s.lastAttemptAt && now() - s.lastAttemptAt < 15 * 60000) return null;
    return sweep();
  }
  return { sweep, tick, status };
}
function reportText(r) {
  return `Account audit ${r.dryRun ? "preview" : "complete"}: ${r.candidates} subjects with sensor observations, ${r.review} ticket-ready cases. ${r.opened.length} investigation tickets opened, ${r.existing.length} already tracked, ${r.deferred} deferred, ${r.uncertain.length} need receipt inspection.${r.truncated ? " Source limits were reached; this is a partial sweep." : ""}\n` + r.opened.map(t => `Investigation #${t.ticketNumber}`).join("\n");
}
module.exports = { createAccountAudit, reportText, INTERVAL };
