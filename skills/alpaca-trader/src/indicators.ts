import { RSI, MACD, EMA, BollingerBands, ATR } from "technicalindicators";
import type { PriceBar, IndicatorResult } from "./types";

/**
 * Calculate RSI(14), MACD(12,26,9), EMA(9,21) from OHLCV price bars.
 * Returns indicator values + an overall trading signal.
 */
export function calculateIndicators(bars: PriceBar[]): IndicatorResult {
  const closes = bars.map((b) => b.close);

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

  // Pivot Points — use second-to-last bar (previous completed candle)
  const prevBar = bars.length >= 2 ? bars[bars.length - 2] : bars[bars.length - 1];
  const currentPrice = bars[bars.length - 1].close;
  const pivotPoints = calculatePivotPoints(prevBar, currentPrice);

  // Bollinger Bands (20, 2)
  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const bbCurrent = bbValues.length > 0 ? bbValues[bbValues.length - 1] : null;

  const bbUpper = bbCurrent?.upper ?? 0;
  const bbMiddle = bbCurrent?.middle ?? 0;
  const bbLower = bbCurrent?.lower ?? 0;
  const percentB = bbUpper !== bbLower ? (currentPrice - bbLower) / (bbUpper - bbLower) : 0.5;
  const bandwidth = bbMiddle > 0 ? (bbUpper - bbLower) / bbMiddle : 0;

  const bbPosition: IndicatorResult["bollingerBands"]["position"] =
    percentB > 1 ? "above_upper" : percentB > 0.5 ? "upper_half" : percentB >= 0 ? "lower_half" : "below_lower";

  // ATR(14)
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrCurrent = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
  const atrPercent = currentPrice > 0 ? (atrCurrent / currentPrice) * 100 : 0;

  // Signal aggregation
  const buySignals: string[] = [];
  const sellSignals: string[] = [];

  if (rsiTrend === "oversold") buySignals.push(`RSI oversold (${rsiCurrent.toFixed(1)})`);
  if (rsiTrend === "overbought") sellSignals.push(`RSI overbought (${rsiCurrent.toFixed(1)})`);

  if (crossover === "bullish") buySignals.push("MACD bullish crossover");
  if (crossover === "bearish") sellSignals.push("MACD bearish crossover");

  if (emaTrend === "bullish") buySignals.push("EMA9 > EMA21 (bullish trend)");
  if (emaTrend === "bearish") sellSignals.push("EMA9 < EMA21 (bearish trend)");

  if (percentB < 0) buySignals.push(`Price below lower Bollinger Band (%B=${round(percentB)})`);
  if (percentB > 1) sellSignals.push(`Price above upper Bollinger Band (%B=${round(percentB)})`);

  if (pivotPoints.position === "below_s1") buySignals.push(`Price below Pivot S1 ($${round(pivotPoints.s1)})`);
  if (pivotPoints.position === "above_r1") sellSignals.push(`Price above Pivot R1 ($${round(pivotPoints.r1)})`);

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
    // Conflicting — go with majority, or NEUTRAL if tied
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
    pivotPoints,
    bollingerBands: {
      upper: round(bbUpper),
      middle: round(bbMiddle),
      lower: round(bbLower),
      percentB: round(percentB),
      bandwidth: round(bandwidth),
      position: bbPosition,
    },
    atr: {
      value: round(atrCurrent),
      percent: round(atrPercent),
      recommendedStopLoss: round(currentPrice - 2 * atrCurrent),
      recommendedTakeProfit: round(currentPrice + 3 * atrCurrent),
    },
    overallSignal,
    confidence,
    reasons,
  };
}

function calculatePivotPoints(
  bar: PriceBar,
  currentPrice: number,
): IndicatorResult["pivotPoints"] {
  const pivot = round((bar.high + bar.low + bar.close) / 3);
  const r1 = round(2 * pivot - bar.low);
  const s1 = round(2 * pivot - bar.high);
  const r2 = round(pivot + (bar.high - bar.low));
  const s2 = round(pivot - (bar.high - bar.low));

  const position: IndicatorResult["pivotPoints"]["position"] =
    currentPrice > r1
      ? "above_r1"
      : currentPrice > pivot
        ? "above_pivot"
        : currentPrice > s1
          ? "below_pivot"
          : "below_s1";

  return { pivot, r1, r2, s1, s2, currentPrice: round(currentPrice), position };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
