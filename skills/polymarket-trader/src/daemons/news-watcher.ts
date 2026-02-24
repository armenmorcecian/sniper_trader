import "dotenv/config";
import Parser from "rss-parser";
import { execSync } from "child_process";
import {
  log,
  loadState,
  saveState,
  isAgentBusy,
  acquireLock,
  releaseLock,
  triggerTradingCycle,
  todayDateString,
  sleep,
} from "./shared";
import type {
  FeedConfig,
  CategorizedHeadline,
  NewsWatcherState,
  SeenHeadlines,
  NewsDaemonConfig,
} from "./types";

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG: NewsDaemonConfig = {
  rssIntervalMs: 30_000,       // 30 seconds
  twitterIntervalMs: 0,        // Disabled — Twitter requires login, Chromium uses 700MB RAM
  agentCooldownMs: 3 * 60_000, // 3 minutes
  dailyAlertCap: 48,
  seenHeadlineTtlMs: 48 * 60 * 60 * 1000, // 48 hours
};

const DAEMON = "news-watcher";

// ─── RSS Feed List ───────────────────────────────────────────────────────────

const RSS_FEEDS: FeedConfig[] = [
  // Crypto
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", category: "crypto" },
  { url: "https://cointelegraph.com/rss", category: "crypto" },
  { url: "https://www.theblock.co/rss.xml", category: "crypto" },
  // Economics
  { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", category: "economics" },
  { url: "https://feeds.reuters.com/reuters/businessNews", category: "economics" },
  // Sports
  { url: "https://www.espn.com/espn/rss/news", category: "sports" },
  // General / Breaking
  { url: "https://feeds.bbci.co.uk/news/rss.xml", category: "general" },
  { url: "https://feeds.reuters.com/reuters/topNews", category: "general" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", category: "general" },
  { url: "https://rss.app/feeds/v1.1/cJa8KmX7qvSbDYFa.xml", category: "general" }, // AP News
];

// ─── Twitter Accounts (for Chromium scraping) ────────────────────────────────

const TWITTER_ACCOUNTS = [
  "Reuters",
  "CoinDesk",
  "whale_alert",
  "tier10k",
  "unusual_whales",
  "DeItaone",
  "FirstSquawk",
  "NickTimiraos",
  "BBCBreaking",
];

// ─── Category Detection Patterns ─────────────────────────────────────────────

const CRYPTO_PATTERNS = [
  /\bbitcoin\b/i, /\bbtc\b/i, /\bethereum\b/i, /\beth\b/i,
  /\bsolana\b/i, /\bsol\b/i, /\bcrypto\b/i, /\bcryptocurrency\b/i,
  /\bdogecoin\b/i, /\bdoge\b/i, /\bxrp\b/i, /\bripple\b/i,
  /\bcardano\b/i, /\bpolygon\b/i, /\bmatic\b/i, /\bavalanch[e]?\b/i,
  /\bavax\b/i, /\bchainlink\b/i, /\blitecoin\b/i, /\bltc\b/i,
  /\buniswap\b/i, /\baave\b/i, /\bdefi\b/i, /\bnft\b/i,
  /\bbinance\b/i, /\bcoinbase\b/i, /\bstablecoin\b/i,
  /\busdc\b/i, /\busdt\b/i, /\bblockchain\b/i, /\baltcoin\b/i,
];

const ECONOMICS_PATTERNS = [
  /\bfed\b/i, /\bfederal reserve\b/i, /\bfomc\b/i,
  /\binterest rate/i, /\bbasis points?\b/i, /\bbps\b/i,
  /\brate cut/i, /\brate hike/i, /\brate increase/i, /\brate decrease/i,
  /\binflation\b/i, /\bcpi\b/i, /\bjobs report/i, /\bunemployment\b/i,
  /\bgdp\b/i, /\bmonetary policy/i, /\bfed chair/i,
  /\btreasury yield/i, /\bbond yield/i, /\brecession\b/i,
  /\btariff/i, /\btrade war/i, /\bsanction/i,
];

const SPORTS_PATTERN = /\bvs\.?\s/i;

// ─── State ───────────────────────────────────────────────────────────────────

let seenHeadlines: SeenHeadlines = { headlines: {} };
let watcherState: NewsWatcherState = {
  lastAlertTimestamp: "",
  alertsSentToday: 0,
  dailyResetDate: todayDateString(),
};

function loadAllState(): void {
  const rawSeen = loadState<Record<string, unknown>>("seen-headlines.json", {
    headlines: {},
  });

  // Handle legacy format: { seenUrls: string[] } → convert to { headlines: Record<string, number> }
  if (
    rawSeen &&
    typeof rawSeen === "object" &&
    "headlines" in rawSeen &&
    rawSeen.headlines &&
    typeof rawSeen.headlines === "object"
  ) {
    seenHeadlines = rawSeen as unknown as SeenHeadlines;
  } else if (rawSeen && Array.isArray((rawSeen as { seenUrls?: unknown }).seenUrls)) {
    // Legacy format from existing watchNews — migrate URLs to title-based dedup
    const legacyUrls = (rawSeen as { seenUrls: string[] }).seenUrls;
    const migrated: Record<string, number> = {};
    for (const url of legacyUrls) {
      migrated[url.toLowerCase()] = Date.now();
    }
    seenHeadlines = { headlines: migrated };
    log(DAEMON, "INFO", `Migrated ${legacyUrls.length} legacy seen URLs`);
  } else {
    seenHeadlines = { headlines: {} };
  }

  watcherState = loadState<NewsWatcherState>("news-watcher-state.json", {
    lastAlertTimestamp: "",
    alertsSentToday: 0,
    dailyResetDate: todayDateString(),
  });

  // Ensure watcherState has expected shape
  if (!watcherState || typeof watcherState !== "object") {
    watcherState = {
      lastAlertTimestamp: "",
      alertsSentToday: 0,
      dailyResetDate: todayDateString(),
    };
  }

  // Reset daily counter if new day
  const today = todayDateString();
  if (watcherState.dailyResetDate !== today) {
    watcherState.alertsSentToday = 0;
    watcherState.dailyResetDate = today;
    saveState("news-watcher-state.json", watcherState);
  }
}

function pruneSeenHeadlines(): void {
  const cutoff = Date.now() - CONFIG.seenHeadlineTtlMs;
  const pruned: Record<string, number> = {};
  for (const [key, ts] of Object.entries(seenHeadlines.headlines)) {
    if (ts > cutoff) pruned[key] = ts;
  }
  seenHeadlines.headlines = pruned;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/\s+/g, " ");
}

function isNewHeadline(title: string): boolean {
  return !(normalizeTitle(title) in seenHeadlines.headlines);
}

function markSeen(title: string): void {
  seenHeadlines.headlines[normalizeTitle(title)] = Date.now();
}

// ─── Category Detection ──────────────────────────────────────────────────────

function detectCategory(
  text: string,
  feedCategory: string,
): string {
  if (CRYPTO_PATTERNS.some((re) => re.test(text))) return "crypto";
  if (ECONOMICS_PATTERNS.some((re) => re.test(text))) return "economics";
  if (SPORTS_PATTERN.test(text)) return "sports";
  // Fall back to feed's assigned category
  return feedCategory;
}

// ─── RSS Polling ─────────────────────────────────────────────────────────────

const rssParser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "PolymarketTrader/2.0" },
});

async function pollRssFeeds(): Promise<CategorizedHeadline[]> {
  const now = Date.now();
  const cutoff = new Date(now - 60 * 60 * 1000); // 1 hour
  const newHeadlines: CategorizedHeadline[] = [];

  const results = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      try {
        const parsed = await rssParser.parseURL(feed.url);
        return { feed, items: parsed.items || [] };
      } catch {
        return { feed, items: [] };
      }
    }),
  );

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { feed, items } = result.value;

    for (const item of items) {
      const title = (item.title || "").trim();
      if (!title || title.length < 10) continue;

      // Skip old headlines
      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (pubDate && pubDate < cutoff) continue;

      // Skip already-seen headlines
      if (!isNewHeadline(title)) continue;

      const text = `${title} ${item.contentSnippet || ""}`;
      const ageSeconds = pubDate
        ? Math.floor((now - pubDate.getTime()) / 1000)
        : 0;

      newHeadlines.push({
        title,
        source: feed.url.includes("coindesk")
          ? "CoinDesk"
          : feed.url.includes("cointelegraph")
            ? "CoinTelegraph"
            : feed.url.includes("theblock")
              ? "TheBlock"
              : feed.url.includes("cnbc")
                ? "CNBC"
                : feed.url.includes("reuters")
                  ? "Reuters"
                  : feed.url.includes("espn")
                    ? "ESPN"
                    : feed.url.includes("bbc")
                      ? "BBC"
                      : feed.url.includes("nytimes")
                        ? "NYT"
                        : feed.url.includes("rss.app")
                          ? "AP"
                          : "RSS",
        url: item.link || "",
        publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
        category: detectCategory(text, feed.category),
        ageSeconds,
      });

      markSeen(title);
    }
  }

  return newHeadlines;
}

// ─── Twitter Scraping (Chromium headless) ────────────────────────────────────

async function pollTwitter(): Promise<CategorizedHeadline[]> {
  const headlines: CategorizedHeadline[] = [];

  try {
    // Build search query combining all accounts
    const fromQueries = TWITTER_ACCOUNTS.slice(0, 6)
      .map((a) => `from:${a}`)
      .join(" OR ");
    const searchUrl = `https://x.com/search?q=${encodeURIComponent(fromQueries)}&f=live`;

    const html = execSync(
      `/usr/bin/chromium-browser --headless=new --no-sandbox --disable-gpu ` +
        `--disable-dev-shm-usage --disable-extensions ` +
        `--virtual-time-budget=15000 --dump-dom "${searchUrl}"`,
      {
        timeout: 45_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    // Extract tweet text from DOM (Twitter uses data-testid="tweetText")
    const tweetRegex =
      /<div[^>]*data-testid="tweetText"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    while ((match = tweetRegex.exec(html)) !== null) {
      // Strip HTML tags to get plain text
      const text = match[1].replace(/<[^>]+>/g, "").trim();
      if (text.length < 15) continue;
      if (!isNewHeadline(text)) continue;

      const category = detectCategory(text, "general");
      headlines.push({
        title: text.slice(0, 280),
        source: "Twitter/X",
        url: searchUrl,
        publishedAt: new Date().toISOString(),
        category,
        ageSeconds: 0,
      });

      markSeen(text);
    }

    if (headlines.length > 0) {
      log(DAEMON, "INFO", `Twitter scrape: ${headlines.length} new tweets`);
    }
  } catch {
    // Chromium scraping failed — silently degrade to RSS-only
    log(DAEMON, "WARN", "Twitter scraping failed (degrading to RSS-only)");
  }

  return headlines;
}

// ─── Cooldown & Cap Checks ───────────────────────────────────────────────────

function canTriggerAgent(): boolean {
  // Daily cap
  if (watcherState.alertsSentToday >= CONFIG.dailyAlertCap) {
    log(
      DAEMON,
      "WARN",
      `Daily alert cap reached (${CONFIG.dailyAlertCap}), skipping`,
    );
    return false;
  }

  // Cooldown
  if (watcherState.lastAlertTimestamp) {
    const elapsed =
      Date.now() - new Date(watcherState.lastAlertTimestamp).getTime();
    if (elapsed < CONFIG.agentCooldownMs) {
      const remaining = Math.ceil(
        (CONFIG.agentCooldownMs - elapsed) / 1000,
      );
      log(DAEMON, "INFO", `Cooldown active (${remaining}s remaining), queuing`);
      return false;
    }
  }

  // Agent busy
  if (isAgentBusy()) {
    log(DAEMON, "INFO", "Agent is busy (lockfile), skipping trigger");
    return false;
  }

  return true;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

let pendingHeadlines: CategorizedHeadline[] = [];
let lastTwitterPoll = 0;

async function runPollCycle(): Promise<void> {
  try {
    // Always poll RSS
    const rssHeadlines = await pollRssFeeds();
    if (rssHeadlines.length > 0) {
      log(
        DAEMON,
        "INFO",
        `RSS poll: ${rssHeadlines.length} new headlines`,
      );
      pendingHeadlines.push(...rssHeadlines);
    }

    // Poll Twitter on separate interval (0 = disabled)
    const now = Date.now();
    if (CONFIG.twitterIntervalMs > 0 && now - lastTwitterPoll >= CONFIG.twitterIntervalMs) {
      lastTwitterPoll = now;
      const twitterHeadlines = await pollTwitter();
      if (twitterHeadlines.length > 0) {
        pendingHeadlines.push(...twitterHeadlines);
      }
    }

    // If we have pending headlines and can trigger, send alert
    if (pendingHeadlines.length > 0 && canTriggerAgent()) {
      const batch = pendingHeadlines.splice(0, 50); // Max 50 per alert

      log(
        DAEMON,
        "INFO",
        `Triggering trading cycle with ${batch.length} headlines`,
      );

      const locked = acquireLock();
      if (!locked) {
        log(DAEMON, "WARN", "Could not acquire lock, re-queuing headlines");
        pendingHeadlines.unshift(...batch);
        return;
      }

      try {
        const result = triggerTradingCycle("news", JSON.stringify(batch));
        if (result.success) {
          log(DAEMON, "INFO", "Trading cycle completed successfully");
        } else {
          log(
            DAEMON,
            "ERROR",
            `Trading cycle failed: ${result.output.slice(0, 200)}`,
          );
        }
      } finally {
        releaseLock();
      }

      // Update state
      watcherState.lastAlertTimestamp = new Date().toISOString();
      watcherState.alertsSentToday++;
      saveState("news-watcher-state.json", watcherState);
    }

    // Save seen headlines (with pruning)
    pruneSeenHeadlines();
    saveState("seen-headlines.json", seenHeadlines);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(DAEMON, "ERROR", `Poll cycle error: ${msg}`);
  }
}

async function main(): Promise<void> {
  log(DAEMON, "INFO", "Starting news-watcher daemon");
  loadAllState();

  const seenCount = Object.keys(seenHeadlines.headlines).length;
  log(
    DAEMON,
    "INFO",
    `Loaded ${seenCount} seen headlines, ${watcherState.alertsSentToday}/${CONFIG.dailyAlertCap} alerts sent today`,
  );

  // First poll immediately
  await runPollCycle();

  // Then poll on interval
  while (true) {
    await sleep(CONFIG.rssIntervalMs);
    await runPollCycle();
  }
}

main().catch((err) => {
  log(DAEMON, "ERROR", `Fatal error: ${err.message || err}`);
  process.exit(1);
});
