# Expert Review Synthesis: Sniper Trader System

**Date**: 2026-02-19
**Reviewers**: 4 specialized agents (Risk, Execution, Strategy, Reliability)
**Scope**: Full source code review of M1-M3 implementation

---

## Overall Assessment

| Expert | Domain | Rating | Key Concern |
|--------|--------|--------|-------------|
| Risk Engineer | Capital protection | YELLOW | Realized losses invisible to circuit breaker; bet sizing unenforced |
| Execution Specialist | Order lifecycle | RED | Fire-and-forget orders; proxy retries can duplicate Poly orders |
| Strategy Analyst | Signal quality | YELLOW | Ranking formula mathematically invalid; no out-of-sample validation |
| Reliability Engineer | Runtime failure modes | YELLOW | Ephemeral API health; SQLite open/close per call; no crash recovery |

**Composite Rating: YELLOW-RED** — System is functional for micro-trades (<$5K account) but has structural gaps that could cause significant capital loss at scale. Critical fixes required before increasing account size or trade frequency.

---

## Consolidated Findings by Severity

### CRITICAL (5 findings — could cause immediate capital loss)

| ID | Finding | Expert | Location | Effort |
|----|---------|--------|----------|--------|
| C1 | **Realized losses invisible to daily circuit breaker** — `checkDailyLossLimit()` only sums unrealized P&L from open positions. Closed trades' losses vanish. Agent can serially realize unlimited losses. | Risk | risk-checks.ts:17-38, circuit-breaker.ts:28-57 | S |
| C2 | **No post-order fill verification (Alpaca)** — Orders are fire-and-forget. Limit orders can sit unfilled for hours. No status polling, no reconciliation on restart. | Execution | alpaca.service.ts:234-316 | M |
| C3 | **Proxy retries can duplicate Polymarket orders** — 5 proxy retries × 3 app retries = 15 attempts. No idempotency key. If POST succeeds but response drops, retry resubmits. $100 bet becomes $300+. | Execution | polymarket.service.ts:191-244, 443-454 | L |
| C4 | **Volatility-adjusted ranking formula is mathematically invalid** — `compositeScore / sqrt(atrPercent)` conflates different time scales, has no academic basis, and systematically biases toward low-vol sectors regardless of momentum. | Strategy | ranking.ts:51-54 | M |
| C5 | **SQLite open-close-per-call defeats transaction semantics** — Every function opens/closes a fresh connection. 10+ cycles per agent invocation. Transaction isolation lost, checkpoint storms on Docker volumes, race conditions on deduplication. | Reliability | journal.ts (all functions) | M |

### HIGH (16 findings — significant risk under stress)

| ID | Finding | Expert | Effort |
|----|---------|--------|--------|
| H1 | Bet sizing calculated but never enforced — agent can ignore Kelly and overbet up to 33% concentration limit | Risk | M |
| H2 | Exposure/concentration/dry-powder limits incoherent — can deadlock or leave gaps | Risk | M |
| H3 | Concentration default (33%) exceeds Kelly cap (25%) | Risk | S |
| H4 | Backtest assumes zero slippage — overstates performance by 50-200bps annually | Risk+Strategy | S |
| H5 | Spread analysis is advisory only — no hard execution guard | Execution | M |
| H6 | 15+ min monitoring gap — stop-loss is advisory, not automatic | Execution | M |
| H7 | IEX feed staleness — no timestamp validation, extended hours unreliable | Execution | M |
| H8 | Polymarket balance race — no reservation, no margin tracking | Execution | L |
| H9 | Momentum weights (0.3/0.5/0.2) lack empirical basis — 5d component is reversal signal | Strategy | M |
| H10 | Regime detection (SMA200) has no whipsaw protection — binary flip, no hysteresis | Strategy | M |
| H11 | Correlation threshold (0.65) static across all regimes — too aggressive in bull, too lenient in bear | Strategy | M |
| H12 | No out-of-sample validation — signals trained and tested on same data (look-ahead bias) | Strategy | M |
| H13 | Backtest validates code paths, not statistical significance — no walk-forward analysis | Strategy | L |
| H14 | API health tracker is pure ephemeral state — resets every process start, no cross-invocation memory | Reliability | M |
| H15 | Retry implementations diverge across 3 modules — silent behavior differences, no jitter | Reliability | M |
| H16 | No orphaned order recovery after Docker restart mid-trade | Reliability | L |

### MEDIUM (17 findings — operational improvements)

| ID | Finding | Expert | Effort |
|----|---------|--------|--------|
| M1 | Sharpe ratio missing tail risk metrics (skewness, kurtosis) | Risk | M |
| M2 | Incomplete equity data — Sharpe from sparse snapshots, no confidence interval | Risk | M |
| M3 | Daily P&L summary not pre-computed — restart loses daily tracking | Risk | M |
| M4 | API health doesn't block vitals reads — confused state | Risk | S |
| M5 | Order execution status ambiguity — unfilled orders marked "submitted" conflated with filled | Risk | M |
| M6 | Buying power vs cash confusion in Alpaca pre-check | Execution | S |
| M7 | No blockchain confirmation for Polymarket orders | Execution | S |
| M8 | Static whale threshold ignores volatility | Execution | S |
| M9 | Price staleness in Polymarket indicators | Execution | S |
| M10 | Buy-3/Hold-5 + correlation filter creates excessive turnover | Strategy | M |
| M11 | SMA50 breadth thresholds (7/4) lack statistical validation | Strategy | S-M |
| M12 | Risk parity weighting amplifies low-vol sectors unfairly | Strategy | M |
| M13 | Insufficient error handling in compute.ts — silent failures, -Infinity in JSON | Strategy | S |
| M14 | Docker health check only validates file freshness, not system integrity | Reliability | S |
| M15 | Dual-write (files + SQLite) has zero reconciliation | Reliability | M |
| M16 | Telegram digest silent failures, no retry | Reliability | S |
| M17 | Equity deduplication at 5-min masks intraday volatility | Reliability | S |

### LOW (4 findings — documentation/future-proofing)

| ID | Finding | Expert | Effort |
|----|---------|--------|--------|
| L1 | Backtest doesn't model leverage or margin interest | Strategy | S |
| L2 | Sector universe (11 SPDR) may miss emerging sectors | Strategy | S-M |
| L3 | Tool call logging is fire-and-forget | Reliability | S |
| L4 | Daily digest timezone mismatch (UTC vs ET) | Reliability | S |

---

## Cross-Expert Conflicts & Resolutions

### 1. Bet Sizing: Enforce vs Advisory?
- **Risk Engineer** says: enforce with 1.5x Kelly cap, reject oversize orders
- **Execution Specialist** says: spread should be hard blocker too
- **Resolution**: Implement both. Pre-trade pipeline: (1) check API health → (2) validate spread → (3) enforce bet size cap → (4) check concentration/exposure/dry-powder → (5) submit order → (6) verify fill

### 2. Backtest: Fix First or Ship?
- **Risk Engineer** says: add slippage parameter (quick fix, S effort)
- **Strategy Analyst** says: need walk-forward validation (L effort, foundational)
- **Resolution**: Phase it. Add slippage parameter in Pre-M4 (S). Walk-forward in M5 (L). The slippage fix is useful immediately; walk-forward requires more infrastructure.

### 3. API Health: Persist or Accept Amnesia?
- **Risk Engineer** says: block vitals when API unavailable
- **Reliability Engineer** says: persist to SQLite, add recovery timer
- **Resolution**: Both are needed. Persist health state AND use it to block all API calls (not just trades). Single implementation in M4.

### 4. SQLite: Pool or Restructure?
- **Risk Engineer** says: queries are too fragmented (daily P&L requires full-day scan)
- **Reliability Engineer** says: connection pooling needed (open-close is killing perf)
- **Resolution**: Connection pooling (Pre-M4) + pre-computed daily summaries (M4). Pool first because it's foundational.

---

## Revised Milestone Plan

### Pre-M4: Critical Hotfixes (1-2 days, ~8 hours)

These must ship before any M4 work. All are S or low-M effort.

| Task | Finding | Effort | Description |
|------|---------|--------|-------------|
| P1 | C1 | S | Add realized loss tracking to `checkDailyLossLimit()` — query journal for today's closed trades, sum realized + unrealized P&L |
| P2 | H3 | S | Align `ALPACA_MAX_SINGLE_POSITION_PCT` default from 33 → 25 to match Kelly cap |
| P3 | C5 | M | SQLite connection pooling — cache `DatabaseSync` instance per `openDb()` call, close on process exit only. Run migrations once at init. |
| P4 | H15 | M | Consolidate retry into quant-core/retry.ts — add jitter, per-API config, structured logging. Delete skill-local copies. |
| P5 | H4 | S | Add `slippageBps` parameter to `BacktestConfig` — apply at order execution in backtest engine. Default 10bps. |
| P6 | M13 | S | Signal validation in compute.ts — replace -Infinity with null, add schema check, fail explicitly on bad data |
| P7 | L3 | S | Tool call logging — add retry (3x) and file fallback on SQLite failure |

**Dependency graph**: P3 (SQLite pooling) should land first since P1 depends on journal queries being fast.

```
P3 → P1, P7
P4 (independent)
P2, P5, P6 (independent)
```

**Verification**: Run `npm test` in quant-core after each change. All 144 existing tests must pass + new tests for realized loss tracking and slippage.

---

### M4: Risk Monitor + Order Safety (2-3 weeks)

Split into three parallel workstreams:

#### M4A: Order Lifecycle & Execution Safety (8-10 days)

| Task | Finding | Effort | Description |
|------|---------|--------|-------------|
| 4A-1 | C2, M5 | M | **Alpaca order status tracking** — after `placeOrder()`, poll order status. Record "submitted"/"filled"/"rejected" accurately. Add `getOrderStatus(orderId)` tool. |
| 4A-2 | C3 | L | **Polymarket idempotency** — generate `clientOrderId` per trade intent. After retry success, verify exactly one order exists. Reduce proxy retries to 3. |
| 4A-3 | H5 | M | **Hard spread guard** — make spread check a blocker in `place_order`/`place_trade`. Add estimated slippage calculation. Reject if slippage > configurable threshold. |
| 4A-4 | H6 | M | **Auto stop-loss execution** — convert advisory stop-loss flags to automatic market sells within `manage_positions`. Add configurable dead-man's-switch threshold (-10%). |
| 4A-5 | H16 | L | **Startup reconciliation** — on skill init, fetch open orders from API, compare to journal. Auto-cancel untracked orders with alert. Add `sync_state` tool. |
| 4A-6 | H7 | M | **Price staleness validation** — reject quote/bar data older than 5s. Add market-hours-aware spread thresholds. Volume quality check adjusted for pre/post market. |
| 4A-7 | M6 | S | **Buying power fix** — use `buyingPower` for buy validation, not `cash`. Add margin divergence warning. |

```
4A-1 → 4A-5 (fill tracking enables reconciliation)
4A-2 (independent, Polymarket-specific)
4A-3 → 4A-4 (spread guard enables auto stop-loss)
4A-6, 4A-7 (independent)
```

#### M4B: Risk Model Coherence (5-7 days)

| Task | Finding | Effort | Description |
|------|---------|--------|-------------|
| 4B-1 | H2 | M | **Unified capital allocation model** — replace 3 independent checks with coordinated budget: `maxDeployable`, `minCash`, `maxPerPosition`. Ensure 100% capital accounted for. |
| 4B-2 | H1 | M | **Bet size enforcement** — add optional `useBetSize` flag to order schemas. If enabled, reject orders > 1.5x Kelly recommendation with warning. Log bet-size context. |
| 4B-3 | M3 | M | **Daily P&L pre-computation** — add startup reconciliation of daily_summary table. Query realized + unrealized at end-of-day. Cache for fast circuit breaker checks. |
| 4B-4 | H14 | M | **Persistent API health** — add `api_health` table to SQLite. Load on init, write on state change. Add recovery timer (auto-clear read-only after 5 min of no failures). |
| 4B-5 | M4, M14 | S | **Circuit breaker integration** — check `isApiAvailable()` at ALL tool entry points (including vitals). Expand Docker health check to verify DB integrity + signal content. |

```
4B-4 → 4B-5 (persistent health enables consistent pre-checks)
4B-1 → 4B-2 (unified model enables bet size enforcement)
4B-3 (independent)
```

#### M4C: Signal Quality Foundation (5-7 days)

| Task | Finding | Effort | Description |
|------|---------|--------|-------------|
| 4C-1 | C4 | M | **Fix ranking formula** — replace `compositeScore / sqrt(atrPercent)` with proper risk-adjusted metric (rolling Sharpe or Sortino ratio per sector). Validate against historical rankings. |
| 4C-2 | H10 | M | **Regime whipsaw protection** — add hysteresis: require SPY to move ±1% beyond SMA200 OR hold for 3 consecutive days before regime flip. Make configurable. |
| 4C-3 | H11 | M | **Regime-adaptive correlation threshold** — bull: 0.75, bear: 0.50, neutral: 0.65. Log correlation rejections to journal for monthly audit. |
| 4C-4 | M11 | S | **Breadth threshold validation** — compute forward returns by breadth level on historical data. Calibrate thresholds from data or switch to continuous breadth score. |

```
4C-1 (independent, highest priority)
4C-2 → 4C-3 (regime fix enables regime-dependent correlation)
4C-4 (independent)
```

---

### M5: Strategy Validation & Observability (2-3 weeks)

| Task | Finding | Effort | Description |
|------|---------|--------|-------------|
| 5-1 | H13 | L | **Walk-forward backtester** — 252d train / 63d test rolling windows. Measure in-sample vs out-of-sample Sharpe degradation. Benchmark vs SPY buy-and-hold. |
| 5-2 | H12 | M | **Out-of-sample validation** — fetch 250 bars, use 0-200 for signals, validate on 200-250. Measure forward return correlation with signal strength. |
| 5-3 | H9 | M | **Momentum weight optimization** — grid search over weight triples on rolling 252d windows. Compare to pure 20d momentum baseline. Document chosen weights with backtest stats. |
| 5-4 | M1, M2 | M | **Enhanced Sharpe reporting** — add skewness, kurtosis, worst-day/week, sample size, confidence level. Warn when n < 20. |
| 5-5 | M10 | M | **Turnover reduction** — add ranking stability filter (don't sell if rank drops from top 5 to top 8). Model transaction costs in backtest (3-5 bps per trade). |
| 5-6 | M12 | M | **Fix risk parity weighting** — replace pure inverse-vol with momentum-capped risk parity. Backtest equal-weight vs risk-parity vs momentum-capped. |
| 5-7 | M15 | M | **Dual-write reconciliation** — make SQLite primary, files secondary. Add write_generation versioning. Add `sync_signals` repair tool. |
| 5-8 | M16 | S | **Telegram retry + fallback** — 3x retry with backoff. Persist failed digests for next-day prepend. Increase timeout to 30s. |
| 5-9 | M17 | S | **Equity snapshot granularity** — reduce dedup window from 5min to 30s. Compute true intraday max drawdown separately. |
| 5-10 | L4 | S | **Digest timezone fix** — use ET-based day boundaries, document timezone assumption. |
| 5-11 | H8 | L | **Polymarket balance reservation & margin awareness** — in-memory reservation for pending orders. Add margin ratio awareness. Strict "no margin" default. |
| 5-12 | M8, M9 | S | **Polymarket analytics improvements** — volatility-adjusted whale threshold, indicator staleness warnings. |

---

### M6: Multi-Agent Orchestration & Advanced Features (2-3 weeks)

| Task | Description |
|------|-------------|
| 6-1 | **Multi-agent research framework** — orchestrator prototype that coordinates across skills |
| 6-2 | **Parameter robustness testing** — automated grid search across SMA periods, correlation thresholds, momentum weights (±10%). Flag fragile strategies (Sharpe degrades >20%). |
| 6-3 | **Real-time signal quality monitoring** — daily logging of forward-return correlation to signal strength. Alert on alpha decay. |
| 6-4 | **Sector universe expansion** — evaluate adding granular ETFs or top-50 S&P 500 stocks. Backtest multi-universe comparison. |
| 6-5 | **Blockchain order confirmation (Polymarket)** — poll `getOpenOrders()` post-submission, wait for block confirmation on FOK orders. |
| 6-6 | **WebSocket-based position monitor** — independent of agent cycle, triggers emergency sells on configurable thresholds. |

---

## Effort Summary

| Phase | Tasks | Estimated Hours | Calendar Time |
|-------|-------|-----------------|---------------|
| Pre-M4 | 7 tasks | 8-12 hours | 1-2 days |
| M4A | 7 tasks | 30-40 hours | 8-10 days |
| M4B | 5 tasks | 16-24 hours | 5-7 days |
| M4C | 4 tasks | 12-16 hours | 5-7 days |
| M5 | 12 tasks | 40-56 hours | 2-3 weeks |
| M6 | 6 tasks | 40-60 hours | 2-3 weeks |

M4A/B/C can be parallelized across developers. Total M4 calendar time: ~2 weeks with parallel work.

---

## Dependency Graph (Critical Path)

```
Pre-M4
  ├── P3 (SQLite pooling) ──→ P1 (realized loss tracking) ──→ 4B-3 (daily P&L)
  ├── P4 (retry consolidation)
  ├── P2, P5, P6, P7 (independent quick fixes)
  │
M4 (after Pre-M4 complete)
  ├── M4A (Order Lifecycle) ─────→ M5-11 (Poly balance)
  │   ├── 4A-1 → 4A-5 (fill tracking → reconciliation)
  │   ├── 4A-3 → 4A-4 (spread guard → auto stop-loss) ──→ M6-6 (WebSocket monitor)
  │   └── 4A-2, 4A-6, 4A-7
  │
  ├── M4B (Risk Model) ──────────→ M5-4 (enhanced Sharpe)
  │   ├── 4B-4 → 4B-5 (health persist → pre-checks)
  │   └── 4B-1 → 4B-2 (capital model → bet enforcement)
  │
  └── M4C (Signal Quality) ──────→ M5 (Strategy Validation)
      ├── 4C-1 (ranking fix) ────→ M5-3 (weight optimization)
      ├── 4C-2 → 4C-3 (regime → correlation)
      └── 4C-4 (breadth)

M5 (after M4 complete)
  ├── 5-1 (walk-forward) → M6-2 (parameter robustness)
  ├── 5-2 (OOS validation) → M6-3 (signal quality monitoring)
  └── ...

M6 (after M5 substantially complete)
```

---

## Decisions Requiring User Input

1. **Auto stop-loss behavior (4A-4)**: Should `manage_positions` auto-execute sells when stop-loss triggers, or should it require explicit agent confirmation? Auto-sell is safer but removes human-in-the-loop for the AI agent.

2. **Bet size enforcement (4B-2)**: Should Kelly-based sizing be mandatory (reject oversized orders) or advisory (warn but allow)? Mandatory is safer but may frustrate the AI agent in edge cases.

3. **Ranking formula replacement (4C-1)**: Options:
   - (a) Rolling Sharpe ratio per sector (academically standard)
   - (b) Sortino ratio (penalizes downside only, better for asymmetric returns)
   - (c) Return / max-drawdown (simpler, captures tail risk)

4. **Polymarket proxy retry depth (4A-2)**: Current is 5 proxy × 3 app = 15 max. Recommended reduction to 3 proxy × 2 app = 6 max. Lower retry depth means more failed trades but zero duplicate risk. Acceptable?

5. **Account size threshold for M4 completion**: What account size are you targeting post-M4? This affects the urgency of findings (a $5K account can tolerate advisory-only stop-losses; a $100K+ account cannot).

---

## Verification Checklist (Post-Implementation)

### Pre-M4
- [ ] `npm test` in quant-core — 144 existing tests pass + new tests
- [ ] Circuit breaker test: simulate 3 sequential realized losses, verify daily limit triggers
- [ ] Backtest with 10bps slippage shows reduced returns (confirms slippage applied)
- [ ] SQLite connection pooling: verify single connection per process via `lsof` in container

### M4
- [ ] Order fill verification: place limit order, verify status polling returns "filled"/"cancelled"
- [ ] Polymarket idempotency: simulate network drop after POST, verify no duplicate orders
- [ ] Auto stop-loss: mock -10% position, verify automatic market sell
- [ ] Startup reconciliation: kill process mid-trade, restart, verify orphaned orders detected
- [ ] Regime hysteresis: feed SPY oscillating around SMA200, verify no whipsaw
- [ ] Docker health check: corrupt trades.db, verify container goes unhealthy

### M5
- [ ] Walk-forward backtest: verify out-of-sample Sharpe < in-sample Sharpe (expected)
- [ ] Momentum weights: verify optimized weights outperform default on OOS data
- [ ] Telegram retry: simulate network failure, verify message delivered on retry
- [ ] Dual-write: kill process mid-write, verify reconciliation detects mismatch
