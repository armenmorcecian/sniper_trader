// ─── Vol Tracker ─────────────────────────────────────────────────────────────
// Collects closed 1m klines from Binance and computes ATR(14) via quant-core.
// Provides dynamic volScale per timeframe based on real-time BTC volatility.

import axios from "axios";
import { atrMetrics } from "quant-core";
import type { PriceBar } from "quant-core/src/types";
import type { BinanceKline, Timeframe } from "./types";

const LOG_PREFIX = "[vol-tracker]";
const MAX_BARS = 30;
const MIN_BARS = 15; // ATR(14) needs 15 bars minimum

export class VolTracker {
  private bars: PriceBar[] = [];
  private _atrPercent: number | null = null;

  /** True when we have enough bars for ATR calculation */
  get isReady(): boolean {
    return this._atrPercent !== null;
  }

  /** Current ATR as a percentage of price, or null if not ready */
  get atrPercent(): number | null {
    return this._atrPercent;
  }

  get barCount(): number {
    return this.bars.length;
  }

  /** Process a Binance kline event. Only acts on closed klines. */
  onKline(kline: BinanceKline): void {
    const k = kline.k;
    if (!k.x) return; // Only process closed klines

    const bar: PriceBar = {
      timestamp: new Date(k.t).toISOString(),
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      volume: Number(k.v),
      vwap: 0, // Not available from Binance klines
    };

    // Ring buffer: push and trim
    this.bars.push(bar);
    if (this.bars.length > MAX_BARS) {
      this.bars.shift();
    }

    // Recompute ATR
    if (this.bars.length >= MIN_BARS) {
      const result = atrMetrics(this.bars);
      if (result) {
        this._atrPercent = result.atrPercent;
        console.log(
          `${LOG_PREFIX} ATR updated: atr=${result.atrPercent.toFixed(3)}% bars=${this.bars.length}`,
        );
      }
    } else {
      console.log(`${LOG_PREFIX} warmup(${this.bars.length}/${MIN_BARS})`);
    }
  }

  /**
   * Dynamic vol scale for a given timeframe.
   * volScale = atrPercent * sqrt(tfMinutes) clamped to [0.05, 3.0].
   */
  getVolScale(tf: Timeframe): number | null {
    if (this._atrPercent === null) return null;

    const tfMinutes: Record<Timeframe, number> = {
      "5m": 5,
      "15m": 15,
      "1h": 60,
      "4h": 240,
    };

    const minutes = tfMinutes[tf] ?? 15;
    const raw = this._atrPercent * Math.sqrt(minutes);

    // Clamp to sane range
    return Math.max(0.05, Math.min(3.0, raw));
  }

  /**
   * Seed the bar buffer from Binance REST API to eliminate warmup delay.
   * Fetches the last 30 closed 1m klines. If the fetch fails, falls back
   * to normal WS warmup (non-fatal).
   */
  async seedFromRest(symbol: string): Promise<void> {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=1m&limit=${MAX_BARS}`;
      const resp = await axios.get<any[][]>(url, { timeout: 10_000 });

      // Binance kline response: [openTime, open, high, low, close, volume, closeTime, ...]
      const bars: PriceBar[] = resp.data.map((k) => ({
        timestamp: new Date(k[0] as number).toISOString(),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        vwap: 0,
      }));

      this.bars = bars;

      // Compute ATR immediately
      if (this.bars.length >= MIN_BARS) {
        const result = atrMetrics(this.bars);
        if (result) {
          this._atrPercent = result.atrPercent;
          console.log(
            `${LOG_PREFIX} Seeded from REST: atr=${result.atrPercent.toFixed(3)}% bars=${this.bars.length} (${symbol.toUpperCase()})`,
          );
          return;
        }
      }

      console.warn(`${LOG_PREFIX} Seed fetched ${bars.length} bars but ATR calc failed — falling back to WS warmup`);
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} REST seed failed for ${symbol.toUpperCase()} (non-fatal, will warmup via WS):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
