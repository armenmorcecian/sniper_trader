import * as path from "path";
import dotenv from "dotenv";

// Load local .env first, then fallback to OpenClaw .env
dotenv.config();
dotenv.config({
  path: path.join(process.env.HOME || process.env.USERPROFILE || "/home/node", ".openclaw", ".env"),
});

import cron from "node-cron";
import { computeAll } from "./compute";
import { sendDailyDigest } from "./daily-digest";

const CRON_SCHEDULE = "*/15 9-16 * * 1-5"; // every 15 min, Mon-Fri 9AM-4PM ET

async function main(): Promise<void> {
  console.log("[quant-signals] Starting quant signal service...");
  console.log(`[quant-signals] Cron schedule: ${CRON_SCHEDULE}`);

  // Run once on startup
  console.log("[quant-signals] Running initial computation...");
  await computeAll();

  // Schedule recurring runs
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log(`[quant-signals] Cron triggered at ${new Date().toISOString()}`);
    try {
      await computeAll();
    } catch (err) {
      console.error("[quant-signals] Cron run failed:", err instanceof Error ? err.message : String(err));
    }
  }, {
    timezone: "America/New_York",
  });

  // Daily P&L digest — 5:00 PM ET, Mon-Fri (after market close)
  cron.schedule("0 17 * * 1-5", async () => {
    try {
      await sendDailyDigest();
    } catch (err) {
      console.error("[quant-signals] Digest failed:", err instanceof Error ? err.message : String(err));
    }
  }, {
    timezone: "America/New_York",
  });

  console.log("[quant-signals] Cron scheduled (signals + daily digest). Waiting for next trigger...");
}

main().catch((err) => {
  console.error("[quant-signals] Fatal error:", err);
  process.exit(1);
});
