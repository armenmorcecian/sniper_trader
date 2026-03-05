// ─── Telegram Alerter ────────────────────────────────────────────────────────

import * as https from "https";
import type { Config } from "./config";

const LOG_PREFIX = "[alerter]";
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

export class Alerter {
  constructor(private readonly config: Config) {}

  async sendAlert(
    alertType: string,
    severity: string,
    message: string,
    market?: string,
  ): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return;

    const key = `${alertType}:${market || "global"}`;
    const lastSent = rateLimitMap.get(key);
    if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) return;

    const icon = severity === "block" ? "\u{1F6A8}" : severity === "critical" ? "\u26A0\uFE0F" : "\u2139\uFE0F";
    const text = `${icon} *Crypto Scalper*\n\n*Type:* ${alertType}\n*Severity:* ${severity}${market ? `\n*Market:* ${market}` : ""}\n\n${message}`;

    try {
      await this.sendTelegram(text);
      rateLimitMap.set(key, Date.now());
      console.log(`${LOG_PREFIX} Alert sent: ${alertType} ${market || ""} (${severity})`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to send Telegram alert:`, err instanceof Error ? err.message : String(err));
    }
  }

  async sendStatus(message: string): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return;

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
