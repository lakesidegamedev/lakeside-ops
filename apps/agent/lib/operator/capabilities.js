"use strict";
// Keir 2.1 capabilities: what changed recently, seeing a game page, and waking
// after a turn to verify a fix. Owner-picked 2026-10-13.
const { execFile } = require("node:child_process");
const path = require("node:path");

const exec = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 60000, maxBuffer: 8 << 20, ...opts }, (e, out, err) => e ? reject(new Error(String(err || e.message).slice(0, 400))) : resolve(String(out))));

/** What changed in the game: commits on main and development, released patch
 *  notes and unreleased notes. Up to two years back; filter by keyword (commit
 *  messages and patch notes) and by path. Long windows without a filter return
 *  the patch notes and counts, not every commit. */
async function recentChanges({ repo = "/root/projects/AHDGame", days = 3, query, path: p, run = exec } = {}) {
  const d = Math.min(730, Math.max(1, Number(days) || 3));
  const q = query ? String(query).slice(0, 80) : null;
  if (p && (/\.\./.test(p) || String(p).length > 200)) throw new Error("bad path");
  await run("/usr/bin/git", ["-C", repo, "fetch", "--quiet", "origin", "main", "development"], { timeout: 120000 }).catch(() => {});
  const filtered = Boolean(q || p) || d <= 14;
  const log = async (ref) => {
    const args = ["-C", repo, "log", `origin/${ref}`, `--since=${d} days ago`, "--no-merges", "--format=%h%x09%ad%x09%an%x09%s", "--date=short"];
    if (q) args.push("-i", `--grep=${q}`);
    if (p) args.push("--", String(p));
    return (await run("/usr/bin/git", args).catch(() => "")).trim().split("\n").filter(Boolean)
      .map((l) => { const [sha, date, author, subject] = l.split("\t"); return { sha, date, author, subject: (subject || "").slice(0, 160), pr: Number(/\(#(\d+)\)/.exec(subject || "")?.[1]) || null }; });
  };
  const main = await log("main"), development = await log("development");
  const onMain = new Set(main.map((c) => c.subject));
  const since = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const releases = [];
  for (const f of (await run("/usr/bin/git", ["-C", repo, "ls-tree", "--name-only", "origin/main", "content/changelog/public/"]).catch(() => "")).trim().split("\n").filter((x) => x.endsWith(".md"))) {
    const body = await run("/usr/bin/git", ["-C", repo, "show", `origin/main:${f}`]).catch(() => "");
    const fm = (k) => (new RegExp(`^${k}:\\s*"?([^"\\n]*)"?`, "m").exec(body) || [])[1] || "";
    const summary = (/^summary:\s*>-?\s*\n((?:\s{2,}.*\n)+)/m.exec(body)?.[1] || "").replace(/\s+/g, " ").trim();
    const date = fm("date");
    if (date && date < since) continue;
    if (q && !body.toLowerCase().includes(q.toLowerCase())) continue;
    const hits = q ? body.split("\n").filter((l) => l.toLowerCase().includes(q.toLowerCase())).slice(0, 4).map((l) => l.trim().slice(0, 200)) : undefined;
    releases.push({ version: fm("version"), date, title: fm("title"), summary: summary.slice(0, 400), ...(hits ? { matching: hits } : {}) });
  }
  releases.sort((a, b) => (a.date < b.date ? 1 : -1));
  const notes = [];
  for (const f of (await run("/usr/bin/git", ["-C", repo, "ls-tree", "--name-only", "origin/development", "content/changelog/unreleased/"]).catch(() => "")).trim().split("\n").filter((x) => x.endsWith(".md")).slice(0, 60)) {
    const body = await run("/usr/bin/git", ["-C", repo, "show", `origin/development:${f}`]).catch(() => "");
    if (q && !body.toLowerCase().includes(q.toLowerCase())) continue;
    notes.push({ file: path.basename(f), note: (body.replace(/^---[\s\S]*?---/, "").trim().split("\n").find((l) => l.trim() && !l.startsWith("#")) || "").slice(0, 240) });
  }
  const cap = (list) => filtered ? list.slice(0, 80) : list.slice(0, 15);
  return { days: d, query: q, path: p || null, releasedPatchNotes: releases, liveOnMain: cap(main), liveOnMainTotal: main.length,
    onDevelopmentOnly: cap(development.filter((c) => !onMain.has(c.subject))), unreleasedNotes: notes,
    instruction: filtered ? "liveOnMain is in production; onDevelopmentOnly is not yet. Patch notes are what players were told." : "Long window without a filter: showing patch notes and the latest commits only. Pass query or path to search all commits in the window." };
}

/** Render a public game page as a logged-out visitor sees it: screenshot plus visible text. */
const PAGE = /^https:\/\/(www\.)?ahousedividedgame\.com\/[\w\-./?=&%#]*$/;
// Keir pins its own playwright-core. Borrowing the game checkout's copy broke
// the page sensor whenever that checkout reinstalled a newer Playwright.
function playwrightModule() {
  if (process.env.KEIR_PLAYWRIGHT_MODULE) return process.env.KEIR_PLAYWRIGHT_MODULE;
  try { return require.resolve("playwright-core"); } catch { return "playwright-core"; }
}
async function viewPage(url, { run = exec, playwright = playwrightModule() } = {}) {
  if (!PAGE.test(String(url))) throw new Error("only ahousedividedgame.com pages can be viewed");
  const script = `
    const { chromium } = require(${JSON.stringify(playwright)});
    (async () => {
      const b = await chromium.launch({ args: ["--no-sandbox"] });
      try {
        const p = await b.newPage({ viewport: { width: 1280, height: 1600 } });
        await p.goto(${JSON.stringify(url)}, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
        await p.waitForTimeout(1500);
        const text = (await p.evaluate(() => document.body.innerText)).replace(/\\n{3,}/g, "\\n\\n").slice(0, 9000);
        const png = (await p.screenshot({ fullPage: false })).toString("base64");
        process.stdout.write(JSON.stringify({ title: await p.title(), finalUrl: p.url(), text, png }));
      } finally { await b.close(); }
    })().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e.message || e).slice(0, 300) })); });`;
  const out = JSON.parse(await run(process.execPath, ["-e", script], { timeout: 90000, env: { PATH: "/usr/bin:/bin", HOME: "/root" } }));
  if (out.error) throw new Error(`page did not render: ${out.error}`);
  return { title: out.title, url: out.finalUrl, loggedOut: true, text: out.text,
    note: "This is what a logged-out visitor sees. Panels only the owner of a company or character sees will not appear; read those numbers with the trace tools.",
    image: { data: out.png, media_type: "image/png" } };
}

/** Wakes tasks after a given turn has been processed (no model runs while waiting). */
const MAX_TURN_WATCH_MS = 8 * 3600000;
function createTurnWatch({ ledger, currentTurn, now = () => Date.now(), log = () => {} }) {
  async function tick() {
    const watching = Object.values(ledger.data.jobs).filter((j) => j.turnWatch && !["done", "dismissed", "cancelled"].includes(j.state));
    if (!watching.length) return;
    let turn; try { turn = await currentTurn(); } catch (e) { log(`turnwatch: ${e.message}`); return; }
    for (const job of watching) {
      const w = job.turnWatch;
      // The game's currentTurn is the last turn already processed (processing
      // targets currentTurn + 1), so a watch on turn N is done once
      // currentTurn reaches N. Waiting for N + 1 cost every check a full turn.
      if (!(turn >= w.turn) && now() - w.since < MAX_TURN_WATCH_MS) continue;
      const text = turn >= w.turn ? `Turn ${w.turn} has been processed (now turn ${turn}). ${w.note ? `You wanted to: ${w.note}` : "Verify the outcome now."}` : `Turn ${w.turn} still had not processed after 8 hours (now turn ${turn}). Check the turn status.`;
      (job.inbox ||= []).push({ authorId: "turn-watch", role: "system", content: text, at: new Date(now()).toISOString() });
      delete job.turnWatch;
      if (turn >= w.turn) job.turnChecks = [...(job.turnChecks || []), now()].slice(-10);
      if (["waiting", "blocked"].includes(job.state)) { job.state = "queued"; job.wakeAt = 0; }
      ledger.audit("turn_watch_done", { job: job.id, turn: w.turn, now: turn }); ledger.save();
    }
  }
  return { tick };
}

module.exports = { recentChanges, viewPage, createTurnWatch, PAGE, MAX_TURN_WATCH_MS };
