"use strict";

// Invoked by the broker inside the task sandbox with no network or credentials.
const fs = require("node:fs");
const { chromium, devices } = require("/opt/computer-runtime/node_modules/playwright");
const { file, preset, expect } = JSON.parse(Buffer.from(process.argv[1], "base64").toString());

(async () => {
  const location = fs.realpathSync(`/workspace/${file}`);
  const stat = fs.statSync(location);
  if (!location.startsWith("/workspace/") || !stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("invalid visual fixture file");
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  try {
    const context = await browser.newContext({ ...(preset ? devices[preset] : { viewport: { width: 1280, height: 1000 } }), serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(fs.readFileSync(location, "utf8"), { waitUntil: "domcontentloaded", timeout: 5000 });
    await page.getByText(expect, { exact: false }).first().waitFor({ state: "visible", timeout: 6000 });
    const png = await page.screenshot({ animations: "disabled", timeout: 6000 });
    const text = (await page.locator("body").innerText({ timeout: 3000 })).slice(0, 9000);
    process.stdout.write(JSON.stringify({ text, image: { data: png.toString("base64") } }));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e.message).slice(0, 300)); process.exitCode = 1; });
