// ─── Poly Monitor Service ────────────────────────────────────────────────────
// Full-cycle Polymarket monitor: algorithmic edge detection (BUY pipeline),
// position tracking, and instant algorithmic exits (SELL pipeline).
// Gemini LLM is ONLY called to confirm BUY orders after quant models flag an edge.

import * as path from "path";
import * as fs from "fs";
import dotenv from "dotenv";

// Load local .env first, then fallback to OpenClaw .env
dotenv.config();
dotenv.config({
  path: path.join(process.env.HOME || process.env.USERPROFILE || "/home/node", ".openclaw", ".env"),
});

import { getActiveAlerts, getRealizedPnlToday } from "quant-core";
import { loadConfig } from "./config";
import type { IPolymarketService } from "./types";
import { PositionTracker } from "./position-tracker";
import { PriceFeed } from "./price-feed";
import { Scanner } from "./scanner";
import { confirmBuy } from "./gemini-gate";
import { evaluateExits } from "./exit-engine";
import { Executor, Alerter } from "./executor";
import type { HealthStatus } from "./types";

const LOG_PREFIX = "[poly-monitor]";

// ─── Health Pinger ───────────────────────────────────────────────────────────

class HealthPinger {
  private readonly filePath: string;
  private readonly startTime = Date.now();
  private lastScanMarkets = 0;
  private lastEdgeCheck = 0;

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/home/node";
    const dir = path.join(home, ".openclaw", "signals");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, "poly-monitor-meta.json");
  }

  updateScanTime(): void { this.lastScanMarkets = Date.now(); }
  updateEdgeTime(): void { this.lastEdgeCheck = Date.now(); }

  ping(wsConnected: boolean, positionsTracked: number): void {
    let activeAlertCount = 0;
    try {
      activeAlertCount = getActiveAlerts().length;
    } catch { /* non-fatal */ }

    const status: HealthStatus = {
      lastPing: new Date().toISOString(),
      positionsTracked,
      wsConnected,
      activeAlerts: activeAlertCount,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
      lastScanMarkets: this.lastScanMarkets,
      lastEdgeCheck: this.lastEdgeCheck,
    };

    const tmpPath = this.filePath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to write health file:`, err instanceof Error ? err.message : String(err));
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`${LOG_PREFIX} Starting poly-monitor service...`);

  const config = loadConfig();
  console.log(`${LOG_PREFIX} Config: stopLoss=${config.stopLossPct}%, takeProfit=${config.takeProfitPct}%, minEdge=${config.minEdge}, maxBet=$${config.maxBet}`);
  console.log(`${LOG_PREFIX} Intervals: positionPoll=${config.positionPollMs / 1000}s, exitEval=${config.exitEvalMs / 1000}s, scan=${config.scanIntervalMs / 1000}s`);
  console.log(`${LOG_PREFIX} Telegram: ${config.telegramBotToken ? "configured" : "not configured"}`);
  console.log(`${LOG_PREFIX} Gemini: ${config.geminiModel}`);

  // Create PolymarketService (loaded at runtime to avoid compile-time dependency on polymarket-trader)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PolymarketService } = require("../../../skills/polymarket-trader/src/polymarket.service");
  const service: IPolymarketService = new PolymarketService(config.polymarketConfig);

  // Create components
  const tracker = new PositionTracker(service);
  const scanner = new Scanner(config);
  const executor = new Executor(config, service);
  const alerter = executor.getAlerter();
  const priceFeed = new PriceFeed(config.gammaHost, config.polymarketConfig.proxyUrl);
  const health = new HealthPinger();

  // Initial reconciliation
  console.log(`${LOG_PREFIX} Running initial position reconciliation...`);
  const initial = await tracker.reconcile();
  console.log(`${LOG_PREFIX} Initial state: ${initial.total} positions tracked`);

  // Wire price feed → position tracker
  priceFeed.onPrice((tokenId, price) => {
    tracker.updatePriceByToken(tokenId, price);
  });

  // Connect price feed and subscribe to tracked position tokens
  priceFeed.connect();
  const initialTokens = tracker.getSubscribedTokenIds();
  if (initialTokens.length > 0) {
    setTimeout(() => {
      priceFeed.subscribe(tracker.getSubscribedTokenIds());
    }, 3000);
  }

  // ─── Intervals ──────────────────────────────────────────────────────────────

  // Position poll (5s) — lightweight P&L update
  const positionPollInterval = setInterval(async () => {
    try {
      const result = await tracker.reconcile();
      if (result.added.length > 0 || result.removed.length > 0) {
        // Update price feed subscriptions
        priceFeed.subscribe(tracker.getSubscribedTokenIds());
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Position poll failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.positionPollMs);

  // Exit evaluation (30s) — run all 7 exit rules
  const exitEvalInterval = setInterval(async () => {
    try {
      const positions = tracker.getPositions();
      if (positions.length === 0) return;

      let totalEquity = 0;
      try {
        const vitals = await service.getPortfolioValue();
        totalEquity = vitals.totalEquity;
      } catch {
        // Fall back to sum of positions
        totalEquity = positions.reduce((sum, p) => sum + p.marketValue, 0);
      }

      const signals = evaluateExits(positions, tracker, config, totalEquity);

      for (const signal of signals) {
        const pos = tracker.getPosition(signal.conditionId);
        if (pos) {
          await executor.executeSell(pos, signal);
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Exit evaluation failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.exitEvalMs);

  // Market scan + edge detection + Gemini gate (60s)
  const scanInterval = setInterval(async () => {
    try {
      // Scan for liquid markets
      const markets = await scanner.scanMarkets(service);
      health.updateScanTime();

      if (markets.length === 0) return;

      // Detect edges
      const edges = await scanner.detectEdges(markets, tracker, service);
      health.updateEdgeTime();

      if (edges.length === 0) return;

      // Get portfolio state for Gemini prompt
      let balance = 0;
      let dailyPnl = 0;
      try {
        const vitals = await service.getPortfolioValue();
        balance = vitals.usdcBalance;
        dailyPnl = getRealizedPnlToday("polymarket");
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to get vitals for Gemini gate (non-fatal):`, err instanceof Error ? err.message : String(err));
        return;
      }

      const positionCount = tracker.getPositionCount();

      // Call Gemini for each edge candidate (sequentially to avoid rate limits)
      for (const candidate of edges) {
        try {
          const decision = await confirmBuy(candidate, balance, positionCount, dailyPnl, config);

          if (decision.action === "BUY") {
            const tradeId = await executor.executeBuy(candidate, decision);
            if (tradeId > 0) {
              // Update balance for next candidate
              balance -= decision.amount || 0;
              // Register token mapping for price feed
              tracker.registerTokenMapping(candidate.conditionId, candidate.clobTokenIds);
              priceFeed.subscribe(candidate.clobTokenIds);
            }
          }
        } catch (err) {
          console.error(`${LOG_PREFIX} Gemini gate / buy failed for ${candidate.conditionId.slice(0, 12)}:`, err instanceof Error ? err.message : String(err));
        }
      }

      // Prune stale scanner state
      const activeIds = new Set(markets.map((m) => m.conditionId));
      scanner.pruneStaleStates(activeIds);
    } catch (err) {
      console.error(`${LOG_PREFIX} Scan cycle failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.scanIntervalMs);

  // Full reconciliation (5min)
  const reconcileInterval = setInterval(async () => {
    try {
      const result = await tracker.reconcile();
      priceFeed.subscribe(tracker.getSubscribedTokenIds());
      console.log(`${LOG_PREFIX} Full reconciliation: ${result.total} positions (+${result.added.length} / -${result.removed.length})`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Full reconciliation failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.reconcileMs);

  // Health ping (2min)
  const healthInterval = setInterval(() => {
    health.ping(priceFeed.isConnected, tracker.getPositionCount());
  }, 120_000);

  // Initial health ping
  health.ping(priceFeed.isConnected, tracker.getPositionCount());

  // ─── Shutdown ───────────────────────────────────────────────────────────────

  const shutdown = () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
    clearInterval(positionPollInterval);
    clearInterval(exitEvalInterval);
    clearInterval(scanInterval);
    clearInterval(reconcileInterval);
    clearInterval(healthInterval);
    priceFeed.destroy();
    console.log(`${LOG_PREFIX} Shutdown complete.`);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`${LOG_PREFIX} Running. Positions: ${initial.total}, scan every ${config.scanIntervalMs / 1000}s, exit eval every ${config.exitEvalMs / 1000}s.`);

  // Send startup notification
  alerter.sendStatus(
    `*Poly Monitor Started*\nPositions: ${initial.total}\nScan interval: ${config.scanIntervalMs / 1000}s\nExit eval: ${config.exitEvalMs / 1000}s`,
  ).catch(() => {});
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
