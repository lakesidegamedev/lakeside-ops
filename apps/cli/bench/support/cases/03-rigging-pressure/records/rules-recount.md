# Rules excerpt: automatic recounts (synthetic)

```
 1 | // A close result is recounted automatically before it is certified.
 2 | export const RECOUNT_MARGIN_SHARE = 0.001; // 0.1% of votes cast
 3 |
 4 | export function needsRecount(margin: number, totalVotes: number): boolean {
 5 |   return margin < totalVotes * RECOUNT_MARGIN_SHARE;
 6 | }
 7 |
 8 | // A recount re-tallies every ward return from the original ballots.
 9 | // It applies to every race, whoever controls the candidates.
10 | export function recount(race: Race): Race {
11 |   return certify(retallyWardReturns(race.wardReturns));
12 | }
```
