import { SentimentScore } from "./types";

const BULLISH_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  // Strong bullish
  { pattern: /\brally\b/i, weight: 0.8 },
  { pattern: /\bsurge[ds]?\b/i, weight: 0.8 },
  { pattern: /\bsoar[sed]?\b/i, weight: 0.8 },
  { pattern: /\bbeat[s]?\s+(expectations?|estimates?|forecasts?)\b/i, weight: 0.9 },
  { pattern: /\bupgrade[ds]?\b/i, weight: 0.7 },
  { pattern: /\bbull(ish)?\b/i, weight: 0.6 },
  { pattern: /\bgrowth\b/i, weight: 0.4 },
  { pattern: /\bexpansion\b/i, weight: 0.5 },
  { pattern: /\bdovish\b/i, weight: 0.7 },
  { pattern: /\bstimulus\b/i, weight: 0.6 },
  { pattern: /\brecord\s+high\b/i, weight: 0.9 },
  { pattern: /\ball[- ]time\s+high\b/i, weight: 0.9 },
  { pattern: /\brate\s+cut\b/i, weight: 0.7 },
  { pattern: /\bstrong\s+(earnings?|jobs?|data|gdp|growth)\b/i, weight: 0.7 },
  { pattern: /\bbreakout\b/i, weight: 0.6 },
  { pattern: /\bpositive\b/i, weight: 0.3 },
  { pattern: /\boptimis(m|tic)\b/i, weight: 0.5 },
  { pattern: /\brecovery\b/i, weight: 0.5 },
  { pattern: /\bbuy(s|ing)?\b/i, weight: 0.3 },
];

const BEARISH_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  // Strong bearish
  { pattern: /\bcrash(e[ds])?\b/i, weight: 0.9 },
  { pattern: /\bplunge[ds]?\b/i, weight: 0.9 },
  { pattern: /\bplummet[sed]?\b/i, weight: 0.9 },
  { pattern: /\bmiss(e[ds])?\s+(expectations?|estimates?|forecasts?)\b/i, weight: 0.9 },
  { pattern: /\bdowngrade[ds]?\b/i, weight: 0.7 },
  { pattern: /\bbear(ish)?\b/i, weight: 0.6 },
  { pattern: /\brecession\b/i, weight: 0.8 },
  { pattern: /\bcontraction\b/i, weight: 0.6 },
  { pattern: /\bhawkish\b/i, weight: 0.7 },
  { pattern: /\bdefault[sed]?\b/i, weight: 0.8 },
  { pattern: /\bcollapse[ds]?\b/i, weight: 0.9 },
  { pattern: /\btumble[ds]?\b/i, weight: 0.7 },
  { pattern: /\bsell[- ]?off\b/i, weight: 0.8 },
  { pattern: /\brate\s+hike\b/i, weight: 0.7 },
  { pattern: /\bweak\s+(earnings?|jobs?|data|gdp|growth)\b/i, weight: 0.7 },
  { pattern: /\bbreakdown\b/i, weight: 0.6 },
  { pattern: /\bnegative\b/i, weight: 0.3 },
  { pattern: /\bpessimis(m|tic)\b/i, weight: 0.5 },
  { pattern: /\binflation\s+(surge|spike|jump|soar)\b/i, weight: 0.8 },
  { pattern: /\bsell(s|ing)?\b/i, weight: 0.3 },
  { pattern: /\bfear\b/i, weight: 0.5 },
  { pattern: /\bpanic\b/i, weight: 0.7 },
  { pattern: /\blayoff[s]?\b/i, weight: 0.6 },
  { pattern: /\bshutdown\b/i, weight: 0.5 },
];

const NEGATION_WORDS = new Set([
  "not", "no", "n't", "won't", "fail", "fails", "failed",
  "without", "unlikely", "despite", "neither", "never", "lack", "lacks",
]);

/**
 * Checks if any negation word appears within the 3 words before the match position.
 */
function isNegated(text: string, matchIndex: number): boolean {
  // Get the text before the match
  const before = text.slice(0, matchIndex);
  // Extract up to 3 words before the match
  const words = before.trim().split(/\s+/).slice(-3);
  return words.some((w) => NEGATION_WORDS.has(w.toLowerCase()));
}

export function scoreSentiment(title: string, summary: string): SentimentScore {
  // Title weighted 2x by repeating it
  const text = `${title} ${title} ${summary}`;
  const matchedPatterns: string[] = [];

  let bullScore = 0;
  let bearScore = 0;

  for (const { pattern, weight } of BULLISH_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const negated = isNegated(text, match.index);
      if (negated) {
        bearScore += weight;
        matchedPatterns.push(`~+${pattern.source}`);
      } else {
        bullScore += weight;
        matchedPatterns.push(`+${pattern.source}`);
      }
    }
  }

  for (const { pattern, weight } of BEARISH_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const negated = isNegated(text, match.index);
      if (negated) {
        bullScore += weight;
        matchedPatterns.push(`~-${pattern.source}`);
      } else {
        bearScore += weight;
        matchedPatterns.push(`-${pattern.source}`);
      }
    }
  }

  const total = bullScore + bearScore;
  const score = total > 0 ? (bullScore - bearScore) / total : 0;
  const confidence = Math.min(1, total / 3);

  let label: "bullish" | "bearish" | "neutral";
  if (score > 0.15) {
    label = "bullish";
  } else if (score < -0.15) {
    label = "bearish";
  } else {
    label = "neutral";
  }

  return { score, label, confidence, matchedPatterns };
}
