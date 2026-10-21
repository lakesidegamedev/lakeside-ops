import { loadVps, readVpsToken } from "./vps-profile.mjs";
/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui";
import { loadPeers, inspectPeer } from "./peers.mjs";
import { createPeerMonitor } from "./peer-monitor.mjs";
import { ink, Brand, Scene, syncInk, motion, setMotion } from "./tui/brand";
import { StatusBar } from "./tui/statusbar";
import { SessionStatus, HealthList, ProjectsPanel, showDoctor } from "./tui/status";
import { newerRelease } from "./tui/insights.mjs";
import { StudioPanel, showStudio } from "./tui/studio";
import { loadStudio } from "./integrations/studio.mjs";
import { PeerPanel, showHandoffs } from "./tui/agents";
import { SessionActions, showWorkbench } from "./tui/workbench";
import { NativeSession } from "./tui/native";
import { Preview } from "./tui/preview";
import path from "node:path";
export default {
  id: "lakeside.code.terminal",
  async tui(api: TuiPluginApi, options: { name?: string; backend?: string; version?: string; engine?: string } | undefined) {
    const name = options?.name || "Lakeside Code";
    const version = options?.version || "unknown", engine = options?.engine || "unknown";
    for (const id of ["internal:home-tips", "internal:sidebar-context", "internal:sidebar-lsp", "internal:sidebar-mcp", "internal:sidebar-footer"]) await api.plugins.deactivate(id);
    createEffect(() => {
      const route = api.route.current;
      const session = route.name === "session" ? api.state.session.get(route.params?.sessionID as string) : undefined;
      api.renderer.setTerminalTitle(session?.title ? `${name} | ${session.title.slice(0, 60)}` : name);
    });
    const [peers, setPeers] = createSignal<Awaited<ReturnType<typeof inspectPeer>>[]>([]);
    const [peerError, setPeerError] = createSignal("");
    let prompt: TuiPromptRef | undefined;
    let stopped = false, refreshing = false;
    const controller = new AbortController();
    const monitor = createPeerMonitor();
    // MCP config is read when the engine starts, so a VPS connected from inside a
    // running terminal had no remote tools until a restart. Attach it live instead.
    const attached = new Set<string>();
    async function attachVps() {
      let profile;
      try { profile = loadVps(); } catch { return; }
      if (!profile || api.state.mcp().some(m => m.name === profile.id && m.status === "connected")) return;
      const key = `${profile.id}:${profile.origin}:${profile.tokenFile}`;
      if (attached.has(key)) return;
      attached.add(key);
      try {
        const token = readVpsToken(profile.tokenFile);
        const url = profile.kind === "keir" ? `${profile.origin}/api/keir/app/desktop/mcp` : profile.origin;
        const headers = profile.auth === "cookie" ? { Cookie: `${profile.cookieName}=${token}` } : { Authorization: `Bearer ${token}` };
        await (api.client as any).mcp.add({ body: { name: profile.id, config: { type: "remote", url, oauth: false, headers, timeout: 15000 } } });
        api.ui.toast({ variant: "success", title: "Remote tools connected", message: `${profile.name} tools are available to the agent now.` });
      } catch { attached.delete(key); }
    }
    async function refresh() {
      if (stopped || refreshing) return;
      refreshing = true;
      void attachVps();
      try { const configured = loadPeers(); setPeers(await monitor.refresh(configured, { signal: controller.signal })); setPeerError(""); }
      catch { setPeerError("Peer configuration could not be loaded. Local coding is available."); }
      finally { refreshing = false; }
    }
    void refresh();
    const poll = setInterval(refresh, 10000);
    api.lifecycle.onDispose(() => { stopped = true; clearInterval(poll); controller.abort(); });
    const themes = [
      { value: "midnight", title: "Midnight", description: "Lakeside dark (default)" },
      { value: "daybreak", title: "Daybreak", description: "Light, for bright rooms" },
      { value: "contrast", title: "High contrast", description: "Black background, brighter text" },
    ];
    for (const theme of themes) await api.theme.install(path.join(import.meta.dir, `${theme.value}.json`));
    const applyTheme = (value: string) => { if (api.theme.set(value)) syncInk(api.theme.current as any); };
    const savedTheme = () => String(api.kv.get("lakeside.theme", "midnight"));
    if (api.kv.get("lakeside.motion", true) === false) setMotion(false);
    applyTheme(themes.some(t => t.value === savedTheme()) ? savedTheme() : "midnight");
    const chooseTheme = () => api.ui.dialog.replace(() => <api.ui.DialogSelect title="Theme" current={api.theme.selected} options={themes}
      onMove={option => applyTheme(String(option.value))}
      onSelect={option => { applyTheme(String(option.value)); api.kv.set("lakeside.theme", option.value); api.ui.dialog.clear(); api.ui.toast({ variant: "success", message: `Theme: ${option.title}` }); }} />);
    // Release check: once a day, anonymous, never blocks startup or installs anything.
    const [update, setUpdate] = createSignal<string | null | undefined>(undefined);
    async function checkUpdate(force = false) {
      const last = Number(api.kv.get("lakeside.update.checkedAt", 0));
      if (!force && Date.now() - last < 86400000) { setUpdate(api.kv.get("lakeside.update.available", null) as string | null); return; }
      try {
        const repo = process.env.LAKESIDE_CODE_UPDATE_REPO || "lakesidegamedev/lakeside-ops";
        const channel = process.env.LAKESIDE_CODE_UPDATE_CHANNEL === "stable" ? "stable" : "preview";
        const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/vnd.github+json" } });
        if (!response.ok) throw new Error(String(response.status));
        const found = newerRelease(version, await response.json(), channel);
        api.kv.set("lakeside.update.checkedAt", Date.now()); api.kv.set("lakeside.update.available", found);
        setUpdate(found);
        if (found) api.ui.toast({ variant: "info", title: "Update available", message: `${found} is out. Exit and run lakeside code update.` });
      } catch { setUpdate(null); }
    }
    if (version !== "unknown") void checkUpdate();
    // Studio panels: only with a Keir VPS profile; read-only, every minute.
    const [studio, setStudio] = createSignal<any>(undefined);
    async function refreshStudio() { if (loadVps()?.kind !== "keir") { setStudio(undefined); return; } setStudio(await loadStudio().catch(() => ({ state: "error", detail: "Studio panels failed to load." }))); }
    void refreshStudio();
    const studioPoll = setInterval(refreshStudio, 60000);
    api.lifecycle.onDispose(() => clearInterval(studioPoll));
    api.route.register([{ name: "lakeside.preview", render: () => <Preview api={api} name={name} /> }, { name: "lakeside.native", render: () => <NativeSession api={api} name={name} /> }]);
    if (options?.backend && options.backend !== "api") createEffect(() => {
      if (api.route.current.name !== "lakeside.native") api.route.navigate("lakeside.native");
    });
    const fillPrompt = (text: string) => {
      api.ui.dialog.clear();
      if (prompt?.current.input.trim()) {
        api.ui.toast({ variant: "warning", message: "Send or clear your draft before choosing a workflow action." }); return;
      }
      queueMicrotask(() => { prompt?.set({ input: text, parts: [] }); prompt?.focus(); });
    };
    const shortcuts = [
      { label: "Inspect project", slash: "inspect-project", prompt: "Inspect this project, read its instructions and explain its architecture." },
      { label: "Review changes", slash: "review-changes", prompt: "Review the current diff for bugs and missing validation." },
    ];
    api.command?.register(() => [
      { title: "VPS connection and setup", value: "lakeside.vps", category: "Lakeside Code", slash: { name: "vps" }, onSelect: () => { const profile = loadVps(); api.ui.toast({ variant: "info", title: "Remote workspace", message: profile ? `${profile.origin} · /connections for MCP status · /agents for Keir tasks` : "Not configured. Run lakeside code vps connect --url HTTPS_ORIGIN --token-file LOCAL_FILE" }); } },
      { title: "Load and manage projects", value: "lakeside.projects", category: "Lakeside Code", slash: { name: "projects" }, onSelect: () => fillPrompt("List registered and loaded local projects with project_list. Load only the projects needed for my task using project_load. Multiple projects can stay loaded; keep their instructions and working directories separate.") },
      { title: "Reconnect VPS and agents", value: "lakeside.reconnect", category: "Lakeside Code", slash: { name: "reconnect" }, onSelect: () => { void refresh(); } },
      { title: "Validate changes", value: "lakeside.validate-changes", category: "Lakeside Code", slash: { name: "validate-changes" }, onSelect: () => fillPrompt("Read project instructions and run the smallest relevant permitted checks for the current diff. Record exact outcomes and remaining validation gaps.") },
      ...shortcuts.map(action => ({ title: action.label, value: `lakeside.${action.slash}`, category: "Lakeside Code", slash: { name: action.slash }, onSelect: () => fillPrompt(action.prompt) })),
      { title: "Lakeside Code: live workbench", value: "lakeside.workbench", category: "Lakeside Code", slash: { name: "workbench" }, onSelect: () => showWorkbench(api) },
      { title: "Lakeside Code: connections", value: "lakeside.connections", category: "Lakeside Code", slash: { name: "connections" }, onSelect: () => showWorkbench(api, "connections") },
      { title: "Lakeside Code: visual preview", value: "lakeside.preview", category: "Lakeside Code", slash: { name: "preview" }, onSelect: () => { api.ui.dialog.clear(); api.route.navigate("lakeside.preview"); } },
      { title: "Lakeside Code: connected agents", value: "lakeside.agents", category: "Lakeside Code", slash: { name: "agents" }, onSelect: () => { api.ui.dialog.replace(() => <api.ui.Dialog size="large" onClose={() => api.ui.dialog.clear()}><box padding={2}><PeerPanel api={api} peers={peers} error={peerError} refresh={refresh} /></box></api.ui.Dialog>); } },
      { title: "Lakeside Code: delegated work", value: "lakeside.handoffs", category: "Lakeside Code", slash: { name: "handoffs" }, onSelect: () => showHandoffs(api) },
      { title: "Lakeside Code: studio tickets and kanban", value: "lakeside.studio", category: "Lakeside Code", slash: { name: "studio" }, onSelect: () => { void refreshStudio(); showStudio(api, { studio: () => studio() || { state: loadVps()?.kind === "keir" ? "loading" : "unconfigured", detail: loadVps()?.kind === "keir" ? "Loading..." : "Studio panels need a Keir VPS. Run lakeside code vps connect." }, onPrompt: fillPrompt, refresh: () => void refreshStudio() }); } },
      { title: "Lakeside Code: toggle logo animation", value: "lakeside.motion", category: "Lakeside Code", slash: { name: "motion" }, onSelect: () => { setMotion(!motion()); api.kv.set("lakeside.motion", motion()); api.ui.toast({ variant: "info", message: motion() ? "Logo animation on" : "Logo animation off" }); } },
      { title: "Lakeside Code: theme", value: "lakeside.theme", category: "Lakeside Code", slash: { name: "theme" }, onSelect: chooseTheme },
      { title: "Lakeside Code: doctor", value: "lakeside.doctor", category: "Lakeside Code", slash: { name: "doctor" }, onSelect: () => showDoctor(api, { vps: loadVps(), peers: peers(), engine, version, update, refresh: () => { void refresh(); void checkUpdate(true); } }) },
    ]);
    api.slots.register({ order: -100, slots: {
      home_logo() {
        const dimensions = useTerminalDimensions();
        const height = dimensions().height, columns = dimensions().width;
        const compact = height < 26 || columns < 60;
        const lake = height >= 40 ? 4 : height >= 30 ? 3 : 2;
        // The peer panel joins the footer from 38 rows up; give it its rows back.
        const reserved = height >= 38 && (peers().length > 0 || peerError()) ? 28 : 15;
        const mountain = Math.max(5, Math.min(16, height - reserved - lake));
        const width = Math.max(24, Math.min(120, columns - 4));
        return <Brand name={name} compact={compact} width={width} sky={1} mountain={mountain} lake={lake} />;
      },
      session_prompt(_ctx, props) { return <box gap={1}><box flexDirection="row" justifyContent="space-between"><text fg={ink.primary}><b>▲ {name}</b></text><text fg={ink.muted} onMouseDown={() => showWorkbench(api)}>/workbench · changes, commands, connections</text></box><api.ui.Prompt sessionID={props.session_id} visible={props.visible} disabled={props.disabled} onSubmit={props.on_submit} ref={value => { prompt = value; props.ref?.(value); }} /></box>; },
      sidebar_title(_ctx, props) { return <box gap={1} flexShrink={0}><Scene width={34} sky={0} mountain={3} lake={1} /><text fg={ink.primary}><b>LAKESIDE CODE</b></text><text fg={ink.text}>{props.title}</text><text fg={ink.muted}>{path.basename(api.state.path.directory)}<span style={{ fg: ink.primary }}>{api.state.vcs?.branch ? `  ⎇ ${api.state.vcs.branch}` : ""}</span></text></box>; },
      app_bottom() { return <StatusBar api={api} vps={() => { peers(); try { return loadVps()?.origin; } catch { return undefined; } }} peers={peers} update={update} version={version} />; },
      sidebar_footer() { return <text fg={ink.dim}>/studio · /doctor · /theme · /motion</text>; },
      home_prompt(_ctx, props) { return <api.ui.Prompt ref={value => { prompt = value; props.ref?.(value); }} placeholders={{ normal: ["What are we building?", "Inspect this project and find the next useful change", "Review my changes before I commit"] }} />; },
      home_bottom() {
        const dimensions = useTerminalDimensions();
        return <box width="auto" maxWidth={90} paddingTop={1} gap={1}>
          <text fg={ink.primary} onMouseDown={() => api.command?.trigger("lakeside.vps")}>{loadVps() ? "VPS configured · /connections · /agents" : "VPS not configured · /vps to connect"}</text>
          <Show when={dimensions().height >= 30}><box paddingTop={1}><ProjectsPanel limit={dimensions().height >= 42 ? 8 : 4} onPick={project => fillPrompt(`Load the ${project} project with project_load, then summarize its current branch, uncommitted changes and the next useful step.`)} /></box></Show>
          <Show when={studio()}>
            <Show when={dimensions().height >= 48} fallback={<text height={1} flexShrink={0} fg={ink.primary} onMouseDown={() => api.command?.trigger("lakeside.studio")}>{studio()?.state === "connected" ? `Studio: ${(studio()?.tickets || []).length} open tickets · ${studio()?.kanban?.counts?.needs_owner ?? 0} need you · ${(studio()?.agents || []).filter((a: any) => a.status === "running").length} agents running · /studio` : `Studio: ${studio()?.detail || "loading"}`}</text>}>
              <box paddingTop={1} flexShrink={0}><StudioPanel studio={studio} onPrompt={fillPrompt} refresh={() => void refreshStudio()} compact /></box>
            </Show>
          </Show>
          <box flexDirection="row" gap={3} flexShrink={0}><text fg={ink.primary} onMouseDown={() => api.keymap.dispatchCommand("session.list")}>Resume session</text><text fg={ink.primary} onMouseDown={() => showWorkbench(api)}>Workbench</text><For each={shortcuts}>{action => <text fg={ink.primary} onMouseDown={() => fillPrompt(action.prompt)}>{action.label}</text>}</For></box>
          <Show when={dimensions().height >= 38 && (peers().length > 0 || peerError())}><box paddingTop={1}><PeerPanel api={api} peers={peers} error={peerError} refresh={refresh} compact /></box></Show>
        </box>;
      },
      home_footer() { return <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="row" justifyContent="space-between"><text fg={ink.muted}>{path.basename(api.state.path.directory)}<span style={{ fg: ink.primary }}>{api.state.vcs?.branch ? `  ⎇ ${api.state.vcs.branch}` : ""}</span></text><Show when={peers().length > 0 || peerError()}><text fg={ink.primary} onMouseDown={() => api.command?.trigger("lakeside.agents")}>/agents</text></Show></box>; },
      sidebar_content(_ctx, props) { return <box gap={2}><SessionStatus api={api} sessionID={props.session_id} /><HealthList api={api} vpsOrigin={() => { peers(); try { return loadVps()?.origin; } catch { return undefined; } }} peers={peers} /><SessionActions api={api} fill={fillPrompt} /><Show when={peers().length > 0 || peerError()}><PeerPanel api={api} peers={peers} error={peerError} refresh={refresh} /></Show></box>; },
    } });
  },
};
