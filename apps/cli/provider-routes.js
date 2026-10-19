"use strict";
// Shared by interactive launch and unattended activations. Billing is a route
// choice; it is never inferred from an unavailable model or changed on retry.
const PROVIDERS = [
  { id: "antigravity", name: "Antigravity", billing: "subscription", runner: "agy", backend: "antigravity" },
  { id: "ollama", name: "Ollama Cloud", billing: "subscription", runner: "ollama", backend: "api", prefix: "ollama" },
  { id: "deepseek", name: "DeepSeek API", billing: "api", runner: "deepseek", backend: "api", prefix: "deepseek" },
  { id: "codex-sub", name: "Codex subscription", billing: "subscription", runner: "codex", backend: "codex" },
  { id: "codex-api", name: "Codex API", billing: "api", runner: "opencode", backend: "api", prefix: "openai" },
  { id: "claude-sub", name: "Claude subscription", billing: "subscription", runner: "claude", backend: "claude" },
  { id: "claude-api", name: "Claude API", billing: "api", runner: "opencode", backend: "api", prefix: "anthropic" },
  { id: "opencode-go", name: "OpenCode Go", billing: "subscription", runner: "opencode", backend: "api", prefix: "opencode-go" },
];
function providerRoute(id, model) {
  const provider = PROVIDERS.find(p => p.id === id);
  if (!provider) throw new Error(`Unknown provider ${id}`);
  if (typeof model !== "string" || !model.trim() || /\s/.test(model)) throw new Error("Choose an explicit model for --provider");
  if (model.includes("/") && (!provider.prefix || !model.startsWith(`${provider.prefix}/`))) throw new Error("Model prefix does not match the selected provider and billing route");
  return { ...provider, model: provider.prefix && !model.includes("/") ? `${provider.prefix}/${model}` : model };
}
// Owner billing restriction: Muse may only use the explicitly selected Go route.
// Old persisted pins must fail before a provider starts, never spend on Meta.
function assertAllowedBilling({ runner, model }) {
  if ((runner === "muse" || /muse|^meta\//i.test(String(model))) &&
      !(runner === "opencode" && /^opencode-go\/muse-[a-z0-9.-]+$/.test(model))) {
    throw new Error("Muse direct API billing is disabled. Select an available opencode-go/muse model explicitly; no paid fallback is allowed.");
  }
}
function credentialEnv(env = process.env) {
  return Object.fromEntries(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "OPENCODE_GO_API_KEY", "OLLAMA_API_KEY", "DEEPSEEK_API_KEY"].filter(key => env[key]).map(key => [key, env[key]]));
}
module.exports = { PROVIDERS, providerRoute, credentialEnv, assertAllowedBilling };
