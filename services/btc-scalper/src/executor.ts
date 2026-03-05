// ─── Executor ────────────────────────────────────────────────────────────────
// Buy + sell execution with journal recording, rate limits, dedup, cooldown.

import {
  recordTrade,
  updateTradeExit,
  recordEquitySnapshot,
  logPrediction,
} from "quant-core";
import type { Config } from "./config";
import type { ExitSignal, IPolymarketService, OpenPosition, ScalpSignal } from "./types";
import type { CandleTracker } from "./candle-tracker";
import type { Alerter } from "./alerter";
import type { HealthPinger } from "./health";

const LOG_PREFIX = "[executor]";


export class Executor {
  private openPositions: OpenPosition[] = [];
  private betConditionIds = new Set<string>();
  private betsThisHour: number[] = []; // timestamps
  private lastLossTime = 0;
  private sellInProgress = new Set<string>();
  private circuitBreakerTripped = false;
  private circuitBreakerTrippedAt = 0;
  private cachedTotalEquity = 0;
  private cachedBalance = 0;
  private cacheTs = 0;

  /** Callback fired after a successful sell — used for immediate re-evaluation */
  onExit: ((conditionId: string, exitRule: string) => void) | null = null;

  constructor(
    private readonly config: Config,
    private readonly service: IPolymarketService,
    private readonly alerter: Alerter,
    private readonly health: HealthPinger,
  ) {}

  getOpenPositions(): OpenPosition[] {
    return [...this.openPositions];
  }

  isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  resetCircuitBreaker(): void {
    this.circuitBreakerTripped = false;
    this.circuitBreakerTrippedAt = 0;
    console.log(`${LOG_PREFIX} Circuit breaker flag RESET`);
  }

  getCircuitBreakerAge(): number {
    return this.circuitBreakerTrippedAt > 0 ? Date.now() - this.circuitBreakerTrippedAt : 0;
  }

  getBetConditionIds(): Set<string> {
    return this.betConditionIds;
  }

  /** Update cached equity from the exit loop's periodic getPortfolioValue() call */
  updateCachedEquity(totalEquity: number, usdcBalance: number): void {
    this.cachedTotalEquity = totalEquity;
    this.cachedBalance = usdcBalance;
    this.cacheTs = Date.now();
  }

  /** Execute a buy for a scalp signal. Returns trade ID or 0 on failure. */
  async executeBuy(signal: ScalpSignal, tracker: CandleTracker): Promise<number> {
    // Rate limit check
    const now = Date.now();
    this.betsThisHour = this.betsThisHour.filter((t) => now - t < 3_600_000);
    if (this.betsThisHour.length >= this.config.maxBetsPerHour) {
      console.log(`${LOG_PREFIX} Rate limit: ${this.betsThisHour.length}/${this.config.maxBetsPerHour} bets/hour`);
      return 0;
    }

    // Circuit breaker check — do not buy if CB has tripped
    if (this.circuitBreakerTripped) {
      console.log(`${LOG_PREFIX} Circuit breaker tripped — blocking buy`);
      return 0;
    }

    // Cooldown check
    if (now - this.lastLossTime < this.config.cooldownAfterLossMs) {
      const remaining = Math.ceil((this.config.cooldownAfterLossMs - (now - this.lastLossTime)) / 1000);
      console.log(`${LOG_PREFIX} Cooldown: ${remaining}s remaining after last loss`);
      return 0;
    }

    // Concurrent position limit
    if (this.openPositions.length >= this.config.maxConcurrentBets) {
      console.log(`${LOG_PREFIX} Max concurrent bets: ${this.openPositions.length}/${this.config.maxConcurrentBets}`);
      return 0;
    }

    // Dedup — optimistic lock: add BEFORE async buy to prevent concurrent duplicates
    if (this.betConditionIds.has(signal.conditionId)) {
      return 0;
    }
    this.betConditionIds.add(signal.conditionId);

    // Per-asset max bet
    const assetMaxBet = this.config.assetConfigs.get(signal.asset)?.maxBet ?? this.config.defaultMaxBet;

    try {
      // Cash reserve check (lightweight: 1 REST call instead of 4)
      const usdcBalance = await this.service.getUsdcBalance();
      const totalEquity = this.cachedTotalEquity > 0 ? this.cachedTotalEquity : usdcBalance;
      const amount = Math.min(assetMaxBet, usdcBalance * 0.5);
      if (amount <= 0.10) {
        console.log(`${LOG_PREFIX} Insufficient balance: $${usdcBalance.toFixed(2)}`);
        this.betConditionIds.delete(signal.conditionId); // rollback optimistic lock
        return 0;
      }

      const balanceAfterTrade = usdcBalance - amount;
      const reserveRatio = totalEquity > 0 ? balanceAfterTrade / totalEquity : 0;
      if (reserveRatio < this.config.cashReservePct / 100) {
        console.log(`${LOG_PREFIX} Cash reserve would drop to ${(reserveRatio * 100).toFixed(1)}%`);
        this.betConditionIds.delete(signal.conditionId); // rollback optimistic lock
        return 0;
      }

      console.log(
        `${LOG_PREFIX} BUY: ${signal.asset} ${signal.side} on ${signal.market.timeframe} ${signal.direction} ` +
        `@ $${signal.marketPrice.toFixed(3)} — $${amount.toFixed(2)} — edge=${signal.edge.toFixed(3)}`,
      );

      const result = this.config.useLimitOrders
        ? await this.executeLimitWithFallback(signal, amount)
        : await this.service.marketBuy({
            marketConditionId: signal.conditionId,
            outcome: signal.side,
            side: "BUY",
            amount,
            skipBalanceChecks: true,
          });

      // Validate order was actually placed (proxy errors return empty orderId)
      if (!result.orderId) {
        console.warn(`${LOG_PREFIX} Order not placed (empty orderId), skipping position tracking`);
        this.betConditionIds.delete(signal.conditionId); // rollback optimistic lock
        return 0;
      }

      // Verify order actually filled — totalCost=0 means no fill (phantom position)
      if (result.totalCost <= 0) {
        console.warn(`${LOG_PREFIX} Order not filled (totalCost=${result.totalCost}) — not tracking position`);
        this.betConditionIds.delete(signal.conditionId); // rollback optimistic lock
        return 0;
      }

      // Record in journal
      let tradeId = 0;
      try {
        tradeId = recordTrade({
          skill: "polymarket",
          tool: "crypto-scalper:buy",
          symbol: signal.conditionId,
          conditionId: signal.conditionId,
          side: "BUY",
          amount: result.totalCost,
          price: signal.marketPrice,
          status: "filled",
          outcome: signal.side,
          metadata: {
            source: "crypto-scalper",
            asset: signal.asset,
            edge: signal.edge,
            impliedProb: signal.impliedProb,
            timeframe: signal.market.timeframe,
            direction: signal.direction,
            returnFromOpen: signal.returnFromOpen,
            flowRatio: signal.flowRatio,
            elapsed: signal.elapsed,
          },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to record trade (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Log prediction for calibration tracking
      try {
        logPrediction(signal.conditionId, signal.impliedProb, "crypto-scalper");
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to log prediction (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Track position
      const metrics = tracker.getMetrics(signal.conditionId);
      this.openPositions.push({
        conditionId: signal.conditionId,
        market: signal.market,
        asset: signal.asset,
        side: signal.side,
        entryPrice: signal.marketPrice,
        entryTime: Date.now(),
        entryAssetPrice: metrics?.currentPrice ?? 0,
        entryReturnFromOpen: signal.returnFromOpen,
        amount: result.totalCost,
        tradeId,
        peakPnlPct: 0,
        failedSellAttempts: 0,
      });
      this.betConditionIds.add(signal.conditionId);
      this.betsThisHour.push(Date.now());
      this.health.incrementBets();

      // Telegram alert
      await this.alerter.sendAlert(
        "BUY",
        "info",
        `*BUY* ${signal.asset} ${signal.market.timeframe} ${signal.direction} @ $${signal.marketPrice.toFixed(3)}\n` +
        `Amount: $${result.totalCost.toFixed(2)} | Edge: ${(signal.edge * 100).toFixed(1)}%\n` +
        `${signal.asset}: $${tracker.price.toFixed(0)}`,
        signal.conditionId.slice(0, 12),
      );

      console.log(`${LOG_PREFIX} Buy executed: orderId=${result.orderId}, price=${result.price}`);
      return tradeId;
    } catch (err) {
      console.error(`${LOG_PREFIX} Buy execution failed:`, err instanceof Error ? err.message : String(err));
      this.betConditionIds.delete(signal.conditionId); // rollback optimistic lock
      return 0;
    }
  }

  /**
   * Place a GTC limit order at market price, poll for fill, fall back to market order on timeout.
   * Avoids slippage while guaranteeing execution within the timeout window.
   */
  private async executeLimitWithFallback(
    signal: ScalpSignal,
    amount: number,
  ): Promise<{ orderId: string; price: number; size: number; totalCost: number }> {
    const deadline = Date.now() + this.config.limitOrderTimeoutMs;
    const pollMs = this.config.limitOrderPollMs;

    // 1. Place GTC limit order at current market price
    console.log(`${LOG_PREFIX} Placing limit order: ${signal.asset} ${signal.side} @ $${signal.marketPrice.toFixed(3)} — $${amount.toFixed(2)}`);
    const limitResult = await this.service.createLimitOrder({
      marketConditionId: signal.conditionId,
      outcome: signal.side,
      side: "BUY",
      amount,
      limitPrice: signal.marketPrice,
      skipBalanceChecks: true,
    });

    if (!limitResult.orderId) {
      console.warn(`${LOG_PREFIX} Limit order returned empty orderId — falling back to market`);
      return this.service.marketBuy({
        marketConditionId: signal.conditionId,
        outcome: signal.side,
        side: "BUY",
        amount,
        skipBalanceChecks: true,
      });
    }

    // 2. Poll for fill
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const status = await this.service.getOrderStatus(limitResult.orderId);
        const s = status.status.toUpperCase();
        if (s === "MATCHED" || s === "FILLED") {
          console.log(`${LOG_PREFIX} Limit order filled: ${limitResult.orderId}`);
          return limitResult;
        }
        if (s === "CANCELLED" || s === "EXPIRED") {
          console.log(`${LOG_PREFIX} Limit order ${s} — falling back to market`);
          break;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Order status poll failed:`, err instanceof Error ? err.message : String(err));
      }
    }

    // 3. Timeout → cancel + market fallback
    console.log(`${LOG_PREFIX} Limit order timeout — cancelling and falling back to market`);
    try {
      await this.service.cancelOrder(limitResult.orderId);
    } catch {
      // Cancel failed → order may have filled during race
      try {
        const finalStatus = await this.service.getOrderStatus(limitResult.orderId);
        const s = finalStatus.status.toUpperCase();
        if (s === "MATCHED" || s === "FILLED") {
          console.log(`${LOG_PREFIX} Limit order filled during cancel race — using limit fill`);
          return limitResult;
        }
      } catch {
        // Status check also failed — proceed with market fallback
      }
    }

    // 4. Fall back to market order (guaranteed fill)
    return this.service.marketBuy({
      marketConditionId: signal.conditionId,
      outcome: signal.side,
      side: "BUY",
      amount,
      skipBalanceChecks: true,
    });
  }

  /** Execute a sell for an exit signal. Returns true on success. */
  async executeSell(exitSignal: ExitSignal): Promise<boolean> {
    // Prevent double-sell from overlapping exit loops
    if (this.sellInProgress.has(exitSignal.conditionId)) return false;

    const posIdx = this.openPositions.findIndex((p) => p.conditionId === exitSignal.conditionId);
    if (posIdx === -1) {
      console.warn(`${LOG_PREFIX} No open position for ${exitSignal.conditionId}`);
      return false;
    }

    const pos = this.openPositions[posIdx];
    this.sellInProgress.add(exitSignal.conditionId);

    try {
      console.log(`${LOG_PREFIX} SELL (${exitSignal.rule}): ${pos.asset} ${pos.market.timeframe} ${pos.side} — ${exitSignal.reason}`);

      const result = await this.service.sellPosition(pos.conditionId, pos.side);

      // Compute P&L using exit-engine's live price (result.price is 0 for market orders)
      // Guard against zero/negative exit price (stale data, resolved market)
      let exitPrice = exitSignal.currentPrice;
      if (exitPrice <= 0) {
        console.warn(`${LOG_PREFIX} Exit price is ${exitPrice} — falling back to entry price (P&L=0)`);
        exitPrice = pos.entryPrice;
      }
      const pnl = (exitPrice - pos.entryPrice) * (pos.amount / pos.entryPrice);
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

      // Set circuit breaker flag on CB exit
      if (exitSignal.rule === "circuit_breaker") {
        this.circuitBreakerTripped = true;
        this.circuitBreakerTrippedAt = Date.now();
        console.log(`${LOG_PREFIX} Circuit breaker flag SET — blocking further buys`);
      }

      // Update journal
      try {
        if (pos.tradeId) {
          updateTradeExit(pos.tradeId, exitPrice, pnl);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to update trade exit (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Record equity snapshot
      try {
        const vitals = await this.service.getPortfolioValue();
        recordEquitySnapshot({
          skill: "polymarket",
          equity: vitals.totalEquity,
          cash: vitals.usdcBalance,
          positionsValue: vitals.positionValue,
          metadata: { source: "crypto-scalper", asset: pos.asset, exitRule: exitSignal.rule },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to record equity snapshot (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Track cooldown on loss
      if (pnl < 0) {
        this.lastLossTime = Date.now();
      }

      // Remove from tracking
      this.openPositions.splice(posIdx, 1);
      // NOTE: Do NOT clear betConditionIds here — keep dedup until candle expires
      // to prevent re-entry on the same conditionId within the same candle.
      // clearExpiredDedup() handles cleanup when the candle is no longer active.

      // Trigger post-exit re-evaluation callback
      if (this.onExit) this.onExit(exitSignal.conditionId, exitSignal.rule);

      // Telegram
      const pnlSign = pnl >= 0 ? "+" : "-";
      const pnlStr = `${pnlSign}$${Math.abs(pnl).toFixed(2)}`;
      const pnlPctStr = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`;
      const severity = exitSignal.urgency === "high" ? "critical" : "info";
      await this.alerter.sendAlert(
        `EXIT:${exitSignal.rule}`,
        severity,
        `*SELL* ${pos.asset} ${pos.market.timeframe} ${pos.side} (${exitSignal.rule})\n` +
        `Entry: $${pos.entryPrice.toFixed(3)} → Exit: $${exitPrice.toFixed(3)}\n` +
        `P&L: ${pnlStr} (${pnlPctStr})`,
        pos.conditionId.slice(0, 12),
      );

      console.log(`${LOG_PREFIX} Sell executed: orderId=${result.orderId}, P&L=${pnlStr} (${pnlPct.toFixed(1)}%)`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Sell execution failed:`, msg);

      // If Polymarket says no position exists, clean up the phantom
      if (msg.includes("No open position found")) {
        console.warn(`${LOG_PREFIX} Phantom position detected — removing ${exitSignal.conditionId.slice(0, 12)}`);
        this.openPositions.splice(posIdx, 1);
        this.betConditionIds.delete(exitSignal.conditionId);
      } else {
        // Non-phantom sell failure: increment counter for retry on next exit tick
        const currentPos = this.openPositions[posIdx];
        if (currentPos) {
          currentPos.failedSellAttempts = (currentPos.failedSellAttempts || 0) + 1;
          console.warn(
            `${LOG_PREFIX} Sell attempt ${currentPos.failedSellAttempts}/3 failed for ${exitSignal.conditionId.slice(0, 12)} — will retry`,
          );
          if (currentPos.failedSellAttempts >= 3) {
            console.warn(
              `${LOG_PREFIX} 3 consecutive sell failures — force-removing ${currentPos.asset} ${currentPos.market.timeframe} ${currentPos.side} (will resolve on-chain)`,
            );
            this.openPositions.splice(posIdx, 1);
            // Don't clear betConditionIds — keep dedup to prevent re-entry on same candle
          }
        }
      }

      return false;
    } finally {
      this.sellInProgress.delete(exitSignal.conditionId);
    }
  }

  /**
   * Verify open positions actually exist on Polymarket.
   * Cleans up phantom positions where buy appeared to fill but tokens never settled.
   */
  async verifyPositions(): Promise<void> {
    if (this.openPositions.length === 0) return;

    try {
      const vitals = await this.service.getPortfolioValue();
      // getPortfolioValue doesn't give us per-position data, so we attempt
      // a lightweight sell-check: try to query each position's existence.
      // For now, we use a simpler heuristic: if total position value is 0
      // but we think we have positions, something is wrong.
      if (vitals.positionValue <= 0 && this.openPositions.length > 0) {
        console.warn(
          `${LOG_PREFIX} Position verification: portfolio shows $0 position value but we track ${this.openPositions.length} positions — cleaning phantoms`,
        );
        for (const pos of [...this.openPositions]) {
          console.warn(`${LOG_PREFIX} Removing phantom: ${pos.asset} ${pos.market.timeframe} ${pos.side} (${pos.conditionId.slice(0, 12)})`);
          this.betConditionIds.delete(pos.conditionId);
        }
        this.openPositions = [];
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Position verification failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  /** Clean up expired candle positions (candle resolved while we held — shouldn't happen with time-decay exit) */
  pruneExpired(): void {
    const now = Date.now();
    const expired = this.openPositions.filter(
      (p) => new Date(p.market.endDate).getTime() < now,
    );

    for (const pos of expired) {
      console.warn(`${LOG_PREFIX} Position expired without exit: ${pos.asset} ${pos.market.timeframe} ${pos.side}`);
      const idx = this.openPositions.indexOf(pos);
      if (idx !== -1) this.openPositions.splice(idx, 1);
    }
  }

  /** Clear dedup set for expired candles */
  clearExpiredDedup(activeConditionIds: Set<string>): void {
    for (const id of this.betConditionIds) {
      if (!activeConditionIds.has(id)) {
        this.betConditionIds.delete(id);
      }
    }
  }
}
