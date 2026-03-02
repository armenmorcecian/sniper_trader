import { describe, it, expect } from "vitest";
import { PredictionMarketParticleFilter } from "../particle-filter";

describe("PredictionMarketParticleFilter", () => {
  it("converges to true probability from prior", () => {
    const pf = new PredictionMarketParticleFilter({
      nParticles: 2000,
      priorProb: 0.50,
      processVol: 0.02,
      obsNoise: 0.02,
    });

    // Feed 30 observations at p=0.65
    for (let i = 0; i < 30; i++) {
      pf.update(0.65 + (Math.random() - 0.5) * 0.02);
    }

    const est = pf.estimate();
    // Should be close to 0.65 (within 0.10)
    expect(est.filteredProb).toBeGreaterThan(0.55);
    expect(est.filteredProb).toBeLessThan(0.75);
  });

  it("smooths noisy observations", () => {
    const pf = new PredictionMarketParticleFilter({
      nParticles: 1000,
      priorProb: 0.50,
      processVol: 0.02,
      obsNoise: 0.03,
    });

    // Observations that bounce around 0.60 with noise
    const observations = [
      0.55, 0.58, 0.62, 0.57, 0.63, 0.59, 0.61, 0.64,
      0.58, 0.62, 0.60, 0.63, 0.61, 0.59, 0.62, 0.60,
    ];

    const filtered: number[] = [];
    for (const obs of observations) {
      const est = pf.update(obs);
      filtered.push(est.filteredProb);
    }

    // Filtered variance should be less than observation variance
    const obsMean = observations.reduce((s, o) => s + o, 0) / observations.length;
    const obsVar = observations.reduce((s, o) => s + (o - obsMean) ** 2, 0) / observations.length;

    const filtMean = filtered.reduce((s, f) => s + f, 0) / filtered.length;
    const filtVar = filtered.reduce((s, f) => s + (f - filtMean) ** 2, 0) / filtered.length;

    expect(filtVar).toBeLessThan(obsVar);
  });

  it("ESS triggers resampling", () => {
    const pf = new PredictionMarketParticleFilter({
      nParticles: 500,
      priorProb: 0.50,
      processVol: 0.01,
      obsNoise: 0.01,
    });

    // A large jump should cause weight degeneracy → resampling
    pf.update(0.50);
    pf.update(0.50);
    pf.update(0.80); // Big jump

    const est = pf.estimate();
    // After resampling, ESS should be restored
    expect(est.ess).toBeGreaterThan(100);
  });

  it("serialize/deserialize round-trips correctly", () => {
    const pf = new PredictionMarketParticleFilter({
      nParticles: 500,
      priorProb: 0.50,
    });

    // Update a few times
    pf.update(0.55);
    pf.update(0.60);
    pf.update(0.58);

    const state = pf.serialize();
    const restored = PredictionMarketParticleFilter.deserialize(state);

    const originalEst = pf.estimate();
    const restoredEst = restored.estimate();

    expect(restoredEst.filteredProb).toBe(originalEst.filteredProb);
    expect(restored.observationCount).toBe(3);
    expect(restored.history).toHaveLength(3);
  });

  it("detects divergence on price spike", () => {
    const pf = new PredictionMarketParticleFilter({
      nParticles: 1000,
      priorProb: 0.50,
      processVol: 0.02,
      obsNoise: 0.02,
    });

    // Establish baseline around 0.50
    for (let i = 0; i < 10; i++) {
      pf.update(0.50 + (Math.random() - 0.5) * 0.01);
    }

    // Sudden spike to 0.80
    const spikeEst = pf.update(0.80);

    // Divergence should be high because the filter hasn't caught up
    expect(spikeEst.divergence).toBeGreaterThan(0.05);
  });

  it("credible interval contains true value most of the time", () => {
    // Run multiple independent filters and check calibration
    const trueProb = 0.60;
    let contained = 0;
    const nTests = 50;

    for (let t = 0; t < nTests; t++) {
      const pf = new PredictionMarketParticleFilter({
        nParticles: 1000,
        priorProb: 0.50,
        processVol: 0.03,
        obsNoise: 0.02,
      });

      // Feed noisy observations around true value
      for (let i = 0; i < 20; i++) {
        pf.update(trueProb + (Math.random() - 0.5) * 0.04);
      }

      const est = pf.estimate();
      if (est.ci95[0] <= trueProb && trueProb <= est.ci95[1]) {
        contained++;
      }
    }

    // Should contain true value at least 70% of the time
    // (we use a lenient threshold because particle filters with few particles
    //  may not achieve exact 95% coverage)
    expect(contained / nTests).toBeGreaterThan(0.7);
  });

  it("tracks observation count and history", () => {
    const pf = new PredictionMarketParticleFilter({ nParticles: 100 });

    expect(pf.observationCount).toBe(0);
    expect(pf.history).toHaveLength(0);

    pf.update(0.55);
    pf.update(0.60);
    pf.update(0.58);

    expect(pf.observationCount).toBe(3);
    expect(pf.history).toHaveLength(3);
  });
});
