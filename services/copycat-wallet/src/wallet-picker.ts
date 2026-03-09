// ─── Wallet Picker ──────────────────────────────────────────────────────────
// Fetches top wallets from all 4 Polymarket leaderboard time periods,
// deduplicates, and scores by how many categories each wallet appears in.

import axios from "axios";
import type { CopycatConfig } from "./config";
import type { WalletScore, TimePeriod } from "./types";

const LOG_PREFIX = "[wallet-picker]";
const LEADERBOARD_URL = "https://data-api.polymarket.com/v1/leaderboard";
const TIME_PERIODS: TimePeriod[] = ["DAY", "WEEK", "MONTH", "ALL"];

interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string;
  vol: number;
  pnl: number;
}

async function fetchLeaderboard(period: TimePeriod, limit: number): Promise<LeaderboardEntry[]> {
  try {
    const resp = await axios.get(LEADERBOARD_URL, {
      params: { orderBy: "PNL", timePeriod: period, limit },
      timeout: 15_000,
    });
    const data: LeaderboardEntry[] = Array.isArray(resp.data) ? resp.data : [];
    return data.filter((e) => e.proxyWallet);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to fetch ${period} leaderboard:`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function pickWallets(config: CopycatConfig): Promise<Map<string, WalletScore>> {
  // Seed wallet override — return just that wallet as tier 4
  if (config.seedWallet) {
    console.log(`${LOG_PREFIX} Using seed wallet: ${config.seedWallet}`);
    const map = new Map<string, WalletScore>();
    map.set(config.seedWallet.toLowerCase(), {
      proxyWallet: config.seedWallet,
      userName: "manual",
      categories: ["DAY", "WEEK", "MONTH", "ALL"],
      tier: 4,
      bestPnl: 0,
      vol: 0,
    });
    return map;
  }

  console.log(`${LOG_PREFIX} Fetching leaderboards (${config.walletCount} per category)...`);

  // Fetch all 4 leaderboards in parallel
  const results = await Promise.all(
    TIME_PERIODS.map((period) => fetchLeaderboard(period, config.walletCount)),
  );

  // Build deduplicated wallet score map
  const scoreMap = new Map<string, WalletScore>();

  for (let i = 0; i < TIME_PERIODS.length; i++) {
    const period = TIME_PERIODS[i];
    const entries = results[i];

    for (const entry of entries) {
      const key = entry.proxyWallet.toLowerCase();
      const existing = scoreMap.get(key);

      if (existing) {
        // Already seen — add this category
        if (!existing.categories.includes(period)) {
          existing.categories.push(period);
          existing.tier = existing.categories.length;
        }
        if (entry.pnl > existing.bestPnl) existing.bestPnl = entry.pnl;
        if (entry.vol > existing.vol) existing.vol = entry.vol;
      } else {
        scoreMap.set(key, {
          proxyWallet: entry.proxyWallet,
          userName: entry.userName || key.slice(0, 10),
          categories: [period],
          tier: 1,
          bestPnl: entry.pnl,
          vol: entry.vol,
        });
      }
    }
  }

  // Filter out vol === 0 (unrealized PnL, no recent trades)
  for (const [key, score] of scoreMap) {
    if (score.vol <= 0) {
      scoreMap.delete(key);
    }
  }

  // Log tier breakdown
  const tierCounts = [0, 0, 0, 0, 0]; // index 1-4
  for (const score of scoreMap.values()) {
    tierCounts[score.tier]++;
  }

  console.log(
    `${LOG_PREFIX} Picked ${scoreMap.size} wallets: ` +
    `${tierCounts[4]} tier-4, ${tierCounts[3]} tier-3, ${tierCounts[2]} tier-2, ${tierCounts[1]} tier-1`,
  );

  if (scoreMap.size === 0) {
    throw new Error("No wallets found on any leaderboard");
  }

  return scoreMap;
}
