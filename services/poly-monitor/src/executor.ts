// ─── Executor ────────────────────────────────────────────────────────────────
// Buy + Sell execution, trade journal logging, and Telegram alerts.

import * as https from "https";
import {
  recordTrade,
  updateTradeExit,
  recordEquitySnapshot,
  logPrediction,
  queryTrades,
} from "quant-core";
import type { Config } from "./config";
import type { EdgeCandidate, ExitSignal, GeminiDecision, IPolymarketService, TrackedPosition } from "./types";

const LOG_PREFIX = "[executor]";

// Rate limit: key = "type:id", value = last send timestamp
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Telegram Alerter ────────────────────────────────────────────────────────

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
    const text = `${icon} *Poly Monitor*\n\n*Type:* ${alertType}\n*Severity:* ${severity}${market ? `\n*Market:* ${market}` : ""}\n\n${message}`;

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

// ─── Executor ────────────────────────────────────────────────────────────────

export class Executor {
  private readonly alerter: Alerter;

  constructor(
    private readonly config: Config,
    private readonly service: IPolymarketService,
  ) {
    this.alerter = new Alerter(config);
  }

  getAlerter(): Alerter {
    return this.alerter;
  }

  /** Returns the journal trade ID on success, or 0 on failure/skip */
  async executeBuy(
    candidate: EdgeCandidate,
    decision: GeminiDecision,
  ): Promise<number> {
    if (decision.action !== "BUY" || !decision.outcome || !decision.amount) {
      return 0;
    }

    try {
      // Validate bet size
      const amount = Math.min(decision.amount, this.config.maxBet);
      if (amount <= 0) {
        console.log(`${LOG_PREFIX} Skipping buy — amount <= 0`);
        return 0;
      }

      // Check cash reserve
      const vitals = await this.service.getPortfolioValue();
      const balanceAfterTrade = vitals.usdcBalance - amount;
      const reserveRatio = balanceAfterTrade / vitals.totalEquity;
      if (reserveRatio < this.config.cashReservePct / 100) {
        console.log(`${LOG_PREFIX} Skipping buy — cash reserve would drop to ${(reserveRatio * 100).toFixed(1)}%`);
        return 0;
      }

      console.log(`${LOG_PREFIX} Executing BUY: ${decision.outcome} on "${candidate.question}" @ $${candidate.marketPrice.toFixed(3)} — $${amount.toFixed(2)}`);

      const result = await this.service.createLimitOrder({
        marketConditionId: candidate.conditionId,
        outcome: decision.outcome,
        side: "BUY",
        amount,
        limitPrice: candidate.marketPrice,
      });

      // Record trade in journal
      let tradeId = 0;
      try {
        tradeId = recordTrade({
          skill: "polymarket",
          tool: "poly-monitor:buy",
          symbol: candidate.conditionId,
          conditionId: candidate.conditionId,
          side: "BUY",
          amount: result.totalCost,
          price: result.price,
          status: "filled",
          outcome: decision.outcome,
          metadata: {
            source: "poly-monitor",
            edge: candidate.edge,
            filteredProb: candidate.filteredProb,
            size: result.size,
            orderId: result.orderId,
          },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to record trade (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Log prediction for calibration
      try {
        logPrediction(candidate.conditionId, candidate.filteredProb, "poly-monitor");
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to log prediction (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Telegram alert
      const edgePct = (candidate.edge * 100).toFixed(1);
      await this.alerter.sendAlert(
        "BUY",
        "info",
        `*BUY ${decision.outcome}* on "${candidate.question}"\nPrice: $${result.price.toFixed(3)}\nAmount: $${result.totalCost.toFixed(2)}\nEdge: ${edgePct}%\nFiltered prob: ${candidate.filteredProb.toFixed(3)}`,
        candidate.conditionId.slice(0, 12),
      );

      console.log(`${LOG_PREFIX} Buy executed: orderId=${result.orderId}, size=${result.size}, price=${result.price}`);
      return tradeId;
    } catch (err) {
      console.error(`${LOG_PREFIX} Buy execution failed:`, err instanceof Error ? err.message : String(err));
      return 0;
    }
  }

  async executeSell(
    position: TrackedPosition,
    signal: ExitSignal,
  ): Promise<boolean> {
    try {
      console.log(`${LOG_PREFIX} Executing SELL (${signal.rule}): "${position.question}" — ${signal.reason}`);

      const result = await this.service.sellPosition(
        position.conditionId,
        position.outcome as "Yes" | "No",
      );

      // Record exit in journal — find the open trade for this position
      try {
        if (position.tradeId) {
          updateTradeExit(position.tradeId, result.price, position.pnl);
        } else {
          // Fall back: find most recent BUY trade for this conditionId without an exit
          const trades = queryTrades({ symbol: position.conditionId, skill: "polymarket" });
          const openTrade = trades.find((t: { side: string; exitPrice?: number }) => t.side === "BUY" && !t.exitPrice);
          if (openTrade?.id) {
            updateTradeExit(openTrade.id, result.price, position.pnl);
          }
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to update trade exit (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Record equity snapshot
      try {
        const vitals = await this.service.getPortfolioValue();
        recordEquitySnapshot({
          skill: "polymarket",
          equity: vitals.totalEquity,
          cash: vitals.usdcBalance,
          positionsValue: vitals.positionValue,
          metadata: { source: "poly-monitor", exitRule: signal.rule },
        });
      } catch (err) {
        console.error(`${LOG_PREFIX} Failed to record equity snapshot (non-fatal):`, err instanceof Error ? err.message : String(err));
      }

      // Telegram alert
      const pnlStr = position.pnl >= 0 ? `+$${position.pnl.toFixed(2)}` : `-$${Math.abs(position.pnl).toFixed(2)}`;
      const pnlPctStr = position.pnlPercent >= 0 ? `+${position.pnlPercent.toFixed(1)}%` : `${position.pnlPercent.toFixed(1)}%`;
      const severity = signal.urgency === "high" ? "critical" : "info";
      await this.alerter.sendAlert(
        `EXIT:${signal.rule}`,
        severity,
        `*EXIT* "${position.question}"\nRule: ${signal.rule}\nP&L: ${pnlStr} (${pnlPctStr})\nReason: ${signal.reason}`,
        position.conditionId.slice(0, 12),
      );

      console.log(`${LOG_PREFIX} Sell executed: orderId=${result.orderId}, P&L=${pnlStr}`);
      return true;
    } catch (err) {
      console.error(`${LOG_PREFIX} Sell execution failed:`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
