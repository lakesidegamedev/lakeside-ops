#!/usr/bin/env node
"use strict";
// Render a page to a PNG for the owner's app chat, using the box's installed
// Playwright and headless Chromium. The image lands in the public preview
// directory and the printed JSON carries its public URL, because the app shows
// Markdown links in supervisor replies but cannot load private attachments
// from this route yet.
//
//   node render.js --url https://example.com [--width 1280] [--height 800] [--full] [--name shot]
//   node render.js --html /path/page.html ...
//
// The directory name is random, so a link is not guessable, but anyone with
// the link can open it: never render secrets or private player data.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const PUBLIC_DIR = process.env.KEIR_RENDER_DIR || "/srv/ahd-public/keir-renders";
const PUBLIC_URL = (process.env.KEIR_RENDER_URL || "https://ops.lakesidegames.net/p/keir-renders").replace(/\/$/, "");
const CANDIDATES = [process.env.KEIR_PLAYWRIGHT_CORE, "/opt/keir/current/node_modules/playwright-core", "playwright-core", "playwright"].filter(Boolean);

function loadPlaywright() {
  for (const id of CANDIDATES) { try { return require(id); } catch { /* next */ } }
  throw new Error(`Playwright is not installed in any of: ${CANDIDATES.join(", ")}`);
}

function parse(argv) {
  const out = { width: 1280, height: 800, full: false, wait: 1500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") out.full = true;
    else if (["--url", "--html", "--name", "--width", "--height", "--wait"].includes(a)) out[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.url === !out.html) throw new Error("give exactly one of --url or --html");
  if (out.url && !/^https?:\/\//.test(out.url)) throw new Error("--url must be http or https");
  out.width = Math.min(3840, Math.max(320, Number(out.width) || 1280));
  out.height = Math.min(4000, Math.max(240, Number(out.height) || 800));
  out.wait = Math.min(30000, Math.max(0, Number(out.wait) || 0));
  out.name = String(out.name || "render").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "render";
  return out;
}

async function render(opts) {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(os.homedir(), ".cache/ms-playwright");
  const { chromium } = loadPlaywright();
  const dir = path.join(PUBLIC_DIR, crypto.randomBytes(9).toString("hex"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, `${opts.name}.png`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
    if (opts.url) await page.goto(opts.url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => page.waitForLoadState("load"));
    else await page.setContent(fs.readFileSync(opts.html, "utf8"), { waitUntil: "networkidle", timeout: 45000 });
    if (opts.wait) await page.waitForTimeout(opts.wait);
    await page.screenshot({ path: file, fullPage: opts.full });
    const title = await page.title().catch(() => "");
    fs.chmodSync(file, 0o644);
    return { file, url: `${PUBLIC_URL}/${path.basename(dir)}/${path.basename(file)}`, bytes: fs.statSync(file).size, title, width: opts.width, height: opts.height, fullPage: opts.full };
  } finally { await browser.close(); }
}

if (require.main === module) {
  render(parse(process.argv.slice(2)))
    .then((r) => { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); })
    .catch((e) => { process.stderr.write(`render failed: ${e.message}\n`); process.exit(1); });
}

module.exports = { render, parse };
