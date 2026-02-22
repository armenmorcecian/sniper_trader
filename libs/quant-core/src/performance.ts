// ─── Performance Tracker ────────────────────────────────────────────────────
// Pure computation functions for Sharpe ratio, max drawdown, win rate,
// profit factor. DB-backed getPerformanceMetrics() aggregates from journal.

import { queryTrades, getEquitySnapshots } from "./journal";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PerformanceMetrics {
  period: string;
  startDate: string;
  endDate: string;
  skill: "alpaca" | "polymarket" | "all";
  startingEquity: number;
  endingEquity: number;
  netReturn: number;
  sharpeRatio: number | null;
  maxDrawdown: number;
  maxDrawdownPeak: number;
  maxDrawdownTrough: number;
  winRate: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  tradesCount: number;
  wins: number;
  losses: number;
  bestTrade: { symbol?: string; pnl: number } | null;
  worstTrade: { symbol?: string; pnl: number } | null;
}

// ─── Pure Math Functions ────────────────────────────────────────────────────

/**
 * Annualized Sharpe ratio from daily returns (risk-free rate = 0).
 * Returns null if fewer than 2 data points or zero standard deviation.
 */
export function computeSharpe(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 2) return null;

  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stddev = Math.sqrt(variance);

  if (stddev === 0) return null;

  // Annualize: multiply by sqrt(252 trading days)
  return Math.round((mean / stddev) * Math.sqrt(252) * 100) / 100;
}

/**
 * Max drawdown from an equity curve (array of equity values).
 * Returns { maxDrawdownPercent (negative), peakValue, troughValue }.
 * Returns 0 drawdown for monotonically increasing curves or empty input.
 */
export function computeMaxDrawdown(
  equityCurve: number[],
): { maxDrawdownPercent: number; peakValue: number; troughValue: number } {
  if (equityCurve.length < 2) {
    return { maxDrawdownPercent: 0, peakValue: equityCurve[0] || 0, troughValue: equityCurve[0] || 0 };
  }

  let peak = equityCurve[0];
  let maxDd = 0;
  let ddPeak = peak;
  let ddTrough = peak;

  for (const equity of equityCurve) {
    if (equity > peak) {
      peak = equity;
    }
    const dd = (equity - peak) / peak;
    if (dd < maxDd) {
      maxDd = dd;
      ddPeak = peak;
      ddTrough = equity;
    }
  }

  return {
    maxDrawdownPercent: Math.round(maxDd * 10000) / 100,
    peakValue: ddPeak,
    troughValue: ddTrough,
  };
}

/**
 * Profit factor = gross wins / |gross losses|.
 * Returns null if there are no losing trades (infinite profit factor).
 */
export function computeProfitFactor(pnls: number[]): number | null {
  let grossWins = 0;
  let grossLosses = 0;

  for (const pnl of pnls) {
    if (pnl > 0) grossWins += pnl;
    else if (pnl < 0) grossLosses += Math.abs(pnl);
  }

  if (grossLosses === 0) return grossWins > 0 ? null : null;
  return Math.round((grossWins / grossLosses) * 100) / 100;
}

// ─── DB-backed Metrics ──────────────────────────────────────────────────────

/**
 * Compute comprehensive performance metrics from the trade journal + equity snapshots.
 */
export function getPerformanceMetrics(
  opts?: { skill?: "alpaca" | "polymarket" | "all"; period?: string; startDate?: string; endDate?: string },
  dbPath?: string,
): PerformanceMetrics {
  const skill = opts?.skill || "all";
  const period = opts?.period || "weekly";
  const now = new Date();

  // Compute date range from period
  let startDate: string;
  let endDate: string = now.toISOString();

  if (opts?.startDate && opts?.endDate) {
    startDate = opts.startDate;
    endDate = opts.endDate;
  } else {
    switch (period) {
      case "daily":
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        break;
      case "weekly":
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case "monthly":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        break;
      case "all-time":
        startDate = "2000-01-01T00:00:00Z";
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  // Query trades with pnl for win/loss stats
  const skillFilter = skill === "all" ? undefined : skill;
  const trades = queryTrades(
    { skill: skillFilter, since: startDate, limit: 10000 },
    dbPath,
  );

  const tradesWithPnl = trades.filter(t => t.pnl != null);
  const pnls = tradesWithPnl.map(t => t.pnl!);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);

  const winRate = tradesWithPnl.length > 0
    ? Math.round((wins.length / tradesWithPnl.length) * 10000) / 100
    : 0;

  const avgWin = wins.length > 0
    ? Math.round((wins.reduce((s, p) => s + p, 0) / wins.length) * 100) / 100
    : 0;
  const avgLoss = losses.length > 0
    ? Math.round((losses.reduce((s, p) => s + p, 0) / losses.length) * 100) / 100
    : 0;

  const profitFactor = pnls.length > 0 ? computeProfitFactor(pnls) : null;

  // Best/worst trades
  let bestTrade: PerformanceMetrics["bestTrade"] = null;
  let worstTrade: PerformanceMetrics["worstTrade"] = null;

  if (tradesWithPnl.length > 0) {
    const sorted = [...tradesWithPnl].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    bestTrade = { symbol: best.symbol || best.conditionId, pnl: best.pnl! };
    worstTrade = { symbol: worst.symbol || worst.conditionId, pnl: worst.pnl! };
  }

  // Query equity snapshots for equity curve
  const equitySkill = skill === "all" ? "alpaca" : skill;
  const snapshots = getEquitySnapshots(equitySkill, startDate, 10000, dbPath);

  const equityCurve = snapshots.map(s => s.equity);
  const startingEquity = equityCurve.length > 0 ? equityCurve[0] : 0;
  const endingEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1] : 0;

  const netReturn = startingEquity > 0
    ? Math.round(((endingEquity - startingEquity) / startingEquity) * 10000) / 100
    : 0;

  // Compute daily returns from equity curve for Sharpe
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i - 1] > 0) {
      dailyReturns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
    }
  }

  const sharpeRatio = computeSharpe(dailyReturns);
  const drawdown = computeMaxDrawdown(equityCurve);

  return {
    period,
    startDate,
    endDate,
    skill,
    startingEquity,
    endingEquity,
    netReturn,
    sharpeRatio,
    maxDrawdown: drawdown.maxDrawdownPercent,
    maxDrawdownPeak: drawdown.peakValue,
    maxDrawdownTrough: drawdown.troughValue,
    winRate,
    profitFactor,
    avgWin,
    avgLoss,
    tradesCount: tradesWithPnl.length,
    wins: wins.length,
    losses: losses.length,
    bestTrade,
    worstTrade,
  };
}
