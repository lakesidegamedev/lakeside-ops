"use strict";
// Keir 10 W3 item 1: reads switched on for ticket tasks.
const test = require("node:test"), assert = require("node:assert/strict");
const { SUPPORT_READS, FINDING_READS, PLAYER_PRIVATE } = require("../lib/operator/broker");
const { SEEDS } = require("../lib/operator/readyreads");

test("ticket tasks read military, bonds, fiscal history and the lore wiki", () => {
  for (const t of ["military_roster", "trace_bonds", "country_fiscal_history"]) assert.ok(SUPPORT_READS.gamestate.includes(t), t);
  for (const t of ["lore_wiki_search", "lore_wiki_page", "lore_glossary", "lore_country", "lore_parties", "lore_organizations"]) assert.ok(SUPPORT_READS.lore.includes(t), t);
});

test("alt-ring tools stay out of automatic ticket reads (staff only)", () => {
  for (const t of ["alt_ring_audit", "alt_rank"]) { assert.ok(!SUPPORT_READS.gamestate.includes(t)); assert.ok(!FINDING_READS.gamestate.includes(t)); }
});

test("bond positions are reporter-scoped and closed to findings", () => {
  assert.ok(PLAYER_PRIVATE.has("trace_bonds"));
  assert.ok(!FINDING_READS.gamestate.includes("trace_bonds"));
  assert.ok(FINDING_READS.lore.includes("lore_glossary"));
});

test("ready reads has seed examples for the new tools", () => {
  for (const tool of ["military_roster", "trace_bonds", "country_fiscal_history", "lore_wiki_search", "lore_glossary"]) assert.ok(SEEDS.some(([, , t]) => t === tool), tool);
});
