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
import { ASSET_BINANCE_SYMBOL, ASSET_BYBIT_SYMBOL, ASSET_OKX_SYMBOL } from "./types";
import { OrderBookFeed } from "./orderbook-feed";
import { BinanceFeed } from "./binance-feed";
import { ClobFeed } from "./clob-feed";
import { CandleTracker } from "./candle-tracker";
import { MarketDiscovery } from "./market-discovery";
import { evaluateSignals } from "./signal-engine";
import { evaluateExits } from "./exit-engine";
import { Executor } from "./executor";
import { Alerter } from "./alerter";
import { HealthPinger } from "./health";
import { VolTracker } from "./vol-tracker";
import { TickCopulaTracker } from "./copula-tracker";
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
  console.log(`${LOG_PREFIX} Exit: TP=${config.baseTakeProfitPct}% (decay=${config.tpDecayFactor}), SL=${config.baseStopLossPct}% (tighten=${config.slTightenFactor}), maxHold=${config.maxHoldElapsed}, grace=${config.minHoldMs / 1000}s (5m=${config.minHoldMs5m / 1000}s)`);
  console.log(`${LOG_PREFIX} Trailing TP: activate=${config.trailingTpActivationPct}%, drop=${config.trailingTpDropPct}%`);
  console.log(`${LOG_PREFIX} Limit orders (buy): ${config.useLimitOrders ? `enabled (timeout=${config.limitOrderTimeoutMs}ms, poll=${config.limitOrderPollMs}ms)` : "disabled"}`);
  console.log(`${LOG_PREFIX} Limit orders (sell): ${config.useLimitOrdersForExits ? `enabled (timeout=${config.sellLimitTimeoutMs}ms, poll=${config.sellLimitPollMs}ms)` : "disabled"}`);
  if (config.useGtcTp) {
    console.log(`${LOG_PREFIX} GTC TP: enabled (${config.gtcTpPct}%, poll=${config.gtcTpPollMs}ms)`);
  }
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
      obiFeed: config.enableObi ? new OrderBookFeed(
        symbol,
        ASSET_BYBIT_SYMBOL[asset],
        ASSET_OKX_SYMBOL[asset],
      ) : undefined,
      copulaTracker: new TickCopulaTracker(),
    };
    pipelines.set(asset, pipeline);
    symbolToPipeline.set(symbol, pipeline);
    binanceSymbols.push(symbol);
  }

  // Seed vol trackers from Binance REST API (eliminates 15min warmup)
  await Promise.all(
    config.assets.map((asset) => {
      const symbol = ASSET_BINANCE_SYMBOL[asset];
      const pipeline = pipelines.get(asset)!;
      return pipeline.volTracker.seedFromRest(symbol);
    }),
  );

  // Create shared components
  const binance = new BinanceFeed(binanceSymbols);
  // Connect WS directly (no proxy) — read-only data, geo-blocking only applies to order placement
  const clobFeed = new ClobFeed();
  const discovery = new MarketDiscovery(config.gammaHost, config.assetConfigs, config.minLiquidity);
  const alerter = new Alerter(config);
  const health = new HealthPinger();
  const executor = new Executor(config, service, alerter, health);

  // Wire Binance trades → per-asset pipeline trackers + copula
  binance.onTrade((trade, symbol) => {
    const pipeline = symbolToPipeline.get(symbol);
    if (pipeline) {
      pipeline.tracker.onTrade(trade);
      const price = Number(trade.p);
      if (price > 0) pipeline.copulaTracker?.onBtcTick(price);
    }
  });

  // Wire Binance klines → per-asset pipeline vol trackers
  binance.onKline((kline, symbol) => {
    const pipeline = symbolToPipeline.get(symbol);
    if (pipeline) {
      pipeline.volTracker.onKline(kline);
    }
  });

  // Connect to Binance + CLOB price feed
  binance.connect();
  clobFeed.connect();

  // Connect OBI feeds
  for (const pipeline of pipelines.values()) {
    pipeline.obiFeed?.connect();
  }

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
        pipeline.tracker.addMarket(m, ASSET_BINANCE_SYMBOL[m.asset]);
        if (m.outcomePrices.length >= 2) {
          pipeline.tracker.updateMarketPrices(m.conditionId, m.outcomePrices);
        }
      }
    }
    // Sync CLOB WebSocket subscriptions to active market tokens
    const allTokens: string[] = [];
    for (const m of markets) {
      allTokens.push(m.upTokenId, m.downTokenId);
    }
    clobFeed.setTokens(allTokens);
  }

  /** Get live contract price for a market+side, preferring CLOB WS over Gamma REST */
  function getLivePrice(market: CandleMarket, side: "Up" | "Down"): number {
    const tokenId = side === "Up" ? market.upTokenId : market.downTokenId;
    const wsPrice = clobFeed.getPrice(tokenId);
    if (wsPrice > 0 && clobFeed.getPriceAge(tokenId) < 30_000) {
      return wsPrice;
    }
    // Fallback to Gamma REST prices
    return side === "Up" ? market.outcomePrices[0] : market.outcomePrices[1];
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
      // Force-exit positions whose candles have expired before pruning removes them
      const now = Date.now();
      for (const pos of executor.getOpenPositions()) {
        const candleEndMs = new Date(pos.market.endDate).getTime();
        if (now >= candleEndMs) {
          const livePrice = polyPrices.get(pos.conditionId) ?? pos.entryPrice;
          console.log(`${LOG_PREFIX} Force-exit expired candle: ${pos.asset} ${pos.market.timeframe} ${pos.side}`);
          if (config.useGtcTp) {
            await executor.cancelGtcTp(pos.conditionId);
          }
          await executor.executeSell({
            conditionId: pos.conditionId,
            rule: "time_decay",
            reason: `Candle expired (endDate passed)`,
            urgency: "high",
            currentPrice: livePrice,
          });
        }
      }

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
      // Update polyPrices for open positions — prefer CLOB WS, fallback to Gamma REST
      for (const pos of openPositions) {
        const pipeline = pipelines.get(pos.asset);
        if (pipeline) {
          const market = pipeline.activeMarkets.find((m) => m.conditionId === pos.conditionId);
          if (market) {
            polyPrices.set(pos.conditionId, getLivePrice(market, pos.side));
          }
        }
      }

      // Use cached equity (updated by signal loop) — zero HTTP calls per exit tick
      const totalEquity = executor.getCachedTotalEquity() || openPositions.reduce((sum, p) => sum + p.amount, 0);

      const exitSignals = evaluateExits(openPositions, pipelines, config, totalEquity, polyPrices);

      const posSummary = openPositions.map((p) => {
        const curPrice = polyPrices.get(p.conditionId) ?? p.entryPrice;
        const pnlPct = ((curPrice - p.entryPrice) / p.entryPrice) * 100;
        const tokenId = p.side === "Up" ? p.market.upTokenId : p.market.downTokenId;
        const src = tokenId && clobFeed.getPrice(tokenId) > 0 && clobFeed.getPriceAge(tokenId) < 30_000 ? "ws" : "gam";
        return `${p.asset}/${p.market.timeframe}/${p.side}=${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%(${src})`;
      }).join(", ");
      console.log(
        `${LOG_PREFIX} [exit-tick] positions=${openPositions.length} [${posSummary}] ` +
        `exits=${exitSignals.length} equity=$${totalEquity.toFixed(2)}`,
      );

      for (const signal of exitSignals) {
        await executor.executeSell(signal);
      }

      // Poll GTC TP order fills
      if (config.useGtcTp) {
        await executor.pollGtcTpFills();
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Exit eval failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      exitRunning = false;
    }
  }, exitMs);

  // ─── Toxicity check (500ms) — cancel stale pending orders on momentum reversal
  const toxicityInterval = setInterval(() => {
    const pending = executor.getPendingOrders();
    for (const order of pending) {
      const pipeline = pipelines.get(order.asset);
      if (!pipeline) continue;
      const metrics = pipeline.tracker.getMetrics(order.conditionId);
      if (!metrics) continue;
      const reversed = (order.side === "Up" && metrics.returnFromOpen < 0)
        || (order.side === "Down" && metrics.returnFromOpen > 0);
      if (reversed) {
        console.log(
          `${LOG_PREFIX} [toxicity] Cancelling pending ${order.asset} ${order.timeframe} ${order.side} — ` +
          `momentum reversed (ret=${metrics.returnFromOpen.toFixed(3)}%)`,
        );
        executor.requestCancelPending(order.conditionId);
      }
    }
  }, 500);

  // ─── Post-exit immediate re-evaluation ─────────────────────────────
  let signalRunning = false;
  executor.onExit = async (_conditionId, exitRule) => {
    if (exitRule === "circuit_breaker" || exitRule === "stop_loss") {
      console.log(`${LOG_PREFIX} [post-exit] Skipping re-eval after ${exitRule} exit`);
      return;
    }

    if (signalRunning) {
      console.log(`${LOG_PREFIX} [post-exit] Skipping re-eval — signal eval already running`);
      return;
    }
    signalRunning = true;
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
          pipeline.obiFeed as any,
        );
        if (signals.length > 0) {
          console.log(`${LOG_PREFIX} [post-exit] ${asset} re-eval: ${signals.length} signal(s)`);
          for (const s of signals) {
            await executor.executeBuy(s, pipeline.tracker, pipeline.copulaTracker);
          }
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Post-exit re-eval failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      signalRunning = false;
    }
  };

  // ─── Signal evaluation (5s) — buy checks ────────────────────────────
  const signalInterval = setInterval(async () => {
    if (signalRunning) return;
    signalRunning = true;
    try {
      // Refresh prices from Gamma before evaluating
      allMarkets = await discovery.getActiveMarkets();
      distributeMarkets(allMarkets);

      // Update polyPrices + market outcomePrices from CLOB WS (with Gamma REST fallback)
      for (const pipeline of pipelines.values()) {
        for (const m of pipeline.activeMarkets) {
          // Inject live CLOB prices into market object so signal engine sees fresh data
          const wsUp = clobFeed.getPrice(m.upTokenId);
          const wsDown = clobFeed.getPrice(m.downTokenId);
          if (wsUp > 0 && clobFeed.getPriceAge(m.upTokenId) < 30_000) m.outcomePrices[0] = wsUp;
          if (wsDown > 0 && clobFeed.getPriceAge(m.downTokenId) < 30_000) m.outcomePrices[1] = wsDown;

          // Use side-aware pricing for polyPrices map
          const openPos = executor.getOpenPositions().find((p) => p.conditionId === m.conditionId);
          const priceIdx = openPos?.side === "Down" ? 1 : 0;
          polyPrices.set(m.conditionId, m.outcomePrices[priceIdx]);
          // Feed copula tracker with Polymarket Up price
          if (m.outcomePrices[0] > 0) pipeline.copulaTracker?.onPolyPriceUpdate(m.outcomePrices[0]);
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
            pipeline.obiFeed as any,
          );
          totalSignals += signals.length;

          const atrInfo = pipeline.volTracker.isReady
            ? `atr=${pipeline.volTracker.atrPercent?.toFixed(3)}%`
            : `atr=warmup(${pipeline.volTracker.barCount}/15)`;
          assetParts.push(`${asset}=$${price.toLocaleString()} mkts=${pipeline.activeMarkets.length} ${atrInfo}`);

          for (const signal of signals) {
            await executor.executeBuy(signal, pipeline.tracker, pipeline.copulaTracker);
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
    } finally {
      signalRunning = false;
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
    clearInterval(toxicityInterval);
    clearInterval(signalInterval);
    clearInterval(healthInterval);
    binance.destroy();
    clobFeed.destroy();
    for (const pipeline of pipelines.values()) {
      pipeline.obiFeed?.destroy();
    }
    console.log(`${LOG_PREFIX} Shutdown complete.`);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const assetPrices = config.assets.map(a => `${a}=$${binance.getLastPrice(ASSET_BINANCE_SYMBOL[a]).toLocaleString()}`).join(", ");
  console.log(
    `${LOG_PREFIX} Running. ${assetPrices}, ` +
    `markets=${allMarkets.length}, ` +
    `CLOB WS=${clobFeed.isConnected ? "up" : "connecting"}, ` +
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
