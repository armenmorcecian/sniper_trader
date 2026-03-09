// ─── Copycat Wallet Config ───────────────────────────────────────────────────

import type { PolymarketConfig } from "./types";

export interface CopycatConfig {
  polymarketConfig: PolymarketConfig;
  gammaHost: string;

  // Polygon
  polygonWsRpc: string;

  // Position sizing
  maxBet: number;
  maxConcurrent: number;
  cashReservePct: number;
  minWhaleSize: number;

  // Risk
  dailyLossPct: number;
  tpPct: number;
  slPct: number;
  maxHoldHours: number;

  // Wallet selection
  walletCount: number;
  maxPriceDriftPct: number;
  minCopyPrice: number;
  maxCopyPrice: number;
  minTimeToResolutionHours: number;
  noOutcomeWhaleSizeMultiplier: number;
  rotationHours: number;

  // Intervals
  exitCheckMs: number;

  // Override wallet
  seedWallet: string;

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function loadConfig(): CopycatConfig {
  const privateKey = process.env.PRIVATE_KEY;
  const walletAddress = process.env.WALLET_ADDRESS;

  if (!privateKey) throw new Error("PRIVATE_KEY is required");
  if (!walletAddress) throw new Error("WALLET_ADDRESS is required");

  const polygonWsRpc = process.env.POLYGON_WS_RPC;
  if (!polygonWsRpc) throw new Error("POLYGON_WS_RPC is required (e.g. wss://polygon-mainnet.g.alchemy.com/v2/{key})");

  const gammaHost = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

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
      polygonRpc: process.env.POLYGON_RPC_URL || polygonWsRpc.replace("wss://", "https://").replace("ws://", "http://"),
    },
    gammaHost,
    polygonWsRpc,

    maxBet: Number(process.env.COPYCAT_MAX_BET) || 1.0,
    maxConcurrent: Number(process.env.COPYCAT_MAX_CONCURRENT) || 1,
    cashReservePct: Number(process.env.COPYCAT_CASH_RESERVE_PCT) || 25,
    minWhaleSize: Number(process.env.COPYCAT_MIN_WHALE_SIZE) || 500,

    dailyLossPct: Number(process.env.COPYCAT_DAILY_LOSS_PCT) || 15,
    tpPct: Number(process.env.COPYCAT_TP_PCT) || 15,
    slPct: Number(process.env.COPYCAT_SL_PCT) || 20,
    maxHoldHours: Number(process.env.COPYCAT_MAX_HOLD_HOURS) || 72,

    walletCount: Number(process.env.COPYCAT_WALLET_COUNT) || 10,
    maxPriceDriftPct: Number(process.env.COPYCAT_MAX_PRICE_DRIFT_PCT) || 5,
    minCopyPrice: Number(process.env.COPYCAT_MIN_COPY_PRICE) || 0.10,
    maxCopyPrice: Number(process.env.COPYCAT_MAX_COPY_PRICE) || 0.90,
    minTimeToResolutionHours: Number(process.env.COPYCAT_MIN_TIME_TO_RESOLUTION_HOURS) || 24,
    noOutcomeWhaleSizeMultiplier: Number(process.env.COPYCAT_NO_OUTCOME_WHALE_MULT) || 0.5,
    rotationHours: Number(process.env.COPYCAT_ROTATION_HOURS) || 24,

    exitCheckMs: Number(process.env.COPYCAT_EXIT_CHECK_MS) || 60_000,

    seedWallet: process.env.COPYCAT_SEED_WALLET || "",

    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
  };
}
