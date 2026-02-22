import { PositionSummary, SpreadAnalysis, ExposureCheck, VitalSigns } from "./types";

// ─── Spread Analysis ────────────────────────────────────────────────────────

/**
 * Analyzes bid-ask spread and volume for a given quote.
 *
 * Thresholds:
 * - SPY/QQQ: spread < 0.05%, volume > 1M
 * - Others:  spread < 0.15%, volume > 100K
 */
export function analyzeSpread(
  symbol: string,
  bidPrice: number,
  askPrice: number,
  volume: number,
  avgVolume20d: number,
): SpreadAnalysis {
  const spread = askPrice - bidPrice;
  const midpoint = (askPrice + bidPrice) / 2;
  const spreadPercent = midpoint > 0 ? (spread / midpoint) * 100 : 0;

  const isHighLiquidity = symbol === "SPY" || symbol === "QQQ";
  const spreadThreshold = isHighLiquidity ? 0.05 : 0.15;
  const volumeThreshold = isHighLiquidity ? 1_000_000 : 100_000;

  const spreadOk = spreadPercent <= spreadThreshold;
  const volumeOk = volume >= volumeThreshold;
  const liquidEnough = spreadOk && volumeOk;

  let reason: string;
  if (liquidEnough) {
    reason = "Spread and volume within acceptable range";
  } else if (!spreadOk && !volumeOk) {
    reason = `Spread ${spreadPercent.toFixed(3)}% exceeds ${spreadThreshold}% AND volume ${volume.toLocaleString()} below ${volumeThreshold.toLocaleString()}`;
  } else if (!spreadOk) {
    reason = `Spread ${spreadPercent.toFixed(3)}% exceeds ${spreadThreshold}% threshold`;
  } else {
    reason = `Volume ${volume.toLocaleString()} below ${volumeThreshold.toLocaleString()} threshold`;
  }

  return {
    symbol,
    spread: Math.round(spread * 10000) / 10000,
    spreadPercent: Math.round(spreadPercent * 10000) / 10000,
    volume,
    avgVolume20d,
    liquidEnough,
    reason,
  };
}

// ─── Stop-Loss Check ────────────────────────────────────────────────────────

/**
 * Checks positions against a stop-loss threshold.
 * Returns positions that should be exited immediately.
 * Default -5% for ETFs (tighter than Polymarket's -15%).
 */
export function checkStopLoss(
  positions: PositionSummary[],
  stopLossPercent: number = -5,
): PositionSummary[] {
  return positions.filter((pos) => pos.pnlPercent <= stopLossPercent);
}

// ─── Exposure Validation ────────────────────────────────────────────────────

/**
 * Validates that a proposed trade doesn't violate exposure rules:
 * - 50% max total exposure (positions / equity)
 * - 20% dry powder minimum (cash / equity)
 * - 25% max single position (proposed / equity)
 */
export function validateExposure(
  vitals: VitalSigns,
  proposedAmount: number,
): ExposureCheck {
  const equity = vitals.totalEquity;
  if (equity <= 0) {
    return {
      allowed: false,
      reason: "Zero or negative equity",
      currentExposure: 0,
      proposedExposure: 0,
      maxExposure: 0,
      dryPowderPercent: 0,
    };
  }

  const maxExposurePct = Number(process.env.ALPACA_MAX_TOTAL_EXPOSURE_PCT) || 50;
  const dryPowderMinPct = Number(process.env.ALPACA_DRY_POWDER_MIN_PCT) || 20;
  const maxSinglePct = Number(process.env.ALPACA_MAX_SINGLE_POSITION_PCT) || 25;

  const currentPositionValue = vitals.positions.reduce(
    (sum, p) => sum + p.marketValue,
    0,
  );
  const currentExposurePct = (currentPositionValue / equity) * 100;
  const proposedExposurePct =
    ((currentPositionValue + proposedAmount) / equity) * 100;

  // Check max total exposure
  if (proposedExposurePct > maxExposurePct) {
    return {
      allowed: false,
      reason: `Total exposure would be ${proposedExposurePct.toFixed(1)}% (max ${maxExposurePct}%)`,
      currentExposure: currentExposurePct,
      proposedExposure: proposedExposurePct,
      maxExposure: maxExposurePct,
      dryPowderPercent: (vitals.cash / equity) * 100,
    };
  }

  // Check dry powder minimum cash reserve
  const cashAfter = vitals.cash - proposedAmount;
  const dryPowderAfter = (cashAfter / equity) * 100;
  if (dryPowderAfter < dryPowderMinPct) {
    return {
      allowed: false,
      reason: `Dry powder would drop to ${dryPowderAfter.toFixed(1)}% (min ${dryPowderMinPct}%)`,
      currentExposure: currentExposurePct,
      proposedExposure: proposedExposurePct,
      maxExposure: maxExposurePct,
      dryPowderPercent: dryPowderAfter,
    };
  }

  // Check single position size
  const singlePositionPct = (proposedAmount / equity) * 100;
  if (singlePositionPct > maxSinglePct) {
    return {
      allowed: false,
      reason: `Single position ${singlePositionPct.toFixed(1)}% exceeds ${maxSinglePct}% max`,
      currentExposure: currentExposurePct,
      proposedExposure: proposedExposurePct,
      maxExposure: maxExposurePct,
      dryPowderPercent: dryPowderAfter,
    };
  }

  return {
    allowed: true,
    reason: "Exposure within limits",
    currentExposure: currentExposurePct,
    proposedExposure: proposedExposurePct,
    maxExposure: maxExposurePct,
    dryPowderPercent: dryPowderAfter,
  };
}
