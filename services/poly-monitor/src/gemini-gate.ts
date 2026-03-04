// ─── Gemini Gate ─────────────────────────────────────────────────────────────
// Compact Gemini LLM gate for BUY confirmations. Only invoked when the
// quant pipeline detects a statistically significant edge.

import axios from "axios";
import type { Config } from "./config";
import type { EdgeCandidate, GeminiDecision } from "./types";

const LOG_PREFIX = "[gemini-gate]";

// ─── Gemini API Call ─────────────────────────────────────────────────────────

async function callGemini(
  prompt: string,
  config: Config,
): Promise<{ success: boolean; text: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;

  try {
    const resp = await axios.post(
      `${url}?key=${config.geminiApiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 256,
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

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildBuyPrompt(
  candidate: EdgeCandidate,
  balance: number,
  positionCount: number,
  dailyPnl: number,
): string {
  return `You are a quantitative trading assistant. A prediction market opportunity has been detected by algorithmic analysis.

OPPORTUNITY:
- Market: "${candidate.question}"
- Current price: ${candidate.marketPrice.toFixed(3)}
- Model probability: ${candidate.filteredProb.toFixed(3)} (edge: ${(candidate.edge * 100).toFixed(1)}%)
- Monte Carlo implied prob: ${candidate.ev.impliedProbYes.toFixed(3)}
- Confidence interval: [${candidate.ci95[0].toFixed(3)}, ${candidate.ci95[1].toFixed(3)}]
- Expiry: ${candidate.endDate}
- Suggested outcome: ${candidate.outcome}

PORTFOLIO:
- Balance: $${balance.toFixed(2)}
- Open positions: ${positionCount}
- Daily P&L: $${dailyPnl.toFixed(2)}

RULES:
- Max bet: min($2.00, 10% of balance)
- Keep 20% cash reserve
- Only confirm if you believe the edge is real and the market is liquid

Respond with ONLY a JSON object, no markdown:
{"action":"BUY","outcome":"Yes or No","amount":N} or {"action":"SKIP","reasoning":"..."}`;
}

// ─── Response Parser ─────────────────────────────────────────────────────────

function validateDecision(parsed: Record<string, unknown>): GeminiDecision {
  const action = parsed.action as string;
  if (action !== "BUY" && action !== "SKIP") {
    return { action: "SKIP", reasoning: `Unknown action: ${action}` };
  }
  if (action === "BUY") {
    return {
      action: "BUY",
      outcome: (parsed.outcome as "Yes" | "No") || "Yes",
      amount: Number(parsed.amount) || 1,
      reasoning: String(parsed.reasoning || "Gemini confirmed"),
    };
  }
  return { action: "SKIP", reasoning: String(parsed.reasoning || "Gemini skipped") };
}

function parseGeminiDecision(rawText: string): GeminiDecision {
  // Strip markdown code fences
  const text = rawText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Strategy 1: Try full JSON parse
  try {
    const parsed = JSON.parse(text);
    if (parsed.action) return validateDecision(parsed);
  } catch { /* continue */ }

  // Strategy 2: Collapse to single line
  const singleLine = text.replace(/\r?\n/g, " ").trim();
  try {
    const parsed = JSON.parse(singleLine);
    if (parsed.action) return validateDecision(parsed);
  } catch { /* continue */ }

  // Strategy 3: Bracket matching for "action"
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
            } catch { /* continue */ }
            break;
          }
        }
      }
    }
  }

  // Strategy 4: Regex extraction
  const actionMatch = text.match(/"action"\s*:\s*"(BUY|SKIP)"/);
  if (actionMatch) {
    const action = actionMatch[1] as "BUY" | "SKIP";
    const reasoningMatch = text.match(/"reasoning"\s*:\s*"([^"]*(?:\\"[^"]*)*)"/);
    const reasoning = reasoningMatch ? reasoningMatch[1] : "extracted via regex";
    console.log(`${LOG_PREFIX} Parsed decision via regex fallback: ${action}`);

    if (action === "BUY") {
      const outcomeMatch = text.match(/"outcome"\s*:\s*"(Yes|No)"/);
      const amountMatch = text.match(/"amount"\s*:\s*([0-9.]+)/);
      return {
        action: "BUY",
        outcome: (outcomeMatch?.[1] as "Yes" | "No") || "Yes",
        amount: amountMatch ? Number(amountMatch[1]) : 1,
        reasoning,
      };
    }
    return { action: "SKIP", reasoning };
  }

  console.warn(`${LOG_PREFIX} Could not parse Gemini response, defaulting to SKIP. Preview: ${text.slice(0, 200)}`);
  return { action: "SKIP", reasoning: "Failed to parse LLM response" };
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function confirmBuy(
  candidate: EdgeCandidate,
  balance: number,
  positionCount: number,
  dailyPnl: number,
  config: Config,
): Promise<GeminiDecision> {
  const prompt = buildBuyPrompt(candidate, balance, positionCount, dailyPnl);

  console.log(`${LOG_PREFIX} Calling Gemini for "${candidate.question.slice(0, 50)}..." (edge=${(candidate.edge * 100).toFixed(1)}%)`);

  const result = await callGemini(prompt, config);

  if (!result.success) {
    console.error(`${LOG_PREFIX} Gemini call failed: ${result.text}`);
    return { action: "SKIP", reasoning: `Gemini error: ${result.text.slice(0, 100)}` };
  }

  const decision = parseGeminiDecision(result.text);
  console.log(`${LOG_PREFIX} Gemini decision: ${decision.action}${decision.action === "BUY" ? ` ${decision.outcome} $${decision.amount}` : ""} — ${decision.reasoning.slice(0, 80)}`);

  return decision;
}
