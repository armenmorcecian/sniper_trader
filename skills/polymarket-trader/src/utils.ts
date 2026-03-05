import {
  BetSizeParams,
  BetSizeResult,
} from "./types";

// ─── Bet Sizing ─────────────────────────────────────────────────────────────

/**
 * Two-regime position sizing:
 *
 * Regime 1 (Fixed Fractional): bankroll <= $100 OR tradeCount < 50
 *   - bet = min($2.00, balance * 10%)
 *   - Survives 25 consecutive losses from $50
 *
 * Regime 2 (Half-Kelly): bankroll > $100 AND tradeCount >= 50
 *   - f* = (b*p - q) / b, then halved, capped at 25% of bankroll
 *   - Returns 0 if edge is negative
 */
export function calculateBetSize(params: BetSizeParams): BetSizeResult {
  const { currentBalance, marketPrice, estimatedProbability, tradeCount } =
    params;

  // Regime 1: Fixed Fractional — survival mode
  if (currentBalance <= 100 || tradeCount < 50) {
    const betSize = Math.min(2.0, currentBalance * 0.1);
    return {
      betSize: Math.max(0, Math.round(betSize * 100) / 100),
      regime: "fixed",
      reason:
        currentBalance <= 100
          ? "Survival mode: bankroll <= $100"
          : "Learning mode: fewer than 50 trades completed",
    };
  }

  // Regime 2: Half-Kelly
  // b = decimal odds = (1 - marketPrice) / marketPrice
  // f* = (b*p - q) / b where p = estimated probability, q = 1 - p
  const p = estimatedProbability;
  const q = 1 - p;
  const b = (1 - marketPrice) / marketPrice;

  if (b <= 0) {
    return {
      betSize: 0,
      regime: "half-kelly",
      reason: "Market price implies zero or negative odds",
      fraction: 0,
      edge: 0,
    };
  }

  const fullKelly = (b * p - q) / b;

  if (fullKelly <= 0) {
    return {
      betSize: 0,
      regime: "half-kelly",
      reason: "Negative edge — no bet",
      fraction: 0,
      edge: fullKelly,
    };
  }

  const halfKelly = fullKelly * 0.5;
  const cappedFraction = Math.min(halfKelly, 0.25);
  const betSize = Math.round(currentBalance * cappedFraction * 100) / 100;

  return {
    betSize,
    regime: "half-kelly",
    reason: `Half-Kelly: ${((cappedFraction ?? 0) * 100).toFixed(1)}% of bankroll`,
    fraction: cappedFraction,
    edge: fullKelly,
  };
}

// ─── Retry Logic (delegated to quant-core) ──────────────────────────────────
export { withRetry, isRetryable } from "quant-core";

// ─── Token Resolution ───────────────────────────────────────────────────────

/**
 * Maps "Yes"/"No" to the correct CLOB token ID.
 * Handles both array and JSON-string formats from Gamma API.
 */
export function resolveTokenId(
  outcomes: string[] | string,
  clobTokenIds: string[] | string,
  targetOutcome: string,
): string {
  const parsedOutcomes: string[] =
    typeof outcomes === "string" ? JSON.parse(outcomes) : outcomes;
  const parsedTokenIds: string[] =
    typeof clobTokenIds === "string" ? JSON.parse(clobTokenIds) : clobTokenIds;

  const index = parsedOutcomes.findIndex(
    (o) => o.toLowerCase() === targetOutcome.toLowerCase(),
  );

  if (index === -1) {
    throw new Error(
      `Outcome "${targetOutcome}" not found in outcomes: ${JSON.stringify(parsedOutcomes)}`,
    );
  }

  if (index >= parsedTokenIds.length) {
    throw new Error(
      `Token ID index ${index} out of bounds for tokens: ${JSON.stringify(parsedTokenIds)}`,
    );
  }

  return parsedTokenIds[index];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Safely parse a value that may be a JSON string or already an array/number.
 */
export function safeJsonParse<T>(value: T | string): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value;
}
