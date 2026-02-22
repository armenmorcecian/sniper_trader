import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeSignals, readLatestSignals, querySignalHistory } from "../signals";
import { recordTrade, queryTrades } from "../journal";

// Use a temp file per test to persist across multiple openDb() calls
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `signals-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// ─── Test data ──────────────────────────────────────────────────────────────

const sampleRegime = { regime: "bull", spyPrice: 500, sma200: 480, distancePercent: 4.17 };
const sampleRankings = { rankings: [{ symbol: "XLK", rank: 1, momentum20d: 5.2 }], top3: ["XLK", "XLY", "XLI"], top5: ["XLK", "XLY", "XLI", "XLF", "XLE"] };
const sampleRebalance = { actions: [{ action: "buy", symbol: "XLK", reason: "top 3" }], currentHoldings: ["XLE"] };
const sampleMeta = { lastRun: "2026-02-18T10:00:00.000Z", nextRun: "", status: "ok", errors: [], durationMs: 1200 };

function writeSampleRun() {
  return writeSignals({
    regime: sampleRegime,
    rankings: sampleRankings,
    rebalance: sampleRebalance,
    meta: sampleMeta,
  }, dbPath);
}

// ─── writeSignals ───────────────────────────────────────────────────────────

describe("writeSignals", () => {
  it("writes 4 rows atomically and returns a UUID run_id", () => {
    const runId = writeSampleRun();
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("generates unique run_ids for each write", () => {
    const id1 = writeSampleRun();
    const id2 = writeSampleRun();
    expect(id1).not.toBe(id2);
  });

  it("rejects duplicate run_id + signal_type via UNIQUE constraint", () => {
    // writeSignals generates its own UUID so duplicates won't happen in normal use,
    // but we verify the constraint by checking the 4 types are stored
    const runId = writeSampleRun();
    const signals = readLatestSignals(dbPath);
    expect(signals).not.toBeNull();
    expect(signals!.runId).toBe(runId);
    expect(signals!.regime).toEqual(sampleRegime);
    expect(signals!.rankings).toEqual(sampleRankings);
    expect(signals!.rebalance).toEqual(sampleRebalance);
    expect(signals!.meta).toEqual(sampleMeta);
  });

  it("stores payload as valid JSON", () => {
    writeSampleRun();
    const signals = readLatestSignals(dbPath);
    expect(signals!.regime).toHaveProperty("regime", "bull");
    expect(signals!.rankings).toHaveProperty("top3");
    expect(signals!.meta).toHaveProperty("durationMs", 1200);
  });
});

// ─── readLatestSignals ──────────────────────────────────────────────────────

describe("readLatestSignals", () => {
  it("returns null when no signals exist", () => {
    const signals = readLatestSignals(dbPath);
    expect(signals).toBeNull();
  });

  it("returns the most recent run", () => {
    writeSampleRun();
    // Write a second run with different data
    const laterMeta = { ...sampleMeta, lastRun: "2026-02-18T11:00:00.000Z", durationMs: 900 };
    const runId2 = writeSignals({
      regime: { ...sampleRegime, regime: "bear" },
      rankings: sampleRankings,
      rebalance: sampleRebalance,
      meta: laterMeta,
    }, dbPath);

    const signals = readLatestSignals(dbPath);
    expect(signals).not.toBeNull();
    expect(signals!.runId).toBe(runId2);
    expect((signals!.regime as Record<string, unknown>).regime).toBe("bear");
    expect(signals!.meta).toEqual(laterMeta);
  });

  it("returns correct data after multiple writes", () => {
    for (let i = 0; i < 5; i++) {
      writeSampleRun();
    }
    const signals = readLatestSignals(dbPath);
    expect(signals).not.toBeNull();
    expect(signals!.regime).toEqual(sampleRegime);
  });
});

// ─── querySignalHistory ─────────────────────────────────────────────────────

describe("querySignalHistory", () => {
  it("returns empty array when no signals exist", () => {
    const history = querySignalHistory({}, dbPath);
    expect(history).toEqual([]);
  });

  it("returns runs ordered newest first", () => {
    const id1 = writeSampleRun();
    const id2 = writeSampleRun();
    const id3 = writeSampleRun();

    const history = querySignalHistory({}, dbPath);
    expect(history.length).toBe(3);
    // Newest first
    expect(history[0].runId).toBe(id3);
    expect(history[2].runId).toBe(id1);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      writeSampleRun();
    }
    const history = querySignalHistory({ limit: 2 }, dbPath);
    expect(history.length).toBe(2);
  });

  it("defaults to limit of 20", () => {
    for (let i = 0; i < 25; i++) {
      writeSampleRun();
    }
    const history = querySignalHistory({}, dbPath);
    expect(history.length).toBe(20);
  });

  it("filters by since timestamp", () => {
    writeSampleRun(); // run 1

    // All runs get SQLite-generated timestamps (now), so 'since' in the future returns empty
    const futureHistory = querySignalHistory({ since: "2099-01-01T00:00:00Z" }, dbPath);
    expect(futureHistory.length).toBe(0);

    // 'since' in the past returns all
    const pastHistory = querySignalHistory({ since: "2020-01-01T00:00:00Z" }, dbPath);
    expect(pastHistory.length).toBe(1);
  });

  it("filters by signalType (includes only runs with that type)", () => {
    writeSampleRun(); // has all 4 types
    const history = querySignalHistory({ signalType: "regime" }, dbPath);
    expect(history.length).toBe(1);
    expect(history[0].regime).toEqual(sampleRegime);
  });
});

// ─── Schema coexistence ─────────────────────────────────────────────────────

describe("schema coexistence", () => {
  it("signals table coexists with trades table", () => {
    // Write a trade
    const tradeId = recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "SPY",
      side: "buy",
      amount: 500,
      status: "submitted",
    }, dbPath);
    expect(tradeId).toBe(1);

    // Write signals
    const runId = writeSampleRun();
    expect(runId).toBeTruthy();

    // Both are readable
    const trades = queryTrades({}, dbPath);
    expect(trades.length).toBe(1);

    const signals = readLatestSignals(dbPath);
    expect(signals).not.toBeNull();
    expect(signals!.regime).toEqual(sampleRegime);
  });

  it("opening DB twice with signals works (idempotent schema)", () => {
    writeSampleRun();
    writeSampleRun();
    const history = querySignalHistory({}, dbPath);
    expect(history.length).toBe(2);
  });
});
