import { describe, it, expect } from "vitest";
import { checkCircuitBreaker, checkConcentration } from "../circuit-breaker";
import { getRealizedPnlToday, recordTrade, updateTradeExit } from "../journal";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("checkCircuitBreaker", () => {
  it("returns tripped=false when PnL is within limit", () => {
    const result = checkCircuitBreaker(-200, 10000, 3);
    expect(result.tripped).toBe(false);
    expect(result.dailyPnlPercent).toBe(-2);
  });

  it("returns tripped=true when PnL exceeds limit", () => {
    const result = checkCircuitBreaker(-400, 10000, 3);
    expect(result.tripped).toBe(true);
    expect(result.action).toBe("cancel_all_orders");
    expect(result.reason).toContain("-4.00%");
    expect(result.reason).toContain("-3%");
  });

  it("returns tripped=true at exact limit boundary", () => {
    // -3.01% should trip at 3% limit
    const result = checkCircuitBreaker(-301, 10000, 3);
    expect(result.tripped).toBe(true);
  });

  it("returns tripped=false at exactly -3.00%", () => {
    // Exactly -3% is NOT tripped (must exceed, not equal)
    const result = checkCircuitBreaker(-300, 10000, 3);
    expect(result.tripped).toBe(false);
  });

  it("handles zero equity", () => {
    const result = checkCircuitBreaker(0, 0, 3);
    expect(result.tripped).toBe(true);
    expect(result.reason).toContain("Zero or negative equity");
  });

  it("handles negative equity", () => {
    const result = checkCircuitBreaker(-100, -50, 3);
    expect(result.tripped).toBe(true);
  });

  it("handles positive PnL (no trip)", () => {
    const result = checkCircuitBreaker(500, 10000, 3);
    expect(result.tripped).toBe(false);
    expect(result.dailyPnlPercent).toBe(5);
  });

  it("works with different thresholds", () => {
    // 10% threshold (Polymarket default)
    const result = checkCircuitBreaker(-800, 10000, 10);
    expect(result.tripped).toBe(false);

    const result2 = checkCircuitBreaker(-1100, 10000, 10);
    expect(result2.tripped).toBe(true);
  });

  it("rounds dailyPnlPercent to 2 decimal places", () => {
    const result = checkCircuitBreaker(-123.456, 10000, 3);
    expect(result.dailyPnlPercent).toBe(-1.23);
  });
});

describe("checkConcentration", () => {
  it("returns exceeded=false when within limit", () => {
    const result = checkConcentration(2000, 10000, 33);
    expect(result.exceeded).toBe(false);
    expect(result.currentPercent).toBe(20);
    expect(result.maxPercent).toBe(33);
  });

  it("returns exceeded=true when over limit", () => {
    const result = checkConcentration(4000, 10000, 33);
    expect(result.exceeded).toBe(true);
    expect(result.currentPercent).toBe(40);
    expect(result.reason).toContain("40.0%");
    expect(result.reason).toContain("33%");
  });

  it("handles zero equity", () => {
    const result = checkConcentration(100, 0, 33);
    expect(result.exceeded).toBe(true);
    expect(result.reason).toContain("Zero or negative equity");
  });

  it("handles exact boundary (not exceeded)", () => {
    const result = checkConcentration(3300, 10000, 33);
    expect(result.exceeded).toBe(false);
    expect(result.currentPercent).toBe(33);
  });

  it("handles zero position value", () => {
    const result = checkConcentration(0, 10000, 33);
    expect(result.exceeded).toBe(false);
    expect(result.currentPercent).toBe(0);
  });
});

describe("getRealizedPnlToday", () => {
  function tmpDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qc-test-"));
    return path.join(dir, "test.db");
  }

  it("returns 0 with empty DB", () => {
    const dbPath = tmpDbPath();
    const pnl = getRealizedPnlToday("alpaca", dbPath);
    expect(pnl).toBe(0);
  });

  it("sums only trades with exit_price set", () => {
    const dbPath = tmpDbPath();
    // Record two trades — one closed, one still open
    const id1 = recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "SPY",
      side: "buy",
      amount: 1000,
      price: 400,
      status: "filled",
      pnl: -50,
    }, dbPath);
    updateTradeExit(id1, 395, -50, dbPath);

    recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "QQQ",
      side: "buy",
      amount: 500,
      price: 350,
      status: "filled",
      pnl: 20,
    }, dbPath);

    const pnl = getRealizedPnlToday("alpaca", dbPath);
    expect(pnl).toBe(-50); // Only the closed trade
  });

  it("filters by skill", () => {
    const dbPath = tmpDbPath();
    const id1 = recordTrade({
      skill: "alpaca",
      tool: "place_order",
      symbol: "SPY",
      side: "buy",
      amount: 1000,
      price: 400,
      status: "filled",
      pnl: -30,
    }, dbPath);
    updateTradeExit(id1, 397, -30, dbPath);

    const id2 = recordTrade({
      skill: "polymarket",
      tool: "place_trade",
      symbol: "BTC",
      side: "buy",
      amount: 100,
      price: 0.5,
      status: "filled",
      pnl: -10,
    }, dbPath);
    updateTradeExit(id2, 0.4, -10, dbPath);

    expect(getRealizedPnlToday("alpaca", dbPath)).toBe(-30);
    expect(getRealizedPnlToday("polymarket", dbPath)).toBe(-10);
  });
});
