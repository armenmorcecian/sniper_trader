# Polymarket Simulation Stack — Full Implementation Plan

## Executive Summary

Add a production-grade simulation engine to the Polymarket arbitrage system. This transforms the current "trade blind" approach into a quantitative framework with fee-aware P&L, pre-trade Monte Carlo simulation, order book slippage modeling, real-time particle filtering, agent-based backtesting, copula-based portfolio correlation, and Brier score calibration tracking.

## Architecture Decision: What Goes Where

| Module | Location | Reason |
|--------|----------|--------|
| Monte Carlo engine, particle filter, copula models, Brier score | `libs/quant-core/src/` | Shared quant logic — reusable across skills, unit-testable with Vitest |
| Fee model, slippage model, arb simulator | `skills/polymarket-trader/src/` | Polymarket-specific, depends on CLOB order book format |
| New agent tools | `skills/polymarket-trader/src/polymarket.skill.ts` | Follows existing tool registration pattern |

## Phase 1: Fee-Aware P&L (CRITICAL — fixes a live bug)

### Problem
`arbitrage.ts:15` hardcodes `PAIR_SUM = 1.0`. Polymarket charges dynamic taker fees on 15-minute crypto markets. Current P&L calculation (`1.00 - P1 - P2`) **overestimates profit** and may execute negative-EV trades.

### New File: `skills/polymarket-trader/src/fees.ts`

```typescript
// Dynamic taker fee model for Polymarket
// Fee scales inversely with market certainty:
//   - Peak ~3.15% at p=0.50 (maximum uncertainty)
//   - Decline toward 0% as p→0 or p→1 (high certainty)
//
// Formula: fee(p) = baseFeeRate * 2 * p * (1 - p)
// where baseFeeRate ≈ 0.063 (calibrated so peak = ~3.15% at p=0.50)

export interface FeeEstimate {
  feeRate: number;      // Percentage fee (e.g., 0.0315 = 3.15%)
  feeAmount: number;    // Absolute fee for given notional
  effectivePrice: number; // Price + fee
}

export function computeTakerFee(price: number, notional: number, marketType?: string): FeeEstimate;
export function computePairFees(p1: number, p2: number, notional: number): {
  leg1Fee: FeeEstimate;
  leg2Fee: FeeEstimate;
  totalFees: number;
  netPairSum: number; // 1.00 minus total fees — the REAL redemption value
};
export function feeAdjustedMaxAcceptable(p1Filled: number, margin: number, notional: number): number;
```

### Modifications to: `skills/polymarket-trader/src/arbitrage.ts`

1. **Replace** `const PAIR_SUM = 1.0` with fee-adjusted calculation:
   ```typescript
   import { computePairFees, feeAdjustedMaxAcceptable } from "./fees";
   // Remove: const PAIR_SUM = 1.0;
   ```

2. **Update** `maxAcceptablePrice` computation (line 77):
   ```typescript
   // OLD: const maxAcceptablePrice = PAIR_SUM - firstLegPrice - margin;
   const maxAcceptablePrice = feeAdjustedMaxAcceptable(firstLegPrice, margin, amount);
   ```

3. **Update** `dynamicMaxPrice` computation (line 192):
   ```typescript
   // OLD: const dynamicMaxPrice = PAIR_SUM - pFilled - margin;
   const dynamicMaxPrice = feeAdjustedMaxAcceptable(pFilled, margin, amount);
   ```

4. **Update** `calculateNetPnl()` (lines 345-369):
   ```typescript
   // Include fee costs in P&L calculation
   const { totalFees, netPairSum } = computePairFees(leg1.price, leg2.price, leg1.size);
   return Math.round((netPairSum * minSize - leg1Cost - leg2Cost) * 10000) / 10000;
   ```

5. **Update** locked spread log message (line 245):
   ```typescript
   const { netPairSum } = computePairFees(pFilled, bestAsk, leg1.size);
   const lockedSpread = netPairSum - pFilled - bestAsk;
   ```

### Tests: `libs/quant-core/src/__tests__/` — N/A (fee model is Polymarket-specific)

We'll add tests in Phase 5 as part of the arb simulator test suite if we add a `__tests__/` directory to polymarket-trader.

---

## Phase 2: Order Book Slippage Model

### Problem
`arbitrage.ts:239` uses `bestAsk` (top of book) as the fill price. For larger FOK orders, the actual fill "walks the book" — eating through multiple price levels. We're underestimating execution cost.

### New File: `skills/polymarket-trader/src/slippage.ts`

```typescript
// Walk the order book to estimate volume-weighted average fill price
// for a given order size. Returns Infinity if insufficient liquidity.

interface OrderBookLevel {
  price: string;
  size: string;
}

export interface SlippageEstimate {
  vwap: number;               // Volume-weighted average fill price
  bestPrice: number;          // Top of book (best case)
  worstPrice: number;         // Deepest level touched
  slippageBps: number;        // Slippage in basis points vs best price
  levelsTouched: number;      // How many price levels consumed
  fullyFillable: boolean;     // Whether the book has enough depth
  remainingSize: number;      // Unfilled size if book is thin
}

export function estimateSlippage(
  asks: OrderBookLevel[],
  orderSizeUsd: number,
): SlippageEstimate;

// For sell-side (bailout) — walk bids
export function estimateSellSlippage(
  bids: OrderBookLevel[],
  orderSizeTokens: number,
): SlippageEstimate;
```

### Modifications to: `skills/polymarket-trader/src/arbitrage.ts`

1. **Import** slippage model
2. **Before** placing leg 2 FOK (line 228), estimate actual fill price:
   ```typescript
   const slippage = estimateSlippage(orderBook.asks, amount);
   if (!slippage.fullyFillable || slippage.vwap > dynamicMaxPrice) continue;
   // Use slippage.vwap instead of bestAsk for P&L calculation
   ```
3. **Before** bailout sell (line 308), estimate sell slippage:
   ```typescript
   const sellSlippage = estimateSellSlippage(orderBook.bids, leg1.size);
   // Log expected vs actual bailout cost
   ```

---

## Phase 3: Pre-Trade Monte Carlo Simulation

### Problem
The arbitrage engine executes blind — no probabilistic assessment of whether a trade will succeed before committing capital. We need to simulate the execution path to estimate EV and gate low-quality trades.

### New File: `libs/quant-core/src/monte-carlo.ts`

```typescript
// Core Monte Carlo engine with variance reduction techniques.
// Used for both Polymarket arbitrage simulation and general probability estimation.

export interface MonteCarloConfig {
  nPaths: number;        // Number of simulation paths (default: 10000)
  seed?: number;         // Optional deterministic seed for reproducibility
  useAntithetic: boolean; // Antithetic variates (default: true)
  useStratified: boolean; // Stratified sampling (default: true)
}

export interface MonteCarloResult {
  estimate: number;
  stdError: number;
  ci95: [number, number];
  nPaths: number;
  varianceReduction?: number; // Factor vs crude MC
}

// Core MC estimator with variance reduction
export function monteCarloEstimate(
  payoffFn: (z: number) => number,
  config?: Partial<MonteCarloConfig>,
): MonteCarloResult;

// Antithetic variate pair generation
export function antitheticSamples(n: number, seed?: number): Float64Array;

// Stratified sampling within [0,1] quantile bands
export function stratifiedSamples(n: number, strata: number, seed?: number): Float64Array;

// Importance sampling for rare events (tail risk)
export interface ImportanceSamplingConfig extends MonteCarloConfig {
  tiltMean: number;   // Shifted distribution mean
  tiltStd: number;    // Shifted distribution std
}

export function importanceSamplingEstimate(
  payoffFn: (z: number) => number,
  originalMean: number,
  originalStd: number,
  config: ImportanceSamplingConfig,
): MonteCarloResult;

// Brier score for calibration measurement
export function brierScore(predictions: number[], outcomes: number[]): number;

// Binary contract probability estimation via GBM
export function simulateBinaryContract(params: {
  currentPrice: number;
  strikePrice: number;
  volatility: number;
  timeToExpiry: number; // in years
  drift?: number;
  nPaths?: number;
}): MonteCarloResult;
```

### New File: `skills/polymarket-trader/src/arb-simulator.ts`

```typescript
// Pre-trade Monte Carlo simulator for pair arbitrage.
// Runs N simulated execution paths incorporating:
//   - Order book dynamics (fill probability, slippage)
//   - Fee model
//   - Timeout/bailout probability
//   - Expected value calculation
//
// This is the PRE-TRADE GATE: only execute if simulated EV > threshold.

import { MonteCarloResult } from "quant-core";

export interface ArbSimulationParams {
  // Market state
  leg1Price: number;
  leg2BestAsk: number;
  leg2AskDepth: { price: number; size: number }[];
  bidDepth: { price: number; size: number }[];  // For bailout slippage

  // Trade params
  amount: number;
  margin: number;
  legTimeoutMs: number;
  pollIntervalMs: number;

  // Historical calibration (optional — improves estimates)
  historicalFillRateMs?: number;  // Avg time for leg1 to fill
  historicalBailoutRate?: number; // % of past arbs that bailed out

  // Simulation config
  nPaths?: number;  // default 5000
}

export interface ArbSimulationResult {
  // Headline metrics
  expectedPnl: number;           // E[P&L] across all paths
  pnlStdError: number;
  profitProbability: number;     // P(profit > 0)
  bailoutProbability: number;    // P(timeout → bailout)

  // Conditional metrics
  expectedProfitIfComplete: number;  // E[P&L | pair completes]
  expectedLossIfBailout: number;     // E[P&L | bailout triggered]

  // Risk metrics
  worstCaseScenario: number;    // 5th percentile P&L
  bestCaseScenario: number;     // 95th percentile P&L

  // Decision
  recommendation: "EXECUTE" | "SKIP" | "REDUCE_SIZE";
  reason: string;

  // Fee breakdown
  estimatedFees: number;
  estimatedSlippage: number;

  // Raw MC stats
  mc: MonteCarloResult;
}

export function simulateArbitrage(params: ArbSimulationParams): ArbSimulationResult;
```

### Modifications to: `skills/polymarket-trader/src/arbitrage.ts`

1. **Add** simulation gate before Step 1 (after param validation, line 111):
   ```typescript
   // ── Pre-Trade Simulation Gate ───────────────────────────────────────
   const simResult = simulateArbitrage({
     leg1Price: firstLegPrice,
     leg2BestAsk: /* fetch current best ask */,
     leg2AskDepth: /* from order book */,
     bidDepth: /* from order book */,
     amount,
     margin,
     legTimeoutMs,
     pollIntervalMs,
   });

   if (simResult.recommendation === "SKIP") {
     return makeResult(`Simulation rejected: ${simResult.reason}. Expected P&L: ${simResult.expectedPnl.toFixed(4)}`);
   }
   ```

### Modifications to: `skills/polymarket-trader/src/polymarket.skill.ts`

1. **Add** new tool: `simulate_arbitrage`
   ```typescript
   const SimulateArbitrageSchema = Type.Object({
     marketConditionId: Type.String({ description: "Polymarket condition ID" }),
     firstLeg: Type.Union([Type.Literal("Yes"), Type.Literal("No")]),
     amount: Type.Number({ description: "USDC amount per leg" }),
     firstLegPrice: Type.Number({ description: "Limit price for leg 1" }),
     margin: Type.Number({ description: "Target profit margin" }),
     legTimeoutMs: Type.Optional(Type.Number({ default: 3000 })),
     nPaths: Type.Optional(Type.Number({ default: 5000, description: "MC simulation paths" })),
   });
   ```
   - This tool runs the simulation WITHOUT executing. The agent calls it first to evaluate, then decides whether to `execute_pair_arbitrage`.

### Tests: `libs/quant-core/src/__tests__/monte-carlo.test.ts`

Test cases:
- `monteCarloEstimate` converges to known probability (coin flip → 0.50)
- `antitheticSamples` produces negatively correlated pairs
- `stratifiedSamples` covers all quantile bands
- `brierScore` matches known values (perfect calibration → 0, always uncertain → 0.25)
- `simulateBinaryContract` converges to Black-Scholes closed form within CI
- Variance reduction: antithetic + stratified SE < crude SE
- Importance sampling: tail event estimate has lower SE than crude

---

## Phase 4: Particle Filter for Real-Time Edge Detection

### Problem
The agent trusts raw market prices directly. A particle filter smooths noisy observations and identifies when the market price diverges from the estimated "true" probability — those divergences are trading opportunities.

### New File: `libs/quant-core/src/particle-filter.ts`

```typescript
// Sequential Monte Carlo (particle filter) for real-time probability estimation.
// Maintains N particles tracking the hidden "true" probability.
// Updates on each new market observation (price, volume, news signal).
// Operates in logit space to keep probabilities bounded [0,1].

export interface ParticleFilterConfig {
  nParticles: number;     // default: 2000
  processVol: number;     // State transition volatility in logit space (default: 0.03)
  obsNoise: number;       // Observation noise (default: 0.02)
  priorProb: number;      // Initial probability estimate (default: 0.50)
}

export interface ParticleFilterState {
  // Serializable state for persistence
  logitParticles: number[];
  weights: number[];
  history: number[];      // Filtered probability after each update
  observationCount: number;
}

export interface FilterEstimate {
  filteredProb: number;     // Weighted mean probability
  ci95: [number, number];   // 95% credible interval
  ess: number;              // Effective sample size
  divergence: number;       // |filtered - observed| — high = potential edge
}

export class PredictionMarketParticleFilter {
  constructor(config?: Partial<ParticleFilterConfig>);

  // Process a new observation
  update(observedPrice: number): FilterEstimate;

  // Current estimate without new observation
  estimate(): FilterEstimate;

  // Serialize for SQLite persistence between sessions
  serialize(): ParticleFilterState;
  static deserialize(state: ParticleFilterState, config?: Partial<ParticleFilterConfig>): PredictionMarketParticleFilter;
}
```

### Modifications to: `skills/polymarket-trader/src/price-collector.ts`

1. **Integrate** particle filter: after each price snapshot, update the filter
2. **Store** filter state alongside price history (new field in JSON)
3. **Return** filtered probability + divergence in `collectPrices()` output

### Modifications to: `skills/polymarket-trader/src/polymarket.skill.ts`

1. **Enhance** `collect_prices` return to include `filteredProbability` and `edgeSignal`
2. **Add** new tool: `edge_detection`
   ```typescript
   const EdgeDetectionSchema = Type.Object({
     conditionId: Type.String({ description: "Polymarket condition ID" }),
     outcome: Type.Union([Type.Literal("Yes"), Type.Literal("No")]),
   });
   ```
   Returns current filtered probability, market price, divergence, and whether the divergence is statistically significant.

### Tests: `libs/quant-core/src/__tests__/particle-filter.test.ts`

Test cases:
- Filter converges to true probability from uniform prior
- Filter smooths noisy observations (filtered variance < observation variance)
- ESS drops and triggers resampling on weight degeneracy
- Serialize/deserialize round-trips correctly
- Divergence detection fires on synthetic price spike
- Credible interval contains true value 95% of the time (calibration)

---

## Phase 5: Agent-Based Market Backtesting

### Problem
We have zero ability to backtest the arbitrage strategy or optimize parameters (timeout, margin, poll interval) without risking real capital.

### New File: `skills/polymarket-trader/src/arb-backtest.ts`

```typescript
// Agent-based simulation of a Polymarket order book.
// Replays historical price data through a simulated CLOB with:
//   - Informed traders (trade toward true probability)
//   - Noise traders (random)
//   - Market makers (provide liquidity)
// Tests the arbitrage engine against this simulated environment.

export interface ABMConfig {
  trueProb: number;         // True resolution probability
  nInformed: number;        // Informed trader count (default: 10)
  nNoise: number;           // Noise trader count (default: 50)
  nMM: number;              // Market maker count (default: 5)
  nSteps: number;           // Simulation steps (default: 2000)
  initialPrice: number;     // Starting market price (default: 0.50)
}

export interface ABMResult {
  priceHistory: number[];
  finalPrice: number;
  convergenceError: number;  // |finalPrice - trueProb|
  totalVolume: number;
  informedPnl: number;
  noisePnl: number;
}

export class PredictionMarketABM {
  constructor(config: Partial<ABMConfig>);
  step(): void;
  run(nSteps?: number): number[];   // Returns price history
  getResults(): ABMResult;
}

// Backtest runner: runs N arbitrage attempts against ABM-generated order books
export interface ArbBacktestConfig {
  // Arbitrage params to test
  amount: number;
  margin: number;
  legTimeoutMs: number;
  pollIntervalMs: number;

  // ABM config
  abm: Partial<ABMConfig>;
  nTrials: number;          // How many arb attempts to simulate (default: 100)
}

export interface ArbBacktestResult {
  nTrials: number;
  completed: number;        // Pairs that completed
  bailed: number;           // Bailouts triggered
  completionRate: number;
  avgPnlCompleted: number;
  avgPnlBailout: number;
  totalPnl: number;
  sharpeRatio: number | null;
  maxDrawdown: number;
  winRate: number;
  bestParams?: string;      // Suggested parameter adjustments
}

export function backtestArbitrage(config: ArbBacktestConfig): ArbBacktestResult;
```

### Modifications to: `skills/polymarket-trader/src/polymarket.skill.ts`

1. **Add** new tool: `backtest_arbitrage`
   ```typescript
   const BacktestArbitrageSchema = Type.Object({
     trueProb: Type.Number({ description: "Assumed true probability for simulation" }),
     amount: Type.Number({ description: "USDC per leg" }),
     margin: Type.Number({ description: "Target margin" }),
     legTimeoutMs: Type.Optional(Type.Number({ default: 3000 })),
     nTrials: Type.Optional(Type.Number({ default: 100 })),
   });
   ```

---

## Phase 6: Copula-Based Correlation Modeling

### Problem
If the agent runs multiple arbitrage attempts across correlated markets (e.g., multiple Fed-related contracts), it needs to understand tail dependence. The Gaussian copula underestimates extreme co-movements by 2-5x.

### New File: `libs/quant-core/src/copula.ts`

```typescript
// Copula models for correlated prediction market outcomes.
// Implements Gaussian, Student-t, and Clayton copulas.

export interface CopulaResult {
  jointOutcomes: number[][];  // N x d matrix of correlated binary outcomes
  sweepProbability: number;   // P(all markets resolve same way)
  tailDependence: { upper: number; lower: number };
}

// Gaussian copula — no tail dependence (baseline)
export function gaussianCopula(
  probs: number[],
  corrMatrix: number[][],
  nSamples?: number,
): CopulaResult;

// Student-t copula — symmetric tail dependence
export function tCopula(
  probs: number[],
  corrMatrix: number[][],
  degreesOfFreedom?: number,  // default: 4
  nSamples?: number,
): CopulaResult;

// Clayton copula — lower tail dependence (crash correlation)
export function claytonCopula(
  probs: number[],
  theta?: number,  // default: 2.0
  nSamples?: number,
): CopulaResult;

// Compute Kendall's tau from price history pairs
export function kendallTau(a: number[], b: number[]): number;

// Build correlation matrix from price histories
export function buildCorrelationMatrix(
  priceHistories: number[][],
): number[][];

// Portfolio-level risk from copula
export interface PortfolioRisk {
  expectedPnl: number;
  pnlVariance: number;
  correlationImpact: number;  // How much correlation increases portfolio risk
  worstCaseJoint: number;     // P(all positions lose)
  diversificationBenefit: number; // Risk reduction from diversification
}

export function assessPortfolioRisk(
  positions: { prob: number; size: number; expectedPnl: number }[],
  corrMatrix: number[][],
  copulaType?: "gaussian" | "t" | "clayton",
): PortfolioRisk;
```

### Modifications to: `skills/polymarket-trader/src/polymarket.skill.ts`

1. **Add** new tool: `portfolio_correlation`
   ```typescript
   const PortfolioCorrelationSchema = Type.Object({
     conditionIds: Type.Array(Type.String(), { description: "List of condition IDs to analyze" }),
   });
   ```
   Returns correlation matrix, tail dependence estimates, and portfolio risk assessment.

### Tests: `libs/quant-core/src/__tests__/copula.test.ts`

Test cases:
- Gaussian copula: independent probs → joint = product of marginals
- Student-t tail dependence > 0 (vs Gaussian = 0)
- Clayton lower tail dependence > 0
- Correlation matrix is symmetric and positive semi-definite
- `kendallTau` returns known values for ranked data
- `assessPortfolioRisk` identifies concentration risk

---

## Phase 7: Brier Score Calibration Tracking

### Problem
We need to know if our probability estimates are actually calibrated. Without calibration metrics, we can't trust our edge detection.

### Modifications to: `libs/quant-core/src/monte-carlo.ts` (already added in Phase 3)

The `brierScore()` function is implemented here.

### Modifications to: `libs/quant-core/src/journal.ts`

1. **Add** new SQLite table: `calibration_log`
   ```sql
   CREATE TABLE IF NOT EXISTS calibration_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     condition_id TEXT NOT NULL,
     predicted_prob REAL NOT NULL,
     actual_outcome INTEGER,       -- 1 = Yes, 0 = No, NULL = unresolved
     source TEXT NOT NULL,          -- "market_price", "particle_filter", "mc_simulation"
     logged_at TEXT NOT NULL,
     resolved_at TEXT
   );
   ```

2. **Add** functions:
   ```typescript
   export function logPrediction(conditionId: string, predictedProb: number, source: string): void;
   export function resolvePrediction(conditionId: string, actualOutcome: 0 | 1): void;
   export function getCalibrationMetrics(source?: string): {
     brierScore: number;
     nPredictions: number;
     nResolved: number;
     calibrationByBucket: { bucket: string; predicted: number; actual: number; count: number }[];
   };
   ```

### Modifications to: `libs/quant-core/src/index.ts`

Export new calibration functions.

### Modifications to: `skills/polymarket-trader/src/polymarket.skill.ts`

1. **Enhance** `performance_report` tool to include calibration metrics.

### Tests: `libs/quant-core/src/__tests__/monte-carlo.test.ts` (added in Phase 3)

Brier score tests included there.

---

## Phase 8: Wire Everything Together

### Modifications to: `skills/polymarket-trader/src/arbitrage.ts`

Final integration pass — the arbitrage engine now:
1. Computes fee-adjusted max acceptable price (Phase 1)
2. Estimates slippage before FOK orders (Phase 2)
3. Runs MC simulation as pre-trade gate (Phase 3)
4. Logs predictions for calibration tracking (Phase 7)
5. Records fee/slippage breakdown in trade journal metadata

### Modifications to: `skills/polymarket-trader/src/polymarket.skill.ts`

New tools added across phases:
- `simulate_arbitrage` (Phase 3) — dry-run MC simulation before execution
- `edge_detection` (Phase 4) — particle filter divergence signal
- `backtest_arbitrage` (Phase 5) — ABM-based strategy backtesting
- `portfolio_correlation` (Phase 6) — copula risk assessment

### Modifications to: `skills/polymarket-trader/SKILL.md`

Update tool documentation with new tools and their usage patterns.

---

## New Files Summary

| File | Phase | Location |
|------|-------|----------|
| `fees.ts` | 1 | `skills/polymarket-trader/src/` |
| `slippage.ts` | 2 | `skills/polymarket-trader/src/` |
| `monte-carlo.ts` | 3 | `libs/quant-core/src/` |
| `arb-simulator.ts` | 3 | `skills/polymarket-trader/src/` |
| `particle-filter.ts` | 4 | `libs/quant-core/src/` |
| `copula.ts` | 6 | `libs/quant-core/src/` |
| `arb-backtest.ts` | 5 | `skills/polymarket-trader/src/` |
| `monte-carlo.test.ts` | 3 | `libs/quant-core/src/__tests__/` |
| `particle-filter.test.ts` | 4 | `libs/quant-core/src/__tests__/` |
| `copula.test.ts` | 6 | `libs/quant-core/src/__tests__/` |

## Modified Files Summary

| File | Phases | Changes |
|------|--------|---------|
| `arbitrage.ts` | 1,2,3,8 | Fee-aware P&L, slippage gate, MC simulation gate |
| `polymarket.skill.ts` | 3,4,5,6 | 4 new tools + enhanced existing tools |
| `price-collector.ts` | 4 | Particle filter integration |
| `journal.ts` | 7 | `calibration_log` table + functions |
| `index.ts` (quant-core) | 3,4,6,7 | Export new modules |
| `SKILL.md` | 8 | Document new tools |

## Type Additions Summary

### `libs/quant-core/src/types.ts`
No changes — new types are co-located with their modules.

### `skills/polymarket-trader/src/types.ts`
Add:
- `FeeEstimate` (re-exported from fees.ts)
- `SlippageEstimate` (re-exported from slippage.ts)
- `ArbSimulationResult` (re-exported from arb-simulator.ts)
- `ArbBacktestResult` (re-exported from arb-backtest.ts)

Extend `ArbitrageResult`:
```typescript
// Add optional fields
feeBreakdown?: { leg1Fee: number; leg2Fee: number; totalFees: number };
slippageBreakdown?: { leg1Slippage: number; leg2Slippage: number };
simulationResult?: { expectedPnl: number; profitProbability: number; recommendation: string };
```

## Implementation Order

1. **Phase 1** (fees.ts + arbitrage.ts updates) — fixes live P&L bug
2. **Phase 2** (slippage.ts + arbitrage.ts updates) — fixes execution cost estimation
3. **Phase 3** (monte-carlo.ts + arb-simulator.ts + tests) — adds pre-trade intelligence
4. **Phase 4** (particle-filter.ts + price-collector.ts + tests) — adds edge detection
5. **Phase 5** (arb-backtest.ts) — enables parameter optimization
6. **Phase 6** (copula.ts + tests) — portfolio-level risk
7. **Phase 7** (journal.ts calibration) — calibration tracking
8. **Phase 8** (final wiring) — integration pass

Phases 1-2 are must-ship (fix live bugs). Phases 3-4 are high-value. Phases 5-7 are medium-value. Phase 8 is cleanup.
