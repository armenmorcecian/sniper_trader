// ─── Risk Monitor Service ────────────────────────────────────────────────────
// Persistent WebSocket-based risk monitor for Alpaca positions.
// Watches positions in real time, writes block alerts to SQLite on breaches,
// sends Telegram notifications.

import * as path from "path";
import dotenv from "dotenv";

// Load local .env first, then fallback to OpenClaw .env
dotenv.config();
dotenv.config({
  path: path.join(process.env.HOME || process.env.USERPROFILE || "/home/node", ".openclaw", ".env"),
});

import cron from "node-cron";
import { cleanExpiredAlerts, resolveAlertsByType, recordEquitySnapshot } from "quant-core";
import { loadConfig } from "./config";
import { PositionTracker } from "./position-tracker";
import { RiskEngine } from "./risk-engine";
import { TradingWebSocket } from "./ws-trading";
import { DataWebSocket } from "./ws-data";
import { Alerter } from "./alerter";
import { HealthPinger } from "./health";

const LOG_PREFIX = "[risk-monitor]";

async function main(): Promise<void> {
  console.log(`${LOG_PREFIX} Starting risk monitor service...`);

  const config = loadConfig();
  console.log(`${LOG_PREFIX} Config: stopLoss=${config.stopLossPercent}%, dailyLoss=${config.maxDailyLossPercent}%, drawdown=${config.maxDrawdownPercent}%`);
  console.log(`${LOG_PREFIX} Base URL: ${config.alpacaBaseUrl}`);
  console.log(`${LOG_PREFIX} Telegram: ${config.telegramBotToken ? "configured" : "not configured"}`);

  // Create components
  const tracker = new PositionTracker(config);
  const engine = new RiskEngine(config, tracker);
  const alerter = new Alerter(config);
  const health = new HealthPinger();

  // Initial REST reconciliation
  console.log(`${LOG_PREFIX} Running initial position reconciliation...`);
  await tracker.reconcile();

  // Create WebSocket connections
  const tradingWs = new TradingWebSocket(config);
  const dataWs = new DataWebSocket(config);

  // Wire trading WebSocket: on fill, update tracker + immediate risk check
  tradingWs.onTradeUpdate((update) => {
    tracker.updateFromTradeEvent(update);

    // Immediate risk check on fills
    if (update.event === "fill" || update.event === "partial_fill") {
      const result = engine.evaluate();

      // Send alerts via Telegram
      for (const alert of result.alerts) {
        alerter.sendAlert(alert.alertType, alert.severity, alert.message, alert.symbol).catch(() => {});
      }

      // Update data subscription after trade
      dataWs.updateSubscription(tracker.getSymbols());
    }
  });

  // Wire data WebSocket: on bar, update price
  dataWs.onBar((bar) => {
    tracker.updatePrice(bar.S, bar.c);
  });

  // Connect WebSockets
  tradingWs.connect();
  dataWs.connect();

  // Subscribe to current positions
  const currentSymbols = tracker.getSymbols();
  if (currentSymbols.length > 0) {
    // Small delay to allow WS to connect and authenticate
    setTimeout(() => {
      dataWs.updateSubscription(tracker.getSymbols());
    }, 3000);
  }

  // ─── Intervals ──────────────────────────────────────────────────────────────

  // Risk check every 60s
  const riskCheckInterval = setInterval(() => {
    try {
      const result = engine.evaluate();
      for (const alert of result.alerts) {
        alerter.sendAlert(alert.alertType, alert.severity, alert.message, alert.symbol).catch(() => {});
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Risk check failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.riskCheckMs);

  // REST reconciliation every 5 minutes
  const reconcileInterval = setInterval(async () => {
    try {
      await tracker.reconcile();
      // Update data subscription after reconcile
      dataWs.updateSubscription(tracker.getSymbols());
    } catch (err) {
      console.error(`${LOG_PREFIX} Reconciliation failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.reconcileMs);

  // Health ping every 2 minutes
  const healthInterval = setInterval(() => {
    health.ping(tradingWs.isConnected, dataWs.isConnected, tracker.getPositions().length);
  }, 120_000);

  // Initial health ping
  health.ping(tradingWs.isConnected, dataWs.isConnected, tracker.getPositions().length);

  // ─── Cron Jobs ──────────────────────────────────────────────────────────────

  // 9:25 AM ET Mon-Fri: clean expired alerts + resolve previous day's daily_loss alerts
  cron.schedule("25 9 * * 1-5", () => {
    console.log(`${LOG_PREFIX} Pre-market cleanup: resolving daily_loss alerts + cleaning expired`);
    try {
      const dailyResolved = resolveAlertsByType("daily_loss");
      const cleaned = cleanExpiredAlerts();
      tracker.resetDailyBaseline();
      console.log(`${LOG_PREFIX} Cleanup: resolved ${dailyResolved} daily_loss, cleaned ${cleaned} expired`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Pre-market cleanup failed:`, err);
    }
  }, { timezone: "America/New_York" });

  // Record equity snapshots every 5 min during market hours
  cron.schedule("*/5 9-16 * * 1-5", () => {
    try {
      const equity = tracker.getTotalEquity();
      if (equity > 0) {
        recordEquitySnapshot({
          skill: "alpaca",
          equity,
          cash: tracker.getCash(),
          positionsValue: equity - tracker.getCash(),
          metadata: { source: "risk-monitor" },
        });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Equity snapshot failed:`, err);
    }
  }, { timezone: "America/New_York" });

  // ─── Shutdown ───────────────────────────────────────────────────────────────

  const shutdown = () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
    clearInterval(riskCheckInterval);
    clearInterval(reconcileInterval);
    clearInterval(healthInterval);
    tradingWs.destroy();
    dataWs.destroy();
    console.log(`${LOG_PREFIX} Shutdown complete.`);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`${LOG_PREFIX} Running. Risk checks every ${config.riskCheckMs / 1000}s, reconcile every ${config.reconcileMs / 1000}s.`);

  // Send startup notification
  alerter.sendStatus(`*Risk Monitor Started*\nPositions: ${tracker.getPositions().length}\nEquity: $${tracker.getTotalEquity().toFixed(2)}`).catch(() => {});
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
