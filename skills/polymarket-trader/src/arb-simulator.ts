// ─── Pre-Trade Monte Carlo Simulator for Pair Arbitrage ─────────────────────
//
// Runs N simulated execution paths BEFORE committing capital to estimate:
//   - Expected P&L after fees + slippage
//   - Probability that the pair completes (vs bailout)
//   - Worst-case scenario (5th percentile P&L)
//
// This is the PRE-TRADE GATE: only execute if simulated EV > threshold.
//
// Model assumptions:
//   - Leg 2 best ask follows a random walk around current level
//   - Each poll has a probability of the ask being within our window
//   - Slippage is sampled from empirical distribution based on order book depth
//   - Bailout sell slippage is modeled separately
//   - Fees are computed dynamically per the fee model
// ─────────────────────────────────────────────────────────────────────────────

import type { MonteCarloResult } from "quant-core";
import { computePairFees, computeTakerFee } from "./fees";
import { estimateSlippage, estimateSellSlippage } from "./slippage";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArbSimulationParams {
  /** Leg 1 limit price */
  leg1Price: number;
  /** Current best ask for leg 2 outcome */
  leg2BestAsk: number;
  /** Full ask-side order book for leg 2 (for slippage estimation) */
  leg2AskDepth: Array<{ price: string; size: string }>;
  /** Full bid-side order book for leg 1 (for bailout slippage) */
  bidDepth: Array<{ price: string; size: string }>;

  /** USDC amount per leg */
  amount: number;
  /** Target profit margin */
  margin: number;
  /** Hedge window timeout in ms */
  legTimeoutMs: number;
  /** Poll interval in ms */
  pollIntervalMs: number;

  /** Historical average fill time for leg 1 in ms (optional, improves accuracy) */
  historicalFillRateMs?: number;
  /** Historical bailout rate as fraction (optional, calibrates timeout model) */
  historicalBailoutRate?: number;

  /** Number of MC paths (default: 5000) */
  nPaths?: number;
}

export interface ArbSimulationResult {
  /** Expected P&L across all simulated paths */
  expectedPnl: number;
  /** Standard error of expected P&L */
  pnlStdError: number;
  /** Probability of positive P&L */
  profitProbability: number;
  /** Probability of timeout → bailout */
  bailoutProbability: number;

  /** Expected P&L given pair completes */
  expectedProfitIfComplete: number;
  /** Expected P&L given bailout */
  expectedLossIfBailout: number;

  /** 5th percentile P&L (worst case) */
  worstCaseScenario: number;
  /** 95th percentile P&L (best case) */
  bestCaseScenario: number;

  /** Trade recommendation */
  recommendation: "EXECUTE" | "SKIP" | "REDUCE_SIZE";
  /** Reason for recommendation */
  reason: string;

  /** Estimated total fees for the pair */
  estimatedFees: number;
  /** Estimated slippage cost */
  estimatedSlippage: number;

  /** Raw MC result */
  mc: MonteCarloResult;
}

// ─── Simulation Engine ──────────────────────────────────────────────────────

/**
 * Simulate N arbitrage execution paths to estimate expected value.
 *
 * Each path:
 *   1. Leg 1 fills at leg1Price (assumed — we're past the "should we enter" decision)
 *   2. During hedge window, leg 2 ask price follows random walk
 *   3. If ask drops within fee-adjusted window → pair completes with slippage
 *   4. If timeout → bailout sell with bid-side slippage
 *   5. P&L computed with fees for each path
 */
export function simulateArbitrage(params: ArbSimulationParams): ArbSimulationResult {
  const {
    leg1Price,
    leg2BestAsk,
    leg2AskDepth,
    bidDepth,
    amount,
    margin,
    legTimeoutMs,
    pollIntervalMs,
    nPaths = 5000,
  } = params;

  // Fee-adjusted max acceptable price for leg 2
  const leg1FeeRate = computeTakerFee(leg1Price, amount).feeRate;
  const estimatedP2 = 1.0 - leg1Price;
  const leg2FeeRate = computeTakerFee(estimatedP2, amount).feeRate;
  const netPairSum = 1.0 - leg1FeeRate - leg2FeeRate;
  const maxAcceptable = netPairSum - leg1Price - margin;

  // Estimate slippage from current order book
  const leg2Slippage = estimateSlippage(leg2AskDepth, amount);
  const bailoutSlippage = estimateSellSlippage(bidDepth, amount / leg1Price);

  // How many polls fit in the timeout window
  const maxPolls = Math.floor(legTimeoutMs / pollIntervalMs);

  // Estimate probability of ask being within window per poll
  // Based on: how far is current ask from our max acceptable price
  const currentGap = leg2BestAsk - maxAcceptable;
  // If gap <= 0, the current ask is already within our window (high fill prob)
  // If gap > 0, we need the ask to drop — lower probability per poll
  const askVolPerPoll = 0.005; // ~50bps price noise per poll interval
  const fillProbPerPoll = currentGap <= 0
    ? Math.min(0.95, 0.7 + 0.25 * Math.min(1, -currentGap / 0.01))
    : Math.max(0.02, Math.exp(-currentGap / (askVolPerPoll * 2)));

  // Run simulations
  const pnls: number[] = new Array(nPaths);
  let completions = 0;
  let bailouts = 0;
  let totalFees = 0;
  let totalSlippage = 0;

  let sumCompletePnl = 0;
  let sumBailoutPnl = 0;

  for (let i = 0; i < nPaths; i++) {
    let filled = false;

    // Simulate hedge window: each poll has independent fill probability
    for (let poll = 0; poll < maxPolls; poll++) {
      if (Math.random() < fillProbPerPoll) {
        filled = true;
        break;
      }
    }

    if (filled) {
      // Pair completes — compute P&L with fees and slippage
      const leg2Price = leg2Slippage.fullyFillable
        ? leg2Slippage.vwap + (Math.random() - 0.5) * askVolPerPoll
        : leg2BestAsk + Math.random() * 0.02;

      const clampedP2 = Math.max(0.01, Math.min(0.99, leg2Price));
      const { netPairSum: realNetPair, totalFees: pairFees } = computePairFees(leg1Price, clampedP2, amount);
      const leg1Size = amount / leg1Price;
      const leg2Size = amount / clampedP2;
      const minSize = Math.min(leg1Size, leg2Size);
      const pnl = realNetPair * minSize - (leg1Price * leg1Size) - (clampedP2 * leg2Size);

      pnls[i] = pnl;
      completions++;
      sumCompletePnl += pnl;
      totalFees += pairFees;
      totalSlippage += Math.max(0, clampedP2 - leg2BestAsk) * leg2Size;
    } else {
      // Bailout — sell leg 1 at bid with slippage
      const leg1Size = amount / leg1Price;
      const leg1Cost = amount;
      const sellPrice = bailoutSlippage.fullyFillable
        ? bailoutSlippage.vwap * (1 - Math.random() * 0.01)
        : (leg1Price - 0.02) * (1 - Math.random() * 0.02);

      const clampedSell = Math.max(0.01, sellPrice);
      const sellProceeds = clampedSell * leg1Size;
      const pnl = sellProceeds - leg1Cost;

      pnls[i] = pnl;
      bailouts++;
      sumBailoutPnl += pnl;
      totalSlippage += Math.max(0, leg1Price - clampedSell) * leg1Size;
    }
  }

  // Compute statistics
  const sum = pnls.reduce((a, b) => a + b, 0);
  const expectedPnl = sum / nPaths;
  const variance = pnls.reduce((s, p) => s + (p - expectedPnl) ** 2, 0) / nPaths;
  const stdError = Math.sqrt(variance / nPaths);

  const profitProbability = pnls.filter(p => p > 0).length / nPaths;
  const bailoutProbability = bailouts / nPaths;

  const expectedProfitIfComplete = completions > 0 ? sumCompletePnl / completions : 0;
  const expectedLossIfBailout = bailouts > 0 ? sumBailoutPnl / bailouts : 0;

  // Percentiles
  const sorted = [...pnls].sort((a, b) => a - b);
  const worstCaseScenario = sorted[Math.floor(nPaths * 0.05)];
  const bestCaseScenario = sorted[Math.floor(nPaths * 0.95)];

  // Decision logic
  let recommendation: ArbSimulationResult["recommendation"];
  let reason: string;

  if (expectedPnl <= 0) {
    recommendation = "SKIP";
    reason = `Negative expected P&L ($${expectedPnl.toFixed(4)}). Fees and slippage erode the spread.`;
  } else if (bailoutProbability > 0.6) {
    recommendation = "SKIP";
    reason = `High bailout probability (${(bailoutProbability * 100).toFixed(0)}%). ` +
             `Expected loss on bailout: $${expectedLossIfBailout.toFixed(4)}.`;
  } else if (worstCaseScenario < -amount * 0.1) {
    recommendation = "REDUCE_SIZE";
    reason = `Worst case (5th pct) loss of $${worstCaseScenario.toFixed(4)} exceeds 10% of amount. ` +
             `Consider reducing position size.`;
  } else if (profitProbability < 0.5) {
    recommendation = "SKIP";
    reason = `Profit probability ${(profitProbability * 100).toFixed(0)}% is below 50%.`;
  } else {
    recommendation = "EXECUTE";
    reason = `Expected P&L: $${expectedPnl.toFixed(4)}, profit probability: ${(profitProbability * 100).toFixed(0)}%, ` +
             `bailout rate: ${(bailoutProbability * 100).toFixed(0)}%.`;
  }

  return {
    expectedPnl: round4(expectedPnl),
    pnlStdError: round4(stdError),
    profitProbability: round4(profitProbability),
    bailoutProbability: round4(bailoutProbability),
    expectedProfitIfComplete: round4(expectedProfitIfComplete),
    expectedLossIfBailout: round4(expectedLossIfBailout),
    worstCaseScenario: round4(worstCaseScenario),
    bestCaseScenario: round4(bestCaseScenario),
    recommendation,
    reason,
    estimatedFees: round4(totalFees / nPaths),
    estimatedSlippage: round4(totalSlippage / nPaths),
    mc: {
      estimate: round4(expectedPnl),
      stdError: round4(stdError),
      ci95: [round4(expectedPnl - 1.96 * stdError), round4(expectedPnl + 1.96 * stdError)],
      nPaths,
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
