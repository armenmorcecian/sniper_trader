// ─── Configuration ───────────────────────────────────────────────────────────

import type { Asset, PolymarketConfig, Timeframe } from "./types";

export interface AssetConfig {
  asset: Asset;
  maxBet: number;
  targetTimeframes: Timeframe[];
  volScale5m: number;
  volScale15m: number;
  volScale1h: number;
  volScale4h: number;
  minMomentumPct: number;
  minVwapDevPct: number;
  minFlowRatio: number;
  minEdge: number;
}

export interface Config {
  // Polymarket connection
  polymarketConfig: PolymarketConfig;
  gammaHost: string;

  // Assets
  assets: Asset[];
  assetConfigs: Map<Asset, AssetConfig>;

  // Global risk controls
  defaultMaxBet: number;
  maxDailyLossPct: number;
  cashReservePct: number;
  maxConcurrentBets: number;
  maxBetsPerHour: number;
  cooldownAfterLossMs: number;
  polyFeeRate: number;

  // Exit thresholds (global)
  baseTakeProfitPct: number;
  tpDecayFactor: number;
  baseStopLossPct: number;
  slTightenFactor: number;
  maxHoldElapsed: number;
  trailingTpActivationPct: number;
  trailingTpDropPct: number;

  // Global signal thresholds (defaults for per-asset)
  minMomentumPct: number;
  minVwapDevPct: number;
  minFlowRatio: number;
  minEdge: number;
  maxSpread: number;
  minElapsed: number;
  maxElapsed: number;
  maxElapsed5m: number;
  minLiquidity: number;
  maxEntryPrice: number;

  // Global vol scales (defaults for per-asset)
  volScale5m: number;
  volScale15m: number;
  volScale1h: number;
  volScale4h: number;

  // Limit order settings
  useLimitOrders: boolean;
  limitOrderTimeoutMs: number;
  limitOrderPollMs: number;

  // Market discovery
  targetTimeframes: Timeframe[];
  marketPollMs: number;

  // Signal eval interval (buy checks)
  evalIntervalMs: number;

  // Exit eval interval (faster TP/SL checks)
  exitIntervalMs: number;

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;
}

/** Read an env var with per-asset prefix fallback: ASSET_KEY → BTC_KEY → hardcoded default */
function envNum(asset: Asset, key: string, fallback: number): number {
  const assetVal = process.env[`${asset}_${key}`];
  if (assetVal !== undefined && assetVal !== "") return Number(assetVal);
  const btcVal = process.env[`BTC_${key}`];
  if (btcVal !== undefined && btcVal !== "") return Number(btcVal);
  return fallback;
}

function envStr(asset: Asset, key: string, fallback: string): string {
  const assetVal = process.env[`${asset}_${key}`];
  if (assetVal !== undefined && assetVal !== "") return assetVal;
  const btcVal = process.env[`BTC_${key}`];
  if (btcVal !== undefined && btcVal !== "") return btcVal;
  return fallback;
}

function buildAssetConfig(asset: Asset, globalConfig: {
  defaultMaxBet: number;
  targetTimeframes: Timeframe[];
  volScale5m: number;
  volScale15m: number;
  volScale1h: number;
  volScale4h: number;
  minMomentumPct: number;
  minVwapDevPct: number;
  minFlowRatio: number;
  minEdge: number;
}): AssetConfig {
  return {
    asset,
    maxBet: envNum(asset, "MAX_BET", globalConfig.defaultMaxBet),
    targetTimeframes: envStr(asset, "TARGET_TIMEFRAMES", globalConfig.targetTimeframes.join(","))
      .split(",").map(s => s.trim()) as Timeframe[],
    volScale5m: envNum(asset, "VOL_SCALE_5M", globalConfig.volScale5m),
    volScale15m: envNum(asset, "VOL_SCALE_15M", globalConfig.volScale15m),
    volScale1h: envNum(asset, "VOL_SCALE_1H", globalConfig.volScale1h),
    volScale4h: envNum(asset, "VOL_SCALE_4H", globalConfig.volScale4h),
    minMomentumPct: envNum(asset, "MIN_MOMENTUM_PCT", globalConfig.minMomentumPct),
    minVwapDevPct: envNum(asset, "MIN_VWAP_DEV_PCT", globalConfig.minVwapDevPct),
    minFlowRatio: envNum(asset, "MIN_FLOW_RATIO", globalConfig.minFlowRatio),
    minEdge: envNum(asset, "MIN_EDGE", globalConfig.minEdge),
  };
}

export function loadConfig(): Config {
  const privateKey = process.env.PRIVATE_KEY;
  const walletAddress = process.env.WALLET_ADDRESS;

  if (!privateKey) throw new Error("PRIVATE_KEY is required");
  if (!walletAddress) throw new Error("WALLET_ADDRESS is required");

  const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

  // Parse assets from env (default: BTC only for backward compat)
  const assetsRaw = process.env.SCALPER_ASSETS || "BTC";
  const assets = assetsRaw.split(",").map(s => s.trim().toUpperCase()) as Asset[];

  // Global defaults (from BTC_* env vars for backward compat)
  const defaultMaxBet = Number(process.env.BTC_MAX_BET) || 2.0;
  const targetTimeframes = (process.env.BTC_TARGET_TIMEFRAMES || "15m").split(",").map(s => s.trim()) as Timeframe[];
  const volScale5m = Number(process.env.BTC_VOL_SCALE_5M) || 0.25;
  const volScale15m = Number(process.env.BTC_VOL_SCALE_15M) || 0.40;
  const volScale1h = Number(process.env.BTC_VOL_SCALE_1H) || 0.50;
  const volScale4h = Number(process.env.BTC_VOL_SCALE_4H) || 1.0;
  const minMomentumPct = Number(process.env.BTC_MIN_MOMENTUM_PCT) || 0.10;
  const minVwapDevPct = Number(process.env.BTC_MIN_VWAP_DEV_PCT) || 0.03;
  const minFlowRatio = Number(process.env.BTC_MIN_FLOW_RATIO) || 0.10;
  const minEdge = Number(process.env.BTC_MIN_EDGE) || 0.05;

  const globalDefaults = {
    defaultMaxBet, targetTimeframes,
    volScale5m, volScale15m, volScale1h, volScale4h,
    minMomentumPct, minVwapDevPct, minFlowRatio, minEdge,
  };

  // Build per-asset configs
  const assetConfigs = new Map<Asset, AssetConfig>();
  for (const asset of assets) {
    assetConfigs.set(asset, buildAssetConfig(asset, globalDefaults));
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
    },
    gammaHost,

    // Assets
    assets,
    assetConfigs,

    // Global risk controls
    defaultMaxBet,
    maxDailyLossPct: Number(process.env.BTC_MAX_DAILY_LOSS_PCT) || 10,
    cashReservePct: Number(process.env.BTC_CASH_RESERVE_PCT) || 20,
    maxConcurrentBets: Number(process.env.BTC_MAX_CONCURRENT_BETS) || 5,
    maxBetsPerHour: Number(process.env.BTC_MAX_BETS_PER_HOUR) || 10,
    cooldownAfterLossMs: Number(process.env.BTC_COOLDOWN_AFTER_LOSS_MS) || 60_000,
    polyFeeRate: Number(process.env.BTC_POLY_FEE_RATE) || 0.02,

    // Exit thresholds
    baseTakeProfitPct: Number(process.env.BTC_BASE_TAKE_PROFIT_PCT) || 20,
    tpDecayFactor: Number(process.env.BTC_TP_DECAY_FACTOR) || 0.7,
    baseStopLossPct: Number(process.env.BTC_BASE_STOP_LOSS_PCT) || 10,
    slTightenFactor: Number(process.env.BTC_SL_TIGHTEN_FACTOR) || 0.6,
    maxHoldElapsed: Number(process.env.BTC_MAX_HOLD_ELAPSED) || 0.80,
    trailingTpActivationPct: Number(process.env.BTC_TRAILING_TP_ACTIVATION_PCT) || 15,
    trailingTpDropPct: Number(process.env.BTC_TRAILING_TP_DROP_PCT) || 5,

    // Global signal thresholds
    minMomentumPct,
    minVwapDevPct,
    minFlowRatio,
    minEdge,
    maxSpread: Number(process.env.BTC_MAX_SPREAD) || 0.08,
    minElapsed: Number(process.env.BTC_MIN_ELAPSED) || 0.15,
    maxElapsed: Number(process.env.BTC_MAX_ELAPSED) || 0.70,
    maxElapsed5m: Number(process.env.BTC_MAX_ELAPSED_5M) || 0.50,
    minLiquidity: Number(process.env.BTC_MIN_LIQUIDITY) || 5000,
    maxEntryPrice: Number(process.env.BTC_MAX_ENTRY_PRICE) || 0.40,

    // Global vol scales
    volScale5m,
    volScale15m,
    volScale1h,
    volScale4h,

    // Limit order settings
    useLimitOrders: process.env.BTC_USE_LIMIT_ORDERS !== "false",
    limitOrderTimeoutMs: Number(process.env.BTC_LIMIT_ORDER_TIMEOUT_MS) || 8000,
    limitOrderPollMs: Number(process.env.BTC_LIMIT_ORDER_POLL_MS) || 1500,

    // Market discovery
    targetTimeframes,
    marketPollMs: Number(process.env.BTC_MARKET_POLL_MS) || 30_000,

    // Signal eval interval
    evalIntervalMs: Number(process.env.BTC_EVAL_INTERVAL_MS) || 5_000,

    // Exit eval interval
    exitIntervalMs: Number(process.env.BTC_EXIT_INTERVAL_MS) || 1_000,

    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
  };
}
