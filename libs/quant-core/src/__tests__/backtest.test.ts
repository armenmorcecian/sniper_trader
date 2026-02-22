import { describe, it, expect } from "vitest";
import { runBacktest } from "../backtest";
import type { PriceBar } from "../types";
import { SECTOR_UNIVERSE } from "../constants";

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateBars(count: number, startPrice: number, trend: number, volatility: number = 0): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = startPrice;
  const startDate = new Date("2024-01-01");

  for (let i = 0; i < count; i++) {
    price = price * (1 + trend + (Math.random() - 0.5) * volatility);
    if (price < 1) price = 1; // floor
    const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
    bars.push({
      timestamp: date.toISOString().split("T")[0],
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000000,
      vwap: price,
    });
  }
  return bars;
}

function generateBullBars(count: number, startPrice: number): PriceBar[] {
  // Steady uptrend: +0.05% per day, low volatility
  return generateBars(count, startPrice, 0.0005, 0.002);
}

function generateBearBars(count: number, startPrice: number): PriceBar[] {
  // Steady downtrend: -0.1% per day
  return generateBars(count, startPrice, -0.001, 0.002);
}

function generateFlatBars(count: number, price: number): PriceBar[] {
  // Flat: 0% trend, very low volatility
  return generateBars(count, price, 0, 0.001);
}

const defaultConfig = {
  startingCapital: 10000,
  rebalanceFrequency: 5,
  positionCount: 3,
  stopLossPercent: -7,
  commissionPerTrade: 0,
};

function buildMultiBars(
  spyBars: PriceBar[],
  sectorGenerator: (count: number, startPrice: number) => PriceBar[],
): Record<string, PriceBar[]> {
  const result: Record<string, PriceBar[]> = { SPY: spyBars };
  const prices = [50, 45, 55, 40, 60, 35, 65, 30, 70, 25, 75];
  for (let i = 0; i < SECTOR_UNIVERSE.length; i++) {
    result[SECTOR_UNIVERSE[i]] = sectorGenerator(spyBars.length, prices[i % prices.length]);
  }
  return result;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runBacktest", () => {
  it("throws if insufficient SPY bars", () => {
    const multiBars = buildMultiBars(generateBullBars(100, 400), generateBullBars);
    expect(() => runBacktest(multiBars, defaultConfig)).toThrow("Need 201+ SPY bars");
  });

  it("throws if fewer than 3 sector ETFs have enough bars", () => {
    const multiBars: Record<string, PriceBar[]> = {
      SPY: generateBullBars(250, 400),
      XLK: generateBullBars(250, 50),
      XLF: generateBullBars(250, 40),
    };
    expect(() => runBacktest(multiBars, defaultConfig)).toThrow("Need at least 3 sector ETFs");
  });

  it("produces positive return in a bull market", () => {
    const multiBars = buildMultiBars(generateBullBars(300, 400), generateBullBars);
    const result = runBacktest(multiBars, defaultConfig);

    expect(result.tradingDays).toBe(100); // 300 - 200 start index
    expect(result.finalEquity).toBeGreaterThan(defaultConfig.startingCapital);
    expect(result.totalReturn).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBe(100);
    expect(result.startDate).toBeDefined();
    expect(result.endDate).toBeDefined();
  });

  it("goes to cash in a bear market", () => {
    // SPY below SMA200 = bear regime → sell everything
    const multiBars = buildMultiBars(generateBearBars(300, 400), generateBearBars);
    const result = runBacktest(multiBars, defaultConfig);

    // In a bear market, the system should mostly be in cash
    // Final equity should be close to starting capital (minimal losses from brief holds)
    expect(result.tradingDays).toBe(100);
    // The system sells on bear regime, so equity shouldn't collapse
    expect(result.finalEquity).toBeGreaterThan(defaultConfig.startingCapital * 0.7);
  });

  it("triggers stop-loss on sharp drops", () => {
    // Bull market but with one sector that crashes
    const multiBars = buildMultiBars(generateBullBars(300, 400), generateBullBars);
    // Make XLK crash after bar 220
    const xlkBars = multiBars["XLK"];
    for (let i = 220; i < xlkBars.length; i++) {
      xlkBars[i] = {
        ...xlkBars[i],
        close: xlkBars[219].close * 0.8, // 20% crash
        open: xlkBars[219].close * 0.82,
        high: xlkBars[219].close * 0.83,
        low: xlkBars[219].close * 0.78,
      };
    }

    const result = runBacktest(multiBars, defaultConfig);
    // Should still complete without error
    expect(result.tradingDays).toBe(100);
    expect(result.totalTrades).toBeGreaterThan(0);
  });

  it("returns valid equity curve", () => {
    const multiBars = buildMultiBars(generateBullBars(250, 400), generateBullBars);
    const result = runBacktest(multiBars, defaultConfig);

    // Equity curve should have one entry per trading day
    expect(result.equityCurve.length).toBe(50);
    // First entry should be close to starting capital
    expect(result.equityCurve[0].equity).toBeCloseTo(defaultConfig.startingCapital, -1);
    // All equity values should be positive
    expect(result.equityCurve.every(e => e.equity > 0)).toBe(true);
  });

  it("returns rebalance log entries", () => {
    const multiBars = buildMultiBars(generateBullBars(250, 400), generateBullBars);
    const result = runBacktest(multiBars, { ...defaultConfig, rebalanceFrequency: 10 });

    // Should have at least a few rebalances in 50 trading days with freq=10
    expect(result.rebalanceLog.length).toBeGreaterThan(0);
    for (const entry of result.rebalanceLog) {
      expect(entry.date).toBeDefined();
      expect(Array.isArray(entry.actions)).toBe(true);
      expect(Array.isArray(entry.holdings)).toBe(true);
      expect(entry.equity).toBeGreaterThan(0);
    }
  });

  it("computes performance metrics correctly", () => {
    const multiBars = buildMultiBars(generateBullBars(300, 400), generateBullBars);
    const result = runBacktest(multiBars, defaultConfig);

    // Win rate should be between 0 and 100
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(100);

    // Max drawdown should be <= 0 (negative percentage)
    expect(result.maxDrawdown).toBeLessThanOrEqual(0);

    // Config should be preserved
    expect(result.config).toEqual(defaultConfig);
  });

  it("handles flat market without errors", () => {
    const multiBars = buildMultiBars(generateFlatBars(250, 400), generateFlatBars);
    const result = runBacktest(multiBars, defaultConfig);

    expect(result.tradingDays).toBe(50);
    // Flat market: return should be close to 0
    expect(Math.abs(result.totalReturn)).toBeLessThan(10);
  });

  it("slippage reduces final equity compared to zero-slippage", () => {
    const multiBars = buildMultiBars(generateBullBars(300, 400), generateBullBars);
    const noSlippage = runBacktest(multiBars, defaultConfig);
    const withSlippage = runBacktest(multiBars, { ...defaultConfig, slippageBps: 50 });
    expect(withSlippage.finalEquity).toBeLessThan(noSlippage.finalEquity);
  });

  it("zero slippageBps matches default behavior", () => {
    const multiBars = buildMultiBars(generateBullBars(300, 400), generateBullBars);
    const result0 = runBacktest(multiBars, { ...defaultConfig, slippageBps: 0 });
    const resultDefault = runBacktest(multiBars, defaultConfig);
    expect(result0.finalEquity).toBe(resultDefault.finalEquity);
  });
});
