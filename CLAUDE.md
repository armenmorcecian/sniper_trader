# CLAUDE.md — Sniper Trader Workspace Guide

## Project Overview

Sniper Trader is an autonomous trading system built on the **OpenClaw** agent platform. It implements a **weekly sector rotation strategy** using SPDR sector ETFs via the Alpaca brokerage API, with a secondary **Polymarket prediction market** trading capability. The system is designed to run as a Docker-based multi-service architecture with an AI agent (currently Gemini Flash 3 Preview) orchestrating trades.

**Owner**: Armen
**Agent Persona**: "The Architect" — a calm, calculated, risk-averse systematic swing trader.

## Repository Structure

```
sniper_trader/
├── libs/
│   └── quant-core/              # Shared quant library (npm package)
│       ├── src/
│       │   ├── index.ts          # Re-exports all modules
│       │   ├── types.ts          # Core type definitions (PriceBar, Regime, SectorMomentum, etc.)
│       │   ├── constants.ts      # SECTOR_UNIVERSE (11 SPDR ETFs), ETF_WATCHLIST, CORRELATION_THRESHOLD
│       │   ├── regime.ts         # Bull/bear regime detection (SPY SMA200 + sector breadth)
│       │   ├── ranking.ts        # Sector momentum ranking (composite 5d/20d/60d)
│       │   ├── rebalance.ts      # Rebalance action generation (correlation filter + risk-parity)
│       │   ├── momentum.ts       # Composite momentum, ATR metrics, risk-parity weights
│       │   ├── math.ts           # round(), dailyReturns(), pearsonCorrelation()
│       │   ├── signals.ts        # SQLite-based signal read/write/history
│       │   ├── journal.ts        # Trade journal, equity snapshots, tool call logging (SQLite)
│       │   ├── performance.ts    # Sharpe ratio, max drawdown, profit factor, win rate
│       │   ├── backtest.ts       # Backtesting engine
│       │   ├── risk-alerts.ts    # Risk alert insert/query/resolve (SQLite)
│       │   ├── circuit-breaker.ts # Daily loss circuit breaker + concentration checks
│       │   ├── api-health.ts     # API availability tracking (success/failure counters)
│       │   ├── retry.ts          # withRetry() + isRetryable() for transient failures
│       │   ├── validation.ts     # Bar data validation (NaN/zero filtering)
│       │   └── __tests__/        # Vitest unit tests (one per module)
│       ├── package.json
│       └── tsconfig.json
│
├── services/
│   ├── quant-signals/            # Standalone cron job — computes regime/rankings/rebalance
│   │   └── src/
│   │       ├── index.ts          # Entry: cron schedule (*/15 9-16 * * 1-5) + daily digest at 5PM ET
│   │       ├── compute.ts        # Orchestrator: fetches Alpaca bars, runs quant pipeline, writes JSON + SQLite
│   │       ├── daily-digest.ts   # Telegram daily P&L digest
│   │       ├── alpaca-client.ts  # Minimal Alpaca data REST client (bars + positions)
│   │       ├── backtest-runner.ts # Scheduled backtest execution
│   │       └── regime.ts, ranking.ts, rebalance.ts  # Re-exports from quant-core
│   │
│   └── risk-monitor/             # Always-on WebSocket risk monitor
│       └── src/
│           ├── index.ts          # Entry: WS connections, risk check intervals, cron cleanup
│           ├── risk-engine.ts    # Core risk evaluation (stop-loss, daily loss, drawdown)
│           ├── position-tracker.ts # REST reconciliation + real-time position tracking
│           ├── ws-trading.ts     # Alpaca trading WebSocket (trade updates/fills)
│           ├── ws-data.ts        # Alpaca data WebSocket (real-time bars)
│           ├── ws-base.ts        # Base WebSocket class with reconnection
│           ├── alerter.ts        # Telegram alert sender
│           ├── config.ts         # Environment-based configuration loader
│           ├── health.ts         # Health ping writer (meta JSON)
│           └── types.ts
│
├── skills/                       # OpenClaw agent skill plugins
│   ├── alpaca-trader/            # Primary ETF trading skill
│   │   ├── SKILL.md              # Tool definitions + usage docs for the agent
│   │   ├── src/
│   │   │   ├── alpaca.skill.ts   # Skill registration + tool handlers (29KB)
│   │   │   ├── alpaca.service.ts # Alpaca REST API client
│   │   │   ├── indicators.ts     # RSI, MACD, EMA, Bollinger, Pivot Points, ATR
│   │   │   ├── analysis.ts       # Technical analysis signal generation
│   │   │   ├── risk-checks.ts    # Pre-trade risk validation
│   │   │   ├── rotation.ts       # Sector rotation re-exports
│   │   │   ├── types.ts          # Skill-specific types
│   │   │   ├── utils.ts          # Formatting and helper utilities
│   │   │   └── cli.ts            # CLI entry point for skill invocation
│   │   └── .env.example
│   │
│   ├── polymarket-trader/        # Polymarket prediction market skill
│   │   ├── SKILL.md
│   │   ├── src/
│   │   │   ├── polymarket.skill.ts  # Skill registration (25KB)
│   │   │   ├── polymarket.service.ts # CLOB client + Gamma API (31KB)
│   │   │   ├── indicators.ts     # TA indicators for prediction markets
│   │   │   ├── analysis.ts       # Market analysis
│   │   │   ├── price-collector.ts # Price history collection
│   │   │   ├── types.ts
│   │   │   ├── utils.ts
│   │   │   └── cli.ts
│   │   └── .env.example
│   │
│   ├── news-search/              # News aggregation + sentiment
│   │   ├── SKILL.md
│   │   └── src/
│   │       ├── news.skill.ts     # watch_news + analyze_news tools
│   │       ├── news.service.ts   # RSS + NewsAPI client (10 feeds)
│   │       ├── sentiment.ts      # Negation-aware sentiment scoring (-1 to +1)
│   │       ├── types.ts
│   │       └── cli.ts
│   │
│   └── web-search/               # Headless Chromium browsing
│       ├── SKILL.md
│       └── src/
│           ├── web.skill.ts      # browse_web tool
│           ├── web.service.ts    # Puppeteer headless browser
│           ├── types.ts
│           └── cli.ts
│
├── deploy/
│   ├── docker-compose.yml        # 4 services: openclaw-gateway, quant-signals, risk-monitor, openclaw-cli
│   ├── Dockerfile                # Node 22 + Bun + Chromium deps, builds with pnpm
│   └── entrypoint.sh             # Symlinks openclaw + skill wrappers into PATH
│
├── staging/                      # Architecture roadmap (not yet implemented)
│   ├── PHASE1_QUANT_AGENT.md     # Standalone quant process (completed)
│   ├── PHASE2_PUBSUB_LAYER.md    # SQLite pub/sub + real-time risk (completed)
│   └── PHASE3_MULTI_AGENT.md     # Multi-agent orchestrator (future)
│
├── IDENTITY.md                   # Agent persona definition
├── SOUL.md                       # Agent decision-making philosophy
├── STRATEGY.md                   # Sector rotation strategy rules
├── HEARTBEAT.md                  # 30-min execution cycle definition
├── AGENTS.md                     # Agent workspace/session instructions
├── MEMORY.md                     # Persistent trade context
├── USER.md                       # Human operator info (Armen)
├── TOOLS.md                      # Environment-specific tool notes
└── .gitignore
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict mode, ES2022 target) |
| Runtime | Node.js 22 (via tsx for dev, tsc for build) |
| Package Manager | npm (per-package), pnpm (Docker build) |
| Build | `tsc` (TypeScript compiler) |
| Test Framework | Vitest (quant-core only) |
| Database | SQLite (via better-sqlite3 in quant-core, accessed by services) |
| Containerization | Docker + docker-compose |
| Scheduling | node-cron |
| HTTP Client | axios |
| WebSocket | ws |
| Technical Indicators | technicalindicators |
| Schema Validation | @sinclair/typebox (skills) |
| Headless Browser | Puppeteer + Chromium |
| Blockchain | ethers v5 (Polymarket only) |
| Notifications | Telegram Bot API |

## Key Commands

### quant-core (shared library)

```bash
cd libs/quant-core
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc
npm test              # vitest run
npm run test:watch    # vitest (watch mode)
```

### quant-signals service

```bash
cd services/quant-signals
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc
npm start             # npx tsx src/index.ts
```

### risk-monitor service

```bash
cd services/risk-monitor
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc
npm start             # npx tsx src/index.ts
```

### Skills (all follow same pattern)

```bash
cd skills/<skill-name>
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc
```

### Docker

```bash
cd deploy
docker compose up -d                    # Start all services
docker compose logs -f quant-signals    # Watch quant service logs
docker compose logs -f risk-monitor     # Watch risk monitor logs
```

## Testing

Tests exist only in `libs/quant-core/src/__tests__/` and use **Vitest**. Every module in quant-core has a corresponding test file:

- `api-health.test.ts`
- `backtest.test.ts`
- `circuit-breaker.test.ts`
- `journal.test.ts`
- `math.test.ts`
- `momentum.test.ts`
- `performance.test.ts`
- `ranking.test.ts`
- `rebalance.test.ts`
- `regime.test.ts`
- `retry.test.ts`
- `risk-alerts.test.ts`
- `signals.test.ts`
- `validation.test.ts`

Run all tests:
```bash
cd libs/quant-core && npm test
```

Services and skills do not currently have tests — they rely on the quant-core library being well-tested and on manual/integration testing via the Docker environment.

## Architecture & Data Flow

```
Alpaca API                    OpenClaw Agent
    │                              │
    ├── bars/positions ──────►  quant-signals (cron */15min)
    │                              │
    │                              ├── writes JSON → ~/.openclaw/signals/
    │                              └── writes SQLite → quant-core journal
    │
    ├── WebSocket (trades) ──► risk-monitor (always-on)
    ├── WebSocket (bars)   ──► risk-monitor
    │                              │
    │                              ├── evaluates risk rules every 60s
    │                              ├── writes alerts → SQLite (quant-core risk-alerts)
    │                              ├── records equity snapshots → SQLite
    │                              └── sends Telegram alerts on breaches
    │
    └── REST (orders) ◄──────── alpaca-trader skill (agent-driven)
                                   │
                                   ├── reads pre-computed signals (read_signals)
                                   ├── places orders (place_order)
                                   ├── records all trades → SQLite journal
                                   └── performance_report from journal data
```

## Environment Variables

### Required (for trading)

| Variable | Used By | Purpose |
|----------|---------|---------|
| `APCA_API_KEY_ID` | quant-signals, risk-monitor, alpaca-trader | Alpaca API key |
| `APCA_API_SECRET_KEY` | quant-signals, risk-monitor, alpaca-trader | Alpaca API secret |

### Required (for Polymarket)

| Variable | Used By | Purpose |
|----------|---------|---------|
| `PRIVATE_KEY` | polymarket-trader | Ethereum wallet private key |
| `WALLET_ADDRESS` | polymarket-trader | Ethereum wallet address |

### Optional

| Variable | Default | Purpose |
|----------|---------|---------|
| `APCA_API_BASE_URL` | `https://paper-api.alpaca.markets` | Paper vs live trading |
| `TELEGRAM_BOT_TOKEN` | — | Telegram alert notifications |
| `TELEGRAM_CHAT_ID` | — | Telegram chat for alerts |
| `NEWS_API_KEY` | — | NewsAPI premium access (80 calls/day) |
| `PROXY_URL` | — | HTTP proxy for web-search |
| `ALPACA_MAX_DAILY_LOSS_PCT` | 3 | Daily loss circuit breaker (%) |
| `ALPACA_MAX_SINGLE_POSITION_PCT` | 33 | Max single position concentration (%) |
| `ALPACA_MAX_TOTAL_EXPOSURE_PCT` | 50 | Max total portfolio exposure (%) |
| `ALPACA_DRY_POWDER_MIN_PCT` | 20 | Minimum cash reserve (%) |
| `POLY_MAX_DAILY_LOSS_PCT` | 10 | Polymarket daily loss breaker (%) |
| `POLY_MAX_SINGLE_MARKET_PCT` | 40 | Polymarket max single market (%) |
| `RISK_STOP_LOSS_PCT` | 5 | Risk monitor per-position stop-loss (%) |
| `RISK_MAX_DRAWDOWN_PCT` | 10 | Risk monitor max drawdown (%) |
| `RISK_CHECK_MS` | 60000 | Risk check interval (ms) |
| `RISK_RECONCILE_MS` | 300000 | Position reconciliation interval (ms) |

Environment files are loaded from `.env` in the package directory, then from `~/.openclaw/.env` as fallback.

## Conventions & Patterns

### TypeScript

- **Strict mode** enabled in all tsconfig files.
- **ES2022** target, **CommonJS** module output.
- Types are defined in dedicated `types.ts` files per package.
- Re-exports are organized by category in `index.ts` with section comment headers (`// --- Section ---`).
- Module resolution uses `"node"` strategy.

### Code Organization

- **Skills** follow the pattern: `<name>.skill.ts` (tool registration), `<name>.service.ts` (API client), `cli.ts` (entry point), `types.ts`.
- **Services** have a single `index.ts` entry point that sets up cron/intervals and wires components.
- **quant-core** is the shared library — all quantitative logic, journal, and SQLite access lives here. Services and skills depend on it via `"quant-core": "file:../../libs/quant-core"`.

### Data Storage

- **SQLite** is the primary data store (trade journal, equity snapshots, tool call logs, risk alerts, signal history). Accessed via `better-sqlite3` through quant-core.
- **JSON files** in `~/.openclaw/signals/` provide a secondary signal output (regime.json, rankings.json, rebalance.json, meta.json) for fast agent reads.
- Writes use **atomic rename** pattern (write to `.tmp`, then rename).

### Error Handling

- Non-fatal errors are caught and logged, never crash the service.
- SQLite writes in services are wrapped in try/catch with `(non-fatal)` logging.
- The `withRetry()` utility in quant-core handles transient API failures with exponential backoff.
- `isRetryable()` classifies errors (network, 429, 5xx) for retry decisions.

### Risk Management (Critical)

- **Circuit breakers**: Daily loss limits auto-cancel all open orders and block new trades.
- **Concentration limits**: Max percentage of equity in a single position.
- **Risk monitor** runs independently — writes block alerts to SQLite that the agent checks.
- **Pre-market cleanup**: Daily loss alerts are resolved at 9:25 AM ET each trading day.
- **Hard stop-loss**: -7% on any single ETF position (strategy level).

### Agent Markdown Files

The root-level `.md` files define the AI agent's behavior (these are NOT developer docs):

| File | Purpose |
|------|---------|
| `IDENTITY.md` | Agent persona (name, role, vibe) |
| `SOUL.md` | Decision-making philosophy |
| `STRATEGY.md` | Sector rotation algorithm rules |
| `HEARTBEAT.md` | 30-minute execution cycle |
| `AGENTS.md` | Session startup procedure |
| `MEMORY.md` | Persistent trade context |
| `USER.md` | Human operator profile |
| `TOOLS.md` | Environment-specific notes |

Each skill also has a `SKILL.md` that defines available tools for the agent.

### Sector Rotation Universe

The strategy trades exactly 11 SPDR sector ETFs (defined in `libs/quant-core/src/constants.ts`):

`XLK, XLF, XLV, XLE, XLY, XLP, XLI, XLU, XLB, XLC, XLRE`

Regime detection uses SPY (S&P 500) as the market health indicator. Safe havens: BIL (T-Bills), GLD (Gold).

## Development Workflow

1. **Shared logic** goes in `libs/quant-core/` with unit tests.
2. **Services** (quant-signals, risk-monitor) consume quant-core and run as long-lived processes.
3. **Skills** are OpenClaw plugins that expose tools to the AI agent via CLI wrappers.
4. All packages use `tsc --noEmit` for type checking (run `npm run typecheck`).
5. Only quant-core has automated tests. Run `cd libs/quant-core && npm test` before modifying quantitative logic.
6. Services run via `npx tsx src/index.ts` in development — no build step needed.
7. Docker builds compile everything with `tsc` and run compiled JS.

## Roadmap

The `staging/` directory contains the architectural evolution plan:

- **Phase 1** (completed): Standalone quant-signals process replacing in-agent computation.
- **Phase 2** (completed): SQLite pub/sub layer + real-time risk-monitor with Alpaca WebSocket.
- **Phase 3** (future): Multi-agent architecture with Orchestrator, Quant, Risk, Intel, and Executor agents running as independent OpenClaw instances.
