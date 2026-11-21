// The one display mapping for a ticket's state, and the ticket-number matcher
// kanban cards are linked with.
// Run: node --test ticket-status.test.js
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ticketStatusLabel, ticketState, isTicketClosed, ticketClosedAt, CLOSED_STATUSES, OPEN_STATUSES } = require("./ticket-status");
const { ticketNumbersFromText, ticketNumbersFromDetail, ticketRefsFromText, normalizeTicketInput } = require("./ticket-refs");

describe("ticket display status", () => {
  it("maps every stored status to Open or Closed", () => {
    const expected = {
      open: "Open", triaging: "Open", assessed: "Open", investigating: "Open", in_progress: "Open", fixing: "Open",
      awaiting_player: "Open", reopened: "Open", blocked: "Open", parked: "Open",
      resolved: "Closed", closed: "Closed", rejected: "Closed", wont_fix: "Closed", wontfix: "Closed", not_implementing: "Closed",
      completed: "Closed", done: "Closed", duplicate: "Closed", archived: "Closed", merged: "Closed, merged",
    };
    for (const status of [...CLOSED_STATUSES, ...OPEN_STATUSES]) assert.ok(status in expected, `${status} has an expected label`);
    for (const [status, label] of Object.entries(expected)) {
      assert.equal(ticketStatusLabel(status), label, status);
      assert.equal(ticketStatusLabel({ status }), label, `${status} as a record`);
      assert.equal(ticketState(status), label === "Open" ? "open" : "closed", status);
    }
  });

  it("never says resolved, and is case-insensitive", () => {
    assert.equal(ticketStatusLabel("Resolved"), "Closed");
    assert.equal(ticketStatusLabel(" RESOLVED "), "Closed");
    for (const s of [...CLOSED_STATUSES, ...OPEN_STATUSES]) assert.doesNotMatch(ticketStatusLabel(s), /resolved/i);
  });

  it("a merged ticket reads Closed, merged into N", () => {
    assert.equal(ticketStatusLabel({ status: "closed", mergedInto: 1745 }), "Closed, merged into 1745");
    assert.equal(ticketStatusLabel({ status: "open", mergedInto: 1745 }), "Closed, merged into 1745");
    assert.equal(isTicketClosed({ status: "open", mergedInto: 1745 }), true);
    assert.equal(ticketStatusLabel({ status: "open", mergedInto: null }), "Open");
  });

  it("unknown or empty stored values read Open, never Closed", () => {
    for (const s of ["", null, undefined, "something_new"]) assert.equal(ticketStatusLabel(s), "Open");
  });

  it("closed_at is when the ticket became closed", () => {
    const t = {
      status: "resolved",
      closedAt: "2026-11-18T09:00:00Z",
      statusHistory: [
        { status: "in_progress", at: "2026-11-17T22:00:00Z" },
        { status: "resolved", at: "2026-11-18T04:01:51Z" },
        { status: "resolved", at: "2026-11-18T04:05:24Z" },
      ],
    };
    assert.equal(ticketClosedAt(t).toISOString(), "2026-11-18T04:01:51.000Z");
    assert.equal(ticketClosedAt({ status: "closed", closedAt: "2026-11-10T00:00:00Z" }).toISOString(), "2026-11-10T00:00:00.000Z");
    assert.equal(ticketClosedAt({ status: "open", closedAt: "2026-11-10T00:00:00Z" }), null);
  });
});

describe("ticket matcher", () => {
  it("finds tickets in the established forms", () => {
    const cases = {
      "Tech tree R&D prices are unreachable at real R&D income (ticket 1852)": [1852],
      "Raised by Keir from ticket 1852.": [1852],
      "Ticket #1852: fix the cap": [1852],
      "Ticket 1852. Next step": [1852],
      "tickets 1852, 1853 and #1860": [1852, 1853, 1860],
      "tickets 1852 & 1853": [1852, 1853],
      "Ticket #77 and incident 4": [77, 4],
      "fix/ticket-1852": [1852],
      "support-ticket-1852": [1852],
      "ticket no. 1852": [1852],
      "ticket 1852, then PR 3": [1852],
    };
    for (const [text, want] of Object.entries(cases)) assert.deepEqual(ticketNumbersFromText(text), want, text);
    assert.deepEqual(ticketRefsFromText("incident 41").map((r) => r.kind), ["incident"]);
  });

  it("does not take a pull request, turn, year, version or count for a ticket", () => {
    const negatives = [
      "Fix #7025 so it merges", "PR #496 landed", "turn 412 economy", "Plan for 2026", "Ship v4.6.1", "ticket 1852.3",
      "see ticket 12px", "subticket 5", "2 tickets 5 bugs", "the ticket is 3 days old", "ticket on 17 Nov", "tickets 10-12",
      "lakesidegamedev/AHDGame#1852", "issue 1852", "#1852",
    ];
    for (const text of negatives) assert.deepEqual(ticketNumbersFromText(text), [], text);
    // A list keeps going only with numbers of the same length.
    assert.deepEqual(ticketNumbersFromText("ticket 1852 and 3 others"), [1852]);
  });

  it("keeps every ticket a card names, once each, in order", () => {
    assert.deepEqual(ticketNumbersFromText("ticket 1853 then ticket 1852, again ticket 1853"), [1853, 1852]);
    assert.deepEqual(ticketNumbersFromText("Title (ticket 1852)", "and ticket 1860"), [1852, 1860]);
  });

  it("links from a card's detail only in the intake forms", () => {
    assert.deepEqual(ticketNumbersFromDetail("Raised by Keir from ticket 1852. Similar to ticket 1700."), [1852]);
    assert.deepEqual(ticketNumbersFromDetail("Context (ticket 1852) and more"), [1852]);
    assert.deepEqual(ticketNumbersFromDetail("Ticket: 1852\nSee ticket 1700 for background"), [1852]);
    assert.deepEqual(ticketNumbersFromDetail("See ticket 1700 for background; PR #7025."), []);
  });

  it("normalizes explicit ticket input", () => {
    assert.deepEqual(normalizeTicketInput(1852), [1852]);
    assert.deepEqual(normalizeTicketInput("#1852"), [1852]);
    assert.deepEqual(normalizeTicketInput([1852, "1853", 1852]), [1852, 1853]);
    assert.deepEqual(normalizeTicketInput([]), []);
    assert.throws(() => normalizeTicketInput("abc"), /ticket must be a ticket number/);
    assert.throws(() => normalizeTicketInput(-3), /ticket must be a ticket number/);
  });
});
