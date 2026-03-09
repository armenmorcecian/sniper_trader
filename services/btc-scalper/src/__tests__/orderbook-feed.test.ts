import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ws module to avoid actual WebSocket connections
vi.mock("ws", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      send: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
      readyState: 1,
    })),
    OPEN: 1,
  };
});

import { OrderBookFeed } from "../orderbook-feed";

describe("OrderBookFeed", () => {
  let feed: OrderBookFeed;

  beforeEach(() => {
    feed = new OrderBookFeed("btcusdt", "BTCUSDT", "BTC-USDT");
  });

  describe("initial state", () => {
    it("is not ready before any data", () => {
      expect(feed.isReady).toBe(false);
    });

    it("lastObi is null before any data", () => {
      expect(feed.lastObi).toBeNull();
    });
  });

  describe("computeObi", () => {
    it("equal bids and asks produce OBI ≈ 0", () => {
      // Access private method through prototype for testing
      const feedAny = feed as any;
      feedAny.snapshots.set("binance", {
        exchange: "binance",
        symbol: "btcusdt",
        bids: [[50000, 1], [49999, 1]] as [number, number][],
        asks: [[50001, 1], [50002, 1]] as [number, number][],
        timestamp: Date.now(),
      });
      feedAny.snapshots.set("bybit", {
        exchange: "bybit",
        symbol: "BTCUSDT",
        bids: [[50000, 1], [49999, 1]] as [number, number][],
        asks: [[50001, 1], [50002, 1]] as [number, number][],
        timestamp: Date.now(),
      });

      feedAny.computeObi();

      const obi = feed.lastObi;
      expect(obi).not.toBeNull();
      expect(obi!.obi).toBeCloseTo(0, 1);
      expect(obi!.exchangeCount).toBe(2);
    });

    it("more bids than asks produce positive OBI", () => {
      const feedAny = feed as any;
      feedAny.snapshots.set("binance", {
        exchange: "binance",
        symbol: "btcusdt",
        bids: [[50000, 5], [49999, 5]] as [number, number][],  // large bid volume
        asks: [[50001, 1], [50002, 1]] as [number, number][],  // small ask volume
        timestamp: Date.now(),
      });

      feedAny.computeObi();

      const obi = feed.lastObi;
      expect(obi).not.toBeNull();
      expect(obi!.obi).toBeGreaterThan(0);
    });

    it("more asks than bids produce negative OBI", () => {
      const feedAny = feed as any;
      feedAny.snapshots.set("binance", {
        exchange: "binance",
        symbol: "btcusdt",
        bids: [[50000, 1], [49999, 1]] as [number, number][],
        asks: [[50001, 5], [50002, 5]] as [number, number][],
        timestamp: Date.now(),
      });

      feedAny.computeObi();

      const obi = feed.lastObi;
      expect(obi).not.toBeNull();
      expect(obi!.obi).toBeLessThan(0);
    });

    it("single exchange fallback works", () => {
      const feedAny = feed as any;
      feedAny.snapshots.set("binance", {
        exchange: "binance",
        symbol: "btcusdt",
        bids: [[50000, 2]] as [number, number][],
        asks: [[50001, 1]] as [number, number][],
        timestamp: Date.now(),
      });

      feedAny.computeObi();

      const obi = feed.lastObi;
      expect(obi).not.toBeNull();
      expect(obi!.exchangeCount).toBe(1);
      expect(obi!.obi).toBeGreaterThan(0);
    });

    it("exchange weighting applies correctly", () => {
      const feedAny = feed as any;
      const now = Date.now();

      // Binance (weight 0.50): heavily bullish
      feedAny.snapshots.set("binance", {
        exchange: "binance",
        symbol: "btcusdt",
        bids: [[50000, 10]] as [number, number][],
        asks: [[50001, 1]] as [number, number][],
        timestamp: now,
      });

      // Bybit (weight 0.30): heavily bearish
      feedAny.snapshots.set("bybit", {
        exchange: "bybit",
        symbol: "BTCUSDT",
        bids: [[50000, 1]] as [number, number][],
        asks: [[50001, 10]] as [number, number][],
        timestamp: now,
      });

      feedAny.computeObi();

      const obi = feed.lastObi;
      expect(obi).not.toBeNull();
      // Binance bullish > Bybit bearish due to higher weight, so OBI should be positive
      expect(obi!.obi).toBeGreaterThan(0);
      expect(obi!.exchangeCount).toBe(2);
    });

    it("skips stale snapshots (>10s old)", () => {
      const feedAny = feed as any;
      feedAny.snapshots.set("binance", {
        exchange: "binance",
        symbol: "btcusdt",
        bids: [[50000, 5]] as [number, number][],
        asks: [[50001, 1]] as [number, number][],
        timestamp: Date.now() - 15_000, // 15s old — stale
      });

      feedAny.computeObi();

      // Stale snapshot skipped, no valid data → lastObi should still be null
      expect(feed.lastObi).toBeNull();
    });

    it("returns empty for no snapshots", () => {
      const feedAny = feed as any;
      feedAny.computeObi();
      expect(feed.lastObi).toBeNull();
    });
  });

  describe("destroy", () => {
    it("marks feed as destroyed", () => {
      feed.destroy();
      expect((feed as any).destroyed).toBe(true);
    });
  });
});
