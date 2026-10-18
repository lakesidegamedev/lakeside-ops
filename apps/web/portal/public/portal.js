"use strict";
const $ = id => document.getElementById(id);
let selected = "main", cursor = 0, version = "", stopped = true, generation = 0;
function error(e) { $("error").textContent = e.message; $("error").hidden = false; }
async function api(route, body, signal) {
  const r = await fetch(route, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal });
  const data = await r.json(); if (!r.ok) { if (r.status === 401 && route !== "/api/login") signedOut(); throw new Error(data.error || "Request failed"); } return data;
}
function signedOut() { $("controls").close(); $("models").close(); controls = null; controlsVersion = ""; stopped = true; generation++; $("workspace").hidden = true; $("login").hidden = false; }
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
  navigation(false); $("models").close(); controls = null; controlsVersion = ""; legacyModelSelection = "auto"; $("model-picker").textContent = "Model · Loading…"; selected = id; cursor = 0; version = ""; $("title").textContent = title; $("messages").replaceChildren(); $("tasks").replaceChildren();
  for (const b of $("threads").children) b.setAttribute("aria-current", String(b.dataset.thread === id));
  welcome(); const run = ++generation; poll(run);
}
async function poll(run) {
  while (!stopped && run === generation) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 32000);
    try {
      const q = new URLSearchParams({ thread: selected, after: String(cursor), since: version, wait: version ? "25" : "0" });
      const view = await api(`/api/keir/app/thread?${q}`, null, controller.signal);
      if (run !== generation) return;
      if (view.messages?.length) $("welcome")?.remove();
      for (const row of view.messages || []) { const a = document.createElement("article"), author = document.createElement("strong"); a.className = row.role; author.textContent = row.role === "owner" ? "You" : "Keir"; a.append(author, document.createTextNode(row.text)); $("messages").append(a); }
      if (view.messages?.length) $("messages").scrollTop = $("messages").scrollHeight;
      cursor = view.cursor; version = view.version; $("connection").textContent = view.controls?.stopped ? "Stopped" : view.working ? "Working" : "Connected"; $("connection").dataset.state = view.controls?.stopped ? "stopped" : view.working ? "working" : "ready";
      legacyModelSelection = view.modelSelection || "auto";
      if (view.controls) renderControls(view.controls);
      $("tasks").replaceChildren();
      for (const task of view.tasks || []) {
        const div = document.createElement("div"), label = document.createElement("span"), stop = document.createElement("button"); div.className = "task";
        label.textContent = `${task.state}: ${task.status || task.title}${task.provider?.runner ? ` · ${task.provider.runner}:${task.provider.model}${task.provider.effort ? "@" + task.provider.effort : ""}` : ""}${task.skills?.length ? ` · ${task.skills.join(", ")}` : ""}`; stop.textContent = "Stop";
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
  const empty = document.createElement("div"), mark = document.createElement("div"), title = document.createElement("h2"), intro = document.createElement("p"), prompts = document.createElement("div");
  empty.id = "welcome"; mark.className = "presence-mark"; mark.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 5; i++) mark.append(document.createElement("i"));
  title.textContent = "What are we working on?"; intro.textContent = "Ask a question, investigate a problem, or put a plan into motion."; prompts.className = "starter-prompts";
  for (const [label, text] of [["Explore this project", "Explore this project and tell me how it works."], ["Investigate a problem", "Help me investigate a problem: "], ["Plan a change", "Help me plan a change: "]]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    button.onclick = () => { $("message").value = text; $("message").focus(); }; prompts.append(button);
  }
  empty.append(mark, title, intro, prompts); $("messages").append(empty);
}

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
