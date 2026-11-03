"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { requested } = require("../lib/operator/suggestionintake");

test("everyday wording asks for a suggestion; praise and refusals do not (ticket 1756)", () => {
  for (const t of ["Send the suggestion", "keir make that a suggestion please", "file a suggestion for this"]) assert.equal(requested(t), true, t);
  for (const t of ["great suggestion", "do not send the suggestion", "don't file a suggestion"]) assert.equal(requested(t), false, t);
});
