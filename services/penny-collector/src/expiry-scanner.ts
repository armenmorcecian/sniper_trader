// ─── Expiry Scanner ─────────────────────────────────────────────────────────
// Finds candle markets in the 30-60s expiry window with winning side at $0.90-0.95.
// Uses CLOB WebSocket prices exclusively — skips markets with stale/missing WS data.
// Trusts the CLOB price as the directional signal (no Binance confirmation).

import type { PennyCandidate, CandleMarket } from "./types";
import type { PennyConfig } from "./config";
import type { MarketDiscovery } from "./market-discovery";
import type { ClobFeed } from "./clob-feed";

const LOG_PREFIX = "[expiry-scanner]";
const CLOB_PRICE_MAX_AGE_MS = 30_000; // consider WS price stale after 30s

export class ExpiryScanner {
  constructor(
    private readonly discovery: MarketDiscovery,
    private readonly config: PennyConfig,
    private readonly clobFeed: ClobFeed,
  ) {}

  async findCandidates(): Promise<PennyCandidate[]> {
    const markets = await this.discovery.getActiveMarkets();
    const now = Date.now();
    const candidates: PennyCandidate[] = [];

    for (const market of markets) {
      const endMs = new Date(market.endDate).getTime();
      const secondsRemaining = (endMs - now) / 1000;

      // Time filter: 30-60s window (configurable)
      if (secondsRemaining < this.config.minSecondsBeforeExpiry ||
          secondsRemaining > this.config.maxSecondsBeforeExpiry) continue;

      // CLOB WS prices only — skip if stale or missing
      const upPrice = this.clobFeed.getPrice(market.upTokenId);
      const downPrice = this.clobFeed.getPrice(market.downTokenId);
      const upFresh = upPrice > 0 && this.clobFeed.getPriceAge(market.upTokenId) < CLOB_PRICE_MAX_AGE_MS;
      const downFresh = downPrice > 0 && this.clobFeed.getPriceAge(market.downTokenId) < CLOB_PRICE_MAX_AGE_MS;

      if (!upFresh || !downFresh) {
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `stale CLOB (up=${upPrice.toFixed(3)} ${upFresh ? "fresh" : "STALE"}, down=${downPrice.toFixed(3)} ${downFresh ? "fresh" : "STALE"})`,
        );
        continue;
      }

      let winningSide: "Up" | "Down";
      let winningPrice: number;
      let tokenId: string;

      if (upPrice >= this.config.minWinningPrice && upPrice <= this.config.maxWinningPrice) {
        winningSide = "Up";
        winningPrice = upPrice;
        tokenId = market.upTokenId;
      } else if (downPrice >= this.config.minWinningPrice && downPrice <= this.config.maxWinningPrice) {
        winningSide = "Down";
        winningPrice = downPrice;
        tokenId = market.downTokenId;
      } else {
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `price out of range (up=$${upPrice.toFixed(3)}, down=$${downPrice.toFixed(3)}, ` +
          `window=$${this.config.minWinningPrice}-$${this.config.maxWinningPrice})`,
        );
        continue;
      }

      // Spread check
      const spread = Math.abs(1 - upPrice - downPrice);
      if (spread > this.config.maxSpread) {
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `spread too wide: ${spread.toFixed(3)} > ${this.config.maxSpread}`,
        );
        continue;
      }

      // Liquidity check (still from Gamma — no WS equivalent)
      if (market.liquidityNum < this.config.minLiquidity) continue;

      const expectedProfit = (1.00 - winningPrice) * this.config.maxBetAmount;

      candidates.push({
        market,
        winningSide,
        winningPrice,
        secondsRemaining,
        tokenId,
        expectedProfit,
      });
    }

    // Sort by highest expected profit (lowest price = most profit)
    candidates.sort((a, b) => b.expectedProfit - a.expectedProfit);

    if (candidates.length > 0) {
      console.log(
        `${LOG_PREFIX} Found ${candidates.length} candidate(s) in ${this.config.minSecondsBeforeExpiry}-${this.config.maxSecondsBeforeExpiry}s window: ` +
        candidates.map((c) =>
          `${c.market.asset}/${c.market.timeframe}/${c.winningSide}@$${c.winningPrice.toFixed(2)}(${c.secondsRemaining.toFixed(0)}s)`
        ).join(", "),
      );
    }

    return candidates;
  }
}
