"use strict";
// The models the owner can pick for a chat with Keir: the Claude models this
// box's Claude Code can run, and Claude Code's reasoning effort levels. The
// choice is per conversation (home, support desk, each side chat) and a single
// message may override it.
const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", provider: "Claude" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "Claude" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", provider: "Claude" },
  { id: "claude-fable-5-2", label: "Fable 5.2", provider: "Claude" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Conversation keys: the private home chat, the support desk, and side chats
// (the operator's 12-hex thread ids).
const THREAD = /^(?:owner-supervisor|main|[a-f0-9]{12})$/;
const HOME = "owner-supervisor";

const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
function threadKey(value) {
  if (value === undefined || value === null || value === "") return HOME;
  if (typeof value !== "string" || !THREAD.test(value)) fail("thread must be owner-supervisor, main or a side chat id");
  return value;
}
function checkModel(value) {
  if (value === undefined || value === null || value === "" || value === "auto") return null;
  if (!MODELS.some((m) => m.id === value)) fail(`model must be one of ${MODELS.map((m) => m.id).join(", ")}`);
  return value;
}
function checkEffort(value) {
  if (value === undefined || value === null || value === "" || value === "auto") return null;
  if (!EFFORTS.includes(value)) fail(`effort must be one of ${EFFORTS.join(", ")}`);
  return value;
}

module.exports = { MODELS, EFFORTS, HOME, threadKey, checkModel, checkEffort };
