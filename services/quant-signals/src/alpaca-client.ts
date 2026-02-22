import axios, { AxiosInstance } from "axios";
import type { AlpacaDataConfig, PriceBar, PositionSummary } from "./types";
import { ETF_WATCHLIST, withRetry } from "./helpers";

export class AlpacaDataClient {
  private tradingApi: AxiosInstance;
  private dataApi: AxiosInstance;

  constructor(config: AlpacaDataConfig) {
    const authHeaders = {
      "APCA-API-KEY-ID": config.apiKeyId,
      "APCA-API-SECRET-KEY": config.apiSecretKey,
    };

    this.tradingApi = axios.create({
      baseURL: config.tradingBaseUrl + "/v2",
      headers: authHeaders,
      timeout: 15000,
    });

    this.dataApi = axios.create({
      baseURL: config.dataBaseUrl + "/v2",
      headers: authHeaders,
      timeout: 15000,
    });
  }

  /** Fetch price bars for multiple symbols in one API call. */
  async getMultiBars(
    symbols: string[],
    timeframe: string = "1Day",
    limit: number = 200,
  ): Promise<Record<string, PriceBar[]>> {
    return withRetry(async () => {
      const daysBack = timeframe.includes("Min") || timeframe.includes("Hour") ? 7 : 400;
      const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
        .toISOString().split("T")[0];

      const response = await this.dataApi.get("/stocks/bars", {
        params: { symbols: symbols.join(","), timeframe, limit, start, feed: "iex" },
      });

      const multiBars = (response.data.bars || {}) as Record<string, Array<Record<string, unknown>>>;
      const result: Record<string, PriceBar[]> = {};
      for (const symbol of symbols) {
        result[symbol] = (multiBars[symbol] || []).map((bar) => ({
          timestamp: bar.t as string,
          open: bar.o as number,
          high: bar.h as number,
          low: bar.l as number,
          close: bar.c as number,
          volume: bar.v as number,
          vwap: bar.vw as number,
        }));
      }
      return result;
    });
  }

  /** Get current positions from the trading API. */
  async getPositions(): Promise<PositionSummary[]> {
    return withRetry(async () => {
      const response = await this.tradingApi.get("/positions");
      const rawPositions = response.data as Array<Record<string, string>>;

      return rawPositions.map((pos) => ({
        symbol: pos.symbol,
        sector: ETF_WATCHLIST[pos.symbol] || "Other",
        qty: parseFloat(pos.qty),
        avgEntryPrice: parseFloat(pos.avg_entry_price),
        currentPrice: parseFloat(pos.current_price),
        marketValue: parseFloat(pos.market_value),
        pnl: parseFloat(pos.unrealized_pl),
        pnlPercent: parseFloat(pos.unrealized_plpc) * 100,
      }));
    });
  }
}
