---
name: web-search
description: Headless Chromium web browsing with optional proxy support
emoji: "\U0001F310"
metadata: |
  {
    "requirements": {
      "bins": ["node", "npm"]
    },
    "optional_env": ["PROXY_URL"],
    "install": "cd skills/web-search && npm install"
  }
---

## How to Call Tools

Use the `exec` tool (NOT `openclaw skills`, NOT `nodes invoke`). Always set yieldMs: 60000.

Example exec call:
  command: web-search <tool_name> '<json_params>'
  yieldMs: 60000

IMPORTANT:
- Always set yieldMs: 60000 — default (10s) is too short and wastes API quota on polling
- Do NOT use `process poll` unless exec explicitly returns a sessionId
- Do NOT chain commands with `&&` — one tool per exec call
- Output is always JSON

## Available Tools

| Tool | Parameters | Purpose |
|------|-----------|---------|
| `browse_web` | `url` (required), `selector` (optional CSS), `timeout` (optional ms) | Open URL in headless Chromium, extract page text. Text capped at 50KB. |

## Technical Notes

- **Proxy support**: Set `PROXY_URL` env var (e.g. `http://user:pass@host:port`) to route through a residential proxy. Needed for geo-restricted content like Polymarket pages. If unset, connects directly.
- **Chromium**: Uses `PUPPETEER_EXECUTABLE_PATH` env var if set, otherwise uses bundled Chromium.
- **Output**: Returns page title, extracted text (scripts/styles/nav stripped), content length.
- **SPA support**: Tries `networkidle2` first (waits for JS frameworks to render), falls back to `domcontentloaded`. JavaScript-heavy sites like TradingView and finviz should load correctly.
