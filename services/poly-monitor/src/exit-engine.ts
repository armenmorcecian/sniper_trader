// ─── Exit Engine ─────────────────────────────────────────────────────────────
// 7 fully algorithmic exit rules. No LLM calls — all exits are instant.

import {
  checkCircuitBreaker,
  getRealizedPnlToday,
  assessPortfolioRisk,
  buildCorrelationMatrix,
  calibrateCopulaDf,
} from "quant-core";
import type { Config } from "./config";
import type { ExitSignal, TrackedPosition } from "./types";
import type { PositionTracker } from "./position-tracker";

const LOG_PREFIX = "[exit-engine]";

export function evaluateExits(
  positions: TrackedPosition[],
  tracker: PositionTracker,
  config: Config,
  totalEquity: number,
): ExitSignal[] {
  const signals: ExitSignal[] = [];
  if (positions.length === 0) return signals;

  // ─── Rule 1: Circuit Breaker (all positions) ────────────────────────────

  try {
    const dailyRealized = getRealizedPnlToday("polymarket");
    const unrealizedPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
    const totalDailyPnl = dailyRealized + unrealizedPnl;
    const cbResult = checkCircuitBreaker(totalDailyPnl, totalEquity, config.maxDailyLossPct);

    if (cbResult.tripped) {
      console.log(`${LOG_PREFIX} CIRCUIT BREAKER: daily P&L $${totalDailyPnl.toFixed(2)} — exiting ALL positions`);
      for (const pos of positions) {
        signals.push({
          conditionId: pos.conditionId,
          outcome: pos.outcome,
          rule: "circuit_breaker",
          reason: `Daily loss $${totalDailyPnl.toFixed(2)} exceeded -${config.maxDailyLossPct}% of equity`,
          urgency: "high",
        });
      }
      return signals; // Exit everything immediately
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Circuit breaker check failed (non-fatal):`, err instanceof Error ? err.message : String(err));
  }

  // Evaluate per-position rules
  const exitConditionIds = new Set<string>();

  for (const pos of positions) {
    const signal = evaluatePositionRules(pos, tracker, config);
    if (signal) {
      signals.push(signal);
      exitConditionIds.add(pos.conditionId);
    }
  }

  // ─── Rule 7: Portfolio Risk (cross-position) ─────────────────────────────

  if (positions.length >= 2 && exitConditionIds.size < positions.length) {
    const portfolioSignal = evaluatePortfolioRisk(positions, tracker, config, exitConditionIds);
    if (portfolioSignal) {
      signals.push(portfolioSignal);
    }
  }

  return signals;
}

function evaluatePositionRules(
  pos: TrackedPosition,
  tracker: PositionTracker,
  config: Config,
): ExitSignal | null {

  // ─── Rule 2: Stop-loss ──────────────────────────────────────────────────

  if (pos.pnlPercent < -config.stopLossPct) {
    console.log(`${LOG_PREFIX} STOP-LOSS: "${pos.question.slice(0, 40)}..." P&L ${pos.pnlPercent.toFixed(1)}%`);
    return {
      conditionId: pos.conditionId,
      outcome: pos.outcome,
      rule: "stop_loss",
      reason: `P&L ${pos.pnlPercent.toFixed(1)}% exceeded -${config.stopLossPct}% stop`,
      urgency: "high",
    };
  }

  // ─── Rule 3: Take-profit ────────────────────────────────────────────────

  if (pos.pnlPercent > config.takeProfitPct) {
    console.log(`${LOG_PREFIX} TAKE-PROFIT: "${pos.question.slice(0, 40)}..." P&L +${pos.pnlPercent.toFixed(1)}%`);
    return {
      conditionId: pos.conditionId,
      outcome: pos.outcome,
      rule: "take_profit",
      reason: `P&L +${pos.pnlPercent.toFixed(1)}% hit +${config.takeProfitPct}% target`,
      urgency: "medium",
    };
  }

  // ─── Rule 4: Expiry Proximity ───────────────────────────────────────────

  if (pos.endDate) {
    const hoursRemaining = (new Date(pos.endDate).getTime() - Date.now()) / 3_600_000;
    if (hoursRemaining < config.expiryExitHours && pos.pnl < 0) {
      console.log(`${LOG_PREFIX} EXPIRY-EXIT: "${pos.question.slice(0, 40)}..." expires in ${hoursRemaining.toFixed(1)}h with negative P&L`);
      return {
        conditionId: pos.conditionId,
        outcome: pos.outcome,
        rule: "expiry_proximity",
        reason: `Expires in ${hoursRemaining.toFixed(1)}h with negative P&L`,
        urgency: "high",
      };
    }
  }

  // ─── Rule 5: Edge Decay ─────────────────────────────────────────────────

  if (pos.entryEdge > 0 && pos.lastEdge !== null) {
    if (pos.lastEdge < pos.entryEdge * config.edgeDecayRatio) {
      console.log(`${LOG_PREFIX} EDGE-DECAY: "${pos.question.slice(0, 40)}..." edge ${(pos.entryEdge * 100).toFixed(1)}% → ${(pos.lastEdge * 100).toFixed(1)}%`);
      return {
        conditionId: pos.conditionId,
        outcome: pos.outcome,
        rule: "edge_decay",
        reason: `Edge decayed from ${(pos.entryEdge * 100).toFixed(1)}% to ${(pos.lastEdge * 100).toFixed(1)}%`,
        urgency: "medium",
      };
    }
  }

  // ─── Rule 6: Max Hold ───────────────────────────────────────────────────

  const hoursHeld = (Date.now() - new Date(pos.entryTime).getTime()) / 3_600_000;
  if (hoursHeld > config.maxHoldHours) {
    console.log(`${LOG_PREFIX} MAX-HOLD: "${pos.question.slice(0, 40)}..." held for ${hoursHeld.toFixed(0)}h`);
    return {
      conditionId: pos.conditionId,
      outcome: pos.outcome,
      rule: "max_hold",
      reason: `Held for ${hoursHeld.toFixed(0)}h (max ${config.maxHoldHours}h)`,
      urgency: "medium",
    };
  }

  return null;
}

function evaluatePortfolioRisk(
  positions: TrackedPosition[],
  tracker: PositionTracker,
  config: Config,
  alreadyExiting: Set<string>,
): ExitSignal | null {
  try {
    const activePositions = positions.filter((p) => !alreadyExiting.has(p.conditionId));
    if (activePositions.length < 2) return null;

    const priceHistories: number[][] = [];
    const riskPositions: Array<{ prob: number; size: number; expectedPnl: number }> = [];
    const validPositions: TrackedPosition[] = [];

    for (const pos of activePositions) {
      const pf = tracker.getParticleFilter(pos.conditionId);
      if (pf && pf.history.length >= 5) {
        priceHistories.push(pf.history);
        riskPositions.push({
          prob: pos.currentPrice,
          size: pos.marketValue,
          expectedPnl: pos.pnl,
        });
        validPositions.push(pos);
      }
    }

    if (priceHistories.length < 2) return null;

    const corrMatrix = buildCorrelationMatrix(priceHistories);
    const calibratedDf = calibrateCopulaDf(priceHistories);
    const risk = assessPortfolioRisk(riskPositions, corrMatrix, "t", calibratedDf);

    if (risk.worstCaseJoint > config.maxJointLoss) {
      // Exit the position with the lowest edge
      let weakest = validPositions[0];
      let weakestEdge = Infinity;

      for (const pos of validPositions) {
        const edge = pos.lastEdge ?? Infinity;
        if (edge < weakestEdge) {
          weakestEdge = edge;
          weakest = pos;
        }
      }

      console.log(`${LOG_PREFIX} PORTFOLIO-RISK: worstCaseJoint=${risk.worstCaseJoint.toFixed(3)} > ${config.maxJointLoss} — exiting weakest: "${weakest.question.slice(0, 40)}..."`);
      return {
        conditionId: weakest.conditionId,
        outcome: weakest.outcome,
        rule: "portfolio_risk",
        reason: `Joint loss risk ${risk.worstCaseJoint.toFixed(3)} > ${config.maxJointLoss} threshold`,
        urgency: "medium",
      };
    }

    return null;
  } catch (err) {
    console.error(`${LOG_PREFIX} Portfolio risk check failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    return null;
  }
}
