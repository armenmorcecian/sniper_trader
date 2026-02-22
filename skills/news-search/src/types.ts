export interface NewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary: string;
}

export interface SentimentScore {
  score: number;       // -1 to 1
  label: "bullish" | "bearish" | "neutral";
  confidence: number;  // 0 to 1
  matchedPatterns: string[];
}

export interface ScoredNewsItem extends NewsItem {
  sentiment: SentimentScore;
}

export interface NewsResult {
  items: ScoredNewsItem[];
  keywords: string[];
  premiumValidated: boolean;
  queryTimestamp: string;
}

export interface WatchNewsResult {
  items: ScoredNewsItem[];
  newCount: number;
  totalTracked: number;
  queryTimestamp: string;
}

export interface SeenHeadlinesState {
  headlines: Record<string, string>;
  lastWatchedAt: string;
}
