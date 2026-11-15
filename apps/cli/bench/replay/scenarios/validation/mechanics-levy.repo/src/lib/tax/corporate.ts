// Corporate taxation at turn settlement. Every country taxes taxable profit at
// its corporate rate. Countries with an excess profits levy also charge the
// levy rate on the part of profit above the levy threshold. Both are taken in
// the corporation's home currency in the same turn.
import type { Country, Corporation } from "./types";

export function corporateTax(country: Country, profit: number) {
  if (profit <= 0) return { corporateTax: 0, excessProfitsLevy: 0, total: 0 };
  const corporateTax = profit * country.fiscal.corporateTaxRate;
  const levy = country.fiscal.excessProfitsLevy;
  const excessProfitsLevy = levy ? Math.max(0, profit - levy.threshold) * levy.rate : 0;
  return { corporateTax, excessProfitsLevy, total: corporateTax + excessProfitsLevy };
}
