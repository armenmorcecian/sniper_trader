import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { Type, type Static } from "@sinclair/typebox";
import { AlpacaService } from "./alpaca.service";
import { checkStopLoss, validateExposure } from "./analysis";
import { calculateBetSize, SECTOR_UNIVERSE } from "./utils";
import { calculateIndicators } from "./indicators";
import { calculateRegime, rankSectorMomentum, generateRebalanceActions } from "./rotation";
import type { AlpacaConfig, OrderParams, SectorScanResult } from "./types";
import { checkDailyLossLimit } from "./risk-checks";
import { checkConcentration, isApiAvailable, recordTrade, queryTrades, getDailySummary, getTradesToday, recordEquitySnapshot, readLatestSignals, getPerformanceMetrics, isTradingBlocked, getActiveAlerts } from "quant-core";
import type { TradeEntry } from "quant-core";

// ─── Error Formatting ────────────────────────────────────────────────────────

function formatAxiosError(err: unknown, context: string): { error: string; code: string; status?: number } {
  const axiosErr = err as { response?: { status?: number; data?: unknown }; config?: { url?: string } };
  if (axiosErr.response?.status) {
    const detail = typeof axiosErr.response.data === 'object'
      ? JSON.stringify(axiosErr.response.data)
      : String(axiosErr.response.data || '');
    return {
      error: `${context}: HTTP ${axiosErr.response.status} — ${detail}`,
      code: `HTTP_${axiosErr.response.status}`,
      status: axiosErr.response.status,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: `${context}: ${message}`, code: "UNKNOWN" };
}

// ─── Lazy Singleton ─────────────────────────────────────────────────────────

let alpacaService: AlpacaService | null = null;

function getConfig(): AlpacaConfig {
  const apiKeyId = process.env.APCA_API_KEY_ID;
  const apiSecretKey = process.env.APCA_API_SECRET_KEY;

  if (!apiKeyId) throw new Error("APCA_API_KEY_ID environment variable is required");
  if (!apiSecretKey) throw new Error("APCA_API_SECRET_KEY environment variable is required");

  return {
    apiKeyId,
    apiSecretKey,
    tradingBaseUrl: process.env.APCA_API_BASE_URL || "https://paper-api.alpaca.markets",
    dataBaseUrl: "https://data.alpaca.markets",
  };
}

function getAlpacaService(): AlpacaService {
  if (!alpacaService) {
    alpacaService = new AlpacaService(getConfig());
  }
  return alpacaService;
}

// ─── Tool Schemas ───────────────────────────────────────────────────────────

const CheckVitalsSchema = Type.Object({});

const ScanETFsSchema = Type.Object({});

const CheckSpreadSchema = Type.Object({
  symbol: Type.String({ description: "ETF symbol (e.g. SPY, QQQ, XLE)" }),
});

const PlaceOrderSchema = Type.Object({
  symbol: Type.String({ description: "ETF symbol" }),
  side: Type.Union([Type.Literal("buy"), Type.Literal("sell")]),
  amount: Type.Number({ description: "Dollar amount for the order" }),
  qty: Type.Optional(Type.Number({ description: "Share quantity for sells (overrides dollar amount)" })),
  orderType: Type.Union([Type.Literal("market"), Type.Literal("limit")], { default: "limit" }),
  limitPrice: Type.Optional(Type.Number({ description: "Limit price (required for limit orders)" })),
  timeInForce: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("gtc"), Type.Literal("ioc")], { default: "day" })),
  extendedHours: Type.Optional(Type.Boolean({ default: false, description: "If true, order participates in extended hours (limit orders only)" })),
  skipExposureCheck: Type.Optional(Type.Boolean({ default: false, description: "If true, skip exposure validation (for sector rotation 33% allocation)" })),
});

const ManagePositionsSchema = Type.Object({
  stopLossPercent: Type.Optional(Type.Number({ default: -5, description: "Stop-loss threshold as negative percentage (default: -5)" })),
});

const GetBarsSchema = Type.Object({
  symbol: Type.String({ description: "ETF symbol" }),
  timeframe: Type.Optional(Type.String({ default: "1Day", description: "Bar timeframe: 1Min, 5Min, 15Min, 1Hour, 1Day" })),
  limit: Type.Optional(Type.Number({ default: 30, description: "Number of bars to return" })),
});

const AnalyzeIndicatorsSchema = Type.Object({
  symbol: Type.String({ description: "ETF symbol (e.g. SPY, QQQ)" }),
  timeframe: Type.Optional(Type.String({ default: "5Min", description: "Bar timeframe: 1Min, 5Min, 15Min, 1Hour, 1Day" })),
  periods: Type.Optional(Type.Number({ default: 50, description: "Number of bars to analyze (minimum 26 for MACD)" })),
});

const ScanSectorsSchema = Type.Object({
  stopLossPercent: Type.Optional(Type.Number({ default: -7, description: "Hard stop-loss threshold as negative percentage (default: -7 per strategy)" })),
});

const ReadSignalsSchema = Type.Object({});

const TradeJournalSchema = Type.Object({
  action: Type.Union([Type.Literal("recent"), Type.Literal("daily"), Type.Literal("stats")], { default: "recent", description: "recent: last N trades, daily: day summary, stats: win/loss stats" }),
  limit: Type.Optional(Type.Number({ default: 20, description: "Max trades to return (for 'recent' action)" })),
  since: Type.Optional(Type.String({ description: "ISO date to filter from (for 'recent' action)" })),
  date: Type.Optional(Type.String({ description: "Date for daily summary (YYYY-MM-DD). Defaults to today." })),
});

const PerformanceReportSchema = Type.Object({
  period: Type.Optional(Type.Union([
    Type.Literal("daily"),
    Type.Literal("weekly"),
    Type.Literal("monthly"),
    Type.Literal("all-time"),
  ], { default: "weekly", description: "Time period for performance analysis" })),
  skill: Type.Optional(Type.Union([
    Type.Literal("alpaca"),
    Type.Literal("polymarket"),
  ], { description: "Filter by skill. Defaults to alpaca." })),
});

// ─── Tool Types ─────────────────────────────────────────────────────────────

type CheckSpreadParams = Static<typeof CheckSpreadSchema>;
type PlaceOrderParams = Static<typeof PlaceOrderSchema>;
type ManagePositionsParams = Static<typeof ManagePositionsSchema>;
type GetBarsParams = Static<typeof GetBarsSchema>;
type AnalyzeIndicatorsParams = Static<typeof AnalyzeIndicatorsSchema>;
type ScanSectorsParams = Static<typeof ScanSectorsSchema>;
type TradeJournalParams = Static<typeof TradeJournalSchema>;
type PerformanceReportParams = Static<typeof PerformanceReportSchema>;

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const tools = [
  {
    name: "check_vitals",
    description:
      "Account snapshot: cash, buying power, total equity, all positions with P&L, open orders, day trade count, market status (pre/open/after/closed), agent health (HEALTHY/WARNING/CRITICAL/DEAD). Call at start and end of every cycle.",
    parameters: CheckVitalsSchema,
    handler: async () => {
      try {
        const service = getAlpacaService();
        const vitals = await service.getAccount();
        const dailyLossStatus = checkDailyLossLimit(vitals.positions, vitals.totalEquity);
        const maxSinglePct = Number(process.env.ALPACA_MAX_SINGLE_POSITION_PCT) || 25;
        const concentrationWarnings = vitals.positions
          .filter(p => (p.marketValue / vitals.totalEquity * 100) > maxSinglePct)
          .map(p => ({ symbol: p.symbol, percent: Math.round(p.marketValue / vitals.totalEquity * 10000) / 100, maxPercent: maxSinglePct }));
        try {
          recordEquitySnapshot({
            skill: "alpaca",
            equity: vitals.totalEquity,
            cash: vitals.cash,
            positionsValue: vitals.totalEquity - vitals.cash,
          });
        } catch { /* non-fatal */ }
        let riskAlerts: unknown[] = [];
        try { riskAlerts = getActiveAlerts(); } catch { /* non-fatal */ }
        return { ...vitals, dailyLossStatus, concentrationWarnings, riskAlerts };
      } catch (err) {
        return formatAxiosError(err, "check_vitals");
      }
    },
  },

  {
    name: "scan_etfs",
    description:
      "Scan the ETF watchlist (SPY, QQQ, XLK, XLE, XLF, XLV, XLI, XLP, XLU, XLY, XLB, GLD, TLT, BITO, IWM) for current prices, changes, volume, and spreads. Returns ETFs sorted by biggest movers. Use this to find trading candidates.",
    parameters: ScanETFsSchema,
    handler: async () => {
      try {
        const service = getAlpacaService();
        return await service.scanETFs();
      } catch (err) {
        return formatAxiosError(err, "scan_etfs");
      }
    },
  },

  {
    name: "check_spread",
    description:
      "Analyze bid-ask spread and volume for a specific ETF. Checks against liquidity thresholds (SPY/QQQ: <0.05% spread, >1M vol; others: <0.15%, >100K). Call before placing any trade.",
    parameters: CheckSpreadSchema,
    handler: async (params: CheckSpreadParams) => {
      try {
        const service = getAlpacaService();
        return await service.getSpread(params.symbol.toUpperCase());
      } catch (err) {
        return formatAxiosError(err, `check_spread(${params.symbol})`);
      }
    },
  },

  {
    name: "place_order",
    description:
      "Place a buy or sell order. Buys use dollar amount (fractional shares). For sells, prefer `qty` (share count) over `amount` (dollars). Sells look up current position. Pre-checks balance. For extended hours, use limit orders with extendedHours=true.",
    parameters: PlaceOrderSchema,
    handler: async (params: PlaceOrderParams) => {
      try {
        // Normalize: Gemini sometimes omits or stringifies numeric params
        const amount = Number(params.amount);
        const qty = params.qty != null ? Number(params.qty) : undefined;

        // Allow amount=0 for sells when qty is provided
        const hasQty = qty != null && !isNaN(qty) && qty > 0;
        if (params.side === "sell" && hasQty) {
          // qty-based sell — amount is not required
        } else if (!params.amount || isNaN(amount) || amount <= 0) {
          return {
            error: "INVALID_PARAMS",
            message: `"amount" is required and must be a positive number, got: ${JSON.stringify(params.amount)}`,
          };
        }

        const limitPrice = params.limitPrice != null ? Number(params.limitPrice) : undefined;
        const side = params.side || "buy";
        const symbol = (params.symbol || "").toUpperCase();

        if (!symbol) {
          return { error: "INVALID_PARAMS", message: '"symbol" is required' };
        }

        const service = getAlpacaService();

        // Risk monitor block check — highest priority gate
        try {
          const blockCheck = isTradingBlocked();
          if (blockCheck.blocked) {
            recordTrade({
              skill: "alpaca",
              tool: "place_order",
              symbol,
              side,
              amount,
              price: limitPrice,
              orderType: params.orderType || "limit",
              status: "blocked",
              errorCode: "RISK_MONITOR_BLOCK",
              metadata: { reasons: blockCheck.reasons },
            });
            return {
              error: "RISK_MONITOR_BLOCK",
              message: `Trading blocked by risk monitor: ${blockCheck.reasons.join("; ")}`,
            };
          }
        } catch { /* non-fatal: if SQLite is unavailable, don't block trading */ }

        // Daily loss circuit breaker — check before any trade
        const vitals = await service.getAccount();
        const lossCheck = checkDailyLossLimit(vitals.positions, vitals.totalEquity);
        if (lossCheck.blocked) {
          // Hard circuit breaker: cancel all open orders
          const cancelResult = await service.cancelAllOpenOrders();
          recordTrade({
            skill: "alpaca",
            tool: "place_order",
            symbol,
            side,
            amount,
            price: limitPrice,
            orderType: params.orderType || "limit",
            status: "blocked",
            errorCode: "DAILY_LOSS_LIMIT",
            equityAtTrade: vitals.totalEquity,
            metadata: { dailyPnl: lossCheck.dailyPnl, dailyPnlPercent: lossCheck.dailyPnlPercent, cancelledOrders: cancelResult.cancelledCount },
          });
          return {
            error: "DAILY_LOSS_LIMIT",
            message: lossCheck.reason,
            details: lossCheck,
            circuitBreaker: { cancelledOrders: cancelResult.cancelledCount },
          };
        }

        // API availability check
        if (!isApiAvailable("alpaca-trading")) {
          recordTrade({
            skill: "alpaca",
            tool: "place_order",
            symbol,
            side,
            amount,
            price: limitPrice,
            orderType: params.orderType || "limit",
            status: "blocked",
            errorCode: "API_UNAVAILABLE",
            equityAtTrade: vitals.totalEquity,
          });
          return {
            error: "API_UNAVAILABLE",
            message: "Alpaca trading API has too many consecutive failures. Trading paused until API recovers.",
          };
        }

        // Concentration check for buys
        if (side === "buy") {
          const maxSinglePct = Number(process.env.ALPACA_MAX_SINGLE_POSITION_PCT) || 25;
          const existingPos = vitals.positions.find(p => p.symbol === symbol);
          const existingValue = existingPos ? existingPos.marketValue : 0;
          const totalValue = existingValue + amount;
          const concCheck = checkConcentration(totalValue, vitals.totalEquity, maxSinglePct);
          if (concCheck.exceeded) {
            recordTrade({
              skill: "alpaca",
              tool: "place_order",
              symbol,
              side,
              amount,
              price: limitPrice,
              orderType: params.orderType || "limit",
              status: "blocked",
              errorCode: "CONCENTRATION_LIMIT",
              equityAtTrade: vitals.totalEquity,
              metadata: { currentPercent: concCheck.currentPercent, maxPercent: concCheck.maxPercent, existingValue },
            });
            return {
              error: "CONCENTRATION_LIMIT",
              message: concCheck.reason,
              details: concCheck,
            };
          }
        }

        // Exposure validation for buys (skippable for sector rotation)
        if (side === "buy" && !params.skipExposureCheck) {
          const exposure = validateExposure(vitals, amount);
          if (!exposure.allowed) {
            return {
              error: "EXPOSURE_LIMIT",
              message: exposure.reason,
              details: exposure,
            };
          }
        }

        const orderParams: OrderParams = {
          symbol,
          side,
          amount,
          qty: hasQty ? qty : undefined,
          orderType: params.orderType || "limit",
          limitPrice,
          timeInForce: params.timeInForce || "day",
          extendedHours: params.extendedHours || false,
        };

        const result = await service.placeOrder(orderParams);

        // Record successful submission to journal
        recordTrade({
          skill: "alpaca",
          tool: "place_order",
          symbol,
          side,
          amount,
          price: limitPrice ?? (result.filledAvgPrice ? parseFloat(result.filledAvgPrice) : undefined),
          orderType: params.orderType || "limit",
          status: "submitted",
          equityAtTrade: vitals.totalEquity,
          metadata: { orderId: result.orderId, orderStatus: result.status },
        });

        return result;
      } catch (err) {
        // Record error to journal
        recordTrade({
          skill: "alpaca",
          tool: "place_order",
          symbol: (params.symbol || "").toUpperCase(),
          side: params.side || "buy",
          amount: Number(params.amount) || 0,
          price: params.limitPrice != null ? Number(params.limitPrice) : undefined,
          orderType: params.orderType || "limit",
          status: "error",
          errorCode: (err as { response?: { status?: number } }).response?.status
            ? `HTTP_${(err as { response: { status: number } }).response.status}`
            : "UNKNOWN",
          metadata: { message: err instanceof Error ? err.message : String(err) },
        });
        return formatAxiosError(err, `place_order(${params.symbol}, ${params.side})`);
      }
    },
  },

  {
    name: "manage_positions",
    description:
      "Check all positions against stop-loss threshold (default -5%). Returns positions that should be exited. Does NOT auto-sell — you must call place_order sell for each flagged position.",
    parameters: ManagePositionsSchema,
    handler: async (params: ManagePositionsParams) => {
      try {
        const service = getAlpacaService();
        const positions = await service.getPositions();
        const stopLossPercent = params.stopLossPercent ?? -5;
        const flagged = checkStopLoss(positions, stopLossPercent);

        // Record flagged positions to journal
        for (const pos of flagged) {
          recordTrade({
            skill: "alpaca",
            tool: "manage_positions",
            symbol: pos.symbol,
            side: "sell",
            amount: pos.marketValue,
            price: pos.currentPrice,
            status: "flagged",
            errorCode: "STOP_LOSS",
            pnl: pos.pnl,
            equityAtTrade: undefined,
            metadata: { pnlPercent: pos.pnlPercent, stopLossThreshold: stopLossPercent },
          });
        }

        return {
          totalPositions: positions.length,
          positions,
          flaggedForExit: flagged,
          stopLossThreshold: stopLossPercent,
          actionRequired: flagged.length > 0,
        };
      } catch (err) {
        return formatAxiosError(err, "manage_positions");
      }
    },
  },

  {
    name: "get_bars",
    description:
      "Get price history bars for a symbol. Timeframes: 1Min, 5Min, 15Min, 1Hour, 1Day. Use for technical context before trading.",
    parameters: GetBarsSchema,
    handler: async (params: GetBarsParams) => {
      try {
        const service = getAlpacaService();
        return await service.getBars(
          params.symbol.toUpperCase(),
          params.timeframe || "1Day",
          params.limit || 30,
        );
      } catch (err) {
        return formatAxiosError(err, `get_bars(${params.symbol})`);
      }
    },
  },

  {
    name: "analyze_indicators",
    description:
      "Calculate RSI(14), MACD(12,26,9), EMA(9,21) on recent price bars. Returns indicator values + trading signal (BUY/SELL/NEUTRAL) with confidence level. Requires 26+ bars for MACD.",
    parameters: AnalyzeIndicatorsSchema,
    handler: async (params: AnalyzeIndicatorsParams) => {
      try {
        const service = getAlpacaService();
        const bars = await service.getBars(
          params.symbol.toUpperCase(),
          params.timeframe || "5Min",
          params.periods || 50,
        );
        if (bars.length < 26) {
          return {
            error: "NOT_ENOUGH_DATA",
            barsAvailable: bars.length,
            required: 26,
            message: `Need at least 26 bars for MACD calculation, got ${bars.length}. Try a longer timeframe or more periods.`,
          };
        }
        return calculateIndicators(bars);
      } catch (err) {
        return formatAxiosError(err, `analyze_indicators(${params.symbol})`);
      }
    },
  },

  {
    name: "scan_sectors",
    description:
      "Sector rotation engine. Fetches 200 daily bars for SPY + 11 SPDR sector ETFs in one API call. Returns: SPY regime (bull/bear via SMA200), all 11 sectors ranked by 20-day momentum, top 3/5 lists, current sector holdings, and specific rebalance actions (buy/sell/hold with reasons). Use every Monday at market open for weekly rebalancing.",
    parameters: ScanSectorsSchema,
    handler: async (params: ScanSectorsParams) => {
      try {
        const service = getAlpacaService();
        const allSymbols = ["SPY", ...SECTOR_UNIVERSE];

        // Parallel: fetch bars + account in 2 round-trips
        const [multiBars, vitals] = await Promise.all([
          service.getMultiBars(allSymbols, "1Day", 200),
          service.getAccount(),
        ]);

        const spyBars = multiBars["SPY"] || [];
        if (spyBars.length < 200) {
          return {
            error: "NOT_ENOUGH_DATA",
            barsAvailable: spyBars.length,
            required: 200,
            message: `Need 200+ SPY bars for SMA200, got ${spyBars.length}.`,
          };
        }

        // Build sectorBars (11 sectors, excluding SPY)
        const sectorBars: Record<string, import("./types").PriceBar[]> = {};
        for (const sym of SECTOR_UNIVERSE) {
          if (multiBars[sym]) sectorBars[sym] = multiBars[sym];
        }

        // Regime detection (with breadth from sector SMA50s)
        const regime = calculateRegime(spyBars, sectorBars);

        // Momentum ranking
        const rankings = rankSectorMomentum(multiBars, SECTOR_UNIVERSE);
        const top3 = rankings.slice(0, 3).map((r) => r.symbol);
        const top5 = rankings.slice(0, 5).map((r) => r.symbol);

        // Current sector holdings
        const sectorSet = new Set(SECTOR_UNIVERSE);
        const currentHoldings = vitals.positions
          .filter((p) => sectorSet.has(p.symbol))
          .map((p) => p.symbol);

        // Rebalance actions (with correlation filtering)
        const rebalanceActions = generateRebalanceActions(regime, rankings, currentHoldings, multiBars);

        // Check hard stop-loss on sector holdings
        const stopLossPercent = params.stopLossPercent ?? -7;
        const sectorPositions = vitals.positions.filter((p) => sectorSet.has(p.symbol));
        const stopLossFlagged = sectorPositions.filter((p) => p.pnlPercent <= stopLossPercent);

        for (const pos of stopLossFlagged) {
          // Only add if not already in rebalance actions as a sell
          const alreadySelling = rebalanceActions.some(
            (a) => a.symbol === pos.symbol && a.action === "sell",
          );
          if (!alreadySelling) {
            rebalanceActions.push({
              action: "sell",
              symbol: pos.symbol,
              reason: `Hard stop-loss hit: ${pos.pnlPercent.toFixed(1)}% (threshold ${stopLossPercent}%)`,
            });
          }
        }

        // Compute metadata: averageATR from rankings, riskParityTotal from top-3 weights
        const atrValues = rankings.filter((r) => r.atrPercent != null).map((r) => r.atrPercent!);
        const averageATR = atrValues.length > 0
          ? Math.round((atrValues.reduce((s, v) => s + v, 0) / atrValues.length) * 10000) / 10000
          : undefined;
        const top3Rankings = rankings.slice(0, 3);
        const riskParityTotal = top3Rankings.every((r) => r.targetWeight != null)
          ? Math.round(top3Rankings.reduce((s, r) => s + r.targetWeight!, 0) * 10000) / 10000
          : undefined;

        const result: SectorScanResult = {
          regime,
          rankings,
          top3,
          top5,
          currentHoldings,
          rebalanceActions,
          metadata: {
            sectorCount: SECTOR_UNIVERSE.length,
            barsPerSymbol: spyBars.length,
            marketStatus: vitals.marketStatus,
            timestamp: new Date().toISOString(),
            averageATR,
            riskParityTotal,
          },
        };

        return result;
      } catch (err) {
        return formatAxiosError(err, "scan_sectors");
      }
    },
  },

  {
    name: "read_signals",
    description:
      "Read pre-computed quant signals (regime, rankings, rebalance actions) from the quant-signals service. Returns instantly (<100ms) vs scan_sectors which fetches live data. Falls back to scan_sectors if signals are stale (>30 min).",
    parameters: ReadSignalsSchema,
    handler: async () => {
      try {
        // Primary: SQLite
        try {
          const signals = readLatestSignals();
          if (signals?.meta) {
            const result: Record<string, unknown> = {
              regime: signals.regime,
              rankings: signals.rankings,
              rebalance: signals.rebalance,
              meta: signals.meta,
              source: "sqlite",
              runId: signals.runId,
            };
            // Stale check (>30 min)
            const meta = signals.meta as { lastRun?: string };
            if (meta.lastRun) {
              const ageMinutes = (Date.now() - new Date(meta.lastRun).getTime()) / 60000;
              if (ageMinutes > 30) {
                result.stale = true;
                result.staleWarning = `Signals are ${Math.round(ageMinutes)} minutes old. Consider falling back to scan_sectors for live data.`;
              }
            }
            return result;
          }
        } catch { /* SQLite unavailable — fall through to file-based */ }

        // Fallback: file-based signals (transition period)
        const signalsDir = path.join(
          process.env.HOME || process.env.USERPROFILE || "/home/node",
          ".openclaw",
          "signals",
        );

        const files = ["regime.json", "rankings.json", "rebalance.json", "meta.json"];
        const result: Record<string, unknown> = { source: "files" };
        let anyMissing = false;

        for (const file of files) {
          const filePath = path.join(signalsDir, file);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            result[file.replace(".json", "")] = JSON.parse(content);
          } catch {
            anyMissing = true;
            result[file.replace(".json", "")] = null;
          }
        }

        if (anyMissing) {
          result.warning = "Some signal files are missing. Run quant-signals service or fall back to scan_sectors.";
        }

        // Stale check: if meta.lastRun > 30 min old
        const meta = result.meta as { lastRun?: string } | null;
        if (meta?.lastRun) {
          const lastRunMs = new Date(meta.lastRun).getTime();
          const ageMinutes = (Date.now() - lastRunMs) / 60000;
          if (ageMinutes > 30) {
            result.stale = true;
            result.staleWarning = `Signals are ${Math.round(ageMinutes)} minutes old. Consider falling back to scan_sectors for live data.`;
          }
        }

        return result;
      } catch (err) {
        return {
          error: "Failed to read signals",
          message: err instanceof Error ? err.message : String(err),
          hint: "Ensure quant-signals service is running. Fall back to scan_sectors.",
        };
      }
    },
  },

  {
    name: "trade_journal",
    description:
      "Query trade history, daily P&L summaries, and win/loss stats from the persistent trade journal.",
    parameters: TradeJournalSchema,
    handler: async (params: TradeJournalParams) => {
      try {
        const action = params.action || "recent";
        if (action === "recent") {
          const trades = queryTrades({
            skill: "alpaca",
            limit: params.limit || 20,
            since: params.since,
          });
          return { action: "recent", trades, count: trades.length };
        }
        if (action === "daily") {
          const date = params.date || new Date().toISOString().split("T")[0];
          const summary = getDailySummary(date, "alpaca");
          const todayTrades = getTradesToday("alpaca");
          return { action: "daily", date, summary, todayTrades };
        }
        if (action === "stats") {
          const trades = queryTrades({ skill: "alpaca", limit: 100 });
          const filled = trades.filter(t => t.status === "filled");
          const wins = filled.filter(t => (t.pnl ?? 0) > 0).length;
          const losses = filled.filter(t => (t.pnl ?? 0) < 0).length;
          const totalPnl = filled.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
          const blocked = trades.filter(t => t.status === "blocked").length;
          return {
            action: "stats",
            totalTrades: trades.length,
            filled: filled.length,
            wins,
            losses,
            winRate: filled.length > 0 ? Math.round(wins / filled.length * 10000) / 100 : 0,
            totalPnl: Math.round(totalPnl * 100) / 100,
            blocked,
          };
        }
        return { error: "Unknown action. Use: recent, daily, stats" };
      } catch (err) {
        return { error: `trade_journal: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },

  {
    name: "performance_report",
    description:
      "Performance analytics: Sharpe ratio, max drawdown, win rate, profit factor. Computed from trade journal + equity snapshots.",
    parameters: PerformanceReportSchema,
    handler: async (params: PerformanceReportParams) => {
      try {
        return getPerformanceMetrics({
          skill: params.skill || "alpaca",
          period: params.period || "weekly",
        });
      } catch (err) {
        return { error: `performance_report: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
];

// ─── Bet Size Calculator (exported for agent use) ───────────────────────────

export { calculateBetSize } from "./utils";
