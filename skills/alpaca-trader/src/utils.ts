import axios from "axios";
import {
  BetSizeParams,
  BetSizeResult,
  MarketStatus,
} from "./types";

// ─── Re-export constants from quant-core ─────────────────────────────────────

export { ETF_WATCHLIST, SECTOR_UNIVERSE } from "quant-core";

// ─── Market Status ──────────────────────────────────────────────────────────

/**
 * Queries Alpaca /v2/clock to determine market status.
 * Uses the clock's timestamps to handle holidays correctly.
 */
export async function getMarketStatus(
  tradingBaseUrl: string,
  apiKeyId: string,
  apiSecretKey: string,
): Promise<{ status: MarketStatus; nextOpen: string; nextClose: string }> {
  const response = await axios.get(`${tradingBaseUrl}/v2/clock`, {
    headers: {
      "APCA-API-KEY-ID": apiKeyId,
      "APCA-API-SECRET-KEY": apiSecretKey,
    },
    timeout: 10000,
  });

  const clock = response.data;
  const isOpen: boolean = clock.is_open;
  const now = new Date();
  const nextOpen = new Date(clock.next_open);
  const nextClose = new Date(clock.next_close);

  let status: MarketStatus;

  if (isOpen) {
    status = "open";
  } else {
    // Market is closed — determine if pre, after, or fully closed
    const hour = now.getUTCHours();
    // Extended hours: pre-market 4AM-9:30AM ET, after-hours 4PM-8PM ET
    // ET is UTC-5 (EST) or UTC-4 (EDT)
    // Approximation: use the clock response to determine
    // If next_open is today and we're before it: pre-market
    // If next_open is tomorrow: after-hours or closed
    const todayStr = now.toISOString().split("T")[0];
    const nextOpenStr = nextOpen.toISOString().split("T")[0];

    if (nextOpenStr === todayStr) {
      // Next open is today — we're in pre-market
      status = "pre";
    } else {
      // Next open is a future day
      // Check if we're in after-hours (same day as next_close or recently closed)
      const nextCloseStr = nextClose.toISOString().split("T")[0];
      if (nextCloseStr > todayStr) {
        // next_close is in the future but next_open is also in the future
        // This means market closed today and we might be in after-hours
        // Use UTC hour heuristic: after-hours is roughly 21:00-01:00 UTC (4PM-8PM ET)
        if (hour >= 20 || hour < 1) {
          status = "after";
        } else {
          status = "closed";
        }
      } else {
        status = "closed";
      }
    }
  }

  return {
    status,
    nextOpen: clock.next_open,
    nextClose: clock.next_close,
  };
}

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
    reason: `Half-Kelly: ${(cappedFraction * 100).toFixed(1)}% of bankroll`,
    fraction: cappedFraction,
    edge: fullKelly,
  };
}

// ─── Retry Logic (delegated to quant-core) ──────────────────────────────────
export { withRetry, isRetryable } from "quant-core";
