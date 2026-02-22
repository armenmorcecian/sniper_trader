import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  computeSharpe,
  computeMaxDrawdown,
  computeProfitFactor,
  getPerformanceMetrics,
} from "../performance";
import { recordTrade, recordEquitySnapshot } from "../journal";

let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `perf-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

// ─── computeSharpe ──────────────────────────────────────────────────────────

describe("computeSharpe", () => {
  it("returns null for fewer than 2 data points", () => {
    expect(computeSharpe([])).toBeNull();
    expect(computeSharpe([0.01])).toBeNull();
  });

  it("returns positive Sharpe for steady positive returns", () => {
    // Consistent 1% daily returns
    const returns = Array(30).fill(0.01);
    const sharpe = computeSharpe(returns)!;
    expect(sharpe).toBeGreaterThan(0);
  });

  it("returns negative Sharpe for steady negative returns", () => {
    const returns = Array(30).fill(-0.01);
    const sharpe = computeSharpe(returns)!;
    expect(sharpe).toBeLessThan(0);
  });

  it("returns null for zero standard deviation", () => {
    // All identical returns → zero variance
    const returns = [0, 0, 0, 0, 0];
    expect(computeSharpe(returns)).toBeNull();
  });

  it("higher Sharpe for less volatile returns", () => {
    // Low vol: consistent 1%
    const lowVol = Array(30).fill(0.01);
    // High vol: alternating +3%, -1%
    const highVol = Array(30).fill(0).map((_, i) => i % 2 === 0 ? 0.03 : -0.01);
    const sharpeLow = computeSharpe(lowVol)!;
    const sharpeHigh = computeSharpe(highVol)!;
    expect(sharpeLow).toBeGreaterThan(sharpeHigh);
  });
});

// ─── computeMaxDrawdown ─────────────────────────────────────────────────────

describe("computeMaxDrawdown", () => {
  it("returns 0 for monotonically increasing curve", () => {
    const curve = [100, 101, 102, 103, 104, 105];
    const result = computeMaxDrawdown(curve);
    expect(result.maxDrawdownPercent).toBe(0);
  });

  it("returns 0 for single point", () => {
    const result = computeMaxDrawdown([100]);
    expect(result.maxDrawdownPercent).toBe(0);
    expect(result.peakValue).toBe(100);
  });

  it("returns 0 for empty array", () => {
    const result = computeMaxDrawdown([]);
    expect(result.maxDrawdownPercent).toBe(0);
  });

  it("computes correct drawdown for known data", () => {
    // Peak at 100, drops to 80 (20% drawdown), recovers to 95
    const curve = [100, 95, 80, 85, 90, 95];
    const result = computeMaxDrawdown(curve);
    expect(result.maxDrawdownPercent).toBe(-20);
    expect(result.peakValue).toBe(100);
    expect(result.troughValue).toBe(80);
  });

  it("finds deepest drawdown in multi-drawdown curve", () => {
    // First drawdown: 100→90 (10%), Second drawdown: 110→85 (22.73%)
    const curve = [100, 90, 110, 85, 100];
    const result = computeMaxDrawdown(curve);
    expect(result.maxDrawdownPercent).toBeCloseTo(-22.73, 1);
    expect(result.peakValue).toBe(110);
    expect(result.troughValue).toBe(85);
  });
});

// ─── computeProfitFactor ────────────────────────────────────────────────────

describe("computeProfitFactor", () => {
  it("returns null when no losses", () => {
    expect(computeProfitFactor([100, 50, 25])).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(computeProfitFactor([])).toBeNull();
  });

  it("returns > 1 for net-winning trades", () => {
    const pf = computeProfitFactor([100, 50, -30, -20])!;
    expect(pf).toBe(3); // 150 / 50 = 3
  });

  it("returns < 1 for net-losing trades", () => {
    const pf = computeProfitFactor([10, -50, -30])!;
    expect(pf).toBe(0.13); // 10 / 80 = 0.125 → rounds to 0.13
  });

  it("returns 1 for break-even", () => {
    const pf = computeProfitFactor([50, -50])!;
    expect(pf).toBe(1);
  });
});

// ─── getPerformanceMetrics ──────────────────────────────────────────────────

describe("getPerformanceMetrics", () => {
  it("returns zero-filled metrics for empty DB", () => {
    const metrics = getPerformanceMetrics({ period: "all-time" }, dbPath);
    expect(metrics.tradesCount).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.sharpeRatio).toBeNull();
    expect(metrics.maxDrawdown).toBe(0);
    expect(metrics.startingEquity).toBe(0);
    expect(metrics.endingEquity).toBe(0);
  });

  it("computes metrics from known trades and snapshots", () => {
    // Insert trades with known P&L
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "SPY", side: "buy", amount: 500, status: "filled", pnl: 50 }, dbPath);
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "QQQ", side: "buy", amount: 300, status: "filled", pnl: -20 }, dbPath);
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "XLK", side: "buy", amount: 200, status: "filled", pnl: 30 }, dbPath);

    const metrics = getPerformanceMetrics({ skill: "alpaca", period: "all-time" }, dbPath);
    expect(metrics.tradesCount).toBe(3);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(1);
    expect(metrics.winRate).toBeCloseTo(66.67, 1);
    expect(metrics.avgWin).toBe(40); // (50+30)/2
    expect(metrics.avgLoss).toBe(-20);
    expect(metrics.bestTrade?.pnl).toBe(50);
    expect(metrics.worstTrade?.pnl).toBe(-20);
  });

  it("filters by skill", () => {
    recordTrade({ skill: "alpaca", tool: "place_order", symbol: "SPY", side: "buy", amount: 500, status: "filled", pnl: 50 }, dbPath);
    recordTrade({ skill: "polymarket", tool: "place_trade", side: "BUY", amount: 50, status: "filled", pnl: -10 }, dbPath);

    const alpacaMetrics = getPerformanceMetrics({ skill: "alpaca", period: "all-time" }, dbPath);
    expect(alpacaMetrics.tradesCount).toBe(1);
    expect(alpacaMetrics.wins).toBe(1);

    const polyMetrics = getPerformanceMetrics({ skill: "polymarket", period: "all-time" }, dbPath);
    expect(polyMetrics.tradesCount).toBe(1);
    expect(polyMetrics.losses).toBe(1);
  });

  it("uses equity snapshots for return calculation", () => {
    // Need to bypass deduplication by inserting directly
    // Just insert one snapshot (can't dedup if there's only one per skill)
    recordEquitySnapshot({ skill: "alpaca", equity: 10000, cash: 5000, positionsValue: 5000 }, dbPath);

    const metrics = getPerformanceMetrics({ skill: "alpaca", period: "all-time" }, dbPath);
    expect(metrics.startingEquity).toBe(10000);
    expect(metrics.endingEquity).toBe(10000);
    expect(metrics.netReturn).toBe(0);
  });
});
