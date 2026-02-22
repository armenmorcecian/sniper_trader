import { SMA } from "technicalindicators";
import type { PriceBar, SectorMomentum } from "./types";
import { ETF_WATCHLIST } from "./constants";
import { round } from "./math";
import { compositeMomentum, atrMetrics } from "./momentum";

/**
 * Ranks sector ETFs by volatility-adjusted composite momentum.
 * Falls back gracefully: if bars are insufficient for multi-factor, uses 20d momentum.
 */
export function rankSectorMomentum(
  multiBars: Record<string, PriceBar[]>,
  sectorSymbols: string[],
): SectorMomentum[] {
  const momentums: SectorMomentum[] = sectorSymbols.map((symbol) => {
    const bars = multiBars[symbol] || [];

    if (bars.length < 21) {
      return {
        symbol,
        sector: ETF_WATCHLIST[symbol] || symbol,
        rank: 0,
        momentum20d: -Infinity,
        latestClose: bars.length > 0 ? bars[bars.length - 1].close : 0,
        close20dAgo: 0,
      };
    }

    const latestClose = bars[bars.length - 1].close;
    const close20dAgo = bars[bars.length - 21].close;
    const momentum20d = ((latestClose - close20dAgo) / close20dAgo) * 100;

    // Multi-factor momentum
    const cm = compositeMomentum(bars);

    // ATR metrics
    const atr = atrMetrics(bars);

    // SMA50
    let sma50: number | undefined;
    let aboveSMA50: boolean | undefined;
    if (bars.length >= 50) {
      const sma50Values = SMA.calculate({ values: bars.map((b) => b.close), period: 50 });
      if (sma50Values.length > 0) {
        sma50 = round(sma50Values[sma50Values.length - 1]);
        aboveSMA50 = latestClose > sma50;
      }
    }

    // Volatility-adjusted score
    const volatilityAdjustedScore =
      atr && atr.atrPercent > 0 && cm.compositeScore !== -Infinity
        ? round(cm.compositeScore / Math.sqrt(atr.atrPercent))
        : -Infinity;

    return {
      symbol,
      sector: ETF_WATCHLIST[symbol] || symbol,
      rank: 0,
      momentum20d: round(momentum20d),
      latestClose: round(latestClose),
      close20dAgo: round(close20dAgo),
      momentum5d: cm.momentum5d,
      momentum60d: cm.momentum60d,
      compositeScore: cm.compositeScore,
      atr14: atr?.atr14,
      atrPercent: atr?.atrPercent,
      volatilityAdjustedScore,
      sma50,
      aboveSMA50,
    };
  });

  // Sort by volatilityAdjustedScore (descending), fall back to compositeScore, then momentum20d
  momentums.sort((a, b) => {
    const va = a.volatilityAdjustedScore ?? -Infinity;
    const vb = b.volatilityAdjustedScore ?? -Infinity;
    if (va !== vb) return vb - va;

    const ca = a.compositeScore ?? -Infinity;
    const cb = b.compositeScore ?? -Infinity;
    if (ca !== cb) return cb - ca;

    return b.momentum20d - a.momentum20d;
  });

  // Assign ranks 1–N
  momentums.forEach((m, i) => {
    m.rank = i + 1;
  });

  return momentums;
}
