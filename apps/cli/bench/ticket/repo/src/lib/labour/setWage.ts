// Applies a corporation's offered wage for one sector.
import { minimumWageFor } from "./minimumWage";
import type { Sector } from "../types";

export interface SetWageInput {
  sectorId: string;
  wage: number;
}

export function applyOfferedWage(sector: Sector, input: SetWageInput, regionCode: string) {
  const minimum = minimumWageFor(regionCode);
  // Reject anything that is not a finite number.
  if (typeof input.wage !== "number" || !Number.isFinite(input.wage)) {
    sector.offeredWage = null;
    return { ok: true, wage: null };
  }
  if (input.wage < minimum) return { ok: false, error: `Wage must be at least ${minimum}` };
  sector.offeredWage = Math.round(input.wage * 100) / 100;
  return { ok: true, wage: sector.offeredWage };
}
