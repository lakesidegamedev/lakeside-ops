"use strict";
// Keir 11.4 (ticket 1875, owner 2026-11-21): asked for a picture, Keir produces a picture.
//
// The developer asked "can you show us a rendered image of how you would make that distinction clearer?" and Keir said
// "I cannot render the page from here". It could: the computer tool renders HTML in a network-isolated browser, but only
// for the owner's app tasks, and the request ran in the quick lane with no rendering tool at all.
//
// render_preview draws the HTML Keir writes (the proposed wording or layout, in the game's style) in the same isolated
// browser the computer tool uses (computer-worker.js: no network, no signed-in session), stamps it as a preview in the
// image itself, and the broker posts it as an image where Keir is answering, through the outbox path charts use.
const fs = require("node:fs");
const path = require("node:path");

const LABEL = "Preview of the proposed wording, not the live page.";
const MAX_HTML = 150000;
// A message asking to be shown something: an image, render, mockup, screenshot, picture, or how it would look.
const ASKS = /\b(?:render(?:ed|ing)?|mock-?ups?|screenshots?|screen ?shots?|images?|pictures?|pics?|visuals?|previews?|wireframes?|sketch(?:es)?|draw (?:it|this|that|me|us)|show (?:me|us|them) (?:how|what) (?:it|this|that|the \w+) (?:would|will|could|might) (?:look|read|appear)|what (?:it|this|that) (?:would|will|could) look like)\b/i;
function asksForImage(text) { return ASKS.test(String(text || "")); }

// The newest message from the owner or staff on this task asks for an image (a player's request never unlocks it).
function requested(job, config = {}) {
  if (!job || job.role === "player" || job.kind === "finding" || job.codingParent || job.internalProbe) return false;
  const staff = new Set([config.ownerId, ...(config.staffIds || [])].filter(Boolean));
  const app = job.replyChannel === "app" && job.role === "owner";
  const msgs = [job.source, ...(job.requestInbox || []), ...(job.inbox || [])].filter((s) => s && s.content && (app ? s.role !== "system" : staff.has(s.authorId)));
  return msgs.some((s) => asksForImage(s.content));
}

// The label is drawn into the image itself. Keir 11.4 review (M5): inserting a strip into the model's HTML could be
// defeated (a "<body>" inside a comment, a later fixed overlay, body opacity, a clip-path on <html>). Now the page is
// Keir's own: the label bar sits above a sandboxed iframe (no scripts, no same origin) that holds the model's HTML, so
// nothing in that HTML can reach, cover or restyle the bar. render() also refuses an image whose text lacks the label.
const LABEL_ID = "keir-preview-label";
const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function labelled(html) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}` +
    `#${LABEL_ID}{display:block;height:30px;box-sizing:border-box;padding:6px 12px;background:#b45309;color:#fff;font:600 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif}` +
    `iframe{display:block;border:0;width:100%;height:calc(100% - 30px)}</style></head><body><div id="${LABEL_ID}">${LABEL}</div>` +
    `<iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeAttr(html)}"></iframe></body></html>`;
}

// Renders in the task's sandbox with the computer worker. Returns { png, title, text }.
async function render({ sandbox, jobId, html, signal }) {
  if (typeof html !== "string" || html.length < 10 || Buffer.byteLength(html) > MAX_HTML) throw new Error("provide the preview as HTML up to 150 KB");
  if (!sandbox?.workspace || !sandbox?.run) throw new Error("the preview browser is not available on this host");
  const folder = path.join(sandbox.workspace(jobId), ".keir-computer");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, "request.json"), JSON.stringify({ html: labelled(html), steps: [] }), { mode: 0o600 });
  const worker = fs.readFileSync(path.join(__dirname, "computer-worker.js"), "utf8");
  const encoded = Buffer.from(worker).toString("base64");
  const result = await sandbox.run(jobId, `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`, signal, { computer: true, timeoutMs: 25000 });
  if (result.code !== 0 || result.truncated) throw new Error("the preview browser did not start");
  const png = fs.readFileSync(path.join(folder, "screen.png"));
  if (png.length > 3 * 1024 * 1024) throw new Error("the preview image is over 3 MB");
  let detail = {}; try { detail = JSON.parse(fs.readFileSync(path.join(folder, "result.json"), "utf8")); } catch {}
  if (!String(detail.text || "").includes(LABEL)) throw new Error("the preview label did not render, so the image was not posted");
  return { png, title: String(detail.title || "").slice(0, 120), text: String(detail.text || "").slice(0, 3000) };
}

module.exports = { LABEL, LABEL_ID, asksForImage, requested, labelled, render, MAX_HTML };
