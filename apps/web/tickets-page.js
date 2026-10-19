// ─── COMMUNITY: TICKETS MANAGEMENT PAGE ──────────────────────────────────
// Self-contained body/CSS generators for the /tickets list + detail views.
// Rendered server-side and wrapped with the shared admin shell (renderShell).
const { icon } = require("./ui-kit");
const {
  getResolution,
  isTerminalStatus,
  publicTimeline,
  publicStatusLabel,
  resolutionSourceLabel,
} = require("./ticket-receipt");
const {
  PLAYER_COPY,
  contextRequestForDisplay,
} = require("./ticket-context");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function relTime(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  const diff = Date.now() - dt.getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return s <= 1 ? "just now" : s + "s ago";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const days = Math.round(h / 24);
  if (days < 30) return days + "d ago";
  return fmtDate(d);
}

// Triage metadata card: tags (chips), a "likely already fixed" badge, and a
// status-history timeline. Shared by the ticket + suggestion detail bodies.
// `tags` comes off the item doc, `likelyAlreadyFixed` off the assessment,
// `statusHistory` off the item doc.
function renderTriageMeta({ tags, assessment, statusHistory, terminalStatus = false }) {
  const t = Array.isArray(tags) ? tags : [];
  const history = Array.isArray(statusHistory) ? statusHistory : [];
  const fixed = !!(assessment && assessment.likelyAlreadyFixed === true);
  if (!t.length && !history.length && !fixed) return "";

  const fixedBadge = fixed
    ? `<div class="cm-fixed">${icon("check", { size: 14 })} Likely already fixed</div>`
    : "";
  const tagChips = t.length
    ? `<div class="cm-tagrow">${t.map((x) => `<span class="cm-ttag">${esc(x)}</span>`).join("")}</div>`
    : "";
  const timeline = history.length
    ? `${terminalStatus ? "" : `<h2 style="margin-top:var(--s-4)">${icon("clock", { size: 13 })} Status history</h2>`}
       <ol class="cm-timeline">${history
         .slice()
         .reverse()
         .map(
           (h) =>
             `<li><span class="cm-tl-status">${esc(String(h.status || "").replace(/_/g, " "))}</span>` +
             (h.source ? `<span class="cm-tl-src">${esc(h.source)}</span>` : "") +
             `<span class="cm-tl-time">${esc(relTime(h.at))}${h.by ? " · " + esc(h.by) : ""}</span>` +
             (h.note ? `<div class="cm-tl-note">${esc(h.note)}</div>` : "") +
             `</li>`
         )
         .join("")}</ol>`
    : "";

  return `<div class="cm-card"><h2>${icon("tag", { size: 14 })} ${terminalStatus ? "Status history" : "Triage"}</h2>${fixedBadge}${tagChips}${timeline}</div>`;
}

// Shared styling for both tickets and suggestions pages.
const COMMUNITY_CSS = `
/* GitHub triage, built for a phone first. A six-row table plus three link
   lists is a wall on a 390px screen, so the outcome and the classification sit
   on top, every link is a full-width tap target, and the confidences live one
   tap away. Nothing is removed, just ordered. */
/* Timeline rows for the reporter's page: label left, date right, no table. */
.cm-tl{display:flex;flex-direction:column;gap:.35rem;font-size:.86rem}
.cm-tl-row{display:flex;justify-content:space-between;gap:var(--s-3)}
.cm-tl-k{color:var(--text-3)}
/* Stage bar: five segments, readable at 390px without a legend to decode. */
.cm-stage{margin:var(--s-3) 0 var(--s-4)}
.cm-stage-bar{display:flex;gap:4px;margin-bottom:.45rem}
.cm-stage-bar .seg{flex:1;height:6px;border-radius:var(--r-full,999px);background:var(--surface-2,var(--glass-2))}
.cm-stage-bar .seg.on{background:var(--accent)}
.cm-stage-now{font-weight:600;font-size:.9rem}
.cm-stage-hint{font-size:.74rem;color:var(--text-3);margin-top:.15rem}
/* An expired attachment URL shows a labelled chip instead of a broken image. */
.cm-imgs{flex-wrap:wrap}
.cm-img.cm-img-dead{display:inline-flex;align-items:center;min-height:2.25rem;padding:.35rem .6rem;border:1px solid var(--border);border-radius:var(--r-sm);text-decoration:none}
.cm-img.cm-img-dead img{display:none}
.cm-img.cm-img-dead::before{content:"expired attachment";font-size:.76rem;color:var(--text-3)}
/* When every attachment in a group is dead, say it once instead of N times. */
.cm-imgs-all-dead .cm-img{display:none}
.cm-imgs-all-dead::before{content:attr(data-all-dead);font-size:.8rem;color:var(--text-3)}
.cm-msgs-tail{margin-top:var(--s-3);padding-top:var(--s-3);border-top:1px dashed var(--border)}
.cm-gh-links{display:flex;flex-direction:column;gap:.25rem;margin:var(--s-3) 0 0}
.cm-gh-link{display:flex;align-items:center;gap:.5rem;min-height:2.75rem;padding:.5rem .7rem;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:inherit;text-decoration:none;font-size:.86rem}
.cm-gh-link:hover{background:var(--glass-2)}
.cm-gh-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cm-gh-link .k{font-family:var(--mono);font-size:.78rem;font-weight:600;color:var(--text);flex-shrink:0}
.cm-gh-link .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3)}
.cm-gh-link .c{font-size:.74rem;color:var(--text-3);flex-shrink:0}
.cm-gh-more{margin-top:var(--s-4);border-top:1px solid var(--border);padding-top:.55rem}
.cm-gh-more>summary{cursor:pointer;font-size:.78rem;font-weight:600;color:var(--text-3);list-style:none}
.cm-gh-more>summary::-webkit-details-marker{display:none}
.cm-gh-more>summary::after{content:" +"}
.cm-gh-more[open]>summary::after{content:" −"}
.cm-gh-sig{display:flex;flex-wrap:wrap;gap:.4rem .8rem;margin:.6rem 0 0;font-size:.8rem;color:var(--text-3)}
.cm-gh-sig b{font-weight:600;color:var(--text-2)}
.cm-conf{opacity:.65}
.cm-muted{opacity:.65}

.cm-head{padding:var(--s-7) 0 var(--s-5)}
.cm-head h1{font-size:clamp(1.4rem,3vw,1.9rem);font-weight:800;letter-spacing:-.025em;display:flex;align-items:center;gap:.55rem}
.cm-head p{color:var(--text-3);margin-top:.3rem;font-size:.88rem}
.cm-list-summary{display:flex;align-items:center;justify-content:space-between;gap:var(--s-3);margin:var(--s-4) 0;color:var(--text-3);font-size:var(--fs-xs)}
.cm-list-summary strong{font:700 var(--fs-h3) var(--mono);color:var(--text)}
.cm-list-summary a{color:var(--accent);font-weight:650;text-decoration:none}
.cm-tabs{display:flex;flex-wrap:wrap;gap:.4rem;margin:var(--s-4) 0 var(--s-5)}
.cm-tab{padding:.35rem .75rem;border-radius:var(--r-pill,999px);border:1px solid var(--border);background:var(--surface);color:var(--text-3);font-size:.8rem;font-weight:600;text-decoration:none;transition:all var(--t)}
.cm-tab:hover{color:var(--text-2);border-color:var(--border-2)}
.cm-tab.on{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 45%,var(--border));color:var(--accent)}
.cm-list{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;background:var(--surface)}
.cm-row{display:grid;grid-template-columns:64px 1fr auto;gap:var(--s-4);align-items:center;padding:.85rem var(--s-5);border-bottom:1px solid var(--border);text-decoration:none;color:inherit;transition:background var(--t)}
.cm-row:last-child{border-bottom:none}
.cm-row:hover{background:var(--glass-2)}
.cm-num{font-family:var(--mono);font-size:.8rem;color:var(--text-3);font-weight:600}
.cm-main{min-width:0}
.cm-title{font-weight:600;font-size:.95rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cm-sub{font-size:.78rem;color:var(--text-3);margin-top:.2rem;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.cm-right{display:flex;align-items:center;gap:.5rem;flex-shrink:0}
.cm-badge{display:inline-flex;align-items:center;gap:.3rem;padding:.18rem .5rem;border-radius:var(--r-sm);font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--border)}
.cm-badge.b-open,.cm-badge.b-not_reviewed{background:var(--accent-soft);color:var(--accent)}
.cm-badge.b-triaging{background:var(--amber-soft,rgba(245,180,80,.15));color:var(--amber,#f5b450)}
.cm-badge.b-assessed,.cm-badge.b-planned{background:var(--accent-soft);color:var(--accent)}
.cm-badge.b-in_progress{background:var(--accent-soft);color:var(--accent)}
.cm-badge.b-resolved,.cm-badge.b-completed{background:var(--green-soft,rgba(80,200,120,.15));color:var(--green,#50c878)}
.cm-badge.b-closed,.cm-badge.b-wont_fix,.cm-badge.b-not_implementing{background:var(--glass-2);color:var(--text-3)}
.cm-flag{display:inline-flex;align-items:center;gap:.25rem;font-size:.72rem;color:var(--text-3)}
.cm-flag.has{color:var(--green,#50c878)}
/* triage-state badge on list rows */
.cm-triage{display:inline-flex;align-items:center;gap:.35rem;font-size:.72rem;font-weight:700;color:var(--text-3)}
.cm-triage.has{color:var(--green,#50c878)}
.cm-triage.awaiting{color:var(--text-3);font-weight:600;font-style:italic}
.cm-chips{display:inline-flex;gap:.3rem}
.cm-chip{display:inline-flex;align-items:center;padding:.1rem .4rem;border-radius:var(--r-sm);font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em;border:1px solid var(--border);background:var(--glass-2);color:var(--text-2)}
.cm-chip.risk-low{background:var(--green-soft,rgba(80,200,120,.13));color:var(--green,#50c878);border-color:transparent}
.cm-chip.risk-medium{background:var(--amber-soft,rgba(245,180,80,.13));color:var(--amber,#f5b450);border-color:transparent}
.cm-chip.risk-high{background:rgba(224,92,92,.14);color:var(--red,#e05c5c);border-color:transparent}
/* easiest wins */
.cm-wins{margin:var(--s-5) 0 var(--s-6)}
.cm-wins-head{display:flex;align-items:center;gap:.5rem;font-size:.82rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2);margin-bottom:var(--s-3)}
.cm-wins-head .n{font-weight:600;color:var(--text-3);text-transform:none;letter-spacing:0}
.cm-wins-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:var(--s-3)}
.cm-win{display:block;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);padding:.7rem .8rem;text-decoration:none;color:inherit;transition:border-color var(--t),background var(--t)}
.cm-win:hover{border-color:var(--border-2);background:var(--glass-2)}
.cm-win-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.35rem}
.cm-win-num{font-family:var(--mono);font-size:.72rem;color:var(--text-3);font-weight:600}
.cm-win-title{font-weight:600;font-size:.88rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:.4rem}
.cm-win-meta{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.cm-tag{display:inline-flex;align-items:center;padding:.12rem .45rem;border-radius:var(--r-pill,999px);font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.cm-tag.decline{background:var(--glass-2);color:var(--text-3)}
.cm-tag.quick{background:var(--accent-soft);color:var(--accent)}
.cm-tag.easy{background:var(--green-soft,rgba(80,200,120,.15));color:var(--green,#50c878)}
.cm-wins-empty{font-size:.82rem;color:var(--text-3);font-style:italic}
.cm-pager{display:flex;justify-content:space-between;align-items:center;margin-top:var(--s-4);font-size:.82rem;color:var(--text-3)}
.cm-pager a{color:var(--accent);text-decoration:none;padding:.3rem .6rem;border:1px solid var(--border);border-radius:var(--r-sm)}
.cm-pager a.disabled{opacity:.4;pointer-events:none}
.cm-empty{padding:var(--s-8);text-align:center;color:var(--text-3)}
/* detail */
.cm-back{display:inline-flex;align-items:center;gap:.35rem;color:var(--text-3);text-decoration:none;font-size:.82rem;margin:var(--s-5) 0 var(--s-3)}
.cm-back:hover{color:var(--text-2)}
.cm-dhead{display:flex;flex-wrap:wrap;align-items:center;gap:.65rem;margin-bottom:.4rem}
.cm-dhead h1{font-size:clamp(1.3rem,3vw,1.7rem);font-weight:800;letter-spacing:-.02em}
.cm-dmeta{display:flex;flex-wrap:wrap;gap:1rem;color:var(--text-3);font-size:.82rem;margin-bottom:var(--s-5)}
.cm-dmeta a{color:var(--accent);text-decoration:none}
.cm-card{border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);padding:var(--s-5);margin-bottom:var(--s-4)}
.cm-card h2{font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);margin-bottom:var(--s-3);display:flex;align-items:center;gap:.4rem}
.cm-desc{white-space:pre-wrap;line-height:1.6;color:var(--text-2);font-size:.92rem}
.cm-msgs{display:flex;flex-direction:column;gap:var(--s-3)}
.cm-msg{border-left:2px solid var(--border-2);padding:.3rem 0 .3rem .75rem}
.cm-msg .a{font-weight:600;font-size:.82rem;color:var(--text-2)}
.cm-msg .t{font-size:.8rem;color:var(--text-3);margin-left:.4rem}
.cm-msg .c{white-space:pre-wrap;font-size:.9rem;color:var(--text-2);margin-top:.2rem;line-height:1.5}
.cm-imgs{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.5rem}
.cm-imgs a img{height:90px;border-radius:var(--r-sm);border:1px solid var(--border)}
.cm-assess-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:var(--s-3);margin:var(--s-3) 0}
.cm-as{border:1px solid var(--border);border-radius:var(--r-md);padding:.55rem .7rem;background:var(--glass-1)}
.cm-as .l{font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:700}
.cm-as .v{font-size:1.05rem;font-weight:700;margin-top:.15rem;text-transform:capitalize}
.cm-files{list-style:none;padding:0;margin:.3rem 0 0;display:flex;flex-direction:column;gap:.2rem}
.cm-files li{font-family:var(--mono);font-size:.8rem;color:var(--text-2);background:var(--glass-2);padding:.25rem .5rem;border-radius:var(--r-sm)}
.cm-steps{margin:.3rem 0 0;padding-left:1.3rem;display:flex;flex-direction:column;gap:.35rem}
.cm-steps li{line-height:1.55;color:var(--text-2);font-size:.9rem}
.cm-launch{display:inline-flex;align-items:center;gap:.45rem;padding:.6rem 1.1rem;border-radius:var(--r-md);border:none;background:var(--accent);color:var(--on-accent);font-weight:700;font-size:.9rem;cursor:pointer;transition:opacity var(--t)}
.cm-launch:hover{opacity:.9}
.cm-launch:disabled{opacity:.5;cursor:default}
.cm-launch-note{font-size:.78rem;color:var(--text-3);margin-top:.5rem}
.cm-launch-result{margin-top:.6rem;font-size:.86rem}
.cm-launch-result a{color:var(--accent)}
.cm-retriage{display:inline-flex;align-items:center;gap:.45rem;padding:.6rem 1.1rem;border-radius:var(--r-md);border:1px solid var(--border);background:var(--glass-2);color:var(--text-2);font-weight:600;font-size:.9rem;cursor:pointer;transition:opacity var(--t);margin-left:.5rem}
.cm-retriage:hover{opacity:.85}
.cm-retriage:disabled{opacity:.5;cursor:default}
.cm-pending{color:var(--text-3);font-size:.88rem;font-style:italic}
.cm-err{color:var(--red,#e05c5c);font-size:.85rem}
/* triage meta: tags, already-fixed badge, status timeline */
.cm-tagrow{display:flex;flex-wrap:wrap;gap:.35rem;margin:.2rem 0}
.cm-ttag{display:inline-flex;align-items:center;padding:.18rem .55rem;border-radius:var(--r-pill,999px);font-size:.72rem;font-weight:700;letter-spacing:.02em;background:var(--accent-soft);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent)}
.cm-fixed{display:inline-flex;align-items:center;gap:.35rem;padding:.3rem .6rem;border-radius:var(--r-sm);font-size:.8rem;font-weight:700;background:var(--green-soft,rgba(80,200,120,.15));color:var(--green,#50c878);margin-bottom:.5rem}
.cm-timeline{list-style:none;padding:0;margin:.3rem 0 0;display:flex;flex-direction:column;gap:.4rem}
.cm-timeline li{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-size:.82rem;border-left:2px solid var(--border-2);padding:.15rem 0 .15rem .7rem}
.cm-tl-status{font-weight:700;color:var(--text-2);text-transform:capitalize}
.cm-tl-src{font-size:.68rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);background:var(--glass-2);padding:.1rem .4rem;border-radius:var(--r-sm)}
.cm-tl-time{color:var(--text-3);font-size:.78rem}
.cm-tl-note{flex-basis:100%;color:var(--text-3);font-size:.8rem;margin-top:.1rem}
/* close-ticket form */
.cm-close-form{display:flex;flex-direction:column;gap:.5rem;margin-top:.3rem}
.cm-close-form textarea{width:100%;min-height:74px;resize:vertical;padding:.6rem .7rem;border-radius:var(--r-md);border:1px solid var(--border);background:var(--glass-1);color:var(--text);font:inherit;font-size:.9rem}
.cm-close-btn{align-self:flex-start;display:inline-flex;align-items:center;gap:.45rem;padding:.55rem 1rem;border-radius:var(--r-md);border:1px solid var(--border);background:var(--glass-2);color:var(--text);font-weight:700;font-size:.88rem;cursor:pointer;transition:opacity var(--t)}
.cm-close-btn:hover{opacity:.85}
.cm-close-btn:disabled{opacity:.5;cursor:default}
/* Public support receipt. This is intentionally one visual system: the
   capability page is a customer document, not a staff dashboard with pieces
   removed. */
.cm-receipt{max-width:760px;margin:0 auto;padding:var(--s-4) 0 var(--s-8)}
.cm-receipt-back{display:inline-flex;align-items:center;gap:.4rem;color:var(--text-3);text-decoration:none;font-size:.82rem;margin:var(--s-3) 0 var(--s-5)}
.cm-receipt-back:hover{color:var(--text-2)}
.cm-receipt-hero{border:1px solid var(--border);border-top:3px solid var(--accent);border-radius:2px;background:var(--surface);padding:clamp(1.25rem,4vw,2.25rem);margin-bottom:var(--s-4)}
.cm-receipt-kicker{font-size:.72rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:.7rem}
.cm-receipt-title{font-size:clamp(1.55rem,4vw,2.25rem);line-height:1.1;letter-spacing:-.035em;font-weight:800;color:var(--text);margin:0}
.cm-receipt-status{display:flex;align-items:center;gap:.55rem;margin-top:1rem;color:var(--text-2);font-size:.95rem}
.cm-receipt-status .cm-badge{font-size:.68rem}
.cm-receipt-intro{margin:1rem 0 0;color:var(--text-2);font-size:.98rem;line-height:1.6;max-width:58ch}
.cm-receipt-meta{display:flex;flex-wrap:wrap;gap:.45rem 1rem;margin-top:1.2rem;color:var(--text-3);font-size:.78rem}
.cm-receipt-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(220px,.75fr);gap:var(--s-4)}
.cm-receipt-panel{border:1px solid var(--border);border-radius:2px;background:var(--surface);padding:clamp(1rem,3vw,1.35rem);margin-bottom:var(--s-4)}
.cm-receipt-panel h2{font-size:.76rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);margin:0 0 .8rem}
.cm-receipt-copy{white-space:pre-wrap;color:var(--text-2);font-size:.94rem;line-height:1.65}
.cm-receipt-actions{list-style:none;padding:0;margin:.9rem 0 0;display:flex;flex-direction:column;gap:.6rem}
.cm-receipt-actions li{display:flex;gap:.55rem;color:var(--text-2);font-size:.9rem;line-height:1.5}
.cm-receipt-actions li::before{content:"✓";display:inline-flex;align-items:center;justify-content:center;flex:0 0 1.25rem;height:1.25rem;border-radius:50%;background:var(--green-soft,rgba(80,200,120,.15));color:var(--green,#50c878);font-weight:800;font-size:.72rem;margin-top:.1rem}
.cm-receipt-followup{border-left:3px solid var(--accent);padding:.1rem 0 .1rem .8rem;color:var(--text-2);font-size:.9rem;line-height:1.55}
.cm-receipt-context{border:1px solid color-mix(in srgb,var(--accent) 32%,var(--border));border-radius:2px;background:var(--accent-soft);padding:1rem 1.1rem;margin-bottom:var(--s-4)}
.cm-receipt-context h2{font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 .45rem}
.cm-receipt-context p{color:var(--text-2);font-size:.9rem;line-height:1.55;margin:0}
.cm-receipt-context ul{margin:.65rem 0 0;padding-left:1.15rem;color:var(--text-2);font-size:.88rem;line-height:1.55}
.cm-receipt-context li+li{margin-top:.35rem}
.cm-receipt-work{margin-bottom:var(--s-4)}
.cm-receipt-work h2{font-size:.76rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);margin:0 0 .65rem}
.cm-receipt-timeline{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:0}
.cm-receipt-event{position:relative;display:grid;grid-template-columns:1rem minmax(0,1fr);gap:.7rem;align-items:start;padding:0 0 1rem}
.cm-receipt-event:last-child{padding-bottom:0}
.cm-receipt-event::before{content:"";width:.55rem;height:.55rem;border-radius:50%;background:var(--accent);margin-top:.28rem;box-shadow:0 0 0 4px var(--accent-soft)}
.cm-receipt-event:not(:last-child)::after{content:"";position:absolute;left:.24rem;top:.9rem;bottom:.15rem;width:1px;background:var(--border-2)}
.cm-receipt-event-main{min-width:0}
.cm-receipt-event-head{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;min-width:0}
.cm-receipt-event .label{font-weight:700;color:var(--text-2);font-size:.88rem}
.cm-receipt-event .date{color:var(--text-3);font-size:.75rem;white-space:nowrap;flex:0 0 auto}
.cm-receipt-event .detail{color:var(--text-3);font-size:.82rem;line-height:1.5;margin-top:.25rem;white-space:pre-wrap}
.cm-receipt-muted{color:var(--text-3);font-size:.86rem;line-height:1.55}
.cm-receipt-toolbar{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}
.cm-receipt-toolbar button{border:1px solid var(--border);border-radius:2px;background:var(--surface);color:var(--text-2);padding:.5rem .8rem;font:inherit;font-size:.8rem;cursor:pointer}
.cm-receipt-toolbar button:hover{border-color:var(--accent)}
.cm-receipt-toolbar button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cm-receipt .cm-badge,.cm-receipt .cm-gh-link{border-radius:2px}
.cm-receipt details summary{cursor:pointer;color:var(--text-2);font-size:.85rem}
@media print{.cm-receipt-toolbar,.cm-receipt-back{display:none}.cm-receipt{max-width:none}.cm-receipt-panel,.cm-receipt-hero{break-inside:avoid}.cm-receipt-grid{display:block}}
.cm-receipt-footer{color:var(--text-3);font-size:.78rem;line-height:1.5;padding:0 .2rem}
.cm-receipt-footer a{color:var(--accent);text-decoration:none}
.cm-head{padding:8px 0 20px;border-bottom:1px solid var(--border)}
.cm-head .cm-kicker{display:block;margin-bottom:8px;color:var(--accent);font:700 .66rem var(--mono);letter-spacing:.13em;text-transform:uppercase}
.cm-head h1{font-size:clamp(1.8rem,3vw,2.35rem);font-weight:780;letter-spacing:-.05em;gap:10px}
.cm-head h1 .icon{color:var(--accent)}
.cm-head p{color:var(--text-2);font-size:.88rem;margin-top:6px}
.cm-list-summary{margin:22px 0 9px;align-items:baseline}
.cm-list-summary strong{font-size:1.38rem;letter-spacing:-.045em}
.cm-tabs{gap:18px;flex-wrap:nowrap;overflow-x:auto;margin:0 0 18px;border-bottom:1px solid var(--border)}
.cm-tab{padding:12px 1px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--text-3);font-size:.77rem}
.cm-tab:hover{border-color:transparent;color:var(--text)}
.cm-tab.on{border:0;border-bottom:2px solid var(--accent);background:transparent;color:var(--text)}
.cm-list{border-radius:10px}
.cm-row{grid-template-columns:72px minmax(0,1fr) auto;padding:15px 20px}
.cm-title{font-size:.91rem;font-weight:680}
@media (max-width:680px){.cm-receipt-grid{grid-template-columns:1fr}.cm-receipt-event-head{display:block}.cm-receipt-event .date{display:block;white-space:normal;margin-top:.18rem}.cm-receipt-event .detail{margin-top:.35rem}.cm-head{padding:var(--s-4) 0}.cm-tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin;padding-bottom:.4rem;margin:var(--s-3) 0}.cm-tab{white-space:nowrap;min-height:40px;display:inline-flex;align-items:center}.cm-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"num right" "main main";gap:.4rem;padding:var(--s-4)}.cm-num{grid-area:num}.cm-main{grid-area:main}.cm-right{grid-area:right;flex-wrap:wrap;justify-content:flex-end}.cm-title{white-space:normal;overflow-wrap:anywhere}.cm-list-summary{align-items:baseline}}
`;

function statusBadge(status, label = null) {
  const s = status || "open";
  return `<span class="cm-badge b-${esc(s)}">${esc(label || s.replace(/_/g, " "))}</span>`;
}

// Triage-state badge for list rows. `assess` is { complexity, risk } (or null).
// Renders a green "Triaged" badge with complexity·risk chips when an assessment
// exists, else a muted "Awaiting triage" badge.
function triageBadge(assess) {
  if (!assess) {
    return `<span class="cm-triage awaiting">${icon("clock", { size: 12 })} Awaiting triage</span>`;
  }
  const complexity = assess.complexity || "—";
  const risk = assess.risk || "—";
  return `<span class="cm-triage has">${icon("check", { size: 12 })} Triaged</span>` +
    `<span class="cm-chips"><span class="cm-chip">${esc(complexity)}</span><span class="cm-chip risk-${esc(risk)}">${esc(risk)}</span></span>`;
}

// ── List page ──────────────────────────────────────────────────────────
// `tokens` maps ticketNumber -> opaque /t/ token. Rows link to the token URL
// when one is known: there is exactly one page per ticket, and it is the
// scrambled one. Numbers without a token yet (never swept) keep the numeric
// staff link, which redirects once the token exists.
function makeTicketsListBody({ tickets, page, totalPages, status, total, tokens = null }) {
  const statuses = ["all", "open", "triaging", "assessed", "in_progress", "resolved", "closed", "wont_fix"];
  const cur = status || "all";
  const tabs = statuses
    .map((s) => `<a class="cm-tab ${s === cur ? "on" : ""}" href="/tickets${s === "all" ? "" : "?status=" + s}">${esc(s.replace(/_/g, " "))}</a>`)
    .join("");

  const rows = tickets.length
    ? tickets
        .map((t) => {
          const reporter = t.reporter ? t.reporter.characterName || t.reporter.username : "anon";
          const token = tokens && tokens[String(t.ticketNumber)];
          return `<a class="cm-row" href="${token ? `/t/${esc(token)}` : `/tickets/${esc(t.ticketNumber)}`}">

            <span class="cm-num">#${esc(t.ticketNumber)}</span>
            <span class="cm-main">
              <div class="cm-title">${esc(t.title || "(untitled)")}</div>
              <div class="cm-sub">${t.category ? `<span>${esc(t.category)}</span>` : ""}<span>${esc(reporter)}</span><span>${esc(fmtDate(t.createdAt))}</span></div>
            </span>
            <span class="cm-right">${triageBadge(t.triage)}${statusBadge(t.status)}</span>
          </a>`;
        })
        .join("")
    : `<div class="cm-empty">No tickets${cur !== "all" ? " with status “" + esc(cur) + "”" : ""} yet.</div>`;

  const qp = cur === "all" ? "" : `&status=${cur}`;
  const pager = `<div class="cm-pager">
    <span>${total} ticket${total === 1 ? "" : "s"}${totalPages > 1 ? ` · page ${page}/${totalPages}` : ""}</span>
    <span>
      <a class="${page <= 1 ? "disabled" : ""}" href="/tickets?page=${page - 1}${qp}">← Prev</a>
      <a class="${page >= totalPages ? "disabled" : ""}" href="/tickets?page=${page + 1}${qp}">Next →</a>
    </span>
  </div>`;

  return {
    extraCss: COMMUNITY_CSS,
    body: `<div class="cm-head"><span class="cm-kicker">Operate / Support</span><h1>${icon("life-buoy", { size: 22 })} Support queue</h1><p>Community reports and delivery receipts, from intake to resolution.</p></div>
      <div class="cm-list-summary"><span><strong>${esc(total)}</strong> ${cur === "all" ? "tickets" : esc(cur.replace(/_/g, " ")) + " tickets"}</span><a href="/tickets/report">Analytics report →</a></div>
      <nav class="cm-tabs" aria-label="Ticket status">${tabs}</nav>
      <div class="cm-list">${rows}</div>
      ${pager}`,
  };
}

// ── Detail page ────────────────────────────────────────────────────────
function renderAssessmentCard(assessment) {
  if (!assessment) {
    return `<div class="cm-card"><h2>${icon("sparkles", { size: 14 })} Assessment</h2><p class="cm-pending">No assessment yet — the triage worker will pick this up shortly.</p></div>`;
  }
  if (assessment.status === "error") {
    return `<div class="cm-card"><h2>${icon("sparkles", { size: 14 })} Assessment</h2><p class="cm-err">Triage failed: ${esc(assessment.error || "unknown error")}. It will be retried automatically.</p></div>`;
  }
  const files = (assessment.affectedFiles || []).length
    ? `<ul class="cm-files">${assessment.affectedFiles.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
    : `<p class="cm-pending">No specific files identified.</p>`;
  return `<div class="cm-card"><h2>${icon("sparkles", { size: 14 })} Assessment <span style="font-weight:500;text-transform:none;letter-spacing:0;color:var(--text-3)">· ${esc(assessment.model || "")}</span></h2>
    <p class="cm-desc">${esc(assessment.summary || "")}</p>
    <div class="cm-assess-grid">
      <div class="cm-as"><div class="l">Complexity</div><div class="v">${esc(assessment.complexity || "—")}</div></div>
      <div class="cm-as"><div class="l">Risk</div><div class="v">${esc(assessment.risk || "—")}</div></div>
      <div class="cm-as"><div class="l">Confidence</div><div class="v">${assessment.confidence != null ? Math.round(assessment.confidence * 100) + "%" : "—"}</div></div>
    </div>
    <h2 style="margin-top:var(--s-4)">${icon("folder", { size: 13 })} Likely areas</h2>${files}
    ${assessment.recommendation ? `<h2 style="margin-top:var(--s-4)">${icon("compass", { size: 13 })} Recommendation</h2><p class="cm-desc">${esc(assessment.recommendation)}</p>` : ""}
    ${(assessment.nextSteps || []).length ? `<h2 style="margin-top:var(--s-4)">${icon("clipboard", { size: 13 })} Recommended next steps</h2><ol class="cm-steps">${assessment.nextSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
  </div>`;
}

// GitHub triage card: what the box's ticket-file decided for this ticket, what
// it filed, and which issues/PRs it judged related — with the confidence behind
// each link, because a 0.6 match and a 0.95 match do not mean the same thing.
const TRIAGE_LABEL = {
  filed: "filed",
  "would-file": "verified",
  linked: "reported again",
  duplicate: "already open",
  "already-fixed": "fixed by a PR",
  "needs-human": "needs a human",
};

// Three link rows before the disclosure: enough to see what it matched, short
// enough that the card does not own the whole phone screen. The rest stay one
// tap away rather than being dropped.
const VISIBLE_LINKS = 3;

// Legacy tickets carry the whole support thread: the biggest ones here hold 213
// messages, some of them a couple of thousand characters. Rendering all of that
// buries the page. The first and last messages answer almost every triage
// question (what was reported, how it ended), so those stay, the middle moves
// behind one tap, and any single message is clamped to something readable.
const MAX_MSG_CHARS = 420;
const MAX_HIDDEN_MESSAGES = 40;
const MAX_MSG_IMAGES = 4;
const MAX_TOP_IMAGES = 6;

function clipText(value, max = MAX_MSG_CHARS) {
  const t = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)) + "…";
}

// Discord attachment URLs expire. The link stays (it may still resolve), but a
// dead URL shows a chip instead of a broken-image icon and a hole in the page.
function attachment(url) {
  return `<a class="cm-img" href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="attachment" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('cm-img-dead')"></a>`;
}

function messageBlock(m) {
  const text = clipText(m && m.content);
  const images = ((m && m.imageUrls) || []).slice(0, MAX_MSG_IMAGES);
  if (!text && !images.length) return "";
  return `<div class="cm-msg"><span class="a">${esc((m && m.authorName) || "user")}</span><span class="t">${esc(fmtDate(m && m.createdAt))}</span>${text ? `<div class="c">${esc(text)}</div>` : ""}${images.length ? `<div class="cm-imgs">${images.map(attachment).join("")}</div>` : ""}</div>`;
}

function githubArtifactUrl(item, kind = "issue") {
  const supplied = String(item && item.url || "").trim();
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+(?:[/?#].*)?$/i.test(supplied)) return supplied;
  const repo = String(item && item.repo || "").trim();
  const number = Number(item && item.number);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isInteger(number) || number < 1) return "";
  return `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

function githubArtifactState(item, artifacts, kind) {
  const pool = kind === "pr" ? (artifacts && artifacts.prs) || [] : (artifacts && artifacts.issues) || [];
  const live = pool.find((entry) => Number(entry.number) === Number(item && item.number));
  if (!live) return String(item && (item.state || item.status) || "").toLowerCase();
  if (kind === "pr" && (live.mergedAt || live.state === "MERGED")) return "merged";
  return String(live.state || "").toLowerCase();
}

function renderPublicWorkLinks(github) {
  if (!github || github.publicRepo !== true || !github.latest) return "";
  const l = github.latest;
  const items = [
    ...(l.issuesFiled || []).map((item) => ({ ...item, kind: "issue", label: "Issue" })),
    ...(l.relatedPrs || []).map((item) => ({ ...item, kind: "pr", label: "Fix PR" })),
    ...(l.relatedIssues || []).map((item) => ({ ...item, kind: "issue", label: "Related issue" })),
  ];
  const seen = new Set();
  const rows = items
    .filter((item) => {
      const key = `${item.kind}:${item.repo || ""}:${item.number}`;
      if (!item || !item.number || seen.has(key) || !githubArtifactUrl(item, item.kind)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, VISIBLE_LINKS)
    .map((item) => {
      const href = githubArtifactUrl(item, item.kind);
      const state = githubArtifactState(item, github.artifacts, item.kind);
      const title = item.title || (item.kind === "pr" ? "Code fix" : "Filed report");
      return `<a class="cm-gh-link" href="${esc(href)}" target="_blank" rel="noopener">
        <span class="k">${esc(item.label)} #${esc(item.number)}</span><span class="t">${esc(title)}</span>${state ? `<span class="c">${esc(state)}</span>` : ""}
      </a>`;
    })
    .join("");
  return rows ? `<section class="cm-receipt-work"><h2>Related public work</h2><div class="cm-gh-links">${rows}</div></section>` : "";
}

function renderContextBanner(ticket) {
  const request = contextRequestForDisplay(ticket);
  if (!request || !request.needed || !request.needed.length) return "";
  const lines = request.needed.map((kind) => PLAYER_COPY[kind]).filter(Boolean);
  if (!lines.length) return "";
  return `<aside class="cm-receipt-context" aria-label="More information requested">
    <h2>Help us identify this report</h2>
    <p>We may need one more detail to match your report to the right game records.</p>
    <ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
  </aside>`;
}

function renderGitHubCard(github, ticketNumber, ticket = null) {
  const terminal = isTerminalStatus(ticket && ticket.status);
  const heading = terminal ? `GitHub triage <span class="cm-muted">(historical)</span>` : "GitHub triage";
  if (!github || !github.latest) {
    // Without this the card simply vanishes on every ticket the box has not
    // looked at, which reads as "the feature does not exist".
    return `<div class="cm-card"><h2>${icon("git-branch", { size: 14 })} ${heading}</h2>
      <p class="cm-muted" style="font-size:.85rem">${terminal ? `The ticket is ${esc(publicStatusLabel(ticket.status))}; no current GitHub triage is required.` : `Not reassessed yet. Run <code>/reassess ${esc(String(ticketNumber ?? ""))}</code> in Discord, or wait for the next sweep.`}</p></div>`;
  }
  const l = github.latest;
  const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) + "%");
  const openable = github.publicRepo === true;
  const filed = openable ? (l.issuesFiled || []) : [];
  const related = openable
    ? [
        ...(l.relatedIssues || []).map((item) => ({ ...item, __kind: "issue" })),
        ...(l.relatedPrs || []).map((item) => ({ ...item, __kind: "pr" })),
      ]
    : [];

  // One repo on every row means the repo name is repeated noise on a phone, and
  // it is what pushes the titles into ellipsis. Name it once only when the rows
  // actually span more than one.
  const repos = new Set([...filed, ...related].map((r) => r.repo));
  const showRepo = repos.size > 1;
  const row = (repo, number, title, confidence, note, kind = "issue") => `<a class="cm-gh-link" href="${esc(githubArtifactUrl({ repo, number }, kind))}" target="_blank" rel="noopener">
      <span class="k">${esc(showRepo ? `${String(repo).split("/").pop()}#${number}` : `#${number}`)}</span>
      <span class="t">${esc(title || "")}</span>
      ${pct(confidence) || note ? `<span class="c">${esc([pct(confidence), note].filter(Boolean).join(" · "))}</span>` : ""}
    </a>`;

  const visibleFiled = filed.slice(0, VISIBLE_LINKS);
  const room = Math.max(0, VISIBLE_LINKS - visibleFiled.length);
  const visibleRelated = related.slice(0, room);
  const hidden = [...filed.slice(VISIBLE_LINKS), ...related.slice(room)];

  const status = terminal ? "historical" : TRIAGE_LABEL[l.outcome] || l.outcome || "assessed";
  // The repo confidence lives in the signal list; repeating it in the tile only
  // wrapped the value onto a second line.
  const tiles = [
    ["Classification", [l.type, l.severity].filter(Boolean).join(" · ") || "unknown"],
    ["Repository", String(l.repo || "?").split("/").pop()],
  ];
  const signals = [
    ["type", l.type, null],
    ["severity", l.severity, null],
    ["repo", l.repo ? String(l.repo).split("/").pop() : null, l.repoConfidence],
    ["actionable", l.actionable ? String(l.actionable.value) : null, l.actionable ? l.actionable.probability : null],
    ["staff action", l.staffAction ? String(l.staffAction.value) : null, l.staffAction ? l.staffAction.probability : null],
    ["sensitive", l.sensitive ? String(l.sensitive.value) : null, l.sensitive ? l.sensitive.probability : null],
  ].filter(([, v]) => v != null);
  const runs = (github.history || []).length;

  return `<div class="cm-card"><h2>${icon("git-branch", { size: 14 })} ${heading} <span class="cm-badge">${esc(status)}</span></h2>
    ${terminal ? `<p class="cm-launch-note">Ticket is ${esc(publicStatusLabel(ticket.status))}. This assessment is retained for audit only.</p>` : stageBar(stageFor(github.artifacts, l))}
    ${!terminal && l.why ? `<p class="cm-desc">Referred to a human: ${esc(l.why)}</p>` : ""}
    <div class="cm-assess-grid">${tiles.map(([k, v]) => `<div class="cm-as"><div class="l">${esc(k)}</div><div class="v">${esc(String(v))}</div></div>`).join("")}</div>
    ${visibleFiled.length || visibleRelated.length
      ? `<div class="cm-gh-links">${visibleFiled.map((i) => row(i.repo, i.number, i.title, null, i.status === "filed" ? "filed" : i.status, "issue")).join("")}${visibleRelated.map((r) => row(r.repo, r.number, r.title, r.confidence, r.merged ? "merged" : r.state ? String(r.state).toLowerCase() : null, r.__kind)).join("")}</div>`
      : `<p class="cm-muted" style="font-size:.82rem">Nothing filed, and no related issues or pull requests found.</p>`}
    <details class="cm-gh-more"><summary>Classifier detail${hidden.length ? `, ${hidden.length} more link${hidden.length === 1 ? "" : "s"}` : ""}</summary>
      <div class="cm-gh-sig">${signals.map(([k, v, c]) => `<span>${esc(k)} <b>${esc(String(v))}</b>${pct(c) ? ` <span class="cm-conf">${pct(c)}</span>` : ""}</span>`).join("")}</div>
      ${hidden.length ? `<div class="cm-gh-links">${hidden.map((r) => row(r.repo, r.number, r.title, r.confidence, r.merged ? "merged" : r.state ? String(r.state).toLowerCase() : null, r.__kind)).join("")}</div>` : ""}
      <p class="cm-muted" style="font-size:.78rem">${l.draftedBy ? `drafted by ${esc(l.draftedBy)} · ` : ""}${l.model ? `classified by ${esc(l.model)} · ` : ""}${runs} run${runs === 1 ? "" : "s"}${l.at ? `, last ${esc(relTime(l.at))}` : ""}</p>
    </details>
  </div>`;
}

// One report, one page. These sections are the same for everybody; the staff
// blocks below them appear only when a staff session is looking. Previously
// this was two pages that drifted apart, which is how a reporter's page ends up
// saying something the staff page contradicts.
//
// Player words for each filer outcome live here, once. The Discord announce
// embed in server.js reads the same map, so the channel message, the public
// page and the staff page cannot describe one outcome three different ways.
// The internal reason ("not actionable", "repo classification not decisive")
// stays staff-only: a player reading "not actionable" about their own report
// reads as a dismissal, and it is our vocabulary, not theirs.
const OUTCOME_STATUS_TEXT = {
  filed: "Logged as a tracked issue",
  linked: "Added to an existing report",
  duplicate: "Already being tracked",
  "already-fixed": "This looks fixed already — reopen if it still happens",
  "needs-human": "With the team for review",
  "would-file": "Being looked at",
};
// Backwards-compatible alias; prefer OUTCOME_STATUS_TEXT for new code.
const PUBLIC_STATUS_TEXT = OUTCOME_STATUS_TEXT;

function renderReportSummary({ ticket, github, viewer = "staff" }) {
  const isStaff = viewer !== "public";
  const terminal = isTerminalStatus(ticket && ticket.status);
  const l = (github && github.latest) || null;
  const artifacts = (github && github.artifacts) || {};
  const openable = (github && github.publicRepo === true) || isStaff;
  const status = terminal ? publicStatusLabel(ticket.status) : l ? (isStaff ? (TRIAGE_LABEL[l.outcome] || l.outcome || "assessed") : (OUTCOME_STATUS_TEXT[l.outcome] || "Being looked at")) : "Received";

  const artifactOf = (number, kind) => {
    const pool = kind === "pr" ? artifacts.prs || [] : artifacts.issues || [];
    return pool.find((x) => Number(x.number) === Number(number)) || null;
  };
  const stateOf = (number, kind) => {
    const hit = artifactOf(number, kind);
    if (!hit) return null;
    if (kind === "pr") return hit.mergedAt || hit.state === "MERGED" ? "merged" : String(hit.state || "").toLowerCase();
    return String(hit.state || "").toLowerCase();
  };

  const entries = openable ? [
    ...((l && l.issuesFiled) || []).map((i) => ({ ...i, kind: "issue", state: stateOf(i.number, "issue") })),
    ...((l && l.relatedPrs) || []).map((x) => ({ ...x, kind: "pr", state: stateOf(x.number, "pr") })),
    ...((l && l.relatedIssues) || []).map((i) => ({ ...i, kind: "issue", state: stateOf(i.number, "issue"), related: true })),
  ].filter((e) => e && e.number) : [];

  const seen = new Set();
  const unique = entries.filter((e) => { const key = `${e.kind}-${e.number}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const shown = unique.slice(0, 5);
  const more = unique.length - shown.length;

  const rows = shown.map((e) => `<a class="cm-gh-link" href="${esc(githubArtifactUrl(e, e.kind))}" target="_blank" rel="noopener">
      <span class="k">#${esc(String(e.number))}</span>
      <span class="t">${esc(String(e.title || (artifactOf(e.number, e.kind) || {}).title || (e.kind === "pr" ? "pull request" : "issue")))}</span>
      <span class="c">${[e.state, e.related ? "same problem" : null, isStaff && e.confidence != null ? `${Math.round(Number(e.confidence) * 100)}%` : null].filter(Boolean).join(" · ")}</span>
    </a>`).join("");

  const relatedCount = ((l && l.relatedIssues) || []).length;

  return `<div class="cm-card"><h2>${icon("check", { size: 14 })} ${esc(status)}</h2>
    ${terminal ? terminalStageBar(ticket) : stageBar(stageFor(artifacts, l))}
    ${!terminal && l && l.why && isStaff ? `<p class="cm-desc">Referred to a human: ${esc(l.why)}</p>` : ""}
    ${rows ? `<div class="cm-gh-links">${rows}</div>` : ""}
    ${more > 0 ? `<p class="cm-muted" style="font-size:.8rem">${more} more linked item${more === 1 ? "" : "s"}</p>` : ""}
    ${relatedCount ? `<p class="cm-muted" style="font-size:.8rem">${relatedCount} other report${relatedCount === 1 ? "" : "s"} of this.</p>` : ""}
  </div>`;
}

function renderTimeline({ ticket, github }) {
  const l = (github && github.latest) || null;
  const artifacts = (github && github.artifacts) || {};
  const resolution = getResolution(ticket);
  const rows = [
    ticket.createdAt ? ["Reported", ticket.createdAt] : null,
    l && l.at ? ["Assessed", l.at] : null,
    l && l.issuesFiled && l.issuesFiled.length ? ["Filed", l.at] : null,
    artifacts.refreshedAt ? ["Last triage check", artifacts.refreshedAt] : null,
    isTerminalStatus(ticket.status) ? [publicStatusLabel(ticket.status), (resolution && resolution.resolvedAt) || ticket.closedAt || ticket.updatedAt] : null,
  ].filter(Boolean).map(([k, v]) => `<div class="cm-tl-row"><span class="cm-tl-k">${esc(k)}</span><span>${esc(fmtDate(new Date(v).toISOString()))}</span></div>`).join("");
  return rows ? `<div class="cm-card"><h2>${icon("clock", { size: 14 })} Timeline</h2><div class="cm-tl">${rows}</div></div>` : "";
}

// Merged tracker card. One function, two viewers: reporters see that their
// report is tracked, what stage it is at and why it is stuck. Never ids,
// numbers, or internal notes. Staff see the linked tracker item itself with a
// way into the board. `tracked` is the raw tracker_items document or null.
function renderTrackedWork(tracked, viewer = "staff", ticket = null) {
  if (!tracked || isTerminalStatus(ticket && ticket.status)) return "";
  const isStaff = viewer !== "public";
  const status = esc(String(tracked.status || "open").replace(/_/g, " "));
  if (!isStaff) {
    const blocked =
      tracked.status === "blocked" && tracked.blocked_by
        ? `<div class="cm-tl-note">${esc(tracked.blocked_by)}</div>`
        : "";
    const updated =
      tracked.updated_at || tracked.updatedAt
        ? `<div class="cm-launch-note">Last update ${esc(fmtDate(new Date(tracked.updated_at || tracked.updatedAt).toISOString()))}.</div>`
        : "";
    return `<div class="cm-card"><h2>${icon("check", { size: 14 })} Tracked work</h2>
      <div class="cm-stage-now">${status}</div>${blocked}${updated}</div>`;
  }
  const meta = [];
  if (tracked.project) meta.push(esc(tracked.project));
  if (tracked.realm) meta.push(esc(tracked.realm));
  if (tracked.phase) meta.push(esc(tracked.phase));
  return `<div class="cm-card"><h2>${icon("check", { size: 14 })} Tracked work</h2>
    <div class="cm-desc"><b>${status}</b>${tracked.blocked_by ? `: ${esc(tracked.blocked_by)}` : ""}</div>
    ${meta.length ? `<div class="cm-gh-sig">${meta.map((m) => `<span>${m}</span>`).join("")}</div>` : ""}
    <div class="cm-launch-note">Tracker item <code>${esc(tracked.id || "")}</code>${
      tracked.updated_by ? ` · last touched by ${esc(tracked.updated_by)}` : ""
    } · <a href="/tracker">Open the board</a>. Linked from this report via the support MCP.</div></div>`;
}

function renderPublicReceiptBody({ ticket, github }) {
  const t = ticket || {};
  const terminal = isTerminalStatus(t.status);
  const receipt = getResolution(t);
  const receiptReady = terminal && !!receipt;
  const thread = (t.messages || []).filter((m) => String(m && m.content || "").trim());
  const reported = String(t.description || (thread[0] && thread[0].content) || "").trim();
  const timeline = publicTimeline(t);
  const timelineHtml = timeline.length
    ? `<ol class="cm-receipt-timeline">${timeline.map((event) => `<li class="cm-receipt-event">
        <div class="cm-receipt-event-main"><div class="cm-receipt-event-head"><div class="label">${esc(event.label)}</div><time class="date" datetime="${esc(event.at.toISOString())}">${esc(fmtDate(event.at))}</time></div>
        ${event.detail ? `<div class="detail">${esc(event.detail)}</div>` : ""}</div>
      </li>`).join("")}</ol>`
    : `<p class="cm-receipt-muted">Your report has been recorded.</p>`;

  const actions = receipt && receipt.actions && receipt.actions.length
    ? `<ul class="cm-receipt-actions">${receipt.actions.map((action) => `<li><span>${esc(action.label)}${action.detail ? ` <span class="cm-receipt-muted">${esc(action.detail)}</span>` : ""}</span></li>`).join("")}</ul>`
    : "";
  const reportedPanel = `<section class="cm-receipt-panel"><h2>What you reported</h2><div class="cm-receipt-copy">${esc(clipText(reported || "Your support report", 1400))}</div>
    ${(t.imageUrls || []).length ? `<div class="cm-imgs" style="margin-top:1rem">${t.imageUrls.slice(0, MAX_TOP_IMAGES).map(attachment).join("")}</div>` : ""}</section>`;
  const resolutionPanel = receiptReady
    ? `<section class="cm-receipt-panel"><h2>What we did</h2><div class="cm-receipt-copy">${esc(receipt.message)}</div>${actions}
        ${receipt.followUp ? `<h2 style="margin-top:1.2rem">Follow-up</h2><div class="cm-receipt-followup">${esc(receipt.followUp)}</div>` : ""}
        <p class="cm-receipt-muted" style="margin-top:1rem">${esc(resolutionSourceLabel(receipt.source))}.</p></section>`
    : terminal
      ? `<section class="cm-receipt-panel"><h2>Resolution</h2><p class="cm-receipt-copy">We recorded the outcome and are preparing the player-facing receipt details. Please check back soon.</p></section>`
    : `<section class="cm-receipt-panel"><h2>Progress</h2>
        <p class="cm-receipt-copy">${esc(publicStatusLabel(t.status || "open"))}. We will keep this receipt updated as work progresses.</p>
        ${stageBar((t.publicUpdates || []).some((update) => update.kind === "production" && !update.supersededAt) ? "fixed" : (t.publicUpdates || []).some((update) => ["development", "heal"].includes(update.kind) && !update.supersededAt) ? "in_progress" : stageFor((github && github.artifacts) || {}, (github && github.latest) || null))}
      </section>`;
  const nextPanel = receiptReady
    ? `<section class="cm-receipt-panel"><h2>Need more help?</h2><p class="cm-receipt-muted">If the issue is still present, reply in the original Discord ticket channel or open a new support ticket.</p></section>`
    : terminal
      ? `<section class="cm-receipt-panel"><h2>What happens next</h2><p class="cm-receipt-muted">This page will show the completed receipt as soon as the resolution details are recorded.</p></section>`
    : `<section class="cm-receipt-panel"><h2>What happens next</h2><p class="cm-receipt-muted">You can return to this page at any time. Progress updates appear here. We send the receipt link when your ticket opens and with the closing message.</p></section>`;

  return {
    extraCss: COMMUNITY_CSS,
    body: `<main class="cm-receipt">
      <a class="cm-receipt-back" href="https://www.ahousedividedgame.com">${icon("arrow-left", { size: 14 })} Back to the game</a>
      ${renderContextBanner(t)}
      <header class="cm-receipt-hero">
        <div class="cm-receipt-kicker">Support receipt</div>
        <h1 class="cm-receipt-title">${esc(t.title || "Your support report")}</h1>
        <div class="cm-receipt-status">${statusBadge(t.status || "open", publicStatusLabel(t.status || "open"))}<span>${esc(receiptReady ? "This report is complete." : terminal ? "The outcome is recorded." : "This report is still in progress.")}</span></div>
        <p class="cm-receipt-intro">${esc(receiptReady ? "Your report has been resolved. This page is the permanent record of what you reported, what we changed, and what to do next." : terminal ? "Your report outcome is recorded. The player-facing resolution details are being prepared for this receipt." : "Your report has been received. This page is the permanent record of the work and updates connected to it.")}</p>
        <div class="cm-receipt-meta">${t.category ? `<span>${esc(t.category)}</span>` : ""}<span>Reported ${esc(fmtDate(t.createdAt))}</span>${receiptReady ? `<span>Resolved ${esc(fmtDate(receipt.resolvedAt || t.closedAt))}</span>` : `<span>Last updated ${esc(fmtDate(t.updatedAt || t.createdAt))}</span>`}</div>
      </header>
      <nav class="cm-receipt-toolbar" aria-label="Receipt actions"><button type="button" id="receipt-copy">Copy receipt link</button><button type="button" id="receipt-refresh">Refresh status</button><button type="button" id="receipt-print">Print receipt</button><span id="receipt-action-status" role="status" aria-live="polite"></span></nav>
      ${reportedPanel}
      ${renderPublicWorkLinks(github)}
      <div class="cm-receipt-grid">${resolutionPanel}<section class="cm-receipt-panel"><h2>Timeline</h2>${timelineHtml}</section></div>
      ${nextPanel}
      <p class="cm-receipt-footer">This private receipt link does not require sign-in. Keep it if you need to refer back to this report.</p>
    </main><script>(function(){var status=document.getElementById('receipt-action-status');document.getElementById('receipt-copy').addEventListener('click',async function(){try{await navigator.clipboard.writeText(location.href);status.textContent='Receipt link copied.';}catch(e){status.textContent='Copy the link from your browser address bar.';}});document.getElementById('receipt-refresh').addEventListener('click',function(){location.reload();});document.getElementById('receipt-print').addEventListener('click',function(){window.print();});})();</script>`,
  };
}

function makeTicketDetailBody({ ticket, assessment, fixSession, github, viewer = "staff", tracked = null }) {
  const isStaff = viewer !== "public";
  const t = ticket;
  if (!isStaff && t.category === "investigation") return { extraCss: "", body: "<p>Ticket not found</p>" };
  if (!isStaff) return renderPublicReceiptBody({ ticket: t, github });
  const visits = (t.supportRecentVisits || []).slice(0, 5);
  const supportContext = visits.length ? `<div class="cm-card"><h2>Recent game context (staff only)</h2><p class="cm-muted">Unconfirmed observations from recent game visits. Confirm the affected page and platform with the reporter.</p><ul>${visits.map((visit) => {
    const path = String(visit.path || "");
    const safePath = /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(path) ? path : "";
    return `<li>${safePath ? `<a href="https://ahousedividedgame.com${esc(safePath)}" target="_blank" rel="noopener">${esc(safePath)}</a>` : "Page unavailable"} · ${esc(fmtDate(visit.recordedAt))} · ${esc(visit.platform || "unknown")}, ${esc(visit.device || "unknown")} · game ${esc(visit.gameVersion || "unknown")} · client ${esc(visit.clientVersion || "unknown")}</li>`;
  }).join("")}</ul></div>` : "";
  const r = t.reporter || {};
  const meta = [];
  meta.push(`<span>${icon("calendar", { size: 13 })} ${esc(fmtDate(t.createdAt))}</span>`);
  if (t.category) meta.push(`<span>${icon("tag", { size: 13 })} ${esc(t.category)}</span>`);
  if (r.username || r.characterName) {
    const name = esc(r.characterName || r.username);
    meta.push(r.profileUrl ? `<a href="${esc(r.profileUrl)}" target="_blank" rel="noopener">${icon("user", { size: 13 })} ${name}</a>` : `<span>${icon("user", { size: 13 })} ${name}</span>`);
  }
  if (r.corporationName) {
    const corp = esc(r.corporationName) + (r.corporationTicker ? ` [${esc(r.corporationTicker)}]` : "");
    meta.push(r.corporationUrl ? `<a href="${esc(r.corporationUrl)}" target="_blank" rel="noopener">${icon("briefcase", { size: 13 })} ${corp}</a>` : `<span>${icon("briefcase", { size: 13 })} ${corp}</span>`);
  }

  // The description is usually the first message repeated verbatim, so show it
  // only when it says something the thread does not already open with.
  const thread = (t.messages || []).filter((m) => String(m && m.content || "").trim() || ((m && m.imageUrls) || []).length);
  const firstMessageText = String(thread[0] && thread[0].content || "").replace(/\s+/g, " ").trim();
  const descText = String(t.description || "").replace(/\s+/g, " ").trim();
  const descAdds = descText && descText !== firstMessageText && !(firstMessageText && firstMessageText.startsWith(descText.slice(0, 60)));
  const descriptionCard = descAdds
    ? `<div class="cm-card"><h2>${icon("file-text", { size: 14 })} Description</h2><div class="cm-desc">${esc(clipText(descText, 1200))}</div></div>`
    : "";

  const head = thread.slice(0, 2);
  const tail = thread.length > 4 ? thread.slice(-2) : [];
  const middle = thread.length > 4 ? thread.slice(2, -2) : thread.slice(2);
  const hiddenShown = middle.slice(-MAX_HIDDEN_MESSAGES);
  const omitted = middle.length - hiddenShown.length;
  const msgs = thread.length
    ? `<div class="cm-card"><h2>${icon("message-square", { size: 14 })} Conversation <span class="cm-muted" style="font-weight:500;text-transform:none;letter-spacing:0">· ${thread.length} message${thread.length === 1 ? "" : "s"}</span></h2>
        <div class="cm-msgs">${head.map(messageBlock).join("")}</div>
        ${middle.length ? `<details class="cm-gh-more"><summary>${middle.length} earlier message${middle.length === 1 ? "" : "s"}</summary>
          ${omitted > 0 ? `<p class="cm-muted" style="font-size:.8rem">${omitted} older message${omitted === 1 ? "" : "s"} not shown — the full thread is in the support tracker.</p>` : ""}
          <div class="cm-msgs">${hiddenShown.map(messageBlock).join("")}</div></details>` : ""}
        ${tail.length ? `<div class="cm-msgs cm-msgs-tail">${tail.map(messageBlock).join("")}</div>` : ""}
      </div>`
    : "";

  const topImages = (t.imageUrls || []);
  const topImgs = topImages.length
    ? `<div class="cm-card"><h2>${icon("image", { size: 14 })} Attachments <span class="cm-muted" style="font-weight:500;text-transform:none;letter-spacing:0">· ${topImages.length}</span></h2>
        <div class="cm-imgs" data-all-dead="${topImages.length} attachments, links may have expired">${topImages.slice(0, MAX_TOP_IMAGES).map(attachment).join("")}</div>
        ${topImages.length > MAX_TOP_IMAGES ? `<p class="cm-muted" style="font-size:.8rem">${topImages.length - MAX_TOP_IMAGES} more in the thread below.</p>` : ""}</div>`
    : "";

  // Manual code-session launching from the ticket page is retired; the kanban
  // tracker is the working view. A session started by triage still shows its
  // progress here.
  let launchBlock = "";
  if (fixSession && fixSession.codeSessionId) {
    launchBlock = `<div class="cm-card"><h2>${icon("git-pull-request", { size: 14 })} Fix in progress</h2>
      <div class="cm-launch-result">A code-agent session was launched. <a href="/code/session/${esc(fixSession.codeSessionId)}">Open session →</a>${fixSession.prUrl ? ` · <a href="${esc(fixSession.prUrl)}" target="_blank" rel="noopener">View PR →</a>` : ""}</div></div>`;
  } else if (fixSession && fixSession.prUrl) {
    launchBlock = `<div class="cm-card"><h2>${icon("git-pull-request", { size: 14 })} Fix in progress</h2><div class="cm-launch-result"><a href="${esc(fixSession.prUrl)}" target="_blank" rel="noopener">View PR →</a></div></div>`;
  }

  // Attachments come from Discord, whose URLs expire. If none in a group
  // actually loads, the row of dead chips is replaced by one honest line.
  const imagesJs = `<script>(function(){document.querySelectorAll('.cm-imgs').forEach(function(g){var imgs=g.querySelectorAll('img');if(!imgs.length)return;var dead=0;function check(){if(dead===imgs.length)g.classList.add('cm-imgs-all-dead');}imgs.forEach(function(i){if(i.complete&&i.naturalWidth===0){dead++;check();return;}i.addEventListener('error',function(){dead++;check();});});});})();</script>`;

  // Re-run triage block — forces the worker to re-assess this ticket next tick.
  const retriageBlock = `<button class="cm-retriage" id="cm-retriage-btn">${icon("refresh", { size: 14 })} Re-run triage</button>
    <span class="cm-launch-result" id="cm-retriage-result" style="margin-left:.5rem"></span>`;
  const retriageJs = `<script>(function(){function fail(el,msg){el.replaceChildren();var s=document.createElement('span');s.style.color='var(--red,#e05c5c)';s.textContent=msg;el.appendChild(s);}function launched(el,id){el.replaceChildren();el.appendChild(document.createTextNode('Session launched. '));var a=document.createElement('a');a.href='/code/session/'+encodeURIComponent(id);a.textContent='Open session →';el.appendChild(a);}
    var btn=document.getElementById('cm-retriage-btn');if(!btn)return;
    var out=document.getElementById('cm-retriage-result');
    btn.addEventListener('click',function(){
      if(!confirm('Re-run triage for ticket #${esc(t.ticketNumber)}? The current assessment will be replaced on the next worker tick.'))return;
      btn.disabled=true;btn.textContent='Re-queuing…';
      fetch('/api/tickets/${esc(t._id)}/retriage',{method:'POST',headers:{'Content-Type':'application/json'}})
        .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d}})})
        .then(function(res){
          if(res.ok&&res.d.ok){
            out.textContent='Re-assessing…';var tries=0;
            var poll=setInterval(function(){tries++;
              fetch('/api/tickets/${esc(t._id)}/triage-status').then(function(r){return r.json()}).then(function(st){
                if(st.triageStatus==='assessed'){clearInterval(poll);out.textContent='Done — reloading…';location.reload();}
                else if(st.triageStatus==='error'){clearInterval(poll);fail(out,'Assessment failed: '+(st.error||''));btn.disabled=false;btn.innerHTML='Re-run triage';}
                else if(tries>40){clearInterval(poll);location.reload();}
              }).catch(function(){});
            },2000);
          }
          else{fail(out,'Failed: '+((res.d&&res.d.error)||'error'));btn.disabled=false;btn.innerHTML='Re-run triage';}
        }).catch(function(e){fail(out,'Failed: '+e.message);btn.disabled=false;btn.innerHTML='Re-run triage';});
    });
  })();</script>`;

  // Resolution receipt block. A terminal status without a receipt is an
  // incomplete record, so staff get a publish form instead of a false finish.
  let closeBlock, closeJs = "";
  const existingReceipt = getResolution(t);
  if (isTerminalStatus(t.status) && existingReceipt) {
    const delivery = existingReceipt.delivery || {};
    const actionsHtml = existingReceipt.actions && existingReceipt.actions.length
      ? `<ul class="cm-steps">${existingReceipt.actions.map((action) => `<li>${esc(action.label)}${action.detail ? `: ${esc(action.detail)}` : ""}</li>`).join("")}</ul>`
      : "";
    closeBlock = `<div class="cm-card"><h2>${icon("check", { size: 14 })} Resolution receipt</h2>
      <div class="cm-desc">${esc(existingReceipt.message)}</div>
      ${actionsHtml ? `<h2 style="margin-top:var(--s-4)">Actions recorded</h2>${actionsHtml}` : ""}
      ${existingReceipt.followUp ? `<h2 style="margin-top:var(--s-4)">Follow-up</h2><div class="cm-desc">${esc(existingReceipt.followUp)}</div>` : ""}
      <div class="cm-launch-note">${esc(resolutionSourceLabel(existingReceipt.source))}${t.closedBy ? " by " + esc(t.closedBy) : ""}${existingReceipt.resolvedAt ? " · " + esc(fmtDate(existingReceipt.resolvedAt)) : ""}.</div>
      <div class="cm-launch-note">Channel delivery: <b>${esc(delivery.status || (existingReceipt.deliveredAt ? "posted" : "pending"))}</b>${delivery.error ? ` · ${esc(delivery.error)}` : ""}</div></div>`;
  } else {
    const targetStatus = t.status === "closed" ? "closed" : "resolved";
    closeBlock = `<div class="cm-card"><h2>${icon("check", { size: 14 })} Publish resolution receipt</h2>
      <div class="cm-close-form">
        <textarea id="cm-close-msg" placeholder="Plain-language summary for the player: what was fixed or decided."></textarea>
        <textarea id="cm-close-actions" placeholder="Actions taken, one per line."></textarea>
        <textarea id="cm-close-followup" placeholder="Follow-up for the player, if any."></textarea>
        <label class="cm-launch-note" for="cm-close-source">How was this resolved?</label>
        <select id="cm-close-source" style="max-width:20rem;padding:.55rem .7rem;border-radius:var(--r-md);border:1px solid var(--border);background:var(--glass-1);color:var(--text);font:inherit">
          <option value="ops">Support operation</option>
          <option value="discord">Discord request</option>
          <option value="agent">Agentic work</option>
        </select>
        <button class="cm-close-btn" id="cm-close-btn">${icon("check", { size: 15 })} Mark ${targetStatus} &amp; notify reporter</button>
      </div>
      <div class="cm-launch-note">Saves the permanent receipt and sends a human-facing update in the ticket channel. Internal diagnosis and promotion details stay out of the player message.</div>
      <div class="cm-launch-result" id="cm-close-result"></div></div>`;
    closeJs = `<script>(function(){function fail(el,msg){el.replaceChildren();var s=document.createElement('span');s.style.color='var(--red,#e05c5c)';s.textContent=msg;el.appendChild(s);}function launched(el,id){el.replaceChildren();el.appendChild(document.createTextNode('Session launched. '));var a=document.createElement('a');a.href='/code/session/'+encodeURIComponent(id);a.textContent='Open session →';el.appendChild(a);}
      var btn=document.getElementById('cm-close-btn');if(!btn)return;
      var out=document.getElementById('cm-close-result');var ta=document.getElementById('cm-close-msg');var actionsTa=document.getElementById('cm-close-actions');var followUpTa=document.getElementById('cm-close-followup');var sourceEl=document.getElementById('cm-close-source');
      btn.addEventListener('click',function(){
        var msg=(ta&&ta.value||'').trim();
        if(!msg){out.innerHTML='<span style="color:var(--red,#e05c5c)">Enter a player-facing resolution summary first.</span>';return;}
        if(!confirm('Close ticket #${esc(t.ticketNumber)} and send this resolution to the reporter?'))return;
        var actions=(actionsTa&&actionsTa.value||'').split(/\r?\n/).map(function(x){return x.trim();}).filter(Boolean);
        var followUp=(followUpTa&&followUpTa.value||'').trim();
        btn.disabled=true;btn.textContent='Saving receipt...';
        fetch('/api/tickets/${esc(t._id)}/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resolution:msg,actions:actions,followUp:followUp,source:(sourceEl&&sourceEl.value)||'ops',status:'${targetStatus}'})})
          .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d}})})
          .then(function(res){
            if(res.ok&&res.d.ok){out.textContent='Receipt saved and reporter notified. Reloading...';setTimeout(function(){location.reload()},1200);}
            else{fail(out,'Failed: '+((res.d&&res.d.error)||'error'));btn.disabled=false;btn.innerHTML='Mark ${targetStatus} &amp; notify reporter';}
          }).catch(function(e){fail(out,'Failed: '+e.message);btn.disabled=false;btn.innerHTML='Mark ${targetStatus} &amp; notify reporter';});
      });
    })();</script>`;
  }

  return {
    extraCss: COMMUNITY_CSS,
    body: `${isStaff
        ? `<a class="cm-back" href="/tickets">${icon("arrow-left", { size: 14 })} All tickets</a>`
        : `<a class="cm-back" href="https://www.ahousedividedgame.com">${icon("arrow-left", { size: 14 })} Back to the game</a>`}
      <div class="cm-dhead"><h1>${isStaff ? `#${esc(t.ticketNumber)} ` : ""}${esc(t.title || "(untitled)")}</h1>${statusBadge(t.status)}</div>
      <div class="cm-dmeta">${meta.join("")}</div>
      ${renderReportSummary({ ticket: t, github, viewer })}
      ${renderTrackedWork(tracked, viewer, t)}
      ${supportContext}
      ${descriptionCard}
      ${renderTimeline({ ticket: t, github })}
      ${isStaff ? `${topImgs}
      ${msgs}
      ${renderTriageMeta({ tags: t.tags, assessment, statusHistory: t.statusHistory, terminalStatus: isTerminalStatus(t.status) })}
      ${renderGitHubCard(github, t.ticketNumber, t)}
      ${renderAssessmentCard(assessment)}
      ${launchBlock}
      ${closeBlock}
      <div class="cm-card"><h2>${icon("refresh", { size: 14 })} Re-triage</h2>
        <div>${retriageBlock}</div>
        <div class="cm-launch-note">Resets this ticket so the triage worker re-assesses it on its next tick. The previous assessment is kept as history.</div>
      </div>
      ${imagesJs}
      ${retriageJs}
      ${closeJs}` : ""}`,
  };
}

// The five steps a report moves through, and the rule that decides which one it
// is in from the live state of its GitHub artefacts. Kept here rather than only
// in the filer so the page can re-derive it from freshly read state.
const STAGE_STEPS = [
  ["received", "Received"],
  ["triaged", "Triaged"],
  ["tracked", "Tracked"],
  ["in_progress", "Fix in progress"],
  ["fixed", "Fixed"],
];

/** Which step, from artefact states plus the last verdict. */
function stageFor(artifacts, latest) {
  const issues = (artifacts && artifacts.issues) || [];
  const outcome = latest && latest.outcome;
  // A merged PR only means fixed when it is one we matched with confidence; a
  // weak "possibly related" match is not evidence the report is resolved.
  const fixers = ((latest && latest.relatedPrs) || []).filter((p) => p && (p.confidence == null || Number(p.confidence) >= 0.6)).map((p) => Number(p.number));
  const prs = ((artifacts && artifacts.prs) || []).filter((p) => fixers.includes(Number(p.number)));
  if (prs.some((p) => p.mergedAt || p.state === "MERGED")) return "fixed";
  if (issues.length && issues.every((i) => i.state === "CLOSED")) return "fixed";
  if (prs.some((p) => p.state === "OPEN")) return "in_progress";
  if (issues.some((i) => i.state === "OPEN")) return "tracked";
  if (outcome === "needs-human" || outcome === "would-file") return "triaged";
  if (outcome === "filed" || outcome === "linked" || outcome === "duplicate") return "tracked";
  return "received";
}

/** A five-segment bar with the current step named underneath. */
function stageBar(stage) {
  const idx = Math.max(0, STAGE_STEPS.findIndex(([key]) => key === stage));
  const [key, label] = STAGE_STEPS[idx];
  const segments = STAGE_STEPS.map((_, i) => `<span class="seg${i <= idx ? " on" : ""}"></span>`).join("");
  return `<div class="cm-stage">
    <div class="cm-stage-bar" role="img" aria-label="Step ${idx + 1} of ${STAGE_STEPS.length}: ${esc(label)}">${segments}</div>
    <div class="cm-stage-now">${esc(label)}<span class="cm-muted"> · step ${idx + 1} of ${STAGE_STEPS.length}</span></div>
    <div class="cm-stage-hint">${STAGE_STEPS.map(([, l]) => esc(l)).join(" → ")}</div>
  </div>`;
}

/** A terminal ticket is no longer in the GitHub triage pipeline. */
function terminalStageBar(ticket) {
  const label = publicStatusLabel(ticket && ticket.status);
  const segments = STAGE_STEPS.map(() => `<span class="seg on"></span>`).join("");
  return `<div class="cm-stage">
    <div class="cm-stage-bar" role="img" aria-label="${esc(label)}, terminal status">${segments}</div>
    <div class="cm-stage-now">${esc(label)}<span class="cm-muted"> · terminal</span></div>
    <div class="cm-stage-hint">The receipt below is the current source of truth.</div>
  </div>`;
}

module.exports = { COMMUNITY_CSS, esc, fmtDate, relTime, statusBadge, triageBadge, renderAssessmentCard, renderTriageMeta, renderGitHubCard, githubArtifactUrl, renderPublicWorkLinks, renderContextBanner, makeTicketsListBody, makeTicketDetailBody, renderPublicReceiptBody, renderTrackedWork, stageBar, terminalStageBar, stageFor, STAGE_STEPS, TRIAGE_LABEL, OUTCOME_STATUS_TEXT, PUBLIC_STATUS_TEXT };
