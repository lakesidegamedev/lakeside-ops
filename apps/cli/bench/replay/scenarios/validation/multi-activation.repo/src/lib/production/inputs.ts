// Input availability for a sector, per turn. Steel needs coking coal in the
// same state. Coal comes from supply agreements and local stock; an agreement
// delivers from its first delivery turn, at most its tonnes per turn.
import type { Sector, Agreement } from "./types";

export function coalAvailable(sector: Sector, agreements: Agreement[], turn: number) {
  const delivered = agreements
    .filter((a) => a.status === "active" && a.commodity === "coking coal" && turn >= a.firstDeliveryTurn)
    .reduce((n, a) => n + a.tonnesPerTurn, 0);
  return delivered + (sector.stock["coking coal"] || 0);
}

// Output scales with the binding input: with half the coal, half the steel.
export function outputFor(sector: Sector, coal: number) {
  const share = Math.min(1, coal / sector.coalNeededPerTurn);
  return Math.floor(sector.capacity * share);
}
