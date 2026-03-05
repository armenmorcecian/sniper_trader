// ─── Binance WebSocket Feed ──────────────────────────────────────────────────
// Real-time crypto trades + 1m klines from Binance public WebSocket.
// Supports multiple symbols via combined streams. No auth needed.
// Reconnects with exponential backoff. Proactive 23h reconnect.

import WebSocket from "ws";
import type { BinanceTrade, BinanceKline } from "./types";

const LOG_PREFIX = "[binance-feed]";
const PING_INTERVAL_MS = 30_000;
const PROACTIVE_RECONNECT_MS = 23 * 60 * 60 * 1000; // 23h (Binance drops at 24h)

type TradeCallback = (trade: BinanceTrade, symbol: string) => void;
type KlineCallback = (kline: BinanceKline, symbol: string) => void;

export class BinanceFeed {
  private readonly symbols: string[];
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private tradeCallbacks: TradeCallback[] = [];
  private klineCallbacks: KlineCallback[] = [];
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private proactiveTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private _connected = false;
  private _lastPrices = new Map<string, number>();
  private _tradeCounts = new Map<string, number>();

  constructor(symbols: string[] = ["btcusdt"]) {
    this.symbols = symbols.map(s => s.toLowerCase());
    // Build combined stream URL: btcusdt@trade/btcusdt@kline_1m/ethusdt@trade/ethusdt@kline_1m/...
    const streams = this.symbols.flatMap(s => [`${s}@trade`, `${s}@kline_1m`]);
    this.wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`;
  }

  get isConnected(): boolean { return this._connected; }

  getLastPrice(symbol: string): number {
    return this._lastPrices.get(symbol.toLowerCase()) ?? 0;
  }

  getTradeCount(symbol: string): number {
    return this._tradeCounts.get(symbol.toLowerCase()) ?? 0;
  }

  /** Backward compat: returns first symbol's price */
  get lastPrice(): number {
    return this._lastPrices.get(this.symbols[0]) ?? 0;
  }

  get tradeCount(): number {
    let total = 0;
    for (const count of this._tradeCounts.values()) total += count;
    return total;
  }

  onTrade(callback: TradeCallback): void {
    this.tradeCallbacks.push(callback);
  }

  onKline(callback: KlineCallback): void {
    this.klineCallbacks.push(callback);
  }

  connect(): void {
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

  // ─── WebSocket ──────────────────────────────────────────────────────────────

  private connectWebSocket(): void {
    if (this.destroyed) return;

    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
    }

    console.log(`${LOG_PREFIX} Connecting to Binance WebSocket (${this.symbols.length} symbol(s): ${this.symbols.join(", ")})...`);

    this.ws = new WebSocket(this.wsUrl, {
      handshakeTimeout: 10_000,
    });

    this.ws.on("open", () => {
      console.log(`${LOG_PREFIX} Connected to Binance WebSocket`);
      this.reconnectDelay = 1000;
      this._connected = true;

      // Ping to keep alive
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, PING_INTERVAL_MS);

      // Proactive reconnect before Binance 24h limit
      if (this.proactiveTimer) clearTimeout(this.proactiveTimer);
      this.proactiveTimer = setTimeout(() => {
        console.log(`${LOG_PREFIX} Proactive reconnect (23h limit)`);
        if (this.ws) {
          try { this.ws.close(1000, "proactive-reconnect"); } catch { /* ignore */ }
        }
      }, PROACTIVE_RECONNECT_MS);
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      this.handleMessage(data);
    });

    this.ws.on("pong", () => { /* alive */ });

    this.ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} WebSocket error: ${err.message}`);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.warn(`${LOG_PREFIX} WebSocket closed: ${code} ${reason.toString()}`);
      this.ws = null;
      this._connected = false;

      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      if (this.proactiveTimer) {
        clearTimeout(this.proactiveTimer);
        this.proactiveTimer = null;
      }

      this.scheduleReconnect();
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const wrapper = JSON.parse(data.toString());

      // Binance combined stream wraps data in { stream, data }
      const streamName: string = wrapper.stream || "";
      const payload = wrapper.data || wrapper;

      // Extract symbol from stream name: "btcusdt@trade" → "btcusdt"
      const symbol = streamName.split("@")[0] || "";

      if (streamName.includes("@trade") || payload.e === "trade") {
        const trade = payload as BinanceTrade;
        const price = Number(trade.p);
        if (!isNaN(price) && price > 0) {
          this._lastPrices.set(symbol, price);
          this._tradeCounts.set(symbol, (this._tradeCounts.get(symbol) ?? 0) + 1);
          for (const cb of this.tradeCallbacks) {
            try { cb(trade, symbol); } catch (err) {
              console.error(`${LOG_PREFIX} Trade callback error:`, err instanceof Error ? err.message : String(err));
            }
          }
        }
      } else if (streamName.includes("@kline") || payload.e === "kline") {
        const kline = payload as BinanceKline;
        for (const cb of this.klineCallbacks) {
          try { cb(kline, symbol); } catch (err) {
            console.error(`${LOG_PREFIX} Kline callback error:`, err instanceof Error ? err.message : String(err));
          }
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
  }
}
