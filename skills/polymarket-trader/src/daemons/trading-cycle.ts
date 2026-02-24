import * as dotenv from "dotenv";
import * as path from "path";

// Load .env from skill root (not cwd-dependent)
const SKILL_DIR = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(SKILL_DIR, ".env") });

import axios from "axios";
import { PolymarketService } from "../polymarket.service";
import { NewsService } from "../news.service";
import { checkStopLoss } from "../analysis";
import { log } from "./shared";
import type {
  PolymarketConfig,
  VitalSigns,
  ScannedMarket,
  TradeResult,
  PositionSummary,
} from "../types";
import type { CategorizedHeadline } from "./types";

const DAEMON = "trading-cycle";

// ─── Service Setup ──────────────────────────────────────────────────────────

function getConfig(): PolymarketConfig {
  const privateKey = process.env.PRIVATE_KEY;
  const walletAddress = process.env.WALLET_ADDRESS;
  if (!privateKey) throw new Error("PRIVATE_KEY not set");
  if (!walletAddress) throw new Error("WALLET_ADDRESS not set");

  return {
    privateKey,
    walletAddress,
    apiKey: process.env.POLY_API_KEY,
    apiSecret: process.env.POLY_API_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
    funder: process.env.POLY_FUNDER,
    clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
    gammaHost: process.env.GAMMA_HOST || "https://gamma-api.polymarket.com",
    dataHost: process.env.DATA_HOST || "https://data-api.polymarket.com",
    newsApiKey: process.env.NEWS_API_KEY,
    proxyUrl: process.env.PROXY_URL,
  };
}

// ─── Direct Gemini API Call ──────────────────────────────────────────────────

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Calls Gemini API directly — no OpenClaw session, no context accumulation.
 * Each call is a fresh context with just the trading prompt (~3K tokens).
 */
async function callGemini(prompt: string): Promise<{ success: boolean; text: string }> {
  if (!GEMINI_API_KEY) {
    return { success: false, text: "GEMINI_API_KEY not set in .env" };
  }

  try {
    const resp = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      },
      { timeout: 60_000 },
    );

    const candidate = resp.data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || "";
    return { success: true, text };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      return {
        success: false,
        text: `Gemini API error ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, text: msg };
  }
}

// ─── Keyword Extraction ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "will", "the", "a", "an", "in", "on", "at", "by", "to", "of", "for",
  "is", "be", "or", "and", "not", "this", "that", "it", "its", "has",
  "have", "had", "do", "does", "did", "but", "if", "from", "with",
  "are", "was", "were", "been", "being", "than", "more", "most",
  "before", "after", "above", "below", "between", "during",
  "hit", "reach", "end", "win", "over", "under", "what", "how",
  "when", "where", "who", "which", "would", "could", "should",
]);

function extractKeywords(question: string): string[] {
  const words = question
    .replace(/[?!.,;:'"$%()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()));

  const unique = [...new Set(words)];
  return unique.slice(0, 4);
}

// ─── Data Types ─────────────────────────────────────────────────────────────

interface TriggerContext {
  type: "news" | "price";
  news?: CategorizedHeadline[];
  price?: {
    conditionId: string;
    question: string;
    changePercent: number;
    oldPrice: number;
    newPrice: number;
    durationSeconds: number;
  };
}

interface GatheredData {
  vitals: VitalSigns;
  flaggedPositions: PositionSummary[];
  candidates: ScannedMarket[];
  candidateNews: Map<string, { title: string; source: string; age: string }[]>;
}

interface TradeDecision {
  action: "TRADE" | "SKIP";
  trades?: Array<{
    conditionId: string;
    outcome: "Yes" | "No";
    side: "BUY" | "SELL";
    amount: number;
    limitPrice: number;
  }>;
  reasoning: string;
}

// ─── Data Gathering ─────────────────────────────────────────────────────────

async function gatherAllData(
  service: PolymarketService,
  newsService: NewsService,
  trigger: TriggerContext,
): Promise<GatheredData> {
  // Phase 1: Vitals + market scan in parallel
  const [vitals, scanResult] = await Promise.all([
    service.getPortfolioValue(),
    service.findLiquidMarkets({
      limit: 5,
      category: "crypto,economics,sports",
    }),
  ]);

  const flaggedPositions = checkStopLoss(vitals.positions, -15);

  // Phase 2: Get news for top candidates
  const candidates = scanResult.markets;
  const candidateNews = new Map<
    string,
    { title: string; source: string; age: string }[]
  >();

  // For price triggers, prioritize the triggered market
  // For news triggers, get news for top 3 candidates
  const marketsForNews =
    trigger.type === "price" && trigger.price
      ? candidates
          .filter((m) => m.conditionId === trigger.price!.conditionId)
          .slice(0, 1)
      : candidates.slice(0, 3);

  const newsPromises = marketsForNews.map(async (market) => {
    try {
      const keywords = extractKeywords(market.question);
      if (keywords.length === 0) return;
      const result = await newsService.fetchRelevantNews(keywords, 6);
      const headlines = result.items.slice(0, 5).map((item) => {
        const ageMs = Date.now() - new Date(item.publishedAt).getTime();
        const ageMin = Math.floor(ageMs / 60000);
        const age =
          ageMin < 60
            ? `${ageMin} min ago`
            : `${Math.floor(ageMin / 60)}h ago`;
        return { title: item.title, source: item.source, age };
      });
      candidateNews.set(market.conditionId, headlines);
    } catch {
      // News fetch failed for this market — continue without
    }
  });

  await Promise.all(newsPromises);

  return { vitals, flaggedPositions, candidates, candidateNews };
}

// ─── Stop-Loss Handler ──────────────────────────────────────────────────────

async function handleStopLosses(
  service: PolymarketService,
  flagged: PositionSummary[],
): Promise<TradeResult[]> {
  const results: TradeResult[] = [];

  for (const pos of flagged) {
    try {
      // Skip expired/closed markets (size=0 or no order book)
      if (pos.size <= 0) {
        log(DAEMON, "INFO", `Skipping stop-loss for ${pos.question}: size is 0 (market likely expired)`);
        continue;
      }

      log(
        DAEMON,
        "INFO",
        `Stop-loss exit: ${pos.question} ${pos.outcome} (${pos.pnlPercent.toFixed(1)}%)`,
      );
      const result = await service.sellPosition(
        pos.conditionId,
        pos.outcome as "Yes" | "No",
      );
      results.push(result);
      log(DAEMON, "INFO", `Stop-loss executed: orderId=${result.orderId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't log as ERROR for expected failures (expired markets, no order book)
      if (msg.includes("not iterable") || msg.includes("404") || msg.includes("No open position")) {
        log(DAEMON, "INFO", `Stop-loss skipped for ${pos.question}: ${msg.slice(0, 100)}`);
      } else {
        log(DAEMON, "ERROR", `Stop-loss failed for ${pos.conditionId}: ${msg}`);
      }
    }
  }

  return results;
}

// ─── Prompt Builder ─────────────────────────────────────────────────────────

function buildDecisionPrompt(
  data: GatheredData,
  trigger: TriggerContext,
): string {
  const { vitals, candidates, candidateNews } = data;

  // ─── Trigger Section
  let triggerSection: string;
  if (trigger.type === "news" && trigger.news) {
    const lines = trigger.news.slice(0, 10).map((h, i) => {
      const age =
        h.ageSeconds < 60
          ? `${h.ageSeconds}s ago`
          : `${Math.floor(h.ageSeconds / 60)} min ago`;
      return `  ${i + 1}. [${h.category}] ${h.title} (${h.source}, ${age})`;
    });
    triggerSection = `Trigger: NEWS_ALERT (${trigger.news.length} new headlines)\n${lines.join("\n")}`;
  } else if (trigger.type === "price" && trigger.price) {
    const p = trigger.price;
    const dir = p.changePercent > 0 ? "UP" : "DOWN";
    const durMin = Math.floor(p.durationSeconds / 60);
    triggerSection =
      `Trigger: PRICE_MOVEMENT\n` +
      `Market: "${p.question}"\n` +
      `Movement: ${p.changePercent > 0 ? "+" : ""}${p.changePercent.toFixed(1)}% ${dir} in ${durMin} min ` +
      `(${p.oldPrice.toFixed(3)} -> ${p.newPrice.toFixed(3)})\n` +
      `conditionId: ${p.conditionId}`;
  } else {
    triggerSection = "Trigger: SCHEDULED_CYCLE";
  }

  // ─── Portfolio Section
  const posLines =
    vitals.positions.length > 0
      ? vitals.positions
          .map(
            (p) =>
              `  - ${p.question} | ${p.outcome} | size: ${p.size} | entry: ${p.avgEntryPrice.toFixed(3)} | now: ${p.currentPrice.toFixed(3)} | P&L: ${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)} (${p.pnlPercent >= 0 ? "+" : ""}${p.pnlPercent.toFixed(1)}%)`,
          )
          .join("\n")
      : "  (none)";

  const portfolioSection =
    `Balance: $${vitals.usdcBalance.toFixed(2)} USDC | Position Value: $${vitals.positionValue.toFixed(2)} | Equity: $${vitals.totalEquity.toFixed(2)} | Status: ${vitals.status}\n` +
    `Positions:\n${posLines}`;

  // ─── Risk calculations
  const maxBet = Math.min(2.0, vitals.usdcBalance * 0.1);
  const cashReserve = vitals.totalEquity * 0.2;
  const availableForTrading = Math.max(0, vitals.usdcBalance - cashReserve);

  // ─── Market Candidates Section
  const marketLines = candidates
    .slice(0, 5)
    .map((m, i) => {
      const prices = m.outcomes
        .map(
          (o, idx) =>
            `${o}: ${m.outcomePrices[idx]?.toFixed(3) || "?"}`,
        )
        .join(" | ");
      const news = candidateNews.get(m.conditionId);
      const newsLines =
        news && news.length > 0
          ? news
              .map((n) => `    - "${n.title}" (${n.source}, ${n.age})`)
              .join("\n")
          : "    (no recent news)";

      return (
        `${i + 1}. "${m.question}"\n` +
        `   conditionId: ${m.conditionId}\n` +
        `   ${prices} | Spread: ${m.spread.toFixed(3)} | Vol24h: $${m.volume24hr.toLocaleString()}\n` +
        `   Bid depth: $${m.bidDepthUsd.toLocaleString()} | Ask depth: $${m.askDepthUsd.toLocaleString()} | Whale wall: ${m.whaleWallDetected ? "YES - AVOID" : "none"}\n` +
        `   NEWS:\n${newsLines}`
      );
    })
    .join("\n\n");

  // ─── Full Prompt
  return (
    `TRADING DECISION REQUEST\n` +
    `========================\n` +
    `${triggerSection}\n\n` +
    `PORTFOLIO STATUS\n` +
    `================\n` +
    `${portfolioSection}\n\n` +
    `MARKET CANDIDATES (pre-filtered for volume/liquidity)\n` +
    `======================================================\n` +
    `${marketLines || "(no candidates found)"}\n\n` +
    `RISK RULES\n` +
    `==========\n` +
    `- Bet size: max $${maxBet.toFixed(2)} per trade (min of $2.00 and 10% of balance)\n` +
    `- Available for trading: $${availableForTrading.toFixed(2)} (after 20% cash reserve)\n` +
    `- Current position value: $${vitals.positionValue.toFixed(2)}\n` +
    `- Only trade if news CLEARLY confirms direction\n` +
    `- Skip any market with whale wall detected\n` +
    `- If unsure about ANY aspect, action MUST be SKIP\n\n` +
    `DO NOT call any tools. ALL data is provided above.\n` +
    `Respond with ONLY a JSON object. No markdown, no explanation outside JSON.\n\n` +
    `{"action":"TRADE","trades":[{"conditionId":"...","outcome":"Yes","side":"BUY","amount":N,"limitPrice":N.NN}],"reasoning":"..."}\n` +
    `or\n` +
    `{"action":"SKIP","reasoning":"..."}`
  );
}

// ─── Response Parser ────────────────────────────────────────────────────────

function validateDecision(parsed: Record<string, unknown>): TradeDecision {
  const action = String(parsed.action);
  if (action !== "TRADE" && action !== "SKIP") {
    return { action: "SKIP", reasoning: `Unknown action: ${action}` };
  }
  if (action === "TRADE" && !Array.isArray(parsed.trades)) {
    return { action: "SKIP", reasoning: "TRADE action missing trades array" };
  }
  return parsed as unknown as TradeDecision;
}

function parseDecision(rawText: string): TradeDecision {
  // Strip markdown code fences (LLMs often wrap in ```json ... ```)
  const text = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Strategy 1: Try parsing the full text as JSON
  try {
    const parsed = JSON.parse(text);
    if (parsed.action) return validateDecision(parsed);
  } catch {
    // May have unescaped newlines inside strings — try fixing
  }

  // Strategy 2: Collapse to single line and retry (fixes unescaped newlines in strings)
  const singleLine = text.replace(/\r?\n/g, " ").trim();
  try {
    const parsed = JSON.parse(singleLine);
    if (parsed.action) return validateDecision(parsed);
  } catch {
    // Still invalid — try bracket matching
  }

  // Strategy 3: Find JSON block containing "action" via bracket matching
  const actionIdx = singleLine.indexOf('"action"');
  if (actionIdx !== -1) {
    let start = -1;
    for (let i = actionIdx; i >= 0; i--) {
      if (singleLine[i] === "{") {
        start = i;
        break;
      }
    }

    if (start !== -1) {
      let depth = 0;
      for (let i = start; i < singleLine.length; i++) {
        if (singleLine[i] === "{") depth++;
        if (singleLine[i] === "}") {
          depth--;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(singleLine.slice(start, i + 1));
              if (parsed.action) return validateDecision(parsed);
            } catch {
              // Continue
            }
            break;
          }
        }
      }
    }
  }

  // Strategy 4: Regex extraction as last resort
  const actionMatch = text.match(/"action"\s*:\s*"(TRADE|SKIP)"/);
  if (actionMatch) {
    const action = actionMatch[1] as "TRADE" | "SKIP";
    const reasoningMatch = text.match(/"reasoning"\s*:\s*"([^"]*(?:\\"[^"]*)*)"/);
    const reasoning = reasoningMatch ? reasoningMatch[1] : "extracted via regex";
    log(DAEMON, "INFO", `Parsed decision via regex fallback: ${action}`);
    return { action, reasoning };
  }

  log(
    DAEMON,
    "WARN",
    `Could not parse decision, defaulting to SKIP. Preview: ${text.slice(0, 300)}`,
  );
  return { action: "SKIP", reasoning: "Failed to parse LLM response" };
}

// ─── Trade Executor ─────────────────────────────────────────────────────────

async function executeTrades(
  service: PolymarketService,
  decision: TradeDecision,
  vitals: VitalSigns,
): Promise<TradeResult[]> {
  if (
    decision.action !== "TRADE" ||
    !decision.trades ||
    decision.trades.length === 0
  ) {
    return [];
  }

  const results: TradeResult[] = [];
  const maxBet = Math.min(2.0, vitals.usdcBalance * 0.1);
  const cashReserve = vitals.totalEquity * 0.2;
  let currentBalance = vitals.usdcBalance;

  for (const trade of decision.trades) {
    try {
      // Validate and cap bet size
      const amount = Math.min(trade.amount, maxBet);
      if (amount <= 0) {
        log(DAEMON, "WARN", "Skipping trade: amount <= 0");
        continue;
      }

      // Check cash reserve
      if (currentBalance - amount < cashReserve) {
        log(
          DAEMON,
          "WARN",
          `Skipping trade: would breach cash reserve ($${cashReserve.toFixed(2)})`,
        );
        continue;
      }

      // Validate price
      if (
        !trade.limitPrice ||
        trade.limitPrice <= 0 ||
        trade.limitPrice >= 1
      ) {
        log(
          DAEMON,
          "WARN",
          `Skipping trade: invalid limitPrice ${trade.limitPrice}`,
        );
        continue;
      }

      // Validate side
      const side = trade.side === "SELL" ? "SELL" : "BUY";

      log(
        DAEMON,
        "INFO",
        `Executing: ${side} ${trade.outcome} $${amount.toFixed(2)} @ ${trade.limitPrice.toFixed(3)} on ${trade.conditionId.slice(0, 12)}...`,
      );

      const result = await service.createLimitOrder({
        marketConditionId: trade.conditionId,
        outcome: trade.outcome,
        side,
        amount,
        limitPrice: trade.limitPrice,
      });

      results.push(result);
      log(
        DAEMON,
        "INFO",
        `Trade executed: orderId=${result.orderId} status=${result.status}`,
      );

      // Update balance for next trade
      currentBalance = result.balanceAfter;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(DAEMON, "ERROR", `Trade execution failed: ${msg}`);
    }
  }

  return results;
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

async function runTradingCycle(
  triggerType: string,
  contextJson: string,
): Promise<void> {
  log(DAEMON, "INFO", `Starting trading cycle (trigger: ${triggerType})`);

  const config = getConfig();
  const service = new PolymarketService(config);
  const newsService = new NewsService(config.newsApiKey);

  // Parse trigger context
  let trigger: TriggerContext;
  try {
    const parsed = JSON.parse(contextJson);
    if (triggerType === "news") {
      trigger = { type: "news", news: parsed as CategorizedHeadline[] };
    } else if (triggerType === "price") {
      trigger = { type: "price", price: parsed };
    } else {
      trigger = { type: "news" };
    }
  } catch {
    log(DAEMON, "WARN", "Failed to parse context JSON, treating as news cycle");
    trigger = { type: "news" };
  }

  // Phase 1: Gather all data programmatically
  log(DAEMON, "INFO", "Gathering market data...");
  let data: GatheredData;
  try {
    data = await gatherAllData(service, newsService, trigger);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(DAEMON, "ERROR", `Data gathering failed: ${msg}`);
    return;
  }

  log(
    DAEMON,
    "INFO",
    `Data gathered: balance=$${data.vitals.usdcBalance.toFixed(2)}, ` +
      `${data.candidates.length} candidates, ` +
      `${data.flaggedPositions.length} stop-loss flags`,
  );

  // Phase 2: Handle stop-losses mechanically (no LLM needed)
  if (data.flaggedPositions.length > 0) {
    log(
      DAEMON,
      "INFO",
      `Executing ${data.flaggedPositions.length} stop-loss exits`,
    );
    await handleStopLosses(service, data.flaggedPositions);
  }

  // Phase 3: Abort if unhealthy
  if (data.vitals.status === "DEAD" || data.vitals.status === "CRITICAL") {
    log(
      DAEMON,
      "WARN",
      `Status is ${data.vitals.status} — aborting trading cycle`,
    );
    return;
  }

  // Phase 4: Build decision prompt and call Gemini directly (1 fresh API call)
  if (data.candidates.length === 0) {
    log(DAEMON, "INFO", "No market candidates found — skipping LLM call");
    return;
  }

  const prompt = buildDecisionPrompt(data, trigger);
  log(
    DAEMON,
    "INFO",
    `Calling Gemini directly (${prompt.length} chars, ~${Math.ceil(prompt.length / 4)} tokens)`,
  );

  const geminiResult = await callGemini(prompt);
  if (!geminiResult.success) {
    log(
      DAEMON,
      "ERROR",
      `Gemini call failed: ${geminiResult.text.slice(0, 200)}`,
    );
    return;
  }

  // Phase 5: Parse decision
  const decision = parseDecision(geminiResult.text);
  log(
    DAEMON,
    "INFO",
    `Agent decision: ${decision.action} — ${decision.reasoning}`,
  );

  // Phase 6: Execute trades
  if (decision.action === "TRADE") {
    const results = await executeTrades(service, decision, data.vitals);
    log(DAEMON, "INFO", `Executed ${results.length} trade(s)`);
  } else {
    log(DAEMON, "INFO", "Agent chose to SKIP — no trades placed");
  }

  log(DAEMON, "INFO", "Trading cycle complete");
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

const [triggerType, contextJson] = process.argv.slice(2);

if (!triggerType) {
  console.error("Usage: trading-cycle.ts <news|price> '<contextJson>'");
  process.exit(1);
}

runTradingCycle(triggerType, contextJson || "{}").then(
  () => {
    process.exit(0);
  },
  (err) => {
    log(DAEMON, "ERROR", `Fatal: ${err.message || err}`);
    process.exit(1);
  },
);
