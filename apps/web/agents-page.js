// agents-page.js — admin-only "Agents" page for the Ops platform.
//
// Two jobs:
//   1. Token generator — issue scoped bearer tokens for the Ops Knowledge MCP
//      (which collections, read vs read+write). Raw token is shown exactly once.
//   2. Setup guide — auto-generates the copy-paste MCP config (with the fresh
//      token filled in) for connecting an agent / cloud-code session.
//
// Returns { extraCss, body } for renderShell(), matching the other page modules.

const { getMcpCatalog, buildGettingStarted } = require("./mcp-catalog");
const MCP_CATALOG = getMcpCatalog();

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleString(); } catch { return "—"; }
}

const EXTRA_CSS = `
.ag-wrap{max-width:1180px;margin:0 auto;padding:var(--s-5) var(--s-4);display:flex;flex-direction:column;gap:var(--s-5)}
.ag-head h1{font-size:1.4rem;font-weight:700;letter-spacing:-.02em;margin:0 0 4px}
.ag-head p{color:var(--text-3,#888);font-size:.9rem;margin:0;max-width:640px}
.ag-card{border:1px solid var(--border,#2a2a2a);border-radius:14px;background:var(--bg-1,#161616);padding:18px 20px}
.ag-card h2{font-size:.95rem;font-weight:700;margin:0 0 14px;display:flex;align-items:center;gap:8px}
.ag-operations{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.ag-operations a{color:var(--accent)}.ag-operation{border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--bg-0)}.ag-operation strong{display:block;font-size:1.1rem}.ag-operation span{color:var(--text-3);font-size:.75rem}
.ag-operation{min-height:104px;display:flex;flex-direction:column;justify-content:space-between;border-radius:var(--r-md);padding:var(--s-4);background:var(--surface)}.ag-operation strong{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:clamp(1rem,2vw,1.25rem)}.ag-operation.status-good{border-color:color-mix(in srgb,var(--green) 34%,var(--border))}.ag-operation.status-good strong{color:var(--green)}.ag-operation.status-bad{border-color:color-mix(in srgb,var(--red) 34%,var(--border))}.ag-operation.status-bad strong{color:var(--red)}
.ag-row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end}
.ag-field{display:flex;flex-direction:column;gap:6px}
.ag-field label{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3,#888)}
.ag-field input[type=text]{padding:.5rem .75rem;border-radius:9px;border:1px solid var(--border,#2a2a2a);background:var(--bg-0,#0e0e0e);color:var(--text,#eee);font-size:.85rem;font-family:inherit;min-width:220px;outline:none}
.ag-field input:focus{border-color:var(--accent,#6c8cff)}
.ag-scopes{display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.ag-chk{display:inline-flex;align-items:center;gap:6px;font-size:.85rem;color:var(--text,#eee);cursor:pointer}
.ag-btn{padding:.55rem 1.1rem;border-radius:9px;border:1px solid transparent;background:var(--accent,#6c8cff);color:var(--on-accent,#fff);font-weight:600;font-size:.85rem;cursor:pointer;font-family:inherit}
.ag-btn:hover{filter:brightness(1.08)}
.ag-btn.ghost{background:transparent;border-color:var(--border,#2a2a2a);color:var(--text-2,#bbb)}
.ag-btn.danger{background:transparent;border-color:color-mix(in srgb,var(--red) 50%,var(--border));color:var(--red);padding:.3rem .6rem;font-size:.75rem}
.ag-table{width:100%;border-collapse:collapse;font-size:.84rem}
.ag-table th{text-align:left;font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3,#888);font-weight:600;padding:6px 10px;border-bottom:1px solid var(--border,#2a2a2a)}
.ag-table td{padding:9px 10px;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);vertical-align:middle}
.ag-pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.7rem;font-weight:600;background:var(--glass-2,#222);color:var(--text-2,#bbb);margin-right:4px}
.ag-pill.w{background:color-mix(in srgb,var(--amber) 22%,transparent);color:var(--amber)}
.ag-pill.revoked{background:color-mix(in srgb,var(--red) 18%,transparent);color:var(--red)}
.ag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem}
.ag-guide pre{background:var(--bg-0,#0e0e0e);border:1px solid var(--border,#2a2a2a);border-radius:10px;padding:14px 16px;overflow-x:auto;font-size:.78rem;line-height:1.5;margin:8px 0}
.ag-guide code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ag-tabs{display:flex;gap:6px;margin-bottom:6px}
.ag-tab{padding:.35rem .8rem;border-radius:8px;border:1px solid var(--border,#2a2a2a);background:transparent;color:var(--text-2,#bbb);font-size:.8rem;cursor:pointer;font-family:inherit}
.ag-tab.on{background:var(--glass-2,#222);color:var(--text,#eee);border-color:color-mix(in srgb,var(--accent) 40%,var(--border))}
.ag-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:200;padding:20px}
.ag-overlay.on{display:flex}
.ag-modal{background:var(--bg-1,#161616);border:1px solid var(--border,#2a2a2a);border-radius:16px;max-width:640px;width:100%;padding:22px 24px}
.ag-modal h3{margin:0 0 6px;font-size:1.05rem}
.ag-modal .warn{color:var(--amber);font-size:.82rem;margin:0 0 14px}
.ag-tokbox{display:flex;gap:8px;align-items:center;margin:10px 0}
.ag-tokbox input{flex:1;padding:.55rem .7rem;border-radius:9px;border:1px solid var(--border);background:var(--bg-0,#0e0e0e);color:var(--text,#eee);font-family:ui-monospace,monospace;font-size:.8rem}
.ag-empty{color:var(--text-3,#888);font-size:.85rem;padding:14px 4px}
.ag-section{font-size:.95rem;font-weight:700;margin:6px 0 0}.ag-section .ag-hint{color:var(--text-3,#888);font-weight:400;font-size:.85rem}
.ag-mcps{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
.ag-mcp{border:1px solid var(--border,#2a2a2a);border-radius:13px;background:var(--bg-1,#161616);padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.ag-mcp-top{display:flex;align-items:center;gap:8px}
.ag-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}.ag-dot.up{background:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 22%,transparent)}.ag-dot.down{background:var(--red)}.ag-dot.na{background:var(--text-3,#666)}
.ag-mcp-ico{font-size:1.05rem}.ag-mcp-name{font-weight:700;font-size:.92rem}
.ag-mcp-tr{margin-left:auto;font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3,#888);border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:1px 8px}
.ag-mcp-desc{font-size:.82rem;color:var(--text-2,#bbb);line-height:1.45}
.ag-tools{display:flex;flex-wrap:wrap;gap:4px}
.ag-tool{font-size:.68rem;font-family:ui-monospace,Menlo,monospace;background:var(--glass-2,#222);color:var(--text-3,#999);padding:1px 6px;border-radius:5px}
.ag-connect summary{cursor:pointer;font-size:.78rem;color:var(--accent,#6c8cff);font-weight:600;list-style:none}.ag-connect summary::-webkit-details-marker{display:none}.ag-connect summary::before{content:"▸ connect"}.ag-connect[open] summary::before{content:"▾ connect"}
.ag-connect pre{margin:8px 0 2px}
.ag-wire{margin:0;padding-left:1.1rem;font-size:.85rem;line-height:1.6;color:var(--text-2,#bbb)}.ag-wire code{font-family:ui-monospace,Menlo,monospace;font-size:.92em;background:var(--bg-0,#0e0e0e);padding:.05em .35em;border-radius:4px}.ag-wire a{color:var(--accent,#6c8cff)}
.ag-rec{display:inline-block;padding:1px 9px;border-radius:999px;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.ag-rec.keep{background:color-mix(in srgb,var(--green) 20%,transparent);color:var(--green)}
.ag-rec.verify{background:color-mix(in srgb,var(--amber) 22%,transparent);color:var(--amber)}
.ag-rec.ditch{background:color-mix(in srgb,var(--red) 18%,transparent);color:var(--red)}
.ag-sig{font-size:.72rem;color:var(--text-3,#888);font-family:ui-monospace,Menlo,monospace}
.ag-diff{background:var(--bg-0,#0e0e0e);border:1px solid var(--border,#2a2a2a);border-radius:10px;padding:10px 12px;overflow-x:auto;font-family:ui-monospace,Menlo,monospace;font-size:.76rem;line-height:1.5;margin:8px 0;max-height:52vh}
.ag-diff .d-add{color:var(--green);background:color-mix(in srgb,var(--green) 9%,transparent);display:block}
.ag-diff .d-del{color:var(--red);background:color-mix(in srgb,var(--red) 9%,transparent);display:block}
.ag-diff .d-ctx{color:var(--text-3,#888);display:block}
.ag-vchip{display:inline-block;padding:2px 8px;margin:0 4px 4px 0;border-radius:7px;border:1px solid var(--border,#2a2a2a);background:transparent;color:var(--text-2,#bbb);font-size:.74rem;cursor:pointer;font-family:inherit}
.ag-vchip.on{border-color:var(--accent,#6c8cff);color:var(--text,#eee);background:var(--glass-2,#222)}
.ag-vchip .vm{color:var(--text-3,#888);font-size:.68rem}
`;

function connectSnippet(m) {
  if (m.connect === "http") {
    return `<pre><code>claude mcp add --transport http ${m.key} \\
  ${esc(m.url)} \\
  --header "Authorization: Bearer &lt;TOKEN&gt;"</code></pre>
<p style="font-size:.76rem;color:var(--text-3);margin:4px 0 0">Public — works from any Claude Code with a token.</p>`;
  }
  if (m.connect === "stdio") {
    return `<pre><code># /root/.hermes/config.yaml → mcp_servers
${m.key}:
  command: npx
  args: ["-y", "${esc(m.url)}"]
  env: { GLITCHTIP_API_ENDPOINT: ".../errors", GLITCHTIP_API_TOKEN: "&lt;TOKEN&gt;", GLITCHTIP_ORGANIZATION_SLUG: "ahousedivided" }</code></pre>`;
  }
  // on-box HTTP — already wired into hermes + cloud-code
  return `<pre><code># /root/.hermes/config.yaml → mcp_servers
${m.key}:
  url: "${esc(m.localUrl || m.url)}"
  headers:
    Authorization: "Bearer &lt;TOKEN&gt;"</code></pre>
<p style="font-size:.76rem;color:var(--text-3);margin:4px 0 0">✓ On-box only — not reachable from the public host. Already wired into hermes &amp; auto-loaded in cloud-code sessions.</p>`;
}

function renderMcps(status) {
  status = status || {};
  return '<div class="ag-mcps">' + getMcpCatalog().map((m) => {
    const dot = m.health == null ? '<span class="ag-dot na" title="stdio"></span>'
      : `<span class="ag-dot ${status[m.key] ? "up" : "down"}" title="${status[m.key] ? "healthy" : "down"}"></span>`;
    const tools = m.tools.map((t) => `<span class="ag-tool">${esc(t)}</span>`).join("");
    return `<div class="ag-mcp">
      <div class="ag-mcp-top">${dot}<span class="ag-mcp-ico">${m.icon}</span><span class="ag-mcp-name">${esc(m.name)}</span><span class="ag-mcp-tr">${esc(m.transport)}</span></div>
      <div class="ag-mcp-desc">${esc(m.desc)}</div>
      <div class="ag-tools">${tools}</div>
      <details class="ag-connect"><summary></summary>${connectSnippet(m)}</details>
    </div>`;
  }).join("") + "</div>";
}

function tokenRows(tokens) {
  if (!tokens || !tokens.length) {
    return `<tr><td colspan="5"><div class="ag-empty">No tokens yet. Generate one above to connect an agent.</div></td></tr>`;
  }
  return tokens
    .map((t) => {
      const cols = (t.scopes && t.scopes.collections) || [];
      const pills = cols.map((c) => `<span class="ag-pill">${esc(c)}</span>`).join("");
      const wpill = t.scopes && t.scopes.write ? `<span class="ag-pill w">write</span>` : `<span class="ag-pill">read</span>`;
      const revoked = !!t.revokedAt;
      const status = revoked
        ? `<span class="ag-pill revoked">revoked</span>`
        : `<span class="ag-mono">${esc(t.display || "")}</span>`;
      const action = revoked
        ? ""
        : `<button class="ag-btn danger" data-revoke="${esc(String(t._id))}">Revoke</button>`;
      return `<tr>
        <td><strong>${esc(t.name)}</strong><br><span class="ag-mono" style="color:var(--text-3)">${status}</span></td>
        <td>${pills} ${wpill}</td>
        <td>${esc(fmtDate(t.createdAt))}</td>
        <td>${esc(fmtDate(t.lastUsedAt))}</td>
        <td style="text-align:right">${action}</td>
      </tr>`;
    })
    .join("");
}

function makeAgentsBody({ tokens = [], tokensUnavailable = false, mcpUrl = "https://mcp.lakesidegames.net/mcp", status = {}, operations = {} } = {}) {
  const gettingStarted = buildGettingStarted(mcpUrl);
  const body = `
<div class="ag-wrap">
  <div class="ag-head">
    <h1>Agents</h1>
    <p>See the agent fleet at a glance, inspect worktree pressure, and manage MCP access.</p>
  </div>

  <div class="ag-tabs">
    <button class="ag-tab on" data-tab="console">Console</button>
    <button class="ag-tab" data-tab="bootstrap">Getting Started Prompt</button>
    <button class="ag-tab" data-tab="review">Review Queue</button>
    <button class="ag-tab" data-tab="history">History</button>
  </div>

  <div data-pane="console">
  <div class="ag-card">
    <h2>Agent operations</h2>
    <div class="ag-operations">
      <div class="ag-operation ${operations.paseo === true ? "status-good" : operations.paseo === false ? "status-bad" : ""}"><strong>${operations.paseo === true ? "Running" : operations.paseo === false ? "Unavailable" : "Unknown"}</strong><span>Paseo daemon</span></div>
      <div class="ag-operation"><strong>${esc(operations.todayCost || "Loading…")}</strong><span>Agent usage today · <a href="/code">sessions</a></span></div>
      <div class="ag-operation"><strong>${operations.todayTokens == null ? "Loading…" : esc(Number(operations.todayTokens).toLocaleString("en-US"))}</strong><span>Tokens today</span></div>
      <div class="ag-operation"><strong>${operations.worktrees == null ? "No report" : esc(operations.worktrees)}</strong><span>Worktrees needing attention · <a href="/worktrees">fleet</a></span></div>
    </div>
  </div>
  <div class="ag-card">
    <h2>Generate token</h2>
    <div class="ag-row">
      <div class="ag-field">
        <label>Agent name</label>
        <input type="text" id="ag-name" placeholder="e.g. cloud-code-dev" autocomplete="off">
      </div>
      <div class="ag-field">
        <label>Collections</label>
        <div class="ag-scopes">
          <label class="ag-chk"><input type="checkbox" class="ag-col" value="docs" checked> docs</label>
          <label class="ag-chk"><input type="checkbox" class="ag-col" value="skills" checked> skills</label>
          <label class="ag-chk"><input type="checkbox" class="ag-col" value="memory" checked> memory</label>
        </div>
      </div>
      <div class="ag-field">
        <label>Access</label>
        <label class="ag-chk"><input type="checkbox" id="ag-write"> allow write (save / update / delete)</label>
      </div>
      <button class="ag-btn" id="ag-gen">Generate</button>
    </div>
  </div>

  <div class="ag-card">
    <h2>Active tokens</h2>
    <table class="ag-table">
      <thead><tr><th>Agent</th><th>Scope</th><th>Created</th><th>Last used</th><th></th></tr></thead>
      <tbody id="ag-tbody">${tokensUnavailable ? '<tr><td colspan="5"><div class="ag-empty">Token service is temporarily unavailable. Try again shortly.</div></td></tr>' : tokenRows(tokens)}</tbody>
    </table>
  </div>

  <h2 class="ag-section">Platform MCPs <span class="ag-hint">— what agents can use</span></h2>
  ${renderMcps(status)}

  <div class="ag-card">
    <h2>How agents connect</h2>
    <ul class="ag-wire">
      <li><strong>Generate one token</strong> above (read-only is the safe default) — this single token is what every MCP below checks; there's no separate credential per MCP.</li>
      <li><strong>On-box MCPs</strong> (support, gamestate, engine, worldsim, security, discord, community) are HTTP servers on <code>127.0.0.1</code>. For hermes, paste a block per MCP into <code>/root/.hermes/config.yaml → mcp_servers</code> (see each card's <em>connect</em> snippet), then <code>systemctl --user restart hermes-gateway</code>.</li>
      <li><strong>Claude Code / cloud-code</strong>: <code>claude mcp add --transport http &lt;name&gt; http://127.0.0.1:&lt;port&gt;/mcp --header "Authorization: Bearer &lt;TOKEN&gt;"</code> for each on-box MCP (user scope, so it's available in every session). Run <code>claude mcp list</code> to confirm all are Connected.</li>
      <li><strong>Public MCP</strong> (Ops Knowledge) works from anywhere with the token — <code>https://mcp.lakesidegames.net/mcp</code> — see its connect snippet.</li>
      <li><strong>Any other agent / raw HTTP</strong>: it's just Streamable HTTP MCP — <code>POST http://127.0.0.1:&lt;port&gt;/mcp</code> with header <code>Authorization: Bearer &lt;TOKEN&gt;</code>. No SDK-specific glue required.</li>
      <li><strong>Add a new MCP</strong>: <code>MCP-HANDOFF.md</code> (repo root) — paste a block into <code>mcp_servers</code>; the gateway hot-reloads.</li>
      <li>Surfaces: <a href="/code">/code</a> · <a href="/ideas">/ideas</a> · <a href="/engine">/engine</a> · <code>/api/ask-public</code>.</li>
    </ul>
  </div>
  </div><!-- /console pane -->

  <div data-pane="bootstrap" style="display:none">
    <div class="ag-card ag-guide">
      <h2>🧠 Getting Started Prompt <span class="ag-hint" style="font-weight:400;color:var(--text-3)">— onboard any agent in one paste</span></h2>
      <p style="color:var(--text-3);font-size:.85rem;margin:0 0 12px;max-width:640px">One prompt that contextualizes a fresh agent to the shared brain, the live toolbelt, the project layout, and how we work. Drop it into a new Claude / Kimi / Hermes / cloud-code session (with a token from the Console tab) and it's productive immediately.</p>
      <div style="text-align:right;margin-bottom:6px"><button class="ag-btn" id="ag-copy-prompt">Copy prompt</button></div>
      <pre id="ag-prompt" style="white-space:pre-wrap;max-height:60vh;overflow:auto">${esc(gettingStarted)}</pre>
    </div>
  </div>

  <div data-pane="review" style="display:none">
    <div class="ag-card">
      <h2>🧹 Review queue <span class="ag-hint" style="font-weight:400;color:var(--text-3)">— entries an agent read while &gt;7 days stale</span></h2>
      <p style="color:var(--text-3);font-size:.85rem;margin:0 0 12px;max-width:640px">Each carries a heuristic recommendation: <strong>keep</strong> (used/maintained), <strong>verify</strong> (docs &amp; skills — confirm still correct), <strong>ditch</strong> (cold, unused memory). Mark reviewed to clear the flag, or delete to prune.</p>
      <div style="margin-bottom:8px"><button class="ag-btn ghost" id="ag-rv-refresh">Refresh</button></div>
      <div id="ag-rv-body"><div class="ag-empty">Loading…</div></div>
    </div>
  </div>

  <div data-pane="history" style="display:none">
    <div class="ag-card">
      <h2>🕓 Version history <span class="ag-hint" style="font-weight:400;color:var(--text-3)">— every save snapshots the prior revision (docs · skills · memory)</span></h2>
      <div class="ag-row" style="margin-bottom:10px">
        <div class="ag-field"><label>Collection</label>
          <select id="ag-hi-kind" style="padding:.5rem .6rem;border-radius:9px;border:1px solid var(--border);background:var(--bg-0,#0e0e0e);color:var(--text,#eee);font-family:inherit;font-size:.85rem"><option value="docs">docs</option><option value="skills">skills</option><option value="memory">memory</option></select>
        </div>
        <div class="ag-field"><label>Entry name (slug)</label><input type="text" id="ag-hi-name" placeholder="e.g. ahd-turn-stuck-incident" autocomplete="off"></div>
        <button class="ag-btn" id="ag-hi-load">Load</button>
      </div>
      <div id="ag-hi-body"></div>
    </div>
  </div>
</div>

<div class="ag-overlay" id="ag-overlay">
  <div class="ag-modal">
    <h3>Token created</h3>
    <p class="warn">Copy this now — it will not be shown again.</p>
    <div class="ag-tokbox">
      <input type="text" id="ag-newtoken" readonly>
      <button class="ag-btn" id="ag-copy">Copy</button>
    </div>
    <pre><code id="ag-snippet"></code></pre>
    <div style="text-align:right;margin-top:8px"><button class="ag-btn ghost" id="ag-done">Done</button></div>
  </div>
</div>

<script>
(function(){
  var MCP_URL = ${JSON.stringify(mcpUrl)};
  function $(s){return document.querySelector(s);}
  // tabs
  document.querySelectorAll('.ag-tab').forEach(function(t){
    t.onclick=function(){
      document.querySelectorAll('.ag-tab').forEach(function(x){x.classList.remove('on');});
      t.classList.add('on');
      document.querySelectorAll('[data-pane]').forEach(function(p){p.style.display='none';});
      var pane=document.querySelector('[data-pane="'+t.getAttribute('data-tab')+'"]');
      if(pane)pane.style.display='block';
    };
  });
  // copy getting-started prompt
  var cp=$('#ag-copy-prompt');
  if(cp)cp.onclick=function(){
    var txt=$('#ag-prompt').textContent;
    if(navigator.clipboard)navigator.clipboard.writeText(txt);
    else{var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);}
    cp.textContent='Copied ✓';setTimeout(function(){cp.textContent='Copy prompt';},1500);
  };
  // generate
  $('#ag-gen').onclick=function(){
    var name=$('#ag-name').value.trim();
    var cols=Array.prototype.map.call(document.querySelectorAll('.ag-col:checked'),function(c){return c.value;});
    if(!cols.length){alert('Pick at least one collection.');return;}
    var write=$('#ag-write').checked;
    $('#ag-gen').disabled=true;$('#ag-gen').textContent='Generating…';
    fetch('/api/agents/tokens',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:name,collections:cols,write:write})})
      .then(function(r){return r.json();})
      .then(function(d){
        $('#ag-gen').disabled=false;$('#ag-gen').textContent='Generate';
        if(d.error){alert('Error: '+d.error);return;}
        $('#ag-newtoken').value=d.token;
        $('#ag-snippet').textContent='claude mcp add --transport http ops-knowledge \\\\\\n  '+MCP_URL+' \\\\\\n  --header "Authorization: Bearer '+d.token+'"';
        $('#ag-overlay').classList.add('on');
      }).catch(function(e){$('#ag-gen').disabled=false;$('#ag-gen').textContent='Generate';alert('Request failed');});
  };
  $('#ag-copy').onclick=function(){var i=$('#ag-newtoken');i.select();try{document.execCommand('copy');}catch(e){}navigator.clipboard&&navigator.clipboard.writeText(i.value);$('#ag-copy').textContent='Copied';};
  $('#ag-done').onclick=function(){$('#ag-overlay').classList.remove('on');location.reload();};
  // revoke (delegated)
  document.getElementById('ag-tbody').addEventListener('click',function(e){
    var btn=e.target.closest('[data-revoke]');if(!btn)return;
    if(!confirm('Revoke this token? Agents using it will lose access immediately.'))return;
    fetch('/api/agents/tokens/revoke',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:btn.getAttribute('data-revoke')})})
      .then(function(r){return r.json();}).then(function(d){if(d.error)alert('Error: '+d.error);else location.reload();});
  });

  // ---- Review queue ----
  function esch(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function fmtWhen(x){if(!x)return '';try{return new Date(x).toLocaleDateString();}catch(e){return '';}}
  var reviewLoaded=false;
  function loadReview(){
    function setHtml(el,html){if(!el)return;if(window.OpsDom&&OpsDom.setTrustedHtml)OpsDom.setTrustedHtml(el,html);}
    var box=$('#ag-rv-body');setHtml(box,'<div class="ag-empty">Loading…</div>');
    fetch('/api/knowledge/review-queue').then(function(r){return r.json();}).then(function(d){
      if(d.error){setHtml(box,'<div class="ag-empty">Error: '+esch(d.error)+'</div>');return;}
      if(!d.items||!d.items.length){setHtml(box,'<div class="ag-empty">Nothing flagged. Entries land here when an agent reads something not updated in over a week.</div>');return;}
      var rows=d.items.map(function(it){var s=it.signals||{};
        return '<tr>'+
          '<td><strong>'+esch(it.title||it.name)+'</strong><br><span class="ag-mono" style="color:var(--text-3)">'+esch(it.kind)+'/'+esch(it.name)+'</span></td>'+
          '<td><span class="ag-rec '+esch(it.recommendation)+'">'+esch(it.recommendation)+'</span><br><span class="ag-sig">hits '+(s.hits||0)+' · edits '+(s.edits||0)+' · '+(s.sinceRetrieved==null?'—':s.sinceRetrieved+'d')+'</span></td>'+
          '<td style="font-size:.8rem;color:var(--text-2)">'+esch(it.reason||'')+'</td>'+
          '<td style="text-align:right;white-space:nowrap"><button class="ag-btn ghost" data-rv-mark="'+esch(it.kind)+'/'+esch(it.name)+'" style="padding:.3rem .6rem;font-size:.75rem">Reviewed</button> <button class="ag-btn danger" data-rv-del="'+esch(it.kind)+'/'+esch(it.name)+'">Delete</button></td>'+
        '</tr>';
      }).join('');
      setHtml(box,'<table class="ag-table"><thead><tr><th>Entry</th><th>Recommendation</th><th>Why</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>');
    }).catch(function(){setHtml(box,'<div class="ag-empty">Request failed.</div>');});
  }
  function reviewAction(kind,name,action){return fetch('/api/knowledge/review-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:kind,name:name,action:action})}).then(function(r){return r.json();});}
  $('#ag-rv-refresh').onclick=loadReview;
  $('#ag-rv-body').addEventListener('click',function(e){
    var mk=e.target.closest('[data-rv-mark]'),dl=e.target.closest('[data-rv-del]');
    if(mk){var a=mk.getAttribute('data-rv-mark').split('/');reviewAction(a[0],a.slice(1).join('/'),'mark').then(loadReview);}
    else if(dl){var b=dl.getAttribute('data-rv-del');if(!confirm('Delete '+b+'? (soft-delete, recoverable)'))return;var c=b.split('/');reviewAction(c[0],c.slice(1).join('/'),'delete').then(loadReview);}
  });

  // ---- History / diff ----
  function loadHistory(from){
    var kind=$('#ag-hi-kind').value,name=$('#ag-hi-name').value.trim();
    if(!name)return;
    var box=$('#ag-hi-body');setHtml(box,'<div class="ag-empty">Loading…</div>');
    var q='/api/knowledge/history?kind='+encodeURIComponent(kind)+'&name='+encodeURIComponent(name);
    if(from)q+='&from='+encodeURIComponent(from);
    fetch(q).then(function(r){return r.json();}).then(function(d){
      if(d.error){setHtml(box,'<div class="ag-empty">'+esch(d.error)+'</div>');return;}
      renderHistory(d);
    }).catch(function(){setHtml(box,'<div class="ag-empty">Request failed.</div>');});
  }
  function renderHistory(d){
    var box=$('#ag-hi-body');
    var chips=d.versions.map(function(v){
      var on=(d.diff&&v.version===d.diff.fromVersion)?' on':'';
      return '<button class="ag-vchip'+on+'" data-ver="'+v.version+'" title="'+esch(v.updatedBy||'')+'">v'+v.version+(v.current?' (current)':'')+' <span class="vm">'+esch(fmtWhen(v.updatedAt))+'</span></button>';
    }).join('');
    var diffHtml;
    if(d.diff){
      var lines=(d.diff.patch||'').split('\\n').map(function(ln){
        var cls=ln.charAt(0)==='+'?'d-add':ln.charAt(0)==='-'?'d-del':'d-ctx';
        return '<span class="'+cls+'">'+esch(ln||' ')+'</span>';
      }).join('');
      diffHtml='<div style="font-size:.78rem;color:var(--text-3);margin:6px 0 2px">Diff v'+d.diff.fromVersion+' → v'+d.diff.toVersion+' <span>(click a version to diff it against current)</span></div><div class="ag-diff">'+lines+'</div>';
    }else{diffHtml='<div class="ag-empty">Only one version — nothing to diff yet.</div>';}
    setHtml(box,'<div style="margin:4px 0 8px">'+chips+'</div>'+diffHtml);
  }
  $('#ag-hi-load').onclick=function(){loadHistory(null);};
  $('#ag-hi-name').addEventListener('keydown',function(e){if(e.key==='Enter')loadHistory(null);});
  $('#ag-hi-body').addEventListener('click',function(e){var v=e.target.closest('[data-ver]');if(v)loadHistory(v.getAttribute('data-ver'));});

  // lazy-load the review queue the first time its tab opens
  document.querySelectorAll('.ag-tab').forEach(function(t){
    t.addEventListener('click',function(){if(t.getAttribute('data-tab')==='review'&&!reviewLoaded){reviewLoaded=true;loadReview();}});
  });
})();
</script>
`;
  return { extraCss: EXTRA_CSS, body };
}

module.exports = { makeAgentsBody };
