import { OrderBookDepth, PositionSummary } from "./types";

/** Minimal order book shape from CLOB client */
interface OrderBookSummary {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

/**
 * Analyzes order book depth and detects whale walls.
 * Whale threshold scales dynamically with market depth: max(5000, totalDepth * 0.25).
 * Returns depth totals and flags for large single orders.
 */
export function analyzeOrderBookDepth(
  orderBook: OrderBookSummary,
): OrderBookDepth {
  let bidDepthUsd = 0;
  let largestBidWall = 0;

  for (const bid of orderBook.bids) {
    const price = parseFloat(bid.price);
    const size = parseFloat(bid.size);
    const usdValue = price * size;
    bidDepthUsd += usdValue;
    if (usdValue > largestBidWall) largestBidWall = usdValue;
  }

  let askDepthUsd = 0;
  let largestAskWall = 0;

  for (const ask of orderBook.asks) {
    const price = parseFloat(ask.price);
    const size = parseFloat(ask.size);
    const usdValue = price * size;
    askDepthUsd += usdValue;
    if (usdValue > largestAskWall) largestAskWall = usdValue;
  }

  const totalDepth = bidDepthUsd + askDepthUsd;
  const whaleThreshold = Math.max(5000, totalDepth * 0.25);

  const whaleWallDetected =
    largestBidWall > whaleThreshold || largestAskWall > whaleThreshold;

  return {
    bidDepthUsd: Math.round(bidDepthUsd * 100) / 100,
    askDepthUsd: Math.round(askDepthUsd * 100) / 100,
    largestBidWall: Math.round(largestBidWall * 100) / 100,
    largestAskWall: Math.round(largestAskWall * 100) / 100,
    whaleThreshold: Math.round(whaleThreshold * 100) / 100,
    whaleWallDetected,
  };
}

/**
 * Determines if a market should be avoided based on order book depth.
 *
 * Rules:
 * - BUY side: avoid if largest ask wall > threshold (big seller against you)
 * - SELL side: avoid if largest bid wall > threshold
 * - Always avoid if total opposing depth < $500 (can't exit)
 */
export function shouldAvoidMarket(
  depth: OrderBookDepth,
  tradeSide: "BUY" | "SELL",
): { avoid: boolean; reason: string } {
  if (tradeSide === "BUY") {
    if (depth.largestAskWall > depth.whaleThreshold) {
      return {
        avoid: true,
        reason: `Whale ask wall detected: $${(depth.largestAskWall ?? 0).toFixed(0)} (threshold: $${depth.whaleThreshold})`,
      };
    }
    if (depth.askDepthUsd < 500) {
      return {
        avoid: true,
        reason: `Insufficient ask depth: $${(depth.askDepthUsd ?? 0).toFixed(0)} (need > $500 to exit)`,
      };
    }
  } else {
    if (depth.largestBidWall > depth.whaleThreshold) {
      return {
        avoid: true,
        reason: `Whale bid wall detected: $${(depth.largestBidWall ?? 0).toFixed(0)} (threshold: $${depth.whaleThreshold})`,
      };
    }
    if (depth.bidDepthUsd < 500) {
      return {
        avoid: true,
        reason: `Insufficient bid depth: $${(depth.bidDepthUsd ?? 0).toFixed(0)} (need > $500 to exit)`,
      };
    }
  }

  return { avoid: false, reason: "Market depth is acceptable" };
}

/**
 * Checks positions against a stop-loss threshold.
 * Returns positions that should be exited immediately.
 */
export function checkStopLoss(
  positions: PositionSummary[],
  stopLossPercent: number = -15,
): PositionSummary[] {
  return positions.filter((pos) => pos.pnlPercent <= stopLossPercent);
}
