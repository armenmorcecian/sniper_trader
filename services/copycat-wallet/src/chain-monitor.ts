// ─── Chain Monitor ──────────────────────────────────────────────────────────
// Subscribes to OrderFilled events on both Polymarket CTF Exchange contracts
// via Polygon WebSocket. Tracks multiple wallets with tier-based filtering.

import { ethers } from "ethers";
import { EventEmitter } from "events";
import type { OrderFilledEvent, WalletScore } from "./types";

const LOG_PREFIX = "[chain-monitor]";

// Polymarket CTF Exchange contracts on Polygon
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEGRISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// OrderFilled event ABI (same for both contracts)
const ORDER_FILLED_ABI = [
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
];

// USDC assetId on Polymarket is 0
const USDC_ASSET_ID = ethers.BigNumber.from(0);

// Debounce window for partial fills (ms)
const DEBOUNCE_MS = 5_000;

interface DebouncedEvent {
  event: OrderFilledEvent;
  timer: ReturnType<typeof setTimeout>;
}

export class ChainMonitor extends EventEmitter {
  private provider: ethers.providers.WebSocketProvider | null = null;
  private ctfContract: ethers.Contract | null = null;
  private negRiskContract: ethers.Contract | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private _connected = false;
  private walletScores = new Map<string, WalletScore>();
  private trackedSet = new Set<string>(); // lowercase addresses
  private debounceMap = new Map<string, DebouncedEvent>(); // "tokenId:wallet" → pending event

  constructor(
    private readonly wsRpcUrl: string,
    walletScores: Map<string, WalletScore>,
  ) {
    super();
    this.setWallets(walletScores);
  }

  get connected(): boolean {
    return this._connected;
  }

  get walletCount(): number {
    return this.trackedSet.size;
  }

  private setWallets(scores: Map<string, WalletScore>): void {
    this.walletScores = scores;
    this.trackedSet = new Set([...scores.keys()].map((k) => k.toLowerCase()));
  }

  /** Replace tracked wallets and re-subscribe. */
  updateWallets(newScores: Map<string, WalletScore>): void {
    const oldSet = this.trackedSet;
    this.setWallets(newScores);

    const added = [...this.trackedSet].filter((w) => !oldSet.has(w));
    const removed = [...oldSet].filter((w) => !this.trackedSet.has(w));

    console.log(
      `${LOG_PREFIX} Wallet rotation: +${added.length} -${removed.length} → ${this.trackedSet.size} tracked`,
    );

    // Re-subscribe only if connected
    if (this._connected && this.provider) {
      this.removeSubscriptions();
      this.setupSubscriptions();
    }
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.destroyed) return;

    try {
      console.log(`${LOG_PREFIX} Connecting to Polygon WSS...`);
      this.provider = new ethers.providers.WebSocketProvider(this.wsRpcUrl);

      this.provider.on("error", (err: Error) => {
        console.error(`${LOG_PREFIX} Provider error:`, err.message);
        this._connected = false;
      });

      // Detect disconnect via the underlying WebSocket
      const ws = (this.provider as any)._websocket;
      if (ws) {
        ws.on("close", () => {
          console.warn(`${LOG_PREFIX} WebSocket closed`);
          this._connected = false;
          this.scheduleReconnect();
        });
        ws.on("error", (err: Error) => {
          console.error(`${LOG_PREFIX} WebSocket error:`, err.message);
        });
      }

      this.setupSubscriptions();
      this._connected = true;
      this.reconnectAttempts = 0;
      console.log(`${LOG_PREFIX} Connected — tracking ${this.trackedSet.size} wallets`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Connection failed:`, err instanceof Error ? err.message : String(err));
      this._connected = false;
      this.scheduleReconnect();
    }
  }

  private setupSubscriptions(): void {
    if (!this.provider) return;

    this.ctfContract = new ethers.Contract(CTF_EXCHANGE, ORDER_FILLED_ABI, this.provider);
    this.negRiskContract = new ethers.Contract(NEGRISK_EXCHANGE, ORDER_FILLED_ABI, this.provider);

    let subCount = 0;

    for (const [walletKey, score] of this.walletScores) {
      const wallet = walletKey.toLowerCase();

      // All wallets get maker + taker filters on both exchanges
      // (taker needed to catch market sells for timely exit)
      this.ctfContract.on(
        this.ctfContract.filters.OrderFilled(null, wallet),
        (...args: any[]) => this.handleEvent(args, "ctf", "maker"),
      );
      this.ctfContract.on(
        this.ctfContract.filters.OrderFilled(null, null, wallet),
        (...args: any[]) => this.handleEvent(args, "ctf", "taker"),
      );
      this.negRiskContract.on(
        this.negRiskContract.filters.OrderFilled(null, wallet),
        (...args: any[]) => this.handleEvent(args, "negrisk", "maker"),
      );
      this.negRiskContract.on(
        this.negRiskContract.filters.OrderFilled(null, null, wallet),
        (...args: any[]) => this.handleEvent(args, "negrisk", "taker"),
      );
      subCount += 4;
    }

    console.log(`${LOG_PREFIX} Subscribed: ${subCount} filters across ${this.trackedSet.size} wallets`);
  }

  private handleEvent(args: any[], exchange: "ctf" | "negrisk", role: "maker" | "taker"): void {
    try {
      // ethers v5 passes event args + the event object as the last arg
      const event = args[args.length - 1];
      const eventArgs = event.args || args;

      const maker: string = eventArgs.maker || eventArgs[1];
      const taker: string = eventArgs.taker || eventArgs[2];
      const makerAssetId: ethers.BigNumber = ethers.BigNumber.from(eventArgs.makerAssetId || eventArgs[3]);
      const takerAssetId: ethers.BigNumber = ethers.BigNumber.from(eventArgs.takerAssetId || eventArgs[4]);
      const makerAmountFilled: ethers.BigNumber = ethers.BigNumber.from(eventArgs.makerAmountFilled || eventArgs[5]);
      const takerAmountFilled: ethers.BigNumber = ethers.BigNumber.from(eventArgs.takerAmountFilled || eventArgs[6]);

      // Check if maker or taker is one of our tracked wallets
      const makerLower = maker.toLowerCase();
      const takerLower = taker.toLowerCase();
      let sourceWallet = "";

      if (this.trackedSet.has(makerLower)) {
        sourceWallet = makerLower;
      } else if (this.trackedSet.has(takerLower)) {
        sourceWallet = takerLower;
      } else {
        return; // Neither side is a tracked wallet
      }

      const isSourceMaker = sourceWallet === makerLower;

      // Determine BUY vs SELL:
      // BUY: source pays USDC (assetId == 0) → receives tokens
      // SELL: source pays tokens → receives USDC
      let type: "buy" | "sell";
      let tokenId: string;
      let usdcAmount: number;
      let shares: number;

      if (isSourceMaker) {
        if (makerAssetId.eq(USDC_ASSET_ID)) {
          type = "buy";
          tokenId = takerAssetId.toString();
          usdcAmount = parseFloat(ethers.utils.formatUnits(makerAmountFilled, 6));
          shares = parseFloat(ethers.utils.formatUnits(takerAmountFilled, 6));
        } else {
          type = "sell";
          tokenId = makerAssetId.toString();
          usdcAmount = parseFloat(ethers.utils.formatUnits(takerAmountFilled, 6));
          shares = parseFloat(ethers.utils.formatUnits(makerAmountFilled, 6));
        }
      } else {
        // Source is taker
        if (takerAssetId.eq(USDC_ASSET_ID)) {
          type = "buy";
          tokenId = makerAssetId.toString();
          usdcAmount = parseFloat(ethers.utils.formatUnits(takerAmountFilled, 6));
          shares = parseFloat(ethers.utils.formatUnits(makerAmountFilled, 6));
        } else {
          type = "sell";
          tokenId = takerAssetId.toString();
          usdcAmount = parseFloat(ethers.utils.formatUnits(makerAmountFilled, 6));
          shares = parseFloat(ethers.utils.formatUnits(takerAmountFilled, 6));
        }
      }

      const price = shares > 0 ? usdcAmount / shares : 0;

      const filled: OrderFilledEvent = {
        type,
        tokenId,
        usdcAmount,
        shares,
        price,
        exchange,
        sourceWallet,
        timestamp: Date.now(),
      };

      // 5-second debounce per tokenId+wallet (partial fills)
      const debounceKey = `${tokenId}:${sourceWallet}:${type}`;
      const existing = this.debounceMap.get(debounceKey);

      if (existing) {
        // Accumulate into existing debounced event
        clearTimeout(existing.timer);
        existing.event.usdcAmount += usdcAmount;
        existing.event.shares += shares;
        existing.event.price = existing.event.shares > 0
          ? existing.event.usdcAmount / existing.event.shares
          : 0;
        existing.timer = setTimeout(() => this.flushDebounced(debounceKey), DEBOUNCE_MS);
      } else {
        // Start new debounce
        const timer = setTimeout(() => this.flushDebounced(debounceKey), DEBOUNCE_MS);
        this.debounceMap.set(debounceKey, { event: { ...filled }, timer });
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Error parsing OrderFilled:`, err instanceof Error ? err.message : String(err));
    }
  }

  private flushDebounced(key: string): void {
    const entry = this.debounceMap.get(key);
    if (!entry) return;
    this.debounceMap.delete(key);

    const { event } = entry;
    const score = this.walletScores.get(event.sourceWallet);
    const tierLabel = score ? `T${score.tier}` : "T?";
    const nameLabel = score?.userName || event.sourceWallet.slice(0, 10);

    console.log(
      `${LOG_PREFIX} ${event.type.toUpperCase()} [${tierLabel} ${nameLabel}] ` +
      `token=${event.tokenId.slice(0, 16)}... $${event.usdcAmount.toFixed(2)} ` +
      `@ $${event.price.toFixed(4)} (${event.exchange})`,
    );

    this.emit(event.type, event);
  }

  private removeSubscriptions(): void {
    try {
      if (this.ctfContract) {
        this.ctfContract.removeAllListeners();
      }
      if (this.negRiskContract) {
        this.negRiskContract.removeAllListeners();
      }
    } catch { /* ignore */ }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`${LOG_PREFIX} Max reconnect attempts reached (${this.maxReconnectAttempts})`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts++;
    console.log(`${LOG_PREFIX} Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.cleanup();
      this.connect();
    }, delay);
  }

  private cleanup(): void {
    try {
      this.removeSubscriptions();
      this.ctfContract = null;
      this.negRiskContract = null;
      if (this.provider) {
        this.provider.removeAllListeners();
        const ws = (this.provider as any)._websocket;
        if (ws) {
          ws.removeAllListeners();
          try { ws.close(); } catch { /* ignore */ }
        }
        this.provider = null;
      }
    } catch { /* ignore */ }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Clear pending debounce timers
    for (const entry of this.debounceMap.values()) {
      clearTimeout(entry.timer);
    }
    this.debounceMap.clear();
    this.cleanup();
    this._connected = false;
    console.log(`${LOG_PREFIX} Destroyed`);
  }
}
