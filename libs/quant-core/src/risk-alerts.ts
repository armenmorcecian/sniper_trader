// ─── Risk Alerts ─────────────────────────────────────────────────────────────
// Persistent risk alert system for the real-time risk monitor (M4).
// Alerts are stored in the shared trades.db SQLite database.
// Skills check isTradingBlocked() before placing orders.

import { getDb } from "./journal";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RiskAlert {
  id?: number;
  timestamp?: string;
  alertType: "stop_loss" | "daily_loss" | "drawdown" | "ws_disconnect" | "manual";
  severity: "warning" | "critical" | "block";
  symbol?: string;
  message: string;
  details?: Record<string, unknown>;
  resolved?: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  expiresAt?: string;
}

export interface TradingBlockStatus {
  blocked: boolean;
  reasons: string[];
}

export interface ActiveAlertOptions {
  severity?: "warning" | "critical" | "block";
  symbol?: string;
  alertType?: string;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Insert a risk alert. Deduplicates: skips if an identical unresolved alert
 * already exists (same alertType + symbol + severity). Returns the row ID
 * (existing or new).
 */
export function insertRiskAlert(alert: RiskAlert, dbPath?: string): number {
  const { db, pooled } = getDb(dbPath);
  try {
    // Deduplication: check for existing unresolved alert with same key
    const existing = db.prepare(`
      SELECT id FROM risk_alerts
      WHERE alert_type = :alertType AND severity = :severity AND resolved = 0
        AND (symbol IS :symbol OR (symbol IS NULL AND :symbol IS NULL))
      LIMIT 1
    `).get({
      alertType: alert.alertType,
      severity: alert.severity,
      symbol: alert.symbol ?? null,
    }) as { id: number } | undefined;

    if (existing) {
      return existing.id;
    }

    const result = db.prepare(`
      INSERT INTO risk_alerts (alert_type, severity, symbol, message, details, expires_at)
      VALUES (:alertType, :severity, :symbol, :message, :details, :expiresAt)
    `).run({
      alertType: alert.alertType,
      severity: alert.severity,
      symbol: alert.symbol ?? null,
      message: alert.message,
      details: JSON.stringify(alert.details || {}),
      expiresAt: alert.expiresAt ?? null,
    });

    return Number(result.lastInsertRowid);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Query unresolved alerts. Filters by severity, symbol, alertType.
 * Excludes expired alerts.
 */
export function getActiveAlerts(opts?: ActiveAlertOptions, dbPath?: string): RiskAlert[] {
  const { db, pooled } = getDb(dbPath);
  try {
    const conditions = ["resolved = 0"];
    const params: Record<string, string> = {};

    // Exclude expired
    conditions.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))");

    if (opts?.severity) {
      conditions.push("severity = :severity");
      params.severity = opts.severity;
    }
    if (opts?.symbol) {
      conditions.push("symbol = :symbol");
      params.symbol = opts.symbol;
    }
    if (opts?.alertType) {
      conditions.push("alert_type = :alertType");
      params.alertType = opts.alertType;
    }

    const rows = db.prepare(
      `SELECT * FROM risk_alerts WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC`,
    ).all(params) as Record<string, unknown>[];

    return rows.map(mapAlertRow);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Check if trading is blocked. Returns true if any unresolved severity='block'
 * alert exists that hasn't expired.
 */
export function isTradingBlocked(dbPath?: string): TradingBlockStatus {
  const { db, pooled } = getDb(dbPath);
  try {
    const rows = db.prepare(`
      SELECT message FROM risk_alerts
      WHERE resolved = 0 AND severity = 'block'
        AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY timestamp DESC
    `).all() as { message: string }[];

    return {
      blocked: rows.length > 0,
      reasons: rows.map(r => r.message),
    };
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Resolve a single alert by ID.
 */
export function resolveAlert(alertId: number, resolvedBy: string, dbPath?: string): void {
  const { db, pooled } = getDb(dbPath);
  try {
    db.prepare(`
      UPDATE risk_alerts
      SET resolved = 1, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = :resolvedBy
      WHERE id = :alertId
    `).run({ alertId, resolvedBy });
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Resolve all unresolved alerts matching alertType (and optionally symbol).
 * Returns the number of alerts resolved.
 */
export function resolveAlertsByType(
  alertType: string,
  symbol?: string,
  dbPath?: string,
): number {
  const { db, pooled } = getDb(dbPath);
  try {
    const conditions = ["alert_type = :alertType", "resolved = 0"];
    const params: Record<string, string> = { alertType };

    if (symbol) {
      conditions.push("symbol = :symbol");
      params.symbol = symbol;
    }

    const result = db.prepare(
      `UPDATE risk_alerts SET resolved = 1, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = 'auto'
       WHERE ${conditions.join(" AND ")}`,
    ).run(params);

    return Number(result.changes);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Delete expired and resolved alerts older than 24 hours. Returns the count deleted.
 */
export function cleanExpiredAlerts(dbPath?: string): number {
  const { db, pooled } = getDb(dbPath);
  try {
    const result = db.prepare(`
      DELETE FROM risk_alerts
      WHERE resolved = 1
        AND resolved_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `).run();

    return Number(result.changes);
  } finally {
    if (!pooled) db.close();
  }
}

// ─── Row Mapper ─────────────────────────────────────────────────────────────

function mapAlertRow(row: Record<string, unknown>): RiskAlert {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    alertType: row.alert_type as RiskAlert["alertType"],
    severity: row.severity as RiskAlert["severity"],
    symbol: (row.symbol as string | null) ?? undefined,
    message: row.message as string,
    details: safeJsonParse(row.details as string),
    resolved: (row.resolved as number) === 1,
    resolvedAt: (row.resolved_at as string | null) ?? undefined,
    resolvedBy: (row.resolved_by as string | null) ?? undefined,
    expiresAt: (row.expires_at as string | null) ?? undefined,
  };
}

function safeJsonParse(str: string | null | undefined): Record<string, unknown> {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
