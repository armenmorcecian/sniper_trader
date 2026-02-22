import { describe, it, expect, beforeEach } from "vitest";
import {
  recordApiSuccess,
  recordApiFailure,
  isApiAvailable,
  getApiHealth,
  resetAllApiHealth,
} from "../api-health";

beforeEach(() => {
  resetAllApiHealth();
});

describe("recordApiSuccess", () => {
  it("resets failure count to 0", () => {
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    recordApiSuccess("test-api");
    expect(getApiHealth("test-api").consecutiveFailures).toBe(0);
    expect(getApiHealth("test-api").readOnly).toBe(false);
  });

  it("creates state for new API", () => {
    recordApiSuccess("new-api");
    expect(getApiHealth("new-api").consecutiveFailures).toBe(0);
  });
});

describe("recordApiFailure", () => {
  it("increments consecutive failures", () => {
    recordApiFailure("test-api");
    expect(getApiHealth("test-api").consecutiveFailures).toBe(1);

    recordApiFailure("test-api");
    expect(getApiHealth("test-api").consecutiveFailures).toBe(2);
  });

  it("sets lastFailureTime on failure", () => {
    recordApiFailure("test-api");
    expect(getApiHealth("test-api").lastFailureTime).toBeDefined();
  });

  it("marks readOnly after threshold failures", () => {
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    expect(getApiHealth("test-api").readOnly).toBe(false);

    recordApiFailure("test-api"); // 3rd failure = threshold
    expect(getApiHealth("test-api").readOnly).toBe(true);
  });

  it("respects custom threshold", () => {
    recordApiFailure("test-api", 5);
    recordApiFailure("test-api", 5);
    recordApiFailure("test-api", 5);
    expect(getApiHealth("test-api").readOnly).toBe(false);

    recordApiFailure("test-api", 5);
    recordApiFailure("test-api", 5); // 5th failure
    expect(getApiHealth("test-api").readOnly).toBe(true);
  });
});

describe("isApiAvailable", () => {
  it("returns true for unknown API", () => {
    expect(isApiAvailable("nonexistent")).toBe(true);
  });

  it("returns true when failures below threshold", () => {
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    expect(isApiAvailable("test-api")).toBe(true);
  });

  it("returns false when failures reach threshold", () => {
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    expect(isApiAvailable("test-api")).toBe(false);
  });

  it("returns true again after success resets failures", () => {
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    expect(isApiAvailable("test-api")).toBe(false);

    recordApiSuccess("test-api");
    expect(isApiAvailable("test-api")).toBe(true);
  });

  it("respects custom maxConsecutiveFailures", () => {
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    recordApiFailure("test-api");
    // Default threshold would fail, but custom 5 still OK
    expect(isApiAvailable("test-api", 5)).toBe(true);
  });
});

describe("getApiHealth", () => {
  it("returns default state for new API", () => {
    const state = getApiHealth("fresh-api");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.readOnly).toBe(false);
    expect(state.lastFailureTime).toBeUndefined();
  });
});
