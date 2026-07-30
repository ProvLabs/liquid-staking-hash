// Public program-endpoint row shapes. Producer: services/api. Consumers:
// services/api and apps/web.
//
// These shapes are FROZEN: a field change is a spec-level amendment
// (app-spec §9.4 revision note), never a silent edit, because both tiers
// compile against this one declaration.
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
 * `GET /api/v1/redemptions/stats` payload (app-spec §8.4 exit surface,
 * §9.5.3, §14.12): the program-wide "typical time-to-payout" statistic —
 * median / p90 of `(expedited_at ?? matured_at) − enqueued_at` over the
 * recent terminal-request cohort (matured or expedited). Public + aggregate,
 * never keyed by owner (no PII).
 *
 * Honesty gates carried IN the payload so the web tier renders them without
 * re-deciding the rule:
 * - `median_seconds`/`p90_seconds` are null below the **≥ 10-terminal
 *   threshold** (§14.12) OR during epoch cold-start — the flow then shows
 *   the 60-day guarantee alone (a small-sample "typical" would be a lie).
 * - `cold_start` is true before the first completed epoch (time-to-payout is
 *   an epoch-step metric, §14.12) — an explicit "first epoch not yet
 *   settled" state, never a zero.
 * - the physical **21–60-day band** bounds ride as data (`band_floor_seconds`
 *   / `band_ceiling_seconds`), so copy never implies precision outside what
 *   the mechanism can deliver (§9.5.3).
 */
export interface PayoutStats {
  /** Terminal (matured/expedited) requests in the recent window. */
  sample_count: number;
  /** Median seconds enqueue→payout, or null below threshold / cold-start. */
  median_seconds: number | null;
  /** p90 seconds enqueue→payout, or null below threshold / cold-start. */
  p90_seconds: number | null;
  /** Unbonding floor of the physical band (~21 days), in seconds. */
  band_floor_seconds: number;
  /** Guarantee ceiling of the physical band (60 days), in seconds. */
  band_ceiling_seconds: number;
  /** True before the first completed epoch — stats gated regardless of count. */
  cold_start: boolean;
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
 * Transaction kinds, mirroring the indexer's Prisma enum
 * (`services/indexer/prisma/transactions.prisma`). Closed union.
 */
export type TransactionKind =
  | "swap_in"
  | "swap_out_request"
  | "redemption_payout"
  | "redemption_refund"
  | "transfer_in"
  | "transfer_out";

/** Redemption lifecycle states (`redemption_requests.prisma`). Closed union. */
export type RedemptionStatus = "enqueued" | "expedited" | "matured" | "refunded";

/**
 * One row of `GET /api/v1/transactions` (address-scoped, newest first): a
 * per-event fact from the indexed history — amounts as base-unit decimal
 * strings, with the NAV marker current at the event's height (app-spec §8.2:
 * "amounts, NAV at the time, txhash"). The CSV export serves exactly these
 * rows (§14.11: a statement of fact, not a computed tax position).
 */
export interface TransactionRow {
  txhash: string;
  msg_index: number;
  kind: TransactionKind;
  /** nvHASH base units, decimal string. */
  shares: string;
  /** nhash, decimal string (0 where the event carries no nhash leg). */
  nhash: string;
  /** NAV marker at the event's height, nhash per whole nvHASH, decimal string. */
  nav_at_height: string;
  height: number;
  /** ISO-8601 block time. */
  block_time: string;
}

/**
 * One active redemption of `GET /api/v1/portfolio` (app-spec §8.2): the
 * escrowed `SwapOut` request with its lifecycle timestamps. The chain's
 * projected-payout `estimates` series is deliberately ABSENT: no indexer
 * worker writes it yet, and freezing a shape with no producer would be
 * invention — adding it is a §9.4 revision when its producer lands.
 */
export interface RedemptionRow {
  request_id: string;
  /** Shares escrowed by this request, nvHASH base units, decimal string. */
  shares: string;
  status: RedemptionStatus;
  enqueued_at: string;
  expedited_at: string | null;
  matured_at: string | null;
  refunded_at: string | null;
  /** Height/txhash of the last lifecycle event (verify-link anchor). */
  last_height: number;
  last_txhash: string;
}

/**
 * `GET /api/v1/portfolio` (address-scoped, app-spec §8.2): the indexed facts
 * for one address. Deliberately NO current-balance field ([R2],
 * app-spec §9.4): the nvHASH balance is an
 * on-chain LIVE read owned by the web tier (§8.2, §5.1) — indexed
 * transactions cannot see bank transfers, so a transactions-sum "balance"
 * here would silently misstate holdings. Derived metrics (cost basis,
 * effective yield) are the service, not this endpoint.
 */
export interface PortfolioSummary {
  /** The authorized address the facts belong to (echo of the query). */
  address: string;
  /** ISO-8601 time of the address's first indexed event, or null. */
  first_activity_at: string | null;
  /** Indexed events for this address (the /transactions row count). */
  transaction_count: number;
  /** Total shares escrowed in active (enqueued/expedited) redemptions. */
  escrowed_shares: string;
  /** Active redemptions, newest first. */
  active_redemptions: RedemptionRow[];
}

/**
 * One epoch step of the personal effective-yield series. The
 * program figure `net_apr_bps` rides alongside the personal APR so the UI can
 * chart the depositor against the program for the same epoch. Both are signed
 * bps and nullable: null is the honest "not attributable to this position"
 * state (cold-start epoch, zero-share NAV, or a step the position did not span).
 */
export interface EffectiveYieldPoint {
  epoch_index: number;
  /** ISO-8601 settlement time of this epoch. */
  ended_at: string;
  /** Personal APR over the step, bps, signed; null when not attributable. */
  personal_apr_bps: number | null;
  /** Program net APR for the same epoch, bps; null when absent. */
  net_apr_bps: number | null;
}

/**
 * One step-after sample of the position's value: value in nhash of
 * the held+escrow shares priced at the NAV current at `time`. Points exist only
 * once the position is priceable (a deposit exists and a NAV-bearing epoch has
 * settled); before that, a value cannot be honestly stated.
 */
export interface AccrualPoint {
  /** ISO-8601 time of the epoch step or event this point samples. */
  time: string;
  height: number;
  /** Position value in nhash base units, decimal string. */
  value_nhash: string;
}

/**
 * One event annotation on the accrual series: the deposit,
 * request, payout, refund, or transfer that moved the position, echoing the
 * event's own amounts (refund `nhash` is "0" upstream).
 */
export interface AccrualMarker {
  /** ISO-8601 event time. */
  time: string;
  txhash: string;
  kind: TransactionKind;
  /** Shares moved by the event, nvHASH base units, decimal string. */
  shares: string;
  /** nhash leg of the event, decimal string ("0" where none). */
  nhash: string;
}

/**
 * Fidelity of the reconstructed cost-basis history:
 * `complete`: a clean deposit/redemption record;
 * `has_transfers`: transfers were observed (they carry no basis, so the
 *   reconstructed basis is a lower-fidelity estimate);
 * `inconsistent`: an event would drive a pool negative or hit an empty escrow,
 *   so no basis/gain figure can be trusted (those fields serve null).
 */
export type PortfolioHistoryState = "complete" | "has_transfers" | "inconsistent";

/**
 * `GET /api/v1/portfolio/metrics` (address-scoped): the derived
 * cost-basis, realized-gain, effective-yield, and accrual figures for one
 * address, reconstructed from the indexed event history. All amounts are
 * base-unit decimal strings; basis/gain/APR fields serve null on an
 * `inconsistent` history (never a fabricated figure). Balances are the indexed
 * held/escrow share pools (not a live bank read, which stays a web-tier read,
 * [R2]).
 */
export interface PortfolioMetrics {
  /** The authorized address the figures belong to (echo of the query). */
  address: string;
  history_state: PortfolioHistoryState;
  /** Held-pool shares (excludes escrow), nvHASH base units, decimal string. */
  indexed_share_balance: string;
  /** Escrowed shares in active redemptions, base units, decimal string. */
  escrowed_share_balance: string;
  /** Held-pool average-cost basis in nhash, decimal string; null if inconsistent. */
  cost_basis_nhash: string | null;
  /** Escrow-pool average-cost basis in nhash, decimal string; null if inconsistent. */
  escrowed_basis_nhash: string | null;
  /** Realized gain in nhash, signed decimal string; null if inconsistent. */
  realized_gain_nhash: string | null;
  /** Effective APR since first deposit, bps; null until a step completes. */
  effective_apr_bps: number | null;
  /** Per-epoch personal-vs-program yield, oldest first from the first deposit; most recent MAX_YIELD_POINTS kept. */
  yield_by_epoch: EffectiveYieldPoint[];
  /** True when the yield cap trimmed earlier epochs; the most recent points are kept. */
  yield_truncated: boolean;
  /** Step-after value series, most recent MAX_ACCRUAL_POINTS kept. */
  accrual: AccrualPoint[];
  /** True when the accrual cap trimmed earlier history; the most recent points are kept. */
  accrual_truncated: boolean;
  /** Event annotations, most recent MARKER_CAP kept. */
  accrual_markers: AccrualMarker[];
  /** True when the marker cap trimmed older events. */
  markers_truncated: boolean;
}

/**
 * One depth-at-slippage band of a sampled DEX pool (app-spec §5.3/§8.5).
 * PROVISIONAL SHAPE: the market sampler is parked pending the
 * §14.3 pool facts, so no producer pins these fields yet — when a sampler lands
 * it writes `market_samples.depthBands` in exactly this shape, and any
 * adjustment it needs is an app-spec §9.4 revision, never a silent edit.
 */
export interface MarketDepthBand {
  /** Trade direction the band measures. */
  side: "buy" | "sell";
  /** Slippage tolerance the depth is quoted at, bps. */
  slippage_bps: number;
  /** Executable size within that slippage, nvHASH base units, decimal string. */
  amount: string;
}

/**
 * The latest DEX pool observation (`GET /api/v1/market`). Market data has no
 * chain-canonical plane (app-spec §12.1), so its labeling is load-bearing:
 * `venue`, `pool`, and `sampled_at` ride IN the payload — a market figure is
 * never shown without where and when it was sampled.
 */
export interface MarketSample {
  /** Venue identifier (e.g. the DEX name); public configuration, not PII. */
  venue: string;
  /** Pool contract address on the sampled chain (public). */
  pool: string;
  /** Pool price in nhash per whole nvHASH, decimal string (base-unit price). */
  price: string;
  /**
   * `(market_price − NAV) / NAV` in bps, signed (negative = discount),
   * truncated toward zero — computed against the NAV current AT THIS
   * SAMPLE'S TIME (the last epoch settled at or before `sampled_at`;
   * app-spec §9.5(4)). Null when no epoch had settled by then (no NAV means
   * no honest premium — never a fabricated 0).
   */
  premium_discount_bps: number | null;
  /** Depth-at-slippage bands as sampled (provisional shape, see above). */
  depth_bands: MarketDepthBand[];
  /** ISO-8601 sample time. */
  sampled_at: string;
}

/** Latest bridged-supply reading for one remote chain (`bridge_supply_samples`). */
export interface BridgedSupplyRow {
  /** Remote chain identifier. */
  chain: string;
  /** nvHASH supply on that chain, base units, decimal string. */
  supply: string;
  /** ISO-8601 sample time. */
  sampled_at: string;
}

/**
 * `GET /api/v1/market` payload (app-spec §8.5). In v1 the DEX plane ships as
 * a labeled "coming soon" shell (§13 decision 4): with the sampler parked,
 * `sample` is null and `bridged_supply` is empty — the honest empty state,
 * with the shape stable ahead of the data. The LOCAL side of the supply
 * split is deliberately absent: local supply is a live chain read (the
 * canonical plane, §5.1) owned by the web tier, not derivable from indexed
 * samples — serving it here would fabricate a plane this API does not have.
 */
export interface MarketSummary {
  /** Latest pool observation, or null while no market data exists. */
  sample: MarketSample | null;
  /** Latest reading per remote chain (empty until the bridge is live). */
  bridged_supply: BridgedSupplyRow[];
}

// --- internal alert-facts surface (`internal:notifier` scope) ---------
//
// The notifier (an apps/web worker, ADR-001 Decision 3) evaluates alert rules
// against indexed facts it cannot read directly — its `app_writer` credential
// has no `indexed` grants. These three shapes are the cross-address evaluation
// reads served under the `internal:notifier` scope (app-spec §9.4): identity
// and ordinals only, no amounts on the redemption/incident facts (the notifier
// stores no amounts), so the surface stays minimal. Producer:
// services/api. Consumer: the apps/web notifier. A field change here is an
// app-spec §9.4 revision, never a silent edit.

/**
 * One row of `GET /api/v1/internal/alert-facts/redemptions`: a
 * redemption whose lifecycle advanced past the notifier's height cursor. The
 * notifier keys `redemption_update` alerts off the terminal timestamps
 * (matured/expedited/refunded) and the `owner` account (both public chain
 * data). Deliberately NO `shares`/amount field — the notification payload
 * carries identifiers only, and the linked surface shows the live
 * amount with a freshness label (§12.1).
 */
export interface AlertRedemptionFact {
  request_id: string;
  /** Owning bech32 account (public chain data) — the alert's target address. */
  owner: string;
  status: RedemptionStatus;
  enqueued_at: string;
  expedited_at: string | null;
  matured_at: string | null;
  refunded_at: string | null;
  /** Height of the last lifecycle event — the notifier's redemption cursor. */
  last_height: number;
}

/**
 * One row of `GET /api/v1/internal/alert-facts/incidents`: a computed
 * incident, projected to the identity the notifier needs — `id` (its id
 * cursor) and `(kind, dedupe_key)` (the replay-stable notification identity,
 * NOT the autoincrement id). NO payload passthrough: the notifier
 * needs identity, not detail. `opened_at`/`opened_height` locate
 * the event; there is no `closed_at` (v1 sends no close notifications, §7 Q3).
 */
export interface AlertIncidentFact {
  /** Autoincrement incident id — the notifier's incidents cursor only. */
  id: number;
  kind: IncidentKind;
  severity: IncidentSeverity;
  /** The indexer's own dedupe key; `(kind, dedupe_key)` is replay-stable. */
  dedupe_key: string;
  opened_at: string;
  opened_height: number | null;
}

/**
 * One row of `GET /api/v1/internal/alert-facts/arrears`: a program
 * validator with commission still due in the latest sampled epoch, joined to
 * its operator account. Only active registry rows (unregistered validators
 * excluded). The `operator` account is the `operator_arrears` alert's target
 * address. `commission_due` rides as a decimal string per the boundary
 * amount convention, though the stored notification carries no amount.
 */
export interface AlertArrearsFact {
  valoper: string;
  /** Operator bech32 account (public) — the alert's target address. */
  operator: string;
  epoch_index: number;
  /** Commission due in nhash base units, decimal string. */
  commission_due: string;
}

// --- operator surface (address-scoped) --------------------------------
//
// The `/validators/mine` view's three reads (app-spec §8.6, §9.4). They are the
// PERSONAL counterpart of the public `/validators` projection, which
// deliberately excludes operator economics: these carry the commission/TIP
// figures and the per-payment history a validator's operator needs for its own
// standing and tax analysis. The address→valoper mapping is resolved
// server-side from `validator_registry.operator`, so an operator only ever sees
// the validators it operates; an address that operates none gets honest-empty
// answers, never an error that would reveal who operates what.
//
// A field change here is an app-spec §9.4 revision, never a silent edit.

/** Commission or TIP — mirrors the indexer's `OperatorPaymentType` enum. */
export type OperatorPaymentType = "commission" | "tip";

/**
 * One owned validator in `GET /api/v1/operator/summary`: registry enrollment,
 * the latest sampled epoch's economics, and lifetime payment totals.
 *
 * Per-epoch fields are null before the first sample — the honest "no sample
 * yet" state, never a fabricated zero (the `/validators` precedent). Lifetime
 * totals come from `operator_payments` and are always present ("0" is an
 * honest sum over zero rows, not a cold-start artifact).
 *
 * NOTE (§12.1): every figure here is INDEXED. The commission standing an
 * operator acts on — including a prepaid credit, which the chain reports as
 * `commission_paid − commission_accrued` and the payment events cannot show at
 * all (`outstanding` saturates at 0) — is a LIVE read owned by the web tier.
 * This payload is history; it is not the current obligation.
 */
export interface OperatorValidatorRow {
  valoper: string;
  /** Self-declared on-chain moniker (public), not off-chain identity. */
  moniker: string;
  /** Operator account this row was resolved through (echo of the query). */
  operator: string;
  /** Enrolled and not unregistered. */
  active: boolean;
  /** ISO-8601 enrollment time. */
  enrolled_at: string;
  /** ISO-8601 unregistration time, or null while enrolled. */
  unregistered_at: string | null;
  /** Epoch index the per-epoch fields reflect, or null before any sample. */
  epoch_index: number | null;
  /** Uptime in bps at that epoch, or null before any sample. */
  uptime_bps: number | null;
  /** Eligibility at that epoch, or null before any sample. */
  eligible: boolean | null;
  /** Reasons the validator failed eligibility checks (empty when eligible). */
  failing_reasons: string[];
  /** Program delegation in nhash, decimal string, or null before any sample. */
  program_delegation: string | null;
  /** TIP credited in that epoch, nhash decimal string, or null. */
  tip: string | null;
  /** Cumulative commission accrued, nhash decimal string, or null. */
  commission_accrued: string | null;
  /** Cumulative commission paid, nhash decimal string, or null. */
  commission_paid: string | null;
  /** Commission due at the grace boundary, nhash decimal string, or null. */
  commission_due: string | null;
  /** Lifetime commission paid via PayCommission, nhash decimal string. */
  commission_paid_total: string;
  /** Lifetime TIP paid via PayTip, nhash decimal string. */
  tip_paid_total: string;
  /** Indexed payment rows for this validator (both types). */
  payment_count: number;
}

/** `GET /api/v1/operator/summary` payload. */
export interface OperatorSummary {
  /** The authorized address the rows belong to (echo of the query). */
  address: string;
  /** Validators this address operates; empty when it operates none. */
  validators: OperatorValidatorRow[];
}

/**
 * One row of `GET /api/v1/operator/epochs` (newest first): a validator's
 * per-epoch economics from `validator_epochs` — the history the console cannot
 * show (app-spec §8.6). Unlike the summary's latest-epoch fields these are
 * never null: a row exists only because the sampler recorded it.
 */
export interface OperatorEpochRow {
  valoper: string;
  epoch_index: number;
  uptime_bps: number;
  eligible: boolean;
  failing_reasons: string[];
  /** All amounts nhash base units, decimal strings. */
  tip: string;
  commission_accrued: string;
  commission_paid: string;
  commission_due: string;
  program_delegation: string;
  height: number;
  /** ISO-8601 time the sampler observed this epoch. */
  observed_at: string;
}

/**
 * One row of `GET /api/v1/operator/payments` (newest first; the CSV export
 * serves the complete history ascending). A per-payment fact from
 * `operator_payments` — the §14.11 operator export's grain.
 *
 * `payer` is the paying account: payment is permissionless ("anyone, nhash
 * attached"), so the payer is frequently NOT the operator, and an operator
 * auditing who paid on its behalf needs it (public tx data; decided
 * 2026-07-27). It is deliberately absent from the CSV, whose column set §14.11
 * pins.
 *
 * `epoch_index` is DERIVED at read time, not stored: the crediting epoch closes
 * at the next `run_epoch` crank, which the indexer cannot know at the payment's
 * height (app-spec §9.1). Null means the crediting epoch has not closed yet, or
 * no epoch snapshot covers the height — never a guess.
 */
export interface OperatorPaymentRow {
  txhash: string;
  msg_index: number;
  valoper: string;
  /** Paying bech32 account (public tx data) — often not the operator. */
  payer: string;
  payment_type: OperatorPaymentType;
  /** nhash attached to the payment, base units, decimal string. */
  amount: string;
  /** Epoch the payment credited, or null while that epoch is still open. */
  epoch_index: number | null;
  height: number;
  /** ISO-8601 block time of the payment. */
  occurred_at: string;
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
   * honest state, never a fabricated "0"). Widened from `string`,
   * recorded in the app-spec §9.4 revision note.
   */
  nav: string | null;
  /** Total vault value in base units at settlement, decimal string. */
  tvv: string;
  /** Net APR for the window ending at this epoch, bps, or null below window. */
  net_apr_bps: number | null;
}


// --- governance (app-spec §8.7/§9.1/§9.4) --------
//
// The durable MIRROR's shapes, not the live chain's. `services/api` has no chain
// client by design (ADR-001 Decision 1), so these carry what the indexer stored
// and the web tier owns the live plane at 7.2 — the `/market` and `/portfolio`
// division. Consequences visible in the field set below:
//
//   * every figure is AS OF `observed_height`, not "now";
//   * `pruned_at_height` says the chain no longer holds the proposal, so no
//     verify affordance is offered for it (§12.2 revision: a verify link must
//     never be dead, and there is nothing on chain left to link to);
//   * `decision_policy` is the rule snapshotted AT SUBMIT, because the live
//     policy can change and a historical tally-vs-threshold would otherwise be
//     unrenderable.
//
// Weights are DECIMAL STRINGS with no ceiling: they are sums of member weights,
// not token amounts, so `Uint128` would be an invented bound and a JS number
// would corrupt them past 2^53. Passage is decided by the shared
// `meetsThreshold` (tally.ts), never re-derived per consumer.

/** Proposal status. Closed union mirroring x/group's proto. `aborted` is in it
 * because the module defines it, NOT because the devnet corpus reaches it — the
 * 2026-07-29 drill could not produce an abort on that build, which is recorded in
 * the fixture manifest. `unspecified` is the honest landing place for a status a
 * later chain upgrade adds. */
export type GovProposalStatus =
  | "submitted"
  | "accepted"
  | "rejected"
  | "aborted"
  | "withdrawn"
  | "unspecified";

/** Execution outcome, INDEPENDENT of `status`. `accepted` + `failure` — "it
 * passed and then the messages failed" — is a real pair that `status` alone
 * cannot express, and it is what an administrator needs to see. */
export type GovExecutorResult = "not_run" | "success" | "failure" | "unspecified";

export type GovVoteOption = "yes" | "no" | "abstain" | "no_with_veto" | "unspecified";

/** The four tally counts, decimal strings (unbounded member weights). */
export interface GovTally {
  yes: string;
  no: string;
  abstain: string;
  no_with_veto: string;
}

/** The decision rule in force at submit. `unknown` preserves the raw payload so a
 * surface can say what it does not understand instead of summarizing it. */
export type GovDecisionPolicy =
  | { kind: "threshold"; threshold: string; voting_period: string; min_execution_period: string }
  | { kind: "percentage"; percentage: string; voting_period: string; min_execution_period: string }
  | { kind: "unknown"; type_url: string };

/**
 * One row of `GET /api/v1/governance/proposals` (newest first).
 *
 * `height`/`txhash` are SUBMIT provenance and are NULLABLE: a proposal first seen
 * by the indexer's height-pinned sweep — one submitted before the stream's start
 * height — has no submit transaction to point at, and null is honest where a
 * fabricated height is not. `observed_height` is the separate AS-OF stamp of the
 * status and tally.
 */
export interface GovProposalRow {
  proposal_id: string;
  group_policy_address: string;
  group_id: string;
  /** x/group permits several proposers; one scalar would be a lie for two. */
  proposers: string[];
  status: GovProposalStatus;
  executor_result: GovExecutorResult;
  /** Author-supplied title/summary (public chain text). Empty string when unset —
   * these are the only human-readable label a proposal has, and for a pruned
   * proposal that label exists nowhere else. */
  title: string;
  summary: string;
  /** The chain's free-form proposal metadata string, or null. */
  metadata: string | null;
  tally: GovTally;
  decision_policy: GovDecisionPolicy;
  /** ISO-8601. */
  submit_time: string;
  /** ISO-8601 — the §8.7 countdown, and the only thing that explains a status
   * change that arrived with no transaction. */
  voting_period_end: string;
  /** x/group ABORTs on a group/policy change; without these a UI can assert an
   * abort but not explain it. */
  group_version: string;
  group_policy_version: string;
  /** AS-OF of `status` and `tally` (§12.1 freshness). */
  observed_height: number;
  /** ISO-8601 AS-OF. */
  observed_at: string;
  /** Submit provenance, null when the proposal was never seen in a transaction. */
  height: number | null;
  txhash: string | null;
  /** Set when the chain no longer holds this proposal. The row survives; the
   * surfaces say so rather than offer a verify path that resolves to nothing. */
  pruned_at_height: number | null;
  /** True when `messages` was trimmed to its wire bound. An over-limit proposal is
   * served FLAGGED, never silently shortened — quietly truncating the payload
   * would misstate what is being voted on. */
  messages_truncated: boolean;
  /** True when `proposers` was trimmed to its wire bound. Same rule, and it needs
   * stating separately because WHO proposed something is identity data: a trimmed
   * list that carried no flag would be indistinguishable from the complete one, so
   * a consumer could not tell a 32-proposer proposal from a 40-proposer one. */
  proposers_truncated: boolean;
  /** The proposal's messages, VERBATIM and undecoded. 7.2 decodes them against a
   * closed typed union with a tagged `unknown`; no summary is invented here. */
  messages: unknown[];
}

/** One row of a proposal's vote list.
 *
 * `weight` is nullable because x/group's `Vote` payload carries NO weight field:
 * it has to be resolved from the member set at the vote height, and null means
 * "not recoverable", never 0 — a fabricated weight would misstate how a proposal
 * passed. `height`/`txhash` are nullable for the same reason as on the proposal,
 * and it is the COMMON case here: the module deletes votes at the
 * voting-period-end tally, so a closed proposal's votes survive only in the
 * mirror. */
export interface GovVoteRow {
  proposal_id: string;
  voter: string;
  option: GovVoteOption;
  metadata: string | null;
  weight: string | null;
  /** ISO-8601. */
  submit_time: string;
  height: number | null;
  txhash: string | null;
}

/**
 * `GET /api/v1/governance/proposal?id=` — a query param, not a path segment:
 * `services/api`'s `findRoute` is an exact string match with no path parameters
 * (M7 overview finding F3). The web tier is React Router and may use
 * `/governance/:proposalId` for its own URL.
 */
export interface GovProposalDetail {
  proposal: GovProposalRow;
  votes: GovVoteRow[];
  /** True when the vote list was trimmed to its wire bound. NOT page-controlled
   * by the caller — the detail endpoint returns the whole vote set, whose size is
   * a property of the group — so the server trims and flags rather than assuming
   * groups are small. */
  votes_truncated: boolean;
}

/** The list payload. `indexed_from_height` is the load-bearing field: proposals
 * pruned before the indexer existed are unrecoverable, so the page must never
 * imply a completeness it lacks (§12.1). */
export interface GovProposalsPayload {
  proposals: GovProposalRow[];
  /** First height the governance stream ingested. */
  indexed_from_height: number | null;
}

/**
 * One row of `GET /api/v1/governance/policies` — the HISTORICAL policy set as
 * observed in the mirror, plus each policy's last-seen height. Historical, not
 * live: the API is DB-only (D12/D16), and the live policy set with its current
 * membership is a web-tier read.
 */
export interface GovPolicyRow {
  address: string;
  group_id: string;
  /** Proposals mirrored against this policy. */
  proposal_count: number;
  /** Highest `observed_height` across this policy's proposals. */
  last_seen_height: number;
  /** The most recently observed decision rule for this policy — a snapshot off
   * its newest proposal, never a live read. */
  decision_policy: GovDecisionPolicy | null;
}
