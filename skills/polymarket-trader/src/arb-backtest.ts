// ─── Agent-Based Market Simulator + Arbitrage Backtesting ───────────────────
//
// Simulates a Polymarket order book populated by heterogeneous agents:
//   - Informed traders: know true probability, trade toward it
//   - Noise traders: random buy/sell
//   - Market makers: provide liquidity around current price
//
// Uses the ABM to generate synthetic order book dynamics and tests the
// arbitrage strategy against them. This enables parameter optimization
// (timeout, margin, poll interval) without risking capital.
//
// Key insight from Gode & Sunder (1993): even zero-intelligence traders
// achieve near-100% allocative efficiency in a continuous double auction.
// The ABM captures emergent dynamics that no closed-form model can.
// ─────────────────────────────────────────────────────────────────────────────

import { computeSharpe, computeMaxDrawdown } from "quant-core";
import { computePairFees } from "./fees";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ABMConfig {
  /** True resolution probability (hidden from agents initially) */
  trueProb: number;
  /** Number of informed traders (default: 10) */
  nInformed: number;
  /** Number of noise traders (default: 50) */
  nNoise: number;
  /** Number of market makers (default: 5) */
  nMM: number;
  /** Number of simulation steps (default: 2000) */
  nSteps: number;
  /** Starting market price (default: 0.50) */
  initialPrice: number;
}

export interface ABMResult {
  /** Full price history */
  priceHistory: number[];
  /** Final market price */
  finalPrice: number;
  /** |finalPrice - trueProb| */
  convergenceError: number;
  /** Total trading volume */
  totalVolume: number;
  /** P&L of informed traders */
  informedPnl: number;
  /** P&L of noise traders */
  noisePnl: number;
}

export interface ArbBacktestConfig {
  /** USDC per leg */
  amount: number;
  /** Target profit margin */
  margin: number;
  /** Hedge window timeout ms */
  legTimeoutMs: number;
  /** Poll interval ms */
  pollIntervalMs: number;
  /** ABM configuration */
  abm: Partial<ABMConfig>;
  /** Number of arbitrage trials (default: 100) */
  nTrials: number;
}

export interface ArbBacktestResult {
  /** Total arbitrage attempts */
  nTrials: number;
  /** Pairs that completed */
  completed: number;
  /** Bailouts triggered */
  bailed: number;
  /** Completion rate */
  completionRate: number;
  /** Average P&L on completed pairs */
  avgPnlCompleted: number;
  /** Average P&L on bailouts */
  avgPnlBailout: number;
  /** Total P&L across all trials */
  totalPnl: number;
  /** Annualized Sharpe ratio */
  sharpeRatio: number | null;
  /** Maximum drawdown percentage */
  maxDrawdown: number;
  /** Win rate */
  winRate: number;
}

// ─── Agent-Based Model ──────────────────────────────────────────────────────

const DEFAULT_ABM: ABMConfig = {
  trueProb: 0.60,
  nInformed: 10,
  nNoise: 50,
  nMM: 5,
  nSteps: 2000,
  initialPrice: 0.50,
};

export class PredictionMarketABM {
  private config: ABMConfig;
  private price: number;
  private priceHistory: number[];
  private bestBid: number;
  private bestAsk: number;
  private volume: number;
  private informedPnl: number;
  private noisePnl: number;

  constructor(config?: Partial<ABMConfig>) {
    this.config = { ...DEFAULT_ABM, ...config };
    this.price = this.config.initialPrice;
    this.priceHistory = [this.price];
    this.bestBid = this.price - 0.01;
    this.bestAsk = this.price + 0.01;
    this.volume = 0;
    this.informedPnl = 0;
    this.noisePnl = 0;
  }

  /** Execute one time step: randomly select an agent to trade */
  step(): void {
    const { nInformed, nNoise, nMM } = this.config;
    const total = nInformed + nNoise + nMM;
    const r = Math.random() * total;

    if (r < nInformed) {
      this.informedTrade();
    } else if (r < nInformed + nNoise) {
      this.noiseTrade();
    } else {
      this.mmUpdate();
    }

    this.priceHistory.push(this.price);
  }

  /** Run N steps and return price history */
  run(nSteps?: number): number[] {
    const steps = nSteps || this.config.nSteps;
    for (let i = 0; i < steps; i++) {
      this.step();
    }
    return [...this.priceHistory];
  }

  /** Get simulation results */
  getResults(): ABMResult {
    return {
      priceHistory: [...this.priceHistory],
      finalPrice: Math.round(this.price * 10000) / 10000,
      convergenceError: Math.round(Math.abs(this.price - this.config.trueProb) * 10000) / 10000,
      totalVolume: Math.round(this.volume * 100) / 100,
      informedPnl: Math.round(this.informedPnl * 100) / 100,
      noisePnl: Math.round(this.noisePnl * 100) / 100,
    };
  }

  /** Get current synthetic order book for arbitrage simulation */
  getOrderBook(): {
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
  } {
    // Generate a synthetic 5-level book around current price
    const spread = this.bestAsk - this.bestBid;
    const bids: Array<{ price: string; size: string }> = [];
    const asks: Array<{ price: string; size: string }> = [];

    for (let i = 0; i < 5; i++) {
      const bidPrice = Math.max(0.01, this.bestBid - i * (spread * 0.5));
      const askPrice = Math.min(0.99, this.bestAsk + i * (spread * 0.5));
      const bidSize = 50 + Math.random() * 200; // 50-250 tokens
      const askSize = 50 + Math.random() * 200;

      bids.push({ price: bidPrice.toFixed(4), size: bidSize.toFixed(2) });
      asks.push({ price: askPrice.toFixed(4), size: askSize.toFixed(2) });
    }

    return { bids, asks };
  }

  // ─── Private Agent Behaviors ──────────────────────────────────────────────

  private informedTrade(): void {
    const signal = this.config.trueProb + (Math.random() - 0.5) * 0.04;

    if (signal > this.bestAsk + 0.01) {
      const size = Math.min(0.1, Math.abs(signal - this.price) * 2);
      this.price += size * this.kyleLambda();
      this.volume += size;
      this.informedPnl += (this.config.trueProb - this.bestAsk) * size;
    } else if (signal < this.bestBid - 0.01) {
      const size = Math.min(0.1, Math.abs(this.price - signal) * 2);
      this.price -= size * this.kyleLambda();
      this.volume += size;
      this.informedPnl += (this.bestBid - this.config.trueProb) * size;
    }

    this.price = Math.max(0.01, Math.min(0.99, this.price));
    this.updateBook();
  }

  private noiseTrade(): void {
    const direction = Math.random() < 0.5 ? -1 : 1;
    const size = -Math.log(Math.random()) * 0.02; // Exponential(0.02)
    this.price += direction * size * this.kyleLambda();
    this.price = Math.max(0.01, Math.min(0.99, this.price));
    this.volume += size;
    this.noisePnl -= Math.abs(this.price - this.config.trueProb) * size * 0.5;
    this.updateBook();
  }

  private mmUpdate(): void {
    const spread = Math.max(0.02, 0.05 * (1 - Math.min(1, this.volume / 100)));
    this.bestBid = this.price - spread / 2;
    this.bestAsk = this.price + spread / 2;
  }

  private kyleLambda(): number {
    const sigmaV = Math.abs(this.config.trueProb - this.price) + 0.05;
    const sigmaU = 0.1 * Math.sqrt(this.config.nNoise);
    return sigmaV / (2 * sigmaU);
  }

  private updateBook(): void {
    const spread = this.bestAsk - this.bestBid;
    this.bestBid = this.price - spread / 2;
    this.bestAsk = this.price + spread / 2;
  }
}

// ─── Backtest Runner ────────────────────────────────────────────────────────

/**
 * Run N arbitrage attempts against ABM-generated order book dynamics.
 *
 * For each trial:
 *   1. Run ABM to generate a price path + synthetic order book
 *   2. Sample a random point in the path where Yes+No prices sum < 1.00
 *   3. Simulate the hedge window with ABM-driven price evolution
 *   4. Record outcome (complete/bailout) and P&L
 */
export function backtestArbitrage(config: ArbBacktestConfig): ArbBacktestResult {
  const { amount, margin, legTimeoutMs, pollIntervalMs, nTrials } = config;

  const pnls: number[] = [];
  let completed = 0;
  let bailed = 0;
  let sumCompletePnl = 0;
  let sumBailoutPnl = 0;

  // Simulate each trial
  for (let trial = 0; trial < nTrials; trial++) {
    // Create a fresh ABM for this trial
    const abm = new PredictionMarketABM(config.abm);
    // Run ABM for a while to establish a market
    const prices = abm.run(500);

    // Current "Yes" price from ABM
    const yesPrice = prices[prices.length - 1];
    const noPrice = 1 - yesPrice;
    const pairSum = yesPrice + noPrice; // Should be ~1.0 but noise may differ

    // Check if there's an arbitrage opportunity
    const adjustedMaxPrice = 1.0 - yesPrice - margin;
    if (adjustedMaxPrice <= 0 || noPrice > adjustedMaxPrice) {
      // No opportunity at this price point — skip
      continue;
    }

    // Simulate hedge window
    const maxPolls = Math.floor(legTimeoutMs / pollIntervalMs);
    let pairCompleted = false;
    let leg2FillPrice = 0;

    for (let poll = 0; poll < maxPolls; poll++) {
      // ABM evolves the price each poll
      abm.step();
      const currentNoPrice = 1 - prices[prices.length - 1 + poll] || noPrice;
      const { netPairSum } = computePairFees(yesPrice, currentNoPrice, amount);
      const feeAdjustedMax = netPairSum - yesPrice - margin;

      if (currentNoPrice <= feeAdjustedMax) {
        pairCompleted = true;
        leg2FillPrice = currentNoPrice;
        break;
      }
    }

    if (pairCompleted) {
      // Compute fee-adjusted P&L
      const { netPairSum } = computePairFees(yesPrice, leg2FillPrice, amount);
      const leg1Size = amount / yesPrice;
      const leg2Size = amount / leg2FillPrice;
      const minSize = Math.min(leg1Size, leg2Size);
      const pnl = netPairSum * minSize - amount - (leg2FillPrice * leg2Size);
      pnls.push(pnl);
      completed++;
      sumCompletePnl += pnl;
    } else {
      // Bailout: sell Yes at bid with ~1% slippage
      const sellPrice = yesPrice * (1 - 0.005 - Math.random() * 0.01);
      const leg1Size = amount / yesPrice;
      const sellProceeds = sellPrice * leg1Size;
      const pnl = sellProceeds - amount;
      pnls.push(pnl);
      bailed++;
      sumBailoutPnl += pnl;
    }
  }

  const totalTrials = completed + bailed;
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const wins = pnls.filter(p => p > 0).length;

  // Equity curve for Sharpe/drawdown
  const equityCurve: number[] = [1000]; // Start with $1000
  for (const pnl of pnls) {
    equityCurve.push(equityCurve[equityCurve.length - 1] + pnl);
  }

  const dailyReturns = pnls.map(p => p / amount);
  const sharpeRatio = computeSharpe(dailyReturns);
  const { maxDrawdownPercent } = computeMaxDrawdown(equityCurve);

  return {
    nTrials: totalTrials,
    completed,
    bailed,
    completionRate: totalTrials > 0 ? Math.round((completed / totalTrials) * 10000) / 10000 : 0,
    avgPnlCompleted: completed > 0 ? Math.round((sumCompletePnl / completed) * 10000) / 10000 : 0,
    avgPnlBailout: bailed > 0 ? Math.round((sumBailoutPnl / bailed) * 10000) / 10000 : 0,
    totalPnl: Math.round(totalPnl * 10000) / 10000,
    sharpeRatio,
    maxDrawdown: maxDrawdownPercent,
    winRate: totalTrials > 0 ? Math.round((wins / totalTrials) * 10000) / 10000 : 0,
  };
}
