// ─── Poly Monitor Types ──────────────────────────────────────────────────────

import type { PredictionContractResult } from "quant-core";

// ─── Polymarket Types (mirrored from skills/polymarket-trader/src/types.ts) ──

export interface PolymarketConfig {
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  funder?: string;
  walletAddress: string;
  clobHost: string;
  gammaHost: string;
  dataHost: string;
  newsApiKey?: string;
  proxyUrl?: string;
}

export interface PositionSummary {
  conditionId: string;
  question: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  pnl: number;
  pnlPercent: number;
}

export interface VitalSigns {
  usdcBalance: number;
  positionValue: number;
  totalEquity: number;
  positions: PositionSummary[];
  openOrderCount: number;
  status: "HEALTHY" | "WARNING" | "CRITICAL" | "DEAD";
  timestamp: string;
}

export interface TradeParams {
  marketConditionId: string;
  outcome: "Yes" | "No";
  side: "BUY" | "SELL";
  amount: number;
  limitPrice?: number;
  orderType?: "GTC" | "FOK";
}

export interface TradeResult {
  orderId: string;
  side: "BUY" | "SELL";
  outcome: "Yes" | "No";
  price: number;
  size: number;
  totalCost: number;
  balanceAfter: number;
  status: string;
  transactionHashes: string[];
}

export interface MarketScanParams {
  minVolume?: number;
  minLiquidity?: number;
  maxSpread?: number;
  category?: string;
  limit?: number;
}

export interface ScannedMarket {
  conditionId: string;
  question: string;
  description: string;
  category: string;
  active: boolean;
  endDate: string;
  volume24hr: number;
  liquidity: number;
  outcomes: string[];
  clobTokenIds: string[];
  outcomePrices: number[];
  spread: number;
  midpoint: number;
  bestBid: number;
  bestAsk: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  whaleWallDetected: boolean;
  hoursToExpiration: number;
  expirationWarning?: string;
}

export interface MarketScanResult {
  markets: ScannedMarket[];
  metadata: {
    totalFound: number;
    filtersApplied: MarketScanParams;
    timestamp: string;
  };
}

/** Minimal interface for the PolymarketService methods we use */
export interface IPolymarketService {
  getOpenPositionsWithPnL(): Promise<PositionSummary[]>;
  getPortfolioValue(): Promise<VitalSigns>;
  createLimitOrder(params: TradeParams): Promise<TradeResult>;
  sellPosition(conditionId: string, outcome: "Yes" | "No"): Promise<TradeResult>;
  findLiquidMarkets(params?: MarketScanParams): Promise<MarketScanResult>;
}

// ─── Poly Monitor Types ──────────────────────────────────────────────────────

export interface TrackedPosition {
  conditionId: string;
  question: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  pnl: number;
  pnlPercent: number;
  entryTime: string;
  entryEdge: number;
  clobTokenIds: string[];
  endDate: string | null;
  lastEdge: number | null;
  /** Trade journal ID (from recordTrade) — used for updateTradeExit */
  tradeId?: number;
}

export interface ExitSignal {
  conditionId: string;
  outcome: string;
  rule: "stop_loss" | "take_profit" | "expiry_proximity" | "edge_decay" | "max_hold" | "portfolio_risk" | "circuit_breaker";
  reason: string;
  urgency: "high" | "medium";
}

export interface EdgeCandidate {
  conditionId: string;
  question: string;
  outcome: "Yes" | "No";
  marketPrice: number;
  filteredProb: number;
  divergence: number;
  ci95: [number, number];
  edge: number;
  ev: PredictionContractResult;
  clobTokenIds: string[];
  endDate: string;
}

export interface GeminiDecision {
  action: "BUY" | "SKIP";
  outcome?: "Yes" | "No";
  amount?: number;
  reasoning: string;
}

export interface HealthStatus {
  lastPing: string;
  positionsTracked: number;
  wsConnected: boolean;
  activeAlerts: number;
  uptimeSeconds: number;
  lastScanMarkets: number;
  lastEdgeCheck: number;
}
