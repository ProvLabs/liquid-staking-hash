// Operator-view view models (`/validators/mine`, app-spec §8.6; assembled by
// mine.server.ts, consumed by the client components). Same split as
// portfolio/market: BigInt never crosses the wire — every amount is a display
// string prepared server-side. The one exception is the delegation chart's
// plottable points (render-time HASH conversion, app-spec §9.5), confined to
// that mapping.
//
// Two honesty rules shape these shapes:
//   1. Every figure is nullable and renders "n/a" when null, never 0.
//   2. The COMMISSION STANDING comes from the LIVE plane only. The indexed
//      payment history cannot see a prepaid credit at all — the contract's
//      `outstanding` event attribute saturates at 0 — so the credit is read
//      from `Validators {}` as `commission_paid − commission_accrued`.

import type { FreshnessMeta } from "@nvhash/api-types";

/**
 * Where a validator stands on program commission (verified against
 * `contracts/src/validators.rs` 2026-07-27). THREE states, not two:
 * - `in-arrears`: `commission_paid < commission_due` — past the one-epoch
 *   grace, which alone makes the validator ineligible.
 * - `current`: nothing owed and nothing prepaid.
 * - `prepaid`: `commission_paid > commission_accrued` — an overpayment, which
 *   is CUMULATIVE and carries forward indefinitely (unlike TIP, which is
 *   per-epoch and resets at every rollover).
 */
export type CommissionStanding = "in-arrears" | "current" | "prepaid";

/** An open jail report and the instant a purge becomes allowed (RC1 §9.8). */
export interface JailReportVM {
  reportedAt: string;
  purgeReadyAt: string;
}

/** Live standing for one owned validator (contract `Validators {}` + `Config {}`). */
export interface OperatorStandingVM {
  valoper: string;
  moniker: string | null;
  active: boolean;
  enrolledAt: string;
  eligible: boolean | null;
  jailed: boolean;
  tombstoned: boolean;
  /** Reasons the latest indexed sample failed eligibility (empty when eligible). */
  failingReasons: string[];
  uptimePercent: string | null;
  thresholdPercent: string | null;
  /** Signed headroom against the uptime threshold, in percentage points. */
  uptimeHeadroomPercent: string | null;
  /** Commission standing, or null when the live read failed (never guessed). */
  standing: CommissionStanding | null;
  commissionAccruedHash: string | null;
  commissionPaidHash: string | null;
  commissionDueHash: string | null;
  /** `paid − accrued` when positive — the prepaid credit, live plane only. */
  prepaidCreditHash: string | null;
  /** TIP credited for the CURRENT epoch; resets at the next rollover. */
  tipEpochHash: string | null;
  /** Concentration headroom for new delegation (0 when ineligible). */
  headroomHash: string | null;
  jailReport: JailReportVM | null;
}

/**
 * Net-benefit-after-fees (§8.6, §7 Q2). `estimatedEarningsHash` is an ESTIMATE
 * and is always labeled as one; the two paid terms are exact indexed facts.
 * Every term is shown separately so the derivation is inspectable, and the net
 * is null whenever the estimate is (a net computed from a missing term would be
 * a fabrication).
 */
export interface NetBenefitVM {
  /** Estimated staking-commission earnings on the program's delegation. */
  estimatedEarningsHash: string | null;
  /** Exact: lifetime program commission paid for this validator. */
  commissionPaidTotalHash: string;
  /** Exact: lifetime TIP paid for this validator. */
  tipPaidTotalHash: string;
  /** estimate − (commission + TIP), or null when the estimate is unavailable. */
  netBenefitHash: string | null;
  /** The validator's own x/staking commission rate, as a percent display. */
  commissionRatePercent: string | null;
  /** How many epoch steps the estimate could actually cover. */
  epochsCovered: number;
  /** True when the epoch page cap bounded the history the estimate saw. */
  truncated: boolean;
}

/** Step-after program-delegation history (one point per settled epoch). */
export interface DelegationHistoryVM {
  /** Plottable HASH values, oldest → newest (render-time conversion, §9.5). */
  points: number[];
  /** Epoch-index labels aligned with `points`. */
  epochLabels: string[];
  /** Table rows mirroring the chart (epoch, delegation) — never chart-only. */
  rows: string[][];
  truncated: boolean;
}

export interface OperatorEpochRowVM {
  epochIndex: number;
  observedAt: string;
  uptimePercent: string;
  eligible: boolean;
  failingReasons: string[];
  programDelegationHash: string;
  tipHash: string;
  commissionAccruedHash: string;
  commissionPaidHash: string;
  commissionDueHash: string;
  consoleHref: string | null;
}

export interface OperatorPaymentRowVM {
  time: string;
  /**
   * The payment's index within its transaction. Carried because ONE tx can
   * hold several payments — paying is permissionless, so an external batched
   * tx (two `pay_commission`s, or a commission plus a tip) is lawful — and
   * those rows share `txhash` AND `time` (block time is per-tx). `(txhash,
   * msgIndex)` is the identity the indexer and the API row already key on, so
   * it is what identifies a row here too.
   */
  msgIndex: number;
  paymentType: "commission" | "tip";
  amountHash: string;
  /** Null while the crediting epoch is still open — rendered "pending". */
  epochIndex: number | null;
  payer: string;
  /** True when the payer is not the validator's own operator account. */
  paidByOther: boolean;
  txhash: string;
  explorerHref: string | null;
}

/** One owned validator, fully composed. */
export interface OperatorValidatorVM {
  valoper: string;
  moniker: string | null;
  /** Currently enrolled. From the LIVE contract set whenever that read
   * succeeded — membership is a canonical-plane fact (app-spec §12.1). */
  active: boolean;
  /**
   * Lifetime totals from the indexed payment history — NULL when the indexed
   * plane has no row for this validator yet (it is written only at epoch
   * cranks, so a just-enrolled validator has none for up to a month). Null
   * means "not known yet", which is not the same claim as "0".
   */
  commissionPaidTotalHash: string | null;
  tipPaidTotalHash: string | null;
  paymentCount: number | null;
}

export interface OperatorViewData {
  address: string;
  /** Every validator this address operates (empty = operates none). */
  owned: OperatorValidatorVM[];
  /** Whether `selectedValoper` is STILL ENROLLED. Program actions apply only
   * to an enrolled validator, so this gates the action panel; history renders
   * either way. */
  selectedActive: boolean;
  /** The valoper the detail sections describe, or null when none is owned. */
  selectedValoper: string | null;
  standing: OperatorStandingVM | null;
  netBenefit: NetBenefitVM | null;
  delegationHistory: DelegationHistoryVM | null;
  epochs: OperatorEpochRowVM[];
  epochsTruncated: boolean;
  payments: OperatorPaymentRowVM[];
  paymentsHasMore: boolean;
  /** False when the assertion key is unset or the API is unreachable. */
  personalReadsAvailable: boolean;
  /** False when the live contract reads failed — standing renders unavailable. */
  liveAvailable: boolean;
  freshness: FreshnessMeta | null;
}
