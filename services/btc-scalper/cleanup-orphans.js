#!/usr/bin/env node
// ─── One-time cleanup: close orphaned trades ────────────────────────────────
// Finds all trades with no exit older than 24h and records them as losses.
// Run once: node cleanup-orphans.js
//   or in container: node /app/services/btc-scalper/cleanup-orphans.js

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "/home/node",
  ".openclaw",
  "signals",
  "trades.db",
);

console.log(`Opening database: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);

// Find orphaned trades: no exit price, older than 24h
const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const orphans = db
  .prepare(
    `SELECT id, symbol, side, amount, price, timestamp, metadata
     FROM trades
     WHERE exit_price IS NULL
       AND timestamp < ?
     ORDER BY timestamp ASC`,
  )
  .all(cutoff);

console.log(`Found ${orphans.length} orphaned trade(s) older than 24h:\n`);

if (orphans.length === 0) {
  console.log("Nothing to clean up.");
  process.exit(0);
}

const updateStmt = db.prepare(
  `UPDATE trades SET exit_price = ?, pnl = ?, exit_timestamp = ? WHERE id = ?`,
);

let totalPnl = 0;

for (const trade of orphans) {
  const pnl = -trade.amount;
  totalPnl += pnl;
  const now = new Date().toISOString();

  console.log(
    `  #${trade.id} | ${(trade.symbol || "???").slice(0, 12)}... | ${trade.side} | ` +
    `$${trade.amount.toFixed(2)} @ $${(trade.price || 0).toFixed(3)} | ` +
    `${trade.timestamp} | P&L: -$${trade.amount.toFixed(2)}`,
  );

  updateStmt.run(0, pnl, now, trade.id);
}

console.log(`\nClosed ${orphans.length} orphaned trades. Total P&L: -$${Math.abs(totalPnl).toFixed(2)}`);
console.log("Done.");
