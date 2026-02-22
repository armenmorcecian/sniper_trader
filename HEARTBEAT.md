# HEARTBEAT — 30-min Cycle (Sector Rotation)

> **Philosophy**: Follow the flow of capital. Never predict — react.

## Every Cycle (Phase 1: Defense)
1. `check_vitals` — check `dailyLossStatus.blocked`
   - If `blocked: true` → **STOP all trading**, report daily P&L, wait for next session
   - If equity $0 → STOP
2. If holding sector positions: `manage_positions` with -7% stop-loss
3. If any flagged: `place_order sell` immediately
4. If `concentrationWarnings` present: note over-concentrated positions, avoid adding to them
5. `trade_journal '{"action":"stats"}'` — check win rate and daily P&L
6. If Monday: `performance_report '{"period":"weekly"}'` — review Sharpe, max drawdown, win rate
   - If Sharpe < 0 for 2+ weeks: message Armen, reduce position sizes to 20%
   - If maxDrawdown < -10%: message Armen, pause new buys this week
   - If win rate < 30%: message Armen, reduce to 15% positions
   - If metrics recovered (Sharpe > 0, drawdown < -5%): message Armen, resume normal 33% sizing

## Monday Only (Phase 2: Weekly Rebalance)
If today is Monday AND market is open:
0. `performance_report '{"period":"weekly"}'` — auto-adapt sizing based on metrics (before rebalancing)
1. `read_signals` → returns regime, rankings, rebalance actions (<100ms)
   - If `stale: true` → fall back to `scan_sectors`
2. **Sentiment cross-check**: before executing buys, run `watch_news` (news-search skill)
   - If top-ranked sector has `bearish` sentiment with confidence > 0.5 → skip or reduce size
   - If contradictory headlines → wait for clarity
3. `trade_journal '{"action":"recent","limit":5}'` — check recent trades on target symbols
   - If last trade on a symbol was a loss → require both technicals + news to align before re-entering
4. Execute SELLS first (free up capital)
5. Execute BUYS second (use adapted sizing: 33%/20%/15% depending on performance metrics, `skipExposureCheck: true`)
6. If Bear Mode: sell all sectors, optionally buy GLD if positive momentum

## Tue–Fri (Phase 3: Monitor)
1. Defense only (Phase 1)
2. Do NOT rebalance mid-week unless hard stop-loss hit

## Report Format
`Regime: Bull/Bear | DailyPnL: -X.X% | Top 3: [XLK, XLY, XLI] | Equity: $X | Action: Rebalanced/Held/Stop-Loss/BLOCKED`
