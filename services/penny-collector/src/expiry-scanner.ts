// ─── Expiry Scanner ─────────────────────────────────────────────────────────
// Finds candle markets in the 30-60s expiry window with winning side at $0.90-0.95.
// Uses CLOB WebSocket prices as primary source; falls back to Gamma outcomePrices
// when CLOB feed is stale (e.g. after a WebSocket reconnect gap).
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
        // CLOB feed is stale (WS reconnect gap) — try Gamma outcomePrices as fallback.
        // outcomePrices is normalized to [Up, Down] by market-discovery.
        const gammaUp = market.outcomePrices[0] ?? 0;
        const gammaDown = market.outcomePrices[1] ?? 0;

        if (gammaUp > 0 && gammaDown > 0) {
          console.log(
            `${LOG_PREFIX} [warn] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
            `stale CLOB (up=${upPrice.toFixed(3)} ${upFresh ? "fresh" : "STALE"}, ` +
            `down=${downPrice.toFixed(3)} ${downFresh ? "fresh" : "STALE"}); ` +
            `using Gamma fallback (up=$${gammaUp.toFixed(3)}, down=$${gammaDown.toFixed(3)})`,
          );
          // Shadow the CLOB prices with Gamma prices for the rest of this iteration
          const effectiveUpPrice = gammaUp;
          const effectiveDownPrice = gammaDown;

          let winningSide: "Up" | "Down";
          let winningPrice: number;
          let tokenId: string;

          if (effectiveUpPrice >= this.config.minWinningPrice && effectiveUpPrice <= this.config.maxWinningPrice) {
            winningSide = "Up";
            winningPrice = effectiveUpPrice;
            tokenId = market.upTokenId;
          } else if (effectiveDownPrice >= this.config.minWinningPrice && effectiveDownPrice <= this.config.maxWinningPrice) {
            winningSide = "Down";
            winningPrice = effectiveDownPrice;
            tokenId = market.downTokenId;
          } else {
            console.log(
              `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
              `Gamma price out of range (up=$${effectiveUpPrice.toFixed(3)}, down=$${effectiveDownPrice.toFixed(3)}, ` +
              `window=$${this.config.minWinningPrice}-$${this.config.maxWinningPrice})`,
            );
            continue;
          }

          const spread = Math.abs(1 - effectiveUpPrice - effectiveDownPrice);
          if (spread > this.config.maxSpread) {
            console.log(
              `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
              `Gamma spread too wide: ${spread.toFixed(3)} > ${this.config.maxSpread}`,
            );
            continue;
          }

          if (market.liquidityNum < this.config.minLiquidity) continue;

          const expectedProfit = (1.00 - winningPrice) * this.config.maxBetAmount;
          candidates.push({ market, winningSide, winningPrice, secondsRemaining, tokenId, expectedProfit });
          continue;
        }

        // Gamma price also unavailable — skip
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `stale CLOB (up=${upPrice.toFixed(3)} ${upFresh ? "fresh" : "STALE"}, down=${downPrice.toFixed(3)} ${downFresh ? "fresh" : "STALE"}) and no Gamma fallback`,
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
