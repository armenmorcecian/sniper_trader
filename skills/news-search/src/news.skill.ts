import "dotenv/config";
import { Type, type Static } from "@sinclair/typebox";
import { NewsService } from "./news.service";

// ─── Lazy Singleton ─────────────────────────────────────────────────────────

let newsService: NewsService | null = null;

function getNewsService(): NewsService {
  if (!newsService) {
    newsService = new NewsService(process.env.NEWS_API_KEY);
  }
  return newsService;
}

// ─── Tool Schemas ───────────────────────────────────────────────────────────

const WatchNewsSchema = Type.Object({});
type WatchNewsParams = Static<typeof WatchNewsSchema>;

const AnalyzeNewsSchema = Type.Object({
  keywords: Type.Array(Type.String(), { description: "Keywords to search for in news (e.g. ['Bitcoin', 'Fed', 'oil'])" }),
  premium: Type.Optional(Type.Boolean({ default: false, description: "If true, also queries NewsAPI (quota-limited, max 80/day)" })),
});
type AnalyzeNewsParams = Static<typeof AnalyzeNewsSchema>;

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const tools = [
  {
    name: "watch_news",
    description:
      "Poll all RSS feeds (Reuters, CNBC, Dow Jones, Yahoo, Fed, Oil, Tech, CoinDesk, Cointelegraph, The Block) and return only NEW headlines since last call. Stateful — tracks seen headlines in data/seen-headlines.json. No params needed. Call at start of every trading cycle.",
    parameters: WatchNewsSchema,
    handler: async (_params: WatchNewsParams) => {
      const service = getNewsService();
      return service.watchNews();
    },
  },

  {
    name: "analyze_news",
    description:
      "Fetch recent news relevant to given keywords. RSS-first (unlimited). Set premium=true to also query NewsAPI for validation before committing capital (max 80/day). Returns raw headlines — the agent decides sentiment.",
    parameters: AnalyzeNewsSchema,
    handler: async (params: AnalyzeNewsParams) => {
      const service = getNewsService();
      if (params.premium) {
        const result = await service.validateWithPremiumNews(params.keywords);
        const usage = service.getNewsApiUsage();
        return { ...result, newsApiUsage: usage };
      }
      return service.fetchRelevantNews(params.keywords);
    },
  },
];
