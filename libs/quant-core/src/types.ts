// ─── Price Data ──────────────────────────────────────────────────────────────

export interface PriceBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

// ─── Regime Detection ────────────────────────────────────────────────────────

export type Regime = "bull" | "bear";

export interface RegimeResult {
  regime: Regime;
  spyPrice: number;
  sma200: number;
  distancePercent: number;
  breadthCount?: number;
  breadthSignal?: "bull" | "bear" | "neutral";
  compositeRegime?: Regime;
  sectorSMA50Status?: Record<string, boolean>;
}

// ─── Momentum Ranking ────────────────────────────────────────────────────────

export interface SectorMomentum {
  symbol: string;
  sector: string;
  rank: number;
  momentum20d: number;
  latestClose: number;
  close20dAgo: number;
  momentum5d?: number;
  momentum60d?: number;
  compositeScore?: number;
  atr14?: number;
  atrPercent?: number;
  volatilityAdjustedScore?: number;
  sma50?: number;
  aboveSMA50?: boolean;
  targetWeight?: number;
  correlationWarning?: string;
}

// ─── Rebalance Actions ───────────────────────────────────────────────────────

export type RebalanceAction =
  | { action: "buy";  symbol: string; reason: string; targetWeight?: number }
  | { action: "sell"; symbol: string; reason: string }
  | { action: "hold"; symbol: string; reason: string; targetWeight?: number };

// ─── Position Summary ────────────────────────────────────────────────────────

export interface PositionSummary {
  symbol: string;
  sector: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  pnl: number;
  pnlPercent: number;
}

// ─── Signal Output Files ─────────────────────────────────────────────────────

export interface SignalMeta {
  lastRun: string;
  nextRun: string;
  status: "ok" | "error";
  errors: string[];
  durationMs: number;
}

export interface RankingsSignal {
  rankings: SectorMomentum[];
  top3: string[];
  top5: string[];
}

export interface RebalanceSignal {
  actions: RebalanceAction[];
  currentHoldings: string[];
}

// ─── Signal Storage ─────────────────────────────────────────────────────────

export interface SignalRun {
  runId: string;
  timestamp: string;
  regime: RegimeResult | null;
  rankings: RankingsSignal | null;
  rebalance: RebalanceSignal | null;
  meta: SignalMeta | null;
}

export interface SignalHistoryOptions {
  since?: string;       // ISO timestamp
  limit?: number;       // max runs (default 20)
  signalType?: "regime" | "rankings" | "rebalance" | "meta";
}

// ─── Retry ───────────────────────────────────────────────────────────────────

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
