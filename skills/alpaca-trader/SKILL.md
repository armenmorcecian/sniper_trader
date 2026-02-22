---
name: alpaca-trader
description: Alpaca ETF trading tools — orders, portfolio, ETF scanning, spread analysis, price bars
emoji: "\U0001F4C8"
metadata: |
  {
    "requirements": {
      "env": ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"],
      "bins": ["node", "npm"]
    },
    "optional_env": ["APCA_API_BASE_URL"],
    "install": "cd skills/alpaca-trader && npm install"
  }
---

## How to Call Tools

Use the `exec` tool (NOT `openclaw skills`, NOT `nodes invoke`). Always set yieldMs: 60000.

Example exec call:
  command: alpaca-trader <tool_name> '<json_params>'
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
| `check_vitals` | none | Account snapshot: cash, equity, positions, market status (pre/open/after/closed), day trade count, agent health. Includes `dailyLossStatus`: `blocked` (bool), `dailyPnl`, `dailyPnlPercent`, `maxLossPercent`. Also includes `concentrationWarnings` for positions exceeding single-position limit. |
| `manage_positions` | `stopLossPercent` (default: -5) | Stop-loss sweep. Returns flagged positions. Does NOT auto-sell. |
| `scan_etfs` | none | Scan watchlist (SPY, QQQ, XLK, XLE, XLF, XLV, XLI, XLP, XLU, XLY, XLB, GLD, TLT, BITO, IWM). Returns prices, changes, spreads. Sorted by biggest movers. |
| `check_spread` | `symbol` | Bid-ask spread + volume analysis. Returns `liquidEnough` boolean. |
| `place_order` | `symbol`, `side`, `amount`, `qty`, `orderType`, `limitPrice`, `timeInForce`, `extendedHours`, `skipExposureCheck` | Place buy/sell order. Buys use dollar amount (fractional shares). For sells, use `qty` (share count) instead of `amount` (dollar value) — if `qty` not provided, `amount` is treated as dollars. Pre-checks: (1) daily loss circuit breaker — auto-cancels all orders if tripped, (2) API availability, (3) concentration limit (33% default per symbol), (4) exposure limits unless `skipExposureCheck: true`. All decisions recorded to trade journal. |
| `trade_journal` | `action` (recent/daily/stats), `limit`, `since`, `date` | Query trade history, daily P&L summaries, win/loss stats. Actions: `recent` (last N trades), `daily` (day summary + today's count), `stats` (win rate, P&L, blocked count). |
| `performance_report` | `period` (daily/weekly/monthly/all-time), `skill` (alpaca/polymarket) | Performance analytics: Sharpe ratio, max drawdown, win rate, profit factor, equity curve stats. Computed from trade journal + equity snapshots. |
| `get_bars` | `symbol`, `timeframe`, `limit` | Price history bars (1Min/5Min/15Min/1Hour/1Day). |
| `analyze_indicators` | `symbol`, `timeframe` (default: 5Min), `periods` (default: 50) | RSI(14), MACD(12,26,9), EMA(9,21), Classic Pivot Points (S1/S2/P/R1/R2), Bollinger Bands (20,2), ATR(14). Returns BUY/SELL/NEUTRAL signal with confidence + concrete price levels. ATR provides dynamic stop-loss (price - 2×ATR) and take-profit (price + 3×ATR) levels — use these instead of fixed percentages. Needs 26+ bars. |
| `read_signals` | none | Read pre-computed quant signals (regime, rankings, rebalance actions) from the quant-signals service. Returns instantly (<100ms). Prefer this over `scan_sectors`. Falls back warning if signals are stale (>30 min). |
| `scan_sectors` | `stopLossPercent` (default: -7) | Sector rotation engine (live fallback). Fetches SPY regime (bull/bear via SMA200 + breadth regime from sector SMA50s), ranks 11 SPDR sector ETFs by volatility-adjusted composite momentum (5d/20d/60d weighted, divided by √ATR%), applies correlation filtering (rejects >0.65 correlated candidates), and computes risk-parity weights for position sizing. Returns regime, rankings, top 3/5 lists, current holdings, and rebalance actions with targetWeight. Use as fallback when `read_signals` reports stale data. |

## Sector Rotation Workflow

Prefer `read_signals` (pre-computed, <100ms) over `scan_sectors` (live API, ~5s):

1. Call `read_signals` first
2. If `stale: true` or signals missing → fall back to `scan_sectors`
3. Signals are refreshed every 15 minutes during market hours by the quant-signals service

## ETF Watchlist

| Symbol | Sector | News Triggers |
|--------|--------|--------------|
| SPY | S&P 500 | Fed, GDP, earnings season, recession |
| QQQ | Nasdaq 100 | Tech earnings, AI, semiconductor |
| XLK | Technology | Tech earnings, AI, semiconductor, cloud |
| XLE | Energy | Oil price, OPEC, Middle East |
| XLF | Financials | Rate decisions, bank earnings, yield curve |
| XLV | Healthcare | FDA, drug approvals, ACA, Medicare |
| XLI | Industrials | Infrastructure, manufacturing, defense |
| XLP | Consumer Staples | Inflation, consumer spending, defensive |
| XLU | Utilities | Interest rates, defensive, regulation |
| XLY | Consumer Discretionary | Consumer confidence, retail, housing |
| XLB | Materials | Commodities, construction, China demand |
| XLC | Communication | Media, telecom, social platforms |
| XLRE | Real Estate | REITs, interest rates, housing |
| GLD | Gold | Inflation, Fed, geopolitical risk, dollar |
| TLT | Treasuries | Fed rate, inflation, flight to safety |
| BITO | Bitcoin Futures | BTC halving, ETF flows, regulation |
| IWM | Russell 2000 | Small cap, domestic economy, rates |

## Market Hours Reference

| Session | Eastern Time | Notes |
|---------|-------------|-------|
| Pre-market | 4:00 AM - 9:30 AM | Limit orders only, `extendedHours: true` |
| Regular | 9:30 AM - 4:00 PM | Market + limit orders |
| After-hours | 4:00 PM - 8:00 PM | Limit orders only, `extendedHours: true` |
| Closed | 8:00 PM - 4:00 AM | No trading. Weekends + holidays. |

Use `check_vitals` to get `marketStatus` from Alpaca's clock (handles holidays correctly).

## Macro Risk Rules

### TLT Bond Yield Check (Required Before Buying)
Before placing any BUY order on SPY, QQQ, IWM, or XLF:
1. Run `scan_etfs` and check TLT's `changePercent`
2. If TLT is **down > 1%** today → bond yields are spiking → **DO NOT BUY** risk assets
3. If TLT is **down > 2%** → extreme risk-off → consider selling existing positions
4. This does NOT apply to GLD (gold benefits from risk-off) or XLE (driven by oil)

## Sentiment Validation (Pre-Trade Checklist)

Before entering any position > $50:
1. Run `analyze_news` (news-search skill) with keywords matching the trade thesis
2. If NO recent news matches → trade lacks catalyst → **skip or reduce size**
3. If news sentiment contradicts the technical signal → **skip**
4. For Polymarket trades, use `browse_web` to check event-specific pages for volume/interest

### Red Flags (Do Not Trade)
- Zero news results for the asset/event → no market interest
- Contradictory headlines (bullish technicals but bearish news)
- Major scheduled event within 2 hours (FOMC, CPI, NFP) → wait for release

## Key Technical Gotchas

1. **Long only** — No short selling. Side must be `"buy"` or `"sell"` (lowercase for Alpaca API).
2. **PDT rule** — If `dayTradeCount >= 3` and equity < $25K, avoid same-day round trips.
3. **Extended hours** — Only limit orders with `extendedHours: true`.
4. **Exposure validation** — `place_order` auto-checks max exposure, dry powder, single position (all configurable via env vars).
5. **Paper account** — Default `APCA_API_BASE_URL` is `https://paper-api.alpaca.markets`.
6. **Trade journal** — Every trade decision (success, blocked, error) is recorded to a persistent SQLite journal for audit and performance tracking.

## Hard Circuit Breaker

- **Threshold**: `ALPACA_MAX_DAILY_LOSS_PCT` (default 3%) — daily loss vs total equity
- **Action**: When tripped, **auto-cancels ALL open orders** (not just advisory) and blocks all trading
- **Enforcement**: `place_order` checks before EVERY trade; blocked trades recorded to journal
- **Visibility**: `check_vitals` returns `dailyLossStatus.blocked` — check this first each cycle
- **Error**: `{ error: "DAILY_LOSS_LIMIT", circuitBreaker: { cancelledOrders: N } }`
- **Reset**: Automatically clears next trading session (positions P&L resets)

## Position Concentration Limits

- **Threshold**: `ALPACA_MAX_SINGLE_POSITION_PCT` (default 33%) — max % of equity in one symbol
- **Check**: For buys, existing position value + proposed amount vs equity
- **Visibility**: `check_vitals` returns `concentrationWarnings` for over-concentrated positions
- **Error**: `{ error: "CONCENTRATION_LIMIT", details: { currentPercent, maxPercent } }`

## Configurable Risk Thresholds

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALPACA_MAX_DAILY_LOSS_PCT` | 3 | Hard circuit breaker threshold (%) |
| `ALPACA_MAX_SINGLE_POSITION_PCT` | 33 | Max single position (% of equity) |
| `ALPACA_MAX_TOTAL_EXPOSURE_PCT` | 50 | Max total exposure (% of equity) |
| `ALPACA_DRY_POWDER_MIN_PCT` | 20 | Min cash reserve (% of equity) |

All have sensible defaults — the system works without setting them.

## Observability

- **Equity Snapshots**: `check_vitals` automatically records equity snapshots to SQLite (deduplicated to 5-min intervals). Used by `performance_report` for Sharpe ratio and max drawdown calculations.
- **Structured Logging**: Every tool call is logged with timestamp, params, result summary, latency, and status to the `tool_calls` table. Logging never breaks tool execution (wrapped in try/catch).
- **Performance Report**: Use `performance_report` to get Sharpe ratio, max drawdown, win rate, profit factor, and equity curve stats for any time period.
