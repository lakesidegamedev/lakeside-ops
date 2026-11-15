"use strict";
// Keir 10: lessons live with the lane they belong to, not in the one giant
// brief. A lesson is an ordinary notebook note of kind lesson whose text starts
// with "[lane:<lane>] ". The lane playbook context asks for its own lessons with
// lessonsFor(); the brief never grows.
const LANES = ["question", "bug", "outage", "account", "idea"];
const TAG = /^\s*\[lane:([a-z]+)\]\s*/i;

const laneOfText = (text) => { const m = TAG.exec(String(text || "")); return m && LANES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null; };
const tag = (lane, text) => `[lane:${lane}] ${String(text || "").replace(TAG, "").trim()}`;
const plain = (text) => String(text || "").replace(TAG, "").trim();

// The lane's live lessons, newest first, at most k, as plain sentences with their ticket.
function lessonsFor(notebook, lane, k = 5) {
  if (!notebook?.all || !LANES.includes(lane)) return [];
  return notebook.all().filter((n) => n.kind === "lesson" && laneOfText(n.text) === lane).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, k)
    .map((n) => ({ id: n.id, text: plain(n.text), ticket: n.ticket || n.sources?.find((s) => s.type === "ticket")?.number || null }));
}

// Save a lesson into a lane (used by the review and the lesson CLI).
function saveLaneLesson(notebook, { lane, text, ticket, by = "self-review" }) {
  if (!LANES.includes(lane)) throw new Error(`lane must be one of ${LANES.join(", ")}`);
  return notebook.remember({ kind: "lesson", text: tag(lane, text), ticket, by });
}

module.exports = { LANES, laneOfText, tag, plain, lessonsFor, saveLaneLesson };
