/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { ink, Rail } from "./brand";
import { summarizeUsage, formatTokens, formatCost, projectStatuses, doctorChecks } from "./insights.mjs";
import { describeModel } from "./model-label.mjs";
import { loadProjects } from "../workspace/projects.mjs";

const dot = (level: string) => level === "ok" || level === "connected" ? ink.green : level === "error" || level === "failed" ? ink.red : level === "warn" ? ink.amber : ink.muted;

/** Model, tokens and cost for the open session. */
export function SessionStatus(props: { api: TuiPluginApi; sessionID?: string }) {
  const usage = createMemo(() => summarizeUsage(props.sessionID ? props.api.state.session.messages(props.sessionID) : []));
  const info = createMemo(() => describeModel(usage().provider, usage().model));
  return <Show when={usage().turns > 0}>
    <box>
      <Rail title="Session" right={`${usage().turns} turns`} />
      <Show when={info().label} fallback={<text fg={ink.muted}>model pending</text>}>
        <text fg={ink[info().color]}>{info().glyph} <span style={{ fg: ink.text }}>{info().provider || info().model}</span></text>
        <Show when={info().provider && info().model}><text fg={ink.muted}>  {info().model}</text></Show>
      </Show>
      <text fg={ink.muted}>{formatTokens(usage().input)} in · {formatTokens(usage().output)} out{usage().cacheRead ? ` · ${formatTokens(usage().cacheRead)} cached` : ""}</text>
      <text fg={usage().cost ? ink.amber : ink.muted}>{formatCost(usage().cost)}</text>
    </box>
  </Show>;
}

/** MCP servers and remote connection at a glance; click opens /doctor. */
export function HealthList(props: { api: TuiPluginApi; vpsOrigin: () => string | undefined; peers: () => any[] }) {
  const mcp = createMemo(() => props.api.state.mcp());
  const down = createMemo(() => props.peers().filter(p => p.state !== "connected"));
  return <box onMouseDown={() => props.api.command?.trigger("lakeside.doctor")}>
    <Rail title="Health" right="/doctor" />
    <Show when={props.vpsOrigin()} fallback={<text fg={ink.muted}>○ VPS not connected</text>}>
      <text fg={down().length ? ink.amber : ink.green}>● <span style={{ fg: ink.text }}>VPS</span><span style={{ fg: ink.muted }}>{down().length ? `  ${down().length} offline` : "  connected"}</span></text>
    </Show>
    <For each={mcp().slice(0, 8)}>{item =>
      <text fg={dot(item.status)}>● <span style={{ fg: ink.text }}>{item.name}</span><span style={{ fg: ink.muted }}>{item.status === "connected" ? "" : `  ${item.error || item.status}`}</span></text>}
    </For>
    <Show when={mcp().length > 8}><text fg={ink.muted}>+{mcp().length - 8} more</text></Show>
  </box>;
}

/** Registered projects with branch and uncommitted changes. Click fills a load request. */
export function ProjectsPanel(props: { onPick: (name: string) => void; limit?: number }) {
  const [rows, setRows] = createSignal<ReturnType<typeof projectStatuses>>([]);
  const read = () => { try { setRows(projectStatuses(loadProjects())); } catch { setRows([]); } };
  read();
  const timer = setInterval(read, 30000);
  onCleanup(() => clearInterval(timer));
  return <Show when={rows().length > 0} fallback={<text fg={ink.muted}>No registered projects. Run lakeside code projects add NAME PATH.</text>}>
    <box>
      <Rail title="Projects" right={`${rows().length} registered · click to load`} />
      <For each={rows().slice(0, props.limit || 8)}>{row =>
        <box flexDirection="row" gap={2} onMouseDown={() => props.onPick(row.name)}>
          <text fg={ink.primary} width={18}>{row.name}</text>
          <text fg={row.ok ? ink.muted : ink.red} width={22}>{row.ok ? `⎇ ${row.branch}` : "not a git checkout"}</text>
          <text fg={row.changes ? ink.amber : ink.dim}>{row.ok ? (row.changes ? `${row.changes} changed` : "clean") : ""}</text>
        </box>}
      </For>
    </box>
  </Show>;
}

/** /doctor: every check with what to do about it. */
export function showDoctor(api: TuiPluginApi, input: { vps: { origin?: string } | null; peers: any[]; engine: string; version: string; update: () => string | null | undefined; refresh: () => void }) {
  const rows = () => doctorChecks({ providers: api.state.provider, mcp: api.state.mcp(), vps: input.vps, peers: input.peers, engine: input.engine, version: input.version, update: input.update() });
  api.ui.dialog.replace(() => <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}>
    <box padding={2} gap={1}>
      <Rail title="Lakeside Code doctor" right="esc to close" />
      <For each={rows()}>{row =>
        <box flexDirection="row" gap={2}>
          <text fg={dot(row.level)} width={2}>●</text>
          <text fg={ink.text} width={14}><b>{row.label}</b></text>
          <text fg={row.level === "ok" ? ink.muted : ink.text}>{row.detail}</text>
        </box>}
      </For>
      <text fg={ink.primary} onMouseDown={() => { input.refresh(); api.ui.dialog.clear(); showDoctor(api, input); }}>Recheck</text>
    </box>
  </api.ui.Dialog>);
}
