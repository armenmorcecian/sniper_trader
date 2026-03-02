/**
 * Shared test helpers for quant-core test suite.
 * Provides seeded random data generators for consistent, reproducible tests.
 */

/** Simple seeded PRNG (Mulberry32) for reproducible test data */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform using seeded PRNG */
function seededRandn(rng: () => number): number {
  let u1: number;
  do { u1 = rng(); } while (u1 === 0);
  const u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

function logit(p: number): number {
  const clamped = Math.max(1e-10, Math.min(1 - 1e-10, p));
  return Math.log(clamped / (1 - clamped));
}

function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

/**
 * Generate synthetic prediction market prices using a seeded logit random walk.
 * Produces consistent data across test runs for the same seed.
 *
 * @param opts.nSteps     - Number of price observations to generate
 * @param opts.startProb  - Starting probability (default: 0.50)
 * @param opts.processVol - Volatility of the logit random walk (default: 0.03)
 * @param opts.obsNoise   - Observation noise std (default: 0.02)
 * @param opts.seed       - PRNG seed for reproducibility (default: 42)
 */
export function generateSyntheticPrices(opts: {
  nSteps: number;
  startProb?: number;
  processVol?: number;
  obsNoise?: number;
  seed?: number;
}): number[] {
  const {
    nSteps,
    startProb = 0.50,
    processVol = 0.03,
    obsNoise = 0.02,
    seed = 42,
  } = opts;

  const rng = mulberry32(seed);
  const prices: number[] = [];
  let logitState = logit(startProb);

  for (let i = 0; i < nSteps; i++) {
    // State transition (logit random walk)
    logitState += seededRandn(rng) * processVol;

    // Observation = sigmoid(state) + noise
    const trueProb = sigmoid(logitState);
    const noise = seededRandn(rng) * obsNoise;
    const observed = Math.max(0.001, Math.min(0.999, trueProb + noise));
    prices.push(Math.round(observed * 10000) / 10000);
  }

  return prices;
}
