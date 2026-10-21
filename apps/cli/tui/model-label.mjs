// @ts-check
// Pure formatting for provider and model ids shown in the TUI. No UI or
// OpenCode imports, so it runs under node --test as well as inside the host.

/**
 * @typedef {"primary" | "blue" | "amber" | "text" | "muted" | "dim" | "green"} PaletteKey
 * @typedef {{ label: string, provider: string, model: string, glyph: string, color: PaletteKey }} ModelLabel
 */

/** @type {Record<string, string>} */
const PROVIDERS = {
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  anthropic: "Claude",
  openai: "Codex",
  codex: "Codex",
  deepseek: "DeepSeek",
  google: "Gemini",
  gemini: "Gemini",
  xai: "Grok",
  grok: "Grok",
  ollama: "Ollama",
  antigravity: "Antigravity",
  github: "Copilot",
  copilot: "Copilot",
  mistral: "Mistral",
  meta: "Llama",
  llama: "Llama",
  qwen: "Qwen",
};

const ACRONYMS = new Set(["gpt", "glm", "ai", "api", "o1", "o2", "o3", "o4"]);

/** @param {string} token */
function titleToken(token) {
  if (!token) return token;
  const lower = token.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** @param {string | null | undefined} id */
function prettify(id) {
  const raw = String(id || "").split("/").pop() || "";
  const tokens = raw.split(/[-_]+/).filter(Boolean);
  if (!tokens.length) return "";
  const parts = tokens.map(titleToken);
  const sep = ACRONYMS.has(parts[0].toLowerCase()) ? "-" : " ";
  return parts.length > 1 ? `${parts[0]}${sep}${parts.slice(1).join("-")}` : parts[0];
}

/** @param {string | null | undefined} id */
function providerName(id) {
  const key = String(id || "").toLowerCase();
  return PROVIDERS[key] || prettify(key);
}

/** @param {string} text */
function family(text) {
  if (/claude|anthropic/.test(text)) return "claude";
  if (/codex|openai|gpt/.test(text)) return "codex";
  if (/deepseek/.test(text)) return "deepseek";
  if (/gemini|google/.test(text)) return "gemini";
  if (/grok|xai/.test(text)) return "grok";
  if (/llama|meta/.test(text)) return "llama";
  if (/mistral/.test(text)) return "mistral";
  if (/ollama/.test(text)) return "ollama";
  return "";
}

/** @type {Record<string, { glyph: string, color: PaletteKey }>} */
const MARKS = {
  claude: { glyph: "✳", color: "amber" },
  codex: { glyph: "◎", color: "green" },
  deepseek: { glyph: "≈", color: "blue" },
  gemini: { glyph: "✦", color: "primary" },
  grok: { glyph: "◈", color: "text" },
  llama: { glyph: "∞", color: "blue" },
  mistral: { glyph: "▲", color: "primary" },
  ollama: { glyph: "◍", color: "muted" },
};

/** @type {{ glyph: string, color: PaletteKey }} */
const DEFAULT_MARK = { glyph: "◆", color: "dim" };

/**
 * Friendly route, formatted model name and a single-width provider mark.
 * @param {string | null | undefined} providerID
 * @param {string | null | undefined} modelID
 * @returns {ModelLabel}
 */
export function describeModel(providerID, modelID) {
  const provider = providerName(providerID);
  const formatted = prettify(modelID);
  // "Claude - Claude Sonnet-4-5" reads badly; the route already names the family.
  const model = provider && formatted.startsWith(`${provider} `) ? formatted.slice(provider.length + 1) : formatted;
  const key = family(String(providerID || "").toLowerCase()) || family(String(modelID || "").toLowerCase());
  const mark = MARKS[key] || DEFAULT_MARK;
  return {
    label: provider && model ? `${provider} - ${model}` : provider || model,
    provider,
    model,
    glyph: mark.glyph,
    color: mark.color,
  };
}
