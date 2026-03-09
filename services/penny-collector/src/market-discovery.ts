// ─── Market Discovery ────────────────────────────────────────────────────────
// Polls Gamma API events endpoint to find active crypto "Up or Down" candle markets.
// Supports multiple assets (BTC, ETH, SOL, etc.) via configurable slug prefixes.
// Timeframe is parsed from the event slug (e.g., btc-updown-5m-1772675100).
// Outcomes are "Up"/"Down" — first token is "Up", second is "Down".

import axios from "axios";
import type { CandleMarket, Asset, Timeframe } from "./types";
import { ASSET_SLUG_PREFIX, ASSET_HOURLY_SLUG_PREFIX } from "./types";
import type { AssetConfig } from "./types";

const LOG_PREFIX = "[market-discovery]";

// Timeframe extracted from event slug pattern: {asset}-updown-{tf}-{timestamp}
const SLUG_TF_PATTERNS: Array<{ match: string; tf: Timeframe }> = [
  { match: "-5m-", tf: "5m" },
  { match: "-15m-", tf: "15m" },
  { match: "-1h-", tf: "1h" },
  { match: "-4h-", tf: "4h" },
];

// Fallback: parse timeframe from title time range like "8:45PM-8:50PM" (5min gap)
function parseTfFromTitle(title: string): Timeframe | null {
  if (/hourly/i.test(title)) return "1h";

  const rangeMatch = title.match(/(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i);
  if (rangeMatch) {
    let startH = parseInt(rangeMatch[1]);
    const startM = parseInt(rangeMatch[2]);
    const startAP = rangeMatch[3].toUpperCase();
    let endH = parseInt(rangeMatch[4]);
    const endM = parseInt(rangeMatch[5]);
    const endAP = rangeMatch[6].toUpperCase();

    if (startAP === "PM" && startH !== 12) startH += 12;
    if (startAP === "AM" && startH === 12) startH = 0;
    if (endAP === "PM" && endH !== 12) endH += 12;
    if (endAP === "AM" && endH === 12) endH = 0;

    const durMin = (endH * 60 + endM) - (startH * 60 + startM);
    if (durMin === 5) return "5m";
    if (durMin === 15) return "15m";
    if (durMin === 60) return "1h";
    if (durMin === 240) return "4h";
  }

  return null;
}

export class MarketDiscovery {
  private readonly gammaHost: string;
  private readonly enabledAssets: Asset[];
  private readonly timeframesByAsset: Map<Asset, Set<Timeframe>>;
  private readonly minLiquidity: number;
  private cache: CandleMarket[] = [];
  private lastPoll = 0;
  private readonly cacheTtlMs = 5_000; // 5s (CLOB WS is primary price source)

  constructor(gammaHost: string, assetConfigs: Map<Asset, AssetConfig>, minLiquidity: number = 5000) {
    this.gammaHost = gammaHost;
    this.enabledAssets = [...assetConfigs.keys()];
    this.minLiquidity = minLiquidity;
    this.timeframesByAsset = new Map();
    for (const [asset, cfg] of assetConfigs) {
      this.timeframesByAsset.set(asset, new Set(cfg.targetTimeframes));
    }
  }

  /** Get active candle markets for all configured assets, using cache if fresh */
  async getActiveMarkets(force = false): Promise<CandleMarket[]> {
    if (!force && Date.now() - this.lastPoll < this.cacheTtlMs && this.cache.length > 0) {
      return this.cache;
    }

    try {
      const markets = await this.pollEventsApi();
      this.cache = markets;
      this.lastPoll = Date.now();
      return markets;
    } catch (err) {
      console.warn(`${LOG_PREFIX} Gamma API poll failed (using cache):`, err instanceof Error ? err.message : String(err));
      return this.cache; // Return stale cache on error
    }
  }

  private async pollEventsApi(): Promise<CandleMarket[]> {
    // Use end_date_min=now so we only get markets that haven't ended yet,
    // ordered by endDate ascending so the soonest-ending (live) markets come first.
    const resp = await axios.get(`${this.gammaHost}/events`, {
      params: {
        active: true,
        closed: false,
        end_date_min: new Date().toISOString(),
        limit: 500,
        order: "endDate",
        ascending: true,
      },
      timeout: 5_000,
    });

    const events: Record<string, unknown>[] = resp.data || [];
    const results: CandleMarket[] = [];
    const now = Date.now();

    for (const ev of events) {
      const slug = String(ev.slug || "");

      // Match slug against enabled asset prefixes (short form: btc-updown-*, hourly form: bitcoin-up-or-down-*)
      let matchedAsset: Asset | null = null;
      let isHourlySlug = false;
      for (const asset of this.enabledAssets) {
        if (slug.startsWith(ASSET_SLUG_PREFIX[asset])) {
          matchedAsset = asset;
          break;
        }
        if (slug.startsWith(ASSET_HOURLY_SLUG_PREFIX[asset])) {
          matchedAsset = asset;
          isHourlySlug = true;
          break;
        }
      }
      if (!matchedAsset) continue;

      const title = String(ev.title || "");
      const markets = (ev.markets || []) as Record<string, unknown>[];
      if (markets.length === 0) continue;

      const m = markets[0];

      // Parse timeframe: hourly slug → 1h, short slug → from pattern, fallback → title
      let timeframe: Timeframe | null = null;
      if (isHourlySlug) {
        timeframe = "1h";
      } else {
        for (const { match, tf } of SLUG_TF_PATTERNS) {
          if (slug.includes(match)) {
            timeframe = tf;
            break;
          }
        }
      }
      if (!timeframe) {
        timeframe = parseTfFromTitle(title);
      }
      if (!timeframe) continue;

      // Filter to this asset's target timeframes
      const assetTimeframes = this.timeframesByAsset.get(matchedAsset);
      if (!assetTimeframes || !assetTimeframes.has(timeframe)) continue;

      // Parse token IDs
      let clobTokenIds: string[];
      const rawTokens = m.clobTokenIds;
      if (typeof rawTokens === "string") {
        try { clobTokenIds = JSON.parse(rawTokens); } catch { continue; }
      } else if (Array.isArray(rawTokens)) {
        clobTokenIds = rawTokens as string[];
      } else {
        continue;
      }
      if (clobTokenIds.length < 2) continue;

      // Parse outcome prices [Up, Down]
      let outcomePrices: number[];
      const rawPrices = m.outcomePrices;
      if (typeof rawPrices === "string") {
        try { outcomePrices = JSON.parse(rawPrices).map(Number); } catch { continue; }
      } else if (Array.isArray(rawPrices)) {
        outcomePrices = (rawPrices as (string | number)[]).map(Number);
      } else {
        continue;
      }
      if (outcomePrices.length < 2 || outcomePrices.some(isNaN)) continue;

      // Parse outcomes array to determine Up/Down index ordering
      let rawOutcomes: string[] = [];
      const mOutcomes = m.outcomes;
      if (typeof mOutcomes === "string") {
        try { rawOutcomes = JSON.parse(mOutcomes); } catch { /* fallback below */ }
      } else if (Array.isArray(mOutcomes)) {
        rawOutcomes = mOutcomes as string[];
      }

      // Find which index is Up vs Down (case-insensitive)
      let upIdx = rawOutcomes.findIndex(o => String(o).toLowerCase() === "up");
      let downIdx = rawOutcomes.findIndex(o => String(o).toLowerCase() === "down");

      // Fallback: assume [Up, Down] if outcomes not parseable
      if (upIdx === -1 || downIdx === -1) {
        upIdx = 0;
        downIdx = 1;
      }

      if (upIdx !== 0) {
        console.log(`${LOG_PREFIX} ${matchedAsset} ${timeframe}: outcomes ordering is [Down, Up] — reordering`);
      }

      const conditionId = String(m.conditionId || "");
      const endDate = String(m.endDate || "");
      const startDate = String(m.eventStartTime || "");
      if (!conditionId || !endDate) continue;

      // Only keep markets whose candle is currently live (start <= now < end)
      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();
      if (isNaN(endMs)) continue;
      if (startDate && isNaN(startMs)) {
        console.warn(`${LOG_PREFIX} Skip ${matchedAsset} "${title}" — invalid startDate: "${startDate}"`);
        continue;
      }
      if (endMs < now || (startDate && startMs > now)) continue;

      // Reject markets whose actual duration doesn't match the parsed timeframe.
      // Daily markets (e.g. "Bitcoin Up or Down on March 6?") match the hourly slug
      // prefix but have durations far exceeding 1h. Allow 2x tolerance for each TF.
      const MAX_DURATION_MS: Record<Timeframe, number> = {
        "5m": 10 * 60_000,
        "15m": 30 * 60_000,
        "1h": 2 * 60 * 60_000,
        "4h": 8 * 60 * 60_000,
      };
      const actualDurationMs = endMs - (startDate ? startMs : now);
      const maxDuration = MAX_DURATION_MS[timeframe];
      if (maxDuration && actualDurationMs > maxDuration) {
        console.log(
          `${LOG_PREFIX} Skip ${matchedAsset} "${title}" — duration ${Math.round(actualDurationMs / 60_000)}min ` +
          `exceeds ${timeframe} max (${maxDuration / 60_000}min)`,
        );
        continue;
      }

      // Skip markets not accepting orders
      if (m.acceptingOrders === false) continue;

      // Parse liquidity fields from Gamma response
      const volumeNum = Number(m.volumeNum) || 0;
      const liquidityNum = Number(m.liquidityNum) || 0;

      // Filter out illiquid markets
      if (liquidityNum < this.minLiquidity) {
        console.log(
          `${LOG_PREFIX} Skip ${matchedAsset} ${timeframe} — low liquidity: $${liquidityNum.toFixed(0)} < $${this.minLiquidity} (vol=$${volumeNum.toFixed(0)})`,
        );
        continue;
      }

      results.push({
        conditionId,
        question: title,
        slug,
        asset: matchedAsset,
        timeframe,
        startDate,
        endDate,
        clobTokenIds,
        outcomePrices: [outcomePrices[upIdx], outcomePrices[downIdx]],  // normalized to [Up, Down]
        upTokenId: clobTokenIds[upIdx],
        downTokenId: clobTokenIds[downIdx],
        volumeNum,
        liquidityNum,
      });
    }

    if (results.length > 0) {
      // Group by asset for logging
      const byAsset = new Map<Asset, CandleMarket[]>();
      for (const m of results) {
        const arr = byAsset.get(m.asset) ?? [];
        arr.push(m);
        byAsset.set(m.asset, arr);
      }
      const parts: string[] = [];
      for (const [asset, markets] of byAsset) {
        const marketStrs = markets.map((m) => {
          const remainSec = Math.round((new Date(m.endDate).getTime() - now) / 1000);
          const remainMin = Math.floor(remainSec / 60);
          const remainS = remainSec % 60;
          const liqStr = m.liquidityNum >= 1000 ? `$${(m.liquidityNum / 1000).toFixed(0)}K` : `$${m.liquidityNum.toFixed(0)}`;
          return `${m.timeframe}(liq=${liqStr}, ${remainMin}m${remainS}s)`;
        }).join(", ");
        parts.push(`${asset}=[${marketStrs}]`);
      }
      console.log(`${LOG_PREFIX} Found ${results.length} live market(s): ${parts.join(" | ")}`);
    } else {
      console.log(`${LOG_PREFIX} No live markets for ${this.enabledAssets.join("/")} right now (waiting for next candle)`);
    }

    return results;
  }
}
