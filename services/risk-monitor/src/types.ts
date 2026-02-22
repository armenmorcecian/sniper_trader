// ─── Types for risk-monitor service ──────────────────────────────────────────

export interface AlpacaTradeUpdate {
  event: string;
  order: {
    id: string;
    client_order_id: string;
    symbol: string;
    side: "buy" | "sell";
    type: string;
    qty: string;
    filled_qty: string;
    filled_avg_price: string;
    status: string;
  };
  timestamp: string;
  position_qty?: string;
  price?: string;
  qty?: string;
}

export interface AlpacaMinuteBar {
  T: string;   // message type ("b" for bar)
  S: string;   // symbol
  o: number;   // open
  h: number;   // high
  l: number;   // low
  c: number;   // close
  v: number;   // volume
  t: string;   // timestamp
  n: number;   // number of trades
  vw: number;  // vwap
}

export interface TrackedPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface HealthStatus {
  lastPing: string;
  tradingWsConnected: boolean;
  dataWsConnected: boolean;
  positionsTracked: number;
  activeAlerts: number;
  uptimeSeconds: number;
}

export interface RiskCheckResult {
  alerts: Array<{
    alertType: "stop_loss" | "daily_loss" | "drawdown";
    severity: "warning" | "critical" | "block";
    symbol?: string;
    message: string;
    details: Record<string, unknown>;
  }>;
  resolutions: Array<{
    alertType: string;
    symbol?: string;
    reason: string;
  }>;
}
