"use strict";
// Keir 9 (feature C): what a ticket task asks the notebook. The player's words, plus the names of game files and
// screens the ticket mentions or has already read, so a note about the same file or screen is found even when the
// player never used its words.
const FILE = /[\w./-]*[\w-]\.(?:[cm]?[jt]sx?|rs|py|json)\b/gi;
const SCREEN = /\b([A-Za-z][\w'-]*(?: [A-Za-z][\w'-]*)?) (?:screen|page|tab|panel|menu|dialog|window)\b/gi;

function queryFor({ texts = [], reads = [] } = {}) {
  const text = texts.filter(Boolean).join(" ");
  const names = new Set();
  const addPath = (p) => { for (const part of String(p).split("/").slice(-2)) { const base = part.replace(/\.[a-z]+$/i, ""); names.add(base.toLowerCase()); for (const w of base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/)) if (w.length > 2) names.add(w.toLowerCase()); } };
  for (const m of text.matchAll(FILE)) addPath(m[0]);
  for (const r of reads) addPath(r.path || r);
  for (const m of text.matchAll(SCREEN)) names.add(m[1].toLowerCase());
  return [text, ...names].join(" ");
}

module.exports = { queryFor };
