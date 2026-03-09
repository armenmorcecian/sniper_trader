// ─── Token Map ──────────────────────────────────────────────────────────────
// Maps Polymarket token IDs (uint256 positionIds) to market info via Gamma API.
// Periodically fetches active events and builds a reverse index.

import axios from "axios";
import type { MarketInfo } from "./types";

const LOG_PREFIX = "[token-map]";

export class TokenMap {
  private map = new Map<string, MarketInfo>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly gammaHost: string) {}

  get size(): number {
    return this.map.size;
  }

  /** Initial load + start periodic refresh */
  async start(refreshIntervalMs = 300_000): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => {
        console.error(`${LOG_PREFIX} Refresh failed:`, err instanceof Error ? err.message : String(err));
      });
    }, refreshIntervalMs);
  }

  /** Look up a tokenId → MarketInfo */
  get(tokenId: string): MarketInfo | undefined {
    return this.map.get(tokenId);
  }

  /** Fetch a single token from Gamma on cache miss */
  async fetchSingle(tokenId: string): Promise<MarketInfo | undefined> {
    try {
      const resp = await axios.get(`${this.gammaHost}/markets`, {
        params: { clob_token_ids: tokenId },
        timeout: 10_000,
      });

      const markets = resp.data;
      if (!Array.isArray(markets) || markets.length === 0) return undefined;

      const market = markets[0];
      const tokens: string[] = market.clobTokenIds
        ? (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds)
        : [];
      const outcomes: string[] = market.outcomes
        ? (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes)
        : ["Yes", "No"];

      const idx = tokens.indexOf(tokenId);
      if (idx === -1) return undefined;

      const info: MarketInfo = {
        conditionId: market.condition_id || market.conditionId || "",
        outcome: outcomes[idx] || (idx === 0 ? "Yes" : "No"),
        question: market.question || "",
        slug: market.slug || "",
        endDate: market.endDate || market.end_date || "",
      };

      this.map.set(tokenId, info);
      console.log(`${LOG_PREFIX} Cache miss resolved: ${tokenId.slice(0, 16)}... → "${info.question.slice(0, 60)}"`);
      return info;
    } catch (err) {
      console.error(`${LOG_PREFIX} Single fetch failed for ${tokenId.slice(0, 16)}...:`, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /** Fetch all active events from Gamma, build reverse index */
  private async refresh(): Promise<void> {
    const newMap = new Map<string, MarketInfo>();
    let offset = 0;
    const limit = 100;
    let fetched = 0;

    try {
      while (true) {
        const resp = await axios.get(`${this.gammaHost}/events`, {
          params: { active: true, closed: false, limit, offset },
          timeout: 15_000,
        });

        const events = resp.data;
        if (!Array.isArray(events) || events.length === 0) break;

        for (const event of events) {
          const markets = event.markets;
          if (!Array.isArray(markets)) continue;

          for (const market of markets) {
            const conditionId: string = market.condition_id || market.conditionId || "";
            const question: string = market.question || event.title || "";
            const slug: string = market.slug || "";

            const tokens: string[] = market.clobTokenIds
              ? (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds)
              : [];
            const outcomes: string[] = market.outcomes
              ? (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes)
              : ["Yes", "No"];

            const endDate: string = market.endDate || market.end_date || "";

            for (let i = 0; i < tokens.length; i++) {
              newMap.set(tokens[i], {
                conditionId,
                outcome: outcomes[i] || (i === 0 ? "Yes" : "No"),
                question,
                slug,
                endDate,
              });
            }
          }
        }

        fetched += events.length;
        if (events.length < limit) break;
        offset += limit;
      }

      this.map = newMap;
      console.log(`${LOG_PREFIX} Refreshed: ${this.map.size} tokens from ${fetched} events`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Refresh error:`, err instanceof Error ? err.message : String(err));
      // Keep existing map on failure
    }
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
