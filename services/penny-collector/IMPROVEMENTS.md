# Penny Collector — Improvement Backlog

Potential improvements to increase P&L and win rate. Review and implement as desired.

---

## Signal Quality

### SQ-1: Binance price confirmation before entry
Currently we rely solely on CLOB midpoint as the directional signal. Adding a quick
Binance spot price comparison (already has a `binance-feed.ts` file) could filter out
cases where the CLOB book is thin and the midpoint is temporarily distorted. Only enter
if CLOB directional signal matches Binance spot trend.

### SQ-10: Near-miss logging for entry threshold calibration
**Observed (cycle 23):** First window with live prices (CF-3 fix active). BTC/15m tracked through
full buy window. Peak Up price was $0.745 at 95s remaining — 0.135 below the $0.88 threshold.
Market reversed to $0.515 at 85s, then oscillated 0.49-0.60 to expiry. Window never triggered.
**Problem:** No log currently records "near misses" — windows where the peak price was ≥$0.80
but fell short of the $0.88 entry threshold. Over many windows this data would:
1. Quantify how often the threshold prevents entry (opportunity cost vs false-positive protection)
2. Show the distribution of "how close we came" (median near-miss gap)
3. Enable data-driven threshold refinement (e.g., if peak price regularly reaches $0.85 and
   converges, lowering threshold to $0.85 adds bets without significantly increasing loss rate)
**Fix:** In ExpiryScanner, track the peak CLOB price for each side per window. On window exit
(when market expires or tokens change), if peak price was ≥$0.80 but < $0.88, log:
  `[near-miss] BTC/15m — peak Up=$0.745 at 95s remaining, never reached $0.88 entry floor`
Also record to journal/SQLite for statistical analysis.
**Threshold context (cycle 23 data):** At $0.745 with 95s remaining, expected value IF resolved
Up would be $0.255/share gain. But the price dropped 0.23 in 10s → the current $0.88 floor is
*correct* for this case. The near-miss log would accumulate evidence to validate or adjust this.
**Priority:** Low — observability/analytics improvement, no direct P&L impact without additional
analysis. Useful for future threshold tuning once 50+ windows of data are collected.

### SQ-2: Order book depth filter
Before entering, check that the ask side has enough size at the winning price to fill
our bet without significant slippage. Currently we only check total liquidity from Gamma.
A thin top-of-book could cause FOK failures even when total liquidity is adequate.
*(Partially addressed: `getAskDepthUsd()` pre-check added in PR #9, but race condition
between WS snapshot and live book remains — FOK can still fail if asks are pulled between
our depth check and order submission.)*

### SQ-6: Tight slippage pre-check — skip entry when depth is stacked far above signal price
**Observed (1):** BTC/15m/Up signal at $0.945 (40s remaining), filled at $0.980 — 3.5¢ slippage
cutting expected profit from $0.275 to $0.10 (~64% reduction).
**Observed (2):** BTC/15m/Up signal at $0.895 (64s remaining), filled at $0.980 — 8.5¢ slippage,
80% profit reduction. `making=4.99996 taking=5.102 → fillPrice=0.980`. All ask depth was at
$0.98; asks between $0.895 and $0.975 were essentially empty.
The current ask-depth check passes because there IS ≥$5 depth below `maxWinningPrice=$0.98`,
but all that depth sat at $0.98. The market order swept through all the thin asks up to $0.98.
**Fix:** Tighten the depth check: verify ≥$5 ask-side depth at or below
`winningPrice + 0.020` (2¢). If depth only exists near `maxWinningPrice`, the expected
fill will be far from signal price — skip rather than accept a predictably bad fill.
**Trade-off:** Will skip entries where depth is thin but concentrated just above signal price.
*(Implemented via `fix/penny-sq6-tight-depth-check`)*

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
**Note:** In observed cases, builder-relayer unexecutable status has actually BENEFITED
P&L — the inability to stop-loss prevented crystallizing losses that subsequently recovered
(both Up@$0.960 and Up@$0.899 resolved correctly despite deep drawdowns). Implementing
relayer-routed stop-losses could eliminate this beneficial "hold to expiry" behaviour, so
consider RM-5 (final-window time-gate) as a prerequisite before implementing RM-4.

### RM-6: Raise PENNY_MAX_CONCURRENT to 2 — allow simultaneous 15m + 1h positions
**Observed:** While holding BTC/1h/Down@$0.960 (bought at 150s remaining), the scanner
found 3 valid BTC/15m/Up candidates: $0.91 (99s), $0.96 (89s), $0.97 (77s). All blocked
by `PENNY_MAX_CONCURRENT=1`. The 15m/Up market settled one-sided at up=$0.985 (all three
would have won). The 1h/Down simultaneously settled at down=$0.985 (both markets won in
the same expiry window).
**Why independent:** 15m and 1h markets have different strikes and expiry times. When both
are simultaneously in the $0.88-$0.98 range, BTC is between the two strikes — the 1h/Down
means BTC is below the 1h strike, and the 15m/Up means BTC is above the 15m strike. These
bets are often *negatively correlated* (BTC rising hurts 1h/Down but helps 15m/Up and vice
versa), making simultaneous holding a natural hedge rather than doubled exposure.
**Estimated P&L impact (this window):** At balance ~$0.94 remaining after 1h/Down buy,
second bet would have been ~$0.80 at $0.91 fill → profit ~$0.08. At higher balances
(e.g. $20 total), second bet would be ~$4 → ~$0.36 additional profit per window.
**Fix:** Set `PENNY_MAX_CONCURRENT=2` in `.env`. Code already supports it (default=3).
No code change needed. Verify risk by monitoring 2-position windows for a week before
raising further.
**Trade-off:** Second position is always cash-limited (remaining balance after first bet
deducted). If balance is low (~$5), second bet may be <$1. If both positions lose
simultaneously (BTC makes a large move against both strikes), total loss doubles. But given
the near-expiry short window (30-180s) and negative correlation structure, simultaneous
losses are less likely than in same-direction bets.

### RM-5: Stop-loss final-window time-gate — suppress within 60s of expiry ⭐ FIXED
**Observed (3 consecutive windows):**
- 66s: Up=$0.785 (-18.2%) → stop-loss triggered → FOK failed → resolved Up +4.2%
- 44s: Up=$0.645 (-32.8%) → stop-loss triggered → FOK failed → resolved Up +4.2%
- 31s: Up=$0.740 (-17.7%) → stop-loss triggered → unexecutable → resolved Up +11.2%
In ALL three cases the stop-loss fired in the final 66s and all three would have locked
in losses that became wins. Near-expiry CLOB prices are unreliable: books are thin, market
makers reprice rapidly before oracle settlement, and large orders cause temporary distortions
that revert within seconds. A stop-loss that fires within the final 60s is almost certainly
firing on noise rather than a genuine directional failure.
**Fix:** In `checkStopLosses()`, skip positions with < 60 seconds remaining. Log once per
position when it enters this window: "Stop-loss suppressed (Xs remaining — final 60s window,
holding to expiry)". After 60s, the position resolves within the next scan cycle anyway.
**Trade-off:** Genuine reversals at 61-90s remaining will not be caught. But evidence shows
near-expiry stop-losses cause more harm than they prevent.
*(Implemented via `fix/penny-stoploss-final-window-gate`)*

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

### SL-1: Stop-loss FOK retry bug — mark exhausted after first FOK failure ⭐ FIXED
**Observed:** BTC/15m/Up entered at $0.960 (126s remaining). Price swung wildly in final 66s:
- 66s: Up=$0.785 (-18.2%) → stop-loss triggered → FOK failed ("order couldn't be fully filled")
- 44s: Up=$0.645 (-32.8%) → stop-loss triggered again → FOK failed again
Market resolved Up → +$0.21 (+4.2%). The stop-loss would have crystallized a loss that became a win.
**Root cause:** FOK failures in `checkStopLosses()` weren't setting `stopLossExhausted=true`.
Only "not enough balance" (builder-relayer) set `stopLossUnexecutable=true`. FOK failures fell
into the `else` branch (just logged), so on the next 5s scan the stop-loss fired again.
**Fix:** Detect "order couldn't be fully filled" in the catch block and set `stopLossExhausted=true`.
Log "thin book, holding to expiry" with seconds remaining for diagnosis.
**Trade-off:** If FOK fails early in the hold (e.g., 120s remaining), we won't retry even if
the book replenishes. In practice, near-expiry books don't replenish quickly enough.
*(Implemented via `fix/penny-stoploss-fok-exhausted`)*

### EX-5: Log rejection reason when executeBuy returns false silently
**Observed:** Scanner logs `Found 1 candidate(s)...BTC/15m/Up@$0.91(99s)` but the next
scan log shows `candidates=1 positions=1` with no BUY attempt. The rejection is silent —
no log explains whether the candidate was blocked by: concurrent limit, dedup, rate limit,
cash check, or slippage reject. When debugging missed entries, it's impossible to tell
which guard fired.
**Fix:** In `executeBuy()`, add a brief `console.log` at each early-return guard:
- Dedup: `"[skip] ${conditionId.slice(0,12)} — already in portfolio (dedup)"`
- Concurrent: `"[skip] ${market.asset}/${timeframe}/${side} — concurrent limit (${size}/${max})"`
- Rate: `"[rate-limit] ${betsThisHour}/${maxBetsPerHour} bets/hr — skipping"`
- Cash: already logged
This makes the per-scan decision visible in logs without adding noise (each guard fires at
most once per candidate).

### EX-4: Sell at CLOB when price drops below entry in final 10s
If a held position's CLOB price drops to < $0.50 with < 10s remaining (market about to
resolve wrong), attempt an emergency CLOB sell instead of waiting for $0 resolution.
Even getting $0.20 back is better than $0.

---

## Infrastructure

### CF-2: Skip force-reconnect when snapshot-failed tokens are far from buy window ⭐ FIXED + VERIFIED
**Observed:** The 4h market oscillated between excluded ($420 liquidity) and included ($4K
liquidity) within the same 15-minute window. Each time it appeared with valid liquidity, its
tokens were subscribed. The CLOB server rarely delivers initial snapshots for low-activity 4h
tokens (thin book, few events). After 3 retries × 30s = 90s, the IN-10 fix triggers a force-
reconnect. This causes an unnecessary reconnect when all snapshot-failed tokens are > 5 minutes
from their buy window — a reconnect for tokens at 22m+ remaining disrupts the existing subscriptions
for tokens approaching expiry.
**Example:** At 7m52s on 15m market, force-reconnect triggered by 4h tokens at 22m42s remaining.
The 15m tokens got disrupted even though they had a valid subscription with prices, and the 15m
was the only market approaching the buy window.
**Fix:** In the `gaveUp && subscribedTokens.size > 0` check in clob-feed.ts, only force-reconnect
if at least one snapshot-failed token is within `BUY_WINDOW_SECS × 2` (e.g., 360s) of expiry.
For tokens > 5 minutes from expiry, just log and continue — the zombie detector will reconnect
if truly stale.
**Trade-off:** Tokens that never get snapshots (e.g., empty 4h books) would accumulate silently.
Accept this — the scan loop's `setTokens()` will eventually drop them when they expire.
**Estimated impact:** Prevents 1-2 unnecessary reconnects per hour when 4h tokens are included.
**Verified (cycle 14):** At 7m38s remaining, 2 tokens gave up snapshots → logged "all >6min from
expiry — skipping force-reconnect". Zombie check then correctly fired at 6m1s (inside 6-min buy
window), reconnecting at the right moment with fresh snapshots. CF-2 deferred reconnect until
urgency threshold was crossed.
*(Implemented via fix/penny-cf2-skip-reconnect-far-tokens)*

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

### IN-8: Timeout on getPortfolioValue() in checkResolutions() — prevents 90-174s scan-loop block
**Observed:** During `checkResolutions()`, `getPortfolioValue()` is awaited synchronously before
the redemption is launched. When the portfolio API is slow (proxy round-trip), this blocks the
entire Node.js scan loop. Two zombies observed: 90s and 174s of CLOB silence while portfoliocheck ran.
While harmless in practice (redemption happens right after window expiry, new window has 12+ min),
it could matter if the next window enters buy range before the portfolio check completes.
**Fix:** Wrap `getPortfolioValue()` with `Promise.race()` against a 12s timeout. If it times out,
skip resolution for this cycle and retry on the next 5s scan tick (leave position in `positions` Map).
This prevents long-duration blocking while guaranteeing at least one successful check before the
2-hour journal hydration expiry window closes.

### IN-7: Journal hydration on restart — reconstruct positions Map from unresolved trades
**Observed:** After service restart, `init()` only populated `betConditionIds` from the portfolio
API, NOT the `positions` Map. This meant `checkResolutions()` iterated an empty map and never
fired for positions created in a previous session. Slippage-reject position (trade #624, Down@$0.990)
filled via builder-relayer survived restart with `pnl=null` until manual service restart with fix.
**Fix:** Extended `init()` to query the journal for unresolved `penny-collector:buy` fills
(status='filled', exitPrice=null, endDate within last 2h) and reconstruct `PennyPosition` objects.
After restart, service logs `Hydrated N positions from journal`, immediately fires redemption for
old positions, and records P&L correctly.
**Observed outcome:** Position 0x33adb17d36 (Down@$0.990, slippageReject=true, builder-relayer fill)
was redeemed successfully via relayer on restart → +$0.05 (+1.0%) profit recorded.
*(Implemented via `fix/penny-journal-hydration`)*
**⚠️ NOT YET DEPLOYED to workspace:** Branch exists but is NOT merged to master / workspace.
Workspace `init()` still only populates `betConditionIds` (dedup), NOT `this.positions`. Confirmed
impact (cycle 16): BTC/15m/Up@$0.970 ($5 bet, winner, interrupted by SIGHUP in cycle 15) survived
the setpriv restart as a dedup entry only — tokens stuck unredeemed on-chain. Merge + deploy ASAP.
**⚠️ PREREQUISITE:** Must deploy IN-13 (`fix/penny-journal-metadata-fix`) FIRST or together —
without tokenId+endDate in metadata, the hydration loop skips all trades silently.

### IN-9: SIGHUP restart loop — graceful shutdown on su session termination ⭐ FIXED
**Observed:** "Session terminated, killing shell..." appears every 3-10 minutes for ALL services
(penny-collector, early-scalper, risk-monitor). The `su -s /bin/sh node -c '...'` entrypoint
sends SIGHUP to the child when the su session ends. Without a SIGHUP handler, Node.js uses
the default SIGHUP action (terminate) — bypassing the shutdown() function. The `su` process
then exits cleanly (code 0) → Docker `restart: unless-stopped` brings the container back.
This causes a ~5-10s scan gap every few minutes. Journal hydration (IN-7) protects trade state,
but the restart interrupts active CLOB subscriptions and can miss buy window entries.
**Root causes:**
1. No `process.on('SIGHUP', shutdown)` handler — shutdown logs and cleanup are skipped.
2. No early health file write — Docker healthcheck may fire before `init()` completes
   (health file doesn't exist until after `await executor.init()` + `writeHealth()` at line 200).
**Fix:** Two changes to `index.ts`:
1. Add `process.on('SIGHUP', shutdown)` so SIGHUP triggers graceful shutdown instead of silent kill.
2. Write an early health stamp (lastPing, openPositions=0, assets) synchronously before `executor.init()`
   using atomic rename. This ensures the health file exists from the very first second of startup.
*(Implemented via `fix/penny-sighup-health-race`)*

### IN-10: CLOB snapshot retry exhaustion causes 30-90s stale-price window ⭐ FIXED
**Observed:** After zombie reconnect (post-resolution), the CLOB server failed to deliver
initial book snapshots for 3 consecutive retry attempts (~90s total). After "giving up"
on all tokens, the code removed them from pending and waited for the zombie timer to fire
(another 30-90s) before force-reconnecting. Observed 64s gap between last "giving up" log
and the next reconnect.
**Log pattern:**
```
Re-subscribing 2 token(s) with missing initial snapshot (attempt 1/3)
Re-subscribing 2 token(s) with missing initial snapshot (attempt 2/3)
Re-subscribing 2 token(s) with missing initial snapshot (attempt 3/3)
Snapshot timeout: giving up on ... after 3 retries  ← all retries done
<64 seconds of silence>                              ← stale prices here
Zombie detected: no messages for 64s — force reconnecting
```
**Risk:** If the 15m window enters the $0.88-$0.98 buy range during the 64s silence window,
the entry would be missed (stale price check causes the scanner to skip the candidate).
**Fix:** After all pending tokens exhaust retries (`gaveUp && _pendingSnapshotSince.size === 0
&& subscribedTokens.size > 0`), immediately call `ws.terminate()` to trigger the existing
close→reconnect path. Eliminates the zombie-timer delay entirely.
*(Implemented via `fix/penny-clob-snapshot-immediate-reconnect`)*

### IN-12: Timeout on getPortfolioValue() in init() — prevents indefinite startup hang ⭐ FIXED
**Observed:** Service started (logged up to "Telegram: configured"), then hung indefinitely
at `await executor.init()` for 3+ minutes without reaching "Running. Scan every 5s."
Root cause: `init()` calls `getPortfolioValue()` with NO timeout. The same API that caused
90-174s blocking in `checkResolutions()` (IN-8) also blocks `init()` — but in `init()`,
the ENTIRE startup is blocked. The scan loop never starts, meaning buy windows are completely
missed for the duration of the hang. With SIGHUP restarts every 3-10 minutes, every other
restart could miss an entire 15m window.
**Root cause:** IN-8 added `Promise.race([getPortfolioValue(), 12s timeout])` to
`checkResolutions()` but the same protection was never applied to `init()`.
**Fix:** Added `const INIT_TIMEOUT_MS = 15_000` and wrapped `getPortfolioValue()` in
`Promise.race()` in `init()`. If the API times out, the existing catch block logs a
non-fatal warning and the service proceeds with an empty dedup set (safe — dedup will be
populated by `hydratePositionsFromJournal()` and the first portfolio check in the next cycle).
After fix: service reliably reaches "Running. Scan every 5s." within 15s of startup even
when portfolio API is slow.
*(Implemented via `fix/penny-init-portfolio-timeout`)*

### IN-11: Remove `su` from Docker entrypoint to eliminate SIGHUP restarts entirely ⭐ FIXED (v2: setpriv)
**Observed:** Even with the SIGHUP handler (IN-9), the container restarts every 3-10 minutes due to
`su -s /bin/sh node -c '...'` creating a PAM session that terminates and sends SIGHUP. Each restart
causes a fresh CLOB reconnect, re-subscription, and snapshot fetch (~5-10s gap). Observed impact:
SIGHUP at 5m27s remaining → service restarted at 3m20s, missing ~2 minutes of pre-window monitoring.
**v1 attempted (runuser):** Replaced `su` with `exec runuser -u node -- npx tsx src/index.ts`.
FAILED — `runuser` on Debian Bookworm ALSO opens a PAM session: `/etc/pam.d/runuser` includes
`pam_keyinit.so revoke` and `pam_unix.so`, which print "Session terminated, killing shell..." and
can send SIGHUP via keyring revocation. Restarts continued.
**v2 fix (setpriv):** Replace with `exec setpriv --reuid=1000 --regid=1000 --init-groups -- npx tsx src/index.ts`.
`setpriv` (util-linux 2.38.1, available in container) drops privileges by calling setuid/setgid
directly — NO PAM session opened, NO SIGHUP ever sent. node UID=1000, GID=1000 (official node image).
Applied to all 6 service entrypoints (openclaw/docker-compose.yml + deploy/docker-compose.yml).
**Verification:** ⭐ CONFIRMED IN PRODUCTION (cycle 16) — Container ran 10+ minutes with status
`Up 10 minutes (healthy)` and zero "Session terminated" messages. Previous runuser version
restarted every 3-10 minutes; setpriv version shows zero restarts. Fix proven.
*(Implemented via fix/penny-md3-liquidity-thresholds commit 2)*

### MD-3: 4h market liquidity threshold excludes thinly-traded but valid markets ⭐ FIXED
**Observed:** `Skip BTC 4h — low liquidity: $420 < $3000 (vol=$31816)`,
`Skip BTC 4h — low liquidity: $2993 < $3000 (vol=$2325)` — 4h market consistently excluded
despite having 84-598x our max bet in depth. The $3000 floor was wildly overcautious for a $5 bet.
**Fix:** Per-timeframe liquidity thresholds — 4h defaults to $500 (100x max bet), 15m/1h keep
the $3000 minimum. Override via env: `PENNY_MIN_LIQUIDITY_4H=500`, `PENNY_MIN_LIQUIDITY_1H`,
`PENNY_MIN_LIQUIDITY_15M`.
- `config.ts`: adds `minLiquidityByTimeframe: Partial<Record<Timeframe, number>>` to PennyConfig
- `market-discovery.ts`: constructor accepts 4th arg, uses `minLiquidityByTimeframe[tf] ?? minLiquidity` per market
- `index.ts`: passes `config.minLiquidityByTimeframe` to MarketDiscovery
**Trade-off:** 4h markets with $400-$2500 depth may have wider spreads and more volatile near-expiry
prices. 4h candle resolves on a longer window (more stable oracle) which offsets this.
**Estimated uplift:** 4h windows excluded in ~60% of scans → could add 2-3 bets/hour for 4h contracts.
*(Implemented via fix/penny-md3-liquidity-thresholds)*

### IN-13: recordTrade metadata missing tokenId/endDate — breaks journal hydration ⭐ FIXED
**Observed (cycle 17):** `fix/penny-journal-hydration` branch's `init()` journal hydration reads
`meta.tokenId` and `meta.endDate` from journal entries, but `recordTrade()` in `execution.ts`
never wrote these fields. The guard `if (!meta.endDate || typeof meta.endDate !== "string") continue;`
causes every trade to be skipped — `journalCount` stays 0, making the journal hydration a silent no-op.
Even after deploying `fix/penny-journal-hydration`, orphaned winning tokens would NEVER be recovered
because the prerequisite data was never stored.
**Fix:** Added `tokenId: candidate.tokenId` and `endDate: candidate.market.endDate` to the
`metadata` object in the `recordTrade()` call inside `executeBuy()`. Two fields, zero risk.
All future buy fills will have the fields needed for journal hydration to reconstruct positions.
**Note:** Existing journal entries (before this fix) still lack these fields — no retroactive fix
possible. But the BTC/15m/Up@$0.970 orphaned token can still be recovered via the portfolio API
path in `init()` (it's in betConditionIds). Only NEW positions bought after this fix will be
recoverable from the journal.
*(Deployed to workspace + fix/penny-journal-metadata-fix branch, cycle 17)*

### SQ-9: Trending-market idle telemetry — alert when consecutive one-sided windows exceed threshold
**Observed (cycles 16-18):** 5+ consecutive 15m/1h windows all one-sided (alternating BTC strong
UP then DOWN). Every window entered the buy window at $0.986/$0.990 or $0.015/$0.985 — never
in the $0.88-$0.98 entry range. The service correctly skips all via `[settled]` but logs nothing
to indicate HOW LONG it's been idle. An operator watching logs sees only silence between market-
discovery lines and cannot distinguish "idle due to trending market" from "bug preventing entries".
**Observed pattern:** BTC in strong directional trend → 15m candles one-sided ~85% of the time,
1h candles one-sided ~70% of the time. Entry windows only open during choppy/range-bound sessions.
**Fix:** Track a rolling counter of consecutive one-sided windows per timeframe. After N=3
consecutive one-sided windows, log a summary and send one Telegram alert:
  `"[penny-collector] Trending idle: last 3x BTC/15m all one-sided (UP). Next candle ends at HH:MM"`
Reset counter when any candidate is found OR when the direction changes (UP→DOWN or vice versa).
Telegram alert: fire once at N=3, then re-fire every N=10 to avoid spam.
**Implementation:** Add `_oneSidedStreak = new Map<string, {count: number, direction: string}>()`
to ExpiryScanner. Increment on `[settled]` detection, reset on candidate emission, log/alert at
threshold. Direction = "UP" if up>0.5, "DOWN" if down>0.5.
**Estimated value:** Reduces operator confusion about service health during trending markets.
Also useful for post-hoc analysis: correlate idle streaks with BTC trend data to estimate
what market volatility conditions maximize entry frequency.
**Low priority** — does not affect P&L, pure observability improvement.

### CF-3: Snapshot retry exhaustion + active WS = permanent price blackout for new tokens ⭐ FIXED
**Observed (cycles 17–20, confirmed pattern):** Every new candle window triggers the same sequence:
1. Subscribe to 2 new token IDs at ~10m remaining (entering subscribe window)
2. Snapshot retry×3 over 90s (retries at 9m10s / 8m37s / 8m5s)
3. All retries exhausted → CF-2 logs "all >6min from expiry — skipping force-reconnect"
4. WS stream remains active (msgs counter always incrementing: 44K+ msgs/cycle)
5. Zombie timer never fires (zombie requires 65s WS silence; stream is NEVER silent)
6. **Result: CLOB prices for these tokens are NEVER populated** — `getPrice(tokenId)` returns 0

**Why zombie assumption is wrong:** CF-2's rationale is "zombie detector will reconnect if truly stale."
But the zombie checks global WS message time, not per-token activity. Since the CLOB stream sends
continuous order-flow for other markets (msgs counter 40K+/cycle), the WS never goes silent for 65s,
so zombie never fires. The "zombie will handle it" assumption only holds if the WS goes quiet — which
it doesn't in normal operation.

**Current exposure:** In trending market sessions (one-sided windows, $0.986/$0.990), this is benign
— prices aren't needed because ExpiryScanner rejects one-sided markets. But during range-bound/choppy
sessions where balanced windows DO occur, ALL buy opportunities would be missed because `getPrice()`
returns 0 → stale price check → scanner skips.

**Fix:** After snapshot retries exhausted and CF-2 skips immediate reconnect, schedule a delayed
reconnect: `setTimeout(() => this._ws?.terminate(), 30_000)`. A "soft zombie" that fires regardless
of WS message activity. With tokens 6–9 minutes from expiry, a 30s delay still leaves 5+ minutes
of fresh price data before the buy window.
**Alternative (lighter):** Use REST API fallback — after snapshot exhaustion, call the CLOB REST
endpoint (`GET /orderbook/:tokenId`) once to seed the price cache. Avoids a full reconnect.
**Trade-off:** Proactive reconnect adds 1–3s of WS gap every new candle cycle. Acceptable given
6+ minutes remaining when it fires.
**Priority:** High — this is a silent miss risk for ALL range-bound market sessions.
**Verification (cycle 21):** Previous service had `emitted=129491` frozen for 38+ min (zero new
price events). After fix deployment + restart: `emitted` went 0→443→24820 in the first 2 minutes.
Active price data flowing; scanner now has valid CLOB prices for entry decisions.
**Confirmed miss (cycle 22):** Cycle 22 logs captured the OLD service (pre-fix) missing an ENTIRE
15m buy window: scans from 177s→36s remaining ALL logged `stale CLOB (up=0.000 STALE)`. Every
scan in the window was skipped. With a 38-min session, 2-3 full buy windows were lost to this bug.
**Live verification (cycle 24, 2nd candle):** CF-3 fired again on brand-new 15m token IDs after
candle rollover. Exact sequence: 3 snapshot retries (9m56s / 8m51s / 7m46s remaining) → exhausted
at 7m22s remaining → CF-2 "all >6min — soft reconnect in 30s" → timer fired at 6m40s remaining
→ WS closed (code=1006) → fresh connection → RAW book snapshots immediate (best_bid:0.92) →
`emitted` rose 259,148→286,528 (+27,380) over 5 min before buy window opened. Market settled at
177s (up=$0.01, down=$0.99) → correct one-sided skip. No missed bet. Fix working as designed.
**Structural pattern confirmed:** CF-3 fires on EVERY new 15m candle rollover. New token IDs
always fail snapshot on the existing WS connection. Delay profile: subscribe at ~10m remaining
→ 3 retries × 30s → CF-3 fires at ~7m30s → reconnect at ~7m00s → fresh data from ~6m40s to 3m.
Leaves 3.7 minutes of live price data before the buy window — adequate margin.
*(Deployed to workspace, fix/penny-cf3-soft-reconnect branch pending review)*

### CF-4: Stale-CLOB emergency reconnect when prices dead during buy window
**Observed (cycle 22):** Pre-CF-3 service showed `[skip] BTC/15m 177s — stale CLOB (up=0.000 STALE)`
for EVERY scan from 177s down to 36s remaining. The entire buy window was lost. CF-3 prevents this
for the normal subscription cycle, but CF-4 is a defensive backstop: if somehow prices are still 0
when the buy window opens (CF-3 reconnect failed, connection refused, race condition), the scanner
should trigger an emergency reconnect rather than silently skipping every scan.
**Fix:** In `ExpiryScanner.findCandidates()`, track consecutive stale scans per market during the
buy window. After N=3 consecutive stale scans (15s), call `clobFeed.forceReconnect()`:
- Add `_staleInWindowCount = new Map<string, number>()` to ExpiryScanner
- When `priceAge > 30_000` inside the buy window (< 180s), increment the counter
- At count === 3: log `[emergency] BTC/15m — stale for 3 scans in buy window, forcing CLOB reconnect`
  and call `clobFeed.forceReconnect()` (new public wrapper for `ws.terminate()`)
- Reset counter on any non-stale scan or market expiry
**Trade-off:** Adds a reconnect mid-buy-window (~1s gap). Acceptable — better than 100% miss.
A reconnect at 150s remaining still leaves 150s of buy window after reconnect (snapshots arrive in ~5s).
**Priority:** Medium — CF-3 should prevent this scenario in normal operation. CF-4 is insurance.

### CF-5: Proactive reconnect on new token IDs — eliminate 150s dead time at candle rollover ⭐ FIXED
**Observed (cycles 24–25):** CF-3 confirmed firing on EVERY new 15m candle rollover. The 150s
delay (3×30s retries + 30s soft-reconnect) leaves ~2m55s of dead time before prices flow. At 9m
remaining (when new tokens subscribed), CF-3 doesn't deliver prices until 7m05s — we lose the
first 2m55s of the 9-minute monitoring window. In a volatile final 3m, this deprives the scanner
of trend context that could distinguish directional moves from noise.
**Root cause:** Same as CF-3 — CLOB server only delivers book snapshots for the FIRST subscribe
batch after a connection opens. Tokens added later on an existing connection never receive
snapshots. CF-3 waits for retries to exhaust (90s) then fires a 30s delayed reconnect (30s).
**Fix:** In `setTokens()`, when new token IDs are detected on a connection older than 30s,
immediately schedule a 5s proactive reconnect. This ensures new tokens are included in the
next connection's initial subscribe batch, getting snapshots within seconds of rollover.
- New field: `_connectionOpenTime = 0` (set in open handler)
- New field: `_proactiveReconnectTimer` (cleaned up in destroy/open handler)
- Guard: `connectionAge > 30_000 && !_proactiveReconnectTimer && !_softReconnectTimer`
- Effect: new tokens get prices in ~5-10s instead of ~150s after rollover
**Dead time comparison:**
- Before CF-5: 9m→7m05s = 2m55s dead at each candle rollover
- After CF-5: 9m→8m55s = 5s dead at each candle rollover
**Additional benefit (cycle 25):** Simultaneous 15m+1h expiry detected (both at 9m49s) — 4 tokens
subscribed at once. CF-5 would fire for all 4 simultaneously, giving 3 extra minutes of data for
both markets before their shared buy window opens.
**Live verification (cycle 26):** CF-5 fired: "New token(s) on 392s-old connection — proactive reconnect
in 5s" → WS closed → fresh connection → "Subscribed to 2 token(s)" → emitted: 13,760→45,716→90,796
(+77K in 2 minutes). Subsequent 15m buy window at 175s remaining showed live prices ($0.185/$0.815)
with zero stale-CLOB warnings — a clean buy window scan with valid price data. Previously (before
CF-3/CF-5), this window would have shown all scans as "stale CLOB (up=0.000 STALE)".
*(Deployed to workspace + fix/penny-cf5-proactive-reconnect branch pending review)*

### SQ-8: Skip expiry-scanner stability check for already-deduped conditionId
**Observed:** After buying BTC/15m/Up at 65s remaining, the expiry-scanner continued running
SQ-5 stability checks on the same market (scan 1/2 at 50s, candidate at 42s). The subsequent
`executeBuy()` correctly rejected via dedup, but the scanner wasted 2 scan cycles on an
already-bought market. Minor but adds noise to logs.
**Fix:** In `ExpiryScanner.findCandidates()`, check if a candidate's conditionId is already
in the executor's dedup set before running stability checks. Skip markets where `executor.betConditionIds.has(conditionId)`. Requires passing executor reference to scanner, or adding a `isAlreadyBought(conditionId)` method on the executor.
**Trade-off:** Very minor log noise reduction. Low priority.
