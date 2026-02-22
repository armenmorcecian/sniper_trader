import type { RetryConfig } from "./types";

const RETRYABLE_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN",
]);

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

// Error class names that should never be retried (checked by name to avoid cross-package instanceof issues)
const NON_RETRYABLE_ERROR_NAMES = new Set([
  "InsufficientFundsError",
  "AgentDeathError",
]);

// Error class names that should always be retried
const ALWAYS_RETRYABLE_ERROR_NAMES = new Set([
  "RetryableError",
]);

export function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    if (NON_RETRYABLE_ERROR_NAMES.has(error.name)) return false;
    if (ALWAYS_RETRYABLE_ERROR_NAMES.has(error.name)) return true;
  }

  const err = error as Record<string, unknown>;

  if (typeof err.code === "string" && RETRYABLE_CODES.has(err.code)) return true;

  const status =
    typeof err.status === "number"
      ? err.status
      : (err.response as Record<string, unknown>)?.status;
  if (typeof status === "number" && RETRYABLE_STATUS_CODES.has(status)) return true;

  return false;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> & { isRetryable?: (error: unknown) => boolean } = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_CONFIG, ...config };
  const retryCheck = config.isRetryable ?? isRetryable;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!retryCheck(error) || attempt === maxRetries) throw error;
      // Exponential backoff with jitter (±500ms)
      const jitter = Math.random() * 1000 - 500;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt) + jitter, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
    }
  }
  throw lastError;
}
