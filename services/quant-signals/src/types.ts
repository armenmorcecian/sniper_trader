// Re-export all shared types from quant-core
export type {
  PriceBar,
  Regime,
  RegimeResult,
  SectorMomentum,
  RebalanceAction,
  PositionSummary,
  SignalMeta,
  RankingsSignal,
  RebalanceSignal,
  RetryConfig,
} from "quant-core";

// ─── Alpaca Client Config (service-specific) ────────────────────────────────

export interface AlpacaDataConfig {
  apiKeyId: string;
  apiSecretKey: string;
  tradingBaseUrl: string;
  dataBaseUrl: string;
}
