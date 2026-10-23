//! Minimal JSON-RPC client for the local MCP servers, read token only. The
//! shadow reads canonical ticket state from the support MCP; it never writes.

use serde_json::{json, Value};
use std::time::Duration;

pub struct McpClient { base: String, token: String, http: reqwest::Client, servers: std::collections::BTreeMap<String, String> }

impl McpClient {
    pub fn new(base: &str, token: &str) -> Self {
        McpClient { base: base.trim_end_matches('/').to_string(), token: token.to_string(), http: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("http client"), servers: Default::default() }
    }

    /// Token from `/etc/keir-agent.env` (`KEIR_AGENT_MCP_TOKEN=...`), the same
    /// read-only token the Node operator uses.
    pub fn token_from_env_file(path: &std::path::Path) -> Option<String> {
        let text = std::fs::read_to_string(path).ok()?;
        text.lines().find_map(|l| l.strip_prefix("KEIR_AGENT_MCP_TOKEN=")).map(|v| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string()).filter(|v| !v.is_empty())
    }

    /// Register the local servers from a Claude-style MCP config (`mcpServers.<name>.url`); only 127.0.0.1 URLs are kept.
    /// The URL is the endpoint, used verbatim: a consolidated server answers an
    /// absorbed one at `/mcp/<name>`, and rewriting the URL (it used to strip a
    /// trailing `/mcp` and append one) turned that into `/mcp/<name>/mcp`.
    pub fn with_servers_from(mut self, config_path: &std::path::Path) -> Self {
        if let Ok(text) = std::fs::read_to_string(config_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(m) = v.get("mcpServers").and_then(Value::as_object) {
                    for (name, c) in m {
                        if let Some(u) = c.get("url").and_then(Value::as_str) { if u.starts_with("http://127.0.0.1:") || u.starts_with("http://localhost:") { self.servers.insert(name.clone(), u.trim_end_matches('/').to_string()); } }
                    }
                }
            }
        }
        self
    }
    pub fn servers(&self) -> Vec<String> { self.servers.keys().cloned().collect() }

    pub async fn call_on(&self, server: &str, tool: &str, arguments: Value) -> anyhow::Result<Value> {
        let endpoint = self.servers.get(server).ok_or_else(|| anyhow::anyhow!("unknown MCP server {server}"))?.clone();
        self.call_at(&endpoint, tool, arguments).await
    }

    /// Call the server `new` was given. A base without a path gets `/mcp`, as before.
    pub async fn call(&self, tool: &str, arguments: Value) -> anyhow::Result<Value> { let endpoint = endpoint_of(&self.base); self.call_at(&endpoint, tool, arguments).await }

    async fn call_at(&self, endpoint: &str, tool: &str, arguments: Value) -> anyhow::Result<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": arguments } });
        let res = self.http.post(endpoint).bearer_auth(&self.token)
            .header("Accept", "application/json, text/event-stream").json(&body).send().await?;
        let status = res.status();
        let text = res.text().await?;
        let v = parse_rpc(&text)?;
        if !status.is_success() || v.get("error").is_some() || v.pointer("/result/isError") == Some(&Value::Bool(true)) {
            anyhow::bail!("mcp {tool} failed: {}", v.get("error").or_else(|| v.get("result")).map(|e| e.to_string()).unwrap_or_default().chars().take(500).collect::<String>());
        }
        let text_parts: Vec<&str> = v.pointer("/result/content").and_then(Value::as_array).map(|a| a.iter().filter(|c| c.get("type").and_then(Value::as_str) == Some("text")).filter_map(|c| c.get("text").and_then(Value::as_str)).collect()).unwrap_or_default();
        let joined = text_parts.join("\n");
        Ok(serde_json::from_str(&joined).unwrap_or(Value::String(joined)))
    }
}

/// `new` takes a server base like `http://127.0.0.1:9735`; its endpoint is
/// `<base>/mcp` unless the base already names one.
fn endpoint_of(base: &str) -> String {
    if base.ends_with("/mcp") || base.contains("/mcp/") { base.to_string() } else { format!("{base}/mcp") }
}

/// Streamable HTTP may answer as SSE (`data: {...}` lines) or plain JSON.
pub fn parse_rpc(text: &str) -> anyhow::Result<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(text) { return Ok(v); }
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            if let Ok(v) = serde_json::from_str::<Value>(data.trim()) { if v.get("result").is_some() || v.get("error").is_some() { return Ok(v); } }
        }
    }
    anyhow::bail!("unparseable MCP response: {}", text.chars().take(200).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_sse_and_json() {
        assert_eq!(parse_rpc(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#).unwrap()["result"]["ok"], true);
        let v = parse_rpc("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]}}\n\n").unwrap();
        assert!(v["result"]["content"].is_array());
        assert!(parse_rpc("garbage").is_err());
    }

    #[test]
    fn registered_urls_are_used_verbatim() {
        let dir = std::env::temp_dir().join(format!("mcp-client-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("claude.json");
        std::fs::write(&file, r#"{"mcpServers":{"gamestate":{"url":"http://127.0.0.1:9751/mcp/gamestate"},"support":{"url":"http://127.0.0.1:19735/mcp"},"public":{"url":"https://example.com/mcp"}}}"#).unwrap();
        let c = McpClient::new("http://127.0.0.1:1", "t").with_servers_from(&file);
        assert_eq!(c.servers.get("gamestate").map(String::as_str), Some("http://127.0.0.1:9751/mcp/gamestate"));
        assert_eq!(c.servers.get("support").map(String::as_str), Some("http://127.0.0.1:19735/mcp"));
        assert!(!c.servers.contains_key("public"), "only loopback servers are kept");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bare_base_still_gets_mcp_appended() {
        assert_eq!(endpoint_of("http://127.0.0.1:9735"), "http://127.0.0.1:9735/mcp");
        assert_eq!(endpoint_of("http://127.0.0.1:9735/mcp"), "http://127.0.0.1:9735/mcp");
        assert_eq!(endpoint_of("http://127.0.0.1:9751/mcp/gamestate"), "http://127.0.0.1:9751/mcp/gamestate");
    }
}
