// @ts-check
// The Lakeside mark as a scene: a static, gradient mountain range over a lake
// whose surface is the only moving part. Pure: sceneCells(t) returns rows of
// colored cells, so it is testable and the renderer only maps color keys to the
// active theme.

/** Deterministic integer ridge height for column x. Static: no time input.
 * @param {number} x @param {number} w @param {number} m
 * @param {[number, number, number][]} peaks [centre, half-width, height] as fractions of w and m
 * @returns {number} rows above the base, 0..m */
function ridgeAt(x, w, m, peaks) {
  let h = 0;
  for (const [centre, spread, rel] of peaks) {
    const d = Math.abs(x - centre * w) / Math.max(1, spread * w);
    if (d < 1) h = Math.max(h, rel * m * (1 - d));
  }
  return Math.max(0, Math.min(m, Math.ceil(h)));
}

/**
 * @param {number} t seconds since start (0 for a still frame)
 * @param {{ width?: number, sky?: number, mountain?: number, lake?: number }} [size]
 * @returns {{ ch: string, c: string }[][]} rows of cells; c is a palette key
 */
export function sceneCells(t, size = {}) {
  const w = size.width || 44, skyRows = size.sky ?? 1, mRows = size.mountain ?? 6, lakeRows = size.lake ?? 3;

  // Two ranges, distant behind near; both static.
  const farPeaks = /** @type {[number, number, number][]} */ ([[0.50, 0.30, 0.55], [0.16, 0.16, 0.40]]);
  const nearPeaks = /** @type {[number, number, number][]} */ ([[0.26, 0.20, 0.95], [0.74, 0.19, 0.80]]);
  const far = [], near = [];
  for (let x = 0; x < w; x++) {
    far.push(ridgeAt(x, w, mRows, farPeaks));
    near.push(ridgeAt(x, w, mRows, nearPeaks));
  }
  const maxNear = Math.max(1, ...near);

  const rows = [];
  for (let r = 0; r < skyRows; r++) rows.push(Array.from({ length: w }, () => ({ ch: " ", c: "muted" })));

  for (let r = 0; r < mRows; r++) {
    const h = mRows - r, row = [];
    for (let x = 0; x < w; x++) {
      const nh = near[x], fh = far[x];
      if (h <= nh) {
        // Row-wise gradient, with text reserved for the tallest ridge tops.
        const c = h === nh && nh === maxNear && maxNear >= 3 ? "text"
          : h > mRows * 0.72 ? "primary" : h > mRows * 0.42 ? "blue" : "dim";
        row.push({ ch: "█", c });
      } else if (h <= fh) {
        row.push({ ch: "█", c: h > mRows * 0.5 ? "blue" : "dim" });
      } else {
        row.push({ ch: " ", c: "muted" });
      }
    }
    rows.push(row);
  }

  // Waterline: a slow glint drifting along the shore.
  const shore = [];
  for (let x = 0; x < w; x++) {
    const glint = (x + Math.floor(t * 3)) % 19 === 0 || (x * 5 + Math.floor(t * 2)) % 31 === 0;
    shore.push({ ch: "━", c: glint ? "text" : "dim" });
  }
  rows.push(shore);

  // Lake: line glyphs whose phase drifts with time. t = 0 is a valid still.
  for (let k = 0; k < lakeRows; k++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const v = Math.sin(x * 0.55 + t * (1.4 + k * 0.25) + k * 0.9);
      const ch = v > 0.72 ? "‾" : v > 0.15 ? "─" : v > -0.5 ? "≈" : "~";
      row.push({ ch, c: k === 0 ? "blue" : "dim" });
    }
    rows.push(row);
  }
  return rows;
}

/** Merge equal-colored neighbors into runs for cheaper rendering. @param {{ ch: string, c: string }[][]} rows */
export function toRuns(rows) {
  return rows.map(row => row.reduce((/** @type {{ text: string, c: string }[]} */ runs, cell) => {
    const last = runs[runs.length - 1];
    if (last && last.c === cell.c) last.text += cell.ch; else runs.push({ text: cell.ch, c: cell.c });
    return runs;
  }, []));
}
