// ─── Multi-Exchange Order Book Feed ──────────────────────────────────────────
// Aggregates order book depth from Binance, Bybit, and OKX to compute
// volume-weighted Order Book Imbalance (OBI).

import WebSocket from "ws";
import type { OrderBookSnapshot, AggregatedOBI } from "./types";

const LOG_PREFIX = "[obi]";

// Exchange weights for OBI aggregation
const WEIGHTS = { binance: 0.50, bybit: 0.30, okx: 0.20 } as const;

export class OrderBookFeed {
  private snapshots = new Map<string, OrderBookSnapshot>();
  private _lastObi: AggregatedOBI | null = null;
  private connections: WebSocket[] = [];
  private reconnectTimers: ReturnType<typeof setTimeout>[] = [];
  private destroyed = false;

  constructor(
    private readonly binanceSymbol: string,
    private readonly bybitSymbol: string,
    private readonly okxSymbol: string,
  ) {}

  get isReady(): boolean {
    return this._lastObi !== null && this.snapshots.size > 0;
  }

  get lastObi(): AggregatedOBI | null {
    return this._lastObi;
  }

  connect(): void {
    this.connectBinance();
    this.connectBybit();
    this.connectOkx();
  }

  destroy(): void {
    this.destroyed = true;
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers = [];
    for (const ws of this.connections) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
    this.connections = [];
  }

  // ─── Binance ────────────────────────────────────────────────────────────

  private connectBinance(): void {
    if (this.destroyed) return;
    const url = `wss://stream.binance.com:9443/ws/${this.binanceSymbol}@depth20@100ms`;
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.connections.push(ws);

    ws.on("open", () => {
      console.log(`${LOG_PREFIX} Binance depth connected (${this.binanceSymbol})`);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.bids && msg.asks) {
          this.snapshots.set("binance", {
            exchange: "binance",
            symbol: this.binanceSymbol,
            bids: msg.bids.map((b: string[]) => [Number(b[0]), Number(b[1])] as [number, number]),
            asks: msg.asks.map((a: string[]) => [Number(a[0]), Number(a[1])] as [number, number]),
            timestamp: Date.now(),
          });
          this.computeObi();
        }
      } catch { /* non-fatal */ }
    });

    ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} Binance depth error: ${err.message}`);
    });

    ws.on("close", () => {
      this.snapshots.delete("binance");
      this.scheduleReconnect("binance");
    });
  }

  // ─── Bybit ──────────────────────────────────────────────────────────────

  private connectBybit(): void {
    if (this.destroyed) return;
    const ws = new WebSocket("wss://stream.bybit.com/v5/public/spot", { handshakeTimeout: 10_000 });
    this.connections.push(ws);

    ws.on("open", () => {
      console.log(`${LOG_PREFIX} Bybit depth connected (${this.bybitSymbol})`);
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [`orderbook.50.${this.bybitSymbol}`],
      }));
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        // Bybit sends snapshot (type=snapshot) and delta (type=delta)
        // For simplicity, use snapshot data; deltas require incremental book management
        const bookData = msg.data;
        if (bookData && (msg.type === "snapshot" || msg.topic?.startsWith("orderbook"))) {
          const bids = bookData.b || bookData.bids || [];
          const asks = bookData.a || bookData.asks || [];
          if (bids.length > 0 || asks.length > 0) {
            this.snapshots.set("bybit", {
              exchange: "bybit",
              symbol: this.bybitSymbol,
              bids: bids.map((b: string[]) => [Number(b[0]), Number(b[1])] as [number, number]),
              asks: asks.map((a: string[]) => [Number(a[0]), Number(a[1])] as [number, number]),
              timestamp: Date.now(),
            });
            this.computeObi();
          }
        }
      } catch { /* non-fatal */ }
    });

    ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} Bybit depth error: ${err.message}`);
    });

    ws.on("close", () => {
      this.snapshots.delete("bybit");
      this.scheduleReconnect("bybit");
    });
  }

  // ─── OKX ────────────────────────────────────────────────────────────────

  private connectOkx(): void {
    if (this.destroyed) return;
    const ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public", { handshakeTimeout: 10_000 });
    this.connections.push(ws);

    ws.on("open", () => {
      console.log(`${LOG_PREFIX} OKX depth connected (${this.okxSymbol})`);
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [{ channel: "books5", instId: this.okxSymbol }],
      }));
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.data && Array.isArray(msg.data) && msg.data.length > 0) {
          const book = msg.data[0];
          const bids = book.bids || [];
          const asks = book.asks || [];
          if (bids.length > 0 || asks.length > 0) {
            this.snapshots.set("okx", {
              exchange: "okx",
              symbol: this.okxSymbol,
              bids: bids.map((b: string[]) => [Number(b[0]), Number(b[1])] as [number, number]),
              asks: asks.map((a: string[]) => [Number(a[0]), Number(a[1])] as [number, number]),
              timestamp: Date.now(),
            });
            this.computeObi();
          }
        }
      } catch { /* non-fatal */ }
    });

    ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} OKX depth error: ${err.message}`);
    });

    ws.on("close", () => {
      this.snapshots.delete("okx");
      this.scheduleReconnect("okx");
    });
  }

  // ─── OBI Computation ───────────────────────────────────────────────────

  computeObi(): void {
    if (this.snapshots.size === 0) return;

    let weightedBidVol = 0;
    let weightedAskVol = 0;
    let totalWeight = 0;
    let exchangeCount = 0;

    for (const [exchange, snap] of this.snapshots) {
      const weight = WEIGHTS[exchange as keyof typeof WEIGHTS] ?? 0.1;
      const staleMs = Date.now() - snap.timestamp;
      if (staleMs > 10_000) continue; // skip stale snapshots (>10s)

      let bidVol = 0;
      for (const [price, qty] of snap.bids) bidVol += price * qty;
      let askVol = 0;
      for (const [price, qty] of snap.asks) askVol += price * qty;

      weightedBidVol += bidVol * weight;
      weightedAskVol += askVol * weight;
      totalWeight += weight;
      exchangeCount++;
    }

    if (totalWeight === 0) return;

    // Normalize weights
    weightedBidVol /= totalWeight;
    weightedAskVol /= totalWeight;

    const total = weightedBidVol + weightedAskVol;
    const obi = total > 0 ? (weightedBidVol - weightedAskVol) / total : 0;

    this._lastObi = {
      obi,
      bidVolume: weightedBidVol,
      askVolume: weightedAskVol,
      exchangeCount,
      timestamp: Date.now(),
    };
  }

  // ─── Reconnection ──────────────────────────────────────────────────────

  private scheduleReconnect(exchange: string): void {
    if (this.destroyed) return;
    console.log(`${LOG_PREFIX} ${exchange} disconnected — reconnecting in 5s`);
    const timer = setTimeout(() => {
      switch (exchange) {
        case "binance": this.connectBinance(); break;
        case "bybit": this.connectBybit(); break;
        case "okx": this.connectOkx(); break;
      }
    }, 5000);
    this.reconnectTimers.push(timer);
  }
}
