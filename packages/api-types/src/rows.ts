// Public program-endpoint row shapes (app plan PR 4.2 tranche 1, freezing the
// Learn-facing subset of the PR 3.1 contracts; master plan M3 header:
// contracts are defined and mocked first so the web lane builds without
// waiting). Producer: services/api. Consumers: services/api and apps/web.
// PR 3.1 implements the real derivations against exactly these shapes; a
// field change is a spec-level amendment (app-spec §9.4 revision note), never
// a silent edit. PR 3.1 also freezes the `/validators` shapes below (master
// plan §2 places the endpoint in 3.1; PR 4.3's public page consumes them —
// confirmed 2026-07-22, docs/plans/2026-07-22-app-m3-query-api.md §7).
//
// Scale conventions follow the repo amount rules: token amounts and NAV are
// DECIMAL STRINGS (BigInt/Decimal domain, never JS floats); block heights and
// counts are JS safe integers; timestamps are ISO-8601 strings.

/**
 * Incident kinds, mirroring the indexer's Prisma enum
 * (`services/indexer/prisma/incidents.prisma`). Closed union: an unknown kind
 * from the wire is a shape error at the consumer boundary, not a guess.
 */
export type IncidentKind =
  | "contract_halted"
  | "vault_paused"
  | "slash_write_down"
  | "redemption_refund"
  | "jail_report"
  | "epoch_overdue"
  | "reconciler_divergence"
  | "indexer_lag";

/** Incident severity, aligned with console-spec §11.2 status semantics. */
export type IncidentSeverity = "info" | "warning" | "critical";

/**
 * One row of `GET /api/v1/incidents`. An incident is open while `closed_at`
 * is null; closure is computed (the condition clearing), never hand-entered
 * (app-spec §9.6).
 */
export interface IncidentRow {
  kind: IncidentKind;
  severity: IncidentSeverity;
  /** ISO-8601 time the deriving condition was first observed. */
  opened_at: string;
  /** ISO-8601 close time, or null while the incident is open. */
  closed_at: string | null;
  /** Block height the incident was derived at, or null if not height-bound. */
  height: number | null;
}

/**
 * `GET /api/v1/metrics` payload: program-level aggregates the chain does not
 * retain (app-spec §8.1 proof strip: participant count, program age). Every
 * field is nullable: null is the honest "not yet indexed" state the UI
 * renders as "n/a" (§12.1), exactly like the envelope's null heights.
 */
export interface ProgramMetrics {
  /** Distinct depositor addresses observed on chain, or null until indexed. */
  participant_count: number | null;
  /** ISO-8601 time of the first indexed program activity, or null. */
  program_started_at: string | null;
  /** Settled epochs observed, or null until indexed. */
  epoch_count: number | null;
}

/**
 * One row of `GET /api/v1/validators` (public set view, app-spec §8.6):
 * enrollment facts from `validator_registry` joined with the validator's
 * latest `validator_epochs` sample. Per-epoch fields are null before the
 * first sampled epoch — the honest "no sample yet" state, never a fabricated
 * zero. Caveat carried from the sampler (services/indexer/CLAUDE.md): uptime
 * capture is not wired yet, so `uptime_bps` may read 0 for a validator whose
 * uptime was simply not measured — read it alongside `eligible`.
 */
export interface ValidatorRow {
  /** Operator (valoper) address — public chain identifier. */
  valoper: string;
  /** Self-declared on-chain moniker (public), not off-chain identity. */
  moniker: string;
  /** Enrolled and not unregistered. */
  active: boolean;
  /** Epoch index the per-epoch fields reflect, or null before any sample. */
  epoch_index: number | null;
  /** Uptime in bps at that epoch, or null before any sample (see caveat). */
  uptime_bps: number | null;
  /** Eligibility at that epoch, or null before any sample. */
  eligible: boolean | null;
  /** Reasons the validator failed eligibility checks (empty when eligible). */
  failing_reasons: string[];
  /** Program delegation in nhash base units, decimal string, or null. */
  program_delegation: string | null;
  /** Commission currently due in nhash, decimal string, or null. */
  commission_due: string | null;
}

/**
 * Set-health aggregates over the `/api/v1/validators` rows (app-spec §8.6):
 * counts are over the CURRENT set (`active` rows) except `total`, which
 * counts every enrollment the program has seen (registry rows, including
 * unregistered). `in_arrears` counts active validators with a positive
 * `commission_due` in their latest sampled epoch.
 */
export interface ValidatorSetHealth {
  total: number;
  active: number;
  eligible: number;
  in_arrears: number;
}

/** `GET /api/v1/validators` payload: the set plus its health aggregates. */
export interface ValidatorsPayload {
  validators: ValidatorRow[];
  set_health: ValidatorSetHealth;
}

/**
 * One row of `GET /api/v1/epochs` (newest first): the per-epoch series behind
 * the Learn NAV step chart and the §8.5 history views. NAV and TVV are
 * decimal strings in base units (contract §5 stepwise NAV: values change only
 * at settlement, so one row per epoch IS the honest series).
 */
export interface EpochRow {
  epoch_index: number;
  /** ISO-8601 settlement time of this epoch. */
  ended_at: string;
  /**
   * NAV in HASH per nvHASH at settlement, decimal string — or null for an
   * epoch settled with zero shares (an empty vault has no NAV; null is the
   * honest state, never a fabricated "0"). Widened from `string` by PR 3.1,
   * recorded in the app-spec §9.4 revision note.
   */
  nav: string | null;
  /** Total vault value in base units at settlement, decimal string. */
  tvv: string;
  /** Net APR for the window ending at this epoch, bps, or null below window. */
  net_apr_bps: number | null;
}
