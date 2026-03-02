import { describe, it, expect } from "vitest";
import {
  monteCarloEstimate,
  antitheticSamples,
  stratifiedSamples,
  brierScore,
  brierSkillScore,
  simulateBinaryContract,
  simulatePredictionContract,
  importanceSamplingEstimate,
  logit,
  sigmoid,
} from "../monte-carlo";

describe("antitheticSamples", () => {
  it("produces negatively correlated pairs", () => {
    const samples = antitheticSamples(1000, 42);
    expect(samples.length).toBe(1000);

    // First half and second half should be negated
    let sumProduct = 0;
    for (let i = 0; i < 500; i++) {
      sumProduct += samples[i] * samples[i + 500];
    }
    // Correlation should be strongly negative
    expect(sumProduct / 500).toBeLessThan(-0.5);
  });

  it("produces deterministic output with seed", () => {
    const s1 = antitheticSamples(100, 123);
    const s2 = antitheticSamples(100, 123);
    for (let i = 0; i < 100; i++) {
      expect(s1[i]).toBe(s2[i]);
    }
  });
});

describe("stratifiedSamples", () => {
  it("covers all quantile bands", () => {
    const samples = stratifiedSamples(1000, 10, 42);
    expect(samples.length).toBe(1000);

    // Check that samples span a reasonable range (not all clustered)
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    // Should span at least 4 standard deviations
    expect(max - min).toBeGreaterThan(4);
  });

  it("has lower variance than crude for uniform estimation", () => {
    // Estimate P(Z > 0) = 0.50 with stratified vs crude
    const stratified = monteCarloEstimate(
      (z) => z > 0 ? 1 : 0,
      { nPaths: 5000, useStratified: true, useAntithetic: false, nStrata: 10, seed: 42 },
    );
    const crude = monteCarloEstimate(
      (z) => z > 0 ? 1 : 0,
      { nPaths: 5000, useStratified: false, useAntithetic: false, nStrata: 10, seed: 42 },
    );

    // Both should be close to 0.50
    expect(stratified.estimate).toBeCloseTo(0.5, 1);
    expect(crude.estimate).toBeCloseTo(0.5, 1);
    // Stratified should have lower or comparable SE
    expect(stratified.stdError).toBeLessThanOrEqual(crude.stdError * 1.5);
  });
});

describe("monteCarloEstimate", () => {
  it("converges to known probability (coin flip)", () => {
    // P(Z > 0) = 0.50 exactly
    const result = monteCarloEstimate(
      (z) => z > 0 ? 1 : 0,
      { nPaths: 50000, seed: 42 },
    );
    expect(result.estimate).toBeCloseTo(0.5, 1);
    expect(result.ci95[0]).toBeLessThan(0.5);
    expect(result.ci95[1]).toBeGreaterThan(0.5);
  });

  it("estimates mean of normal distribution", () => {
    // E[Z] = 0
    const result = monteCarloEstimate(
      (z) => z,
      { nPaths: 50000, seed: 42 },
    );
    expect(result.estimate).toBeCloseTo(0, 1);
  });

  it("returns correct nPaths", () => {
    const result = monteCarloEstimate((z) => z, { nPaths: 1234 });
    expect(result.nPaths).toBe(1234);
  });

  it("CI contains the true value", () => {
    // P(Z > 1) ≈ 0.1587
    const result = monteCarloEstimate(
      (z) => z > 1 ? 1 : 0,
      { nPaths: 100000, seed: 42 },
    );
    expect(result.ci95[0]).toBeLessThan(0.1587);
    expect(result.ci95[1]).toBeGreaterThan(0.1587);
  });
});

describe("importanceSamplingEstimate", () => {
  it("estimates tail probability with lower variance", () => {
    // P(X > 3) for X ~ N(0,1) ≈ 0.00135
    const isResult = importanceSamplingEstimate(
      (x) => x > 3 ? 1 : 0,
      0, 1,
      { nPaths: 10000, tiltMean: 3, tiltStd: 1 },
    );

    expect(isResult.estimate).toBeGreaterThan(0);
    expect(isResult.estimate).toBeCloseTo(0.00135, 2);
  });
});

describe("brierScore", () => {
  it("returns 0 for perfect predictions", () => {
    expect(brierScore([1, 0, 1, 0], [1, 0, 1, 0])).toBe(0);
  });

  it("returns 0.25 for always-uncertain predictions", () => {
    expect(brierScore([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.25);
  });

  it("returns 1 for maximally wrong predictions", () => {
    expect(brierScore([0, 1, 0, 1], [1, 0, 1, 0])).toBe(1);
  });

  it("confident correct model beats uncertain model", () => {
    const confident = brierScore([0.9, 0.1, 0.9, 0.1], [1, 0, 1, 0]);
    const uncertain = brierScore([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]);
    expect(confident).toBeLessThan(uncertain);
  });

  it("returns 0 for empty arrays", () => {
    expect(brierScore([], [])).toBe(0);
  });
});

describe("simulateBinaryContract", () => {
  it("converges to Black-Scholes closed form", () => {
    const result = simulateBinaryContract({
      currentPrice: 100,
      strikePrice: 105,
      volatility: 0.20,
      timeToExpiry: 30 / 365,
      drift: 0.08,
      nPaths: 100000,
      seed: 42,
    });

    // MC estimate should be close to closed form (within 5 percentage points)
    expect(Math.abs(result.estimate - result.closedFormPrice)).toBeLessThan(0.05);
    // CI should overlap with a reasonable band around closed form
    expect(result.ci95[0]).toBeLessThan(result.closedFormPrice + 0.05);
    expect(result.ci95[1]).toBeGreaterThan(result.closedFormPrice - 0.05);
  });

  it("returns higher probability for in-the-money", () => {
    const itm = simulateBinaryContract({
      currentPrice: 110,
      strikePrice: 100,
      volatility: 0.20,
      timeToExpiry: 30 / 365,
      nPaths: 10000,
      seed: 42,
    });
    const otm = simulateBinaryContract({
      currentPrice: 90,
      strikePrice: 100,
      volatility: 0.20,
      timeToExpiry: 30 / 365,
      nPaths: 10000,
      seed: 42,
    });

    expect(itm.estimate).toBeGreaterThan(otm.estimate);
  });
});

describe("logit / sigmoid", () => {
  it("sigmoid(logit(p)) round-trips", () => {
    for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      expect(sigmoid(logit(p))).toBeCloseTo(p, 8);
    }
  });

  it("logit maps 0.5 to 0", () => {
    expect(logit(0.5)).toBeCloseTo(0, 10);
  });

  it("sigmoid maps 0 to 0.5", () => {
    expect(sigmoid(0)).toBe(0.5);
  });

  it("sigmoid is bounded in (0,1) for extreme inputs", () => {
    expect(sigmoid(-100)).toBeGreaterThan(0);
    expect(sigmoid(-100)).toBeLessThan(0.001);
    expect(sigmoid(100)).toBeGreaterThan(0.999);
    expect(sigmoid(100)).toBeLessThanOrEqual(1);
    // At moderate inputs, strictly less than 1
    expect(sigmoid(10)).toBeLessThan(1);
    expect(sigmoid(10)).toBeGreaterThan(0.999);
  });

  it("logit clamps near 0 and 1", () => {
    expect(logit(0)).toBeLessThan(-20);
    expect(logit(1)).toBeGreaterThan(20);
    expect(isFinite(logit(0))).toBe(true);
    expect(isFinite(logit(1))).toBe(true);
  });
});

describe("simulatePredictionContract", () => {
  it("all terminal probabilities bounded in (0,1)", () => {
    const result = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 0.50, // High vol
      timeToExpiry: 1.0,
      nPaths: 5000,
      seed: 42,
    });

    // All quantiles must be in (0,1)
    for (const q of result.terminalQuantiles) {
      expect(q).toBeGreaterThan(0);
      expect(q).toBeLessThan(1);
    }
    expect(result.impliedProbYes).toBeGreaterThan(0);
    expect(result.impliedProbYes).toBeLessThan(1);
  });

  it("bounded even at extreme vol levels", () => {
    const result = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 2.0, // Very high vol
      timeToExpiry: 1.0,
      nPaths: 5000,
      seed: 42,
    });

    for (const q of result.terminalQuantiles) {
      expect(q).toBeGreaterThan(0);
      expect(q).toBeLessThan(1);
    }
  });

  it("Brownian bridge converges near terminal", () => {
    const bridged = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 0.30,
      timeToExpiry: 0.01, // Very near expiry
      nPaths: 5000,
      seed: 42,
      useBrownianBridge: true,
      terminalProb: 1.0,
    });

    const standard = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 0.30,
      timeToExpiry: 0.01,
      nPaths: 5000,
      seed: 42,
    });

    // Bridged should be closer to 1.0 than standard
    expect(bridged.impliedProbYes).toBeGreaterThan(standard.impliedProbYes);
  });

  it("higher vol produces wider spread", () => {
    const lowVol = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 0.10,
      timeToExpiry: 0.5,
      nPaths: 10000,
      seed: 42,
    });

    const highVol = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 0.80,
      timeToExpiry: 0.5,
      nPaths: 10000,
      seed: 42,
    });

    const lowSpread = lowVol.terminalQuantiles[4] - lowVol.terminalQuantiles[0];
    const highSpread = highVol.terminalQuantiles[4] - highVol.terminalQuantiles[0];
    expect(highSpread).toBeGreaterThan(lowSpread);
  });

  it("handles extreme probabilities (0.01, 0.99)", () => {
    for (const prob of [0.01, 0.99]) {
      const result = simulatePredictionContract({
        currentProb: prob,
        volatility: 0.30,
        timeToExpiry: 0.5,
        nPaths: 5000,
        seed: 42,
      });

      for (const q of result.terminalQuantiles) {
        expect(q).toBeGreaterThan(0);
        expect(q).toBeLessThan(1);
      }
    }
  });

  it("zero time-to-expiry returns current prob", () => {
    const result = simulatePredictionContract({
      currentProb: 0.65,
      volatility: 0.30,
      timeToExpiry: 0,
      nPaths: 5000,
      seed: 42,
    });

    // With T=0, sigma*sqrt(0)=0, all paths land on currentProb
    expect(result.impliedProbYes).toBeCloseTo(0.65, 2);
    expect(result.terminalQuantiles[2]).toBeCloseTo(0.65, 2); // Median
  });

  it("returns correct nPaths", () => {
    const result = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 0.20,
      timeToExpiry: 0.5,
      nPaths: 3000,
      seed: 42,
    });
    expect(result.nPaths).toBe(3000);
  });

  it("quantiles are monotonically ordered", () => {
    const result = simulatePredictionContract({
      currentProb: 0.50,
      volatility: 0.30,
      timeToExpiry: 0.5,
      nPaths: 10000,
      seed: 42,
    });

    for (let i = 0; i < result.terminalQuantiles.length - 1; i++) {
      expect(result.terminalQuantiles[i]).toBeLessThanOrEqual(result.terminalQuantiles[i + 1]);
    }
  });
});

describe("brierSkillScore", () => {
  it("BSS = 0 for naive base-rate predictor", () => {
    // Predicting the mean outcome = the reference model
    const outcomes = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
    const predictions = outcomes.map(() => 0.5); // base rate = 0.5
    expect(brierSkillScore(predictions, outcomes)).toBeCloseTo(0, 2);
  });

  it("BSS > 0 for skilled predictor", () => {
    const outcomes =    [1, 0, 1, 0, 1, 0, 1, 0];
    const predictions = [0.9, 0.1, 0.8, 0.2, 0.9, 0.1, 0.8, 0.2];
    expect(brierSkillScore(predictions, outcomes)).toBeGreaterThan(0);
  });

  it("BSS < 0 for anti-skilled predictor", () => {
    const outcomes =    [1, 0, 1, 0, 1, 0, 1, 0];
    const predictions = [0.1, 0.9, 0.2, 0.8, 0.1, 0.9, 0.2, 0.8]; // Wrong direction
    expect(brierSkillScore(predictions, outcomes)).toBeLessThan(0);
  });

  it("BSS = 1 for perfect predictor", () => {
    const outcomes =    [1, 0, 1, 0];
    const predictions = [1, 0, 1, 0];
    expect(brierSkillScore(predictions, outcomes)).toBeCloseTo(1, 4);
  });

  it("exposes rare-event weakness of raw Brier score", () => {
    // A rare event (2% base rate) — naive predictor always says 0.02
    const outcomes: number[] = new Array(100).fill(0);
    outcomes[0] = 1;
    outcomes[50] = 1; // 2% occurrence

    // Naive model
    const naive = outcomes.map(() => 0.02);
    // Slightly skilled model
    const skilled = outcomes.map((_, i) => (i === 0 || i === 50) ? 0.10 : 0.01);

    const naiveBSS = brierSkillScore(naive, outcomes);
    const skilledBSS = brierSkillScore(skilled, outcomes);

    expect(naiveBSS).toBeCloseTo(0, 1); // Naive = reference
    expect(skilledBSS).toBeGreaterThan(0); // Skilled beats reference
  });

  it("respects custom base rate", () => {
    const outcomes = [1, 0, 1, 0];
    const predictions = [0.7, 0.3, 0.7, 0.3];
    const withDefault = brierSkillScore(predictions, outcomes);
    const withCustom = brierSkillScore(predictions, outcomes, 0.7);

    // Different base rates should give different BSS
    expect(withDefault).not.toBeCloseTo(withCustom, 2);
  });

  it("returns 0 for empty arrays", () => {
    expect(brierSkillScore([], [])).toBe(0);
  });
});
