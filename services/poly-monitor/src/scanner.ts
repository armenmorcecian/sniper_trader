// ─── Market Scanner + Edge Detector ──────────────────────────────────────────
// Scans Gamma API for liquid markets, runs particle filter edge detection,
// Monte Carlo EV check, and copula portfolio risk assessment.

import {
  PredictionMarketParticleFilter,
  simulatePredictionContract,
  buildCorrelationMatrix,
  assessPortfolioRisk,
  calibrateCopulaDf,
  checkCircuitBreaker,
  getRealizedPnlToday,
} from "quant-core";
import type { Config } from "./config";
import type { EdgeCandidate, IPolymarketService, ScannedMarket } from "./types";
import type { PositionTracker } from "./position-tracker";

const LOG_PREFIX = "[scanner]";

interface PFState {
  pf: PredictionMarketParticleFilter;
  prices: number[];
}

export class Scanner {
  /** Particle filter state per conditionId (persists across scans) */
  private pfStates = new Map<string, PFState>();

  constructor(private readonly config: Config) {}

  async scanMarkets(service: IPolymarketService): Promise<ScannedMarket[]> {
    try {
      const result = await service.findLiquidMarkets();
      console.log(`${LOG_PREFIX} Scanned ${result.markets.length} liquid markets`);
      return result.markets;
    } catch (err) {
      console.error(`${LOG_PREFIX} Market scan failed:`, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async detectEdges(
    markets: ScannedMarket[],
    tracker: PositionTracker,
    service: IPolymarketService,
  ): Promise<EdgeCandidate[]> {
    const candidates: EdgeCandidate[] = [];

    // Check circuit breaker first — skip all if tripped
    try {
      const vitals = await service.getPortfolioValue();
      const dailyPnl = getRealizedPnlToday("polymarket");
      const unrealizedPnl = tracker.getPositions().reduce((sum, p) => sum + p.pnl, 0);
      const totalDailyPnl = dailyPnl + unrealizedPnl;
      const cbResult = checkCircuitBreaker(totalDailyPnl, vitals.totalEquity, this.config.maxDailyLossPct);
      if (cbResult.tripped) {
        console.log(`${LOG_PREFIX} Circuit breaker tripped — skipping all edge detection`);
        return [];
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Circuit breaker check failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }

    for (const market of markets) {
      try {
        const edge = this.evaluateMarketEdge(market);
        if (!edge) continue;
        candidates.push(edge);
      } catch (err) {
        console.error(`${LOG_PREFIX} Edge check failed for ${market.conditionId.slice(0, 12)} (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }

    // Portfolio risk check — filter out candidates that would exceed joint loss limit
    if (candidates.length > 0 && tracker.getPositionCount() > 0) {
      return this.filterByPortfolioRisk(candidates, tracker);
    }

    if (candidates.length > 0) {
      console.log(`${LOG_PREFIX} ${candidates.length} edge(s) detected`);
    }

    return candidates;
  }

  private evaluateMarketEdge(market: ScannedMarket): EdgeCandidate | null {
    const yesPrice = market.outcomePrices[0];
    if (!yesPrice || yesPrice <= 0.01 || yesPrice >= 0.99) return null;

    // Skip markets expiring very soon (< 1 hour)
    if (market.hoursToExpiration < 1) return null;

    // Get or create particle filter state
    let state = this.pfStates.get(market.conditionId);
    if (!state) {
      state = {
        pf: new PredictionMarketParticleFilter({
          nParticles: 2000,
          priorProb: 0.50,
          processVol: 0.03,
          obsNoise: 0.02,
        }),
        prices: [],
      };
      this.pfStates.set(market.conditionId, state);
    }

    // Feed current price
    state.prices.push(yesPrice);
    state.pf.update(yesPrice);

    // Calibrate if enough data
    if (state.prices.length === 20) {
      try {
        const calibrated = PredictionMarketParticleFilter.calibrate(state.prices, 0.50, 500);
        // Rebuild PF with calibrated params
        state.pf = new PredictionMarketParticleFilter({
          nParticles: 2000,
          priorProb: 0.50,
          processVol: calibrated.processVol,
          obsNoise: calibrated.obsNoise,
        });
        // Re-feed all prices
        for (const p of state.prices) {
          state.pf.update(p);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Calibration failed for ${market.conditionId.slice(0, 12)} (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }

    // Need at least 5 observations for meaningful estimate
    if (state.prices.length < 5) return null;

    const estimate = state.pf.estimate();
    const edge = Math.abs(estimate.filteredProb - yesPrice);
    const ciWidth = estimate.ci95[1] - estimate.ci95[0];
    const isSignificant = estimate.divergence > ciWidth;

    if (!isSignificant || edge < this.config.minEdge) return null;

    // Determine outcome direction
    const outcome: "Yes" | "No" = estimate.filteredProb > yesPrice ? "Yes" : "No";
    const marketPrice = outcome === "Yes" ? yesPrice : (1 - yesPrice);

    // Monte Carlo EV check
    const ev = simulatePredictionContract({
      currentProb: marketPrice,
      volatility: 0.03,
      timeToExpiry: market.hoursToExpiration / 8760,
      nPaths: 3000,
    });

    // Check EV is positive — buying at marketPrice, payout 1 if win, 0 if lose
    // Expected profit = impliedProbYes * (1 - marketPrice) - (1 - impliedProbYes) * marketPrice
    const expectedProfit = ev.impliedProbYes * (1 - marketPrice) - (1 - ev.impliedProbYes) * marketPrice;
    if (expectedProfit <= 0) {
      return null;
    }

    console.log(`${LOG_PREFIX} Edge detected: "${market.question.slice(0, 60)}..." — ${outcome} edge=${(edge * 100).toFixed(1)}%, EV=${expectedProfit.toFixed(4)}`);

    return {
      conditionId: market.conditionId,
      question: market.question,
      outcome,
      marketPrice,
      filteredProb: estimate.filteredProb,
      divergence: estimate.divergence,
      ci95: estimate.ci95 as [number, number],
      edge,
      ev,
      clobTokenIds: market.clobTokenIds,
      endDate: market.endDate,
    };
  }

  private filterByPortfolioRisk(
    candidates: EdgeCandidate[],
    tracker: PositionTracker,
  ): EdgeCandidate[] {
    try {
      // Build price histories from tracked positions' PF history
      const trackedPositions = tracker.getPositions();
      const priceHistories: number[][] = [];
      const positions: Array<{ prob: number; size: number; expectedPnl: number }> = [];

      for (const pos of trackedPositions) {
        const pf = tracker.getParticleFilter(pos.conditionId);
        if (pf && pf.history.length >= 5) {
          priceHistories.push(pf.history);
          positions.push({
            prob: pos.currentPrice,
            size: pos.marketValue,
            expectedPnl: pos.pnl,
          });
        }
      }

      if (priceHistories.length < 2) return candidates;

      const corrMatrix = buildCorrelationMatrix(priceHistories);
      const calibratedDf = calibrateCopulaDf(priceHistories);
      const risk = assessPortfolioRisk(positions, corrMatrix, "t", calibratedDf);

      if (risk.worstCaseJoint > this.config.maxJointLoss) {
        console.log(`${LOG_PREFIX} Portfolio risk too high (worstCaseJoint=${risk.worstCaseJoint.toFixed(3)} > ${this.config.maxJointLoss}) — filtering candidates`);
        // Only keep candidates with very strong edges
        return candidates.filter((c) => c.edge > this.config.minEdge * 2);
      }

      return candidates;
    } catch (err) {
      console.error(`${LOG_PREFIX} Portfolio risk check failed (non-fatal):`, err instanceof Error ? err.message : String(err));
      return candidates;
    }
  }

  /** Clean up stale PF states for markets we haven't seen in a while */
  pruneStaleStates(activeConditionIds: Set<string>): void {
    for (const [conditionId] of this.pfStates) {
      if (!activeConditionIds.has(conditionId)) {
        this.pfStates.delete(conditionId);
      }
    }
  }
}
