// ─── Health Ping ─────────────────────────────────────────────────────────────
// Writes risk-monitor-meta.json for Docker health checks.

import * as fs from "fs";
import * as path from "path";
import { getActiveAlerts } from "quant-core";
import type { HealthStatus } from "./types";

const LOG_PREFIX = "[health]";

export class HealthPinger {
  private readonly filePath: string;
  private readonly startTime = Date.now();

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/home/node";
    const dir = path.join(home, ".openclaw", "signals");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, "risk-monitor-meta.json");
  }

  ping(
    tradingWsConnected: boolean,
    dataWsConnected: boolean,
    positionsTracked: number,
  ): void {
    let activeAlertCount = 0;
    try {
      activeAlertCount = getActiveAlerts().length;
    } catch { /* non-fatal */ }

    const status: HealthStatus = {
      lastPing: new Date().toISOString(),
      tradingWsConnected,
      dataWsConnected,
      positionsTracked,
      activeAlerts: activeAlertCount,
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
    };

    // Atomic write: tmp + rename
    const tmpPath = this.filePath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(status, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to write health file:`, err instanceof Error ? err.message : String(err));
      // Clean up tmp file on failure
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
