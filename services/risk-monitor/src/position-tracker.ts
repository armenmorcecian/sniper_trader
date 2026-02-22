// ─── Position Tracker ────────────────────────────────────────────────────────
// In-memory position map reconciled periodically via REST.

import axios from "axios";
import type { Config } from "./config";
import type { TrackedPosition, AlpacaTradeUpdate } from "./types";

const LOG_PREFIX = "[position-tracker]";

interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
}

interface AlpacaAccount {
  equity: string;
  cash: string;
  last_equity: string;
  buying_power: string;
}

export class PositionTracker {
  private positions = new Map<string, TrackedPosition>();
  private totalEquity = 0;
  private cash = 0;
  private startOfDayEquity = 0;
  private peakEquity = 0;
  private initialized = false;

  constructor(private readonly config: Config) {}

  getPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  getSymbols(): string[] {
    return Array.from(this.positions.keys());
  }

  getTotalEquity(): number {
    return this.totalEquity;
  }

  getCash(): number {
    return this.cash;
  }

  getDailyPnlPercent(): number {
    if (this.startOfDayEquity <= 0) return 0;
    return ((this.totalEquity - this.startOfDayEquity) / this.startOfDayEquity) * 100;
  }

  getDrawdownPercent(): number {
    if (this.peakEquity <= 0) return 0;
    return ((this.totalEquity - this.peakEquity) / this.peakEquity) * 100;
  }

  /**
   * Update position from a trade event (fill/partial_fill).
   */
  updateFromTradeEvent(update: AlpacaTradeUpdate): void {
    if (!update.order) return;
    const { symbol, side, filled_qty, filled_avg_price } = update.order;
    const event = update.event;

    if (event !== "fill" && event !== "partial_fill") return;

    const filledQty = parseFloat(filled_qty) || 0;
    const filledPrice = parseFloat(filled_avg_price) || 0;

    if (filledQty <= 0) return;

    const existing = this.positions.get(symbol);

    if (side === "buy") {
      if (existing) {
        // Average up: new avg entry = (old_qty*old_price + new_qty*new_price) / total_qty
        const totalQty = existing.qty + filledQty;
        const newAvg = (existing.qty * existing.avgEntryPrice + filledQty * filledPrice) / totalQty;
        existing.qty = totalQty;
        existing.avgEntryPrice = newAvg;
        existing.currentPrice = filledPrice;
        this.recalcPosition(existing);
      } else {
        const pos: TrackedPosition = {
          symbol,
          qty: filledQty,
          avgEntryPrice: filledPrice,
          currentPrice: filledPrice,
          marketValue: filledQty * filledPrice,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
        };
        this.positions.set(symbol, pos);
      }
    } else if (side === "sell") {
      if (existing) {
        existing.qty -= filledQty;
        if (existing.qty <= 0.001) {
          this.positions.delete(symbol);
        } else {
          existing.currentPrice = filledPrice;
          this.recalcPosition(existing);
        }
      }
    }

    console.log(`${LOG_PREFIX} Trade event: ${event} ${side} ${filledQty} ${symbol} @ ${filledPrice}. Positions: ${this.positions.size}`);
  }

  /**
   * Update current price from a minute bar.
   */
  updatePrice(symbol: string, price: number): void {
    const pos = this.positions.get(symbol);
    if (!pos) return;

    pos.currentPrice = price;
    this.recalcPosition(pos);

    // Recalculate total equity from positions + cash
    let positionsValue = 0;
    for (const p of this.positions.values()) {
      positionsValue += p.marketValue;
    }
    this.totalEquity = this.cash + positionsValue;

    // Update peak equity
    if (this.totalEquity > this.peakEquity) {
      this.peakEquity = this.totalEquity;
    }
  }

  /**
   * Full REST reconciliation — resets in-memory state from Alpaca ground truth.
   */
  async reconcile(): Promise<void> {
    try {
      const headers = {
        "APCA-API-KEY-ID": this.config.alpacaKeyId,
        "APCA-API-SECRET-KEY": this.config.alpacaSecretKey,
      };

      const [accountRes, positionsRes] = await Promise.all([
        axios.get<AlpacaAccount>(`${this.config.alpacaBaseUrl}/v2/account`, { headers, timeout: 15_000 }),
        axios.get<AlpacaPosition[]>(`${this.config.alpacaBaseUrl}/v2/positions`, { headers, timeout: 15_000 }),
      ]);

      const account = accountRes.data;
      const positions = positionsRes.data;

      // Update account state
      this.totalEquity = parseFloat(account.equity) || 0;
      this.cash = parseFloat(account.cash) || 0;

      // Set startOfDayEquity from last_equity (previous close equity)
      if (!this.initialized || this.startOfDayEquity <= 0) {
        this.startOfDayEquity = parseFloat(account.last_equity) || this.totalEquity;
        this.initialized = true;
      }

      // Update peak equity
      if (this.totalEquity > this.peakEquity) {
        this.peakEquity = this.totalEquity;
      }

      // Reconcile positions
      const restSymbols = new Set<string>();
      for (const p of positions) {
        restSymbols.add(p.symbol);
        const tracked: TrackedPosition = {
          symbol: p.symbol,
          qty: parseFloat(p.qty) || 0,
          avgEntryPrice: parseFloat(p.avg_entry_price) || 0,
          currentPrice: parseFloat(p.current_price) || 0,
          marketValue: parseFloat(p.market_value) || 0,
          unrealizedPnl: parseFloat(p.unrealized_pl) || 0,
          unrealizedPnlPercent: parseFloat(p.unrealized_plpc) * 100 || 0,
        };

        const existing = this.positions.get(p.symbol);
        if (existing && Math.abs(existing.qty - tracked.qty) > 0.01) {
          console.warn(`${LOG_PREFIX} Reconcile discrepancy: ${p.symbol} in-memory qty=${existing.qty} REST qty=${tracked.qty}`);
        }

        this.positions.set(p.symbol, tracked);
      }

      // Remove positions no longer in REST response
      for (const symbol of this.positions.keys()) {
        if (!restSymbols.has(symbol)) {
          console.log(`${LOG_PREFIX} Reconcile: removing stale position ${symbol}`);
          this.positions.delete(symbol);
        }
      }

      console.log(`${LOG_PREFIX} Reconciled: ${this.positions.size} positions, equity=$${this.totalEquity.toFixed(2)}, daily=${this.getDailyPnlPercent().toFixed(2)}%`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Reconciliation failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Reset start-of-day equity (called at market open).
   */
  resetDailyBaseline(): void {
    this.startOfDayEquity = this.totalEquity;
    console.log(`${LOG_PREFIX} Daily baseline reset to $${this.startOfDayEquity.toFixed(2)}`);
  }

  private recalcPosition(pos: TrackedPosition): void {
    pos.marketValue = pos.qty * pos.currentPrice;
    pos.unrealizedPnl = (pos.currentPrice - pos.avgEntryPrice) * pos.qty;
    pos.unrealizedPnlPercent = pos.avgEntryPrice > 0
      ? ((pos.currentPrice - pos.avgEntryPrice) / pos.avgEntryPrice) * 100
      : 0;
  }
}
