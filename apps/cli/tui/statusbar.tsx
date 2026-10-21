/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import path from "node:path";
import { ink } from "./brand";
import { summarizeUsage, formatTokens, formatCost } from "./insights.mjs";
import { describeModel } from "./model-label.mjs";

/** Full-width Lakeside status line on every screen: where you are, what is connected, what this session costs. */
export function StatusBar(props: { api: TuiPluginApi; vps: () => string | undefined; peers: () => any[]; update: () => string | null | undefined; version: string }) {
  const dims = useTerminalDimensions();
  const sessionID = () => { const route = props.api.route.current; return route.name === "session" ? String(route.params?.sessionID || "") : ""; };
  const usage = createMemo(() => summarizeUsage(sessionID() ? props.api.state.session.messages(sessionID()) : []));
  const info = createMemo(() => describeModel(usage().provider, usage().model));
  const mcp = createMemo(() => props.api.state.mcp());
  const mcpUp = () => mcp().filter(m => m.status === "connected").length;
  const vpsDown = () => props.peers().some(p => p.state !== "connected");
  const wide = () => dims().width >= 110;
  return <box height={1} flexShrink={0} flexDirection="row" justifyContent="space-between" backgroundColor={ink.panel} paddingLeft={1} paddingRight={1}>
    <text height={1} wrapMode="none">
      <span style={{ fg: ink.bg, bg: ink.primary }}><b> ▲ LAKESIDE </b></span>
      <span style={{ fg: ink.text }}> {path.basename(props.api.state.path.directory) || "~"}</span>
      <Show when={props.api.state.vcs?.branch}><span style={{ fg: ink.blue }}>  ⎇ {props.api.state.vcs?.branch}</span></Show>
      <span style={{ fg: ink.dim }}>  │  </span>
      <span style={{ fg: props.vps() ? (vpsDown() ? ink.amber : ink.green) : ink.muted }}>{props.vps() ? "● VPS" : "○ local"}</span>
      <Show when={mcp().length > 0}><span style={{ fg: mcpUp() === mcp().length ? ink.green : ink.amber }}>  ● {mcpUp()}/{mcp().length} MCP</span></Show>
    </text>
    <text height={1} wrapMode="none">
      <Show when={usage().turns > 0}>
        <Show when={info().label}>
          <span style={{ fg: ink[info().color] }}>{info().glyph}</span>
          <span style={{ fg: ink.muted }}>{wide() ? ` ${info().label}  ` : "  "}</span>
        </Show>
        <span style={{ fg: ink.text }}>{formatTokens(usage().input + usage().cacheRead)}↑ {formatTokens(usage().output)}↓</span>
        <span style={{ fg: usage().cost ? ink.amber : ink.muted }}>  {formatCost(usage().cost)}</span>
        <span style={{ fg: ink.dim }}>  │  </span>
      </Show>
      <span style={{ fg: props.update() ? ink.amber : ink.muted }}>{props.update() ? `${props.update()} available · /doctor` : `v${props.version} · /doctor`}</span>
    </text>
  </box>;
}
