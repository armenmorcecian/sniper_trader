// ─── Alpaca Trading WebSocket ────────────────────────────────────────────────
// Connects to Alpaca v2 trading stream for trade_updates events.

import { ReconnectingWebSocket } from "./ws-base";
import type { Config } from "./config";
import type { AlpacaTradeUpdate } from "./types";

const LOG_PREFIX = "[ws-trading]";

export class TradingWebSocket {
  private ws: ReconnectingWebSocket;
  private tradeUpdateHandler: ((update: AlpacaTradeUpdate) => void) | null = null;

  constructor(private readonly config: Config) {
    this.ws = new ReconnectingWebSocket(config.tradingWsUrl, "trading-stream");

    this.ws.onConnect(() => this.authenticate());
    this.ws.onMessage((data) => this.handleMessage(data));
  }

  get isConnected(): boolean {
    return this.ws.isConnected;
  }

  onTradeUpdate(handler: (update: AlpacaTradeUpdate) => void): void {
    this.tradeUpdateHandler = handler;
  }

  connect(): void {
    this.ws.connect();
  }

  destroy(): void {
    this.ws.destroy();
  }

  private authenticate(): void {
    console.log(`${LOG_PREFIX} Authenticating...`);
    this.ws.send({
      action: "authenticate",
      data: {
        key_id: this.config.alpacaKeyId,
        secret_key: this.config.alpacaSecretKey,
      },
    });
  }

  private handleMessage(data: unknown): void {
    const msg = data as { stream?: string; data?: Record<string, unknown> };

    if (msg.stream === "authorization") {
      const authData = msg.data as { status?: string; action?: string };
      if (authData?.status === "authorized") {
        console.log(`${LOG_PREFIX} Authenticated. Subscribing to trade_updates...`);
        this.ws.send({
          action: "listen",
          data: { streams: ["trade_updates"] },
        });
      } else {
        console.error(`${LOG_PREFIX} Auth failed:`, JSON.stringify(msg.data));
      }
      return;
    }

    if (msg.stream === "listening") {
      console.log(`${LOG_PREFIX} Subscribed to:`, JSON.stringify(msg.data));
      return;
    }

    if (msg.stream === "trade_updates") {
      const update = msg.data as unknown as AlpacaTradeUpdate;
      if (update && this.tradeUpdateHandler) {
        console.log(`${LOG_PREFIX} Trade update: ${update.event} ${update.order?.symbol} ${update.order?.side} qty=${update.order?.filled_qty}`);
        this.tradeUpdateHandler(update);
      }
      return;
    }
  }
}
