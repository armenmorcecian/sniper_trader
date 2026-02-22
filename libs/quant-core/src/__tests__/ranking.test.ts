import { describe, it, expect } from "vitest";
import { rankSectorMomentum } from "../ranking";
import type { PriceBar } from "../types";

function bar(close: number): PriceBar {
  return { timestamp: "2024-01-01", open: close * 0.99, high: close * 1.02, low: close * 0.98, close, volume: 1000000, vwap: close };
}

function generateBars(count: number, startPrice: number, trend: number): PriceBar[] {
  const bars: PriceBar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price = price * (1 + trend);
    bars.push(bar(price));
  }
  return bars;
}

describe("rankSectorMomentum", () => {
  it("returns -Infinity momentum for symbols with <21 bars", () => {
    const multiBars = { XLK: generateBars(10, 100, 0.01) };
    const result = rankSectorMomentum(multiBars, ["XLK"]);
    expect(result).toHaveLength(1);
    expect(result[0].momentum20d).toBe(-Infinity);
  });

  it("ranks sectors by momentum correctly", () => {
    const multiBars = {
      XLK: generateBars(65, 100, 0.02),   // strong uptrend
      XLF: generateBars(65, 100, 0.005),  // moderate uptrend
      XLE: generateBars(65, 100, -0.01),  // downtrend
    };
    const result = rankSectorMomentum(multiBars, ["XLK", "XLF", "XLE"]);

    expect(result).toHaveLength(3);
    expect(result[0].symbol).toBe("XLK"); // strongest
    expect(result[2].symbol).toBe("XLE"); // weakest
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
    expect(result[2].rank).toBe(3);
  });

  it("computes SMA50 for symbols with 50+ bars", () => {
    const multiBars = { XLK: generateBars(55, 100, 0.005) };
    const result = rankSectorMomentum(multiBars, ["XLK"]);
    expect(result[0].sma50).toBeDefined();
    expect(result[0].aboveSMA50).toBeDefined();
  });

  it("computes ATR metrics for symbols with 15+ bars", () => {
    const multiBars = { XLK: generateBars(25, 100, 0.005) };
    const result = rankSectorMomentum(multiBars, ["XLK"]);
    expect(result[0].atr14).toBeDefined();
    expect(result[0].atrPercent).toBeDefined();
  });
});
