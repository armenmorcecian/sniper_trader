// ─── News Watcher Types ──────────────────────────────────────────────────────

export interface FeedConfig {
  url: string;
  category: "crypto" | "economics" | "sports" | "general";
}

export interface CategorizedHeadline {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  category: string;
  ageSeconds: number;
}

export interface NewsWatcherState {
  lastAlertTimestamp: string;
  alertsSentToday: number;
  dailyResetDate: string;
}

/** Map from normalized title → first-seen timestamp (ms) */
export interface SeenHeadlines {
  headlines: Record<string, number>;
}

// ─── Price Watcher Types ─────────────────────────────────────────────────────

export interface WatchlistEntry {
  conditionId: string;
  question: string;
  tokenId: string;
  outcome: string;
}

export interface PriceSnapshot {
  price: number;
  timestamp: number;
}

export interface PriceWindow {
  conditionId: string;
  question: string;
  tokenId: string;
  outcome: string;
  snapshots: PriceSnapshot[];
}

export interface PriceWatcherState {
  watchlist: WatchlistEntry[];
  lastWatchlistRefresh: string;
  /** Per-market last alert timestamp (conditionId → ISO string) */
  marketCooldowns: Record<string, string>;
}

// ─── Daemon Configs ──────────────────────────────────────────────────────────

export interface NewsDaemonConfig {
  rssIntervalMs: number;
  twitterIntervalMs: number;
  agentCooldownMs: number;
  dailyAlertCap: number;
  seenHeadlineTtlMs: number;
}

export interface PriceDaemonConfig {
  wsUrl: string;
  watchlistRefreshIntervalMs: number;
  priceWindowMs: number;
  movementThresholdPercent: number;
  perMarketCooldownMs: number;
  restFallbackIntervalMs: number;
  gammaHost: string;
}
