// ─── Copula Models for Correlated Prediction Markets ─────────────────────────
//
// Models joint dependency structures between correlated prediction market
// contracts. Critical for portfolio risk when trading multiple markets.
//
// Implements:
//   - Gaussian copula (baseline — NO tail dependence, λ_U = λ_L = 0)
//   - Student-t copula (symmetric tail dependence — 2-5x more extreme co-movement)
//   - Clayton copula (lower tail dependence — crash correlation)
//
// Why this matters:
//   Gaussian copula failure in 2008 showed that modeling extreme co-movements
//   with zero tail dependence is catastrophically wrong. For prediction market
//   portfolios, the t-copula shows 2-5x higher probability of joint extreme
//   outcomes than Gaussian.
//
//   IMPORTANT: Static t-copula parameters (degrees of freedom) suffer the same
//   estimation weakness as Gaussian — they don't adapt to changing regimes.
//   Use calibrateCopulaDf() for production to estimate df from observed data.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CopulaResult {
  /** N x d matrix of correlated binary outcomes */
  jointOutcomes: number[][];
  /** P(all markets resolve the same way) */
  sweepProbability: number;
  /** Tail dependence coefficients */
  tailDependence: { upper: number; lower: number };
}

export interface PortfolioRisk {
  /** Expected P&L across the portfolio */
  expectedPnl: number;
  /** Variance of portfolio P&L */
  pnlVariance: number;
  /** How much correlation increases risk vs independent assumption */
  correlationImpact: number;
  /** P(all positions lose simultaneously) */
  worstCaseJoint: number;
  /** Risk reduction from diversification (vs concentrated single position) */
  diversificationBenefit: number;
}

// ─── Math Helpers ────────────────────────────────────────────────────────────

/** Box-Muller normal */
function randn(): number {
  let u1: number;
  do { u1 = Math.random(); } while (u1 === 0);
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * Math.random());
}

/** Normal CDF (Abramowitz & Stegun) */
function normalCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x));
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Student-t CDF approximation using the incomplete beta function relation.
 * For small ν (3-10), this provides adequate accuracy for copula thresholds.
 */
function studentTCdf(x: number, nu: number): number {
  // Use normal CDF approximation adjusted for fat tails
  // Cornish-Fisher approximation: maps t to approximately normal
  const g1 = 1 / (4 * nu);
  const g2 = 1 / (2 * nu);
  const z = x * (1 - g1 * (x * x - 3) / 6 - g2);
  return normalCdf(z);
}

/** Cholesky decomposition of a symmetric positive-definite matrix */
function cholesky(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }
      if (i === j) {
        const diag = matrix[i][i] - sum;
        L[i][j] = diag > 0 ? Math.sqrt(diag) : 1e-10;
      } else {
        L[i][j] = (matrix[i][j] - sum) / L[j][j];
      }
    }
  }
  return L;
}

// ─── Gaussian Copula ────────────────────────────────────────────────────────

/**
 * Gaussian copula — NO tail dependence (λ_U = λ_L = 0).
 * This is the baseline: underestimates extreme co-movements.
 */
export function gaussianCopula(
  probs: number[],
  corrMatrix: number[][],
  nSamples: number = 100000,
): CopulaResult {
  const d = probs.length;
  const L = cholesky(corrMatrix);

  const jointOutcomes: number[][] = [];
  let sweepYes = 0;
  let sweepNo = 0;

  for (let s = 0; s < nSamples; s++) {
    // Generate correlated normals
    const z: number[] = new Array(d);
    const indep: number[] = new Array(d);
    for (let i = 0; i < d; i++) indep[i] = randn();

    for (let i = 0; i < d; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += L[i][j] * indep[j];
      z[i] = sum;
    }

    // Map to uniform via normal CDF, then to binary outcomes
    const outcomes: number[] = new Array(d);
    for (let i = 0; i < d; i++) {
      const u = normalCdf(z[i]);
      outcomes[i] = u < probs[i] ? 1 : 0;
    }

    jointOutcomes.push(outcomes);

    if (outcomes.every(o => o === 1)) sweepYes++;
    if (outcomes.every(o => o === 0)) sweepNo++;
  }

  return {
    jointOutcomes,
    sweepProbability: (sweepYes + sweepNo) / nSamples,
    tailDependence: { upper: 0, lower: 0 }, // Gaussian: always zero
  };
}

// ─── Student-t Copula ───────────────────────────────────────────────────────

/**
 * Student-t copula — symmetric tail dependence.
 * With ν=4 and ρ=0.6, tail dependence ≈ 0.18 (18% probability of
 * extreme co-movement given one contract hits an extreme).
 *
 * @param degreesOfFreedom - Lower ν → fatter tails → more tail dependence
 */
export function tCopula(
  probs: number[],
  corrMatrix: number[][],
  degreesOfFreedom: number = 4,
  nSamples: number = 100000,
): CopulaResult {
  const d = probs.length;
  const nu = degreesOfFreedom;
  const L = cholesky(corrMatrix);

  const jointOutcomes: number[][] = [];
  let sweepYes = 0;
  let sweepNo = 0;

  for (let s = 0; s < nSamples; s++) {
    // Generate correlated normals
    const indep: number[] = new Array(d);
    for (let i = 0; i < d; i++) indep[i] = randn();

    const x: number[] = new Array(d);
    for (let i = 0; i < d; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += L[i][j] * indep[j];
      x[i] = sum;
    }

    // Divide by sqrt(chi-squared / nu) to get t-distributed
    // Chi-squared(nu) = sum of nu standard normals squared
    let chiSq = 0;
    for (let k = 0; k < nu; k++) {
      const z = randn();
      chiSq += z * z;
    }
    const scale = Math.sqrt(chiSq / nu);

    // Map to uniform via t-CDF, then to binary outcomes
    const outcomes: number[] = new Array(d);
    for (let i = 0; i < d; i++) {
      const t = x[i] / scale;
      const u = studentTCdf(t, nu);
      outcomes[i] = u < probs[i] ? 1 : 0;
    }

    jointOutcomes.push(outcomes);

    if (outcomes.every(o => o === 1)) sweepYes++;
    if (outcomes.every(o => o === 0)) sweepNo++;
  }

  // Compute theoretical tail dependence for t-copula
  // λ = 2 * t_{ν+1}(-√((ν+1)(1-ρ)/(1+ρ)))
  // Use average correlation for a scalar approximation
  let sumCorr = 0, countCorr = 0;
  for (let i = 0; i < d; i++) {
    for (let j = i + 1; j < d; j++) {
      sumCorr += corrMatrix[i][j];
      countCorr++;
    }
  }
  const avgCorr = countCorr > 0 ? sumCorr / countCorr : 0;
  const tdArg = -Math.sqrt((nu + 1) * (1 - avgCorr) / (1 + avgCorr));
  const tailDep = 2 * studentTCdf(tdArg, nu + 1);

  return {
    jointOutcomes,
    sweepProbability: (sweepYes + sweepNo) / nSamples,
    tailDependence: {
      upper: Math.round(tailDep * 10000) / 10000,
      lower: Math.round(tailDep * 10000) / 10000, // Symmetric for t-copula
    },
  };
}

// ─── Clayton Copula ─────────────────────────────────────────────────────────

/**
 * Clayton copula — LOWER tail dependence only (λ_L = 2^{-1/θ}).
 * Models crash correlation: when one market crashes, others follow.
 * No upper tail dependence (correlated positive resolutions not modeled).
 */
export function claytonCopula(
  probs: number[],
  theta: number = 2.0,
  nSamples: number = 100000,
): CopulaResult {
  const d = probs.length;

  const jointOutcomes: number[][] = [];
  let sweepYes = 0;
  let sweepNo = 0;

  for (let s = 0; s < nSamples; s++) {
    // Marshall-Olkin algorithm for Clayton copula
    // V ~ Gamma(1/θ, 1), E_i ~ Exp(1), U_i = (1 + E_i/V)^{-1/θ}
    const v = gammaRandom(1 / theta, 1);

    const outcomes: number[] = new Array(d);
    for (let i = 0; i < d; i++) {
      const e = -Math.log(Math.random()); // Exp(1)
      const u = Math.pow(1 + e / v, -1 / theta);
      outcomes[i] = u < probs[i] ? 1 : 0;
    }

    jointOutcomes.push(outcomes);

    if (outcomes.every(o => o === 1)) sweepYes++;
    if (outcomes.every(o => o === 0)) sweepNo++;
  }

  const lowerTailDep = Math.pow(2, -1 / theta);

  return {
    jointOutcomes,
    sweepProbability: (sweepYes + sweepNo) / nSamples,
    tailDependence: {
      upper: 0,
      lower: Math.round(lowerTailDep * 10000) / 10000,
    },
  };
}

/** Gamma random variable via Marsaglia and Tsang's method */
function gammaRandom(shape: number, scale: number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^{1/a}
    return gammaRandom(shape + 1, scale) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x: number, v: number;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

// ─── Correlation Utilities ──────────────────────────────────────────────────

/**
 * Kendall's tau rank correlation (more robust than Pearson for copula selection).
 * Counts concordant vs discordant pairs.
 */
export function kendallTau(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  let concordant = 0;
  let discordant = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const aDiff = a[i] - a[j];
      const bDiff = b[i] - b[j];
      const product = aDiff * bDiff;
      if (product > 0) concordant++;
      else if (product < 0) discordant++;
      // Ties are excluded
    }
  }

  const totalPairs = (n * (n - 1)) / 2;
  return totalPairs > 0 ? (concordant - discordant) / totalPairs : 0;
}

/**
 * Build a correlation matrix from multiple price history arrays.
 * Uses Pearson correlation (imported from math.ts via local computation).
 */
export function buildCorrelationMatrix(priceHistories: number[][]): number[][] {
  const d = priceHistories.length;
  const matrix: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));

  for (let i = 0; i < d; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < d; j++) {
      const corr = pearsonR(priceHistories[i], priceHistories[j]);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }
  return matrix;
}

/** Local Pearson r (avoids circular import) */
function pearsonR(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]; sumB += b[i];
    sumAB += a[i] * b[i];
    sumA2 += a[i] * a[i]; sumB2 += b[i] * b[i];
  }
  const denom = Math.sqrt((n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB));
  if (denom === 0) return 0;
  return (n * sumAB - sumA * sumB) / denom;
}

// ─── Copula Degrees-of-Freedom Calibration ──────────────────────────────────

/**
 * Estimate optimal t-copula degrees of freedom from price histories.
 * Compares theoretical tail dependence at each candidate df against empirical
 * joint tail frequencies from rolling windows.
 *
 * @param priceHistories - Array of price series (one per market)
 * @param windowSize     - Rolling window size (default: 20)
 * @returns Optimal degrees of freedom (integer, range 2-30)
 */
export function calibrateCopulaDf(
  priceHistories: number[][],
  windowSize: number = 20,
): number {
  const d = priceHistories.length;
  if (d < 2) return 4;

  const minLen = Math.min(...priceHistories.map(h => h.length));
  if (minLen < windowSize + 5) return 4;

  // Compute returns
  const returns: number[][] = priceHistories.map(h => {
    const r: number[] = [];
    for (let i = 1; i < minLen; i++) {
      r.push(h[i] - h[i - 1]);
    }
    return r;
  });

  // Empirical joint tail frequency via rolling windows
  const tailThreshold = 0.10;
  let jointTailCount = 0;
  let totalWindows = 0;

  for (let start = 0; start <= returns[0].length - windowSize; start++) {
    totalWindows++;

    const inTail: boolean[] = new Array(d);
    for (let m = 0; m < d; m++) {
      const windowReturns = returns[m].slice(start, start + windowSize);
      const sorted = [...windowReturns].sort((a, b) => a - b);
      const cutoff = sorted[Math.floor(windowSize * tailThreshold)];
      inTail[m] = returns[m][start + windowSize - 1] <= cutoff;
    }

    if (inTail.every(x => x)) {
      jointTailCount++;
    }
  }

  const empiricalTailFreq = totalWindows > 0 ? jointTailCount / totalWindows : 0;

  // Average pairwise correlation
  const corrMatrix = buildCorrelationMatrix(
    priceHistories.map(h => h.slice(0, minLen)),
  );
  let sumCorr = 0, countCorr = 0;
  for (let i = 0; i < d; i++) {
    for (let j = i + 1; j < d; j++) {
      sumCorr += corrMatrix[i][j];
      countCorr++;
    }
  }
  const avgCorr = countCorr > 0 ? sumCorr / countCorr : 0;

  // Grid search: find df that best matches empirical tail frequency
  const dfCandidates = [2, 3, 4, 5, 6, 8, 10, 15, 20, 30];
  let bestDf = 4;
  let bestError = Infinity;

  for (const nu of dfCandidates) {
    const rhoClamp = Math.max(avgCorr, 0.001);
    const tdArg = -Math.sqrt((nu + 1) * (1 - rhoClamp) / (1 + rhoClamp));
    const theoreticalTailDep = 2 * studentTCdf(tdArg, nu + 1);
    const theoreticalJointTail = Math.pow(theoreticalTailDep, d - 1) * tailThreshold;

    const error = Math.abs(theoreticalJointTail - empiricalTailFreq);
    if (error < bestError) {
      bestError = error;
      bestDf = nu;
    }
  }

  return bestDf;
}

// ─── Portfolio Risk Assessment ──────────────────────────────────────────────

/**
 * Assess portfolio-level risk using copula-based dependency modeling.
 *
 * Compares risk under the chosen copula vs independent assumption
 * to quantify the "correlation premium" — how much worse the portfolio
 * can behave than a naive diversification analysis would suggest.
 */
export function assessPortfolioRisk(
  positions: Array<{ prob: number; size: number; expectedPnl: number }>,
  corrMatrix: number[][],
  copulaType: "gaussian" | "t" | "clayton" = "t",
  degreesOfFreedom?: number,
): PortfolioRisk {
  const d = positions.length;
  if (d === 0) {
    return { expectedPnl: 0, pnlVariance: 0, correlationImpact: 0, worstCaseJoint: 0, diversificationBenefit: 0 };
  }

  const probs = positions.map(p => p.prob);
  const nSamples = 50000;

  // Simulate under chosen copula
  let copulaResult: CopulaResult;
  if (copulaType === "gaussian") {
    copulaResult = gaussianCopula(probs, corrMatrix, nSamples);
  } else if (copulaType === "clayton") {
    copulaResult = claytonCopula(probs, undefined, nSamples);
  } else {
    copulaResult = tCopula(probs, corrMatrix, degreesOfFreedom ?? 4, nSamples);
  }

  // Compute portfolio P&L distribution
  const pnls: number[] = [];
  let loseAllCount = 0;

  for (const outcomes of copulaResult.jointOutcomes) {
    let portfolioPnl = 0;
    let allLose = true;
    for (let i = 0; i < d; i++) {
      // If outcome matches our position direction, we profit
      portfolioPnl += outcomes[i] === 1
        ? positions[i].expectedPnl
        : -positions[i].size; // Loss = position size
      if (outcomes[i] === 1) allLose = false;
    }
    pnls.push(portfolioPnl);
    if (allLose) loseAllCount++;
  }

  const expectedPnl = pnls.reduce((s, p) => s + p, 0) / nSamples;
  const pnlVariance = pnls.reduce((s, p) => s + (p - expectedPnl) ** 2, 0) / nSamples;

  // Compare with independent assumption
  const independentLoseAll = positions.reduce((p, pos) => p * (1 - pos.prob), 1);
  const copulaLoseAll = loseAllCount / nSamples;
  const correlationImpact = independentLoseAll > 0
    ? copulaLoseAll / independentLoseAll
    : 0;

  // Diversification benefit: risk of portfolio vs sum of individual risks
  const totalIndividualRisk = positions.reduce((s, p) => s + p.size * (1 - p.prob), 0);
  const portfolioRisk = Math.sqrt(pnlVariance);
  const diversificationBenefit = totalIndividualRisk > 0
    ? 1 - portfolioRisk / totalIndividualRisk
    : 0;

  return {
    expectedPnl: Math.round(expectedPnl * 10000) / 10000,
    pnlVariance: Math.round(pnlVariance * 10000) / 10000,
    correlationImpact: Math.round(correlationImpact * 100) / 100,
    worstCaseJoint: Math.round(copulaLoseAll * 10000) / 10000,
    diversificationBenefit: Math.round(diversificationBenefit * 10000) / 10000,
  };
}
