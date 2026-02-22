// ─── API Health Tracker ─────────────────────────────────────────────────────
// In-process health state — resets each CLI invocation.
// Prevents infinite retry within a single tool call by tracking consecutive failures.

export interface ApiHealthState {
  consecutiveFailures: number;
  lastFailureTime?: string;
  readOnly: boolean;
}

const DEFAULT_MAX_FAILURES = 3;

// In-process state — module-level Map, resets on process start
const healthMap = new Map<string, ApiHealthState>();

function getOrCreate(apiName: string): ApiHealthState {
  let state = healthMap.get(apiName);
  if (!state) {
    state = { consecutiveFailures: 0, readOnly: false };
    healthMap.set(apiName, state);
  }
  return state;
}

/**
 * Record a successful API call — resets failure counter.
 */
export function recordApiSuccess(apiName: string): void {
  const state = getOrCreate(apiName);
  state.consecutiveFailures = 0;
  state.readOnly = false;
  state.lastFailureTime = undefined;
}

/**
 * Record an API failure — increments consecutive failure counter.
 * After maxConsecutiveFailures, the API is marked read-only.
 */
export function recordApiFailure(apiName: string, maxConsecutiveFailures = DEFAULT_MAX_FAILURES): void {
  const state = getOrCreate(apiName);
  state.consecutiveFailures++;
  state.lastFailureTime = new Date().toISOString();
  if (state.consecutiveFailures >= maxConsecutiveFailures) {
    state.readOnly = true;
  }
}

/**
 * Check if an API is available for write operations.
 * Returns false if consecutive failures >= maxConsecutiveFailures.
 */
export function isApiAvailable(apiName: string, maxConsecutiveFailures = DEFAULT_MAX_FAILURES): boolean {
  const state = healthMap.get(apiName);
  if (!state) return true;
  return state.consecutiveFailures < maxConsecutiveFailures;
}

/**
 * Get the current health state for an API.
 */
export function getApiHealth(apiName: string): ApiHealthState {
  return getOrCreate(apiName);
}

/**
 * Reset health state for an API (mainly for testing).
 */
export function resetApiHealth(apiName: string): void {
  healthMap.delete(apiName);
}

/**
 * Reset all health state (mainly for testing).
 */
export function resetAllApiHealth(): void {
  healthMap.clear();
}
