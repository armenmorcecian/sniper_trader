// ─── Configuration ───────────────────────────────────────────────────────────

import type { PolymarketConfig } from "./types";

export interface Config {
  // Polymarket connection
  polymarketConfig: PolymarketConfig;

  // Intervals
  positionPollMs: number;
  exitEvalMs: number;
  scanIntervalMs: number;
  reconcileMs: number;

  // Exit thresholds
  stopLossPct: number;
  takeProfitPct: number;
  expiryExitHours: number;
  edgeDecayRatio: number;
  maxHoldHours: number;
  maxJointLoss: number;
  maxDailyLossPct: number;

  // Buy thresholds
  minEdge: number;
  maxBet: number;
  cashReservePct: number;

  // Gemini
  geminiApiKey: string;
  geminiModel: string;

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;

  // Hosts
  gammaHost: string;
}

export function loadConfig(): Config {
  const privateKey = process.env.PRIVATE_KEY;
  const walletAddress = process.env.WALLET_ADDRESS;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!privateKey) throw new Error("PRIVATE_KEY is required");
  if (!walletAddress) throw new Error("WALLET_ADDRESS is required");
  if (!geminiApiKey) throw new Error("GEMINI_API_KEY is required");

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
    },

    positionPollMs: Number(process.env.POLY_POSITION_POLL_MS) || 5_000,
    exitEvalMs: Number(process.env.POLY_EXIT_EVAL_MS) || 30_000,
    scanIntervalMs: Number(process.env.POLY_SCAN_INTERVAL_MS) || 60_000,
    reconcileMs: Number(process.env.POLY_RECONCILE_MS) || 300_000,

    stopLossPct: Number(process.env.POLY_STOP_LOSS_PCT) || 15,
    takeProfitPct: Number(process.env.POLY_TAKE_PROFIT_PCT) || 30,
    expiryExitHours: Number(process.env.POLY_EXPIRY_EXIT_HOURS) || 2,
    edgeDecayRatio: Number(process.env.POLY_EDGE_DECAY_RATIO) || 0.5,
    maxHoldHours: Number(process.env.POLY_MAX_HOLD_HOURS) || 72,
    maxJointLoss: Number(process.env.POLY_MAX_JOINT_LOSS) || 0.3,
    maxDailyLossPct: Number(process.env.POLY_MAX_DAILY_LOSS_PCT) || 10,

    minEdge: Number(process.env.POLY_MIN_EDGE) || 0.03,
    maxBet: Number(process.env.POLY_MAX_BET) || 2.0,
    cashReservePct: Number(process.env.POLY_CASH_RESERVE_PCT) || 20,

    geminiApiKey,
    geminiModel: process.env.GEMINI_MODEL || "gemini-3-flash-preview",

    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,

    gammaHost,
  };
}
