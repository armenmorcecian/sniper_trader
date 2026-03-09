// ─── Copycat Wallet Service ──────────────────────────────────────────────────
// Mirrors trades from top Polymarket wallets via on-chain OrderFilled events.
// Tracks leaders across all leaderboard categories with tier-weighted copy decisions.

import * as path from "path";
import Module from "node:module";
import dotenv from "dotenv";

// Load local .env first, then fallback to OpenClaw .env
dotenv.config();
dotenv.config({
  path: path.join(process.env.HOME || process.env.USERPROFILE || "/home/node", ".openclaw", ".env"),
});

// Patch module resolution for quant-core (same as other services)
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

import { queryTrades } from "quant-core";
import { loadConfig } from "./config";
import type { IPolymarketService, WalletScore } from "./types";
import { ChainMonitor } from "./chain-monitor";
import { TokenMap } from "./token-map";
import { CopycatExecutor } from "./executor";
import { PositionRedeemer } from "./redeemer";
import { Alerter } from "./alerter";
import { HealthPinger } from "./health";
import { pickWallets } from "./wallet-picker";

const LOG_PREFIX = "[copycat-wallet]";

function formatTierBreakdown(scores: Map<string, WalletScore>): string {
  const tiers = [0, 0, 0, 0, 0]; // index 1-4
  for (const s of scores.values()) tiers[s.tier]++;
  return `${scores.size} wallets: ${tiers[4]} T4, ${tiers[3]} T3, ${tiers[2]} T2, ${tiers[1]} T1`;
}

async function main(): Promise<void> {
  console.log(`${LOG_PREFIX} Starting copycat wallet service...`);

  const config = loadConfig();
  console.log(`${LOG_PREFIX} Max bet: $${config.maxBet}, concurrent: ${config.maxConcurrent}`);
  console.log(`${LOG_PREFIX} TP: ${config.tpPct}%, SL: ${config.slPct}%, max hold: ${config.maxHoldHours}h`);
  console.log(`${LOG_PREFIX} Min whale size: $${config.minWhaleSize} (No outcome: $${(config.minWhaleSize * config.noOutcomeWhaleSizeMultiplier).toFixed(0)}), price drift: ${config.maxPriceDriftPct}%`);
  console.log(`${LOG_PREFIX} Price filter: $${config.minCopyPrice}-$${config.maxCopyPrice}, min time to resolution: ${config.minTimeToResolutionHours}h`);
  console.log(`${LOG_PREFIX} Rotation: every ${config.rotationHours}h, ${config.walletCount} per category`);
  console.log(`${LOG_PREFIX} Telegram: ${config.telegramBotToken ? "configured" : "not configured"}`);

  // Create PolymarketService (runtime require to avoid compile-time dependency)
  const { PolymarketService } = require("../../../skills/polymarket-trader/dist/polymarket.service");
  const service: IPolymarketService = new PolymarketService(config.polymarketConfig);

  // Pick target wallets
  const walletScores = await pickWallets(config);
  console.log(`${LOG_PREFIX} Tracking ${formatTierBreakdown(walletScores)}`);

  // Initialize components
  const alerter = new Alerter(config);
  const health = new HealthPinger();
  const tokenMap = new TokenMap(config.gammaHost);
  const executor = new CopycatExecutor(config, service, tokenMap, alerter, health);
  executor.updateWalletScores(walletScores);

  // Build initial token map
  console.log(`${LOG_PREFIX} Building token map from Gamma API...`);
  await tokenMap.start(300_000); // refresh every 5min
  console.log(`${LOG_PREFIX} Token map ready: ${tokenMap.size} tokens`);

  // Start chain monitor
  const monitor = new ChainMonitor(config.polygonWsRpc, walletScores);

  monitor.on("buy", async (event) => {
    try {
      await executor.executeBuy(event);
    } catch (err) {
      console.error(`${LOG_PREFIX} Buy handler error:`, err instanceof Error ? err.message : String(err));
    }
  });

  monitor.on("sell", async (event) => {
    try {
      await executor.executeSell(event);
    } catch (err) {
      console.error(`${LOG_PREFIX} Sell handler error:`, err instanceof Error ? err.message : String(err));
    }
  });

  monitor.start();

  // ─── Safety exit check interval ──────────────────────────────────

  const exitInterval = setInterval(async () => {
    try {
      await executor.checkSafetyExits();
    } catch (err) {
      console.error(`${LOG_PREFIX} Safety exit check error:`, err instanceof Error ? err.message : String(err));
    }
  }, config.exitCheckMs);

  // ─── Resolution redeemer (5min) ─────────────────────────────────

  const redeemer = new PositionRedeemer(config, service, executor, alerter);

  const redeemerInterval = setInterval(async () => {
    try {
      await redeemer.checkResolutions();
    } catch (err) {
      console.error(`${LOG_PREFIX} Redeemer check error:`, err instanceof Error ? err.message : String(err));
    }
  }, 300_000); // 5 minutes

  // ─── Health ping (2min) ──────────────────────────────────────────

  const writeHealth = () => {
    health.ping(monitor.connected, `${monitor.walletCount} wallets`, executor.getPositionCount());
  };
  writeHealth();
  const healthInterval = setInterval(writeHealth, 120_000);

  // ─── Wallet rotation interval ────────────────────────────────────

  const rotationMs = config.rotationHours * 3_600_000;
  const rotationInterval = setInterval(async () => {
    try {
      console.log(`${LOG_PREFIX} Rotating wallets...`);
      const oldKeys = new Set(walletScores.keys());
      const newScores = await pickWallets(config);

      const added = [...newScores.keys()].filter((k) => !oldKeys.has(k));
      const removed = [...oldKeys].filter((k) => !newScores.has(k));

      monitor.updateWallets(newScores);
      executor.updateWalletScores(newScores);

      // Update reference for health pings
      console.log(`${LOG_PREFIX} Rotation complete: ${formatTierBreakdown(newScores)}`);

      if (added.length > 0 || removed.length > 0) {
        const addedNames = added.map((k) => newScores.get(k)?.userName || k.slice(0, 8)).slice(0, 5);
        const removedNames = removed.map((k) => walletScores.get(k)?.userName || k.slice(0, 8)).slice(0, 5);

        await alerter.sendStatus(
          `*Wallet Rotation*\n` +
          `${formatTierBreakdown(newScores)}\n` +
          (added.length > 0 ? `Added: ${addedNames.join(", ")}${added.length > 5 ? ` +${added.length - 5}` : ""}\n` : "") +
          (removed.length > 0 ? `Removed: ${removedNames.join(", ")}${removed.length > 5 ? ` +${removed.length - 5}` : ""}` : ""),
        );
      }

      // Update the local reference for next rotation diff
      walletScores.clear();
      for (const [k, v] of newScores) walletScores.set(k, v);
    } catch (err) {
      console.error(`${LOG_PREFIX} Wallet rotation failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }, rotationMs);

  // ─── Daily summary (24h) ─────────────────────────────────────────

  const dailySummaryInterval = setInterval(async () => {
    try {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const allTrades = queryTrades({
        skill: "polymarket",
        since,
        limit: 500,
      });
      const trades = allTrades.filter((t) => t.tool === "copycat-wallet:buy");

      if (trades.length === 0) {
        console.log(`${LOG_PREFIX} [daily] No trades in last 24h`);
        return;
      }

      let wins = 0;
      let losses = 0;
      let totalPnl = 0;
      const byWallet = new Map<string, { count: number; pnl: number }>();

      for (const t of trades) {
        const pnl = t.pnl ?? 0;
        totalPnl += pnl;
        if (pnl >= 0) wins++;
        else losses++;

        const meta = typeof t.metadata === "string" ? JSON.parse(t.metadata) : t.metadata;
        const src = meta?.sourceWallet || "unknown";
        const entry = byWallet.get(src) || { count: 0, pnl: 0 };
        entry.count++;
        entry.pnl += pnl;
        byWallet.set(src, entry);
      }

      const pnlSign = totalPnl >= 0 ? "+" : "";
      const summaryLines = [
        `*Daily Copycat Summary*`,
        `Trades: ${trades.length} (${wins}W / ${losses}L)`,
        `PnL: ${pnlSign}$${totalPnl.toFixed(2)}`,
        ``,
        `By wallet:`,
      ];

      for (const [wallet, stats] of byWallet) {
        const s = stats.pnl >= 0 ? "+" : "";
        const label = walletScores.get(wallet)?.userName || wallet.slice(0, 10);
        summaryLines.push(`  ${label}: ${stats.count} trades, ${s}$${stats.pnl.toFixed(2)}`);
      }

      const summaryText = summaryLines.join("\n");
      console.log(`${LOG_PREFIX} [daily] ${summaryText}`);
      await alerter.sendStatus(summaryText);
    } catch (err) {
      console.error(`${LOG_PREFIX} Daily summary failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }
  }, 86_400_000); // 24h

  // ─── Periodic status log (5min) ──────────────────────────────────

  const statusInterval = setInterval(() => {
    const positions = executor.getPositions();
    console.log(
      `${LOG_PREFIX} [status] connected=${monitor.connected} tokens=${tokenMap.size} ` +
      `positions=${positions.length} wallets=${monitor.walletCount}`,
    );
    if (positions.length > 0) {
      for (const p of positions) {
        const age = ((Date.now() - p.entryTime) / 3_600_000).toFixed(1);
        console.log(`${LOG_PREFIX}   ${p.outcome} "${p.question.slice(0, 50)}" @ $${p.entryPrice.toFixed(4)} (${age}h)`);
      }
    }
  }, 300_000);

  // ─── Shutdown ────────────────────────────────────────────────────

  const shutdown = () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
    clearInterval(exitInterval);
    clearInterval(redeemerInterval);
    clearInterval(healthInterval);
    clearInterval(rotationInterval);
    clearInterval(dailySummaryInterval);
    clearInterval(statusInterval);
    monitor.destroy();
    tokenMap.destroy();
    console.log(`${LOG_PREFIX} Shutdown complete.`);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`${LOG_PREFIX} Running. ${formatTierBreakdown(walletScores)}.`);

  await alerter.sendStatus(
    `*Copycat Wallet Started*\n${formatTierBreakdown(walletScores)}\n` +
    `Max bet: $${config.maxBet} | Concurrent: ${config.maxConcurrent}\n` +
    `TP: ${config.tpPct}% | SL: ${config.slPct}% | Drift: ${config.maxPriceDriftPct}%\n` +
    `Min whale: $${config.minWhaleSize} (No: $${(config.minWhaleSize * config.noOutcomeWhaleSizeMultiplier).toFixed(0)})\n` +
    `Price filter: $${config.minCopyPrice}-$${config.maxCopyPrice} | Min resolution: ${config.minTimeToResolutionHours}h\n` +
    `Rotation: every ${config.rotationHours}h`,
  );
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
