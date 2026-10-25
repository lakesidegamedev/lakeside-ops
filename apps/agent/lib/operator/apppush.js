"use strict";
// Push notifications for the owner's Lakeside Ops app: Keir's replies in the
// app thread, open owner decisions, and Watchkeeper incidents. Off unless the
// APNs key is configured. Nothing here ever reaches anyone but registered
// owner devices.
const crypto = require("node:crypto");
const fs = require("node:fs");
const http2 = require("node:http2");
const { describeAlert } = require("./notification-policy");
const { alertKind, threadOf } = require("./appchannel");

function createApns({ teamId, keyId, keyFile, topic, host = "api.push.apple.com", now = () => Date.now(), connect = http2.connect }) {
  if (!teamId || !keyId || !keyFile || !topic) return null;
  let jwt = null, minted = 0, session = null;
  function token() {
    if (jwt && now() - minted < 40 * 60000) return jwt;
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = b({ alg: "ES256", kid: keyId }), claims = b({ iss: teamId, iat: Math.floor(now() / 1000) });
    const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key: fs.readFileSync(keyFile, "utf8"), dsaEncoding: "ieee-p1363" }).toString("base64url");
    jwt = `${head}.${claims}.${sig}`; minted = now();
    return jwt;
  }
  function client() {
    if (session && !session.closed && !session.destroyed) return session;
    session = connect(`https://${host}`);
    session.on("error", () => { session = null; });
    session.on("goaway", () => { session = null; });
    session.setTimeout?.(5 * 60000, () => { session?.close(); session = null; });
    return session;
  }
  function send(deviceToken, payload, { collapseId, priority = 10, pushType = "alert" } = {}) {
    return new Promise((resolve) => {
      let status = 0, body = "";
      const req = client().request({ ":method": "POST", ":path": `/3/device/${deviceToken}`, authorization: `bearer ${token()}`,
        "apns-topic": pushType === "liveactivity" ? `${topic}.push-type.liveactivity` : topic, "apns-push-type": pushType, "apns-priority": String(priority),
        ...(collapseId ? { "apns-collapse-id": String(collapseId).slice(0, 64) } : {}) });
      const timer = setTimeout(() => { req.close(); resolve({ status: 0, reason: "timeout" }); }, 15000);
      req.on("response", (h) => { status = h[":status"]; });
      req.on("data", (c) => { body += c; });
      req.on("end", () => { clearTimeout(timer); let reason = null; try { reason = JSON.parse(body).reason; } catch {} resolve({ status, reason }); });
      req.on("error", (e) => { clearTimeout(timer); resolve({ status: 0, reason: e.message }); });
      req.end(JSON.stringify(payload));
    });
  }
  return { send };
}

const clip = (text, n) => { const s = String(text || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Builds the notifications that are due. Pure over the ledger so it is testable.
function duePushes(d, { now = Date.now() } = {}) {
  const t = threadOf(d);
  const state = t.push ||= { seq: t.seq || 0, decisions: {}, alerts: {}, since: now };
  const out = [];
  for (const m of (t.messages || []).filter((m) => m.role === "keir" && m.seq > state.seq)) {
    // A progress update is a quiet, replaceable notice; a decision already pushes on its own.
    if (m.update) {
      out.push({ key: `reply:${m.seq}`, pref: "replies", collapseId: "keir-updates", mark: () => { state.seq = Math.max(state.seq, m.seq); },
        payload: { aps: { alert: { title: "Keir update", body: clip(m.text.replace(/^- /gm, ""), 240) }, "thread-id": "keir-updates", "interruption-level": "passive" }, route: "keir", thread: "main", seq: m.seq } });
      continue;
    }
    out.push({ key: `reply:${m.seq}`, pref: "replies", mark: () => { state.seq = Math.max(state.seq, m.seq); },
      payload: { aps: { alert: { title: m.watch ? "Keir watch" : "Keir", body: clip(m.text, 240) }, sound: "default", "thread-id": m.thread || "keir", "interruption-level": m.watch ? "time-sensitive" : "active" }, route: "keir", thread: m.thread || "main", seq: m.seq } });
  }
  for (const x of Object.values(d.decisions || {}).filter((x) => x.state === "pending" && !state.decisions[x.id] && x.at >= state.since - 3600000)) {
    out.push({ key: `decision:${x.id}`, pref: "decisions", mark: () => { state.decisions[x.id] = now; },
      payload: { aps: { alert: { title: x.options ? "Keir: choose an option" : "Keir: action approval", body: clip(x.review?.title ? `${x.review.title}: ${x.question}` : x.question, 240) }, sound: "default", "thread-id": "decisions", "interruption-level": "time-sensitive", category: x.options ? "KEIR_CHOICE" : "KEIR_DECISION" }, route: "decision", decision: x.id } });
  }
  for (const a of (d.alerts || []).filter((a) => alertKind(a.key) === "incident" && a.at > state.since && !state.alerts[`${a.key}@${a.at}`])) {
    const notice = describeAlert(a, d, now);
    if (notice.pending) continue;
    state.incidentNotices ||= {};
    const last = state.incidentNotices[notice.identity];
    if (notice.suppressed || notice.cooldown && last && now - last < notice.cooldown) { state.alerts[`${a.key}@${a.at}`] = now; continue; }
    out.push({ key: `incident:${a.key}@${a.at}`, pref: "incidents", group: notice.identity, cooldown: notice.cooldown,
      mark: () => { state.alerts[`${a.key}@${a.at}`] = now; state.incidentNotices[notice.identity] = now; }, collapseId: notice.collapseId,
      payload: { aps: { alert: { title: "Watchkeeper", body: clip(notice.text, 240) }, "thread-id": "incidents", "interruption-level": "passive" }, route: "alerts" } });
  }
  // The morning brief and goal progress from the feed.
  state.feedAt ||= now;
  for (const f of (t.feed || []).filter((f) => f.at > state.feedAt && (f.kind === "brief" || (f.goal && f.kind === "win"))).reverse()) {
    out.push({ key: `feed:${f.id || f.at}`, pref: "feed", mark: () => { state.feedAt = Math.max(state.feedAt, f.at); },
      payload: { aps: { alert: { title: f.kind === "brief" ? "Morning brief" : "Goal progress", body: clip(f.title + (f.body ? `: ${f.body}` : ""), 240) }, sound: f.kind === "brief" ? "default" : undefined, "thread-id": "feed", "interruption-level": f.kind === "brief" ? "active" : "passive" }, route: "feed" } });
  }
  // Answered or expired decisions and old alert marks are forgotten.
  for (const id of Object.keys(state.decisions)) if (d.decisions?.[id]?.state !== "pending" && now - state.decisions[id] > 86400000) delete state.decisions[id];
  for (const [k, at] of Object.entries(state.alerts)) if (now - at > 7 * 86400000) delete state.alerts[k];
  return out;
}

function createAppPush({ ledger, apns, log = () => {}, now = () => Date.now() }) {
  let busy = false;
  async function tick() {
    if (!apns || busy) return;
    busy = true;
    try {
    const t = threadOf(ledger.data);
    // Live Activity tokens are distinct from ordinary device tokens.
    for (const row of [...(t.activities || [])]) {
      if (row.expiresAt <= now()) { t.activities = t.activities.filter(a => a !== row); continue; }
      const state = require("./appcontrols").activityState(ledger.data, now());
      const signature = JSON.stringify([state.status, state.count, state.stopped]);
      if (row.signature === signature && now() - (row.lastSent || 0) < 60000) continue;
      const ended = !state.count || state.stopped;
      const aps = { timestamp: Math.floor(now() / 1000), event: ended ? "end" : "update", "content-state": state, "stale-date": Math.floor(now() / 1000) + 90, ...(ended ? { "dismissal-date": Math.floor(now() / 1000) + 30 } : {}) };
      const result = await apns.send(row.token, { aps }, { pushType: "liveactivity", priority: 5 });
      if (result.status === 200) { row.signature = signature; row.lastSent = now(); }
      if (result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered" || ended && result.status === 200) t.activities = t.activities.filter(a => a !== row);
    }
    // With no device registered, history is marked seen so a first install is not flooded.
    if (!t.devices?.length) { duePushes(ledger.data, { now: now() }).forEach((p) => p.mark()); ledger.save(); return; }
      if (ledger.data.control?.stopped) { duePushes(ledger.data, { now: now() }).forEach(p => p.mark()); ledger.save(); return; }
      for (const p of duePushes(ledger.data, { now: now() }).slice(0, 10)) {
        if (ledger.data.control?.stopped) return;
        // Earlier entries in this tick can satisfy the same monitor group.
        if (p.cooldown && t.push.incidentNotices?.[p.group] && now() - t.push.incidentNotices[p.group] < p.cooldown) { p.mark(); continue; }
        const delivered = (t.push.delivered ||= {});
        const receipts = delivered[p.key] ||= {};
        let retry = false;
        for (const device of [...t.devices]) {
          const deviceId = crypto.createHash("sha256").update(device.token).digest("hex").slice(0, 16);
          if (device.prefs?.[p.pref] === false || receipts[deviceId]) continue;
          const r = await apns.send(device.token, p.payload, { collapseId: p.collapseId, priority: p.pref === "incidents" || p.collapseId === "keir-updates" ? 5 : 10 });
          if (r.status === 200) { receipts[deviceId] = now(); t.push.lastSuccess = now(); }
          else t.push.lastError = { status: r.status, reason: r.reason || "delivery rejected", at: now() };
          if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") { t.devices = t.devices.filter((x) => x.token !== device.token); ledger.audit("app_device_removed", { reason: r.reason || r.status }); }
          else if (r.status !== 200) { retry = true; log(`app push ${p.pref}: ${r.status} ${r.reason || ""}`); }
        }
        if (retry) break; // Do not advance a shared cursor past a failed delivery.
        p.mark(); delete delivered[p.key];
      }
      ledger.save();
    } finally { busy = false; }
  }
  function status() {
    const t = threadOf(ledger.data);
    return { configured: Boolean(apns), registeredDevices: t.devices?.length || 0, lastAccepted: t.push?.lastSuccess || null, lastError: t.push?.lastError || null };
  }
  async function route(path, method) {
    if (path === "/notifications" && method === "GET") return status();
    if (path !== "/notifications/test" || method !== "POST") return undefined;
    const t = threadOf(ledger.data);
    if (!apns) throw Object.assign(new Error("Apple push is not configured"), { status: 503 });
    if (!t.devices?.length) throw Object.assign(new Error("No device is registered. Check notification permission and retry registration."), { status: 409 });
    let accepted = 0;
    for (const device of [...t.devices]) {
      const r = await apns.send(device.token, { aps: { alert: { title: "Keir", body: "Your test notification arrived." }, sound: "default" }, route: "settings" });
      if (r.status === 200) accepted++;
      else ledger.audit("app_push_test_failed", { status: r.status, reason: r.reason || null });
    }
    ledger.audit("app_push_test", { accepted }); ledger.save();
    if (!accepted) throw Object.assign(new Error("Apple did not accept the test notification. Retry registration."), { status: 503 });
    return { accepted };
  }
  return { tick, status, route };
}

module.exports = { createApns, createAppPush, duePushes };
