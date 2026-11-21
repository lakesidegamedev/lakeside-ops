"use strict";
// Owner-only files for the private supervisor: images and documents the owner
// attaches to a message, and images or files Keir attaches to its reply.
// Bytes live under <stateDir>/files/<id>.<ext> (mode 0600); the record lives
// in the supervisor's durable state. The extension matters: Claude Code's Read
// tool decides by extension whether a file is an image it should look at.
// Served only through /api/keir/supervisor/files/<id>, behind owner auth.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FILE = 10 * 1024 * 1024;
const MAX_UNSENT = 20 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const UNSENT_TTL = 24 * 60 * 60000;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt" };

const validFileId = (id) => /^[a-f0-9]{32}$/.test(String(id || ""));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const safeName = (name) => path.basename(String(name || "attachment")).replace(/[\x00-\x1f\x7f/\\]/g, "").trim().slice(0, 120) || "attachment";

// The type is decided by the bytes, never by what the client claims.
function sniff(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes.includes(0)) return null;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return "text/plain"; } catch { return null; }
}

function createFiles({ dir, records, save, now = Date.now }) {
  const all = () => records();
  const pathOf = (item) => path.join(dir, `${item.id}.${EXT[item.type] || "bin"}`);
  const descriptor = (item) => ({ id: item.id, name: item.name, type: item.type, size: item.size, url: `/api/keir/supervisor/files/${item.id}` });

  // Unsent owner uploads expire after a day so abandoned drafts do not pile up.
  function cleanup() {
    let changed = false;
    for (const item of Object.values(all())) {
      if (item.origin === "owner" && !item.messageId && now() - item.at > UNSENT_TTL) {
        fs.rmSync(pathOf(item), { force: true }); delete all()[item.id]; changed = true;
      }
    }
    return changed;
  }

  function store(bytes, { name, thread, origin }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) fail(400, "The file is empty.");
    if (bytes.length > MAX_FILE) fail(413, "Files must be at most 10 MB.");
    const type = sniff(bytes);
    if (!type) fail(415, "Choose an image (JPEG, PNG, GIF or WebP), a PDF or a text file.");
    if (cleanup()) save();
    const items = Object.values(all());
    if (items.reduce((n, i) => n + i.size, 0) + bytes.length > MAX_TOTAL) fail(413, "Attachment storage is full.");
    if (origin === "owner" && items.filter((i) => i.origin === "owner" && !i.messageId && i.thread === thread).reduce((n, i) => n + i.size, 0) + bytes.length > MAX_UNSENT) {
      fail(413, "Unsent attachments in a conversation must fit within 20 MB.");
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomBytes(16).toString("hex");
    const item = { id, name: safeName(name), type, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), thread, origin, at: now() };
    fs.writeFileSync(pathOf(item), bytes, { flag: "wx", mode: 0o600 });
    all()[id] = item;
    return item;
  }

  // An owner upload from the phone. Saved before the caller sees success.
  function upload(bytes, { name, thread }) {
    const item = store(bytes, { name, thread, origin: "owner" });
    try { save(); } catch (e) { delete all()[item.id]; fs.rmSync(pathOf(item), { force: true }); throw e; }
    return descriptor(item);
  }

  // A file Keir chose to show the owner: copied in, so later edits or deletes
  // of the original do not change what the chat shows.
  function attachFromPath(file, { name, thread }) {
    if (typeof file !== "string" || !path.isAbsolute(file)) fail(400, "path must be an absolute file path");
    let stat;
    try { stat = fs.statSync(file); } catch { fail(404, `No file at ${file}`); }
    if (!stat.isFile()) fail(400, `${file} is not a regular file`);
    if (stat.size > MAX_FILE) fail(413, "Files must be at most 10 MB.");
    return descriptor(store(fs.readFileSync(file), { name: name || path.basename(file), thread, origin: "keir" }));
  }

  // Owner references in a message: their own unsent uploads in this conversation.
  function claim(refs, thread) {
    if (refs === undefined || refs === null) return [];
    if (!Array.isArray(refs) || refs.length > 6) fail(400, "Choose at most six attachments.");
    const seen = new Set();
    return refs.map((ref) => {
      const id = typeof ref === "string" ? ref : ref?.id;
      if (!validFileId(id) || seen.has(id)) fail(400, "Each attachment must be a distinct uploaded file.");
      seen.add(id);
      const item = all()[id];
      if (!item || item.origin !== "owner" || item.thread !== thread) fail(404, "That attachment is unavailable in this conversation. Attach it again.");
      if (item.messageId) fail(409, "That attachment was already sent.");
      if (!fs.existsSync(pathOf(item))) fail(404, "That attachment has expired. Attach it again.");
      return item;
    });
  }

  function read(id) {
    const item = validFileId(id) ? all()[id] : null;
    if (!item) fail(404, "not found");
    let bytes;
    try { bytes = fs.readFileSync(pathOf(item)); } catch { fail(404, "not found"); }
    return { item, bytes };
  }

  function discard(id) {
    const item = validFileId(id) ? all()[id] : null;
    if (!item) fail(404, "not found");
    if (item.origin !== "owner" || item.messageId) fail(409, "Only an unsent upload can be removed.");
    fs.rmSync(pathOf(item), { force: true }); delete all()[id]; save();
    return { removed: true };
  }

  return { upload, attachFromPath, claim, read, discard, descriptor, pathOf, cleanup };
}

module.exports = { createFiles, sniff, validFileId, MAX_FILE, EXT };
