# Rules excerpt: realized sale price (synthetic)

```
 1 | // Realized price for a product sold by a corporation this turn.
 2 | export function realizedPrice(quote: number, localDemandFactor: number): number {
 3 |   // Sales settle against last turn's local demand, not the live world quote.
 4 |   return Math.round(quote * localDemandFactor * 100) / 100;
 5 | }
 6 |
 7 | // Sales screen headline figure.
 8 | export function averageSalePrice(lines: { units: number; revenue: number }[]): number {
 9 |   const units = lines.reduce((s, l) => s + l.units, 0);
10 |   const revenue = lines.reduce((s, l) => s + l.revenue, 0);
11 |   return units ? Math.round((revenue / units) * 100) / 100 : 0; // all products together
12 | }
```
