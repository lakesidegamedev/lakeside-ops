"use strict";
// Keir 10: optional Sentry output over plain HTTPS (envelope endpoint, no dependency). Off unless KEIR_SENTRY_DSN is set.
const crypto = require("node:crypto");
const https = require("node:https");
const http = require("node:http");

function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.split("/").filter(Boolean).pop();
    if (!u.username || !projectId) return null;
    const prefix = u.pathname.split("/").filter(Boolean).slice(0, -1).join("/");
    return { key: u.username, protocol: u.protocol, host: u.host, projectId, url: `${u.protocol}//${u.host}${prefix ? `/${prefix}` : ""}/api/${projectId}/envelope/` };
  } catch { return null; }
}
function buildEnvelope(dsn, event, now = new Date()) {
  const id = crypto.randomUUID().replace(/-/g, "");
  const body = { event_id: id, timestamp: now.toISOString(), platform: "node", ...event };
  return `${JSON.stringify({ event_id: id, sent_at: now.toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(body)}\n`;
}
function createSentry({ dsn, release = null, post = defaultPost, log = () => {} } = {}) {
  const p = dsn ? parseDsn(dsn) : null;
  if (!p) return null;
  const send = async (event) => {
    try { await post(p, buildEnvelope(p, { release, ...event })); } catch (e) { log(`sentry: ${e.message}`); }
  };
  const tagsOf = (f) => ({ class: f.class, kind: f.kind, lane: f.lane, provider: f.provider, model: f.model });
  return {
    captureException: (err, tags = {}) => send({ level: "error", exception: { values: [{ type: err?.name || "Error", value: String(err?.message || err).slice(0, 500) }] }, tags }),
    captureAlert: (a, text) => send({ level: a.type === "REGRESSION" ? "warning" : "error", message: text.title, fingerprint: [a.fingerprint], tags: { alert: a.type, ...(a.group ? tagsOf(a.group) : { class: a.cls }) }, extra: { detail: text.detail.slice(0, 4000) } }),
  };
}
function defaultPost(p, envelope) {
  return new Promise((resolve, reject) => {
    const mod = p.protocol === "http:" ? http : https;
    const req = mod.request(p.url, { method: "POST", timeout: 8000, headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${p.key}, sentry_client=keir-failures/1` } }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject); req.end(envelope);
  });
}
module.exports = { parseDsn, buildEnvelope, createSentry };
