"use strict";
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { terminateTree } = require("./process-tree");
// Optional Microsoft Edge online speech adapter. No credentials or audio are
// stored in the ledger. Independent installations install edge-tts separately.
function createSpeech({ env = process.env, spawnImpl = spawn } = {}) {
  const binary = env.KEIR_SPEECH_BIN || "edge-tts";
  const voice = env.KEIR_SPEECH_VOICE || "en-US-AvaMultilingualNeural";
  let active = 0;
  return {
    status: () => ({ provider: "Microsoft online speech", voice }),
    async synthesize(text, signal) {
      if (typeof text !== "string" || !text.trim() || text.length > 6000) throw Object.assign(new Error("Speech text must contain 1 to 6000 characters."), { status: 400 });
      if (signal?.aborted) throw Object.assign(new Error("Speech cancelled."), { status: 499 });
      if (active >= 2) throw Object.assign(new Error("Speech is busy. Try again shortly."), { status: 429 });
      active++;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keir-speech-"));
      try {
        const input = path.join(dir, "text"), output = path.join(dir, "speech.mp3");
        fs.writeFileSync(input, text.trim(), { mode: 0o600 });
        await new Promise((resolve, reject) => {
          const child = spawnImpl(binary, ["--voice", voice, "--file", input, "--write-media", output], { stdio: "ignore", detached: process.platform !== "win32" });
          let killed = false;
          const kill = () => { killed = true; terminateTree(child.pid).catch(() => {}); };
          const timer = setTimeout(kill, 15000);
          const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", kill); };
          signal?.addEventListener("abort", kill, { once: true });
          if (signal?.aborted) kill();
          child.once("error", () => { cleanup(); reject(Object.assign(new Error("Microsoft voice is not installed on this server."), { status: 503 })); });
          child.once("close", code => { cleanup(); code === 0 && !killed ? resolve() : reject(Object.assign(new Error("Microsoft voice is temporarily unavailable. Try again."), { status: 502 })); });
        });
        const stat = fs.statSync(output);
        if (!stat.size || stat.size > 4 * 1024 * 1024) throw Object.assign(new Error("Invalid speech response."), { status: 502 });
        return fs.readFileSync(output);
      } finally { active--; fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
}
module.exports = { createSpeech };
