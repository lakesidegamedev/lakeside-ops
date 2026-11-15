// Manual race edits by staff. Every edit is written to the race's
// manualChanges list, which the race record exposes.
import type { Race } from "../elections/types";

export function setWinner(race: Race, winner: string, staffId: string, reason: string) {
  race.manualChanges.push({ at: Date.now(), staffId, reason, from: race.winner, to: winner });
  race.winner = winner;
}
