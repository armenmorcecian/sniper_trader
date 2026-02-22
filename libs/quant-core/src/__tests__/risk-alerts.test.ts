import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  insertRiskAlert,
  getActiveAlerts,
  isTradingBlocked,
  resolveAlert,
  resolveAlertsByType,
  cleanExpiredAlerts,
} from "../risk-alerts";
import type { RiskAlert } from "../risk-alerts";

let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `risk-alerts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe("insertRiskAlert", () => {
  it("inserts an alert and returns row ID", () => {
    const id = insertRiskAlert({
      alertType: "stop_loss",
      severity: "block",
      symbol: "SPY",
      message: "SPY stop-loss breached: -6.2%",
      details: { pnlPercent: -6.2 },
    }, dbPath);
    expect(id).toBe(1);
  });

  it("deduplicates: returns existing ID for same type+symbol+severity", () => {
    const id1 = insertRiskAlert({
      alertType: "stop_loss",
      severity: "block",
      symbol: "SPY",
      message: "SPY stop-loss breached: -6.2%",
    }, dbPath);
    const id2 = insertRiskAlert({
      alertType: "stop_loss",
      severity: "block",
      symbol: "SPY",
      message: "SPY stop-loss breached: -7.0%",
    }, dbPath);
    expect(id1).toBe(id2);
  });

  it("allows different symbols for same type+severity", () => {
    const id1 = insertRiskAlert({
      alertType: "stop_loss",
      severity: "block",
      symbol: "SPY",
      message: "SPY stop-loss",
    }, dbPath);
    const id2 = insertRiskAlert({
      alertType: "stop_loss",
      severity: "block",
      symbol: "QQQ",
      message: "QQQ stop-loss",
    }, dbPath);
    expect(id1).not.toBe(id2);
  });

  it("allows null symbol alerts", () => {
    const id = insertRiskAlert({
      alertType: "daily_loss",
      severity: "block",
      message: "Daily loss limit breached: -3.5%",
    }, dbPath);
    expect(id).toBeGreaterThan(0);
  });
});

describe("isTradingBlocked", () => {
  it("returns false with empty DB", () => {
    const result = isTradingBlocked(dbPath);
    expect(result.blocked).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("returns true with active block alert", () => {
    insertRiskAlert({
      alertType: "daily_loss",
      severity: "block",
      message: "Daily loss circuit breaker triggered",
    }, dbPath);
    const result = isTradingBlocked(dbPath);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain("Daily loss circuit breaker triggered");
  });

  it("ignores warning-severity alerts", () => {
    insertRiskAlert({
      alertType: "stop_loss",
      severity: "warning",
      symbol: "SPY",
      message: "SPY approaching stop-loss",
    }, dbPath);
    const result = isTradingBlocked(dbPath);
    expect(result.blocked).toBe(false);
  });

  it("ignores critical-severity alerts (only block blocks)", () => {
    insertRiskAlert({
      alertType: "drawdown",
      severity: "critical",
      message: "Drawdown approaching limit",
    }, dbPath);
    const result = isTradingBlocked(dbPath);
    expect(result.blocked).toBe(false);
  });

  it("ignores resolved alerts", () => {
    const id = insertRiskAlert({
      alertType: "daily_loss",
      severity: "block",
      message: "Daily loss circuit breaker triggered",
    }, dbPath);
    resolveAlert(id, "manual", dbPath);
    const result = isTradingBlocked(dbPath);
    expect(result.blocked).toBe(false);
  });

  it("ignores expired alerts", () => {
    insertRiskAlert({
      alertType: "daily_loss",
      severity: "block",
      message: "Daily loss circuit breaker triggered",
      expiresAt: "2020-01-01T00:00:00.000Z", // already expired
    }, dbPath);
    const result = isTradingBlocked(dbPath);
    expect(result.blocked).toBe(false);
  });
});

describe("getActiveAlerts", () => {
  it("returns all active alerts", () => {
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss" }, dbPath);
    insertRiskAlert({ alertType: "daily_loss", severity: "warning", message: "Daily loss warning" }, dbPath);
    const alerts = getActiveAlerts(undefined, dbPath);
    expect(alerts).toHaveLength(2);
  });

  it("filters by severity", () => {
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss" }, dbPath);
    insertRiskAlert({ alertType: "daily_loss", severity: "warning", message: "Daily loss warning" }, dbPath);
    const blocks = getActiveAlerts({ severity: "block" }, dbPath);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].alertType).toBe("stop_loss");
  });

  it("filters by symbol", () => {
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss" }, dbPath);
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "QQQ", message: "QQQ stop-loss" }, dbPath);
    const spyAlerts = getActiveAlerts({ symbol: "SPY" }, dbPath);
    expect(spyAlerts).toHaveLength(1);
    expect(spyAlerts[0].symbol).toBe("SPY");
  });

  it("filters by alertType", () => {
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss" }, dbPath);
    insertRiskAlert({ alertType: "ws_disconnect", severity: "block", message: "WS disconnected" }, dbPath);
    const wsAlerts = getActiveAlerts({ alertType: "ws_disconnect" }, dbPath);
    expect(wsAlerts).toHaveLength(1);
    expect(wsAlerts[0].alertType).toBe("ws_disconnect");
  });

  it("excludes expired alerts", () => {
    insertRiskAlert({
      alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss",
      expiresAt: "2020-01-01T00:00:00.000Z",
    }, dbPath);
    const alerts = getActiveAlerts(undefined, dbPath);
    expect(alerts).toHaveLength(0);
  });
});

describe("resolveAlert", () => {
  it("resolves an alert by ID", () => {
    const id = insertRiskAlert({
      alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss",
    }, dbPath);
    resolveAlert(id, "manual-user", dbPath);
    const alerts = getActiveAlerts(undefined, dbPath);
    expect(alerts).toHaveLength(0);
  });
});

describe("resolveAlertsByType", () => {
  it("resolves all alerts of a given type", () => {
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss" }, dbPath);
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "QQQ", message: "QQQ stop-loss" }, dbPath);
    insertRiskAlert({ alertType: "daily_loss", severity: "block", message: "Daily loss" }, dbPath);
    const count = resolveAlertsByType("stop_loss", undefined, dbPath);
    expect(count).toBe(2);
    const remaining = getActiveAlerts(undefined, dbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].alertType).toBe("daily_loss");
  });

  it("resolves only matching symbol when specified", () => {
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss" }, dbPath);
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "QQQ", message: "QQQ stop-loss" }, dbPath);
    const count = resolveAlertsByType("stop_loss", "SPY", dbPath);
    expect(count).toBe(1);
    const remaining = getActiveAlerts(undefined, dbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].symbol).toBe("QQQ");
  });
});

describe("cleanExpiredAlerts", () => {
  it("returns 0 on empty DB", () => {
    const count = cleanExpiredAlerts(dbPath);
    expect(count).toBe(0);
  });

  it("does not delete unresolved alerts", () => {
    insertRiskAlert({ alertType: "stop_loss", severity: "block", symbol: "SPY", message: "SPY stop-loss" }, dbPath);
    const count = cleanExpiredAlerts(dbPath);
    expect(count).toBe(0);
    const alerts = getActiveAlerts(undefined, dbPath);
    expect(alerts).toHaveLength(1);
  });
});
