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
      `Insufficient funds: need $${(required ?? 0).toFixed(2)}, have $${(available ?? 0).toFixed(2)}`,
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

export interface PolymarketConfig {
  /** Ethereum private key for L1 signing */
  privateKey: string;
  /** L2 API key (derived from privateKey if absent) */
  apiKey?: string;
  /** L2 API secret */
  apiSecret?: string;
  /** L2 passphrase */
  passphrase?: string;
  /** Proxy wallet / funder address (from polymarket.com settings) */
  funder?: string;
  /** Public address for Data API position queries */
  walletAddress: string;
  /** CLOB API host */
  clobHost: string;
  /** Gamma API host */
  gammaHost: string;
  /** Data API host */
  dataHost: string;
  /** NewsAPI.org key (falls back to RSS-only if absent) */
  newsApiKey?: string;
  /** Residential proxy URL for order placement (e.g. http://user:pass@host:port) */
  proxyUrl?: string;
}

// ─── Market Scanning ────────────────────────────────────────────────────────

export interface MarketScanParams {
  /** Minimum 24h volume in USD (default: 10000) */
  minVolume?: number;
  /** Minimum total liquidity in USD (default: 5000) */
  minLiquidity?: number;
  /** Maximum bid-ask spread (default: 0.10 = 10 cents) */
  maxSpread?: number;
  /** Market category filter (default: "crypto") */
  category?: string;
  /** Max markets to return (default: 20) */
  limit?: number;
}

export interface ScannedMarket {
  /** Polymarket condition ID */
  conditionId: string;
  /** Human-readable market question */
  question: string;
  /** Market description / resolution criteria */
  description: string;
  /** Market category */
  category: string;
  /** Whether the market is currently active */
  active: boolean;
  /** End date ISO string */
  endDate: string;
  /** 24h trading volume in USD */
  volume24hr: number;
  /** Total liquidity in USD */
  liquidity: number;
  /** Outcome labels (e.g., ["Yes", "No"]) */
  outcomes: string[];
  /** CLOB token IDs for each outcome */
  clobTokenIds: string[];
  /** Current outcome prices */
  outcomePrices: number[];
  /** Bid-ask spread from CLOB */
  spread: number;
  /** Midpoint price from CLOB */
  midpoint: number;
  /** Best bid price */
  bestBid: number;
  /** Best ask price */
  bestAsk: number;
  /** Total bid depth in USD */
  bidDepthUsd: number;
  /** Total ask depth in USD */
  askDepthUsd: number;
  /** Whether a large single order (>$5k) was detected */
  whaleWallDetected: boolean;
  /** Hours until market expiration */
  hoursToExpiration: number;
  /** Warning if market expires soon */
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

// ─── Trading ────────────────────────────────────────────────────────────────

export interface TradeParams {
  /** Market condition ID */
  marketConditionId: string;
  /** Outcome name (e.g., "Yes", "No", "Up", "Down") */
  outcome: string;
  /** BUY or SELL */
  side: "BUY" | "SELL";
  /** Amount in USDC */
  amount: number;
  /** Limit price (required for limit orders) */
  limitPrice?: number;
  /** GTC (default) or FOK for market orders */
  orderType?: "GTC" | "FOK";
  /** Skip pre/post-order balance checks (used by scalper for speed) */
  skipBalanceChecks?: boolean;
}

export interface TradeResult {
  orderId: string;
  side: "BUY" | "SELL";
  outcome: string;
  price: number;
  size: number;
  totalCost: number;
  balanceAfter: number;
  status: string;
  transactionHashes: string[];
}

// ─── Portfolio & Vitals ─────────────────────────────────────────────────────

export type AgentStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "DEAD";

export interface PositionSummary {
  conditionId: string;
  question: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  pnl: number;
  /** Percentage P&L for stop-loss checks */
  pnlPercent: number;
}

export interface VitalSigns {
  usdcBalance: number;
  positionValue: number;
  totalEquity: number;
  positions: PositionSummary[];
  openOrderCount: number;
  status: AgentStatus;
  timestamp: string;
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
  /** Whether NewsAPI (premium) was used to validate */
  premiumValidated: boolean;
  queryTimestamp: string;
}

// ─── Order Book Analysis ────────────────────────────────────────────────────

export interface OrderBookDepth {
  /** Total bid depth in USD */
  bidDepthUsd: number;
  /** Total ask depth in USD */
  askDepthUsd: number;
  /** Largest single bid order in USD */
  largestBidWall: number;
  /** Largest single ask order in USD */
  largestAskWall: number;
  /** Threshold above which a single order is considered a whale wall */
  whaleThreshold: number;
  /** Whether any single order exceeds the whale threshold */
  whaleWallDetected: boolean;
}

// ─── Price History (for TA indicators) ──────────────────────────────────────

export interface PriceSnapshot {
  timestamp: string;
  yesPrice: number;
  noPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
}

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
  overallSignal: "BUY" | "SELL" | "NEUTRAL";
  confidence: "strong" | "moderate" | "weak";
  reasons: string[];
}

// ─── Retry Configuration ────────────────────────────────────────────────────

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 8000) */
  maxDelayMs: number;
}

// ─── Pair Arbitrage (Leg-Risk & Bailout) ────────────────────────────────────

export interface ArbitrageParams {
  /** Market condition ID (binary market with Yes/No outcomes) */
  marketConditionId: string;
  /** Which outcome to buy first (the "initiating leg") */
  firstLeg: "Yes" | "No";
  /** USDC amount to spend on each leg */
  amount: number;
  /** Limit price for the first leg order */
  firstLegPrice: number;
  /** Target profit margin in price units (e.g., 0.02 = 2 cents) */
  margin: number;
  /** Milliseconds to wait for the second leg before bailing out (default: 3000) */
  legTimeoutMs?: number;
  /** Milliseconds between order book polls during the hedge window (default: 500) */
  pollIntervalMs?: number;
}

export type ArbitragePhase =
  | "LEG1_PENDING"
  | "LEG1_FILLED"
  | "HEDGING"
  | "LEG2_FILLED"
  | "BAILING_OUT"
  | "FLAT"
  | "COMPLETE"
  | "FAILED";

export interface ArbitrageLegStatus {
  outcome: "Yes" | "No";
  orderId: string;
  price: number;
  size: number;
  status: "pending" | "filled" | "cancelled" | "failed";
}

export interface ArbitrageResult {
  /** Final state of the arbitrage attempt */
  phase: ArbitragePhase;
  /** First leg execution details */
  leg1: ArbitrageLegStatus;
  /** Second leg execution details (null if never attempted) */
  leg2: ArbitrageLegStatus | null;
  /** Whether the pair was fully locked in */
  pairComplete: boolean;
  /** Net P&L of the arbitrage (positive = profit, negative = bailout cost) */
  netPnl: number;
  /** Maximum acceptable price for leg 2 (fee-adjusted) */
  maxAcceptablePrice: number;
  /** Whether bailout was triggered */
  bailoutTriggered: boolean;
  /** Bailout sell details if applicable */
  bailoutSell?: { orderId: string; price: number; size: number };
  /** Total elapsed time in milliseconds */
  elapsedMs: number;
  /** Human-readable summary */
  summary: string;
  /** Fee breakdown per leg (present when pair completes or is attempted) */
  feeBreakdown?: { leg1Fee: number; leg2Fee: number; totalFees: number };
  /** Slippage estimates from order book walk */
  slippageBreakdown?: { leg2SlippageBps: number; leg2Vwap: number; bailoutSlippageBps?: number };
  /** Pre-trade simulation result (present when MC gate runs) */
  simulationResult?: { expectedPnl: number; profitProbability: number; recommendation: string };
}

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
