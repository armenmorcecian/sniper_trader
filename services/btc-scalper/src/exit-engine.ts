// ─── Exit Engine ─────────────────────────────────────────────────────────────
// Profit-only exit strategy: only sell when profitable or at candle time limit.
// Never hold to resolution — sell the contract to capture the price move.

// Circuit breaker exit disabled — imports kept for reference
// import { checkCircuitBreaker, getRealizedPnlToday } from "quant-core";
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

  // ─── Rule 5: Circuit Breaker — DISABLED (no exits) ──────────────────

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
  // Grace period: skip all exit rules for young positions
  const holdMs = Date.now() - pos.entryTime;
  const minHold = pos.market.timeframe === "5m" ? config.minHoldMs5m : config.minHoldMs;
  if (holdMs < minHold) {
    return null;
  }

  const livePrice = currentPolyPrices.get(pos.conditionId);
  if (livePrice === undefined) {
    console.warn(`${LOG_PREFIX} No live price for ${pos.conditionId.slice(0, 12)} — using entry price`);
  }
  const curPrice = livePrice ?? pos.entryPrice;

  // Skip dynamic TP evaluation if GTC TP is active (exchange manages the TP)
  if (pos.tpOrderId) {
    const candleStartMs = pos.market.startDate
      ? new Date(pos.market.startDate).getTime()
      : new Date(pos.market.endDate).getTime() - (TIMEFRAME_SECONDS[pos.market.timeframe] || 300) * 1000;
    const candleEndMs = new Date(pos.market.endDate).getTime();
    const candleDurationMs = candleEndMs - candleStartMs;
    const elapsed = candleDurationMs > 0 ? Math.min(Math.max((Date.now() - candleStartMs) / candleDurationMs, 0), 1.0) : 0;

    if (elapsed >= config.maxHoldElapsed) {
      return {
        conditionId: pos.conditionId,
        rule: "time_decay",
        reason: `Candle ${(elapsed * 100).toFixed(0)}% elapsed — cancelling GTC TP and force-selling`,
        urgency: "high",
        currentPrice: curPrice,
      };
    }
    return null;
  }

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

  // ─── Rule 2: Stop-Loss ────────────────────────────────────────────────
  if (pnlPct <= -config.baseStopLossPct) {
    console.log(`${LOG_PREFIX} STOP-LOSS: ${pos.asset} ${pos.market.timeframe} ${pos.side} — P&L ${pnlPct.toFixed(1)}%`);
    return {
      conditionId: pos.conditionId,
      rule: "stop_loss",
      reason: `P&L ${pnlPct.toFixed(1)}% hit stop at -${config.baseStopLossPct}%`,
      urgency: "high",
      currentPrice: curPrice,
    };
  }

  return null;
}
