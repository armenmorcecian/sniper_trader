import { describe, it, expect, vi } from "vitest";
import { validateBars } from "../validation";
import type { PriceBar } from "../types";

function bar(close: number, overrides: Partial<PriceBar> = {}): PriceBar {
  return { timestamp: "2024-01-01", open: close, high: close, low: close, close, volume: 1000, vwap: close, ...overrides };
}

describe("validateBars", () => {
  it("passes through valid bars", () => {
    const bars = [bar(100), bar(200), bar(300)];
    expect(validateBars(bars)).toHaveLength(3);
  });

  it("filters bars with close <= 0", () => {
    const bars = [bar(100), bar(0), bar(-5), bar(200)];
    expect(validateBars(bars)).toHaveLength(2);
  });

  it("filters bars with NaN close", () => {
    const bars = [bar(100), bar(NaN), bar(200)];
    expect(validateBars(bars)).toHaveLength(2);
  });

  it("filters bars with zero volume", () => {
    const bars = [bar(100), bar(100, { volume: 0 }), bar(200)];
    expect(validateBars(bars)).toHaveLength(2);
  });

  it("filters bars with NaN open/high/low", () => {
    const bars = [
      bar(100),
      bar(100, { open: NaN }),
      bar(100, { high: Infinity }),
      bar(100, { low: -1 }),
    ];
    expect(validateBars(bars)).toHaveLength(1);
  });

  it("logs warning for filtered bars", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bars = [bar(100), bar(0)];
    validateBars(bars, "SPY");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Filtered 1 invalid bar(s) for SPY"));
    spy.mockRestore();
  });

  it("returns empty array for all-invalid bars", () => {
    const bars = [bar(0), bar(NaN)];
    expect(validateBars(bars)).toHaveLength(0);
  });
});
