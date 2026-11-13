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
// Owner billing restriction: Muse may only use the explicitly selected Go route or the Muse Code CLI on the
// owner's subscription (owner 2026-11-12: "we have muse code directly"). Old persisted pins on any other route
// must fail before a provider starts, never spend on the Meta API.
// The Muse Code CLI runs on the owner's subscription only for these models. Anything else on the muse runner is
// refused with the billing message below (audit 2026-11-12: a blanket runner allow let any model name through).
// muse-wonder-full-1.0 is the delegation default coder (delegation.js DEFAULT_CODER) and is the same subscription.
const MUSE_SUBSCRIPTION_MODELS = ["muse-spark-1.3-contributor", "muse-spark-1.3", "muse-spark-1.2-contributor", "muse-wonder-1.0", "muse-wonder-full-1.0"];
function assertAllowedBilling({ runner, model }) {
  if (runner === "muse") {
    if (MUSE_SUBSCRIPTION_MODELS.includes(String(model))) return;
    throw new Error("Muse direct API billing is disabled. Select an available opencode-go/muse model explicitly; no paid fallback is allowed.");
  }
  if (/muse|^meta\//i.test(String(model)) &&
      !(runner === "opencode" && /^opencode-go\/muse-[a-z0-9.-]+$/.test(model))) {
    throw new Error("Muse direct API billing is disabled. Select an available opencode-go/muse model explicitly; no paid fallback is allowed.");
  }
}
function credentialEnv(env = process.env) {
  return Object.fromEntries(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "OPENCODE_GO_API_KEY", "OLLAMA_API_KEY", "DEEPSEEK_API_KEY"].filter(key => env[key]).map(key => [key, env[key]]));
}
module.exports = { MUSE_SUBSCRIPTION_MODELS, PROVIDERS, providerRoute, credentialEnv, assertAllowedBilling };
