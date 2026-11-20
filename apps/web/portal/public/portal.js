"use strict";
const $ = id => document.getElementById(id);
const taskPanel = $("tasks");
$("messages").append(taskPanel);

/// One thread row, keyed by message id so a revised answer updates in place.
function renderMessage(row) {
  let a = row.id ? document.getElementById(`msg-${row.id}`) : null;
  if (!a) {
    a = document.createElement("article"); a.id = `msg-${row.id || Math.random().toString(36).slice(2)}`;
    $("messages").insertBefore(a, taskPanel);
  }
  a.className = row.role || "keir"; a.replaceChildren();
  const author = document.createElement("strong"); author.textContent = row.role === "owner" ? "You" : "Keir";
  a.append(author);
  if (row.activity?.length) a.append(toolActivity(row.activity));
  a.append(document.createTextNode(row.text || ""));
  if (row.editedAt) { const edited = document.createElement("small"); edited.className = "edited"; edited.textContent = " · edited"; a.append(edited); }
  if (row.progress) { const progress = document.createElement("em"); progress.className = "progress"; progress.textContent = row.progress; a.append(progress); }
  return a;
}

function toolActivity(calls) {
  const group = document.createElement("div"); group.className = "tool-activity"; group.setAttribute("role", "list");
  for (const call of calls || []) {
    const row = document.createElement("div"), title = document.createElement("span"), source = document.createElement("small"), state = document.createElement("span");
    row.className = "tool-call"; row.dataset.call = call.id || ""; row.dataset.state = call.state || (call.ok ? "completed" : "failed"); row.setAttribute("role", "listitem");
    title.textContent = call.title || call.tool; source.textContent = call.source || "Keir";
    state.textContent = call.state === "running" ? "Running" : call.state === "failed" || call.ok === false ? "Failed" : "Completed";
    row.append(title, source, state); group.append(row);
  }
  return group;
}
let team = null, decisions = [], decisionsVersion = "", mode = "standalone", answering = new Set();
let selected = "main", cursor = 0, version = "", stopped = true, generation = 0;
function error(e) { $("error").textContent = e.message; $("error").hidden = false; }
async function api(route, body, signal) {
  const r = await fetch(route, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal });
  const data = await r.json(); if (!r.ok) { if (r.status === 401 && route !== "/api/login") signedOut(); throw new Error(data.error || "Request failed"); } return data;
}
function signedOut() { team = null; decisions = []; decisionsVersion = ""; renderAttention(); $("controls").close(); $("models").close(); controls = null; controlsVersion = ""; stopped = true; generation++; $("workspace").hidden = true; $("login").hidden = false; }
async function connected() {
  const me = await api("/api/me"); $("identity").textContent = me.email;
  $("workspace").hidden = false; $("login").hidden = true; $("password").value = ""; $("error").hidden = true;
  stopped = false; await threads(); select("main");
}
async function threads() {
  const result = await api("/api/keir/app/threads"); $("threads").replaceChildren();
  for (const row of result.threads || []) {
    if (row.id === "watches" || row.archived) continue;
    const b = document.createElement("button"); b.textContent = row.title; b.dataset.thread = row.id; b.setAttribute("aria-current", String(row.id === selected));
    b.onclick = () => select(row.id, row.title); $("threads").append(b);
  }
}
function select(id, title = "Keir") {
  navigation(false); $("models").close(); controls = null; controlsVersion = ""; legacyModelSelection = "auto"; $("model-picker").textContent = "Model · Loading…"; selected = id; cursor = 0; version = ""; $("title").textContent = title; $("messages").replaceChildren(); $("messages").append(taskPanel); $("tasks").replaceChildren();
  for (const b of $("threads").children) b.setAttribute("aria-current", String(b.dataset.thread === id));
  welcome(); renderAttention(); const run = ++generation; poll(run);
}
async function poll(run) {
  while (!stopped && run === generation) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 32000);
    try {
      const q = new URLSearchParams({ thread: selected, after: String(cursor), since: version, wait: version ? "25" : "0", edits: "1" });
      const view = await api(`/api/keir/app/thread?${q}`, null, controller.signal);
      if (run !== generation) return;
      if (view.messages?.length) $("welcome")?.remove();
      // A revised answer keeps its id and arrives in `revised`: update the row in
      // place, keyed by message id, rather than posting a second bubble.
      for (const row of [...(view.messages || []), ...(view.revised || [])]) renderMessage(row);
      if (view.messages?.length || view.revised?.length) $("messages").scrollTop = $("messages").scrollHeight;
      cursor = view.cursor; version = view.version; $("connection").textContent = view.controls?.stopped ? "Stopped" : view.working ? "Working" : "Connected"; $("connection").dataset.state = view.controls?.stopped ? "stopped" : view.working ? "working" : "ready";
      legacyModelSelection = view.modelSelection || "auto";
      team = view.team || null; renderAttention(); refreshDecisions(view.version);
      if (view.controls) renderControls(view.controls);
      $("tasks").replaceChildren();
      for (const task of view.tasks || []) {
        const div = document.createElement("div"), label = document.createElement("span"), stop = document.createElement("button"); div.className = "task";
        label.textContent = `${task.state}: ${task.status || task.title}`; stop.textContent = "Stop";
        if (task.live?.length) div.append(toolActivity(task.live));
        stop.onclick = () => api("/api/keir/app/cancel", { taskId: task.id }).catch(error); div.append(label, stop); $("tasks").append(div);
      }
    } catch (e) { if (run !== generation || stopped) return; $("connection").textContent = "Reconnecting"; if (e.name !== "AbortError") error(e); await new Promise(r => setTimeout(r, 3000)); }
    finally { clearTimeout(timeout); }
  }
}
$("signin").onsubmit = async e => { e.preventDefault(); const b = e.submitter; b.disabled = true; try { await api("/api/login", { password: $("password").value, email: $("email").value }); await connected(); } catch (e) { error(e); } finally { b.disabled = false; } };
$("logout").onclick = async () => { try { await api("/api/logout", {}); signedOut(); } catch (e) { error(e); } };
$("new-thread").onclick = async () => { const title = prompt("Conversation title"); if (!title?.trim()) return; try { const row = await api("/api/keir/app/threads", { title }); await threads(); select(row.id, row.title); } catch (e) { error(e); } };
let pending = null;
$("compose").onsubmit = async e => { e.preventDefault(); const text = $("message").value.trim(); if (!text) return; const b = e.submitter; b.disabled = true;
  if (!pending || pending.text !== text || pending.thread !== selected) pending = { text, thread: selected, clientId: crypto.randomUUID(), mode: "new" };
  try { const result = await api("/api/keir/app/messages", pending); if (result.thread) { await threads(); select(result.thread); } pending = null; $("message").value = ""; $("error").hidden = true; } catch (e) { error(e); } finally { b.disabled = false; }
};
api("/api/portal/config").then(config => {
  if (config.mode === "lakeside") {
    mode = "lakeside"; $("back-to-ops").hidden = false; $("studio-links").hidden = false; renderAttention();
    $("login").querySelector("p").textContent = "Sign in with your studio account to open Keir.";
    $("email-label").hidden = config.auth !== "password";
    $("sso").href = "/auth/game?next=" + encodeURIComponent(new URL("/keir/app", location.origin).href);
    $("signin").hidden = config.auth === "sso"; $("sso").hidden = config.auth !== "sso";
  }
}).catch(error);
connected().catch(e => { if (!$("login").hidden) return; error(e); });
let controls = null, controlBusy = false, controlsVersion = "", legacyModelSelection = "auto";
const lanes = ["conversation", "coding", "investigation", "coordination"];
async function changeControl(fields) {
  if (controlBusy) return;
  controlBusy = true; const thread = selected;
  try { const result = await api("/api/keir/app/controls", { thread, ...fields }); if (selected === thread) { renderControls(result); renderModelPicker(); } $("error").hidden = true; }
  catch (e) { error(e); if (controls) renderControls(controls, true); }
  finally { controlBusy = false; renderModelPicker(); }
}
function renderControls(value, force = false) {
  controls = value;
  renderModelPicker();
  $("runtime-control").hidden = !value.supported; $("runtime-control").textContent = value.stopped ? "Start" : "Stop";
  $("runtime-control").className = value.stopped ? "start" : "stop";
  $("approval-mode").hidden = value.approvalMode !== "yolo";
  $("runtime-description").textContent = value.stopped ? "Stopped. Start enables new work; cancelled tasks stay cancelled." : "Ready. Stop cancels work and queued publications across the installation.";
  $("yolo").checked = value.approvalMode === "yolo";
  const version = JSON.stringify([value.routes, value.options, value.defaults, value.skills, value.catalog]);
  if (version === controlsVersion && !force) return;
  controlsVersion = version;
  $("route-settings").replaceChildren();
  for (const lane of lanes) {
    const label = document.createElement("label"), select = document.createElement("select"), hint = document.createElement("small");
    label.textContent = lane[0].toUpperCase() + lane.slice(1); select.setAttribute("aria-label", `${lane} provider`);
    for (const route of value.options?.[lane] || []) {
      const option = document.createElement("option"); option.value = route.id;
      option.disabled = route.available === false;
      option.textContent = route.id === "auto" ? "Installation default" : `${route.provider} · ${route.label}${route.available === false ? " · unavailable for this work" : ""}`;
      select.append(option);
    }
    const chosen = value.routes?.[lane] || "auto";
    select.value = (value.options?.[lane] || []).find(r => r.id.split("@")[0] === chosen.split("@")[0])?.id || chosen;
    select.onchange = () => changeControl({ action: "configure", routes: { [lane]: select.value } });
    hint.textContent = `Default: ${value.defaults?.[lane] || "Not configured"}. Changes apply on the next activation.`;
    label.append(select, hint); $("route-settings").append(label);
  }
  renderSkills();
}
function renderSkills() {
  $("skill-settings").replaceChildren(); const lane = $("skill-lane").value;
  for (const skill of controls?.catalog || []) {
    const label = document.createElement("label"), input = document.createElement("input"); input.type = "checkbox";
    const key = { conversation: "quick", coding: "coder", investigation: "investigator", coordination: "worker" }[lane];
    const selectedSkills = controls.skills?.[lane] ?? controls.catalog.filter(s => s.defaults?.includes(key)).map(s => s.id);
    input.checked = selectedSkills.includes(skill.id); input.disabled = !skill.available;
    input.onchange = () => changeControl({ action: "configure", skills: { [lane]: input.checked ? [...new Set([...selectedSkills, skill.id])] : selectedSkills.filter(id => id !== skill.id) } });
    label.append(input, document.createTextNode(`${skill.id} · ${skill.license}`)); $("skill-settings").append(label);
  }
}
$("open-controls").onclick = async () => { try { renderControls(await api(`/api/keir/app/controls?thread=${encodeURIComponent(selected)}`)); $("controls").showModal(); } catch (e) { error(e); } };
$("runtime-control").onclick = () => changeControl({ action: controls?.stopped ? "start" : "stop" });
$("yolo").onchange = () => changeControl({ action: "configure", approvalMode: $("yolo").checked ? "yolo" : "ask" });
$("skill-lane").onchange = renderSkills;
$("reset-skills").onclick = () => changeControl({ action: "configure", skills: { [$("skill-lane").value]: null } });
$("message").addEventListener("input", () => {
  const text = $("message").value; $("commands").replaceChildren(); $("commands").hidden = !text.startsWith("/");
  if (!text.startsWith("/")) return;
  for (const command of controls?.commands || []) if (command.id.startsWith(text.toLowerCase())) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = `${command.id} · ${command.detail}`;
    button.onclick = () => { $("message").value = command.id; $("message").focus(); $("commands").hidden = true; }; $("commands").append(button);
  }
});
function navigation(open) {
  const mobile = window.matchMedia("(max-width:700px)").matches;
  $("workspace").classList.toggle("nav-open", mobile && open);
  $("open-navigation").setAttribute("aria-expanded", String(mobile && open));
  $("navigation").setAttribute("aria-hidden", String(mobile && !open));
  $("workspace").querySelector("main").inert = mobile && open;
  if (mobile && open) $("close-navigation").focus();
}
$("open-navigation").onclick = () => navigation(true);
$("close-navigation").onclick = $("nav-scrim").onclick = () => { navigation(false); $("open-navigation").focus(); };
window.matchMedia("(max-width:700px)").addEventListener("change", () => navigation(false));
document.addEventListener("keydown", e => {
  if (!$("workspace").classList.contains("nav-open")) return;
  if (e.key === "Escape") { navigation(false); $("open-navigation").focus(); }
  if (e.key === "Tab") {
    const focusable = [...$("navigation").querySelectorAll("button,a,input")].filter(el => !el.disabled && el.offsetParent !== null);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
function welcome() {
  const empty = document.createElement("div"), mark = document.createElement("img"), title = document.createElement("h2"), intro = document.createElement("p"), prompts = document.createElement("div");
  empty.id = "welcome"; mark.src = "/keir/keir-mark.svg"; mark.alt = ""; mark.width = 56; mark.height = 56;
  title.textContent = "What are we working on?"; intro.textContent = "Ask a question, investigate a problem, or put a plan into motion."; prompts.className = "starter-prompts";
  for (const [label, text] of [["Explore this project", "Explore this project and tell me how it works."], ["Investigate a problem", "Help me investigate a problem: "], ["Plan a change", "Help me plan a change: "]]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    button.onclick = () => { $("message").value = text; $("message").focus(); }; prompts.append(button);
  }
  empty.append(mark, title, intro);
  const glance = glanceLine(); if (glance) empty.append(glance);
  empty.append(prompts); $("messages").append(empty);
}
const STATE_LABEL = { "needs-you": "Needs you", stuck: "Stuck", working: "Working", queued: "Queued", waiting: "Waiting", held: "Held" };
/// Real counts from Keir's board, only the non-zero ones. Nothing is shown before the first poll.
function glanceLine() {
  const parts = [];
  if (decisions.length) parts.push(["needs a decision", decisions.length]);
  if (team) for (const [key, label] of [["needsYou", "need you"], ["stuck", "stuck"], ["working", "working"], ["waiting", "waiting"]]) if (team[key]) parts.push([label, team[key]]);
  if (!parts.length) return null;
  const list = document.createElement("ul"); list.className = "glance";
  for (const [label, n] of parts) { const li = document.createElement("li"), b = document.createElement("strong"); b.textContent = n; li.append(b, ` ${label}`); list.append(li); }
  return list;
}
function studioHref(item) { return item.ticket && mode === "lakeside" ? `/tickets/${encodeURIComponent(item.ticket)}` : null; }
function renderAttention() {
  const board = $("work-items"); board.replaceChildren();
  const count = Math.max(decisions.length, team?.needsYou || 0) + (team?.stuck || 0); // a decision is usually the same item the board calls needs-you
  $("attention-count").hidden = !count; $("attention-count").textContent = count;
  $("decisions-panel").hidden = !decisions.length;
  $("work-summary").textContent = !team ? "Waiting for Keir's first report." : team.open ? `${team.open} open: ${[["needsYou", "need you"], ["stuck", "stuck"], ["working", "working"], ["waiting", "waiting or queued"], ["held", "held"]].filter(([k]) => team[k]).map(([k, l]) => `${team[k]} ${l}`).join(", ") || "none active"}.` : "Nothing in progress.";
  for (const item of team?.items || []) {
    const li = document.createElement("li"), title = document.createElement("span"), meta = document.createElement("span"), state = document.createElement("span"); li.dataset.state = item.state;
    title.className = "item-title"; title.textContent = item.title; meta.className = "item-meta"; state.className = "state"; state.textContent = STATE_LABEL[item.state] || item.state;
    meta.append(state); if (item.reason) meta.append(document.createTextNode(` · ${item.reason}`));
    li.append(title, meta);
    const href = studioHref(item); if (href) { const a = document.createElement("a"); a.href = href; a.textContent = `Ticket ${item.ticket} in studio`; li.append(a); }
    board.append(li);
  }
  const list = $("decisions"); list.replaceChildren();
  for (const x of decisions) list.append(decisionCard(x));
  if (!$("welcome")) return;
  $("welcome").querySelector(".glance")?.remove(); const glance = glanceLine(); if (glance) $("welcome").querySelector(".starter-prompts").before(glance);
}
function decisionCard(x) {
  const card = document.createElement("div"), question = document.createElement("div"), meta = document.createElement("div"), actions = document.createElement("div");
  card.className = "decision"; question.className = "question"; question.textContent = x.question; meta.className = "meta";
  meta.textContent = [x.kind, x.ticket ? `ticket ${x.ticket}` : null, x.canAnswer ? null : x.reason].filter(Boolean).join(" · ");
  card.append(question); if (meta.textContent) card.append(meta);
  if (x.args && Object.keys(x.args).length) { const d = document.createElement("details"), s = document.createElement("summary"), pre = document.createElement("pre"); s.textContent = "Exact action"; pre.textContent = JSON.stringify(x.args, null, 2); d.append(s, pre); card.append(d); }
  actions.className = "actions";
  const add = (label, verdict, cls) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; if (cls) b.className = cls; b.disabled = !x.canAnswer || answering.has(x.id); b.onclick = () => answer(x, verdict); actions.append(b); };
  if (x.options?.length) x.options.slice(0, 6).forEach((o, i) => add(String(o.label || o.title || o), `choose:${i + 1}`));
  else { if (x.canApprove) add("Approve", "approve", "primary"); add("Reject", "reject"); }
  card.append(actions); return card;
}
async function answer(x, verdict) {
  if (answering.has(x.id)) return; answering.add(x.id); renderAttention();
  try { await api(`/api/keir/app/decisions/${x.id}`, { verdict }); decisionsVersion = ""; await refreshDecisions(""); $("error").hidden = true; }
  catch (e) { error(e); }
  finally { answering.delete(x.id); renderAttention(); }
}
async function refreshDecisions(v) {
  if (v && v === decisionsVersion) return; decisionsVersion = v || "";
  try { decisions = (await api("/api/keir/app/decisions")).decisions || []; renderAttention(); } catch (e) { if (!stopped) error(e); }
}
$("open-attention").onclick = () => { const open = $("attention").hidden; $("attention").hidden = !open; $("open-attention").setAttribute("aria-expanded", String(open)); };

function renderModelPicker() {
  const lane = $("model-lane").value, options = controls?.options?.[lane] || [];
  const selection = controls?.routes?.[lane] || (lane === "conversation" ? legacyModelSelection : "auto");
  const chat = controls?.routes?.conversation || legacyModelSelection || "auto";
  const chatRoute = controls?.options?.conversation?.find(r => r.id.split("@")[0] === chat.split("@")[0]);
  $("model-picker").textContent = `Model · ${chat === "auto" ? "Auto" : chatRoute?.label || chat}`;
  $("model-picker").disabled = !controls;
  const search = $("model-search").value.trim().toLowerCase();
  $("model-options").replaceChildren();
  for (const route of options) {
    if (search && !`${route.label} ${route.provider} ${route.id}`.toLowerCase().includes(search)) continue;
    const button = document.createElement("button"), title = document.createElement("strong"), detail = document.createElement("small");
    button.type = "button"; button.className = "model-option"; button.dataset.route = route.id;
    button.setAttribute("aria-pressed", String(route.id.split("@")[0] === selection.split("@")[0])); button.disabled = route.available === false || controlBusy;
    title.textContent = route.id === "auto" ? "Auto" : route.label;
    detail.textContent = route.id === "auto" ? `Installation default: ${controls?.defaults?.[lane] || "not configured"}` : `${route.provider} · ${route.id}${route.effortMode === "provider-managed" ? " · Cursor chooses model and effort" : ""}${route.available === false ? " · " + route.reason : ""}`;
    button.append(title, detail); button.onclick = () => changeControl({ action: "configure", routes: { [lane]: route.id } }); $("model-options").append(button);
  }
  $("model-selected").textContent = `Selected: ${selection}. This is the requested route; completion is reported separately.`;
}
$("model-picker").onclick = async () => {
  try {
    const thread = selected, value = await api(`/api/keir/app/controls?thread=${encodeURIComponent(thread)}`);
    if (thread !== selected) return;
    renderControls(value); $("models").showModal(); $("model-search").focus();
  } catch (e) { error(e); }
};
$("model-search").oninput = renderModelPicker;
$("model-lane").onchange = renderModelPicker;
