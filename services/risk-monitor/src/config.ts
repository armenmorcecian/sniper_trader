// ─── Configuration ───────────────────────────────────────────────────────────

export interface Config {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  alpacaBaseUrl: string;
  tradingWsUrl: string;
  dataWsUrl: string;
  stopLossPercent: number;
  maxDailyLossPercent: number;
  maxDrawdownPercent: number;
  reconcileMs: number;
  riskCheckMs: number;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function loadConfig(): Config {
  const alpacaKeyId = process.env.APCA_API_KEY_ID;
  const alpacaSecretKey = process.env.APCA_API_SECRET_KEY;

  if (!alpacaKeyId) throw new Error("APCA_API_KEY_ID is required");
  if (!alpacaSecretKey) throw new Error("APCA_API_SECRET_KEY is required");

  const baseUrl = process.env.APCA_API_BASE_URL || "https://paper-api.alpaca.markets";
  const isPaper = baseUrl.includes("paper");

  // Derive WebSocket URLs from base URL
  const tradingWsUrl = isPaper
    ? "wss://paper-api.alpaca.markets/stream"
    : "wss://api.alpaca.markets/stream";

  // Data WS: always use IEX (free tier) for real-time bars
  const dataWsUrl = "wss://stream.data.alpaca.markets/v2/iex";

  return {
    alpacaKeyId,
    alpacaSecretKey,
    alpacaBaseUrl: baseUrl,
    tradingWsUrl,
    dataWsUrl,
    stopLossPercent: Number(process.env.RISK_STOP_LOSS_PCT) || 5,
    maxDailyLossPercent: Number(process.env.ALPACA_MAX_DAILY_LOSS_PCT) || 3,
    maxDrawdownPercent: Number(process.env.RISK_MAX_DRAWDOWN_PCT) || 10,
    reconcileMs: Number(process.env.RISK_RECONCILE_MS) || 300_000,    // 5 min
    riskCheckMs: Number(process.env.RISK_CHECK_MS) || 60_000,         // 60s
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
  };
}
