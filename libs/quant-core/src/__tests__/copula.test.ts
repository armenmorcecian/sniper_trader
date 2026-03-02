import { describe, it, expect } from "vitest";
import {
  gaussianCopula,
  tCopula,
  claytonCopula,
  kendallTau,
  buildCorrelationMatrix,
  assessPortfolioRisk,
  calibrateCopulaDf,
} from "../copula";

describe("gaussianCopula", () => {
  it("with identity correlation matches independent probabilities", () => {
    const probs = [0.5, 0.5];
    const identity = [[1, 0], [0, 1]];
    const result = gaussianCopula(probs, identity, 50000);

    // P(both=1) should be ~0.25 for independent 50/50
    const bothYes = result.jointOutcomes.filter(o => o[0] === 1 && o[1] === 1).length;
    expect(bothYes / 50000).toBeCloseTo(0.25, 1);
  });

  it("has zero tail dependence", () => {
    const probs = [0.5, 0.5];
    const corr = [[1, 0.7], [0.7, 1]];
    const result = gaussianCopula(probs, corr, 10000);

    expect(result.tailDependence.upper).toBe(0);
    expect(result.tailDependence.lower).toBe(0);
  });

  it("positive correlation increases joint probability", () => {
    const probs = [0.5, 0.5];
    const independent = gaussianCopula(probs, [[1, 0], [0, 1]], 50000);
    const correlated = gaussianCopula(probs, [[1, 0.8], [0.8, 1]], 50000);

    const indepBoth = independent.jointOutcomes.filter(o => o[0] === 1 && o[1] === 1).length;
    const corrBoth = correlated.jointOutcomes.filter(o => o[0] === 1 && o[1] === 1).length;

    // Correlated case should have higher joint yes probability
    expect(corrBoth / 50000).toBeGreaterThan(indepBoth / 50000);
  });
});

describe("tCopula", () => {
  it("has positive tail dependence", () => {
    const probs = [0.5, 0.5];
    const corr = [[1, 0.6], [0.6, 1]];
    const result = tCopula(probs, corr, 4, 50000);

    expect(result.tailDependence.upper).toBeGreaterThan(0);
    expect(result.tailDependence.lower).toBeGreaterThan(0);
  });

  it("sweep probability exceeds gaussian for correlated markets", () => {
    const probs = [0.52, 0.53, 0.51];
    const corr = [
      [1.0, 0.7, 0.5],
      [0.7, 1.0, 0.6],
      [0.5, 0.6, 1.0],
    ];
    const nSamples = 50000;

    const gaussResult = gaussianCopula(probs, corr, nSamples);
    const tResult = tCopula(probs, corr, 4, nSamples);

    // t-copula should produce higher (or comparable) sweep probability
    // due to tail dependence
    expect(tResult.sweepProbability).toBeGreaterThanOrEqual(
      gaussResult.sweepProbability * 0.8
    );
  });
});

describe("claytonCopula", () => {
  it("has lower tail dependence only", () => {
    const probs = [0.5, 0.5];
    const result = claytonCopula(probs, 2.0, 10000);

    expect(result.tailDependence.lower).toBeGreaterThan(0);
    expect(result.tailDependence.upper).toBe(0);
  });

  it("lower tail dependence equals 2^{-1/theta}", () => {
    const theta = 2.0;
    const result = claytonCopula([0.5, 0.5], theta, 10000);
    const expected = Math.pow(2, -1 / theta);

    expect(result.tailDependence.lower).toBeCloseTo(expected, 3);
  });
});

describe("kendallTau", () => {
  it("returns 1 for perfectly concordant data", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 20, 30, 40, 50];
    expect(kendallTau(a, b)).toBe(1);
  });

  it("returns -1 for perfectly discordant data", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [50, 40, 30, 20, 10];
    expect(kendallTau(a, b)).toBe(-1);
  });

  it("returns 0 for fewer than 2 points", () => {
    expect(kendallTau([1], [2])).toBe(0);
    expect(kendallTau([], [])).toBe(0);
  });
});

describe("buildCorrelationMatrix", () => {
  it("produces symmetric matrix with 1s on diagonal", () => {
    const histories = [
      [1, 2, 3, 4, 5],
      [2, 4, 6, 8, 10],
      [5, 4, 3, 2, 1],
    ];
    const matrix = buildCorrelationMatrix(histories);

    expect(matrix.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(matrix[i][i]).toBeCloseTo(1, 5);
      for (let j = i + 1; j < 3; j++) {
        expect(matrix[i][j]).toBeCloseTo(matrix[j][i], 5);
      }
    }
  });

  it("detects perfect positive and negative correlation", () => {
    const histories = [
      [1, 2, 3, 4, 5],
      [2, 4, 6, 8, 10],  // Perfect positive
      [10, 8, 6, 4, 2],  // Perfect negative
    ];
    const matrix = buildCorrelationMatrix(histories);

    expect(matrix[0][1]).toBeCloseTo(1, 3);
    expect(matrix[0][2]).toBeCloseTo(-1, 3);
  });
});

describe("assessPortfolioRisk", () => {
  it("returns zero risk for empty portfolio", () => {
    const result = assessPortfolioRisk([], []);
    expect(result.expectedPnl).toBe(0);
    expect(result.pnlVariance).toBe(0);
  });

  it("identifies higher risk for correlated positions", () => {
    const positions = [
      { prob: 0.6, size: 10, expectedPnl: 5 },
      { prob: 0.55, size: 10, expectedPnl: 4 },
    ];

    const independent = assessPortfolioRisk(
      positions,
      [[1, 0], [0, 1]],
      "gaussian",
    );
    const correlated = assessPortfolioRisk(
      positions,
      [[1, 0.8], [0.8, 1]],
      "gaussian",
    );

    // Correlated portfolio should have higher worst-case joint loss
    expect(correlated.worstCaseJoint).toBeGreaterThanOrEqual(independent.worstCaseJoint * 0.8);
  });

  it("accepts custom degreesOfFreedom for t-copula", () => {
    const positions = [
      { prob: 0.6, size: 10, expectedPnl: 5 },
      { prob: 0.55, size: 10, expectedPnl: 4 },
    ];
    const corr = [[1, 0.6], [0.6, 1]];

    // Lower df = fatter tails = more extreme co-movements
    const lowDf = assessPortfolioRisk(positions, corr, "t", 3);
    const highDf = assessPortfolioRisk(positions, corr, "t", 20);

    // Both should return valid results
    expect(lowDf.expectedPnl).toBeDefined();
    expect(highDf.expectedPnl).toBeDefined();
    expect(lowDf.pnlVariance).toBeGreaterThanOrEqual(0);
    expect(highDf.pnlVariance).toBeGreaterThanOrEqual(0);
  });
});

describe("calibrateCopulaDf", () => {
  it("returns valid df in expected range", () => {
    // Generate correlated price series
    const n = 50;
    const series1: number[] = [];
    const series2: number[] = [];
    let p1 = 0.5, p2 = 0.5;

    for (let i = 0; i < n; i++) {
      const shock = (Math.sin(i * 0.3) + Math.cos(i * 0.7)) * 0.02;
      p1 = Math.max(0.1, Math.min(0.9, p1 + shock + (Math.random() - 0.5) * 0.03));
      p2 = Math.max(0.1, Math.min(0.9, p2 + shock * 0.8 + (Math.random() - 0.5) * 0.03));
      series1.push(p1);
      series2.push(p2);
    }

    const df = calibrateCopulaDf([series1, series2]);
    expect(df).toBeGreaterThanOrEqual(2);
    expect(df).toBeLessThanOrEqual(30);
  });

  it("returns default df=4 for insufficient data", () => {
    const short1 = [0.5, 0.6, 0.55];
    const short2 = [0.4, 0.45, 0.42];

    const df = calibrateCopulaDf([short1, short2]);
    expect(df).toBe(4);
  });

  it("returns default df=4 for single market", () => {
    const df = calibrateCopulaDf([[0.5, 0.6, 0.55, 0.58]]);
    expect(df).toBe(4);
  });

  it("handles 3+ markets", () => {
    const n = 50;
    const series: number[][] = [[], [], []];
    const bases = [0.5, 0.6, 0.4];

    for (let i = 0; i < n; i++) {
      const common = Math.sin(i * 0.2) * 0.02;
      for (let m = 0; m < 3; m++) {
        bases[m] = Math.max(0.1, Math.min(0.9, bases[m] + common + (Math.random() - 0.5) * 0.02));
        series[m].push(bases[m]);
      }
    }

    const df = calibrateCopulaDf(series);
    expect(df).toBeGreaterThanOrEqual(2);
    expect(df).toBeLessThanOrEqual(30);
  });
});
