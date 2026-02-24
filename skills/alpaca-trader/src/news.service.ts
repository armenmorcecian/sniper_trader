import fs from "fs";
import path from "path";
import axios, { AxiosInstance } from "axios";
import Parser from "rss-parser";
import { NewsItem, NewsResult } from "./types";

const RSS_FEEDS = [
  // Macro / General
  "https://feeds.reuters.com/reuters/businessNews",
  "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "https://feeds.content.dowjones.io/public/rss/mw_topstories",
  "https://finance.yahoo.com/news/rssindex",
  // Fed / Economics
  "https://www.federalreserve.gov/feeds/press_all.xml",
  // Energy
  "https://oilprice.com/rss/main",
  // Tech
  "https://techcrunch.com/feed/",
  // Crypto (for BITO)
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
];

const NEWSAPI_BASE = "https://newsapi.org/v2/everything";

export class NewsService {
  private rssParser: Parser;
  private newsApiClient: AxiosInstance | null;
  private newsApiCallsToday: number = 0;
  private newsApiResetDate: string;

  constructor(newsApiKey?: string) {
    this.rssParser = new Parser({
      timeout: 10000,
      headers: {
        "User-Agent": "AlpacaTrader/1.0",
      },
    });

    this.newsApiClient = newsApiKey
      ? axios.create({
          baseURL: NEWSAPI_BASE,
          params: { apiKey: newsApiKey },
          timeout: 10000,
        })
      : null;

    this.newsApiResetDate = this.todayDateString();
  }

  /**
   * PRIMARY path — RSS feeds only (unlimited, no API key needed).
   * Fetches macro/sector news, filters by keywords, returns raw headlines.
   */
  async fetchRelevantNews(
    keywords: string[],
    hoursBack: number = 6,
  ): Promise<NewsResult> {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const allItems: NewsItem[] = [];

    const feedPromises = RSS_FEEDS.map((feedUrl) =>
      this.parseFeed(feedUrl, keywords, cutoff).catch(() => [] as NewsItem[]),
    );

    const results = await Promise.all(feedPromises);
    for (const items of results) {
      allItems.push(...items);
    }

    const deduped = this.deduplicateByTitle(allItems);
    deduped.sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );

    return {
      items: deduped.slice(0, 30),
      keywords,
      premiumValidated: false,
      queryTimestamp: new Date().toISOString(),
    };
  }

  /**
   * PREMIUM path — also queries NewsAPI (max 80 calls/day).
   * Only called when a trade is imminent (after all other filters pass).
   */
  async validateWithPremiumNews(keywords: string[]): Promise<NewsResult> {
    const today = this.todayDateString();
    if (today !== this.newsApiResetDate) {
      this.newsApiCallsToday = 0;
      this.newsApiResetDate = today;
    }

    const rssResult = await this.fetchRelevantNews(keywords);

    if (!this.newsApiClient || this.newsApiCallsToday >= 80) {
      return {
        ...rssResult,
        premiumValidated: false,
      };
    }

    try {
      this.newsApiCallsToday++;
      const query = keywords.join(" OR ");
      const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      const response = await this.newsApiClient.get("", {
        params: {
          q: query,
          from: fromDate,
          sortBy: "publishedAt",
          pageSize: 20,
          language: "en",
        },
      });

      const newsApiItems: NewsItem[] = (response.data.articles || []).map(
        (article: Record<string, unknown>) => ({
          title: (article.title as string) || "",
          source:
            (article.source as Record<string, string>)?.name || "NewsAPI",
          url: (article.url as string) || "",
          publishedAt: (article.publishedAt as string) || "",
          summary: (article.description as string) || "",
        }),
      );

      const merged = this.deduplicateByTitle([
        ...rssResult.items,
        ...newsApiItems,
      ]);
      merged.sort(
        (a, b) =>
          new Date(b.publishedAt).getTime() -
          new Date(a.publishedAt).getTime(),
      );

      return {
        items: merged.slice(0, 40),
        keywords,
        premiumValidated: true,
        queryTimestamp: new Date().toISOString(),
      };
    } catch {
      return {
        ...rssResult,
        premiumValidated: false,
      };
    }
  }

  /**
   * STATEFUL scan — fetches ALL items from ALL RSS feeds, diffs against
   * seen-headlines state file, returns only new items since last call.
   * Prunes entries older than 7 days. Caps output at 50 items.
   */
  async watchNews(): Promise<{ items: NewsItem[]; newCount: number; totalTracked: number; queryTimestamp: string }> {
    const state = this.loadSeenHeadlines();
    const allItems: NewsItem[] = [];

    const feedPromises = RSS_FEEDS.map((feedUrl) =>
      this.parseAllFeedItems(feedUrl).catch(() => [] as NewsItem[]),
    );
    const results = await Promise.all(feedPromises);
    for (const items of results) {
      allItems.push(...items);
    }

    const deduped = this.deduplicateByTitle(allItems);

    // Filter to only new headlines
    const newItems = deduped.filter((item) => {
      const key = item.title.toLowerCase().trim().replace(/\s+/g, " ");
      return !state.headlines[key];
    });

    // Sort newest first
    newItems.sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    );

    // Add new headlines to state
    const now = new Date().toISOString();
    for (const item of newItems) {
      const key = item.title.toLowerCase().trim().replace(/\s+/g, " ");
      state.headlines[key] = item.publishedAt || now;
    }

    // Prune entries older than 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [key, timestamp] of Object.entries(state.headlines)) {
      if (new Date(timestamp).getTime() < sevenDaysAgo) {
        delete state.headlines[key];
      }
    }

    state.lastWatchedAt = now;
    this.saveSeenHeadlines(state);

    return {
      items: newItems.slice(0, 50),
      newCount: newItems.length,
      totalTracked: Object.keys(state.headlines).length,
      queryTimestamp: now,
    };
  }

  getNewsApiUsage(): { callsToday: number; limit: number } {
    return { callsToday: this.newsApiCallsToday, limit: 80 };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async parseFeed(
    feedUrl: string,
    keywords: string[],
    cutoff: Date,
  ): Promise<NewsItem[]> {
    const feed = await this.rssParser.parseURL(feedUrl);
    const lowerKeywords = keywords.map((k) => k.toLowerCase());

    return (feed.items || [])
      .filter((item) => {
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        if (pubDate && pubDate < cutoff) return false;

        const text = `${item.title || ""} ${item.contentSnippet || ""} ${item.content || ""}`.toLowerCase();
        return lowerKeywords.some((kw) => text.includes(kw));
      })
      .map((item) => ({
        title: item.title || "",
        source: feed.title || feedUrl,
        url: item.link || "",
        publishedAt: item.pubDate || item.isoDate || "",
        summary: (item.contentSnippet || item.content || "").slice(0, 500),
      }));
  }

  private async parseAllFeedItems(feedUrl: string): Promise<NewsItem[]> {
    const feed = await this.rssParser.parseURL(feedUrl);
    return (feed.items || []).map((item) => ({
      title: item.title || "",
      source: feed.title || feedUrl,
      url: item.link || "",
      publishedAt: item.pubDate || item.isoDate || "",
      summary: (item.contentSnippet || item.content || "").slice(0, 500),
    }));
  }

  private loadSeenHeadlines(): { headlines: Record<string, string>; lastWatchedAt: string } {
    const filePath = path.resolve(process.cwd(), "data", "seen-headlines.json");
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        headlines: parsed.headlines && typeof parsed.headlines === "object" ? parsed.headlines : {},
        lastWatchedAt: parsed.lastWatchedAt || "",
      };
    } catch {
      return { headlines: {}, lastWatchedAt: "" };
    }
  }

  private saveSeenHeadlines(state: { headlines: Record<string, string>; lastWatchedAt: string }): void {
    const dirPath = path.resolve(process.cwd(), "data");
    const filePath = path.join(dirPath, "seen-headlines.json");
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  private deduplicateByTitle(items: NewsItem[]): NewsItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = item.title.toLowerCase().trim().replace(/\s+/g, " ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private todayDateString(): string {
    return new Date().toISOString().split("T")[0];
  }
}
