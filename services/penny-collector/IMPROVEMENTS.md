# Penny Collector — Improvement Backlog

Potential improvements to increase P&L and win rate. Review and implement as desired.

---

## Signal Quality

### SQ-1: Binance price confirmation before entry
Currently we rely solely on CLOB midpoint as the directional signal. Adding a quick
Binance spot price comparison (already has a `binance-feed.ts` file) could filter out
cases where the CLOB book is thin and the midpoint is temporarily distorted. Only enter
if CLOB directional signal matches Binance spot trend.

### SQ-2: Order book depth filter
Before entering, check that the ask side has enough size at the winning price to fill
our bet without significant slippage. Currently we only check total liquidity from Gamma.
A thin top-of-book could cause FOK failures even when total liquidity is adequate.
*(Partially addressed: `getAskDepthUsd()` pre-check added in PR #9, but race condition
between WS snapshot and live book remains — FOK can still fail if asks are pulled between
our depth check and order submission.)*

### SQ-6: Tight slippage pre-check — skip entry when depth is stacked far above signal price
**Observed:** BTC/15m/Up signal at $0.945 (40s remaining), filled at $0.980 — 3.5¢ slippage
cutting expected profit from $0.275 to $0.10 (~64% reduction). The current ask-depth check
passes because there IS ≥$5 depth below `maxWinningPrice=$0.98`, but all that depth sat at
$0.98, not at the signal price. The market order swept through all the thin asks up to $0.98.
**Fix:** Tighten the depth check: verify ≥$5 ask-side depth at or below
`winningPrice + SLIPPAGE_TOLERANCE` (e.g. 0.015 = 1.5¢). If depth only exists near
`maxWinningPrice`, the expected fill will be far from signal price — skip rather than accept
a predictably bad fill. This trades fewer entries for better average fill quality.
**Trade-off:** Will skip some valid entries where depth is thin but concentrated just above
signal price. Set tolerance generously (2¢) to avoid over-filtering.

### SQ-5: Price stability filter — require ≥2 consecutive in-range scans before entry
**Observed:** BTC/15m at 76s had Up=$0.89 (in range), but then dropped to $0.83 at 50s,
$0.68 at 40s — a volatile spike-and-revert. This suggests a single large order temporarily
pushed the price into range, not genuine market convergence. Second data point: BTC/15m/Up
signal at 125s ($0.875 out-of-range) → 115s ($0.895 first in-range → FOK failed) → 100s
($0.925 second in-range → filled $0.899). SQ-5 would have skipped the 115s FOK call
and triggered cleanly at 100s with the same or better fill.
**Fix:** Track how many consecutive scans each market has been in the winning-price range.
Only emit as a candidate if the price has been in range for ≥2 consecutive scans (≥6 seconds).
A single-scan spike is unreliable; genuine convergence produces sustained in-range prices.
**Trade-off:** Slightly tighter entry window (need 6s of in-range readings), but filters
out noise from thin-book spikes.
*(Implemented via `fix/penny-sq5-price-stability`)*

### SQ-3: Recent trade activity filter
If no trades have occurred on the CLOB for the last N seconds for a token, the midpoint
may be stale even if it's within the 30s price-age window. Filter on `lastTradeTime`
to ensure there's genuine recent activity before buying.

### SQ-4: Skip markets too far from strike
Candle contracts where BTC spot is very far from the strike (e.g. > 1% above/below) at
entry time are unlikely to flip. While the CLOB already prices this in, we could add an
explicit Binance-spot sanity check to avoid buys where BTC would need to move > 0.5%
in the remaining seconds.

---

## Risk Management

### RM-1: Per-session daily loss limit
Add a session-level daily loss cap (e.g. -$15/day). If total realized P&L for the day
hits the floor, pause new buys until tomorrow. Prevents runaway losses in bad market
conditions.

### RM-2: Win-rate adaptive position sizing
Track rolling win rate over last 20 bets. If win rate drops below 50%, halve the bet
size until it recovers above 60%. If win rate is above 80% for 20+ bets, increase toward
max. Current fixed sizing leaves money on the table in hot streaks.

### RM-3: Consecutive-loss circuit breaker
If we lose 3 bets in a row (all resolved $0), pause new entries for 30 minutes. The
market may be in a highly volatile regime where near-expiry prices are unreliable.

### RM-4: Stop-loss for builder-relayer fills
Currently `stopLossUnexecutable = true` when CLOB rejects with "not enough balance"
(tokens from builder fills aren't in CTF proxy). Fix: detect builder-relayer fills at
entry time (check response metadata) and route stop-loss through the relayer instead.

---

## Execution

### EX-1: Pre-check ask-side depth before placing FOK ⭐ HIGH PRIORITY
**Observed:** BTC/15m/Down window had 3 consecutive FOK failures ($0.895 → $0.885 → $0.935)
before finally filling at $0.960. `fastMarketBuy` uses `createAndPostMarketOrder` (true market
order), so FOK failures mean insufficient ask-side depth to fill $5 at the computed worst-case
price. Each retry burns ~3-5s of the buy window.
**Root cause:** When the Down midpoint was $0.885-0.895, the ask side didn't have $5+ depth to
fill. The midpoint then jumped to $0.935 (ask ≈ $0.960) where $5 could be filled. Net result:
fill at $0.960 vs signal at $0.895 = 6.5¢ slippage, cutting expected profit by ~64%.
**Fix:** Before calling `fastMarketBuy`, sum the ask-side size in `clobFeed.bookAsks` at/below
the current ask to verify ≥ $5 fillable. Skip entry if depth is insufficient — wait for the
book to replenish rather than burning 3 retries. Relates to SQ-2 (order book depth filter).
**Impact:** 3 FOK failures delayed fill by ~15s and pushed fill price from $0.895 to $0.960,
cutting expected profit ~64% (from ~$0.59 to ~$0.21).

### EX-2: Parallel multi-asset scanning (ETH, BTC)
Add ETH candle markets to the scan. ETH and BTC 15m windows are independent, doubling
bet opportunities per hour. Config already supports multi-asset via `PENNY_ASSETS=BTC,ETH`.

### EX-3: Earlier subscription for expiring tokens
Subscribe to expiring market tokens 10 minutes before their buy window opens (currently
done at each scan based on Gamma's active list). This ensures book snapshots arrive
well before the 180s window and avoids the stale-price-on-resubscribe issue.
*(Partial fix already applied via fix/penny-stale-clob-price-on-resubscribe)*
*(Additional fix: snapshot retry after 30s wait applied via fix/penny-clob-snapshot-retry —
if server drops initial subscription, re-subscribes on next 30s ping. Observed: 54s of
stale at window start for 18:45 UTC BTC/15m because initial book snapshot never arrived.)*

### EX-4: Sell at CLOB when price drops below entry in final 10s
If a held position's CLOB price drops to < $0.50 with < 10s remaining (market about to
resolve wrong), attempt an emergency CLOB sell instead of waiting for $0 resolution.
Even getting $0.20 back is better than $0.

---

## Infrastructure

### IN-1: Persist CLOB price cache across container restarts
On shutdown, write the current `_prices` + `_lastUpdateMs` maps to a temp file. On
startup, reload them so the first scan after restart has prices immediately available
rather than waiting for fresh WS snapshots.

### IN-2: Metrics endpoint
Expose a simple HTTP endpoint (or write to the signals JSON) with live stats:
bets placed, win rate, total P&L, current positions. Makes it easier to monitor
performance without tailing Docker logs.

### IN-3: Alert on repeated missed windows
If the scanner skips 3+ consecutive windows for the same reason (stale CLOB, FOK fail,
spread too wide), send a Telegram alert so the operator can investigate. Currently
missed windows are silent unless you're actively watching logs.

### IN-4: Database persistence for P&L tracking
Wire up `recordEquitySnapshot` calls after each resolution to build a time-series P&L
chart queryable from the trade journal. Currently resolutions are journaled but no
daily/weekly summary is computed for this service specifically.
