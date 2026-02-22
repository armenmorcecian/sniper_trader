/** The 11 SPDR Select Sector ETFs — rotation universe */
export const SECTOR_UNIVERSE: string[] = [
  "XLK", "XLF", "XLV", "XLE", "XLY", "XLP", "XLI", "XLU", "XLB", "XLC", "XLRE",
];

/** Maximum allowed Pearson correlation between sector holdings */
export const CORRELATION_THRESHOLD = 0.65;

/** ETF symbol → sector name mapping */
export const ETF_WATCHLIST: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "Nasdaq 100",
  XLK: "Technology",
  XLE: "Energy",
  XLF: "Financials",
  XLV: "Healthcare",
  XLI: "Industrials",
  XLP: "Consumer Staples",
  XLU: "Utilities",
  XLY: "Consumer Discretionary",
  XLB: "Materials",
  XLC: "Communication",
  XLRE: "Real Estate",
  GLD: "Gold",
  TLT: "20+ Year Treasuries",
  BITO: "Bitcoin Futures",
  IWM: "Russell 2000",
};
