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
  cbMinLossAbs: number;
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
  momentumReversalThreshold: number;

  // Global signal thresholds (defaults for per-asset)
  minMomentumPct: number;
  minVwapDevPct: number;
  minFlowRatio: number;
  minEdge: number;
  maxSpread: number;
  minElapsed: number;
  maxElapsed: number;
  maxElapsed5m: number;
  minElapsed15m: number;
  minElapsed1h: number;
  minElapsed4h: number;
  maxElapsed1h: number;
  maxElapsed4h: number;
  minLiquidity: number;
  maxEntryPrice: number;
  minEntryPrice: number;
  orderJitterMs: number;
  enableObi: boolean;
  obiMinConfirmation: number;

  // Global vol scales (defaults for per-asset)
  volScale5m: number;
  volScale15m: number;
  volScale1h: number;
  volScale4h: number;

  // Limit order settings (buys)
  useLimitOrders: boolean;
  limitOrderStrict: boolean;
  limitOrderTimeoutMs: number;
  limitOrderPollMs: number;

  // Limit order settings (sells)
  useLimitOrdersForExits: boolean;
  sellLimitTimeoutMs: number;
  sellLimitPollMs: number;

  // GTC Take-Profit mode
  useGtcTp: boolean;
  gtcTpPct: number;
  gtcTpPollMs: number;

  // Market discovery
  targetTimeframes: Timeframe[];
  marketPollMs: number;

  // Signal eval interval (buy checks)
  evalIntervalMs: number;

  // Hold grace period (skip exits for young positions)
  minHoldMs: number;
  minHoldMs5m: number;

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
  const assetsRaw = process.env.SCALPER_ASSETS || "BTC,ETH";
  const assets = assetsRaw.split(",").map(s => s.trim().toUpperCase()) as Asset[];

  // Global defaults (from BTC_* env vars for backward compat)
  const defaultMaxBet = Number(process.env.BTC_MAX_BET) || 1.0;
  const targetTimeframes = (process.env.BTC_TARGET_TIMEFRAMES || "15m,1h,4h").split(",").map(s => s.trim()) as Timeframe[];
  const volScale5m = Number(process.env.BTC_VOL_SCALE_5M) || 0.25;
  const volScale15m = Number(process.env.BTC_VOL_SCALE_15M) || 0.40;
  const volScale1h = Number(process.env.BTC_VOL_SCALE_1H) || 0.50;
  const volScale4h = Number(process.env.BTC_VOL_SCALE_4H) || 1.0;
  const minMomentumPct = Number(process.env.BTC_MIN_MOMENTUM_PCT) || 0.10;
  const minVwapDevPct = Number(process.env.BTC_MIN_VWAP_DEV_PCT) || 0.03;
  const minFlowRatio = Number(process.env.BTC_MIN_FLOW_RATIO) || 0.10;
  const minEdge = Number(process.env.BTC_MIN_EDGE) || 0.03;

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
    cbMinLossAbs: Number(process.env.BTC_CB_MIN_LOSS_ABS) || 10,
    cashReservePct: Number(process.env.BTC_CASH_RESERVE_PCT) || 20,
    maxConcurrentBets: Number(process.env.BTC_MAX_CONCURRENT_BETS) || 5,
    maxBetsPerHour: Number(process.env.BTC_MAX_BETS_PER_HOUR) || 10,
    cooldownAfterLossMs: Number(process.env.BTC_COOLDOWN_AFTER_LOSS_MS) || 60_000,
    polyFeeRate: Number(process.env.BTC_POLY_FEE_RATE) || 0.02,

    // Exit thresholds
    baseTakeProfitPct: Number(process.env.BTC_BASE_TAKE_PROFIT_PCT) || 2,
    tpDecayFactor: Number(process.env.BTC_TP_DECAY_FACTOR) || 0.3,
    baseStopLossPct: Number(process.env.BTC_BASE_STOP_LOSS_PCT) || 15,
    slTightenFactor: Number(process.env.BTC_SL_TIGHTEN_FACTOR) || 0.6,
    maxHoldElapsed: Number(process.env.BTC_MAX_HOLD_ELAPSED) || 0.80,
    trailingTpActivationPct: Number(process.env.BTC_TRAILING_TP_ACTIVATION_PCT) || 2,
    trailingTpDropPct: Number(process.env.BTC_TRAILING_TP_DROP_PCT) || 1,
    momentumReversalThreshold: Number(process.env.BTC_MOMENTUM_REVERSAL_PCT) || 0.15,

    // Global signal thresholds
    minMomentumPct,
    minVwapDevPct,
    minFlowRatio,
    minEdge,
    maxSpread: Number(process.env.BTC_MAX_SPREAD) || 0.08,
    minElapsed: Number(process.env.BTC_MIN_ELAPSED) || 0.10,
    maxElapsed: Number(process.env.BTC_MAX_ELAPSED) || 0.70,
    maxElapsed5m: Number(process.env.BTC_MAX_ELAPSED_5M) || 0.50,
    minElapsed15m: Number(process.env.BTC_MIN_ELAPSED_15M) || 0.03,
    minElapsed1h: Number(process.env.BTC_MIN_ELAPSED_1H) || 0.03,
    minElapsed4h: Number(process.env.BTC_MIN_ELAPSED_4H) || 0.03,
    maxElapsed1h: Number(process.env.BTC_MAX_ELAPSED_1H) || 0.95,
    maxElapsed4h: Number(process.env.BTC_MAX_ELAPSED_4H) || 0.95,
    minLiquidity: Number(process.env.BTC_MIN_LIQUIDITY) || 3000,
    maxEntryPrice: Number(process.env.BTC_MAX_ENTRY_PRICE) || 0.99,
    minEntryPrice: Number(process.env.BTC_MIN_ENTRY_PRICE) || 0.70,

    // Global vol scales
    volScale5m,
    volScale15m,
    volScale1h,
    volScale4h,

    // Order jitter
    orderJitterMs: Number(process.env.BTC_ORDER_JITTER_MS) || 300,

    // OBI settings
    enableObi: process.env.BTC_ENABLE_OBI !== "false",
    obiMinConfirmation: Number(process.env.BTC_OBI_MIN_CONFIRMATION) || 0.05,

    // Hold grace period
    minHoldMs: process.env.BTC_MIN_HOLD_MS != null ? Number(process.env.BTC_MIN_HOLD_MS) : 90_000,
    minHoldMs5m: process.env.BTC_MIN_HOLD_MS_5M != null ? Number(process.env.BTC_MIN_HOLD_MS_5M) : 60_000,

    // Limit order settings (buys)
    useLimitOrders: process.env.BTC_USE_LIMIT_ORDERS !== "false",
    limitOrderStrict: process.env.BTC_LIMIT_ORDER_STRICT === "true",
    limitOrderTimeoutMs: Number(process.env.BTC_LIMIT_ORDER_TIMEOUT_MS) || 8000,
    limitOrderPollMs: Number(process.env.BTC_LIMIT_ORDER_POLL_MS) || 1500,

    // Limit order settings (sells)
    useLimitOrdersForExits: process.env.BTC_USE_LIMIT_SELLS !== "false",
    sellLimitTimeoutMs: Number(process.env.BTC_SELL_LIMIT_TIMEOUT_MS) || 5000,
    sellLimitPollMs: Number(process.env.BTC_SELL_LIMIT_POLL_MS) || 1000,

    // GTC Take-Profit
    useGtcTp: process.env.BTC_USE_GTC_TP === "true",
    gtcTpPct: Number(process.env.BTC_GTC_TP_PCT) || 5.0,
    gtcTpPollMs: Number(process.env.BTC_GTC_TP_POLL_MS) || 5000,

    // Market discovery
    targetTimeframes,
    marketPollMs: Number(process.env.BTC_MARKET_POLL_MS) || 30_000,

    // Signal eval interval
    evalIntervalMs: Number(process.env.BTC_EVAL_INTERVAL_MS) || 1_000,

    // Exit eval interval
    exitIntervalMs: Number(process.env.BTC_EXIT_INTERVAL_MS) || 1_000,

    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
  };
}
