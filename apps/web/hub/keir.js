"use strict";

// hub/keir.js: Keir in the ticket hub. The 8-bit sprite (the same pack the
// iPhone Ops app uses), a plain-language reading of what Keir is doing, model
// names people can read, and a persistent performance tracker.
//
// The tracker appends one snapshot an hour to a JSONL file in the dashboard's
// data directory, so trends survive restarts and releases (data/ is linked
// across releases). Daily activation and success counts come from Keir's own
// usage log; resolution metrics come from the operator's performance endpoint.

const fs = require("fs");
const path = require("path");

const SPRITE_CSS = `
.ksprite{width:var(--ks,80px);height:var(--ks,80px);background-image:url('/hub/assets/keir-L.png');background-repeat:no-repeat;image-rendering:pixelated;image-rendering:crisp-edges;flex:none}
.ksprite.m{background-image:url('/hub/assets/keir-M.png')}
`;

// Animates every .ksprite[data-state] on the page. Each element picks its own
// state; idle sprites blink and do small variety moves now and then.
const SPRITE_JS = `<script>(function(){
var F=null,reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
function start(el){if(el.__k)return;el.__k=1;var big=!el.classList.contains('m'),cell=F.cells[big?'L':'M'],px=el.clientWidth||cell,scale=px/cell;
el.style.backgroundSize=(cell*10*scale)+'px auto';
var cur=el.getAttribute('data-state')||'idle',frame=0,once=null,next=Date.now()+3000+Math.random()*4000;
function spec(s){return F.states[s]||F.states.idle}
function draw(){var s=spec(once||cur);el.style.backgroundPosition=(-frame*px)+'px '+(-s[0]*px)+'px'}
function tick(){if(!el.isConnected)return;var want=el.getAttribute('data-state')||'idle';if(want!==cur){cur=want;frame=0;once=null}var s=spec(once||cur);frame++;if(frame>=s[1]){frame=0;if(once||!s[3])once=null}draw();
if(!once&&(cur==='idle'||cur==='reading')&&Date.now()>next){var v=F.variety;once=Math.random()<.6?'blink':v[Math.floor(Math.random()*v.length)];frame=0;next=Date.now()+1000*(F.every[0]+Math.random()*(F.every[1]-F.every[0]))}
setTimeout(tick,1000/(spec(once||cur)[2]||6))}
draw();if(!reduce)setTimeout(tick,Math.random()*400)}
window.keirSprites=function(){if(!F)return;[].forEach.call(document.querySelectorAll('.ksprite'),start)};
fetch('/hub/assets/keir-frames.json').then(function(r){return r.json()}).then(function(d){F=d;window.keirSprites()}).catch(function(){})})();</script>`;

function spriteHtml(state, { size = 80, medium = false, label = "Keir" } = {}) {
  return `<div class="ksprite${medium ? " m" : ""}" data-state="${state}" style="--ks:${size}px" role="img" aria-label="${label}"></div>`;
}

// What Keir is doing, in one word for the sprite and one line for people.
function keirMood(hub) {
  if (!hub) return { state: "sleeping", label: "Keir status unavailable", tone: "quiet" };
  const k = hub.kpis || {};
  if (hub.paused) return { state: "sleeping", label: "Keir is paused", tone: "warn" };
  if (k.decisionsPending > 0) return { state: "alert", label: `Keir needs ${k.decisionsPending === 1 ? "a decision" : k.decisionsPending + " decisions"}`, tone: "warn" };
  if (k.running > 0) return { state: "working", label: `Keir is working on ${k.running === 1 ? "a ticket" : k.running + " tickets"} right now`, tone: "good" };
  if (k.blocked > 0 && !k.waiting) return { state: "concerned", label: `Keir is blocked on ${k.blocked === 1 ? "a ticket" : k.blocked + " tickets"}`, tone: "warn" };
  if (k.waiting > 0) return { state: "reading", label: `Keir is watching ${k.waiting === 1 ? "a ticket" : k.waiting + " tickets"} and will check back`, tone: "good" };
  if (k.queued > 0) return { state: "thinking", label: "Keir is about to pick up a ticket", tone: "good" };
  return { state: "idle", label: "Keir is on call, nothing to work on", tone: "quiet" };
}

// "opencode:opencode-go/deepseek-v4.1-flash@low" -> "DeepSeek V4.1 Flash"
function modelName(route) {
  const s = String(route || "");
  if (!s) return "";
  const model = s.replace(/@.*$/, "").split(":").pop().split("/").pop();
  const pretty = model
    .replace(/^claude-/, "Claude ").replace(/^deepseek-/, "DeepSeek ").replace(/^gpt-/, "GPT ")
    .replace(/-free$/, " Free").replace(/-(\d)/g, " $1").replace(/-/g, " ")
    .replace(/\bv(\d)/i, "V$1").replace(/\b(flash|pro|sonnet|opus|haiku|fable)\b/gi, (w) => w[0].toUpperCase() + w.slice(1));
  return pretty.replace(/(\d) (\d)\b/g, "$1.$2").trim();
}
function runnerName(route) {
  const s = String(route || "").split(":")[0];
  return { opencode: "OpenCode", claude: "Claude Code", ollama: "Ollama", codex: "Codex", muse: "Muse" }[s] || s;
}

// ── Persistent tracker
function trackerFile(dataDir) { return path.join(dataDir, "keir-performance.jsonl"); }

function readTracker(dataDir, { days = 90 } = {}) {
  const since = Date.now() - days * 864e5;
  let text = "";
  try { text = fs.readFileSync(trackerFile(dataDir), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { const r = JSON.parse(line); if (r.at >= since) out.push(r); } catch { /* skip torn line */ }
  }
  return out;
}

// One snapshot per hour at most; safe to call on every page load.
function recordSnapshot(dataDir, hub, extra = {}) {
  if (!hub || !hub.kpis) return false;
  const rows = readTracker(dataDir, { days: 1 });
  const last = rows[rows.length - 1];
  if (last && Date.now() - last.at < 55 * 60_000) return false;
  const k = hub.kpis;
  const row = {
    at: Date.now(), version: hub.release && hub.release.version, paused: !!hub.paused,
    open: k.openTickets, running: k.running, waiting: k.waiting, queued: k.queued, blocked: k.blocked,
    decisions: k.decisionsPending, activations24h: k.activations24h, success24h: k.successRate24h,
    medianActivationMs: k.medianActivationMs, ...extra,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(trackerFile(dataDir), JSON.stringify(row) + "\n");
    return true;
  } catch { return false; }
}

// Daily activations, failures and model mix from Keir's usage log entries.
function dailyUsage(usage, { days = 14, now = Date.now() } = {}) {
  const day = 864e5;
  const start = Math.floor(now / day) * day - (days - 1) * day;
  const rows = Array.from({ length: days }, (_, i) => ({ day: new Date(start + i * day).toISOString().slice(0, 10), runs: 0, failed: 0, ms: 0, models: {} }));
  for (const u of usage || []) {
    const i = Math.floor((u.atMs - start) / day);
    if (i < 0 || i >= days) continue;
    const r = rows[i];
    r.runs++; r.ms += u.durationMs || 0;
    if (u.outcome && u.outcome !== "ok") r.failed++;
    const m = modelName(u.model || u.provider) || "Other";
    r.models[m] = (r.models[m] || 0) + 1;
  }
  return rows;
}

module.exports = { SPRITE_CSS, SPRITE_JS, spriteHtml, keirMood, modelName, runnerName, readTracker, recordSnapshot, dailyUsage, trackerFile };
