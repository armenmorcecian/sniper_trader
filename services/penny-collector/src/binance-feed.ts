// ─── Binance Spot Price Feed ────────────────────────────────────────────────
// Lightweight Binance WebSocket feed for spot price verification.
// Used to confirm penny collector picks are aligned with actual price direction.

import WebSocket from "ws";

const LOG_PREFIX = "[binance-feed]";
const PING_INTERVAL_MS = 30_000;
const PROACTIVE_RECONNECT_MS = 23 * 60 * 60 * 1000;

/** Maps Polymarket asset names to Binance symbols */
const ASSET_TO_SYMBOL: Record<string, string> = {
  BTC: "btcusdt",
  ETH: "ethusdt",
  SOL: "solusdt",
  DOGE: "dogeusdt",
  SUI: "suiusdt",
  PEPE: "pepeusdt",
  LINK: "linkusdt",
  AVAX: "avaxusdt",
};

export class BinanceFeed {
  private readonly symbols: string[];
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private proactiveTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private _connected = false;
  private _lastPrices = new Map<string, number>();

  constructor(assets: string[]) {
    this.symbols = assets
      .map((a) => ASSET_TO_SYMBOL[a.toUpperCase()])
      .filter(Boolean);
    const streams = this.symbols.map((s) => `${s}@trade`);
    this.wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  /** Get last trade price for a Polymarket asset name (e.g. "BTC") */
  getPrice(asset: string): number {
    const symbol = ASSET_TO_SYMBOL[asset.toUpperCase()];
    if (!symbol) return 0;
    return this._lastPrices.get(symbol) ?? 0;
  }

  connect(): void {
    if (this.symbols.length === 0) return;
    this.connectWebSocket();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.proactiveTimer) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    this._connected = false;
  }

  private connectWebSocket(): void {
    if (this.destroyed) return;
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
    }

    console.log(`${LOG_PREFIX} Connecting (${this.symbols.join(", ")})...`);

    this.ws = new WebSocket(this.wsUrl, { handshakeTimeout: 10_000 });

    this.ws.on("open", () => {
      console.log(`${LOG_PREFIX} Connected`);
      this.reconnectDelay = 1000;
      this._connected = true;

      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
      }, PING_INTERVAL_MS);

      if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
      this.proactiveTimer = setTimeout(() => {
        console.log(`${LOG_PREFIX} Proactive reconnect (23h)`);
        if (this.ws) {
          try { this.ws.close(1000, "proactive-reconnect"); } catch { /* ignore */ }
        }
      }, PROACTIVE_RECONNECT_MS);
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const wrapper = JSON.parse(data.toString());
        const streamName: string = wrapper.stream || "";
        const payload = wrapper.data || wrapper;
        const symbol = streamName.split("@")[0] || "";

        if (streamName.includes("@trade") || payload.e === "trade") {
          const price = Number(payload.p);
          if (!isNaN(price) && price > 0) {
            this._lastPrices.set(symbol, price);
          }
        }
      } catch { /* non-fatal */ }
    });

    this.ws.on("pong", () => { /* alive */ });
    this.ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} WebSocket error: ${err.message}`);
    });
    this.ws.on("close", () => {
      this.ws = null;
      this._connected = false;
      if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
      if (this.proactiveTimer) { clearTimeout(this.proactiveTimer); this.proactiveTimer = null; }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    console.log(`${LOG_PREFIX} Reconnecting in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connectWebSocket();
    }, this.reconnectDelay);
  }
}
