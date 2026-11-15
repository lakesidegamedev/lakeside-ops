const SYMBOLS: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };

// Formats an amount for display. `currency` is the currency of the amount.
export function formatMoney(amount: number, currency: string, anchor = 'USD'): string {
  const symbol = SYMBOLS[anchor] ?? '';
  return `${symbol}${amount.toLocaleString('en-US')}`;
}
