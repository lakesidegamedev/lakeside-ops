/** @jsxImportSource @opentui/solid */
import { createSignal, For, onCleanup, Show } from "solid-js";
import { sceneCells, toRuns } from "./scene.mjs";
type Color = any;
const midnight = { primary: "#8BB4E0", blue: "#7894AF", amber: "#D8BA8E", text: "#DDE5EF", muted: "#8B9AA9", dim: "#607B96", bg: "#0E141C", panel: "#151F2B", green: "#A4C9AE", red: "#E5A2A5" };
const [palette, setPalette] = createSignal<Record<keyof typeof midnight, Color>>(midnight);
// Reactive: components read ink.* inside JSX, so a theme change repaints them.
export const ink = Object.fromEntries(Object.keys(midnight).map(key => [key, undefined])) as Record<keyof typeof midnight, Color>;
for (const key of Object.keys(midnight) as (keyof typeof midnight)[]) Object.defineProperty(ink, key, { get: () => palette()[key], enumerable: true });
/** Follow the active OpenCode theme. */
export function syncInk(theme: { primary: Color; secondary: Color; warning: Color; text: Color; textMuted: Color; border: Color; background: Color; backgroundPanel: Color; success: Color; error: Color }) {
  setPalette({ primary: theme.primary, blue: theme.secondary, amber: theme.warning, text: theme.text, muted: theme.textMuted, dim: theme.border,
    bg: theme.background, panel: theme.backgroundPanel, green: theme.success, red: theme.error });
}
// Logo motion: on by default, off with LAKESIDE_CODE_REDUCE_MOTION=1 or /motion.
const [motion, setMotion] = createSignal(process.env.LAKESIDE_CODE_REDUCE_MOTION !== "1");
export { motion, setMotion };

/** The animated mountain-and-lake mark. Fixed size, so layout never jumps. */
export function Scene(props: { width?: number; sky?: number; mountain?: number; lake?: number }) {
  const [t, setT] = createSignal(0);
  const started = Date.now();
  const timer = setInterval(() => { if (motion()) setT((Date.now() - started) / 1000); }, 160);
  onCleanup(() => clearInterval(timer));
  const size = () => ({ width: props.width || 44, sky: props.sky ?? 1, mountain: props.mountain || 6, lake: props.lake || 3 });
  const rows = () => toRuns(sceneCells(motion() ? t() : 0, size()));
  return <box height={size().sky + size().mountain + 1 + size().lake} flexShrink={0}>
    <For each={rows()}>{row => <text height={1} flexShrink={0} wrapMode="none"><For each={row}>{run => <span style={{ fg: (ink as any)[run.c] || ink.muted }}>{run.text}</span>}</For></text>}</For>
  </box>;
}

export function Eyebrow(props: { children: any; color?: string }) {
  return <text fg={props.color || ink.muted}>{props.children}</text>;
}

export function Brand(props: { name: string; compact?: boolean; width?: number; sky?: number; mountain?: number; lake?: number }) {
  const size = () => ({ width: props.width || 44, sky: props.sky ?? 1, mountain: props.mountain ?? 6, lake: props.lake ?? 3 });
  return <box alignItems="center" gap={1} flexShrink={0} height={props.compact ? 3 : size().sky + size().mountain + 1 + size().lake + 2}>
    <Show when={!props.compact} fallback={<text height={1} flexShrink={0} fg={ink.primary}><b> ▲  ▰ </b><span style={{ fg: ink.dim }}>━━━━━━</span></text>}><Scene width={size().width} sky={size().sky} mountain={size().mountain} lake={size().lake} /></Show>
    <text fg={ink.text}><b>{props.name.toUpperCase().split("").join(" ")}</b></text>
  </box>;
}

export function Rail(props: { title: string; right?: string; color?: string }) {
  return <box flexDirection="row" justifyContent="space-between" paddingBottom={1}>
    <text fg={props.color || ink.primary}><b>{props.title}</b></text>
    <text fg={ink.muted}>{props.right || ""}</text>
  </box>;
}

