//! keir-shadow-rs: one shadow pass.
//!
//! Reads the Node operator's ledger and event sink (read-only) and the
//! canonical ticket statuses from the support MCP (read token), projects
//! them onto the Rust harness model, and reports where Rust and Node agree
//! or disagree on: status card stages against release facts, economy
//! promotion gate verdicts, and outcome labels. Writes `latest.json` plus a
//! JSONL history under the output directory and appends to `harness.db`.
//! No side effects on the operator, Discord, GitHub or the game.

use harness_core::blast::{promotion_gate, BlastClass, GateInput, Window};
use harness_core::metrics::{cohort, TicketTimeline};
use harness_core::outcome::{label_ticket, TicketFacts};
use harness_core::status::card_stage_allowed;
use harness_store::db::{Comparison, HarnessDb};
use harness_store::events::EventReader;
use harness_store::ledger::{self, Snapshot};
use harness_store::mcp::McpClient;
use harness_store::project::{graph_of, ticket_facts, ticket_numbers};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

struct Args { ledger: PathBuf, events: PathBuf, out: PathBuf, support_url: String, token_file: PathBuf, network: bool, release: Option<String> }

/// The support MCP as everything else on the box finds it: the `support`
/// registration in the Claude-style MCP config, loopback only. Hardcoding the
/// port left this pass on the retired Rust front after the support server
/// moved (2026-10-23, MCP fleet consolidation).
const DEFAULT_SUPPORT_URL: &str = "http://127.0.0.1:19735/mcp";

fn registered_support_url(config: &std::path::Path) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(config).ok()?).ok()?;
    let url = v.pointer("/mcpServers/support/url")?.as_str()?;
    (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")).then(|| url.trim_end_matches('/').to_string())
}

fn args() -> Args {
    let mut a = Args {
        ledger: "/var/lib/keir-operator/ledger.json".into(),
        events: "/var/lib/keir-operator/events.db".into(),
        out: "/var/lib/keir-operator/shadow-rs".into(),
        support_url: registered_support_url(std::path::Path::new("/root/.claude.json")).unwrap_or_else(|| DEFAULT_SUPPORT_URL.into()),
        token_file: "/etc/keir-agent.env".into(),
        network: true,
        release: std::env::var("KEIR_SHADOW_RELEASE").ok().or_else(|| std::fs::read_to_string("/opt/keir/current/RELEASE").ok().and_then(|t| t.split_whitespace().next().map(|s| s[..s.len().min(12)].to_string()))),
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        match k.as_str() {
            "--ledger" => a.ledger = it.next().expect("path").into(),
            "--events" => a.events = it.next().expect("path").into(),
            "--out" => a.out = it.next().expect("path").into(),
            "--support-url" => a.support_url = it.next().expect("url"),
            "--token-file" => a.token_file = it.next().expect("path").into(),
            "--no-network" => a.network = false,
            "--once" => {}
            other => { eprintln!("unknown argument {other}"); std::process::exit(64); }
        }
    }
    a
}

fn now_ms() -> i64 { chrono::Utc::now().timestamp_millis() }

/// Node's status cards may only show a stage the release facts support.
fn compare_cards(s: &Snapshot, now: i64) -> (Vec<Comparison>, Vec<Value>) {
    let mut cmp = Vec::new();
    let mut findings = Vec::new();
    for card in &s.status_cards {
        let f = ticket_facts(s, card.ticket);
        for item in &card.items {
            let verdict = card_stage_allowed(&item.stage, f.on_development, f.on_staging, f.on_main);
            let agree = verdict.is_ok();
            if !agree { findings.push(json!({ "ticket": card.ticket, "item": item.name, "stage": item.stage, "reason": verdict.clone().err() })); }
            cmp.push(Comparison { at: now, kind: "card-stage".into(), subject: format!("{}:{}", card.ticket, item.name), rust: verdict.map(|_| "allowed".to_string()).unwrap_or_else(|e| e), node: item.stage.clone(), agree, note: String::new() });
        }
    }
    (cmp, findings)
}

/// Every economy promotion to main the owner approved: what the 4.0 gate
/// would have said at approval time, against what Node did (3.2.0 audits
/// `promotion_held_awake_window` / `promotion_window_ok`; older ones have no
/// audit and are counterfactuals).
fn compare_promotions(s: &Snapshot, now: i64) -> (Vec<Comparison>, Vec<Value>) {
    let mut cmp = Vec::new();
    let mut findings = Vec::new();
    for a in s.actions.iter().filter(|a| a.kind == "github" && a.action.as_deref() == Some("promote") && a.to.as_deref() == Some("main")) {
        let decided_at = a.approved_at.unwrap_or(a.at);
        let answer_np = s.decisions.iter().find(|d| d.action_id.as_deref() == Some(&a.id)).and_then(|d| d.answer.as_deref()).map(harness_core::blast::has_night_pass).unwrap_or(false);
        let verdict = promotion_gate(GateInput { class: BlastClass::Economy, to: "main", now_ms: decided_at, last_owner_approval_at: a.approved_at, night_pass: a.night_pass || answer_np, window: Window::default() });
        let node_audit = s.audit.iter().filter(|e| e.job.as_deref() == Some(&a.job_id) && (e.kind == "promotion_held_awake_window" || e.kind == "promotion_window_ok")).max_by_key(|e| e.at);
        let node = match node_audit { Some(e) if e.kind == "promotion_held_awake_window" => "held", Some(_) => "allowed", None => if a.state == "approved" { "executed-pre-3.2" } else { &a.state } }.to_string();
        let rust = if verdict.allowed { "allowed" } else { "held" }.to_string();
        let agree = node_audit.is_none() || node == rust;
        if node == "executed-pre-3.2" && !verdict.allowed {
            findings.push(json!({ "action": a.id, "job": a.job_id, "head": a.head, "approved_at": a.approved_at, "eastern_hour": harness_core::blast::eastern_hour(decided_at), "note": "promotion to main outside the owner-awake window before the 3.2.0 gate" }));
        }
        cmp.push(Comparison { at: now, kind: "promotion-gate".into(), subject: a.id.clone(), rust, node, agree, note: verdict.reason });
    }
    (cmp, findings)
}

async fn canonical_statuses(a: &Args) -> BTreeMap<u32, (String, Option<i64>)> {
    let mut out = BTreeMap::new();
    if !a.network { return out; }
    let Some(token) = McpClient::token_from_env_file(&a.token_file) else { tracing::warn!("no read token at {}", a.token_file.display()); return out; };
    let mcp = McpClient::new(&a.support_url, &token);
    match mcp.call("support_list", json!({ "kind": "ticket", "limit": 60 })).await {
        Ok(v) => {
            for item in v.get("items").and_then(Value::as_array).into_iter().flatten() {
                let (Some(n), Some(status)) = (item.get("number").and_then(Value::as_u64), item.get("status").and_then(Value::as_str)) else { continue };
                out.insert(n as u32, (status.to_string(), None));
            }
        }
        Err(e) => tracing::warn!("support_list failed: {e}"),
    }
    out
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse()?)).init();
    let a = args();
    let now = now_ms();
    std::fs::create_dir_all(&a.out)?;
    let snapshot = ledger::load(&a.ledger)?;
    let graph = graph_of(&snapshot);
    let db = HarnessDb::open(&a.out.join("harness.db")).await?;

    let events = match EventReader::open(&a.events).await { Ok(r) => Some(r), Err(e) => { tracing::warn!("events.db unavailable: {e}"); None } };
    let (event_count, event_kinds) = match &events { Some(r) => (r.count().await.unwrap_or(0), r.kinds().await.unwrap_or_default()), None => (0, vec![]) };
    // Jev intake tags and post screens, for the analytics view: work kinds,
    // moods, urgency and proposed friction labels, counted over the sink.
    let mut tag_counts: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    let mut screen_labels: BTreeMap<String, i64> = BTreeMap::new();
    if let Some(r) = &events {
        for e in r.by_kind("audit:intake_tagged", 2000).await.unwrap_or_default() {
            for key in ["kind", "urgency", "mood", "complexity"] {
                if let Some(v) = e.payload.pointer(&format!("/tags/{key}")).and_then(Value::as_str) { *tag_counts.entry(key.into()).or_default().entry(v.into()).or_default() += 1; }
            }
            if e.payload.pointer("/tags/injection") == Some(&Value::Bool(true)) { *tag_counts.entry("injection".into()).or_default().entry("true".into()).or_default() += 1; }
        }
        for e in r.by_kind("audit:post_screened", 2000).await.unwrap_or_default() {
            for l in e.payload.get("labels").and_then(Value::as_array).into_iter().flatten() { if let Some(n) = l.get("label").and_then(Value::as_str) { *screen_labels.entry(n.into()).or_default() += 1; } }
            if e.payload.get("refused") == Some(&Value::Bool(true)) { *screen_labels.entry("refused".into()).or_default() += 1; }
        }
    }

    let (card_cmp, card_findings) = compare_cards(&snapshot, now);
    let (promo_cmp, promo_findings) = compare_promotions(&snapshot, now);
    for c in card_cmp.iter().chain(promo_cmp.iter()) { db.record_comparison(c).await?; }

    // Outcome labels: canonical status from the support MCP, closure time from
    // the ticket task's last finish, Keir attribution from shipped fixes.
    let statuses = canonical_statuses(&a).await;
    let mut labels = Vec::new();
    let mut timelines = Vec::new();
    for t in ticket_numbers(&snapshot) {
        let jobs: Vec<&ledger::Job> = snapshot.jobs.values().filter(|j| j.ticket == Some(t)).collect();
        let intake = jobs.iter().map(|j| j.at).filter(|x| *x > 0).min().unwrap_or(now);
        let ticket_job = jobs.iter().find(|j| j.kind == "ticket");
        let status = statuses.get(&t).map(|(s, _)| s.clone()).unwrap_or_else(|| if ticket_job.map(|j| j.state == "done").unwrap_or(false) { "closed".into() } else { "open".into() });
        let closed_at = if matches!(status.as_str(), "resolved" | "closed") { ticket_job.and_then(|j| j.finished_at.or(Some(j.updated_at))) } else { None };
        let facts = ticket_facts(&snapshot, t);
        let externally = ticket_job.map(|j| j.summary.contains("closed externally")).unwrap_or(false);
        let label = label_ticket(&TicketFacts { ticket: t, status: status.clone(), closed_at, keir_shipped_fix: facts.on_main || jobs.iter().any(|j| j.merged), keir_resolution_receipt: ticket_job.map(|j| j.state == "done" && !externally).unwrap_or(false), closed_externally: externally, observation_complete: None, ..Default::default() }, now);
        db.record_label(&label).await?;
        let decisions: Vec<(i64, Option<i64>)> = snapshot.decisions.iter().filter(|d| jobs.iter().any(|j| j.id == d.job_id)).map(|d| (d.at, d.answered_at)).collect();
        timelines.push(TicketTimeline { ticket: t, intake_at: intake, first_useful_at: None, closed_at, decision_requests: decisions, longest_keir_run: snapshot.monologue.get(&t).map(|m| m.1).unwrap_or(0), ..Default::default() });
        labels.push(json!({ "ticket": t, "label": label.label, "provisional": label.provisional, "attributed": label.keir_attributed, "status": status }));
    }
    let metrics = cohort(&timelines, now);

    // Human review queue (plan: a batch ops queue, no reaction buttons):
    // contradictions and costly failures with the concrete ticket behind each.
    let mut review: Vec<Value> = Vec::new();
    for f in &card_findings { review.push(json!({ "kind": "card-stage-unsupported", "ticket": f["ticket"], "detail": f })); }
    for f in &promo_findings { review.push(json!({ "kind": "promotion-outside-window", "job": f["job"], "detail": f })); }
    for l in &labels { if matches!(l["label"].as_str(), Some("reopened") | Some("recurrence_confirmed")) { review.push(json!({ "kind": "recurrence", "ticket": l["ticket"], "label": l["label"] })); } }
    for d in snapshot.decisions.iter().filter(|d| d.state == "pending" && now - d.at > 3 * 3_600_000) { review.push(json!({ "kind": "decision-unanswered", "decision": d.id, "job": d.job_id, "hours": (now - d.at) / 3_600_000 })); }
    for (t, m) in &snapshot.monologue { if m.1 >= 3 { review.push(json!({ "kind": "keir-monologue", "ticket": t, "posts_since_human": m.1 })); } }
    if let Some(r) = &events {
        for e in r.by_kind("audit:post_screened", 200).await.unwrap_or_default() { if e.payload.get("refused") == Some(&Value::Bool(true)) { review.push(json!({ "kind": "post-refused-leak", "ticket": e.ticket, "job": e.attempt_id, "at": e.at })); } }
        for e in r.by_kind("audit:intake_tagged", 500).await.unwrap_or_default() { if e.payload.pointer("/tags/injection") == Some(&Value::Bool(true)) { review.push(json!({ "kind": "injection-flagged", "ticket": e.ticket, "job": e.attempt_id, "at": e.at })); } }
    }
    let agreement = db.agreement(now - 86_400_000).await?;
    let report = json!({
        "at": now,
        "release": a.release,
        "ledger": { "jobs": snapshot.jobs.len(), "tasks": graph.tasks.len(), "attempts": graph.attempts.len(), "actions": snapshot.actions.len(), "decisions": snapshot.decisions.len(), "support_owner": snapshot.support_owner },
        "events": { "count": event_count, "kinds": event_kinds.iter().take(15).map(|(k, n)| json!({ "kind": k, "n": n })).collect::<Vec<_>>() },
        "jev": { "intake_tags": tag_counts, "post_screens": screen_labels },
        "review_queue": review,
        "agreement_24h": agreement.iter().map(|(k, a, t)| json!({ "kind": k, "agreed": a, "total": t })).collect::<Vec<_>>(),
        "card_stage_findings": card_findings,
        "promotion_findings": promo_findings,
        "labels": labels,
        "metrics": metrics,
        "open_tasks": graph.tasks.values().filter(|t| graph.task_state(&t.id) != harness_core::tasks::TaskState::Terminal).map(|t| json!({ "id": t.id, "state": graph.task_state(&t.id), "attempts": graph.attempts.values().filter(|a| a.task_id == t.id).count() })).collect::<Vec<_>>(),
    });
    db.record_run(now, a.release.as_deref(), &report).await?;
    std::fs::write(a.out.join("latest.json"), serde_json::to_string_pretty(&report)?)?;
    use std::io::Write;
    let mut hist = std::fs::OpenOptions::new().create(true).append(true).open(a.out.join("history.jsonl"))?;
    writeln!(hist, "{}", json!({ "at": now, "agreement_24h": report["agreement_24h"], "card_findings": card_findings.len(), "promotion_findings": promo_findings.len(), "open_tasks": report["open_tasks"].as_array().map(|a| a.len()).unwrap_or(0) }))?;
    println!("shadow pass {now}: {} tasks, {} attempts, {} card findings, {} promotion findings, {} labels, events {event_count}", graph.tasks.len(), graph.attempts.len(), card_findings.len(), promo_findings.len(), labels.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_support_url_comes_from_the_registration() {
        let dir = std::env::temp_dir().join(format!("shadow-support-url-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("claude.json");
        std::fs::write(&f, r#"{"mcpServers":{"support":{"url":"http://127.0.0.1:19735/mcp"}}}"#).unwrap();
        assert_eq!(registered_support_url(&f).as_deref(), Some("http://127.0.0.1:19735/mcp"));
        std::fs::write(&f, r#"{"mcpServers":{"support":{"url":"https://mcp.example.com/support/mcp"}}}"#).unwrap();
        assert_eq!(registered_support_url(&f), None, "only loopback");
        assert_eq!(registered_support_url(&dir.join("missing.json")), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
