// ─── Crypto Scalper Service ──────────────────────────────────────────────────
// Autonomous multi-asset scalper: Binance price feeds → Polymarket binary candle contracts.
// Buy early on momentum, sell the contract price move, never hold to resolution.

import * as path from "path";
import Module from "node:module";
import dotenv from "dotenv";

// Load local .env first, then fallback to OpenClaw .env
dotenv.config();
dotenv.config({
  path: path.join(process.env.HOME || process.env.USERPROFILE || "/home/node", ".openclaw", ".env"),
});

// Patch module resolution: tsx hooks intercept ALL requires, even cross-package.
// When polymarket-trader code requires "quant-core", tsx fails to resolve it from
// btc-scalper's context. Fix: resolve quant-core once from our own node_modules,
// then return that path for any subsequent resolution failures.
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
import type { IPolymarketService, CandleMarket, Asset, AssetPipeline, AssetHealthStats } from "./types";
import { ASSET_BINANCE_SYMBOL } from "./types";
import { BinanceFeed } from "./binance-feed";
import { CandleTracker } from "./candle-tracker";
import { MarketDiscovery } from "./market-discovery";
import { evaluateSignals } from "./signal-engine";
import { evaluateExits } from "./exit-engine";
import { Executor } from "./executor";
import { Alerter } from "./alerter";
import { HealthPinger } from "./health";
import { VolTracker } from "./vol-tracker";
import { getRealizedPnlToday, resolvePrediction } from "quant-core";

const LOG_PREFIX = "[crypto-scalper]";

async function main(): Promise<void> {
  console.log(`${LOG_PREFIX} Starting crypto scalper service...`);

  const config = loadConfig();
  console.log(`${LOG_PREFIX} Assets: ${config.assets.join(", ")}`);
  console.log(`${LOG_PREFIX} Global: maxBets/hr=${config.maxBetsPerHour}, concurrent=${config.maxConcurrentBets}, dailyLoss=${config.maxDailyLossPct}%`);
  for (const [asset, ac] of config.assetConfigs) {
    console.log(`${LOG_PREFIX} ${asset}: maxBet=$${ac.maxBet}, timeframes=${ac.targetTimeframes.join(",")}, edge=${ac.minEdge}, momentum=${ac.minMomentumPct}%`);
  }
  console.log(`${LOG_PREFIX} Exit: TP=${config.baseTakeProfitPct}% (decay=${config.tpDecayFactor}), SL=${config.baseStopLossPct}% (tighten=${config.slTightenFactor}), maxHold=${config.maxHoldElapsed}`);
  console.log(`${LOG_PREFIX} Trailing TP: activate=${config.trailingTpActivationPct}%, drop=${config.trailingTpDropPct}%`);
  console.log(`${LOG_PREFIX} Limit orders: ${config.useLimitOrders ? `enabled (timeout=${config.limitOrderTimeoutMs}ms, poll=${config.limitOrderPollMs}ms)` : "disabled"}`);
  console.log(`${LOG_PREFIX} Telegram: ${config.telegramBotToken ? "configured" : "not configured"}`);

  // Create PolymarketService (runtime require to avoid compile-time dependency)
  // Use compiled dist/ to avoid tsx cross-package resolution issues with TS source
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PolymarketService } = require("../../../skills/polymarket-trader/dist/polymarket.service");
  const service: IPolymarketService = new PolymarketService(config.polymarketConfig);

  // ─── Build per-asset pipelines ──────────────────────────────────────────

  const pipelines = new Map<Asset, AssetPipeline>();
  const symbolToPipeline = new Map<string, AssetPipeline>();
  const binanceSymbols: string[] = [];

  for (const asset of config.assets) {
    const symbol = ASSET_BINANCE_SYMBOL[asset];
    const pipeline: AssetPipeline = {
      asset,
      tracker: new CandleTracker(),
      volTracker: new VolTracker(),
      activeMarkets: [],
      prevGammaPrices: new Map(),
    };
    pipelines.set(asset, pipeline);
    symbolToPipeline.set(symbol, pipeline);
    binanceSymbols.push(symbol);
  }

  // Create shared components
  const binance = new BinanceFeed(binanceSymbols);
  const discovery = new MarketDiscovery(config.gammaHost, config.assetConfigs, config.minLiquidity);
  const alerter = new Alerter(config);
  const health = new HealthPinger();
  const executor = new Executor(config, service, alerter, health);

  // Wire Binance trades → per-asset pipeline trackers
  binance.onTrade((trade, symbol) => {
    const pipeline = symbolToPipeline.get(symbol);
    if (pipeline) {
      pipeline.tracker.onTrade(trade);
    }
  });

  // Wire Binance klines → per-asset pipeline vol trackers
  binance.onKline((kline, symbol) => {
    const pipeline = symbolToPipeline.get(symbol);
    if (pipeline) {
      pipeline.volTracker.onKline(kline);
    }
  });

  // Connect to Binance
  binance.connect();

  // Wait for first price on ALL configured assets (with 30s timeout)
  console.log(`${LOG_PREFIX} Waiting for Binance connection (${config.assets.join(", ")})...`);
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const allReady = binanceSymbols.every(s => binance.getLastPrice(s) > 0);
      if (allReady) {
        clearInterval(check);
        resolve();
      }
    }, 500);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 30_000);
  });

  for (const asset of config.assets) {
    const symbol = ASSET_BINANCE_SYMBOL[asset];
    const price = binance.getLastPrice(symbol);
    if (price > 0) {
      console.log(`${LOG_PREFIX} ${asset} connected: $${price.toLocaleString()}`);
    } else {
      console.warn(`${LOG_PREFIX} ${asset} not yet connected, proceeding anyway`);
    }
  }

  // Startup warmup: allow 15s for staleness guard to establish baseline prices
  const startupTime = Date.now();
  const WARMUP_MS = 15_000;

  // ─── Helper: distribute markets to pipelines ────────────────────────────

  function distributeMarkets(markets: CandleMarket[]): void {
    // Clear per-pipeline market lists
    for (const pipeline of pipelines.values()) {
      pipeline.activeMarkets = [];
    }
    // Distribute by asset
    for (const m of markets) {
      const pipeline = pipelines.get(m.asset);
      if (pipeline) {
        pipeline.activeMarkets.push(m);
        pipeline.tracker.addMarket(m);
        if (m.outcomePrices.length >= 2) {
          pipeline.tracker.updateMarketPrices(m.conditionId, m.outcomePrices);
        }
      }
    }
  }

  // Initial market discovery
  let allMarkets: CandleMarket[] = [];
  try {
    allMarkets = await discovery.getActiveMarkets();
    console.log(`${LOG_PREFIX} Found ${allMarkets.length} active candle market(s)`);
    distributeMarkets(allMarkets);
  } catch (err) {
    console.error(`${LOG_PREFIX} Initial market discovery failed:`, err instanceof Error ? err.message : String(err));
  }

  // Track Polymarket contract prices (updated via REST during eval cycles)
  const polyPrices = new Map<string, number>();

  // ─── Intervals ──────────────────────────────────────────────────────────

  // Market discovery poll (30s)
  const marketPollInterval = setInterval(async () => {
    try {
      allMarkets = await discovery.getActiveMarkets();
      distributeMarkets(allMarkets);

      const activeIds = new Set(allMarkets.map((m) => m.conditionId));

      // Prune expired candles from all trackers
      for (const pipeline of pipelines.values()) {
        pipeline.tracker.pruneExpired();
      }

      // Clear dedup for expired candles
      executor.clearExpiredDedup(activeIds);

      // Prune expired positions
      executor.pruneExpired();

      // Verify open positions actually exist on Polymarket (catch phantoms)
      await executor.verifyPositions();

      // CB auto-reset: time-based fallback (5 min) or P&L recovery
      if (executor.isCircuitBreakerTripped()) {
        const CB_MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes
        const cbAge = executor.getCircuitBreakerAge();

        if (cbAge > CB_MAX_DURATION_MS) {
          executor.resetCircuitBreaker();
          console.log(`${LOG_PREFIX} CB time-reset after ${(cbAge / 1000).toFixed(0)}s — resuming trading`);
        } else {
          try {
            const dailyPnl = getRealizedPnlToday("polymarket");
            const vitals = await service.getPortfolioValue();
            const pnlPct = vitals.totalEquity > 0 ? (dailyPnl / vitals.totalEquity) * 100 : 0;
            if (pnlPct > -config.maxDailyLossPct) {
              executor.resetCircuitBreaker();
              console.log(`${LOG_PREFIX} CB auto-reset: daily P&L ${pnlPct.toFixed(2)}% > -${config.maxDailyLossPct}%`);
            }
          } catch (err) {
            console.error(`${LOG_PREFIX} CB auto-reset check failed (non-fatal):`, err instanceof Error ? err.message : String(err));
          }
        }
      }

      // Calibration: resolve predictions for expired candles (per pipeline)
      for (const pipeline of pipelines.values()) {
        for (const [conditionId] of pipeline.prevGammaPrices) {
          if (!activeIds.has(conditionId)) {
            const lastPrices = pipeline.prevGammaPrices.get(conditionId);
            if (lastPrices && lastPrices.length >= 2) {
              const outcome: 0 | 1 = lastPrices[0] > 0.5 ? 1 : 0;
              try {
                const resolved = resolvePrediction(conditionId, outcome);
                if (resolved > 0) {
                  console.log(`${LOG_PREFIX} Resolved ${resolved} prediction(s) for ${pipeline.asset} expired candle: outcome=${outcome === 1 ? "Up" : "Down"}`);
                }
              } catch (err) {
                console.error(`${LOG_PREFIX} Prediction resolve failed (non-fatal):`, err instanceof Error ? err.message : String(err));
              }
            }
            pipeline.prevGammaPrices.delete(conditionId);
          }
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Market discovery failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.marketPollMs);

  // ─── Exit evaluation (1s) — fast TP/SL reactions ─────────────────────
  let exitRunning = false;
  const exitMs = config.exitIntervalMs > 0 ? config.exitIntervalMs : 1_000;
  const exitInterval = setInterval(async () => {
    if (exitRunning) return;
    const openPositions = executor.getOpenPositions();
    if (openPositions.length === 0) return;

    exitRunning = true;
    try {
      // Update polyPrices for open positions from all pipeline market data
      for (const pos of openPositions) {
        const pipeline = pipelines.get(pos.asset);
        if (pipeline) {
          const market = pipeline.activeMarkets.find((m) => m.conditionId === pos.conditionId);
          if (market) {
            const priceIdx = pos.side === "Up" ? 0 : 1;
            polyPrices.set(pos.conditionId, market.outcomePrices[priceIdx] ?? pos.entryPrice);
          }
        }
      }

      let totalEquity = 0;
      try {
        const vitals = await service.getPortfolioValue();
        totalEquity = vitals.totalEquity;
        executor.updateCachedEquity(vitals.totalEquity, vitals.usdcBalance);
      } catch {
        totalEquity = openPositions.reduce((sum, p) => sum + p.amount, 0);
      }

      const exitSignals = evaluateExits(openPositions, pipelines, config, totalEquity, polyPrices);

      const posSummary = openPositions.map((p) => {
        const curPrice = polyPrices.get(p.conditionId) ?? p.entryPrice;
        const pnlPct = ((curPrice - p.entryPrice) / p.entryPrice) * 100;
        return `${p.asset}/${p.market.timeframe}/${p.side}=${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`;
      }).join(", ");
      console.log(
        `${LOG_PREFIX} [exit-tick] positions=${openPositions.length} [${posSummary}] ` +
        `exits=${exitSignals.length} equity=$${totalEquity.toFixed(2)}`,
      );

      for (const signal of exitSignals) {
        await executor.executeSell(signal);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Exit eval failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      exitRunning = false;
    }
  }, exitMs);

  // ─── Post-exit immediate re-evaluation ─────────────────────────────
  executor.onExit = async (_conditionId, exitRule) => {
    if (exitRule === "circuit_breaker" || exitRule === "stop_loss") {
      console.log(`${LOG_PREFIX} [post-exit] Skipping re-eval after ${exitRule} exit`);
      return;
    }

    try {
      allMarkets = await discovery.getActiveMarkets(true);
      distributeMarkets(allMarkets);

      // Re-eval per pipeline
      for (const [asset, pipeline] of pipelines) {
        const assetConfig = config.assetConfigs.get(asset);
        if (!assetConfig || pipeline.activeMarkets.length === 0) continue;
        const signals = evaluateSignals(
          pipeline.activeMarkets,
          pipeline.tracker,
          config,
          executor.getBetConditionIds(),
          assetConfig,
          pipeline.volTracker,
          pipeline.activeMarkets,
        );
        if (signals.length > 0) {
          console.log(`${LOG_PREFIX} [post-exit] ${asset} re-eval: ${signals.length} signal(s)`);
          for (const s of signals) {
            await executor.executeBuy(s, pipeline.tracker);
          }
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Post-exit re-eval failed:`, err instanceof Error ? err.message : String(err));
    }
  };

  // ─── Signal evaluation (5s) — buy checks ────────────────────────────
  const signalInterval = setInterval(async () => {
    try {
      // Refresh prices from Gamma before evaluating
      allMarkets = await discovery.getActiveMarkets();
      distributeMarkets(allMarkets);

      // Update polyPrices from all pipelines
      for (const pipeline of pipelines.values()) {
        for (const m of pipeline.activeMarkets) {
          polyPrices.set(m.conditionId, m.outcomePrices[0]);
        }
      }

      health.updateSignalCheckTime();

      const openCount = executor.getOpenPositions().length;

      // Startup warmup: record baseline prices but don't trade for first 15s
      if (Date.now() - startupTime < WARMUP_MS) {
        for (const pipeline of pipelines.values()) {
          for (const m of pipeline.activeMarkets) {
            pipeline.prevGammaPrices.set(m.conditionId, [...m.outcomePrices]);
          }
        }
        console.log(`${LOG_PREFIX} [signal-tick] skipping eval — warmup (${((Date.now() - startupTime) / 1000).toFixed(0)}s/${WARMUP_MS / 1000}s)`);
        return;
      }

      if (allMarkets.length > 0 && binance.isConnected) {
        let totalSignals = 0;

        // Per-pipeline signal evaluation
        const assetParts: string[] = [];
        for (const [asset, pipeline] of pipelines) {
          const assetConfig = config.assetConfigs.get(asset);
          if (!assetConfig) continue;

          const symbol = ASSET_BINANCE_SYMBOL[asset];
          const price = binance.getLastPrice(symbol);

          // Staleness guard: reject markets where Gamma prices jumped >20% between polls
          const freshMarkets = pipeline.activeMarkets.filter((m) => {
            const prev = pipeline.prevGammaPrices.get(m.conditionId);
            pipeline.prevGammaPrices.set(m.conditionId, [...m.outcomePrices]);

            if (!prev) return true; // first poll — allow
            for (let i = 0; i < Math.min(prev.length, m.outcomePrices.length); i++) {
              if (prev[i] > 0 && Math.abs(m.outcomePrices[i] - prev[i]) / prev[i] > 0.20) {
                console.warn(
                  `${LOG_PREFIX} [staleness] ${asset} ${m.timeframe} price jumped ` +
                  `${prev[i].toFixed(3)}→${m.outcomePrices[i].toFixed(3)} — skipping`,
                );
                return false;
              }
            }
            return true;
          });

          const signals = evaluateSignals(
            freshMarkets,
            pipeline.tracker,
            config,
            executor.getBetConditionIds(),
            assetConfig,
            pipeline.volTracker,
            pipeline.activeMarkets,
          );
          totalSignals += signals.length;

          const atrInfo = pipeline.volTracker.isReady
            ? `atr=${pipeline.volTracker.atrPercent?.toFixed(3)}%`
            : `atr=warmup(${pipeline.volTracker.barCount}/8)`;
          assetParts.push(`${asset}=$${price.toLocaleString()} mkts=${pipeline.activeMarkets.length} ${atrInfo}`);

          for (const signal of signals) {
            await executor.executeBuy(signal, pipeline.tracker);
          }
        }

        console.log(
          `${LOG_PREFIX} [signal-tick] ${assetParts.join(" | ")} ` +
          `candidates=${totalSignals} open=${openCount} dedup=${executor.getBetConditionIds().size}`,
        );
      } else {
        console.log(
          `${LOG_PREFIX} [signal-tick] markets=${allMarkets.length} binance=${binance.isConnected ? "up" : "down"} ` +
          `open=${openCount} — skipping (no markets or no feed)`,
        );
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Signal eval failed:`, err instanceof Error ? err.message : String(err));
    }
  }, config.evalIntervalMs);

  // Health ping (2min)
  const buildAssetHealthStats = (): Record<string, AssetHealthStats> => {
    const stats: Record<string, AssetHealthStats> = {};
    for (const [asset, pipeline] of pipelines) {
      stats[asset] = {
        activeMarkets: pipeline.activeMarkets.length,
        lastPrice: binance.getLastPrice(ASSET_BINANCE_SYMBOL[asset]),
      };
    }
    return stats;
  };

  const healthInterval = setInterval(() => {
    health.ping(
      binance.isConnected,
      buildAssetHealthStats(),
      executor.getOpenPositions().length,
    );
  }, 120_000);

  // Initial health ping
  health.ping(binance.isConnected, buildAssetHealthStats(), 0);

  // ─── Shutdown ───────────────────────────────────────────────────────────

  const shutdown = () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
    clearInterval(marketPollInterval);
    clearInterval(exitInterval);
    clearInterval(signalInterval);
    clearInterval(healthInterval);
    binance.destroy();
    console.log(`${LOG_PREFIX} Shutdown complete.`);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const assetPrices = config.assets.map(a => `${a}=$${binance.getLastPrice(ASSET_BINANCE_SYMBOL[a]).toLocaleString()}`).join(", ");
  console.log(
    `${LOG_PREFIX} Running. ${assetPrices}, ` +
    `markets=${allMarkets.length}, ` +
    `exit eval every ${exitMs / 1000}s, ` +
    `signal eval every ${config.evalIntervalMs / 1000}s, ` +
    `market poll every ${config.marketPollMs / 1000}s`,
  );

  // Send startup notification
  alerter.sendStatus(
    `*Crypto Scalper Started*\nAssets: ${config.assets.join(", ")}\n` +
    `${assetPrices}\n` +
    `Markets: ${allMarkets.length}\nExit: ${exitMs / 1000}s | Signal: ${config.evalIntervalMs / 1000}s\n` +
    config.assets.map(a => `${a} max: $${config.assetConfigs.get(a)?.maxBet ?? config.defaultMaxBet}`).join(", "),
  ).catch(() => {});
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});
