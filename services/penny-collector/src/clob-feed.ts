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

    // Remove stale tokens from price cache and book state
    for (const id of this.subscribedTokens) {
      if (!newSet.has(id)) {
        this._prices.delete(id);
        this._lastUpdateMs.delete(id);
        this.bookBids.delete(id);
        this.bookAsks.delete(id);
      }
    }

    this.subscribedTokens = newSet;

    if (toAdd.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.subscribe(toAdd);
    } else if (toAdd.length > 0) {
      for (const id of toAdd) this.pendingTokens.add(id);
    }
  }

  connect(): void {
    if (this.destroyed) return;
    this.doConnect();
  }

  destroy(): void {
    this.destroyed = true;
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
      this._lastMessageTime = Date.now();
      this._lastPongTime = Date.now();

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
