// ─── Penny Executor ─────────────────────────────────────────────────────────
// Market buy (FOK) near-expiry contracts, hold to resolution at $1.00.

import axios from "axios";
import { recordTrade, updateTradeExit, recordEquitySnapshot, queryTrades } from "quant-core";
import type { CandleMarket, PennyCandidate, PennyPosition, IPolymarketService } from "./types";
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

    await this.hydratePositionsFromJournal();
  }

  /** Reconstruct in-flight positions from the trade journal after a restart */
  private async hydratePositionsFromJournal(): Promise<void> {
    let trades;
    try {
      trades = queryTrades({ skill: "polymarket" });
    } catch (err) {
      console.warn(`${LOG_PREFIX} Could not query journal for position hydration (non-fatal):`, err instanceof Error ? err.message : String(err));
      return;
    }

    const unresolvedBuys = trades.filter(
      (t) => t.tool === "penny-collector:buy" && t.status === "filled" && t.exitPrice == null,
    );

    let hydrated = 0;

    for (const trade of unresolvedBuys) {
      const conditionId = trade.conditionId ?? trade.symbol ?? "";
      if (!conditionId) continue;

      // Don't overwrite positions that were registered post-restart (from this session)
      if (this.positions.has(conditionId)) continue;

      const meta = trade.metadata ?? {};

      if (meta.tokenId && meta.endDate) {
        // New trades: full metadata available
        const endDate = meta.endDate as string;
        const endMs = new Date(endDate).getTime();

        if (Date.now() > endMs + 2 * 3_600_000) continue; // beyond 2h retry window

        const tokenId = meta.tokenId as string;
        const position: PennyPosition = {
          conditionId,
          market: {
            conditionId,
            question: "",
            slug: "",
            asset: ((meta.asset as string) || "BTC") as CandleMarket["asset"],
            timeframe: ((meta.timeframe as string) || "15m") as CandleMarket["timeframe"],
            startDate: "",
            endDate,
            clobTokenIds: [],
            outcomePrices: [],
            upTokenId: "",
            downTokenId: "",
            volumeNum: 0,
            liquidityNum: 0,
          },
          side: (trade.outcome as "Up" | "Down") ?? "Up",
          entryPrice: trade.price ?? 0,
          entryTime: trade.timestamp ? new Date(trade.timestamp).getTime() : Date.now(),
          amount: trade.amount ?? 0,
          tradeId: trade.id ?? 0,
          orderId: "",
          tokenId,
          status: "open",
        };

        this.positions.set(conditionId, position);
        this.betConditionIds.add(conditionId);
        hydrated++;
      } else {
        // Old trades without tokenId/endDate: fall back to Gamma API
        try {
          const url = `${this.config.gammaHost}/markets?condition_ids=${conditionId}`;
          const resp = await axios.get<Array<{
            conditionId?: string;
            condition_id?: string;
            endDate?: string;
            end_date?: string;
            clobTokenIds?: string[];
            clob_token_ids?: string[];
          }>>(url, { timeout: 5000 });

          const markets = resp.data;
          if (!markets || markets.length === 0) continue;

          const mkt = markets[0];
          const endDate = mkt.endDate ?? mkt.end_date ?? "";
          if (!endDate) continue;

          const endMs = new Date(endDate).getTime();
          if (Date.now() > endMs + 2 * 3_600_000) continue; // beyond 2h retry window

          const clobTokenIds: string[] = mkt.clobTokenIds ?? mkt.clob_token_ids ?? [];
          const upTokenId = clobTokenIds[0] ?? "";
          const downTokenId = clobTokenIds[1] ?? "";
          const tokenId = trade.outcome === "Down" ? downTokenId : upTokenId;

          const position: PennyPosition = {
            conditionId,
            market: {
              conditionId,
              question: "",
              slug: "",
              asset: ((meta.asset as string) || "BTC") as CandleMarket["asset"],
              timeframe: ((meta.timeframe as string) || "15m") as CandleMarket["timeframe"],
              startDate: "",
              endDate,
              clobTokenIds,
              outcomePrices: [],
              upTokenId,
              downTokenId,
              volumeNum: 0,
              liquidityNum: 0,
            },
            side: (trade.outcome as "Up" | "Down") ?? "Up",
            entryPrice: trade.price ?? 0,
            entryTime: trade.timestamp ? new Date(trade.timestamp).getTime() : Date.now(),
            amount: trade.amount ?? 0,
            tradeId: trade.id ?? 0,
            orderId: "",
            tokenId,
            status: "open",
          };

          this.positions.set(conditionId, position);
          this.betConditionIds.add(conditionId);
          hydrated++;
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} Could not hydrate position ${conditionId.slice(0, 12)} from Gamma (non-fatal):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    if (hydrated > 0) {
      console.log(`${LOG_PREFIX} Hydrated ${hydrated} in-flight position(s) from journal`);
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
      // NOTE: Do NOT clear betConditionIds here — the order DID fill, so we must
      // keep the dedup lock to prevent double-buying on the next scan cycle.
      const fillPrice = result.price > 0 ? result.price : candidate.winningPrice;

      if (fillPrice > this.config.maxWinningPrice) {
        console.warn(
          `${LOG_PREFIX} SLIPPAGE REJECT (max): fill $${fillPrice.toFixed(3)} > max $${this.config.maxWinningPrice} — ` +
          `selling back ${candidate.market.asset} ${candidate.market.timeframe} ${candidate.winningSide}`,
        );
        try {
          const shares = result.totalCost / fillPrice;
          await this.service.fastMarketBuy({
            tokenId: candidate.tokenId,
            amount: shares,
            side: "SELL",
          });
        } catch (err) {
          console.error(`${LOG_PREFIX} Slippage sell-back failed:`, err instanceof Error ? err.message : String(err));
        }
        // Keep betConditionIds locked — never re-buy a market we already filled on
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
            tokenId: candidate.tokenId,
            endDate: candidate.market.endDate,
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

      // Skip stop-loss after market expiry — CLOB prices are stale post-expiry
      // Let checkResolutions() handle the final outcome instead
      const endMs = new Date(pos.market.endDate).getTime();
      if (Date.now() >= endMs) continue;

      const currentPrice = clobFeed.getPrice(pos.tokenId);
      if (currentPrice <= 0) continue; // no price data yet

      const priceAge = clobFeed.getPriceAge(pos.tokenId);
      if (priceAge > 30_000) continue; // stale price (>30s)

      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      if (pnlPct >= -this.config.stopLossPct) continue; // not triggered

      console.log(
        `${LOG_PREFIX} STOP-LOSS: ${pos.market.asset} ${pos.market.timeframe} ${pos.side} ` +
        `@ $${pos.entryPrice.toFixed(3)} -> $${currentPrice.toFixed(3)} (${pnlPct.toFixed(1)}%)`,
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
    const SETTLE_BUFFER_MS = 600_000; // 10min — oracle needs time to resolve on-chain

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
          // Tokens not in portfolio positions list.
          // This can mean: (a) market resolved and positions API dropped the entry,
          // (b) tokens were sold externally, or (c) redemption already happened.
          // Try redemption to distinguish win vs loss — don't assume $0 yet.
          if (this.service.redeemWinningTokens) {
            try {
              const redeemed = await this.service.redeemWinningTokens(conditionId);
              if (redeemed) {
                console.log(`${LOG_PREFIX} Redeemed winning tokens (was missing from portfolio) for ${conditionId.slice(0, 12)}`);
                exitPrice = 1.00;
              } else {
                // Redemption returned false — oracle may not have finalized yet.
                // Retry for up to 2 hours before giving up.
                const msSinceExpiry = Date.now() - endMs;
                if (msSinceExpiry < 2 * 3_600_000) {
                  console.log(`${LOG_PREFIX} Redemption not ready for missing position ${conditionId.slice(0, 12)} (${Math.round(msSinceExpiry / 60_000)}min post-expiry) — will retry`);
                  continue;
                }
                // 2h timeout — check if externally exited before recording loss
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
                  } catch { /* non-fatal */ }
                }
                // 2h elapsed + not sold externally = assume lost
                console.log(`${LOG_PREFIX} Not redeemable after 2h, tokens gone: ${conditionId.slice(0, 12)} — recording as loss`);
                exitPrice = 0.00;
              }
            } catch (redeemErr: unknown) {
              const msg = redeemErr instanceof Error ? redeemErr.message : String(redeemErr);
              if (msg.includes("not received yet") || msg.includes("not resolved")) {
                // Oracle hasn't resolved yet — but tokens are gone from portfolio.
                // This is unusual. Could be an API lag. Retry next cycle.
                console.log(`${LOG_PREFIX} Oracle not resolved but tokens missing for ${conditionId.slice(0, 12)} — will retry`);
                continue;
              }
              // Other error (tokens already redeemed by us in a previous cycle, or network error)
              // Check journal for existing exit
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
                } catch { /* non-fatal */ }
              }
              // Unknown error — assume loss rather than false win
              console.warn(`${LOG_PREFIX} Redemption error for missing position ${conditionId.slice(0, 12)}: ${msg} — recording as loss`);
              exitPrice = 0.00;
            }
          } else {
            // No redeemWinningTokens method — fall back to $0 (legacy behavior)
            exitPrice = 0.00;
          }
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
