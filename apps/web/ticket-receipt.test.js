"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getResolution,
  isTerminalStatus,
  nextResolutionVersion,
  normalizeResolution,
  publicTimeline,
  resolutionSourceLabel,
} = require("./ticket-receipt");

test("normalizes a durable receipt with actions and follow-up", () => {
  const receipt = normalizeResolution(
    {
      message: "We restored the missing seat.",
      actions: [
        "Restored the Commons office.",
        {
          label: "Verified the profile",
          detail: "The seat now shows eight seats.",
        },
      ],
      followUp: "Refresh the profile and try again.",
      source: "agent",
    },
    { by: "agent-1", now: new Date("2026-09-19T10:00:00Z") },
  );

  assert.equal(receipt.receiptVersion, 1);
  assert.equal(receipt.actions.length, 2);
  assert.equal(receipt.actions[1].detail, "The seat now shows eight seats.");
  assert.equal(receipt.source, "agent");
  assert.equal(receipt.closedBy, "agent-1");
  assert.equal(receipt.delivery.status, "pending");
});

test("terminal status is distinct from tracker progress", () => {
  assert.equal(isTerminalStatus("resolved"), true);
  assert.equal(isTerminalStatus("closed"), true);
  assert.equal(isTerminalStatus("in_progress"), false);
  assert.equal(
    resolutionSourceLabel("discord"),
    "Closed from a Discord request",
  );
});

test("a corrected receipt clears old channel delivery but preserves channel closure", () => {
  const closedAt = new Date("2026-09-22T10:00:00Z");
  const prior = {
    receiptId: "receipt-old",
    message: "The old outcome.",
    channelDelivery: { status: "posted", postedAt: closedAt },
    channelClose: { status: "closed" },
    channelClosedAt: closedAt,
  };
  const proposed = {
    receiptId: "receipt-new",
    message: "The corrected outcome.",
    delivery: { status: "pending" },
  };

  const corrected = nextResolutionVersion(prior, proposed);

  assert.equal(corrected.message, "The corrected outcome.");
  assert.deepEqual(corrected.delivery, { status: "pending" });
  assert.equal(corrected.channelDelivery, undefined);
  assert.deepEqual(corrected.channelClose, { status: "closed" });
  assert.equal(corrected.channelClosedAt, closedAt);
  assert.equal(nextResolutionVersion(prior, prior), prior);
});

test("public timeline omits internal status notes and includes safe updates", () => {
  const ticket = {
    status: "resolved",
    createdAt: "2026-09-18T10:00:00Z",
    statusHistory: [
      {
        status: "open",
        at: "2026-09-18T10:00:00Z",
        by: "secret-user",
        note: "internal",
      },
      {
        status: "in_progress",
        at: "2026-09-18T11:00:00Z",
        by: "agent",
        note: "private diagnosis",
      },
      { status: "resolved", at: "2026-09-19T10:00:00Z", by: "agent" },
    ],
    publicUpdates: [
      {
        kind: "heal",
        at: "2026-09-18T12:00:00Z",
        message: "Game data corrected.",
      },
    ],
    resolution: {
      message: "Resolved.",
      source: "agent",
      actions: [],
      createdAt: "2026-09-19T10:00:00Z",
    },
  };
  const timeline = publicTimeline(ticket);
  assert.deepEqual(
    timeline.map((event) => event.label),
    ["Report received", "Work in progress", "Game data corrected", "Closed"],
  );
  assert.ok(
    timeline.every(
      (event) => !JSON.stringify(event).includes("private diagnosis"),
    ),
  );
  assert.equal(getResolution(ticket).message, "Resolved.");
});

test("public timeline hides superseded resolution updates", () => {
  const ticket = {
    status: "resolved",
    createdAt: "2026-09-18T10:00:00Z",
    publicUpdates: [
      {
        kind: "resolution",
        at: "2026-09-18T11:00:00Z",
        message: "The old resolution said private-sale listing was required.",
        supersededAt: "2026-09-19T10:00:00Z",
      },
      {
        kind: "resolution",
        at: "2026-09-19T10:00:00Z",
        message: "The corrected resolution uses a shareholder vote.",
      },
    ],
    resolution: {
      message: "The corrected resolution uses a shareholder vote.",
      source: "agent",
      actions: [],
      createdAt: "2026-09-19T10:00:00Z",
    },
  };

  const timeline = publicTimeline(ticket);
  assert.doesNotMatch(JSON.stringify(timeline), /private-sale listing/);
  assert.match(JSON.stringify(timeline), /shareholder vote/);
});

test("public timeline hides a context request made after the fix entered testing", () => {
  const timeline = publicTimeline({
    createdAt: new Date("2026-09-22T20:30:00Z"),
    publicUpdates: [
      { kind: "development", at: new Date("2026-09-22T21:14:22Z"), message: "Fix in testing" },
      { kind: "context", at: new Date("2026-09-22T21:14:25Z"), message: "Send a link" },
    ],
  });
  assert.deepEqual(timeline.map((entry) => entry.label), ["Report received", "Fix in testing"]);
});
