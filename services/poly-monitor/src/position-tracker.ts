// ─── Position Tracker ────────────────────────────────────────────────────────
// Polls PolymarketService for open positions, maintains TrackedPosition map
// with particle filter state per position.

import { PredictionMarketParticleFilter } from "quant-core";
import type { IPolymarketService, TrackedPosition } from "./types";

const LOG_PREFIX = "[position-tracker]";

export class PositionTracker {
  private positions = new Map<string, TrackedPosition>();
  private particleFilters = new Map<string, PredictionMarketParticleFilter>();
  /** Maps CLOB tokenId → conditionId for price feed routing */
  private tokenToCondition = new Map<string, string>();

  constructor(private readonly service: IPolymarketService) {}

  async reconcile(): Promise<{ added: string[]; removed: string[]; total: number }> {
    const added: string[] = [];
    const removed: string[] = [];

    try {
      const apiPositions = await this.service.getOpenPositionsWithPnL();
      const apiConditionIds = new Set(apiPositions.map((p) => p.conditionId));

      // Detect new positions
      for (const pos of apiPositions) {
        if (!this.positions.has(pos.conditionId)) {
          // New position detected
          const tracked: TrackedPosition = {
            conditionId: pos.conditionId,
            question: pos.question,
            outcome: pos.outcome,
            size: pos.size,
            avgEntryPrice: pos.avgEntryPrice,
            currentPrice: pos.currentPrice,
            marketValue: pos.marketValue,
            pnl: pos.pnl,
            pnlPercent: pos.pnlPercent,
            entryTime: new Date().toISOString(),
            entryEdge: 0, // Unknown — not tracked at entry
            clobTokenIds: [], // Will be populated by scanner if known
            endDate: null,
            lastEdge: null,
          };
          this.positions.set(pos.conditionId, tracked);

          // Initialize particle filter for this position
          const pf = new PredictionMarketParticleFilter({
            nParticles: 2000,
            priorProb: 0.50,
            processVol: 0.03,
            obsNoise: 0.02,
          });
          pf.update(pos.currentPrice);
          this.particleFilters.set(pos.conditionId, pf);

          added.push(pos.conditionId);
          console.log(`${LOG_PREFIX} New position: "${pos.question}" (${pos.outcome}) — ${pos.size} @ $${pos.avgEntryPrice.toFixed(3)}`);
        } else {
          // Update existing position
          const tracked = this.positions.get(pos.conditionId)!;
          tracked.currentPrice = pos.currentPrice;
          tracked.pnl = pos.pnl;
          tracked.pnlPercent = pos.pnlPercent;
          tracked.marketValue = pos.marketValue;
          tracked.size = pos.size;
        }
      }

      // Detect closed positions
      for (const [conditionId] of this.positions) {
        if (!apiConditionIds.has(conditionId)) {
          const pos = this.positions.get(conditionId)!;
          console.log(`${LOG_PREFIX} Position closed: "${pos.question}"`);
          this.positions.delete(conditionId);
          this.particleFilters.delete(conditionId);
          // Clean up token mapping
          for (const [tokenId, cid] of this.tokenToCondition) {
            if (cid === conditionId) this.tokenToCondition.delete(tokenId);
          }
          removed.push(conditionId);
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Reconciliation failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    }

    return { added, removed, total: this.positions.size };
  }

  updatePrice(conditionId: string, price: number): void {
    const pos = this.positions.get(conditionId);
    if (!pos) return;

    pos.currentPrice = price;
    // Recalculate P&L
    pos.pnl = (price - pos.avgEntryPrice) * pos.size;
    pos.pnlPercent = pos.avgEntryPrice > 0
      ? ((price - pos.avgEntryPrice) / pos.avgEntryPrice) * 100
      : 0;
    pos.marketValue = price * pos.size;

    // Feed to particle filter
    const pf = this.particleFilters.get(conditionId);
    if (pf) {
      pf.update(price);
      const estimate = pf.estimate();
      pos.lastEdge = Math.abs(estimate.filteredProb - price);
    }
  }

  /** Route a CLOB tokenId price update to the corresponding position */
  updatePriceByToken(tokenId: string, price: number): void {
    const conditionId = this.tokenToCondition.get(tokenId);
    if (conditionId) {
      this.updatePrice(conditionId, price);
    }
  }

  /** Register tokenId → conditionId mappings for price feed routing */
  registerTokenMapping(conditionId: string, tokenIds: string[]): void {
    for (const tokenId of tokenIds) {
      this.tokenToCondition.set(tokenId, conditionId);
    }
    // Also store on the tracked position
    const pos = this.positions.get(conditionId);
    if (pos) {
      pos.clobTokenIds = tokenIds;
    }
  }

  getPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  getPosition(conditionId: string): TrackedPosition | undefined {
    return this.positions.get(conditionId);
  }

  getParticleFilter(conditionId: string): PredictionMarketParticleFilter | undefined {
    return this.particleFilters.get(conditionId);
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  /** Get all subscribed CLOB token IDs for price feed */
  getSubscribedTokenIds(): string[] {
    return Array.from(this.tokenToCondition.keys());
  }
}
