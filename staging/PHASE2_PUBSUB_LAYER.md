# Phase 2: SQLite Pub/Sub Layer + Real-Time Risk Process

## Objective

Replace the file-based signal system (Phase 1) with a SQLite-backed pub/sub layer. A **Quant process** publishes signals, a **Risk process** publishes constraints (exposure limits, stop-loss triggers, drawdown alerts), and the **OpenClaw agent** subscribes and reacts. The Risk process also integrates Alpaca's WebSocket for real-time price feeds.

## Why

- File-based signals have no ordering guarantees, no acknowledgment, and no history.
- SQLite gives us ACID writes, queryable history, and WAL mode for concurrent readers.
- A dedicated Risk process can enforce portfolio constraints in real-time (sub-second stop-loss) instead of waiting for the agent's 15-min heartbeat.
- WebSocket price feeds enable trailing stops, intraday momentum shifts, and flash crash detection.

## Architecture

```
┌──────────────┐  publish   ┌───────────────────┐  subscribe  ┌──────────────────┐
│ Quant Process│ ─────────► │  SQLite Pub/Sub    │ ◄────────── │ OpenClaw Agent   │
│ (cron 15min) │            │  ~/.openclaw/      │             │ (alpaca-trader)  │
└──────────────┘            │  signals.db        │             └──────────────────┘
                            │                    │
┌──────────────┐  publish   │  Tables:           │
│ Risk Process │ ─────────► │  - signals         │
│ (always-on)  │            │  - constraints     │
│              │            │  - ack             │
│ Alpaca WS ◄──┤            └───────────────────┘
└──────────────┘
```

## SQLite Schema

```sql
-- signals.db

-- Quant signals (regime, rankings, rebalance actions)
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,           -- 'regime', 'rankings', 'rebalance'
  payload TEXT NOT NULL,           -- JSON blob
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_signals_channel ON signals(channel, consumed, created_at);

-- Risk constraints (exposure limits, stop-loss, drawdown)
CREATE TABLE constraints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- 'stop_loss', 'max_exposure', 'drawdown_alert', 'circuit_breaker'
  symbol TEXT,                     -- NULL for portfolio-wide constraints
  payload TEXT NOT NULL,           -- JSON: { threshold, currentValue, triggered, reason }
  severity TEXT NOT NULL DEFAULT 'warning',  -- 'info', 'warning', 'critical'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_constraints_type ON constraints(type, consumed, created_at);

-- Acknowledgment log (agent marks signals/constraints as processed)
CREATE TABLE ack (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table TEXT NOT NULL,      -- 'signals' or 'constraints'
  source_id INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT 'alpaca-trader',
  action_taken TEXT,               -- 'executed', 'skipped', 'deferred'
  notes TEXT,
  acked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Price feed snapshots (last N ticks per symbol, for risk calculations)
CREATE TABLE price_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  bid REAL,
  ask REAL,
  volume INTEGER,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_price_ticks_symbol ON price_ticks(symbol, created_at);

-- Cleanup: only keep last 1000 ticks per symbol
CREATE TRIGGER cleanup_price_ticks AFTER INSERT ON price_ticks
BEGIN
  DELETE FROM price_ticks
  WHERE id NOT IN (
    SELECT id FROM price_ticks WHERE symbol = NEW.symbol
    ORDER BY created_at DESC LIMIT 1000
  ) AND symbol = NEW.symbol;
END;
```

## Files to Create

### Shared library: `~/.openclaw/workspace/libs/pubsub/`

| File | Purpose |
|------|---------|
| `package.json` | Deps: `better-sqlite3`, `@types/better-sqlite3` |
| `src/db.ts` | Open/create SQLite DB, run migrations, WAL mode |
| `src/publisher.ts` | `publish(channel, payload)`, `publishConstraint(type, symbol, payload, severity)` |
| `src/subscriber.ts` | `consume(channel, limit?)` → unconsumed signals; `ack(table, id, action, notes)` |
| `src/types.ts` | Signal, Constraint, Ack interfaces |

### Risk process: `~/.openclaw/workspace/services/risk-monitor/`

| File | Purpose |
|------|---------|
| `package.json` | Deps: `better-sqlite3`, `ws`, `dotenv` |
| `src/index.ts` | Entry point — starts WebSocket + risk loop |
| `src/websocket.ts` | Alpaca market data WebSocket (trades/quotes for held symbols) |
| `src/risk-engine.ts` | Core risk calculations |
| `src/rules.ts` | Configurable risk rules (stop-loss, max drawdown, etc.) |

### Changes to Quant process (Phase 1)

Replace file writes with SQLite publishes:
```ts
// Before (Phase 1)
await fs.writeFile("signals/regime.json", JSON.stringify(regime));

// After (Phase 2)
import { publish } from "@workspace/pubsub";
publish("regime", regime);
publish("rankings", { rankings, top3, top5 });
publish("rebalance", { actions, currentHoldings });
```

### Changes to `alpaca-trader` skill

Replace `read_signals` tool with `check_signals`:
```ts
// Consumes unconsumed signals + constraints from SQLite
async () => {
  const signals = consume("regime", 1);    // latest regime
  const rankings = consume("rankings", 1);  // latest rankings
  const rebalance = consume("rebalance", 1);
  const constraints = consumeConstraints(["stop_loss", "drawdown_alert", "circuit_breaker"]);

  // Auto-ack consumed signals
  for (const s of [...signals, ...rankings, ...rebalance]) {
    ack("signals", s.id, "consumed");
  }

  return { signals, rankings, rebalance, constraints };
}
```

## Risk Process: Core Logic

### `risk-engine.ts`

```ts
interface RiskRule {
  name: string;
  check(positions: Position[], prices: Map<string, number>, equity: number): Constraint | null;
}

// Built-in rules:

// 1. Per-position stop-loss (configurable, default -7%)
// 2. Portfolio max drawdown from high-water mark (-10% → circuit breaker)
// 3. Single position > 35% of equity → warning
// 4. Total exposure > 95% → critical
// 5. Intraday loss > 3% → warning, > 5% → circuit breaker
// 6. Flash crash detection: any position drops > 5% in 5 minutes → critical

class RiskEngine {
  private rules: RiskRule[] = [];
  private highWaterMark: number = 0;
  private prices: Map<string, number> = new Map();

  addRule(rule: RiskRule): void { ... }

  onPriceTick(symbol: string, price: number): void {
    this.prices.set(symbol, price);
    // Store in SQLite price_ticks table
    // Run all rules against current state
    // Publish any triggered constraints
  }

  checkAll(positions: Position[], equity: number): Constraint[] {
    return this.rules
      .map(r => r.check(positions, this.prices, equity))
      .filter(Boolean) as Constraint[];
  }
}
```

### Alpaca WebSocket (`websocket.ts`)

```ts
// Connect to wss://stream.data.alpaca.markets/v2/iex (or sip for paid)
// Subscribe to trades for all held symbols + SPY
// On each trade tick:
//   1. Update price in risk engine
//   2. Store in price_ticks table
//   3. If risk rule triggers → publish constraint

// Reconnect logic: exponential backoff, max 5 retries
// Symbol management: re-subscribe when holdings change (poll every 5 min)
```

## Docker Integration

Update `docker-compose.yaml`:
```yaml
services:
  quant-signals:
    # ... (from Phase 1, updated to use SQLite)
    volumes:
      - signals-db:/data

  risk-monitor:
    build:
      context: ./services/risk-monitor
    volumes:
      - signals-db:/data
    env_file:
      - ${HOME}/.openclaw/.env
    restart: unless-stopped

  openclaw-gateway:
    # ... existing config
    volumes:
      - signals-db:/data  # read-only access to signals.db

volumes:
  signals-db:
```

## Verification

```bash
# Build shared lib
cd ~/.openclaw/workspace/libs/pubsub && npm install && npm run build

# Build risk monitor
cd ~/.openclaw/workspace/services/risk-monitor && npm install && npm run build

# Start risk monitor (needs Alpaca keys)
APCA_API_KEY_ID=xxx APCA_API_SECRET_KEY=xxx npx tsx src/index.ts

# Check SQLite content
sqlite3 ~/.openclaw/signals.db "SELECT * FROM signals ORDER BY id DESC LIMIT 5;"
sqlite3 ~/.openclaw/signals.db "SELECT * FROM constraints WHERE consumed=0;"

# From OpenClaw agent
alpaca-trader check_signals '{}'

# Verify WebSocket
# Should see price_ticks populating during market hours
sqlite3 ~/.openclaw/signals.db "SELECT symbol, price, timestamp FROM price_ticks ORDER BY id DESC LIMIT 20;"
```

## Success Criteria

1. Quant process publishes to SQLite instead of flat files
2. Risk process connects to Alpaca WebSocket, receives real-time trades
3. Stop-loss constraints are published within 1 second of price crossing threshold
4. Agent consumes signals + constraints via `check_signals` tool
5. All signals/constraints have audit trail via `ack` table
6. SQLite WAL mode allows concurrent reads from agent while quant/risk write
7. Price ticks table auto-cleans (max 1000 per symbol)
8. Circuit breaker constraint halts all agent buying when triggered
