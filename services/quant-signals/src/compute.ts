import * as fs from "fs";
import * as path from "path";
import type {
  AlpacaDataConfig,
  RegimeResult,
  RankingsSignal,
  RebalanceSignal,
  SignalMeta,
} from "./types";
import { SECTOR_UNIVERSE } from "./helpers";
import { validateBars } from "quant-core";
import { AlpacaDataClient } from "./alpaca-client";
import { calculateRegime } from "./regime";
import { rankSectorMomentum } from "./ranking";
import { generateRebalanceActions } from "./rebalance";
import { writeSignals } from "quant-core";

const SIGNALS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/home/node",
  ".openclaw",
  "signals",
);

function ensureSignalsDir(): void {
  if (!fs.existsSync(SIGNALS_DIR)) {
    fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  }
}

function writeSignal(filename: string, data: unknown): void {
  const finalPath = path.join(SIGNALS_DIR, filename);
  const tmpPath = finalPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, finalPath);
}

export async function computeAll(): Promise<void> {
  const startMs = Date.now();
  const errors: string[] = [];

  ensureSignalsDir();

  // Build config from env
  const config: AlpacaDataConfig = {
    apiKeyId: process.env.APCA_API_KEY_ID || "",
    apiSecretKey: process.env.APCA_API_SECRET_KEY || "",
    tradingBaseUrl: process.env.APCA_API_BASE_URL || "https://paper-api.alpaca.markets",
    dataBaseUrl: "https://data.alpaca.markets",
  };

  if (!config.apiKeyId || !config.apiSecretKey) {
    const msg = "Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY";
    console.error(`[quant-signals] ${msg}`);
    writeSignal("meta.json", {
      lastRun: new Date().toISOString(),
      nextRun: "",
      status: "error",
      errors: [msg],
      durationMs: Date.now() - startMs,
    } satisfies SignalMeta);
    return;
  }

  const client = new AlpacaDataClient(config);
  const allSymbols = ["SPY", ...SECTOR_UNIVERSE];

  try {
    // Fetch bars + positions in parallel
    console.log(`[quant-signals] Fetching bars for ${allSymbols.length} symbols + positions...`);
    const [multiBars, positions] = await Promise.all([
      client.getMultiBars(allSymbols, "1Day", 200),
      client.getPositions(),
    ]);

    // Validate bars — filter out NaN/zero-close/zero-volume
    for (const sym of allSymbols) {
      if (multiBars[sym]) {
        multiBars[sym] = validateBars(multiBars[sym], sym);
      }
    }

    const spyBars = multiBars["SPY"] || [];
    if (spyBars.length < 200) {
      throw new Error(`Need 200+ SPY bars for SMA200, got ${spyBars.length}`);
    }

    // Build sectorBars (excluding SPY)
    const sectorBars: Record<string, import("./types").PriceBar[]> = {};
    for (const sym of SECTOR_UNIVERSE) {
      if (multiBars[sym]) sectorBars[sym] = multiBars[sym];
    }

    // Current sector holdings
    const sectorSet = new Set(SECTOR_UNIVERSE);
    const currentHoldings = positions
      .filter((p) => sectorSet.has(p.symbol))
      .map((p) => p.symbol);

    // 1. Regime detection
    console.log("[quant-signals] Computing regime...");
    const regime: RegimeResult = calculateRegime(spyBars, sectorBars);
    writeSignal("regime.json", regime);

    // 2. Momentum ranking
    console.log("[quant-signals] Computing rankings...");
    const rankings = rankSectorMomentum(multiBars, SECTOR_UNIVERSE);

    // Filter out sectors with invalid values (-Infinity, NaN)
    const validRankings = rankings.filter(r => {
      if (!isFinite(r.momentum20d) || !isFinite(r.latestClose)) {
        console.warn(`[quant-signals] Dropped ${r.symbol}: invalid momentum/price values`);
        return false;
      }
      if (r.volatilityAdjustedScore !== undefined && !isFinite(r.volatilityAdjustedScore)) {
        console.warn(`[quant-signals] Dropped ${r.symbol}: non-finite volatilityAdjustedScore`);
        return false;
      }
      return true;
    });

    if (validRankings.length < 3) {
      throw new Error(`Only ${validRankings.length} valid sector rankings (need ≥3). Check bar data quality.`);
    }

    const rankingsSignal: RankingsSignal = {
      rankings: validRankings,
      top3: validRankings.slice(0, 3).map((r) => r.symbol),
      top5: validRankings.slice(0, 5).map((r) => r.symbol),
    };
    writeSignal("rankings.json", rankingsSignal);

    // 3. Rebalance actions
    console.log("[quant-signals] Computing rebalance actions...");
    const rebalanceActions = generateRebalanceActions(regime, validRankings, currentHoldings, multiBars);
    const rebalanceSignal: RebalanceSignal = {
      actions: rebalanceActions,
      currentHoldings,
    };
    writeSignal("rebalance.json", rebalanceSignal);

    // 4. Meta
    const durationMs = Date.now() - startMs;
    console.log(`[quant-signals] Done in ${durationMs}ms. Regime: ${regime.compositeRegime ?? regime.regime}, top3: ${rankingsSignal.top3.join(",")}`);

    const meta: SignalMeta = {
      lastRun: new Date().toISOString(),
      nextRun: "",  // filled by cron scheduler
      status: "ok",
      errors,
      durationMs,
    };
    writeSignal("meta.json", meta);

    // 5. Dual-write to SQLite (non-fatal)
    try {
      const runId = writeSignals({ regime, rankings: rankingsSignal, rebalance: rebalanceSignal, meta });
      console.log(`[quant-signals] SQLite write OK (run_id=${runId})`);
    } catch (dbErr) {
      console.error(`[quant-signals] SQLite write failed (non-fatal): ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[quant-signals] Error: ${msg}`);
    errors.push(msg);

    writeSignal("meta.json", {
      lastRun: new Date().toISOString(),
      nextRun: "",
      status: "error",
      errors,
      durationMs: Date.now() - startMs,
    } satisfies SignalMeta);
  }
}
