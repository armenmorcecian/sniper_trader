// ─── Risk Engine ─────────────────────────────────────────────────────────────
// Evaluates positions against risk thresholds and manages alerts.

import {
  insertRiskAlert,
  resolveAlertsByType,
  getActiveAlerts,
} from "quant-core";
import type { Config } from "./config";
import type { RiskCheckResult } from "./types";
import { PositionTracker } from "./position-tracker";

const LOG_PREFIX = "[risk-engine]";

export class RiskEngine {
  constructor(
    private readonly config: Config,
    private readonly tracker: PositionTracker,
  ) {}

  /**
   * Evaluate all risk conditions. Inserts alerts for breaches, resolves cleared conditions.
   */
  evaluate(): RiskCheckResult {
    const result: RiskCheckResult = { alerts: [], resolutions: [] };

    this.checkStopLoss(result);
    this.checkDailyLoss(result);
    this.checkDrawdown(result);

    // Insert alerts
    for (const alert of result.alerts) {
      try {
        insertRiskAlert({
          alertType: alert.alertType,
          severity: alert.severity,
          symbol: alert.symbol,
          message: alert.message,
          details: alert.details,
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to insert alert:`, err);
      }
    }

    // Process resolutions
    for (const res of result.resolutions) {
      try {
        const count = resolveAlertsByType(res.alertType, res.symbol);
        if (count > 0) {
          console.log(`${LOG_PREFIX} Auto-resolved ${count} ${res.alertType} alert(s)${res.symbol ? ` for ${res.symbol}` : ""}: ${res.reason}`);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to resolve alerts:`, err);
      }
    }

    if (result.alerts.length > 0) {
      console.warn(`${LOG_PREFIX} Risk check: ${result.alerts.length} alert(s) generated`);
    }

    return result;
  }

  /**
   * Per-position stop-loss check.
   */
  private checkStopLoss(result: RiskCheckResult): void {
    const threshold = -this.config.stopLossPercent;

    for (const pos of this.tracker.getPositions()) {
      if (pos.unrealizedPnlPercent <= threshold) {
        result.alerts.push({
          alertType: "stop_loss",
          severity: "block",
          symbol: pos.symbol,
          message: `${pos.symbol} stop-loss breached: ${pos.unrealizedPnlPercent.toFixed(1)}% (threshold: ${threshold}%)`,
          details: {
            pnlPercent: pos.unrealizedPnlPercent,
            unrealizedPnl: pos.unrealizedPnl,
            currentPrice: pos.currentPrice,
            avgEntryPrice: pos.avgEntryPrice,
            qty: pos.qty,
            threshold,
          },
        });
      } else {
        // Check if there's an active stop_loss alert for this symbol that should be resolved
        // (price recovered above threshold)
        try {
          const active = getActiveAlerts({ alertType: "stop_loss", symbol: pos.symbol });
          if (active.length > 0 && pos.unrealizedPnlPercent > threshold + 1) {
            // Only auto-resolve if position recovered by at least 1% above threshold
            result.resolutions.push({
              alertType: "stop_loss",
              symbol: pos.symbol,
              reason: `Price recovered to ${pos.unrealizedPnlPercent.toFixed(1)}%`,
            });
          }
        } catch { /* non-fatal */ }
      }
    }

    // Resolve alerts for positions that no longer exist (sold)
    try {
      const activeStopLoss = getActiveAlerts({ alertType: "stop_loss" });
      const currentSymbols = new Set(this.tracker.getSymbols());
      for (const alert of activeStopLoss) {
        if (alert.symbol && !currentSymbols.has(alert.symbol)) {
          result.resolutions.push({
            alertType: "stop_loss",
            symbol: alert.symbol,
            reason: "Position closed",
          });
        }
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Daily loss circuit breaker check.
   */
  private checkDailyLoss(result: RiskCheckResult): void {
    const dailyPnlPercent = this.tracker.getDailyPnlPercent();
    const threshold = -this.config.maxDailyLossPercent;

    if (dailyPnlPercent <= threshold) {
      result.alerts.push({
        alertType: "daily_loss",
        severity: "block",
        message: `Daily loss circuit breaker: ${dailyPnlPercent.toFixed(2)}% (threshold: ${threshold}%)`,
        details: {
          dailyPnlPercent,
          totalEquity: this.tracker.getTotalEquity(),
          threshold,
        },
      });
    }
    // Note: daily_loss alerts are resolved at 9:25 AM ET via cron, not here
  }

  /**
   * Max drawdown check.
   */
  private checkDrawdown(result: RiskCheckResult): void {
    const drawdownPercent = this.tracker.getDrawdownPercent();
    const threshold = -this.config.maxDrawdownPercent;

    if (drawdownPercent <= threshold) {
      result.alerts.push({
        alertType: "drawdown",
        severity: "block",
        message: `Max drawdown breached: ${drawdownPercent.toFixed(2)}% (threshold: ${threshold}%)`,
        details: {
          drawdownPercent,
          totalEquity: this.tracker.getTotalEquity(),
          threshold,
        },
      });
    } else {
      // Auto-resolve if drawdown has recovered
      try {
        const active = getActiveAlerts({ alertType: "drawdown" });
        if (active.length > 0 && drawdownPercent > threshold + 2) {
          result.resolutions.push({
            alertType: "drawdown",
            reason: `Drawdown recovered to ${drawdownPercent.toFixed(2)}%`,
          });
        }
      } catch { /* non-fatal */ }
    }
  }
}
