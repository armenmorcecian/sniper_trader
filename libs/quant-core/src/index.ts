// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  PriceBar,
  Regime,
  RegimeResult,
  SectorMomentum,
  RebalanceAction,
  PositionSummary,
  SignalMeta,
  RankingsSignal,
  RebalanceSignal,
  RetryConfig,
} from "./types";

// ─── Constants ───────────────────────────────────────────────────────────────
export { SECTOR_UNIVERSE, ETF_WATCHLIST, CORRELATION_THRESHOLD } from "./constants";

// ─── Math Helpers ────────────────────────────────────────────────────────────
export { round, calculateDailyReturns, pearsonCorrelation } from "./math";

// ─── Momentum ────────────────────────────────────────────────────────────────
export { compositeMomentum, atrMetrics, riskParityWeights } from "./momentum";

// ─── Regime Detection ────────────────────────────────────────────────────────
export { calculateRegime } from "./regime";

// ─── Momentum Ranking ────────────────────────────────────────────────────────
export { rankSectorMomentum } from "./ranking";

// ─── Rebalance ───────────────────────────────────────────────────────────────
export { generateRebalanceActions } from "./rebalance";

// ─── Retry ───────────────────────────────────────────────────────────────────
export { withRetry, isRetryable } from "./retry";

// ─── Validation ─────────────────────────────────────────────────────────────
export { validateBars } from "./validation";

// ─── Circuit Breaker ────────────────────────────────────────────────────────
export { checkCircuitBreaker, checkConcentration } from "./circuit-breaker";
export type { CircuitBreakerConfig, CircuitBreakerResult, ConcentrationResult } from "./circuit-breaker";

// ─── API Health ─────────────────────────────────────────────────────────────
export {
  recordApiSuccess,
  recordApiFailure,
  isApiAvailable,
  getApiHealth,
  resetApiHealth,
  resetAllApiHealth,
} from "./api-health";
export type { ApiHealthState } from "./api-health";

// ─── Trade Journal ──────────────────────────────────────────────────────────
export {
  recordTrade,
  upsertDailySummary,
  queryTrades,
  getDailySummary,
  getTradesToday,
  getRealizedPnlToday,
  getDb,
} from "./journal";
export type { TradeEntry, DailySummaryEntry, JournalQueryOptions } from "./journal";

// ─── Equity Snapshots ──────────────────────────────────────────────────────
export { recordEquitySnapshot, getEquitySnapshots } from "./journal";
export type { EquitySnapshot } from "./journal";

// ─── Tool Call Logging ─────────────────────────────────────────────────────
export { recordToolCall, queryToolCalls } from "./journal";
export type { ToolCallEntry } from "./journal";

// ─── Trade Exit Tracking ───────────────────────────────────────────────────
export { updateTradeExit } from "./journal";

// ─── Signal Storage ──────────────────────────────────────────────────────────
export { writeSignals, readLatestSignals, querySignalHistory } from "./signals";
export type { SignalRun, SignalHistoryOptions } from "./types";

// ─── Performance Tracker ───────────────────────────────────────────────────
export { computeSharpe, computeMaxDrawdown, computeProfitFactor, getPerformanceMetrics } from "./performance";
export type { PerformanceMetrics } from "./performance";

// ─── Backtest ──────────────────────────────────────────────────────────────
export { runBacktest } from "./backtest";
export type { BacktestConfig, BacktestResult, BacktestRebalanceEntry } from "./backtest";

// ─── Risk Alerts ────────────────────────────────────────────────────────────
export {
  insertRiskAlert, getActiveAlerts, isTradingBlocked,
  resolveAlert, resolveAlertsByType, cleanExpiredAlerts,
} from "./risk-alerts";
export type { RiskAlert, TradingBlockStatus, ActiveAlertOptions } from "./risk-alerts";
