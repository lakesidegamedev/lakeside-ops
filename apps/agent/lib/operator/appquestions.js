"use strict";
// OpenMuse's present_choices pattern: structured input is part of the saved
// conversation. Preference answers are never receipts for external effects.
const crypto = require("node:crypto");
const { threadOf, isAppJob } = require("./appchannel");
const err = (status, text) => Object.assign(new Error(text), { status });
function createAppQuestions({ ledger, app, config, now = () => Date.now() }) {
  function ask(job, { title, questions }) {
    if (!isAppJob(job) || job.role !== "owner") throw err(403, "owner app task required");
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > 5) throw err(400, "ask one to five questions");
    for (const q of questions) require("./decisionpolicy").requireRealDecision(q.prompt);
    const normalized = questions.map((q, i) => {
      if (typeof q.prompt !== "string" || !q.prompt.trim() || q.prompt.length > 500 || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw err(400, "questions need a prompt and two to six options");
      return { id: String(i + 1), prompt: q.prompt.trim(), multiple: q.multiple === true, options: q.options.map((o, n) => {
        if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 160 || (o.detail && (typeof o.detail !== "string" || o.detail.length > 400))) throw err(400, "invalid choice option");
        return { id: String(n + 1), label: o.label.trim(), detail: o.detail || "", recommended: o.recommended === true };
      }) };
    });
    const t = threadOf(ledger.data); t.questions ||= {};
    const pending = Object.values(t.questions).filter((q) => q.jobId === job.id && q.state === "pending");
    for (const q of pending) q.state = "superseded";
    const id = crypto.randomBytes(6).toString("hex");
    const panel = { id, jobId: job.id, thread: job.appThread || "main", title: String(title || "A question for you").slice(0, 160), questions: normalized, state: "pending", at: now() };
    t.questions[id] = panel;
    // Bound retained panels independently from the thread message window.
    for (const old of Object.values(t.questions).sort((a, b) => b.at - a.at).slice(100)) if (old.state !== "pending") delete t.questions[old.id];
    ledger.audit("app_questions_asked", { job: job.id, panel: id }); ledger.save();
    return { id, instruction: "The owner can tap these choices or give a custom answer. Finish waiting for their answer; do not repeat the options in prose. An answer is task guidance and does not approve an external action." };
  }
  // A question whose task is gone or finished can never be answered or cleared,
  // and it kept "Needs you" lit with nothing to act on. Expire it on read.
  function list(thread) {
    const d = ledger.data, t = threadOf(d); let changed = false;
    for (const q of Object.values(t.questions || {})) {
      const job = d.jobs?.[q.jobId];
      if (q.state === "pending" && (!job || ["done", "dismissed", "cancelled"].includes(job.state))) { q.state = "expired"; q.expiredAt = now(); changed = true; }
    }
    if (changed) { ledger.audit("app_questions_expired", { thread }); ledger.save(); }
    return Object.values(t.questions || {}).filter((q) => q.thread === thread);
  }
  function answer(id, { answers, clientId }) {
    const panel = threadOf(ledger.data).questions?.[id];
    if (!panel) throw err(404, "unknown question");
    if (panel.state === "answered" && panel.clientId === clientId) return { answered: true, duplicate: true };
    if (panel.state !== "pending") throw err(409, "these choices are no longer current");
    if (!Array.isArray(answers) || answers.length !== panel.questions.length || typeof clientId !== "string" || !clientId || clientId.length > 80) throw err(400, "answer each question");
    const lines = panel.questions.map((q) => {
      const a = answers.find((v) => v.id === q.id);
      if (!a || !Array.isArray(a.selected) || a.selected.some((id) => !q.options.some((o) => o.id === id)) || new Set(a.selected).size !== a.selected.length || (!q.multiple && a.selected.length > 1)) throw err(400, "invalid selected option");
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (text.length > 1000 || (!text && !a.selected.length)) throw err(400, "choose an option or write an answer");
      return `${q.prompt}\n${[...q.options.filter((o) => a.selected.includes(o.id)).map((o) => o.label), text].filter(Boolean).join("; ")}`;
    });
    const posted = app.post(`My answers to ${panel.title}:\n\n${lines.join("\n\n")}`, `answer-${clientId}`, panel.thread, { mode: "steer", taskId: panel.jobId });
    panel.state = "answered"; panel.answers = answers; panel.answeredAt = now(); panel.clientId = clientId;
    ledger.audit("app_questions_answered", { job: panel.jobId, panel: id }); ledger.save();
    return { answered: true, jobId: posted.jobId };
  }
  async function route(path, method, body, query) {
    if (path === "/questions" && method === "GET") return { questions: list(query.get("thread") || "main") };
    const m = /^\/questions\/([a-f0-9]{12})$/.exec(path);
    if (m && method === "POST") return answer(m[1], body);
    return undefined;
  }
  return { ask, list, answer, route };
}
module.exports = { createAppQuestions };
