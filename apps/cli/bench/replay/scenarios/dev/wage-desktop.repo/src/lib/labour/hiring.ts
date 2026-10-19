// Each turn a sector hires toward its target headcount at its offered wage.
import type { Sector } from "../types";

export function hireForTurn(sector: Sector, regionalMinimum: number) {
  if (sector.offeredWage === null || sector.offeredWage < regionalMinimum) {
    // No valid wage on offer: nobody accepts work and existing staff leave.
    sector.workers = 0;
    return 0;
  }
  const hired = Math.min(sector.targetWorkers - sector.workers, Math.ceil(sector.targetWorkers * 0.25));
  sector.workers += Math.max(0, hired);
  return hired;
}
