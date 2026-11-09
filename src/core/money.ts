// Money is kept as integer nanodollars (1e-9 USD) so that sums of many tiny
// per-call costs compare exactly against the cap. Prices per token stay as
// floats in nanodollars, and every computed amount is rounded to an integer.

export type Nanos = number;

export const NANOS_PER_USD = 1_000_000_000;

export function usdToNanos(usd: number): Nanos {
  return Math.round(usd * NANOS_PER_USD);
}

export function nanosToUsd(n: Nanos): number {
  return n / NANOS_PER_USD;
}

export function formatUsd(n: Nanos): string {
  const usd = nanosToUsd(n);
  if (usd === 0) return "$0.00";
  // Small amounts keep two significant digits: $0.0043, $0.000052.
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(Math.max(4, 1 - Math.floor(Math.log10(Math.abs(usd)))))}`;
  return `$${usd.toFixed(2)}`;
}

// A model's price, in nanodollars per token (prompt, completion) and per request.
export interface Price {
  prompt: number;
  completion: number;
  request: number;
}

export function priceFromUsdPerToken(p: { prompt: number; completion: number; request?: number }): Price {
  return {
    prompt: p.prompt * NANOS_PER_USD,
    completion: p.completion * NANOS_PER_USD,
    request: (p.request ?? 0) * NANOS_PER_USD,
  };
}

export function costOf(price: Price, promptTokens: number, completionTokens: number): Nanos {
  return Math.round(price.request + price.prompt * promptTokens + price.completion * completionTokens);
}
