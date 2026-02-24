import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(__dirname, "../../data");
const LOCK_FILE = path.join(DATA_DIR, "agent-busy.lock");
const NODE_BIN = "/root/.nvm/versions/node/v22.22.0/bin";
const OPENCLAW_DIR = "/root/openclaw";
const SKILL_DIR = path.join(__dirname, "../..");

// ─── Data Directory ──────────────────────────────────────────────────────────

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function getDataDir(): string {
  ensureDataDir();
  return DATA_DIR;
}

// ─── State File I/O ──────────────────────────────────────────────────────────

export function loadState<T>(filename: string, defaultValue: T): T {
  const filepath = path.join(getDataDir(), filename);
  try {
    const raw = fs.readFileSync(filepath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

export function saveState<T>(filename: string, data: T): void {
  const filepath = path.join(getDataDir(), filename);
  const tmpPath = filepath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filepath);
}

// ─── Lockfile Management ─────────────────────────────────────────────────────

const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

export function isAgentBusy(): boolean {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const stat = fs.statSync(LOCK_FILE);
    return Date.now() - stat.mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

export function acquireLock(): boolean {
  ensureDataDir();
  if (isAgentBusy()) return false;
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

// ─── Agent Trigger ───────────────────────────────────────────────────────────

export function triggerAgent(message: string): {
  success: boolean;
  output: string;
} {
  const result = spawnSync(
    path.join(NODE_BIN, "npx"),
    [
      "openclaw",
      "agent",
      "--agent",
      "main",
      "--message",
      message,
      "--json",
      "--timeout",
      "120",
    ],
    {
      cwd: OPENCLAW_DIR,
      timeout: 150_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${NODE_BIN}:${process.env.PATH || ""}`,
      },
    },
  );

  if (result.error) {
    return { success: false, output: result.error.message };
  }

  return {
    success: result.status === 0,
    output: (result.stdout || "") + (result.stderr || ""),
  };
}

// ─── Trading Cycle Trigger ───────────────────────────────────────────────────

/**
 * Spawns the single-prompt trading cycle script.
 * Gathers all data, builds one LLM prompt, parses decision, executes trades.
 * Replaces the multi-step triggerAgent flow for daemon-initiated cycles.
 */
export function triggerTradingCycle(
  triggerType: string,
  contextJson: string,
): { success: boolean; output: string } {
  const result = spawnSync(
    path.join(NODE_BIN, "npx"),
    ["tsx", "src/daemons/trading-cycle.ts", triggerType, contextJson],
    {
      cwd: SKILL_DIR,
      timeout: 300_000, // 5 min — data gathering + agent call + trade execution
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${NODE_BIN}:${process.env.PATH || ""}`,
      },
    },
  );

  if (result.error) {
    return { success: false, output: result.error.message };
  }

  return {
    success: result.status === 0,
    output: (result.stdout || "") + (result.stderr || ""),
  };
}

// ─── Logging ─────────────────────────────────────────────────────────────────

export function log(
  daemon: string,
  level: "INFO" | "WARN" | "ERROR",
  message: string,
): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${daemon}] [${level}] ${message}`;
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function todayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
