// ─── Penny Collector Config ─────────────────────────────────────────────────

import type { Asset, AssetConfig, PolymarketConfig, Timeframe } from "./types";

export interface PennyConfig {
  polymarketConfig: PolymarketConfig;
  gammaHost: string;

  assets: Asset[];
  assetConfigs: Map<Asset, AssetConfig>;

  // Time window
  minSecondsBeforeExpiry: number;
  maxSecondsBeforeExpiry: number;

  // Price window
  minWinningPrice: number;
  maxWinningPrice: number;
  maxSpread: number;
  minLiquidity: number;
  minLiquidityByTimeframe: Partial<Record<Timeframe, number>>;

  // Position sizing
  maxBetAmount: number;
  maxConcurrentPositions: number;
  maxBetsPerHour: number;
  cashReservePct: number;

  // Risk
  stopLossPct: number;

  // Scanning
  scanIntervalMs: number;

  // Limit order
  limitOrderTimeoutMs: number;
  limitOrderPollMs: number;

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function loadConfig(): PennyConfig {
  const privateKey = process.env.PRIVATE_KEY;
  const walletAddress = process.env.WALLET_ADDRESS;

  if (!privateKey) throw new Error("PRIVATE_KEY is required");
  if (!walletAddress) throw new Error("WALLET_ADDRESS is required");

  const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

  const assetsRaw = process.env.PENNY_ASSETS || "BTC";
  const assets = assetsRaw.split(",").map((s) => s.trim().toUpperCase()) as Asset[];

  const targetTimeframes = (process.env.PENNY_TARGET_TIMEFRAMES || "15m,1h,4h")
    .split(",")
    .map((s) => s.trim()) as Timeframe[];

  const assetConfigs = new Map<Asset, AssetConfig>();
  for (const asset of assets) {
    assetConfigs.set(asset, { asset, targetTimeframes });
  }

  return {
    polymarketConfig: {
      privateKey,
      walletAddress,
      apiKey: process.env.POLY_API_KEY,
      apiSecret: process.env.POLY_API_SECRET,
      passphrase: process.env.POLY_PASSPHRASE,
      funder: process.env.POLY_FUNDER,
      clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
      gammaHost,
      dataHost: process.env.DATA_HOST || "https://data-api.polymarket.com",
      proxyUrl: process.env.PROXY_URL,
      polygonRpc: process.env.POLYGON_RPC_URL
        || (process.env.POLYGON_WS_RPC ? process.env.POLYGON_WS_RPC.replace("wss://", "https://").replace("ws://", "http://") : undefined),
      builderApiKey: process.env.BUILDER_API_KEY,
      builderSecret: process.env.BUILDER_SECRET,
      builderPassphrase: process.env.BUILDER_PASSPHRASE,
    },
    gammaHost,
    assets,
    assetConfigs,

    minSecondsBeforeExpiry: Number(process.env.PENNY_MIN_SECONDS_BEFORE_EXPIRY) || 30,
    maxSecondsBeforeExpiry: Number(process.env.PENNY_MAX_SECONDS_BEFORE_EXPIRY) || 120,

    minWinningPrice: Number(process.env.PENNY_MIN_WINNING_PRICE) || 0.90,
    maxWinningPrice: Number(process.env.PENNY_MAX_WINNING_PRICE) || 0.97,
    maxSpread: Number(process.env.PENNY_MAX_SPREAD) || 0.08,
    minLiquidity: Number(process.env.PENNY_MIN_LIQUIDITY) || 3000,
    minLiquidityByTimeframe: {
      "4h": Number(process.env.PENNY_MIN_LIQUIDITY_4H) || 500,
      ...(process.env.PENNY_MIN_LIQUIDITY_15M ? { "15m": Number(process.env.PENNY_MIN_LIQUIDITY_15M) } : {}),
      ...(process.env.PENNY_MIN_LIQUIDITY_1H ? { "1h": Number(process.env.PENNY_MIN_LIQUIDITY_1H) } : {}),
    },

    stopLossPct: Number(process.env.PENNY_STOP_LOSS_PCT) || 15,

    maxBetAmount: Number(process.env.PENNY_MAX_BET) || 10.0,
    maxConcurrentPositions: Number(process.env.PENNY_MAX_CONCURRENT) || 3,
    maxBetsPerHour: Number(process.env.PENNY_MAX_BETS_PER_HOUR) || 30,
    cashReservePct: Number(process.env.PENNY_CASH_RESERVE_PCT) || 25,

    scanIntervalMs: Number(process.env.PENNY_SCAN_INTERVAL_MS) || 5000,

    limitOrderTimeoutMs: Number(process.env.PENNY_LIMIT_ORDER_TIMEOUT_MS) || 3000,
    limitOrderPollMs: Number(process.env.PENNY_LIMIT_ORDER_POLL_MS) || 1000,

    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
  };
}
