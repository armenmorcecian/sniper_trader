// ─── Position Redeemer ───────────────────────────────────────────────────────
// Periodically checks if open positions have resolved and redeems winning tokens.

import axios from "axios";
import { updateTradeExit, recordEquitySnapshot } from "quant-core";
import type { CopycatConfig } from "./config";
import type { IPolymarketService } from "./types";
import type { CopycatExecutor } from "./executor";
import type { Alerter } from "./alerter";

const LOG_PREFIX = "[redeemer]";

export class PositionRedeemer {
  constructor(
    private readonly config: CopycatConfig,
    private readonly service: IPolymarketService,
    private readonly executor: CopycatExecutor,
    private readonly alerter: Alerter,
  ) {}

  async checkResolutions(): Promise<void> {
    const positions = this.executor.getPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
      try {
        // Query Gamma API to check if market has resolved
        const resp = await axios.get(`${this.config.gammaHost}/markets`, {
          params: { condition_id: pos.conditionId },
          timeout: 10_000,
        });

        const market = resp.data?.[0];
        if (!market) continue;

        // Check if market is closed (resolved)
        if (!market.closed) continue;

        // Parse outcome prices to determine win/loss
        let outcomePrices: number[] = [];
        try {
          const raw = market.outcomePrices;
          outcomePrices = typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw.map(Number) : []);
        } catch { continue; }

        // Determine outcome index for this position
        let outcomes: string[] = [];
        try {
          const raw = market.outcomes;
          outcomes = typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        } catch { continue; }

        const outcomeIndex = outcomes.findIndex(
          (o: string) => o.toLowerCase() === pos.outcome.toLowerCase(),
        );
        if (outcomeIndex < 0) continue;

        const resolvedPrice = outcomePrices[outcomeIndex] ?? 0;
        const won = resolvedPrice >= 0.99;
        const exitPrice = won ? 1.00 : 0.00;

        const shares = pos.shares > 0 ? pos.shares : (pos.amount / pos.entryPrice);
        const pnl = (exitPrice - pos.entryPrice) * shares;
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const pnlSign = pnl >= 0 ? "+" : "";
        const wonLabel = won ? "WON" : "LOST";

        console.log(
          `${LOG_PREFIX} RESOLVED: "${pos.question.slice(0, 50)}" — ${wonLabel} ` +
          `${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
        );

        // Redeem winning tokens on-chain
        if (won && this.service.redeemWinningTokens) {
          try {
            const redeemed = await this.service.redeemWinningTokens(pos.conditionId);
            if (redeemed) {
              console.log(`${LOG_PREFIX} Redeemed winning tokens for ${pos.conditionId.slice(0, 12)}`);
            }
          } catch (err) {
            console.error(`${LOG_PREFIX} Redemption failed (non-fatal):`, err instanceof Error ? err.message : String(err));
          }
        }

        // Update journal
        try {
          if (pos.tradeId) updateTradeExit(pos.tradeId, exitPrice, pnl);
        } catch { /* non-fatal */ }

        // Equity snapshot
        try {
          const vitals = await this.service.getPortfolioValue();
          recordEquitySnapshot({
            skill: "polymarket",
            equity: vitals.totalEquity,
            cash: vitals.usdcBalance,
            positionsValue: vitals.positionValue,
            metadata: { source: "copycat-wallet", exitRule: "resolution", won },
          });
        } catch { /* non-fatal */ }

        // Remove from executor tracking (frees maxConcurrent slot)
        this.executor.removeResolvedPosition(pos.conditionId);

        // Telegram alert
        await this.alerter.sendStatus(
          `*Copycat RESOLVED* (${wonLabel})\n"${pos.question.slice(0, 80)}"\n` +
          `${pos.outcome}: $${pos.entryPrice.toFixed(4)} -> $${exitPrice.toFixed(2)}\n` +
          `PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`,
        );
      } catch (err) {
        // Non-fatal — skip this position and try the rest
        console.error(
          `${LOG_PREFIX} Error checking resolution for ${pos.conditionId.slice(0, 12)}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}
