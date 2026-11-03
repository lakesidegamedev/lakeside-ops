"use strict";

// hub/shell.js: the Ops hub chrome. One persistent top bar with the three
// views (Work board, Library, Tickets), a global search palette and the
// signed-in user. Every hub page, the report viewer and any page rendered
// through renderShell() share it, so moving between a report, a ticket and
// the board never changes the frame.
//
// The bar renders without user data and fills itself from /api/hub/me. The
// same poll keeps the tab badges fresh and keeps sign-in state in sync: a
// sign-out in one tab (or an expired session) is broadcast to every other
// open tab, which swaps in a sign-in prompt instead of failing silently.

const { icon, THEME_HEAD } = require("../ui-kit");
const { TOKENS_CSS } = require("../design-system");

const VIEWS = [
  { id: "board", href: "/kanban", label: "Work board", icon: "layers", badge: "board" },
  { id: "library", href: "/library", label: "Library", icon: "book-open", badge: "library" },
  { id: "tickets", href: "/tickets", label: "Tickets", icon: "life-buoy", badge: "tickets" },
];

function viewFor(pathname) {
  const p = String(pathname || "");
  if (p === "/kanban" || p.startsWith("/kanban/")) return "board";
  if (p === "/tickets" || p.startsWith("/tickets/") || p.startsWith("/t/")) return "tickets";
  if (p === "/library" || p.startsWith("/library/") || p === "/reports" || p.startsWith("/reports/") || p === "/knowledge") return "library";
  return "";
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const HUB_H = 56;

const HUB_CSS = `
${TOKENS_CSS}
:root{--hub-h:${HUB_H}px;--hub-bg:color-mix(in srgb,var(--bg-0) 82%,transparent)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body.hub{margin:0;font-family:var(--font);background:var(--bg-0);color:var(--text);line-height:1.5;letter-spacing:-.011em;-webkit-font-smoothing:antialiased;min-height:100vh;padding-top:var(--hub-h)}
body.hub a{color:inherit;text-decoration:none}
body.hub button,body.hub input,body.hub select{font-family:inherit}
.hub-bar{position:fixed;inset:0 0 auto 0;height:var(--hub-h);z-index:9000;display:flex;align-items:center;gap:14px;padding:0 18px;background:var(--hub-bg);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);border-bottom:1px solid var(--border)}
.hub-bar::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--accent) 40%,transparent) 30%,color-mix(in srgb,var(--accent-2) 40%,transparent) 70%,transparent);opacity:.55;pointer-events:none}
.hub-brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:.95rem;letter-spacing:-.02em;white-space:nowrap;color:var(--text)}
.hub-mark{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#0b1220;box-shadow:0 6px 18px -8px var(--accent)}
.hub-mark svg{width:16px;height:16px}
.hub-brand small{font-weight:600;color:var(--text-3);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;margin-left:2px}
.hub-views{display:flex;gap:4px;margin-left:10px;padding:4px;border:1px solid var(--border);border-radius:12px;background:var(--glass-1)}
.hub-view{position:relative;display:flex;align-items:center;gap:8px;height:34px;padding:0 13px;border-radius:9px;color:var(--text-2);font-weight:600;font-size:.84rem;transition:background var(--t),color var(--t)}
.hub-view:hover{color:var(--text);background:var(--glass-2)}
.hub-view.on{color:var(--text);background:var(--surface-2);box-shadow:var(--e1),var(--hi)}
.hub-view.on::after{content:"";position:absolute;left:12px;right:12px;bottom:-5px;height:2px;border-radius:2px;background:var(--accent);box-shadow:0 0 12px var(--accent)}
.hub-view .icon{opacity:.85}
.hub-badge{min-width:20px;height:18px;padding:0 6px;border-radius:999px;display:none;align-items:center;justify-content:center;font:700 .66rem/1 var(--font);font-variant-numeric:tabular-nums;background:var(--glass-3);color:var(--text-2)}
.hub-badge.show{display:inline-flex}
.hub-badge.hot{background:color-mix(in srgb,var(--red) 22%,transparent);color:color-mix(in srgb,var(--red) 75%,var(--text))}
.hub-spacer{flex:1}
.hub-search{display:flex;align-items:center;gap:9px;height:36px;min-width:250px;padding:0 10px 0 12px;border:1px solid var(--border);border-radius:10px;background:var(--glass-1);color:var(--text-3);font-size:.82rem;cursor:pointer;transition:border-color var(--t),background var(--t)}
.hub-search:hover{border-color:var(--border-2);background:var(--glass-2);color:var(--text-2)}
.hub-search kbd{margin-left:auto;font:600 .66rem var(--mono);padding:2px 6px;border:1px solid var(--border);border-radius:5px;color:var(--text-3)}
.hub-ext{display:none;align-items:center;gap:7px;height:36px;padding:0 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--accent-2) 40%,var(--border));color:var(--accent-2);font-weight:700;font-size:.8rem;background:color-mix(in srgb,var(--accent-2) 8%,transparent)}
.hub-ext.show{display:inline-flex}
.hub-ext:hover{background:color-mix(in srgb,var(--accent-2) 15%,transparent)}
.hub-icon-btn{width:36px;height:36px;display:grid;place-items:center;border-radius:10px;border:1px solid var(--border);background:var(--glass-1);color:var(--text-2);cursor:pointer}
.hub-icon-btn:hover{color:var(--text);background:var(--glass-2)}
:root[data-theme="light"] .hub-icon-btn .t-sun{display:none}
:root:not([data-theme="light"]) .hub-icon-btn .t-moon{display:none}
.hub-user{position:relative}
.hub-avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font:800 .78rem var(--font);color:#0b1220;background:linear-gradient(135deg,#c7d2fe,#99f6e4);border:2px solid var(--bg-0);box-shadow:0 0 0 1px var(--border-2);cursor:pointer}
.hub-avatar.pending{background:var(--glass-3);color:transparent}
.hub-menu{position:absolute;right:0;top:46px;width:260px;padding:8px;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:var(--e3);display:none}
.hub-menu.on{display:block}
.hub-menu .who{padding:8px 10px 10px;border-bottom:1px solid var(--border);margin-bottom:6px}
.hub-menu .who b{display:block;font-size:.9rem}
.hub-menu .who span{font-size:.75rem;color:var(--text-3)}
.hub-menu .role{display:inline-block;margin-top:6px;padding:1px 8px;border-radius:999px;font:700 .64rem var(--font);letter-spacing:.06em;text-transform:uppercase;background:var(--accent-soft);color:var(--accent)}
.hub-menu a,.hub-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:0;border-radius:9px;background:none;color:var(--text-2);font:600 .82rem var(--font);text-align:left;cursor:pointer}
.hub-menu a:hover,.hub-menu button:hover{background:var(--glass-2);color:var(--text)}
.hub-auth-dot{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:var(--green);border:2px solid var(--bg-0)}
.hub-auth-dot.off{background:var(--red)}
/* Command palette */
.hub-pal{position:fixed;inset:0;z-index:9500;display:none;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(4,8,14,.55);backdrop-filter:blur(4px)}
.hub-pal.on{display:flex}
.hub-pal-box{width:min(680px,94vw);border:1px solid var(--border-2);border-radius:16px;background:var(--surface);box-shadow:var(--e3);overflow:hidden}
.hub-pal-in{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border)}
.hub-pal-in input{flex:1;border:0;outline:0;background:none;color:var(--text);font:500 1rem var(--font)}
.hub-pal-list{max-height:min(60vh,520px);overflow:auto;padding:6px}
.hub-pal-group{padding:10px 10px 4px;font:700 .64rem var(--font);letter-spacing:.09em;text-transform:uppercase;color:var(--text-3)}
.hub-pal-item{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:10px;cursor:pointer;color:var(--text-2)}
.hub-pal-item .k{width:8px;height:8px;border-radius:50%;flex:none}
.hub-pal-item .tt{flex:1;min-width:0;color:var(--text);font-weight:600;font-size:.86rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hub-pal-item .mm{font-size:.72rem;color:var(--text-3);white-space:nowrap}
.hub-pal-item.sel{background:var(--accent-soft)}
.hub-pal-empty{padding:26px;text-align:center;color:var(--text-3);font-size:.85rem}
/* Signed-out overlay */
.hub-gate{position:fixed;inset:var(--hub-h) 0 0 0;z-index:8999;display:none;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bg-0) 88%,transparent);backdrop-filter:blur(6px)}
.hub-gate.on{display:flex}
.hub-gate-card{max-width:380px;padding:28px;border:1px solid var(--border);border-radius:18px;background:var(--surface);box-shadow:var(--e3);text-align:center}
.hub-gate-card h2{margin:0 0 6px;font-size:1.15rem}
.hub-gate-card p{margin:0 0 18px;color:var(--text-2);font-size:.88rem}
.hub-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:38px;padding:0 16px;border-radius:10px;border:1px solid transparent;background:var(--accent);color:var(--on-accent)!important;font:700 .85rem var(--font);cursor:pointer}
.hub-btn.ghost{background:var(--glass-2);border-color:var(--border);color:var(--text)!important}
/* Mobile: views move to a persistent bottom tab bar */
.hub-tabs{display:none}
@media(max-width:900px){
  .hub-views,.hub-search span,.hub-search kbd,.hub-brand small,.hub-ext span{display:none}
  .hub-search{min-width:0;width:36px;padding:0;justify-content:center}
  .hub-ext{padding:0 10px}
  body.hub{padding-bottom:calc(64px + env(safe-area-inset-bottom))}
  .hub-tabs{position:fixed;left:0;right:0;bottom:0;z-index:9000;display:grid;grid-template-columns:repeat(3,1fr);height:calc(62px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);background:var(--hub-bg);backdrop-filter:blur(18px);border-top:1px solid var(--border)}
  .hub-tabs a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font:700 .68rem var(--font);color:var(--text-3)}
  .hub-tabs a.on{color:var(--accent)}
}
`;

function renderHubBar(active) {
  const views = VIEWS.map((v) => `<a class="hub-view${v.id === active ? " on" : ""}" href="${v.href}" data-view="${v.id}">${icon(v.icon, { size: 16 })}<span>${v.label}</span><span class="hub-badge" data-badge="${v.badge}"></span></a>`).join("");
  const tabs = VIEWS.map((v) => `<a class="${v.id === active ? "on" : ""}" href="${v.href}">${icon(v.icon, { size: 20 })}<span>${v.label}</span></a>`).join("");
  return `<header class="hub-bar" role="banner">
<a class="hub-brand" href="/library" aria-label="Lakeside Ops home"><span class="hub-mark">${icon("compass", { size: 16, stroke: 2.4 })}</span>Lakeside<small>Ops</small></a>
<nav class="hub-views" aria-label="Ops views">${views}</nav>
<div class="hub-spacer"></div>
<button class="hub-search" id="hubSearch" type="button" aria-label="Search everything">${icon("search", { size: 15 })}<span>Search reports, tickets, cards</span><kbd>⌘K</kbd></button>
<a class="hub-ext" id="hubConsole" href="#" target="_blank" rel="noopener">${icon("terminal", { size: 15 })}<span>Console</span></a>
<button class="hub-icon-btn" id="hubTheme" type="button" aria-label="Switch theme">${icon("sun", { size: 16, cls: "t-sun" })}${icon("moon", { size: 16, cls: "t-moon" })}</button>
<div class="hub-user"><button class="hub-avatar pending" id="hubAvatar" type="button" aria-label="Account" aria-haspopup="true">··<span class="hub-auth-dot" id="hubDot"></span></button>
<div class="hub-menu" id="hubMenu" role="menu"><div class="who"><b id="hubName">Signed in</b><span id="hubSub"></span><div><span class="role" id="hubRole">admin</span></div></div>
<a href="/kanban">${icon("layers", { size: 15 })}Work board</a><a href="/library">${icon("book-open", { size: 15 })}Library</a><a href="/tickets">${icon("life-buoy", { size: 15 })}Tickets</a>
<button type="button" id="hubLogout">${icon("log-out", { size: 15 })}Sign out</button></div></div>
</header>
<nav class="hub-tabs" aria-label="Ops views">${tabs}</nav>
<div class="hub-gate" id="hubGate"><div class="hub-gate-card"><h2>You are signed out</h2><p>Your session ended, here or in another tab. Sign in again to keep working; this page reloads where you left off.</p><a class="hub-btn" id="hubSignIn" href="/auth/game">Sign in</a></div></div>
<div class="hub-pal" id="hubPal" aria-hidden="true"><div class="hub-pal-box" role="dialog" aria-label="Search"><div class="hub-pal-in">${icon("search", { size: 18 })}<input id="hubPalIn" placeholder="Search reports, docs, tickets and cards" autocomplete="off" spellcheck="false"><kbd style="font:600 .66rem var(--mono);color:var(--text-3)">esc</kbd></div><div class="hub-pal-list" id="hubPalList"></div></div></div>`;
}

// Client side. Plain ES5-ish so it runs inside any page the bar is injected in.
const HUB_JS = `<script>(function(){
var $=function(id){return document.getElementById(id)};
var CH=null;try{CH=new BroadcastChannel('lakeside-ops-auth')}catch(e){}
var me=null,signedOut=false;
function initials(n){n=String(n||'').replace(/@.*/,'').trim();var p=n.split(/[\\s._-]+/).filter(Boolean);return ((p[0]||'?')[0]+(p[1]?p[1][0]:(p[0]||'').slice(1,2))).toUpperCase()}
function badge(k,n,hot){var b=document.querySelector('[data-badge="'+k+'"]');if(!b)return;if(n==null||n===0){b.classList.remove('show');return}b.textContent=n>999?'999+':n;b.classList.add('show');b.classList.toggle('hot',!!hot)}
function gate(on){signedOut=on;$('hubGate').classList.toggle('on',on);$('hubDot').classList.toggle('off',on);var s=$('hubSignIn');if(s)s.href='/auth/game?next='+encodeURIComponent(location.href)}
function apply(d){me=d;var a=$('hubAvatar');a.classList.remove('pending');a.firstChild.nodeValue=initials(d.name||d.email);$('hubName').textContent=d.name||d.email||'Signed in';$('hubSub').textContent=d.email&&d.name&&d.email!==d.name?d.email:'';$('hubRole').textContent=d.role||'';
var c=$('hubConsole');if(d.consoleUrl){c.href=d.consoleUrl;c.classList.add('show')}else c.classList.remove('show');
var k=d.counts||{};badge('tickets',k.ticketsOpen,k.ticketsWaiting>0);badge('board',k.boardNow,k.boardOwner>0);badge('library',k.libraryNew)}
function poll(){fetch('/api/hub/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===401||r.status===403){if(!signedOut){gate(true);if(CH)CH.postMessage({t:'out'})}return null}return r.ok?r.json():null}).then(function(d){if(!d)return;if(signedOut){gate(false);if(CH)CH.postMessage({t:'in'})}apply(d)}).catch(function(){})}
if(CH)CH.onmessage=function(e){var t=e.data&&e.data.t;if(t==='out')gate(true);if(t==='in'){gate(false);poll()}};
poll();setInterval(poll,60000);document.addEventListener('visibilitychange',function(){if(!document.hidden)poll()});
var av=$('hubAvatar'),mn=$('hubMenu');av.addEventListener('click',function(e){e.stopPropagation();mn.classList.toggle('on')});document.addEventListener('click',function(){mn.classList.remove('on')});
$('hubLogout').addEventListener('click',function(){fetch('/api/logout',{method:'POST',credentials:'same-origin'}).finally(function(){if(CH)CH.postMessage({t:'out'});location.href='/'})});
$('hubTheme').addEventListener('click',function(){var r=document.documentElement,n=r.getAttribute('data-theme')==='light'?'dark':'light';r.setAttribute('data-theme',n);try{localStorage.setItem('ahd-theme',n)}catch(e){}});
/* Search palette */
var pal=$('hubPal'),inp=$('hubPalIn'),list=$('hubPalList'),items=[],sel=0,timer=null,seq=0;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function render(groups){items=[];var h='';groups.forEach(function(g){if(!g.items.length)return;h+='<div class="hub-pal-group">'+esc(g.label)+'</div>';g.items.forEach(function(it){var i=items.length;items.push(it);h+='<div class="hub-pal-item'+(i===sel?' sel':'')+'" data-i="'+i+'"><span class="k" style="background:'+esc(it.color||'var(--text-3)')+'"></span><span class="tt">'+esc(it.title)+'</span><span class="mm">'+esc(it.meta||'')+'</span></div>'})});list.innerHTML=h||'<div class="hub-pal-empty">'+(inp.value?'Nothing matches.':'Type to search the library, tickets and the work board.')+'</div>'}
function search(){var q=inp.value.trim(),my=++seq;fetch('/api/hub/search?q='+encodeURIComponent(q),{credentials:'same-origin'}).then(function(r){return r.ok?r.json():{groups:[]}}).then(function(d){if(my!==seq)return;sel=0;render(d.groups||[])}).catch(function(){})}
function open(){pal.classList.add('on');pal.setAttribute('aria-hidden','false');inp.value='';search();setTimeout(function(){inp.focus()},10)}
function close(){pal.classList.remove('on');pal.setAttribute('aria-hidden','true')}
function go(it){if(it&&it.href&&it.href.charAt(0)==='/'&&it.href.charAt(1)!=='/')location.href=it.href}
$('hubSearch').addEventListener('click',open);pal.addEventListener('click',function(e){if(e.target===pal)close()});
list.addEventListener('click',function(e){var el=e.target.closest('.hub-pal-item');if(el)go(items[+el.getAttribute('data-i')])});
inp.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(search,120)});
function mark(){var els=list.querySelectorAll('.hub-pal-item');for(var i=0;i<els.length;i++)els[i].classList.toggle('sel',i===sel);if(els[sel])els[sel].scrollIntoView({block:'nearest'})}
document.addEventListener('keydown',function(e){var tag=(e.target&&e.target.tagName)||'';if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();pal.classList.contains('on')?close():open();return}
if(!pal.classList.contains('on')){if(e.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test(tag)&&!e.target.isContentEditable){e.preventDefault();open()}return}
if(e.key==='Escape')close();else if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(items.length-1,sel+1);mark()}else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(0,sel-1);mark()}else if(e.key==='Enter'){e.preventDefault();go(items[sel])}});
window.hubOpenSearch=open;
})();</script>`;

function renderHubPage({ title = "Ops", active = "", body = "", extraCss = "", head = "", bodyClass = "" } = {}) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} · Lakeside Ops</title>
${THEME_HEAD}
<link rel="icon" href="/logo.svg" type="image/svg+xml">
${FONTS}
<style>${HUB_CSS}${extraCss}</style>${head}
</head><body class="hub ${esc(bodyClass)}">
${renderHubBar(active)}
<main class="hub-main">${body}</main>
${HUB_JS}
</body></html>`;
}

module.exports = { VIEWS, viewFor, HUB_CSS, HUB_JS, HUB_H, renderHubBar, renderHubPage, esc, FONTS };
