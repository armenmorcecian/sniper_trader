import axios, { AxiosInstance } from "axios";
import { recordApiSuccess, recordApiFailure } from "quant-core";
import {
  AlpacaConfig,
  AgentDeathError,
  InsufficientFundsError,
  ETFQuote,
  ETFScanResult,
  OrderParams,
  OrderResult,
  PositionSummary,
  VitalSigns,
  SpreadAnalysis,
  PriceBar,
  MarketStatus,
  AgentStatus,
} from "./types";
import { ETF_WATCHLIST, withRetry } from "./utils";
import { analyzeSpread } from "./analysis";

export class AlpacaService {
  private tradingApi: AxiosInstance;
  private dataApi: AxiosInstance;
  private config: AlpacaConfig;

  constructor(config: AlpacaConfig) {
    this.config = config;

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

    // API health tracking interceptors
    this.tradingApi.interceptors.response.use(
      (res) => { recordApiSuccess("alpaca-trading"); return res; },
      (err) => { if (err.response?.status >= 500 || err.code === "ECONNABORTED") recordApiFailure("alpaca-trading"); return Promise.reject(err); },
    );
    this.dataApi.interceptors.response.use(
      (res) => { recordApiSuccess("alpaca-data"); return res; },
      (err) => { if (err.response?.status >= 500 || err.code === "ECONNABORTED") recordApiFailure("alpaca-data"); return Promise.reject(err); },
    );
  }

  // ─── Account / Vitals ─────────────────────────────────────────────────

  async getAccount(): Promise<VitalSigns> {
    return withRetry(async () => {
      const [accountRes, positionsRes, ordersRes, clockRes] = await Promise.all([
        this.tradingApi.get("/account"),
        this.tradingApi.get("/positions"),
        this.tradingApi.get("/orders", { params: { status: "open" } }),
        this.tradingApi.get("/clock"),
      ]);

      const account = accountRes.data;
      const rawPositions = positionsRes.data as Array<Record<string, string>>;
      const openOrders = ordersRes.data as unknown[];
      const clock = clockRes.data;

      const cash = parseFloat(account.cash);
      const equity = parseFloat(account.equity);
      const buyingPower = parseFloat(account.buying_power);
      const dayTradeCount = parseInt(account.daytrade_count || "0", 10);

      if (equity <= 0) {
        throw new AgentDeathError();
      }

      const positions: PositionSummary[] = rawPositions.map((pos) => {
        const qty = parseFloat(pos.qty);
        const avgEntry = parseFloat(pos.avg_entry_price);
        const currentPrice = parseFloat(pos.current_price);
        const marketValue = parseFloat(pos.market_value);
        const pnl = parseFloat(pos.unrealized_pl);
        const pnlPercent = parseFloat(pos.unrealized_plpc) * 100;

        return {
          symbol: pos.symbol,
          sector: ETF_WATCHLIST[pos.symbol] || "Other",
          qty,
          avgEntryPrice: avgEntry,
          currentPrice,
          marketValue,
          pnl,
          pnlPercent,
        };
      });

      const marketStatus = this.parseMarketStatus(clock);

      let status: AgentStatus = "HEALTHY";
      if (equity < 50) status = "CRITICAL";
      else if (equity < 200 || (cash / equity) < 0.1) status = "WARNING";

      return {
        cash,
        buyingPower,
        totalEquity: equity,
        positions,
        openOrderCount: openOrders.length,
        dayTradeCount,
        status,
        marketStatus,
        timestamp: new Date().toISOString(),
      };
    });
  }

  // ─── ETF Scanning ─────────────────────────────────────────────────────

  async scanETFs(): Promise<ETFScanResult> {
    return withRetry(async () => {
      const symbols = Object.keys(ETF_WATCHLIST);
      const symbolsParam = symbols.join(",");

      const [snapshotRes, clockRes] = await Promise.all([
        this.dataApi.get("/stocks/snapshots", {
          params: { symbols: symbolsParam, feed: "iex" },
        }),
        this.tradingApi.get("/clock"),
      ]);

      const snapshots = snapshotRes.data as Record<string, Record<string, unknown>>;
      const marketStatus = this.parseMarketStatus(clockRes.data);

      const etfs: ETFQuote[] = [];

      for (const symbol of symbols) {
        const snap = snapshots[symbol];
        if (!snap) continue;

        const latestTrade = snap.latestTrade as Record<string, number> | undefined;
        const latestQuote = snap.latestQuote as Record<string, number> | undefined;
        const dailyBar = snap.dailyBar as Record<string, number> | undefined;
        const prevDailyBar = snap.prevDailyBar as Record<string, number> | undefined;

        const lastPrice = latestTrade?.p ?? 0;
        const prevClose = prevDailyBar?.c ?? lastPrice;
        const change = lastPrice - prevClose;
        const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
        const volume = dailyBar?.v ?? 0;
        const bidPrice = latestQuote?.bp ?? 0;
        const askPrice = latestQuote?.ap ?? 0;
        const spread = askPrice - bidPrice;
        const midpoint = (askPrice + bidPrice) / 2;
        const spreadPercent = midpoint > 0 ? (spread / midpoint) * 100 : 0;

        // Volume spike: today's volume > 1.5x of what we'd expect (rough heuristic)
        // We don't have 20-day avg here, so just flag high absolute volume
        const volumeSpike = volume > 2_000_000;

        etfs.push({
          symbol,
          sector: ETF_WATCHLIST[symbol],
          lastPrice,
          change: Math.round(change * 100) / 100,
          changePercent: Math.round(changePercent * 100) / 100,
          volume,
          bidPrice,
          askPrice,
          spread: Math.round(spread * 10000) / 10000,
          spreadPercent: Math.round(spreadPercent * 10000) / 10000,
          volumeSpike,
          marketStatus,
        });
      }

      // Sort by absolute change percent (biggest movers first)
      etfs.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

      return {
        etfs,
        metadata: {
          totalScanned: etfs.length,
          marketStatus,
          timestamp: new Date().toISOString(),
        },
      };
    });
  }

  // ─── Spread Analysis ──────────────────────────────────────────────────

  async getSpread(symbol: string): Promise<SpreadAnalysis> {
    return withRetry(async () => {
      const barsStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      const [snapshotRes, barsRes] = await Promise.all([
        this.dataApi.get(`/stocks/${symbol}/snapshot`, {
          params: { feed: "iex" },
        }),
        this.dataApi.get(`/stocks/${symbol}/bars`, {
          params: { timeframe: "1Day", limit: 20, start: barsStart, feed: "iex" },
        }),
      ]);

      const snap = snapshotRes.data;
      const bars = (barsRes.data.bars || []) as Array<Record<string, number>>;

      const latestQuote = snap.latestQuote as Record<string, number> | undefined;
      const dailyBar = snap.dailyBar as Record<string, number> | undefined;

      const bidPrice = latestQuote?.bp ?? 0;
      const askPrice = latestQuote?.ap ?? 0;
      const volume = dailyBar?.v ?? 0;

      // Calculate 20-day average volume
      const volumes = bars.map((b) => b.v || 0);
      const avgVolume20d =
        volumes.length > 0
          ? Math.round(volumes.reduce((s, v) => s + v, 0) / volumes.length)
          : 0;

      return analyzeSpread(symbol, bidPrice, askPrice, volume, avgVolume20d);
    });
  }

  // ─── Order Placement ──────────────────────────────────────────────────

  async placeOrder(params: OrderParams): Promise<OrderResult> {
    return withRetry(async () => {
      // Pre-check: balance
      if (params.side === "buy") {
        const accountRes = await this.tradingApi.get("/account");
        const cash = parseFloat(accountRes.data.cash);
        if (params.amount > cash) {
          throw new InsufficientFundsError(params.amount, cash);
        }
      }

      // Pre-check: for sell, get current position qty
      let sellQty: string | undefined;
      if (params.side === "sell") {
        const posRes = await this.tradingApi.get(
          `/positions/${params.symbol}`,
        );
        const posQty = parseFloat(posRes.data.qty);
        const currentPrice = parseFloat(posRes.data.current_price);

        if (params.qty != null && params.qty > 0) {
          // Qty-based sell: use share count directly
          // If qty covers ≥95% of position, sell all to avoid fractional dust
          if (params.qty >= posQty * 0.95) {
            sellQty = posQty.toString();
          } else {
            sellQty = params.qty.toFixed(9);
          }
        } else {
          // Dollar-amount sell (legacy)
          const posValue = posQty * currentPrice;
          if (params.amount >= posValue * 0.95) {
            sellQty = posQty.toString();
          } else {
            sellQty = (Number(params.amount) / currentPrice).toFixed(9);
          }
        }
      }

      // Build order body
      const orderBody: Record<string, unknown> = {
        symbol: params.symbol,
        side: params.side,
        type: params.orderType,
        time_in_force: params.timeInForce || "day",
      };

      if (params.side === "buy") {
        // Use notional (dollar amount) for buys — fractional shares automatically
        orderBody.notional = Number(params.amount).toFixed(2);
      } else {
        orderBody.qty = sellQty;
      }

      if (params.orderType === "limit" && params.limitPrice != null) {
        orderBody.limit_price = Number(params.limitPrice).toFixed(2);
      }

      if (params.extendedHours) {
        orderBody.extended_hours = true;
        // Extended hours requires limit order + day time_in_force
        orderBody.type = "limit";
        orderBody.time_in_force = "day";
      }

      const response = await this.tradingApi.post("/orders", orderBody);
      const order = response.data;

      return {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        orderType: order.type,
        status: order.status,
        notional: order.notional,
        qty: order.qty,
        filledQty: order.filled_qty,
        filledAvgPrice: order.filled_avg_price,
        limitPrice: order.limit_price,
        extendedHours: order.extended_hours || false,
        submittedAt: order.submitted_at,
      };
    });
  }

  // ─── Cancel All Orders ───────────────────────────────────────────────

  async cancelAllOpenOrders(): Promise<{ cancelledCount: number }> {
    const ordersRes = await this.tradingApi.get("/orders", { params: { status: "open" } });
    const openOrders = ordersRes.data;
    if (!openOrders?.length) return { cancelledCount: 0 };
    await this.tradingApi.delete("/orders");
    return { cancelledCount: openOrders.length };
  }

  // ─── Price Bars ───────────────────────────────────────────────────────

  async getBars(
    symbol: string,
    timeframe: string = "1Day",
    limit: number = 30,
  ): Promise<PriceBar[]> {
    return withRetry(async () => {
      // IEX free tier requires explicit start date for bars
      const daysBack = timeframe.includes("Min") || timeframe.includes("Hour") ? 7 : 60;
      const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
      const response = await this.dataApi.get(`/stocks/${symbol}/bars`, {
        params: { timeframe, limit, start, feed: "iex" },
      });

      const bars = (response.data.bars || []) as Array<Record<string, unknown>>;

      return bars.map((bar) => ({
        timestamp: bar.t as string,
        open: bar.o as number,
        high: bar.h as number,
        low: bar.l as number,
        close: bar.c as number,
        volume: bar.v as number,
        vwap: bar.vw as number,
      }));
    });
  }

  // ─── Multi-Symbol Bars (for sector rotation) ────────────────────────

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

  // ─── Positions (for stop-loss) ────────────────────────────────────────

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

  // ─── Private Helpers ──────────────────────────────────────────────────

  private parseMarketStatus(clock: Record<string, unknown>): MarketStatus {
    if (clock.is_open) return "open";

    const now = new Date();
    const nextOpen = new Date(clock.next_open as string);
    const todayStr = now.toISOString().split("T")[0];
    const nextOpenStr = nextOpen.toISOString().split("T")[0];

    if (nextOpenStr === todayStr) {
      return "pre";
    }

    // Check if after-hours (UTC heuristic: 20:00-01:00 UTC ≈ 4PM-8PM ET)
    const hour = now.getUTCHours();
    if (hour >= 20 || hour < 1) {
      return "after";
    }

    return "closed";
  }
}
