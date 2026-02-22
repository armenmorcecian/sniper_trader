import * as fs from "fs";
import * as path from "path";
import { PolymarketService } from "./polymarket.service";
import { resolveTokenId } from "./utils";
import type { PriceSnapshot } from "./types";

interface PriceHistory {
  [conditionId: string]: PriceSnapshot[];
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
 * Returns the collected snapshots + history depth per market.
 */
export async function collectPrices(
  service: PolymarketService,
  conditionIds: string[],
): Promise<{
  collected: { conditionId: string; snapshot: PriceSnapshot }[];
  historyDepth: { [conditionId: string]: number };
  errors: { conditionId: string; error: string }[];
}> {
  const history = loadHistory();
  pruneOldEntries(history);

  const collected: { conditionId: string; snapshot: PriceSnapshot }[] = [];
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
      collected.push({ conditionId, snapshot });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ conditionId, error: message });
    }
  }

  saveHistory(history);

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
