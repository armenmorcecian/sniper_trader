// ─── Telegram Alerter ────────────────────────────────────────────────────────
// Rate-limited Telegram alerts. Max 1 message per (alertType, symbol) per 5 min.
// Uses node:https — no additional dependencies.

import * as https from "https";
import type { Config } from "./config";

const LOG_PREFIX = "[alerter]";

// Rate limit: key = "alertType:symbol", value = last send timestamp
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

export class Alerter {
  constructor(private readonly config: Config) {}

  /**
   * Send a risk alert via Telegram. Rate-limited per (alertType, symbol).
   */
  async sendAlert(
    alertType: string,
    severity: string,
    message: string,
    symbol?: string,
  ): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      return;
    }

    // Rate limit check
    const key = `${alertType}:${symbol || "global"}`;
    const lastSent = rateLimitMap.get(key);
    if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
      return;
    }

    const icon = severity === "block" ? "🚨" : severity === "critical" ? "⚠️" : "ℹ️";
    const text = `${icon} *Risk Alert*\n\n*Type:* ${alertType}\n*Severity:* ${severity}${symbol ? `\n*Symbol:* ${symbol}` : ""}\n\n${message}`;

    try {
      await this.sendTelegram(text);
      rateLimitMap.set(key, Date.now());
      console.log(`${LOG_PREFIX} Alert sent: ${alertType} ${symbol || ""} (${severity})`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to send Telegram alert:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Send a general status message (not rate-limited).
   */
  async sendStatus(message: string): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) {
      return;
    }

    try {
      await this.sendTelegram(message);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to send Telegram status:`, err instanceof Error ? err.message : String(err));
    }
  }

  private sendTelegram(text: string): Promise<void> {
    const payload = JSON.stringify({
      chat_id: this.config.telegramChatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.telegram.org",
          path: `/bot${this.config.telegramBotToken}/sendMessage`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 10_000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
            }
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Telegram API request timed out"));
      });
      req.write(payload);
      req.end();
    });
  }
}
