import { loadVps, readVpsToken } from "../vps-profile.mjs";
import { openVpsClient, vpsEndpoint } from "./vps-client.mjs";

// A bounded, read-only Streamable HTTP probe. Never persist remote text or tokens.
export async function discoverVps(env = process.env, { fetchImpl = fetch, timeoutMs = 8000, signal, delayMs = 250 } = {}) {
  const started = Date.now(), clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160);
  let profile;
  const offline = (errorKind, auth) => ({ state: "offline", ...(profile ? { id: profile.id, kind: profile.kind } : {}), errorKind, next: auth ? "Refresh the credential in the configured token file, then run lakeside code vps status. The connection profile is retained." : "Check the server URL, token file and network, then run lakeside code vps status. Local coding remains available.", latencyMs: Date.now() - started });
  try {
    profile = loadVps(env);
    if (!profile) return { state: "unconfigured", next: "Run lakeside code vps connect --url HTTPS_ORIGIN --token-file LOCAL_FILE" };
    const token = readVpsToken(profile.tokenFile);
    const endpoint = vpsEndpoint(profile, token);
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, 15000)));
      const abort = () => controller.abort();
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      let initialized = false;
      try {
        const client = openVpsClient({ ...endpoint, fetchImpl, signal: controller.signal });
        const request = client.request;
        await client.initialize("keir-code-discovery");
        initialized = true;
        const tools = [];
        let cursor, complete = false;
        for (let page = 0; page < 5; page++) {
          const listed = await request("tools/list", cursor ? { cursor } : {});
          if (!Array.isArray(listed.tools)) throw Error("Invalid MCP tool list");
          tools.push(...listed.tools.filter(tool => typeof tool?.name === "string").map(tool => clean(tool.name)).filter(Boolean));
          cursor = listed.nextCursor;
          if (!cursor) { complete = true; break; }
        }
        const report = { state: "connected", id: profile.id, kind: profile.kind, tools: [...new Set(tools)], discoveryComplete: complete, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started };
        // Generic MCPs never receive Keir-specific calls.
        if (profile.kind === "keir" && tools.includes("vps_status")) {
          try {
            const status = await request("tools/call", { name: "vps_status", arguments: {} });
            const value = status.structuredContent || JSON.parse(status.content?.find(block => block.type === "text")?.text || "{}");
            report.services = Array.isArray(value.services) ? value.services.map(clean).slice(0, 100) : [];
            report.projects = Object.keys(value.projects || {}).map(clean).slice(0, 200);
            report.sentryConfigured = value.sentryConfigured === true;
            report.environmentValues = "redacted";
            report.productionWrites = false;
          } catch { report.details = "Gateway connected; project/service discovery unavailable. Call vps_status to retry."; }
        }
        return report;
      } catch (error) {
        const auth = error.status === 401 || error.status === 403;
        const errorKind = auth ? "auth" : controller.signal.aborted ? "timeout" : "connection";
        // Retry only a pre-initialize transport failure, once, with a fresh client.
        if (errorKind !== "connection" || initialized || attempt > 1) return offline(errorKind, auth);
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs)));
    }
  } catch (error) {
    const auth = error.status === 401 || error.status === 403;
    return offline(auth ? "auth" : "connection", auth);
  }
}
