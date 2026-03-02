// ─── Dynamic Taker Fee Model for Polymarket ─────────────────────────────────
//
// Polymarket charges dynamic taker fees on certain markets (e.g., 15-minute
// crypto contracts). Fees scale inversely with market certainty:
//
//   fee(p) = baseFeeRate × 2 × p × (1 − p)
//
// Peak fee: ~3.15% when p = 0.50 (maximum uncertainty)
// Fee → 0 as p → 0 or p → 1 (high certainty)
//
// The baseFeeRate ≈ 0.063 is calibrated so that the peak = ~3.15%.
// For non-fee markets, pass marketType = "standard" to bypass fees.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_FEE_RATE = 0.063;
const PAIR_REDEMPTION = 1.0; // Binary: Yes + No always redeem for $1.00

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FeeEstimate {
  /** Fee rate as a decimal (e.g., 0.0315 = 3.15%) */
  feeRate: number;
  /** Absolute fee amount in USD for the given notional */
  feeAmount: number;
  /** Price including fee (price + fee per unit) */
  effectivePrice: number;
}

export interface PairFees {
  leg1Fee: FeeEstimate;
  leg2Fee: FeeEstimate;
  /** Sum of both leg fees in USD */
  totalFees: number;
  /** 1.00 minus total fee rates — the real redemption after fees */
  netPairSum: number;
}

// ─── Fee Computation ─────────────────────────────────────────────────────────

/**
 * Compute the taker fee for a single leg at a given price.
 *
 * @param price     - Contract price (0 to 1)
 * @param notional  - USD notional (amount spent)
 * @param marketType - "crypto-15m" applies dynamic fees; "standard" = no fees
 */
export function computeTakerFee(
  price: number,
  notional: number,
  marketType: string = "crypto-15m",
): FeeEstimate {
  if (marketType === "standard" || price <= 0 || price >= 1) {
    return { feeRate: 0, feeAmount: 0, effectivePrice: price };
  }

  // fee(p) = baseFeeRate × 2 × p × (1 − p)
  const feeRate = BASE_FEE_RATE * 2 * price * (1 - price);
  const feePerUnit = feeRate * price;
  const size = notional / price;
  const feeAmount = feePerUnit * size;

  return {
    feeRate: Math.round(feeRate * 100000) / 100000,
    feeAmount: Math.round(feeAmount * 10000) / 10000,
    effectivePrice: Math.round((price + feePerUnit) * 10000) / 10000,
  };
}

/**
 * Compute fees for both legs of a pair arbitrage.
 *
 * @param p1       - Leg 1 fill price
 * @param p2       - Leg 2 fill price
 * @param notional - USD notional per leg
 */
export function computePairFees(
  p1: number,
  p2: number,
  notional: number,
): PairFees {
  const leg1Fee = computeTakerFee(p1, notional);
  const leg2Fee = computeTakerFee(p2, notional);
  const totalFees = leg1Fee.feeAmount + leg2Fee.feeAmount;
  const totalFeeRate = leg1Fee.feeRate + leg2Fee.feeRate;

  return {
    leg1Fee,
    leg2Fee,
    totalFees: Math.round(totalFees * 10000) / 10000,
    netPairSum: Math.round((PAIR_REDEMPTION - totalFeeRate) * 10000) / 10000,
  };
}

/**
 * Compute the maximum acceptable price for leg 2 after accounting for fees.
 *
 * Without fees:  maxPrice = 1.00 − p1 − margin
 * With fees:     maxPrice = netPairSum − p1 − margin
 *                         = (1.00 − fee1Rate − fee2RateEstimate) − p1 − margin
 *
 * Since we don't know leg 2's exact price yet, we estimate its fee using
 * the complement price (1 − p1) as a proxy. This is conservative — the
 * actual fee may be slightly different once the real fill price is known.
 *
 * @param p1Filled - Leg 1 actual fill price
 * @param margin   - Target profit margin
 * @param notional - USD notional per leg
 */
export function feeAdjustedMaxAcceptable(
  p1Filled: number,
  margin: number,
  notional: number,
): number {
  const leg1FeeRate = computeTakerFee(p1Filled, notional).feeRate;

  // Estimate leg 2 fee at the complement price
  const estimatedP2 = PAIR_REDEMPTION - p1Filled;
  const leg2FeeRate = computeTakerFee(estimatedP2, notional).feeRate;

  const netPairSum = PAIR_REDEMPTION - leg1FeeRate - leg2FeeRate;
  const maxAcceptable = netPairSum - p1Filled - margin;

  return Math.round(maxAcceptable * 10000) / 10000;
}
