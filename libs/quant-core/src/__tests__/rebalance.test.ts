import { describe, it, expect } from "vitest";
import { generateRebalanceActions } from "../rebalance";
import type { RegimeResult, SectorMomentum } from "../types";

function mockRankings(symbols: string[]): SectorMomentum[] {
  return symbols.map((symbol, i) => ({
    symbol,
    sector: symbol,
    rank: i + 1,
    momentum20d: 10 - i,
    latestClose: 100,
    close20dAgo: 90 + i,
    compositeScore: 10 - i,
    atrPercent: 1.5,
    volatilityAdjustedScore: (10 - i) / 1.5,
  }));
}

const bullRegime: RegimeResult = {
  regime: "bull",
  spyPrice: 500,
  sma200: 450,
  distancePercent: 11.11,
  compositeRegime: "bull",
};

const bearRegime: RegimeResult = {
  regime: "bear",
  spyPrice: 400,
  sma200: 450,
  distancePercent: -11.11,
  compositeRegime: "bear",
};

describe("generateRebalanceActions", () => {
  it("sells everything in bear mode", () => {
    const rankings = mockRankings(["XLK", "XLF", "XLV", "XLE", "XLY"]);
    const currentHoldings = ["XLK", "XLF"];
    const actions = generateRebalanceActions(bearRegime, rankings, currentHoldings);

    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.action === "sell")).toBe(true);
    expect(actions.map((a) => a.symbol)).toEqual(["XLK", "XLF"]);
  });

  it("generates no sell actions for empty holdings in bear mode", () => {
    const rankings = mockRankings(["XLK", "XLF", "XLV"]);
    const actions = generateRebalanceActions(bearRegime, rankings, []);
    expect(actions).toHaveLength(0);
  });

  it("buys top 3 in bull mode with no holdings", () => {
    const rankings = mockRankings(["XLK", "XLF", "XLV", "XLE", "XLY", "XLP"]);
    const actions = generateRebalanceActions(bullRegime, rankings, []);

    const buys = actions.filter((a) => a.action === "buy");
    expect(buys).toHaveLength(3);
    expect(buys.map((a) => a.symbol)).toEqual(["XLK", "XLF", "XLV"]);
  });

  it("sells holdings outside top 5", () => {
    const rankings = mockRankings(["XLK", "XLF", "XLV", "XLE", "XLY", "XLP", "XLI"]);
    const currentHoldings = ["XLP", "XLI"]; // ranked 6th and 7th
    const actions = generateRebalanceActions(bullRegime, rankings, currentHoldings);

    const sells = actions.filter((a) => a.action === "sell");
    expect(sells).toHaveLength(2);
    expect(sells.map((a) => a.symbol).sort()).toEqual(["XLI", "XLP"]);
  });

  it("holds existing top-3 positions", () => {
    const rankings = mockRankings(["XLK", "XLF", "XLV", "XLE", "XLY"]);
    const currentHoldings = ["XLK"];
    const actions = generateRebalanceActions(bullRegime, rankings, currentHoldings);

    const holds = actions.filter((a) => a.action === "hold" && a.symbol === "XLK");
    expect(holds).toHaveLength(1);
    expect(holds[0].reason).toContain("already held");
  });

  it("holds positions ranked 4-5 if already held", () => {
    const rankings = mockRankings(["XLK", "XLF", "XLV", "XLE", "XLY"]);
    const currentHoldings = ["XLE"]; // rank 4
    const actions = generateRebalanceActions(bullRegime, rankings, currentHoldings);

    const holds = actions.filter((a) => a.action === "hold" && a.symbol === "XLE");
    expect(holds).toHaveLength(1);
    expect(holds[0].reason).toContain("Still in top 5");
  });

  it("uses composite regime over spy-only regime", () => {
    const mixedRegime: RegimeResult = {
      regime: "bull",
      spyPrice: 500,
      sma200: 450,
      distancePercent: 11.11,
      compositeRegime: "bear", // breadth says bear
      breadthCount: 3,
      breadthSignal: "bear",
    };
    const rankings = mockRankings(["XLK", "XLF"]);
    const actions = generateRebalanceActions(mixedRegime, rankings, ["XLK"]);

    // Should sell because composite is bear
    expect(actions[0].action).toBe("sell");
  });
});
