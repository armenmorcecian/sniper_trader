// ─── Penny Collector Types ──────────────────────────────────────────────────

export type Asset = "BTC" | "ETH" | "SOL" | "DOGE" | "SUI" | "PEPE" | "LINK" | "AVAX";
export type Timeframe = "5m" | "15m" | "1h" | "4h";

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

export interface CandleMarket {
  conditionId: string;
  question: string;
  slug: string;
  asset: Asset;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  clobTokenIds: string[];
  outcomePrices: number[];
  upTokenId: string;
  downTokenId: string;
  volumeNum: number;
  liquidityNum: number;
}

export interface IPolymarketService {
  getUsdcBalance(): Promise<number>;
  getPortfolioValue(): Promise<{
    usdcBalance: number;
    positionValue: number;
    totalEquity: number;
    positions?: Array<{
      conditionId: string;
      size: number;
      currentPrice: number;
    }>;
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
    status: string;
  }>;
  fastMarketBuy(params: {
    tokenId: string;
    amount: number;
    side: "BUY" | "SELL";
  }): Promise<{
    orderId: string;
    price: number;
    size: number;
    totalCost: number;
    status: string;
  }>;
  redeemWinningTokens?(conditionId: string): Promise<boolean>;
  sellPosition?(conditionId: string, outcome: string, knownSize?: number): Promise<{
    orderId: string;
    price: number;
    size: number;
    totalCost: number;
    status: string;
  }>;
}

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
  polygonRpc?: string;
}

export interface PennyCandidate {
  market: CandleMarket;
  winningSide: "Up" | "Down";
  winningPrice: number;
  secondsRemaining: number;
  tokenId: string;
  expectedProfit: number;
}

export interface PennyPosition {
  conditionId: string;
  market: CandleMarket;
  side: "Up" | "Down";
  entryPrice: number;
  entryTime: number;
  amount: number;
  tradeId: number;
  orderId: string;
  tokenId: string;
  status: "open" | "sold";
  tokens?: number;                // actual outcome token quantity received at fill
  stopLossExhausted?: boolean;    // true when stop-loss can't execute (value too small)
  stopLossUnexecutable?: boolean; // true when CLOB rejects sell (builder-relayer tokens not in CTF Exchange)
}

// Minimal AssetConfig for MarketDiscovery compatibility
export interface AssetConfig {
  asset: Asset;
  targetTimeframes: Timeframe[];
}
