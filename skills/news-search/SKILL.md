---
name: news-search
description: News aggregation — RSS feeds + NewsAPI for trading intelligence
emoji: "\U0001F4F0"
metadata: |
  {
    "requirements": {
      "bins": ["node", "npm"]
    },
    "optional_env": ["NEWS_API_KEY"],
    "install": "cd skills/news-search && npm install"
  }
---

## How to Call Tools

Use the `exec` tool (NOT `openclaw skills`, NOT `nodes invoke`). Always set yieldMs: 60000.

Example exec call:
  command: news-search <tool_name> '<json_params>'
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
| `watch_news` | none | Poll all RSS feeds (Reuters, CNBC, Dow Jones, Yahoo, Fed, Oil, Tech, CoinDesk, Cointelegraph, The Block). Returns only NEW headlines since last call. Stateful — tracks seen headlines. Includes `sentiment` per item (score, label, confidence, matchedPatterns). |
| `analyze_news` | `keywords` (string array), `premium` (bool, optional) | Keyword-filtered news search. RSS-first (free, unlimited). Set `premium: true` to also query NewsAPI (max 80 calls/day). Includes `sentiment` per item (score, label, confidence, matchedPatterns). |

## Technical Notes

- **NewsAPI quota**: 80 calls/day hard cap (20-call safety margin on 100 free tier). Use RSS first, NewsAPI only pre-trade.
- **State file**: `data/seen-headlines.json` — tracks which headlines have been seen. Auto-prunes entries older than 7 days.
- **RSS feeds**: 10 feeds across macro (Reuters, CNBC, Dow Jones, Yahoo, Fed, Oil, Tech) and crypto (CoinDesk, Cointelegraph, The Block).

## Sentiment Scoring

Every news item includes a `sentiment` object:
- `score`: -1 to +1 (negative = bearish, positive = bullish)
- `label`: `"bullish"` / `"bearish"` / `"neutral"` (thresholds: ±0.15)
- `confidence`: 0 to 1 — higher means more patterns matched (>0.5 = reliable)
- `matchedPatterns`: array of matched pattern strings

**Negation-aware**: "NOT cut rates" correctly scores bearish; "fails to rally" scores bearish. Titles weighted 2x.

**How to use**: `label` for quick filtering, `score` for ranking trade candidates, `confidence` for position sizing.
