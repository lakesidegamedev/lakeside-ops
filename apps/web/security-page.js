"use strict";

// ─── SECURITY PAGE ────────────────────────────────────────────────────────
// Renders the two-VPS security posture that security-service.js assembles.
//
// Client code builds DOM with createElement/textContent rather than innerHTML:
// every value here originates on a remote host, and scripts/check-innerhtml.js
// ratchets unescaped sinks downward. Nothing on this page is interpolated into
// markup on the client.

const CSS = `
.sec{display:flex;flex-direction:column;gap:var(--s-4);max-width:1200px}
.sec-head{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--s-4);flex-wrap:wrap}
.sec-head h1{font-size:var(--fs-h1);margin:0 0 .25rem}
.sec-head p{margin:0;color:var(--text-3);font-size:var(--fs-sm)}
.sec-actions{display:flex;align-items:center;gap:var(--s-2)}
.sec-btn{appearance:none;border:1px solid var(--border);background:var(--glass-2);color:var(--text-1);border-radius:var(--r-md);padding:.45rem .8rem;font-size:var(--fs-sm);cursor:pointer}
.sec-btn:hover{background:var(--glass-hover)}
.sec-btn[disabled]{opacity:.55;cursor:progress}
.sec-stamp{color:var(--text-3);font-size:var(--fs-2xs);font-family:var(--mono)}

.sec-overview{display:grid;grid-template-columns:auto 1fr;gap:var(--s-4);align-items:center;padding:var(--s-4);border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface)}
.sec-ring{--value:0;--ring:var(--green);width:118px;aspect-ratio:1;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--ring) calc(var(--value)*1%),var(--glass-3) 0);position:relative}
.sec-ring:after{content:'';position:absolute;inset:9px;border-radius:50%;background:var(--bg-1);box-shadow:inset 0 0 0 1px var(--border)}
.sec-ring.watch{--ring:var(--amber)}.sec-ring.at-risk{--ring:var(--red)}.sec-ring.critical{--ring:var(--red)}
.sec-ring-in{position:relative;z-index:1;text-align:center}
.sec-ring-in b{display:block;font-size:1.7rem;line-height:1}
.sec-ring-in span{display:block;margin-top:.2rem;font-size:var(--fs-2xs);color:var(--text-3);text-transform:uppercase;letter-spacing:.08em}
.sec-counts{display:flex;flex-wrap:wrap;gap:var(--s-2)}
.sec-count{display:flex;align-items:baseline;gap:.4rem;padding:.4rem .7rem;border-radius:var(--r-md);border:1px solid var(--border);background:var(--glass-2);font-size:var(--fs-sm)}
.sec-count b{font-family:var(--mono);font-size:1rem}
.sec-count.critical{border-color:var(--red)}.sec-count.critical b{color:var(--red)}
.sec-count.high{border-color:var(--red);opacity:.92}.sec-count.high b{color:var(--red)}
.sec-count.medium b{color:var(--amber)}
.sec-count.low b{color:var(--text-2)}
.sec-count.info b{color:var(--text-3)}
.sec-count.zero{opacity:.5}

.sec-hosts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--s-3)}
.sec-host{border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);padding:var(--s-4);display:flex;flex-direction:column;gap:var(--s-3)}
.sec-host.down{border-color:var(--red)}
.sec-host-top{display:flex;align-items:center;justify-content:space-between;gap:var(--s-2)}
.sec-host-top h2{font-size:1rem;margin:0;display:flex;align-items:center;gap:.5rem}
.sec-dot{width:.55rem;height:.55rem;border-radius:50%;background:var(--green);display:inline-block}
.sec-dot.stale,.sec-dot.down{background:var(--red)}
.sec-host-sub{font-size:var(--fs-2xs);color:var(--text-3);font-family:var(--mono)}
.sec-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--s-1) var(--s-3)}
.sec-kv{display:flex;justify-content:space-between;gap:.5rem;padding:.3rem 0;border-bottom:1px solid var(--border);font-size:var(--fs-sm);min-width:0}
.sec-kv span:first-child{color:var(--text-3);white-space:nowrap}
.sec-kv span:last-child{font-family:var(--mono);font-size:var(--fs-xs);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sec-kv .ok{color:var(--green)}.sec-kv .bad{color:var(--red)}.sec-kv .warn{color:var(--amber)}
.sec-host-err{margin:0;padding:.5rem .6rem;border-radius:var(--r-md);background:var(--red-soft);color:var(--red);font-size:var(--fs-xs);font-family:var(--mono);overflow-wrap:anywhere}

.sec-findings{display:flex;flex-direction:column;gap:var(--s-2)}
.sec-finding{border:1px solid var(--border);border-left:3px solid var(--text-3);border-radius:var(--r-md);background:var(--surface);padding:var(--s-3)}
.sec-finding.critical{border-left-color:var(--red);background:linear-gradient(90deg,var(--red-soft),transparent 55%)}
.sec-finding.high{border-left-color:var(--red)}
.sec-finding.medium{border-left-color:var(--amber)}
.sec-finding.low{border-left-color:var(--text-2)}
.sec-finding-top{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
.sec-sev{font-family:var(--mono);font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.07em;padding:.15rem .4rem;border-radius:var(--r-xs);background:var(--glass-3);color:var(--text-2)}
.sec-finding.critical .sec-sev{background:var(--red);color:#fff}
.sec-finding.high .sec-sev{background:var(--red-soft);color:var(--red)}
.sec-finding.medium .sec-sev{background:var(--amber-soft);color:var(--amber)}
.sec-finding h3{margin:0;font-size:var(--fs-sm);font-weight:600}
.sec-hostchip{margin-left:auto;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--text-3);border:1px solid var(--border);border-radius:var(--r-full);padding:.1rem .5rem}
.sec-finding p{margin:.4rem 0 0;color:var(--text-2);font-size:var(--fs-sm)}
.sec-fix{margin-top:.45rem;font-family:var(--mono);font-size:var(--fs-2xs);color:var(--text-3);overflow-wrap:anywhere}
.sec-fix b{color:var(--text-2);font-weight:600}
.sec-empty{padding:var(--s-4);border:1px dashed var(--border);border-radius:var(--r-md);color:var(--text-3);font-size:var(--fs-sm);text-align:center}
.sec-legend{color:var(--text-3);font-size:var(--fs-2xs);margin:0}
@media(max-width:700px){
  .sec-overview{grid-template-columns:1fr;justify-items:center;text-align:center}
  .sec-grid{grid-template-columns:1fr}
  .sec-head{flex-direction:column}
}
`;

function makeSecurityBody() {
  const body = `<main class="sec">
  <header class="sec-head">
    <div>
      <h1>Security</h1>
      <p>Host hardening, monitoring health and open findings across both VPS hosts.</p>
    </div>
    <div class="sec-actions">
      <span class="sec-stamp" id="sec-stamp">Loading…</span>
      <button class="sec-btn" id="sec-refresh" type="button">Re-probe</button>
    </div>
  </header>

  <section class="sec-overview" aria-label="Security posture">
    <div class="sec-ring" id="sec-ring"><div class="sec-ring-in"><b id="sec-score">–</b><span>Posture</span></div></div>
    <div>
      <div class="sec-counts" id="sec-counts"></div>
      <p class="sec-legend" id="sec-legend">Waiting for the first probe.</p>
    </div>
  </section>

  <section class="sec-hosts" id="sec-hosts" aria-label="Hosts"></section>

  <section class="sec-findings" id="sec-findings" aria-label="Findings"></section>
</main>
<script>
(function(){
  "use strict";
  var SEV_ORDER = ["critical","high","medium","low","info"];

  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function kv(label, value, tone){
    var row = el("div","sec-kv");
    row.appendChild(el("span", null, label));
    var v = el("span", tone || null, value === undefined || value === null || value === "" ? "—" : value);
    v.title = v.textContent;
    row.appendChild(v);
    return row;
  }
  function fmtAge(ms){
    if (ms === null || ms === undefined) return "never";
    var s = Math.round(ms/1000);
    if (s < 90) return s + "s ago";
    var m = Math.round(s/60);
    if (m < 90) return m + "m ago";
    return Math.round(m/60) + "h ago";
  }
  function tone(ok, soft){
    if (ok === true) return "ok";
    if (ok === false) return "bad";
    return soft || null;
  }

  function renderHosts(hosts){
    var root = document.getElementById("sec-hosts");
    root.replaceChildren();
    (hosts || []).forEach(function(h){
      var card = el("article","sec-host" + (h.ok ? "" : " down"));
      var top = el("div","sec-host-top");
      var title = el("h2");
      title.appendChild(el("span","sec-dot" + (h.ok ? (h.stale ? " stale" : "") : " down")));
      title.appendChild(document.createTextNode(h.label + " · " + (h.name || "")));
      top.appendChild(title);
      top.appendChild(el("span","sec-host-sub", h.collectedAt ? fmtAge(h.ageMs) : "no data"));
      card.appendChild(top);

      if (!h.ok && h.error) {
        card.appendChild(el("p","sec-host-err", h.error));
      }
      if (!h.firewall) {
        card.appendChild(el("p","sec-host-sub","No probe data yet — install and start lakeside-security-probe.timer on this host."));
        root.appendChild(card);
        return;
      }

      var grid = el("div","sec-grid");
      grid.appendChild(kv("Firewall", h.firewall.active ? "active · deny in" : "INACTIVE", tone(h.firewall.active)));
      var f2b = h.fail2ban || {};
      grid.appendChild(kv("fail2ban", f2b.running ? (f2b.jails || []).join("+") : "DOWN", tone(!!f2b.running)));
      grid.appendChild(kv("Bans now", f2b.currentlyBanned, f2b.currentlyBanned > 0 ? "warn" : null));
      grid.appendChild(kv("Bans total", f2b.totalBanned, null));
      var a = h.auditd || {};
      grid.appendChild(kv("auditd", a.active ? ("active · " + (a.rules || 0) + " rules") : "DOWN", tone(!!a.active)));
      var u = h.updates || {};
      grid.appendChild(kv("Security updates", u.securityPending === 0 ? "none pending" : u.securityPending + " pending", u.securityPending > 0 ? "bad" : "ok"));
      var s = h.ssh || {};
      grid.appendChild(kv("SSH password auth", s.passwordAuthentication === "no" ? "off" : "ON", tone(s.passwordAuthentication === "no")));
      grid.appendChild(kv("SSH root login", s.permitRootLogin || "—", ["prohibit-password","without-password","no"].indexOf(String(s.permitRootLogin)) >= 0 ? "ok" : "bad"));
      var au = h.auth || {};
      grid.appendChild(kv("SSH failed 24h", au.sshFailed24h === undefined ? "—" : au.sshFailed24h.toLocaleString(), au.sshFailed24h >= 5000 ? "warn" : null));
      grid.appendChild(kv("SSH accepted 24h", au.sshAccepted24h === undefined ? "—" : au.sshAccepted24h.toLocaleString(), null));
      card.appendChild(grid);

      var ex = h.exposure || {};
      if (ex.docker) {
        card.appendChild(el("p","sec-host-sub",
          "Containers: " + (ex.docker.running || 0) + " running · " +
          (ex.docker.privileged || 0) + " privileged · " +
          (ex.docker.hostNetwork || 0) + " host-network"));
      }
      root.appendChild(card);
    });
    if (!(hosts || []).length) root.appendChild(el("div","sec-empty","No hosts configured."));
  }

  function renderFindings(findings){
    var root = document.getElementById("sec-findings");
    root.replaceChildren();
    if (!findings || !findings.length) {
      root.appendChild(el("div","sec-empty","No findings. Both hosts are within baseline."));
      return;
    }
    findings.forEach(function(f){
      var item = el("article","sec-finding " + f.severity);
      var top = el("div","sec-finding-top");
      top.appendChild(el("span","sec-sev", f.severity));
      top.appendChild(el("h3", null, f.title));
      top.appendChild(el("span","sec-hostchip", f.hostLabel || f.host));
      item.appendChild(top);
      if (f.detail) item.appendChild(el("p", null, f.detail));
      if (f.remedy) {
        var fix = el("div","sec-fix");
        fix.appendChild(el("b", null, "Fix: "));
        fix.appendChild(document.createTextNode(f.remedy));
        item.appendChild(fix);
      }
      root.appendChild(item);
    });
  }

  function renderSummary(data){
    var s = data.summary || {};
    var ring = document.getElementById("sec-ring");
    ring.className = "sec-ring " + (s.posture || "");
    ring.style.setProperty("--value", String(Math.max(0, Math.min(100, Number(s.score) || 0))));
    document.getElementById("sec-score").textContent = String(s.score == null ? "–" : s.score);

    var counts = document.getElementById("sec-counts");
    counts.replaceChildren();
    SEV_ORDER.forEach(function(sev){
      var n = (s.counts && s.counts[sev]) || 0;
      var chip = el("div","sec-count " + sev + (n === 0 ? " zero" : ""));
      chip.appendChild(el("b", null, n));
      chip.appendChild(el("span", null, sev));
      counts.appendChild(chip);
    });

    var m = data.monitoring || {};
    var stamp = document.getElementById("sec-stamp");
    var parts = [];
    parts.push("posture " + (s.posture || "?"));
    parts.push((m.hostsReporting || 0) + "/" + (m.hostsTotal || 0) + " hosts reporting");
    if (data.generatedAt) parts.push("checked " + new Date(data.generatedAt).toLocaleTimeString());
    stamp.textContent = parts.join(" · ");
    document.getElementById("sec-legend").textContent =
      "Probe every " + (m.expectedIntervalMinutes || 15) + " min; a host goes stale after " + (m.staleAfterMinutes || 45) + " min. Score starts at 100 and loses 25 per critical, 10 per high, 4 per medium, 1 per low.";
  }

  var busy = false;
  async function load(force){
    if (busy) return;
    busy = true;
    var btn = document.getElementById("sec-refresh");
    if (btn) btn.disabled = true;
    try {
      // Re-probe is handled by the dedicated endpoint; this poll rides the
      // service's 60s cache so ten open tabs are not ten SSH calls.
      var r = await fetch("/api/security", { cache: "no-store", credentials: "same-origin" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      var data = await r.json();
      renderSummary(data);
      renderHosts(data.hosts);
      renderFindings(data.findings);
    } catch (e) {
      document.getElementById("sec-stamp").textContent = "refresh failed: " + e.message;
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  var btn = document.getElementById("sec-refresh");
  if (btn) btn.addEventListener("click", function(){
    btn.disabled = true;
    btn.textContent = "Probing…";
    fetch("/api/security/reprobe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "ops-dashboard" },
    })
      .then(function(){ return load(true); })
      .catch(function(){ return load(true); })
      .finally(function(){ btn.disabled = false; btn.textContent = "Re-probe"; });
  });

  load(false);
  setInterval(function(){ load(false); }, 30000);
})();
</script>`;
  return { extraCss: CSS, body };
}

module.exports = { makeSecurityBody, CSS };
