// ─── Tick-Level Copula Tracker ────────────────────────────────────────────────
// Tracks real-time correlation between BTC spot price movements and Polymarket
// contract price changes. Computes tail dependence via t-copula to dynamically
// adjust position sizing — higher tail dependence → smaller positions.

import {
  calibrateCopulaDf,
  buildCorrelationMatrix,
  computeTailDependence,
} from "quant-core";

const LOG_PREFIX = "[copula-tracker]";
const WINDOW_SIZE = 60;       // Rolling window of return samples
const MIN_SAMPLES = 10;       // Minimum samples before ready
const RECALIBRATE_MS = 30_000; // Recalibrate every 30s

export class TickCopulaTracker {
  private btcPrices: number[] = [];
  private polyPrices: number[] = [];
  private btcReturns: number[] = [];
  private polyReturns: number[] = [];
  private _tailDependence = 0;
  private _isReady = false;
  private lastCalibrationTime = 0;

  get isReady(): boolean {
    return this._isReady;
  }

  get tailDependence(): number {
    return this._tailDependence;
  }

  /** Feed a BTC spot price tick from Binance */
  onBtcTick(price: number): void {
    if (price <= 0) return;

    this.btcPrices.push(price);
    if (this.btcPrices.length > WINDOW_SIZE + 1) {
      this.btcPrices.shift();
    }

    // Compute return from previous price
    if (this.btcPrices.length >= 2) {
      const prev = this.btcPrices[this.btcPrices.length - 2];
      if (prev > 0) {
        this.btcReturns.push((price - prev) / prev);
        if (this.btcReturns.length > WINDOW_SIZE) {
          this.btcReturns.shift();
        }
      }
    }

    this.maybeRecalibrate();
  }

  /** Feed a Polymarket contract price update */
  onPolyPriceUpdate(price: number): void {
    if (price <= 0 || price >= 1) return;

    this.polyPrices.push(price);
    if (this.polyPrices.length > WINDOW_SIZE + 1) {
      this.polyPrices.shift();
    }

    // Compute return from previous price
    if (this.polyPrices.length >= 2) {
      const prev = this.polyPrices[this.polyPrices.length - 2];
      if (prev > 0) {
        this.polyReturns.push((price - prev) / prev);
        if (this.polyReturns.length > WINDOW_SIZE) {
          this.polyReturns.shift();
        }
      }
    }
  }

  /**
   * Get position size factor based on tail dependence.
   * Higher tail dependence → more likely correlated extreme moves → smaller positions.
   */
  getSizeFactor(): number {
    if (!this._isReady) return 1.0;
    if (this._tailDependence > 0.3) return 0.5;
    if (this._tailDependence > 0.15) return 0.75;
    return 1.0;
  }

  private maybeRecalibrate(): void {
    const now = Date.now();
    if (now - this.lastCalibrationTime < RECALIBRATE_MS) return;

    const minLen = Math.min(this.btcReturns.length, this.polyReturns.length);
    if (minLen < MIN_SAMPLES) return;

    this.lastCalibrationTime = now;

    try {
      // Use aligned return windows
      const btcWindow = this.btcReturns.slice(-minLen);
      const polyWindow = this.polyReturns.slice(-minLen);

      // Calibrate t-copula degrees of freedom from observed data
      const nu = calibrateCopulaDf([btcWindow, polyWindow]);

      // Build correlation matrix and extract rho
      const corrMatrix = buildCorrelationMatrix([btcWindow, polyWindow]);
      const rho = corrMatrix[0][1];

      // Compute tail dependence
      const td = computeTailDependence(Math.max(rho, 0.001), nu);
      this._tailDependence = td;
      this._isReady = true;

      console.log(
        `${LOG_PREFIX} Recalibrated: rho=${rho.toFixed(3)} nu=${nu} tailDep=${td.toFixed(4)} sizeFactor=${this.getSizeFactor()} samples=${minLen}`,
      );
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Calibration failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
