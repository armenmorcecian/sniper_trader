import { describe, it, expect } from "vitest";
import { calculateRegime } from "../regime";
import type { PriceBar } from "../types";

function bar(close: number): PriceBar {
  return { timestamp: "2024-01-01", open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000000, vwap: close };
}

function generateBullBars(count: number): PriceBar[] {
  // Starts at 400, rises steadily to ~500+ — clearly above 200-SMA
  const bars: PriceBar[] = [];
  for (let i = 0; i < count; i++) {
    const price = 400 + i * 0.5;
    bars.push(bar(price));
  }
  return bars;
}

function generateBearBars(count: number): PriceBar[] {
  // Starts at 500, drops steadily — latest price below 200-SMA
  const bars: PriceBar[] = [];
  for (let i = 0; i < count; i++) {
    const price = 500 - i * 0.5;
    bars.push(bar(price));
  }
  return bars;
}

describe("calculateRegime", () => {
  it("throws if fewer than 200 bars", () => {
    expect(() => calculateRegime([bar(500)])).toThrow("Need 200+ SPY bars");
  });

  it("detects bull regime when price above SMA200", () => {
    const bars = generateBullBars(250);
    const result = calculateRegime(bars);
    expect(result.regime).toBe("bull");
    expect(result.spyPrice).toBeGreaterThan(result.sma200);
    expect(result.distancePercent).toBeGreaterThan(0);
  });

  it("detects bear regime when price below SMA200", () => {
    const bars = generateBearBars(250);
    const result = calculateRegime(bars);
    expect(result.regime).toBe("bear");
    expect(result.spyPrice).toBeLessThan(result.sma200);
    expect(result.distancePercent).toBeLessThan(0);
  });

  it("computes breadth when sectorBars provided", () => {
    const spyBars = generateBullBars(250);
    const sectorBars: Record<string, PriceBar[]> = {
      XLK: generateBullBars(60),
      XLF: generateBullBars(60),
      XLV: generateBullBars(60),
      XLE: generateBullBars(60),
      XLY: generateBullBars(60),
      XLP: generateBullBars(60),
      XLI: generateBullBars(60),
      XLU: generateBullBars(60),
      XLB: generateBullBars(60),
      XLC: generateBullBars(60),
      XLRE: generateBullBars(60),
    };
    const result = calculateRegime(spyBars, sectorBars);
    expect(result.breadthCount).toBeDefined();
    expect(result.breadthSignal).toBeDefined();
    expect(result.compositeRegime).toBeDefined();
    expect(result.sectorSMA50Status).toBeDefined();
  });
});
