// ─── Health Pinger ───────────────────────────────────────────────────────────

import * as path from "path";
import * as fs from "fs";

const LOG_PREFIX = "[health]";

export interface CopycatHealthStatus {
  lastPing: string;
  polygonConnected: boolean;
  trackedWallet: string;
  openPositions: number;
  uptimeSeconds: number;
  copiesToday: number;
}

export class HealthPinger {
  private readonly filePath: string;
  private readonly startTime = Date.now();
  private copiesToday = 0;

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/home/node";
    const dir = path.join(home, ".openclaw", "signals");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, "copycat-wallet-meta.json");
  }

  incrementCopies(): void { this.copiesToday++; }
  resetDailyCopies(): void { this.copiesToday = 0; }

  ping(
    polygonConnected: boolean,
    trackedWallet: string,
    openPositions: number,
  ): void {
    const status: CopycatHealthStatus = {
      lastPing: new Date().toISOString(),
      polygonConnected,
      trackedWallet,
      openPositions,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
      copiesToday: this.copiesToday,
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
