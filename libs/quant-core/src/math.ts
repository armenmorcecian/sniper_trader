import type { PriceBar } from "./types";

/** Round to 4 decimal places. */
export function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Daily returns as percentages. Returns [] if <2 bars. */
export function calculateDailyReturns(bars: PriceBar[]): number[] {
  if (bars.length < 2) return [];
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push(((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100);
  }
  return returns;
}

/** Standard Pearson r. Returns 0 if degenerate. */
export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i];
    sumB2 += b[i] * b[i];
  }

  const denom = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  if (denom === 0) return 0;
  return (n * sumAB - sumA * sumB) / denom;
}
