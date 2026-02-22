// ─── Backtest Engine ────────────────────────────────────────────────────────
// Replays historical bars through the existing pure quant functions.
// Limitations: no slippage model, no partial fills, no intraday movement.

import type { PriceBar, RebalanceAction } from "./types";
import { SECTOR_UNIVERSE } from "./constants";
import { round } from "./math";
import { calculateRegime } from "./regime";
import { rankSectorMomentum } from "./ranking";
import { generateRebalanceActions } from "./rebalance";
import { computeSharpe, computeMaxDrawdown, computeProfitFactor } from "./performance";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BacktestConfig {
  startingCapital: number;
  rebalanceFrequency: number;  // days between rebalances
  positionCount: number;       // how many top sectors to hold
  stopLossPercent: number;     // e.g. -7
  commissionPerTrade: number;  // e.g. 0
  slippageBps?: number;        // basis points per trade (default 0 for backward compat)
}

export interface BacktestRebalanceEntry {
  date: string;
  actions: RebalanceAction[];
  holdings: string[];
  equity: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  startDate: string;
  endDate: string;
  tradingDays: number;
  finalEquity: number;
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number | null;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number | null;
  totalTrades: number;
  equityCurve: { date: string; equity: number }[];
  rebalanceLog: BacktestRebalanceEntry[];
}

// ─── Internal position tracker ──────────────────────────────────────────────

interface Position {
  symbol: string;
  shares: number;
  entryPrice: number;
}

// ─── Main Backtest Function ─────────────────────────────────────────────────

/**
 * Run a backtest over historical multi-symbol bars.
 * Requires at least 201 bars per symbol (200 for SMA200 lookback + 1 trading day).
 */
export function runBacktest(
  multiBars: Record<string, PriceBar[]>,
  config: BacktestConfig,
): BacktestResult {
  const spyBars = multiBars["SPY"];
  if (!spyBars || spyBars.length < 201) {
    throw new Error(`Need 201+ SPY bars for backtest, got ${spyBars?.length ?? 0}`);
  }

  // Determine sector symbols available in the data
  const sectorSymbols = SECTOR_UNIVERSE.filter(s => {
    const bars = multiBars[s];
    return bars && bars.length >= 201;
  });

  if (sectorSymbols.length < 3) {
    throw new Error(`Need at least 3 sector ETFs with 201+ bars, got ${sectorSymbols.length}`);
  }

  const slippageFraction = (config.slippageBps ?? 0) / 10000;

  let cash = config.startingCapital;
  const positions: Map<string, Position> = new Map();
  const equityCurve: { date: string; equity: number }[] = [];
  const rebalanceLog: BacktestRebalanceEntry[] = [];
  const tradePnls: number[] = [];
  let daysSinceRebalance = config.rebalanceFrequency; // trigger on first eligible day
  let totalTrades = 0;

  // Start at bar 200 (index 200 = bar 201, enough lookback for SMA200)
  const startIdx = 200;
  const endIdx = spyBars.length;

  for (let i = startIdx; i < endIdx; i++) {
    const date = spyBars[i].timestamp;

    // 1. Mark-to-market: compute current equity
    let positionsValue = 0;
    for (const [symbol, pos] of positions) {
      const bars = multiBars[symbol];
      if (bars && bars[i]) {
        positionsValue += pos.shares * bars[i].close;
      }
    }
    const equity = cash + positionsValue;
    equityCurve.push({ date, equity: round(equity) });

    // 2. Check stop-losses
    const toClose: string[] = [];
    for (const [symbol, pos] of positions) {
      const bars = multiBars[symbol];
      if (!bars || !bars[i]) continue;
      const currentPrice = bars[i].close;
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      if (pnlPct <= config.stopLossPercent) {
        toClose.push(symbol);
      }
    }

    for (const symbol of toClose) {
      const pos = positions.get(symbol)!;
      const bars = multiBars[symbol]!;
      const exitPrice = bars[i].close * (1 - slippageFraction);
      const pnl = (exitPrice - pos.entryPrice) * pos.shares - config.commissionPerTrade;
      tradePnls.push(pnl);
      cash += pos.shares * exitPrice - config.commissionPerTrade;
      positions.delete(symbol);
      totalTrades++;
    }

    // 3. Check rebalance
    daysSinceRebalance++;
    if (daysSinceRebalance >= config.rebalanceFrequency) {
      daysSinceRebalance = 0;

      // Slice bars up to current index (inclusive) for lookback
      const slicedMultiBars: Record<string, PriceBar[]> = {};
      for (const sym of ["SPY", ...sectorSymbols]) {
        const bars = multiBars[sym];
        if (bars) {
          slicedMultiBars[sym] = bars.slice(0, i + 1);
        }
      }

      const slicedSpyBars = slicedMultiBars["SPY"];
      if (!slicedSpyBars || slicedSpyBars.length < 200) continue;

      // Build sector bars for regime breadth
      const sectorBarsForRegime: Record<string, PriceBar[]> = {};
      for (const sym of sectorSymbols) {
        if (slicedMultiBars[sym]) sectorBarsForRegime[sym] = slicedMultiBars[sym];
      }

      try {
        const regime = calculateRegime(slicedSpyBars, sectorBarsForRegime);
        const rankings = rankSectorMomentum(slicedMultiBars, sectorSymbols);
        const currentHoldings = [...positions.keys()];
        const actions = generateRebalanceActions(regime, rankings, currentHoldings, slicedMultiBars);

        // Execute sells first
        for (const action of actions) {
          if (action.action === "sell" && positions.has(action.symbol)) {
            const pos = positions.get(action.symbol)!;
            const bars = multiBars[action.symbol];
            if (!bars || !bars[i]) continue;
            const exitPrice = bars[i].close * (1 - slippageFraction);
            const pnl = (exitPrice - pos.entryPrice) * pos.shares - config.commissionPerTrade;
            tradePnls.push(pnl);
            cash += pos.shares * exitPrice - config.commissionPerTrade;
            positions.delete(action.symbol);
            totalTrades++;
          }
        }

        // Execute buys
        const buyActions = actions.filter(a => a.action === "buy");
        if (buyActions.length > 0) {
          const currentEquity = cash + [...positions.values()].reduce((s, p) => {
            const bars = multiBars[p.symbol];
            return s + (bars && bars[i] ? p.shares * bars[i].close : 0);
          }, 0);

          // Limit buys to positionCount
          const buysToExecute = buyActions.slice(0, Math.max(0, config.positionCount - positions.size));

          for (const action of buysToExecute) {
            const weight = (action as { targetWeight?: number }).targetWeight || (1 / config.positionCount);
            const allocationAmount = currentEquity * weight;
            const bars = multiBars[action.symbol];
            if (!bars || !bars[i]) continue;
            const price = bars[i].close * (1 + slippageFraction);
            const shares = Math.floor((allocationAmount - config.commissionPerTrade) / price * 100) / 100; // fractional
            if (shares <= 0) continue;

            cash -= shares * price + config.commissionPerTrade;
            positions.set(action.symbol, { symbol: action.symbol, shares, entryPrice: price });
            totalTrades++;
          }
        }

        rebalanceLog.push({
          date,
          actions,
          holdings: [...positions.keys()],
          equity: round(cash + [...positions.values()].reduce((s, p) => {
            const bars = multiBars[p.symbol];
            return s + (bars && bars[i] ? p.shares * bars[i].close : 0);
          }, 0)),
        });
      } catch {
        // Skip rebalance if regime calculation fails (e.g., insufficient bars in slice)
      }
    }
  }

  // Final equity
  const lastEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : config.startingCapital;
  const totalReturn = round(((lastEquity - config.startingCapital) / config.startingCapital) * 100);
  const tradingDays = equityCurve.length;

  // Annualized return
  const years = tradingDays / 252;
  const annualizedReturn = years > 0
    ? round((Math.pow(lastEquity / config.startingCapital, 1 / years) - 1) * 100)
    : 0;

  // Compute daily returns for Sharpe
  const equityValues = equityCurve.map(e => e.equity);
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityValues.length; i++) {
    if (equityValues[i - 1] > 0) {
      dailyReturns.push((equityValues[i] - equityValues[i - 1]) / equityValues[i - 1]);
    }
  }

  const sharpeRatio = computeSharpe(dailyReturns);
  const drawdown = computeMaxDrawdown(equityValues);
  const profitFactor = tradePnls.length > 0 ? computeProfitFactor(tradePnls) : null;

  const wins = tradePnls.filter(p => p > 0).length;
  const losses = tradePnls.filter(p => p < 0).length;
  const winRate = tradePnls.length > 0 ? round((wins / tradePnls.length) * 100) : 0;

  return {
    config,
    startDate: spyBars[startIdx].timestamp,
    endDate: spyBars[endIdx - 1].timestamp,
    tradingDays,
    finalEquity: round(lastEquity),
    totalReturn,
    annualizedReturn,
    sharpeRatio,
    maxDrawdown: drawdown.maxDrawdownPercent,
    winRate,
    profitFactor,
    totalTrades,
    equityCurve,
    rebalanceLog,
  };
}
