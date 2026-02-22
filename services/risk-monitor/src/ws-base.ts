// ─── Reconnecting WebSocket ──────────────────────────────────────────────────
// Base class for Alpaca WebSocket connections with exponential backoff + jitter.

import WebSocket from "ws";
import { insertRiskAlert, resolveAlertsByType } from "quant-core";

const LOG_PREFIX = "[ws-base]";

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private destroyed = false;

  private connectHandler: (() => void) | null = null;
  private messageHandler: ((data: unknown) => void) | null = null;
  private disconnectHandler: (() => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly name: string,
    private readonly maxAttempts: number = 50,
    private readonly baseDelay: number = 1000,
    private readonly maxDelay: number = 60_000,
  ) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onConnect(handler: () => void): void {
    this.connectHandler = handler;
  }

  onMessage(handler: (data: unknown) => void): void {
    this.messageHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
    }

    console.log(`${LOG_PREFIX} [${this.name}] Connecting to ${this.url}...`);

    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      console.log(`${LOG_PREFIX} [${this.name}] Connected`);
      this.consecutiveFailures = 0;

      // Auto-resolve ws_disconnect alerts on successful reconnect
      try { resolveAlertsByType("ws_disconnect"); } catch { /* non-fatal */ }

      if (this.connectHandler) this.connectHandler();
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        if (this.messageHandler) this.messageHandler(data);
      } catch (err) {
        console.error(`${LOG_PREFIX} [${this.name}] Parse error:`, err);
      }
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.warn(`${LOG_PREFIX} [${this.name}] Closed: ${code} ${reason.toString()}`);
      if (this.disconnectHandler) this.disconnectHandler();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error(`${LOG_PREFIX} [${this.name}] Error:`, err.message);
      // close event will fire after error, which triggers reconnect
    });
  }

  send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.maxAttempts) {
      console.error(`${LOG_PREFIX} [${this.name}] Max reconnect attempts (${this.maxAttempts}) reached. Writing block alert.`);
      try {
        insertRiskAlert({
          alertType: "ws_disconnect",
          severity: "block",
          message: `${this.name} WebSocket disconnected after ${this.maxAttempts} reconnect attempts`,
          details: { url: this.url, consecutiveFailures: this.consecutiveFailures },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} [${this.name}] Failed to write alert:`, err);
      }
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.consecutiveFailures - 1),
      this.maxDelay,
    );
    const jitter = delay * 0.2 * Math.random();
    const totalDelay = delay + jitter;

    console.log(`${LOG_PREFIX} [${this.name}] Reconnecting in ${Math.round(totalDelay)}ms (attempt ${this.consecutiveFailures}/${this.maxAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, totalDelay);
  }
}
