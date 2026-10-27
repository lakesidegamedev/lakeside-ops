"use strict";
// Compact repository map for repository_snapshot (KBX2, 2026-10-27). Small trees
// list every file; large trees list directories (to depth 4) with file counts,
// so the model can aim evidence_batch searches without ls/find rounds.
function repoMap(files, { maxLines = 220 } = {}) {
  if (!files.length) return null;
  if (files.length <= maxLines) return { files };
  const counts = new Map();
  for (const f of files) {
    const parts = f.split("/").slice(0, -1);
    for (let d = 1; d <= Math.min(4, parts.length); d++) { const k = parts.slice(0, d).join("/"); counts.set(k, (counts.get(k) || 0) + 1); }
  }
  // Shallow directories first, then the biggest deeper ones, up to the line budget.
  const depthOf = (k) => k.split("/").length;
  const dirs = [...counts].sort(([a, n], [b, m]) => depthOf(a) - depthOf(b) || m - n).slice(0, maxLines);
  return { totalFiles: files.length, directories: dirs.sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}/ (${n})`) };
}
module.exports = { repoMap };
