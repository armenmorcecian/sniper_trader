// ─── Health Pinger ───────────────────────────────────────────────────────────

import * as path from "path";
import * as fs from "fs";
import type { AssetHealthStats, ScalperHealthStatus } from "./types";

const LOG_PREFIX = "[health]";

export class HealthPinger {
  private readonly filePath: string;
  private readonly startTime = Date.now();
  private lastSignalCheck = 0;
  private betsToday = 0;

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/home/node";
    const dir = path.join(home, ".openclaw", "signals");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, "crypto-scalper-meta.json");
  }

  updateSignalCheckTime(): void { this.lastSignalCheck = Date.now(); }
  incrementBets(): void { this.betsToday++; }
  resetDailyBets(): void { this.betsToday = 0; }

  ping(
    binanceConnected: boolean,
    assets: Record<string, AssetHealthStats>,
    openPositions: number,
  ): void {
    const status: ScalperHealthStatus = {
      lastPing: new Date().toISOString(),
      binanceConnected,
      assets,
      openPositions,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
      lastSignalCheck: this.lastSignalCheck,
      betsToday: this.betsToday,
    };

    const tmpPath = this.filePath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to write health file:`, err instanceof Error ? err.message : String(err));
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
