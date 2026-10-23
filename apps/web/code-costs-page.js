// code-costs-page.js — Full CodeBurn spend breakdown for the Code Agent.
// Period picker, KPIs, provider/model/project tables, and a session ledger.

const { icon, faviconFor, THEME_HEAD, THEME_TOGGLE_JS } = require('./ui-kit');

module.exports = function makeCodeCostsPage(FONT_LINKS, BASE_CSS) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Code burn — Lakeside Ops</title>
${THEME_HEAD}
<link rel="icon" href="${faviconFor('coins')}">
${FONT_LINKS}
<style>${BASE_CSS}
html,body{height:100%;overflow:auto;overscroll-behavior:contain}
body{background:var(--bg-0);color:var(--text)}

.costs-wrap{max-width:980px;margin:0 auto;padding:var(--s-6) var(--s-5);padding-top:max(var(--s-5),env(safe-area-inset-top));min-height:100dvh;display:flex;flex-direction:column;gap:var(--s-5)}

.page-top{display:flex;align-items:flex-start;gap:var(--s-3)}
.icon-btn{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:var(--r-md);border:1px solid transparent;background:transparent;color:var(--text-2);cursor:pointer;transition:background var(--t),color var(--t),border-color var(--t);flex-shrink:0;text-decoration:none;margin-top:2px}
.icon-btn:hover{background:var(--glass-2);border-color:var(--border);color:var(--text)}
.page-head{flex:1;min-width:0}
.page-title{font-size:clamp(1.35rem,3vw,1.65rem);font-weight:700;letter-spacing:-.03em;display:flex;align-items:center;gap:.65rem;color:var(--text);line-height:1.15}
.page-title .brand-mark{width:34px;height:34px;border-radius:var(--r-sm);background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;color:var(--on-accent);flex-shrink:0;box-shadow:var(--e1),0 0 0 1px color-mix(in srgb,var(--accent) 35%,transparent)}
.page-title .brand-mark svg{display:block}
.page-sub{margin:.35rem 0 0;font-size:.82rem;color:var(--text-3);line-height:1.45;max-width:40rem}
.page-actions{display:flex;align-items:center;gap:var(--s-2);flex-shrink:0;padding-top:2px}

.period-seg{display:inline-flex;align-items:center;padding:3px;border-radius:var(--r-full);border:1px solid var(--border);background:var(--glass-1);gap:2px}
.period-seg button{appearance:none;border:0;background:transparent;color:var(--text-3);font:600 .74rem var(--font);padding:.42rem .85rem;border-radius:999px;cursor:pointer;transition:background var(--t),color var(--t)}
.period-seg button:hover{color:var(--text)}
.period-seg button.active{background:var(--accent);color:var(--on-accent);box-shadow:var(--e1)}

.kpi-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--s-3)}
.kpi{padding:var(--s-4);border-radius:var(--r-lg);border:1px solid var(--border);background:color-mix(in srgb,var(--surface) 75%,transparent);box-shadow:var(--hi)}
.kpi .lbl{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)}
.kpi .val{margin-top:.35rem;font-size:1.35rem;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--text)}
.kpi .hint{margin-top:.2rem;font-size:.68rem;color:var(--text-3)}

.panel{border:1px solid var(--border);border-radius:var(--r-lg);background:color-mix(in srgb,var(--surface) 70%,transparent);box-shadow:var(--hi);overflow:hidden}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);padding:var(--s-3) var(--s-4);border-bottom:1px solid var(--border)}
.panel-title{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3)}
.panel-meta{font-size:.68rem;color:var(--text-3)}
.break-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s-4)}

.share-table{width:100%;border-collapse:collapse;font-size:.8rem}
.share-table th{text-align:left;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);padding:.55rem .9rem;border-bottom:1px solid var(--border)}
.share-table th.num,.share-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.share-table td{padding:.55rem .9rem;border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent);color:var(--text-2);vertical-align:middle}
.share-table tr:last-child td{border-bottom:0}
.share-table .name{color:var(--text);font-weight:600;max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.share-bar{display:block;height:4px;margin-top:.35rem;border-radius:99px;background:var(--glass-2);overflow:hidden}
.share-bar i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.share-empty{padding:var(--s-5);text-align:center;color:var(--text-3);font-size:.82rem}

.ledger-tools{display:flex;align-items:center;gap:var(--s-2);flex-wrap:wrap}
.ledger-tools input,.ledger-tools select{padding:.45rem .7rem;border-radius:var(--r-md);border:1px solid var(--border);background:var(--field-bg);color:var(--text);font:500 .78rem var(--font);outline:none;min-width:0}
.ledger-tools input{flex:1;min-width:140px}
.ledger-tools input:focus,.ledger-tools select:focus{border-color:var(--accent);box-shadow:var(--ring)}
.ledger-table-wrap{overflow:auto}
.ledger-table{width:100%;border-collapse:collapse;font-size:.78rem;min-width:720px}
.ledger-table th{position:sticky;top:0;background:var(--surface);z-index:1;text-align:left;font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);padding:.65rem .85rem;border-bottom:1px solid var(--border)}
.ledger-table th.num,.ledger-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.ledger-table td{padding:.6rem .85rem;border-bottom:1px solid color-mix(in srgb,var(--border) 65%,transparent);color:var(--text-2);vertical-align:top}
.ledger-table .provider{font-weight:650;color:var(--text);text-transform:capitalize}
.ledger-table .models{font-family:var(--mono);font-size:.68rem;color:var(--accent);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ledger-table .project{font-family:var(--mono);font-size:.7rem;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ledger-table .cost{font-weight:700;color:var(--text)}
.ledger-table .when{white-space:nowrap;font-size:.7rem}

.status-banner{display:none;align-items:center;gap:var(--s-3);padding:var(--s-3) var(--s-4);border-radius:var(--r-md);border:1px solid var(--border);background:var(--glass-1);color:var(--text-2);font-size:.84rem}
.status-banner.show{display:flex}
.status-banner.error{border-color:color-mix(in srgb,var(--red) 35%,var(--border));background:var(--red-soft);color:var(--red)}
.status-banner .loading-dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 55%,transparent);animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.foot-note{font-size:.68rem;color:var(--text-3);text-align:right}

@media(max-width:900px){
  .break-grid{grid-template-columns:1fr}
  .kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:600px){
  .costs-wrap{padding:10px;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(18px,env(safe-area-inset-bottom));gap:12px}
  .page-top{position:sticky;top:0;z-index:20;margin:0 -10px;padding:8px 10px;background:color-mix(in srgb,var(--bg-0) 88%,transparent);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-bottom:1px solid var(--border);align-items:center}
  .page-title{font-size:1.05rem}.page-title .brand-mark{width:28px;height:28px}.page-sub{display:none}
  .icon-btn{width:44px;height:44px;margin-top:0}
  .period-seg button{padding:.5rem .7rem;min-height:40px}
  .kpi-row{grid-template-columns:1fr 1fr;gap:8px}
  .kpi{padding:12px}.kpi .val{font-size:1.15rem}
}
</style>
</head>
<body>
<div class="costs-wrap">
  <div class="page-top">
    <a href="/code" class="icon-btn" title="Back to Code Agent">${icon('arrow-left', { size: 18 })}</a>
    <div class="page-head">
      <div class="page-title"><span class="brand-mark">${icon('coins', { size: 18 })}</span> Code burn</div>
      <p class="page-sub">API-equivalent spend via CodeBurn — by provider, model, project, and session.</p>
    </div>
    <div class="page-actions">
      <div class="period-seg" id="period-seg" role="tablist" aria-label="Period">
        <button type="button" data-period="today" class="active" role="tab" aria-selected="true">Today</button>
        <button type="button" data-period="week" role="tab" aria-selected="false">Week</button>
        <button type="button" data-period="month" role="tab" aria-selected="false">Month</button>
      </div>
    </div>
  </div>

  <div class="status-banner show" id="status"><span class="loading-dot"></span><span>Loading CodeBurn breakdown…</span></div>

  <div class="kpi-row" id="kpis" hidden>
    <div class="kpi"><div class="lbl">Spend</div><div class="val" id="kpi-cost">—</div><div class="hint" id="kpi-period">today</div></div>
    <div class="kpi"><div class="lbl">Calls</div><div class="val" id="kpi-calls">—</div><div class="hint">API requests</div></div>
    <div class="kpi"><div class="lbl">Sessions</div><div class="val" id="kpi-sessions">—</div><div class="hint">agent sessions</div></div>
    <div class="kpi"><div class="lbl">Turns</div><div class="val" id="kpi-turns">—</div><div class="hint">conversation turns</div></div>
  </div>

  <div class="break-grid" id="break-grid" hidden>
    <section class="panel">
      <div class="panel-head"><div class="panel-title">By provider</div><div class="panel-meta" id="meta-provider"></div></div>
      <div id="table-provider"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><div class="panel-title">By model</div><div class="panel-meta" id="meta-model"></div></div>
      <div id="table-model"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><div class="panel-title">By project</div><div class="panel-meta" id="meta-project"></div></div>
      <div id="table-project"></div>
    </section>
  </div>

  <section class="panel" id="ledger-panel" hidden>
    <div class="panel-head">
      <div class="panel-title">Session ledger</div>
      <div class="ledger-tools">
        <input type="search" id="ledger-q" placeholder="Search project, model, session…" aria-label="Search sessions">
        <select id="ledger-provider" aria-label="Filter provider"><option value="">All providers</option></select>
      </div>
    </div>
    <div class="ledger-table-wrap">
      <table class="ledger-table" id="ledger-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Project</th>
            <th>Models</th>
            <th class="num">Cost</th>
            <th class="num">Calls</th>
            <th class="num">Turns</th>
            <th class="num">Duration</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody id="ledger-body"></tbody>
      </table>
    </div>
    <div class="share-empty" id="ledger-empty" hidden>No sessions match this filter.</div>
  </section>

  <div class="foot-note" id="foot-note" hidden>API-equivalent via CodeBurn</div>
</div>

<script>
(function() {
  var period = 'today';
  var data = null;
  var statusEl = document.getElementById('status');
  var kpis = document.getElementById('kpis');
  var breakGrid = document.getElementById('break-grid');
  var ledgerPanel = document.getElementById('ledger-panel');
  var footNote = document.getElementById('foot-note');
  var ledgerBody = document.getElementById('ledger-body');
  var ledgerEmpty = document.getElementById('ledger-empty');
  var ledgerTable = document.getElementById('ledger-table');
  var qEl = document.getElementById('ledger-q');
  var providerEl = document.getElementById('ledger-provider');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtInt(n) {
    return (Number(n) || 0).toLocaleString();
  }

  function fmtDuration(ms) {
    var m = Number(ms) || 0;
    if (m <= 0) return '—';
    var sec = Math.round(m / 1000);
    if (sec < 60) return sec + 's';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm';
    var hr = Math.floor(min / 60);
    var rem = min % 60;
    return hr + 'h' + (rem ? ' ' + rem + 'm' : '');
  }

  function fmtWhen(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(kind, msg) {
    if (!msg) { statusEl.className = 'status-banner'; statusEl.hidden = true; return; }
    statusEl.hidden = false;
    statusEl.className = 'status-banner show' + (kind === 'error' ? ' error' : '');
    statusEl.innerHTML = kind === 'loading'
      ? '<span class="loading-dot"></span><span>' + escapeHtml(msg) + '</span>'
      : '<span>' + escapeHtml(msg) + '</span>';
  }

  function shareRows(rows, nameFn) {
    if (!rows || !rows.length) return '<div class="share-empty">No data</div>';
    var total = rows.reduce(function(sum, r) { return sum + (Number(r.cost) || 0); }, 0) || 1;
    var html = '<table class="share-table"><thead><tr><th>Name</th><th class="num">Cost</th><th class="num">Share</th></tr></thead><tbody>';
    rows.forEach(function(r) {
      var cost = Number(r.cost) || 0;
      var pct = Math.max(0, Math.min(100, (cost / total) * 100));
      html += '<tr><td><div class="name">' + escapeHtml(nameFn(r)) + '</div>' +
        '<span class="share-bar"><i style="width:' + pct.toFixed(1) + '%"></i></span></td>' +
        '<td class="num">' + escapeHtml(r.label || ('$' + cost.toFixed(2))) + '</td>' +
        '<td class="num">' + pct.toFixed(0) + '%</td></tr>';
    });
    return html + '</tbody></table>';
  }

  function renderKpis(totals) {
    document.getElementById('kpi-cost').textContent = totals.label || '$0';
    document.getElementById('kpi-calls').textContent = fmtInt(totals.calls);
    document.getElementById('kpi-sessions').textContent = fmtInt(totals.sessions);
    document.getElementById('kpi-turns').textContent = fmtInt(totals.turns);
    document.getElementById('kpi-period').textContent = period;
  }

  function fillProviderFilter(sessions) {
    var current = providerEl.value;
    var set = {};
    (sessions || []).forEach(function(s) { if (s.provider) set[s.provider] = true; });
    var providers = Object.keys(set).sort();
    providerEl.innerHTML = '<option value="">All providers</option>' +
      providers.map(function(p) {
        return '<option value="' + escapeHtml(p) + '"' + (p === current ? ' selected' : '') + '>' + escapeHtml(p) + '</option>';
      }).join('');
  }

  function renderLedger() {
    if (!data) return;
    var q = (qEl.value || '').trim().toLowerCase();
    var prov = providerEl.value;
    var rows = (data.sessions || []).filter(function(s) {
      if (prov && s.provider !== prov) return false;
      if (!q) return true;
      var hay = [s.provider, s.project, (s.models || []).join(' '), s.sessionId, s.label].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    if (!rows.length) {
      ledgerBody.innerHTML = '';
      ledgerTable.hidden = true;
      ledgerEmpty.hidden = false;
      return;
    }
    ledgerTable.hidden = false;
    ledgerEmpty.hidden = true;
    ledgerBody.innerHTML = rows.map(function(s) {
      return '<tr>' +
        '<td class="provider">' + escapeHtml(s.provider) + '</td>' +
        '<td class="project" title="' + escapeHtml(s.project) + '">' + escapeHtml(s.project) + '</td>' +
        '<td class="models" title="' + escapeHtml((s.models || []).join(', ')) + '">' + escapeHtml((s.models || []).join(', ') || '—') + '</td>' +
        '<td class="num cost">' + escapeHtml(s.label) + '</td>' +
        '<td class="num">' + fmtInt(s.calls) + '</td>' +
        '<td class="num">' + fmtInt(s.turns) + '</td>' +
        '<td class="num">' + escapeHtml(fmtDuration(s.durationMs)) + '</td>' +
        '<td class="when">' + escapeHtml(fmtWhen(s.endedAt || s.startedAt)) + '</td>' +
      '</tr>';
    }).join('');
  }

  function render(payload) {
    data = payload;
    var totals = payload.totals || {};
    renderKpis(totals);
    document.getElementById('table-provider').innerHTML = shareRows(payload.byProvider, function(r) { return r.provider; });
    document.getElementById('table-model').innerHTML = shareRows(payload.byModel, function(r) {
      return (r.provider ? r.provider + ' · ' : '') + r.model;
    });
    document.getElementById('table-project').innerHTML = shareRows(payload.byProject, function(r) { return r.project; });
    document.getElementById('meta-provider').textContent = (payload.byProvider || []).length + ' providers';
    document.getElementById('meta-model').textContent = (payload.byModel || []).length + ' models';
    document.getElementById('meta-project').textContent = (payload.byProject || []).length + ' projects';
    fillProviderFilter(payload.sessions);
    renderLedger();
    kpis.hidden = false;
    breakGrid.hidden = false;
    ledgerPanel.hidden = false;
    footNote.hidden = false;
    footNote.textContent = 'API-equivalent via CodeBurn · updated ' + (payload.generatedAt
      ? new Date(payload.generatedAt).toLocaleTimeString()
      : 'just now');
    setStatus(null);
  }

  function load(attempt) {
    attempt = attempt || 0;
    setStatus('loading', 'Loading CodeBurn breakdown…');
    kpis.hidden = true;
    breakGrid.hidden = true;
    ledgerPanel.hidden = true;
    footNote.hidden = true;
    fetch('/api/code/costs/breakdown?period=' + encodeURIComponent(period), { cache: 'no-store' })
      .then(function(r) {
        return r.json().then(function(body) {
          if (r.status === 202 && body && body.pending) return body;
          if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
          return body;
        });
      })
      .then(function(body) {
        if (body && body.pending) {
          if (attempt >= 20) throw new Error('Usage data is still warming — try again shortly');
          setStatus('loading', 'CodeBurn is indexing usage — this only happens once…');
          setTimeout(function() { load(attempt + 1); }, 3000);
          return;
        }
        render(body);
      })
      .catch(function(err) {
        setStatus('error', err.message || 'Failed to load breakdown');
      });
  }

  document.getElementById('period-seg').addEventListener('click', function(e) {
    var btn = e.target.closest('button[data-period]');
    if (!btn) return;
    period = btn.getAttribute('data-period');
    document.querySelectorAll('#period-seg button').forEach(function(b) {
      var on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    load();
  });

  qEl.addEventListener('input', renderLedger);
  providerEl.addEventListener('change', renderLedger);

  load();
})();
</script>
${THEME_TOGGLE_JS}
</body>
</html>`;
};
