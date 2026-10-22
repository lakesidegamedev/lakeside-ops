//! `lakeside`: the shared harness front door.
//!
//!   lakeside run --project ahd --role researcher [--route claude:claude-sonnet-5-5@medium]
//!                --prompt-file brief.md [--cwd /path/to/worktree] [--grant read|coding]
//!                [--image a.png ...] [--timeout 900] [--max-turns 40] [--node-tools-url URL]
//!                [--data-class public-code|private-ops|player-personal] [--json]
//!   lakeside tasks [--limit 20]
//!   lakeside show <attempt-id>
//!   lakeside vision-bench --corpus corpus.json --routes claude:claude-opus-5-5@medium,codex:gpt-6.1-sol@medium [--out report.json]
//!
//! Owner-selected routes win; an unavailable provider fails explicitly.

mod settings;

use harness_core::routing::{resolve_route_for_project, resolve_route, DataClass, Grant, Role, Route, RouteRequest};
use harness_runner::backend::{is_registered_worktree, NodeProxy, ToolBackend, Workspace};
use harness_runner::run::{run_attempt, RunSpec};
use harness_runner::spawn::binary_available;
use harness_store::attempts::AttemptStore;
use harness_store::mcp::McpClient;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

const STATE: &str = "/var/lib/keir-operator/harness";
const DEFAULT_BRIEF: &str = "You are an engineering agent working one bounded task. Use only the tools provided over the harness MCP server. Your own client's shell, file and web tools are switched off on purpose; that does not make the task read-only. If the harness lists write_file and shell, you edit code with write_file and run tests with shell, exactly as the task says. Never stop or report the environment as read-only because of your own client's sandbox notice; if a harness tool itself refuses, report its exact error. Establish facts with tools before concluding, cite file paths and line numbers in findings, never invent numbers, and never post anywhere. When the task is complete, call finish exactly once with status, a plain summary, findings, sources and, if you changed code, the patch summary and the tests you ran. If you are blocked, call finish with status blocked and the exact blocker.";

fn parse_args() -> (String, HashMap<String, Vec<String>>, Vec<String>) {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_else(|| "help".into());
    let mut opts: HashMap<String, Vec<String>> = HashMap::new();
    let mut positional = Vec::new();
    while let Some(a) = it.next() {
        if let Some(k) = a.strip_prefix("--") {
            if matches!(k, "json" | "no-network" | "dry-run") { opts.entry(k.into()).or_default().push("true".into()); }
            else { opts.entry(k.into()).or_default().push(it.next().unwrap_or_default()); }
        } else { positional.push(a); }
    }
    (cmd, opts, positional)
}
fn opt<'a>(o: &'a HashMap<String, Vec<String>>, k: &str) -> Option<&'a str> { o.get(k).and_then(|v| v.last()).map(|s| s.as_str()) }

fn settings(o: &HashMap<String, Vec<String>>) -> anyhow::Result<Option<settings::Settings>> {
    let path = opt(o, "config").map(PathBuf::from).or_else(|| std::env::var_os("LAKESIDE_CONFIG").map(PathBuf::from));
    path.map(|p| settings::Settings::load(&p)).transpose()
}

fn state_dir(o: &HashMap<String, Vec<String>>) -> anyhow::Result<PathBuf> {
    let config = settings(o)?;
    Ok(std::env::var_os("LAKESIDE_STATE_DIR").map(PathBuf::from)
        .or_else(|| config.map(|s| s.state_dir)).unwrap_or_else(|| PathBuf::from(STATE)))
}

fn role_of(s: &str) -> anyhow::Result<Role> {
    Ok(match s { "investigator" => Role::Investigator, "coder" => Role::Coder, "reviewer" => Role::Reviewer, "vision" | "vision-inspector" => Role::VisionInspector, "researcher" => Role::Researcher, "docs" | "doc-writer" => Role::DocWriter, "release" | "release-verifier" => Role::ReleaseVerifier, "conversation" => Role::Conversation, other => anyhow::bail!("unknown role {other}") })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("warn".parse()?)).with_writer(std::io::stderr).init();
    let (cmd, o, pos) = parse_args();
    match cmd.as_str() {
        "run" => run(&o).await,
        "tasks" => { let s = AttemptStore::open(&state_dir(&o)?.join("harness.db")).await?; println!("{}", serde_json::to_string_pretty(&s.list_tasks(opt(&o, "limit").and_then(|l| l.parse().ok()).unwrap_or(20)).await?)?); Ok(()) }
        "show" => { let s = AttemptStore::open(&state_dir(&o)?.join("harness.db")).await?; let id = pos.first().ok_or_else(|| anyhow::anyhow!("show <attempt-id>"))?; println!("{}", serde_json::to_string_pretty(&s.show_attempt(id).await?)?); Ok(()) }
        "vision-bench" => vision_bench(&o).await,
        "activation" => activation(&o).await,
        _ => { eprintln!("usage: lakeside run|tasks|show|vision-bench ... [--config /absolute/config.json] (see docs/INSTALL.md)"); std::process::exit(64) }
    }
}

async fn run(o: &HashMap<String, Vec<String>>) -> anyhow::Result<()> {
    let config = settings(o)?;
    let project = opt(o, "project").ok_or_else(|| anyhow::anyhow!("--project is required"))?.to_string();
    let role = role_of(opt(o, "role").unwrap_or("researcher"))?;
    let route = match opt(o, "route").or_else(|| config.as_ref().map(|c| c.default_route.as_str())) { Some(r) => Some(Route::parse(r).ok_or_else(|| anyhow::anyhow!("bad --route, expected provider:model@effort"))?), None => None };
    let grant = match opt(o, "grant") { Some("coding") => Some(Grant::coding()), Some("read") => Some(Grant::read_only()), Some(other) => anyhow::bail!("unknown grant {other}"), None => None };
    let data_classes: Vec<DataClass> = o.get("data-class").map(|v| v.iter().map(|c| match c.as_str() { "private-ops" => DataClass::PrivateOps, "player-personal" => DataClass::PlayerPersonal, _ => DataClass::PublicCode }).collect()).unwrap_or_else(|| vec![DataClass::PublicCode]);
    let images: Vec<PathBuf> = o.get("image").map(|v| v.iter().map(PathBuf::from).collect()).unwrap_or_default();
    let prompt = std::fs::read_to_string(opt(o, "prompt-file").ok_or_else(|| anyhow::anyhow!("--prompt-file is required"))?)?;
    let brief = match opt(o, "brief-file").map(PathBuf::from).or_else(|| config.as_ref().and_then(|c| c.brief_file.clone())) {
        Some(f) => std::fs::read_to_string(f)?, None => DEFAULT_BRIEF.to_string()
    };
    let req = RouteRequest { project: project.clone(), role, route, grant, data_classes: data_classes.clone(), has_images: !images.is_empty(), headless: true };
    // A child task can never widen its parent's grant: the parent's recorded
    // grant is the ceiling, whatever the request or the prompt text says.
    let state = state_dir(o)?;
    let store = AttemptStore::open(&state.join("harness.db")).await?;
    let parent_grant: Option<Grant> = match opt(o, "parent") {
        Some(p) => { let t = store.get_task(p).await?.ok_or_else(|| anyhow::anyhow!("unknown parent task {p}"))?; Some(serde_json::from_value(t["spec"]["grant"].clone()).map_err(|_| anyhow::anyhow!("parent task {p} has no recorded grant"))?) }
        None => None,
    };
    let resolved = if let Some(c) = &config {
        let p = c.projects.iter().find(|p| p.id == project).ok_or_else(|| anyhow::anyhow!("unknown configured project {project}"))?;
        resolve_route_for_project(&req, p.clone(), parent_grant.as_ref(), &binary_available)
    } else { resolve_route(&req, parent_grant.as_ref(), &binary_available) }.map_err(|e| anyhow::anyhow!("route refused: {e}"))?;
    let cwd = PathBuf::from(opt(o, "cwd").unwrap_or(&resolved.project.repo_path));
    if resolved.grant.sandbox_write {
        let repo = PathBuf::from(&resolved.project.repo_path);
        if cwd.canonicalize()? == repo.canonicalize()? { anyhow::bail!("a coding task needs a registered worktree, never the main checkout ({})", repo.display()); }
        if !is_registered_worktree(&repo, &cwd) { anyhow::bail!("{} is not a registered worktree of {}", cwd.display(), repo.display()); }
    }
    // Worker manifest: the base commit and a clean tree are recorded before any
    // coding attempt, so a patch is always relative to a known ref and a
    // leftover edit from another session is never silently absorbed.
    let base_sha = std::process::Command::new("git").arg("-C").arg(&cwd).arg("rev-parse").arg("HEAD").output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    if resolved.grant.sandbox_write {
        let dirty = std::process::Command::new("git").arg("-C").arg(&cwd).arg("status").arg("--porcelain").output().map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty()).unwrap_or(true);
        if dirty && opt(o, "allow-dirty").is_none() { anyhow::bail!("{} has uncommitted changes; a coding task starts from a clean tree (pass --allow-dirty to override)", cwd.display()); }
    }
    let task_id = opt(o, "task").map(String::from).unwrap_or_else(|| format!("task:{}", uuid::Uuid::new_v4().simple()));
    let attempt_id = format!("a-{}", uuid::Uuid::new_v4().simple());
    let spec_json = json!({ "project": project, "role": format!("{:?}", role), "route": resolved.route, "grant": resolved.grant, "data_classes": data_classes, "images": images, "cwd": cwd, "base_sha": base_sha, "owner_selected": resolved.owner_selected, "notes": resolved.notes });
    store.create_task(&task_id, "general", &resolved.project.id, &format!("{:?}", role).to_lowercase(), opt(o, "parent"), opt(o, "requester"), &spec_json, chrono::Utc::now().timestamp_millis()).await?;
    if opt(o, "dry-run").is_some() { println!("{}", serde_json::to_string_pretty(&json!({ "task": task_id, "resolved": resolved }))?); return Ok(()); }
    let backend: Arc<dyn ToolBackend> = match opt(o, "node-tools-url") {
        Some(url) => Arc::new(NodeProxy::connect(url).await?),
        None => {
            if let Some(c) = &config {
                let mcp = if opt(o, "no-network").is_some() { None } else if let Some(file) = &c.mcp_config {
                    let token = std::env::var("LAKESIDE_MCP_TOKEN").unwrap_or_default();
                    let client = McpClient::new("http://127.0.0.1:1", &token).with_servers_from(file);
                    let available = client.servers();
                    for name in c.mcp_read_tools.keys() {
                        if !available.contains(name) { anyhow::bail!("MCP server {name} must have a local HTTP URL in mcp_config"); }
                    }
                    Some((client, c.mcp_read_tools.keys().cloned().collect()))
                } else { None };
                Arc::new(Workspace::new(cwd.clone(), resolved.grant, mcp).with_read_tools(c.mcp_read_tools.clone()))
            } else {
            let mcp = if opt(o, "no-network").is_none() { McpClient::token_from_env_file(std::path::Path::new("/etc/keir-agent.env")).map(|t| { let c = McpClient::new("http://127.0.0.1:9735", &t).with_servers_from(std::path::Path::new("/root/.claude.json")); let servers: Vec<String> = c.servers().into_iter().filter(|s| ["gamestate", "engine", "turndiag", "support", "ops-knowledge", "worldsim", "community"].contains(&s.as_str())).collect(); (c, servers) }) } else { None };
            Arc::new(Workspace::new(cwd.clone(), resolved.grant, mcp))
            }
        }
    };
    let scratch = state.join("scratch").join(&attempt_id);
    let outcome = run_attempt(RunSpec { task_id: task_id.clone(), attempt_id, route: resolved.route.clone(), brief, prompt, images, cwd: cwd.clone(), scratch: scratch.clone(), max_turns: opt(o, "max-turns").and_then(|m| m.parse().ok()).unwrap_or(40), timeout_secs: opt(o, "timeout").and_then(|t| t.parse().ok()).unwrap_or(900), writable_workspace: resolved.grant.sandbox_write, interactive: false, backend }, Some(&store)).await?;
    let _ = std::fs::remove_dir_all(&scratch);
    let state_word = match (&outcome.result, outcome.timed_out, outcome.quota_hold.is_some()) { (Some(r), _, _) => r.get("status").and_then(Value::as_str).unwrap_or("done").to_string(), (None, true, _) => "timed-out".into(), (None, _, true) => "quota-hold".into(), _ => "no-result".into() };
    store.set_task_state(&task_id, &state_word).await?;
    // Patch handoff: a coding attempt's actual diff is the deliverable, saved
    // beside the trace. The coordinator applies it; the subagent never pushes.
    let patch = if resolved.grant.sandbox_write {
        let diff = std::process::Command::new("git").arg("-C").arg(&cwd).arg("diff").output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        let untracked = std::process::Command::new("git").arg("-C").arg(&cwd).arg("ls-files").arg("--others").arg("--exclude-standard").output().map(|o| String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect::<Vec<_>>()).unwrap_or_default();
        let mut full = diff.clone();
        for f in &untracked { if let Ok(c) = std::fs::read_to_string(cwd.join(f)) { full.push_str(&format!("diff --git a/{f} b/{f}\nnew file mode 100644\n--- /dev/null\n+++ b/{f}\n@@ -0,0 +1,{} @@\n", c.lines().count())); for l in c.lines() { full.push('+'); full.push_str(l); full.push('\n'); } } }
        if full.trim().is_empty() { None } else {
            let dir = state.join("patches"); std::fs::create_dir_all(&dir)?;
            let file = dir.join(format!("{}.diff", outcome.attempt_id)); std::fs::write(&file, &full)?;
            Some(json!({ "file": file, "bytes": full.len(), "base_sha": base_sha, "untracked": untracked }))
        }
    } else { None };
    if opt(o, "json").is_some() { println!("{}", serde_json::to_string_pretty(&json!({ "task": task_id, "route": resolved.route, "state": state_word, "patch": patch, "outcome": outcome }))?); }
    else {
        println!("task {task_id} [{state_word}] via {} in {} ms, {} tool calls, exit {:?}{}", outcome.provider_label, outcome.duration_ms, outcome.tool_calls.len(), outcome.exit_code, if outcome.timed_out { " (timed out)" } else { "" });
        if let Some(p) = &patch { println!("patch: {} ({} bytes)", p["file"], p["bytes"]); }
        if let Some(q) = &outcome.quota_hold { println!("quota hold: {q}"); }
        match &outcome.result { Some(r) => println!("{}", serde_json::to_string_pretty(r)?), None => println!("{}", outcome.final_text) }
    }
    Ok(())
}

/// One Keir activation executed by the Rust runner on the Node operator's
/// behalf: Node opened the tool session and built the brief and context; Rust
/// owns the loop, the trace and admission, and answers in the Claude-shaped
/// result the Node agent already consumes. Ticket and job state stay in Node.
async fn activation(o: &HashMap<String, Vec<String>>) -> anyhow::Result<()> {
    let job = opt(o, "job").ok_or_else(|| anyhow::anyhow!("--job is required"))?.to_string();
    let url = opt(o, "tools-url").ok_or_else(|| anyhow::anyhow!("--tools-url is required"))?.to_string();
    let route = Route::parse(opt(o, "route").ok_or_else(|| anyhow::anyhow!("--route is required"))?).ok_or_else(|| anyhow::anyhow!("bad --route"))?;
    let brief = std::fs::read_to_string(opt(o, "brief-file").ok_or_else(|| anyhow::anyhow!("--brief-file is required"))?)?;
    let prompt = std::fs::read_to_string(opt(o, "prompt-file").ok_or_else(|| anyhow::anyhow!("--prompt-file is required"))?)?;
    let task_id = opt(o, "task").map(String::from).unwrap_or_else(|| format!("request:{job}"));
    let lane = opt(o, "lane").unwrap_or("worker").to_string();
    let timeout_secs = opt(o, "timeout-ms").and_then(|t| t.parse::<u64>().ok()).map(|ms| (ms / 1000).max(30)).or_else(|| opt(o, "timeout").and_then(|t| t.parse().ok())).unwrap_or(900);
    if !binary_available(route.provider) { anyhow::bail!("provider {:?} unavailable", route.provider); }
    let state = state_dir(o)?;
    let store = AttemptStore::open(&state.join("harness.db")).await?;
    store.create_task(&task_id, "keir-activation", "a-house-divided", &lane, None, None, &json!({ "job": job, "lane": lane, "route": route }), chrono::Utc::now().timestamp_millis()).await?;
    let attempt_id = format!("k-{}", uuid::Uuid::new_v4().simple());
    let backend: Arc<dyn ToolBackend> = Arc::new(NodeProxy::connect(&url).await?);
    let cwd = state.join("claude-cwd"); std::fs::create_dir_all(&cwd)?;
    let scratch = state.join("scratch").join(&attempt_id);
    let outcome = run_attempt(RunSpec { task_id: task_id.clone(), attempt_id: attempt_id.clone(), route: route.clone(), brief, prompt, images: vec![], cwd, scratch: scratch.clone(), max_turns: opt(o, "max-turns").and_then(|m| m.parse().ok()).unwrap_or(40), timeout_secs, writable_workspace: false, interactive: lane == "quick", backend }, Some(&store)).await;
    let _ = std::fs::remove_dir_all(&scratch);
    let out = match outcome {
        Ok(oc) => {
            let result_subtype = oc.events_subtype();
            let max_turns = result_subtype.as_deref() == Some("error_max_turns") || (route.provider == harness_core::routing::Provider::Muse && regex_match(&oc.stderr_tail, r"(?i)max(imum)?[ -]model[ -]steps|step (cap|limit)|did not reach a terminal state within \d+ step"));
            let subtype = if oc.timed_out || max_turns { "error_max_turns" } else if oc.exit_code == Some(0) || oc.result.is_some() { "success" } else { "error" };
            json!({ "subtype": subtype, "is_error": subtype != "success", "timedOut": oc.timed_out, "result": oc.final_text, "num_turns": oc.usage.num_turns.unwrap_or(oc.tool_calls.len() as u64),
                "usage": { "input_tokens": oc.usage.input_tokens, "output_tokens": oc.usage.output_tokens, "cache_read_input_tokens": oc.usage.cache_read_tokens, "cache_creation_input_tokens": oc.usage.cache_creation_input_tokens, "cache_creation": oc.usage.cache_creation },
                "provenance": { "runner": "rust", "attempt": attempt_id, "label": format!("{}-via-rust", oc.provider_label), "tool_calls": oc.tool_calls.len(), "duration_ms": oc.duration_ms, "quota_hold": oc.quota_hold, "exit_code": oc.exit_code } })
        }
        Err(e) => json!({ "subtype": "error", "is_error": true, "result": format!("rust runner: {e}"), "provenance": { "runner": "rust", "attempt": attempt_id } }),
    };
    store.set_task_state(&task_id, out["subtype"].as_str().unwrap_or("error")).await?;
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

fn regex_match(text: &str, pattern: &str) -> bool { regex_lite(pattern).map(|r| r.is_match(text)).unwrap_or(false) }
fn regex_lite(pattern: &str) -> Option<regex::Regex> { regex::Regex::new(pattern).ok() }

trait SubtypeOf { fn events_subtype(&self) -> Option<String>; }
impl SubtypeOf for harness_runner::run::Outcome {
    /// Claude's final `result` event carries `subtype`; the runner keeps it in the trace, and the
    /// last trace row is in `final_text` only, so read it from the stderr-free result when present.
    fn events_subtype(&self) -> Option<String> { self.result_subtype.clone() }
}

/// Vision benchmark over the private corpus. No tools: the image goes in
/// through the CLI's own image input and the model answers in JSON. Scoring
/// is substring containment after normalising digits, case and punctuation.
async fn vision_bench(o: &HashMap<String, Vec<String>>) -> anyhow::Result<()> {
    let corpus: Value = serde_json::from_str(&std::fs::read_to_string(opt(o, "corpus").unwrap_or("/var/lib/keir-operator/vision-bench/corpus.json"))?)?;
    // "openrouter:<model>@effort" is an HTTP route for the benchmark only (metered key, owner-requested).
    let routes: Vec<Route> = opt(o, "routes").unwrap_or("claude:claude-opus-5-5@medium,claude:claude-sonnet-5-5@medium,codex:gpt-6.1-sol@medium").split(',').filter_map(|r| {
        if let Some(rest) = r.strip_prefix("openrouter:") { let (model, effort) = rest.split_once('@').unwrap_or((rest, "medium")); return Some(Route::new(harness_core::routing::Provider::OpenCode, &format!("openrouter/{}", model.trim_start_matches("openrouter/")), effort)); }
        Route::parse(r)
    }).collect();
    let out = PathBuf::from(opt(o, "out").unwrap_or("/var/lib/keir-operator/vision-bench/report.json"));
    let state = state_dir(o)?;
    let store = AttemptStore::open(&state.join("harness.db")).await?;
    // Models write the typographic minus (U+2212) for negatives; the UI uses it too.
    let norm = |s: &str| s.to_lowercase().replace(['\u{2212}', '\u{2013}', '\u{2014}'], "-").chars().filter(|c| c.is_alphanumeric() || *c == '.' || *c == '%' || *c == '-').collect::<String>();
    let mut report = Vec::new();
    for route in &routes {
        // The benchmark exists to measure, so every provider with an image path is tried,
        // whatever the capability table assumes. Ollama Cloud (DeepSeek) goes over HTTP.
        let http_vision = matches!(route.provider, harness_core::routing::Provider::Ollama | harness_core::routing::Provider::OpenCode);
        if !http_vision && !binary_available(route.provider) { report.push(json!({ "route": route, "error": "provider binary unavailable" })); continue; }
        let mut cases_out = Vec::new();
        let (mut correct, mut total) = (0usize, 0usize);
        let mut latency = Vec::new();
        for case in corpus["cases"].as_array().cloned().unwrap_or_default() {
            let questions = case["questions"].as_array().cloned().unwrap_or_default();
            let qlist: Vec<String> = questions.iter().enumerate().map(|(i, q)| format!("{}. {}", i + 1, q["q"].as_str().unwrap_or(""))).collect();
            let prompt = format!("Look at the attached screenshot from the game A House Divided and answer each question from what is visible only. Quote numbers exactly as displayed, with their units and punctuation. If something is cut off or unreadable, say so. Reply with a JSON object only: keys \"1\", \"2\", ... in question order, string values.\n\n{}", qlist.join("\n"));
            let attempt_id = format!("vb-{}", uuid::Uuid::new_v4().simple());
            let task_id = format!("vision-bench:{}", case["id"].as_str().unwrap_or("case"));
            store.create_task(&task_id, "vision-bench", "a-house-divided", "vision-inspector", None, None, &json!({ "image": case["image"] }), chrono::Utc::now().timestamp_millis()).await?;
            let scratch = state.join("scratch").join(&attempt_id);
            let backend: Arc<dyn ToolBackend> = Arc::new(Workspace::new(PathBuf::from("/var/lib/keir-operator/vision-bench"), Grant::read_only(), None));
            let outcome = if http_vision {
                let call = if route.provider == harness_core::routing::Provider::OpenCode { openrouter_vision(&route.model, &prompt, case["image"].as_str().unwrap_or("")).await } else { ollama_cloud_vision(&route.model, &prompt, case["image"].as_str().unwrap_or("")).await };
                call.map(|(text, ms)| harness_runner::run::Outcome { attempt_id: attempt_id.clone(), provider_label: if route.provider == harness_core::routing::Provider::OpenCode { "openrouter-http".into() } else { "ollama-cloud-http".into() }, exit_code: Some(0), timed_out: false, quota_hold: None, result: None, final_text: text, usage: Default::default(), tool_calls: vec![], events: 0, duration_ms: ms, stderr_tail: String::new(), result_subtype: None })
            } else {
                run_attempt(RunSpec { task_id, attempt_id: attempt_id.clone(), route: route.clone(), brief: "You read game screenshots precisely. You have no tools to use except reading the attached image; do not call any tool. Answer in JSON only.".into(), prompt, images: vec![PathBuf::from(case["image"].as_str().unwrap_or(""))], cwd: PathBuf::from("/var/lib/keir-operator/vision-bench"), scratch: scratch.clone(), max_turns: 6, timeout_secs: 240, writable_workspace: false, interactive: false, backend }, Some(&store)).await
            };
            let _ = std::fs::remove_dir_all(&scratch);
            let (answers, err, ms): (Value, Option<String>, u64) = match outcome {
                Ok(oc) => { let text = oc.final_text.clone(); let start = text.find('{'); let end = text.rfind('}'); let parsed = match (start, end) { (Some(s), Some(e)) if e > s => serde_json::from_str::<Value>(&text[s..=e]).unwrap_or(Value::Null), _ => Value::Null }; (parsed, if parsed_is_null(&text) { Some(text.chars().take(300).collect()) } else { None }, oc.duration_ms) }
                Err(e) => (Value::Null, Some(e.to_string()), 0),
            };
            latency.push(ms);
            let mut qres = Vec::new();
            for (i, q) in questions.iter().enumerate() {
                let got = answers.get((i + 1).to_string()).and_then(Value::as_str).unwrap_or("").to_string();
                let expect: Vec<String> = q["expect"].as_array().cloned().unwrap_or_default().iter().filter_map(Value::as_str).map(String::from).collect();
                let ok = !expect.is_empty() && expect.iter().all(|e| norm(&got).contains(&norm(e)));
                total += 1; if ok { correct += 1; }
                qres.push(json!({ "q": q["q"], "expect": expect, "got": got, "ok": ok }));
            }
            cases_out.push(json!({ "case": case["id"], "attempt": attempt_id, "ms": ms, "error": err, "questions": qres }));
        }
        let lat = harness_core::metrics::summarize(latency.iter().map(|x| *x as i64).collect());
        report.push(json!({ "route": route, "correct": correct, "total": total, "accuracy": if total > 0 { correct as f64 / total as f64 } else { 0.0 }, "latency_ms": lat, "cases": cases_out }));
        eprintln!("{:?}:{} {}/{} correct", route.provider, route.model, correct, total);
    }
    let full = json!({ "at": chrono::Utc::now().to_rfc3339(), "corpus_version": corpus["version"], "routes": report });
    if let Some(dir) = out.parent() { std::fs::create_dir_all(dir)?; }
    std::fs::write(&out, serde_json::to_string_pretty(&full)?)?;
    println!("{}", serde_json::to_string_pretty(&full["routes"].as_array().unwrap_or(&vec![]).iter().map(|r| json!({ "route": r["route"], "correct": r["correct"], "total": r["total"], "accuracy": r["accuracy"], "latency_ms": r["latency_ms"], "error": r["error"], "skipped": r["skipped"] })).collect::<Vec<_>>())?);
    println!("report: {}", out.display());
    Ok(())
}

fn parsed_is_null(text: &str) -> bool { !text.contains('{') }

/// Ollama Cloud chat with one image (DeepSeek and other hosted open models).
/// Key from /root/.config/lakeside/ollama-cloud.json, as dsflash.sh uses.
async fn ollama_cloud_vision(model: &str, prompt: &str, image: &str) -> anyhow::Result<(String, u64)> {
    let key = std::env::var("OLLAMA_API_KEY").ok().or_else(|| std::fs::read_to_string("/root/.config/lakeside/ollama-cloud.json").ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["api_key"].as_str().map(String::from))).ok_or_else(|| anyhow::anyhow!("no Ollama Cloud key"))?;
    let bytes = std::fs::read(image)?;
    let b64 = base64_encode(&bytes);
    let body = json!({ "model": model, "stream": false, "think": false, "messages": [{ "role": "user", "content": prompt, "images": [b64] }] });
    let started = std::time::Instant::now();
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(240)).build()?;
    let res = http.post("https://ollama.com/api/chat").bearer_auth(key).json(&body).send().await?;
    let status = res.status();
    let v: Value = res.json().await?;
    if !status.is_success() { anyhow::bail!("ollama cloud {status}: {}", v.to_string().chars().take(300).collect::<String>()); }
    Ok((v["message"]["content"].as_str().unwrap_or("").to_string(), started.elapsed().as_millis() as u64))
}

/// OpenRouter chat completions with one image (data URL). Key from /etc/lakeside/decisions.env.
async fn openrouter_vision(model: &str, prompt: &str, image: &str) -> anyhow::Result<(String, u64)> {
    let key = std::env::var("OPENROUTER_API_KEY").ok().or_else(|| std::fs::read_to_string("/etc/lakeside/decisions.env").ok().and_then(|t| t.lines().find_map(|l| l.strip_prefix("OPENROUTER_API_KEY=").map(|v| v.trim().to_string())))).ok_or_else(|| anyhow::anyhow!("no OpenRouter key"))?;
    let bytes = std::fs::read(image)?;
    let mime = if image.ends_with(".webp") { "image/webp" } else if image.ends_with(".jpg") || image.ends_with(".jpeg") { "image/jpeg" } else { "image/png" };
    let data_url = format!("data:{mime};base64,{}", base64_encode(&bytes));
    let body = json!({ "model": model, "messages": [{ "role": "user", "content": [{ "type": "text", "text": prompt }, { "type": "image_url", "image_url": { "url": data_url } }] }] });
    let started = std::time::Instant::now();
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(240)).build()?;
    let res = http.post("https://openrouter.ai/api/v1/chat/completions").bearer_auth(key).header("HTTP-Referer", "https://lakesidegames.net").header("X-Title", "Lakeside vision bench").json(&body).send().await?;
    let status = res.status();
    let v: Value = res.json().await?;
    if !status.is_success() || v.get("error").is_some() { anyhow::bail!("openrouter {status}: {}", v.to_string().chars().take(300).collect::<String>()); }
    let served = v["model"].as_str().unwrap_or("").to_string();
    let text = v["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    Ok((format!("{text}\n[served by {served}]"), started.elapsed().as_millis() as u64))
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char); out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}
