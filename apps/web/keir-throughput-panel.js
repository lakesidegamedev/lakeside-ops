"use strict";

// Actual tasks are the visual units. Columns express recorded state, never
// inferred completion percentages. All nodes survive unchanged polls.
function createThroughputPanel(root, { onJob = () => {} } = {}) {
  const el = (tag, cls, value) => { const n = document.createElement(tag); n.className = cls || ""; if (value !== undefined) n.textContent = value; return n; };
  const text = (n, value) => { const s = String(value ?? ""); if (n.textContent !== s) n.textContent = s; };
  const age = (ms) => ms == null ? "Age not recorded" : ms < 60000 ? "Under a minute" : ms < 3600000 ? Math.floor(ms / 60000) + "m" : Math.floor(ms / 3600000) + "h " + Math.floor(ms % 3600000 / 60000) + "m";
  const labels = { executing: "Executing", queued: "Queued", dependency: "Waiting for delegated work", ci: "Waiting for checks", owner: "Owner decision", turn: "Waiting for a game turn", schedule: "Release held for owner hours", other: "Wait reason not recorded" };
  const head = el("div", "kt-head"), title = el("div", "");
  title.append(el("span", "kt-eyebrow", "DELIVERY CONTROL"), el("h2", "", "Work in motion"), el("p", "kt-intro", "Follow the tickets. See the gates. Open any task for the evidence."));
  const health = el("span", "kt-health"); head.append(title, health);
  const map = el("div", "kt-map"), columns = new Map();
  const stages = [["queued", "Queued", "Ready for a slot"], ["investigation", "Investigating", "Confirming the cause"], ["coding", "Building", "Preparing a fix"], ["ci", "Checks", "Waiting on verification"], ["release", "Release", "Promotion or rollout"]];
  for (const [id, label, hint] of stages) {
    const lane = el("section", "kt-lane"); lane.dataset.stage = id; lane.setAttribute("aria-label", label);
    const heading = el("div", "kt-lanehead"), mark = el("i", "kt-station"); heading.append(mark, el("h3", "", label));
    const list = el("div", "kt-tasks"), empty = el("span", "kt-lane-empty", "Clear");
    lane.append(heading, el("small", "kt-lanehint", hint), list, empty); map.append(lane); columns.set(id, { lane, list, empty });
  }
  const branches = el("div", "kt-branches");
  for (const [id, label, hint] of [["approval", "Owner gate", "A decision is the next move"], ["unknown", "Other waits", "Next step not yet recorded"], ["monitoring", "Under observation", "Closed or in closure grace"]]) {
    const lane = el("section", "kt-branch"); lane.dataset.stage = id;
    const heading = el("div", "kt-branch-title"); heading.append(el("i", "kt-station"), el("b", "", label), el("small", "", hint));
    const list = el("div", "kt-branch-list"), empty = el("span", "kt-lane-empty", "Clear"); lane.append(heading, list, empty); branches.append(lane); columns.set(id, { lane, list, empty });
  }
  const inspector = el("div", "kt-inspector"), inspectorCopy = el("div", ""), inspectorTitle = el("b", "", "Select a ticket on the map"), inspectorText = el("p", "", "Only recorded task and dependency state determines a ticket's position.");
  const open = el("button", "kh-btn2", "Open task detail"); open.type = "button"; open.hidden = true; open.onclick = () => { if (selected) onJob(selected); };
  inspectorCopy.append(inspectorTitle, inspectorText); inspector.append(inspectorCopy, open);
  const details = el("details", "kt-method"); details.append(el("summary", "", "Timing, exhaustion and counting receipts"));
  const receipts = el("p", "kt-receipts"), foot = el("p", "kt-foot"), source = el("p", "kt-source"); details.append(receipts, foot, source);
  root.replaceChildren(head, map, branches, inspector, details);
  let state = null, selected = null;
  const nodes = new Map();
  function inspect() {
    const row = state?.work?.find((r) => r.id === selected);
    if (!row) { selected = null; open.hidden = true; text(inspectorTitle, "Select a ticket on the map"); text(inspectorText, "Task positions come from recorded state. Owner approval is a separate gate, not a guaranteed release step."); return; }
    text(inspectorTitle, row.label + " · " + (labels[row.category] || row.category));
    const facts = [row.children ? row.children + " live delegated jobs" + (row.queuedChildren ? ", " + row.queuedChildren + " queued" : "") : "No live delegated jobs", Math.round(row.modelMs / 60000) + " completed model minutes", row.activations + " activations in this window"];
    if (row.exhausted) facts.push(row.exhausted + " exhausted" + (row.repeatedExhaustion ? "; repeated budget exhaustion needs attention" : ""));
    if (row.blockedChildren) facts.push(row.blockedChildren + " delegated job returned blocked");
    if (row.category !== "executing") facts.push(age(row.ageMs) + (row.waitSince ? " at this gate" : " since root-job update; exact wait start unknown"));
    text(inspectorText, facts.join(" · ")); open.hidden = false;
  }
  return { update(next) {
    if (!next) { text(health, "Local snapshot unavailable"); return; }
    state = next; const c = state.counts, cost = state.cost;
    text(health, state.paused ? "Operator paused" : c.executing ? "Execution in progress" : "Between activations"); health.dataset.busy = String(!state.paused && c.executing > 0);
    const work = (state.work || []).filter((r) => r.active), keep = new Set(), positions = new Map();
    for (const row of work) {
      keep.add(row.id); const stage = columns.has(row.stage) ? row.stage : "unknown", column = columns.get(stage);
      let item = nodes.get(row.id);
      if (!item) {
        const node = el("button", "kt-ticket"); node.type = "button";
        const top = el("span", "kt-ticket-top"), signal = el("i", "kt-signal"), name = el("b", ""), hint = el("span", "kt-ticket-hint"), warning = el("i", "kt-alert");
        top.append(signal, name, warning); node.append(top, hint);
        node.onclick = () => { selected = row.id; for (const [id, n] of nodes) { n.node.classList.toggle("selected", id === selected); n.node.setAttribute("aria-pressed", String(id === selected)); } inspect(); };
        item = { node, name, hint, warning }; nodes.set(row.id, item);
      }
      text(item.name, row.label);
      text(item.hint, row.category === "executing" ? "Working now" : row.category === "ci" ? "Checks pending" : row.category === "owner" ? "Decision needed" : row.monitoring ? "Monitoring" : row.blockedChildren ? "Child returned blocked" : row.category === "dependency" ? "Waiting for subworker" : labels[row.category] || row.category);
      text(item.warning, row.repeatedExhaustion || row.blockedChildren ? "!" : "");
      item.warning.hidden = !row.repeatedExhaustion && !row.blockedChildren;
      item.node.dataset.running = String(!state.paused && row.category === "executing");
      item.node.classList.toggle("gated", ["ci", "approval"].includes(stage));
      item.node.classList.toggle("stalled", row.category !== "executing" && row.ageMs >= 1800000);
      item.node.classList.toggle("selected", row.id === selected); item.node.setAttribute("aria-pressed", String(row.id === selected));
      item.node.title = row.label + ": " + (labels[row.category] || row.category) + (row.category !== "executing" ? "; " + age(row.ageMs) + (row.waitSince ? " waiting" : " since update") : "") + (row.repeatedExhaustion ? "; repeated budget exhaustion" : "");
      const position = positions.get(stage) || 0; positions.set(stage, position + 1);
      if (column.list.children[position] !== item.node) {
        const focused = document.activeElement === item.node;
        column.list.insertBefore(item.node, column.list.children[position] || null);
        if (focused) item.node.focus({ preventScroll: true });
      }
      if (item.stage && item.stage !== stage && !matchMedia("(prefers-reduced-motion: reduce)").matches) item.node.animate([{ opacity: .5, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "ease-out" });
      item.stage = stage;
    }
    for (const [id, item] of nodes) if (!keep.has(id)) { item.node.remove(); nodes.delete(id); }
    for (const [stage, column] of columns) {
      column.empty.hidden = Boolean(positions.get(stage));
      column.lane.dataset.active = String(!state.paused && work.some((r) => r.stage === stage && r.category === "executing"));
      column.lane.classList.toggle("has-work", Boolean(positions.get(stage)));
    }
    text(receipts, "Last " + Math.round(state.windowMs / 3600000) + "h: " + Math.round(cost.modelMs / 60000) + " completed model minutes across " + cost.activations + " activations; " + cost.exhausted + " budget exhaustions. Ledger: " + c.ticketRoots + " distinct root ticket tasks, " + c.childJobs + " live child jobs. " + c.monitoringTicketRoots + " roots are resolved monitoring or closure grace.");
    text(foot, state.note + (state.hiddenWork ? " " + state.hiddenWork + " additional root tasks omitted from this bounded map." : ""));
    const sample = state.supportSample;
    text(source, sample?.available ? "Support-list sample: " + sample.count + " of at most " + sample.limit + " recent records. " + Object.entries(sample.statuses).map(([key, n]) => n + " " + key.replace(/_/g, " ")).join(" · ") + ". This is not the total support backlog." : "Canonical support sample unavailable. Task state comes from the local ledger.");
    inspect();
  } };
}
const THROUGHPUT_CSS = `
.kt [hidden]{display:none!important}
.kt{border:1px solid color-mix(in srgb,var(--accent) 25%,var(--border));border-radius:16px;overflow:hidden;background:radial-gradient(ellipse at 20% 0,color-mix(in srgb,var(--accent) 6%,transparent),transparent 65%),var(--surface)}
.kt-head{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:25px 28px 22px}.kt-eyebrow{font:650 10px var(--mono);letter-spacing:.16em;color:var(--accent)}.kt h2{font-size:clamp(23px,2.8vw,32px);font-weight:650;letter-spacing:-.04em;margin:7px 0 4px;line-height:1.15}.kt-intro{font-size:12px;color:var(--text-3);margin:0}.kt-health{font:500 10px var(--mono);color:var(--text-3);white-space:nowrap;display:flex;align-items:center;gap:7px}.kt-health:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--text-3)}.kt-health[data-busy=true]:before{background:var(--st-good);animation:ktSignal 2.2s ease-in-out infinite}
.kt-map{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;padding:0 20px 20px}.kt-lane{position:relative;padding:0 9px;min-height:200px;min-width:0}.kt-lanehead{display:flex;align-items:center;gap:8px;position:relative;height:38px}.kt-lanehead:after{content:'';height:1px;position:absolute;top:18px;left:18px;right:-9px;background:var(--border);z-index:0}.kt-lane:last-child .kt-lanehead:after{right:0}.kt-lane h3{position:relative;z-index:1;font-size:11px;font-weight:600;background:var(--surface);padding-right:9px;color:var(--text-2)}.kt-station{position:relative;z-index:1;display:inline-block;width:9px;height:9px;border:1.5px solid var(--text-3);border-radius:50%;background:var(--surface);flex:none}.kt-lane[data-active=true] .kt-station{border-color:var(--accent);background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}.kt-lanehint{display:block;min-height:28px;font-size:9px;color:var(--text-3);line-height:1.4}.kt-tasks{position:relative;display:flex;flex-direction:column;gap:8px;min-height:104px;padding:8px 0}.kt-tasks:before{content:'';position:absolute;left:3px;top:8px;bottom:5px;border-left:1px dashed var(--border)}.kt-lane[data-active=true] .kt-tasks:before{border-color:var(--accent);background:linear-gradient(transparent,var(--accent),transparent);background-size:1px 36px;animation:ktPath 2.6s linear infinite}.kt-lane-empty{display:block;font:10px var(--mono);color:var(--text-3);opacity:.5;padding:10px 0 0 12px}
.kt-ticket{position:relative;min-width:0;display:flex;flex-direction:column;gap:8px;margin-left:12px;padding:13px 11px;text-align:left;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);cursor:pointer;box-shadow:0 2px 6px -4px #0005;transition:border-color .18s,background .18s}.kt-ticket:before{content:'';position:absolute;top:20px;width:10px;height:1px;left:-11px;background:var(--border)}.kt-ticket:hover{border-color:var(--accent);background:var(--accent-soft)}.kt-ticket.selected{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}.kt-ticket-top{display:flex;align-items:center;gap:6px;min-width:0}.kt-ticket-top b{font:550 10px var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kt-signal{width:5px;height:5px;border-radius:50%;flex:none;background:var(--text-3)}.kt-ticket[data-running=true]{border-color:color-mix(in srgb,var(--accent) 55%,var(--border))}.kt-ticket[data-running=true] .kt-signal{background:var(--accent);animation:ktSignal 2s ease-in-out infinite}.kt-ticket-hint{font-size:9px;color:var(--text-3);line-height:1.35}.kt-alert{font:600 10px var(--mono);color:var(--st-serious);margin-left:auto;font-style:normal}.kt-ticket.gated,.kt-ticket.stalled{border-color:color-mix(in srgb,var(--st-warn) 40%,var(--border));background:color-mix(in srgb,var(--st-warn) 5%,var(--surface))}.kt-ticket.gated .kt-signal,.kt-ticket.stalled .kt-signal{background:var(--st-warn)}
.kt-branches{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin:0 28px 22px;padding-top:18px;border-top:1px dashed var(--border)}.kt-branch{position:relative;min-width:0;padding-left:13px;border-left:1px solid var(--border)}.kt-branch[data-stage=approval].has-work{border-left-color:var(--st-warn)}.kt-branch-title{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.kt-branch-title b{font-size:10px;font-weight:600;color:var(--text-2)}.kt-branch-title small{flex-basis:100%;font-size:9px;color:var(--text-3);margin-left:17px}.kt-branch[data-stage=approval].has-work .kt-station{border-color:var(--st-warn);background:var(--st-warn)}.kt-branch-list{display:flex;flex-wrap:wrap;gap:8px}.kt-branch .kt-ticket{margin:0;min-width:115px}.kt-branch .kt-ticket:before{display:none}.kt-branch .kt-lane-empty{padding-top:4px}
.kt-inspector{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:17px 28px;background:color-mix(in srgb,var(--bg-0) 35%,transparent);border-top:1px solid var(--border);min-height:76px}.kt-inspector b{font-size:11px;font-weight:600}.kt-inspector p{font-size:10px;color:var(--text-3);line-height:1.6;margin:5px 0 0;max-width:100ch}.kt-inspector button{font-size:10px;white-space:nowrap}.kt-method{padding:12px 28px;font-size:10px;color:var(--text-3);border-top:1px solid var(--border)}.kt-method summary{cursor:pointer}.kt-method p{margin:9px 0;line-height:1.65}
.kh-diagnostics{border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--surface) 60%,transparent)}.kh-diagnostics>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 20px;cursor:pointer;font-size:13px;font-weight:600;list-style:none}.kh-diagnostics>summary:after{content:'+';color:var(--text-3);font:18px var(--mono)}.kh-diagnostics[open]>summary:after{content:'−'}.kh-diagnostics>summary small{font-size:11px;font-weight:400;color:var(--text-3);margin-right:auto}.kh-diagnostics-body{display:flex;flex-direction:column;gap:14px;padding:0 14px 14px}.kh-diagnostics .kh-panel{box-shadow:none}
@keyframes ktSignal{0%,100%{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 10%,transparent)}50%{box-shadow:0 0 0 5px transparent}}@keyframes ktPath{to{background-position:0 36px}}
@media(max-width:850px){.kt-head{padding:20px;align-items:flex-start}.kt-health{font-size:9px;max-width:90px;white-space:normal;line-height:1.5}.kt-intro{font-size:10px;max-width:32ch}.kt-map{grid-template-columns:1fr;gap:0;padding:0 20px 12px}.kt-lane{display:grid;grid-template-columns:100px minmax(0,1fr);gap:0 12px;min-height:90px;padding:0 0 14px 0}.kt-lanehead{grid-column:1}.kt-lanehead:after{left:4px;top:30px;bottom:-72px;width:1px;height:auto;right:auto}.kt-lane:last-child .kt-lanehead:after{display:none}.kt-lanehint{grid-column:1;font-size:9px;padding-left:17px;align-self:start}.kt-tasks{grid-column:2;grid-row:1 / span 2;padding:5px 0;min-height:0}.kt-tasks:before{display:none}.kt-lane-empty{grid-column:2;grid-row:1 / span 2;align-self:start;padding:16px 0}.kt-ticket{margin-left:0;max-width:100%}.kt-ticket:before{left:-13px;width:12px}.kt-ticket-top b{font-size:11px}.kt-ticket-hint{font-size:10px}.kt-branches{grid-template-columns:1fr;gap:14px;margin:0 20px 20px}.kt-branch-title small{flex-basis:auto;font-size:9px;margin-left:0}.kt-branch .kt-lane-empty{margin-left:16px}.kt-inspector{padding:15px 20px;flex-direction:column;align-items:flex-start;gap:10px}.kt-method{padding:12px 20px}.kh-diagnostics>summary small{display:none}}
@media(prefers-reduced-motion:reduce){.kt *,.kt *:before,.kt *:after{animation:none!important;transition:none!important}}
`;
module.exports = { createThroughputPanel, THROUGHPUT_CSS };
