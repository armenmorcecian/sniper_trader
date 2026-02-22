# Phase 3: Multi-Agent Architecture with Orchestrator

## Objective

Each concern (Quant, Risk, Intel, Executor) becomes its own OpenClaw agent instance with independent heartbeats and context windows. An **Orchestrator** agent delegates to specialized agents via tool calls, enabling parallel processing, fault isolation, and independent scaling.

## Why

- Single-agent architecture has a fundamental context window bottleneck — the agent must hold market data, risk state, news analysis, and execution logic simultaneously.
- Specialized agents can have tailored system prompts, tool access, and heartbeat intervals.
- Fault isolation: if the Intel agent crashes parsing a news feed, the Executor keeps running.
- Independent heartbeats: Quant runs every 15 min, Risk runs continuously, Intel runs every 30 min, Executor runs on-demand.
- Each agent's context window stays focused — Quant only sees numbers, Intel only sees text, Executor only sees orders.

## Architecture

```
                        ┌─────────────────────┐
                        │   Orchestrator      │
                        │   (OpenClaw Agent)   │
                        │                     │
                        │   Heartbeat: 60min  │
                        │   Model: gemini-pro │
                        └──────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
    ┌─────────▼──────────┐ ┌──────▼───────┐ ┌──────────▼──────────┐
    │   Quant Agent      │ │ Risk Agent   │ │   Intel Agent       │
    │                    │ │              │ │                     │
    │   Tools:           │ │ Tools:       │ │   Tools:            │
    │   - compute_regime │ │ - check_risk │ │   - watch_news      │
    │   - rank_sectors   │ │ - get_prices │ │   - analyze_news    │
    │   - get_signals    │ │ - set_limits │ │   - browse_web      │
    │                    │ │ - circuit_brk│ │   - summarize       │
    │   Heartbeat: 15min │ │ Heartbeat:   │ │   Heartbeat: 30min  │
    │   Model: haiku     │ │ continuous   │ │   Model: haiku      │
    └────────────────────┘ │ Model: haiku │ └─────────────────────┘
                           └──────┬───────┘
                                  │
                        ┌─────────▼──────────┐
                        │  Executor Agent     │
                        │                    │
                        │  Tools:            │
                        │  - place_order     │
                        │  - check_spread    │
                        │  - check_vitals    │
                        │  - manage_positions│
                        │                    │
                        │  Heartbeat: on-demand│
                        │  Model: gemini-pro │
                        └────────────────────┘
```

## Agent Definitions

### 1. Orchestrator Agent (`orchestrator`)

**Role**: High-level decision maker. Reads signals from sub-agents, decides whether to trade, and delegates execution.

**System Prompt Core**:
```
You are the Orchestrator for a multi-agent trading system. You coordinate
Quant, Risk, Intel, and Executor agents. Your job is to:

1. Every heartbeat (60 min), poll Quant for latest signals and rankings
2. Check Risk for any active constraints or circuit breakers
3. If signals suggest rebalancing, ask Intel for news validation
4. If news confirms, delegate to Executor with specific orders
5. Never bypass Risk constraints — if circuit breaker is active, do nothing

Decision framework:
- Quant says BUY + Risk says OK + Intel confirms → Execute
- Quant says BUY + Risk says WARNING → Reduce size by 50%
- Quant says BUY + Risk says CRITICAL → Do not execute
- Any agent unreachable → Log and wait for next heartbeat
```

**Tools**:
| Tool | Target Agent | Purpose |
|------|-------------|---------|
| `ask_quant` | Quant | Get regime, rankings, rebalance signals |
| `ask_risk` | Risk | Get active constraints, portfolio risk metrics |
| `ask_intel` | Intel | Get news sentiment for specific symbols/events |
| `tell_executor` | Executor | Submit trade orders with full context |
| `get_portfolio` | (direct) | Current positions and P&L |
| `send_telegram` | (direct) | Alert human operator |

### 2. Quant Agent (`quant-agent`)

**Role**: Pure quantitative analysis. No trading decisions, no news, no opinions.

**Heartbeat**: Every 15 minutes during market hours.

**System Prompt Core**:
```
You are the Quant Agent. You compute market regime, sector momentum rankings,
and rebalance signals. You work with numbers only — no news, no opinions.

Every heartbeat:
1. Run compute_regime to get SPY regime + breadth
2. Run rank_sectors to get volatility-adjusted rankings
3. Store results in the signal store
4. If regime changed since last check, flag as HIGH priority

You never execute trades. You only publish signals.
```

**Tools**:
| Tool | Purpose |
|------|---------|
| `compute_regime` | SPY SMA200 + sector breadth (SMA50) |
| `rank_sectors` | Composite momentum + ATR + vol-adjusted scores |
| `compute_rebalance` | Rebalance actions with correlation filter |
| `publish_signal` | Write to SQLite signal store |
| `get_bars` | Fetch price bars from Alpaca |

### 3. Risk Agent (`risk-agent`)

**Role**: Real-time risk monitoring. Enforces constraints, triggers circuit breakers.

**Heartbeat**: Continuous (event-driven via WebSocket).

**System Prompt Core**:
```
You are the Risk Agent. You monitor portfolio risk in real-time.
You have the power to HALT all trading via circuit breaker.

Continuous monitoring:
1. Track real-time prices via WebSocket
2. Check per-position stop-losses every tick
3. Track portfolio drawdown from high-water mark
4. Publish constraints when thresholds are breached

Circuit breaker triggers (HALT all trading):
- Portfolio drawdown > 10% from high-water mark
- Intraday loss > 5%
- Any single position drops > 8% in one session
- VIX > 35 (extreme fear)

You never execute trades. You only publish constraints.
```

**Tools**:
| Tool | Purpose |
|------|---------|
| `check_risk` | Run all risk rules against current state |
| `get_realtime_prices` | Latest prices from WebSocket feed |
| `set_stop_loss` | Configure per-symbol stop-loss |
| `activate_circuit_breaker` | Halt all trading |
| `deactivate_circuit_breaker` | Resume trading (requires reason) |
| `publish_constraint` | Write to SQLite constraint store |
| `get_positions` | Current portfolio positions |

### 4. Intel Agent (`intel-agent`)

**Role**: News and sentiment analysis. Validates trade theses with current events.

**Heartbeat**: Every 30 minutes.

**System Prompt Core**:
```
You are the Intel Agent. You monitor news feeds and web sources for
trading-relevant intelligence.

Every heartbeat:
1. Run watch_news for broad market headlines
2. Analyze headlines for sector-specific impacts
3. Flag any contradictions with current positions
4. Store intel summaries in signal store

When asked to validate a trade:
1. Search for recent news on the symbol/sector
2. Check for upcoming events (earnings, FOMC, CPI)
3. Return sentiment: CONFIRMS, CONTRADICTS, or NEUTRAL
4. Include 2-3 key headlines as evidence
```

**Tools**:
| Tool | Purpose |
|------|---------|
| `watch_news` | Poll RSS + NewsAPI feeds |
| `analyze_news` | Keyword-focused news search |
| `browse_web` | Headless browser for specific pages |
| `publish_intel` | Write to SQLite signal store |
| `validate_thesis` | Check if news supports a trade thesis |

### 5. Executor Agent (`executor-agent`)

**Role**: Trade execution only. Receives fully-specified orders from Orchestrator. Handles spread checks, order placement, and confirmation.

**Heartbeat**: On-demand (invoked by Orchestrator).

**System Prompt Core**:
```
You are the Executor Agent. You execute trades with precision.
You receive fully-specified orders from the Orchestrator.

For each order:
1. Check spread — if > 0.15%, warn Orchestrator
2. Check liquidity — if volume < 100K, warn Orchestrator
3. Place order (limit preferred, market only if spread < 0.03%)
4. Confirm fill or report status
5. Never modify order parameters — execute exactly as specified

You never decide WHAT to trade. You only decide HOW to trade
(limit vs market, timing, order splitting for large orders).
```

**Tools**:
| Tool | Purpose |
|------|---------|
| `check_spread` | Bid-ask spread analysis |
| `place_order` | Submit order to Alpaca |
| `check_vitals` | Account snapshot |
| `get_order_status` | Check pending order status |
| `cancel_order` | Cancel a pending order |

## OpenClaw Configuration

### `~/.openclaw/openclaw.json` — Multi-agent setup

```json
{
  "agents": {
    "orchestrator": {
      "model": "google/gemini-3-pro-preview",
      "heartbeat": "0 * * * 1-5",
      "skills": ["orchestrator-tools"],
      "systemPrompt": "skills/orchestrator/SYSTEM.md"
    },
    "quant-agent": {
      "model": "anthropic/claude-haiku",
      "heartbeat": "*/15 9-16 * * 1-5",
      "skills": ["quant-tools"],
      "systemPrompt": "skills/quant-agent/SYSTEM.md"
    },
    "risk-agent": {
      "model": "anthropic/claude-haiku",
      "heartbeat": "continuous",
      "skills": ["risk-tools"],
      "systemPrompt": "skills/risk-agent/SYSTEM.md"
    },
    "intel-agent": {
      "model": "anthropic/claude-haiku",
      "heartbeat": "*/30 9-16 * * 1-5",
      "skills": ["intel-tools", "news-search", "web-search"],
      "systemPrompt": "skills/intel-agent/SYSTEM.md"
    },
    "executor-agent": {
      "model": "google/gemini-3-pro-preview",
      "heartbeat": "on-demand",
      "skills": ["alpaca-trader"],
      "systemPrompt": "skills/executor-agent/SYSTEM.md"
    }
  },
  "orchestration": {
    "interAgentProtocol": "tool-call",
    "sharedState": "sqlite",
    "dbPath": "~/.openclaw/signals.db"
  }
}
```

> **Note**: OpenClaw may not support this exact multi-agent config natively yet. The above is the target architecture. Phase 3 implementation may require OpenClaw updates or a custom orchestration layer outside OpenClaw.

## Inter-Agent Communication Protocol

Agents communicate via the SQLite pub/sub layer (Phase 2) plus direct tool-call invocation for synchronous requests.

### Async (pub/sub):
- Quant → publishes signals → Orchestrator consumes
- Risk → publishes constraints → Orchestrator consumes
- Intel → publishes intel → Orchestrator consumes

### Sync (tool calls):
- Orchestrator → `ask_intel("validate XLK buy thesis")` → Intel responds
- Orchestrator → `tell_executor({ orders: [...] })` → Executor responds with fill status

### Message format:
```ts
interface AgentMessage {
  from: string;        // agent name
  to: string;          // target agent or "broadcast"
  type: "signal" | "constraint" | "intel" | "order" | "ack";
  priority: "low" | "normal" | "high" | "critical";
  payload: unknown;    // JSON
  timestamp: string;
  correlationId: string;  // for request-response tracking
}
```

## Files to Create

### New skills (one per agent):

```
~/.openclaw/workspace/skills/
  orchestrator/
    SKILL.md            # Orchestrator tool definitions
    src/cli.ts          # Entry point
    src/orchestrator.skill.ts
  quant-agent/
    SKILL.md
    SYSTEM.md           # Agent system prompt
    src/cli.ts
    src/quant.skill.ts
  risk-agent/
    SKILL.md
    SYSTEM.md
    src/cli.ts
    src/risk.skill.ts
  intel-agent/
    SKILL.md
    SYSTEM.md
    src/cli.ts
    src/intel.skill.ts
  executor-agent/
    SKILL.md
    SYSTEM.md
    src/cli.ts
    src/executor.skill.ts
```

### Shared libs (from Phase 2, extended):

```
~/.openclaw/workspace/libs/
  pubsub/              # SQLite pub/sub (Phase 2)
  agent-protocol/      # Inter-agent message types + helpers
    src/types.ts
    src/messenger.ts   # send/receive with correlation IDs
    src/router.ts      # Route messages to correct agent
```

## Migration Path

1. **Start with Orchestrator + existing alpaca-trader**: Orchestrator wraps existing skill, no behavior change
2. **Extract Quant Agent**: Move quant logic from alpaca-trader into quant-agent skill
3. **Extract Risk Agent**: Move risk monitoring into risk-agent, connect WebSocket
4. **Extract Intel Agent**: Wire existing news-search + web-search into intel-agent
5. **Extract Executor Agent**: Slim down alpaca-trader to execution-only
6. **Remove alpaca-trader**: Once all logic is distributed, retire the monolith

## Verification

```bash
# Start all agents
docker compose up -d

# Check agent health
curl http://localhost:18789/api/agents | jq '.[] | {name, status, lastHeartbeat}'

# Watch Orchestrator decisions
docker compose logs -f orchestrator

# Check inter-agent messages
sqlite3 ~/.openclaw/signals.db "
  SELECT from_agent, to_agent, type, priority, datetime(timestamp)
  FROM messages ORDER BY timestamp DESC LIMIT 20;
"

# Verify circuit breaker
# 1. Risk agent detects drawdown
# 2. Publishes circuit_breaker constraint
# 3. Orchestrator reads it, stops all buying
# 4. Human gets Telegram alert
docker compose logs risk-agent | grep "circuit_breaker"

# Manual Orchestrator invocation
alpaca-trader ask_quant '{"query": "latest regime and top 3"}'
```

## Success Criteria

1. Each agent runs independently with its own heartbeat and context window
2. Orchestrator correctly coordinates: Quant → Risk check → Intel validate → Execute
3. Circuit breaker halts all trading within 5 seconds of risk trigger
4. Agent failure is isolated — other agents continue operating
5. Inter-agent latency < 2 seconds for sync tool calls
6. Total context window usage across all agents < 50% of single-agent usage
7. Full audit trail in SQLite: every signal, constraint, order, and ack is logged
8. Telegram alerts fire for critical constraints and trade executions
