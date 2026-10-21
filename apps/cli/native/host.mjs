import { createNativeRuntime } from "./runtime.mjs";
import { serveNative } from "./server.mjs";

/** @type {ReturnType<typeof createNativeRuntime> | undefined} */
let runtime;
/** @type {Awaited<ReturnType<typeof serveNative>> | undefined} */
let server;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await runtime?.close(); } finally { await server?.close(); process.exit(0); }
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
process.once("disconnect", close);
try {
  const options = JSON.parse(process.env.LAKESIDE_NATIVE_OPTIONS || "null");
  if (!options || !process.send) throw new Error("Native host must be started by Lakeside Code");
  runtime = createNativeRuntime(options);
  server = await serveNative(runtime);
  process.send({ type: "ready", url: server.url, token: server.token });
} catch (error) {
  process.send?.({ type: "error", message: error instanceof Error ? error.message : "Native host startup failed" });
  await close();
}
