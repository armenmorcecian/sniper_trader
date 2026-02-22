// ─── Alpaca Data WebSocket ───────────────────────────────────────────────────
// Connects to Alpaca v2 data stream for real-time minute bars.

import { ReconnectingWebSocket } from "./ws-base";
import type { Config } from "./config";
import type { AlpacaMinuteBar } from "./types";

const LOG_PREFIX = "[ws-data]";

export class DataWebSocket {
  private ws: ReconnectingWebSocket;
  private barHandler: ((bar: AlpacaMinuteBar) => void) | null = null;
  private subscribedSymbols: string[] = [];

  constructor(private readonly config: Config) {
    this.ws = new ReconnectingWebSocket(config.dataWsUrl, "data-stream");

    this.ws.onConnect(() => this.authenticate());
    this.ws.onMessage((data) => this.handleMessage(data));
  }

  get isConnected(): boolean {
    return this.ws.isConnected;
  }

  onBar(handler: (bar: AlpacaMinuteBar) => void): void {
    this.barHandler = handler;
  }

  connect(): void {
    this.ws.connect();
  }

  destroy(): void {
    this.ws.destroy();
  }

  /**
   * Update bar subscription to track specific symbols.
   * Unsubscribes from removed symbols and subscribes to new ones.
   */
  updateSubscription(symbols: string[]): void {
    const newSet = new Set(symbols);
    const oldSet = new Set(this.subscribedSymbols);

    const toRemove = this.subscribedSymbols.filter(s => !newSet.has(s));
    const toAdd = symbols.filter(s => !oldSet.has(s));

    if (toRemove.length > 0) {
      this.ws.send({ action: "unsubscribe", bars: toRemove });
      console.log(`${LOG_PREFIX} Unsubscribed from bars: ${toRemove.join(", ")}`);
    }

    if (toAdd.length > 0) {
      this.ws.send({ action: "subscribe", bars: toAdd });
      console.log(`${LOG_PREFIX} Subscribed to bars: ${toAdd.join(", ")}`);
    }

    this.subscribedSymbols = [...symbols];
  }

  private authenticate(): void {
    console.log(`${LOG_PREFIX} Authenticating...`);
    this.ws.send({
      action: "auth",
      key: this.config.alpacaKeyId,
      secret: this.config.alpacaSecretKey,
    });
  }

  private handleMessage(data: unknown): void {
    // Alpaca data WS sends arrays of messages
    const messages = Array.isArray(data) ? data : [data];

    for (const msg of messages) {
      const typed = msg as { T?: string; msg?: string; S?: string };

      if (typed.T === "success") {
        if (typed.msg === "authenticated") {
          console.log(`${LOG_PREFIX} Authenticated.`);
          // Re-subscribe to previously subscribed symbols on reconnect
          if (this.subscribedSymbols.length > 0) {
            this.ws.send({ action: "subscribe", bars: this.subscribedSymbols });
            console.log(`${LOG_PREFIX} Re-subscribed to: ${this.subscribedSymbols.join(", ")}`);
          }
        } else if (typed.msg === "connected") {
          console.log(`${LOG_PREFIX} Connected to data stream.`);
        }
        continue;
      }

      if (typed.T === "subscription") {
        console.log(`${LOG_PREFIX} Subscription update:`, JSON.stringify(msg));
        continue;
      }

      if (typed.T === "error") {
        console.error(`${LOG_PREFIX} Error:`, JSON.stringify(msg));
        continue;
      }

      // Minute bar
      if (typed.T === "b" && typed.S) {
        const bar = msg as unknown as AlpacaMinuteBar;
        if (this.barHandler) {
          this.barHandler(bar);
        }
        continue;
      }
    }
  }
}
