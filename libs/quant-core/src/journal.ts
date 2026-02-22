// ─── Trade Journal (SQLite) ─────────────────────────────────────────────────
// Persistent trade audit trail using Node.js built-in node:sqlite (DatabaseSync).
// Database: $HOME/.openclaw/signals/trades.db (signals-data Docker volume)
// Connection pattern: open → WAL + busy_timeout → execute → close (per invocation)
// No native dependencies — uses Node 22+ built-in SQLite.

import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TradeEntry {
  id?: number;
  timestamp?: string;
  skill: "alpaca" | "polymarket";
  tool: string;
  symbol?: string;
  conditionId?: string;
  side: string;
  amount: number;
  price?: number;
  orderType?: string;
  status: "submitted" | "filled" | "rejected" | "error" | "blocked" | "flagged";
  errorCode?: string;
  outcome?: string;
  pnl?: number;
  equityAtTrade?: number;
  exitPrice?: number;
  exitTimestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface DailySummaryEntry {
  id?: number;
  date: string;
  skill: "alpaca" | "polymarket";
  startingEquity?: number;
  endingEquity?: number;
  tradesCount?: number;
  wins?: number;
  losses?: number;
  grossPnl?: number;
  netPnl?: number;
  maxDrawdown?: number;
  sharpeRatio?: number;
  winRate?: number;
  profitFactor?: number;
  metadata?: Record<string, unknown>;
  updatedAt?: string;
}

export interface JournalQueryOptions {
  skill?: "alpaca" | "polymarket";
  since?: string;
  limit?: number;
  status?: string;
  symbol?: string;
}

export interface EquitySnapshot {
  id?: number;
  timestamp?: string;
  skill: string;
  equity: number;
  cash?: number;
  positionsValue?: number;
  metadata?: Record<string, unknown>;
}

export interface ToolCallEntry {
  id?: number;
  timestamp?: string;
  skill: string;
  tool: string;
  params?: Record<string, unknown>;
  resultSummary?: string;
  latencyMs?: number;
  status: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  skill           TEXT NOT NULL CHECK(skill IN ('alpaca','polymarket')),
  tool            TEXT NOT NULL,
  symbol          TEXT,
  condition_id    TEXT,
  side            TEXT NOT NULL,
  amount          REAL NOT NULL,
  price           REAL,
  order_type      TEXT,
  status          TEXT NOT NULL,
  error_code      TEXT,
  outcome         TEXT DEFAULT 'pending',
  pnl             REAL,
  equity_at_trade REAL,
  metadata        TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_trades_skill_ts ON trades(skill, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

CREATE TABLE IF NOT EXISTS daily_summary (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  skill           TEXT NOT NULL,
  starting_equity REAL,
  ending_equity   REAL,
  trades_count    INTEGER DEFAULT 0,
  wins            INTEGER DEFAULT 0,
  losses          INTEGER DEFAULT 0,
  gross_pnl       REAL DEFAULT 0,
  net_pnl         REAL DEFAULT 0,
  max_drawdown    REAL,
  metadata        TEXT DEFAULT '{}',
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(date, skill)
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  skill           TEXT NOT NULL,
  equity          REAL NOT NULL,
  cash            REAL,
  positions_value REAL,
  metadata        TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_equity_skill_ts ON equity_snapshots(skill, timestamp);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  skill           TEXT NOT NULL,
  tool            TEXT NOT NULL,
  params          TEXT DEFAULT '{}',
  result_summary  TEXT,
  latency_ms      INTEGER,
  status          TEXT NOT NULL DEFAULT 'ok',
  error           TEXT,
  metadata        TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_skill_ts ON tool_calls(skill, timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool);

CREATE TABLE IF NOT EXISTS signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  signal_type TEXT NOT NULL CHECK(signal_type IN ('regime','rankings','rebalance','meta')),
  payload     TEXT NOT NULL,
  UNIQUE(run_id, signal_type)
);
CREATE INDEX IF NOT EXISTS idx_signals_type_ts ON signals(signal_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_run_id ON signals(run_id);

CREATE TABLE IF NOT EXISTS risk_alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  alert_type  TEXT NOT NULL CHECK(alert_type IN ('stop_loss','daily_loss','drawdown','ws_disconnect','manual')),
  severity    TEXT NOT NULL CHECK(severity IN ('warning','critical','block')),
  symbol      TEXT,
  message     TEXT NOT NULL,
  details     TEXT DEFAULT '{}',
  resolved    INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  resolved_by TEXT,
  expires_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_active ON risk_alerts(resolved, severity, timestamp);
CREATE INDEX IF NOT EXISTS idx_risk_alerts_symbol ON risk_alerts(symbol);
`;

// ─── Migrations ─────────────────────────────────────────────────────────────
// Detect existing columns via PRAGMA table_info before ALTER TABLE ADD COLUMN
// (SQLite has no ADD COLUMN IF NOT EXISTS).

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some(r => r.name === column);
}

function runMigrations(db: DatabaseSync): void {
  // trades: add exit_price, exit_timestamp
  if (!hasColumn(db, "trades", "exit_price")) {
    db.exec("ALTER TABLE trades ADD COLUMN exit_price REAL");
  }
  if (!hasColumn(db, "trades", "exit_timestamp")) {
    db.exec("ALTER TABLE trades ADD COLUMN exit_timestamp TEXT");
  }

  // daily_summary: add sharpe_ratio, win_rate, profit_factor
  if (!hasColumn(db, "daily_summary", "sharpe_ratio")) {
    db.exec("ALTER TABLE daily_summary ADD COLUMN sharpe_ratio REAL");
  }
  if (!hasColumn(db, "daily_summary", "win_rate")) {
    db.exec("ALTER TABLE daily_summary ADD COLUMN win_rate REAL");
  }
  if (!hasColumn(db, "daily_summary", "profit_factor")) {
    db.exec("ALTER TABLE daily_summary ADD COLUMN profit_factor REAL");
  }
}

// ─── Connection ─────────────────────────────────────────────────────────────

function getDefaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/home/node";
  const dir = path.join(home, ".openclaw", "signals");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "trades.db");
}

// ─── Connection Pool ────────────────────────────────────────────────────────
// Cache one DatabaseSync per dbPath. Reuse across function calls.
// Only close on process exit. Custom dbPath (tests) bypasses the pool.

const dbPool = new Map<string, DatabaseSync>();

export function getDb(dbPath?: string): { db: DatabaseSync; pooled: boolean } {
  // Custom path = no pooling (tests pass custom paths)
  if (dbPath) {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 30000");
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    return { db, pooled: false };
  }

  const defaultPath = getDefaultDbPath();
  let db = dbPool.get(defaultPath);
  if (!db) {
    db = new DatabaseSync(defaultPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 30000");
    db.exec("PRAGMA wal_autocheckpoint = 10000");
    db.exec(SCHEMA_SQL);
    runMigrations(db);
    dbPool.set(defaultPath, db);
  }
  return { db, pooled: true };
}

// Clean up on process exit
process.on("exit", () => {
  for (const db of dbPool.values()) {
    try { db.close(); } catch { /* ignore */ }
  }
});

/** @deprecated Use getDb() instead. Kept for backward compatibility. */
export function openDb(dbPath?: string): DatabaseSync {
  const { db } = getDb(dbPath);
  return db;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a trade decision to the journal. Returns the row ID.
 */
export function recordTrade(entry: TradeEntry, dbPath?: string): number {
  const { db, pooled } = getDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT INTO trades (skill, tool, symbol, condition_id, side, amount, price, order_type, status, error_code, outcome, pnl, equity_at_trade, metadata)
      VALUES (:skill, :tool, :symbol, :conditionId, :side, :amount, :price, :orderType, :status, :errorCode, :outcome, :pnl, :equityAtTrade, :metadata)
    `);

    const result = stmt.run({
      skill: entry.skill,
      tool: entry.tool,
      symbol: entry.symbol || null,
      conditionId: entry.conditionId || null,
      side: entry.side,
      amount: entry.amount,
      price: entry.price ?? null,
      orderType: entry.orderType || null,
      status: entry.status,
      errorCode: entry.errorCode || null,
      outcome: entry.outcome || "pending",
      pnl: entry.pnl ?? null,
      equityAtTrade: entry.equityAtTrade ?? null,
      metadata: JSON.stringify(entry.metadata || {}),
    });

    return Number(result.lastInsertRowid);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Upsert a daily summary row (INSERT OR REPLACE on date+skill).
 */
export function upsertDailySummary(entry: DailySummaryEntry, dbPath?: string): void {
  const { db, pooled } = getDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT INTO daily_summary (date, skill, starting_equity, ending_equity, trades_count, wins, losses, gross_pnl, net_pnl, max_drawdown, metadata)
      VALUES (:date, :skill, :startingEquity, :endingEquity, :tradesCount, :wins, :losses, :grossPnl, :netPnl, :maxDrawdown, :metadata)
      ON CONFLICT(date, skill) DO UPDATE SET
        ending_equity = :endingEquity,
        trades_count = :tradesCount,
        wins = :wins,
        losses = :losses,
        gross_pnl = :grossPnl,
        net_pnl = :netPnl,
        max_drawdown = :maxDrawdown,
        metadata = :metadata,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `);

    stmt.run({
      date: entry.date,
      skill: entry.skill,
      startingEquity: entry.startingEquity ?? null,
      endingEquity: entry.endingEquity ?? null,
      tradesCount: entry.tradesCount ?? 0,
      wins: entry.wins ?? 0,
      losses: entry.losses ?? 0,
      grossPnl: entry.grossPnl ?? 0,
      netPnl: entry.netPnl ?? 0,
      maxDrawdown: entry.maxDrawdown ?? null,
      metadata: JSON.stringify(entry.metadata || {}),
    });
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Query trade entries with optional filters.
 */
export function queryTrades(opts?: JournalQueryOptions, dbPath?: string): TradeEntry[] {
  const { db, pooled } = getDb(dbPath);
  try {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (opts?.skill) {
      conditions.push("skill = :skill");
      params.skill = opts.skill;
    }
    if (opts?.since) {
      conditions.push("timestamp >= :since");
      params.since = opts.since;
    }
    if (opts?.status) {
      conditions.push("status = :status");
      params.status = opts.status;
    }
    if (opts?.symbol) {
      conditions.push("symbol = :symbol");
      params.symbol = opts.symbol;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const limit = opts?.limit || 50;

    const rows = db.prepare(
      `SELECT * FROM trades ${whereClause} ORDER BY timestamp DESC LIMIT :limit`,
    ).all({ ...params, limit }) as Record<string, unknown>[];

    return rows.map(mapTradeRow);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Get daily summary for a given date, optionally filtered by skill.
 */
export function getDailySummary(date: string, skill?: string, dbPath?: string): DailySummaryEntry[] {
  const { db, pooled } = getDb(dbPath);
  try {
    const conditions = ["date = :date"];
    const params: Record<string, string> = { date };

    if (skill) {
      conditions.push("skill = :skill");
      params.skill = skill;
    }

    const rows = db.prepare(
      `SELECT * FROM daily_summary WHERE ${conditions.join(" AND ")} ORDER BY skill`,
    ).all(params) as Record<string, unknown>[];

    return rows.map(mapSummaryRow);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Get today's trade count and P&L for a specific skill.
 */
export function getTradesToday(skill: string, dbPath?: string): { count: number; pnl: number } {
  const { db, pooled } = getDb(dbPath);
  try {
    const today = new Date().toISOString().split("T")[0];
    const row = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(pnl), 0) as pnl
      FROM trades
      WHERE skill = :skill AND timestamp >= :today
    `).get({ skill, today: today + "T00:00:00Z" }) as { count: number; pnl: number };

    return { count: row.count, pnl: row.pnl };
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Get today's realized P&L for a specific skill.
 * Sums pnl from trades with exit_price set (closed positions).
 */
export function getRealizedPnlToday(skill: string, dbPath?: string): number {
  const { db, pooled } = getDb(dbPath);
  try {
    const today = new Date().toISOString().split("T")[0];
    const row = db.prepare(`
      SELECT COALESCE(SUM(pnl), 0) as realizedPnl
      FROM trades
      WHERE skill = :skill AND timestamp >= :today AND exit_price IS NOT NULL
    `).get({ skill, today: today + "T00:00:00Z" }) as { realizedPnl: number };
    return row.realizedPnl;
  } finally {
    if (!pooled) db.close();
  }
}

// ─── Equity Snapshots ───────────────────────────────────────────────────────

/**
 * Record an equity snapshot. Deduplicates: skips if last snapshot for this
 * skill was < 5 minutes ago. Returns the row ID (or -1 if deduplicated).
 */
export function recordEquitySnapshot(entry: EquitySnapshot, dbPath?: string): number {
  const { db, pooled } = getDb(dbPath);
  try {
    // Deduplication: skip if last snapshot for this skill was < 5 minutes ago
    const lastRow = db.prepare(
      `SELECT timestamp FROM equity_snapshots WHERE skill = :skill ORDER BY timestamp DESC LIMIT 1`,
    ).get({ skill: entry.skill }) as { timestamp: string } | undefined;

    if (lastRow) {
      const lastTs = new Date(lastRow.timestamp).getTime();
      if (Date.now() - lastTs < 5 * 60 * 1000) {
        return -1;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO equity_snapshots (skill, equity, cash, positions_value, metadata)
      VALUES (:skill, :equity, :cash, :positionsValue, :metadata)
    `);

    const result = stmt.run({
      skill: entry.skill,
      equity: entry.equity,
      cash: entry.cash ?? null,
      positionsValue: entry.positionsValue ?? null,
      metadata: JSON.stringify(entry.metadata || {}),
    });

    return Number(result.lastInsertRowid);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Query equity snapshots for a skill, optionally filtered by time range.
 */
export function getEquitySnapshots(
  skill: string,
  since?: string,
  limit?: number,
  dbPath?: string,
): EquitySnapshot[] {
  const { db, pooled } = getDb(dbPath);
  try {
    const conditions = ["skill = :skill"];
    const params: Record<string, string | number> = { skill };

    if (since) {
      conditions.push("timestamp >= :since");
      params.since = since;
    }

    const maxRows = limit || 500;
    const rows = db.prepare(
      `SELECT * FROM equity_snapshots WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC LIMIT :limit`,
    ).all({ ...params, limit: maxRows }) as Record<string, unknown>[];

    return rows.map(mapEquityRow);
  } finally {
    if (!pooled) db.close();
  }
}

// ─── Tool Call Logging ──────────────────────────────────────────────────────

/**
 * Record a tool call with timing and result summary. Returns the row ID.
 */
export function recordToolCall(entry: ToolCallEntry, dbPath?: string): number {
  const { db, pooled } = getDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT INTO tool_calls (skill, tool, params, result_summary, latency_ms, status, error, metadata)
      VALUES (:skill, :tool, :params, :resultSummary, :latencyMs, :status, :error, :metadata)
    `);

    const result = stmt.run({
      skill: entry.skill,
      tool: entry.tool,
      params: JSON.stringify(entry.params || {}),
      resultSummary: entry.resultSummary || null,
      latencyMs: entry.latencyMs ?? null,
      status: entry.status,
      error: entry.error || null,
      metadata: JSON.stringify(entry.metadata || {}),
    });

    return Number(result.lastInsertRowid);
  } finally {
    if (!pooled) db.close();
  }
}

/**
 * Query tool call log with optional filters.
 */
export function queryToolCalls(
  opts?: { skill?: string; tool?: string; since?: string; status?: string; limit?: number },
  dbPath?: string,
): ToolCallEntry[] {
  const { db, pooled } = getDb(dbPath);
  try {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (opts?.skill) {
      conditions.push("skill = :skill");
      params.skill = opts.skill;
    }
    if (opts?.tool) {
      conditions.push("tool = :tool");
      params.tool = opts.tool;
    }
    if (opts?.since) {
      conditions.push("timestamp >= :since");
      params.since = opts.since;
    }
    if (opts?.status) {
      conditions.push("status = :status");
      params.status = opts.status;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit || 50;

    const rows = db.prepare(
      `SELECT * FROM tool_calls ${whereClause} ORDER BY timestamp DESC LIMIT :limit`,
    ).all({ ...params, limit }) as Record<string, unknown>[];

    return rows.map(mapToolCallRow);
  } finally {
    if (!pooled) db.close();
  }
}

// ─── Trade Exit Tracking ────────────────────────────────────────────────────

/**
 * Update a trade with exit price and realized P&L.
 */
export function updateTradeExit(tradeId: number, exitPrice: number, pnl: number, dbPath?: string): void {
  const { db, pooled } = getDb(dbPath);
  try {
    db.prepare(`
      UPDATE trades SET exit_price = :exitPrice, exit_timestamp = strftime('%Y-%m-%dT%H:%M:%fZ','now'), pnl = :pnl
      WHERE id = :tradeId
    `).run({ tradeId, exitPrice, pnl });
  } finally {
    if (!pooled) db.close();
  }
}

// ─── Row Mappers ────────────────────────────────────────────────────────────

function mapEquityRow(row: Record<string, unknown>): EquitySnapshot {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    skill: row.skill as string,
    equity: row.equity as number,
    cash: (row.cash as number | null) ?? undefined,
    positionsValue: (row.positions_value as number | null) ?? undefined,
    metadata: safeJsonParse(row.metadata as string),
  };
}

function mapToolCallRow(row: Record<string, unknown>): ToolCallEntry {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    skill: row.skill as string,
    tool: row.tool as string,
    params: safeJsonParse(row.params as string),
    resultSummary: (row.result_summary as string | null) ?? undefined,
    latencyMs: (row.latency_ms as number | null) ?? undefined,
    status: row.status as string,
    error: (row.error as string | null) ?? undefined,
    metadata: safeJsonParse(row.metadata as string),
  };
}

function mapTradeRow(row: Record<string, unknown>): TradeEntry {
  return {
    id: row.id as number,
    timestamp: row.timestamp as string,
    skill: row.skill as "alpaca" | "polymarket",
    tool: row.tool as string,
    symbol: (row.symbol as string | null) ?? undefined,
    conditionId: (row.condition_id as string | null) ?? undefined,
    side: row.side as string,
    amount: row.amount as number,
    price: (row.price as number | null) ?? undefined,
    orderType: (row.order_type as string | null) ?? undefined,
    status: row.status as TradeEntry["status"],
    errorCode: (row.error_code as string | null) ?? undefined,
    outcome: (row.outcome as string | null) ?? undefined,
    pnl: (row.pnl as number | null) ?? undefined,
    equityAtTrade: (row.equity_at_trade as number | null) ?? undefined,
    exitPrice: (row.exit_price as number | null) ?? undefined,
    exitTimestamp: (row.exit_timestamp as string | null) ?? undefined,
    metadata: safeJsonParse(row.metadata as string),
  };
}

function mapSummaryRow(row: Record<string, unknown>): DailySummaryEntry {
  return {
    id: row.id as number,
    date: row.date as string,
    skill: row.skill as "alpaca" | "polymarket",
    startingEquity: (row.starting_equity as number | null) ?? undefined,
    endingEquity: (row.ending_equity as number | null) ?? undefined,
    tradesCount: row.trades_count as number,
    wins: row.wins as number,
    losses: row.losses as number,
    grossPnl: row.gross_pnl as number,
    netPnl: row.net_pnl as number,
    maxDrawdown: (row.max_drawdown as number | null) ?? undefined,
    sharpeRatio: (row.sharpe_ratio as number | null) ?? undefined,
    winRate: (row.win_rate as number | null) ?? undefined,
    profitFactor: (row.profit_factor as number | null) ?? undefined,
    metadata: safeJsonParse(row.metadata as string),
    updatedAt: row.updated_at as string,
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
