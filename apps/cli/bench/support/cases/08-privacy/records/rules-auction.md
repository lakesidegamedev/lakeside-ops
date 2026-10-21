# Rules excerpt: sealed bid auctions (synthetic)

```
 1 | // Highest funded bid wins. Ties go to the earliest bid.
 2 | export function pickWinner(bids: Bid[]): Bid {
 3 |   return bids.filter(b => b.funded).sort((a, b) => b.amount - a.amount || a.turn - b.turn)[0];
 4 | }
 5 | // Bids are accepted until the auction closes at the end of its listed turn.
```
