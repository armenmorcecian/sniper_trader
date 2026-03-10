// ─── Expiry Scanner ─────────────────────────────────────────────────────────
// Finds candle markets in the 30-60s expiry window with winning side at $0.90-0.95.
// Uses CLOB WebSocket prices exclusively — skips markets with stale/missing WS data.
// Gamma outcomePrices are NOT used as a fallback: they lag by minutes during final
// expiry convergence and cause slippage rejects on every buy attempt.
// Trusts the CLOB price as the directional signal (no Binance confirmation).
// SQ-5: Price stability filter — requires ≥2 consecutive in-range scans before
// emitting a candidate, avoiding wasted FOK calls on single-scan price spikes.
// SQ-6: Tight slippage pre-check — verifies ask-side depth within 2¢ of signal price.
// Prevents entries where all depth is stacked near maxWinningPrice ($0.98), forcing
// the market order to sweep through thin asks and fill with 8-10¢ slippage.

import type { PennyCandidate, CandleMarket } from "./types";
import type { PennyConfig } from "./config";
import type { MarketDiscovery } from "./market-discovery";
import type { ClobFeed } from "./clob-feed";

const LOG_PREFIX = "[expiry-scanner]";
const CLOB_PRICE_MAX_AGE_MS = 30_000;        // normal stale threshold
const CLOB_PRICE_NEAR_EXPIRY_AGE_MS = 300_000; // 5-min threshold when book goes quiet at convergence

export class ExpiryScanner {
  private _consecutiveInRange = new Map<string, number>();

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

      // CLOB WS prices only — skip if stale or missing.
      // Near expiry, the order book goes quiet as the market converges to 0/1
      // and trading activity dries up. Use an extended stale threshold in that
      // case: a price received within the last 5 minutes is still a valid
      // directional signal even if no new book updates have arrived.
      const upPrice = this.clobFeed.getPrice(market.upTokenId);
      const downPrice = this.clobFeed.getPrice(market.downTokenId);
      const staleThresholdMs = secondsRemaining < this.config.maxSecondsBeforeExpiry
        ? CLOB_PRICE_NEAR_EXPIRY_AGE_MS
        : CLOB_PRICE_MAX_AGE_MS;
      const upFresh = upPrice > 0 && this.clobFeed.getPriceAge(market.upTokenId) < staleThresholdMs;
      const downFresh = downPrice > 0 && this.clobFeed.getPriceAge(market.downTokenId) < staleThresholdMs;

      if (!upFresh || !downFresh) {
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `stale CLOB (up=${upPrice.toFixed(3)} ${upFresh ? "fresh" : "STALE"}, ` +
          `down=${downPrice.toFixed(3)} ${downFresh ? "fresh" : "STALE"}) — waiting for refresh`,
        );
        this._consecutiveInRange.delete(market.upTokenId);
        this._consecutiveInRange.delete(market.downTokenId);
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
        this._consecutiveInRange.delete(market.upTokenId);
        this._consecutiveInRange.delete(market.downTokenId);
        continue;
      }

      // Reset counter for the non-winning token
      const losingTokenId = winningSide === "Up" ? market.downTokenId : market.upTokenId;
      this._consecutiveInRange.delete(losingTokenId);

      // Price stability check (SQ-5): require ≥2 consecutive in-range scans
      const inRangeCount = (this._consecutiveInRange.get(tokenId) ?? 0) + 1;
      this._consecutiveInRange.set(tokenId, inRangeCount);
      const REQUIRED_CONSECUTIVE_SCANS = 2;
      if (inRangeCount < REQUIRED_CONSECUTIVE_SCANS) {
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `price not stable yet: scan ${inRangeCount}/${REQUIRED_CONSECUTIVE_SCANS} in-range (${winningSide}@$${winningPrice.toFixed(3)})`,
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

      // Ask-side depth check (broad): ensure enough liquidity to fill at all within range
      const askDepthUsd = this.clobFeed.getAskDepthUsd(tokenId, this.config.maxWinningPrice);
      if (askDepthUsd < this.config.maxBetAmount) {
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `insufficient ask depth: $${askDepthUsd.toFixed(2)} < $${this.config.maxBetAmount.toFixed(2)} bet`,
        );
        continue;
      }

      // Ask-side depth check (tight / SQ-6): skip if depth is concentrated far above signal
      // price. A market order will sweep thin asks up to the nearest bulk depth level, causing
      // 5-10¢ slippage that eliminates most of the expected profit.
      const SLIPPAGE_TOLERANCE = 0.050; // 5¢ — fills within 5¢ of signal price are acceptable
      const tightAskDepthUsd = this.clobFeed.getAskDepthUsd(tokenId, winningPrice + SLIPPAGE_TOLERANCE);
      if (tightAskDepthUsd < this.config.maxBetAmount) {
        console.log(
          `${LOG_PREFIX} [skip] ${market.asset}/${market.timeframe} ${secondsRemaining.toFixed(0)}s — ` +
          `depth stacked above signal: only $${tightAskDepthUsd.toFixed(2)} within 5¢ of ` +
          `$${winningPrice.toFixed(3)} (total depth $${askDepthUsd.toFixed(2)}) — likely fill near $${this.config.maxWinningPrice}`,
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
