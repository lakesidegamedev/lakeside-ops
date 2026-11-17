"use strict";
// Keir 10 failure tracking: one place that classifies, groups and watches Keir's own failures.
// Classes: reasoning, tool, provider, process, player. Every failure gets a fingerprint (class, kind,
// tool or guard, normalized message) so repeats fold into one group, and a sample list with the attempt id
// so the model transcript behind it can be opened (transcriptPath). Recording is best effort: it never
// throws into the operator, errors are counted. Tables live in events.db beside the evidence trail.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HOUR = 3600000, DAY = 86400000;
const CLASSES = ["reasoning", "tool", "provider", "process", "player"];

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, class TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
      job TEXT, ticket INTEGER, lane TEXT, provider TEXT, model TEXT, release TEXT, attempt TEXT, detail TEXT, src TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS failures_fp ON failures(fingerprint, at);
    CREATE INDEX IF NOT EXISTS failures_at ON failures(at);
    CREATE TABLE IF NOT EXISTS failure_groups (
      fingerprint TEXT PRIMARY KEY, class TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, count_24h INTEGER NOT NULL DEFAULT 0, tickets TEXT NOT NULL DEFAULT '[]', releases TEXT NOT NULL DEFAULT '{}',
      providers TEXT NOT NULL DEFAULT '{}', samples TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS failure_activations (src TEXT PRIMARY KEY, at INTEGER NOT NULL, release TEXT, provider TEXT, outcome TEXT);
    CREATE INDEX IF NOT EXISTS failure_act_rel ON failure_activations(release, at);
    CREATE TABLE IF NOT EXISTS failure_alerts (key TEXT PRIMARY KEY, type TEXT, at INTEGER NOT NULL, card_id INTEGER, reported_at INTEGER);`);
}

// An MCP tool error arrives as its JSON envelope; the message is the text inside it. Without unwrapping, the
// quoted-string rule below blanked the whole message, so every tool error folded into one group (2026-11-16: a
// dead code index was reported under an unrelated "parties is not available" title).
function unwrapToolError(msg) {
  const s = String(msg ?? "");
  const i = s.indexOf("{");
  if (i < 0) return s;
  try {
    const j = JSON.parse(s.slice(i));
    const text = (j?.content || []).filter((c) => c?.type === "text").map((c) => c.text).join(" ");
    return text ? `${s.slice(0, i)}${text}` : s;
  } catch { return s; }
}
// Strip what changes between occurrences of the same problem.
function normalize(msg) {
  return unwrapToolError(msg)
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "?")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#")
    .replace(/\bticket[-\s#]*\d+\b/gi, "ticket #")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/\s+/g, " ").trim().toLowerCase().slice(0, 140);
}
function fingerprint(f) {
  const h = crypto.createHash("sha1").update([f.class, f.kind, f.tool || "", normalize(f.detail || f.message || "")].join("|")).digest("hex").slice(0, 8);
  return `${f.class}:${f.kind}:${h}`;
}

const providerName = (p) => (p && typeof p === "object" ? p.runner || p.name || null : p || null);
const versionOf = (r) => (r && typeof r === "object" ? r.version || null : r || null);

// A tool_refused error text to class and kind.
function classifyRefusal(error, tool) {
  const e = String(error || "");
  const t = (cls, kind) => ({ class: cls, kind });
  if (/^Not finished:/i.test(e)) return t("reasoning", "finish_refused_open_work");
  if (/outcome Keir has no receipt|no verified delivered public update|no receipt for/i.test(e)) return t("reasoning", "claim_without_receipt");
  if (/not in (?:the )?evidence|figure.*not.*(?:read|evidence)|number.*not.*evidence/i.test(e)) return t("reasoning", "number_not_in_evidence");
  if (/contradict/i.test(e)) return t("reasoning", "contradiction_refused");
  if (/^Not posted:|Rewrite for the player|Ticket updates are for the player|correction is one or two/i.test(e)) return t("reasoning", "post_refused");
  if (/Input validation error|Invalid argum|MCP error -32602|must be \d+ to \d+|Supply \d|needs a bounded|unknown operator|cannot nest/i.test(e)) return t("tool", "schema_rejected");
  if (/timeout|timed out|aborted/i.test(e)) return t("tool", "timeout");
  if (/fetch failed|ECONN|ENOTFOUND|socket hang up/i.test(e)) return t("tool", "network");
  if (/not authori[sz]ed|outside (?:support|quick read)|not allowed|authority is inactive|stand down|closed to support|only this task|no authenticated reply|no developer owns|PR tools need/i.test(e)) return t("tool", "refused_authority");
  if (/not found|404|no longer exists|no such|has no (?:assigned|linked)|no supported/i.test(e)) return t("tool", "not_found");
  if (/\/channels\/null|Discord (?:GET|POST)/i.test(e)) return t("tool", "bad_argument");
  return t("tool", "refused_other");
}

// Groups that are a guard doing its job, a handled fallback or a policy refusal. They stay recorded and queryable
// (keir-failures.js) but never raise a NEW or SPIKE alert, so they do not reach Sentry or the kanban as errors.
// Real loops and deadlocks built from the same refusals still alert as refusal_loop and guard_deadlock.
const EXPECTED_KINDS = new Set(["raw_read_fallback", "refused_authority", "finish_refused_open_work", "unanswered_finish", "unanswered_finish_refused",
  "certainty_refused", "clarification_refused", "stall_refused", "status_card_regression_refused", "ticket_quality_refused", "owner_muse_refused", "update_spam", "post_refused", "claim_without_receipt"]);
const EXPECTED_DETAIL = /read the assigned ticket only|no concrete problem phrase|no linked character profile|did not match exactly one account/i;
// Blips that a restart or a flaky connection produce: only a real spike (see detect) is worth an alert.
const TRANSIENT_KINDS = new Set(["network", "interrupted", "transient_retry"]);
const isExpected = (g) => EXPECTED_KINDS.has(g.kind) || EXPECTED_DETAIL.test(`${g.title || ""} ${g.detail || ""}`);

const COMPLAINT = { slow_or_silent: "complaint_slow_or_silent", tone: "complaint_tone", wrong_or_misleading: "answer_wrong_player_reported" };

// One audit entry to a failure, or null when it is not one. Pure.
function classifyAudit(kind, d = {}) {
  const k = String(kind || "").replace(/^audit:/, "");
  const base = { job: d.job || null, ticket: d.ticket ?? null, lane: d.lane || null, attempt: d.attempt || null };
  switch (k) {
    case "tool_refused": {
      const c = classifyRefusal(d.error, d.tool);
      return { ...base, ...c, tool: d.tool || null, detail: String(d.error || "").slice(0, 300) };
    }
    case "raw_read": return { ...base, class: "tool", kind: "raw_read_fallback", tool: "raw_read", detail: `collection ${d.collection || "?"}` };
    case "tool_markup_leaked": return { ...base, class: "reasoning", kind: "tool_markup_leaked", model: d.model || null, detail: "tool markup leaked into text" };
    case "update_spam_refused": return { ...base, class: "reasoning", kind: "update_spam", detail: "update refused as spam" };
    case "certainty_refused": case "clarification_refused": case "stall_refused": case "status_card_regression_refused":
    case "ticket_quality_refused": case "unanswered_finish_refused": case "owner_muse_refused":
      return { ...base, class: "reasoning", kind: k.replace(/_refused$/, "_refused"), detail: String(d.reason || d.error || k).slice(0, 300) };
    case "cli_activation": {
      const m = { auth_failed: ["provider", "auth_failed"], error_max_turns: ["reasoning", "step_limit"], error_empty_result: ["reasoning", "empty_result"], error: ["provider", "runner_error"] }[d.subtype];
      return m ? { ...base, class: m[0], kind: m[1], detail: `activation ${d.subtype}` } : null;
    }
    case "usage_limit_no_fallback": return { ...base, class: "provider", kind: "quota", detail: `usage limit on ${d.runner || "runner"} with no fallback` };
    case "auth_failure_provider_fallback": return { ...base, class: "provider", kind: "auth_failed", detail: "login failed, moved to fallback" };
    case "transient_retry": return { ...base, class: "provider", kind: "transient_retry", detail: "transient provider error, retried" };
    case "wake_capped": return { ...base, class: "process", kind: "wake_capped", detail: `wake cap hit: ${d.runs ?? "?"} runs in ${d.window ?? "window"}` };
    case "sweeper_action": return d.action === "escalate_owner" ? { ...base, class: "process", kind: "sweeper_escalation", detail: String(d.reason || "").slice(0, 200) } : null;
    case "effect_recovery": case "effect_recovered": return { ...base, class: "process", kind: "effect_recovery", detail: String(d.reason || d.effect || k).slice(0, 200) };
    case "kill_switch": case "killswitch": return { ...base, class: "process", kind: "kill_switch", detail: String(d.reason || "kill switch").slice(0, 200) };
    case "ticket_reopened_canonical": case "ticket_reopened_by_handoff": return { ...base, class: "player", kind: "ticket_reopened", detail: k };
    case "feedback_logged": {
      const kk = COMPLAINT[d.kind];
      if (!kk) return null;
      return { ...base, class: kk === "answer_wrong_player_reported" ? "reasoning" : "player", kind: kk, detail: `${d.kind} (${d.severity || "?"})` };
    }
    case "correction_posted": return { ...base, class: "reasoning", kind: "correction_posted", detail: "correction posted to player" };
    case "retracted_claim": case "trust_retraction": return { ...base, class: "reasoning", kind: "retracted_fixed_claim", detail: String(d.text || d.reason || "retracted fixed claim").slice(0, 200) };
    default: return null;
  }
}

// usage.jsonl activation row to a failure (or null when the outcome was fine).
function classifyUsage(row = {}) {
  const o = row.outcome;
  if (!o || o === "ok" || o === "success") return null;
  const map = { timeout: ["provider", "timeout"], interrupted: ["provider", "interrupted"], "runner-error": ["provider", "runner_error"], auth_failed: ["provider", "auth_failed"],
    error: ["provider", "runner_error"], error_max_turns: ["reasoning", "step_limit"], error_empty_result: ["reasoning", "empty_result"] };
  const m = map[o] || ["provider", "runner_error"];
  return { class: m[0], kind: m[1], job: row.job || null, ticket: row.ticket ?? null, provider: row.provider || null, model: row.model || null, attempt: row.attempt || null, detail: `activation ${o}` };
}
const isCorrectionPost = (text) => /^\s*Correction:/i.test(String(text || ""));

// ---- transcripts ----
function transcriptCandidates(attempt, stateDir) {
  if (!attempt || !/^[\w.-]+$/.test(String(attempt))) return [];
  return [
    path.join(stateDir, "opencode-runtime", attempt, "transcript.json"),
    path.join(stateDir, `claude-stream-${attempt}.jsonl`),
    path.join(stateDir, `codex-stream-${attempt}.jsonl`),
    path.join(stateDir, "muse-traces", `${attempt}.jsonl`),
    path.join(stateDir, "cli-attempts", `${attempt}.json`),
  ];
}
// Best transcript for an attempt: a stream or runtime transcript first, then the harness event trail, then the attempt record.
function transcriptPath(attempt, { stateDir = process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator", harness = true } = {}) {
  const found = transcriptCandidates(attempt, stateDir).filter((p) => fs.existsSync(p));
  if (harness && attempt) {
    const h = path.join(stateDir, "harness", "harness.db");
    if (fs.existsSync(h)) {
      try {
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(h, { readOnly: true });
        try { if (db.prepare("SELECT 1 FROM attempt_events WHERE attempt_id = ? LIMIT 1").get(attempt)) found.splice(Math.min(1, found.length), 0, `${h}#${attempt}`); } finally { db.close(); }
      } catch {}
    }
  }
  return found[0] || null;
}
const transcriptPaths = (attempt, opts = {}) => {
  const stateDir = opts.stateDir || process.env.KEIR_OPERATOR_STATE_DIR || "/var/lib/keir-operator";
  const all = transcriptCandidates(attempt, stateDir).filter((p) => fs.existsSync(p));
  const t = transcriptPath(attempt, { stateDir });
  return t && !all.includes(t) ? [t, ...all] : all;
};

// ---- recorder and queries ----
function createRecorder({ db, now = () => Date.now(), release = null, lookupJob = () => null, log = () => {}, stateDir = null } = {}) {
  migrate(db);
  const stats = { recorded: 0, errors: 0, ignored: 0 };
  const pacing = new Map(); // job -> last "Not posted:" refusal time, for deadlock detection
  const loops = new Map();  // job|fingerprint -> { n, first }
  const insertFailure = db.prepare("INSERT OR IGNORE INTO failures (at, class, kind, fingerprint, job, ticket, lane, provider, model, release, attempt, detail, src) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const getGroup = db.prepare("SELECT * FROM failure_groups WHERE fingerprint = ?");
  const putGroup = db.prepare("INSERT OR REPLACE INTO failure_groups (fingerprint, class, kind, title, first_seen, last_seen, count, count_24h, tickets, releases, providers, samples) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertActivation = db.prepare("INSERT OR IGNORE INTO failure_activations (src, at, release, provider, outcome) VALUES (?,?,?,?,?)");
  const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

  function record(input, { at = now(), src = null } = {}) {
    try {
      if (!input || !CLASSES.includes(input.class) || !input.kind) { stats.ignored++; return null; }
      const job = input.job ? lookupJob(input.job) : null;
      const f = { ...input, job: input.job ?? null, attempt: input.attempt ?? null,
        lane: input.lane || job?.lane || null, provider: providerName(input.provider) || job?.provider || null, model: input.model || job?.model || null,
        release: versionOf(input.release) || release || null, ticket: input.ticket ?? job?.ticket ?? null,
        detail: String(input.detail || "").replace(/\s+/g, " ").slice(0, 300) };
      if (!src && f.attempt) src = `act:${f.attempt}:${f.kind}`;
      f.fingerprint = fingerprint(f);
      const r = insertFailure.run(at, f.class, f.kind, f.fingerprint, f.job, Number.isFinite(Number(f.ticket)) && f.ticket !== null ? Number(f.ticket) : null, f.lane, f.provider, f.model, f.release, f.attempt, f.detail, src);
      if (!r.changes) return f.fingerprint; // already counted (backfill or the other activation source)
      stats.recorded++;
      const g = getGroup.get(f.fingerprint);
      const tickets = g ? parse(g.tickets, []) : [], releases = g ? parse(g.releases, {}) : {}, providers = g ? parse(g.providers, {}) : {}, samples = g ? parse(g.samples, []) : [];
      if (f.ticket && !tickets.includes(Number(f.ticket))) tickets.push(Number(f.ticket));
      if (f.release) releases[f.release] = (releases[f.release] || 0) + 1;
      if (f.provider) providers[f.provider] = (providers[f.provider] || 0) + 1;
      samples.push({ job: f.job, ticket: f.ticket ?? null, attempt: f.attempt, at, detail: f.detail });
      const title = g?.title || `${f.class}/${f.kind}${f.tool ? ` (${f.tool})` : ""}: ${f.detail || f.kind}`.slice(0, 160);
      const recent = at >= now() - DAY;
      putGroup.run(f.fingerprint, f.class, f.kind, title, g ? Math.min(g.first_seen, at) : at, g ? Math.max(g.last_seen, at) : at, (g?.count || 0) + 1, (g?.count_24h || 0) + (recent ? 1 : 0),
        JSON.stringify(tickets.slice(-20)), JSON.stringify(releases), JSON.stringify(providers), JSON.stringify(samples.slice(-5)));
      return f.fingerprint;
    } catch (e) { stats.errors++; try { log(`failures: ${e.message}`); } catch {} return null; }
  }

  // An audit entry as it is written. Also derives loop and guard-deadlock failures from sequences.
  function fromAudit(kind, detail = {}, opts = {}) {
    try {
      const at = opts.at ?? detail.at ?? now();
      const k = String(kind).replace(/^audit:/, "");
      const src = opts.src || null;
      // Activation outcomes are counted from usage rows (they carry release, provider and model); the audit twin is skipped.
      let f = k === "cli_activation" ? null : classifyAudit(k, detail);
      if (k === "tool_refused" && detail.job) {
        const err = String(detail.error || "");
        if (/^Not posted:/i.test(err)) pacing.set(detail.job, at);
        if (/nothing has been posted since/i.test(err) && at - (pacing.get(detail.job) ?? -Infinity) <= 60000 && at >= (pacing.get(detail.job) ?? 0)) f = { ...f, class: "process", kind: "guard_deadlock" };
        const key = `${detail.job}|${normalize(err)}`;
        const l = loops.get(key);
        if (!l || at - l.first > 30 * 60000) loops.set(key, { n: 1, first: at });
        else if (++l.n === 3) record({ class: "reasoning", kind: "refusal_loop", job: detail.job, ticket: detail.ticket ?? null, tool: detail.tool || null, detail: err.slice(0, 200) }, { at, src: src ? `${src}:loop` : null });
      }
      return f ? record(opts.release ? { ...f, release: opts.release } : f, { at, src }) : null;
    } catch (e) { stats.errors++; return null; }
  }
  // A usage.jsonl activation row: counts as an activation for release rates and may be a failure.
  function fromUsage(row, opts = {}) {
    try {
      const at = opts.at ?? (Date.parse(row.at) || now());
      const rel = versionOf(row.release) || release;
      insertActivation.run(opts.src || `usage:${row.attempt || `${row.job}:${at}`}`, at, rel, providerName(row.provider), row.outcome || null);
      const f = classifyUsage(row);
      return f ? record({ ...f, release: rel }, { at, src: opts.failSrc || null }) : null;
    } catch (e) { stats.errors++; return null; }
  }
  const exception = (err, where = "operator") => record({ class: "process", kind: "crash", detail: `${where}: ${String(err?.message || err).slice(0, 200)}` });
  const correction = (job, ticket) => record({ class: "reasoning", kind: "correction_posted", job, ticket, detail: "correction posted to player" });

  const mapGroup = (g) => ({ ...g, tickets: parse(g.tickets, []), releases: parse(g.releases, {}), providers: parse(g.providers, {}), samples: parse(g.samples, []) });
  function refresh24h(at = now()) {
    db.prepare("UPDATE failure_groups SET count_24h = (SELECT count(*) FROM failures f WHERE f.fingerprint = failure_groups.fingerprint AND f.at >= ?)").run(at - DAY);
  }
  function groups({ since = null, cls = null, limit = 20, at = now() } = {}) {
    refresh24h(at);
    const rows = since
      ? db.prepare(`SELECT g.*, (SELECT count(*) FROM failures f WHERE f.fingerprint = g.fingerprint AND f.at >= ?) AS in_window FROM failure_groups g WHERE (? IS NULL OR g.class = ?) AND g.last_seen >= ? ORDER BY in_window DESC, g.count DESC LIMIT ?`).all(at - since, cls, cls, at - since, limit)
      : db.prepare("SELECT *, count AS in_window FROM failure_groups WHERE (? IS NULL OR class = ?) ORDER BY count DESC LIMIT ?").all(cls, cls, limit);
    return rows.filter((r) => r.in_window > 0).map(mapGroup);
  }
  const get = (fp) => { const g = getGroup.get(fp); return g ? mapGroup(g) : null; };
  const topFailures = (n = 5, { classes = ["reasoning", "tool"], since = 7 * DAY, at = now() } = {}) =>
    classes.flatMap((c) => groups({ since, cls: c, limit: n, at })).sort((a, b) => b.in_window - a.in_window).slice(0, n)
      .map((g) => ({ fingerprint: g.fingerprint, class: g.class, kind: g.kind, title: g.title, count: g.in_window, tickets: g.tickets.length, lastSeen: g.last_seen }));

  // Failures per 100 activations by class for a release.
  function releaseRates(rel) {
    const act = db.prepare("SELECT count(*) AS n FROM failure_activations WHERE release = ?").get(rel).n;
    const byClass = Object.fromEntries(db.prepare("SELECT class, count(*) AS n FROM failures WHERE release = ? GROUP BY class").all(rel).map((r) => [r.class, r.n]));
    const rates = {};
    for (const c of CLASSES) rates[c] = act ? Math.round(((byClass[c] || 0) / act) * 10000) / 100 : null;
    return { release: rel, activations: act, failures: byClass, per100: rates };
  }
  function releases() {
    return db.prepare("SELECT release, max(at) AS last FROM failure_activations WHERE release IS NOT NULL GROUP BY release ORDER BY last DESC").all().map((r) => r.release);
  }

  // Detection. Returns alerts; `file` (optional async) files or updates one kanban card per fingerprint.
  function detect(at = now()) {
    refresh24h(at);
    const alerts = [];
    const sample = (g) => g.samples.slice(-3).map((s) => ({ ...s, transcript: stateDir ? transcriptPath(s.attempt, { stateDir }) : null }));
    for (const r of db.prepare("SELECT * FROM failure_groups WHERE first_seen >= ? AND count >= 3").all(at - HOUR).filter((r) => !isExpected(r) && !TRANSIENT_KINDS.has(r.kind))) alerts.push({ type: "NEW", fingerprint: r.fingerprint, group: mapGroup(r) });
    for (const r of db.prepare("SELECT * FROM failure_groups WHERE class = 'process' AND kind = 'crash' AND last_seen >= ?").all(at - 15 * 60000)) alerts.push({ type: "NEW", fingerprint: r.fingerprint, group: mapGroup(r), crash: true });
    for (const r of db.prepare("SELECT * FROM failure_groups WHERE count_24h >= 10").all().filter((r) => !isExpected(r))) {
      const week = db.prepare("SELECT count(*) AS n FROM failures WHERE fingerprint = ? AND at >= ?").get(r.fingerprint, at - 7 * DAY).n;
      const avg = week / 7;
      if (r.count_24h > 3 * avg) alerts.push({ type: "SPIKE", fingerprint: r.fingerprint, group: mapGroup(r), avgPerDay: Math.round(avg * 10) / 10 });
    }
    const rels = releases();
    if (rels.length >= 2) {
      const cur = releaseRates(rels[0]), prev = releaseRates(rels[1]);
      if (cur.activations >= 50 && prev.activations >= 50) {
        for (const c of CLASSES) {
          const a = cur.per100[c], b = prev.per100[c];
          if (a !== null && b > 0 && a > b * 1.5) alerts.push({ type: "REGRESSION", fingerprint: `regression:${c}:${cur.release}`, cls: c, current: cur, previous: prev });
        }
      }
    }
    const seen = new Set();
    return alerts.filter((a) => (seen.has(a.fingerprint + a.type) ? false : seen.add(a.fingerprint + a.type))).map((a) => ({ ...a, samples: a.group ? sample(a.group) : [], next: nextStep(a) }));
  }
  const nextStep = (a) => a.type === "REGRESSION" ? `Compare releases for class ${a.cls}: keir-failures.js release ${a.current.release}, then open the top groups of that class.`
    : `Run keir-failures.js show ${a.fingerprint} --context 5 to read the model transcript around the failure, then fix the guard, tool or prompt that caused it.`;
  const cardText = (a) => {
    const g = a.group;
    const head = a.type === "REGRESSION" ? `Keir failures regressed: ${a.cls} on ${a.current.release}` : `Keir failure ${a.type.toLowerCase()}: ${g.title}`;
    const body = a.type === "REGRESSION"
      ? `${a.cls} failures per 100 activations: ${a.current.per100[a.cls]} on ${a.current.release} (${a.current.activations} activations) vs ${a.previous.per100[a.cls]} on ${a.previous.release} (${a.previous.activations}).`
      : `Fingerprint ${a.fingerprint}. Total ${g.count}, last 24 hours ${g.count_24h}${a.avgPerDay !== undefined ? ` (7 day average ${a.avgPerDay} a day)` : ""}. Tickets: ${g.tickets.slice(-5).join(", ") || "none"}.`;
    const ex = (a.samples || []).map((s) => `- attempt ${s.attempt || "?"} job ${s.job || "?"}: ${s.detail}${s.transcript ? `\n  transcript: ${s.transcript}` : ""}`).join("\n");
    return { title: head.slice(0, 280), detail: `${body}\n\nSamples:\n${ex || "none"}\n\nNext step: ${a.next}` };
  };
  const alertState = (key) => db.prepare("SELECT * FROM failure_alerts WHERE key = ?").get(key);
  // scan(now): detect, then file at most one card per fingerprint (update after 6 hours, never more often).
  async function scan(at = now(), { file = null, sentry = null } = {}) {
    const alerts = detect(at), filed = [];
    for (const a of alerts) {
      const key = a.fingerprint, st = alertState(key);
      if (st && at - st.reported_at < 6 * HOUR) continue;
      try {
        const text = cardText(a);
        if (sentry) try { await sentry.captureAlert?.(a, text); } catch {}
        const cardId = file ? await file({ ...text, fingerprint: key, type: a.type, existingCardId: st?.card_id || null }) : null;
        db.prepare("INSERT OR REPLACE INTO failure_alerts (key, type, at, card_id, reported_at) VALUES (?,?,?,?,?)").run(key, a.type, st?.at || at, cardId || st?.card_id || null, at);
        filed.push({ ...a, cardId: cardId || st?.card_id || null });
      } catch (e) { stats.errors++; log(`failures scan: ${e.message}`); }
    }
    return { alerts: alerts.length, filed };
  }
  const digest = (at = now()) => { const t = groups({ since: DAY, limit: 3, at }); return t.length ? `Keir failures, 24h: ${t.map((g) => `${g.title.slice(0, 60)} x${g.in_window}`).join("; ")}` : "Keir failures, 24h: none"; };
  return { record, fromAudit, fromUsage, exception, correction, groups, get, topFailures, releaseRates, releases, detect, scan, digest, stats, db };
}

// Re-classify existing events and usage rows into groups. Idempotent (rows carry a source key).
function backfill({ recorder, eventsDb, usageFile = null, since = 0 }) {
  const kinds = ["audit:tool_refused", "audit:cli_activation", "audit:raw_read", "audit:tool_markup_leaked", "audit:update_spam_refused", "audit:usage_limit_no_fallback", "audit:auth_failure_provider_fallback",
    "audit:wake_capped", "audit:sweeper_action", "audit:feedback_logged", "audit:ticket_reopened_canonical", "audit:ticket_reopened_by_handoff", "audit:certainty_refused", "audit:clarification_refused",
    "audit:stall_refused", "audit:status_card_regression_refused", "audit:ticket_quality_refused", "audit:unanswered_finish_refused", "audit:owner_muse_refused", "audit:transient_retry"];
  let events = 0, usage = 0;
  const rows = eventsDb.prepare(`SELECT id, at, kind, task_id, attempt_id, ticket, release, payload FROM events WHERE at >= ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY at, id`).all(since, ...kinds);
  for (const r of rows) {
    let p = {}; try { p = JSON.parse(r.payload); } catch {}
    recorder.fromAudit(r.kind, { ...p, job: p.job || r.attempt_id, ticket: p.ticket ?? r.ticket, at: r.at }, { at: r.at, src: `ev:${r.id}`, release: r.release || null });
    events++;
  }
  if (usageFile && fs.existsSync(usageFile)) {
    for (const line of fs.readFileSync(usageFile, "utf8").split("\n")) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < since || row.event !== "activation") continue;
      recorder.fromUsage(row, { at });
      usage++;
    }
  }
  return { events, usage };
}

// Top failure groups from an events.db file, read only. Empty when the tables do not exist yet.
function topFromFile(file, n = 5, { since = 7 * DAY, classes = ["reasoning", "tool"] } = {}) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const at = Date.now();
      return db.prepare(`SELECT g.fingerprint, g.class, g.kind, g.title, g.tickets, (SELECT count(*) FROM failures f WHERE f.fingerprint = g.fingerprint AND f.at >= ?) AS count
        FROM failure_groups g WHERE g.class IN (${classes.map(() => "?").join(",")}) ORDER BY count DESC LIMIT ?`).all(at - since, ...classes, n)
        .filter((r) => r.count > 0).map((r) => ({ fingerprint: r.fingerprint, class: r.class, kind: r.kind, title: r.title, count: r.count, tickets: JSON.parse(r.tickets).length }));
    } finally { db.close(); }
  } catch { return []; }
}
module.exports = { isExpected, topFromFile, migrate, normalize, fingerprint, classifyAudit, classifyUsage, classifyRefusal, isCorrectionPost, transcriptPath, transcriptPaths, createRecorder, backfill, CLASSES };
