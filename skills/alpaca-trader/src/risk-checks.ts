import type { PositionSummary } from "./types";
import { getRealizedPnlToday } from "quant-core";

const MAX_DAILY_LOSS_PERCENT = Number(process.env.ALPACA_MAX_DAILY_LOSS_PCT) || 3;

export interface DailyLossCheck {
  blocked: boolean;
  reason?: string;
  dailyPnl: number;
  dailyPnlPercent: number;
  realizedPnl: number;
  unrealizedPnl: number;
  maxLossPercent: number;
}

/**
 * Checks if total daily P&L (realized + unrealized) has exceeded the max loss threshold.
 */
export function checkDailyLossLimit(
  positions: PositionSummary[],
  totalEquity: number,
  maxLossPercent: number = MAX_DAILY_LOSS_PERCENT,
): DailyLossCheck {
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.pnl, 0);

  // Query realized losses from today's closed trades
  let realizedPnl = 0;
  try {
    realizedPnl = getRealizedPnlToday("alpaca");
  } catch {
    // If journal query fails, fall back to unrealized-only (safer than blocking)
  }

  const dailyPnl = realizedPnl + unrealizedPnl;
  const dailyPnlPercent = totalEquity > 0 ? (dailyPnl / totalEquity) * 100 : 0;
  const blocked = dailyPnlPercent < -maxLossPercent;

  return {
    blocked,
    ...(blocked
      ? { reason: `Daily loss limit exceeded: ${dailyPnlPercent.toFixed(2)}% (realized: $${realizedPnl.toFixed(0)}, unrealized: $${unrealizedPnl.toFixed(0)}, max: -${maxLossPercent}%). Trading halted.` }
      : {}),
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    dailyPnlPercent: Math.round(dailyPnlPercent * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    maxLossPercent,
  };
}
