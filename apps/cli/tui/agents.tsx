/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { loadPeers, peerTask, listHandoffs, reconcileHandoff } from "../peers.mjs";
import { ink, Rail } from "./brand";
export function AgentRow(props: { name: string; machine: string; state: string; detail?: string; color?: string; compact?: boolean; onSelect?: () => void }) {
  return <Show when={!props.compact} fallback={<box flexDirection="row" gap={2} onMouseDown={props.onSelect}><text fg={ink.text}><span style={{ fg: props.color || ink.primary }}>● </span><b>{props.name}</b></text><text fg={props.color || ink.primary}>{props.state}</text><Show when={props.detail}><text fg={ink.muted}>{props.detail}</text></Show></box>}>
    <box paddingBottom={1} onMouseDown={props.onSelect}>
      <box flexDirection="row" justifyContent="space-between"><text fg={ink.text}><span style={{ fg: props.color || ink.primary }}>● </span><b>{props.name}</b></text><text fg={props.color || ink.primary}>{props.state}</text></box>
      <text fg={ink.muted}>{props.machine}</text>
      <Show when={props.detail}><text fg={ink.muted}>{props.detail}</text></Show>
    </box>
  </Show>;
}

export function PeerPanel(props: { peers: () => any[]; error: () => string; refresh?: () => Promise<void>; compact?: boolean; api: TuiPluginApi }) {
  return <box gap={1}>
    <Show when={!props.compact}><Rail title="Agents" /></Show>
    <Show when={props.refresh}><text fg={ink.primary} onMouseDown={() => { void props.refresh?.(); }}>Reconnect · /reconnect</text></Show>
    <Show when={props.error()}><text fg={ink.amber}>{props.error()}</text></Show>
    <Show when={!props.peers().length && !props.error()}><text fg={ink.muted}>No agents connected. Configure a peer to inspect or delegate work.</text></Show>
    <For each={props.peers()}>{peer => <AgentRow name={peer.name} machine={peer.kind === "keir" ? "Remote" : "OpenCode"} state={peer.state} compact={props.compact} detail={peer.state === "connected" ? `${peer.tasks.length} ${peer.tasks.length === 1 ? "task" : "tasks"} · ${peer.latencyMs ?? "?"} ms · inspect` : peer.stale ? `${peer.tasks.length} cached tasks · last connected ${new Date(peer.lastSuccessAt).toLocaleTimeString()} · reconnect` : peer.error || "Connection unavailable · inspect"} color={peer.state === "connected" ? ink.green : ink.amber} onSelect={() => showPeer(props.api, peer)} />}</For>
  </box>;
}

function showPeer(api: TuiPluginApi, peer: any) {
  if (peer.state !== "connected") { api.ui.toast({ variant: "warning", title: peer.name, message: peer.error || "Connection unavailable. Check the peer connection and credentials." }); return; }
  if (!peer.tasks.length) { api.ui.toast({ variant: "info", title: peer.name, message: "Connected. No tasks to inspect." }); return; }
  api.ui.dialog.replace(() => <api.ui.DialogSelect title={`${peer.name} · ${peer.state}`} options={peer.tasks.map((task: any) => ({ title: task.title || task.id, value: task.id, description: task.summary || task.state, footer: task.state }))} onSelect={async (row: any) => {
    try {
      const configured = loadPeers().find(item => item.id === peer.id);
      if (!configured) throw new Error("Peer is no longer configured");
      const result = await peerTask(configured, row.value, { signal: api.lifecycle.signal });
      api.ui.dialog.replace(() => <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}><box padding={2} gap={1}><Rail title={peer.name} right={result.state || "session"} /><scrollbox height={20}><text fg={ink.text}>{result.summary || result.messages?.flatMap((message: any) => message.info?.role === "assistant" ? (message.parts || []).filter((part: any) => part.type === "text").map((part: any) => part.text) : []).join("\n\n") || "No result yet."}</text></scrollbox></box></api.ui.Dialog>);
    } catch (error) { api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : "Could not load peer task" }); }
  }} />);
}

export function showHandoffs(api: TuiPluginApi) {
  const receipts = listHandoffs();
  if (!receipts.length) { api.ui.toast({ variant: "info", message: "No delegated work yet." }); return; }
  api.ui.dialog.replace(() => <api.ui.DialogSelect title="Delegated work" options={receipts.map(receipt => ({ title: receipt.spec.goal, value: receipt.id, description: `${receipt.peer} · ${receipt.spec.branch}`, footer: receipt.state }))} onSelect={async row => {
    try {
      const receipt = receipts.find(receipt => receipt.id === row.value);
      const peer = loadPeers().find(peer => peer.id === receipt.peer);
      if (!peer) throw new Error("The original peer is no longer configured");
      const current = await reconcileHandoff(peer, receipt.id, { signal: api.lifecycle.signal });
      const text = [current.spec.goal, `${current.spec.repository} · ${current.spec.branch}`, `Base: ${current.spec.base}`, `Status: ${current.remoteState || current.state}`, current.summary || current.error || (current.taskId ? `Remote task: ${current.taskId}` : "Dispatch is uncertain. Inspect the original peer before retrying.")].join("\n\n");
      api.ui.dialog.replace(() => <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}><box padding={2} gap={1}><Rail title={current.peer} right={current.state} /><scrollbox height={18}><text fg={ink.text}>{text}</text></scrollbox></box></api.ui.Dialog>);
    } catch (error) { api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : "Could not refresh delegated work" }); }
  }} />);
}

