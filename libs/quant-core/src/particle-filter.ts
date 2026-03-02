// ─── Particle Filter for Prediction Market Probability Estimation ────────────
//
// Sequential Monte Carlo (SMC) filter that tracks the hidden "true" probability
// of an event by processing noisy market observations.
//
// State-space model:
//   Hidden state x_t: true probability (unobserved), modeled as logit random walk
//   Observation y_t: market price (noisy reading of true probability)
//
// The filter maintains N particles, each a hypothesis about the true probability.
// As new observations arrive, particles are propagated, reweighted, and
// resampled — producing a filtered probability estimate that:
//   - Smooths noisy price fluctuations
//   - Propagates uncertainty via credible intervals
//   - Detects edge: when |filtered - observed| exceeds noise threshold
//
// Operates in logit space: logit(p) = ln(p/(1-p)) to keep probabilities in (0,1).
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParticleFilterConfig {
  /** Number of particles (default: 2000) */
  nParticles: number;
  /** State transition volatility in logit space (default: 0.03) */
  processVol: number;
  /** Observation noise std in probability space (default: 0.02) */
  obsNoise: number;
  /** Initial probability estimate (default: 0.50) */
  priorProb: number;
  /** ISO timestamp when the market expires (optional — enables near-expiry vol scaling) */
  expiryTime?: string;
  /** Minimum vol fraction near expiry, 0-1 (default: 0.1 = 10% of processVol) */
  minVolFraction?: number;
}

export interface ParticleFilterState {
  logitParticles: number[];
  weights: number[];
  history: number[];
  observationCount: number;
}

export interface FilterEstimate {
  /** Weighted mean probability estimate */
  filteredProb: number;
  /** 95% credible interval */
  ci95: [number, number];
  /** Effective sample size (1 = degenerate, N = uniform) */
  ess: number;
  /** |filtered - observed| — high values suggest edge */
  divergence: number;
}

// ─── Math Helpers ────────────────────────────────────────────────────────────

function logit(p: number): number {
  const clamped = Math.max(1e-10, Math.min(1 - 1e-10, p));
  return Math.log(clamped / (1 - clamped));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    return 1 / (1 + Math.exp(-x));
  }
  const ex = Math.exp(x);
  return ex / (1 + ex);
}

/** Box-Muller normal RNG */
function randn(): number {
  let u1: number;
  do { u1 = Math.random(); } while (u1 === 0);
  const u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

// ─── Particle Filter Class ──────────────────────────────────────────────────

const DEFAULT_CONFIG: ParticleFilterConfig = {
  nParticles: 2000,
  processVol: 0.03,
  obsNoise: 0.02,
  priorProb: 0.50,
};

export class PredictionMarketParticleFilter {
  private config: ParticleFilterConfig;
  private logitParticles: Float64Array;
  private weights: Float64Array;
  private _history: number[];
  private _observationCount: number;
  private _lastObserved: number;

  constructor(config?: Partial<ParticleFilterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const N = this.config.nParticles;

    // Initialize particles around prior in logit space
    const logitPrior = logit(this.config.priorProb);
    this.logitParticles = new Float64Array(N);
    this.weights = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      this.logitParticles[i] = logitPrior + randn() * 0.5;
      this.weights[i] = 1 / N;
    }

    this._history = [];
    this._observationCount = 0;
    this._lastObserved = this.config.priorProb;
  }

  /**
   * Incorporate a new observation (market price) and return updated estimate.
   */
  update(observedPrice: number, currentTime?: string): FilterEstimate {
    const N = this.config.nParticles;
    const { obsNoise } = this.config;
    let effectiveVol = this.config.processVol;
    this._lastObserved = observedPrice;
    this._observationCount++;

    // Near-expiry vol scaling: linearly reduce processVol as expiry approaches
    if (currentTime && this.config.expiryTime) {
      const now = new Date(currentTime).getTime();
      const expiry = new Date(this.config.expiryTime).getTime();
      const hoursToExpiry = (expiry - now) / (1000 * 60 * 60);

      if (hoursToExpiry > 0 && hoursToExpiry < 24) {
        const minFrac = this.config.minVolFraction ?? 0.1;
        const scale = minFrac + (1 - minFrac) * (hoursToExpiry / 24);
        effectiveVol = this.config.processVol * scale;
      }
    }

    // 1. Propagate: random walk in logit space
    for (let i = 0; i < N; i++) {
      this.logitParticles[i] += randn() * effectiveVol;
    }

    // 2. Reweight: likelihood of observation given each particle
    let maxLogW = -Infinity;
    const logWeights = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      const probParticle = sigmoid(this.logitParticles[i]);
      const logLik = -0.5 * ((observedPrice - probParticle) / obsNoise) ** 2;
      logWeights[i] = Math.log(this.weights[i] + 1e-300) + logLik;
      if (logWeights[i] > maxLogW) maxLogW = logWeights[i];
    }

    // Normalize in log space for numerical stability
    let sumW = 0;
    for (let i = 0; i < N; i++) {
      this.weights[i] = Math.exp(logWeights[i] - maxLogW);
      sumW += this.weights[i];
    }
    for (let i = 0; i < N; i++) {
      this.weights[i] /= sumW;
    }

    // 3. Check ESS and resample if needed
    const ess = this.computeEss();
    if (ess < N / 2) {
      this.systematicResample();
    }

    const est = this.estimate();
    this._history.push(est.filteredProb);
    return est;
  }

  /**
   * Current estimate without processing a new observation.
   */
  estimate(): FilterEstimate {
    const N = this.config.nParticles;
    let weightedSum = 0;

    for (let i = 0; i < N; i++) {
      weightedSum += this.weights[i] * sigmoid(this.logitParticles[i]);
    }

    const ci = this.credibleInterval();
    const ess = this.computeEss();
    const divergence = Math.abs(weightedSum - this._lastObserved);

    return {
      filteredProb: Math.round(weightedSum * 10000) / 10000,
      ci95: ci,
      ess: Math.round(ess),
      divergence: Math.round(divergence * 10000) / 10000,
    };
  }

  /**
   * Get the history of filtered probability estimates.
   */
  get history(): number[] {
    return [...this._history];
  }

  /**
   * Get total observations processed.
   */
  get observationCount(): number {
    return this._observationCount;
  }

  // ─── Serialization ──────────────────────────────────────────────────────

  /**
   * Serialize filter state for persistence (JSON/SQLite).
   */
  serialize(): ParticleFilterState {
    return {
      logitParticles: Array.from(this.logitParticles),
      weights: Array.from(this.weights),
      history: [...this._history],
      observationCount: this._observationCount,
    };
  }

  /**
   * Reconstruct a filter from serialized state.
   */
  static deserialize(
    state: ParticleFilterState,
    config?: Partial<ParticleFilterConfig>,
  ): PredictionMarketParticleFilter {
    const cfg = { ...DEFAULT_CONFIG, ...config, nParticles: state.logitParticles.length };
    const pf = new PredictionMarketParticleFilter(cfg);

    pf.logitParticles = Float64Array.from(state.logitParticles);
    pf.weights = Float64Array.from(state.weights);
    pf._history = [...state.history];
    pf._observationCount = state.observationCount;
    if (state.history.length > 0) {
      pf._lastObserved = state.history[state.history.length - 1];
    }

    return pf;
  }

  // ─── Marginal Likelihood ─────────────────────────────────────────────────

  /**
   * Compute marginal likelihood P(observation | model) without mutating state.
   * Used for hyperparameter calibration via evidence maximization.
   */
  marginalLikelihood(observation: number): number {
    const N = this.config.nParticles;
    const { obsNoise } = this.config;

    // Log-sum-exp for numerical stability
    const logTerms = new Float64Array(N);
    let maxLog = -Infinity;

    for (let i = 0; i < N; i++) {
      const probParticle = sigmoid(this.logitParticles[i]);
      const logWeight = Math.log(this.weights[i] + 1e-300);
      const logNormal = -0.5 * ((observation - probParticle) / obsNoise) ** 2
                        - Math.log(obsNoise) - 0.5 * Math.log(2 * Math.PI);
      logTerms[i] = logWeight + logNormal;
      if (logTerms[i] > maxLog) maxLog = logTerms[i];
    }

    let sumExp = 0;
    for (let i = 0; i < N; i++) {
      sumExp += Math.exp(logTerms[i] - maxLog);
    }

    return maxLog + Math.log(sumExp);
  }

  // ─── Calibration ─────────────────────────────────────────────────────────

  /**
   * Empirical Bayes calibration: grid search over processVol × obsNoise
   * to find the pair that maximizes marginal likelihood of the observed data.
   *
   * @param prices     - Observed price sequence (≥5 points recommended)
   * @param priorProb  - Initial probability estimate (default: 0.50)
   * @param nParticles - Particles per candidate filter (default: 500)
   */
  static calibrate(
    prices: number[],
    priorProb?: number,
    nParticles?: number,
  ): { processVol: number; obsNoise: number; logLikelihood: number } {
    const processVolCandidates = [0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12];
    const obsNoiseCandidates = [0.005, 0.01, 0.02, 0.03, 0.05, 0.08];

    let best = { processVol: 0.03, obsNoise: 0.02, logLikelihood: -Infinity };

    for (const pv of processVolCandidates) {
      for (const on of obsNoiseCandidates) {
        const pf = new PredictionMarketParticleFilter({
          nParticles: nParticles ?? 500,
          processVol: pv,
          obsNoise: on,
          priorProb: priorProb ?? 0.50,
        });

        let totalLogLik = 0;
        for (const price of prices) {
          totalLogLik += pf.marginalLikelihood(price);
          pf.update(price);
        }

        if (totalLogLik > best.logLikelihood) {
          best = { processVol: pv, obsNoise: on, logLikelihood: totalLogLik };
        }
      }
    }

    return best;
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  private computeEss(): number {
    let sumSqW = 0;
    for (let i = 0; i < this.config.nParticles; i++) {
      sumSqW += this.weights[i] * this.weights[i];
    }
    return sumSqW > 0 ? 1 / sumSqW : 0;
  }

  /**
   * Systematic resampling — lower variance than multinomial.
   */
  private systematicResample(): void {
    const N = this.config.nParticles;
    const cumsum = new Float64Array(N);
    cumsum[0] = this.weights[0];
    for (let i = 1; i < N; i++) {
      cumsum[i] = cumsum[i - 1] + this.weights[i];
    }

    const u0 = Math.random() / N;
    const newParticles = new Float64Array(N);
    let j = 0;

    for (let i = 0; i < N; i++) {
      const u = u0 + i / N;
      while (j < N - 1 && cumsum[j] < u) j++;
      newParticles[i] = this.logitParticles[j];
    }

    this.logitParticles = newParticles;
    for (let i = 0; i < N; i++) {
      this.weights[i] = 1 / N;
    }
  }

  /**
   * Weighted quantile credible interval.
   */
  private credibleInterval(alpha: number = 0.05): [number, number] {
    const N = this.config.nParticles;

    // Create sorted (prob, weight) pairs
    const pairs: Array<{ prob: number; weight: number }> = [];
    for (let i = 0; i < N; i++) {
      pairs.push({ prob: sigmoid(this.logitParticles[i]), weight: this.weights[i] });
    }
    pairs.sort((a, b) => a.prob - b.prob);

    // Find weighted quantiles
    let cumW = 0;
    let lower = pairs[0].prob;
    let upper = pairs[pairs.length - 1].prob;

    for (const { prob, weight } of pairs) {
      cumW += weight;
      if (cumW >= alpha / 2 && lower === pairs[0].prob) {
        lower = prob;
      }
      if (cumW >= 1 - alpha / 2) {
        upper = prob;
        break;
      }
    }

    return [
      Math.round(lower * 10000) / 10000,
      Math.round(upper * 10000) / 10000,
    ];
  }
}
