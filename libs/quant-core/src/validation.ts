import type { PriceBar } from "./types";

/**
 * Filters out invalid price bars (NaN, zero close, zero volume).
 * Returns only valid bars. Logs warnings for filtered bars.
 */
export function validateBars(bars: PriceBar[], symbol?: string): PriceBar[] {
  const valid: PriceBar[] = [];
  let filtered = 0;

  for (const bar of bars) {
    if (
      !Number.isFinite(bar.close) || bar.close <= 0 ||
      !Number.isFinite(bar.open) || bar.open <= 0 ||
      !Number.isFinite(bar.high) || bar.high <= 0 ||
      !Number.isFinite(bar.low) || bar.low <= 0 ||
      !Number.isFinite(bar.volume) || bar.volume === 0
    ) {
      filtered++;
      continue;
    }
    valid.push(bar);
  }

  if (filtered > 0) {
    const sym = symbol ? ` for ${symbol}` : "";
    console.warn(`[validateBars] Filtered ${filtered} invalid bar(s)${sym} (NaN, zero close, or zero volume)`);
  }

  return valid;
}
