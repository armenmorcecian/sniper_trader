// ─── Copycat Executor ───────────────────────────────────────────────────────
// Copies buy/sell trades from tracked wallets. Tier-based filtering.

import { recordTrade, updateTradeExit, recordEquitySnapshot } from "quant-core";
import type { CopycatConfig } from "./config";
import type { IPolymarketService, CopyPosition, OrderFilledEvent, MarketInfo, WalletScore } from "./types";
import type { TokenMap } from "./token-map";
import type { Alerter } from "./alerter";
import type { HealthPinger } from "./health";

const LOG_PREFIX = "[executor]";

export class CopycatExecutor {
  private positions = new Map<string, CopyPosition>();
  /** Never cleared — prevents re-entry on same market even after exit */
  private betConditionIds = new Set<string>();
  private walletScores = new Map<string, WalletScore>();
  /** Tracks wallet → conditionId → outcome for hedge detection */
  private walletBets = new Map<string, Map<string, string>>();
  /** Async lock — prevents concurrent executeBuy race condition */
  private _executing = false;

  constructor(
    private readonly config: CopycatConfig,
    private readonly service: IPolymarketService,
    private readonly tokenMap: TokenMap,
    private readonly alerter: Alerter,
    private readonly health: HealthPinger,
  ) {}

  updateWalletScores(scores: Map<string, WalletScore>): void {
    // Clean stale wallets from hedge tracker
    for (const wallet of this.walletBets.keys()) {
      if (!scores.has(wallet)) {
        this.walletBets.delete(wallet);
      }
    }
    this.walletScores = scores;
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  getPositions(): CopyPosition[] {
    return [...this.positions.values()];
  }

  /** Remove a resolved position from tracking (frees maxConcurrent slot) */
  removeResolvedPosition(conditionId: string): void {
    this.positions.delete(conditionId);
    // Keep in betConditionIds to prevent re-entry
  }

  // ─── Buy Handler ────────────────────────────────────────────────────

  async executeBuy(event: OrderFilledEvent): Promise<boolean> {
    // Async lock — prevent concurrent buys racing past the position check
    if (this._executing) {
      console.log(`${LOG_PREFIX} Skip: another buy is in progress`);
      return false;
    }
    this._executing = true;

    try {
      // Look up wallet tier
      const score = this.walletScores.get(event.sourceWallet);
      const tier = score?.tier ?? 1;

      // 1. Tier-based filtering
      if (!this.passesTierFilter(tier, event, score)) {
        return false;
      }

      // 2. Price range filter — skip lottery tickets & near-certainties
      if (event.price < this.config.minCopyPrice) {
        console.log(`${LOG_PREFIX} Skip: lottery ticket (price $${event.price.toFixed(4)} < $${this.config.minCopyPrice})`);
        return false;
      }
      if (event.price > this.config.maxCopyPrice) {
        console.log(`${LOG_PREFIX} Skip: near-certainty (price $${event.price.toFixed(4)} > $${this.config.maxCopyPrice})`);
        return false;
      }

      // 3. Resolve tokenId → market info (needed for steps 4-7)
      let info: MarketInfo | undefined = this.tokenMap.get(event.tokenId);
      if (!info) {
        info = await this.tokenMap.fetchSingle(event.tokenId);
      }
      if (!info || !info.conditionId) {
        console.warn(`${LOG_PREFIX} Skip: cannot resolve token ${event.tokenId.slice(0, 16)}...`);
        return false;
      }

      // 4. Same-day market filter — skip markets resolving too soon
      if (info.endDate) {
        const endTime = new Date(info.endDate).getTime();
        const minTimeMs = this.config.minTimeToResolutionHours * 3_600_000;
        const hoursLeft = (endTime - Date.now()) / 3_600_000;
        if (endTime > 0 && endTime - Date.now() < minTimeMs) {
          console.log(`${LOG_PREFIX} Skip: resolves in ${hoursLeft.toFixed(1)}h (min ${this.config.minTimeToResolutionHours}h)`);
          return false;
        }
      }

      // 5. Min whale size with "No" outcome discount
      const effectiveMinWhale = info.outcome === "No"
        ? this.config.minWhaleSize * this.config.noOutcomeWhaleSizeMultiplier
        : this.config.minWhaleSize;
      if (event.usdcAmount < effectiveMinWhale) {
        console.log(`${LOG_PREFIX} Skip: whale trade too small ($${event.usdcAmount.toFixed(2)} < $${effectiveMinWhale.toFixed(0)} [${info.outcome}])`);
        return false;
      }

      // 6. Hedge detection — skip if wallet already bet the other side
      const walletConditions = this.walletBets.get(event.sourceWallet);
      const previousOutcome = walletConditions?.get(info.conditionId);
      if (previousOutcome && previousOutcome !== info.outcome) {
        console.log(
          `${LOG_PREFIX} Skip: HEDGE DETECTED — ${(score?.userName || event.sourceWallet.slice(0, 10))} ` +
          `bet ${previousOutcome} then ${info.outcome} on "${info.question.slice(0, 50)}"`,
        );
        return false;
      }

      // 7. Record wallet bet (track ALL observed bets for future hedge detection)
      if (!this.walletBets.has(event.sourceWallet)) {
        this.walletBets.set(event.sourceWallet, new Map());
      }
      this.walletBets.get(event.sourceWallet)!.set(info.conditionId, info.outcome);

      // 8. Strict dedup — one bet per market, ever
      if (this.betConditionIds.has(info.conditionId)) {
        console.log(`${LOG_PREFIX} Skip: already bet on "${info.question.slice(0, 50)}..."`);
        return false;
      }

      // 9. Concurrent limit
      if (this.positions.size >= this.config.maxConcurrent) {
        console.log(`${LOG_PREFIX} Skip: max concurrent positions (${this.config.maxConcurrent})`);
        return false;
      }

      // 10. Price-drift guard — skip if price moved too far from whale's fill price
      try {
        const priceData = await this.service.getPrice(event.tokenId);
        const currentPrice = priceData.price;
        if (currentPrice > 0 && event.price > 0) {
          const driftPct = Math.abs((currentPrice - event.price) / event.price) * 100;
          if (driftPct > this.config.maxPriceDriftPct) {
            console.log(
              `${LOG_PREFIX} Skip: price drifted ${driftPct.toFixed(1)}% from whale fill ` +
              `($${event.price.toFixed(4)} → $${currentPrice.toFixed(4)})`,
            );
            return false;
          }
        }
      } catch { /* non-fatal, proceed without drift check */ }

      // 11. Cash check
      let balance: number;
      try {
        balance = await this.service.getUsdcBalance();
      } catch (err) {
        console.error(`${LOG_PREFIX} Balance check failed:`, err instanceof Error ? err.message : String(err));
        return false;
      }

      const available = balance * (1 - this.config.cashReservePct / 100);
      const amount = Math.min(event.usdcAmount, this.config.maxBet, available);
      if (amount < 0.10) {
        console.log(`${LOG_PREFIX} Insufficient balance: $${balance.toFixed(2)} (need > $0.10 after reserve)`);
        return false;
      }

      // Lock before async
      this.betConditionIds.add(info.conditionId);

      const tierLabel = `T${tier}`;
      const nameLabel = score?.userName || event.sourceWallet.slice(0, 10);

      try {
        console.log(
          `${LOG_PREFIX} COPY BUY [${tierLabel} ${nameLabel}]: "${info.question.slice(0, 60)}" ${info.outcome} ` +
          `— $${amount.toFixed(2)} (whale: $${event.usdcAmount.toFixed(2)} @ $${event.price.toFixed(4)})`,
        );

        const result = await this.service.fastMarketBuy({
          tokenId: event.tokenId,
          amount,
          side: "BUY",
        });

        if (!result.orderId || result.totalCost <= 0) {
          console.warn(`${LOG_PREFIX} Order not filled (orderId=${result.orderId}, cost=${result.totalCost})`);
          this.betConditionIds.delete(info.conditionId);
          return false;
        }

        // Copy latency: time from whale on-chain fill to our fill
        const copyLatencyMs = Date.now() - event.timestamp;
        const copyLatencySec = (copyLatencyMs / 1000).toFixed(1);

        // Record in journal
        let tradeId = 0;
        try {
          tradeId = recordTrade({
            skill: "polymarket",
            tool: "copycat-wallet:buy",
            symbol: info.conditionId,
            conditionId: info.conditionId,
            side: "BUY",
            amount: result.totalCost,
            price: result.price > 0 ? result.price : event.price,
            status: "filled",
            outcome: info.outcome,
            metadata: {
              source: "copycat-wallet",
              sourceWallet: event.sourceWallet,
              walletTier: tier,
              walletName: nameLabel,
              whalePrice: event.price,
              whaleAmount: event.usdcAmount,
              question: info.question,
              copyLatencyMs,
            },
          });
        } catch (err) {
          console.error(`${LOG_PREFIX} Journal write failed (non-fatal):`, err instanceof Error ? err.message : String(err));
        }

        // Track position
        const entryPrice = result.price > 0 ? result.price : event.price;
        const resultShares = result.size > 0 ? result.size : (result.totalCost / entryPrice);
        this.positions.set(info.conditionId, {
          conditionId: info.conditionId,
          tokenId: event.tokenId,
          outcome: info.outcome,
          question: info.question,
          entryPrice,
          entryTime: Date.now(),
          amount: result.totalCost,
          shares: resultShares,
          sourceWallet: event.sourceWallet,
          tradeId,
          exchange: event.exchange,
        });

        this.health.incrementCopies();

        console.log(
          `${LOG_PREFIX} FILLED: "${info.question.slice(0, 50)}" ${info.outcome} ` +
          `@ $${entryPrice.toFixed(4)} — $${result.totalCost.toFixed(2)} (${resultShares.toFixed(2)} shares) ` +
          `[latency: ${copyLatencySec}s]`,
        );

        await this.alerter.sendStatus(
          `*Copycat BUY* [${tierLabel} ${nameLabel}]\n"${info.question.slice(0, 80)}"\n` +
          `Outcome: ${info.outcome} @ $${entryPrice.toFixed(4)}\n` +
          `Amount: $${result.totalCost.toFixed(2)} (${resultShares.toFixed(2)} shares)\n` +
          `Whale: $${event.usdcAmount.toFixed(2)} @ $${event.price.toFixed(4)}\n` +
          `Copy latency: ${copyLatencySec}s`,
        );

        return true;
      } catch (err) {
        console.error(`${LOG_PREFIX} Buy failed:`, err instanceof Error ? err.message : String(err));
        this.betConditionIds.delete(info.conditionId);
        return false;
      }
    } finally {
      this._executing = false;
    }
  }

  // ─── Tier Filter ──────────────────────────────────────────────────

  private passesTierFilter(tier: number, event: OrderFilledEvent, score?: WalletScore): boolean {
    if (tier >= 4) return true; // Always copy tier 4

    if (tier === 3) return true; // Tier 3: passes (price-drift check happens later)

    if (tier === 2) {
      // Need whale size ≥ 2x minWhaleSize
      if (event.usdcAmount < this.config.minWhaleSize * 2) {
        console.log(`${LOG_PREFIX} Skip T2: whale size $${event.usdcAmount.toFixed(2)} < 2x min ($${this.config.minWhaleSize * 2})`);
        return false;
      }
      return true;
    }

    // Tier 1: only copy DAY leaderboard + whale size ≥ 3x
    if (tier === 1) {
      const isDay = score?.categories.includes("DAY") ?? false;
      if (!isDay) {
        console.log(`${LOG_PREFIX} Skip T1: not on DAY leaderboard`);
        return false;
      }
      if (event.usdcAmount < this.config.minWhaleSize * 3) {
        console.log(`${LOG_PREFIX} Skip T1: whale size $${event.usdcAmount.toFixed(2)} < 3x min ($${this.config.minWhaleSize * 3})`);
        return false;
      }
      return true;
    }

    return false;
  }

  // ─── Sell Handler (whale exit) ──────────────────────────────────────

  async executeSell(event: OrderFilledEvent): Promise<boolean> {
    // Find matching open position by tokenId
    let matchPos: CopyPosition | undefined;
    for (const pos of this.positions.values()) {
      if (pos.tokenId === event.tokenId) {
        matchPos = pos;
        break;
      }
    }
    if (!matchPos) return false;

    return this.exitPosition(matchPos, "whale_exit");
  }

  // ─── Safety Exit Check ──────────────────────────────────────────────

  async checkSafetyExits(): Promise<void> {
    const now = Date.now();

    for (const pos of this.positions.values()) {
      let currentPrice: number | undefined;
      try {
        const priceData = await this.service.getPrice(pos.tokenId);
        currentPrice = priceData.price;
      } catch {
        // Can't get price — skip this check
        continue;
      }

      if (currentPrice === undefined || currentPrice <= 0) continue;

      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const holdHours = (now - pos.entryTime) / 3_600_000;

      // Stop loss
      if (pnlPct <= -this.config.slPct) {
        console.log(`${LOG_PREFIX} Stop loss: "${pos.question.slice(0, 40)}" @ ${pnlPct.toFixed(1)}%`);
        await this.exitPosition(pos, "stop_loss");
        continue;
      }

      // Take profit
      if (pnlPct >= this.config.tpPct) {
        console.log(`${LOG_PREFIX} Take profit: "${pos.question.slice(0, 40)}" @ +${pnlPct.toFixed(1)}%`);
        await this.exitPosition(pos, "take_profit");
        continue;
      }

      // Max hold time
      if (holdHours >= this.config.maxHoldHours) {
        console.log(`${LOG_PREFIX} Max hold: "${pos.question.slice(0, 40)}" @ ${holdHours.toFixed(1)}h`);
        await this.exitPosition(pos, "max_hold");
        continue;
      }
    }

  }

  // ─── Position Exit ──────────────────────────────────────────────────

  private async exitPosition(pos: CopyPosition, rule: string): Promise<boolean> {
    try {
      console.log(`${LOG_PREFIX} EXIT (${rule}): "${pos.question.slice(0, 50)}" ${pos.outcome}`);

      const result = await this.service.sellPosition(pos.conditionId, pos.outcome, pos.shares);

      const exitPrice = result.price > 0 ? result.price : 0;
      const shares = pos.shares > 0 ? pos.shares : (pos.amount / pos.entryPrice);
      const pnl = (exitPrice - pos.entryPrice) * shares;
      const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const pnlSign = pnl >= 0 ? "+" : "";

      console.log(
        `${LOG_PREFIX} EXITED: "${pos.question.slice(0, 40)}" ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
      );

      // Update journal
      try {
        if (pos.tradeId) updateTradeExit(pos.tradeId, exitPrice, pnl);
      } catch { /* non-fatal */ }

      // Equity snapshot
      try {
        const vitals = await this.service.getPortfolioValue();
        recordEquitySnapshot({
          skill: "polymarket",
          equity: vitals.totalEquity,
          cash: vitals.usdcBalance,
          positionsValue: vitals.positionValue,
          metadata: { source: "copycat-wallet", exitRule: rule },
        });
      } catch { /* non-fatal */ }

      // Remove from open positions (keep in betConditionIds to prevent re-entry)
      this.positions.delete(pos.conditionId);

      await this.alerter.sendStatus(
        `*Copycat EXIT* (${rule})\n"${pos.question.slice(0, 80)}"\n` +
        `${pos.outcome}: $${pos.entryPrice.toFixed(4)} → $${exitPrice.toFixed(4)}\n` +
        `PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
      );

      return true;
    } catch (err) {
      console.error(`${LOG_PREFIX} Exit failed for "${pos.question.slice(0, 40)}":`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
