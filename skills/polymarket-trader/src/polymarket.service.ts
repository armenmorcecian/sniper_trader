import { Wallet } from "@ethersproject/wallet";
import {
  ClobClient,
  Chain,
  Side,
  OrderType,
  AssetType,
  ApiKeyCreds,
} from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import axios, { AxiosInstance } from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  PolymarketConfig,
  MarketScanParams,
  MarketScanResult,
  ScannedMarket,
  TradeParams,
  TradeResult,
  VitalSigns,
  PositionSummary,
  AgentStatus,
  AgentDeathError,
  InsufficientFundsError,
} from "./types";
import { withRetry, resolveTokenId, safeJsonParse } from "./utils";
import { analyzeOrderBookDepth, shouldAvoidMarket } from "./analysis";
import { recordApiSuccess, recordApiFailure } from "quant-core";

export class PolymarketService {
  private config: PolymarketConfig;
  private clobClient!: ClobClient;
  private gammaApi: AxiosInstance;
  private dataApi: AxiosInstance;
  private initialized = false;

  constructor(config: PolymarketConfig) {
    this.config = config;

    const agentOpts = config.proxyUrl
      ? { httpsAgent: new HttpsProxyAgent(config.proxyUrl), httpAgent: new HttpsProxyAgent(config.proxyUrl) }
      : {};

    this.gammaApi = axios.create({
      baseURL: config.gammaHost,
      timeout: 15000,
      ...agentOpts,
    });

    this.dataApi = axios.create({
      baseURL: config.dataHost,
      timeout: 15000,
      ...agentOpts,
    });

    // API health interceptors — track consecutive failures for circuit breaker
    this.gammaApi.interceptors.response.use(
      (res) => { recordApiSuccess("poly-gamma"); return res; },
      (err) => { if (err.response?.status >= 500 || err.code === "ECONNABORTED") recordApiFailure("poly-gamma"); return Promise.reject(err); }
    );
    this.dataApi.interceptors.response.use(
      (res) => { recordApiSuccess("poly-data"); return res; },
      (err) => { if (err.response?.status >= 500 || err.code === "ECONNABORTED") recordApiFailure("poly-data"); return Promise.reject(err); }
    );
  }

  /**
   * Initializes the CLOB client.
   * Path 1: L2 creds provided → construct directly
   * Path 2: Only private key → derive API keys first
   */
  async initClient(): Promise<void> {
    if (this.initialized) return;

    const signer = new Wallet(this.config.privateKey);

    if (
      this.config.apiKey &&
      this.config.apiSecret &&
      this.config.passphrase
    ) {
      // Path 1: Direct construction with provided L2 creds
      const creds: ApiKeyCreds = {
        key: this.config.apiKey,
        secret: this.config.apiSecret,
        passphrase: this.config.passphrase,
      };

      this.clobClient = new ClobClient(
        this.config.clobHost,
        Chain.POLYGON,
        signer,
        creds,
        SignatureType.POLY_PROXY,
        this.config.funder,
      );
    } else {
      // Path 2: Derive API keys from private key
      const tempClient = new ClobClient(
        this.config.clobHost,
        Chain.POLYGON,
        signer,
      );

      let derivedCreds: ApiKeyCreds;
      try {
        derivedCreds = await withRetry(() =>
          tempClient.deriveApiKey(),
        );
      } catch (err) {
        // deriveApiKey() failed — fall back to createOrDeriveApiKey() for first-time setup
        console.warn(
          "[PolymarketService] deriveApiKey failed, falling back to createOrDeriveApiKey():",
          err instanceof Error ? err.message : String(err),
        );
        derivedCreds = await tempClient.createOrDeriveApiKey();
      }

      this.clobClient = new ClobClient(
        this.config.clobHost,
        Chain.POLYGON,
        signer,
        derivedCreds,
        SignatureType.POLY_PROXY,
        this.config.funder,
      );
    }

    if (!this.config.funder) {
      console.warn(
        "[PolymarketService] WARNING: POLY_FUNDER not set — balance reads may return $0 if funds are in proxy wallet.",
      );
    }

    // Patch CLOB client to route order-posting requests through residential proxy
    // Polymarket blocks datacenter IPs for order placement
    this.patchProxyForOrders();

    this.initialized = true;
  }

  /**
   * Monkey-patches the ClobClient's `get` and `post` methods to route
   * requests through a residential proxy, bypassing Polymarket's datacenter
   * IP block (Cloudflare 403 on both GET and POST).
   */
  private patchProxyForOrders(): void {
    const proxyUrl = this.config.proxyUrl;
    if (!proxyUrl) return;

    // Access protected methods via any-cast — ClobClient doesn't expose proxy config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.clobClient as any;

    // ── Patch GET ──────────────────────────────────────────────────────────
    const originalGet = client.get.bind(client);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.get = async (endpoint: string, options?: any): Promise<any> => {
      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const agent = new HttpsProxyAgent(proxyUrl);
        try {
          const resp = await axios({
            method: "GET",
            url: endpoint,
            headers: { ...(options?.headers || {}), "User-Agent": "@polymarket/clob-client", Accept: "*/*" },
            params: options?.params,
            httpsAgent: agent,
            httpAgent: agent,
          });
          return resp.data;
        } catch (err: unknown) {
          if (axios.isAxiosError(err) && err.response?.status === 403 && attempt < maxRetries) {
            console.warn(
              `[ProxyGet] 403 on attempt ${attempt}/${maxRetries}, rotating IP...`,
            );
            continue;
          }
          // On final failure or non-403, fall through to original
          if (attempt === maxRetries) return originalGet(endpoint, options);
          throw err;
        }
      }
    };

    // ── Patch POST ─────────────────────────────────────────────────────────
    const originalPost = client.post.bind(client);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.post = async (endpoint: string, options?: any): Promise<any> => {
      // Only proxy write endpoints (order placement, cancellation)
      const isOrderEndpoint =
        endpoint.includes("/order") || endpoint.includes("/cancel");

      if (isOrderEndpoint) {
        const headers: Record<string, string> = {
          ...(options?.headers || {}),
          "User-Agent": "@polymarket/clob-client",
          Accept: "*/*",
          Connection: "keep-alive",
          "Content-Type": "application/json",
        };

        // Retry up to 5 times on 403 — rotating proxy assigns new IP each attempt
        const maxRetries = 5;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          // New agent per attempt to force IP rotation
          const agent = new HttpsProxyAgent(proxyUrl);
          try {
            const resp = await axios({
              method: "POST",
              url: endpoint,
              headers,
              data: options?.data,
              params: options?.params,
              httpsAgent: agent,
              httpAgent: agent,
            });
            return resp.data;
          } catch (err: unknown) {
            if (axios.isAxiosError(err) && err.response) {
              if (err.response.status === 403 && attempt < maxRetries) {
                console.warn(
                  `[ProxyPost] 403 geo-block on attempt ${attempt}/${maxRetries}, rotating IP...`,
                );
                continue;
              }
              console.error(
                "[ProxyPost] error",
                JSON.stringify({
                  status: err.response.status,
                  data: err.response.data,
                }),
              );
              return { ...err.response.data, status: err.response.status };
            }
            throw err;
          }
        }
      }

      // Non-order endpoints go direct (no proxy)
      return originalPost(endpoint, options);
    };

    console.log("[PolymarketService] Residential proxy enabled for GET + POST endpoints (with 403 retry)");
  }

  /**
   * Three-phase market scan:
   * 1. Query Gamma API for markets with volume/liquidity filters
   * 2. Enrich with CLOB spread/midpoint data
   * 3. Fetch order books and run whale detection
   */
  async findLiquidMarkets(
    params: MarketScanParams = {},
  ): Promise<MarketScanResult> {
    await this.ensureInitialized();

    const {
      minVolume = 10000,
      minLiquidity = 5000,
      maxSpread = 0.1,
      category = "crypto,economics,sports",
      limit = 20,
    } = params;

    // Category keyword patterns (Gamma API tag filter is unreliable)
    // Use word-boundary regex to avoid substring matches (e.g., "sol" in "resolution")
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
    ];

    // Sports daily games: must contain "vs" or "vs." — this catches matchups
    // like "Mavericks vs. Lakers" but NOT "Will X win the Stanley Cup"
    const SPORTS_DAILY_PATTERN = /\bvs\.?\s/i;
    // Exclude championship futures that also contain "vs" (unlikely, but safe)
    const SPORTS_FUTURES_EXCLUDE = [
      /\bwin the\b.*\b(stanley cup|nba finals|super bowl|world series|champions league)\b/i,
      /\b(stanley cup|nba finals|super bowl|world series|champions league)\b/i,
    ];

    // Phase 1: Query Gamma API (no tag filter — it's unreliable)
    const gammaResponse = await withRetry(() =>
      this.gammaApi.get("/markets", {
        params: {
          active: true,
          closed: false,
          order: "volume24hr",
          ascending: false,
          limit: limit * 5, // Fetch extra — many will be filtered by category + volume
        },
      }),
    );

    const rawMarkets: Record<string, unknown>[] = gammaResponse.data || [];

    // Helper: check if text matches a category
    const matchesCategory = (text: string, cat: string): boolean => {
      switch (cat) {
        case "crypto":
          return CRYPTO_PATTERNS.some((re) => re.test(text));
        case "economics":
          return ECONOMICS_PATTERNS.some((re) => re.test(text));
        case "sports":
          // Must match "vs" pattern AND not be a championship future
          return (
            SPORTS_DAILY_PATTERN.test(text) &&
            !SPORTS_FUTURES_EXCLUDE.some((re) => re.test(text))
          );
        case "all":
          return true;
        default:
          return true;
      }
    };

    // Filter by volume, liquidity, and category keywords
    const activeCategories =
      category === "all"
        ? ["all"]
        : category.split(",").map((c) => c.trim().toLowerCase());

    const filtered = rawMarkets.filter((m) => {
      const vol = Number(m.volume24hr || 0);
      const liq = Number(m.liquidity || 0);
      if (vol < minVolume || liq < minLiquidity) return false;

      const question = String(m.question || "");
      const description = String(m.description || "");
      const text = question + " " + description;

      return activeCategories.some((cat) => matchesCategory(text, cat));
    });

    // Phase 2 + 3: Enrich with CLOB data and order book depth
    const enrichedPromises = filtered.slice(0, limit).map(async (market) => {
      try {
        return await this.enrichMarketData(market);
      } catch {
        return null;
      }
    });

    const enriched = (await Promise.all(enrichedPromises)).filter(
      (m): m is ScannedMarket => m !== null && m.spread <= maxSpread,
    );

    // Sort by volume descending
    enriched.sort((a, b) => b.volume24hr - a.volume24hr);

    return {
      markets: enriched.slice(0, limit),
      metadata: {
        totalFound: enriched.length,
        filtersApplied: {
          minVolume,
          minLiquidity,
          maxSpread,
          category,
          limit,
        },
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Creates and posts a limit order.
   * Pre-checks: balance validation, whale detection.
   */
  async createLimitOrder(params: TradeParams): Promise<TradeResult> {
    await this.ensureInitialized();

    const {
      marketConditionId,
      outcome,
      side,
      amount,
      limitPrice,
    } = params;

    if (!limitPrice) {
      throw new Error("limitPrice is required for limit orders");
    }

    // Fetch market data from Gamma
    const marketData = await this.fetchGammaMarket(marketConditionId);
    const tokenId = resolveTokenId(
      marketData.outcomes,
      marketData.clobTokenIds,
      outcome,
    );

    // Whale detection
    const orderBook = await withRetry(() =>
      this.clobClient.getOrderBook(tokenId),
    );
    const depth = analyzeOrderBookDepth(orderBook);
    const avoidance = shouldAvoidMarket(depth, side as "BUY" | "SELL");
    if (avoidance.avoid) {
      throw new Error(`Trade rejected — ${avoidance.reason}`);
    }

    // Balance check
    if (side === "BUY") {
      const totalCost = amount * limitPrice;
      const balance = await this.getUsdcBalance();
      if (totalCost > balance) {
        throw new InsufficientFundsError(totalCost, balance);
      }
    } else {
      // SELL: verify we hold enough outcome tokens
      await this.verifySellBalance(marketConditionId, outcome, amount);
    }

    // Fetch tick size and negRisk
    const [tickSize, negRisk] = await Promise.all([
      withRetry(() => this.clobClient.getTickSize(tokenId)),
      withRetry(() => this.clobClient.getNegRisk(tokenId)),
    ]);

    // Calculate size from amount and price
    const size = side === "BUY" ? amount / limitPrice : amount;

    const orderResponse = await withRetry(() =>
      this.clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: limitPrice,
          size,
          side: side === "BUY" ? Side.BUY : Side.SELL,
        },
        { tickSize, negRisk },
        OrderType.GTC,
      ),
    );

    const balanceAfter = await this.getUsdcBalance();

    return {
      orderId: orderResponse.orderID || "",
      side: side as "BUY" | "SELL",
      outcome,
      price: limitPrice,
      size,
      totalCost: side === "BUY" ? size * limitPrice : 0,
      balanceAfter,
      status: orderResponse.status || "unknown",
      transactionHashes: orderResponse.transactionsHashes || [],
    };
  }

  /**
   * Creates and posts a market order (Fill or Kill).
   * Pre-checks: balance validation, whale detection.
   */
  async marketBuy(params: TradeParams): Promise<TradeResult> {
    await this.ensureInitialized();

    const { marketConditionId, outcome, side, amount } = params;

    // Fetch market data
    const marketData = await this.fetchGammaMarket(marketConditionId);
    const tokenId = resolveTokenId(
      marketData.outcomes,
      marketData.clobTokenIds,
      outcome,
    );

    // Whale detection
    const orderBook = await withRetry(() =>
      this.clobClient.getOrderBook(tokenId),
    );
    const depth = analyzeOrderBookDepth(orderBook);
    const avoidance = shouldAvoidMarket(depth, side as "BUY" | "SELL");
    if (avoidance.avoid) {
      throw new Error(`Trade rejected — ${avoidance.reason}`);
    }

    // Balance check
    if (side === "BUY") {
      const balance = await this.getUsdcBalance();
      if (amount > balance) {
        throw new InsufficientFundsError(amount, balance);
      }
    } else {
      // SELL: verify we hold enough outcome tokens
      await this.verifySellBalance(marketConditionId, outcome, amount);
    }

    // Fetch tick size and negRisk
    const [tickSize, negRisk] = await Promise.all([
      withRetry(() => this.clobClient.getTickSize(tokenId)),
      withRetry(() => this.clobClient.getNegRisk(tokenId)),
    ]);

    const orderResponse = await withRetry(() =>
      this.clobClient.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount,
          side: side === "BUY" ? Side.BUY : Side.SELL,
        },
        { tickSize, negRisk },
        OrderType.FOK,
      ),
    );

    const balanceAfter = await this.getUsdcBalance();

    return {
      orderId: orderResponse.orderID || "",
      side: side as "BUY" | "SELL",
      outcome,
      price: 0, // Market order — filled at best available
      size: amount,
      totalCost: amount,
      balanceAfter,
      status: orderResponse.status || "unknown",
      transactionHashes: orderResponse.transactionsHashes || [],
    };
  }

  /**
   * Fetches portfolio value from 4 sources in parallel:
   * 1. CLOB balance (USDC in CTF Exchange proxy)
   * 2. Data API positions
   * 3. Data API total value
   * 4. CLOB open orders count
   */
  async getPortfolioValue(): Promise<VitalSigns> {
    await this.ensureInitialized();

    const userAddress = this.config.funder || this.config.walletAddress;

    let balanceFailed = false;
    let valueFailed = false;

    const [balanceResult, positionsResult, valueResult, ordersResult] =
      await Promise.all([
        withRetry(() =>
          this.clobClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
          }),
        ).catch((err) => {
          console.warn("[getPortfolioValue] balance fetch failed:", err instanceof Error ? err.message : String(err));
          balanceFailed = true;
          return { balance: "0" };
        }),
        withRetry(() =>
          this.dataApi.get("/positions", { params: { user: userAddress } }),
        ).catch((err) => {
          console.warn("[getPortfolioValue] positions fetch failed:", err instanceof Error ? err.message : String(err));
          return { data: [] };
        }),
        withRetry(() =>
          this.dataApi.get("/value", { params: { user: userAddress } }),
        ).catch((err) => {
          console.warn("[getPortfolioValue] value fetch failed:", err instanceof Error ? err.message : String(err));
          valueFailed = true;
          return { data: { value: 0 } };
        }),
        withRetry(() => this.clobClient.getOpenOrders()).catch((err) => {
          console.warn("[getPortfolioValue] orders fetch failed:", err instanceof Error ? err.message : String(err));
          return { data: [] };
        }),
      ]);

    const rawBalance = parseFloat(
      (balanceResult as { balance: string }).balance || "0",
    );
    // CLOB returns balance in microUSDC (6 decimals) — normalize to dollars
    const usdcBalance = rawBalance > 1000 ? rawBalance / 1e6 : rawBalance;

    const positionValue = Number(
      (valueResult as { data: { value: number } }).data?.value || 0,
    );

    const totalEquity = usdcBalance + positionValue;

    // Map positions to summaries
    const rawPositions: Record<string, unknown>[] = Array.isArray(
      (positionsResult as { data: unknown }).data,
    )
      ? ((positionsResult as { data: Record<string, unknown>[] }).data)
      : [];

    const positions: PositionSummary[] = rawPositions
      .map((pos) => {
        const size = Number(pos.size || 0);
        const avgPrice = Number(pos.avgPrice || pos.avg_price || 0);
        const curPrice = Number(pos.curPrice || pos.current_price || 0);
        const marketValue = size * curPrice;
        const costBasis = size * avgPrice;
        const pnl = marketValue - costBasis;
        const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

        return {
          conditionId: String(pos.conditionId || pos.condition_id || ""),
          question: String(pos.title || pos.question || ""),
          outcome: String(pos.outcome || ""),
          size,
          avgEntryPrice: avgPrice,
          currentPrice: curPrice,
          marketValue,
          pnl,
          pnlPercent,
        };
      })
      .filter((pos) => {
        // Resolved losing positions: size > 0 but currentPrice = 0 — no economic value
        if (pos.size > 0 && pos.currentPrice === 0) return false;
        // Dust positions worth less than $0.001
        if (pos.marketValue < 0.001 && pos.size > 0) return false;
        return true;
      });

    // Determine open order count
    const openOrders = (ordersResult as { data?: unknown[] }).data || [];
    const openOrderCount = Array.isArray(openOrders) ? openOrders.length : 0;

    // Status thresholds
    let status: AgentStatus;
    if (totalEquity <= 0) {
      status = "DEAD";
    } else if (totalEquity < 10) {
      status = "CRITICAL";
    } else if (totalEquity < 20) {
      status = "WARNING";
    } else {
      status = "HEALTHY";
    }

    const vitals: VitalSigns = {
      usdcBalance,
      positionValue,
      totalEquity,
      positions,
      openOrderCount,
      status,
      timestamp: new Date().toISOString(),
    };

    if (status === "DEAD") {
      // If both balance AND value fetches failed, this is a data outage, not real $0
      if (balanceFailed || valueFailed) {
        console.warn("[getPortfolioValue] All data sources failed — reporting CRITICAL instead of DEAD to avoid false kill.");
        return {
          ...vitals,
          status: "CRITICAL" as AgentStatus,
        };
      }
      throw new AgentDeathError();
    }

    return vitals;
  }

  /**
   * Returns current positions with P&L for stop-loss checks.
   */
  async getOpenPositionsWithPnL(): Promise<PositionSummary[]> {
    const vitals = await this.getPortfolioValue();
    return vitals.positions;
  }

  /**
   * Cancels a single open order by ID.
   */
  async cancelOrder(orderId: string): Promise<{ success: boolean; orderId: string }> {
    await this.ensureInitialized();
    await withRetry(() => this.clobClient.cancelOrder({ orderID: orderId }));
    return { success: true, orderId };
  }

  /**
   * Cancels all open orders.
   */
  async cancelAllOrders(): Promise<{ success: boolean; cancelledCount: number }> {
    await this.ensureInitialized();
    const openOrders = await withRetry(() => this.clobClient.getOpenOrders());
    const count = Array.isArray(openOrders) ? openOrders.length : 0;
    if (count === 0) {
      return { success: true, cancelledCount: 0 };
    }
    await withRetry(() => this.clobClient.cancelAll());
    return { success: true, cancelledCount: count };
  }

  /**
   * Market sell to exit a position immediately.
   */
  async sellPosition(
    conditionId: string,
    outcome: "Yes" | "No",
  ): Promise<TradeResult> {
    await this.ensureInitialized();
    const marketData = await this.fetchGammaMarket(conditionId);
    const tokenId = resolveTokenId(
      marketData.outcomes,
      marketData.clobTokenIds,
      outcome,
    );

    // Get current position size
    const positions = await this.getOpenPositionsWithPnL();
    const position = positions.find(
      (p) =>
        p.conditionId === conditionId &&
        p.outcome.toLowerCase() === outcome.toLowerCase(),
    );

    if (!position || position.size <= 0) {
      throw new Error(
        `No open position found for ${conditionId} ${outcome}`,
      );
    }

    return this.marketBuy({
      marketConditionId: conditionId,
      outcome,
      side: "SELL",
      amount: position.size,
    });
  }

  /**
   * Fetches the current status of an order by ID.
   * Used by the arbitrage engine to poll for Leg 1 fill confirmation.
   */
  async getOrderStatus(
    orderId: string,
  ): Promise<{ status: string; price?: number }> {
    await this.ensureInitialized();
    const order = await withRetry(() =>
      this.clobClient.getOrder(orderId),
    );
    const o = order as unknown as Record<string, unknown>;
    const status = String(
      o?.status || o?.order_status || "UNKNOWN",
    ).toUpperCase();
    const price = Number(o?.price || 0) || undefined;
    return { status, price };
  }

  /**
   * Fetches order book for a specific token. Exposed for the check_order_depth tool.
   */
  async getOrderBookForToken(
    conditionId: string,
    outcome: "Yes" | "No",
  ): Promise<{
    orderBook: { bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> };
    tokenId: string;
  }> {
    await this.ensureInitialized();

    const marketData = await this.fetchGammaMarket(conditionId);
    const tokenId = resolveTokenId(
      marketData.outcomes,
      marketData.clobTokenIds,
      outcome,
    );

    const orderBook = await withRetry(() =>
      this.clobClient.getOrderBook(tokenId),
    );

    return { orderBook, tokenId };
  }

  /**
   * Fetches the current price for a token from the CLOB.
   */
  async getPrice(tokenId: string): Promise<{ price: number; side: string }> {
    await this.ensureInitialized();
    const result = await withRetry(() =>
      this.clobClient.getPrice(tokenId, Side.BUY),
    );
    return {
      price: parseFloat((result as { price?: string }).price || "0"),
      side: "BUY",
    };
  }

  /**
   * Fetches the end date for a market from the Gamma API.
   * Returns ISO date string or null if not available.
   */
  async getMarketEndDate(conditionId: string): Promise<string | null> {
    try {
      const resp = await this.gammaApi.get("/markets", { params: { condition_id: conditionId } });
      return resp.data?.[0]?.endDate || resp.data?.[0]?.end_date_iso || null;
    } catch { return null; }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initClient();
    }
  }

  /**
   * Verifies the wallet holds enough outcome tokens to sell.
   * Throws a clear error if position doesn't exist or amount exceeds holdings.
   */
  private async verifySellBalance(
    conditionId: string,
    outcome: string,
    amount: number,
  ): Promise<void> {
    const positions = await this.getOpenPositionsWithPnL();
    const position = positions.find(
      (p) =>
        p.conditionId === conditionId &&
        p.outcome.toLowerCase() === outcome.toLowerCase(),
    );

    if (!position || position.size <= 0) {
      throw new Error(
        `Cannot SELL: no open position for conditionId ${conditionId} outcome "${outcome}". ` +
        `You must own tokens before selling. Current positions: ${positions.length === 0 ? "none" : positions.map(p => `${p.conditionId.slice(0, 10)}… ${p.outcome} (${p.size})`).join(", ")}`,
      );
    }

    if (amount > position.size) {
      throw new Error(
        `Cannot SELL ${amount} tokens: only holding ${position.size} of ${outcome} for this market. ` +
        `Reduce amount to ${position.size} or less.`,
      );
    }
  }

  private async getUsdcBalance(): Promise<number> {
    const result = await withRetry(() =>
      this.clobClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      }),
    );
    const raw = parseFloat(result.balance || "0");
    return raw > 1000 ? raw / 1e6 : raw;
  }

  private async fetchGammaMarket(
    conditionId: string,
  ): Promise<{
    outcomes: string[];
    clobTokenIds: string[];
    outcomePrices: number[];
  }> {
    // Use CLOB client getMarket() — reliable conditionId lookup
    const market = await withRetry(() =>
      this.clobClient.getMarket(conditionId),
    );

    if (!market || !market.tokens || market.tokens.length === 0) {
      throw new Error(
        `Market not found for conditionId: ${conditionId}`,
      );
    }

    const outcomes = market.tokens.map(
      (t: { outcome: string }) => t.outcome,
    );
    const clobTokenIds = market.tokens.map(
      (t: { token_id: string }) => t.token_id,
    );
    const outcomePrices = market.tokens.map(
      (t: { price: number }) => t.price,
    );

    return { outcomes, clobTokenIds, outcomePrices };
  }

  private async enrichMarketData(
    market: Record<string, unknown>,
  ): Promise<ScannedMarket | null> {
    const outcomes = safeJsonParse<string[]>(
      market.outcomes as string[] | string,
    );
    const clobTokenIds = safeJsonParse<string[]>(
      market.clobTokenIds as string[] | string,
    );
    const outcomePrices = safeJsonParse<number[]>(
      market.outcomePrices as number[] | string,
    );

    if (!clobTokenIds || clobTokenIds.length === 0) return null;

    const primaryTokenId = clobTokenIds[0];

    // Fetch CLOB data: spread, midpoint, order book
    const [spreadResult, midpointResult, orderBook] = await Promise.all([
      withRetry(() => this.clobClient.getSpread(primaryTokenId)).catch(
        () => null,
      ),
      withRetry(() => this.clobClient.getMidpoint(primaryTokenId)).catch(
        () => null,
      ),
      withRetry(() => this.clobClient.getOrderBook(primaryTokenId)).catch(
        () => null,
      ),
    ]);

    const spread = spreadResult
      ? parseFloat((spreadResult as { spread: string }).spread || "0")
      : 0;
    const midpoint = midpointResult
      ? parseFloat((midpointResult as { mid: string }).mid || "0")
      : 0;

    // Order book depth analysis
    let bidDepthUsd = 0;
    let askDepthUsd = 0;
    let whaleWallDetected = false;
    let bestBid = 0;
    let bestAsk = 0;

    if (orderBook) {
      const depth = analyzeOrderBookDepth(orderBook);
      bidDepthUsd = depth.bidDepthUsd;
      askDepthUsd = depth.askDepthUsd;
      whaleWallDetected = depth.whaleWallDetected;

      if (orderBook.bids.length > 0) {
        bestBid = parseFloat(orderBook.bids[0].price);
      }
      if (orderBook.asks.length > 0) {
        bestAsk = parseFloat(orderBook.asks[0].price);
      }
    }

    // Time-to-expiration calculation
    const endDateStr = String(market.endDate || market.end_date_iso || market.end_date || "");
    let hoursToExpiration = Infinity;
    let expirationWarning: string | undefined;

    if (endDateStr) {
      const endDate = new Date(endDateStr);
      if (!isNaN(endDate.getTime())) {
        hoursToExpiration = Math.max(0, (endDate.getTime() - Date.now()) / (1000 * 60 * 60));
        hoursToExpiration = Math.round(hoursToExpiration * 10) / 10;

        if (hoursToExpiration < 24) {
          expirationWarning = `CRITICAL: Expires in ${hoursToExpiration.toFixed(1)}h — extreme risk`;
        } else if (hoursToExpiration < 7 * 24) {
          const days = Math.round(hoursToExpiration / 24 * 10) / 10;
          expirationWarning = `WARNING: Expires in ${days}d — elevated risk`;
        }
      }
    }

    return {
      conditionId: String(market.conditionId || market.condition_id || ""),
      question: String(market.question || ""),
      description: String(market.description || ""),
      category: String(market.category || market.tag || ""),
      active: Boolean(market.active),
      endDate: endDateStr,
      volume24hr: Number(market.volume24hr || 0),
      liquidity: Number(market.liquidity || 0),
      outcomes,
      clobTokenIds,
      outcomePrices: outcomePrices.map(Number),
      spread,
      midpoint,
      bestBid,
      bestAsk,
      bidDepthUsd,
      askDepthUsd,
      whaleWallDetected,
      hoursToExpiration,
      expirationWarning,
    };
  }
}
