// ─── Signal Storage (SQLite) ────────────────────────────────────────────────
// Persists quant signal runs (regime, rankings, rebalance, meta) to SQLite.
// Each run gets a UUID run_id grouping the 4 signal types.
// Uses the same trades.db as journal.ts (shared schema via openDb).

import * as crypto from "crypto";
import { getDb } from "./journal";
import type { SignalRun, SignalHistoryOptions } from "./types";

/**
 * Write a complete signal run (regime + rankings + rebalance + meta) atomically.
 * Returns the generated run_id (UUID).
 */
export function writeSignals(
  signals: {
    regime: unknown;
    rankings: unknown;
    rebalance: unknown;
    meta: unknown;
  },
  dbPath?: string,
): string {
  const { db, pooled } = getDb(dbPath);
  try {
    const runId = crypto.randomUUID();
    const stmt = db.prepare(
      `INSERT INTO signals (run_id, signal_type, payload) VALUES (:runId, :signalType, :payload)`,
    );

    db.exec("BEGIN");
    try {
      for (const signalType of ["regime", "rankings", "rebalance", "meta"] as const) {
        stmt.run({
          runId,
          signalType,
          payload: JSON.stringify(signals[signalType]),
        });
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return runId;
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Read the most recent complete signal run.
 * Returns null if no signals exist.
 */
export function readLatestSignals(dbPath?: string): SignalRun | null {
  const { db, pooled } = getDb(dbPath);
  try {
    // Find the most recent run_id by the meta row's timestamp
    const latest = db.prepare(
      `SELECT run_id, timestamp FROM signals WHERE signal_type = 'meta' ORDER BY timestamp DESC LIMIT 1`,
    ).get() as { run_id: string; timestamp: string } | undefined;

    if (!latest) return null;

    const rows = db.prepare(
      `SELECT signal_type, payload FROM signals WHERE run_id = :runId`,
    ).all({ runId: latest.run_id }) as { signal_type: string; payload: string }[];

    const byType: Record<string, unknown> = {};
    for (const row of rows) {
      byType[row.signal_type] = JSON.parse(row.payload);
    }

    return {
      runId: latest.run_id,
      timestamp: latest.timestamp,
      regime: (byType.regime as SignalRun["regime"]) ?? null,
      rankings: (byType.rankings as SignalRun["rankings"]) ?? null,
      rebalance: (byType.rebalance as SignalRun["rebalance"]) ?? null,
      meta: (byType.meta as SignalRun["meta"]) ?? null,
    };
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Query signal history. Returns completed runs, newest first.
 * Supports since (ISO timestamp), limit (default 20), signalType filter.
 */
export function querySignalHistory(
  opts?: SignalHistoryOptions,
  dbPath?: string,
): SignalRun[] {
  const { db, pooled } = getDb(dbPath);
  try {
    const limit = opts?.limit ?? 20;

    // Find distinct run_ids from meta rows (each complete run has a meta entry)
    const conditions: string[] = ["signal_type = 'meta'"];
    const params: Record<string, string | number> = { limit };

    if (opts?.since) {
      conditions.push("timestamp >= :since");
      params.since = opts.since;
    }

    const runRows = db.prepare(
      `SELECT run_id, timestamp FROM signals WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT :limit`,
    ).all(params) as { run_id: string; timestamp: string }[];

    if (runRows.length === 0) return [];

    // Fetch all signal rows for these run_ids
    const placeholders = runRows.map(() => "?").join(",");
    const runIds = runRows.map(r => r.run_id);
    const allRows = db.prepare(
      `SELECT run_id, signal_type, payload FROM signals WHERE run_id IN (${placeholders})`,
    ).all(...runIds) as { run_id: string; signal_type: string; payload: string }[];

    // Group by run_id
    const grouped = new Map<string, Record<string, unknown>>();
    for (const row of allRows) {
      if (!grouped.has(row.run_id)) grouped.set(row.run_id, {});
      grouped.get(row.run_id)![row.signal_type] = JSON.parse(row.payload);
    }

    // Assemble SignalRun objects in order
    const results: SignalRun[] = [];
    for (const runRow of runRows) {
      const byType = grouped.get(runRow.run_id) || {};
      const run: SignalRun = {
        runId: runRow.run_id,
        timestamp: runRow.timestamp,
        regime: (byType.regime as SignalRun["regime"]) ?? null,
        rankings: (byType.rankings as SignalRun["rankings"]) ?? null,
        rebalance: (byType.rebalance as SignalRun["rebalance"]) ?? null,
        meta: (byType.meta as SignalRun["meta"]) ?? null,
      };

      // If signalType filter is set, only include runs that have that type
      if (opts?.signalType && byType[opts.signalType] === undefined) continue;

      results.push(run);
    }

    return results;
  } finally {
    if (!pooled) db.close();
  }
}
