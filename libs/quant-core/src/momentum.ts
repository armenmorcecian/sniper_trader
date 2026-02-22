import { ATR } from "technicalindicators";
import type { PriceBar, SectorMomentum } from "./types";
import { round } from "./math";

/** Multi-timeframe momentum. Needs 61+ bars; returns -Infinity scores if insufficient. */
export function compositeMomentum(
  bars: PriceBar[],
): { momentum5d: number; momentum20d: number; momentum60d: number; compositeScore: number } {
  const len = bars.length;
  const latest = len > 0 ? bars[len - 1].close : 0;

  const m5 = len >= 6 ? ((latest - bars[len - 6].close) / bars[len - 6].close) * 100 : -Infinity;
  const m20 = len >= 21 ? ((latest - bars[len - 21].close) / bars[len - 21].close) * 100 : -Infinity;
  const m60 = len >= 61 ? ((latest - bars[len - 61].close) / bars[len - 61].close) * 100 : -Infinity;

  const compositeScore =
    m5 === -Infinity || m20 === -Infinity || m60 === -Infinity
      ? (m20 !== -Infinity ? m20 : -Infinity)
      : 0.3 * m5 + 0.5 * m20 + 0.2 * m60;

  return { momentum5d: round(m5), momentum20d: round(m20), momentum60d: round(m60), compositeScore: round(compositeScore) };
}

/** ATR(14) absolute and as percentage of close. Returns null if <15 bars. */
export function atrMetrics(bars: PriceBar[]): { atr14: number; atrPercent: number } | null {
  if (bars.length < 15) return null;

  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);

  const atrValues = ATR.calculate({ high, low, close, period: 14 });
  if (atrValues.length === 0) return null;

  const atr14 = atrValues[atrValues.length - 1];
  const latestClose = close[close.length - 1];
  const atrPercent = (atr14 / latestClose) * 100;

  return { atr14: round(atr14), atrPercent: round(atrPercent) };
}

/** Inverse-volatility (risk parity) weights normalized to sum=1. */
export function riskParityWeights(sectors: SectorMomentum[]): Record<string, number> {
  if (sectors.length === 0) return {};

  const valid = sectors.filter((s) => s.atrPercent != null && s.atrPercent > 0);
  if (valid.length !== sectors.length) return {};

  const inverses = valid.map((s) => 1 / s.atrPercent!);
  const total = inverses.reduce((sum, v) => sum + v, 0);
  if (total === 0) return {};

  const weights: Record<string, number> = {};
  valid.forEach((s, i) => {
    weights[s.symbol] = round(inverses[i] / total);
  });
  return weights;
}
