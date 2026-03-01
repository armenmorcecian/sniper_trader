// ─── Monte Carlo Simulation Engine ───────────────────────────────────────────
//
// Core Monte Carlo estimator with variance reduction techniques:
//   - Antithetic variates: free symmetry, ~50-75% variance reduction
//   - Stratified sampling: divide-and-conquer over quantile bands
//   - Importance sampling: make rare events common for tail risk
//
// Also includes:
//   - Brier score for calibration measurement
//   - Binary contract probability estimation via GBM
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MonteCarloConfig {
  /** Number of simulation paths (default: 10000) */
  nPaths: number;
  /** Optional seed for reproducible results */
  seed?: number;
  /** Use antithetic variates for variance reduction (default: true) */
  useAntithetic: boolean;
  /** Use stratified sampling for variance reduction (default: true) */
  useStratified: boolean;
  /** Number of strata for stratified sampling (default: 10) */
  nStrata: number;
}

export interface MonteCarloResult {
  /** Point estimate */
  estimate: number;
  /** Standard error of the estimate */
  stdError: number;
  /** 95% confidence interval */
  ci95: [number, number];
  /** Number of paths used */
  nPaths: number;
  /** Variance reduction factor vs crude MC (if applicable) */
  varianceReduction?: number;
}

export interface ImportanceSamplingConfig {
  nPaths: number;
  /** Shifted distribution mean */
  tiltMean: number;
  /** Shifted distribution std */
  tiltStd: number;
}

// ─── PRNG (Mulberry32 — deterministic, fast) ────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Standard Normal via Box-Muller ─────────────────────────────────────────

function boxMuller(rng: () => number): number {
  let u1: number, u2: number;
  do { u1 = rng(); } while (u1 === 0);
  u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

// ─── Inverse Normal CDF (Rational approximation — Abramowitz & Stegun) ──────

function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  // Rational approximation (Peter Acklam's algorithm)
  const a = [
    -3.969683028665376e+01, 2.209460984245205e+02,
    -2.759285104469687e+02, 1.383577518672690e+02,
    -3.066479806614716e+01, 2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01, 1.615858368580409e+02,
    -1.556989798598866e+02, 6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01,
    -2.400758277161838e+00, -2.549732539343734e+00,
    4.374664141464968e+00, 2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03, 3.224671290700398e-01,
    2.445134137142996e+00, 3.754408661907416e+00,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5]) * q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// ─── Normal CDF (for Black-Scholes reference) ───────────────────────────────

function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

// ─── Sample Generation ──────────────────────────────────────────────────────

/**
 * Generate antithetic normal samples. For each Z_i, we also use -Z_i.
 * Returns n samples (n/2 pairs of Z, -Z).
 */
export function antitheticSamples(n: number, seed?: number): Float64Array {
  const rng = seed != null ? mulberry32(seed) : Math.random;
  const halfN = Math.ceil(n / 2);
  const samples = new Float64Array(n);

  for (let i = 0; i < halfN; i++) {
    const z = boxMuller(rng);
    samples[i] = z;
    if (i + halfN < n) {
      samples[i + halfN] = -z;
    }
  }
  return samples;
}

/**
 * Generate stratified normal samples. Divides [0,1] into `strata` equal bands,
 * draws uniformly within each band, then maps to normal via inverse CDF.
 */
export function stratifiedSamples(
  n: number,
  strata: number = 10,
  seed?: number,
): Float64Array {
  const rng = seed != null ? mulberry32(seed) : Math.random;
  const samplesPerStratum = Math.ceil(n / strata);
  const samples = new Float64Array(n);
  let idx = 0;

  for (let j = 0; j < strata && idx < n; j++) {
    const lower = j / strata;
    const upper = (j + 1) / strata;

    for (let k = 0; k < samplesPerStratum && idx < n; k++) {
      const u = lower + rng() * (upper - lower);
      samples[idx] = inverseNormalCdf(u);
      idx++;
    }
  }
  return samples;
}

// ─── Core Monte Carlo Estimator ─────────────────────────────────────────────

const DEFAULT_CONFIG: MonteCarloConfig = {
  nPaths: 10000,
  useAntithetic: true,
  useStratified: true,
  nStrata: 10,
};

/**
 * General-purpose Monte Carlo estimator with variance reduction.
 *
 * @param payoffFn - Function mapping a standard normal Z to a payoff value
 * @param config   - Simulation configuration
 */
export function monteCarloEstimate(
  payoffFn: (z: number) => number,
  config?: Partial<MonteCarloConfig>,
): MonteCarloResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const n = cfg.nPaths;

  // Generate samples with chosen variance reduction
  let samples: Float64Array;
  if (cfg.useStratified) {
    samples = stratifiedSamples(n, cfg.nStrata, cfg.seed);
  } else if (cfg.useAntithetic) {
    samples = antitheticSamples(n, cfg.seed);
  } else {
    // Crude MC
    const rng = cfg.seed != null ? mulberry32(cfg.seed) : Math.random;
    samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = boxMuller(rng);
    }
  }

  // Evaluate payoffs
  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < n; i++) {
    const payoff = payoffFn(samples[i]);
    sum += payoff;
    sumSq += payoff * payoff;
  }

  const estimate = sum / n;
  const variance = (sumSq / n - estimate * estimate);
  const stdError = Math.sqrt(Math.max(0, variance) / n);

  return {
    estimate: Math.round(estimate * 1e8) / 1e8,
    stdError: Math.round(stdError * 1e8) / 1e8,
    ci95: [
      Math.round((estimate - 1.96 * stdError) * 1e8) / 1e8,
      Math.round((estimate + 1.96 * stdError) * 1e8) / 1e8,
    ],
    nPaths: n,
  };
}

// ─── Importance Sampling for Rare Events ─────────────────────────────────────

/**
 * Importance sampling estimator for tail-risk probabilities.
 * Shifts the sampling distribution to oversample the rare region,
 * then corrects with likelihood ratios.
 *
 * @param payoffFn     - Payoff under original measure (0/1 for binary events)
 * @param originalMean - Mean of the original distribution
 * @param originalStd  - Std of the original distribution
 * @param config       - Tilted distribution parameters
 */
export function importanceSamplingEstimate(
  payoffFn: (z: number) => number,
  originalMean: number,
  originalStd: number,
  config: ImportanceSamplingConfig,
): MonteCarloResult {
  const { nPaths, tiltMean, tiltStd } = config;
  const rng = Math.random;

  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < nPaths; i++) {
    // Sample from tilted distribution
    const z = boxMuller(rng);
    const x = tiltMean + tiltStd * z;

    // Likelihood ratio: original density / tilted density
    const logOriginal = -0.5 * ((x - originalMean) / originalStd) ** 2 - Math.log(originalStd);
    const logTilted = -0.5 * ((x - tiltMean) / tiltStd) ** 2 - Math.log(tiltStd);
    const lr = Math.exp(logOriginal - logTilted);

    // Weighted payoff
    const payoff = payoffFn(x) * lr;
    sum += payoff;
    sumSq += payoff * payoff;
  }

  const estimate = sum / nPaths;
  const variance = sumSq / nPaths - estimate * estimate;
  const stdError = Math.sqrt(Math.max(0, variance) / nPaths);

  return {
    estimate: Math.round(estimate * 1e8) / 1e8,
    stdError: Math.round(stdError * 1e8) / 1e8,
    ci95: [
      Math.round((estimate - 1.96 * stdError) * 1e8) / 1e8,
      Math.round((estimate + 1.96 * stdError) * 1e8) / 1e8,
    ],
    nPaths,
  };
}

// ─── Brier Score ─────────────────────────────────────────────────────────────

/**
 * Brier score: mean squared error between predicted probabilities and outcomes.
 *   BS = (1/N) × Σ (p_i − o_i)²
 *
 * Lower is better: 0 = perfect, 0.25 = always predict 0.5
 * Below 0.10 is excellent calibration.
 */
export function brierScore(predictions: number[], outcomes: number[]): number {
  const n = Math.min(predictions.length, outcomes.length);
  if (n === 0) return 0;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (predictions[i] - outcomes[i]) ** 2;
  }
  return Math.round((sum / n) * 10000) / 10000;
}

// ─── Binary Contract Simulation (GBM) ───────────────────────────────────────

/**
 * Estimate probability that an asset-linked binary contract pays off.
 * Uses Geometric Brownian Motion for terminal price distribution.
 *
 * The closed-form Black-Scholes digital price is:
 *   P = N(d2) where d2 = (ln(S/K) + (μ - σ²/2)T) / (σ√T)
 *
 * MC should converge to this within the confidence interval.
 */
export function simulateBinaryContract(params: {
  currentPrice: number;
  strikePrice: number;
  volatility: number;
  timeToExpiry: number;
  drift?: number;
  nPaths?: number;
  seed?: number;
}): MonteCarloResult & { closedFormPrice: number } {
  const {
    currentPrice: S0,
    strikePrice: K,
    volatility: sigma,
    timeToExpiry: T,
    drift: mu = 0.08,
    nPaths = 10000,
    seed,
  } = params;

  // Closed-form Black-Scholes digital price
  const d2 = (Math.log(S0 / K) + (mu - 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const closedFormPrice = normalCdf(d2);

  // MC simulation with variance reduction
  const payoffFn = (z: number): number => {
    const sT = S0 * Math.exp((mu - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * z);
    return sT > K ? 1 : 0;
  };

  const result = monteCarloEstimate(payoffFn, {
    nPaths,
    useAntithetic: true,
    useStratified: true,
    seed,
  });

  return {
    ...result,
    closedFormPrice: Math.round(closedFormPrice * 1e6) / 1e6,
  };
}
