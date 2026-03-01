import * as fs from "fs";
import * as path from "path";
import { PolymarketService } from "./polymarket.service";
import { resolveTokenId } from "./utils";
import type { PriceSnapshot } from "./types";
import { PredictionMarketParticleFilter } from "quant-core";
import type { ParticleFilterState } from "quant-core";

interface PriceHistory {
  [conditionId: string]: PriceSnapshot[];
}

/** Serialized particle filter states per conditionId */
interface FilterStateStore {
  [conditionId: string]: ParticleFilterState;
}

const FILTER_FILE = path.join(__dirname, "..", "data", "particle-filters.json");

function loadFilterStates(): FilterStateStore {
  try {
    if (fs.existsSync(FILTER_FILE)) {
      return JSON.parse(fs.readFileSync(FILTER_FILE, "utf-8"));
    }
  } catch {
    // Corrupt file — start fresh
  }
  return {};
}

function saveFilterStates(states: FilterStateStore): void {
  const dir = path.dirname(FILTER_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(FILTER_FILE, JSON.stringify(states));
}

const DATA_DIR = path.join(__dirname, "..", "data");
const HISTORY_FILE = path.join(DATA_DIR, "price-history.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function loadHistory(): PriceHistory {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch {
    // Corrupt file — start fresh
  }
  return {};
}

function saveHistory(history: PriceHistory): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function pruneOldEntries(history: PriceHistory): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const conditionId of Object.keys(history)) {
    history[conditionId] = history[conditionId].filter(
      (snap) => new Date(snap.timestamp).getTime() > cutoff,
    );
    if (history[conditionId].length === 0) {
      delete history[conditionId];
    }
  }
}

/**
 * Poll current prices for a list of markets and append to history.
 * Updates particle filter for each market to track filtered probability.
 * Returns the collected snapshots + history depth + filtered probabilities per market.
 */
export async function collectPrices(
  service: PolymarketService,
  conditionIds: string[],
): Promise<{
  collected: { conditionId: string; snapshot: PriceSnapshot; filteredProbability?: number; divergence?: number }[];
  historyDepth: { [conditionId: string]: number };
  errors: { conditionId: string; error: string }[];
}> {
  const history = loadHistory();
  pruneOldEntries(history);

  const filterStates = loadFilterStates();
  const collected: { conditionId: string; snapshot: PriceSnapshot; filteredProbability?: number; divergence?: number }[] = [];
  const errors: { conditionId: string; error: string }[] = [];

  for (const conditionId of conditionIds) {
    try {
      // Fetch market data to resolve token IDs
      const { orderBook: yesBook, tokenId: yesTokenId } =
        await service.getOrderBookForToken(conditionId, "Yes");

      // Get Yes price from CLOB
      const yesResult = await service.getPrice(yesTokenId);
      const yesPrice = yesResult.price;
      const noPrice = 1 - yesPrice; // binary market: No = 1 - Yes

      // Best bid/ask from order book
      const bestBid = yesBook.bids.length > 0
        ? parseFloat(yesBook.bids[0].price)
        : 0;
      const bestAsk = yesBook.asks.length > 0
        ? parseFloat(yesBook.asks[0].price)
        : 0;
      const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

      const snapshot: PriceSnapshot = {
        timestamp: new Date().toISOString(),
        yesPrice,
        noPrice: Math.round(noPrice * 10000) / 10000,
        bestBid,
        bestAsk,
        spread: Math.round(spread * 10000) / 10000,
      };

      if (!history[conditionId]) {
        history[conditionId] = [];
      }
      history[conditionId].push(snapshot);

      // Update particle filter for this market
      let filteredProbability: number | undefined;
      let divergence: number | undefined;
      try {
        const pf = filterStates[conditionId]
          ? PredictionMarketParticleFilter.deserialize(filterStates[conditionId])
          : new PredictionMarketParticleFilter({
              nParticles: 1000,
              priorProb: 0.50,
              processVol: 0.03,
              obsNoise: 0.02,
            });

        const estimate = pf.update(yesPrice);
        filteredProbability = Math.round(estimate.filteredProb * 10000) / 10000;
        divergence = Math.round(estimate.divergence * 10000) / 10000;
        filterStates[conditionId] = pf.serialize();
      } catch {
        // Non-fatal — particle filter update failed, continue without it
      }

      collected.push({ conditionId, snapshot, filteredProbability, divergence });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ conditionId, error: message });
    }
  }

  saveHistory(history);
  try { saveFilterStates(filterStates); } catch { /* non-fatal */ }

  const historyDepth: { [conditionId: string]: number } = {};
  for (const conditionId of conditionIds) {
    historyDepth[conditionId] = history[conditionId]?.length ?? 0;
  }

  return { collected, historyDepth, errors };
}

/**
 * Get stored price history for a specific market.
 */
export function getStoredHistory(conditionId: string): PriceSnapshot[] {
  const history = loadHistory();
  return history[conditionId] || [];
}
