// Election-night totals shown on the race page while polling closes. Only
// precincts that reported before the turn ended are included, so the leader
// can change once the remaining precincts are counted at certification.
import type { Race, Count } from "./types";

export function provisionalCount(race: Race): Count {
  const reported = race.precincts.filter((p) => p.reportedAtClose);
  const votes: Record<string, number> = {};
  for (const p of reported) for (const [c, ballots] of Object.entries(p.ballots)) votes[c] = (votes[c] || 0) + ballots.length;
  return { stage: "provisional", votes, reportedShare: reported.length / race.precincts.length };
}
