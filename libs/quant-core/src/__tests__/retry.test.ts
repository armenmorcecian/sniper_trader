import { describe, it, expect } from "vitest";
import { withRetry, isRetryable } from "../retry";

describe("withRetry", () => {
  it("retries on retryable errors and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("timeout") as Error & { code: string };
        err.code = "ETIMEDOUT";
        throw err;
      }
      return "ok";
    }, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws immediately for non-retryable errors", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw new Error("business logic error");
    }, { baseDelayMs: 1 })).rejects.toThrow("business logic error");
    expect(calls).toBe(1);
  });

  it("uses custom isRetryable predicate", async () => {
    class CustomError extends Error {
      constructor() { super("custom"); this.name = "CustomError"; }
    }
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new CustomError();
      return "done";
    }, {
      baseDelayMs: 1,
      maxDelayMs: 1,
      isRetryable: (err) => err instanceof CustomError,
    });
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("custom predicate can prevent retries", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      const err = new Error("timeout") as Error & { code: string };
      err.code = "ETIMEDOUT";
      throw err;
    }, {
      baseDelayMs: 1,
      isRetryable: () => false,  // never retry
    })).rejects.toThrow("timeout");
    expect(calls).toBe(1);
  });
});

describe("isRetryable", () => {
  it("returns true for ETIMEDOUT", () => {
    const err = new Error("timeout") as Error & { code: string };
    err.code = "ETIMEDOUT";
    expect(isRetryable(err)).toBe(true);
  });

  it("returns true for 429 status", () => {
    const err = { response: { status: 429 } };
    expect(isRetryable(err)).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isRetryable(new Error("nope"))).toBe(false);
  });
});
