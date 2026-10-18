"use strict";
// Configured routes and the studio's proven routes appear in the owner's picker. A model change
// takes effect at the next activation, never halfway through an external effect.
const { check } = require("./routing");
const RUNNERS = { claude: "Claude", codex: "Codex", muse: "Muse", agy: "Gemini", cursor: "Cursor", ollama: "Ollama", deepseek: "DeepSeek API", opencode: "OpenCode" };
const PROVEN = ["claude:claude-opus-5-5", "claude:claude-sonnet-5-5", "codex:gpt-6.1-sol", "codex:gpt-6-luna", "opencode:opencode-go/muse-spark-1.3-contributor", "agy:gemini-3.8-flash", "cursor:auto", "ollama:deepseek-v4.1-flash"];
// Voice Auto follows the configured subscription route for all Keir lanes.
const VOICE = ["claude:claude-sonnet-5-5"];
const voiceChoices = (config) => String(config.voiceProvider || VOICE.join(",")).split(",").map(s => s.trim()).filter(Boolean);
const voiceChoiceLabels = (config) => voiceChoices(config).map(id => id === "cursor:auto" ? "Cursor Auto" : id === "claude:claude-sonnet-5-5" ? "Claude Sonnet 5.5" : id);
function models(config, lane = null) {
  const defaults = { claude: config.model, codex: "gpt-6-luna", muse: config.museModel || "muse-wonder-1.0", agy: config.agyModel || "gemini-3.8-flash", cursor: "auto", ollama: "deepseek-v4.1-flash", deepseek: "deepseek-flash" };
  const specs = [config.quickProvider || "claude", config.workerProvider || "claude", config.codingProvider, config.investigatorProvider, config.visionProvider, ...(!config.standalone ? PROVEN : []), config.voiceProvider || (!config.standalone && VOICE[0]), ...(config.availableRoutes || []), config.defaultRoute].filter(Boolean).flatMap((s) => String(s).split(","));
  const routes = new Map();
  for (const value of specs) {
    const [spec, effort] = value.trim().split("@");
    const colon = spec.indexOf(":"), runner = colon < 0 ? spec : spec.slice(0, colon);
    const model = colon < 0 ? defaults[runner] : spec.slice(colon + 1);
    if (!(RUNNERS[runner] || config.standalone && ["antigravity", "opencode", "grok", "gemini", "cursor"].includes(runner)) || !model) continue;
    const id = `${runner}:${model}${effort ? `@${effort}` : ""}`;
    const verdict = check(["conversation", "voice"].includes(lane) ? "quick" : lane === "investigation" ? "investigator" : (lane === "coordination" ? "worker" : lane) || "quick", id);
    routes.set(id, { id, configured: true, laneAllowed: config.standalone || verdict.ok, readiness: { state: "unverified", checkedAt: null, reason: "Configured route. Provider authentication and current availability are checked when work starts." }, available: config.standalone || verdict.ok, ...(!config.standalone && !verdict.ok ? { reason: verdict.reason } : {}), effortMode: runner === "cursor" ? "provider-managed" : "jev", label: require("./selfinfo").label(model), provider: RUNNERS[runner] || runner, runner, model, ...(effort ? { effort } : {}) });
  }
  // Historical effort suffixes remain accepted, but do not fill the picker with
  // duplicate entries for the same model now that Jev chooses activation effort.
  const unique = new Map();
  for (const route of routes.values()) {
    const key = `${route.runner}:${route.model}`;
    if (!unique.has(key) || !route.effort) unique.set(key, route);
  }
  const choices = voiceChoices(config), choiceLabels = voiceChoiceLabels(config);
  const autoReady = lane !== "voice" || choices.every(id => [...unique.values()].some(r => r.id.split("@")[0] === id.split("@")[0] && r.available));
  return [{ id: "auto", label: "Auto", provider: "Keir routing", available: autoReady, ...(autoReady ? {} : { reason: `Voice Auto needs ${choiceLabels.join(" or ")} configured. Select an explicit voice model.` }) }, ...unique.values()];
}
function resolveModel(config, id, lane = null) {
  const options = models(config, lane);
  let route = options.find((m) => m.id === id);
  if (!route && typeof id === "string" && /@(low|medium|high|xhigh|max)$/.test(id)) {
    const [base, effort] = id.split("@");
    const prior = options.find(m => m.id.split("@")[0] === base);
    if (prior?.effortMode === "provider-managed") throw Object.assign(new Error("Cursor Auto manages its own model and reasoning effort"), { status: 400 });
    if (prior) route = { ...prior, id, effort };
  }
  if (route?.available === false) throw Object.assign(new Error(route.reason), { status: 400 });
  if (!route) throw Object.assign(new Error("model route is not available"), { status: 400 });
  return route;
}
// Assign at authenticated ingress, once per accepted message, before any runner.
// Separate jobs keep an in-flight voice reply on its original route. Shared
// thread history still supplies conversation context across voice turns.
function voiceRoute(config, data, thread) {
  const selected = data.appThread?.preferences?.[thread]?.routes?.voice || "auto";
  if (selected !== "auto") return resolveModel(config, selected, "voice").id;
  const choices = voiceChoices(config), choiceLabels = voiceChoiceLabels(config);
  const available = choices.map(id => models(config, "voice").find(m => m.id.split("@")[0] === id.split("@")[0] && m.available !== false)?.id).filter(Boolean);
  if (available.length !== choices.length) throw Object.assign(new Error(`Voice Auto needs ${choiceLabels.join(" or ")} configured. Choose an available voice model.`), { status: 409 });
  const t = data.appThread;
  const n = t.voiceSequence?.[thread] || 0;
  (t.voiceSequence ||= {})[thread] = n + 1;
  return available[n % available.length];
}
function requestedModel(job, config, data, workType) {
  if (job.voiceMode && !job.codingParent) return job.voiceRoute || config.voiceProvider || (config.standalone ? "auto" : VOICE[0]);
  const controls = require("./appcontrols"), root = controls.rootOf(data, job), pref = controls.preferences(data, job);
  return job.appOverrides?.routes?.[workType] || root?.appOverrides?.routes?.[workType] || pref.routes?.[workType] || (!job.codingParent ? data.appThread?.modelSelections?.[root?.appThread || "main"] : null) || "auto";
}
function applyModel(job, config, ledger, lane) {
  const controls = require("./appcontrols");
  const root = controls.rootOf(ledger.data, job);
  if (root?.role !== "owner" || root.actorId !== config.ownerId || root.appWatch) return;
  const workType = controls.laneOf(job, lane === "quick");
  const selected = requestedModel(job, config, ledger.data, workType);
  if (selected === "auto") {
    if (job.provider?.ownerSelected) {
      delete job.provider;
      if (job.codingParent) {
        const route = require("./delegation").codingSpec({ codingProvider: job.investigation ? config.investigatorProvider || config.codingProvider : config.codingProvider });
        job.provider = { lane, ...route, at: Date.now() }; job.effortPin = route.effort;
      }
    }
    return;
  }
  const route = resolveModel(config, selected, workType);
  job.provider = { lane, runner: route.runner, model: route.model, ...(route.effort ? { effort: route.effort } : {}), ownerSelected: true, route: selected, at: Date.now() };
  // The selected effort wins over the default inherited at delegation time.
  if (job.codingParent) job.effortPin = route.effort || undefined;
}
module.exports = { models, resolveModel, applyModel, voiceRoute, requestedModel, PROVEN, VOICE };
