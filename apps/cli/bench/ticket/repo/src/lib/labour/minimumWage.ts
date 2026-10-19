const MINIMUMS: Record<string, number> = { "UK-NE": 13.1, "UK-LDN": 15.4, "US-MI": 14.2 };
export function minimumWageFor(regionCode: string) {
  return MINIMUMS[regionCode] ?? 12;
}
