import { SMA } from "technicalindicators";
import type { PriceBar, Regime, RegimeResult } from "./types";
import { round } from "./math";

/**
 * Determines bull/bear regime from SPY price bars.
 * Bull: SPY closes above its 200-day SMA. Bear: at or below.
 * Requires at least 200 bars to compute the SMA.
 *
 * If sectorBars is provided, also computes breadth (sectors above SMA50)
 * and a composite regime (bear if either SPY or breadth says bear).
 */
export function calculateRegime(
  spyBars: PriceBar[],
  sectorBars?: Record<string, PriceBar[]>,
): RegimeResult {
  if (spyBars.length < 200) {
    throw new Error(
      `Need 200+ SPY bars for SMA200, got ${spyBars.length}. Increase limit or daysBack.`,
    );
  }

  const closes = spyBars.map((b) => b.close);
  const smaValues = SMA.calculate({ values: closes, period: 200 });

  const sma200 = smaValues[smaValues.length - 1];
  const spyPrice = closes[closes.length - 1];
  const distancePercent = ((spyPrice - sma200) / sma200) * 100;
  const spyRegime: Regime = spyPrice > sma200 ? "bull" : "bear";

  const result: RegimeResult = {
    regime: spyRegime,
    spyPrice: round(spyPrice),
    sma200: round(sma200),
    distancePercent: round(distancePercent),
  };

  // Breadth regime from sector SMA50s
  if (sectorBars) {
    const sectorSMA50Status: Record<string, boolean> = {};
    let aboveCount = 0;

    for (const [symbol, bars] of Object.entries(sectorBars)) {
      if (bars.length < 50) {
        sectorSMA50Status[symbol] = false;
        continue;
      }
      const sectorCloses = bars.map((b) => b.close);
      const sma50Values = SMA.calculate({ values: sectorCloses, period: 50 });
      if (sma50Values.length === 0) {
        sectorSMA50Status[symbol] = false;
        continue;
      }
      const sma50 = sma50Values[sma50Values.length - 1];
      const above = sectorCloses[sectorCloses.length - 1] > sma50;
      sectorSMA50Status[symbol] = above;
      if (above) aboveCount++;
    }

    const breadthSignal: "bull" | "bear" | "neutral" =
      aboveCount >= 7 ? "bull" : aboveCount < 4 ? "bear" : "neutral";
    const compositeRegime: Regime =
      spyRegime === "bear" || breadthSignal === "bear" ? "bear" : "bull";

    result.breadthCount = aboveCount;
    result.breadthSignal = breadthSignal;
    result.compositeRegime = compositeRegime;
    result.sectorSMA50Status = sectorSMA50Status;
  }

  return result;
}
