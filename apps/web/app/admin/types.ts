// View models for the §8.8 admin dashboard. Components under
// `app/components/admin/` are presentation-only over these — the feature-seam
// convention, so every honesty decision is made in the loader and unit-tested
// there rather than in JSX.
//
// THE SHAPE THAT MATTERS IS `PanelState<T>`. §8.8 panels degrade
// INDIVIDUALLY: one unavailable input must not blank the page, and must not let
// the others render as if nothing were missing (plan invariant 14). Making each
// panel a tagged union rather than `T | null` is what forces the component to
// handle "unavailable" and "below minimum" as distinct, captioned states — a
// nullable field would let a panel quietly render 0.

import type { FreshnessMeta } from "@nvhash/api-types";

/** Why a panel has no figures. Rendered as a REASON, never as a blank or a 0. */
export type PanelUnavailableReason =
  /** The indexed read failed or the admin assertion could not be minted. */
  | "read-failed"
  /** The read succeeded and the program has no history yet (cold start). */
  | "cold-start"
  /** Withheld by the minimum-group-size gate — we know, and are not saying. */
  | "below-minimum"
  /** The input is not indexed in this build (e.g. capture-signal cadence). */
  | "not-collected";

/**
 * A panel is EITHER data or a stated reason there is none. There is no third
 * arm, and deliberately no `T | null`: the type makes rendering a figure-less
 * panel without a caption impossible.
 */
export type PanelState<T> =
  | { readonly kind: "data"; readonly data: T }
  | { readonly kind: "unavailable"; readonly reason: PanelUnavailableReason };

export interface ProgramHealthVM {
  depositorCount: number | null;
  /** Ascending by epoch; formatted for display at the seam, not in JSX. */
  points: Array<{
    epochIndex: number;
    endedAt: string;
    tvvHash: string;
    netAprPercent: string | null;
    netDepositsHash: string;
    /** True when the epoch's net flow was negative — shape/word, not colour. */
    netOutflow: boolean;
  }>;
  truncated: boolean;
}

export interface RetentionCurveVM {
  cohortEpoch: number;
  cohortSize: number;
  belowMinimum: boolean;
  points: Array<{ horizon: number; retainedPercent: string | null }>;
}

export interface HolderCohortsVM {
  minCohortSize: number;
  adoption: Array<{ epochIndex: number; endedAt: string; newDepositors: number }>;
  adoptionTruncated: boolean;
  curves: RetentionCurveVM[];
  retentionTruncated: boolean;
  redemptionMix: { enqueued: number; expedited: number; matured: number; refunded: number };
  /** Withheld below the minimum holder count — its own panel state (§7.1 Q7). */
  concentration: PanelState<{
    top1Percent: string;
    top5Percent: string;
    top10Percent: string;
    holderCount: number;
  }>;
}

export interface ValidatorCohortsVM {
  enrolledNow: number;
  churnedTotal: number;
  timeline: Array<{
    epochIndex: number;
    endedAt: string;
    sampled: number;
    eligible: number;
    inArrears: number;
    tipPaying: number;
    purged: number;
  }>;
  truncated: boolean;
}

export interface UpkeepDistributionVM {
  sampleCount: number;
  medianLabel: string | null;
  p90Label: string | null;
  buckets: Array<{ label: string; count: number }>;
}

export interface UpkeepVM {
  epochLag: PanelState<UpkeepDistributionVM>;
  redemptionLatency: PanelState<UpkeepDistributionVM>;
  /** Always `not-collected` in this build — §8.8 names it, nothing indexes it. */
  captureCadence: PanelState<UpkeepDistributionVM>;
}

/** What an admin may do to an incident, decided in the loader (C4). */
export interface IncidentRowVM {
  id: number;
  kind: string;
  severity: "info" | "warning" | "critical";
  openedAt: string;
  closedAt: string | null;
  height: number | null;
  open: boolean;
  /** The live acknowledgment, whoever made it. */
  ack: { by: string; at: string; note: string | null; bySessionAdmin: boolean } | null;
  /**
   * C4's state × affordance, resolved here rather than in JSX:
   *   "acknowledge"    — open and unacknowledged
   *   "unacknowledge"  — open and acked BY THIS ADMIN
   *   "none"           — closed, or acked by ANOTHER admin (never re-offered as
   *                      if unacked), or acknowledgment state is UNKNOWN, or
   *                      the feed is degraded
   */
  affordance: "acknowledge" | "unacknowledge" | "none";
}

/**
 * The incident feed: its rows, plus whether acknowledgment state could be read
 * at all.
 *
 * `ackStateKnown` is a field rather than an assumption because the incidents
 * and their acks come from DIFFERENT stores — the feed from `indexed` through
 * the API, the acks from this tier's `app` schema (ADR-001 Decision 1) — so
 * either can fail without the other. When the ack store is unreadable, every
 * row's `ack` is null for want of data, and rendering that as "unacknowledged"
 * would state a fact from a missing input (plan invariant 14) and re-offer
 * "acknowledge" on an incident another admin has already handled (C4).
 */
export interface IncidentFeedVM {
  rows: IncidentRowVM[];
  /** False when the `app`-schema ack read failed: rows are real, ack state is
   * not known, and NO row carries an affordance. */
  ackStateKnown: boolean;
}

export interface FunnelStageVM {
  /** The stored stage key, for the i18n label lookup. */
  stage: string;
  total: number;
}

export interface FunnelVM {
  /** Days covered by the window read, for the panel's caption. */
  windowDays: number;
  stages: FunnelStageVM[];
  /**
   * The chain-derived terminal stage. EXACT, unlike the counters above — which
   * is precisely why it is a separate field: the panel must not present it in
   * the same series and imply uniform precision (plan invariant 15).
   */
  firstDeposits: number | null;
}

/** Everything the `/admin` route renders. Every panel independently degradable. */
export interface AdminViewData {
  address: string;
  programHealth: PanelState<ProgramHealthVM>;
  holderCohorts: PanelState<HolderCohortsVM>;
  validatorCohorts: PanelState<ValidatorCohortsVM>;
  upkeep: UpkeepVM;
  incidents: PanelState<IncidentFeedVM>;
  funnel: PanelState<FunnelVM>;
  /** Surfaced on the dashboard so a stale indexed read is visibly stale (C5). */
  freshness: FreshnessMeta | null;
}
