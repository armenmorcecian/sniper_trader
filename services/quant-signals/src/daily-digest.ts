// ─── Telegram Daily P&L Digest ──────────────────────────────────────────────
// Sends a Markdown-formatted daily summary via Telegram Bot API.
// Uses node:https — no new dependencies. Gracefully skips if env vars missing.

import * as https from "https";
import { getPerformanceMetrics } from "quant-core/src/performance";
import { queryTrades } from "quant-core";

function sendTelegramMessage(text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log("[daily-digest] Skipping — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    return Promise.resolve();
  }

  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${botToken}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
          }
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Telegram API request timed out"));
    });
    req.write(payload);
    req.end();
  });
}

function formatCurrency(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export async function sendDailyDigest(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // Get daily metrics for each skill
  const alpacaMetrics = getPerformanceMetrics({ skill: "alpaca", period: "daily" });
  const polyMetrics = getPerformanceMetrics({ skill: "polymarket", period: "daily" });

  // Get weekly metrics for Sharpe + max drawdown
  const weeklyMetrics = getPerformanceMetrics({ skill: "all", period: "weekly" });

  // Get today's trades for detail
  const alpacaTrades = queryTrades({ skill: "alpaca", since: today + "T00:00:00Z", limit: 50 });
  const polyTrades = queryTrades({ skill: "polymarket", since: today + "T00:00:00Z", limit: 50 });

  const alpacaTradesWithPnl = alpacaTrades.filter(t => t.pnl != null);
  const polyTradesWithPnl = polyTrades.filter(t => t.pnl != null);

  // Build message
  const lines: string[] = [];
  lines.push(`*Daily P&L Digest* — ${today}`);
  lines.push("");

  // Alpaca section
  lines.push("*Alpaca ETF*");
  if (alpacaMetrics.startingEquity > 0 || alpacaMetrics.endingEquity > 0) {
    lines.push(`  Equity: ${formatCurrency(alpacaMetrics.startingEquity)} → ${formatCurrency(alpacaMetrics.endingEquity)}`);
    lines.push(`  Net: ${formatPercent(alpacaMetrics.netReturn)}`);
  }
  lines.push(`  Trades: ${alpacaMetrics.tradesCount} (${alpacaMetrics.wins}W/${alpacaMetrics.losses}L)`);
  if (alpacaMetrics.tradesCount > 0) {
    lines.push(`  Win rate: ${alpacaMetrics.winRate}%`);
  }
  if (alpacaMetrics.bestTrade) {
    const best = `${alpacaMetrics.bestTrade.symbol || "?"} ${formatCurrency(alpacaMetrics.bestTrade.pnl)}`;
    const worst = alpacaMetrics.worstTrade
      ? ` | Worst: ${alpacaMetrics.worstTrade.symbol || "?"} ${formatCurrency(alpacaMetrics.worstTrade.pnl)}`
      : "";
    lines.push(`  Best: ${best}${worst}`);
  }
  lines.push("");

  // Polymarket section
  lines.push("*Polymarket*");
  if (polyMetrics.startingEquity > 0 || polyMetrics.endingEquity > 0) {
    lines.push(`  Equity: ${formatCurrency(polyMetrics.startingEquity)} → ${formatCurrency(polyMetrics.endingEquity)}`);
    lines.push(`  Net: ${formatPercent(polyMetrics.netReturn)}`);
  }
  lines.push(`  Trades: ${polyMetrics.tradesCount} (${polyMetrics.wins}W/${polyMetrics.losses}L)`);
  if (polyMetrics.tradesCount > 0) {
    lines.push(`  Win rate: ${polyMetrics.winRate}%`);
  }
  lines.push("");

  // Weekly metrics
  if (weeklyMetrics.sharpeRatio != null) {
    lines.push(`*7-Day Sharpe*: ${weeklyMetrics.sharpeRatio}`);
  }
  if (weeklyMetrics.maxDrawdown !== 0) {
    lines.push(`*7-Day Max DD*: ${weeklyMetrics.maxDrawdown.toFixed(2)}%`);
  }

  const message = lines.join("\n");
  await sendTelegramMessage(message);
  console.log("[daily-digest] Digest sent successfully");
}
