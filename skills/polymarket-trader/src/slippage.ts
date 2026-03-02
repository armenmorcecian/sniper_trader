// ─── Order Book Slippage Model ───────────────────────────────────────────────
//
// Walks the order book to compute the volume-weighted average fill price
// (VWAP) for a given order size. FOK orders eat through multiple price levels
// when the top-of-book liquidity is insufficient — the actual fill cost is
// higher than the best ask.
//
// This model answers: "If I send a $X FOK order, what price will I actually
// pay after consuming multiple book levels?"
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderBookLevel {
  price: string;
  size: string;
}

export interface SlippageEstimate {
  /** Volume-weighted average fill price */
  vwap: number;
  /** Best available price (top of book) */
  bestPrice: number;
  /** Deepest price level touched */
  worstPrice: number;
  /** Slippage in basis points relative to best price */
  slippageBps: number;
  /** Number of order book levels consumed */
  levelsTouched: number;
  /** Whether the book has enough depth to fill the entire order */
  fullyFillable: boolean;
  /** Unfilled size in USD if book is too thin */
  remainingSize: number;
}

// ─── Buy-Side Slippage (Walking Asks) ─────────────────────────────────────

/**
 * Estimate the fill price for a BUY FOK order by walking the ask side.
 * Asks are assumed sorted ascending by price (best ask first).
 *
 * @param asks         - Ask-side order book levels
 * @param orderSizeUsd - Total USD amount to fill
 */
export function estimateSlippage(
  asks: OrderBookLevel[],
  orderSizeUsd: number,
): SlippageEstimate {
  if (!asks || asks.length === 0 || orderSizeUsd <= 0) {
    return {
      vwap: Infinity,
      bestPrice: Infinity,
      worstPrice: Infinity,
      slippageBps: 0,
      levelsTouched: 0,
      fullyFillable: false,
      remainingSize: orderSizeUsd,
    };
  }

  let remainingUsd = orderSizeUsd;
  let totalCost = 0;
  let totalTokens = 0;
  let levelsTouched = 0;
  let worstPrice = 0;

  const bestPrice = parseFloat(asks[0].price);

  for (const level of asks) {
    if (remainingUsd <= 0) break;

    const price = parseFloat(level.price);
    const sizeTokens = parseFloat(level.size);
    const levelUsd = price * sizeTokens;

    levelsTouched++;
    worstPrice = price;

    if (levelUsd >= remainingUsd) {
      // This level can fill the remaining order
      const tokensNeeded = remainingUsd / price;
      totalCost += remainingUsd;
      totalTokens += tokensNeeded;
      remainingUsd = 0;
    } else {
      // Consume the entire level
      totalCost += levelUsd;
      totalTokens += sizeTokens;
      remainingUsd -= levelUsd;
    }
  }

  const fullyFillable = remainingUsd <= 0;
  const vwap = totalTokens > 0 ? totalCost / totalTokens : Infinity;
  const slippageBps =
    bestPrice > 0 && vwap < Infinity
      ? Math.round(((vwap - bestPrice) / bestPrice) * 10000)
      : 0;

  return {
    vwap: Math.round(vwap * 100000) / 100000,
    bestPrice,
    worstPrice,
    slippageBps,
    levelsTouched,
    fullyFillable,
    remainingSize: Math.round(Math.max(0, remainingUsd) * 10000) / 10000,
  };
}

// ─── Sell-Side Slippage (Walking Bids) ──────────────────────────────────────

/**
 * Estimate the fill price for a SELL FOK order by walking the bid side.
 * Bids are assumed sorted descending by price (best bid first).
 *
 * @param bids            - Bid-side order book levels
 * @param orderSizeTokens - Total tokens to sell
 */
export function estimateSellSlippage(
  bids: OrderBookLevel[],
  orderSizeTokens: number,
): SlippageEstimate {
  if (!bids || bids.length === 0 || orderSizeTokens <= 0) {
    return {
      vwap: 0,
      bestPrice: 0,
      worstPrice: 0,
      slippageBps: 0,
      levelsTouched: 0,
      fullyFillable: false,
      remainingSize: orderSizeTokens,
    };
  }

  let remainingTokens = orderSizeTokens;
  let totalProceeds = 0;
  let totalSold = 0;
  let levelsTouched = 0;
  let worstPrice = Infinity;

  const bestPrice = parseFloat(bids[0].price);

  for (const level of bids) {
    if (remainingTokens <= 0) break;

    const price = parseFloat(level.price);
    const sizeTokens = parseFloat(level.size);

    levelsTouched++;
    worstPrice = price;

    if (sizeTokens >= remainingTokens) {
      // This level can absorb remaining sell
      totalProceeds += price * remainingTokens;
      totalSold += remainingTokens;
      remainingTokens = 0;
    } else {
      // Consume entire bid level
      totalProceeds += price * sizeTokens;
      totalSold += sizeTokens;
      remainingTokens -= sizeTokens;
    }
  }

  const fullyFillable = remainingTokens <= 0;
  const vwap = totalSold > 0 ? totalProceeds / totalSold : 0;
  const slippageBps =
    bestPrice > 0 && vwap > 0
      ? Math.round(((bestPrice - vwap) / bestPrice) * 10000)
      : 0;

  return {
    vwap: Math.round(vwap * 100000) / 100000,
    bestPrice,
    worstPrice: worstPrice === Infinity ? 0 : worstPrice,
    slippageBps,
    levelsTouched,
    fullyFillable,
    remainingSize: Math.round(Math.max(0, remainingTokens) * 10000) / 10000,
  };
}
