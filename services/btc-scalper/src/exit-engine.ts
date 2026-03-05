// ─── Exit Engine ─────────────────────────────────────────────────────────────
// Dynamic take-profit / stop-loss / momentum reversal / time-decay exit rules.
// Never hold to resolution — sell the contract to capture the price move.

import { checkCircuitBreaker, getRealizedPnlToday } from "quant-core";
import type { Config } from "./config";
import type { Asset, AssetPipeline, ExitSignal, OpenPosition } from "./types";
import { TIMEFRAME_SECONDS } from "./types";

const LOG_PREFIX = "[exit-engine]";

export function evaluateExits(
  positions: OpenPosition[],
  pipelines: Map<Asset, AssetPipeline>,
  config: Config,
  totalEquity: number,
  currentPolyPrices: Map<string, number>,
): ExitSignal[] {
  const signals: ExitSignal[] = [];
  if (positions.length === 0) return signals;

  // ─── Rule 5: Circuit Breaker (all positions) ──────────────────────────

  try {
    const dailyRealized = getRealizedPnlToday("polymarket");
    const unrealizedPnl = positions.reduce((sum, pos) => {
      const curPrice = currentPolyPrices.get(pos.conditionId) ?? pos.entryPrice;
      return sum + (curPrice - pos.entryPrice) * (pos.amount / pos.entryPrice);
    }, 0);
    const totalDailyPnl = dailyRealized + unrealizedPnl;
    const cbResult = checkCircuitBreaker(totalDailyPnl, totalEquity, config.maxDailyLossPct);

    if (cbResult.tripped) {
      console.log(`${LOG_PREFIX} CIRCUIT BREAKER: daily P&L $${totalDailyPnl.toFixed(2)}`);
      for (const pos of positions) {
        const curPrice = currentPolyPrices.get(pos.conditionId) ?? pos.entryPrice;
        const posPnlPct = ((curPrice - pos.entryPrice) / pos.entryPrice) * 100;

        // Only exit losing positions — profitable ones are helping recovery
        if (posPnlPct >= 0) {
          console.log(`${LOG_PREFIX} CB: keeping ${pos.asset} ${pos.market.timeframe} ${pos.side} (P&L +${posPnlPct.toFixed(1)}%)`);
          continue;
        }

        signals.push({
          conditionId: pos.conditionId,
          rule: "circuit_breaker",
          reason: `Daily loss $${totalDailyPnl.toFixed(2)} exceeded -${config.maxDailyLossPct}% of equity`,
          urgency: "high",
          currentPrice: curPrice,
        });
      }
      if (signals.length > 0) return signals;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Circuit breaker check failed (non-fatal):`, err instanceof Error ? err.message : String(err));
  }

  // ─── Per-position rules ───────────────────────────────────────────────

  for (const pos of positions) {
    const pipeline = pipelines.get(pos.asset);
    const tracker = pipeline?.tracker;
    const signal = evaluatePositionRules(pos, tracker, config, currentPolyPrices);
    if (signal) {
      signals.push(signal);
    }
  }

  return signals;
}

function evaluatePositionRules(
  pos: OpenPosition,
  tracker: { getMetrics(conditionId: string): { returnFromOpen: number } | null } | undefined,
  config: Config,
  currentPolyPrices: Map<string, number>,
): ExitSignal | null {
  const livePrice = currentPolyPrices.get(pos.conditionId);
  if (livePrice === undefined) {
    console.warn(`${LOG_PREFIX} No live price for ${pos.conditionId.slice(0, 12)} — using entry price`);
  }
  const curPrice = livePrice ?? pos.entryPrice;
  const pnlPct = ((curPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // Update high-water mark for trailing TP
  if (pnlPct > pos.peakPnlPct) pos.peakPnlPct = pnlPct;

  // ─── Trailing Take-Profit ───────────────────────────────────────────
  if (pos.peakPnlPct >= config.trailingTpActivationPct) {
    const drop = pos.peakPnlPct - pnlPct;
    if (drop >= config.trailingTpDropPct) {
      console.log(`${LOG_PREFIX} TRAILING-TP: ${pos.asset} ${pos.market.timeframe} ${pos.side} — peaked +${pos.peakPnlPct.toFixed(1)}%, now +${pnlPct.toFixed(1)}% (drop ${drop.toFixed(1)}%)`);
      return {
        conditionId: pos.conditionId,
        rule: "take_profit",
        reason: `Trailing: peaked +${pos.peakPnlPct.toFixed(1)}%, now +${pnlPct.toFixed(1)}% (drop ${drop.toFixed(1)}% >= ${config.trailingTpDropPct}%)`,
        urgency: "medium",
        currentPrice: curPrice,
      };
    }
  }

  // Compute elapsed fraction using market's actual start/end dates
  const candleStartMs = pos.market.startDate
    ? new Date(pos.market.startDate).getTime()
    : new Date(pos.market.endDate).getTime() - (TIMEFRAME_SECONDS[pos.market.timeframe] || 300) * 1000;
  const candleEndMs = new Date(pos.market.endDate).getTime();
  const candleDurationMs = candleEndMs - candleStartMs;
  const now = Date.now();
  const elapsed = candleDurationMs > 0 ? Math.min(Math.max((now - candleStartMs) / candleDurationMs, 0), 1.0) : 0;

  // ─── Rule 4: Time Decay Exit (mandatory — highest priority) ───────────

  if (elapsed >= config.maxHoldElapsed) {
    console.log(`${LOG_PREFIX} TIME-DECAY: ${pos.asset} ${pos.market.timeframe} ${pos.side} — elapsed ${(elapsed * 100).toFixed(0)}% >= ${(config.maxHoldElapsed * 100).toFixed(0)}%`);
    return {
      conditionId: pos.conditionId,
      rule: "time_decay",
      reason: `Candle ${(elapsed * 100).toFixed(0)}% elapsed (forced exit at ${(config.maxHoldElapsed * 100).toFixed(0)}%)`,
      urgency: "high",
      currentPrice: curPrice,
    };
  }

  // ─── Rule 1: Dynamic Take-Profit ──────────────────────────────────────

  const takeProfitPct = config.baseTakeProfitPct * (1 - elapsed * config.tpDecayFactor);
  if (pnlPct >= takeProfitPct) {
    console.log(`${LOG_PREFIX} TAKE-PROFIT: ${pos.asset} ${pos.market.timeframe} ${pos.side} — P&L +${pnlPct.toFixed(1)}% >= ${takeProfitPct.toFixed(1)}%`);
    return {
      conditionId: pos.conditionId,
      rule: "take_profit",
      reason: `P&L +${pnlPct.toFixed(1)}% hit dynamic target ${takeProfitPct.toFixed(1)}% (elapsed ${(elapsed * 100).toFixed(0)}%)`,
      urgency: "medium",
      currentPrice: curPrice,
    };
  }

  // ─── Rule 2: Dynamic Stop-Loss ────────────────────────────────────────

  const stopLossPct = config.baseStopLossPct * (1 - elapsed * config.slTightenFactor);
  if (pnlPct <= -stopLossPct) {
    console.log(`${LOG_PREFIX} STOP-LOSS: ${pos.asset} ${pos.market.timeframe} ${pos.side} — P&L ${pnlPct.toFixed(1)}% <= -${stopLossPct.toFixed(1)}%`);
    return {
      conditionId: pos.conditionId,
      rule: "stop_loss",
      reason: `P&L ${pnlPct.toFixed(1)}% hit dynamic stop -${stopLossPct.toFixed(1)}% (elapsed ${(elapsed * 100).toFixed(0)}%)`,
      urgency: "high",
      currentPrice: curPrice,
    };
  }

  // ─── Rule 3: Momentum Reversal ────────────────────────────────────────

  if (tracker) {
    const metrics = tracker.getMetrics(pos.conditionId);
    if (metrics && pnlPct < 0) {
      const entryWasBullish = pos.entryReturnFromOpen > 0;
      const reversalThreshold = 0.05;
      const reversed = entryWasBullish
        ? metrics.returnFromOpen < -reversalThreshold
        : metrics.returnFromOpen > reversalThreshold;

      if (reversed) {
        const currentIsBullish = metrics.returnFromOpen > 0;
        console.log(`${LOG_PREFIX} MOMENTUM-REVERSAL: ${pos.asset} ${pos.market.timeframe} ${pos.side} — momentum flipped (ret=${metrics.returnFromOpen.toFixed(3)}%), P&L ${pnlPct.toFixed(1)}%`);
        return {
          conditionId: pos.conditionId,
          rule: "momentum_reversal",
          reason: `Momentum reversed (was ${entryWasBullish ? "bullish" : "bearish"}, now ${currentIsBullish ? "bullish" : "bearish"}, ret=${metrics.returnFromOpen.toFixed(3)}%) with P&L ${pnlPct.toFixed(1)}%`,
          urgency: "high",
          currentPrice: curPrice,
        };
      }
    }
  }

  return null;
}
