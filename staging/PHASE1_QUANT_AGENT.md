# Phase 1: Standalone Quant Signal Process

## Objective

Extract all quantitative computation (regime detection, momentum ranking, volatility analysis, correlation filtering, risk-parity sizing) out of the OpenClaw `alpaca-trader` skill into a standalone Node.js process that runs on a cron schedule. The process writes JSON signal files to a shared volume. The OpenClaw agent reads these pre-computed signals instead of doing the math itself.

## Why

- The OpenClaw agent's context window is expensive — every tool call that returns 200 bars × 12 symbols wastes tokens on raw data the LLM doesn't need to see.
- A standalone process can run more frequently (every 15 min) without burning API credits.
- Signal files provide an audit trail and are debuggable without the agent running.
- Decouples quant logic from agent orchestration — quant code can be tested, profiled, and improved independently.

## Architecture

```
┌────────────────────┐     writes      ┌─────────────────────────┐
│  quant-signals     │ ──────────────► │ ~/.openclaw/signals/    │
│  (Node cron job)   │                 │   regime.json           │
│                    │                 │   rankings.json         │
│  Runs every 15min  │                 │   rebalance.json        │
│  during market hrs │                 │   meta.json             │
└────────────────────┘                 └────────────┬────────────┘
                                                    │ reads
                                       ┌────────────▼────────────┐
                                       │  OpenClaw alpaca-trader │
                                       │  (new tool: read_signals)│
                                       └─────────────────────────┘
```

## Files to Create

All under `~/.openclaw/workspace/services/quant-signals/`:

| File | Purpose |
|------|---------|
| `package.json` | Dependencies: `technicalindicators`, `axios`, `dotenv`, `node-cron` |
| `tsconfig.json` | Standard Node 20 config, outDir `dist/` |
| `src/index.ts` | Entry point — cron scheduler, runs `computeAll()` every 15 min |
| `src/compute.ts` | Orchestrator — fetches bars from Alpaca, runs regime + ranking + rebalance, writes JSON files |
| `src/regime.ts` | Copy of `calculateRegime()` from `rotation.ts` (with breadth) |
| `src/ranking.ts` | Copy of `rankSectorMomentum()` (with composite + ATR) |
| `src/rebalance.ts` | Copy of `generateRebalanceActions()` (with correlation filter + risk parity) |
| `src/helpers.ts` | `calculateDailyReturns`, `pearsonCorrelation`, `compositeMomentum`, `atrMetrics`, `riskParityWeights` |
| `src/alpaca-client.ts` | Minimal Alpaca data client (bars + account/positions) — extract from `alpaca.service.ts` |
| `src/types.ts` | Shared types (copy from alpaca-trader) |

## Signal File Format

### `~/.openclaw/signals/regime.json`
```json
{
  "computedAt": "2025-06-15T14:30:00Z",
  "regime": "bull",
  "spyPrice": 542.31,
  "sma200": 498.72,
  "distancePercent": 8.74,
  "breadthCount": 8,
  "breadthSignal": "bull",
  "compositeRegime": "bull",
  "sectorSMA50Status": { "XLK": true, "XLE": false, ... }
}
```

### `~/.openclaw/signals/rankings.json`
```json
{
  "computedAt": "2025-06-15T14:30:00Z",
  "rankings": [
    {
      "symbol": "XLK", "rank": 1, "compositeScore": 4.21,
      "volatilityAdjustedScore": 3.15, "atrPercent": 1.34, ...
    },
    ...
  ],
  "top3": ["XLK", "XLY", "XLF"],
  "top5": ["XLK", "XLY", "XLF", "XLC", "XLI"]
}
```

### `~/.openclaw/signals/rebalance.json`
```json
{
  "computedAt": "2025-06-15T14:30:00Z",
  "currentHoldings": ["XLK", "XLE"],
  "actions": [
    { "action": "sell", "symbol": "XLE", "reason": "Dropped out of top 5 (rank #9)" },
    { "action": "buy", "symbol": "XLY", "reason": "Top 3 (#2, composite 3.8%) — allocate 38% risk-parity", "targetWeight": 0.38 },
    { "action": "hold", "symbol": "XLK", "reason": "Top 3 (#1) — already held", "targetWeight": 0.35 }
  ]
}
```

### `~/.openclaw/signals/meta.json`
```json
{
  "lastRun": "2025-06-15T14:30:00Z",
  "nextRun": "2025-06-15T14:45:00Z",
  "status": "ok",
  "barsPerSymbol": 200,
  "averageATR": 1.52,
  "riskParityTotal": 1.0,
  "errors": []
}
```

## Changes to `alpaca-trader` Skill

### New tool: `read_signals`
Add a tool to `alpaca.skill.ts`:
```ts
const ReadSignalsSchema = Type.Object({});

// handler:
async () => {
  const signalsDir = path.join(os.homedir(), ".openclaw", "signals");
  const files = ["regime.json", "rankings.json", "rebalance.json", "meta.json"];
  const result: Record<string, unknown> = {};
  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(signalsDir, file), "utf-8");
      result[file.replace(".json", "")] = JSON.parse(content);
    } catch {
      result[file.replace(".json", "")] = null;
    }
  }
  return result;
}
```

### Keep `scan_sectors` as fallback
Don't remove `scan_sectors` — it's the fallback if the quant process is down. Update SKILL.md to recommend `read_signals` first, fall back to `scan_sectors` if signals are stale (>30 min old).

## Cron Schedule

```ts
// src/index.ts
import cron from "node-cron";
import { computeAll } from "./compute";

// Every 15 minutes during US market hours (9:30 AM - 4:00 PM ET, Mon-Fri)
// Cron runs in UTC, so 13:30-20:00 UTC (EST) or 13:30-20:00 (adjust for DST)
cron.schedule("*/15 9-16 * * 1-5", async () => {
  console.log(`[quant-signals] Running at ${new Date().toISOString()}`);
  await computeAll();
});

// Also run once on startup
computeAll().catch(console.error);
```

## Docker Integration

Add to `docker-compose.yaml`:
```yaml
quant-signals:
  build:
    context: .
    dockerfile: Dockerfile
  volumes:
    - ${HOME}/.openclaw:/home/node/.openclaw
  env_file:
    - ${HOME}/.openclaw/.env
  restart: unless-stopped
```

Or run as a simple systemd service / pm2 process on the host.

## Verification

```bash
# Build
cd ~/.openclaw/workspace/services/quant-signals
npm install && npm run build

# Manual run
npx tsx src/index.ts

# Check output
cat ~/.openclaw/signals/regime.json | jq .
cat ~/.openclaw/signals/rankings.json | jq '.rankings[0:3]'
cat ~/.openclaw/signals/rebalance.json | jq '.actions'

# From OpenClaw agent
alpaca-trader read_signals '{}'
```

## Success Criteria

1. `quant-signals` process runs independently, writes fresh signals every 15 min
2. `read_signals` tool returns pre-computed data in <100ms (file read, no API calls)
3. `scan_sectors` still works as a fallback
4. Agent context window usage drops ~40% (no raw bar data in tool output)
5. Signal files are human-readable JSON for debugging
