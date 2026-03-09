// ─── Copycat Wallet Types ────────────────────────────────────────────────────

export interface TrackedWallet {
  proxyWallet: string;
  userName: string;
  pnl: number;
  rank: number;
}

export interface MarketInfo {
  conditionId: string;
  outcome: string;
  question: string;
  slug: string;
  endDate?: string;  // ISO 8601 — market resolution deadline from Gamma API
}

export interface CopyPosition {
  conditionId: string;
  tokenId: string;
  outcome: string;
  question: string;
  entryPrice: number;
  entryTime: number;
  amount: number;
  shares: number;
  sourceWallet: string;
  tradeId: number;
  exchange?: "ctf" | "negrisk";
}

export interface OrderFilledEvent {
  type: "buy" | "sell";
  tokenId: string;
  usdcAmount: number;
  shares: number;
  price: number;
  exchange: "ctf" | "negrisk";
  sourceWallet: string;
  /** When we first observed this on-chain event (ms epoch) */
  timestamp: number;
}

export type TimePeriod = "DAY" | "WEEK" | "MONTH" | "ALL";

export interface WalletScore {
  proxyWallet: string;
  userName: string;
  categories: TimePeriod[];
  tier: number; // 1-4: how many leaderboards the wallet appears on
  bestPnl: number;
  vol: number;
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
  sellPosition(conditionId: string, outcome: string, knownSize?: number): Promise<{
    orderId: string;
    price: number;
    size: number;
    totalCost: number;
    status: string;
  }>;
  getPrice(tokenId: string): Promise<{ price: number; side: string }>;
  redeemWinningTokens?(conditionId: string): Promise<boolean>;
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
