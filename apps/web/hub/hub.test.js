"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const library = require("./library");
const { renderMarkdown } = require("./markdown");
const { handleHubRoute, RETIRED } = require("./routes");
const { viewFor } = require("./shell");

let dir;
let legacy;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-test-"));
  legacy = fs.mkdtempSync(path.join(os.tmpdir(), "hub-legacy-"));
  const manifest = [
    { slug: "market-audit", title: "RAW MARKET AUDIT, TURN 9", category: "Economy Operations", summary: "s", publishedAt: "2026-10-01T00:00:00Z", public: true },
    { slug: "daily-thing", title: "Daily", category: "Daily Reports", publishedAt: "2026-10-02T00:00:00Z" },
    { slug: "secret-handoff", title: "Token", category: "Access", publishedAt: "2026-10-03T00:00:00Z" },
    { slug: "new-election-forecast", title: "Senate forecast", category: "Elections", publishedAt: "2026-10-04T00:00:00Z" },
  ];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, "library.json"), JSON.stringify({ items: {
    "market-audit": { title: "Market audit", category: "economy", type: "Audit", labels: ["1991"] },
    "secret-handoff": { hidden: true },
    "legacy:old-page": { title: "Old page", category: "world", type: "Report", labels: [], legacy: true },
  } }));
  for (const m of manifest) fs.writeFileSync(path.join(dir, `${m.slug}.html`), `<html><body><a href="/reports/x">x</a></body></html>`);
  fs.writeFileSync(path.join(legacy, "old-page.html"), "<html><body>old</body></html>");
});
after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(legacy, { recursive: true, force: true }); });

describe("library catalogue", () => {
  it("applies curation, drops daily and hidden reports, files the rest by keyword", () => {
    const items = library.loadReports({ publishedDir: dir, legacyDir: legacy });
    const ids = items.map((x) => x.id);
    assert.deepEqual(ids.sort(), ["market-audit", "new-election-forecast", "old-page"]);
    const audit = items.find((x) => x.id === "market-audit");
    assert.equal(audit.title, "Market audit");
    assert.equal(audit.original, "RAW MARKET AUDIT, TURN 9");
    assert.equal(audit.category, "economy");
    assert.equal(audit.public, true);
    assert.equal(items.find((x) => x.id === "new-election-forecast").category, "elections");
    assert.equal(items.find((x) => x.id === "old-page").legacy, true);
  });

  it("injects the frame script once, before the last body close", () => {
    const out = library.embedHtml("<html><body>a</body></html>");
    assert.equal(out.match(/window\.top/g).length >= 1, true);
    assert.match(out, /<\/script><\/body><\/html>$/);
  });
});

describe("markdown", () => {
  it("escapes HTML and drops unsafe links", () => {
    const { html } = renderMarkdown("# Hi\n\n<script>x</script> [bad](javascript:alert(1)) [ok](/library)");
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /<a href="\/library">ok<\/a>/);
  });
});

describe("routing", () => {
  const mkRes = () => {
    const res = { headers: {}, status: 0, body: "", headersSent: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
      writeHead(s, h = {}) { this.status = s; for (const [k, v] of Object.entries(h)) this.setHeader(k, v); this.headersSent = true; },
      end(b = "") { this.body = b; } };
    return res;
  };
  const ctx = (role) => ({
    resolveSession: async () => (role ? { role, email: "a@b", userId: "" } : null),
    addSecurityHeaders: (res) => res.setHeader("X-Frame-Options", "DENY"),
    getDb: async () => { throw new Error("no db in tests"); },
    knowledgeStore: {}, getConfig: () => ({}), publishedDir: dir, legacyDir: legacy,
    kanban: () => ({ list: () => ({ items: [] }) }),
  });
  const req = (url) => ({ method: "GET", url, headers: { host: "ops.test" } });

  it("sends admins from retired pages and home to the library", async () => {
    for (const p of ["/", "/engine", "/reports"]) {
      const res = mkRes();
      assert.equal(await handleHubRoute(req(p), res, new URL(p, "http://x"), ctx("admin")), true);
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, "/library");
    }
    assert.ok(RETIRED.has("/scheduler"));
  });

  it("leaves public pages and non-admin requests to the existing handlers", async () => {
    for (const p of ["/", "/tickets", "/engine", "/reports/new-election-forecast"]) {
      const res = mkRes();
      assert.equal(await handleHubRoute(req(p), res, new URL(p, "http://x"), ctx(null)), false, p);
    }
  });

  it("frames a shared report for anyone, same-origin only", async () => {
    const res = mkRes();
    const u = "/reports/market-audit?embed=1";
    assert.equal(await handleHubRoute(req(u), res, new URL(u, "http://x"), ctx(null)), true);
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
  });

  it("does not frame an admin-only report for a signed-out visitor", async () => {
    const res = mkRes();
    const u = "/reports/new-election-forecast?embed=1";
    assert.equal(await handleHubRoute(req(u), res, new URL(u, "http://x"), ctx(null)), false);
  });

  it("maps paths to hub views", () => {
    assert.equal(viewFor("/kanban"), "board");
    assert.equal(viewFor("/t/abc"), "tickets");
    assert.equal(viewFor("/reports/x"), "library");
    assert.equal(viewFor("/status"), "");
  });
});
