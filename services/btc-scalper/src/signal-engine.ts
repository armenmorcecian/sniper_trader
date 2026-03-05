// ─── Signal Engine ───────────────────────────────────────────────────────────
// 3-layer signal: momentum + VWAP confirmation + order flow.
// Computes impliedProb vs Polymarket odds to detect edge.
// Markets have "Up"/"Down" outcomes. If asset is trending up → buy "Up" token.

import type { Config, AssetConfig } from "./config";
import type { CandleMarket, ScalpSignal, Timeframe } from "./types";
import type { CandleTracker, CandleMetrics } from "./candle-tracker";
import type { VolTracker } from "./vol-tracker";

const LOG_PREFIX = "[signal-engine]";
const DEBUG_SIGNALS = process.env.BTC_DEBUG_SIGNALS === "true";

/** Sigmoid function centered at 0 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Get vol scale for a given timeframe — uses dynamic ATR when available */
function getVolScale(assetConfig: AssetConfig, tf: Timeframe, volTracker?: VolTracker): number {
  if (volTracker?.isReady) {
    const dynamic = volTracker.getVolScale(tf);
    if (dynamic !== null && dynamic > 0) return dynamic;
  }
  // Fallback to per-asset config values
  switch (tf) {
    case "5m": return assetConfig.volScale5m;
    case "15m": return assetConfig.volScale15m;
    case "1h": return assetConfig.volScale1h;
    case "4h": return assetConfig.volScale4h;
    default: return assetConfig.volScale5m;
  }
}

export function evaluateSignals(
  markets: CandleMarket[],
  tracker: CandleTracker,
  config: Config,
  betConditionIds: Set<string>,
  assetConfig: AssetConfig,
  volTracker?: VolTracker,
  allAssetMarkets?: CandleMarket[],
): ScalpSignal[] {
  const signals: ScalpSignal[] = [];
  const tfMarkets = allAssetMarkets ?? markets;

  for (const market of markets) {
    // Skip markets we already have a position on
    if (betConditionIds.has(market.conditionId)) continue;

    const metrics = tracker.getMetrics(market.conditionId);
    if (!metrics) continue;

    const signal = evaluateMarket(market, metrics, config, assetConfig, volTracker, tfMarkets);
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
}

/** Check if a longer timeframe confirms the direction for short-TF signals */
function longerTimeframeConfirms(
  market: CandleMarket,
  side: "Up" | "Down",
  allMarkets: CandleMarket[],
): boolean {
  // 1h/4h don't need confirmation — they ARE the trend
  if (market.timeframe === "1h" || market.timeframe === "4h") return true;

  const longerTfs: Timeframe[] = market.timeframe === "5m" ? ["15m", "1h", "4h"] : ["1h", "4h"];

  for (const tf of longerTfs) {
    const longer = allMarkets.find(m => m.asset === market.asset && m.timeframe === tf);
    if (!longer) continue;
    // Check if longer timeframe's market price agrees with our direction
    const longerUpPrice = longer.outcomePrices[0];
    if (side === "Up" && longerUpPrice < 0.45) return false;  // Longer TF is bearish
    if (side === "Down" && longerUpPrice > 0.55) return false; // Longer TF is bullish
    return true; // Found a longer TF that confirms
  }

  return true; // No longer TF market found — allow trade (don't block on missing data)
}

function evaluateMarket(
  market: CandleMarket,
  metrics: CandleMetrics,
  config: Config,
  assetConfig: AssetConfig,
  volTracker?: VolTracker,
  allMarkets?: CandleMarket[],
): ScalpSignal | null {
  const { returnFromOpen, vwapDeviation, flowRatio, elapsed } = metrics;
  let reject = "";

  // ─── Timing Window ──────────────────────────────────────────────────────
  const maxElapsed = market.timeframe === "5m" ? config.maxElapsed5m : config.maxElapsed;
  if (elapsed < config.minElapsed || elapsed > maxElapsed) {
    reject = `timing(${(elapsed * 100).toFixed(0)}%,min=${(config.minElapsed * 100).toFixed(0)}%,max=${(maxElapsed * 100).toFixed(0)}%)`;
  }

  // ─── Layer 1: Momentum ──────────────────────────────────────────────────
  const absReturn = Math.abs(returnFromOpen);
  if (!reject && absReturn < assetConfig.minMomentumPct) {
    reject = `momentum(${absReturn.toFixed(3)}%<${assetConfig.minMomentumPct}%)`;
  }

  // ─── Doji Filter ────────────────────────────────────────────────────────
  if (!reject && absReturn < 0.02) {
    reject = `doji(${absReturn.toFixed(3)}%)`;
  }

  // Determine momentum direction
  const momentumUp = returnFromOpen > 0;

  // ─── Layer 2: VWAP Confirmation ─────────────────────────────────────────
  if (!reject) {
    const vwapConfirms = momentumUp
      ? vwapDeviation > assetConfig.minVwapDevPct
      : vwapDeviation < -assetConfig.minVwapDevPct;
    if (!vwapConfirms) {
      reject = `vwap(${vwapDeviation.toFixed(3)}%,need=${momentumUp ? ">" : "<"}${assetConfig.minVwapDevPct}%)`;
    }
  }

  // ─── Layer 3: Order Flow ────────────────────────────────────────────────
  if (!reject) {
    const flowConfirms = momentumUp
      ? flowRatio > assetConfig.minFlowRatio
      : flowRatio < -assetConfig.minFlowRatio;
    if (!flowConfirms) {
      reject = `flow(${flowRatio.toFixed(3)},need=${momentumUp ? ">" : "<"}${assetConfig.minFlowRatio})`;
    }
  }

  // ─── Edge Calculation ───────────────────────────────────────────────────
  const volScale = getVolScale(assetConfig, market.timeframe, volTracker);
  const probUp = sigmoid(returnFromOpen / volScale);
  const side: "Up" | "Down" = momentumUp ? "Up" : "Down";
  const direction: "up" | "down" = momentumUp ? "up" : "down";
  const marketPrice = side === "Up" ? market.outcomePrices[0] : market.outcomePrices[1];

  if (!reject && (marketPrice <= 0 || marketPrice >= 1)) {
    reject = `price-invalid(${marketPrice})`;
  }

  if (!reject && marketPrice > 0.85) {
    reject = `price-ceiling(${marketPrice.toFixed(3)}>0.85)`;
  }

  if (!reject && marketPrice > config.maxEntryPrice) {
    reject = `entry-price(${marketPrice.toFixed(3)}>${config.maxEntryPrice})`;
  }

  // Spread check (Up + Down should sum to ~1.0)
  const spread = Math.abs(1 - market.outcomePrices[0] - market.outcomePrices[1]);
  if (!reject && spread > config.maxSpread) {
    reject = `spread(${spread.toFixed(3)}>${config.maxSpread})`;
  }

  // Multi-timeframe confluence — don't fight the longer-term trend
  if (!reject && allMarkets && !longerTimeframeConfirms(market, side, allMarkets)) {
    reject = `mtf-confluence(${side})`;
  }

  // Our fair value for the side we're buying
  const fairValue = side === "Up" ? probUp : 1 - probUp;
  const edge = fairValue * (1 - config.polyFeeRate) - marketPrice;

  if (!reject && edge < assetConfig.minEdge) {
    reject = `edge(${edge.toFixed(3)}<${assetConfig.minEdge})`;
  }

  if (reject) {
    if (DEBUG_SIGNALS) {
      console.log(
        `${LOG_PREFIX} [reject] ${market.asset} ${market.timeframe} ${side} @$${marketPrice.toFixed(3)}: ${reject}`,
      );
    }
    return null;
  }

  console.log(
    `${LOG_PREFIX} SIGNAL: ${market.asset} ${market.timeframe} ${side} | ` +
    `ret=${returnFromOpen.toFixed(3)}% vwap=${vwapDeviation.toFixed(3)}% flow=${flowRatio.toFixed(3)} | ` +
    `fair=${fairValue.toFixed(3)} market=${marketPrice.toFixed(3)} edge=${edge.toFixed(3)} | ` +
    `elapsed=${(elapsed * 100).toFixed(0)}%`,
  );

  return {
    conditionId: market.conditionId,
    market,
    asset: market.asset,
    direction,
    side,
    marketPrice,
    impliedProb: fairValue,
    edge,
    returnFromOpen,
    vwapDeviation,
    flowRatio,
    elapsed,
    timestamp: Date.now(),
  };
}
