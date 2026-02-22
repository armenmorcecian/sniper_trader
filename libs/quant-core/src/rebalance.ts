import type { PriceBar, Regime, RegimeResult, SectorMomentum, RebalanceAction } from "./types";
import { round, calculateDailyReturns, pearsonCorrelation } from "./math";
import { CORRELATION_THRESHOLD } from "./constants";
import { riskParityWeights } from "./momentum";

/**
 * Generates buy/sell/hold actions based on regime, rankings, and current holdings.
 *
 * Bear mode: sell everything.
 * Bull mode: sell holdings outside top 5; buy top 3 if not held (with correlation filter);
 *            hold top 4-5 if held. Risk-parity weights on buy/hold.
 *
 * If multiBars is provided, uses Pearson correlation to reject candidates
 * that are >0.8 correlated with existing holdings.
 */
export function generateRebalanceActions(
  regime: RegimeResult,
  rankings: SectorMomentum[],
  currentHoldings: string[],
  multiBars?: Record<string, PriceBar[]>,
): RebalanceAction[] {
  const actions: RebalanceAction[] = [];
  const holdingsSet = new Set(currentHoldings);

  // Use composite regime if available, else fall back to SPY-only regime
  const effectiveRegime: Regime = regime.compositeRegime ?? regime.regime;

  if (effectiveRegime === "bear") {
    const breadthInfo = regime.breadthCount != null
      ? ` | breadth ${regime.breadthCount}/11 sectors above SMA50 (${regime.breadthSignal})`
      : "";
    for (const symbol of currentHoldings) {
      actions.push({
        action: "sell",
        symbol,
        reason: `Bear mode (SPY ${regime.spyPrice} < SMA200 ${regime.sma200}${breadthInfo}) — liquidate all sectors`,
      });
    }
    return actions;
  }

  // Bull mode
  const top3Candidates = rankings.slice(0, 3);
  const top5 = rankings.slice(0, 5).map((r) => r.symbol);
  const top5Set = new Set(top5);

  // Correlation filter: reject top-3 buy candidates that are >0.8 correlated with holdings
  const buySymbols: string[] = [];
  const rejectedForCorrelation: Map<string, string> = new Map();

  for (const candidate of top3Candidates) {
    if (holdingsSet.has(candidate.symbol)) {
      buySymbols.push(candidate.symbol);
      continue;
    }

    let rejected = false;
    if (multiBars && currentHoldings.length > 0) {
      const candidateBars = multiBars[candidate.symbol];
      if (candidateBars && candidateBars.length >= 21) {
        const candidateReturns = calculateDailyReturns(candidateBars);
        for (const held of currentHoldings) {
          const heldBars = multiBars[held];
          if (!heldBars || heldBars.length < 21) continue;
          const heldReturns = calculateDailyReturns(heldBars);
          const r = pearsonCorrelation(candidateReturns, heldReturns);
          if (Math.abs(r) > CORRELATION_THRESHOLD) {
            rejectedForCorrelation.set(candidate.symbol, held);
            candidate.correlationWarning = `r=${round(r)} with ${held}`;
            rejected = true;
            break;
          }
        }
      }
    }

    if (!rejected) {
      buySymbols.push(candidate.symbol);
    }
  }

  const top3Set = new Set(buySymbols);

  // Compute risk-parity weights for buy/hold candidates
  const rpCandidates = rankings.filter((r) => top3Set.has(r.symbol) || (holdingsSet.has(r.symbol) && top5Set.has(r.symbol)));
  const rpWeights = riskParityWeights(rpCandidates);

  // Sell holdings outside top 5
  for (const symbol of currentHoldings) {
    if (!top5Set.has(symbol)) {
      const rank = rankings.find((r) => r.symbol === symbol)?.rank ?? "?";
      actions.push({
        action: "sell",
        symbol,
        reason: `Dropped out of top 5 (rank #${rank})`,
      });
    }
  }

  // Buy top 3 if not already held (and not rejected by correlation)
  for (const symbol of buySymbols) {
    if (!holdingsSet.has(symbol)) {
      const rank = rankings.find((r) => r.symbol === symbol)!;
      const scoreInfo = rank.volatilityAdjustedScore != null && rank.volatilityAdjustedScore !== -Infinity
        ? `, vol-adj ${rank.volatilityAdjustedScore}`
        : "";
      actions.push({
        action: "buy",
        symbol,
        reason: `Top 3 (#${rank.rank}, composite ${rank.compositeScore ?? rank.momentum20d}%${scoreInfo}) — allocate ${rpWeights[symbol] ? (rpWeights[symbol] * 100).toFixed(0) + "% risk-parity" : "33%"}`,
        targetWeight: rpWeights[symbol],
      });
    }
  }

  // Emit hold-with-reason for correlation-rejected candidates
  for (const [symbol, correlatedWith] of rejectedForCorrelation) {
    if (!holdingsSet.has(symbol)) {
      actions.push({
        action: "hold",
        symbol,
        reason: `Top 3 but skipped — too correlated with held ${correlatedWith} (r>${CORRELATION_THRESHOLD})`,
      });
    }
  }

  // Hold top 4-5 if already held
  for (const symbol of top5) {
    if (holdingsSet.has(symbol) && !top3Set.has(symbol)) {
      actions.push({
        action: "hold",
        symbol,
        reason: `Still in top 5 (rank #${rankings.find((r) => r.symbol === symbol)?.rank})`,
        targetWeight: rpWeights[symbol],
      });
    }
  }

  // Hold top 3 if already held
  for (const symbol of buySymbols) {
    if (holdingsSet.has(symbol)) {
      const rank = rankings.find((r) => r.symbol === symbol)!;
      actions.push({
        action: "hold",
        symbol,
        reason: `Top 3 (#${rank.rank}, composite ${rank.compositeScore ?? rank.momentum20d}%) — already held`,
        targetWeight: rpWeights[symbol],
      });
    }
  }

  return actions;
}
