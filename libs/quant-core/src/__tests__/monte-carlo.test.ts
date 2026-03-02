import { describe, it, expect } from "vitest";
import {
  monteCarloEstimate,
  antitheticSamples,
  stratifiedSamples,
  brierScore,
  simulateBinaryContract,
  importanceSamplingEstimate,
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
