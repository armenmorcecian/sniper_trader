import { describe, it, expect } from "vitest";
import { round, calculateDailyReturns, pearsonCorrelation } from "../math";
import type { PriceBar } from "../types";

function bar(close: number, overrides: Partial<PriceBar> = {}): PriceBar {
  return { timestamp: "2024-01-01", open: close, high: close, low: close, close, volume: 1000, vwap: close, ...overrides };
}

describe("round", () => {
  it("rounds to 4 decimal places", () => {
    expect(round(1.23456789)).toBe(1.2346);
    expect(round(0)).toBe(0);
    expect(round(-1.23456)).toBe(-1.2346);
  });
});

describe("calculateDailyReturns", () => {
  it("returns empty array for fewer than 2 bars", () => {
    expect(calculateDailyReturns([])).toEqual([]);
    expect(calculateDailyReturns([bar(100)])).toEqual([]);
  });

  it("calculates correct percentage returns", () => {
    const bars = [bar(100), bar(110), bar(99)];
    const returns = calculateDailyReturns(bars);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(10, 5); // 100 -> 110 = +10%
    expect(returns[1]).toBeCloseTo(-10, 5); // 110 -> 99 = -10%
  });
});

describe("pearsonCorrelation", () => {
  it("returns 0 for fewer than 2 data points", () => {
    expect(pearsonCorrelation([], [])).toBe(0);
    expect(pearsonCorrelation([1], [2])).toBe(0);
  });

  it("returns 1 for perfectly correlated data", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(1, 5);
  });

  it("returns -1 for perfectly inverse data", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for constant array", () => {
    const a = [5, 5, 5, 5];
    const b = [1, 2, 3, 4];
    expect(pearsonCorrelation(a, b)).toBe(0);
  });
});
