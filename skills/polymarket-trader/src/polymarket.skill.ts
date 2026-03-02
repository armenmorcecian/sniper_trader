import "dotenv/config";
import { Type, type Static } from "@sinclair/typebox";
import { PolymarketService } from "./polymarket.service";
import { analyzeOrderBookDepth, shouldAvoidMarket, checkStopLoss } from "./analysis";
import { executePairArbitrage } from "./arbitrage";
import { calculateBetSize } from "./utils";
import { collectPrices, getStoredHistory } from "./price-collector";
import { calculateIndicators } from "./indicators";
import { simulateArbitrage } from "./arb-simulator";
import { backtestArbitrage } from "./arb-backtest";
import type { PolymarketConfig, TradeParams } from "./types";
import {
  checkCircuitBreaker, checkConcentration, isApiAvailable,
  recordTrade, queryTrades, getDailySummary, getTradesToday, recordEquitySnapshot,
  PredictionMarketParticleFilter, getCalibrationMetrics,
  buildCorrelationMatrix, assessPortfolioRisk, calibrateCopulaDf,
} from "quant-core";
import { getPerformanceMetrics } from "quant-core/src/performance";
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

let polymarketService: PolymarketService | null = null;

function getConfig(): PolymarketConfig {
  const privateKey = process.env.PRIVATE_KEY;
  const walletAddress = process.env.WALLET_ADDRESS;

  if (!privateKey) throw new Error("PRIVATE_KEY environment variable is required");
  if (!walletAddress) throw new Error("WALLET_ADDRESS environment variable is required");

  return {
    privateKey,
    walletAddress,
    apiKey: process.env.POLY_API_KEY,
    apiSecret: process.env.POLY_API_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
    funder: process.env.POLY_FUNDER,
    clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
    gammaHost: process.env.GAMMA_HOST || "https://gamma-api.polymarket.com",
    dataHost: process.env.DATA_HOST || "https://data-api.polymarket.com",
    proxyUrl: process.env.PROXY_URL,
  };
}

function getPolymarketService(): PolymarketService {
  if (!polymarketService) {
    polymarketService = new PolymarketService(getConfig());
  }
  return polymarketService;
}

// ─── Tool Schemas ───────────────────────────────────────────────────────────

const ScanMarketsSchema = Type.Object({
  minVolume24hr: Type.Optional(Type.Number({ default: 10000, description: "Minimum 24h volume in USD" })),
  minLiquidity: Type.Optional(Type.Number({ default: 5000, description: "Minimum liquidity in USD" })),
  maxSpread: Type.Optional(Type.Number({ default: 0.10, description: "Maximum bid-ask spread" })),
  category: Type.Optional(Type.String({ default: "crypto,economics,sports", description: "Market category filter. Comma-separated: crypto, economics, sports, all" })),
  limit: Type.Optional(Type.Number({ default: 20, description: "Max markets to return" })),
});

const CheckOrderDepthSchema = Type.Object({
  marketConditionId: Type.String({ description: "Polymarket condition ID" }),
  outcome: Type.Union([Type.Literal("Yes"), Type.Literal("No")], { description: "Which outcome to check" }),
  tradeSide: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")], { description: "The side you plan to trade" }),
});

const PlaceTradeSchema = Type.Object({
  marketConditionId: Type.String({ description: "Polymarket condition ID" }),
  outcome: Type.Union([Type.Literal("Yes"), Type.Literal("No")]),
  side: Type.Union([Type.Literal("BUY"), Type.Literal("SELL")]),
  amount: Type.Number({ description: "Amount in USDC" }),
  limitPrice: Type.Optional(Type.Number({ description: "Limit price (required for limit orders)" })),
  orderType: Type.Optional(Type.Union([Type.Literal("GTC"), Type.Literal("FOK")], { default: "GTC" })),
});

const ManagePositionsSchema = Type.Object({
  stopLossPercent: Type.Optional(Type.Number({ default: -15, description: "Stop-loss threshold as negative percentage (default: -15)" })),
});

const CheckVitalSignsSchema = Type.Object({});

const CollectPricesSchema = Type.Object({
  conditionIds: Type.Array(Type.String(), { description: "List of Polymarket condition IDs to poll prices for" }),
});

const AnalyzeIndicatorsSchema = Type.Object({
  conditionId: Type.String({ description: "Polymarket condition ID" }),
  outcome: Type.Union([Type.Literal("Yes"), Type.Literal("No")], { description: "Which outcome to analyze" }),
});

const CancelOrderSchema = Type.Object({
  orderId: Type.Optional(Type.String({ description: "Specific order ID to cancel. Omit to cancel all open orders." })),
});

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
  ], { description: "Filter by skill. Defaults to polymarket." })),
});

const ExecutePairArbitrageSchema = Type.Object({
  marketConditionId: Type.String({ description: "Polymarket condition ID (must be a binary Yes/No market)" }),
  firstLeg: Type.Union([Type.Literal("Yes"), Type.Literal("No")], { description: "Which outcome to buy first" }),
  amount: Type.Number({ description: "USDC amount to spend on each leg" }),
  firstLegPrice: Type.Number({ description: "Limit price for the first leg order (e.g., 0.45)" }),
  margin: Type.Number({ description: "Target profit margin in price units (e.g., 0.02 = 2 cents guaranteed profit per unit)" }),
  legTimeoutMs: Type.Optional(Type.Number({ default: 3000, description: "Milliseconds to wait for second leg before bailout (default: 3000)" })),
  pollIntervalMs: Type.Optional(Type.Number({ default: 500, description: "Milliseconds between order book polls during hedge window (default: 500)" })),
});

const SimulateArbitrageSchema = Type.Object({
  marketConditionId: Type.String({ description: "Polymarket condition ID (binary Yes/No market)" }),
  firstLeg: Type.Union([Type.Literal("Yes"), Type.Literal("No")], { description: "Which outcome to buy first" }),
  amount: Type.Number({ description: "USDC amount per leg" }),
  firstLegPrice: Type.Number({ description: "Limit price for leg 1" }),
  margin: Type.Number({ description: "Target profit margin" }),
  legTimeoutMs: Type.Optional(Type.Number({ default: 3000, description: "Hedge window timeout ms" })),
  nPaths: Type.Optional(Type.Number({ default: 5000, description: "Monte Carlo simulation paths" })),
});

const EdgeDetectionSchema = Type.Object({
  conditionId: Type.String({ description: "Polymarket condition ID" }),
  outcome: Type.Union([Type.Literal("Yes"), Type.Literal("No")], { description: "Which outcome to analyze" }),
});

const BacktestArbitrageSchema = Type.Object({
  trueProb: Type.Number({ description: "Assumed true probability for ABM simulation (0-1)" }),
  amount: Type.Number({ description: "USDC per leg" }),
  margin: Type.Number({ description: "Target margin" }),
  legTimeoutMs: Type.Optional(Type.Number({ default: 3000, description: "Hedge window timeout ms" })),
  pollIntervalMs: Type.Optional(Type.Number({ default: 500, description: "Poll interval ms" })),
  nTrials: Type.Optional(Type.Number({ default: 100, description: "Number of arbitrage trials to simulate" })),
});

const PortfolioCorrelationSchema = Type.Object({
  conditionIds: Type.Array(Type.String(), { description: "List of condition IDs to analyze for correlation" }),
});

// ─── Tool Types ─────────────────────────────────────────────────────────────

type ScanMarketsParams = Static<typeof ScanMarketsSchema>;
type CheckOrderDepthParams = Static<typeof CheckOrderDepthSchema>;
type PlaceTradeParams = Static<typeof PlaceTradeSchema>;
type ManagePositionsParams = Static<typeof ManagePositionsSchema>;
type CollectPricesParams = Static<typeof CollectPricesSchema>;
type AnalyzeIndicatorsParams = Static<typeof AnalyzeIndicatorsSchema>;
type CancelOrderParams = Static<typeof CancelOrderSchema>;
type TradeJournalParams = Static<typeof TradeJournalSchema>;
type PerformanceReportParams = Static<typeof PerformanceReportSchema>;
type ExecutePairArbitrageParams = Static<typeof ExecutePairArbitrageSchema>;
type SimulateArbitrageParams = Static<typeof SimulateArbitrageSchema>;
type EdgeDetectionParams = Static<typeof EdgeDetectionSchema>;
type BacktestArbitrageParams = Static<typeof BacktestArbitrageSchema>;
type PortfolioCorrelationParams = Static<typeof PortfolioCorrelationSchema>;

// ─── Parameter Normalization ────────────────────────────────────────────────
// Agents frequently pass alternate param names. Map them to canonical names.

function normalizeParams<T extends Record<string, unknown>>(params: T): T {
  const p = { ...params } as Record<string, unknown>;

  // conditionId aliases → marketConditionId
  const conditionAliases = ["conditionId", "condition_id", "market_id", "marketId"];
  for (const alias of conditionAliases) {
    if (p[alias] && !p.marketConditionId) {
      p.marketConditionId = p[alias];
      delete p[alias];
    }
  }

  // price → limitPrice
  if (p.price != null && p.limitPrice == null) {
    p.limitPrice = p.price;
    delete p.price;
  }

  // missing side defaults to BUY
  if (!p.side) {
    p.side = "BUY";
  }

  return p as T;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const tools = [
  {
    name: "scan_markets",
    description:
      "Scan Polymarket for liquid, active markets in crypto, economics/Fed, and sports daily games. Returns markets enriched with order book depth and whale wall detection flags. Use this to find trading candidates.",
    parameters: ScanMarketsSchema,
    handler: async (params: ScanMarketsParams) => {
      try {
        const service = getPolymarketService();
        const result = await service.findLiquidMarkets({
          minVolume: params.minVolume24hr,
          minLiquidity: params.minLiquidity,
          maxSpread: params.maxSpread,
          category: params.category,
          limit: params.limit,
        });
        return result;
      } catch (err) {
        return formatAxiosError(err, "scan_markets");
      }
    },
  },

  {
    name: "check_order_depth",
    description:
      "Fetch order book for a specific market and analyze depth. Detects whale walls (single orders > $5,000) and checks if there's sufficient liquidity to exit. Call this before placing any trade.",
    parameters: CheckOrderDepthSchema,
    handler: async (rawParams: CheckOrderDepthParams) => {
      const params = normalizeParams(rawParams as Record<string, unknown>) as CheckOrderDepthParams;
      if (!params.marketConditionId) {
        return { error: "marketConditionId is required. Pass it as marketConditionId or conditionId.", code: "MISSING_PARAM" };
      }
      try {
        const service = getPolymarketService();
        const { orderBook } = await service.getOrderBookForToken(
          params.marketConditionId,
          params.outcome,
        );
        const depth = analyzeOrderBookDepth(orderBook);
        const avoidance = shouldAvoidMarket(depth, params.tradeSide);
        return {
          depth,
          safeToTrade: !avoidance.avoid,
          avoidanceReason: avoidance.reason,
        };
      } catch (err) {
        return formatAxiosError(err, `check_order_depth(${params.marketConditionId})`);
      }
    },
  },

  {
    name: "place_trade",
    description:
      "Place a trade on Polymarket. Pre-checks: daily loss circuit breaker, API health, concentration limit, balance validation, whale detection. Routes to limit order (GTC) or market order (FOK). Use calculateBetSize() output for amount.",
    parameters: PlaceTradeSchema,
    handler: async (rawParams: PlaceTradeParams) => {
      const params = normalizeParams(rawParams as Record<string, unknown>) as PlaceTradeParams;
      if (!params.marketConditionId) {
        return { error: "marketConditionId is required. Pass it as marketConditionId or conditionId.", code: "MISSING_PARAM" };
      }
      try {
        const service = getPolymarketService();

        // ── Daily loss circuit breaker ──────────────────────────────────────
        const portfolio = await service.getPortfolioValue();
        const dailyPnl = portfolio.positions.reduce((sum, p) => sum + p.pnl, 0);
        const maxDailyLoss = Number(process.env.POLY_MAX_DAILY_LOSS_PCT) || 10;
        const cbResult = checkCircuitBreaker(dailyPnl, portfolio.totalEquity, maxDailyLoss);
        if (cbResult.tripped) {
          await service.cancelAllOrders();
          recordTrade({
            skill: "polymarket",
            tool: "place_trade",
            conditionId: params.marketConditionId,
            side: params.side,
            amount: params.amount,
            price: params.limitPrice,
            status: "blocked",
            errorCode: "DAILY_LOSS_LIMIT",
            equityAtTrade: portfolio.totalEquity,
            metadata: { dailyPnlPercent: cbResult.dailyPnlPercent, cancelledOrders: true },
          });
          return {
            error: "CIRCUIT_BREAKER",
            message: cbResult.reason,
            details: cbResult,
            ordersCancelled: true,
          };
        }

        // ── API availability check ─────────────────────────────────────────
        if (!isApiAvailable("poly-gamma") || !isApiAvailable("poly-data")) {
          recordTrade({
            skill: "polymarket",
            tool: "place_trade",
            conditionId: params.marketConditionId,
            side: params.side,
            amount: params.amount,
            status: "blocked",
            errorCode: "API_UNAVAILABLE",
          });
          return { error: "API_UNAVAILABLE", message: "Polymarket APIs have too many consecutive failures. Operating in read-only mode." };
        }

        // ── Concentration check (BUY side) ─────────────────────────────────
        if (params.side === "BUY") {
          const maxSinglePct = Number(process.env.POLY_MAX_SINGLE_MARKET_PCT) || 40;
          const existingPos = portfolio.positions.find(p => p.conditionId === params.marketConditionId);
          const existingValue = existingPos ? existingPos.marketValue : 0;
          const concResult = checkConcentration(existingValue + params.amount, portfolio.totalEquity, maxSinglePct);
          if (concResult.exceeded) {
            recordTrade({
              skill: "polymarket",
              tool: "place_trade",
              conditionId: params.marketConditionId,
              side: params.side,
              amount: params.amount,
              price: params.limitPrice,
              status: "blocked",
              errorCode: "CONCENTRATION_LIMIT",
              equityAtTrade: portfolio.totalEquity,
              metadata: { currentPercent: concResult.currentPercent, maxPercent: concResult.maxPercent },
            });
            return {
              error: "CONCENTRATION_LIMIT",
              message: concResult.reason,
              details: concResult,
            };
          }
        }

        const tradeParams: TradeParams = {
          marketConditionId: params.marketConditionId,
          outcome: params.outcome,
          side: params.side,
          amount: params.amount,
          limitPrice: params.limitPrice,
          orderType: params.orderType || "GTC",
        };

        let result;

        // FOK SELL → use sellPosition() which resolves position size automatically
        if (params.orderType === "FOK" && params.side === "SELL") {
          result = await service.sellPosition(
            params.marketConditionId,
            params.outcome as "Yes" | "No",
          );
        } else if (params.orderType === "FOK") {
          result = await service.marketBuy(tradeParams);
        } else {
          // GTC orders (both BUY and SELL) go through createLimitOrder
          // SELL pre-check is handled inside createLimitOrder
          result = await service.createLimitOrder(tradeParams);
        }

        // ── Record successful trade to journal ─────────────────────────────
        recordTrade({
          skill: "polymarket",
          tool: "place_trade",
          conditionId: params.marketConditionId,
          side: params.side,
          amount: params.amount,
          price: params.limitPrice,
          orderType: params.orderType || "GTC",
          status: "submitted",
          equityAtTrade: portfolio.totalEquity,
        });

        return result;
      } catch (err) {
        // ── Record error to journal ────────────────────────────────────────
        recordTrade({
          skill: "polymarket",
          tool: "place_trade",
          conditionId: params.marketConditionId,
          side: params.side,
          amount: params.amount,
          price: params.limitPrice,
          status: "error",
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        return formatAxiosError(err, `place_trade(${params.marketConditionId}, ${params.side})`);
      }
    },
  },

  {
    name: "manage_open_positions",
    description:
      "Check all open positions against stop-loss threshold and expiration risk. Returns positions that should be exited (down > stopLossPercent or expiring soon). Does NOT auto-sell — you must call place_trade SELL for each flagged position.",
    parameters: ManagePositionsSchema,
    handler: async (params: ManagePositionsParams) => {
      try {
        const service = getPolymarketService();
        const positions = await service.getOpenPositionsWithPnL();
        const stopLossPercent = params.stopLossPercent ?? -15;
        const flagged = checkStopLoss(positions, stopLossPercent);

        // Record flagged positions to journal
        for (const pos of flagged) {
          recordTrade({
            skill: "polymarket",
            tool: "manage_open_positions",
            conditionId: pos.conditionId,
            side: "SELL",
            amount: pos.size,
            price: pos.currentPrice,
            status: "flagged",
            errorCode: "STOP_LOSS",
            pnl: pos.pnl,
            metadata: { pnlPercent: pos.pnlPercent, stopLossThreshold: stopLossPercent },
          });
        }

        // Enrich positions with expiration data
        const enrichedPositions = await Promise.all(
          positions.map(async (pos) => {
            try {
              const endDate = await service.getMarketEndDate(pos.conditionId);
              if (!endDate) return pos;
              const endDateObj = new Date(endDate);
              if (isNaN(endDateObj.getTime())) return pos;
              const hoursToExpiration = Math.max(0, (endDateObj.getTime() - Date.now()) / (1000 * 60 * 60));
              const hoursRounded = Math.round(hoursToExpiration * 10) / 10;
              let expirationWarning: string | undefined;
              if (hoursToExpiration < 24) {
                expirationWarning = `CRITICAL: Expires in ${hoursRounded.toFixed(1)}h — extreme risk`;
              } else if (hoursToExpiration < 7 * 24) {
                const days = Math.round(hoursToExpiration / 24 * 10) / 10;
                expirationWarning = `WARNING: Expires in ${days}d — elevated risk`;
              }
              return { ...pos, hoursToExpiration: hoursRounded, expirationWarning };
            } catch {
              return pos;
            }
          })
        );

        // Record critical expiration positions to journal
        for (const pos of enrichedPositions) {
          const ep = pos as Record<string, unknown>;
          if (ep.expirationWarning && String(ep.expirationWarning).startsWith("CRITICAL")) {
            recordTrade({
              skill: "polymarket",
              tool: "manage_open_positions",
              conditionId: (pos as any).conditionId,
              side: "SELL",
              amount: (pos as any).size,
              status: "flagged",
              errorCode: "EXPIRATION_CRITICAL",
              metadata: { hoursToExpiration: ep.hoursToExpiration },
            });
          }
        }

        return {
          totalPositions: enrichedPositions.length,
          positions: enrichedPositions,
          flaggedForExit: flagged,
          stopLossThreshold: stopLossPercent,
          actionRequired: flagged.length > 0,
        };
      } catch (err) {
        return formatAxiosError(err, "manage_open_positions");
      }
    },
  },

  {
    name: "check_vital_signs",
    description:
      "Get portfolio snapshot: USDC balance, position value, total equity, all positions, status (HEALTHY/WARNING/CRITICAL/DEAD). Throws AgentDeathError if equity = 0. Call this at start and end of every cycle.",
    parameters: CheckVitalSignsSchema,
    handler: async () => {
      try {
        const service = getPolymarketService();
        const portfolio = await service.getPortfolioValue();
        try {
          recordEquitySnapshot({
            skill: "polymarket",
            equity: portfolio.totalEquity || 0,
            cash: portfolio.usdcBalance || 0,
            positionsValue: portfolio.positionValue || 0,
          });
        } catch { /* non-fatal */ }
        return portfolio;
      } catch (err) {
        return formatAxiosError(err, "check_vital_signs");
      }
    },
  },

  {
    name: "collect_prices",
    description:
      "Poll current prices for tracked markets and store history. Call every cycle to build TA data. Returns latest prices + history depth per market. After 26+ snapshots, analyze_indicators becomes usable.",
    parameters: CollectPricesSchema,
    handler: async (params: CollectPricesParams) => {
      try {
        const service = getPolymarketService();
        return await collectPrices(service, params.conditionIds);
      } catch (err) {
        return formatAxiosError(err, "collect_prices");
      }
    },
  },

  {
    name: "analyze_indicators",
    description:
      "Calculate RSI(14), MACD(12,26,9), EMA(9,21) on collected price history. Returns indicator values + trading signal (BUY/SELL/NEUTRAL). Requires 26+ snapshots — call collect_prices each cycle to build history.",
    parameters: AnalyzeIndicatorsSchema,
    handler: async (params: AnalyzeIndicatorsParams) => {
      const snapshots = getStoredHistory(params.conditionId);
      if (snapshots.length < 26) {
        return {
          error: "NOT_ENOUGH_DATA",
          snapshotsAvailable: snapshots.length,
          required: 26,
          message: `Need at least 26 price snapshots for MACD calculation, have ${snapshots.length}. Keep calling collect_prices each cycle.`,
        };
      }
      return calculateIndicators(snapshots, params.outcome);
    },
  },

  {
    name: "cancel_order",
    description:
      "Cancel open orders. Pass orderId to cancel a specific order, or omit to cancel ALL open orders. Returns confirmation with cancelled order count.",
    parameters: CancelOrderSchema,
    handler: async (params: CancelOrderParams) => {
      try {
        const service = getPolymarketService();
        if (params.orderId) {
          return await service.cancelOrder(params.orderId);
        }
        return await service.cancelAllOrders();
      } catch (err) {
        return formatAxiosError(err, "cancel_order");
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
          const trades = queryTrades({ skill: "polymarket", limit: params.limit || 20, since: params.since });
          return { action: "recent", trades, count: trades.length };
        }
        if (action === "daily") {
          const date = params.date || new Date().toISOString().split("T")[0];
          const summary = getDailySummary(date, "polymarket");
          const todayTrades = getTradesToday("polymarket");
          return { action: "daily", date, summary, todayTrades };
        }
        if (action === "stats") {
          const trades = queryTrades({ skill: "polymarket", limit: 100 });
          const filled = trades.filter(t => t.status === "filled" || t.status === "submitted");
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
      "Performance analytics: Sharpe ratio, max drawdown, win rate, profit factor, and prediction calibration (Brier score). Computed from trade journal + equity snapshots + calibration log.",
    parameters: PerformanceReportSchema,
    handler: async (params: PerformanceReportParams) => {
      try {
        const metrics = getPerformanceMetrics({
          skill: params.skill || "polymarket",
          period: params.period || "weekly",
        });

        // Append calibration metrics if available
        let calibration;
        try {
          calibration = getCalibrationMetrics();
        } catch { /* calibration table may not exist yet */ }

        return { ...metrics, calibration };
      } catch (err) {
        return { error: `performance_report: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },

  {
    name: "execute_pair_arbitrage",
    description:
      "Execute a two-legged pair arbitrage on a binary market. " +
      "Buys one outcome at a limit price, then dynamically hedges by buying the opposite outcome " +
      "if the best ask falls within the profit window (1.00 - P_filled - margin). " +
      "If the hedge timeout expires without completing the pair, automatically bails out by " +
      "selling the filled leg to flatten directional risk. " +
      "Pre-checks: daily loss circuit breaker, API health, concentration limits. " +
      "All legs and bailout actions are recorded to the trade journal.",
    parameters: ExecutePairArbitrageSchema,
    handler: async (rawParams: ExecutePairArbitrageParams) => {
      const params = normalizeParams(rawParams as Record<string, unknown>) as ExecutePairArbitrageParams;
      if (!params.marketConditionId) {
        return { error: "marketConditionId is required.", code: "MISSING_PARAM" };
      }
      try {
        const service = getPolymarketService();

        // ── Daily loss circuit breaker ──────────────────────────────────────
        const portfolio = await service.getPortfolioValue();
        const dailyPnl = portfolio.positions.reduce((sum, p) => sum + p.pnl, 0);
        const maxDailyLoss = Number(process.env.POLY_MAX_DAILY_LOSS_PCT) || 10;
        const cbResult = checkCircuitBreaker(dailyPnl, portfolio.totalEquity, maxDailyLoss);
        if (cbResult.tripped) {
          await service.cancelAllOrders();
          recordTrade({
            skill: "polymarket",
            tool: "execute_pair_arbitrage",
            conditionId: params.marketConditionId,
            side: "BUY",
            amount: params.amount,
            price: params.firstLegPrice,
            status: "blocked",
            errorCode: "DAILY_LOSS_LIMIT",
            equityAtTrade: portfolio.totalEquity,
            metadata: { dailyPnlPercent: cbResult.dailyPnlPercent, cancelledOrders: true },
          });
          return {
            error: "CIRCUIT_BREAKER",
            message: cbResult.reason,
            details: cbResult,
            ordersCancelled: true,
          };
        }

        // ── API availability check ─────────────────────────────────────────
        if (!isApiAvailable("poly-gamma") || !isApiAvailable("poly-data")) {
          recordTrade({
            skill: "polymarket",
            tool: "execute_pair_arbitrage",
            conditionId: params.marketConditionId,
            side: "BUY",
            amount: params.amount,
            status: "blocked",
            errorCode: "API_UNAVAILABLE",
          });
          return { error: "API_UNAVAILABLE", message: "Polymarket APIs have too many consecutive failures. Operating in read-only mode." };
        }

        // ── Balance check ──────────────────────────────────────────────────
        // Need enough for both legs in the worst case
        const totalNeeded = params.amount * 2;
        if (totalNeeded > portfolio.usdcBalance) {
          return {
            error: "INSUFFICIENT_FUNDS",
            message: `Need $${totalNeeded.toFixed(2)} for both legs, have $${portfolio.usdcBalance.toFixed(2)}.`,
          };
        }

        // ── Pre-trade MC simulation gate ────────────────────────────────────
        const secondLeg = params.firstLeg === "Yes" ? "No" : "Yes";
        let simulationResult: { expectedPnl: number; profitProbability: number; recommendation: string } | undefined;
        try {
          const [leg1Book, leg2Book] = await Promise.all([
            service.getOrderBookForToken(params.marketConditionId, params.firstLeg),
            service.getOrderBookForToken(params.marketConditionId, secondLeg),
          ]);
          const leg2BestAsk = leg2Book.orderBook.asks.length > 0
            ? parseFloat(leg2Book.orderBook.asks[0].price) : 1.0;

          const simResult = simulateArbitrage({
            leg1Price: params.firstLegPrice,
            leg2BestAsk,
            leg2AskDepth: leg2Book.orderBook.asks,
            bidDepth: leg1Book.orderBook.bids,
            amount: params.amount,
            margin: params.margin,
            legTimeoutMs: params.legTimeoutMs || 3000,
            pollIntervalMs: params.pollIntervalMs || 500,
            nPaths: 3000,
          });

          simulationResult = {
            expectedPnl: simResult.expectedPnl,
            profitProbability: simResult.profitProbability,
            recommendation: simResult.recommendation,
          };

          if (simResult.recommendation === "SKIP") {
            recordTrade({
              skill: "polymarket",
              tool: "execute_pair_arbitrage",
              conditionId: params.marketConditionId,
              side: "BUY",
              amount: params.amount,
              price: params.firstLegPrice,
              status: "blocked",
              errorCode: "MC_SIMULATION_SKIP",
              metadata: { simulation: simulationResult, reason: simResult.reason },
            });
            return {
              error: "MC_SIMULATION_SKIP",
              message: `Pre-trade simulation recommends SKIP: ${simResult.reason}`,
              simulation: simResult,
            };
          }
        } catch {
          // Non-fatal — proceed without simulation if it fails
        }

        // ── Execute arbitrage engine ───────────────────────────────────────
        const arbResult = await executePairArbitrage(service, {
          marketConditionId: params.marketConditionId,
          firstLeg: params.firstLeg,
          amount: params.amount,
          firstLegPrice: params.firstLegPrice,
          margin: params.margin,
          legTimeoutMs: params.legTimeoutMs,
          pollIntervalMs: params.pollIntervalMs,
        });

        // Attach simulation result if available
        if (simulationResult) {
          arbResult.simulationResult = simulationResult;
        }

        return arbResult;
      } catch (err) {
        recordTrade({
          skill: "polymarket",
          tool: "execute_pair_arbitrage",
          conditionId: params.marketConditionId,
          side: "BUY",
          amount: params.amount,
          price: params.firstLegPrice,
          status: "error",
          metadata: { error: err instanceof Error ? err.message : String(err) },
        });
        return formatAxiosError(err, `execute_pair_arbitrage(${params.marketConditionId})`);
      }
    },
  },

  {
    name: "simulate_arbitrage",
    description:
      "Dry-run Monte Carlo simulation of a pair arbitrage BEFORE execution. " +
      "Runs N simulated paths incorporating fees, slippage, and timeout probability. " +
      "Returns expected P&L, profit probability, bailout probability, and a recommendation " +
      "(EXECUTE/SKIP/REDUCE_SIZE). Call this before execute_pair_arbitrage to validate the trade.",
    parameters: SimulateArbitrageSchema,
    handler: async (rawParams: SimulateArbitrageParams) => {
      const params = normalizeParams(rawParams as Record<string, unknown>) as SimulateArbitrageParams;
      if (!params.marketConditionId) {
        return { error: "marketConditionId is required.", code: "MISSING_PARAM" };
      }
      try {
        const service = getPolymarketService();
        const secondLeg = params.firstLeg === "Yes" ? "No" : "Yes";

        // Fetch order books for both outcomes
        const [leg1Book, leg2Book] = await Promise.all([
          service.getOrderBookForToken(params.marketConditionId, params.firstLeg),
          service.getOrderBookForToken(params.marketConditionId, secondLeg),
        ]);

        const bestAsk = leg2Book.orderBook.asks.length > 0
          ? parseFloat(leg2Book.orderBook.asks[0].price)
          : 1.0;

        const result = simulateArbitrage({
          leg1Price: params.firstLegPrice,
          leg2BestAsk: bestAsk,
          leg2AskDepth: leg2Book.orderBook.asks,
          bidDepth: leg1Book.orderBook.bids,
          amount: params.amount,
          margin: params.margin,
          legTimeoutMs: params.legTimeoutMs || 3000,
          pollIntervalMs: 500,
          nPaths: params.nPaths || 5000,
        });

        return result;
      } catch (err) {
        return formatAxiosError(err, `simulate_arbitrage(${params.marketConditionId})`);
      }
    },
  },

  {
    name: "edge_detection",
    description:
      "Particle filter edge detection for a market. Compares the filtered 'true' probability " +
      "(smoothed via Sequential Monte Carlo) against the raw market price. High divergence " +
      "suggests a trading opportunity — the market is mispricing the event. " +
      "Requires 5+ price snapshots from collect_prices to be useful.",
    parameters: EdgeDetectionSchema,
    handler: async (params: EdgeDetectionParams) => {
      try {
        const snapshots = getStoredHistory(params.conditionId);
        if (snapshots.length < 5) {
          return {
            error: "NOT_ENOUGH_DATA",
            snapshotsAvailable: snapshots.length,
            required: 5,
            message: `Need at least 5 price snapshots for edge detection, have ${snapshots.length}. Keep calling collect_prices.`,
          };
        }

        // Build particle filter from price history with calibrated hyperparameters
        const prices = snapshots.map(s =>
          params.outcome === "Yes" ? s.yesPrice : s.noPrice,
        );

        // Calibrate processVol and obsNoise from observed data
        let pfProcessVol = 0.03;
        let pfObsNoise = 0.02;
        if (prices.length >= 20) {
          const calibrated = PredictionMarketParticleFilter.calibrate(prices, 0.50, 500);
          pfProcessVol = calibrated.processVol;
          pfObsNoise = calibrated.obsNoise;
        }

        const pf = new PredictionMarketParticleFilter({
          nParticles: 2000,
          priorProb: 0.50,
          processVol: pfProcessVol,
          obsNoise: pfObsNoise,
        });

        // Process all historical observations
        for (const price of prices) {
          pf.update(price);
        }

        const estimate = pf.estimate();
        const currentMarketPrice = prices[prices.length - 1];
        const isSignificant = estimate.divergence > estimate.ci95[1] - estimate.ci95[0];

        return {
          conditionId: params.conditionId,
          outcome: params.outcome,
          currentMarketPrice,
          filteredProbability: estimate.filteredProb,
          divergence: estimate.divergence,
          ci95: estimate.ci95,
          ess: estimate.ess,
          isSignificant,
          signal: isSignificant
            ? (estimate.filteredProb > currentMarketPrice ? "UNDERPRICED" : "OVERPRICED")
            : "NEUTRAL",
          snapshotsUsed: snapshots.length,
          history: pf.history.slice(-10), // Last 10 filtered values
        };
      } catch (err) {
        return { error: `edge_detection: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },

  {
    name: "backtest_arbitrage",
    description:
      "Agent-based backtesting of the pair arbitrage strategy. Simulates a Polymarket " +
      "order book with informed/noise/market-maker agents, then tests N arbitrage attempts " +
      "against the simulated environment. Returns completion rate, average P&L, Sharpe ratio, " +
      "max drawdown, and win rate. Use this to optimize parameters without risking capital.",
    parameters: BacktestArbitrageSchema,
    handler: async (params: BacktestArbitrageParams) => {
      try {
        return backtestArbitrage({
          amount: params.amount,
          margin: params.margin,
          legTimeoutMs: params.legTimeoutMs || 3000,
          pollIntervalMs: params.pollIntervalMs || 500,
          nTrials: params.nTrials || 100,
          abm: {
            trueProb: params.trueProb,
            initialPrice: 0.50,
          },
        });
      } catch (err) {
        return { error: `backtest_arbitrage: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },

  {
    name: "portfolio_correlation",
    description:
      "Analyze tail dependence between correlated prediction market positions using copula models. " +
      "Compares Gaussian (no tail dependence) vs Student-t (with tail dependence) to quantify " +
      "how much extreme co-movements increase portfolio risk. Use this when holding multiple " +
      "positions to understand concentration risk.",
    parameters: PortfolioCorrelationSchema,
    handler: async (params: PortfolioCorrelationParams) => {
      try {
        if (params.conditionIds.length < 2) {
          return { error: "Need at least 2 condition IDs to compute correlation." };
        }

        // Gather price histories
        const priceHistories: number[][] = [];
        const marketInfo: Array<{ conditionId: string; snapshotCount: number }> = [];

        for (const conditionId of params.conditionIds) {
          const snapshots = getStoredHistory(conditionId);
          if (snapshots.length < 5) {
            return {
              error: "NOT_ENOUGH_DATA",
              conditionId,
              snapshotsAvailable: snapshots.length,
              required: 5,
              message: `Need at least 5 snapshots for ${conditionId}, have ${snapshots.length}.`,
            };
          }
          priceHistories.push(snapshots.map(s => s.yesPrice));
          marketInfo.push({ conditionId, snapshotCount: snapshots.length });
        }

        // Build correlation matrix from price histories
        const corrMatrix = buildCorrelationMatrix(priceHistories);

        // Get current prices for risk assessment
        const positions = params.conditionIds.map((conditionId, i) => {
          const snapshots = getStoredHistory(conditionId);
          const lastPrice = snapshots[snapshots.length - 1].yesPrice;
          return {
            prob: lastPrice,
            size: 10, // Default position size for analysis
            expectedPnl: lastPrice * 0.05, // Assume 5% edge as baseline
          };
        });

        // Calibrate copula degrees of freedom from observed data
        const calibratedDf = calibrateCopulaDf(priceHistories);

        // Assess risk under t-copula (captures tail dependence)
        const risk = assessPortfolioRisk(positions, corrMatrix, "t", calibratedDf);

        return {
          markets: marketInfo,
          correlationMatrix: corrMatrix.map((row: number[]) =>
            row.map((v: number) => Math.round(v * 10000) / 10000)
          ),
          portfolioRisk: risk,
          insight: risk.correlationImpact > 1.5
            ? "HIGH CORRELATION RISK: Tail dependence significantly increases joint loss probability. Consider diversifying."
            : risk.correlationImpact > 1.1
            ? "MODERATE CORRELATION: Some tail dependence present. Monitor joint exposure."
            : "LOW CORRELATION: Positions are relatively independent. Diversification benefit is strong.",
        };
      } catch (err) {
        return { error: `portfolio_correlation: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
];

// ─── Bet Size Calculator (exported for agent use in system prompt) ──────────

export { calculateBetSize } from "./utils";
