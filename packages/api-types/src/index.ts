// @nvhash/api-types — the shared freshness-envelope contract for the nvHASH App
// (app plan PR 1.2, ADR-001 Decision 4). Producer: services/api. Consumers:
// services/api and apps/web. Zero runtime dependencies.

export {
  envelope,
  freshness,
  type Envelope,
  type FreshnessInput,
  type FreshnessMeta,
  type FreshnessSource,
} from "./envelope.ts";
export {
  type BridgedSupplyRow,
  type EpochRow,
  type IncidentKind,
  type IncidentRow,
  type IncidentSeverity,
  type MarketDepthBand,
  type MarketSample,
  type MarketSummary,
  type PortfolioSummary,
  type ProgramMetrics,
  type RedemptionRow,
  type RedemptionStatus,
  type TransactionKind,
  type TransactionRow,
  type ValidatorRow,
  type ValidatorSetHealth,
  type ValidatorsPayload,
} from "./rows.ts";
export { HASH_EXPONENT, SHARE_EXPONENT, navHashPerShare } from "./amounts.ts";
