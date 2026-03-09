// ─── Crypto Scalper Types ────────────────────────────────────────────────────

// ─── Asset Identity ───────────────────────────────────────────────────────────

export type Asset = "BTC" | "ETH" | "SOL" | "DOGE" | "SUI" | "PEPE" | "LINK" | "AVAX";

export const ASSET_BINANCE_SYMBOL: Record<Asset, string> = {
  BTC: "btcusdt",
  ETH: "ethusdt",
  SOL: "solusdt",
  DOGE: "dogeusdt",
  SUI: "suiusdt",
  PEPE: "pepeusdt",
  LINK: "linkusdt",
  AVAX: "avaxusdt",
};

export const ASSET_SLUG_PREFIX: Record<Asset, string> = {
  BTC: "btc-updown-",
  ETH: "eth-updown-",
  SOL: "sol-updown-",
  DOGE: "doge-updown-",
  SUI: "sui-updown-",
  PEPE: "pepe-updown-",
  LINK: "link-updown-",
  AVAX: "avax-updown-",
};

// Hourly markets use a different slug pattern: "bitcoin-up-or-down-*", "ethereum-up-or-down-*"
export const ASSET_HOURLY_SLUG_PREFIX: Record<Asset, string> = {
  BTC: "bitcoin-up-or-down-",
  ETH: "ethereum-up-or-down-",
  SOL: "solana-up-or-down-",
  DOGE: "dogecoin-up-or-down-",
  SUI: "sui-up-or-down-",
  PEPE: "pepe-up-or-down-",
  LINK: "chainlink-up-or-down-",
  AVAX: "avalanche-up-or-down-",
};

// ─── Binance WebSocket Types ────────────────────────────────────────────────

export interface BinanceTrade {
  e: string;      // Event type ("trade")
  E: number;      // Event time
  s: string;      // Symbol ("BTCUSDT")
  t: number;      // Trade ID
  p: string;      // Price
  q: string;      // Quantity
  b: number;      // Buyer order ID
  a: number;      // Seller order ID
  T: number;      // Trade time
  m: boolean;     // Is buyer the market maker? (true = taker sell, false = taker buy)
}

export interface BinanceKline {
  e: string;      // Event type ("kline")
  E: number;      // Event time
  s: string;      // Symbol
  k: {
    t: number;    // Kline start time
    T: number;    // Kline close time
    s: string;    // Symbol
    i: string;    // Interval
    o: string;    // Open price
    c: string;    // Close price
    h: string;    // High price
    l: string;    // Low price
    v: string;    // Base asset volume
    x: boolean;   // Is this kline closed?
  };
}

// ─── Candle / Market Types ──────────────────────────────────────────────────

export type Timeframe = "5m" | "15m" | "1h" | "4h";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
};

export interface CandleMarket {
  conditionId: string;
  question: string;
  slug: string;
  asset: Asset;
  timeframe: Timeframe;
  startDate: string;         // ISO string — candle open (eventStartTime)
  endDate: string;           // ISO string — candle close
  clobTokenIds: string[];
  outcomePrices: number[];   // [upPrice, downPrice]
  upTokenId: string;         // First token = "Up" outcome
  downTokenId: string;       // Second token = "Down" outcome
  volumeNum: number;         // Traded volume ($)
  liquidityNum: number;      // Order book depth ($)
}

export interface CandleState {
  conditionId: string;
  market: CandleMarket;
  openPrice: number;         // Asset price when candle started tracking
  currentPrice: number;      // Latest asset price
  highPrice: number;
  lowPrice: number;
  vwapNumerator: number;     // sum(price * volume)
  vwapDenominator: number;   // sum(volume)
  netBuyVolume: number;      // Buy volume - Sell volume
  totalVolume: number;
  startTime: number;         // Unix ms — when we started tracking
  lastUpdateTime: number;    // Unix ms
}

// ─── Order Book Types ────────────────────────────────────────────────────────

export interface OrderBookSnapshot {
  exchange: "binance" | "bybit" | "okx";
  symbol: string;
  bids: [number, number][];  // [price, qty]
  asks: [number, number][];
  timestamp: number;
}

export interface AggregatedOBI {
  obi: number;            // -1 to +1 volume-weighted bid/ask imbalance
  bidVolume: number;      // total bid depth (USD) across exchanges
  askVolume: number;      // total ask depth (USD)
  exchangeCount: number;  // how many exchanges contributed
  timestamp: number;
}

export const ASSET_BYBIT_SYMBOL: Record<Asset, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", DOGE: "DOGEUSDT",
  SUI: "SUIUSDT", PEPE: "PEPEUSDT", LINK: "LINKUSDT", AVAX: "AVAXUSDT",
};

export const ASSET_OKX_SYMBOL: Record<Asset, string> = {
  BTC: "BTC-USDT", ETH: "ETH-USDT", SOL: "SOL-USDT", DOGE: "DOGE-USDT",
  SUI: "SUI-USDT", PEPE: "PEPE-USDT", LINK: "LINK-USDT", AVAX: "AVAX-USDT",
};

// ─── Signal Types ───────────────────────────────────────────────────────────

export interface ScalpSignal {
  conditionId: string;
  market: CandleMarket;
  asset: Asset;
  direction: "up" | "down";     // Which way asset is trending
  side: "Up" | "Down";          // Which outcome to buy on Polymarket
  marketPrice: number;          // Current Polymarket price for chosen side
  impliedProb: number;
  edge: number;
  returnFromOpen: number;
  vwapDeviation: number;
  flowRatio: number;
  elapsed: number;              // 0.0 - 1.0 fraction of candle elapsed
  timestamp: number;
}

export interface OpenPosition {
  conditionId: string;
  market: CandleMarket;
  asset: Asset;
  side: "Up" | "Down";
  entryPrice: number;           // Polymarket contract entry price
  entryTime: number;            // Unix ms
  entryAssetPrice: number;      // Asset price at entry
  entryReturnFromOpen: number;  // Asset return from candle open at entry
  amount: number;               // USD amount
  tradeId: number;              // Journal trade ID
  peakPnlPct: number;           // High-water mark for trailing TP
  failedSellAttempts: number;   // Consecutive sell failures — force-remove after 3
  tpOrderId?: string;       // GTC limit sell order ID (if useGtcTp enabled)
  tpPrice?: number;         // Target TP price (entryPrice * (1 + gtcTpPct/100))
}

export interface ExitSignal {
  conditionId: string;
  rule: "take_profit" | "stop_loss" | "momentum_reversal" | "time_decay" | "circuit_breaker";
  reason: string;
  urgency: "high" | "medium";
  currentPrice: number;         // Current Polymarket contract price
}

export interface PendingOrder {
  orderId: string;
  conditionId: string;
  asset: Asset;
  side: "Up" | "Down";
  timeframe: Timeframe;
  placedAt: number;
  limitPrice: number;
  amount: number;
  cancelled: boolean;
}

// ─── Asset Pipeline ───────────────────────────────────────────────────────────

import type { CandleTracker } from "./candle-tracker";
import type { VolTracker } from "./vol-tracker";
import type { TickCopulaTracker } from "./copula-tracker";

export interface AssetPipeline {
  asset: Asset;
  tracker: CandleTracker;
  volTracker: VolTracker;
  activeMarkets: CandleMarket[];
  prevGammaPrices: Map<string, number[]>;
  obiFeed?: { readonly isReady: boolean; readonly lastObi: AggregatedOBI | null; connect(): void; destroy(): void };
  copulaTracker?: TickCopulaTracker;
}

// ─── Health ─────────────────────────────────────────────────────────────────

export interface AssetHealthStats {
  activeMarkets: number;
  lastPrice: number;
}

export interface ScalperHealthStatus {
  lastPing: string;
  binanceConnected: boolean;
  assets: Record<string, AssetHealthStats>;
  openPositions: number;
  uptimeSeconds: number;
  lastSignalCheck: number;
  betsToday: number;
}

// ─── Polymarket Service Interface ───────────────────────────────────────────

export interface IPolymarketService {
  getPortfolioValue(): Promise<{
    usdcBalance: number;
    positionValue: number;
    totalEquity: number;
  }>;
  getUsdcBalance(): Promise<number>;
  createLimitOrder(params: {
    marketConditionId: string;
    outcome: string;
    side: "BUY" | "SELL";
    amount: number;
    limitPrice?: number;
    skipBalanceChecks?: boolean;
  }): Promise<{
    orderId: string;
    price: number;
    size: number;
    totalCost: number;
  }>;
  marketBuy(params: {
    marketConditionId: string;
    outcome: string;
    side: "BUY" | "SELL";
    amount: number;
    skipBalanceChecks?: boolean;
  }): Promise<{
    orderId: string;
    price: number;
    size: number;
    totalCost: number;
  }>;
  sellPosition(conditionId: string, outcome: string, knownSize?: number): Promise<{
    orderId: string;
    price: number;
  }>;
  getOrderStatus(orderId: string): Promise<{ status: string; price?: number }>;
  cancelOrder(orderId: string): Promise<{ success: boolean; orderId: string }>;
}

// ─── Polymarket Config (for PolymarketService constructor) ──────────────────

export interface PolymarketConfig {
  privateKey: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  funder?: string;
  walletAddress: string;
  clobHost: string;
  gammaHost: string;
  dataHost: string;
  proxyUrl?: string;
}
