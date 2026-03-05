// ─── Candle Tracker ─────────────────────────────────────────────────────────
// Real-time candle state machine. Tracks BTC price action per active Polymarket
// candle market: open price, VWAP, order flow, elapsed time.

import type { BinanceTrade, CandleMarket, CandleState } from "./types";
import { TIMEFRAME_SECONDS } from "./types";

const LOG_PREFIX = "[candle-tracker]";

export class CandleTracker {
  private candles = new Map<string, CandleState>();
  private currentPrice = 0;

  get price(): number { return this.currentPrice; }
  get activeCount(): number { return this.candles.size; }

  /** Register a new candle market to track */
  addMarket(market: CandleMarket): void {
    if (this.candles.has(market.conditionId)) return;

    const now = Date.now();
    const price = this.currentPrice || 0;

    this.candles.set(market.conditionId, {
      conditionId: market.conditionId,
      market,
      openPrice: price,
      currentPrice: price,
      highPrice: price,
      lowPrice: price,
      vwapNumerator: 0,
      vwapDenominator: 0,
      netBuyVolume: 0,
      totalVolume: 0,
      startTime: now,
      lastUpdateTime: now,
    });
  }

  /** Remove a candle market (expired or no longer active) */
  removeMarket(conditionId: string): void {
    this.candles.delete(conditionId);
  }

  /** Get all active candle condition IDs */
  getActiveConditionIds(): string[] {
    return Array.from(this.candles.keys());
  }

  /** Get candle state for a specific market */
  getCandle(conditionId: string): CandleState | undefined {
    return this.candles.get(conditionId);
  }

  /** Process a Binance trade — updates ALL active candles */
  onTrade(trade: BinanceTrade): void {
    const price = Number(trade.p);
    const qty = Number(trade.q);
    if (isNaN(price) || isNaN(qty) || price <= 0 || qty <= 0) return;

    this.currentPrice = price;
    const isBuy = !trade.m; // m=false means taker buy
    const now = Date.now();

    for (const candle of this.candles.values()) {
      // Set open price on first trade
      if (candle.openPrice === 0) {
        candle.openPrice = price;
        candle.highPrice = price;
        candle.lowPrice = price;
      }

      candle.currentPrice = price;
      candle.highPrice = Math.max(candle.highPrice, price);
      candle.lowPrice = Math.min(candle.lowPrice, price);

      // VWAP
      candle.vwapNumerator += price * qty;
      candle.vwapDenominator += qty;

      // Order flow
      if (isBuy) {
        candle.netBuyVolume += qty;
      } else {
        candle.netBuyVolume -= qty;
      }
      candle.totalVolume += qty;

      candle.lastUpdateTime = now;
    }
  }

  /** Compute derived metrics for a candle */
  getMetrics(conditionId: string): CandleMetrics | null {
    const candle = this.candles.get(conditionId);
    if (!candle || candle.openPrice === 0) return null;

    const returnFromOpen = ((candle.currentPrice - candle.openPrice) / candle.openPrice) * 100;

    const vwap = candle.vwapDenominator > 0
      ? candle.vwapNumerator / candle.vwapDenominator
      : candle.currentPrice;
    const vwapDeviation = ((candle.currentPrice - vwap) / vwap) * 100;

    const flowRatio = candle.totalVolume > 0
      ? candle.netBuyVolume / candle.totalVolume
      : 0;

    // Use market's actual start/end dates for elapsed if available, else fallback to tracker timing
    const candleStartMs = candle.market.startDate
      ? new Date(candle.market.startDate).getTime()
      : candle.startTime;
    const candleEndMs = candle.market.endDate
      ? new Date(candle.market.endDate).getTime()
      : candleStartMs + (TIMEFRAME_SECONDS[candle.market.timeframe] || 300) * 1000;
    const candleDurationMs = candleEndMs - candleStartMs;
    const elapsedMs = Date.now() - candleStartMs;
    const elapsed = candleDurationMs > 0 ? Math.min(Math.max(elapsedMs / candleDurationMs, 0), 1.0) : 0;

    return {
      returnFromOpen,
      vwapDeviation,
      flowRatio,
      elapsed,
      currentPrice: candle.currentPrice,
      openPrice: candle.openPrice,
      vwap,
    };
  }

  /** Prune expired candles */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [id, candle] of this.candles) {
      const endTime = new Date(candle.market.endDate).getTime();
      if (now > endTime) {
        this.candles.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  /** Update Polymarket prices on a candle market (from market discovery refresh) */
  updateMarketPrices(conditionId: string, outcomePrices: number[]): void {
    const candle = this.candles.get(conditionId);
    if (candle) {
      candle.market.outcomePrices = outcomePrices;
    }
  }
}

export interface CandleMetrics {
  returnFromOpen: number;   // % return from candle open
  vwapDeviation: number;    // % deviation from VWAP
  flowRatio: number;        // net buy flow / total volume (-1 to +1)
  elapsed: number;          // fraction of candle elapsed (0-1)
  currentPrice: number;     // BTC price
  openPrice: number;        // BTC open price
  vwap: number;             // VWAP price
}
