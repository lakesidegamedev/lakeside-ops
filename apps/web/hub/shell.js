"use strict";

// hub/shell.js: the Ops hub chrome. One persistent top bar with the three
// views (Work board, Library, Tickets), a global search palette and the
// signed-in user. Every hub page, the report viewer and any page rendered
// through renderShell() share it, so moving between a report, a ticket and
// the board never changes the frame.
//
// Visual language follows the Lakeside Platform console: near-black canvas,
// Geist, hairline borders, one teal accent, compact type. The tokens below
// reuse the dashboard's variable names so older page bodies (the board, ticket
// detail) pick up the same look without their own rewrite.
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

const FONTS = `<link rel="preload" href="/hub/fonts/geist-sans-latin.woff2" as="font" type="font/woff2" crossorigin>`;

const HUB_H = 52;

// Platform palette mapped onto the dashboard's token names.
const HUB_TOKENS = `
@font-face{font-family:'Geist';src:url('/hub/fonts/geist-sans-latin.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:'Geist Mono';src:url('/hub/fonts/geist-mono-latin.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}
:root{
  --ink:255 255 255;
  --bg-0:#0a0b0d;--bg-1:#0d0f12;--bg:#0a0b0d;
  --surface:#111317;--surface-2:#161a1f;--surface-3:#1c2127;
  --glass-1:rgb(var(--ink)/.02);--glass-2:rgb(var(--ink)/.04);--glass-3:rgb(var(--ink)/.07);--glass-hover:rgb(var(--ink)/.05);
  --border:rgb(var(--ink)/.07);--border-2:rgb(var(--ink)/.12);--border-3:rgb(var(--ink)/.2);
  --text:#eceef1;--text-2:#a3aab3;--text-3:#6c747e;
  --accent:#4cc2d4;--accent-2:#7dd3e0;--accent-soft:rgba(76,194,212,.12);--accent-hover:#7dd3e0;--on-accent:#04262c;
  --green:#3fb950;--green-soft:rgba(63,185,80,.12);--amber:#d29922;--amber-soft:rgba(210,153,34,.12);
  --red:#f85149;--red-soft:rgba(248,81,73,.12);--blue:#58a6ff;--purple:#a371f7;--pink:#f472b6;
  --ok:var(--green);--warn:var(--amber);--danger:var(--red);--info:var(--blue);
  --pill-mix:white;
  --e1:0 1px 0 rgb(var(--ink)/.03) inset;--e2:0 1px 0 rgb(var(--ink)/.03) inset,0 8px 24px -12px rgba(0,0,0,.5);--e3:0 24px 60px -20px rgba(0,0,0,.7);
  --hi:0 1px 0 rgb(var(--ink)/.03) inset;--shadow-sm:none;--shadow:var(--e2);
  --ring:0 0 0 2px var(--bg-0),0 0 0 4px rgba(76,194,212,.45);
  --font:'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'Geist Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --r-xs:5px;--r-sm:6px;--r-md:9px;--r-lg:12px;--r-xl:16px;--r-full:999px;
  --t:130ms cubic-bezier(.4,0,.2,1);
  color-scheme:dark;
}
:root[data-theme="light"]{
  --ink:15 23 42;
  --bg-0:#f6f7f9;--bg-1:#eef0f3;--bg:#f6f7f9;
  --surface:#ffffff;--surface-2:#f4f6f8;--surface-3:#e9ecf0;
  --border:rgb(var(--ink)/.09);--border-2:rgb(var(--ink)/.15);--border-3:rgb(var(--ink)/.26);
  --text:#0f1419;--text-2:#4a5462;--text-3:#7e8895;
  --accent:#0b8597;--accent-2:#0a6f7e;--accent-soft:rgba(11,133,151,.1);--accent-hover:#0a6f7e;--on-accent:#fff;
  --green:#1a7f37;--amber:#9a6700;--red:#cf222e;--blue:#0969da;--purple:#8250df;--pink:#bf3989;
  --pill-mix:black;
  --e2:0 1px 2px rgba(15,23,42,.05),0 8px 24px -16px rgba(15,23,42,.18);--e3:0 24px 60px -24px rgba(15,23,42,.3);
  color-scheme:light;
}`;

const HUB_CSS = `
${TOKENS_CSS}
${HUB_TOKENS}
:root{--hub-h:${HUB_H}px}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body.hub{margin:0;font:400 13px/1.5 var(--font);background:var(--bg-0);color:var(--text);letter-spacing:-.006em;-webkit-font-smoothing:antialiased;min-height:100vh;padding-top:var(--hub-h)}
body.hub a{color:inherit;text-decoration:none}
body.hub button,body.hub input,body.hub select{font:inherit;color:inherit}
body.hub ::selection{background:rgba(76,194,212,.24)}
body.hub :focus-visible{outline:none;box-shadow:var(--ring);border-radius:var(--r-sm)}
body.hub ::-webkit-scrollbar{width:10px;height:10px}
body.hub ::-webkit-scrollbar-thumb{background:rgb(var(--ink)/.1);border-radius:999px;border:2px solid transparent;background-clip:padding-box}
.hub-bar{position:fixed;inset:0 0 auto 0;height:var(--hub-h);z-index:9000;display:flex;align-items:center;gap:10px;padding:0 16px;background:color-mix(in srgb,var(--bg-0) 86%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}
.hub-brand{display:flex;align-items:center;gap:9px;font-size:13.5px;font-weight:450;white-space:nowrap;color:var(--text);padding-right:6px}
.hub-brand img{width:24px;height:24px;border-radius:6px;display:block}
.hub-brand b{font-weight:620;color:var(--accent)}
.hub-sep{width:1px;height:20px;background:var(--border-2)}
.hub-views{display:flex;gap:2px}
.hub-view{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-radius:var(--r-sm);color:var(--text-2);font-weight:450;font-size:13px;transition:background var(--t),color var(--t)}
.hub-view .icon{color:var(--text-3);transition:color var(--t)}
.hub-view:hover{background:rgb(var(--ink)/.04);color:var(--text)}
.hub-view.on{background:rgb(var(--ink)/.065);color:var(--text);font-weight:500}
.hub-view.on .icon{color:var(--accent)}
.hub-badge{min-width:18px;height:17px;padding:0 5px;border-radius:999px;display:none;align-items:center;justify-content:center;font:550 10.5px/1 var(--font);font-variant-numeric:tabular-nums;background:rgb(var(--ink)/.07);color:var(--text-2)}
.hub-badge.show{display:inline-flex}
.hub-badge.hot{background:color-mix(in srgb,var(--amber) 16%,transparent);color:color-mix(in srgb,var(--amber) 80%,var(--pill-mix))}
.hub-spacer{flex:1}
.hub-search{display:flex;align-items:center;gap:7px;height:28px;min-width:230px;padding:0 6px 0 9px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-3);font-size:12px;cursor:pointer;transition:border-color var(--t),color var(--t)}
.hub-search:hover{border-color:var(--border-2);color:var(--text-2)}
.hub-search kbd{margin-left:auto;font:10px/1 var(--mono);padding:3px 5px;border:1px solid var(--border);border-radius:4px;background:var(--bg-1);color:var(--text-3)}
.hub-live{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-3);padding:0 4px}
.hub-live i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(63,185,80,.14)}
.hub-live.off i{background:var(--red);box-shadow:0 0 0 3px rgba(248,81,73,.14)}
.hub-ext{display:none;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:var(--r-sm);border:1px solid var(--border-2);background:var(--surface-2);color:var(--text);font-size:12px;font-weight:490}
.hub-ext .icon{color:var(--accent)}
.hub-ext.show{display:inline-flex}
.hub-ext:hover{background:var(--surface-3);border-color:var(--border-3)}
.hub-icon-btn{width:28px;height:28px;display:grid;place-items:center;border-radius:var(--r-sm);border:1px solid transparent;background:transparent;color:var(--text-3);cursor:pointer}
.hub-icon-btn:hover{color:var(--text);background:rgb(var(--ink)/.05)}
:root[data-theme="light"] .hub-icon-btn .t-sun{display:none}
:root:not([data-theme="light"]) .hub-icon-btn .t-moon{display:none}
.hub-user{position:relative}
.hub-avatar{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:650 9.5px var(--font);color:var(--text-2);background:var(--surface-3);border:1px solid var(--border-2);cursor:pointer;position:relative}
.hub-menu{position:absolute;right:0;top:36px;width:240px;padding:6px;border:1px solid var(--border-2);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e3);display:none}
.hub-menu.on{display:block}
.hub-menu .who{padding:8px 9px 9px;border-bottom:1px solid var(--border);margin-bottom:4px}
.hub-menu .who b{display:block;font-size:12.5px;font-weight:550}
.hub-menu .who span{font-size:11px;color:var(--text-3);word-break:break-all}
.hub-menu .role{display:inline-flex;margin-top:6px;height:19px;align-items:center;padding:0 7px;border-radius:999px;font-size:10.5px;color:var(--accent);background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 25%,transparent)}
.hub-menu a,.hub-menu button{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 9px;border:0;border-radius:var(--r-sm);background:none;color:var(--text-2);font-size:12.5px;text-align:left;cursor:pointer}
.hub-menu a:hover,.hub-menu button:hover{background:rgb(var(--ink)/.05);color:var(--text)}
.hub-menu .icon{color:var(--text-3)}
.hub-pal{position:fixed;inset:0;z-index:9500;display:none;align-items:flex-start;justify-content:center;padding-top:12vh;background:rgba(0,0,0,.5)}
.hub-pal.on{display:flex}
.hub-pal-box{width:min(640px,94vw);border:1px solid var(--border-2);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e3);overflow:hidden}
.hub-pal-in{display:flex;align-items:center;gap:10px;padding:0 14px;height:48px;border-bottom:1px solid var(--border);color:var(--text-3)}
.hub-pal-in input{flex:1;border:0;outline:0;background:none;color:var(--text);font-size:14px}
.hub-pal-in kbd{font:10px var(--mono);color:var(--text-3);border:1px solid var(--border);border-radius:4px;padding:3px 5px}
.hub-pal-list{max-height:min(60vh,500px);overflow:auto;padding:6px}
.hub-pal-group{padding:9px 9px 4px;font-size:10.5px;font-weight:560;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.hub-pal-item{display:flex;align-items:center;gap:10px;height:34px;padding:0 9px;border-radius:var(--r-sm);cursor:pointer;color:var(--text-2)}
.hub-pal-item .k{width:7px;height:7px;border-radius:2px;flex:none}
.hub-pal-item .tt{flex:1;min-width:0;color:var(--text);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hub-pal-item .mm{font-size:11px;color:var(--text-3);white-space:nowrap}
.hub-pal-item.sel{background:rgb(var(--ink)/.065)}
.hub-pal-empty{padding:24px;text-align:center;color:var(--text-3);font-size:12.5px}
.hub-gate{position:fixed;inset:var(--hub-h) 0 0 0;z-index:8999;display:none;align-items:center;justify-content:center;background:color-mix(in srgb,var(--bg-0) 88%,transparent);backdrop-filter:blur(6px)}
.hub-gate.on{display:flex}
.hub-gate-card{max-width:360px;padding:24px;border:1px solid var(--border-2);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--e3);text-align:center}
.hub-gate-card h2{margin:0 0 6px;font-size:15px;font-weight:600}
.hub-gate-card p{margin:0 0 16px;color:var(--text-2);font-size:12.5px}
.hub-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 11px;border-radius:var(--r-sm);border:1px solid transparent;background:var(--accent);color:var(--on-accent)!important;font-size:12px;font-weight:600;cursor:pointer}
.hub-btn:hover{background:var(--accent-2)}
.hub-btn.ghost{background:var(--surface-2);border-color:var(--border-2);color:var(--text)!important;font-weight:490}
.hub-btn.ghost:hover{background:var(--surface-3)}
/* shared primitives for hub pages */
.pill{display:inline-flex;align-items:center;gap:6px;height:21px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:480;white-space:nowrap;color:color-mix(in srgb,var(--c,var(--text-2)) 78%,var(--pill-mix));background:color-mix(in srgb,var(--c,var(--text-3)) 12%,transparent);border:1px solid color-mix(in srgb,var(--c,var(--text-3)) 22%,transparent)}
.pill .dot,.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--c,var(--text-3));flex:none}
.pill.quiet{color:var(--text-2);background:rgb(var(--ink)/.04);border-color:var(--border)}
.tag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:5px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:11px;white-space:nowrap}
.statbar{display:flex;align-items:stretch;min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);overflow-x:auto;scrollbar-width:thin}
.statbar .stat{flex:1 1 0;min-width:128px;padding:9px 14px 8px;border-left:1px solid var(--border)}
.statbar .stat:first-child{border-left:0}
.statbar .k{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:560;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);white-space:nowrap}
.statbar .v{font-size:17px;font-weight:580;letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.25;margin-top:2px;white-space:nowrap}
.statbar .v small{font-size:11px;font-weight:500;color:var(--text-2);letter-spacing:0}
.statbar .s{font-size:11px;color:var(--text-2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.statbar .s .good{color:var(--green)}.statbar .s .warn{color:var(--amber)}.statbar .s .bad{color:var(--red)}
.hcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--e2)}
.hcard-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border)}
.hcard-head h3{margin:0;font-size:12px;font-weight:540;color:var(--text-2)}
.hcard-head .actions{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--text-3);font-size:11.5px}
.sec-h{display:flex;align-items:center;gap:10px;margin:24px 0 9px}
.sec-h h2{margin:0;font-size:12px;font-weight:560;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:7px}
.sec-h .count{font-size:11.5px;color:var(--text-3);font-variant-numeric:tabular-nums}
.sec-h .actions{margin-left:auto;display:flex;gap:6px;align-items:center}
.page-h{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-bottom:16px}
.page-h h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-.03em;display:flex;align-items:center;gap:10px}
.page-h .sub{color:var(--text-2);font-size:12.5px;margin-top:3px}
.page-h .actions{margin-left:auto;display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:16px}
.tabs button,.tabs a{position:relative;height:34px;padding:0 12px;border:0;background:none;color:var(--text-2);font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.tabs button:hover,.tabs a:hover{color:var(--text)}
.tabs .on{color:var(--text);font-weight:500}
.tabs .on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--accent)}
.skel{background:linear-gradient(90deg,rgb(var(--ink)/.035) 25%,rgb(var(--ink)/.075) 37%,rgb(var(--ink)/.035) 63%);background-size:400% 100%;animation:skel 1.5s ease infinite;border-radius:var(--r-sm)}
@keyframes skel{0%{background-position:100% 0}100%{background-position:0 0}}
.fade{animation:fade .16s ease-out}
@keyframes fade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
.hub-tabs{display:none}
@media(max-width:900px){
  .hub-views,.hub-sep,.hub-search span,.hub-search kbd,.hub-live span,.hub-ext span,.hub-brand span{display:none}
  .hub-search{min-width:0;width:28px;padding:0;justify-content:center;border-color:transparent;background:none}
  body.hub{padding-bottom:calc(58px + env(safe-area-inset-bottom))}
  .hub-tabs{position:fixed;left:0;right:0;bottom:0;z-index:9000;display:grid;grid-template-columns:repeat(3,1fr);height:calc(56px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);background:color-mix(in srgb,var(--bg-0) 90%,transparent);backdrop-filter:blur(12px);border-top:1px solid var(--border)}
  .hub-tabs a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:10.5px;font-weight:500;color:var(--text-3)}
  .hub-tabs a.on{color:var(--accent)}
}
@media(prefers-reduced-motion:reduce){.skel,.fade{animation:none}}
`;

function renderHubBar(active) {
  const views = VIEWS.map((v) => `<a class="hub-view${v.id === active ? " on" : ""}" href="${v.href}" data-view="${v.id}">${icon(v.icon, { size: 15 })}<span>${v.label}</span><span class="hub-badge" data-badge="${v.badge}"></span></a>`).join("");
  const tabs = VIEWS.map((v) => `<a class="${v.id === active ? "on" : ""}" href="${v.href}">${icon(v.icon, { size: 19 })}<span>${v.label}</span></a>`).join("");
  return `<header class="hub-bar" role="banner">
<a class="hub-brand" href="/library" aria-label="Lakeside Ops home"><img src="/ops-mark.svg" alt=""><span>Lakeside <b>Ops</b></span></a>
<span class="hub-sep"></span>
<nav class="hub-views" aria-label="Ops views">${views}</nav>
<div class="hub-spacer"></div>
<button class="hub-search" id="hubSearch" type="button" aria-label="Search everything">${icon("search", { size: 14 })}<span>Search reports, tickets, cards</span><kbd>⌘K</kbd></button>
<span class="hub-live" id="hubLive" title="Signed in"><i></i><span>Live</span></span>
<a class="hub-ext" id="hubConsole" href="#" target="_blank" rel="noopener">${icon("terminal", { size: 14 })}<span>Console</span></a>
<button class="hub-icon-btn" id="hubTheme" type="button" aria-label="Switch theme">${icon("sun", { size: 15, cls: "t-sun" })}${icon("moon", { size: 15, cls: "t-moon" })}</button>
<div class="hub-user"><button class="hub-avatar" id="hubAvatar" type="button" aria-label="Account" aria-haspopup="true">··</button>
<div class="hub-menu" id="hubMenu" role="menu"><div class="who"><b id="hubName">Signed in</b><span id="hubSub"></span><div><span class="role" id="hubRole">admin</span></div></div>
<a href="/kanban">${icon("layers", { size: 14 })}Work board</a><a href="/library">${icon("book-open", { size: 14 })}Library</a><a href="/tickets">${icon("life-buoy", { size: 14 })}Tickets</a>
<button type="button" id="hubLogout">${icon("log-out", { size: 14 })}Sign out</button></div></div>
</header>
<nav class="hub-tabs" aria-label="Ops views">${tabs}</nav>
<div class="hub-gate" id="hubGate"><div class="hub-gate-card"><h2>You are signed out</h2><p>Your session ended, here or in another tab. Sign in again to keep working; this page reloads where you left off.</p><a class="hub-btn" id="hubSignIn" href="/auth/game">Sign in</a></div></div>
<div class="hub-pal" id="hubPal" aria-hidden="true"><div class="hub-pal-box" role="dialog" aria-label="Search"><div class="hub-pal-in">${icon("search", { size: 16 })}<input id="hubPalIn" placeholder="Search reports, docs, tickets and cards" autocomplete="off" spellcheck="false"><kbd>esc</kbd></div><div class="hub-pal-list" id="hubPalList"></div></div></div>`;
}

// Client side. Plain ES5-ish so it runs inside any page the bar is injected in.
const HUB_JS = `<script>(function(){
var $=function(id){return document.getElementById(id)};
var CH=null;try{CH=new BroadcastChannel('lakeside-ops-auth')}catch(e){}
var signedOut=false;
function initials(n){n=String(n||'').replace(/@.*/,'').trim();var p=n.split(/[\\s._-]+/).filter(Boolean);return ((p[0]||'?')[0]+(p[1]?p[1][0]:(p[0]||'').slice(1,2))).toUpperCase()}
function badge(k,n,hot){var b=document.querySelector('[data-badge="'+k+'"]');if(!b)return;if(n==null||n===0){b.classList.remove('show');return}b.textContent=n>999?'999+':n;b.classList.add('show');b.classList.toggle('hot',!!hot)}
function gate(on){signedOut=on;$('hubGate').classList.toggle('on',on);var l=$('hubLive');l.classList.toggle('off',on);l.lastChild.textContent=on?'Signed out':'Live';var s=$('hubSignIn');if(s)s.href='/auth/game?next='+encodeURIComponent(location.href)}
function apply(d){$('hubAvatar').textContent=initials(d.name||d.email);$('hubName').textContent=d.name||d.email||'Signed in';$('hubSub').textContent=d.email&&d.name&&d.email!==d.name?d.email:'';$('hubRole').textContent=d.role||'';
var c=$('hubConsole');if(d.consoleUrl){c.href=d.consoleUrl;c.classList.add('show')}else c.classList.remove('show');
var k=d.counts||{};badge('tickets',k.ticketsOpen,k.ticketsWaiting>0);badge('board',k.boardNow,k.boardOwner>0);badge('library',k.libraryNew)}
function poll(){fetch('/api/hub/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===401||r.status===403){if(!signedOut){gate(true);if(CH)CH.postMessage({t:'out'})}return null}return r.ok?r.json():null}).then(function(d){if(!d)return;if(signedOut){gate(false);if(CH)CH.postMessage({t:'in'})}apply(d)}).catch(function(){})}
if(CH)CH.onmessage=function(e){var t=e.data&&e.data.t;if(t==='out')gate(true);if(t==='in'){gate(false);poll()}};
poll();setInterval(poll,60000);document.addEventListener('visibilitychange',function(){if(!document.hidden)poll()});
var av=$('hubAvatar'),mn=$('hubMenu');av.addEventListener('click',function(e){e.stopPropagation();mn.classList.toggle('on')});document.addEventListener('click',function(){mn.classList.remove('on')});
$('hubLogout').addEventListener('click',function(){fetch('/api/logout',{method:'POST',credentials:'same-origin'}).finally(function(){if(CH)CH.postMessage({t:'out'});location.href='/'})});
$('hubTheme').addEventListener('click',function(){var r=document.documentElement,n=r.getAttribute('data-theme')==='light'?'dark':'light';r.setAttribute('data-theme',n);try{localStorage.setItem('ahd-theme',n)}catch(e){}});
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
<link rel="icon" href="/ops-mark.svg" type="image/svg+xml">
${FONTS}
<style>${HUB_CSS}${extraCss}</style>${head}
</head><body class="hub ${esc(bodyClass)}">
${renderHubBar(active)}
<main class="hub-main">${body}</main>
${HUB_JS}
</body></html>`;
}

module.exports = { VIEWS, viewFor, HUB_CSS, HUB_JS, HUB_H, renderHubBar, renderHubPage, esc, FONTS };
