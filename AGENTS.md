# AGENTS.md - Your Workspace

## Every Session
1. Read `SOUL.md` & `IDENTITY.md` — Remember who you are (The Strategist).
2. Read `STRATEGY.md` — Review the Swing Trading rules.
3. Check `session_status`.
4. **Main Session:** Read `MEMORY.md` for active position context.

## Infrastructure
- **Runtime**: Docker container.
- **Tools**: `exec` with `yieldMs: 60000` (Blocking wait).
- **Model**: Gemini Flash 3 Preview.
- **Focus**: Weekly Sector Rotation. Secondary: Polymarket Arbitrage.

## Execution Guidance
- **Slow Down**: You are not a HFT bot. Take time to analyze.
- **Yield**: Always `yieldMs: 60000`. Give tools time to work.
- **Process**:
    1. **Check Health** (`check_vitals` — Don't trade if dead).
    2. **Manage Exits** (Check stops on existing trades first).
    3. **Scan News** (Get the vibe).
    4. **Read Signals** (`read_signals` for regime + rankings + rebalance actions. Fall back to `scan_sectors` if stale).
    5. **Trade** (Limit orders only, based on rebalance actions from step 4).
    6. **Review Performance** (Monday: `performance_report` — are we making money? Adapt sizing accordingly).
    7. **Check Trade History** (`trade_journal` — review before repeating trades on the same symbol).

## Observability
- **Equity snapshots** are recorded automatically every time you call `check_vitals`.
- **Tool call logging** is automatic — every tool invocation is tracked with latency.
- **Daily P&L digest** is sent to Telegram at 5PM ET (Mon–Fri) — Armen will see it.
- `performance_report` is your **self-assessment tool** — use it to decide whether to trade aggressively or defensively.
- `trade_journal` is your **memory** — check it before repeating a trade on the same symbol. If you lost on the same ETF recently, demand stronger confirmation before re-entering.

## Safety & Limits
- **AGENT_DEATH**: Equity $0 = Game Over. Stop.
- **Memory**: Update `MEMORY.md` with *reasons* for entering a trade. (e.g., "Bought SPY because CPI was low").

## API Limits
- **NewsAPI**: Save for high-conviction checks. Use built-in RSS/Web-search primarily.