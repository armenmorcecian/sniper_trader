// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// Pure logic for daily loss limits and position concentration checks.
// No external dependencies — used by both alpaca-trader and polymarket-trader.

export interface CircuitBreakerConfig {
  maxDailyLossPercent: number;
  maxSinglePositionPercent: number;
}

export interface CircuitBreakerResult {
  tripped: boolean;
  reason?: string;
  action?: "cancel_all_orders" | "block_trade";
  dailyPnlPercent?: number;
}

export interface ConcentrationResult {
  exceeded: boolean;
  currentPercent: number;
  maxPercent: number;
  reason?: string;
}

/**
 * Checks if daily P&L has breached the maximum loss threshold.
 * Returns tripped=true with action="cancel_all_orders" when limit is hit.
 */
export function checkCircuitBreaker(
  dailyPnl: number,
  totalEquity: number,
  maxLossPercent: number,
): CircuitBreakerResult {
  if (totalEquity <= 0) {
    return {
      tripped: true,
      reason: "Zero or negative equity — all trading halted",
      action: "cancel_all_orders",
      dailyPnlPercent: 0,
    };
  }

  const dailyPnlPercent = (dailyPnl / totalEquity) * 100;

  if (dailyPnlPercent < -maxLossPercent) {
    return {
      tripped: true,
      reason: `Daily loss ${dailyPnlPercent.toFixed(2)}% exceeds -${maxLossPercent}% limit. All orders cancelled, trading halted.`,
      action: "cancel_all_orders",
      dailyPnlPercent: Math.round(dailyPnlPercent * 100) / 100,
    };
  }

  return {
    tripped: false,
    dailyPnlPercent: Math.round(dailyPnlPercent * 100) / 100,
  };
}

/**
 * Checks if a position (existing + proposed) exceeds the max concentration limit.
 * For buys: positionValue = existing market value + proposed amount.
 */
export function checkConcentration(
  positionValue: number,
  totalEquity: number,
  maxPercent: number,
): ConcentrationResult {
  if (totalEquity <= 0) {
    return {
      exceeded: true,
      currentPercent: 0,
      maxPercent,
      reason: "Zero or negative equity — cannot calculate concentration",
    };
  }

  const currentPercent = Math.round((positionValue / totalEquity) * 10000) / 100;

  if (currentPercent > maxPercent) {
    return {
      exceeded: true,
      currentPercent,
      maxPercent,
      reason: `Position concentration ${currentPercent.toFixed(1)}% exceeds ${maxPercent}% limit`,
    };
  }

  return {
    exceeded: false,
    currentPercent,
    maxPercent,
  };
}
