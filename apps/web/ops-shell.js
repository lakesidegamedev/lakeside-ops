// ops-shell.js — the shared Ops platform shell: persistent sidebar, command
// palette, page wrapper (renderShell) and legacy/immersive wrapper (injectNav).
// Single source of truth so the dashboard AND standalone apps (docs, etc.)
// render an identical nav. Extracted verbatim from server.js.
const { icon, faviconFor, THEME_HEAD, themeToggle, THEME_TOGGLE_JS } = require("./ui-kit");
const { TOKENS_CSS } = require("./design-system");
const { GAMES } = require("./games-config");
const { listExternalLinks } = require("./src/services/externalLinks");
const { getTenant } = require("./src/services/projectRegistry");
const { clientBootstrapScript } = require("./src/ui/safeDom");
const { WORKBENCH_CSS } = require("./ops-workbench");
const APP_VERSION = require("./package.json").version;

function brandMeta() {
  const t = getTenant();
  return {
    name: t.name || "Ops",
    shortName: t.shortName || "Ops",
    title: t.dashboardTitle || "Ops Dashboard",
    logoUrl: t.logoUrl || "/logo.svg",
  };
}

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
/* ── Dark theme (default) ───────────────────────────────────────── */
${TOKENS_CSS}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font);background:var(--bg-0);color:var(--text);min-height:100vh;line-height:1.55;letter-spacing:-.011em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;transition:background var(--t),color var(--t)}
body::before{content:none}
::selection{background:var(--accent-soft);color:var(--text)}
a{color:var(--accent);text-decoration:none;transition:color var(--t)}
a:hover{color:color-mix(in srgb,var(--accent) 78%,var(--text))}
button,input,select,textarea{font-family:inherit}
:focus-visible{outline:none;box-shadow:var(--ring)}
img,svg{display:block}
.icon{display:inline-block;vertical-align:middle;flex-shrink:0}
h1,h2,h3{letter-spacing:-.02em}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--scroll);border-radius:var(--r-full);border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:var(--scroll-h);background-clip:padding-box}

.container{width:100%;margin:0 auto;padding:clamp(1.25rem,4vw,2.5rem) clamp(1rem,4vw,1.5rem)}
.glass{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--e1),var(--hi)}

.topbar{display:flex;align-items:center;gap:var(--s-4);margin-bottom:var(--s-8);padding-bottom:var(--s-5);border-bottom:1px solid var(--border)}
.back-link{display:inline-flex;align-items:center;gap:var(--s-2);color:var(--text-2);font-size:.875rem;font-weight:500;padding:.4rem .7rem;border-radius:var(--r-sm);border:1px solid transparent;transition:all var(--t)}
.back-link:hover{color:var(--text);background:var(--glass-2);border-color:var(--border)}
.page-title{display:flex;align-items:center;gap:var(--s-3);font-size:clamp(1.2rem,3vw,1.55rem);font-weight:700;letter-spacing:-.025em}
.page-title .ico,.page-title .icon{color:var(--accent)}

/* Theme toggle — icons stacked in a fixed box so the button never shifts on toggle */
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:38px;width:38px;height:34px;padding:0;flex-shrink:0;border-radius:var(--r-full);border:1px solid var(--border);background:var(--surface);color:var(--text-2);cursor:pointer;transition:background var(--t),color var(--t),border-color var(--t);font:600 11px var(--font)}
.theme-toggle:hover{color:var(--text);background:var(--glass-hover);border-color:var(--border-2)}
.theme-toggle-label{display:none}
.theme-toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.theme-toggle-icon{position:relative;display:block;width:16px;height:16px;flex-shrink:0}
.theme-toggle .t-sun,.theme-toggle .t-moon{position:absolute;inset:0;display:block;margin:auto}
.theme-toggle .t-moon{opacity:0;pointer-events:none}
.theme-toggle .t-sun{opacity:1}
:root[data-theme="light"] .theme-toggle .t-sun{opacity:0;pointer-events:none}
:root[data-theme="light"] .theme-toggle .t-moon{opacity:1;pointer-events:auto}
.theme-toggle.fixed{position:fixed;top:14px;right:14px;z-index:200;background:var(--bg-1);box-shadow:var(--shadow-sm)}
@media(max-width:600px){.theme-toggle.fixed{top:10px;right:10px}}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--s-2);padding:.6rem 1.1rem;border:1px solid transparent;border-radius:var(--r-sm);background:var(--accent);color:var(--on-accent);font-size:.875rem;font-weight:600;cursor:pointer;transition:all var(--t);box-shadow:var(--shadow-sm)}
.btn:hover{filter:brightness(1.07);transform:translateY(-1px);box-shadow:0 8px 20px -8px color-mix(in srgb,var(--accent) 70%,transparent)}
.btn:active{transform:translateY(0)}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;filter:none}
.btn .icon{margin:-2px 0}
.btn-ghost{background:var(--glass-2);border:1px solid var(--border);color:var(--text);box-shadow:none}
.btn-ghost:hover{background:var(--glass-hover);border-color:var(--border-2);filter:none;transform:translateY(-1px)}

.field{width:100%;padding:.62rem .85rem;background:var(--field-bg);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:.9rem;transition:border-color var(--t),box-shadow var(--t),background var(--t);outline:none}
.field::placeholder{color:var(--text-3)}
.field:hover{border-color:var(--border-2)}
.field:focus{border-color:var(--accent);box-shadow:var(--ring)}
select.field{cursor:pointer;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%238b8b96' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .65rem center;padding-right:2.1rem}

.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}

.skeleton{position:relative;overflow:hidden;background:var(--glass-2);border-radius:var(--r-sm)}
.skeleton::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,var(--glass-3),transparent);animation:shimmer 1.5s infinite}
@keyframes shimmer{100%{transform:translateX(100%)}}
.spinner{width:22px;height:22px;border:2.5px solid var(--border-2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--s-3);padding:var(--s-12) var(--s-4);color:var(--text-3);font-size:.875rem}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--s-3);padding:var(--s-12) var(--s-4);color:var(--text-3);font-size:.9rem;text-align:center}
.empty .e-ico{color:var(--text-3);opacity:.7}
.empty .e-ico .icon{width:34px;height:34px}
.err-text{color:var(--red)}

.app-footer{margin-top:var(--s-12);padding:var(--s-8) var(--s-4) var(--s-6);border-top:1px solid var(--border);text-align:center;color:var(--text-3);font-size:.8125rem}
.app-footer a{color:var(--text-2)}
.app-footer a:hover{color:var(--accent)}

@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.rise{animation:rise .5s var(--ease) both}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important}}
.guide-panel{border:1px solid var(--border);border-radius:var(--r-lg);background:linear-gradient(180deg,var(--glass-2),var(--glass-1));backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);overflow:hidden}
.guide-header{display:flex;align-items:center;justify-content:space-between;gap:var(--s-4);padding:var(--s-4) var(--s-5);border-bottom:1px solid var(--border);flex-wrap:wrap}
.guide-title{display:flex;align-items:center;gap:var(--s-2);font-size:1rem;font-weight:700}
.guide-meta{display:flex;align-items:center;gap:var(--s-2);font-size:.75rem;color:var(--text-3);font-family:var(--mono)}
.guide-dot{width:8px;height:8px;border-radius:50%;background:var(--text-3)}
.guide-dot.live{background:var(--green);box-shadow:0 0 6px var(--green)}
.guide-dot.error{background:var(--red)}
.guide-body{padding:var(--s-5);max-height:420px;overflow-y:auto;font-size:.875rem;line-height:1.65;color:var(--text-2)}
.guide-body h1,.guide-body h2,.guide-body h3{margin-top:var(--s-5);margin-bottom:var(--s-3);color:var(--text);font-weight:700}
.guide-body h1{font-size:1.15rem;border-bottom:1px solid var(--border);padding-bottom:var(--s-2);margin-top:0}
.guide-body h2{font-size:1rem;color:var(--accent)}
.guide-body h3{font-size:.9rem;color:var(--text-2)}
.guide-body p{margin-bottom:var(--s-3)}
.guide-body ul,.guide-body ol{margin-bottom:var(--s-3);padding-left:var(--s-5)}
.guide-body li{margin-bottom:var(--s-1)}
.guide-body code{font-family:var(--mono);font-size:.8125rem;background:var(--bg-1);padding:1px 5px;border-radius:4px;color:var(--accent)}
.guide-body pre{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--r-sm);padding:var(--s-3);overflow-x:auto;margin-bottom:var(--s-3)}
.guide-body pre code{background:none;padding:0;font-size:.78rem}
.guide-body blockquote{border-left:2px solid var(--accent);padding-left:var(--s-3);margin-bottom:var(--s-3);color:var(--text-3);font-style:italic}
.guide-body hr{border:none;border-top:1px solid var(--border);margin:var(--s-4) 0}
.guide-body table{width:100%;border-collapse:collapse;margin-bottom:var(--s-3);font-size:.8rem}
.guide-body th,.guide-body td{padding:var(--s-1) var(--s-2);text-align:left;border-bottom:1px solid var(--border)}
.guide-body th{font-weight:600;color:var(--text-3);font-size:.7rem;text-transform:uppercase;letter-spacing:.05em}
.guide-body tr:hover td{background:var(--glass-1)}
`;


// ─── PUBLIC STATUS PAGE ─────────────────────────────────────────────


// ─── Shared navbar and page wrapper ──────────
// New pages (dashboard, apps) wrap their body in renderShell() to get the
// game-styled sticky navbar, theme toggle and consistent container.
function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
const NAV_CSS = `
:root{--sb-w:236px}
/* ── Left sidebar (primary nav) ─────────────────────────────────── */
.ahd-sb{position:fixed;top:0;left:0;bottom:0;width:var(--sb-w);z-index:100;display:flex;flex-direction:column;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto;overscroll-behavior:contain}
.ahd-sb::-webkit-scrollbar{width:8px}
.sb-brand{display:flex;align-items:center;gap:.5rem;padding:var(--s-5) var(--s-4) var(--s-4);border-bottom:1px solid var(--border);margin-bottom:var(--s-3)}
.sb-brand .brand-logo{height:24px;width:auto;display:block}
.sb-brand .brand-name{font-weight:800;font-size:.95rem;letter-spacing:-.02em;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.sb-brand em{font-style:normal;color:var(--text-3);font-weight:700;font-size:.54rem;letter-spacing:.16em;text-transform:uppercase;border:1px solid var(--border);padding:.1rem .4rem;border-radius:var(--r-full)}
.sb-brand .sb-version{margin-left:auto;font:600 .62rem var(--mono);color:var(--text-3);flex-shrink:0}
.sb-nav{flex:1;padding:0 var(--s-3) var(--s-4);display:flex;flex-direction:column}
.sb-group{margin-top:var(--s-4)}
.sb-group:first-child{margin-top:0}
.sb-group-label{font-size:var(--fs-2xs);font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);padding:0 var(--s-2) var(--s-2)}
.sb-nav a{display:flex;align-items:center;gap:.6rem;padding:.55rem .65rem;margin-bottom:2px;border-radius:var(--r-sm);color:var(--text-2);font-size:var(--fs-body);font-weight:500;transition:color var(--t),background var(--t)}
.sb-nav a .icon{opacity:.6;flex-shrink:0}
.sb-nav a:hover{color:var(--text);background:var(--glass-2)}
.sb-nav a.active{color:var(--text);font-weight:650;background:var(--accent-soft);box-shadow:inset 2px 0 var(--accent)}
.sb-nav a.active .icon{opacity:1;color:var(--accent)}
.sb-nav a .ext{margin-left:auto;opacity:.35}
.sb-foot{padding:var(--s-3);border-top:1px solid var(--border);display:flex;align-items:center;gap:.5rem}
.sb-game{flex:1;display:inline-flex;align-items:center;gap:.4rem;color:var(--text-2);font-size:var(--fs-sm);font-weight:600;padding:.45rem .6rem;border-radius:var(--r-sm);border:1px solid var(--border);transition:all var(--t)}
.sb-game:hover{color:var(--text);border-color:var(--border-2)}
/* ── Studio game links (footer, one per game) ───────────────────── */
.sb-games{padding:var(--s-3) var(--s-3) 0;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:1px}
.sb-games a{display:flex;align-items:center;gap:.55rem;padding:.4rem .6rem;border-radius:var(--r-sm);color:var(--text-2);font-size:var(--fs-sm);font-weight:600;transition:color var(--t),background var(--t)}
.sb-games a:hover{color:var(--text);background:var(--glass-2)}
.sb-games .gdot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sb-games a .ext{margin-left:auto;opacity:.35}
/* ── Top bar + content (offset by the sidebar) ──────────────────── */
.ahd-topbar{margin-left:var(--sb-w);position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:var(--s-3);min-height:68px;padding:.65rem clamp(1rem,3vw,2rem);border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg-0) 88%,transparent);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.ahd-topbar .tb-context{display:flex;flex-direction:column;gap:2px;min-width:0}
.ahd-topbar .tb-section{font:650 var(--fs-2xs) var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}
.ahd-topbar .tb-title{font-size:var(--fs-h2);font-weight:700;color:var(--text);letter-spacing:-.025em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ahd-topbar .tb-actions{display:flex;align-items:center;gap:var(--s-2);margin-left:auto}
.ahd-topbar .tb-status{display:inline-flex;align-items:center;gap:.45rem;padding:.45rem .65rem;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text-2);font-size:var(--fs-xs);text-decoration:none}
.ahd-topbar .tb-status::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--text-3)}
.ahd-topbar .tb-status:hover{color:var(--text);border-color:var(--border-2)}
.ahd-main{margin-left:var(--sb-w);max-width:1440px;padding:var(--s-5) clamp(1rem,3vw,2rem) var(--s-12)}
.sb-toggle{display:none;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--r-sm);border:1px solid var(--border);background:var(--glass-2);color:var(--text-2);cursor:pointer}
.tb-logo{display:none;height:22px;width:auto;flex-shrink:0}
.sb-backdrop{position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.55);opacity:0;pointer-events:none;transition:opacity var(--t)}
@media(max-width:860px){
  .ahd-sb{transform:translateX(-100%);transition:transform var(--t-slow);box-shadow:var(--e3)}
  body.sb-open .ahd-sb{transform:none}
  .ahd-main,.ahd-topbar{margin-left:0}
  .ahd-topbar{padding-top:calc(.6rem + env(safe-area-inset-top,0))}
  .ahd-main{padding-bottom:calc(var(--s-12) + env(safe-area-inset-bottom,0))}
  .sb-toggle{display:inline-flex}
  .tb-logo{display:block}
  body.sb-open .sb-backdrop{opacity:1;pointer-events:auto}
}
@media(max-width:680px){.ahd-topbar .tb-status{display:none}.ahd-topbar .tb-section{font-size:.6rem}.ahd-topbar .tb-title{font-size:var(--fs-h3)}}
/* ── Slim top bar — used ONLY by immersive apps (ask, code) ─────── */
.ahd-nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:var(--s-4);padding:.5rem clamp(1rem,4vw,1.5rem);border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg-0) 82%,transparent);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.ahd-nav .brand{display:flex;align-items:center;gap:.5rem;white-space:nowrap}
.ahd-nav .brand-logo{height:24px;width:auto;display:block}
.ahd-nav .brand em{font-style:normal;color:var(--text-3);font-weight:700;font-size:.56rem;letter-spacing:.14em;text-transform:uppercase;border:1px solid var(--border);padding:.1rem .4rem;border-radius:var(--r-full)}
.nav-links{display:flex;align-items:center;gap:.15rem;margin-left:var(--s-3)}
.nav-links a{display:inline-flex;align-items:center;gap:.4rem;position:relative;padding:.4rem .7rem;border-radius:var(--r-sm);color:var(--text-2);font-size:var(--fs-sm);font-weight:500;white-space:nowrap;transition:color var(--t),background var(--t)}
.nav-links a:hover{color:var(--text);background:var(--glass-2)}
.nav-links a.active{color:var(--text);font-weight:600;background:var(--accent-soft)}
.nav-links a.active .icon{color:var(--accent)}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:.5rem}
.nav-game{display:inline-flex;align-items:center;gap:.4rem;color:var(--text);font-size:var(--fs-sm);font-weight:600;padding:.4rem .8rem;border-radius:var(--r-sm);border:1px solid var(--border);background:var(--glass-2)}
@media(max-width:680px){.nav-links a span,.nav-game span{display:none}}
/* ── "View as moderator" preview ────────────────────────────────── */
.sb-modview{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--r-sm);border:1px solid var(--border);background:var(--glass-2);color:var(--text-2);cursor:pointer;transition:all var(--t);flex-shrink:0}
.sb-modview:hover{color:var(--text);border-color:var(--border-2)}
body.mod-view .sb-modview{color:var(--accent);border-color:transparent;background:var(--accent-soft)}
body.mod-view .sb-nav a:not([data-mod]){display:none}
body.mod-view .sb-group:not(:has(a[data-mod])){display:none}
.modview-banner{display:none}
body.mod-view .modview-banner{display:flex;align-items:center;gap:.5rem;padding:.45rem clamp(1rem,3vw,2rem);background:var(--accent-soft);color:var(--text);font-size:var(--fs-sm);font-weight:600;border-bottom:1px solid var(--border)}
body.mod-view .modview-banner.shell{margin-left:var(--sb-w)}
.modview-banner .icon{color:var(--accent)}
.modview-banner button{margin-left:auto;display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .65rem;border-radius:var(--r-sm);border:1px solid var(--border-2);background:transparent;color:var(--text);font-size:var(--fs-xs);font-weight:600;cursor:pointer}
.modview-banner button:hover{background:var(--glass-2)}
@media(max-width:860px){body.mod-view .modview-banner.shell{margin-left:0}}
${WORKBENCH_CSS}
`;

// Client-side "view as moderator" preview: toggles a body class that hides
// non-moderator nav and shows a banner. Pure presentation — real access is
// unchanged. Event-delegated so it works for both shell and injected pages.
const MODVIEW_JS = `<script>(function(){function mv(v){try{localStorage.setItem('ops-modview',v?'1':'0')}catch(e){}document.body.classList.toggle('mod-view',v)}
try{if(localStorage.getItem('ops-modview')==='1')document.body.classList.add('mod-view')}catch(e){}
document.addEventListener('click',function(e){if(e.target.closest('#modviewToggle')){mv(!document.body.classList.contains('mod-view'))}else if(e.target.closest('#modviewExit')){mv(false)}});})();</script>`;

// Edge-swipe open / swipe-close for the ops left sidebar on narrow viewports.
const SIDEBAR_GESTURE_JS = `<script>(function(){
if(window.__opsSbGesture)return;window.__opsSbGesture=1;
var MQ=window.matchMedia('(max-width:860px)');
var startX=0,startY=0,tracking=false,fromEdge=false,onPanel=false;
function mobile(){return MQ.matches}
function openSb(){document.body.classList.add('sb-open')}
function closeSb(){document.body.classList.remove('sb-open')}
function isOpen(){return document.body.classList.contains('sb-open')}
function onStart(e){
  if(!mobile()||e.touches.length!==1)return;
  var t=e.touches[0];
  startX=t.clientX;startY=t.clientY;tracking=true;
  fromEdge=!isOpen()&&startX<=28;
  onPanel=isOpen()&&!!(e.target.closest&&e.target.closest('.ahd-sb,.sb-backdrop'));
  if(!fromEdge&&!onPanel)tracking=false;
}
function onMove(e){
  if(!tracking||!e.touches.length)return;
  var t=e.touches[0],dx=t.clientX-startX,dy=t.clientY-startY;
  if(Math.abs(dx)<Math.abs(dy)*1.15)return;
  if(fromEdge&&dx>56){openSb();tracking=false;e.preventDefault()}
  else if((onPanel||isOpen())&&dx<-56){closeSb();tracking=false;e.preventDefault()}
}
function onEnd(){tracking=false;fromEdge=false;onPanel=false}
document.addEventListener('touchstart',onStart,{passive:true});
document.addEventListener('touchmove',onMove,{passive:false});
document.addEventListener('touchend',onEnd,{passive:true});
document.addEventListener('touchcancel',onEnd,{passive:true});
})();</script>`;

function modviewBanner(shell) {
  return `<div class="modview-banner${shell ? " shell" : ""}">${icon("eye", { size: 14 })}<span>Previewing the moderator view — this only changes what you see, not your access.</span><button type="button" id="modviewExit">${icon("x", { size: 12 })} Exit</button></div>`;
}

function externalSidebarItems(group) {
  return listExternalLinks(group).map((l) => ({
    href: l.href,
    label: l.label,
    icon: l.icon || "external-link",
    ext: true,
    mod: l.mod,
    feature: l.feature,
  }));
}

function buildSidebar() {
  return [
  { label: "Operate", items: [
    { href: "/", label: "Overview", icon: "home" },
    { href: "/tickets", label: "Tickets", icon: "life-buoy", feature: "tickets" },
    { href: "/reports/worldsim-audit-program", label: "World Audit", icon: "activity" },
    { href: "/kanban", label: "Kanban", icon: "check-square" },
    { href: "/keir", label: "Keir", icon: "activity" },
    { href: "/inbox", label: "Keir inbox", icon: "message-square" },
    { href: "/scheduler", label: "Scheduler", icon: "calendar" },
    { href: "/worktrees", label: "Worktrees", icon: "git-branch" },
  ] },
  { label: "Monitor", items: [
    { href: "/status", label: "Uptime", icon: "activity", mod: true, feature: "statusPage" },
    { href: "/engine", label: "Engine", icon: "cpu" },
    { href: "/observatory", label: "Observatory", icon: "eye" },
    { href: "/events", label: "Event Recovery", icon: "activity" },
    { href: "/security", label: "Security", icon: "shield" },
  ] },
  { label: "Product", items: [
    { href: "/games", label: "Games", icon: "globe" },
    { href: "/reports", label: "Daily Reports", icon: "newspaper" },
    { href: "/navair", label: "Blue Water", icon: "activity" },
    { href: "/suggestions", label: "Suggestions", icon: "lightbulb", feature: "tickets" },
    { href: "/ideas", label: "Ideas", icon: "sparkles", feature: "ideas" },
    { href: "/community-voice", label: "Community Voice", icon: "message-circle", feature: "discordInsights" },
  ] },
  { label: "Tools", items: [
    { href: "/ask", label: "Ask", icon: "message", mod: true },
    { href: "/finder", label: "Finder", icon: "folder" },
    { href: "/pr-reviews", label: "PR Reviews", icon: "git-pull-request" },
    { href: "/db", label: "Database", icon: "database", feature: "dbBrowser" },
    { href: "/backups", label: "Backups", icon: "folder", feature: "backups" },
    { href: "/wiki-export", label: "Wiki Export", icon: "download", feature: "wikiExport" },
    { href: "/skills", label: "Skills", icon: "zap", feature: "agentsPage" },
    { href: "/memories", label: "Memories", icon: "pin", feature: "agentsPage" },
    { href: "/learn", label: "Learn", icon: "graduation-cap" },
  ] },
  { label: "External services", items: [
    ...externalSidebarItems("Platform"),
    ...externalSidebarItems("Observability"),
    ...externalSidebarItems("Analytics"),
    ...externalSidebarItems("Tools"),
    ...externalSidebarItems("Workflows"),
  ] },
];
}

function getSidebar() {
  return buildSidebar();
}

// Grouped sidebar nav — filtered by feature flags at render time.
const SIDEBAR = buildSidebar();

function sidebarForFeatures() {
  const { isEnabled } = require("./src/services/featureFlags");
  return getSidebar()
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.feature || isEnabled(item.feature)),
    }))
    .filter((group) => group.items.length > 0);
}

function renderSidebar(active, role, opts = {}) {
  const isAdmin = role === "admin";
  // When rendered by a standalone app on another subdomain (e.g. docs.*), make
  // relative links + assets absolute against the ops origin so the shared nav
  // still works cross-subdomain.
  const base = (opts.base || "").replace(/\/+$/, "");
  const safeLink = (h) => {
    if (typeof h !== "string") return null;
    if (h.startsWith("/") && !h.startsWith("//")) return h;
    try { const url = new URL(h); return url.protocol === "https:" ? url.href : null; }
    catch { return null; }
  };
  const abs = (h) => (base && h.startsWith("/") ? base + h : h);
  const featured = sidebarForFeatures();
  const groups = isAdmin ? featured : featured.map((g) => ({ label: g.label, items: g.items.filter((it) => it.mod) })).filter((g) => g.items.length);
  const nav = groups
    .map((g, index) => `<details class="sb-group" ${!isAdmin || index === 0 || g.items.some((it) => it.href === active) ? "open" : ""}><summary class="sb-group-label">${escHtml(g.label)}<span class="sb-group-chevron" aria-hidden="true">⌄</span></summary><div class="sb-links">${g.items
      .map((it) => {
        const href = safeLink(it.href);
        if (!href) return "";
        const cls = active === it.href ? ' class="active"' : "";
        const ext = it.ext ? ' target="_blank" rel="noopener"' : "";
        const md = it.mod ? ' data-mod="1"' : "";
        const extIco = it.ext ? `<span class="ext">${icon("external-link", { size: 13 })}</span>` : "";
        return `<a href="${escHtml(abs(href))}"${cls}${active === it.href ? ' aria-current="page"' : ''}${ext}${md}>${icon(it.icon, { size: 16 })}<span>${escHtml(it.label)}</span>${extIco}</a>`;
      })
      .join("")}</div></details>`)
    .join("");
  // Admins get a "view as moderator" toggle to preview the restricted experience.
  // (Suppressed in cross-subdomain mode — the toggle relies on dashboard-local JS.)
  const modBtn = isAdmin && !base
    ? `<button class="sb-modview" id="modviewToggle" type="button" title="Preview moderator view" aria-label="Preview moderator view">${icon("eye", { size: 16 })}</button>`
    : "";
  const gameLinks = GAMES
    .map((g) => safeLink(g.publicUrl) ? `<a href="${escHtml(safeLink(g.publicUrl))}" target="_blank" rel="noopener" title="${escHtml(g.name)}"><span class="gdot" style="background:${/^#[0-9a-fA-F]{3,8}$/.test(g.accent || "") ? g.accent : "var(--accent)"}"></span><span>${escHtml(g.name)}</span><span class="ext">${icon("external-link", { size: 13 })}</span></a>` : "")
    .join("");
  const publicSettings = role === "public" ? `<div class="sb-foot" style="margin-top:auto;display:block;padding:16px 20px"><div style="font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);margin-bottom:12px">Settings</div><div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">${themeToggle()}<span style="font-size:.82rem;color:var(--text-2)">Light / dark mode</span></div><a href="https://lakesidegames.net/account" style="display:flex;align-items:center;gap:8px;color:var(--text-2);font-size:.85rem">${icon("user", { size: 16 })}<span>Lakeside account profile</span></a></div>` : "";
  const brand = brandMeta();
  return `<aside class="ahd-sb">
    <a class="sb-brand" href="${escHtml(abs(isAdmin ? "/" : "/ask"))}"><span class="sb-brand-mark" aria-hidden="true">${escHtml(brand.shortName.slice(0, 1).toUpperCase())}<img class="sb-brand-logo" src="${escHtml(abs(safeLink(brand.logoUrl) || "/logo.svg"))}" alt="" onerror="this.remove()"></span><span class="sb-brand-copy"><strong>${escHtml(brand.shortName)}</strong><small>Operations workspace</small></span></a>
    <nav class="sb-nav" aria-label="Main navigation">${nav}</nav>
    ${role === "public" ? publicSettings : `<details class="sb-portfolio"><summary>Projects <span aria-hidden="true">⌄</span></summary><div class="sb-games">${gameLinks}</div></details>
    <div class="sb-foot"><span class="sb-version">v${escHtml(APP_VERSION)}</span>${modBtn}${themeToggle()}</div>`}
  </aside>`;
}

// Slim top bar kept for immersive full-screen apps (ask, code session).
function renderNavbar(active, role) {
  const isAdmin = role === "admin";
  const links = (isAdmin
    ? [["/", "Dashboard", "home"], ["/reports", "Reports", "newspaper"], ["/ask", "Ask", "message"]]
    : [["/status", "Status", "activity"], ["/ask", "Ask", "message"]]
  )
    .map(([h, l, ic]) => `<a href="${h}" class="${active === h ? "active" : ""}">${icon(ic, { size: 15 })}<span>${l}</span></a>`)
    .join("");
  const gameLinks = GAMES
    .map((g) => `<a class="nav-game" href="${g.publicUrl}" target="_blank" rel="noopener" title="${escHtml(g.name)}"><span class="gdot" style="background:${g.accent};width:8px;height:8px;border-radius:50%;flex-shrink:0"></span><span>${escHtml(g.name)}</span></a>`)
    .join("");
  const brand = brandMeta();
  return `<nav class="ahd-nav">
    <a class="brand" href="${isAdmin ? "/" : "/ask"}"><img class="brand-logo" src="${brand.logoUrl}" alt="${escHtml(brand.name)}"><em>Ops</em></a>
    <div class="nav-links">${links}</div>
    <div class="nav-right">${gameLinks}</div>
  </nav>`;
}

// ─── ⌘K command palette ──────────────────────────────────────────────
const CMDK_CSS = `
.cmdk-trigger{display:inline-flex;align-items:center;gap:.5rem;margin-left:auto;padding:.4rem .65rem;border-radius:var(--r-sm);border:1px solid var(--border);background:var(--glass-2);color:var(--text-3);font-size:var(--fs-sm);cursor:pointer;transition:all var(--t)}
.cmdk-trigger:hover{color:var(--text-2);border-color:var(--border-2)}
.cmdk-trigger kbd{font-family:var(--mono);font-size:var(--fs-2xs);background:var(--surface-2);border:1px solid var(--border);border-radius:4px;padding:0 .3rem}
@media(max-width:680px){.cmdk-trigger span{display:none}}
.cmdk{display:none;position:fixed;inset:0;z-index:300;align-items:flex-start;justify-content:center;padding-top:12vh}
.cmdk.on{display:flex}
.cmdk-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(2px)}
.cmdk-box{position:relative;width:min(560px,92vw);background:var(--surface);border:1px solid var(--border-2);border-radius:var(--r-lg);box-shadow:var(--e3);overflow:hidden}
.cmdk-inwrap{display:flex;align-items:center;gap:.6rem;padding:.85rem 1rem;border-bottom:1px solid var(--border);color:var(--text-3)}
.cmdk-input{flex:1;background:transparent;border:none;outline:none;color:var(--text);font-size:var(--fs-h3);font-family:var(--font)}
.cmdk-list{max-height:50vh;overflow-y:auto;padding:.4rem}
.cmdk-item{display:flex;align-items:center;gap:.65rem;padding:.55rem .7rem;border-radius:var(--r-sm);color:var(--text-2);font-size:var(--fs-body);text-decoration:none}
.cmdk-item .icon{opacity:.7}
.cmdk-item em{margin-left:auto;font-style:normal;font-size:var(--fs-2xs);text-transform:uppercase;letter-spacing:.06em;color:var(--text-3)}
.cmdk-item.sel,.cmdk-item:hover{background:var(--accent-soft);color:var(--text)}
.cmdk-item.sel .icon{color:var(--accent)}
.cmdk-empty{padding:1.2rem;text-align:center;color:var(--text-3);font-size:var(--fs-sm)}
.cmdk-foot{display:flex;gap:.8rem;padding:.5rem 1rem;border-top:1px solid var(--border);font-size:var(--fs-2xs);color:var(--text-3)}
.cmdk-foot kbd{font-family:var(--mono);background:var(--glass-2);border:1px solid var(--border);border-radius:4px;padding:0 .3rem}
`;
const CMDK_JS = `<script>(function(){var cmds=window.__CMDS||[],box,inp,list,items=[],sel=0;
function safeHref(h){if(typeof h!=='string')return null;if(h.startsWith('/')&&!h.startsWith('//'))return h;try{var u=new URL(h);return u.protocol==='https:'?u.href:null}catch(e){return null}}
function render(f){f=(f||'').toLowerCase();items=cmds.filter(function(c){return c.label.toLowerCase().indexOf(f)>=0});if(sel>=items.length)sel=Math.max(0,items.length-1);
list.replaceChildren();if(!items.length){var empty=document.createElement('div');empty.className='cmdk-empty';empty.textContent='No results';list.append(empty);return}
items.forEach(function(c,i){var href=safeHref(c.href);if(!href)return;var a=document.createElement('a');a.className='cmdk-item'+(i===sel?' sel':'');a.href=href;if(c.ext){a.target='_blank';a.rel='noopener'}var label=document.createElement('span');label.textContent=c.label;a.append(label);if(c.group){var group=document.createElement('em');group.textContent=c.group;a.append(group)}list.append(a)});}
function openP(){box.classList.add('on');sel=0;inp.value='';render('');setTimeout(function(){inp.focus()},10);}
function closeP(){box.classList.remove('on');}
function go(c){if(!c)return;var href=safeHref(c.href);if(!href)return;if(c.ext)window.open(href,'_blank','noopener');else location.href=href;}
document.addEventListener('keydown',function(e){
 if((e.metaKey||e.ctrlKey)&&(e.key==='k'||e.key==='K')){e.preventDefault();box.classList.contains('on')?closeP():openP();return;}
 if(!box||!box.classList.contains('on'))return;
 if(e.key==='Escape')closeP();
 else if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,items.length-1);render(inp.value);}
 else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);render(inp.value);}
 else if(e.key==='Enter'){e.preventDefault();go(items[sel]);}});
function init(){box=document.getElementById('cmdk');if(!box)return;inp=document.getElementById('cmdk-input');list=document.getElementById('cmdk-list');
 inp.addEventListener('input',function(){sel=0;render(inp.value)});
 box.querySelector('.cmdk-backdrop').addEventListener('click',closeP);
 var t=document.getElementById('cmdk-trigger');if(t)t.addEventListener('click',openP);}
if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);})();</script>`;
function renderCommandPalette(role, base = "") {
  const b = (base || "").replace(/\/+$/, "");
  const abs = (h) => (b && h.startsWith("/") ? b + h : h);
  const groups = role === "admin" ? sidebarForFeatures() : sidebarForFeatures().map((g) => ({ label: g.label, items: g.items.filter((it) => it.mod) })).filter((g) => g.items.length);
  const cmds = [];
  groups.forEach((g) => g.items.forEach((it) => cmds.push({ label: it.label, href: abs(it.href), icon: icon(it.icon, { size: 16 }), ext: !!it.ext, group: g.label })));
  const json = JSON.stringify(cmds).replace(/</g, "\\u003c");
  return `<div class="cmdk" id="cmdk"><div class="cmdk-backdrop"></div><div class="cmdk-box"><div class="cmdk-inwrap">${icon("search", { size: 16 })}<input class="cmdk-input" id="cmdk-input" placeholder="Search pages…" autocomplete="off" spellcheck="false"></div><div class="cmdk-list" id="cmdk-list"></div><div class="cmdk-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div></div><script>window.__CMDS=${json};</script>${CMDK_JS}`;
}

function renderShell(opts) {
  const { title = "Ops", active = "/", role = "admin", body = "", extraCss = "", base = "", product = "ops" } = opts || {};
  const b = (base || "").replace(/\/+$/, "");
  const asset = (h) => (b ? b + h : h);
  const brand = brandMeta();
  const section = sidebarForFeatures().find((group) => group.items.some((item) => item.href === active))?.label || "Workspace";
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${escHtml(title)} · ${escHtml(brand.title)}</title>
${THEME_HEAD}
${product === "keir"
  ? `<link rel="icon" href="${asset("/keir-mark.svg")}" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="${asset("/keir-favicon-32.png")}">
<link rel="apple-touch-icon" href="${asset("/keir-apple-touch-icon.png")}">`
  : `<link rel="icon" href="${asset(brand.logoUrl)}" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="${asset("/favicon-32.png")}">
<link rel="apple-touch-icon" href="${asset("/apple-touch-icon.png")}">`}
${FONT_LINKS}
<style>${BASE_CSS}${NAV_CSS}${CMDK_CSS}${extraCss}</style>
</head><body>
${renderSidebar(active, role, { base: b })}
<div class="sb-backdrop" onclick="document.body.classList.remove('sb-open')"></div>
<header class="ahd-topbar"><button class="sb-toggle" onclick="document.body.classList.toggle('sb-open')" aria-label="Toggle navigation">${icon("menu", { size: 18 })}</button><div class="tb-context"><span class="tb-section">${escHtml(section)}</span><div class="tb-title">${escHtml(title)}</div></div><div class="tb-actions"><a class="tb-status" href="${asset('/status')}">Status</a><button class="cmdk-trigger" id="cmdk-trigger" type="button" aria-label="Search pages">${icon('search', { size: 15 })}<span>Search pages</span><kbd>⌘K</kbd></button></div></header>
${b ? "" : modviewBanner(true)}
<main class="ahd-main">${body}</main>
${renderCommandPalette(role, b)}${clientBootstrapScript()}${THEME_TOGGLE_JS}${MODVIEW_JS}${SIDEBAR_GESTURE_JS}
</body></html>`;
}

// Wrap a legacy standalone page (its own <body>) with the shared nav so it
// keeps the same structure / a way back. NAV_CSS is injected inline since the
// legacy page already carries BASE_CSS.
//
// opts.immersive + opts.offset: for full-viewport apps (ask, code session) whose
// body is `overflow:hidden` with a `position:fixed; inset:0` root, a normal
// in-flow nav can't sit above them. Instead pin the nav fixed at the top and
// push the app root down by the bar height (its `inset:0` shrinks cleanly, so
// nothing is clipped).
const OPS_BAR_H = 48;
function injectNav(html, active, session, opts = {}) {
  const role = session ? session.role : "admin";
  const mobileToggle = opts.mobileToggle !== false;
  let styleBlock, htmlBlock;
  if (opts.immersive) {
    // Full-screen apps (ask, code): slim fixed top bar, push the app root down.
    styleBlock =
      `<style>${NAV_CSS}
        .ahd-nav{position:fixed;top:0;left:0;right:0;z-index:9990;height:${OPS_BAR_H}px;padding-top:0;padding-bottom:0}
        ${opts.offset || "body"}{top:${OPS_BAR_H}px !important}
      </style>`;
    htmlBlock = renderNavbar(active, role);
  } else {
    // Scrollable legacy pages: the full left sidebar, with content offset.
    // opts.rootOffset: for a full-viewport app whose root is `position:fixed;
    // inset:0` (e.g. the code session app), shift that root's `left` by the
    // sidebar width instead of padding body (which a fixed root ignores).
    const offsetCss = opts.rootOffset
      ? `${opts.rootOffset}{left:var(--sb-w)!important}@media(max-width:860px){${opts.rootOffset}{left:0!important}}`
      : `body{padding-left:var(--sb-w)}@media(max-width:860px){body{padding-left:0}}`;
    styleBlock =
      `<style>${NAV_CSS}${CMDK_CSS}
        ${offsetCss}
        .leg-toggle{position:fixed;top:12px;left:12px;z-index:101;display:none;align-items:center;justify-content:center;width:38px;height:38px;border-radius:var(--r-sm);border:1px solid var(--border);background:var(--surface);color:var(--text-2);cursor:pointer}
        @media(max-width:860px){.leg-toggle{display:inline-flex}}
      </style>`;
    htmlBlock =
      renderSidebar(active, role) +
      `<div class="sb-backdrop" onclick="document.body.classList.remove('sb-open')"></div>` +
      (mobileToggle
        ? `<button class="leg-toggle" onclick="document.body.classList.toggle('sb-open')" aria-label="Toggle navigation">${icon("menu", { size: 18 })}</button>`
        : "") +
      modviewBanner(false) +
      renderCommandPalette(role) +
      THEME_TOGGLE_JS + MODVIEW_JS + SIDEBAR_GESTURE_JS;
  }
  // Styles go in <head> so the layout (sidebar offset) is correct on first
  // paint — injecting them after <body> caused a full-width flash then a jump.
  const out = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, styleBlock + "</head>")
    : html.replace(/<body([^>]*)>/i, (m, attrs) => `<body${attrs}>${styleBlock}`);
  return out.replace(/<body([^>]*)>/i, (m, attrs) => `<body${attrs}>${htmlBlock}`);
}

module.exports = { FONT_LINKS, BASE_CSS, escHtml, NAV_CSS, MODVIEW_JS, SIDEBAR_GESTURE_JS, modviewBanner, SIDEBAR, sidebarForFeatures, renderSidebar, renderNavbar, CMDK_CSS, CMDK_JS, renderCommandPalette, renderShell, injectNav, OPS_BAR_H };
