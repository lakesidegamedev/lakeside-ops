"use strict";
// Is a game fix live? The box's deployer records every production deploy of
// the game's web and worker (one JSON line each, newest last). A fix is live
// when its merge commit is an ancestor of the deployed commit of both.

const fs = require("node:fs");
const { execFile } = require("node:child_process");

const ROWS = { web: "ahd-us-web", worker: "ahd-us-worker" };

/** The newest successful deploy of web and worker: { web: { sha, at }, worker: { sha, at } }. */
function latestDeployed(file, read = (f) => fs.readFileSync(f, "utf8")) {
  const out = { web: null, worker: null };
  for (const line of read(file).split("\n")) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.result !== "deployed" || !r.sha) continue;
    for (const [k, row] of Object.entries(ROWS)) if (r.row === row) out[k] = { sha: r.sha, at: r.finished_at || r.first_seen_at || null };
  }
  return out;
}

function git(repo, args) {
  return new Promise((resolve) => execFile("git", ["-C", repo, ...args], { timeout: 60000 }, (err, stdout) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || "").trim() })));
}

/** Whether `ancestor` is contained in `sha`, fetching main once if either commit is unknown locally. */
async function contains(repo, ancestor, sha, run = git) {
  const known = async (c) => (await run(repo, ["cat-file", "-e", `${c}^{commit}`])).code === 0;
  if (!(await known(ancestor)) || !(await known(sha))) await run(repo, ["fetch", "-q", "origin", "main", "development"]);
  const r = await run(repo, ["merge-base", "--is-ancestor", ancestor, sha]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`could not compare ${String(ancestor).slice(0, 12)} with ${String(sha).slice(0, 12)}`);
}

/** { live, web: { sha, at, contains }, worker: { ... } } for a merge commit. */
async function liveStatus({ repo, releasesFile, mergeSha, run = git, read }) {
  const d = latestDeployed(releasesFile, read);
  const out = { mergeSha, live: false };
  for (const k of Object.keys(ROWS)) {
    if (!d[k]) { out[k] = null; continue; }
    out[k] = { sha: d[k].sha.slice(0, 12), at: d[k].at, contains: await contains(repo, mergeSha, d[k].sha, run) };
  }
  out.live = Boolean(out.web?.contains && out.worker?.contains);
  return out;
}

/** Wake every ticket whose watched fix is now live. Returns the wakes it queued. */
async function checkLiveWatches({ store, repo, releasesFile, deliver, log = () => {}, status = liveStatus, now = () => Date.now() }) {
  const woke = [];
  for (const n of store.list()) {
    const s = store.load(n);
    if (s.closed || s.paused || !(s.liveWatch || []).length) continue;
    for (const w of s.liveWatch) {
      const st = await status({ repo, releasesFile, mergeSha: w.mergeSha });
      if (!st.live) continue;
      const fresh = store.load(n);
      fresh.liveWatch = (fresh.liveWatch || []).filter((x) => x.pr !== w.pr);
      store.save(fresh);
      log(`ticket ${n}: fix #${w.pr} is live (web ${st.web.sha}, worker ${st.worker.sha})`);
      const event = { role: "system", at: new Date(now()).toISOString(), text: `Fix #${w.pr} is live on the game now: web ${st.web.sha} (deployed ${st.web.at}) and worker ${st.worker.sha} (deployed ${st.worker.at}) both contain it. Check it for this player now (site_read for public pages, game_read for their records), record_receipt, then tell them it is live.` };
      deliver(Number(n), [event]);
      woke.push({ ticket: Number(n), pr: w.pr });
    }
  }
  return woke;
}

module.exports = { latestDeployed, contains, liveStatus, checkLiveWatches, ROWS };
