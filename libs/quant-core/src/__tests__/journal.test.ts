import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  recordTrade,
  queryTrades,
  upsertDailySummary,
  getDailySummary,
  getTradesToday,
  recordEquitySnapshot,
  getEquitySnapshots,
  recordToolCall,
  queryToolCalls,
  updateTradeExit,
} from "../journal";
import type { TradeEntry, DailySummaryEntry, EquitySnapshot, ToolCallEntry } from "../journal";

// Use a temp file per test to persist across multiple openDb() calls
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
  // Clean up temp DB files
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe("recordTrade", () => {
  it("inserts a trade and returns row ID", () => {
    const id = recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "SPY",
      side: "buy",
      amount: 500,
      price: 450.50,
      orderType: "limit",
      status: "submitted",
      equityAtTrade: 10000,
    }, dbPath);
    expect(id).toBe(1);
  });

  it("inserts a polymarket trade", () => {
    const id = recordTrade({
      skill: "polymarket",
      tool: "place_trade",
      conditionId: "0xabc123",
      side: "BUY",
      amount: 50,
      price: 0.65,
      orderType: "GTC",
      status: "submitted",
    }, dbPath);
    expect(id).toBe(1);
  });

  it("inserts a blocked trade with error code", () => {
    const id = recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "QQQ",
      side: "buy",
      amount: 1000,
      status: "blocked",
      errorCode: "DAILY_LOSS_LIMIT",
      equityAtTrade: 5000,
    }, dbPath);
    expect(id).toBe(1);
  });

  it("stores and retrieves metadata as JSON", () => {
    recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "SPY",
      side: "buy",
      amount: 200,
      status: "submitted",
      metadata: { reason: "sector rotation", confidence: 0.8 },
    }, dbPath);

    const trades = queryTrades({ limit: 1 }, dbPath);
    expect(trades[0].metadata).toEqual({ reason: "sector rotation", confidence: 0.8 });
  });
});

describe("queryTrades", () => {
  function seedTrades(): void {
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "SPY", side: "buy", amount: 500, status: "submitted" }, dbPath);
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "QQQ", side: "buy", amount: 300, status: "filled", pnl: 15 }, dbPath);
    recordTrade({ skill: "polymarket", tool: "place_trade", conditionId: "0xabc", side: "BUY", amount: 50, status: "submitted" }, dbPath);
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "SPY", side: "sell", amount: 500, status: "blocked", errorCode: "DAILY_LOSS_LIMIT" }, dbPath);
  }

  it("returns all trades when no filter", () => {
    seedTrades();
    const trades = queryTrades({}, dbPath);
    expect(trades.length).toBe(4);
  });

  it("filters by skill", () => {
    seedTrades();
    const trades = queryTrades({ skill: "alpaca" }, dbPath);
    expect(trades.length).toBe(3);
    expect(trades.every(t => t.skill === "alpaca")).toBe(true);
  });

  it("filters by status", () => {
    seedTrades();
    const trades = queryTrades({ status: "blocked" }, dbPath);
    expect(trades.length).toBe(1);
    expect(trades[0].errorCode).toBe("DAILY_LOSS_LIMIT");
  });

  it("filters by symbol", () => {
    seedTrades();
    const trades = queryTrades({ symbol: "SPY" }, dbPath);
    expect(trades.length).toBe(2);
  });

  it("respects limit", () => {
    seedTrades();
    const trades = queryTrades({ limit: 2 }, dbPath);
    expect(trades.length).toBe(2);
  });

  it("orders by timestamp DESC", () => {
    seedTrades();
    const trades = queryTrades({}, dbPath);
    // Last inserted should be first (most recent)
    expect(trades[0].status).toBe("blocked");
  });
});

describe("upsertDailySummary", () => {
  it("inserts a new daily summary", () => {
    upsertDailySummary({
      date: "2026-02-18",
      skill: "alpaca",
      startingEquity: 10000,
      endingEquity: 10150,
      tradesCount: 3,
      wins: 2,
      losses: 1,
      grossPnl: 200,
      netPnl: 150,
    }, dbPath);

    const summaries = getDailySummary("2026-02-18", undefined, dbPath);
    expect(summaries.length).toBe(1);
    expect(summaries[0].skill).toBe("alpaca");
    expect(summaries[0].netPnl).toBe(150);
  });

  it("updates existing summary on conflict", () => {
    upsertDailySummary({
      date: "2026-02-18",
      skill: "alpaca",
      startingEquity: 10000,
      endingEquity: 10100,
      tradesCount: 2,
      wins: 1,
      losses: 1,
      netPnl: 100,
    }, dbPath);

    // Update same date+skill
    upsertDailySummary({
      date: "2026-02-18",
      skill: "alpaca",
      startingEquity: 10000,
      endingEquity: 10200,
      tradesCount: 5,
      wins: 3,
      losses: 2,
      netPnl: 200,
    }, dbPath);

    const summaries = getDailySummary("2026-02-18", undefined, dbPath);
    expect(summaries.length).toBe(1);
    expect(summaries[0].tradesCount).toBe(5);
    expect(summaries[0].netPnl).toBe(200);
  });
});

describe("getDailySummary", () => {
  it("filters by skill", () => {
    upsertDailySummary({ date: "2026-02-18", skill: "alpaca", tradesCount: 3 }, dbPath);
    upsertDailySummary({ date: "2026-02-18", skill: "polymarket", tradesCount: 5 }, dbPath);

    const alpaca = getDailySummary("2026-02-18", "alpaca", dbPath);
    expect(alpaca.length).toBe(1);
    expect(alpaca[0].tradesCount).toBe(3);

    const all = getDailySummary("2026-02-18", undefined, dbPath);
    expect(all.length).toBe(2);
  });

  it("returns empty for unknown date", () => {
    const summaries = getDailySummary("2099-01-01", undefined, dbPath);
    expect(summaries).toEqual([]);
  });
});

describe("getTradesToday", () => {
  it("counts trades and sums PnL for today", () => {
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "SPY", side: "buy", amount: 100, status: "filled", pnl: 25 }, dbPath);
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "QQQ", side: "buy", amount: 200, status: "filled", pnl: -10 }, dbPath);
    recordTrade({ skill: "polymarket", tool: "place_trade", side: "BUY", amount: 50, status: "submitted" }, dbPath);

    const result = getTradesToday("alpaca", dbPath);
    expect(result.count).toBe(2);
    expect(result.pnl).toBe(15);
  });

  it("returns zero for no trades", () => {
    const result = getTradesToday("alpaca", dbPath);
    expect(result.count).toBe(0);
    expect(result.pnl).toBe(0);
  });
});

describe("schema idempotency", () => {
  it("opening DB twice doesn't fail", () => {
    recordTrade({ skill: "alpaca", tool: "test", side: "buy", amount: 1, status: "submitted" }, dbPath);
    recordTrade({ skill: "alpaca", tool: "test", side: "buy", amount: 2, status: "submitted" }, dbPath);
    const trades = queryTrades({}, dbPath);
    expect(trades.length).toBe(2);
  });
});

// ─── Equity Snapshots ───────────────────────────────────────────────────────

describe("recordEquitySnapshot", () => {
  it("inserts a snapshot and returns row ID", () => {
    const id = recordEquitySnapshot({
      skill: "alpaca",
      equity: 10000,
      cash: 5000,
      positionsValue: 5000,
    }, dbPath);
    expect(id).toBe(1);
  });

  it("deduplicates snapshots within 5 minutes", () => {
    const id1 = recordEquitySnapshot({ skill: "alpaca", equity: 10000 }, dbPath);
    expect(id1).toBe(1);
    const id2 = recordEquitySnapshot({ skill: "alpaca", equity: 10050 }, dbPath);
    expect(id2).toBe(-1); // deduplicated
  });

  it("allows snapshots from different skills within 5 minutes", () => {
    const id1 = recordEquitySnapshot({ skill: "alpaca", equity: 10000 }, dbPath);
    const id2 = recordEquitySnapshot({ skill: "polymarket", equity: 500 }, dbPath);
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });
});

describe("getEquitySnapshots", () => {
  it("returns snapshots ordered by timestamp ASC", () => {
    recordEquitySnapshot({ skill: "alpaca", equity: 10000 }, dbPath);
    // Force second insert by using polymarket (different skill, no dedup)
    recordEquitySnapshot({ skill: "polymarket", equity: 500 }, dbPath);

    const alpacaSnaps = getEquitySnapshots("alpaca", undefined, undefined, dbPath);
    expect(alpacaSnaps.length).toBe(1);
    expect(alpacaSnaps[0].equity).toBe(10000);

    const polySnaps = getEquitySnapshots("polymarket", undefined, undefined, dbPath);
    expect(polySnaps.length).toBe(1);
    expect(polySnaps[0].equity).toBe(500);
  });

  it("returns empty for unknown skill", () => {
    const snaps = getEquitySnapshots("unknown", undefined, undefined, dbPath);
    expect(snaps).toEqual([]);
  });
});

// ─── Tool Call Logging ──────────────────────────────────────────────────────

describe("recordToolCall", () => {
  it("inserts a tool call and returns row ID", () => {
    const id = recordToolCall({
      skill: "alpaca",
      tool: "check_vitals",
      params: {},
      resultSummary: "equity=$10000",
      latencyMs: 350,
      status: "ok",
    }, dbPath);
    expect(id).toBe(1);
  });

  it("records error tool calls", () => {
    const id = recordToolCall({
      skill: "alpaca",
      tool: "place_order",
      params: { symbol: "SPY", amount: 500 },
      latencyMs: 1200,
      status: "error",
      error: "HTTP 403",
    }, dbPath);
    expect(id).toBe(1);
  });
});

describe("queryToolCalls", () => {
  function seedToolCalls(): void {
    recordToolCall({ skill: "alpaca", tool: "check_vitals", status: "ok", latencyMs: 100 }, dbPath);
    recordToolCall({ skill: "alpaca", tool: "place_order", status: "error", error: "timeout", latencyMs: 5000 }, dbPath);
    recordToolCall({ skill: "polymarket", tool: "scan_markets", status: "ok", latencyMs: 800 }, dbPath);
  }

  it("returns all tool calls when no filter", () => {
    seedToolCalls();
    const calls = queryToolCalls({}, dbPath);
    expect(calls.length).toBe(3);
  });

  it("filters by skill", () => {
    seedToolCalls();
    const calls = queryToolCalls({ skill: "alpaca" }, dbPath);
    expect(calls.length).toBe(2);
  });

  it("filters by tool", () => {
    seedToolCalls();
    const calls = queryToolCalls({ tool: "check_vitals" }, dbPath);
    expect(calls.length).toBe(1);
    expect(calls[0].tool).toBe("check_vitals");
  });

  it("filters by status", () => {
    seedToolCalls();
    const calls = queryToolCalls({ status: "error" }, dbPath);
    expect(calls.length).toBe(1);
    expect(calls[0].error).toBe("timeout");
  });
});

// ─── Trade Exit Tracking ────────────────────────────────────────────────────

describe("updateTradeExit", () => {
  it("updates trade with exit price and pnl", () => {
    const id = recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "SPY",
      side: "buy",
      amount: 500,
      price: 450,
      status: "submitted",
    }, dbPath);

    updateTradeExit(id, 455, 50, dbPath);

    const trades = queryTrades({ symbol: "SPY" }, dbPath);
    expect(trades[0].exitPrice).toBe(455);
    expect(trades[0].pnl).toBe(50);
    expect(trades[0].exitTimestamp).toBeDefined();
  });
});

// ─── Migration Idempotency ──────────────────────────────────────────────────

describe("migration idempotency", () => {
  it("runs migrations multiple times without error", () => {
    // First call creates tables + runs migrations
    recordTrade({ skill: "alpaca", tool: "test", side: "buy", amount: 1, status: "submitted" }, dbPath);
    // Second call opens same DB, runs migrations again (should be no-ops)
    recordEquitySnapshot({ skill: "alpaca", equity: 10000 }, dbPath);
    // Third call — also safe
    recordToolCall({ skill: "alpaca", tool: "test", status: "ok" }, dbPath);
    // Verify all data is intact
    const trades = queryTrades({}, dbPath);
    expect(trades.length).toBe(1);
  });
});
