import { PolymarketService } from "./polymarket.service";
import type {
  ArbitrageParams,
  ArbitragePhase,
  ArbitrageLegStatus,
  ArbitrageResult,
} from "./types";
import { recordTrade } from "quant-core";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_LEG_TIMEOUT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 500;
/** Polymarket binary markets: Yes + No tokens always sum to 1.00 */
const PAIR_SUM = 1.0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function oppositeOutcome(outcome: "Yes" | "No"): "Yes" | "No" {
  return outcome === "Yes" ? "No" : "Yes";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the best (lowest) ask price from the order book for a given outcome.
 * Returns Infinity if no asks are available.
 */
function bestAskFromBook(
  orderBook: { asks: Array<{ price: string; size: string }> },
): number {
  if (!orderBook.asks || orderBook.asks.length === 0) return Infinity;
  // Order book asks are sorted ascending by price — first entry is best ask
  return parseFloat(orderBook.asks[0].price);
}

// ─── Core Arbitrage Engine ──────────────────────────────────────────────────

/**
 * Executes a two-legged pair arbitrage on a binary Polymarket market.
 *
 * Mathematical basis:
 *   In a binary market, Yes + No tokens redeem for exactly $1.00 on resolution.
 *   If we can buy Yes at P1 and No at P2 where P1 + P2 < 1.00, we lock in
 *   guaranteed profit = 1.00 - P1 - P2 per unit regardless of outcome.
 *
 * Execution sequence:
 *   1. Place Leg 1 as a GTC limit order at `firstLegPrice`
 *   2. Wait for fill confirmation (poll open orders)
 *   3. Start `legTimeoutMs` timer — during this window:
 *      a. Poll order book for the opposite outcome every `pollIntervalMs`
 *      b. Compute Max_Acceptable_Price = 1.00 - P_filled - margin
 *      c. If best ask ≤ Max_Acceptable_Price → send FOK market order to lock pair
 *   4. If timer expires without completing the pair → BAILOUT:
 *      a. Cancel any pending leg 2 order
 *      b. Immediately market-sell leg 1 tokens to flatten position
 *      c. Accept the fractional loss from spread/slippage
 */
export async function executePairArbitrage(
  service: PolymarketService,
  params: ArbitrageParams,
): Promise<ArbitrageResult> {
  const startTime = Date.now();
  const {
    marketConditionId,
    firstLeg,
    amount,
    firstLegPrice,
    margin,
    legTimeoutMs = DEFAULT_LEG_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = params;

  const secondLeg = oppositeOutcome(firstLeg);
  const maxAcceptablePrice = PAIR_SUM - firstLegPrice - margin;

  let phase: ArbitragePhase = "LEG1_PENDING";
  let leg1: ArbitrageLegStatus = {
    outcome: firstLeg,
    orderId: "",
    price: firstLegPrice,
    size: amount / firstLegPrice,
    status: "pending",
  };
  let leg2: ArbitrageLegStatus | null = null;
  let bailoutSell: { orderId: string; price: number; size: number } | undefined;

  const makeResult = (summary: string): ArbitrageResult => ({
    phase,
    leg1,
    leg2,
    pairComplete: phase === "COMPLETE",
    netPnl: calculateNetPnl(leg1, leg2, bailoutSell),
    maxAcceptablePrice: Math.round(maxAcceptablePrice * 10000) / 10000,
    bailoutTriggered: phase === "FLAT",
    bailoutSell,
    elapsedMs: Date.now() - startTime,
    summary,
  });

  // ── Validate params ───────────────────────────────────────────────────────
  if (maxAcceptablePrice <= 0) {
    phase = "FAILED";
    return makeResult(
      `Invalid setup: maxAcceptablePrice=${maxAcceptablePrice.toFixed(4)} ≤ 0. ` +
      `firstLegPrice (${firstLegPrice}) + margin (${margin}) ≥ 1.00. No room for profit.`,
    );
  }

  // ── Step 1: Place Leg 1 (GTC limit order) ─────────────────────────────────
  try {
    const leg1Result = await service.createLimitOrder({
      marketConditionId,
      outcome: firstLeg,
      side: "BUY",
      amount,
      limitPrice: firstLegPrice,
      orderType: "GTC",
    });

    leg1.orderId = leg1Result.orderId;
    leg1.size = leg1Result.size;
    leg1.price = leg1Result.price;

    recordTrade({
      skill: "polymarket",
      tool: "execute_pair_arbitrage",
      conditionId: marketConditionId,
      side: "BUY",
      amount,
      price: firstLegPrice,
      status: "submitted",
      metadata: { leg: 1, outcome: firstLeg, phase: "LEG1_PENDING" },
    });
  } catch (err) {
    phase = "FAILED";
    leg1.status = "failed";
    recordTrade({
      skill: "polymarket",
      tool: "execute_pair_arbitrage",
      conditionId: marketConditionId,
      side: "BUY",
      amount,
      price: firstLegPrice,
      status: "error",
      metadata: { leg: 1, error: err instanceof Error ? err.message : String(err) },
    });
    return makeResult(`Leg 1 failed to submit: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 2: Wait for Leg 1 fill ──────────────────────────────────────────
  // Poll for fill with a generous timeout (10x the leg timeout, capped at 30s)
  const fillPollTimeout = Math.min(legTimeoutMs * 10, 30000);
  const fillPollStart = Date.now();

  while (Date.now() - fillPollStart < fillPollTimeout) {
    try {
      const order = await service.getOrderStatus(leg1.orderId);
      if (order.status === "MATCHED" || order.status === "FILLED") {
        leg1.status = "filled";
        // Use the actual fill price if available
        if (order.price) leg1.price = order.price;
        phase = "LEG1_FILLED";
        break;
      }
      if (order.status === "CANCELLED" || order.status === "EXPIRED") {
        leg1.status = "cancelled";
        phase = "FAILED";
        return makeResult(`Leg 1 order was ${order.status.toLowerCase()} before filling.`);
      }
    } catch {
      // Transient error — continue polling
    }
    await sleep(pollIntervalMs);
  }

  if (leg1.status !== "filled") {
    // Leg 1 never filled — cancel and abort
    try { await service.cancelOrder(leg1.orderId); } catch { /* best effort */ }
    leg1.status = "cancelled";
    phase = "FAILED";
    return makeResult(
      `Leg 1 did not fill within ${fillPollTimeout}ms. Order cancelled.`,
    );
  }

  // ── Step 3: Dynamic Hedging Window ────────────────────────────────────────
  // P_filled is now locked. Compute the ceiling for leg 2.
  const pFilled = leg1.price;
  const dynamicMaxPrice = PAIR_SUM - pFilled - margin;
  phase = "HEDGING";

  recordTrade({
    skill: "polymarket",
    tool: "execute_pair_arbitrage",
    conditionId: marketConditionId,
    side: "BUY",
    amount,
    price: pFilled,
    status: "submitted",
    metadata: {
      leg: 1,
      outcome: firstLeg,
      phase: "LEG1_FILLED",
      maxAcceptableForLeg2: dynamicMaxPrice,
    },
  });

  const hedgeStart = Date.now();

  while (Date.now() - hedgeStart < legTimeoutMs) {
    try {
      // Poll order book for the opposite outcome
      const { orderBook } = await service.getOrderBookForToken(
        marketConditionId,
        secondLeg,
      );
      const bestAsk = bestAskFromBook(orderBook);

      if (bestAsk <= dynamicMaxPrice) {
        // Best ask is within our profit window — cross the spread with FOK
        phase = "LEG2_FILLED";
        const leg2Size = amount / bestAsk;

        try {
          const leg2Result = await service.marketBuy({
            marketConditionId,
            outcome: secondLeg,
            side: "BUY",
            amount,
            orderType: "FOK",
          });

          leg2 = {
            outcome: secondLeg,
            orderId: leg2Result.orderId,
            price: bestAsk,
            size: leg2Result.size || leg2Size,
            status: "filled",
          };

          phase = "COMPLETE";
          const lockedSpread = PAIR_SUM - pFilled - bestAsk;

          recordTrade({
            skill: "polymarket",
            tool: "execute_pair_arbitrage",
            conditionId: marketConditionId,
            side: "BUY",
            amount,
            price: bestAsk,
            status: "submitted",
            pnl: lockedSpread * leg1.size,
            metadata: {
              leg: 2,
              outcome: secondLeg,
              phase: "COMPLETE",
              lockedSpread,
            },
          });

          return makeResult(
            `Pair complete! Bought ${firstLeg}@${pFilled.toFixed(4)} + ${secondLeg}@${bestAsk.toFixed(4)} = ` +
            `${(pFilled + bestAsk).toFixed(4)}. Locked spread: ${lockedSpread.toFixed(4)} per unit.`,
          );
        } catch (err) {
          // FOK failed (likely filled away) — continue polling
          leg2 = {
            outcome: secondLeg,
            orderId: "",
            price: bestAsk,
            size: leg2Size,
            status: "failed",
          };
          phase = "HEDGING"; // Back to hedging, try again
        }
      }
    } catch {
      // Order book fetch failed — continue polling
    }

    await sleep(pollIntervalMs);
  }

  // ── Step 4: Bailout — Timeout expired, pair incomplete ────────────────────
  phase = "BAILING_OUT";

  recordTrade({
    skill: "polymarket",
    tool: "execute_pair_arbitrage",
    conditionId: marketConditionId,
    side: "SELL",
    amount: leg1.size,
    price: pFilled,
    status: "submitted",
    metadata: {
      leg: "bailout",
      outcome: firstLeg,
      phase: "BAILING_OUT",
      reason: `Leg timeout (${legTimeoutMs}ms) expired without completing pair`,
    },
  });

  try {
    // Flatten position: market-sell the filled leg 1 tokens
    const sellResult = await service.sellPosition(marketConditionId, firstLeg);

    bailoutSell = {
      orderId: sellResult.orderId,
      price: sellResult.price || pFilled, // Market sell — actual price unknown until filled
      size: sellResult.size || leg1.size,
    };

    phase = "FLAT";
    return makeResult(
      `BAILOUT: Timeout (${legTimeoutMs}ms) expired. Sold ${firstLeg} position to flatten. ` +
      `Best leg 2 ask never reached max acceptable price (${dynamicMaxPrice.toFixed(4)}).`,
    );
  } catch (err) {
    // Bailout sell failed — we're stuck with directional exposure
    phase = "FAILED";
    const errMsg = err instanceof Error ? err.message : String(err);

    recordTrade({
      skill: "polymarket",
      tool: "execute_pair_arbitrage",
      conditionId: marketConditionId,
      side: "SELL",
      amount: leg1.size,
      status: "error",
      metadata: { leg: "bailout_failed", error: errMsg },
    });

    return makeResult(
      `CRITICAL: Bailout sell failed — holding directional ${firstLeg} position. Error: ${errMsg}. ` +
      `Manual intervention required: sell ${firstLeg} on ${marketConditionId}.`,
    );
  }
}

// ─── P&L Calculation ────────────────────────────────────────────────────────

function calculateNetPnl(
  leg1: ArbitrageLegStatus,
  leg2: ArbitrageLegStatus | null,
  bailoutSell?: { orderId: string; price: number; size: number },
): number {
  if (leg1.status !== "filled") return 0;

  const leg1Cost = leg1.price * leg1.size;

  if (leg2 && leg2.status === "filled") {
    // Pair complete: profit = (1.00 * minSize) - leg1Cost - leg2Cost
    const leg2Cost = leg2.price * leg2.size;
    const minSize = Math.min(leg1.size, leg2.size);
    return Math.round((PAIR_SUM * minSize - leg1Cost - leg2Cost) * 10000) / 10000;
  }

  if (bailoutSell) {
    // Bailout: loss = sellProceeds - leg1Cost
    const sellProceeds = bailoutSell.price * bailoutSell.size;
    return Math.round((sellProceeds - leg1Cost) * 10000) / 10000;
  }

  // Still holding — unrealized
  return -leg1Cost;
}
