// ─── Custom Error Classes ───────────────────────────────────────────────────

export class AgentDeathError extends Error {
  readonly code = "AGENT_DEATH" as const;
  constructor(message = "Agent equity has reached $0. Ceasing all activity.") {
    super(message);
    this.name = "AgentDeathError";
  }
}

export class InsufficientFundsError extends Error {
  readonly code = "INSUFFICIENT_FUNDS" as const;
  constructor(
    public readonly required: number,
    public readonly available: number,
  ) {
    super(
      `Insufficient funds: need $${required.toFixed(2)}, have $${available.toFixed(2)}`,
    );
    this.name = "InsufficientFundsError";
  }
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface AlpacaConfig {
  apiKeyId: string;
  apiSecretKey: string;
  tradingBaseUrl: string;
  dataBaseUrl: string;
}

// ─── Market Data ────────────────────────────────────────────────────────────

export type MarketStatus = "pre" | "open" | "after" | "closed";

export interface ETFQuote {
  symbol: string;
  sector: string;
  lastPrice: number;
  change: number;
  changePercent: number;
  volume: number;
  bidPrice: number;
  askPrice: number;
  spread: number;
  spreadPercent: number;
  volumeSpike: boolean;
  marketStatus: MarketStatus;
}

export interface ETFScanResult {
  etfs: ETFQuote[];
  metadata: {
    totalScanned: number;
    marketStatus: MarketStatus;
    timestamp: string;
  };
}

// ─── Trading ────────────────────────────────────────────────────────────────

export interface OrderParams {
  symbol: string;
  side: "buy" | "sell";
  amount: number;
  qty?: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  timeInForce?: "day" | "gtc" | "ioc";
  extendedHours?: boolean;
}

export interface OrderResult {
  orderId: string;
  symbol: string;
  side: string;
  orderType: string;
  status: string;
  notional: string | null;
  qty: string | null;
  filledQty: string;
  filledAvgPrice: string | null;
  limitPrice: string | null;
  extendedHours: boolean;
  submittedAt: string;
}

// ─── Portfolio & Vitals ─────────────────────────────────────────────────────

export type AgentStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "DEAD";

// Import + re-export shared PositionSummary from quant-core
import type { PositionSummary as _PositionSummary } from "quant-core";
export type PositionSummary = _PositionSummary;

export interface VitalSigns {
  cash: number;
  buyingPower: number;
  totalEquity: number;
  positions: PositionSummary[];
  openOrderCount: number;
  dayTradeCount: number;
  status: AgentStatus;
  marketStatus: MarketStatus;
  timestamp: string;
}

// ─── Analysis ───────────────────────────────────────────────────────────────

export interface SpreadAnalysis {
  symbol: string;
  spread: number;
  spreadPercent: number;
  volume: number;
  avgVolume20d: number;
  liquidEnough: boolean;
  reason: string;
}

// Re-export shared PriceBar from quant-core
export type { PriceBar } from "quant-core";

export interface ExposureCheck {
  allowed: boolean;
  reason: string;
  currentExposure: number;
  proposedExposure: number;
  maxExposure: number;
  dryPowderPercent: number;
}

// ─── News ───────────────────────────────────────────────────────────────────

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary: string;
}

export interface NewsResult {
  items: NewsItem[];
  keywords: string[];
  premiumValidated: boolean;
  queryTimestamp: string;
}

// ─── Technical Indicators ──────────────────────────────────────────────────

export interface IndicatorResult {
  rsi: { current: number; trend: "oversold" | "overbought" | "neutral"; values: number[] };
  macd: {
    histogram: number;
    signal: number;
    macd: number;
    crossover: "bullish" | "bearish" | "none";
    values: { MACD: number; signal: number; histogram: number }[];
  };
  ema: { ema9: number; ema21: number; trend: "bullish" | "bearish" | "flat" };
  pivotPoints: {
    pivot: number;
    r1: number;
    r2: number;
    s1: number;
    s2: number;
    currentPrice: number;
    position: "above_r1" | "above_pivot" | "below_pivot" | "below_s1";
  };
  bollingerBands: {
    upper: number;
    middle: number;
    lower: number;
    percentB: number;
    bandwidth: number;
    position: "above_upper" | "upper_half" | "lower_half" | "below_lower";
  };
  atr: {
    value: number;
    percent: number;
    recommendedStopLoss: number;
    recommendedTakeProfit: number;
  };
  overallSignal: "BUY" | "SELL" | "NEUTRAL";
  confidence: "strong" | "moderate" | "weak";
  reasons: string[];
}

// ─── Sector Rotation (re-exported from quant-core) ──────────────────────────

import type {
  Regime as _Regime,
  RegimeResult as _RegimeResult,
  SectorMomentum as _SectorMomentum,
  RebalanceAction as _RebalanceAction,
} from "quant-core";
export type Regime = _Regime;
export type RegimeResult = _RegimeResult;
export type SectorMomentum = _SectorMomentum;
export type RebalanceAction = _RebalanceAction;

export interface SectorScanResult {
  regime: RegimeResult;
  rankings: SectorMomentum[];
  top3: string[];
  top5: string[];
  currentHoldings: string[];
  rebalanceActions: RebalanceAction[];
  metadata: {
    sectorCount: number;
    barsPerSymbol: number;
    marketStatus: MarketStatus;
    timestamp: string;
    averageATR?: number;           // mean ATR% across sectors
    riskParityTotal?: number;      // sum of risk-parity weights (should be ~1.0)
  };
}

// ─── Retry Configuration (re-exported from quant-core) ──────────────────────

export type { RetryConfig } from "quant-core";

// ─── Bet Sizing ─────────────────────────────────────────────────────────────

export interface BetSizeParams {
  currentBalance: number;
  marketPrice: number;
  estimatedProbability: number;
  tradeCount: number;
}

export interface BetSizeResult {
  betSize: number;
  regime: "fixed" | "half-kelly";
  reason: string;
  fraction?: number;
  edge?: number;
}
