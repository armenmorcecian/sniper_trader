// ─── Executor ────────────────────────────────────────────────────────────────
// Buy + sell execution with journal recording, rate limits, dedup, cooldown.

import {
  recordTrade,
  updateTradeExit,
  recordEquitySnapshot,
  logPrediction,
} from "quant-core";
import type { Config } from "./config";
import type { ExitSignal, IPolymarketService, OpenPosition, PendingOrder, ScalpSignal } from "./types";
import type { CandleTracker } from "./candle-tracker";
import type { TickCopulaTracker } from "./copula-tracker";
import type { Alerter } from "./alerter";
import type { HealthPinger } from "./health";

const LOG_PREFIX = "[executor]";


export class Executor {
  private openPositions: OpenPosition[] = [];
  private betConditionIds = new Set<string>();
  private activeAssetTimeframes = new Set<string>();
  private betsThisHour: number[] = []; // timestamps
  private lastLossTime = 0;
  private sellInProgress = new Set<string>();
  private pendingBuyOrders = new Map<string, PendingOrder>();
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

  /** Get snapshot of all pending buy orders (for toxicity checking) */
  getPendingOrders(): PendingOrder[] {
    return Array.from(this.pendingBuyOrders.values());
  }

  /** Request cancellation of a pending order by conditionId */
  requestCancelPending(conditionId: string): void {
    const pending = this.pendingBuyOrders.get(conditionId);
    if (pending) {
      pending.cancelled = true;
      console.log(`${LOG_PREFIX} Cancel requested for pending order: ${conditionId.slice(0, 12)}`);
    }
  }

  /** Get cached total equity (updated by signal loop via updateCachedEquity) */
  getCachedTotalEquity(): number {
    return this.cachedTotalEquity;
  }

  /** Execute a buy for a scalp signal. Returns trade ID or 0 on failure. */
  async executeBuy(signal: ScalpSignal, tracker: CandleTracker, copulaTracker?: TickCopulaTracker): Promise<number> {
    // Rate limit check
    const now = Date.now();
    this.betsThisHour = this.betsThisHour.filter((t) => now - t < 3_600_000);
    if (this.betsThisHour.length >= this.config.maxBetsPerHour) {
      console.log(`${LOG_PREFIX} Rate limit: ${this.betsThisHour.length}/${this.config.maxBetsPerHour} bets/hour`);
      return 0;
    }

    // Circuit breaker buy-blocking — DISABLED

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

    // Timing jitter to avoid pattern detection
    if (this.config.orderJitterMs > 0) {
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * this.config.orderJitterMs)));
    }

    // Dedup — optimistic lock: add BEFORE async buy to prevent concurrent duplicates
    if (this.betConditionIds.has(signal.conditionId)) {
      return 0;
    }

    // One trade per asset+timeframe — block duplicate candle markets for same combo
    const atKey = `${signal.asset}:${signal.market.timeframe}`;
    if (this.activeAssetTimeframes.has(atKey)) {
      console.log(`${LOG_PREFIX} Already have position for ${atKey} — skipping`);
      return 0;
    }

    this.betConditionIds.add(signal.conditionId);
    this.activeAssetTimeframes.add(atKey);

    // Per-asset max bet
    const assetMaxBet = this.config.assetConfigs.get(signal.asset)?.maxBet ?? this.config.defaultMaxBet;

    try {
      // Cash reserve check (lightweight: 1 REST call instead of 4)
      const usdcBalance = await this.service.getUsdcBalance();
      const totalEquity = this.cachedTotalEquity > 0 ? this.cachedTotalEquity : usdcBalance;
      let amount = Math.min(assetMaxBet, usdcBalance * 0.5);

      // Copula-based dynamic sizing: reduce size when tail dependence is high
      const sizeFactor = copulaTracker?.getSizeFactor() ?? 1.0;
      if (sizeFactor < 1.0) {
        console.log(`${LOG_PREFIX} Copula sizing: factor=${sizeFactor} tailDep=${copulaTracker!.tailDependence.toFixed(4)}`);
        amount *= sizeFactor;
      }

      // Polymarket CLOB requires minimum 5 shares per order
      const minAmount = 5 * signal.marketPrice;
      if (amount < minAmount) {
        console.log(`${LOG_PREFIX} Order too small: ${(amount / signal.marketPrice).toFixed(1)} shares < 5 min — need $${minAmount.toFixed(2)}, have $${amount.toFixed(2)}`);
        this.betConditionIds.delete(signal.conditionId);
        this.activeAssetTimeframes.delete(atKey);
        return 0;
      }

      const balanceAfterTrade = usdcBalance - amount;
      const reserveRatio = totalEquity > 0 ? balanceAfterTrade / totalEquity : 0;
      if (reserveRatio < this.config.cashReservePct / 100) {
        console.log(`${LOG_PREFIX} Cash reserve would drop to ${(reserveRatio * 100).toFixed(1)}%`);
        this.betConditionIds.delete(signal.conditionId);
        this.activeAssetTimeframes.delete(atKey);
        return 0;
      }

      console.log(
        `${LOG_PREFIX} BUY: ${signal.asset} ${signal.side} on ${signal.market.timeframe} ${signal.direction} ` +
        `@ $${signal.marketPrice.toFixed(3)} — $${amount.toFixed(2)} — edge=${signal.edge.toFixed(3)}`,
      );

      const result = this.config.useLimitOrders
        ? await this.executeLimitWithFallback(signal, amount, this.config.limitOrderStrict)
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
        this.betConditionIds.delete(signal.conditionId);
        this.activeAssetTimeframes.delete(atKey);
        return 0;
      }

      // Verify order actually filled — totalCost=0 means no fill (phantom position)
      if (result.totalCost <= 0) {
        console.warn(`${LOG_PREFIX} Order not filled (totalCost=${result.totalCost}) — not tracking position`);
        this.betConditionIds.delete(signal.conditionId);
        this.activeAssetTimeframes.delete(atKey);
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
          price: result.price > 0 ? result.price : signal.marketPrice,
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
        entryPrice: result.price > 0 ? result.price : signal.marketPrice,
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

      // GTC Take-Profit: immediately place limit sell at entry + X%
      if (this.config.useGtcTp) {
        const entryPrice = result.price > 0 ? result.price : signal.marketPrice;
        const rawTpPrice = entryPrice * (1 + this.config.gtcTpPct / 100);
        const tpPrice = Math.min(Math.round(rawTpPrice * 100) / 100, 0.99);
        const shares = result.totalCost / entryPrice;

        try {
          const tpResult = await this.service.createLimitOrder({
            marketConditionId: signal.conditionId,
            outcome: signal.side,
            side: "SELL",
            amount: shares,
            limitPrice: tpPrice,
          });

          if (tpResult.orderId) {
            const pos = this.openPositions[this.openPositions.length - 1];
            pos.tpOrderId = tpResult.orderId;
            pos.tpPrice = tpPrice;
            console.log(
              `${LOG_PREFIX} GTC TP placed: ${signal.asset} ${signal.market.timeframe} ${signal.side} ` +
              `sell @ $${tpPrice.toFixed(3)} (+${this.config.gtcTpPct}%) orderId=${tpResult.orderId}`,
            );
          } else {
            console.warn(`${LOG_PREFIX} GTC TP order returned empty orderId — dynamic exit will handle TP`);
          }
        } catch (err) {
          console.error(`${LOG_PREFIX} GTC TP placement failed (non-fatal):`, err instanceof Error ? err.message : String(err));
        }
      }

      // Telegram alert
      await this.alerter.sendAlert(
        "BUY",
        "info",
        `*BUY* ${signal.asset} ${signal.market.timeframe} ${signal.direction} @ $${(result.price > 0 ? result.price : signal.marketPrice).toFixed(3)}\n` +
        `Amount: $${result.totalCost.toFixed(2)} | Edge: ${(signal.edge * 100).toFixed(1)}%\n` +
        `${signal.asset}: $${tracker.price.toFixed(0)}`,
        signal.conditionId.slice(0, 12),
      );

      console.log(`${LOG_PREFIX} Buy executed: orderId=${result.orderId}, price=${result.price}`);
      return tradeId;
    } catch (err) {
      console.error(`${LOG_PREFIX} Buy execution failed:`, err instanceof Error ? err.message : String(err));
      this.betConditionIds.delete(signal.conditionId);
      this.activeAssetTimeframes.delete(atKey);
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
    strict = false,
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
      if (strict) {
        console.log(`${LOG_PREFIX} Limit order returned empty orderId — strict mode, skipping trade`);
        return { orderId: "", price: 0, size: 0, totalCost: 0 };
      }
      console.warn(`${LOG_PREFIX} Limit order returned empty orderId — falling back to market`);
      return this.service.marketBuy({
        marketConditionId: signal.conditionId,
        outcome: signal.side,
        side: "BUY",
        amount,
        skipBalanceChecks: true,
      });
    }

    // Register pending order for toxicity checking
    const pending: PendingOrder = {
      orderId: limitResult.orderId,
      conditionId: signal.conditionId,
      asset: signal.asset,
      side: signal.side,
      timeframe: signal.market.timeframe,
      placedAt: Date.now(),
      limitPrice: signal.marketPrice,
      amount,
      cancelled: false,
    };
    this.pendingBuyOrders.set(signal.conditionId, pending);

    // 2. Poll for fill
    while (Date.now() < deadline) {
      // Check for external cancellation (toxicity)
      const pendingOrder = this.pendingBuyOrders.get(signal.conditionId);
      if (pendingOrder?.cancelled) {
        console.log(`${LOG_PREFIX} Pending order cancelled by toxicity check — cancelling CLOB order`);
        try { await this.service.cancelOrder(limitResult.orderId); } catch { /* best effort */ }
        this.pendingBuyOrders.delete(signal.conditionId);
        return { orderId: "", price: 0, size: 0, totalCost: 0 };
      }

      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const status = await this.service.getOrderStatus(limitResult.orderId);
        const s = status.status.toUpperCase();
        if (s === "MATCHED" || s === "FILLED") {
          console.log(`${LOG_PREFIX} Limit order filled: ${limitResult.orderId}`);
          this.pendingBuyOrders.delete(signal.conditionId);
          return limitResult;
        }
        if (s === "CANCELLED" || s === "EXPIRED") {
          console.log(`${LOG_PREFIX} Limit order ${s} — falling back to market`);
          this.pendingBuyOrders.delete(signal.conditionId);
          break;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Order status poll failed:`, err instanceof Error ? err.message : String(err));
      }
    }

    // 3. Timeout → cancel + market fallback (unless strict)
    this.pendingBuyOrders.delete(signal.conditionId);
    console.log(`${LOG_PREFIX} Limit order timeout — cancelling${strict ? " (strict mode, no market fallback)" : " and falling back to market"}`);
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

    if (strict) {
      console.log(`${LOG_PREFIX} Strict limit mode — no fill, skipping trade`);
      return { orderId: "", price: 0, size: 0, totalCost: 0 };
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

  /**
   * Place a GTC limit SELL at currentPrice, poll for fill, fall back to market sell on timeout.
   */
  private async executeSellLimit(
    exitSignal: ExitSignal,
    pos: OpenPosition,
  ): Promise<{ orderId: string; price: number }> {
    const deadline = Date.now() + this.config.sellLimitTimeoutMs;
    const pollMs = this.config.sellLimitPollMs;

    // Shares held = amount (USD spent) / entry price
    const size = pos.amount / pos.entryPrice;
    const sellPrice = exitSignal.currentPrice;

    console.log(
      `${LOG_PREFIX} Placing limit SELL: ${pos.asset} ${pos.market.timeframe} ${pos.side} ` +
      `@ $${sellPrice.toFixed(3)} — ${size.toFixed(2)} shares`,
    );

    const limitResult = await this.service.createLimitOrder({
      marketConditionId: pos.conditionId,
      outcome: pos.side,
      side: "SELL",
      amount: size,
      limitPrice: sellPrice,
    });

    if (!limitResult.orderId) {
      console.warn(`${LOG_PREFIX} Limit SELL returned empty orderId — falling back to market sell`);
      return this.service.sellPosition(pos.conditionId, pos.side, size);
    }

    // Poll for fill
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const status = await this.service.getOrderStatus(limitResult.orderId);
        const s = status.status.toUpperCase();
        if (s === "MATCHED" || s === "FILLED") {
          console.log(`${LOG_PREFIX} Limit SELL filled: ${limitResult.orderId}`);
          return { orderId: limitResult.orderId, price: limitResult.price };
        }
        if (s === "CANCELLED" || s === "EXPIRED") {
          console.log(`${LOG_PREFIX} Limit SELL ${s} — falling back to market sell`);
          break;
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Sell order status poll failed:`, err instanceof Error ? err.message : String(err));
      }
    }

    // Timeout → cancel + market fallback
    console.log(`${LOG_PREFIX} Limit SELL timeout — cancelling and falling back to market sell`);
    try {
      await this.service.cancelOrder(limitResult.orderId);
    } catch {
      // Cancel failed → order may have filled during race
      try {
        const finalStatus = await this.service.getOrderStatus(limitResult.orderId);
        const s = finalStatus.status.toUpperCase();
        if (s === "MATCHED" || s === "FILLED") {
          console.log(`${LOG_PREFIX} Limit SELL filled during cancel race — using limit fill`);
          return { orderId: limitResult.orderId, price: limitResult.price };
        }
      } catch {
        // Status check also failed — proceed with market fallback
      }
    }

    return this.service.sellPosition(pos.conditionId, pos.side, size);
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
      // Cancel outstanding GTC TP before executing dynamic sell
      if (pos.tpOrderId) {
        try { await this.service.cancelOrder(pos.tpOrderId); } catch { /* best effort */ }
        pos.tpOrderId = undefined;
      }

      console.log(`${LOG_PREFIX} SELL (${exitSignal.rule}): ${pos.asset} ${pos.market.timeframe} ${pos.side} — ${exitSignal.reason}`);

      // Route: limit sells for non-urgent exits, market sells for time-decay / high urgency
      const useLimitSell = this.config.useLimitOrdersForExits && exitSignal.urgency !== "high";
      const knownSize = pos.amount / pos.entryPrice;
      const result = useLimitSell
        ? await this.executeSellLimit(exitSignal, pos)
        : await this.service.sellPosition(pos.conditionId, pos.side, knownSize);

      // Prefer actual fill price from sell result, fall back to exit-engine estimate
      let exitPrice = result.price > 0 ? result.price : exitSignal.currentPrice;
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

      // Record equity snapshot + refresh cached equity
      try {
        const vitals = await this.service.getPortfolioValue();
        this.updateCachedEquity(vitals.totalEquity, vitals.usdcBalance);
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
      this.activeAssetTimeframes.delete(`${pos.asset}:${pos.market.timeframe}`);
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
        const phantomPos = this.openPositions[posIdx];
        if (phantomPos) {
          // Record exit at $0 for phantom positions
          try {
            if (phantomPos.tradeId) {
              updateTradeExit(phantomPos.tradeId, 0, -phantomPos.amount);
            }
          } catch { /* non-fatal */ }
          this.activeAssetTimeframes.delete(`${phantomPos.asset}:${phantomPos.market.timeframe}`);
        }
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
            // Record exit at last known price
            try {
              if (currentPos.tradeId) {
                const lastPrice = exitSignal.currentPrice > 0 ? exitSignal.currentPrice : currentPos.entryPrice;
                const pnl = (lastPrice - currentPos.entryPrice) * (currentPos.amount / currentPos.entryPrice);
                updateTradeExit(currentPos.tradeId, lastPrice, pnl);
              }
            } catch { /* non-fatal */ }
            this.activeAssetTimeframes.delete(`${currentPos.asset}:${currentPos.market.timeframe}`);
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

  /** Poll GTC TP orders for fills. Called from exit interval in index.ts. */
  async pollGtcTpFills(): Promise<void> {
    for (const pos of this.openPositions) {
      if (!pos.tpOrderId) continue;

      try {
        const status = await this.service.getOrderStatus(pos.tpOrderId);
        const s = status.status.toUpperCase();

        if (s === "MATCHED" || s === "FILLED") {
          const exitPrice = pos.tpPrice ?? (status.price ?? pos.entryPrice);
          const pnl = (exitPrice - pos.entryPrice) * (pos.amount / pos.entryPrice);
          const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

          console.log(
            `${LOG_PREFIX} GTC TP FILLED: ${pos.asset} ${pos.market.timeframe} ${pos.side} ` +
            `@ $${exitPrice.toFixed(3)} (+${pnlPct.toFixed(1)}%)`,
          );

          // Journal
          try {
            if (pos.tradeId) updateTradeExit(pos.tradeId, exitPrice, pnl);
          } catch { /* non-fatal */ }

          // Equity snapshot
          try {
            const vitals = await this.service.getPortfolioValue();
            this.updateCachedEquity(vitals.totalEquity, vitals.usdcBalance);
            recordEquitySnapshot({
              skill: "polymarket",
              equity: vitals.totalEquity,
              cash: vitals.usdcBalance,
              positionsValue: vitals.positionValue,
              metadata: { source: "crypto-scalper", asset: pos.asset, exitRule: "gtc_tp" },
            });
          } catch { /* non-fatal */ }

          // Telegram alert
          await this.alerter.sendAlert(
            "EXIT:gtc_tp",
            "info",
            `*GTC TP FILLED* ${pos.asset} ${pos.market.timeframe} ${pos.side}\n` +
            `Entry: $${pos.entryPrice.toFixed(3)} -> Exit: $${exitPrice.toFixed(3)}\n` +
            `P&L: +$${pnl.toFixed(2)} (+${pnlPct.toFixed(1)}%)`,
            pos.conditionId.slice(0, 12),
          );

          // Remove position
          const idx = this.openPositions.indexOf(pos);
          if (idx !== -1) this.openPositions.splice(idx, 1);
          this.activeAssetTimeframes.delete(`${pos.asset}:${pos.market.timeframe}`);
          if (this.onExit) this.onExit(pos.conditionId, "gtc_tp");
          break; // Array mutated, restart on next tick
        }

        if (s === "CANCELLED" || s === "EXPIRED") {
          console.warn(
            `${LOG_PREFIX} GTC TP ${s} for ${pos.asset} ${pos.market.timeframe} — dynamic exit will handle`,
          );
          pos.tpOrderId = undefined;
          pos.tpPrice = undefined;
        }
      } catch {
        // Non-fatal: will retry next poll
      }
    }
  }

  /** Cancel outstanding GTC TP order for a position about to be force-sold */
  async cancelGtcTp(conditionId: string): Promise<void> {
    const pos = this.openPositions.find((p) => p.conditionId === conditionId);
    if (pos?.tpOrderId) {
      try {
        await this.service.cancelOrder(pos.tpOrderId);
        console.log(`${LOG_PREFIX} Cancelled GTC TP for ${pos.asset} ${pos.market.timeframe} ${pos.side}`);
      } catch { /* best effort */ }
      pos.tpOrderId = undefined;
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
      // Always update cached equity when we successfully fetch portfolio value
      this.updateCachedEquity(vitals.totalEquity, vitals.usdcBalance);
      // getPortfolioValue doesn't give us per-position data, so we attempt
      // a lightweight sell-check: try to query each position's existence.
      // For now, we use a simpler heuristic: if total position value is 0
      // but we think we have positions, something is wrong.
      if (vitals.positionValue <= 0 && this.openPositions.length > 0) {
        // Only clean positions that have had time to settle (past grace period)
        const now = Date.now();
        const maturePositions = this.openPositions.filter(p => {
          const graceMs = p.market.timeframe === "5m" ? this.config.minHoldMs5m : this.config.minHoldMs;
          return now - p.entryTime >= graceMs;
        });
        const youngPositions = this.openPositions.filter(p => {
          const graceMs = p.market.timeframe === "5m" ? this.config.minHoldMs5m : this.config.minHoldMs;
          return now - p.entryTime < graceMs;
        });

        if (maturePositions.length > 0) {
          console.warn(
            `${LOG_PREFIX} Position verification: portfolio shows $0 position value but we track ${this.openPositions.length} positions — cleaning ${maturePositions.length} mature phantom(s), keeping ${youngPositions.length} young`,
          );
          for (const pos of maturePositions) {
            console.warn(`${LOG_PREFIX} Removing phantom: ${pos.asset} ${pos.market.timeframe} ${pos.side} (${pos.conditionId.slice(0, 12)})`);
            // Record exit at $0 — phantom position (tokens never settled)
            try {
              if (pos.tradeId) {
                const pnl = -pos.amount;
                updateTradeExit(pos.tradeId, 0, pnl);
              }
            } catch { /* non-fatal */ }
            this.betConditionIds.delete(pos.conditionId);
            this.activeAssetTimeframes.delete(`${pos.asset}:${pos.market.timeframe}`);
          }
          this.openPositions = youngPositions;
        } else if (youngPositions.length > 0) {
          console.log(
            `${LOG_PREFIX} Position verification: $0 value but all ${youngPositions.length} position(s) still in grace period — waiting for settlement`,
          );
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Position verification failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Safety-net cleanup for expired candle positions.
   * The primary exit path is the force-exit in the market poll interval (index.ts),
   * which sells before pruning. This only fires if force-exit somehow missed a position.
   */
  pruneExpired(): void {
    const now = Date.now();
    const expired = this.openPositions.filter(
      (p) => new Date(p.market.endDate).getTime() < now,
    );

    for (const pos of expired) {
      console.warn(
        `${LOG_PREFIX} PHANTOM: position survived past candle expiry (force-exit missed): ` +
        `${pos.asset} ${pos.market.timeframe} ${pos.side} (${pos.conditionId.slice(0, 12)}) — removing from tracking`,
      );

      // Record exit at $0 with full loss (position expired unsold)
      try {
        if (pos.tradeId) {
          const pnl = -pos.amount;
          updateTradeExit(pos.tradeId, 0, pnl);
        }
      } catch { /* non-fatal */ }

      const idx = this.openPositions.indexOf(pos);
      if (idx !== -1) this.openPositions.splice(idx, 1);
      this.activeAssetTimeframes.delete(`${pos.asset}:${pos.market.timeframe}`);
      this.betConditionIds.delete(pos.conditionId);
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
