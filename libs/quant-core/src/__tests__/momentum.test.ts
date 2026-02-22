import { describe, it, expect } from "vitest";
import { compositeMomentum, atrMetrics, riskParityWeights } from "../momentum";
import type { PriceBar, SectorMomentum } from "../types";

function bar(close: number, overrides: Partial<PriceBar> = {}): PriceBar {
  return {
    timestamp: "2024-01-01",
    open: close * 0.99,
    high: close * 1.02,
    low: close * 0.98,
    close,
    volume: 1000000,
    vwap: close,
    ...overrides,
  };
}

function generateBars(count: number, startPrice: number = 100, trend: number = 0.001): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price = price * (1 + trend + (Math.sin(i) * 0.005));
    bars.push(bar(price));
  }
  return bars;
}

describe("compositeMomentum", () => {
  it("returns -Infinity for insufficient bars", () => {
    const bars = generateBars(5);
    const result = compositeMomentum(bars);
    expect(result.momentum5d).toBe(-Infinity);
    expect(result.momentum20d).toBe(-Infinity);
    expect(result.compositeScore).toBe(-Infinity);
  });

  it("calculates 5d and 20d momentum for 21+ bars", () => {
    const bars = generateBars(25);
    const result = compositeMomentum(bars);
    expect(result.momentum5d).not.toBe(-Infinity);
    expect(result.momentum20d).not.toBe(-Infinity);
    expect(result.momentum60d).toBe(-Infinity);
    // compositeScore falls back to m20 when m60 is -Infinity
    expect(result.compositeScore).toBe(result.momentum20d);
  });

  it("calculates full composite for 61+ bars", () => {
    const bars = generateBars(65);
    const result = compositeMomentum(bars);
    expect(result.momentum5d).not.toBe(-Infinity);
    expect(result.momentum20d).not.toBe(-Infinity);
    expect(result.momentum60d).not.toBe(-Infinity);
    expect(result.compositeScore).not.toBe(-Infinity);
  });
});

describe("atrMetrics", () => {
  it("returns null for fewer than 15 bars", () => {
    expect(atrMetrics(generateBars(10))).toBeNull();
  });

  it("returns atr14 and atrPercent for 15+ bars", () => {
    const bars = generateBars(20);
    const result = atrMetrics(bars);
    expect(result).not.toBeNull();
    expect(result!.atr14).toBeGreaterThan(0);
    expect(result!.atrPercent).toBeGreaterThan(0);
  });
});

describe("riskParityWeights", () => {
  it("returns empty for no sectors", () => {
    expect(riskParityWeights([])).toEqual({});
  });

  it("returns empty if any sector lacks atrPercent", () => {
    const sectors: SectorMomentum[] = [
      { symbol: "XLK", sector: "Tech", rank: 1, momentum20d: 5, latestClose: 100, close20dAgo: 95, atrPercent: 1.5 },
      { symbol: "XLF", sector: "Fin", rank: 2, momentum20d: 3, latestClose: 50, close20dAgo: 48 },
    ];
    expect(riskParityWeights(sectors)).toEqual({});
  });

  it("weights sum to approximately 1.0", () => {
    const sectors: SectorMomentum[] = [
      { symbol: "XLK", sector: "Tech", rank: 1, momentum20d: 5, latestClose: 100, close20dAgo: 95, atrPercent: 1.5 },
      { symbol: "XLF", sector: "Fin", rank: 2, momentum20d: 3, latestClose: 50, close20dAgo: 48, atrPercent: 2.0 },
      { symbol: "XLE", sector: "Energy", rank: 3, momentum20d: 2, latestClose: 80, close20dAgo: 78, atrPercent: 2.5 },
    ];
    const weights = riskParityWeights(sectors);
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1.0, 2);
  });

  it("gives higher weight to lower volatility", () => {
    const sectors: SectorMomentum[] = [
      { symbol: "LOW", sector: "Low Vol", rank: 1, momentum20d: 5, latestClose: 100, close20dAgo: 95, atrPercent: 0.5 },
      { symbol: "HIGH", sector: "High Vol", rank: 2, momentum20d: 3, latestClose: 50, close20dAgo: 48, atrPercent: 3.0 },
    ];
    const weights = riskParityWeights(sectors);
    expect(weights["LOW"]).toBeGreaterThan(weights["HIGH"]);
  });
});
