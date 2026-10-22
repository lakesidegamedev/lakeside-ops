"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runAlertCheck, diff } = require("./security-alert");

function snap(findings) {
  return {
    generatedAt: new Date().toISOString(),
    summary: { score: 70, posture: "critical", counts: {} },
    hosts: [],
    findings,
  };
}

const critical = {
  id: "eu:firewall-inactive",
  rule: "firewall-inactive",
  host: "eu",
  hostLabel: "EU",
  severity: "critical",
  title: "Host firewall is not active",
  detail: "Everything is exposed.",
  remedy: "ufw --force enable",
};
const high = {
  id: "us:fail2ban-down",
  rule: "fail2ban-down",
  host: "us",
  hostLabel: "US",
  severity: "high",
  title: "fail2ban is not running",
  detail: "No throttling.",
  remedy: "systemctl enable --now fail2ban",
};
const medium = {
  id: "eu:updates-reboot-required",
  rule: "updates-reboot-required",
  host: "eu",
  hostLabel: "EU",
  severity: "medium",
  title: "Reboot required",
  detail: "Kernel staged.",
  remedy: "reboot",
};

describe("security alert diff", () => {
  it("only alerts on critical and high", () => {
    const { fresh } = diff(snap([critical, high, medium]), { alerted: {} });
    assert.deepEqual(
      fresh.map((f) => f.id).sort(),
      ["eu:firewall-inactive", "us:fail2ban-down"],
    );
  });

  it("does not repeat a finding that was already alerted", () => {
    const state = { alerted: { "eu:firewall-inactive": { severity: "critical", title: "x" } } };
    const { fresh } = diff(snap([critical]), state);
    assert.equal(fresh.length, 0);
  });

  it("reports recovery when a finding disappears", () => {
    const state = { alerted: { "eu:firewall-inactive": { severity: "critical", title: "Host firewall is not active" } } };
    const { resolved } = diff(snap([]), state);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, "eu:firewall-inactive");
  });

  it("keeps firstAlertedAt across checks so alerts have an age", () => {
    const state = { alerted: { "eu:firewall-inactive": { severity: "critical", title: "x", firstAlertedAt: "2026-01-01T00:00:00.000Z" } } };
    const { nextAlerted } = diff(snap([critical]), state);
    assert.equal(nextAlerted["eu:firewall-inactive"].firstAlertedAt, "2026-01-01T00:00:00.000Z");
  });
});

describe("runAlertCheck", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-alert-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("posts once and persists state so the next run is silent", async () => {
    const statePath = path.join(dir, "alerts.json");
    const sent = [];
    const notify = async (payload) => {
      sent.push(payload);
      return { posted: true };
    };

    const first = await runAlertCheck({ snapshot: async () => snap([critical]), statePath, notify });
    assert.equal(first.fresh, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /critical/i);
    assert.match(sent[0].description, /ufw --force enable/);

    const second = await runAlertCheck({ snapshot: async () => snap([critical]), statePath, notify });
    assert.equal(second.fresh, 0);
    assert.equal(sent.length, 1, "must not re-alert the same finding");
  });

  it("posts a recovery when the finding clears", async () => {
    const statePath = path.join(dir, "alerts.json");
    const sent = [];
    const notify = async (payload) => {
      sent.push(payload);
      return { posted: true };
    };
    await runAlertCheck({ snapshot: async () => snap([critical]), statePath, notify });
    const cleared = await runAlertCheck({ snapshot: async () => snap([]), statePath, notify });
    assert.equal(cleared.resolved, 1);
    assert.match(sent[1].title, /cleared/i);

    // And the resolved finding can alert again if it comes back.
    const again = await runAlertCheck({ snapshot: async () => snap([critical]), statePath, notify });
    assert.equal(again.fresh, 1);
  });

  it("survives a missing webhook (notifier returns skipped)", async () => {
    const statePath = path.join(dir, "alerts.json");
    const result = await runAlertCheck({
      snapshot: async () => snap([critical]),
      statePath,
      notify: async () => ({ skipped: "no webhook" }),
    });
    assert.equal(result.fresh, 1);
    assert.deepEqual(result.posted, [{ skipped: "no webhook" }]);
  });

  it("never throws when the notifier rejects", async () => {
    const statePath = path.join(dir, "alerts.json");
    const result = await runAlertCheck({
      snapshot: async () => snap([high]),
      statePath,
      notify: async () => {
        throw new Error("discord 500");
      },
    });
    assert.equal(result.fresh, 1);
    assert.ok(result.posted[0].error);
  });

  it("never throws when the snapshot itself fails", async () => {
    const result = await runAlertCheck({
      snapshot: async () => {
        throw new Error("ssh down");
      },
      notify: async () => ({ posted: true }),
      statePath: path.join(dir, "alerts.json"),
    });
    assert.match(result.error, /ssh down/);
  });

  it("caps a flood of findings in one message", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...critical,
      id: `eu:rule-${i}`,
      title: `Finding ${i}`,
    }));
    const sent = [];
    await runAlertCheck({
      snapshot: async () => snap(many),
      statePath: path.join(dir, "alerts.json"),
      notify: async (p) => {
        sent.push(p);
        return { posted: true };
      },
    });
    assert.match(sent[0].description, /and 12 more/);
    assert.match(sent[0].title, /20 critical/);
  });
});
