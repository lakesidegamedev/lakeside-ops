"use strict";
// Keir 10 (W3): see a public game page as a player on a phone sees it.
//
// A superset of the old view_page (url only, desktop only): path or url, a device
// (desktop, iphone, android), reduced motion and dark mode. Ticket 1829 turned on
// whether the page behaved differently with reduced motion; Keir could not look.
// Logged-out only. Signed-in views need a read-only test account, and the code
// has none, so there is deliberately no way to pass a session or cookie here.

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);

const ORIGIN = "https://www.ahousedividedgame.com";
const PAGE = /^https:\/\/(www\.)?ahousedividedgame\.com\/[\w\-./?=&%#]*$/;
const DEVICES = { desktop: null, iphone: "iPhone 14", android: "Pixel 7" };

function playwrightModule() {
  if (process.env.KEIR_PLAYWRIGHT_MODULE) return process.env.KEIR_PLAYWRIGHT_MODULE;
  try { return require.resolve("playwright-core"); } catch { return "playwright-core"; }
}

function target(input) {
  if (input.path !== undefined) {
    const p = String(input.path);
    if (!/^\/[\w\-./?=&%#]*$/.test(p) || p.startsWith("//")) throw new Error("path must start with / and use only plain URL characters");
    return ORIGIN + p;
  }
  const url = String(input.url || "");
  if (!PAGE.test(url)) throw new Error("only ahousedividedgame.com pages can be viewed: pass path (such as /wrapped) or url");
  return url;
}

function options(input) {
  const device = input.device === undefined ? "desktop" : String(input.device);
  if (!(device in DEVICES)) throw new Error("device must be desktop, iphone or android");
  return { url: target(input), device, reducedMotion: input.reducedMotion === true, darkMode: input.darkMode === true };
}

async function render(input, { run = (cmd, args, opts) => exec(cmd, args, opts).then((r) => r.stdout), playwright = playwrightModule() } = {}) {
  const o = options(input);
  const script = `
    const pw = require(${JSON.stringify(playwright)});
    (async () => {
      const preset = ${JSON.stringify(DEVICES[o.device])};
      const b = await pw.chromium.launch({ args: ["--no-sandbox"] });
      try {
        const base = preset ? pw.devices[preset] : { viewport: { width: 1280, height: 1600 } };
        const ctx = await b.newContext({ ...base, reducedMotion: ${o.reducedMotion ? '"reduce"' : '"no-preference"'}, colorScheme: ${o.darkMode ? '"dark"' : '"light"'}, acceptDownloads: false, serviceWorkers: "block" });
        const p = await ctx.newPage();
        await p.goto(${JSON.stringify(o.url)}, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
        await p.waitForTimeout(1500);
        const text = (await p.evaluate(() => document.body.innerText)).replace(/\\n{3,}/g, "\\n\\n").slice(0, 9000);
        const png = (await p.screenshot({ fullPage: false })).toString("base64");
        process.stdout.write(JSON.stringify({ title: await p.title(), finalUrl: p.url(), text, png }));
      } finally { await b.close(); }
    })().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e.message || e).slice(0, 300) })); });`;
  const out = JSON.parse(await run(process.execPath, ["-e", script], { timeout: 90000, maxBuffer: 32 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", HOME: "/root" } }));
  if (out.error) throw new Error(`page did not render: ${out.error}`);
  return { title: out.title, url: out.finalUrl, loggedOut: true, device: o.device, reducedMotion: o.reducedMotion, darkMode: o.darkMode, text: out.text,
    note: "This is what a logged-out visitor sees on this device and settings. Panels only the owner of a company or character sees will not appear; read those numbers with the trace tools. Signed-in views are not available.",
    image: { data: out.png, media_type: "image/png" } };
}

module.exports = { render, options, DEVICES, publicPage: (url) => PAGE.test(url) };
