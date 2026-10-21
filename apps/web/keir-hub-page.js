"use strict";
const { createWatchPanel, WATCH_CSS } = require("./keir-watch-panel");
const { createThroughputPanel, THROUGHPUT_CSS } = require("./keir-throughput-panel");

// Keir hub (/keir): a live view of what Keir is doing.
//
// The top panel says in one sentence what Keir is doing now, shows each live
// job as a ring (spinning while it runs, emptying toward its next wake), the
// Rust runner's tool calls as they stream, a timeline of the last hours with
// one lane per job (activations as bars in the runner's color, actions as
// marks, the next wake past the now line) and a feed of the same actions in
// plain words. Hovering a feed line lights its lane. Below: headline numbers
// that flash when they change, the ticket journey (each open ticket placed at
// its fix stage, sliding along when it advances), analytics, workers, runner
// attempts, PRs and the side lists.
//
// Data comes from /api/keir/hub every three seconds while something runs and
// every eight otherwise; timers tick every second. The client is a real
// function serialized into the page, so it needs no template escaping.
// Everything animated stops under prefers-reduced-motion.
// Returns { extraCss, body } like every other page here.

const CSS = `
.kh{max-width:1580px;margin:0 auto;padding:28px 20px 40px;display:flex;flex-direction:column;gap:16px;
  --run-claude:#2a78d6;--run-codex:#eb6834;--run-muse:#1baf7a;--run-agy:#eda100;--run-other:#8b8a85;
  --st-good:#0ca30c;--st-warn:#fab219;--st-serious:#ec835a;--st-crit:#d03b3b;
  --kh-ease:cubic-bezier(.2,.8,.2,1);--kh-spring:cubic-bezier(.32,1.25,.5,1);
  --kh-elev:0 1px 0 color-mix(in srgb,#fff 5%,transparent) inset,0 1px 2px rgba(0,0,0,.18),0 12px 32px -14px rgba(0,0,0,.5);
  --kh-sep:color-mix(in srgb,var(--border) 75%,transparent);--kh-chip:color-mix(in srgb,var(--text) 7%,transparent);
  font-feature-settings:"tnum" 1,"cv11" 1}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) .kh{--run-claude:#3987e5;--run-codex:#d95926;--run-muse:#199e70;--run-agy:#c98500}}
:root[data-theme="dark"] .kh{--run-claude:#3987e5;--run-codex:#d95926;--run-muse:#199e70;--run-agy:#c98500}
:root[data-theme="light"] .kh{--kh-elev:0 1px 2px rgba(16,24,32,.06),0 10px 28px -16px rgba(16,24,32,.22)}

/* entrance */
.kh .rise{opacity:0;transform:translateY(8px);animation:khRise .55s var(--kh-ease) forwards;animation-delay:calc(var(--i,0) * 60ms)}
@keyframes khRise{to{opacity:1;transform:none}}

/* header */
.kh-top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.kh-title{display:flex;flex-direction:column;gap:6px}
.kh-title h1{margin:0;font-size:28px;line-height:1;font-weight:750;letter-spacing:-.035em;display:flex;align-items:center;gap:12px}
.kh-sub{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--text-3);font-size:12.5px}
.kh-sub b{color:var(--text-2);font-weight:600}
.kh-live{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 10px 0 9px;border-radius:999px;background:color-mix(in srgb,var(--st-good) 14%,transparent);color:color-mix(in srgb,var(--st-good) 80%,var(--text));font:650 11.5px/1 var(--font);letter-spacing:.02em}
.kh-live i{width:7px;height:7px;border-radius:50%;background:var(--st-good);position:relative}
.kh-live i:after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--st-good);opacity:0;animation:khPing 2.4s var(--kh-ease) infinite}
.kh-live.paused{background:var(--kh-chip);color:var(--text-3)}.kh-live.paused i{background:var(--text-3)}.kh-live.paused i:after{animation:none}
@keyframes khPing{0%{transform:scale(.6);opacity:.7}80%,100%{transform:scale(1.9);opacity:0}}
.kh-actions{display:flex;gap:8px;align-items:center}
.kh-seg{display:inline-flex;padding:3px;border-radius:10px;background:var(--surface-2,var(--kh-chip));gap:2px}
.kh-seg button{height:28px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--text-2);font:600 12.5px/1 var(--font);cursor:pointer;transition:background .2s var(--kh-ease),color .2s,box-shadow .2s;display:inline-flex;align-items:center;gap:6px}
.kh-seg button:hover{color:var(--text)}
.kh-seg button.on{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.25),0 0 0 1px var(--kh-sep)}
.kh-seg .n{font-size:11px;color:var(--text-3);font-weight:650}
.kh-link{height:34px;display:inline-flex;align-items:center;padding:0 12px;border-radius:10px;color:var(--text-2);font:600 12.5px var(--font);text-decoration:none;transition:background .2s,color .2s}
.kh-link:hover{background:var(--kh-chip);color:var(--text)}

/* panels */
.kh-panel{background:var(--surface);border:1px solid var(--kh-sep);border-radius:16px;box-shadow:var(--kh-elev);min-width:0}
.kh-ph{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px 10px}
.kh-ph h2{margin:0;font-size:14.5px;font-weight:700;letter-spacing:-.01em;display:flex;align-items:baseline;gap:8px}
.kh-ph h2 small{font-size:12px;font-weight:550;color:var(--text-3)}
.kh-pb{padding:0 18px 16px}

/* headline strip */
.kh-hero{display:grid;grid-template-columns:repeat(5,minmax(0,1fr)) 230px}
.kh-stat{padding:18px 20px;display:flex;flex-direction:column;gap:8px;min-width:0;position:relative}
.kh-stat+.kh-stat:before{content:"";position:absolute;left:0;top:18px;bottom:18px;width:1px;background:var(--kh-sep)}
.kh-stat .lbl{font:650 11.5px/1 var(--font);color:var(--text-3);letter-spacing:.01em;display:flex;align-items:center;gap:6px}
.kh-stat .num{font-size:30px;line-height:1;font-weight:750;letter-spacing:-.04em;color:var(--text)}
.kh-stat .num.alert{color:color-mix(in srgb,var(--st-crit) 85%,var(--text))}
.kh-stat .foot{font-size:12px;color:var(--text-3);min-height:16px;display:flex;align-items:center;gap:8px}
.kh-stat .spark{height:26px;width:100%}
.kh-mix{display:flex;height:6px;border-radius:999px;overflow:hidden;gap:2px;background:transparent}
.kh-mix span{display:block;height:100%;border-radius:2px;transition:flex-grow .6s var(--kh-ease)}
.kh-ringbox{display:flex;align-items:center;gap:14px;padding:16px 20px;position:relative}
.kh-ringbox:before{content:"";position:absolute;left:0;top:18px;bottom:18px;width:1px;background:var(--kh-sep)}
.kh-ring{width:74px;height:74px;flex:none}
.kh-ring circle{fill:none;stroke-width:8}.kh-ring .trk{stroke:var(--kh-chip)}
.kh-ring .val{stroke:var(--accent);stroke-linecap:round;transform:rotate(-90deg);transform-origin:50% 50%;transition:stroke-dashoffset 1s var(--kh-ease)}
.kh-ringtxt{display:flex;flex-direction:column;gap:4px}.kh-ringtxt b{font-size:22px;letter-spacing:-.03em}.kh-ringtxt span{font-size:12px;color:var(--text-3);line-height:1.35}
@media(max-width:1200px){.kh-hero{grid-template-columns:repeat(3,minmax(0,1fr))}.kh-stat:nth-child(4):before,.kh-ringbox:before{display:none}}

/* chart */
.kh-chart{position:relative;padding:4px 18px 4px}
.kh-chart svg{width:100%;height:210px;display:block;overflow:visible}
.kh-chart .bar{transform-box:fill-box;transform-origin:50% 100%;transition:opacity .18s}
.kh-chart.grow .bar{animation:khGrow .7s var(--kh-ease) both;animation-delay:calc(var(--i) * 18ms)}
@keyframes khGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.kh-chart svg.hovering .col:not(.hot) .bar{opacity:.38}
.kh-chart .band{fill:var(--text);opacity:0;transition:opacity .15s}.kh-chart .col.hot .band{opacity:.05}
.kh-legend{display:flex;flex-wrap:wrap;gap:6px 18px;padding:6px 18px 16px;font-size:12.5px;color:var(--text-2)}
.kh-legend span{display:inline-flex;align-items:center;gap:7px}.kh-legend i{width:9px;height:9px;border-radius:3px}
.kh-legend em{font-style:normal;color:var(--text);font-weight:650}
.kh-tip{position:absolute;pointer-events:none;min-width:168px;padding:10px 12px;border-radius:12px;background:var(--surface-3,var(--surface));border:1px solid var(--kh-sep);box-shadow:0 18px 40px -12px rgba(0,0,0,.55);font-size:12.5px;opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s var(--kh-ease);z-index:5}
.kh-tip.on{opacity:1;transform:none}.kh-tip b{display:block;margin-bottom:6px;font-weight:700}
.kh-tip div{display:flex;justify-content:space-between;gap:14px;color:var(--text-2);line-height:1.7}.kh-tip div span:first-child{display:inline-flex;align-items:center;gap:7px}

/* layout */
.kh-cols{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(320px,1fr);gap:16px;align-items:start}
.kh-stack{display:flex;flex-direction:column;gap:16px;min-width:0}
@media(max-width:1150px){.kh-cols{grid-template-columns:1fr}}

/* shared atoms */
.kh-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:7px;background:var(--kh-chip);color:var(--text-2);font:600 11.5px/1 var(--font);white-space:nowrap;vertical-align:middle;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.kh-chip .sw{width:8px;height:8px;border-radius:2.5px;flex:none}
.kh-rust{display:inline-flex;align-items:center;justify-content:center;height:22px;padding:0 7px;border-radius:7px;font:750 10.5px/1 var(--font);letter-spacing:.04em;color:#f0b38c;background:color-mix(in srgb,#ce6a2b 20%,transparent)}
:root[data-theme="light"] .kh-rust{color:#a3501c;background:color-mix(in srgb,#ce6a2b 13%,transparent)}
.kh-st{display:inline-flex;align-items:center;gap:7px;font:650 12px/1 var(--font);color:var(--text-2);white-space:nowrap}
.kh-st svg{width:14px;height:14px;flex:none}
.kh-st.running{color:var(--text)}.kh-st.running svg{color:var(--st-good)}
.kh-st.queued svg{color:var(--accent)}.kh-st.waiting svg{color:var(--text-3)}
.kh-st.blocked{color:color-mix(in srgb,var(--st-crit) 80%,var(--text))}.kh-st.blocked svg{color:var(--st-crit)}
.kh-st.running .pulse{animation:khBreath 2s ease-in-out infinite}
@keyframes khBreath{50%{opacity:.45}}
.kh-muted{color:var(--text-3)}.kh-mono{font-family:var(--mono);font-size:12px}
.kh-empty{padding:18px 0 4px;color:var(--text-3);font-size:13px}
.kh-pb.kh-empty{padding:2px 18px 18px}
.kh-cell{display:flex;align-items:center;gap:6px;min-width:0}
.kh-time{font-family:var(--mono);font-size:12px;color:var(--text-2);white-space:nowrap}.kh-time.muted{color:var(--text-3)}
.kh-a{color:var(--text);text-decoration:none;border-bottom:1px solid transparent;transition:border-color .2s}.kh-a:hover{border-color:currentColor}

/* toolbar */
.kh-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:0 18px 12px}
.kh-search{flex:1;min-width:180px;height:34px;padding:0 12px;border-radius:10px;border:1px solid var(--kh-sep);background:var(--bg-0,var(--surface-2));color:var(--text);font:500 13px var(--font);transition:border-color .2s,box-shadow .2s}
.kh-search:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.kh-select{height:34px;padding:0 10px;border-radius:10px;border:1px solid var(--kh-sep);background:var(--surface-2,var(--surface));color:var(--text-2);font:600 12.5px var(--font)}

/* rows */
.kh-rows{display:flex;flex-direction:column}
.kh-row{display:grid;align-items:center;gap:14px;padding:11px 18px;border-top:1px solid var(--kh-sep);cursor:pointer;transition:background .18s var(--kh-ease)}
.kh-row:hover{background:color-mix(in srgb,var(--text) 3.5%,transparent)}
.kh-row.stale{opacity:.6}.kh-row.stale:hover{opacity:1}
.kh-row:hover .go{opacity:1;transform:none}
.kh-row .go{opacity:0;transform:translateX(-4px);transition:opacity .2s,transform .2s var(--kh-ease);color:var(--text-3)}
.kh-row .ttl{min-width:0;display:flex;flex-direction:column;gap:3px}
.kh-row .ttl b{font-size:13.5px;font-weight:650;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kh-row .ttl span{font-size:12.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kh-row .r{text-align:right;justify-self:end;white-space:nowrap}
.kh-workers .kh-row{grid-template-columns:92px minmax(0,1fr) 150px 88px 14px}
.kh-tickets .kh-row{grid-template-columns:64px minmax(220px,1fr) 108px 250px 120px 220px 14px}
.kh-prs .kh-row{grid-template-columns:62px minmax(0,1fr) 92px 64px 92px}
.kh-head{display:grid;gap:14px;padding:0 18px 8px;font:650 11px/1 var(--font);color:var(--text-3);letter-spacing:.02em}
.kh-workers .kh-head{grid-template-columns:92px minmax(0,1fr) 150px 88px 14px}
.kh-tickets .kh-head{grid-template-columns:64px minmax(220px,1fr) 108px 250px 120px 220px 14px}
.kh-prs .kh-head{grid-template-columns:62px minmax(0,1fr) 92px 64px 92px}
.kh-group{padding:12px 18px 6px;font:650 11.5px/1 var(--font);color:var(--text-3);border-top:1px solid var(--kh-sep);display:flex;gap:8px;align-items:center}
.kh-group:first-child{border-top:0}
@media(max-width:1250px){.kh-tickets .kh-row,.kh-tickets .kh-head{grid-template-columns:60px minmax(0,1fr) 104px 210px 110px 14px}.kh-tickets .kh-row>span:nth-last-child(2),.kh-tickets .kh-head>span:nth-last-child(2){display:none}}
@media(max-width:900px){.kh-workers .kh-row,.kh-workers .kh-head{grid-template-columns:90px minmax(0,1fr) 14px}.kh-workers .hide-s{display:none}
  .kh-tickets .kh-row,.kh-tickets .kh-head{grid-template-columns:52px minmax(0,1fr) 104px}.kh-tickets .hide-s{display:none}}

/* status pill and stepper */
.kh-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;font:650 11.5px/1 var(--font);background:var(--kh-chip);color:var(--text-2);white-space:nowrap}
.kh-pill i{width:6px;height:6px;border-radius:50%;background:currentColor}
.kh-pill.open{color:var(--accent)}.kh-pill.progress{color:color-mix(in srgb,var(--st-good) 85%,var(--text))}.kh-pill.blocked{color:color-mix(in srgb,var(--st-crit) 85%,var(--text))}
.kh-pill.done{color:var(--text-3)}.kh-pill.ask{color:color-mix(in srgb,var(--st-warn) 85%,var(--text));background:color-mix(in srgb,var(--st-warn) 14%,transparent)}
.kh-steps{display:flex;flex-direction:column;gap:6px}
.kh-step{display:grid;grid-template-columns:92px minmax(0,1fr);gap:10px;align-items:center}
.kh-track{display:grid;grid-template-columns:repeat(5,1fr);gap:3px}
.kh-track i{height:6px;border-radius:3px;background:var(--kh-chip);transition:background .5s var(--kh-ease)}
.kh-track i.on{background:var(--accent)}.kh-track.done i.on{background:var(--st-good)}.kh-track.paused i.on{background:var(--st-warn)}
.kh-step span{font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kh-ci{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:7px;background:var(--kh-chip);font:650 11.5px/1 var(--font);color:var(--text-2);text-decoration:none;margin:0 4px 4px 0;transition:background .2s}
.kh-ci:hover{background:color-mix(in srgb,var(--text) 12%,transparent)}
.kh-ci i{width:7px;height:7px;border-radius:50%;background:var(--text-3)}
.kh-ci.green i{background:var(--st-good)}.kh-ci.red i{background:var(--st-crit)}.kh-ci.pending i{background:var(--st-warn);animation:khBreath 1.6s ease-in-out infinite}

/* side lists */
.kh-list{display:flex;flex-direction:column}
.kh-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:11px 18px;border-top:1px solid var(--kh-sep);transition:background .18s}
.kh-item:hover{background:color-mix(in srgb,var(--text) 3%,transparent)}
.kh-item b{font-size:13px;font-weight:650;line-height:1.35}
.kh-item .meta{grid-column:1 / -1;font-size:12px;color:var(--text-3);line-height:1.45}
.kh-item .when{font-size:12px;color:var(--text-3);white-space:nowrap}
.kh-ask{display:flex;gap:12px;padding:14px 18px;border-top:1px solid var(--kh-sep)}
.kh-ask .ico{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:color-mix(in srgb,var(--st-warn) 16%,transparent);color:var(--st-warn);flex:none}
.kh-kv{display:grid;grid-template-columns:auto 1fr;gap:9px 16px;font-size:13px}
.kh-kv dt{color:var(--text-3)}.kh-kv dd{margin:0;text-align:right;font-weight:600}
.kh-more{border:0;background:transparent;color:var(--accent);font:600 12.5px var(--font);cursor:pointer;padding:0}

/* drawer */
.kh-scrim{position:fixed;inset:0;background:rgba(5,9,14,.45);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:opacity .25s var(--kh-ease);z-index:59}
.kh-scrim.on{opacity:1;pointer-events:auto}
.kh-drawer{position:fixed;top:12px;right:12px;bottom:12px;width:min(580px,calc(100vw - 24px));background:var(--surface);border:1px solid var(--kh-sep);border-radius:18px;box-shadow:0 30px 80px -20px rgba(0,0,0,.6);transform:translateX(calc(100% + 24px));transition:transform .45s var(--kh-spring);z-index:60;display:flex;flex-direction:column;overflow:hidden}
.kh-drawer.open{transform:none}
.kh-drawer header{padding:18px 20px 14px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid var(--kh-sep)}
.kh-drawer header h3{margin:0;font-size:18px;letter-spacing:-.02em}
.kh-drawer header p{margin:6px 0 0;display:flex;gap:6px;flex-wrap:wrap}
.kh-x{width:32px;height:32px;border-radius:9px;border:0;background:var(--kh-chip);color:var(--text-2);cursor:pointer;font-size:16px;transition:background .2s}.kh-x:hover{background:color-mix(in srgb,var(--text) 12%,transparent)}
.kh-drawer .body{padding:18px 20px 24px;overflow:auto;display:flex;flex-direction:column;gap:20px}
.kh-sec h4{margin:0 0 10px;font:650 11.5px/1 var(--font);color:var(--text-3);letter-spacing:.02em}
.kh-sec p{margin:0;font-size:13.5px;line-height:1.55;color:var(--text)}
.kh-tl{display:flex;flex-direction:column;gap:14px;position:relative;padding-left:20px}
.kh-tl:before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;border-radius:2px;background:var(--kh-sep)}
.kh-tl div{position:relative}.kh-tl div:before{content:"";position:absolute;left:-19px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--surface);border:2px solid var(--accent)}
.kh-tl .k{font:650 11.5px/1 var(--font);color:var(--text-3);margin-bottom:5px}.kh-tl p{font-size:13px;color:var(--text-2)}
.kh-note{font-size:12px;color:var(--text-3)}
/* incidents */
.kh-inc{padding:12px 18px;border-top:1px solid var(--kh-sep);display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 12px;align-items:center}
.kh-inc .sig{width:10px;height:10px;border-radius:50%;background:var(--st-crit);box-shadow:0 0 0 4px color-mix(in srgb,var(--st-crit) 18%,transparent);animation:khBreath 2.2s ease-in-out infinite}
.kh-inc.closed .sig{background:var(--text-3);box-shadow:none;animation:none}
.kh-inc b{font-size:13.5px;font-weight:650}.kh-inc .meta{grid-column:2 / -1;font-size:12px;color:var(--text-3);line-height:1.45}
.kh-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:22px;padding:0 7px;border-radius:999px;background:color-mix(in srgb,var(--st-crit) 16%,transparent);color:color-mix(in srgb,var(--st-crit) 80%,var(--text));font:700 11.5px/1 var(--font)}
.kh-pill.incident{color:color-mix(in srgb,var(--st-crit) 85%,var(--text));background:color-mix(in srgb,var(--st-crit) 14%,transparent)}
/* merge control */
.kh-mergebtn{width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:var(--text-3);cursor:pointer;display:grid;place-items:center;opacity:0;transition:opacity .2s,background .2s,color .2s}
.kh-row:hover .kh-mergebtn{opacity:1}.kh-mergebtn:hover{background:var(--kh-chip);color:var(--text)}
.kh-pop{position:fixed;z-index:70;width:320px;padding:14px;border-radius:14px;background:var(--surface-3,var(--surface));border:1px solid var(--kh-sep);box-shadow:0 24px 60px -16px rgba(0,0,0,.6);opacity:0;transform:translateY(-4px) scale(.98);transform-origin:top right;transition:opacity .16s,transform .2s var(--kh-ease);pointer-events:none}
.kh-pop.on{opacity:1;transform:none;pointer-events:auto}
.kh-pop h5{margin:0 0 10px;font-size:13px}.kh-pop label{display:block;font:650 11.5px var(--font);color:var(--text-3);margin:10px 0 6px}
.kh-pop select,.kh-pop input{width:100%;height:34px;padding:0 10px;border-radius:9px;border:1px solid var(--kh-sep);background:var(--bg-0,var(--surface-2));color:var(--text);font:500 13px var(--font)}
.kh-pop .row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.kh-btn2{height:32px;padding:0 12px;border-radius:9px;border:1px solid var(--kh-sep);background:transparent;color:var(--text-2);font:600 12.5px var(--font);cursor:pointer;transition:background .2s,color .2s}
.kh-btn2:hover{background:var(--kh-chip);color:var(--text)}
.kh-btn2.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent,#fff)}.kh-btn2.primary:hover{filter:brightness(1.08)}
.kh-btn2[disabled]{opacity:.55;cursor:default}
/* analytics */
.kh-trio{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
@media(max-width:1150px){.kh-trio{grid-template-columns:1fr}}
.kh-mstats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 18px}
.kh-mstat span{display:block;font:650 11.5px/1 var(--font);color:var(--text-3);margin-bottom:6px}
.kh-mstat b{font-size:22px;letter-spacing:-.03em;white-space:nowrap}.kh-mstat em{display:block;font-style:normal;font-size:12px;color:var(--text-3);margin-top:4px;white-space:nowrap}
.kh-stack100{display:flex;height:10px;border-radius:999px;overflow:hidden;gap:2px;margin:14px 0 8px}
.kh-stack100 span{display:block;transition:flex-grow .6s var(--kh-ease)}
.kh-keys{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--text-2)}.kh-keys span{display:inline-flex;align-items:center;gap:6px}.kh-keys i{width:8px;height:8px;border-radius:2.5px}
.kh-hbar{display:grid;grid-template-columns:110px minmax(0,1fr) 34px;gap:10px;align-items:center;font-size:12.5px;margin:7px 0}
.kh-hbar .t{height:8px;border-radius:999px;background:var(--kh-chip);overflow:hidden}.kh-hbar .t i{display:block;height:100%;border-radius:999px;background:var(--accent);transform-origin:left;animation:khBar .8s var(--kh-ease) both}
@keyframes khBar{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.kh-hbar .v{text-align:right;color:var(--text-2);font-weight:650}.kh-hbar .k{color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kh-sub2{font:650 11.5px/1 var(--font);color:var(--text-3);margin:14px 0 4px}
/* runs */
.kh-runs .kh-row{grid-template-columns:72px minmax(0,1fr) 150px 70px 56px 14px}
.kh-runs .kh-head{grid-template-columns:72px minmax(0,1fr) 150px 70px 56px 14px}
.kh-exit{display:inline-flex;align-items:center;gap:6px;font:650 12px/1 var(--font)}.kh-exit i{width:7px;height:7px;border-radius:50%;background:var(--st-good)}.kh-exit.bad i{background:var(--st-crit)}.kh-exit.slow i{background:var(--st-warn)}
.kh-ev{display:grid;grid-template-columns:86px minmax(0,1fr);gap:10px;font-size:12.5px;padding:7px 0;border-top:1px solid var(--kh-sep)}
.kh-ev .k{font:650 11.5px/1.4 var(--font);color:var(--text-3)}.kh-ev .k.tool_use{color:var(--accent)}.kh-ev .k.error{color:var(--st-crit)}
.kh-ev p{margin:0;color:var(--text-2);white-space:pre-wrap;word-break:break-word}
/* toast */
.kh-toasts{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:80;pointer-events:none}
.kh-toast{min-width:280px;max-width:560px;padding:11px 14px;border-radius:12px;background:var(--surface-3,var(--surface));border:1px solid var(--kh-sep);box-shadow:0 20px 50px -14px rgba(0,0,0,.6);font-size:13px;display:flex;gap:10px;align-items:flex-start;animation:khToast .35s var(--kh-spring) both}
.kh-toast i{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:none;background:var(--accent)}.kh-toast.ok i{background:var(--st-good)}.kh-toast.bad i{background:var(--st-crit)}
.kh-toast.out{animation:khToastOut .25s var(--kh-ease) forwards}
@keyframes khToast{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
@keyframes khToastOut{to{opacity:0;transform:translateY(8px)}}
/* now: the live sentence, job orbs, timeline and feed */
.kh-now{overflow:hidden}
.kh-nowhead{display:flex;justify-content:space-between;align-items:center;gap:20px 28px;padding:22px 22px 18px;flex-wrap:wrap}
.kh-say{min-width:0;flex:1 1 440px;display:flex;flex-direction:column;gap:9px}
.kh-say1{font-size:27px;line-height:1.12;font-weight:750;letter-spacing:-.032em;color:var(--text)}
.kh-say1.swap{animation:khSwap .55s var(--kh-ease)}
@keyframes khSwap{from{opacity:0;transform:translateY(8px)}}
.kh-say2{font-size:14px;color:var(--text-2);display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center;min-height:22px}
.kh-say3{font-size:12.5px;color:var(--text-3);line-height:1.4}.kh-say3 b{color:var(--text-2);font-weight:600}
.kh-orbs{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;align-items:center}
.kh-orb{all:unset;box-sizing:border-box;cursor:pointer;width:76px;display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 2px 7px;border-radius:14px;transition:background .2s var(--kh-ease),transform .35s var(--kh-spring)}
.kh-orb:hover{background:var(--kh-chip);transform:translateY(-3px)}
.kh-orb:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.kh-orb .ring{position:relative;width:52px;height:52px}
.kh-orb svg{width:52px;height:52px;display:block}
.kh-orb .trk{fill:none;stroke:var(--kh-chip);stroke-width:4}
.kh-orb .arc{fill:none;stroke:var(--c);stroke-width:4;stroke-linecap:round;transform:rotate(-90deg);transform-origin:50% 50%;transition:stroke-dasharray .9s linear}
.kh-orb.s-running .arc{animation:khSpin 1.3s linear infinite}
@keyframes khSpin{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}
.kh-orb.s-queued .trk{stroke-dasharray:3 4;stroke:color-mix(in srgb,var(--accent) 50%,transparent)}.kh-orb.s-queued .arc{opacity:0}
.kh-orb.s-ask .arc{animation:khBreath 1.8s ease-in-out infinite}
.kh-orb.s-blocked .arc{opacity:.75}
.kh-orb .n{position:absolute;inset:0;display:grid;place-items:center;font:750 12.5px/1 var(--font);letter-spacing:-.02em;color:var(--text)}
.kh-orb .l{font:600 11.5px/1.1 var(--font);color:var(--text-2)}
.kh-orb .t{font:600 11px/1 var(--mono);color:var(--text-3);white-space:nowrap}
.kh-orbmore{font-size:11.5px;color:var(--text-3);line-height:1.35;padding-left:8px}
.kh-tailwrap{padding:0 22px 16px}
.kh-tailrow{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:12px;background:color-mix(in srgb,var(--st-good) 6%,transparent)}
.kh-tailrow+.kh-tailrow{margin-top:8px}
.kh-tailrow .hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}
.kh-tailrow .steps{display:flex;gap:6px;flex-wrap:wrap}
.kh-step2{height:22px;display:inline-flex;align-items:center;padding:0 8px;border-radius:7px;background:var(--kh-chip);font:600 11.5px/1 var(--mono);color:var(--text-2)}
.kh-step2:last-child{background:color-mix(in srgb,var(--st-good) 18%,transparent);color:var(--text)}
.kh-step2.fresh{animation:khStep .5s var(--kh-spring) both}
@keyframes khStep{from{opacity:0;transform:translateX(10px) scale(.92)}}
.kh-tailrow .said{margin:0;font-size:13px;color:var(--text-2);line-height:1.45}
.kh-nowbody{display:grid;grid-template-columns:minmax(0,1fr) 370px;border-top:1px solid var(--kh-sep)}
@media(max-width:1150px){.kh-nowbody{grid-template-columns:1fr}.kh-feedcol{border-left:0!important;border-top:1px solid var(--kh-sep)}}
.kh-lanecol{min-width:0;padding:14px 16px 14px 14px;position:relative}
.kh-feedcol{border-left:1px solid var(--kh-sep);display:flex;flex-direction:column;min-width:0;padding-top:14px}
.kh-subh{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 4px 6px;padding:0 4px}
.kh-feedcol .kh-subh{padding:0 14px;margin:0 0 6px}
.kh-subh h3{margin:0;font-size:13.5px;font-weight:700;display:flex;gap:8px;align-items:baseline}
.kh-subh h3 small{font-size:12px;font-weight:550;color:var(--text-3)}
.kh-lanes{position:relative;min-height:120px}
.kh-lanes svg{display:block;overflow:visible}
.kh-lanes .sp{transform-box:fill-box;transform-origin:0 50%}
.kh-lanes.grow .sp{animation:khSpan .8s var(--kh-ease) both;animation-delay:calc(var(--i) * 50ms)}
@keyframes khSpan{from{transform:scaleX(0)}}
.kh-lanes .mk{transform-box:fill-box;transform-origin:50% 50%;cursor:default}
.kh-lanes.grow .mk{animation:khPop .45s var(--kh-spring) both;animation-delay:calc(450ms + var(--i) * 25ms)}
@keyframes khPop{from{transform:scale(0)}}
.kh-lanes .mk.fresh{animation:khPop .55s var(--kh-spring) both}
.kh-lanes .mk.hot circle:first-child{stroke:currentColor;stroke-width:2}
.kh-lanes .rip{fill:none;stroke-width:1.5;transform-box:fill-box;transform-origin:50% 50%;animation:khRip 1.8s var(--kh-ease) forwards}
@keyframes khRip{from{transform:scale(.6);opacity:.9}to{transform:scale(3.4);opacity:0}}
.kh-lanes .ln{transition:opacity .2s;cursor:pointer}
.kh-lanes svg.focusing .ln:not(.focus){opacity:.25}
.kh-lanes .lnbg{fill:var(--text);opacity:0;transition:opacity .15s}.kh-lanes .ln:hover .lnbg,.kh-lanes .ln.focus .lnbg{opacity:.045}
.kh-lanes .livecap{animation:khBreath 1.4s ease-in-out infinite}
.kh-lkeys{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 8px 0;font-size:12px;color:var(--text-3)}
.kh-lkeys span{display:inline-flex;align-items:center;gap:6px}
.kh-ltip{position:absolute;pointer-events:none;max-width:280px;padding:7px 10px;border-radius:10px;background:var(--surface-3,var(--surface));border:1px solid var(--kh-sep);box-shadow:0 14px 34px -12px rgba(0,0,0,.55);font-size:12.5px;line-height:1.35;opacity:0;transform:translateY(4px);transition:opacity .12s,transform .15s var(--kh-ease);z-index:6}
.kh-ltip.on{opacity:1;transform:none}
.kh-feedlist{flex:1;overflow:auto;max-height:440px;padding:0 6px 14px;-webkit-mask-image:linear-gradient(to bottom,#000 86%,transparent);mask-image:linear-gradient(to bottom,#000 86%,transparent);scrollbar-width:thin}
.kh-fi{display:grid;grid-template-columns:26px minmax(0,1fr);gap:10px;padding:8px 10px;border-radius:10px;cursor:pointer;transition:background .18s}
.kh-fi:hover{background:color-mix(in srgb,var(--text) 4.5%,transparent)}
.kh-fi .g{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--g) 16%,transparent);color:var(--g)}
.kh-fi p{margin:1px 0 0;font-size:13px;line-height:1.38;color:var(--text)}
.kh-fi div>span{display:block;font-size:11.5px;color:var(--text-3);margin-top:2px}
.kh-fi.fresh{animation:khFeed .6s var(--kh-spring) both,khFlash 3s var(--kh-ease) both}
@keyframes khFeed{from{opacity:0;transform:translateY(-12px)}}
@keyframes khFlash{0%,35%{background:color-mix(in srgb,var(--accent) 13%,transparent)}100%{background:transparent}}
.kh-fday{padding:12px 10px 4px;font:650 11px/1 var(--font);color:var(--text-3)}
.kh-live.beat i:after{animation:khPing 1.4s var(--kh-ease) 1}
.kh-live i:after{animation:none}
/* vitals reacting to change */
.kh-stat,.kh-ringbox{overflow:visible}
.kh-stat.bumped .num,.kh-ringbox.bumped b{animation:khNum .9s var(--kh-ease)}
@keyframes khNum{0%{color:var(--accent);transform:translateY(-2px)}100%{color:inherit;transform:none}}
.kh-delta{position:absolute;right:16px;top:14px;font:750 12px/1 var(--font);padding:3px 6px;border-radius:6px;animation:khDelta 1.8s var(--kh-ease) forwards;pointer-events:none}
.kh-delta.up{color:color-mix(in srgb,var(--st-good) 85%,var(--text));background:color-mix(in srgb,var(--st-good) 14%,transparent)}
.kh-delta.down{color:var(--text-2);background:var(--kh-chip)}
@keyframes khDelta{0%{opacity:0;transform:translateY(6px)}15%{opacity:1;transform:none}75%{opacity:1}100%{opacity:0;transform:translateY(-10px)}}
/* ticket journey */
.kh-journey{overflow-x:auto;padding:6px 18px 18px}
.kh-jgrid{display:grid;grid-template-columns:repeat(7,minmax(128px,1fr));gap:0 12px;min-width:960px}
.kh-jst{display:flex;flex-direction:column;min-width:0}
.kh-jhd{display:flex;align-items:center;height:14px;margin-right:-12px}
.kh-jhd .node{width:12px;height:12px;border-radius:50%;border:2px solid var(--kh-sep);background:var(--surface);flex:none;transition:background .5s,border-color .5s,box-shadow .5s}
.kh-jst.has .node{border-color:var(--accent);background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 16%,transparent)}
.kh-jst.live.has .node{border-color:var(--st-good);background:var(--st-good);box-shadow:0 0 0 4px color-mix(in srgb,var(--st-good) 16%,transparent)}
.kh-jhd .bar{flex:1;height:2px;margin:0 4px;border-radius:2px;background:var(--kh-sep);transition:background .6s}
.kh-jhd .bar.lit{background:color-mix(in srgb,var(--accent) 55%,var(--kh-sep))}
.kh-jlbl{display:flex;align-items:baseline;gap:7px;margin:10px 0 10px}
.kh-jlbl b{font:650 12.5px/1 var(--font);color:var(--text-2)}.kh-jlbl em{font-style:normal;font:700 12px/1 var(--font);color:var(--text-3)}
.kh-jst.has .kh-jlbl b{color:var(--text)}
.kh-jtoks{display:flex;flex-direction:column;gap:8px}
.kh-jnone{height:58px;border-radius:12px;border:1px dashed var(--kh-sep)}
.kh-tok{all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;gap:7px;width:100%;padding:10px 12px 9px;border-radius:12px;background:color-mix(in srgb,var(--text) 3.5%,var(--surface));border:1px solid var(--kh-sep);box-shadow:0 1px 2px rgba(0,0,0,.14);transition:transform .3s var(--kh-spring),box-shadow .25s,border-color .2s}
.kh-tok:hover{transform:translateY(-2px);box-shadow:0 12px 26px -14px rgba(0,0,0,.55);border-color:color-mix(in srgb,var(--text) 20%,transparent)}
.kh-tok:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.kh-tok .top{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:18px}
.kh-tok .top b{font:750 13px/1 var(--mono);color:var(--text)}
.kh-tok .top .kh-st svg{width:15px;height:15px}
.kh-tok p{margin:0;font-size:12.5px;line-height:1.35;color:var(--text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.kh-tok .fx{display:flex;gap:3px}
.kh-tok .fx i{flex:1;height:5px;border-radius:3px;background:linear-gradient(90deg,var(--accent) calc(var(--p) * 100%),var(--kh-chip) 0)}
.kh-tok .fx i.done{background:var(--st-good)}.kh-tok .fx i.paused{background:linear-gradient(90deg,var(--st-warn) calc(var(--p) * 100%),var(--kh-chip) 0)}
.kh-tok .ft{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--text-3);white-space:nowrap}
.kh-tok.closed{opacity:.6}.kh-tok.closed:hover{opacity:1}
.kh-tok.ask{border-color:color-mix(in srgb,var(--st-warn) 50%,transparent)}
.kh-tok.enter{animation:khRise .55s var(--kh-ease) both;animation-delay:calc(var(--i,0) * 45ms)}
.kh-runs .ttl>span{overflow:visible}
/* phones and narrow tablets */
@media(max-width:760px){
  .kh{padding:18px 12px 32px;gap:12px}
  .kh-top{align-items:flex-start}.kh-actions{flex-wrap:wrap}
  .kh-sub{font-size:12px}.kh-sub b{word-break:break-word}
  .kh-nowhead{padding:18px 16px 14px}.kh-say1{font-size:22px}.kh-orbs{justify-content:flex-start}
  .kh-tailwrap{padding:0 16px 14px}
  .kh-lanecol{padding:12px 10px}.kh-subh{flex-wrap:wrap}.kh-lkeys{display:none}
  .kh-feedlist{max-height:360px}
  .kh-journey{overflow:visible;padding:4px 14px 14px}
  .kh-jgrid{grid-template-columns:1fr;min-width:0;gap:0}
  .kh-jst{padding:8px 0;border-top:1px solid var(--kh-sep)}.kh-jst:first-child{border-top:0}
  .kh-jst:not(.has){display:none}.kh-jhd{display:none}.kh-jlbl{margin:4px 0 8px}
  .kh-hero{grid-template-columns:repeat(2,minmax(0,1fr))}.kh-stat:before,.kh-ringbox:before{display:none}.kh-ringbox{grid-column:1 / -1}
  .kh-tools{padding:0 12px 10px}.kh-seg{flex-wrap:wrap}
  .kh-row,.kh-head{padding-left:14px;padding-right:14px}
  .kh-runs .kh-row,.kh-runs .kh-head{grid-template-columns:56px minmax(0,1fr) 54px 14px}.kh-runs .kh-row>span:nth-child(3),.kh-runs .kh-head>span:nth-child(3),.kh-runs .kh-row>span:nth-child(5),.kh-runs .kh-head>span:nth-child(5){display:none}
  .kh-prs .kh-row,.kh-prs .kh-head{grid-template-columns:52px minmax(0,1fr) 70px}.kh-prs .kh-row>span:nth-child(4),.kh-prs .kh-head>span:nth-child(4),.kh-prs .kh-row>span:nth-child(5),.kh-prs .kh-head>span:nth-child(5){display:none}
  .kh-drawer{top:0;right:0;bottom:0;width:100vw;border-radius:0}
}
@media (prefers-reduced-motion: reduce){.kh *,.kh *:before,.kh *:after{animation:none!important;transition:none!important}.kh .rise,.kh .enter{opacity:1;transform:none}}
`;

const ICON = {
  running: '<svg viewBox="0 0 16 16"><circle class="pulse" cx="8" cy="8" r="4" fill="currentColor"/><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.5"/></svg>',
  queued: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  waiting: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.5"/></svg>',
  blocked: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2.5" fill="currentColor"/><path d="M6 8h4" stroke="var(--surface)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  done: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.8 1.8 3.4-3.6"/></svg>',
};

function keirHubClient(ICON, mountWatch, mountThroughput) {
"use strict";
const $=s=>document.querySelector(s);
const throughputPanel = mountThroughput($("#kh-throughput"), { onJob: id => { if(S && S.workers.concat(S.recent).some(w=>w.id===id))drawer(id);else toast("This root task is outside the recent task drawer."); } });
const watchPanel = mountWatch($("#kh-watch"), { onJob: id => {
  if(S && S.workers.concat(S.recent).some(w=>w.id===id))drawer(id);
  else toast("This task is outside recent work. Its last summary is shown in the finding.");
} });
// Every view builder below escapes runtime strings with esc() where it
// splices them in; numbers and our own markup builders are inert. This is the
// one place markup is assigned.
const setHtml=(el,markup)=>{if(el && el.__markup!==markup){window.OpsDom.setTrustedHtml(el,markup);el.__markup=markup}};
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const RUN=['claude','codex','muse','agy'];const RL={claude:'Claude',codex:'Codex',muse:'Muse',agy:'Antigravity',other:'Other'};
const STAGES=['found','written','tested','sandbox','main'];const SL={found:'Cause found',written:'Fix written',tested:'Tested on dev',sandbox:'On the sandbox',main:'Live on main',confirmed:'Live, confirmed'};
const ORDER={running:0,queued:1,blocked:2,waiting:3};
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
let S=null,first=true,paused=false,F={state:'all',runner:'all',q:'',prs:'open',kb:false,rec:false},table=false;const shown={};
const dur=ms=>{if(ms==null||!isFinite(ms))return '';ms=Math.abs(ms);const s=Math.floor(ms/1000);if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+String(s%60).padStart(2,'0')+'s';const h=Math.floor(m/60);if(h<48)return h+'h '+String(m%60).padStart(2,'0')+'m';return Math.floor(h/24)+'d '+(h%24)+'h'};
const ago=t=>t?dur(Date.now()-t)+' ago':'';
const chip=r=>r?'<span class="kh-chip"><span class="sw" style="background:var(--run-'+(RUN.includes(r)?r:'other')+')"></span>'+esc(RL[r]||r)+'</span>':'<span class="kh-muted">n/a</span>';
const st=s=>'<span class="kh-st '+esc(s)+'">'+(ICON[s]||ICON.queued)+esc(s[0].toUpperCase()+s.slice(1))+'</span>';
const go='<svg class="go" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 3.5L10.5 8 6 12.5"/></svg>';
function tween(el,to,fmt){const from=+el.dataset.v||0;el.dataset.v=to;if(!first&&!reduce&&isFinite(to)&&Math.round(to)!==Math.round(from))bump(el,to-from);if(reduce||from===to||!isFinite(to)){el.textContent=fmt(to);return}const t0=performance.now(),d=650;(function f(t){const p=Math.min(1,(t-t0)/d),e=1-Math.pow(1-p,3);el.textContent=fmt(from+(to-from)*e);if(p<1)requestAnimationFrame(f)})(t0)}
function spark(vals,color){const w=200,h=26,max=Math.max(1,...vals);const pts=vals.map((v,i)=>[i*(w/(vals.length-1||1)),h-2-(v/max)*(h-4)]);const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  return '<svg class="spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none"><path d="'+d+' L'+w+','+h+' L0,'+h+' Z" fill="'+color+'" opacity=".12"/><path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>'}
function hero(s){const k=s.kpis,act=s.activity;const tot=act.map(b=>RUN.concat(['other']).reduce((a,r)=>a+(b[r]||0),0));
  const mixW=[['running',k.running,'var(--st-good)'],['queued',k.queued,'var(--accent)'],['waiting',k.waiting,'var(--text-3)'],['blocked',k.blocked,'var(--st-crit)']];
  const el=$('#kh-hero');if(!el.dataset.built){el.dataset.built=1;setHtml(el,
   '<div class="kh-stat"><span class="lbl">Live work</span><span class="num" id="h-live">0</span><div class="kh-mix" id="h-mix"></div><span class="foot" id="h-livef"></span></div>'+
   '<div class="kh-stat"><span class="lbl">Waiting on you</span><span class="num" id="h-dec">0</span><span class="foot" id="h-decf"></span></div>'+
   '<div class="kh-stat"><span class="lbl">Open tickets</span><span class="num" id="h-tix">0</span><span class="foot" id="h-tixf"></span></div>'+
   '<div class="kh-stat"><span class="lbl">Activations, 24h</span><span class="num" id="h-act">0</span><div id="h-spark"></div></div>'+
   '<div class="kh-stat"><span class="lbl">Median activation</span><span class="num" id="h-med">0</span><span class="foot" id="h-medf"></span></div>'+
   '<div class="kh-ringbox"><svg class="kh-ring" viewBox="0 0 80 80"><circle class="trk" cx="40" cy="40" r="34"/><circle class="val" id="h-ring" cx="40" cy="40" r="34" stroke-dasharray="213.6" stroke-dashoffset="213.6"/></svg><div class="kh-ringtxt"><b id="h-rust">0%</b><span id="h-rustf">via the Rust runner</span></div></div>')}
  tween($('#h-live'),k.live,v=>Math.round(v));
  setHtml($('#h-mix'),mixW.map(m=>'<span title="'+m[0]+' '+m[1]+'" style="flex-grow:'+(m[1]||0)+';background:'+m[2]+'"></span>').join(''));
  $('#h-livef').textContent=mixW.filter(m=>m[1]).map(m=>m[1]+' '+m[0]).join(' · ')||'idle';
  const dec=$('#h-dec');tween(dec,k.decisionsPending,v=>Math.round(v));dec.classList.toggle('alert',k.decisionsPending>0);
  $('#h-decf').textContent=k.decisionsPending?'owner decisions pending':'nothing pending';
  tween($('#h-tix'),k.openTickets,v=>Math.round(v));$('#h-tixf').textContent=k.prsOpen+' open PR'+(k.prsOpen===1?'':'s')+(k.prsRed?', '+k.prsRed+' red':'');
  tween($('#h-act'),k.activations24h,v=>Math.round(v));setHtml($('#h-spark'),spark(tot,'var(--accent)'));
  tween($('#h-med'),Math.round((k.medianActivationMs||0)/1000),v=>Math.round(v)+'s');$('#h-medf').textContent=k.successRate24h!=null?Math.round(k.successRate24h*100)+'% ok · p90 '+dur(k.p90ActivationMs):'';
  const share=k.rustShareSinceCutover;$('#h-ring').style.strokeDashoffset=String(213.6*(1-(share||0)));
  tween($('#h-rust'),Math.round((share||0)*100),v=>Math.round(v)+'%');setHtml($('#h-rustf'),'via the Rust runner<br>'+(k.rustSince?'since cutover '+ago(k.rustSince):'not yet live'));
}
function chart(b){const el=$('#kh-chart');
  const tot=RUN.concat(['other']).map(r=>[r,b.reduce((a,x)=>a+(x[r]||0),0)]);
  setHtml($('#kh-legend'),tot.filter(t=>t[1]>0||t[0]!=='other').map(t=>'<span><i style="background:var(--run-'+t[0]+')"></i>'+RL[t[0]]+' <em>'+t[1]+'</em></span>').join('')+'<span class="kh-muted">'+b.reduce((a,x)=>a+x.failed,0)+' not ok</span>');
  if(table){setHtml(el,'<div class="kh-rows">'+b.slice().reverse().filter(x=>RUN.some(r=>x[r])).map(x=>'<div class="kh-row" style="grid-template-columns:90px repeat(4,1fr) 80px;cursor:default"><b>'+new Date(x.at).toLocaleTimeString([], {hour:'numeric'})+'</b>'+RUN.map(r=>'<span>'+chip(r)+' '+(x[r]||0)+'</span>').join('')+'<span class="kh-muted">'+x.failed+' not ok</span></div>').join('')+'</div>');return}
  const W=1000,H=210,pl=30,pb=22,pt=10,iw=W-pl,ih=H-pb-pt,n=b.length,bw=iw/n,gap=Math.max(3,bw*.26);
  const sums=b.map(x=>RUN.concat(['other']).reduce((a,r)=>a+(x[r]||0),0));const max=Math.max(4,...sums);const nice=Math.ceil(max/4)*4;const y=v=>pt+ih-(v/nice)*ih;
  let g='';for(const t of [0,nice/2,nice]){g+='<line x1="'+pl+'" x2="'+W+'" y1="'+y(t)+'" y2="'+y(t)+'" stroke="var(--text)" stroke-opacity=".07"/><text x="'+(pl-8)+'" y="'+(y(t)+4)+'" text-anchor="end" font-size="11" fill="var(--text-3)">'+t+'</text>'}
  b.forEach((x,i)=>{const x0=pl+i*bw+gap/2,w=bw-gap;let acc=0;let col='<g class="col" data-i="'+i+'"><rect class="band" x="'+(pl+i*bw)+'" y="'+pt+'" width="'+bw+'" height="'+ih+'" rx="6"/>';
    const segs=RUN.concat(['other']).filter(r=>x[r]);const r4=Math.min(4,w/2);
    segs.forEach((r,j)=>{const v=x[r],top=j===segs.length-1;const y1=y(acc+v),y0=y(acc);acc+=v;const h=Math.max(0,y0-y1-(top?0:2));
      col+=top?'<path class="bar" style="--i:'+i+'" fill="var(--run-'+r+')" d="M'+x0+','+(y1+h)+' V'+(y1+Math.min(r4,h))+' Q'+x0+','+y1+' '+(x0+r4)+','+y1+' H'+(x0+w-r4)+' Q'+(x0+w)+','+y1+' '+(x0+w)+','+(y1+Math.min(r4,h))+' V'+(y1+h)+' Z"/>'
        :'<rect class="bar" style="--i:'+i+'" fill="var(--run-'+r+')" x="'+x0+'" y="'+(y1+2)+'" width="'+w+'" height="'+h+'"/>'});
    if(i%3===0)col+='<text x="'+(x0+w/2)+'" y="'+(H-4)+'" text-anchor="middle" font-size="11" fill="var(--text-3)">'+new Date(x.at).toLocaleTimeString([], {hour:'numeric'})+'</text>';
    g+=col+'</g>'});
  setHtml(el,'<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" role="img" aria-label="Activations per hour by runner, last 24 hours">'+g+'</svg><div class="kh-tip" id="kh-tip"></div>');
  if(first&&!reduce){el.classList.add('grow');setTimeout(()=>el.classList.remove('grow'),1400)}
  const svg=el.querySelector('svg'),tip=$('#kh-tip');
  svg.addEventListener('mousemove',e=>{const c=e.target.closest('.col');svg.querySelectorAll('.col.hot').forEach(x=>x!==c&&x.classList.remove('hot'));if(!c){svg.classList.remove('hovering');tip.classList.remove('on');return}
    c.classList.add('hot');svg.classList.add('hovering');const x=b[+c.dataset.i],t=sums[+c.dataset.i];
    setHtml(tip,'<b>'+new Date(x.at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+' · '+t+' activation'+(t===1?'':'s')+'</b>'+RUN.concat(['other']).filter(r=>x[r]).map(r=>'<div><span><i style="display:inline-block;width:8px;height:8px;border-radius:2.5px;background:var(--run-'+r+')"></i>'+RL[r]+'</span><span>'+x[r]+'</span></div>').join('')+(x.failed?'<div><span>Not ok</span><span>'+x.failed+'</span></div>':'')+(t?'<div><span>Average</span><span>'+dur(x.ms/t)+'</span></div>':''));
    const box=el.getBoundingClientRect();tip.style.left=Math.min(box.width-190,Math.max(0,e.clientX-box.left+14))+'px';tip.style.top=Math.max(0,e.clientY-box.top-30)+'px';tip.classList.add('on')});
  svg.addEventListener('mouseleave',()=>{svg.classList.remove('hovering');svg.querySelectorAll('.col.hot').forEach(x=>x.classList.remove('hot'));tip.classList.remove('on')});
}
function workers(list){const q=F.q.toLowerCase();
  const c={all:list.length,running:0,queued:0,waiting:0,blocked:0};list.forEach(w=>c[w.state]=(c[w.state]||0)+1);
  document.querySelectorAll('#kh-wseg button').forEach(b=>{const v=b.dataset.f.split(':')[1];b.querySelector('.n').textContent=c[v]||0});
  const rows=list.filter(w=>(F.state==='all'||w.state===F.state)&&(F.runner==='all'||w.runner===F.runner)&&(!q||(w.summary+' '+w.ticket+' '+w.kind+' '+w.id).toLowerCase().includes(q))).sort((a,b)=>(ORDER[a.state]??9)-(ORDER[b.state]??9)||(b.updatedAt||0)-(a.updatedAt||0));
  const timer=w=>w.state==='running'&&w.startedAt?'<span class="kh-time" data-since="'+w.startedAt+'">'+dur(Date.now()-w.startedAt)+'</span>':w.wakeAt?'<span class="kh-time muted" data-until="'+w.wakeAt+'">in '+dur(w.wakeAt-Date.now())+'</span>':'<span class="kh-time muted">'+dur(Date.now()-(w.updatedAt||Date.now()))+'</span>';
  setHtml($('#kh-workers'),rows.length?'<div class="kh-head"><span>State</span><span>Work</span><span class="hide-s">Runner</span><span class="r hide-s">Time</span><span></span></div><div class="kh-rows">'+rows.map(w=>'<div class="kh-row'+((w.state==='blocked'||w.state==='queued')&&Date.now()-(w.updatedAt||0)>6*3600000?' stale':'')+'" data-job="'+esc(w.id)+'">'+st(w.state)+'<div class="ttl"><b>'+(w.ticket?'Ticket '+esc(w.ticket):esc(w.kind[0].toUpperCase()+w.kind.slice(1)))+(w.coder?' · coding subworker':'')+(w.decisions.length?' · <span style="color:var(--st-warn)">decision pending</span>':'')+'</b><span>'+esc(w.summary||'No summary yet.')+'</span></div><span class="hide-s kh-cell">'+chip(w.runner)+(w.via==='rust'?'<span class="kh-rust">RUST</span>':'')+'</span><span class="r hide-s">'+timer(w)+'</span>'+go+'</div>').join('')+'</div>':'<div class="kh-pb kh-empty">No workers match these filters.</div>');
}
function pill(t){if(t.category==='incident')return '<span class="kh-pill incident"><i></i>incident</span>';const m={open:'open',triaging:'open',in_progress:'progress',blocked:'blocked',parked:'done',resolved:'done',closed:'done'};return '<span class="kh-pill '+(t.decisionPending?'ask':(m[t.status]||'open'))+'"><i></i>'+esc(t.decisionPending?'needs you':t.status.replace('_',' '))+'</span>'}
function stepper(card){if(!card||!card.items.length)return '<span class="kh-muted" style="font-size:12px">no progress card yet</span>';
  return '<div class="kh-steps">'+card.items.slice(0,3).map(it=>{const idx=it.stage==='confirmed'?4:STAGES.indexOf(it.stage);const cls=it.blocked?'paused':idx>=4?'done':'';return '<div class="kh-step" title="'+esc(it.name+': '+(SL[it.stage]||it.stage)+(it.note?'. '+it.note:''))+'"><div class="kh-track '+cls+'">'+STAGES.map((s,i)=>'<i class="'+(i<=idx?'on':'')+'"></i>').join('')+'</div><span>'+esc(it.blocked?'Paused':SL[it.stage]||it.stage)+'</span></div>'}).join('')+(card.items.length>3?'<span class="kh-note">+'+(card.items.length-3)+' more</span>':'')+'</div>'}
function tickets(rows,prs){const by=Object.fromEntries(prs.map(p=>[p.number,p]));
  const open=rows.filter(t=>!['resolved','closed'].includes(t.status)).sort((a,b)=>(b.decisionPending-a.decisionPending)||(b.createdAt||0)-(a.createdAt||0));
  $('#kh-tcount').textContent=open.length+' open';
  const row=t=>'<div class="kh-row" data-ticket="'+t.number+'"><b class="kh-mono">#'+t.number+'</b><div class="ttl"><b>'+esc(t.title)+'</b><span>'+esc([t.category,t.tags&&t.tags.mood,t.hasImage?'screenshot':null].filter(Boolean).join(' · '))+'</span></div>'+pill(t)+'<div class="hide-s">'+stepper(t.card)+'</div><span class="hide-s">'+(t.active?st(t.active.state):'<span class="kh-muted" style="font-size:12px">idle</span>')+'</span><span class="hide-s" style="display:flex;flex-wrap:wrap;align-items:center">'+t.prs.slice(0,6).map(n=>{const p=by[n];return p?'<a class="kh-ci '+esc(p.ci)+'" href="'+esc(p.url)+'" target="_blank" rel="noopener"><i></i>#'+n+'</a>':''}).join('')+(t.prs.length>6?'<span class="kh-note" style="margin:0 0 4px 2px">+'+(t.prs.length-6)+'</span>':'')+'</span>'+(canMerge(t)?'<button class="kh-mergebtn" data-merge="'+t.number+'" title="Merge into an incident" aria-label="Merge ticket '+t.number+' into an incident"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5v4a3 3 0 0 0 3 3h5"/><path d="M4 13.5v-4"/><path d="M10 7l2.5 2.5L10 12"/></svg></button>':go)+'</div>';
  setHtml($('#kh-tickets'),open.length?'<div class="kh-head"><span>Ticket</span><span>Title</span><span>Status</span><span class="hide-s">Fix progress</span><span class="hide-s">Keir</span><span class="hide-s">PRs</span><span></span></div><div class="kh-rows">'+open.map(row).join('')+'</div>':'<div class="kh-pb kh-empty">No open tickets.</div>');
}
function canMerge(t){return S&&t.category!=='incident'&&t.category!=='moderation'&&S.incidents.some(i=>i.open&&i.number!==t.number)}
function incidents(list){const open=list.filter(i=>i.open);setHtml($('#kh-incn'),open.length?'<span class="kh-count">'+open.length+' open</span>':'');
  const show=open.concat(list.filter(i=>!i.open).slice(0,3));
  setHtml($('#kh-inc'),show.length?show.map(i=>'<div class="kh-inc'+(i.open?'':' closed')+'"><span class="sig"></span><b>#'+i.number+' '+esc(i.title)+'</b><span class="when kh-muted" style="font-size:12px">'+(i.open?esc(i.merged.length+' merged'):esc(i.status))+'</span><span class="meta">'+(i.open?'opened '+ago(i.createdAt)+(i.merged.length?' · latest merge '+ago(Math.max(...i.merged.map(m=>m.mergedAt||0))):''):'')+'</span></div>').join(''):'<div class="kh-pb kh-empty" style="padding-top:2px">No incidents. Staff open one with /ticket when many players hit the same problem.</div>')}
function bars(obj,order,color){const e=Object.entries(obj||{}).sort((a,b)=>order?order.indexOf(a[0])-order.indexOf(b[0]):b[1]-a[1]);const max=Math.max(1,...e.map(x=>x[1]));
  return e.length?e.map(([k,v])=>'<div class="kh-hbar"><span class="k">'+esc(k.replace(/_/g,' '))+'</span><span class="t"><i style="width:'+(100*v/max).toFixed(1)+'%;'+(color?'background:'+color:'')+'"></i></span><span class="v">'+v+'</span></div>').join(''):'<div class="kh-empty" style="padding:6px 0">Nothing yet.</div>'}
function quality(q){const el=$('#kh-quality');if(!q){setHtml(el,'<div class="kh-empty">No shadow pass yet.</div>');return}
  const L={closed_observing:['Closed, watching','var(--accent)'],closed_no_recurrence_7d:['No recurrence 7d','var(--st-good)'],closed_no_recurrence_14d:['No recurrence 14d','color-mix(in srgb,var(--st-good) 70%,#000)'],closed_externally:['Closed by staff','var(--text-3)'],reopened:['Reopened','var(--st-warn)'],recurrence_confirmed:['Recurred','var(--st-crit)'],open:['Open','color-mix(in srgb,var(--text) 25%,transparent)']};
  const tot=Object.values(q.labels||{}).reduce((a,b)=>a+b,0)||1;
  setHtml(el,'<div class="kh-mstats"><div class="kh-mstat"><span>Time to closure</span><b>'+dur(q.time_to_closure.median_ms)+'</b><em>p90 '+dur(q.time_to_closure.p90_ms)+'</em></div><div class="kh-mstat"><span>Decision latency</span><b>'+dur(q.decision_latency.median_ms)+'</b><em>p90 '+dur(q.decision_latency.p90_ms)+'</em></div><div class="kh-mstat"><span>Tickets closed</span><b>'+q.closed+'</b><em>of '+q.tickets+'</em></div><div class="kh-mstat"><span>Unanswered asks</span><b>'+q.decisions_unanswered+'</b><em>oldest open '+dur(q.oldest_open_age_ms)+'</em></div></div>'+
   '<div class="kh-stack100">'+Object.entries(q.labels||{}).map(([k,v])=>'<span title="'+esc((L[k]||[k])[0]+' '+v)+'" style="flex-grow:'+v+';background:'+((L[k]||[0,'var(--text-3)'])[1])+'"></span>').join('')+'</div><div class="kh-keys">'+Object.entries(q.labels||{}).map(([k,v])=>'<span><i style="background:'+((L[k]||[0,'var(--text-3)'])[1])+'"></i>'+esc((L[k]||[k])[0])+' '+Math.round(100*v/tot)+'%</span>').join('')+'</div>')}
function jev(j){setHtml($('#kh-jev'),'<div class="kh-sub2" style="margin-top:0">Kind of request · '+j.tagged+' read</div>'+bars(j.tags.kind)+'<div class="kh-sub2">Mood</div>'+bars(j.tags.mood,['calm','annoyed','frustrated','angry'],'var(--st-warn)')+(j.injections?'<div class="kh-note" style="margin-top:8px">'+j.injections+' request'+(j.injections===1?'':'s')+' tried to instruct Keir; treated as evidence only.</div>':''));
  setHtml($('#kh-screen'),'<div class="kh-mstats" style="margin-bottom:6px"><div class="kh-mstat"><span>Posts screened</span><b>'+j.screened+'</b></div><div class="kh-mstat"><span>Refused as leaks</span><b>'+j.refused+'</b></div></div><div class="kh-sub2">Flags raised</div>'+bars(Object.fromEntries(Object.entries(j.labels).map(([k,v])=>[{leaksInternals:'internals leak',certaintyWithoutReceipt:'claim without receipt',talksPast:'talks past player',tone:'tone'}[k]||k,v])),null,'var(--st-serious)'))}
function runs(list){const r=list.slice(0,10);setHtml($('#kh-runs'),r.length?'<div class="kh-head"><span>When</span><span>Task</span><span>Model</span><span class="r">Time</span><span class="r">Tools</span><span></span></div><div class="kh-rows">'+r.map(a=>{const bad=a.timed_out||(a.exit_code!=null&&a.exit_code!==0);const prov=(a.provider||'').toLowerCase();
  return '<div class="kh-row" data-attempt="'+esc(a.id)+'"><span class="kh-time muted">'+ago(a.started_at).replace(' ago','')+'</span><div class="ttl"><b>'+esc(a.label||a.task_id)+'</b><span><span class="kh-exit'+(bad?' bad':a.quota_hold?' slow':'')+'"><i></i>'+(a.timed_out?'timed out':a.quota_hold?'quota hold':bad?'exit '+a.exit_code:'ok')+'</span></span></div><span class="kh-cell">'+chip(prov==='claude'||prov==='codex'||prov==='muse'?prov:prov==='antigravity'?'agy':'other')+'<span class="kh-muted" style="font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc((a.model||'').replace(/^claude-|^muse-|^gpt-/,''))+'</span></span><span class="r kh-time">'+dur(a.duration_ms)+'</span><span class="r kh-time">'+(a.tool_calls||0)+'</span>'+go+'</div>'}).join('')+'</div>':'<div class="kh-pb kh-empty">No Rust runner attempts in 24 hours.</div>')}
async function attemptDrawer(id){try{const r=await fetch('/api/keir/hub/attempt/'+encodeURIComponent(id),{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const a=await r.json();
  $('#kh-dt').textContent='Runner attempt';setHtml($('#kh-dm'),chip((a.provider||'').toLowerCase()==='antigravity'?'agy':(a.provider||'').toLowerCase())+'<span class="kh-chip">'+esc(a.model||'')+'</span><span class="kh-chip">'+dur(a.duration_ms)+'</span><span class="kh-chip">'+(a.tool_calls||0)+' tool calls</span>');
  setHtml($('#kh-db'),'<div class="kh-sec"><h4>Task</h4><p>'+esc(a.label||a.task_id)+' <span class="kh-mono kh-muted">'+esc(a.id)+'</span></p></div>'+(a.final_text?'<div class="kh-sec"><h4>Final answer</h4><p>'+esc(a.final_text.slice(0,1600))+'</p></div>':'')+(()=>{const n=a.events.filter(e=>e.text||e.tool||e.kind==='tool_use'||e.kind==='error').length,q=a.events.length-n;return '<div class="kh-sec"><h4>Trace · '+n+' steps'+(q?', '+q+' status events hidden':'')+'</h4>'})()+a.events.filter(e=>e.text||e.tool||e.kind==='tool_use'||e.kind==='error').slice(0,160).map(e=>'<div class="kh-ev"><span class="k '+esc(e.kind)+'">'+(e.tool?esc(e.tool):esc(e.kind.replace('_',' ')))+'</span><p>'+esc((e.text||(e.kind==='tool_use'?'called a harness tool':'')).slice(0,500))+'</p></div>').join('')+'</div>');
  $('#kh-drawer').classList.add('open');$('#kh-scrim').classList.add('on')}catch(e){toast('Could not load that attempt: '+e.message,'bad')}}
function toast(text,kind){const t=document.createElement('div');t.className='kh-toast '+(kind||'');setHtml(t,'<i></i><span>'+esc(text)+'</span>');$('#kh-toasts').appendChild(t);setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),300)},kind==='bad'?7000:4200)}
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'ops-dashboard'},body:JSON.stringify(body||{})});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||('HTTP '+r.status));return j}
let popFor=null;function openPop(btn,n){const open=S.incidents.filter(i=>i.open&&i.number!==n);popFor=n;$('#kh-popt').textContent='Merge ticket #'+n+' into an incident';setHtml($('#kh-popi'),open.map(i=>'<option value="'+i.number+'">#'+i.number+' '+esc(i.title)+'</option>').join(''));$('#kh-popr').value='';
  const b=btn.getBoundingClientRect(),pop=$('#kh-pop');pop.style.top=Math.min(innerHeight-260,b.bottom+8)+'px';pop.style.left=Math.max(12,b.right-320)+'px';pop.classList.add('on');setTimeout(()=>$('#kh-popr').focus(),50)}
function closePop(){$('#kh-pop').classList.remove('on');popFor=null}
function prList(prs){const r=prs.filter(p=>F.prs==='all'||(F.prs==='open'?p.state==='OPEN':p.state==='MERGED')).slice(0,12);
  setHtml($('#kh-prs'),r.length?'<div class="kh-head"><span>PR</span><span>Title</span><span>CI</span><span>Ticket</span><span class="r">Updated</span></div><div class="kh-rows">'+r.map(p=>'<a class="kh-row" style="text-decoration:none;color:inherit" href="'+esc(p.url)+'" target="_blank" rel="noopener"><b class="kh-mono">#'+p.number+'</b><div class="ttl"><b>'+esc(p.title)+'</b><span>'+esc(p.state.toLowerCase())+(p.draft?' · draft':'')+'</span></div><span class="kh-ci '+esc(p.ci)+'"><i></i>'+esc(p.ci)+'</span><span class="kh-mono kh-muted">'+(p.ticket?'#'+p.ticket:'')+'</span><span class="r kh-muted" style="font-size:12px" data-ago="'+p.updatedAt+'">'+ago(p.updatedAt)+'</span></a>').join('')+'</div>':'<div class="kh-pb kh-empty">No '+(F.prs==='all'?'':F.prs+' ')+'Keir pull requests.</div>');
}
function side(s){
  setHtml($('#kh-asks'),s.decisions.length?s.decisions.map(x=>'<div class="kh-ask"><span class="ico"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v6M8 12.2v.3"/></svg></span><div><b style="font-size:13px">'+(x.ticket?'Ticket '+x.ticket:'Request')+'</b> <span class="kh-muted" style="font-size:12px">'+ago(x.at)+(x.escalatedAt?' · sent to the delegate':'')+'</span><p style="margin:4px 0 0;font-size:13px;line-height:1.5">'+esc(x.tldr)+'</p></div></div>').join(''):'<div class="kh-pb kh-empty" style="padding-top:2px">Nothing is waiting on you.</div>');
  const sh=s.shadow;setHtml($('#kh-shadow'),sh?'<dl class="kh-kv">'+sh.agreement.map(a=>'<dt>'+esc(a.kind.replace('-',' '))+'</dt><dd>'+a.agreed+' / '+a.total+'</dd>').join('')+'<dt>Review queue</dt><dd>'+sh.review+'</dd><dt>Last pass</dt><dd data-ago="'+sh.at+'">'+ago(sh.at)+'</dd></dl><p style="margin:12px 0 0"><a class="kh-a" href="/reports/keir-4-shadow" style="font-size:12.5px;color:var(--accent)">Full shadow report</a></p>':'<div class="kh-empty">No shadow pass yet.</div>');
  const kb=s.kanban.filter(k=>!k.error),kbo=kb.filter(k=>k.lane!=='done'),kbs=F.kb?kb:kbo.slice(0,8);
  setHtml($('#kh-kb'),kbs.map(k=>'<div class="kh-item"><b>'+esc(k.title)+'</b><span class="when">'+esc(k.lane)+'</span><span class="meta">'+esc([k.assigned_to,k.needs_owner?'needs owner':null,'#'+k.id].filter(Boolean).join(' · '))+'</span></div>').join('')||'<div class="kh-pb kh-empty">No matching kanban items.</div>');
  setHtml($('#kh-kbm'),kb.length>kbs.length||F.kb?'<button class="kh-more" data-t="kb">'+(F.kb?'Open only':'Show all '+kb.length)+'</button>':'');
  setHtml($('#kh-iss'),s.issues.length?s.issues.map(i=>'<a class="kh-item" style="text-decoration:none;color:inherit" href="'+esc(i.html_url)+'" target="_blank" rel="noopener"><b>#'+i.number+' '+esc(i.title||'')+'</b><span class="when">'+esc(i.state)+'</span><span class="meta">from PR '+i.from.map(n=>'#'+n).join(', ')+'</span></a>').join(''):'<div class="kh-pb kh-empty" style="padding-top:2px">No issues referenced by Keir PRs.</div>');
  const rec=F.rec?s.recent:s.recent.slice(0,6);
  setHtml($('#kh-rec'),rec.map(j=>'<div class="kh-item" data-job="'+esc(j.id)+'" style="cursor:pointer"><b>'+(j.ticket?'Ticket '+j.ticket:esc(j.kind))+(j.coder?' · coder':'')+'</b><span class="when" data-ago="'+j.updatedAt+'">'+ago(j.updatedAt)+'</span><span class="meta">'+esc(j.summary.slice(0,150))+'</span></div>').join('')||'<div class="kh-pb kh-empty">Nothing finished in six hours.</div>');
  setHtml($('#kh-recm'),s.recent.length>6?'<button class="kh-more" data-t="rec">'+(F.rec?'Fewer':'Show all '+s.recent.length)+'</button>':'');
}
function drawer(id){const w=S.workers.concat(S.recent).find(x=>x.id===id);if(!w)return;const prs=S.prs.filter(p=>p.job===w.id||(w.ticket&&p.ticket===w.ticket));
  $('#kh-dt').textContent=w.ticket?'Ticket '+w.ticket:w.kind[0].toUpperCase()+w.kind.slice(1);
  setHtml($('#kh-dm'),st(TERMINAL(w.state)?'done':w.state)+chip(w.runner)+(w.via==='rust'?'<span class="kh-rust">RUST</span>':'')+(w.effort?'<span class="kh-chip">'+esc(w.effort)+'</span>':''));
  setHtml($('#kh-db'),'<div class="kh-sec"><h4>Summary</h4><p>'+esc(w.summary||'No summary yet.')+'</p></div>'+
   (w.decisions.length?'<div class="kh-sec"><h4>Waiting on you</h4>'+w.decisions.map(x=>'<p>'+esc(x.tldr)+' <span class="kh-note">'+ago(x.at)+'</span></p>').join('')+'</div>':'')+
   '<div class="kh-sec"><h4>Details</h4><dl class="kh-kv"><dt>Model</dt><dd>'+esc(w.model||'n/a')+'</dd><dt>Rounds</dt><dd>'+w.rounds+'</dd><dt>Last activity</dt><dd>'+ago(w.updatedAt)+'</dd>'+(w.wakeAt?'<dt>Wakes</dt><dd>in '+dur(w.wakeAt-Date.now())+'</dd>':'')+(w.tags?'<dt>Read as</dt><dd>'+esc([w.tags.kind,w.tags.mood,w.tags.urgency].filter(Boolean).join(', '))+'</dd>':'')+'<dt>Job</dt><dd class="kh-mono">'+esc(w.id)+'</dd>'+(w.attempt?'<dt>Rust attempt</dt><dd class="kh-mono">'+esc(w.attempt.slice(0,20))+'</dd>':'')+'</dl></div>'+
   (prs.length?'<div class="kh-sec"><h4>Pull requests</h4>'+prs.map(p=>'<a class="kh-ci '+esc(p.ci)+'" href="'+esc(p.url)+'" target="_blank" rel="noopener"><i></i>#'+p.number+'</a>').join('')+'</div>':'')+
   '<div class="kh-sec"><h4>Recent activity</h4><div class="kh-tl">'+(w.history.length?w.history.slice().reverse().map(h=>'<div><div class="k">'+esc(h.kind)+(h.state?' · '+esc(h.state):'')+' · '+ago(typeof h.at==='number'?h.at:Date.parse(h.at))+'</div><p>'+esc(h.summary)+'</p></div>').join(''):'<div><p>No history yet.</p></div>')+'</div></div>');
  $('#kh-drawer').classList.add('open');$('#kh-scrim').classList.add('on')}
function TERMINAL(s){return ['done','dismissed','cancelled'].includes(s)}
function closeDrawer(){$('#kh-drawer').classList.remove('open');$('#kh-scrim').classList.remove('on')}
// ---- live layer: sentence, orbs, timeline, feed, journey ----
const CATC={fail:'var(--st-crit)',ship:'var(--st-good)',code:'var(--accent)',talk:'var(--text-2)',intake:'var(--text-3)',ask:'var(--st-warn)',yes:'var(--st-good)',no:'var(--st-crit)',guard:'var(--st-serious)',learn:'var(--text-3)',incident:'var(--st-crit)'};
const CATL={run:'Activation',ship:'Shipped',code:'Code',talk:'Talked to a player',intake:'Picked up',ask:'Asked you',yes:'Approved',no:'Declined',guard:'Held or refused',learn:'Learned',incident:'Incident',fail:'Failed'};
const GLY={
  run:'<rect x="1" y="4" width="10" height="4" rx="2" fill="currentColor"/>',
  fail:'<path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ship:'<path d="M6 1l5 5-5 5-5-5z" fill="currentColor"/>',
  code:'<rect x="2" y="2" width="8" height="8" rx="2" fill="currentColor"/>',
  talk:'<path d="M2.5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H6l-2.5 2V9h-1A1.5 1.5 0 0 1 1 7.5V4a1.5 1.5 0 0 1 1.5-1.5z" fill="currentColor"/>',
  intake:'<circle cx="6" cy="6" r="3.8" fill="none" stroke="currentColor" stroke-width="2"/>',
  ask:'<circle cx="6" cy="6" r="4.5" fill="currentColor"/>',
  yes:'<path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  no:'<path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  guard:'<path d="M6 1.5l5 9H1z" fill="currentColor"/>',
  learn:'<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  incident:'<path d="M6 1l5 5-5 5-5-5z" fill="currentColor"/>'};
const catColor=e=>e.cat==='run'?'var(--run-'+(RUN.includes(e.runner)?e.runner:'other')+')':(CATC[e.cat]||'var(--text-3)');
const glyph=(cat,size)=>'<svg viewBox="0 0 12 12" width="'+(size||12)+'" height="'+(size||12)+'">'+(GLY[cat]||GLY.intake)+'</svg>';
const seen={feed:new Set(),marks:new Set(),steps:new Set()};const sig={};
const same=(k,v)=>{const j=JSON.stringify(v);if(sig[k]===j)return true;sig[k]=j;return false};
const nameOf=w=>w.ticket?'ticket '+w.ticket:w.coder?'a coding task':'a '+(w.kind||'job');
const tm=t=>new Date(t).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
function bump(el,d){const host=el.closest('.kh-stat,.kh-ringbox');if(!host)return;host.classList.remove('bumped');void host.offsetWidth;host.classList.add('bumped');
  const b=document.createElement('span');b.className='kh-delta '+(d>0?'up':'down');b.textContent=(d>0?'+':'')+Math.round(d);host.appendChild(b);setTimeout(()=>b.remove(),1800)}

function say(){const W=S.workers,run=W.filter(w=>w.state==='running'),wait=W.filter(w=>w.state==='waiting'&&w.wakeAt).sort((a,b)=>a.wakeAt-b.wakeAt),q=W.filter(w=>w.state==='queued'),dec=S.decisions;
  let a,b='';
  if(S.paused){a='Keir is paused.';b='Nothing runs until the operator resumes.'}
  else if(run.length){const w=run[0],t=(S.live||[])[0];a='Keir is working on '+nameOf(w)+(run.length>1?' and '+(run.length-1)+' more':'')+'.';
    b=chip(w.runner)+(w.model?'<span class="kh-muted">'+esc(w.model)+'</span>':'')+(w.startedAt?'<span class="kh-time" data-since="'+w.startedAt+'">'+dur(Date.now()-w.startedAt)+'</span>':'')+(t?'<span class="kh-muted">'+t.calls+' tool call'+(t.calls===1?'':'s')+'</span>':'')}
  else if(dec.length){a='Keir is waiting on you.';b=dec.length+' decision'+(dec.length===1?'':'s')+' open, oldest from '+ago(Math.min(...dec.map(x=>x.at)))+'.'}
  else if(wait.length){const w=wait[0];a='Keir is between steps.';b='Next it checks '+nameOf(w)+' <span class="kh-time" data-until="'+w.wakeAt+'">in '+dur(w.wakeAt-Date.now())+'</span>'+(wait.length>1?'<span class="kh-muted">then '+(wait.length-1)+' more</span>':'')}
  else if(q.length){a=q.length+' job'+(q.length===1?'':'s')+' queued.';b='They start as soon as a slot frees.'}
  else{a='Keir is idle.';b='Nothing live. New tickets wake it.'}
  if(dec.length&&!a.includes('on you'))b+='<span class="kh-pill ask"><i></i>'+dec.length+' waiting on you</span>';
  const s1=$('#kh-say1');if(s1.dataset.t!==a){s1.dataset.t=a;s1.textContent=a;if(!first&&!reduce){s1.classList.remove('swap');void s1.offsetWidth;s1.classList.add('swap')}}
  setHtml($('#kh-say2'),b);const last=S.stream.feed[0];setHtml($('#kh-say3'),last?'Last action <b>'+esc(last.text)+'</b>, <span data-ago="'+last.at+'">'+ago(last.at)+'</span>':'')}

function orbs(){const now=Date.now(),rank={running:0,ask:1,queued:2,waiting:3,blocked:4};
  const list=S.workers.filter(w=>!(w.state==='blocked'&&(w.coder||now-(w.updatedAt||0)>24*3600000))).map(w=>({w,s:w.decisions.length?'ask':w.state})).sort((a,b)=>(rank[a.s]??9)-(rank[b.s]??9)||(a.w.wakeAt||0)-(b.w.wakeAt||0));
  const old=S.workers.length-list.length,show=list.slice(0,8);
  setHtml($('#kh-orbs'),show.map(({w,s})=>{const c=s==='running'?'var(--run-'+(RUN.includes(w.runner)?w.runner:'other')+')':s==='ask'?'var(--st-warn)':s==='blocked'?'var(--st-crit)':s==='queued'?'var(--accent)':'var(--text-2)';
    const frac=s==='waiting'&&w.wakeAt?Math.max(0,Math.min(1,(w.wakeAt-now)/Math.max(1,w.wakeAt-(w.updatedAt||now)))):s==='running'?.28:1;
    const n=w.ticket?String(w.ticket):({coding:'code',command:'cmd',conversation:'chat',probe:'probe'}[w.kind]||w.kind.slice(0,4));
    const t=s==='running'&&w.startedAt?'<span class="t" data-since="'+w.startedAt+'">'+dur(now-w.startedAt)+'</span>':s==='waiting'&&w.wakeAt?'<span class="t" data-until="'+w.wakeAt+'">in '+dur(w.wakeAt-now)+'</span>':'<span class="t">'+(s==='ask'?'needs you':s)+'</span>';
    return '<button class="kh-orb s-'+s+'" data-job="'+esc(w.id)+'" style="--c:'+c+'" title="'+esc((w.ticket?'Ticket '+w.ticket:w.kind)+': '+(w.summary||s))+'"><span class="ring"><svg viewBox="0 0 52 52"><circle class="trk" cx="26" cy="26" r="22"/><circle class="arc" cx="26" cy="26" r="22" pathLength="100" stroke-dasharray="'+(frac*100).toFixed(1)+' 100"'+(s==='waiting'&&w.wakeAt?' data-wake="'+w.wakeAt+'" data-from="'+(w.updatedAt||now)+'"':'')+'/></svg><span class="n">'+esc(n)+'</span></span><span class="l">'+esc(w.ticket?'Ticket':w.coder?'Coding':w.kind[0].toUpperCase()+w.kind.slice(1))+'</span>'+t+'</button>'}).join('')+(old?'<span class="kh-orbmore">+'+old+' blocked<br>coding or stale</span>':''))}

function tail(){const el=$('#kh-tail'),L=S.live||[];if(!L.length){setHtml(el,'');el.hidden=true;return}el.hidden=false;
  setHtml(el,L.map(a=>{const prov=(a.provider||'').toLowerCase();return '<div class="kh-tailrow"><div class="hd">'+st('running')+'<b>'+esc(a.label)+'</b>'+chip(prov==='antigravity'?'agy':prov)+'<span class="kh-muted">'+esc(a.model||'')+'</span><span class="kh-time" data-since="'+a.startedAt+'">'+dur(Date.now()-a.startedAt)+'</span><span class="kh-muted">'+a.calls+' tool calls</span></div><div class="steps">'+a.steps.filter(x=>x.tool).map(x=>{const k=a.id+':'+x.at+':'+x.tool,f=!first&&!seen.steps.has(k);seen.steps.add(k);return '<span class="kh-step2'+(f?' fresh':'')+'">'+esc(x.tool)+'</span>'}).join('')+'</div>'+((a.steps.filter(x=>x.text).slice(-1)[0]||{}).text?'<p class="said">'+esc(a.steps.filter(x=>x.text).slice(-1)[0].text)+'</p>':'')+'</div>'}).join(''))}

let WIN=innerWidth<600?3600000:3*3600000,laneFocus=null;
function lanes(grow){const box=$('#kh-lanes');const W=Math.max(260,box.clientWidth),narrow=W<560;const now=Date.now(),fut=Math.max(10*60000,WIN*.14),t0=now-WIN,t1=now+fut;
  const live=new Set(['running','queued','waiting','blocked']);
  const L=S.stream.lanes.filter(l=>live.has(l.state)||l.spans.some(s=>s.to>=t0)||l.marks.some(m=>m.at>=t0)).slice(0,WIN>3*3600000?14:10);
  const lx=narrow?84:132,px=W-lx-8,x=t=>lx+(Math.max(t0,Math.min(t1,t))-t0)/(t1-t0)*px,rowH=34,top=28,H=top+Math.max(1,L.length)*rowH+6;
  const step=[600000,900000,1800000,3600000,7200000,14400000].find(s=>s/(t1-t0)*px>=(narrow?58:64))||14400000;
  let g='<rect x="'+x(now)+'" y="'+(top-6)+'" width="'+(x(t1)-x(now))+'" height="'+(H-top+6)+'" fill="var(--text)" opacity=".035" rx="6"/>';
  for(let t=Math.ceil(t0/step)*step;t<=t1;t+=step){if(Math.abs(x(t)-x(now))<34)continue;g+='<line x1="'+x(t)+'" x2="'+x(t)+'" y1="'+(top-4)+'" y2="'+H+'" stroke="var(--text)" stroke-opacity=".06"/><text x="'+x(t)+'" y="'+(top-12)+'" text-anchor="middle" font-size="11" fill="var(--text-3)">'+tm(t)+'</text>'}
  let mi=0;
  L.forEach((l,i)=>{const y=top+i*rowH+rowH/2;const dc=l.state==='running'?'var(--st-good)':l.state==='blocked'?'var(--st-crit)':l.state==='queued'?'var(--accent)':'var(--text-3)';
    const lbl=l.ticket?(l.coder?'Code, ':'Ticket ')+l.ticket:l.coder?'Coding task':l.kind[0].toUpperCase()+l.kind.slice(1);
    let r='<g class="ln" data-job="'+esc(l.id)+'"><rect class="lnbg" x="0" y="'+(y-rowH/2)+'" width="'+W+'" height="'+rowH+'" rx="8"/>';
    r+='<circle cx="9" cy="'+y+'" r="4" fill="'+(['done','dismissed','cancelled'].includes(l.state)?'none':dc)+'" stroke="'+dc+'" stroke-width="1.6"'+(l.state==='running'?' class="livecap"':'')+'/><text x="20" y="'+(y+4)+'" font-size="'+(narrow?11.5:12.5)+'" font-weight="600" fill="var(--text)">'+esc(narrow?lbl.replace('Ticket ','#').replace('Coding task','Code').replace('Code, ','Code #'):lbl)+'</text>';
    const from=Math.max(t0,l.firstAt||t0),end=l.state==='running'||live.has(l.state)?now:Math.max(...l.spans.map(s=>s.to),...l.marks.map(m=>m.at),from);
    if(end>from)r+='<line x1="'+x(from)+'" x2="'+x(end)+'" y1="'+y+'" y2="'+y+'" stroke="var(--text)" stroke-opacity=".14" stroke-width="2" stroke-linecap="round"/>';
    if(l.state==='waiting'&&l.wakeAt){const wx=x(l.wakeAt);r+='<line x1="'+x(now)+'" x2="'+wx+'" y1="'+y+'" y2="'+y+'" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="3 4"/>'+(l.wakeAt<=t1||narrow?'<circle cx="'+wx+'" cy="'+y+'" r="4.5" fill="var(--surface)" stroke="var(--text-2)" stroke-width="1.6" data-tip="Wakes at '+tm(l.wakeAt)+'"/>':'<text x="'+(W-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="11" fill="var(--text-3)">wakes '+esc(tm(l.wakeAt))+'</text>')}
    l.spans.filter(s=>s.to>=t0).forEach(s=>{const x0=x(s.from),w=Math.max(3,x(s.to)-x0);r+='<rect class="sp" style="--i:'+i+'" x="'+x0+'" y="'+(y-6)+'" width="'+w+'" height="12" rx="4" fill="var(--run-'+(RUN.includes(s.runner)?s.runner:'other')+')"'+(s.ok?'':' stroke="var(--st-crit)" stroke-width="2"')+' data-tip="'+esc((s.ok?'Worked ':'Did not finish after ')+dur(s.to-s.from)+(s.model?', '+s.model:'')+' · '+tm(s.to))+'"/>'});
    if(l.state==='running'&&l.startedAt){const x0=x(l.startedAt);r+='<rect class="sp live" data-live-from="'+l.startedAt+'" x="'+x0+'" y="'+(y-6)+'" width="'+Math.max(3,x(now)-x0)+'" height="12" rx="4" fill="var(--run-'+(RUN.includes(l.runner)?l.runner:'other')+')" opacity=".85" data-tip="Running since '+tm(l.startedAt)+'"/><circle class="livecap" cx="'+x(now)+'" cy="'+y+'" r="5" fill="var(--run-'+(RUN.includes(l.runner)?l.runner:'other')+')"/>'}
    l.marks.filter(m=>m.at>=t0).forEach(m=>{const mx=x(m.at),f=!grow&&!first&&!seen.marks.has(m.id);seen.marks.add(m.id);const c=CATC[m.cat]||'var(--text-3)';
      r+='<g class="mk'+(f?' fresh':'')+'" data-mark="'+esc(m.id)+'" style="--i:'+(mi++%40)+';color:'+c+'" data-tip="'+esc(tm(m.at)+' · '+m.text)+'"><circle cx="'+mx+'" cy="'+y+'" r="7" fill="var(--surface)"/><svg x="'+(mx-5)+'" y="'+(y-5)+'" width="10" height="10" viewBox="0 0 12 12">'+(GLY[m.cat]||GLY.intake)+'</svg>'+(f?'<circle class="rip" cx="'+mx+'" cy="'+y+'" r="6" stroke="'+c+'"/>':'')+'</g>'});
    g+=r+'</g>'});
  g+='<line x1="'+x(now)+'" x2="'+x(now)+'" y1="'+(top-8)+'" y2="'+H+'" stroke="var(--accent)" stroke-width="1.5"/><rect x="'+(x(now)-17)+'" y="'+(top-24)+'" width="34" height="16" rx="8" fill="var(--accent)"/><text x="'+x(now)+'" y="'+(top-12.5)+'" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--on-accent,#fff)">now</text>';
  setHtml(box,(L.length?'':'<div class="kh-empty" style="position:absolute;left:150px;top:40px">Nothing ran in this window.</div>')+'<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'+g+'</svg>');
  box.classList.toggle('grow',Boolean(grow)&&!reduce);if(grow&&!reduce)setTimeout(()=>box.classList.remove('grow'),1600);
  $('#kh-lanesn').textContent=(S.stream.hiddenLanes?S.stream.hiddenLanes+' quieter jobs not shown':'');if(laneFocus)focusLane(laneFocus)}
function focusLane(job,mark){laneFocus=job;const svg=$('#kh-lanes svg');if(!svg)return;svg.classList.toggle('focusing',Boolean(job));svg.querySelectorAll('.ln').forEach(g=>g.classList.toggle('focus',g.dataset.job===job));svg.querySelectorAll('.mk.hot').forEach(m=>m.classList.remove('hot'));if(mark){const m=svg.querySelector('[data-mark="'+CSS.escape(mark)+'"]');if(m)m.classList.add('hot')}}

function feed(){const list=S.stream.feed.slice(0,60);$('#kh-feedn').textContent=S.stream.feed.length+' in 12 hours';
  let day='';const h=list.map(e=>{const f=!first&&!seen.feed.has(e.id);seen.feed.add(e.id);const d=new Date(e.at).toDateString(),sep=d!==day&&day?'<div class="kh-fday">'+new Date(e.at).toLocaleDateString([],{weekday:'long'})+'</div>':'';day=d;
    return sep+'<div class="kh-fi'+(f?' fresh':'')+'"'+(e.job?' data-job="'+esc(e.job)+'"':'')+' data-fmark="'+esc(e.id)+'"><span class="g" style="--g:'+catColor(e)+'">'+glyph(e.cat)+'</span><div><p>'+esc(e.text)+'</p><span>'+tm(e.at)+' · <span data-ago="'+e.at+'">'+ago(e.at)+'</span>'+(e.model?' · '+esc(e.model):'')+'</span></div></div>'}).join('');
  setHtml($('#kh-feed'),h||'<div class="kh-empty" style="padding:12px">Nothing in twelve hours.</div>')}

const JST=['new','found','written','tested','sandbox','main','closed'];const JL={new:'New',found:'Cause found',written:'Fix written',tested:'Tested on dev',sandbox:'On the sandbox',main:'Live',closed:'Closed, 24h'};
function stationOf(t){if(['resolved','closed'].includes(t.status))return 'closed';const it=(t.card&&t.card.items)||[];if(!it.length)return 'new';let m=9;it.forEach(i=>{const k=i.stage==='confirmed'?4:STAGES.indexOf(i.stage);if(k>=0&&k<m)m=k});return m===9?'new':STAGES[m]}
function token(t,st){const it=(t.card&&t.card.items)||[],live=it.filter(i=>i.stage==='main'||i.stage==='confirmed').length,blocked=it.some(i=>i.blocked);
  const a=t.active,s=t.decisionPending?'ask':a?a.state:'idle';
  const foot=s==='ask'?'<span style="color:var(--st-warn)">needs you</span>':a&&a.state==='waiting'&&a.wakeAt?'<span>checks <span data-until="'+a.wakeAt+'">in '+dur(a.wakeAt-Date.now())+'</span></span>':'<span>'+esc(st==='closed'?t.status:s)+'</span>';
  return '<button class="kh-tok'+(st==='closed'?' closed':'')+(s==='ask'?' ask':'')+'" data-key="t'+t.number+'" data-ticket="'+t.number+'" title="'+esc(it.map(i=>i.name+': '+(SL[i.stage]||i.stage)+(i.blocked?' (paused)':'')).join('\n')||t.title)+'"><span class="top"><b>#'+t.number+'</b>'+(t.category==='incident'?'<span class="kh-pill incident"><i></i>incident</span>':a&&st!=='closed'?'<span class="kh-st '+esc(a.state)+'">'+(ICON[a.state]||'')+'</span>':'')+'</span><p>'+esc(t.title)+'</p>'+
    (it.length?'<span class="fx">'+it.map(i=>{const k=i.stage==='confirmed'?4:STAGES.indexOf(i.stage);return '<i class="'+(i.blocked?'paused':k>=4?'done':k>=0?'on':'')+'" style="--p:'+((k+1)/5)+'"></i>'}).join('')+'</span>':'')+
    '<span class="ft">'+foot+'<span>'+(it.length>1?live+' of '+it.length+' live':blocked?'paused':'')+(t.prs.length?' · '+t.prs.length+' PR'+(t.prs.length===1?'':'s'):'')+'</span></span></button>'}
function journey(){const el=$('#kh-journey');const now=Date.now();
  const open=S.tickets.filter(t=>!['resolved','closed'].includes(t.status)),closed=S.tickets.filter(t=>['resolved','closed'].includes(t.status)&&t.lastKeirAt&&now-t.lastKeirAt<86400000).sort((a,b)=>b.lastKeirAt-a.lastKeirAt);
  const by={};JST.forEach(s=>by[s]=[]);open.forEach(t=>by[stationOf(t)].push(t));by.closed=closed;
  if(same('journey',[open,closed.map(t=>t.number)])&&!first)return;
  const prev={};el.querySelectorAll('[data-key]').forEach(e=>prev[e.dataset.key]=e.getBoundingClientRect());
  const furthest=JST.reduce((m,s,i)=>by[s].length&&s!=='closed'?i:m,-1);
  setHtml(el,'<div class="kh-jgrid">'+JST.map((s,i)=>{const n=by[s].length,list=s==='closed'?by[s].slice(0,4):by[s];
    return '<div class="kh-jst'+(n?' has':'')+(s==='main'||s==='closed'?' live':'')+'"><div class="kh-jhd"><i class="node"></i>'+(i<JST.length-1?'<span class="bar'+(i<furthest?' lit':'')+'"></span>':'')+'</div><div class="kh-jlbl"><b>'+JL[s]+'</b><em>'+n+'</em></div><div class="kh-jtoks">'+list.map(t=>token(t,s)).join('')+(s==='closed'&&n>4?'<span class="kh-note">+'+(n-4)+' more</span>':'')+(n?'':'<span class="kh-jnone"></span>')+'</div></div>'}).join('')+'</div>');
  if(reduce)return;el.querySelectorAll('[data-key]').forEach((e,i)=>{const p=prev[e.dataset.key];if(first||!p){e.style.setProperty('--i',i);e.classList.add('enter');return}const r=e.getBoundingClientRect(),dx=p.left-r.left,dy=p.top-r.top;if(Math.abs(dx)+Math.abs(dy)>1)e.animate([{transform:'translate('+dx+'px,'+dy+'px)'},{transform:'none'}],{duration:800,easing:'cubic-bezier(.32,1.25,.5,1)'})})}

function render(){
  if(!S)return;watchPanel.update(S.watch);throughputPanel.update(S.throughput);const s=S;
  setHtml($('#kh-sub'),(s.release?'<span>Keir <b>'+esc(s.release.version)+'</b> · '+esc(s.release.sha.slice(0,7))+'</span>':'')+'<span>Rust runner <b>'+esc(s.lanes.join(', ')||'off')+'</b></span>'+(s.routing.worker?'<span>Worker <b>'+esc(s.routing.worker)+'</b></span>':'')+(s.routing.coding?'<span>Coding <b>'+esc(s.routing.coding)+'</b></span>':'')+(s.paused?'<span style="color:var(--st-crit)"><b>Operator paused</b></span>':'')+'<span id="kh-upd">updated '+ago(s.at)+'</span>');
  say();orbs();tail();if(!same('lanes',[s.stream.lanes,WIN])||first||s.kpis.running)lanes(first);feed();hero(s);if(!same('act',[s.activity,table]))chart(s.activity);if(!same('workers',[s.workers,F.state,F.runner,F.q]))workers(s.workers);
  if(F.tview==='list'){$('#kh-journey').hidden=true;$('#kh-tickets').hidden=false;tickets(s.tickets,s.prs)}else{$('#kh-tickets').hidden=true;$('#kh-journey').hidden=false;journey()}
  $('#kh-tcount').textContent=s.sources.support==='loading'?'support sample loading':s.tickets.filter(t=>!['resolved','closed'].includes(t.status)).length+' open in latest support sample';
  if(!same('prs',[s.prs,F.prs,s.sources.prs])){if(!s.prs.length&&s.sources.prs==='loading')setHtml($('#kh-prs'),'<p class="kh-pb kh-empty">Loading pull requests in the background.</p>');else prList(s.prs);}if(!same('side',[s.decisions,s.shadow,s.kanban,s.issues,s.recent,F.kb,F.rec,s.sourceFreshness?.issues?.refreshing])){side(s);if(!s.issues.length&&s.sourceFreshness?.issues?.refreshing)setHtml($('#kh-iss'),'<p class="kh-pb kh-empty">Loading issue links in the background.</p>');}if(!same('incidents',[s.incidents,s.sources.incidents])){if(!s.incidents.length&&s.sources.incidents==='loading')setHtml($('#kh-inc'),'<p class="kh-pb kh-empty">Loading incidents in the background.</p>');else incidents(s.incidents||[]);}if(!same('quality',s.quality))quality(s.quality);if(!same('jev',s.jev))jev(s.jev);if(!same('runs',s.attempts))runs(s.attempts||[]);
  const src=Object.entries(s.sources).filter(e=>e[1]!=='ok'),fresh=Object.entries(s.sourceFreshness||{}),stale=fresh.filter(([,v])=>v.error),updating=fresh.filter(([,v])=>v.refreshing);$('#kh-src').textContent=src.length?'Partial data: '+src.map(e=>e[0]+' '+e[1]).join('; '):stale.length?'Using last successful '+stale.map(([key,v])=>key+' snapshot ('+ago(v.at)+')').join(', ')+'. Upstream refresh failed.':updating.length?'Updating '+updating.map(([key])=>key).join(', ')+' in the background. Current values remain visible.':'';first=false}


document.addEventListener('click',e=>{if(e.target.closest('a'))return;
  const mb=e.target.closest('[data-merge]');if(mb){e.stopPropagation();openPop(mb,+mb.dataset.merge);return}
  if(e.target.closest('#kh-pop'))return;if(popFor)closePop();
  const at=e.target.closest('[data-attempt]');if(at){attemptDrawer(at.dataset.attempt);return}
  const f=e.target.closest('[data-f]');if(f){const [k,v]=f.dataset.f.split(':');F[k]=v;f.parentElement.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===f));render();return}
  const t=e.target.closest('[data-t]');if(t){F[t.dataset.t]=!F[t.dataset.t];render();return}
  const j=e.target.closest('[data-job]');if(j){drawer(j.dataset.job);return}
  const tk=e.target.closest('[data-ticket]');if(tk&&S){const n=+tk.dataset.ticket;const w=S.workers.find(x=>x.ticket===n&&!x.coder)||S.recent.find(x=>x.ticket===n);if(w)drawer(w.id);return}});
$('#kh-popc').onclick=closePop;
$('#kh-popm').onclick=async()=>{const n=popFor,target=+$('#kh-popi').value,reason=$('#kh-popr').value.trim();if(!n||!target)return;if(reason.length<4){toast('Say why it is the same problem.','bad');$('#kh-popr').focus();return}
  const b=$('#kh-popm');b.disabled=true;b.textContent='Merging';try{const r=await post('/api/keir/hub/merge',{source:n,target,reason});closePop();toast('Ticket #'+n+' merged into incident #'+target+(r.steps?' ('+r.steps.join(', ')+')':''),'ok');load()}catch(err){toast('Merge failed: '+err.message,'bad')}finally{b.disabled=false;b.textContent='Merge'}};
$('#kh-popr').addEventListener('keydown',e=>{if(e.key==='Enter')$('#kh-popm').click()});
$('#kh-ping').onclick=async()=>{const b=$('#kh-ping');b.disabled=true;b.textContent='Pinging';const t0=Date.now();try{const r=await post('/api/keir/hub/probe');for(let i=0;i<40;i++){await new Promise(x=>setTimeout(x,3000));const s=await (await fetch('/api/keir/hub/probe/'+r.task,{cache:'no-store'})).json();if(['done','blocked','dismissed','cancelled','waiting'].includes(s.state)){toast('Keir answered in '+dur(Date.now()-t0)+(s.provider&&s.provider.via==='rust'?' via the Rust runner':'')+'. '+(s.summary||'').slice(0,160),s.state==='done'?'ok':'bad');return}}toast('No answer after two minutes; Keir may be busy.','bad')}catch(err){toast('Ping failed: '+err.message,'bad')}finally{b.disabled=false;b.textContent='Ping Keir'}};
$('#kh-scrim').onclick=closeDrawer;$('#kh-x').onclick=closeDrawer;document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDrawer();closePop()}});
$('#kh-q').oninput=e=>{F.q=e.target.value;if(S)workers(S.workers)};$('#kh-run').onchange=e=>{F.runner=e.target.value;if(S)workers(S.workers)};
$('#kh-livebtn').onclick=()=>{paused=!paused;$('#kh-livebtn').textContent=paused?'Resume':'Pause';$('#kh-live').classList.toggle('paused',paused);$('#kh-live').lastChild.textContent=paused?'Paused':'Live';if(!paused)schedule(0)};
$('#kh-view').onclick=e=>{const b=e.target.closest('button');if(!b)return;table=b.dataset.v==='table';$('#kh-view').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));if(S)chart(S.activity)};
let timer=null;
function schedule(ms){clearTimeout(timer);timer=setTimeout(load,ms)}
let inFlight=null;
let performanceAt=0,performanceLoading=false;
async function loadPerformance(){
  if(performanceLoading||paused||Date.now()-performanceAt<60000)return;
  performanceLoading=true;performanceAt=Date.now();
  const host=$('#kh-performance');
  try{
    const days=$('#kh-performance-days').value;
    const response=await fetch('/api/keir/hub/performance?days='+days,{cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('Performance unavailable');
    const p=await response.json(),r=p.resolved;
    const val=n=>n==null?'unknown':Number(n).toLocaleString(undefined,{maximumFractionDigits:2});
    const time=n=>n==null?'unknown':dur(n);
    const usd=n=>n==null?'unknown':'$'+Number(n).toFixed(4);
    const row=(label,d,format)=>'<tr><th scope="row">'+label+'</th><td>'+format(d.median)+'</td><td>'+format(d.mean)+'</td><td>'+format(d.p95)+'</td><td>'+d.n+'</td></tr>';
    setHtml(host,'<p>'+r.tickets+' Keir-resolved · '+p.assisted.tickets+' assisted · '+p.reopenedTickets+' reopened · '+p.unobservedTickets+' awaiting observation</p>'+
      '<div style="overflow-x:auto"><table style="width:100%;text-align:left"><thead><tr><th>Metric</th><th>Median</th><th>Average</th><th>p95</th><th>Samples</th></tr></thead><tbody>'+
      row('Resolution time',r.resolutionMs,time)+row('Time from pickup',r.pickupToResolutionMs,time)+row('Model turns',r.turns,val)+row('API-equivalent USD',r.apiEquivalentUsd,usd)+'</tbody></table></div>'+
      '<p class="kh-muted">Subscription charges are unknown. Estimates use complete token usage; missing data is excluded. Mixed-model tickets appear under each contributor.</p>'+
      '<details><summary>Models and ticket outcomes</summary><div style="overflow-x:auto"><table style="width:100%;text-align:left"><thead><tr><th>Provider / model</th><th>Tickets</th><th>Median turns</th><th>Average estimate</th></tr></thead><tbody>'+
      p.byModel.map(m=>'<tr><th scope="row">'+esc(m.provider)+' / '+esc(m.model)+'</th><td>'+m.tickets+'</td><td>'+val(m.turns.median)+'</td><td>'+usd(m.apiEquivalentUsd.mean)+'</td></tr>').join('')+'</tbody></table></div>'+
      p.tickets.slice(0,100).map(t=>'<p>#'+t.ticket+' · '+esc(t.credit)+' · '+time(t.resolutionMs)+' · '+val(t.turns)+' turns · '+usd(t.apiEquivalentUsd)+' estimate · '+t.models.map(m=>esc(m.model)).join(', ')+'</p>').join('')+'</details>');
  }catch{host.textContent='Ticket performance unavailable. It will appear when the operator supports tracking.'}
  finally{performanceLoading=false}
}
let efficiencyAt=0,efficiencyLoading=false;
async function loadEfficiency(){
  if(efficiencyLoading||paused||Date.now()-efficiencyAt<60000)return;
  efficiencyLoading=true;efficiencyAt=Date.now();const host=$('#kh-release-efficiency');
  try{
    const response=await fetch('/api/keir/hub/efficiency?days='+$('#kh-performance-days').value,{cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error('Unavailable');const report=await response.json();
    const versions=report.versions.slice().sort((a,b)=>b.ticketsWorkedOn-a.ticketsWorkedOn).slice(0,10);
    const known=report.releaseAttribution.exactUsageRows+report.releaseAttribution.eventMatchedRows;
    setHtml(host,'<p>'+known+' activations bound to a release; '+report.releaseAttribution.unknownRows+' unknown. Tickets worked overlap across contributors. Resolution costs include earlier versions.</p><div style="overflow-x:auto"><table style="width:100%;text-align:left"><thead><tr><th>Exact version</th><th>Tickets worked</th><th>Credited resolutions</th><th>Zero-token activations</th></tr></thead><tbody>'+versions.map(v=>'<tr><th scope="row">'+esc(v.version)+'</th><td>'+v.ticketsWorkedOn+'</td><td>'+v.completionCohort.resolvedTickets+'</td><td>'+v.zeroTokenActivations+' / '+v.activations+'</td></tr>').join('')+'</tbody></table></div><p class="kh-muted">Counts reflect different observation spans and ticket difficulty. Use release_efficiency for matched task/model cells and complete single-milestone ticket samples.</p>');
  }catch{host.textContent='Release comparisons will appear when the operator supports version tracking.'}
  finally{efficiencyLoading=false}
}
$('#kh-performance-days').onchange=()=>{performanceAt=0;efficiencyAt=0;loadPerformance();loadEfficiency()};
function load(){if(paused)return Promise.resolve();if(inFlight)return inFlight;
  loadPerformance();loadEfficiency();
  inFlight=(async()=>{try{const r=await fetch('/api/keir/hub',{cache:'no-store',signal:AbortSignal.timeout(30000)});if(r.status===401){location.href='/';return}if(!r.ok)throw Error('HTTP '+r.status);
    const next=await r.json();if(!next||!next.kpis||!next.stream||!Array.isArray(next.activity)||!Array.isArray(next.workers))throw Error('Incomplete dashboard response');
    const previous=S;try{S=next;render()}catch(e){S=previous;throw e}
    const lv=$('#kh-live');lv.classList.remove('beat');void lv.offsetWidth;lv.classList.add('beat')
  }catch(e){$('#kh-src').textContent='Refresh failed: '+e.message+'; showing the last successful snapshot.'}
  finally{inFlight=null;schedule(S&&Object.values(S.sourceFreshness||{}).some(v=>v.refreshing)?2000:S&&(S.live&&S.live.length||S.kpis.running)?3000:8000)}})();return inFlight}
document.addEventListener('mouseover',e=>{const f=e.target.closest('.kh-fi');if(f){focusLane(f.dataset.job||'__none',f.dataset.fmark);return}
  const tip=$('#kh-ltip'),t=e.target.closest('#kh-lanes [data-tip]');if(t){const b=$('#kh-lanecol').getBoundingClientRect(),r=t.getBoundingClientRect();tip.textContent=t.dataset.tip;tip.style.left=Math.min(b.width-260,Math.max(8,r.left-b.left-20))+'px';tip.style.top=(r.top-b.top-36)+'px';tip.classList.add('on')}else tip.classList.remove('on')});
document.addEventListener('mouseout',e=>{const f=e.target.closest('.kh-fi');if(f&&!f.contains(e.relatedTarget)){laneFocus=null;focusLane(null)}});
$('#kh-win').onclick=e=>{const b=e.target.closest('button');if(!b)return;WIN=+b.dataset.w;$('#kh-win').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));if(S)lanes(true)};
$('#kh-tview').onclick=e=>{const b=e.target.closest('button');if(!b)return;F.tview=b.dataset.v;$('#kh-tview').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));delete sig.journey;render()};
let rz=null;addEventListener('resize',()=>{clearTimeout(rz);rz=setTimeout(()=>{if(S)lanes(false)},150)});
setInterval(()=>{const now=Date.now();
  document.querySelectorAll('[data-since]').forEach(el=>{el.textContent=dur(now-+el.dataset.since)});
  document.querySelectorAll('[data-until]').forEach(el=>{const d=+el.dataset.until-now;el.textContent=d>0?'in '+dur(d):'due now'});
  document.querySelectorAll('[data-ago]').forEach(el=>{el.textContent=ago(+el.dataset.ago)});
  document.querySelectorAll('[data-wake]').forEach(el=>{const w=+el.dataset.wake,f=+el.dataset.from;el.setAttribute('stroke-dasharray',(100*Math.max(0,Math.min(1,(w-now)/Math.max(1,w-f)))).toFixed(1)+' 100')});
  const u=$('#kh-upd');if(u&&S)u.textContent='updated '+ago(S.at)},1000);
F.tview='journey';if(WIN===3600000)$('#kh-win').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.w==='3600000'));load();
}

const LEGEND_ITEMS = [["run", "var(--text-3)", "Activation, in the runner's color"], ["ship", "var(--st-good)", "Shipped"], ["code", "var(--accent)", "Code"], ["talk", "var(--text-2)", "Talked to a player"], ["ask", "var(--st-warn)", "Asked you"], ["guard", "var(--st-serious)", "Held or refused"]];
const LEGEND_GLYPH = { run: '<rect x="1" y="4" width="10" height="4" rx="2" fill="currentColor"/>', ship: '<path d="M6 1l5 5-5 5-5-5z" fill="currentColor"/>', code: '<rect x="2" y="2" width="8" height="8" rx="2" fill="currentColor"/>', talk: '<path d="M2.5 2.5h7a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H6l-2.5 2V9h-1A1.5 1.5 0 0 1 1 7.5V4a1.5 1.5 0 0 1 1.5-1.5z" fill="currentColor"/>', ask: '<circle cx="6" cy="6" r="4.5" fill="currentColor"/>', guard: '<path d="M6 1.5l5 9H1z" fill="currentColor"/>' };
const LEGEND = LEGEND_ITEMS.map(([k, c, l]) => `<span><svg viewBox="0 0 12 12" width="11" height="11" style="color:${c}">${LEGEND_GLYPH[k]}</svg>${l}</span>`).join("");

function makeKeirHubBody() {
  const seg = (k, list) => list.map(([v, l], i) => `<button class="${i === 0 ? "on" : ""}" data-f="${k}:${v}">${l}${k === "state" ? ' <span class="n">0</span>' : ""}</button>`).join("");
  const body = `<main class="kh">
  <header class="kh-top rise" style="--i:0">
    <div class="kh-title"><h1>Keir <span class="kh-live" id="kh-live"><i></i>Live</span></h1><div class="kh-sub" id="kh-sub"></div></div>
    <div class="kh-actions"><button class="kh-btn2" id="kh-ping" title="Run a quick probe through Keir">Ping Keir</button><div class="kh-seg"><button class="on" id="kh-livebtn">Pause</button></div><a class="kh-link" href="/inbox">Inbox</a><a class="kh-link" href="/kanban">Kanban</a><a class="kh-link" href="/reports/keir-4-shadow">Shadow report</a></div>
  </header>
  <div class="kh-note" id="kh-src"></div>
  <section class="kt rise" id="kh-throughput" aria-label="Delivery throughput"></section>
  <section class="kh-panel rise" aria-label="Ticket resolution performance"><div class="kh-ph"><h2>Ticket resolution performance</h2><label>Window <select id="kh-performance-days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label></div><div class="kh-pb" id="kh-performance">Loading ticket outcomes.</div></section>
  <details class="kh-panel rise"><summary class="kh-ph">Keir versions and tickets served</summary><div class="kh-pb" id="kh-release-efficiency">Loading release comparisons.</div></details>
  <section class="kh-panel kh-now rise" style="--i:1">
    <div class="kh-nowhead"><div class="kh-say"><div class="kh-say1" id="kh-say1">Reading Keir</div><div class="kh-say2" id="kh-say2"></div><div class="kh-say3" id="kh-say3"></div></div><div class="kh-orbs" id="kh-orbs"></div></div>
    <div class="kh-tailwrap" id="kh-tail" hidden></div>
    <div class="kh-nowbody">
      <div class="kh-lanecol" id="kh-lanecol"><div class="kh-subh"><h3>Timeline <small id="kh-lanesn"></small></h3><div class="kh-seg" id="kh-win"><button data-w="3600000">1h</button><button class="on" data-w="10800000">3h</button><button data-w="43200000">12h</button></div></div>
        <div class="kh-lanes" id="kh-lanes"></div><div class="kh-ltip" id="kh-ltip"></div>
        <div class="kh-lkeys">${LEGEND}</div></div>
      <div class="kh-feedcol"><div class="kh-subh"><h3>As it happens <small id="kh-feedn"></small></h3></div><div class="kh-feedlist" id="kh-feed"></div></div>
    </div>
  </section>
  <details class="kh-diagnostics"><summary>Runner telemetry <small>Activation totals, latency and runner adoption</small></summary><div class="kh-diagnostics-body"><section class="kh-panel kh-hero" id="kh-hero"></section></div></details>
  <section class="kh-panel kh-tickets rise" style="--i:3"><div class="kh-ph"><h2>Ticket journey <small id="kh-tcount"></small></h2><div class="kh-seg" id="kh-tview"><button class="on" data-v="journey">Journey</button><button data-v="list">List</button></div></div><div class="kh-journey" id="kh-journey"></div><div id="kh-tickets" hidden></div></section>
  <details class="kh-diagnostics" id="kh-diagnostics"><summary>Monitoring and quality <small>Findings, shadow evaluation and safety receipts</small></summary><div class="kh-diagnostics-body">
  <section class="kh-panel kh-watch" id="kh-watch" aria-label="Proactive monitoring"></section>
  <div class="kh-trio">
    <section class="kh-panel rise" style="--i:4"><div class="kh-ph"><h2>Quality <small>shadow evaluation</small></h2></div><div class="kh-pb" id="kh-quality"></div></section>
    <section class="kh-panel rise" style="--i:5"><div class="kh-ph"><h2>What players bring <small>last 7 days</small></h2></div><div class="kh-pb" id="kh-jev"></div></section>
    <section class="kh-panel rise" style="--i:6"><div class="kh-ph"><h2>Post screening <small>last 7 days</small></h2></div><div class="kh-pb" id="kh-screen"></div></section>
  </div>
  </div></details>
  <div class="kh-cols">
    <div class="kh-stack">
      <section class="kh-panel rise" style="--i:3"><div class="kh-ph"><h2>Activations by runner <small>last 24 hours</small></h2><div class="kh-seg" id="kh-view"><button class="on" data-v="chart">Chart</button><button data-v="table">Table</button></div></div><div class="kh-chart" id="kh-chart"></div><div class="kh-legend" id="kh-legend"></div></section>
      <section class="kh-panel kh-workers rise" style="--i:4"><div class="kh-ph"><h2>Workers</h2></div>
        <div class="kh-tools"><div class="kh-seg" id="kh-wseg">${seg("state", [["all", "All"], ["running", "Running"], ["queued", "Queued"], ["waiting", "Waiting"], ["blocked", "Blocked"]])}</div>
        <select class="kh-select" id="kh-run"><option value="all">Any runner</option><option value="muse">Muse</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="agy">Antigravity</option></select>
        <input class="kh-search" id="kh-q" placeholder="Search work, tickets, job ids"></div>
        <div id="kh-workers"></div></section>
      <section class="kh-panel kh-runs rise" style="--i:5"><div class="kh-ph"><h2>Rust runner <small>recent attempts</small></h2></div><div id="kh-runs"></div></section>
      <section class="kh-panel kh-prs rise" style="--i:5"><div class="kh-ph"><h2>Pull requests</h2><div class="kh-seg">${seg("prs", [["open", "Open"], ["merged", "Merged"], ["all", "All"]])}</div></div><div id="kh-prs"></div></section>
    </div>
    <div class="kh-stack">
      <section class="kh-panel rise" style="--i:3"><div class="kh-ph"><h2>Incidents</h2><span id="kh-incn"></span></div><div class="kh-list" id="kh-inc"></div></section>
      <section class="kh-panel rise" style="--i:3"><div class="kh-ph"><h2>Waiting on you</h2></div><div id="kh-asks"></div></section>
      <section class="kh-panel rise" style="--i:4"><div class="kh-ph"><h2>Shadow evaluation</h2></div><div class="kh-pb" id="kh-shadow"></div></section>
      <section class="kh-panel rise" style="--i:5"><div class="kh-ph"><h2>Kanban</h2><span id="kh-kbm"></span></div><div class="kh-list" id="kh-kb"></div></section>
      <section class="kh-panel rise" style="--i:6"><div class="kh-ph"><h2>GitHub issues</h2></div><div class="kh-list" id="kh-iss"></div></section>
      <section class="kh-panel rise" style="--i:7"><div class="kh-ph"><h2>Finished recently</h2><span id="kh-recm"></span></div><div class="kh-list" id="kh-rec"></div></section>
    </div>
  </div>
  <div class="kh-pop" id="kh-pop" role="dialog" aria-label="Merge into an incident"><h5 id="kh-popt"></h5><label for="kh-popi">Incident</label><select id="kh-popi"></select><label for="kh-popr">Why it is the same problem</label><input id="kh-popr" maxlength="300" placeholder="Same stalled turn, reported at 9:40"><div class="row"><button class="kh-btn2" id="kh-popc">Cancel</button><button class="kh-btn2 primary" id="kh-popm">Merge</button></div></div>
  <div class="kh-toasts" id="kh-toasts"></div>
  <div class="kh-scrim" id="kh-scrim"></div>
  <aside class="kh-drawer" id="kh-drawer" aria-label="Work detail"><header><div><h3 id="kh-dt"></h3><p id="kh-dm"></p></div><button class="kh-x" id="kh-x" aria-label="Close">×</button></header><div class="body" id="kh-db"></div></aside>
</main><script>(${keirHubClient.toString()})(${JSON.stringify(ICON)}, (${createWatchPanel.toString()}), (${createThroughputPanel.toString()}));</script>`;
  return { extraCss: CSS + WATCH_CSS + THROUGHPUT_CSS, body };
}

module.exports = { makeKeirHubBody };
