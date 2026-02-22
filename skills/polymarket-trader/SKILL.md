---
name: polymarket-trader
description: Polymarket trading tools — CLOB orders, portfolio, market scanning, order book analysis
emoji: "\U0001F3AF"
metadata: |
  {
    "requirements": {
      "env": ["PRIVATE_KEY", "WALLET_ADDRESS"],
      "bins": ["node", "npm"]
    },
    "optional_env": ["POLY_API_KEY", "POLY_API_SECRET", "POLY_PASSPHRASE", "POLY_FUNDER", "PROXY_URL"],
    "install": "cd skills/polymarket-trader && npm install"
  }
---

## How to Call Tools

Use the `exec` tool (NOT `openclaw skills`, NOT `nodes invoke`). Always set yieldMs: 60000.

Example exec call:
  command: polymarket-trader <tool_name> '<json_params>'
  yieldMs: 60000

IMPORTANT:
- Always include `'{}'` even for no-param tools
- Always set yieldMs: 60000 — default (10s) is too short and wastes API quota on polling
- Do NOT use `process poll` unless exec explicitly returns a sessionId
- Do NOT chain commands with `&&` — one tool per exec call
- Output is always JSON

## Available Tools

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `check_vital_signs` | none | Portfolio snapshot: balance, equity, positions, status (HEALTHY/WARNING/CRITICAL/DEAD). |
| `manage_open_positions` | `stopLossPercent` (default: -15) | Check positions against stop-loss. Returns exit recommendations with expiration enrichment (hours to expiry, CRITICAL/WARNING). Flagged positions recorded to trade journal. Does NOT auto-sell. |
| `scan_markets` | `category`, `limit`, `minVolume24hr`, `minLiquidity`, `maxSpread` | Find liquid markets in crypto, economics/Fed, and sports daily games. Returns order book depth + whale flags (dynamic threshold: max($5K, 25% of book depth)). Category accepts comma-separated values: `crypto,economics,sports` (default) or `all`. |
| `check_order_depth` | `marketConditionId`, `outcome`, `tradeSide` | Order book analysis + whale wall detection. Returns `safeToTrade` boolean. |
| `place_trade` | `marketConditionId`, `outcome`, `side`, `amount`, `limitPrice`, `orderType` | Execute a limit (GTC) or market (FOK) order. Pre-checks: (1) daily loss circuit breaker — auto-cancels all orders if tripped, (2) API availability, (3) concentration limit (40% default per market), (4) balance and whale detection. All decisions recorded to trade journal. |
| `cancel_order` | `orderId` (optional) | Cancel a specific open order by ID, or omit `orderId` to cancel ALL open orders. Returns cancelled order count. |
| `collect_prices` | `conditionIds` (array) | Poll current prices for tracked markets and store history. Call every cycle to build TA data. |
| `analyze_indicators` | `conditionId`, `outcome` | Calculate RSI(14), MACD(12,26,9), EMA(9,21) on collected price history. Needs 26+ snapshots. |
| `trade_journal` | `action` (recent/daily/stats), `limit`, `since`, `date` | Query trade history, daily P&L summaries, win/loss stats. Actions: `recent` (last N trades), `daily` (day summary + today's count), `stats` (win rate, P&L, blocked count). |
| `performance_report` | `period` (daily/weekly/monthly/all-time), `skill` (alpaca/polymarket) | Performance analytics: Sharpe ratio, max drawdown, win rate, profit factor, equity curve stats. Computed from trade journal + equity snapshots. |

## Key Technical Gotchas

1. **ethers v5, not v6** — `@polymarket/clob-client` depends on ethers v5 internally
2. **Proxy wallet (funder)** — USDC lives in CTF Exchange proxy wallet, NOT the EOA. `POLY_FUNDER` must be set. If unset, agent reads $0 balance.
3. **Gamma stringified JSON** — `clobTokenIds`/`outcomes`/`outcomePrices` are sometimes JSON strings, not arrays. The service handles this automatically.
4. **Parameter normalization** — Agent may pass `conditionId` instead of `marketConditionId`, or `price` instead of `limitPrice`. Handlers accept both.
5. **CLOB balance is microUSDC** (6 decimals) — normalize: `raw > 1000 ? raw / 1e6 : raw`
6. **tickSize + negRisk** — fetched dynamically per market before every order
7. **Order book staleness** — CLOB `/book` can serve stale data. Use `/price` for live pricing, `/book` for depth analysis only.
8. **Missing `side` defaults to `"BUY"`** with explicit validation in `createLimitOrder`/`marketBuy`
9. **FOK SELL** routes through `sellPosition()` which resolves position size automatically
10. **Trade journal** — Every trade decision (success, blocked, error) is recorded to a persistent SQLite journal for audit and performance tracking.

## Daily Loss Circuit Breaker

- **Threshold**: `POLY_MAX_DAILY_LOSS_PCT` (default 10%) — daily P&L vs total equity
- **Action**: When tripped, **auto-cancels ALL open orders** and blocks all trading
- **Enforcement**: `place_trade` checks before every trade; blocked trades recorded to journal
- **Error**: `{ error: "CIRCUIT_BREAKER", ordersCancelled: true }`
- **Reset**: Automatically clears as portfolio P&L changes

## Position Concentration Limits

- **Threshold**: `POLY_MAX_SINGLE_MARKET_PCT` (default 40%) — max % of equity in one market
- **Check**: For BUY side, existing position value + proposed amount vs equity
- **Error**: `{ error: "CONCENTRATION_LIMIT", details: { currentPercent, maxPercent } }`

## Configurable Risk Thresholds

| Variable | Default | Purpose |
|----------|---------|---------|
| `POLY_MAX_DAILY_LOSS_PCT` | 10 | Hard circuit breaker threshold (%) |
| `POLY_MAX_SINGLE_MARKET_PCT` | 40 | Max single market (% of equity) |

All have sensible defaults — the system works without setting them.

## Observability

- **Equity Snapshots**: `check_vital_signs` automatically records equity snapshots to SQLite (deduplicated to 5-min intervals). Used by `performance_report` for Sharpe ratio and max drawdown calculations.
- **Structured Logging**: Every tool call is logged with timestamp, params, result summary, latency, and status to the `tool_calls` table. Logging never breaks tool execution (wrapped in try/catch).
- **Performance Report**: Use `performance_report` to get Sharpe ratio, max drawdown, win rate, profit factor, and equity curve stats for any time period.
