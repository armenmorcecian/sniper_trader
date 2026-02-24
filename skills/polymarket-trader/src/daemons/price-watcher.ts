import "dotenv/config";
import WebSocket from "ws";
import axios from "axios";
import {
  log,
  loadState,
  saveState,
  isAgentBusy,
  acquireLock,
  releaseLock,
  triggerTradingCycle,
  sleep,
} from "./shared";
import type {
  WatchlistEntry,
  PriceSnapshot,
  PriceWindow,
  PriceWatcherState,
  PriceDaemonConfig,
} from "./types";

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG: PriceDaemonConfig = {
  wsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  watchlistRefreshIntervalMs: 10 * 60_000, // 10 minutes
  priceWindowMs: 5 * 60_000,               // 5-minute rolling window
  movementThresholdPercent: 3,              // >3% triggers alert
  perMarketCooldownMs: 5 * 60_000,         // 5-min cooldown per market
  restFallbackIntervalMs: 30_000,            // 30s REST polling fallback
  gammaHost: "https://gamma-api.polymarket.com",
};

const DAEMON = "price-watcher";
const MAX_WATCHLIST = 30;
const GLOBAL_COOLDOWN_MS = 5 * 60_000; // 5-min global cooldown between ANY price triggers

// ─── State ───────────────────────────────────────────────────────────────────

let state: PriceWatcherState = {
  watchlist: [],
  lastWatchlistRefresh: "",
  marketCooldowns: {},
};

/** Rolling price windows keyed by tokenId */
const priceWindows = new Map<string, PriceWindow>();

let wsConnection: WebSocket | null = null;
let wsReconnectDelay = 1000;
let usingRestFallback = true; // Always start with REST fallback active
let wsReceivingData = false;
let wsMessageCount = 0;
let wsPingInterval: ReturnType<typeof setInterval> | null = null;

// ─── Watchlist Management ────────────────────────────────────────────────────

async function refreshWatchlist(): Promise<void> {
  try {
    log(DAEMON, "INFO", "Refreshing watchlist from Gamma API");

    // Fetch top markets by volume
    const resp = await axios.get(`${CONFIG.gammaHost}/markets`, {
      params: {
        active: true,
        closed: false,
        order: "volume24hr",
        ascending: false,
        limit: MAX_WATCHLIST * 2,
      },
      timeout: 15_000,
    });

    const markets: Record<string, unknown>[] = resp.data || [];
    const entries: WatchlistEntry[] = [];

    for (const market of markets) {
      if (entries.length >= MAX_WATCHLIST) break;

      const conditionId = String(market.conditionId || "");
      const question = String(market.question || "");

      // Parse CLOB token IDs (may be JSON string or array)
      let tokenIds: string[];
      const raw = market.clobTokenIds;
      if (typeof raw === "string") {
        try {
          tokenIds = JSON.parse(raw);
        } catch {
          continue;
        }
      } else if (Array.isArray(raw)) {
        tokenIds = raw as string[];
      } else {
        continue;
      }

      // Parse outcomes
      let outcomes: string[];
      const rawOutcomes = market.outcomes;
      if (typeof rawOutcomes === "string") {
        try {
          outcomes = JSON.parse(rawOutcomes);
        } catch {
          outcomes = ["Yes", "No"];
        }
      } else if (Array.isArray(rawOutcomes)) {
        outcomes = rawOutcomes as string[];
      } else {
        outcomes = ["Yes", "No"];
      }

      if (!conditionId || tokenIds.length === 0) continue;

      // Add "Yes" outcome token (primary)
      entries.push({
        conditionId,
        question,
        tokenId: tokenIds[0],
        outcome: outcomes[0] || "Yes",
      });
    }

    state.watchlist = entries;
    state.lastWatchlistRefresh = new Date().toISOString();
    saveState("price-watcher-state.json", state);

    log(DAEMON, "INFO", `Watchlist updated: ${entries.length} markets`);

    // Re-subscribe if WebSocket is connected
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      subscribeToMarkets();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(DAEMON, "ERROR", `Watchlist refresh failed: ${msg}`);
  }
}

// ─── Price Window Management ─────────────────────────────────────────────────

function recordPrice(tokenId: string, rawPrice: number | string): void {
  const price = Number(rawPrice);
  if (isNaN(price) || price <= 0 || price >= 1) return;

  const entry = state.watchlist.find((w) => w.tokenId === tokenId);
  if (!entry) return;

  let window = priceWindows.get(tokenId);
  if (!window) {
    window = {
      conditionId: entry.conditionId,
      question: entry.question,
      tokenId,
      outcome: entry.outcome,
      snapshots: [],
    };
    priceWindows.set(tokenId, window);
  }

  const now = Date.now();
  window.snapshots.push({ price, timestamp: now });

  // Prune snapshots older than the window
  const cutoff = now - CONFIG.priceWindowMs;
  window.snapshots = window.snapshots.filter((s) => s.timestamp > cutoff);
}

function checkMovement(tokenId: string): {
  moved: boolean;
  changePercent: number;
  oldPrice: number;
  newPrice: number;
  durationSeconds: number;
} | null {
  const window = priceWindows.get(tokenId);
  if (!window || window.snapshots.length < 2) return null;

  const oldest = window.snapshots[0];
  const newest = window.snapshots[window.snapshots.length - 1];

  if (oldest.price === 0) return null;

  const changePercent =
    ((newest.price - oldest.price) / oldest.price) * 100;
  const durationSeconds = Math.floor(
    (newest.timestamp - oldest.timestamp) / 1000,
  );

  return {
    moved: Math.abs(changePercent) >= CONFIG.movementThresholdPercent,
    changePercent,
    oldPrice: oldest.price,
    newPrice: newest.price,
    durationSeconds,
  };
}

// ─── Per-Market Cooldown ─────────────────────────────────────────────────────

function isMarketOnCooldown(conditionId: string): boolean {
  const lastAlert = state.marketCooldowns[conditionId];
  if (!lastAlert) return false;
  return Date.now() - new Date(lastAlert).getTime() < CONFIG.perMarketCooldownMs;
}

function setMarketCooldown(conditionId: string): void {
  state.marketCooldowns[conditionId] = new Date().toISOString();
  saveState("price-watcher-state.json", state);
}

// ─── Movement Detection & Alert ──────────────────────────────────────────────

let lastGlobalTriggerTs = 0;

function processMovements(): void {
  // Global cooldown — only trigger once every 5 minutes regardless of market
  if (Date.now() - lastGlobalTriggerTs < GLOBAL_COOLDOWN_MS) {
    return;
  }

  for (const [tokenId, window] of priceWindows) {
    const result = checkMovement(tokenId);
    if (!result || !result.moved) continue;

    if (isMarketOnCooldown(window.conditionId)) continue;

    if (isAgentBusy()) {
      log(DAEMON, "INFO", "Agent busy, deferring price alert");
      continue;
    }

    log(
      DAEMON,
      "INFO",
      `Price movement detected: ${window.question} ${result.changePercent > 0 ? "+" : ""}${result.changePercent.toFixed(1)}%`,
    );

    const locked = acquireLock();
    if (!locked) {
      log(DAEMON, "WARN", "Could not acquire lock for price alert");
      continue;
    }

    try {
      const contextJson = JSON.stringify({
        conditionId: window.conditionId,
        question: window.question,
        changePercent: result.changePercent,
        oldPrice: result.oldPrice,
        newPrice: result.newPrice,
        durationSeconds: result.durationSeconds,
      });
      const triggerResult = triggerTradingCycle("price", contextJson);
      if (triggerResult.success) {
        log(DAEMON, "INFO", "Trading cycle completed for price movement");
        setMarketCooldown(window.conditionId);
      } else {
        log(
          DAEMON,
          "ERROR",
          `Trading cycle failed: ${triggerResult.output.slice(0, 200)}`,
        );
      }
    } finally {
      releaseLock();
    }

    // Set global cooldown after first successful trigger — exit loop
    lastGlobalTriggerTs = Date.now();
    return;
  }
}

// ─── WebSocket Connection ────────────────────────────────────────────────────

function subscribeToMarkets(): void {
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;

  const assetIds = state.watchlist.map((w) => w.tokenId);
  if (assetIds.length === 0) return;

  // Subscribe to market data for all watched tokens
  const subscribeMsg = JSON.stringify({
    auth: {},
    markets: [],
    assets_id: assetIds,
    type: "market",
  });

  wsConnection.send(subscribeMsg);
  log(DAEMON, "INFO", `Subscribed to ${assetIds.length} tokens via WebSocket`);
}

function handleWsMessage(data: WebSocket.Data): void {
  try {
    wsMessageCount++;

    // Log first 3 messages for debugging subscription format
    if (wsMessageCount <= 3) {
      const preview = data.toString().slice(0, 300);
      log(DAEMON, "INFO", `WS message #${wsMessageCount}: ${preview}`);
    }

    const msg = JSON.parse(data.toString());

    // Handle different event types from Polymarket CLOB WebSocket
    if (Array.isArray(msg)) {
      for (const event of msg) {
        processWsEvent(event);
      }
    } else {
      processWsEvent(msg);
    }
  } catch {
    // Ignore unparseable messages
  }
}

function processWsEvent(event: Record<string, unknown>): void {
  const eventType = String(event.event_type || event.type || "");
  const assetId = String(
    event.asset_id || event.token_id || event.id || "",
  );

  let price: number | null = null;

  // Try to extract price from various field names
  if (event.price !== undefined) {
    price = parseFloat(String(event.price));
  } else if (event.last_trade_price !== undefined) {
    price = parseFloat(String(event.last_trade_price));
  } else if (event.mid !== undefined) {
    price = parseFloat(String(event.mid));
  } else if (event.midpoint !== undefined) {
    price = parseFloat(String(event.midpoint));
  }

  if (assetId && price !== null && !isNaN(price)) {
    if (!wsReceivingData) {
      wsReceivingData = true;
      log(DAEMON, "INFO", "WebSocket is receiving price data — disabling REST fallback");
      usingRestFallback = false;
    }
    recordPrice(assetId, price);
  }

  // Log connection confirmation events
  if (eventType === "subscribed" || eventType === "connected") {
    log(DAEMON, "INFO", `WebSocket ${eventType}`);
  }
}

function connectWebSocket(): void {
  if (wsConnection) {
    try {
      wsConnection.terminate();
    } catch {}
  }

  log(DAEMON, "INFO", `Connecting to WebSocket: ${CONFIG.wsUrl}`);

  wsConnection = new WebSocket(CONFIG.wsUrl, {
    headers: { "User-Agent": "PolymarketTrader/2.0" },
    handshakeTimeout: 10_000,
  });

  wsConnection.on("open", () => {
    log(DAEMON, "INFO", "WebSocket connected");
    wsReconnectDelay = 1000; // Reset backoff
    wsMessageCount = 0;
    subscribeToMarkets();

    // Keepalive ping every 30s to prevent idle timeout
    if (wsPingInterval) clearInterval(wsPingInterval);
    wsPingInterval = setInterval(() => {
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.ping();
      }
    }, 30_000);
  });

  wsConnection.on("message", handleWsMessage);

  wsConnection.on("pong", () => {
    // Server responded to our ping — connection is alive
  });

  wsConnection.on("error", (err: Error) => {
    log(DAEMON, "ERROR", `WebSocket error: ${err.message}`);
  });

  wsConnection.on("close", (code: number, reason: Buffer) => {
    log(
      DAEMON,
      "WARN",
      `WebSocket closed: ${code} ${reason.toString()}`,
    );
    wsConnection = null;
    wsReceivingData = false;
    usingRestFallback = true;
    if (wsPingInterval) {
      clearInterval(wsPingInterval);
      wsPingInterval = null;
    }
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  log(
    DAEMON,
    "INFO",
    `Reconnecting in ${wsReconnectDelay / 1000}s...`,
  );

  setTimeout(() => {
    // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s max
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30_000);
    connectWebSocket();
  }, wsReconnectDelay);

  // If we've been disconnected too long, switch to REST fallback
  if (wsReconnectDelay >= 30_000 && !usingRestFallback) {
    log(
      DAEMON,
      "WARN",
      "WebSocket unreliable — enabling REST fallback mode",
    );
    usingRestFallback = true;
  }
}

// ─── REST Fallback Polling ───────────────────────────────────────────────────

async function pollPricesRest(): Promise<void> {
  if (state.watchlist.length === 0) return;

  try {
    // Fetch prices from Gamma API (goes direct, no proxy needed)
    const resp = await axios.get(`${CONFIG.gammaHost}/markets`, {
      params: {
        active: true,
        closed: false,
        order: "volume24hr",
        ascending: false,
        limit: MAX_WATCHLIST * 2,
      },
      timeout: 15_000,
    });

    const markets: Record<string, unknown>[] = resp.data || [];
    const priceMap = new Map<string, number>();

    for (const market of markets) {
      let tokenIds: string[];
      const raw = market.clobTokenIds;
      if (typeof raw === "string") {
        try {
          tokenIds = JSON.parse(raw);
        } catch {
          continue;
        }
      } else if (Array.isArray(raw)) {
        tokenIds = raw as string[];
      } else {
        continue;
      }

      let prices: number[];
      const rawPrices = market.outcomePrices;
      if (typeof rawPrices === "string") {
        try {
          prices = JSON.parse(rawPrices);
        } catch {
          continue;
        }
      } else if (Array.isArray(rawPrices)) {
        prices = (rawPrices as (string | number)[]).map(Number);
      } else {
        continue;
      }

      for (let i = 0; i < tokenIds.length && i < prices.length; i++) {
        priceMap.set(tokenIds[i], prices[i]);
      }
    }

    // Record prices for all watched tokens
    let matched = 0;
    for (const entry of state.watchlist) {
      const price = priceMap.get(entry.tokenId);
      if (price !== undefined) {
        recordPrice(entry.tokenId, price);
        matched++;
      }
    }
    log(DAEMON, "INFO", `REST poll: ${matched}/${state.watchlist.length} prices updated`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(DAEMON, "ERROR", `REST price poll failed: ${msg}`);
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(DAEMON, "INFO", "Starting price-watcher daemon");

  // Load state
  state = loadState<PriceWatcherState>("price-watcher-state.json", {
    watchlist: [],
    lastWatchlistRefresh: "",
    marketCooldowns: {},
  });

  // Initial watchlist refresh
  await refreshWatchlist();

  // Start WebSocket connection
  connectWebSocket();

  // Schedule periodic tasks
  let lastWatchlistRefresh = Date.now();
  let lastRestPoll = 0;

  while (true) {
    const now = Date.now();

    // Refresh watchlist periodically
    if (now - lastWatchlistRefresh >= CONFIG.watchlistRefreshIntervalMs) {
      lastWatchlistRefresh = now;
      await refreshWatchlist();
    }

    // REST fallback polling (when WebSocket is down or unreliable)
    if (usingRestFallback && now - lastRestPoll >= CONFIG.restFallbackIntervalMs) {
      lastRestPoll = now;
      await pollPricesRest();
    }

    // Check for movements and trigger alerts
    processMovements();

    // Sleep before next check
    await sleep(5_000);
  }
}

main().catch((err) => {
  log(DAEMON, "ERROR", `Fatal error: ${err.message || err}`);
  process.exit(1);
});
