// Automatic recount: re-tallies every precinct's ballots from the stored
// returns. Small differences from the final count are spoiled or duplicate
// ballots removed on the second pass. The recount result is binding.
import type { Race, Count } from "./types";

export function recount(race: Race, finalCount: Count): Count {
  const votes: Record<string, number> = {};
  for (const precinct of race.precincts) {
    for (const [candidate, ballots] of Object.entries(precinct.ballots)) {
      votes[candidate] = (votes[candidate] || 0) + ballots.filter((b) => b.valid).length;
    }
  }
  return { ...finalCount, stage: "recount", votes };
}
