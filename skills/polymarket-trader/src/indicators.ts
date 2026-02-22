import { RSI, MACD, EMA } from "technicalindicators";
import type { PriceSnapshot, IndicatorResult } from "./types";

/**
 * Calculate RSI(14), MACD(12,26,9), EMA(9,21) from collected price snapshots.
 * Uses yesPrice or noPrice as the close price for indicator calculation.
 */
export function calculateIndicators(
  snapshots: PriceSnapshot[],
  outcome: "Yes" | "No",
): IndicatorResult {
  const closes = snapshots.map((s) =>
    outcome === "Yes" ? s.yesPrice : s.noPrice,
  );

  // RSI(14)
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const rsiCurrent = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;
  const rsiTrend: "oversold" | "overbought" | "neutral" =
    rsiCurrent < 30 ? "oversold" : rsiCurrent > 70 ? "overbought" : "neutral";

  // MACD(12, 26, 9)
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const macdCurrent = macdValues.length > 0 ? macdValues[macdValues.length - 1] : null;
  const macdPrev = macdValues.length > 1 ? macdValues[macdValues.length - 2] : null;

  const histogram = macdCurrent?.histogram ?? 0;
  const macdSignal = macdCurrent?.signal ?? 0;
  const macdLine = macdCurrent?.MACD ?? 0;

  // Crossover detection: histogram sign change
  let crossover: "bullish" | "bearish" | "none" = "none";
  if (macdCurrent && macdPrev) {
    const prevHist = macdPrev.histogram ?? 0;
    const currHist = macdCurrent.histogram ?? 0;
    if (prevHist <= 0 && currHist > 0) crossover = "bullish";
    else if (prevHist >= 0 && currHist < 0) crossover = "bearish";
  }

  // EMA(9) and EMA(21)
  const ema9Values = EMA.calculate({ values: closes, period: 9 });
  const ema21Values = EMA.calculate({ values: closes, period: 21 });
  const ema9 = ema9Values.length > 0 ? ema9Values[ema9Values.length - 1] : 0;
  const ema21 = ema21Values.length > 0 ? ema21Values[ema21Values.length - 1] : 0;

  const emaDiff = ema21 > 0 ? (ema9 - ema21) / ema21 : 0;
  const emaTrend: "bullish" | "bearish" | "flat" =
    emaDiff > 0.001 ? "bullish" : emaDiff < -0.001 ? "bearish" : "flat";

  // Signal aggregation
  const buySignals: string[] = [];
  const sellSignals: string[] = [];

  if (rsiTrend === "oversold") buySignals.push(`RSI oversold (${(rsiCurrent ?? 50).toFixed(1)})`);
  if (rsiTrend === "overbought") sellSignals.push(`RSI overbought (${(rsiCurrent ?? 50).toFixed(1)})`);

  if (crossover === "bullish") buySignals.push("MACD bullish crossover");
  if (crossover === "bearish") sellSignals.push("MACD bearish crossover");

  if (emaTrend === "bullish") buySignals.push("EMA9 > EMA21 (bullish trend)");
  if (emaTrend === "bearish") sellSignals.push("EMA9 < EMA21 (bearish trend)");

  // Determine overall signal
  let overallSignal: "BUY" | "SELL" | "NEUTRAL" = "NEUTRAL";
  let confidence: "strong" | "moderate" | "weak" = "weak";
  const reasons: string[] = [];

  if (buySignals.length > 0 && sellSignals.length === 0) {
    overallSignal = "BUY";
    reasons.push(...buySignals);
  } else if (sellSignals.length > 0 && buySignals.length === 0) {
    overallSignal = "SELL";
    reasons.push(...sellSignals);
  } else if (buySignals.length > 0 && sellSignals.length > 0) {
    if (buySignals.length > sellSignals.length) {
      overallSignal = "BUY";
      reasons.push(...buySignals);
      reasons.push(`(conflicting: ${sellSignals.join(", ")})`);
    } else if (sellSignals.length > buySignals.length) {
      overallSignal = "SELL";
      reasons.push(...sellSignals);
      reasons.push(`(conflicting: ${buySignals.join(", ")})`);
    } else {
      overallSignal = "NEUTRAL";
      reasons.push("Conflicting signals", ...buySignals, ...sellSignals);
    }
  } else {
    reasons.push("No clear signal from RSI, MACD, or EMA");
  }

  // Confidence: strong if 2+ signals agree, moderate if 1, weak if conflicting
  const agreeing = overallSignal === "BUY" ? buySignals.length : overallSignal === "SELL" ? sellSignals.length : 0;
  if (agreeing >= 2) confidence = "strong";
  else if (agreeing === 1) confidence = "moderate";
  else confidence = "weak";

  // Format MACD values for output (last 5)
  const macdOut = macdValues.slice(-5).map((v) => ({
    MACD: round(v.MACD ?? 0),
    signal: round(v.signal ?? 0),
    histogram: round(v.histogram ?? 0),
  }));

  return {
    rsi: {
      current: round(rsiCurrent),
      trend: rsiTrend,
      values: rsiValues.slice(-5).map(round),
    },
    macd: {
      histogram: round(histogram),
      signal: round(macdSignal),
      macd: round(macdLine),
      crossover,
      values: macdOut,
    },
    ema: {
      ema9: round(ema9),
      ema21: round(ema21),
      trend: emaTrend,
    },
    overallSignal,
    confidence,
    reasons,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
