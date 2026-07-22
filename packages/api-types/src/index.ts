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
  type EpochRow,
  type IncidentKind,
  type IncidentRow,
  type IncidentSeverity,
  type ProgramMetrics,
  type ValidatorRow,
  type ValidatorSetHealth,
  type ValidatorsPayload,
} from "./rows.ts";
export { HASH_EXPONENT, SHARE_EXPONENT, navHashPerShare } from "./amounts.ts";
