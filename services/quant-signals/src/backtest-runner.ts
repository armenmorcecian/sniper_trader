#!/usr/bin/env npx tsx
// ─── Backtest Runner ────────────────────────────────────────────────────────
// Standalone CLI entry point: fetches historical bars from Alpaca, runs
// backtest through quant-core's sector rotation engine.
//
// Usage: cd ~/.openclaw/workspace/services/quant-signals
//        npx tsx src/backtest-runner.ts

import * as path from "path";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({
  path: path.join(process.env.HOME || process.env.USERPROFILE || "/home/node", ".openclaw", ".env"),
});

import { AlpacaDataClient } from "./alpaca-client";
import { SECTOR_UNIVERSE } from "./helpers";
import { validateBars, runBacktest } from "quant-core";
import type { BacktestConfig } from "quant-core";
import type { AlpacaDataConfig } from "./types";

async function main(): Promise<void> {
  const config: AlpacaDataConfig = {
    apiKeyId: process.env.APCA_API_KEY_ID || "",
    apiSecretKey: process.env.APCA_API_SECRET_KEY || "",
    tradingBaseUrl: process.env.APCA_API_BASE_URL || "https://paper-api.alpaca.markets",
    dataBaseUrl: "https://data.alpaca.markets",
  };

  if (!config.apiKeyId || !config.apiSecretKey) {
    console.error("Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY");
    process.exit(1);
  }

  const client = new AlpacaDataClient(config);
  const allSymbols = ["SPY", ...SECTOR_UNIVERSE];

  console.log(`[backtest] Fetching 500 daily bars for ${allSymbols.length} symbols...`);
  const multiBars = await client.getMultiBars(allSymbols, "1Day", 500);

  // Validate bars
  for (const sym of allSymbols) {
    if (multiBars[sym]) {
      multiBars[sym] = validateBars(multiBars[sym], sym);
    }
  }

  const spyCount = multiBars["SPY"]?.length ?? 0;
  console.log(`[backtest] SPY bars: ${spyCount}`);

  if (spyCount < 201) {
    console.error(`[backtest] Need 201+ SPY bars, got ${spyCount}`);
    process.exit(1);
  }

  const backtestConfig: BacktestConfig = {
    startingCapital: 10000,
    rebalanceFrequency: 5,
    positionCount: 3,
    stopLossPercent: -7,
    commissionPerTrade: 0,
  };

  console.log("[backtest] Running backtest...");
  const result = runBacktest(multiBars, backtestConfig);

  // Print summary (omit full equity curve for brevity)
  const summary = {
    ...result,
    equityCurve: `[${result.equityCurve.length} points — first: ${result.equityCurve[0]?.equity}, last: ${result.equityCurve[result.equityCurve.length - 1]?.equity}]`,
    rebalanceLog: `[${result.rebalanceLog.length} rebalances]`,
  };

  console.log("\n" + JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[backtest] Fatal:", err.message || err);
  process.exit(1);
});
