import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock quant-core to avoid SQLite dependency
vi.mock("quant-core", () => ({
  calibrateCopulaDf: vi.fn(() => 4),
  buildCorrelationMatrix: vi.fn((histories: number[][]) => {
    // Return simple identity + some correlation
    const d = histories.length;
    const matrix: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < d; i++) {
      matrix[i][i] = 1;
      for (let j = i + 1; j < d; j++) {
        matrix[i][j] = 0.5;
        matrix[j][i] = 0.5;
      }
    }
    return matrix;
  }),
  computeTailDependence: vi.fn((rho: number, _nu: number) => {
    // Return a value proportional to rho for testing
    return Math.max(0, rho * 0.4);
  }),
}));

import { TickCopulaTracker } from "../copula-tracker";
import { computeTailDependence } from "quant-core";

describe("TickCopulaTracker", () => {
  let tracker: TickCopulaTracker;

  beforeEach(() => {
    tracker = new TickCopulaTracker();
    vi.clearAllMocks();
  });

  describe("getSizeFactor", () => {
    it("returns 1.0 when not ready", () => {
      expect(tracker.isReady).toBe(false);
      expect(tracker.getSizeFactor()).toBe(1.0);
    });
  });

  describe("onBtcTick", () => {
    it("ignores non-positive prices", () => {
      tracker.onBtcTick(0);
      tracker.onBtcTick(-1);
      expect(tracker.isReady).toBe(false);
    });

    it("does not become ready with insufficient samples", () => {
      for (let i = 0; i < 5; i++) {
        tracker.onBtcTick(50000 + i * 10);
        tracker.onPolyPriceUpdate(0.5 + i * 0.01);
      }
      expect(tracker.isReady).toBe(false);
    });
  });

  describe("onPolyPriceUpdate", () => {
    it("ignores prices outside 0-1 range", () => {
      tracker.onPolyPriceUpdate(0);
      tracker.onPolyPriceUpdate(1);
      tracker.onPolyPriceUpdate(-0.5);
      tracker.onPolyPriceUpdate(1.5);
      expect(tracker.isReady).toBe(false);
    });
  });

  describe("calibration and sizing", () => {
    it("becomes ready after enough samples and recalibration", () => {
      // Feed enough samples (MIN_SAMPLES = 10)
      for (let i = 0; i < 15; i++) {
        tracker.onBtcTick(50000 + i * 10);
        tracker.onPolyPriceUpdate(0.3 + i * 0.02);
      }

      // Force recalibration by advancing time
      // The tracker checks RECALIBRATE_MS (30s) — we need to trick it
      // Since we can't easily mock Date.now in the tracker, we test
      // the mocked path by calling enough ticks
      // Actually, the first call with enough data WILL calibrate since lastCalibrationTime = 0
      expect(tracker.isReady).toBe(true);
    });

    it("returns correct size factor tiers", () => {
      // Feed data to trigger calibration
      for (let i = 0; i < 15; i++) {
        tracker.onBtcTick(50000 + i * 10);
        tracker.onPolyPriceUpdate(0.3 + i * 0.02);
      }

      // With mock rho=0.5, computeTailDependence returns 0.5*0.4=0.20
      // tailDep=0.20 > 0.15 → sizeFactor=0.75
      expect(tracker.getSizeFactor()).toBe(0.75);
    });

    it("returns 0.5 for very high tail dependence", () => {
      // Make computeTailDependence return > 0.3
      vi.mocked(computeTailDependence).mockReturnValue(0.35);

      for (let i = 0; i < 15; i++) {
        tracker.onBtcTick(50000 + i * 10);
        tracker.onPolyPriceUpdate(0.3 + i * 0.02);
      }

      expect(tracker.getSizeFactor()).toBe(0.5);
    });

    it("returns 1.0 for low tail dependence", () => {
      // Make computeTailDependence return < 0.15
      vi.mocked(computeTailDependence).mockReturnValue(0.05);

      for (let i = 0; i < 15; i++) {
        tracker.onBtcTick(50000 + i * 10);
        tracker.onPolyPriceUpdate(0.3 + i * 0.02);
      }

      expect(tracker.getSizeFactor()).toBe(1.0);
    });
  });

  describe("tailDependence", () => {
    it("starts at 0", () => {
      expect(tracker.tailDependence).toBe(0);
    });

    it("updates after calibration", () => {
      for (let i = 0; i < 15; i++) {
        tracker.onBtcTick(50000 + i * 10);
        tracker.onPolyPriceUpdate(0.3 + i * 0.02);
      }

      expect(tracker.tailDependence).toBeGreaterThan(0);
    });
  });
});
