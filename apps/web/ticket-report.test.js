// Unit tests for ticket-report aggregation + rendering (no DB, no I/O).
// Run: node --test ticket-report.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeTicketReport, makeTicketReportBody, terminalAt } = require("./ticket-report");

const NOW = "2026-09-04T12:00:00.000Z";

function ticket(over) {
  return {
    ticketNumber: 1,
    title: "t",
    status: "closed",
    category: "bug",
    tags: [],
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    closedAt: "2026-08-02T12:00:00.000Z",
    statusHistory: [],
    ...over,
  };
}

describe("terminalAt", () => {
  it("prefers closedAt", () => {
    const d = terminalAt(ticket({ closedAt: "2026-08-03T00:00:00Z", statusHistory: [{ status: "closed", at: "2026-08-05T00:00:00Z" }] }));
    assert.equal(d.toISOString(), "2026-08-03T00:00:00.000Z");
  });
  it("falls back to latest DONE history entry", () => {
    const d = terminalAt(ticket({
      closedAt: null,
      updatedAt: "2026-08-06T00:00:00Z",
      statusHistory: [
        { status: "triaging", at: "2026-08-02T00:00:00Z" },
        { status: "closed", at: "2026-08-04T00:00:00Z" },
      ],
    }));
    assert.equal(d.toISOString(), "2026-08-04T00:00:00.000Z");
  });
  it("returns null for still-open tickets", () => {
    assert.equal(terminalAt(ticket({ status: "open", closedAt: null, updatedAt: null, statusHistory: [] })), null);
  });
});

describe("computeTicketReport", () => {
  it("reconstructs outstanding-over-time from open/close dates", () => {
    const r = computeTicketReport([
      ticket({ ticketNumber: 1, createdAt: "2026-08-01T10:00:00Z", closedAt: "2026-08-03T10:00:00Z" }),
      ticket({ ticketNumber: 2, createdAt: "2026-08-02T10:00:00Z", closedAt: "2026-08-02T11:00:00Z" }),
      ticket({ ticketNumber: 3, status: "open", createdAt: "2026-08-02T10:00:00Z", closedAt: null, updatedAt: "2026-08-02T10:00:00Z" }),
    ], { now: NOW });
    assert.equal(r.total, 3);
    assert.equal(r.outstandingCount, 1);
    assert.equal(r.resolvedCount, 2);
    const byDay = Object.fromEntries(r.daily.map((d) => [d.date, d.outstanding]));
    assert.equal(byDay["2026-08-01"], 1);
    assert.equal(byDay["2026-08-02"], 2); // opened 2, closed 1
    assert.equal(byDay["2026-08-03"], 1); // first ticket resolved
    assert.equal(r.peakOutstanding, 2);
    // Backlog lists the open ticket oldest-first.
    assert.equal(r.backlog.length, 1);
    assert.equal(r.backlog[0].number, 3);
  });

  it("computes median/mean resolution and 24h/7d shares", () => {
    const r = computeTicketReport([
      ticket({ ticketNumber: 1, createdAt: "2026-08-01T00:00:00Z", closedAt: "2026-08-01T12:00:00Z" }), // 12h
      ticket({ ticketNumber: 2, createdAt: "2026-08-01T00:00:00Z", closedAt: "2026-08-03T00:00:00Z" }), // 48h
      ticket({ ticketNumber: 3, createdAt: "2026-08-01T00:00:00Z", closedAt: "2026-08-11T00:00:00Z" }), // 240h
    ], { now: NOW });
    assert.equal(r.timing.n, 3);
    assert.equal(r.timing.medianHours, 48);
    assert.equal(r.timing.meanHours, 100);
    assert.equal(r.timing.within24h, 1 / 3);
    assert.equal(r.timing.within7d, 2 / 3);
  });

  it("breaks down categories and tags, skips dateless docs", () => {
    const r = computeTicketReport([
      ticket({ ticketNumber: 1, category: "bug", tags: ["ui-ux", "map-geo"] }),
      ticket({ ticketNumber: 2, category: "bug", tags: ["ui-ux"] }),
      ticket({ ticketNumber: 3, category: "gameplay", tags: [] }),
      ticket({ ticketNumber: 4, createdAt: null, category: "bug" }),
    ], { now: NOW });
    assert.equal(r.total, 3);
    assert.deepEqual(r.categories.map((c) => [c.category, c.total]), [["bug", 2], ["gameplay", 1]]);
    assert.deepEqual(r.topTags.map((x) => [x.tag, x.n]), [["ui-ux", 2], ["map-geo", 1]]);
  });

  it("handles an empty collection", () => {
    const r = computeTicketReport([], { now: NOW });
    assert.equal(r.total, 0);
    assert.deepEqual(r.daily, []);
    assert.equal(r.timing.medianHours, null);
    const { body } = makeTicketReportBody(r);
    assert.match(body, /No tickets/);
  });
});

describe("makeTicketReportBody", () => {
  it("renders all panels with escaped content", () => {
    const r = computeTicketReport([
      ticket({ ticketNumber: 7, title: "<b>evil</b>", category: "bug", tags: ["x"] }),
    ], { now: NOW });
    const { extraCss, body } = makeTicketReportBody(r);
    assert.ok(extraCss.includes(".tr-wrap"));
    for (const h of ["Outstanding tickets over time", "Opened vs closed per week", "Median time to close", "Tickets by category", "Top tags", "Currently outstanding"]) {
      assert.ok(body.includes(h), "missing panel: " + h);
    }
    assert.ok(!body.includes("<b>evil</b>"), "title must be escaped");
    assert.ok(body.includes("<svg"), "charts must render");
  });

  it("public variant keeps aggregates but hides per-ticket backlog", () => {
    const docs = [
      ticket({ ticketNumber: 7, status: "open", title: "Secret player issue", createdAt: "2026-09-01T00:00:00Z", closedAt: null, updatedAt: "2026-09-01T00:00:00Z" }),
    ];
    const r = computeTicketReport(docs, { now: NOW });
    const pub = makeTicketReportBody(r, { showBacklog: false, backHref: "/" }).body;
    const full = makeTicketReportBody(r, { showBacklog: true, backHref: "/tickets" }).body;
    // Aggregates identical in both.
    for (const h of ["Outstanding tickets over time", "Tickets by category", "Top tags"]) {
      assert.ok(pub.includes(h), "public missing panel: " + h);
    }
    // No per-ticket data leaks publicly.
    assert.ok(!pub.includes("Secret player issue"), "public body must not contain ticket titles");
    assert.ok(!pub.includes("/tickets/7"), "public body must not link ticket rows");
    assert.ok(pub.includes("Back to dashboard"), "public back link goes to dashboard");
    // Admin variant unchanged.
    assert.ok(full.includes("Secret player issue"), "admin body must list backlog titles");
    assert.ok(full.includes("Back to tickets"), "admin back link goes to tickets");
  });

  it("backlog rows link the scrambled token URL when known", () => {
    const docs = [
      ticket({ ticketNumber: 7, status: "open", title: "Token row", createdAt: "2026-09-01T00:00:00Z", closedAt: null, updatedAt: "2026-09-01T00:00:00Z" }),
      ticket({ ticketNumber: 8, status: "open", title: "Numeric row", createdAt: "2026-09-01T00:00:00Z", closedAt: null, updatedAt: "2026-09-01T00:00:00Z" }),
    ];
    const r = computeTicketReport(docs, { now: NOW });
    const body = makeTicketReportBody(r, { showBacklog: true, backHref: "/tickets", tokens: { 7: "tok-seven" } }).body;
    assert.ok(body.includes('href="/t/tok-seven"'), "token row must link /t/<token>");
    assert.ok(body.includes('href="/tickets/8"'), "row without a token keeps the numeric staff link");
    assert.ok(!body.includes('href="/tickets/7"'), "row with a token must not link the numeric alias");
  });
});
