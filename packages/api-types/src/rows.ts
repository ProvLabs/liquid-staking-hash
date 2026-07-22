// Public program-endpoint row shapes (app plan PR 4.2 tranche 1, freezing the
// Learn-facing subset of the PR 3.1 contracts; master plan M3 header:
// contracts are defined and mocked first so the web lane builds without
// waiting). Producer: services/api. Consumers: services/api and apps/web.
// PR 3.1 implements the real derivations against exactly these shapes; a
// field change is a spec-level amendment (app-spec §9.4 revision note), never
// a silent edit. `/validators` rows are deliberately absent until PR 4.3.
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
 * One row of `GET /api/v1/epochs` (newest first): the per-epoch series behind
 * the Learn NAV step chart and the §8.5 history views. NAV and TVV are
 * decimal strings in base units (contract §5 stepwise NAV: values change only
 * at settlement, so one row per epoch IS the honest series).
 */
export interface EpochRow {
  epoch_index: number;
  /** ISO-8601 settlement time of this epoch. */
  ended_at: string;
  /** NAV in HASH per nvHASH at settlement, decimal string. */
  nav: string;
  /** Total vault value in base units at settlement, decimal string. */
  tvv: string;
  /** Net APR for the window ending at this epoch, bps, or null below window. */
  net_apr_bps: number | null;
}

/**
 * One row of `GET /api/v1/validators` (newest first): per-settlement
 * validator-set health, the §8.6 public aggregates (eligible-count trend and
 * churn). Frozen by PR 4.3; PR 3.1 derives it from the indexer's
 * `validator_epochs`/`validator_registry` (per-epoch eligibility flags,
 * set-once enrollment, forward-deterministic departure marks).
 */
export interface ValidatorSetEpochRow {
  epoch_index: number;
  /** ISO-8601 settlement time of this epoch. */
  ended_at: string;
  /** Validators meeting every eligibility threshold at this settlement. */
  eligible_count: number;
  /** Validators enrolled in the program at this settlement. */
  enrolled_count: number;
  /** Validators newly enrolled during this epoch. */
  joined: number;
  /** Validators marked departed during this epoch. */
  departed: number;
}
