"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { handleSecurityRoute, isSecurityPath, sameOrigin } = require("./security-routes");
const { makeSecurityBody } = require("./security-page");
const { evaluate, summarize } = require("./security-service");

function call(pathname, opts = {}) {
  const {
    method = "GET",
    session = { role: "admin", email: "admin@example.test" },
    headers = {},
    snapshot,
    reprobe,
  } = opts;
  const req = Readable.from([]);
  Object.assign(req, { method, url: pathname, headers: { host: "ops.example.test", ...headers } });
  const out = { status: 0, headers: {}, body: "" };
  const res = {
    setHeader() {},
    writeHead(status, h) {
      out.status = status;
      out.headers = h || {};
    },
    end(b) {
      out.body = String(b || "");
    },
  };
  const ctx = {
    resolveSession: async () => session,
    addSecurityHeaders() {},
    renderShell: ({ title, body }) => `<title>${title}</title>${body}`,
    snapshot: snapshot || (async () => ({ summary: { score: 90, posture: "good", counts: {} }, hosts: [], findings: [] })),
    reprobe: reprobe || (async () => ({ results: [], snapshot: { ok: true } })),
  };
  return handleSecurityRoute(req, res, pathname.split("?")[0], ctx).then((handled) => ({
    handled,
    ...out,
    json: () => JSON.parse(out.body),
  }));
}

const intactFacts = {
  firewall: { active: true, defaultIncoming: "deny", allowedInbound: [{ port: "22/tcp" }, { port: "443/tcp" }] },
  fail2ban: { running: true, jails: ["recidive", "sshd"], currentlyBanned: 3, totalBanned: 10 },
  ssh: {
    permitRootLogin: "prohibit-password",
    passwordAuthentication: "no",
    x11Forwarding: "no",
    agentForwarding: "no",
    maxAuthTries: "4",
  },
  auditd: { active: true, rules: 25, lost: 0 },
  updates: { securityPending: 0, rebootRequired: false, unattendedEnabled: true, unattendedActive: true },
  accounts: { uid0: ["root"], emptyPassword: [], nopasswdSudoEntries: 2 },
  exposure: { publicListeners: [{ proto: "tcp", port: 22 }], docker: { published: [], privileged: 0, hostNetwork: 0, running: 3 } },
  integrity: { worldWritableEtc: [], perms: { "/etc/shadow": "640", "/root/.ssh": "700" } },
  auth: { sshFailed24h: 100, sshAccepted24h: 5, uniqueSourceIps: 4, topSources: [] },
  services: { failedUnits: [] },
};

function record(overrides = {}, factsOverride = {}) {
  return {
    id: "eu",
    label: "EU",
    name: "contabo-vps18",
    ok: true,
    error: null,
    collectedAt: new Date().toISOString(),
    ageMs: 1000,
    stale: false,
    fetchMs: 5,
    facts: { ...intactFacts, ...factsOverride },
    ...overrides,
  };
}

describe("security route surface", () => {
  it("claims only the dashboard's own paths", () => {
    assert.equal(isSecurityPath("/security"), true);
    assert.equal(isSecurityPath("/api/security"), true);
    assert.equal(isSecurityPath("/api/security/reprobe"), true);
    // Caddy owns /security/* for the Semgrep MCP; the dashboard must not claim it.
    assert.equal(isSecurityPath("/security/mcp"), false);
    assert.equal(isSecurityPath("/security/hosts"), false);
    assert.equal(isSecurityPath("/scheduler"), false);
  });

  it("returns false for unrelated paths so the if-chain continues", async () => {
    const res = await call("/scheduler");
    assert.equal(res.handled, false);
  });

  it("redirects signed-out page views and 401s the API", async () => {
    assert.equal((await call("/security", { session: null })).status, 302);
    const api = await call("/api/security", { session: null });
    assert.equal(api.status, 401);
    assert.equal(api.json().error, "Sign in required");
  });

  it("hides the surface from non-admin sessions", async () => {
    assert.equal((await call("/security", { session: { role: "moderator" } })).status, 404);
    assert.equal((await call("/api/security", { session: { role: "moderator" } })).status, 404);
  });

  it("renders the page for admins inside the shell", async () => {
    const page = await call("/security");
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Security<\/title>/);
    assert.match(page.body, /Host hardening, monitoring health/);
  });

  it("serves the snapshot as JSON", async () => {
    const api = await call("/api/security");
    assert.equal(api.status, 200);
    assert.equal(api.json().summary.score, 90);
    assert.equal(api.headers["Cache-Control"], "no-store");
  });

  it("requires a same-origin marker on re-probe", async () => {
    const bare = await call("/api/security/reprobe", { method: "POST" });
    assert.equal(bare.status, 403);
    const wrong = await call("/api/security/reprobe", {
      method: "POST",
      headers: { origin: "https://evil.test", "x-requested-with": "ops-dashboard" },
    });
    assert.equal(wrong.status, 403);
    const good = await call("/api/security/reprobe", {
      method: "POST",
      headers: { origin: "https://ops.example.test", "x-requested-with": "ops-dashboard" },
    });
    assert.equal(good.status, 200);
  });
});

describe("sameOrigin", () => {
  it("accepts the https host and localhost http", () => {
    assert.equal(
      sameOrigin({ headers: { host: "ops.example.test", origin: "https://ops.example.test", "x-requested-with": "ops-dashboard" } }),
      true,
    );
    assert.equal(
      sameOrigin({ headers: { host: "127.0.0.1:9788", origin: "http://127.0.0.1:9788", "x-requested-with": "ops-dashboard" } }),
      true,
    );
  });
  it("rejects a missing marker or a foreign origin", () => {
    assert.equal(sameOrigin({ headers: { host: "ops.example.test", origin: "https://ops.example.test" } }), false);
    assert.equal(
      sameOrigin({ headers: { host: "ops.example.test", origin: "https://evil.test", "x-requested-with": "ops-dashboard" } }),
      false,
    );
  });
});

describe("security findings", () => {
  it("reports nothing for a host inside baseline", () => {
    const findings = evaluate([record()]);
    assert.deepEqual(findings, []);
    assert.equal(summarize([record()], findings).score, 100);
    assert.equal(summarize([record()], findings).posture, "good");
  });

  it("escalates a missing firewall to critical", () => {
    const findings = evaluate([record({}, { firewall: { active: false, allowedInbound: [] } })]);
    const f = findings.find((x) => x.rule === "firewall-inactive");
    assert.ok(f, "expected a firewall-inactive finding");
    assert.equal(f.severity, "critical");
    assert.equal(f.id, "eu:firewall-inactive");
  });

  it("flags password auth, no fail2ban and a stopped auditd", () => {
    const findings = evaluate([
      record({}, {
        ssh: { ...intactFacts.ssh, passwordAuthentication: "yes" },
        fail2ban: { running: false, jails: [], currentlyBanned: 0, totalBanned: 0 },
        auditd: { active: false, rules: 0, lost: 0 },
      }),
    ]);
    const rules = findings.map((f) => f.rule);
    assert.ok(rules.includes("ssh-password-auth"));
    assert.ok(rules.includes("fail2ban-down"));
    assert.ok(rules.includes("auditd-down"));
    assert.equal(findings.find((f) => f.rule === "ssh-password-auth").severity, "critical");
  });

  it("flags docker publishing to the public interface", () => {
    const findings = evaluate([
      record({}, {
        exposure: {
          publicListeners: [{ proto: "tcp", port: 22 }],
          docker: { published: [{ name: "web", ports: "0.0.0.0:3000->3000/tcp" }], privileged: 0, hostNetwork: 0, running: 2 },
        },
      }),
    ]);
    assert.ok(findings.some((f) => f.rule === "docker-published-public"));
  });

  it("treats a stale probe as a monitoring outage, not a clean bill", () => {
    const findings = evaluate([record({ ok: true, stale: true, ageMs: 90 * 60 * 1000 })]);
    assert.ok(findings.some((f) => f.rule === "probe-stale"));
  });

  it("reports an unreachable host as high severity", () => {
    const findings = evaluate([record({ ok: false, error: "ssh: connect timed out", facts: null })]);
    const f = findings.find((x) => x.rule === "probe-unreachable");
    assert.ok(f);
    assert.equal(f.severity, "high");
  });

  it("sorts by severity and scores posture", () => {
    const findings = evaluate([
      record({}, { ssh: { ...intactFacts.ssh, passwordAuthentication: "yes" } }),
      record({ id: "us", label: "US" }, { updates: { securityPending: 0, rebootRequired: true, unattendedEnabled: true }, firewall: { active: true, defaultIncoming: "deny", allowedInbound: [{ port: "22/tcp" }] } }),
    ]);
    assert.equal(findings[0].severity, "critical");
    const summary = summarize([record(), record({ id: "us" })], findings);
    assert.ok(summary.score < 100);
    assert.equal(summary.posture, "critical");
  });

  it("keeps finding ids stable per host and rule so alerts can dedupe", () => {
    const a = evaluate([record({}, { auditd: { active: false, rules: 0, lost: 0 } })])[0];
    const b = evaluate([record({}, { auditd: { active: false, rules: 0, lost: 0 } })])[0];
    assert.equal(a.id, b.id);
    assert.equal(a.severity, b.severity);
  });
});

describe("security page", () => {
  it("renders a fragment with styles and both host slots", () => {
    const { extraCss, body } = makeSecurityBody();
    assert.match(extraCss, /\.sec-host/);
    assert.match(body, /id="sec-hosts"/);
    assert.match(body, /id="sec-findings"/);
    assert.match(body, /\/api\/security/);
    // Must be a fragment: renderShell supplies the document.
    assert.doesNotMatch(body, /<html/i);
  });

  it("does not build DOM from innerHTML with remote values", () => {
    const { body } = makeSecurityBody();
    assert.doesNotMatch(body, /innerHTML/);
  });
});
