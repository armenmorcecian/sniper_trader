// ─── CLOB WebSocket Price Feed ──────────────────────────────────────────────
// Streams live Polymarket contract prices via the CLOB WebSocket.
// Subscribes to token IDs for active candle markets so exit & signal engines
// get sub-second price updates instead of relying on 10s Gamma REST polls.
// Routes through residential proxy when PROXY_URL is set (geo-blocking).

import WebSocket from "ws";
import http from "http";
import { URL } from "url";
import tls from "tls";

const LOG_PREFIX = "[clob-feed]";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 30_000;

type PriceCallback = (tokenId: string, price: number) => void;

export class ClobFeed {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private destroyed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private subscribedTokens = new Set<string>();
  private pendingTokens = new Set<string>(); // tokens to subscribe once connected
  private priceCallbacks: PriceCallback[] = [];
  private _connected = false;
  private _prices = new Map<string, number>();
  private _lastUpdateMs = new Map<string, number>();
  private _messageCount = 0;
  private _rawLogCount = 0;
  private _lastStatsTime = Date.now();
  private _priceEmitCount = 0;
  private _bookEventCount = 0;
  private _changeEventCount = 0;
  private _tradeEventCount = 0;
  private _droppedCount = 0;
  private _lastMessageTime = 0;
  private _lastPongTime = 0;
  private _proxyUrl: string | undefined;
  private bookBids = new Map<string, Map<string, number>>();  // tokenId → (price_str → size)
  private bookAsks = new Map<string, Map<string, number>>();  // tokenId → (price_str → size)
  private _pendingSnapshotSince = new Map<string, number>(); // tokenId → when subscribe was sent
  private _snapshotRetryCount = new Map<string, number>(); // tokenId → retry attempts so far
  private _tokenExpiry = new Map<string, number>(); // tokenId → market expiry timestamp (ms) — set by index.ts
  private _softReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(proxyUrl?: string) {
    this._proxyUrl = proxyUrl;
  }

  get isConnected(): boolean { return this._connected; }

  /** Get the latest price for a token, or 0 if unknown */
  getPrice(tokenId: string): number {
    return this._prices.get(tokenId) ?? 0;
  }

  /** Get age of last price update in ms, or Infinity if never updated */
  getPriceAge(tokenId: string): number {
    const last = this._lastUpdateMs.get(tokenId);
    return last ? Date.now() - last : Infinity;
  }

  /**
   * Get total USD value of ask-side liquidity at or below maxPrice for a token.
   * Returns 0 if no book data available.
   */
  getAskDepthUsd(tokenId: string, maxPrice: number): number {
    const asks = this.bookAsks.get(tokenId);
    if (!asks) return 0;
    let totalUsd = 0;
    for (const [priceStr, size] of asks) {
      const price = parseFloat(priceStr);
      if (!isNaN(price) && price <= maxPrice && size > 0) {
        totalUsd += price * size;
      }
    }
    return totalUsd;
  }

  /**
   * Register the expiry timestamp for a token (used by CF-2: avoid force-reconnecting
   * when all snapshot-failed tokens are far from their buy window).
   * Call alongside setTokens() for each newly-added near-expiry token.
   */
  setTokenExpiry(tokenId: string, expiryMs: number): void {
    this._tokenExpiry.set(tokenId, expiryMs);
  }

  /** Register callback for price updates */
  onPrice(callback: PriceCallback): void {
    this.priceCallbacks.push(callback);
  }

  /** Update the set of tokens to subscribe to. Re-subscribes if connected. */
  setTokens(tokenIds: string[]): void {
    const newSet = new Set(tokenIds);

    // Find tokens that need subscribing
    const toAdd: string[] = [];
    for (const id of newSet) {
      if (!this.subscribedTokens.has(id)) {
        toAdd.push(id);
      }
    }

    // Remove stale tokens from price cache and book state.
    // Preserve prices received within the last 5 minutes — during market cycle
    // transitions, Gamma briefly drops the expiring token from active markets,
    // causing setTokens() to remove it. The token is re-added milliseconds later,
    // but by then the price is gone and the expiring book may be too quiet to
    // send a new snapshot, causing the entire buy window to show as STALE.
    const now = Date.now();
    for (const id of this.subscribedTokens) {
      if (!newSet.has(id)) {
        const lastUpdate = this._lastUpdateMs.get(id);
        const ageMs = lastUpdate !== undefined ? now - lastUpdate : Infinity;
        if (ageMs > 300_000) {
          // Price is old enough to safely discard
          this._prices.delete(id);
          this._lastUpdateMs.delete(id);
        }
        // Always clear the book state (memory) — midpoint is recomputed on next snapshot
        this.bookBids.delete(id);
        this.bookAsks.delete(id);
        this._pendingSnapshotSince.delete(id);
        this._snapshotRetryCount.delete(id);
      }
    }

    this.subscribedTokens = newSet;

    if (toAdd.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      // Reset retry count for freshly added tokens before subscribing
      for (const id of toAdd) this._snapshotRetryCount.delete(id);
      this.subscribe(toAdd);
    } else if (toAdd.length > 0) {
      for (const id of toAdd) {
        this._snapshotRetryCount.delete(id);
        this.pendingTokens.add(id);
      }
    }
  }

  connect(): void {
    if (this.destroyed) return;
    this.doConnect();
  }

  destroy(): void {
    this.destroyed = true;
    if (this._softReconnectTimer) {
      clearTimeout(this._softReconnectTimer);
      this._softReconnectTimer = null;
    }
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
      this.ws = null;
    }
    this._connected = false;
  }

  private doConnect(): void {
    if (this.destroyed) return;
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
    }

    const wsOpts: WebSocket.ClientOptions = {
      headers: { "User-Agent": "CryptoScalper/1.0" },
      handshakeTimeout: 15_000,
    };

    // Route through HTTP proxy for geo-blocked regions
    if (this._proxyUrl) {
      try {
        const proxy = new URL(this._proxyUrl);
        const proxyHost = proxy.hostname;
        const proxyPort = parseInt(proxy.port) || 80;
        const proxyAuth = proxy.username
          ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
          : undefined;

        const target = new URL(WS_URL);

        // HTTP CONNECT tunnel for WSS through proxy
        const connectReq = http.request({
          host: proxyHost,
          port: proxyPort,
          method: "CONNECT",
          path: `${target.hostname}:443`,
          headers: proxyAuth
            ? { "Proxy-Authorization": "Basic " + Buffer.from(proxyAuth).toString("base64") }
            : {},
        });

        connectReq.on("connect", (_res, socket) => {
          if (this.destroyed) { socket.destroy(); return; }
          // Upgrade socket to TLS then open WebSocket over it
          const tlsSocket = tls.connect({
            host: target.hostname,
            socket,
            servername: target.hostname,
          }, () => {
            if (this.destroyed) { tlsSocket.destroy(); return; }
            this.ws = new WebSocket(WS_URL, {
              ...wsOpts,
              createConnection: () => tlsSocket as unknown as import("net").Socket,
            });
            this.wireEvents();
          });
          tlsSocket.on("error", (err: Error) => {
            console.error(`${LOG_PREFIX} TLS tunnel error: ${err.message}`);
            this.scheduleReconnect();
          });
        });

        connectReq.on("error", (err: Error) => {
          console.error(`${LOG_PREFIX} Proxy CONNECT error: ${err.message}`);
          this.scheduleReconnect();
        });

        connectReq.setTimeout(15_000, () => {
          console.error(`${LOG_PREFIX} Proxy CONNECT timeout`);
          connectReq.destroy();
          this.scheduleReconnect();
        });

        connectReq.end();
        console.log(`${LOG_PREFIX} Connecting via proxy ${proxyHost}:${proxyPort}`);
        return;
      } catch (err) {
        console.error(`${LOG_PREFIX} Proxy setup error:`, err instanceof Error ? err.message : String(err));
        // Fall through to direct connection
      }
    }

    this.ws = new WebSocket(WS_URL, wsOpts);
    this.wireEvents();
  }

  private wireEvents(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      console.log(`${LOG_PREFIX} Connected${this._proxyUrl ? " (via proxy)" : ""}`);
      this._connected = true;
      this.reconnectDelay = 1000;
      this._messageCount = 0;
      this._rawLogCount = 0;
      // Cancel any pending soft reconnect — fresh connection already established
      if (this._softReconnectTimer) {
        clearTimeout(this._softReconnectTimer);
        this._softReconnectTimer = null;
      }
      this._lastMessageTime = Date.now();
      this._lastPongTime = Date.now();

      this._pendingSnapshotSince.clear(); // will be repopulated by subscribe() below

      // Subscribe to all tracked tokens
      const allTokens = [...this.subscribedTokens, ...this.pendingTokens];
      this.pendingTokens.clear();
      if (allTokens.length > 0) {
        this.subscribe(allTokens);
      }

      // Keepalive ping + zombie detection
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();

          const now = Date.now();

          // Zombie check 1: subscribed but no data for 60s
          if (this.subscribedTokens.size > 0 && now - this._lastMessageTime > 60_000) {
            console.warn(
              `${LOG_PREFIX} Zombie detected: no messages for ${Math.round((now - this._lastMessageTime) / 1000)}s ` +
              `with ${this.subscribedTokens.size} subscribed tokens — force reconnecting`,
            );
            this.ws!.terminate();
            return;
          }

          // Zombie check 2: no pong response for 2x ping interval
          if (now - this._lastPongTime > 2 * PING_INTERVAL_MS) {
            console.warn(
              `${LOG_PREFIX} Zombie detected: no pong for ${Math.round((now - this._lastPongTime) / 1000)}s — force reconnecting`,
            );
            this.ws!.terminate();
            return;
          }

          // Snapshot health check: re-subscribe tokens stuck waiting for initial book snapshot.
          // Cap at 3 retries — after that, the server has no snapshot to send (e.g., empty book
          // on a newly started market). Prices will arrive via price_change/last_trade_price events
          // once the market becomes active.
          const SNAPSHOT_TIMEOUT_MS = 30_000;
          const MAX_SNAPSHOT_RETRIES = 3;
          const stuckTokens: string[] = [];
          const gaveUpTokenIds: string[] = [];
          for (const [tokenId, subscribedAt] of this._pendingSnapshotSince) {
            if (!this.subscribedTokens.has(tokenId)) {
              this._pendingSnapshotSince.delete(tokenId);
              this._snapshotRetryCount.delete(tokenId);
              continue;
            }
            const retries = this._snapshotRetryCount.get(tokenId) ?? 0;
            if (retries >= MAX_SNAPSHOT_RETRIES) {
              // Give up — remove from pending so we stop logging/retrying
              this._pendingSnapshotSince.delete(tokenId);
              this._snapshotRetryCount.delete(tokenId);
              console.log(`${LOG_PREFIX} Snapshot timeout: giving up on ${tokenId.slice(0, 12)} after ${retries} retries`);
              gaveUpTokenIds.push(tokenId);
              continue;
            }
            if (now - subscribedAt > SNAPSHOT_TIMEOUT_MS) {
              stuckTokens.push(tokenId);
            }
          }
          if (stuckTokens.length > 0) {
            for (const id of stuckTokens) {
              this._snapshotRetryCount.set(id, (this._snapshotRetryCount.get(id) ?? 0) + 1);
            }
            const attempt = this._snapshotRetryCount.get(stuckTokens[0]) ?? 1;
            console.warn(
              `${LOG_PREFIX} Re-subscribing ${stuckTokens.length} token(s) with missing initial snapshot (attempt ${attempt}/${MAX_SNAPSHOT_RETRIES})`,
            );
            this.subscribe(stuckTokens);
          } else if (gaveUpTokenIds.length > 0 && this._pendingSnapshotSince.size === 0 && this.subscribedTokens.size > 0) {
            // All snapshot retries exhausted. CF-2: only force-reconnect if at least one
            // failed token is near its buy window (≤6min from expiry). Thin-book tokens
            // far from expiry (e.g. 4h tokens at 22min) will never get snapshots — don't
            // disrupt existing subscriptions for markets that ARE approaching their window.
            const BUY_WINDOW_THRESHOLD_MS = 360_000; // 6 min = 2× maxSecondsBeforeExpiry
            const hasUrgentToken = gaveUpTokenIds.some((id) => {
              const expiry = this._tokenExpiry.get(id);
              return expiry === undefined || (expiry - now) <= BUY_WINDOW_THRESHOLD_MS;
            });
            if (hasUrgentToken) {
              console.warn(`${LOG_PREFIX} All snapshot retries exhausted — force reconnecting now`);
              this.ws!.terminate();
              return;
            }
            console.log(
              `${LOG_PREFIX} Snapshot timeout: ${gaveUpTokenIds.length} token(s) gave up but all >6min from expiry — soft reconnect in 30s`,
            );
            if (!this._softReconnectTimer) {
              this._softReconnectTimer = setTimeout(() => {
                this._softReconnectTimer = null;
                if (!this.destroyed && this.ws?.readyState === WebSocket.OPEN) {
                  console.log(`${LOG_PREFIX} Soft reconnect: forcing fresh connection for snapshot refresh`);
                  this.ws.terminate();
                }
              }, 30_000);
            }
          }
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on("pong", () => {
      this._lastPongTime = Date.now();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this._messageCount++;
      const now = Date.now();
      this._lastMessageTime = now;

      // Log first 10 raw messages after each (re)connect for diagnostics
      if (this._rawLogCount < 10) {
        this._rawLogCount++;
        console.log(`${LOG_PREFIX} RAW #${this._rawLogCount}: ${data.toString().slice(0, 500)}`);
      }

      // Periodic stats every 60s
      if (now - this._lastStatsTime >= 60_000) {
        console.log(
          `${LOG_PREFIX} [stats] msgs=${this._messageCount} emitted=${this._priceEmitCount} ` +
          `book=${this._bookEventCount} change=${this._changeEventCount} ` +
          `trade=${this._tradeEventCount} dropped=${this._droppedCount}`,
        );
        this._lastStatsTime = now;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg)) {
          for (const event of msg) this.processEvent(event);
        } else {
          this.processEvent(msg);
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    this.ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} WS error: ${err.message}`);
    });

    this.ws.on("close", (code: number) => {
      console.warn(`${LOG_PREFIX} WS closed (code=${code})`);
      this._connected = false;
      this.ws = null;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    setTimeout(() => this.doConnect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private subscribe(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({
      assets_ids: tokenIds,
      type: "market",
    });
    this.ws.send(msg);
    // Track tokens waiting for their initial snapshot
    const now = Date.now();
    for (const id of tokenIds) {
      if (!this._prices.has(id)) {
        this._pendingSnapshotSince.set(id, now);
      }
    }
    console.log(`${LOG_PREFIX} Subscribed to ${tokenIds.length} token(s)`);
  }

  /** Compute midpoint from best bid/ask for a token */
  private computeMidpoint(tokenId: string): number | null {
    const bids = this.bookBids.get(tokenId);
    const asks = this.bookAsks.get(tokenId);

    let bestBid = -Infinity;
    if (bids) {
      for (const [priceStr, size] of bids) {
        if (size > 0) {
          const p = parseFloat(priceStr);
          if (p > bestBid) bestBid = p;
        }
      }
    }

    let bestAsk = Infinity;
    if (asks) {
      for (const [priceStr, size] of asks) {
        if (size > 0) {
          const p = parseFloat(priceStr);
          if (p < bestAsk) bestAsk = p;
        }
      }
    }

    if (bestBid > 0 && bestAsk < Infinity) {
      return (bestBid + bestAsk) / 2;
    } else if (bestBid > 0) {
      return bestBid;
    } else if (bestAsk < Infinity) {
      return bestAsk;
    }
    return null;
  }

  private emitPrice(assetId: string, price: number): void {
    this._priceEmitCount++;
    this._prices.set(assetId, price);
    this._lastUpdateMs.set(assetId, Date.now());
    this._pendingSnapshotSince.delete(assetId); // snapshot received
    for (const cb of this.priceCallbacks) {
      cb(assetId, price);
    }
  }

  private processEvent(event: Record<string, unknown>): void {
    const eventType = String(event.event_type ?? "");

    // ── book: full order book snapshot (top-level asset_id, bids/asks arrays) ──
    if ((eventType === "book" || !eventType) && Array.isArray(event.bids) && Array.isArray(event.asks)) {
      const assetId = String(event.asset_id ?? "");
      if (!assetId || !this.subscribedTokens.has(assetId)) return;
      this._bookEventCount++;

      const bids = new Map<string, number>();
      for (const level of event.bids as Array<Record<string, unknown>>) {
        const p = String(level.price ?? "");
        const s = parseFloat(String(level.size ?? "0"));
        if (p && !isNaN(s)) bids.set(p, s);
      }
      const asks = new Map<string, number>();
      for (const level of event.asks as Array<Record<string, unknown>>) {
        const p = String(level.price ?? "");
        const s = parseFloat(String(level.size ?? "0"));
        if (p && !isNaN(s)) asks.set(p, s);
      }
      this.bookBids.set(assetId, bids);
      this.bookAsks.set(assetId, asks);
      this._pendingSnapshotSince.delete(assetId); // snapshot received — stop retrying even if book is empty

      const mid = this.computeMidpoint(assetId);
      if (mid !== null && !isNaN(mid) && mid > 0 && mid < 1) {
        this.emitPrice(assetId, mid);
      }
      return;
    }

    // ── price_change: incremental book updates (asset_id nested inside each entry) ──
    if (eventType === "price_change" && Array.isArray(event.price_changes)) {
      this._changeEventCount++;
      const affected = new Set<string>();

      for (const change of event.price_changes as Array<Record<string, unknown>>) {
        const assetId = String(change.asset_id ?? "");
        if (!assetId || !this.subscribedTokens.has(assetId)) continue;

        if (!this.bookBids.has(assetId)) this.bookBids.set(assetId, new Map());
        if (!this.bookAsks.has(assetId)) this.bookAsks.set(assetId, new Map());
        const bids = this.bookBids.get(assetId)!;
        const asks = this.bookAsks.get(assetId)!;

        const p = String(change.price ?? "");
        const s = parseFloat(String(change.size ?? "0"));
        const side = String(change.side ?? "").toUpperCase();
        if (!p) continue;

        const book = side === "BUY" ? bids : asks;
        if (!isNaN(s) && s > 0) {
          book.set(p, s);
        } else {
          book.delete(p);
        }
        affected.add(assetId);
      }

      // Recompute midpoint for each affected token
      for (const assetId of affected) {
        const mid = this.computeMidpoint(assetId);
        if (mid !== null && !isNaN(mid) && mid > 0 && mid < 1) {
          this.emitPrice(assetId, mid);
        }
      }
      return;
    }

    // ── last_trade_price: top-level asset_id + price ──
    if (eventType === "last_trade_price") {
      const assetId = String(event.asset_id ?? "");
      if (!assetId || !this.subscribedTokens.has(assetId)) return;
      this._tradeEventCount++;

      const price = parseFloat(String(event.price ?? ""));
      if (!isNaN(price) && price > 0 && price < 1) {
        this.emitPrice(assetId, price);
      }
      return;
    }

    // Unrecognized event type
    this._droppedCount++;
  }
}
