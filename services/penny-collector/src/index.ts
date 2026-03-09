// ─── Penny Collector Service ────────────────────────────────────────────────
// Scans for near-expiry candle markets at $0.90-0.95, buys and holds to resolution.

import * as path from "path";
import * as fs from "fs";
import Module from "node:module";
import dotenv from "dotenv";

// Load local .env first, then fallback to OpenClaw .env
dotenv.config();
dotenv.config({
  path: path.join(process.env.HOME || process.env.USERPROFILE || "/home/node", ".openclaw", ".env"),
});

// Patch module resolution for quant-core (same as btc-scalper)
const quantCorePath = require.resolve("quant-core");
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
  try {
    return origResolve.call(this, request, parent, isMain, options);
  } catch (err: any) {
    if (err?.code === "MODULE_NOT_FOUND" && request === "quant-core") {
      return quantCorePath;
    }
    throw err;
  }
};

import { loadConfig } from "./config";
import type { IPolymarketService } from "./types";
import { MarketDiscovery } from "./market-discovery";
import { ExpiryScanner } from "./expiry-scanner";
import { PennyExecutor } from "./execution";
import { ClobFeed } from "./clob-feed";

const LOG_PREFIX = "[penny-collector]";

async function main(): Promise<void> {
  console.log(`${LOG_PREFIX} Starting penny collector service...`);

  const config = loadConfig();
  console.log(`${LOG_PREFIX} Assets: ${config.assets.join(", ")}`);
  console.log(`${LOG_PREFIX} Window: ${config.minSecondsBeforeExpiry}-${config.maxSecondsBeforeExpiry}s before expiry`);
  console.log(`${LOG_PREFIX} Price: $${config.minWinningPrice}-$${config.maxWinningPrice}`);
  console.log(`${LOG_PREFIX} Max bet: $${config.maxBetAmount}, concurrent: ${config.maxConcurrentPositions}, bets/hr: ${config.maxBetsPerHour}`);
  console.log(`${LOG_PREFIX} Scan interval: ${config.scanIntervalMs}ms`);
  console.log(`${LOG_PREFIX} Telegram: ${config.telegramBotToken ? "configured" : "not configured"}`);

  // Create PolymarketService (runtime require to avoid compile-time dependency)
  const { PolymarketService } = require("../../../skills/polymarket-trader/dist/polymarket.service");
  const service: IPolymarketService = new PolymarketService(config.polymarketConfig);

  const discovery = new MarketDiscovery(config.gammaHost, config.assetConfigs, config.minLiquidity);

  // CLOB WebSocket for real-time price verification (prevents stale Gamma prices)
  // Connect directly (no proxy) — WS is read-only data, geo-blocking only applies to order placement
  const clobFeed = new ClobFeed();
  clobFeed.connect();

  const scanner = new ExpiryScanner(discovery, config, clobFeed);
  const executor = new PennyExecutor(config, service);

  // Hydrate dedup set from existing portfolio positions (survives container restarts)
  await executor.init();

  // Telegram helper
  const sendTelegram = async (text: string): Promise<void> => {
    if (!config.telegramBotToken || !config.telegramChatId) return;
    try {
      const https = await import("https");
      const payload = JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: "api.telegram.org",
            path: `/bot${config.telegramBotToken}/sendMessage`,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
            timeout: 10_000,
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.write(payload);
        req.end();
      });
    } catch { /* non-fatal */ }
  };

  // ─── Main scan loop ───────────────────────────────────────────────────

  let scanning = false;
  const scanInterval = setInterval(async () => {
    if (scanning) return;
    scanning = true;

    try {
      // Only subscribe to markets within 10 min of expiry (saves proxy bandwidth)
      const SUBSCRIBE_WINDOW_MS = 10 * 60 * 1000;
      const activeMarkets = await discovery.getActiveMarkets();
      const now = Date.now();
      const nearTokens: string[] = [];
      for (const m of activeMarkets) {
        const msRemaining = new Date(m.endDate).getTime() - now;
        if (msRemaining > 0 && msRemaining <= SUBSCRIBE_WINDOW_MS) {
          nearTokens.push(m.upTokenId, m.downTokenId);
        }
      }
      // Also keep tokens for open positions (stop-loss needs prices)
      for (const pos of executor.getPositions()) {
        if (!nearTokens.includes(pos.tokenId)) {
          nearTokens.push(pos.tokenId);
        }
      }
      clobFeed.setTokens(nearTokens);

      const candidates = await scanner.findCandidates();

      for (const candidate of candidates) {
        const bought = await executor.executeBuy(candidate);
        if (bought) {
          await sendTelegram(
            `*Penny Buy* ${candidate.market.asset} ${candidate.market.timeframe} ${candidate.winningSide}\n` +
            `Price: $${candidate.winningPrice.toFixed(3)} | ${candidate.secondsRemaining.toFixed(0)}s remaining\n` +
            `Expected: +$${candidate.expectedProfit.toFixed(2)}`,
          );
        }
      }

      // Check stop-losses using live CLOB prices
      await executor.checkStopLosses(clobFeed);

      // Check for resolved positions
      const beforeCount = executor.getPositionCount();
      await executor.checkResolutions();
      const resolved = beforeCount - executor.getPositionCount();
      if (resolved > 0) {
        await sendTelegram(`*Penny Resolved* ${resolved} position(s) settled`);
      }

      // Periodic status log
      const positions = executor.getPositions();
      if (candidates.length > 0 || positions.length > 0) {
        console.log(
          `${LOG_PREFIX} [scan] candidates=${candidates.length} positions=${positions.length} ` +
          positions.map((p) => `${p.market.asset}/${p.market.timeframe}/${p.side}@$${p.entryPrice.toFixed(3)}`).join(", "),
        );
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Scan failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      scanning = false;
    }
  }, config.scanIntervalMs);

  // ─── Health ping (2min) ───────────────────────────────────────────────

  const healthFile = path.join(
    process.env.HOME || process.env.USERPROFILE || "/home/node",
    ".openclaw",
    "signals",
    "penny-collector-meta.json",
  );

  const writeHealth = () => {
    const status = {
      lastPing: new Date().toISOString(),
      openPositions: executor.getPositionCount(),
      assets: config.assets,
    };
    const tmpPath = healthFile + ".tmp";
    try {
      const dir = path.dirname(healthFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
      fs.renameSync(tmpPath, healthFile);
    } catch (err) {
      console.error(`${LOG_PREFIX} Health write failed:`, err instanceof Error ? err.message : String(err));
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  };

  writeHealth();
  const healthInterval = setInterval(writeHealth, 120_000);

  // ─── Shutdown ─────────────────────────────────────────────────────────

  const shutdown = () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
    clearInterval(scanInterval);
    clearInterval(healthInterval);
    clobFeed.destroy();
    console.log(`${LOG_PREFIX} Shutdown complete.`);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`${LOG_PREFIX} Running. Scan every ${config.scanIntervalMs / 1000}s.`);

  await sendTelegram(
    `*Penny Collector Started*\nAssets: ${config.assets.join(", ")}\n` +
    `Window: ${config.minSecondsBeforeExpiry}-${config.maxSecondsBeforeExpiry}s\n` +
    `Price: $${config.minWinningPrice}-$${config.maxWinningPrice}\n` +
    `Max bet: $${config.maxBetAmount}`,
  );
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
