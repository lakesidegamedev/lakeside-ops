"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { render, options } = require("../lib/operator/pageview");

test("path, device and settings become one logged-out render", async () => {
  let script;
  const out = await render({ path: "/wrapped", device: "iphone", reducedMotion: true, darkMode: true }, { run: async (cmd, args) => { script = args[1]; return JSON.stringify({ title: "Wrapped", finalUrl: "https://www.ahousedividedgame.com/wrapped", text: "hi", png: "AAAA" }); }, playwright: "playwright-core" });
  assert.match(script, /"iPhone 14"/); assert.match(script, /reducedMotion: "reduce"/); assert.match(script, /colorScheme: "dark"/);
  assert.match(script, /https:\/\/www\.ahousedividedgame\.com\/wrapped/);
  assert.equal(out.loggedOut, true); assert.equal(out.image.media_type, "image/png"); assert.equal(out.device, "iphone");
});

test("only game pages, no cookies, no other hosts", () => {
  assert.throws(() => options({ path: "//evil.example/x" }), /path must start/);
  assert.throws(() => options({ url: "https://evil.example/" }), /only ahousedividedgame/);
  assert.throws(() => options({ path: "/ok", device: "toaster" }), /device must be/);
  assert.equal(options({ url: "https://ahousedividedgame.com/wrapped" }).device, "desktop");
  assert.ok(!("cookie" in options({ path: "/x", cookie: "a=b" })), "a session cannot be passed");
});

test("a render failure is reported, not swallowed", async () => {
  await assert.rejects(render({ path: "/x" }, { run: async () => JSON.stringify({ error: "net::ERR" }) }), /did not render/);
});
