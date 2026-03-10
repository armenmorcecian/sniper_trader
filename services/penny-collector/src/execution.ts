// ─── Penny Executor ─────────────────────────────────────────────────────────
// Market buy (FOK) near-expiry contracts, hold to resolution at $1.00.

import { recordTrade, updateTradeExit, recordEquitySnapshot, queryTrades } from "quant-core";
import type { PennyCandidate, PennyPosition, IPolymarketService } from "./types";
import type { PennyConfig } from "./config";
import type { ClobFeed } from "./clob-feed";

const LOG_PREFIX = "[penny-executor]";

export class PennyExecutor {
  private positions = new Map<string, PennyPosition>();
  private betConditionIds = new Set<string>();
  private betsThisHour: number[] = [];

  constructor(
    private readonly config: PennyConfig,
    private readonly service: IPolymarketService,
  ) {}

  /** Hydrate dedup set from existing portfolio positions to survive restarts */
  async init(): Promise<void> {
    try {
      const vitals = await this.service.getPortfolioValue();
      if (vitals.positions) {
        for (const pos of vitals.positions) {
          if (pos.size > 0) {
            this.betConditionIds.add(pos.conditionId);
          }
        }
        if (this.betConditionIds.size > 0) {
          console.log(`${LOG_PREFIX} Hydrated ${this.betConditionIds.size} existing positions into dedup set`);
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Could not hydrate positions (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  getPositions(): PennyPosition[] {
    return [...this.positions.values()];
  }

  async executeBuy(candidate: PennyCandidate): Promise<boolean> {
    // Dedup
    if (this.betConditionIds.has(candidate.market.conditionId)) return false;

    // Concurrent limit
    if (this.positions.size >= this.config.maxConcurrentPositions) return false;

    // Rate limit
    const now = Date.now();
    this.betsThisHour = this.betsThisHour.filter((t) => now - t < 3_600_000);
    if (this.betsThisHour.length >= this.config.maxBetsPerHour) {
      console.log(`${LOG_PREFIX} Rate limit: ${this.betsThisHour.length}/${this.config.maxBetsPerHour} bets/hour`);
      return false;
    }

    // Cash check
    let balance: number;
    try {
      balance = await this.service.getUsdcBalance();
    } catch (err) {
      console.error(`${LOG_PREFIX} Balance check failed:`, err instanceof Error ? err.message : String(err));
      return false;
    }

    const amount = Math.min(
      this.config.maxBetAmount,
      balance * (1 - this.config.cashReservePct / 100),
    );
    if (amount < 0.50) {
      console.log(`${LOG_PREFIX} Insufficient balance: $${balance.toFixed(2)} (need > $0.50 after reserve)`);
      return false;
    }

    // Lock before async
    this.betConditionIds.add(candidate.market.conditionId);

    try {
      console.log(
        `${LOG_PREFIX} BUY: ${candidate.market.asset} ${candidate.market.timeframe} ${candidate.winningSide} ` +
        `@ $${candidate.winningPrice.toFixed(3)} — $${amount.toFixed(2)} (${candidate.secondsRemaining.toFixed(0)}s remaining)`,
      );

      // Fast-path FOK — skip Gamma fetch + whale detection, use tokenId directly
      const result = await this.service.fastMarketBuy({
        tokenId: candidate.tokenId,
        amount,
        side: "BUY",
      });

      if (!result.orderId || result.totalCost <= 0 || result.price <= 0) {
        console.warn(`${LOG_PREFIX} Market order not filled (orderId=${result.orderId}, cost=${result.totalCost}, price=${result.price})`);
        this.betConditionIds.delete(candidate.market.conditionId);
        return false;
      }

      // Post-fill price guard: reject if slippage pushed fill price above max threshold
      // (lower fills are fine — cheaper entry = more profit when contract resolves at $1)
      const fillPrice = result.price > 0 ? result.price : candidate.winningPrice;

      if (fillPrice > this.config.maxWinningPrice) {
        console.warn(
          `${LOG_PREFIX} SLIPPAGE REJECT (max): fill $${fillPrice.toFixed(3)} > max $${this.config.maxWinningPrice} — ` +
          `selling back ${candidate.market.asset} ${candidate.market.timeframe} ${candidate.winningSide}`,
        );
        let sellBackSucceeded = false;
        try {
          const shares = result.totalCost / fillPrice;
          await this.service.fastMarketBuy({
            tokenId: candidate.tokenId,
            amount: shares,
            side: "SELL",
          });
          sellBackSucceeded = true;
        } catch (err) {
          console.error(`${LOG_PREFIX} Slippage sell-back failed:`, err instanceof Error ? err.message : String(err));
        }
        if (sellBackSucceeded) {
          // Sell-back succeeded — net position is zero, release dedup lock so we can retry
          // if price drops back into range before window closes
          this.betConditionIds.delete(candidate.market.conditionId);
          console.log(`${LOG_PREFIX} Slippage sell-back succeeded — dedup lock released for retry`);
        }
        // If sell-back failed, keep betConditionIds locked (may still hold tokens)
        return false;
      }

      // Record in journal
      let tradeId = 0;
      try {
        tradeId = recordTrade({
          skill: "polymarket",
          tool: "penny-collector:buy",
          symbol: candidate.market.conditionId,
          conditionId: candidate.market.conditionId,
          side: "BUY",
          amount: result.totalCost,
          price: result.price > 0 ? result.price : candidate.winningPrice,
          status: "filled",
          outcome: candidate.winningSide,
          metadata: {
            source: "penny-collector",
            asset: candidate.market.asset,
            timeframe: candidate.market.timeframe,
            secondsRemaining: candidate.secondsRemaining,
            expectedProfit: candidate.expectedProfit,
          },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to record trade (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Track position
      this.positions.set(candidate.market.conditionId, {
        conditionId: candidate.market.conditionId,
        market: candidate.market,
        side: candidate.winningSide,
        entryPrice: result.price > 0 ? result.price : candidate.winningPrice,
        entryTime: Date.now(),
        amount: result.totalCost,
        tradeId,
        orderId: result.orderId,
        tokenId: candidate.tokenId,
        status: "open",
      });

      this.betsThisHour.push(Date.now());

      console.log(
        `${LOG_PREFIX} FILLED: ${candidate.market.asset} ${candidate.market.timeframe} ${candidate.winningSide} ` +
        `@ $${(result.price > 0 ? result.price : candidate.winningPrice).toFixed(3)} — $${result.totalCost.toFixed(2)}`,
      );

      return true;
    } catch (err) {
      console.error(`${LOG_PREFIX} Buy failed:`, err instanceof Error ? err.message : String(err));
      this.betConditionIds.delete(candidate.market.conditionId);
      return false;
    }
  }

  /** Check stop-loss on open positions using live CLOB prices */
  async checkStopLosses(clobFeed: ClobFeed): Promise<void> {
    for (const [conditionId, pos] of this.positions) {
      if (pos.status !== "open") continue;

      const currentPrice = clobFeed.getPrice(pos.tokenId);
      if (currentPrice <= 0) continue; // no price data yet

      const priceAge = clobFeed.getPriceAge(pos.tokenId);
      if (priceAge > 30_000) continue; // stale price (>30s)

      if (currentPrice >= this.config.stopLossPrice) continue; // not triggered

      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      console.log(
        `${LOG_PREFIX} STOP-LOSS: ${pos.market.asset} ${pos.market.timeframe} ${pos.side} ` +
        `@ $${pos.entryPrice.toFixed(3)} -> $${currentPrice.toFixed(3)} (${pnlPct.toFixed(1)}%) [floor: $${this.config.stopLossPrice.toFixed(2)}]`,
      );

      // Sell via CLOB
      try {
        const shares = pos.amount / pos.entryPrice;
        const sellResult = await this.service.fastMarketBuy({
          tokenId: pos.tokenId,
          amount: shares,
          side: "SELL",
        });

        const exitPrice = sellResult.price > 0 ? sellResult.price : currentPrice;
        const pnl = (exitPrice - pos.entryPrice) * shares;

        console.log(
          `${LOG_PREFIX} STOP-LOSS SOLD: ${pos.market.asset} ${pos.market.timeframe} ${pos.side} ` +
          `exit $${exitPrice.toFixed(3)} — P&L $${pnl.toFixed(2)}`,
        );

        // Update journal
        try {
          if (pos.tradeId) updateTradeExit(pos.tradeId, exitPrice, pnl);
        } catch { /* non-fatal */ }

        pos.status = "sold";
      } catch (err) {
        console.error(`${LOG_PREFIX} Stop-loss sell failed:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Check if held positions have resolved (candle expired + settlement buffer) */
  async checkResolutions(): Promise<void> {
    const now = Date.now();
    const SETTLE_BUFFER_MS = 30_000; // 30s after expiry

    for (const [conditionId, pos] of this.positions) {
      // Already sold by stop-loss — just clean up
      if (pos.status === "sold") {
        this.positions.delete(conditionId);
        this.betConditionIds.delete(conditionId);
        continue;
      }

      const endMs = new Date(pos.market.endDate).getTime();
      if (now <= endMs + SETTLE_BUFFER_MS) continue;

      // Check actual resolution
      let exitPrice: number;
      try {
        const vitals = await this.service.getPortfolioValue();
        const stillHeld = vitals.positions?.find(
          (p) => p.conditionId === conditionId && p.size > 0,
        );
        if (stillHeld) {
          // Tokens still in wallet = won, will be redeemed at $1.00
          exitPrice = 1.00;
        } else {
          // Tokens gone — check if journal already has an exit (another service may have sold)
          if (pos.tradeId) {
            try {
              const trades = queryTrades({ symbol: conditionId, skill: "polymarket" });
              const buyTrade = trades.find((t) => t.id === pos.tradeId);
              if (buyTrade?.exitPrice !== undefined) {
                console.log(`${LOG_PREFIX} Already exited externally: ${conditionId.slice(0, 12)}`);
                this.positions.delete(conditionId);
                this.betConditionIds.delete(conditionId);
                continue;
              }
            } catch { /* non-fatal — fall through to $0 */ }
          }
          exitPrice = 0.00;
        }
      } catch {
        // Fallback: assume win (conservative — avoids false loss on API error)
        exitPrice = 1.00;
        console.warn(`${LOG_PREFIX} Could not verify resolution for ${conditionId.slice(0, 12)} — assuming win`);
      }

      // Fire-and-forget redemption — don't block scan loop on slow proxy calls
      if (exitPrice === 1.00 && this.service.redeemWinningTokens) {
        console.log(`${LOG_PREFIX} Attempting redemption for ${conditionId.slice(0, 12)}...`);
        this.service.redeemWinningTokens(conditionId).then(
          (redeemed) => {
            if (redeemed) {
              console.log(`${LOG_PREFIX} Redeemed winning tokens for ${conditionId.slice(0, 12)}`);
            } else {
              console.warn(`${LOG_PREFIX} Redemption returned false for ${conditionId.slice(0, 12)}`);
            }
          },
          (err: unknown) => {
            console.error(`${LOG_PREFIX} Redemption failed (non-fatal):`, err instanceof Error ? err.message : String(err));
          },
        );
      }

      const shares = pos.amount / pos.entryPrice;
      const pnl = (exitPrice - pos.entryPrice) * shares;
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const pnlSign = pnl >= 0 ? "+" : "";

      console.log(
        `${LOG_PREFIX} RESOLVED: ${pos.market.asset} ${pos.market.timeframe} ${pos.side} ` +
        `@ $${pos.entryPrice.toFixed(3)} -> $${exitPrice.toFixed(2)} — ` +
        `${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
      );

      // Update journal
      try {
        if (pos.tradeId) updateTradeExit(pos.tradeId, exitPrice, pnl);
      } catch { /* non-fatal */ }

      // Fire-and-forget equity snapshot — don't block scan loop
      this.service.getPortfolioValue().then(
        (vitals) => {
          recordEquitySnapshot({
            skill: "polymarket",
            equity: vitals.totalEquity,
            cash: vitals.usdcBalance,
            positionsValue: vitals.positionValue,
            metadata: { source: "penny-collector", asset: pos.market.asset, exitRule: "resolution" },
          });
        },
        () => { /* non-fatal */ },
      );

      this.positions.delete(conditionId);
      this.betConditionIds.delete(conditionId);
    }
  }

}
