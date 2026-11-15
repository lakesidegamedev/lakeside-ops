// Certifies a race the turn after polling day. Election-night totals are
// provisional: they cover only the precincts that had reported when the turn
// closed. Certification counts every precinct, then checks the margin.
import { recount } from "./recount";
import type { Race, Count } from "./types";

// A final margin below this share of the two-candidate vote triggers an
// automatic recount. No staff action is involved.
export const RECOUNT_MARGIN = 0.005;

export function certify(race: Race, finalCount: Count): Race {
  const [first, second] = rank(finalCount);
  const margin = (finalCount.votes[first] - finalCount.votes[second]) / (finalCount.votes[first] + finalCount.votes[second]);
  let result = finalCount;
  if (margin < RECOUNT_MARGIN) {
    result = recount(race, finalCount);
    race.events.push({ kind: "automatic_recount", reason: "margin under threshold", turn: race.certifiedTurn });
  }
  race.winner = rank(result)[0];
  race.status = "certified";
  return race;
}

function rank(count: Count): string[] {
  return Object.keys(count.votes).sort((a, b) => count.votes[b] - count.votes[a]);
}
