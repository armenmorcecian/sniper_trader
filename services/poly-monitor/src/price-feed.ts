// ─── Price Feed ──────────────────────────────────────────────────────────────
// WebSocket price feed with REST fallback for real-time Polymarket prices.

import WebSocket from "ws";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const LOG_PREFIX = "[price-feed]";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 30_000;
const REST_FALLBACK_INTERVAL_MS = 10_000;

type PriceCallback = (tokenId: string, price: number) => void;

export class PriceFeed {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private subscribedTokenIds = new Set<string>();
  private callbacks: PriceCallback[] = [];
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private restFallbackInterval: ReturnType<typeof setInterval> | null = null;
  private usingRestFallback = true;
  private wsReceivingData = false;
  private destroyed = false;
  private readonly gammaHost: string;
  private readonly proxyUrl?: string;

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.wsReceivingData;
  }

  constructor(gammaHost: string, proxyUrl?: string) {
    this.gammaHost = gammaHost;
    this.proxyUrl = proxyUrl;
  }

  onPrice(callback: PriceCallback): void {
    this.callbacks.push(callback);
  }

  subscribe(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokenIds.add(id);
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscription();
    }
  }

  unsubscribe(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokenIds.delete(id);
    }
  }

  connect(): void {
    this.connectWebSocket();
    this.startRestFallback();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.restFallbackInterval) {
      clearInterval(this.restFallbackInterval);
      this.restFallbackInterval = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────────

  private connectWebSocket(): void {
    if (this.destroyed) return;

    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
    }

    console.log(`${LOG_PREFIX} Connecting to WebSocket: ${WS_URL}`);

    const wsOpts: WebSocket.ClientOptions = {
      headers: { "User-Agent": "PolymarketTrader/2.0" },
      handshakeTimeout: 10_000,
    };
    if (this.proxyUrl) {
      wsOpts.agent = new HttpsProxyAgent(this.proxyUrl);
    }

    this.ws = new WebSocket(WS_URL, wsOpts);

    this.ws.on("open", () => {
      console.log(`${LOG_PREFIX} WebSocket connected`);
      this.reconnectDelay = 1000;
      this.sendSubscription();

      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, PING_INTERVAL_MS);
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      this.handleWsMessage(data);
    });

    this.ws.on("pong", () => {
      // Connection alive
    });

    this.ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} WebSocket error: ${err.message}`);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.warn(`${LOG_PREFIX} WebSocket closed: ${code} ${reason.toString()}`);
      this.ws = null;
      this.wsReceivingData = false;
      this.usingRestFallback = true;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      this.scheduleReconnect();
    });
  }

  private sendSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.subscribedTokenIds.size === 0) return;

    const msg = JSON.stringify({
      auth: {},
      markets: [],
      assets_id: Array.from(this.subscribedTokenIds),
      type: "market",
    });

    this.ws.send(msg);
    console.log(`${LOG_PREFIX} Subscribed to ${this.subscribedTokenIds.size} tokens`);
  }

  private handleWsMessage(data: WebSocket.RawData): void {
    try {
      const parsed = JSON.parse(data.toString());
      const events = Array.isArray(parsed) ? parsed : [parsed];

      for (const event of events) {
        const tokenId = event.asset_id || event.token_id || event.id;
        const price = Number(event.price || event.last_trade_price || event.mid || event.midpoint);

        if (tokenId && !isNaN(price) && price > 0 && price < 1) {
          if (!this.wsReceivingData) {
            this.wsReceivingData = true;
            this.usingRestFallback = false;
            console.log(`${LOG_PREFIX} WebSocket receiving data — disabling REST fallback`);
          }
          this.emitPrice(tokenId, price);
        }
      }
    } catch {
      // Non-fatal: malformed message
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    console.log(`${LOG_PREFIX} Reconnecting in ${this.reconnectDelay / 1000}s...`);

    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connectWebSocket();
    }, this.reconnectDelay);

    if (this.reconnectDelay >= 30_000 && !this.usingRestFallback) {
      console.warn(`${LOG_PREFIX} WebSocket unreliable — enabling REST fallback`);
      this.usingRestFallback = true;
    }
  }

  // ─── REST Fallback ──────────────────────────────────────────────────────────

  private startRestFallback(): void {
    this.restFallbackInterval = setInterval(() => {
      if (this.usingRestFallback && this.subscribedTokenIds.size > 0) {
        this.pollPricesRest().catch((err) => {
          console.error(`${LOG_PREFIX} REST poll failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }, REST_FALLBACK_INTERVAL_MS);
  }

  private async pollPricesRest(): Promise<void> {
    try {
      const proxyOpts = this.proxyUrl
        ? { httpsAgent: new HttpsProxyAgent(this.proxyUrl), httpAgent: new HttpsProxyAgent(this.proxyUrl) }
        : {};

      const resp = await axios.get(`${this.gammaHost}/markets`, {
        params: {
          active: true,
          closed: false,
          order: "volume24hr",
          ascending: false,
          limit: 100,
        },
        timeout: 15_000,
        ...proxyOpts,
      });

      const markets: Record<string, unknown>[] = resp.data || [];

      for (const market of markets) {
        let tokenIds: string[];
        const raw = market.clobTokenIds;
        if (typeof raw === "string") {
          try { tokenIds = JSON.parse(raw); } catch { continue; }
        } else if (Array.isArray(raw)) {
          tokenIds = raw as string[];
        } else {
          continue;
        }

        let prices: number[];
        const rawPrices = market.outcomePrices;
        if (typeof rawPrices === "string") {
          try { prices = JSON.parse(rawPrices); } catch { continue; }
        } else if (Array.isArray(rawPrices)) {
          prices = rawPrices as number[];
        } else {
          continue;
        }

        for (let i = 0; i < tokenIds.length; i++) {
          if (this.subscribedTokenIds.has(tokenIds[i]) && prices[i] != null) {
            const price = Number(prices[i]);
            if (!isNaN(price) && price > 0 && price < 1) {
              this.emitPrice(tokenIds[i], price);
            }
          }
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} REST fallback error:`, err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Emit ───────────────────────────────────────────────────────────────────

  private emitPrice(tokenId: string, price: number): void {
    for (const cb of this.callbacks) {
      try {
        cb(tokenId, price);
      } catch (err) {
        console.error(`${LOG_PREFIX} Price callback error:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}
