// Admin-dashboard data assembly (`/admin`; app-spec §8.8, §12.1). The
// composition seam: every honesty decision — which panel degrades, with what
// reason, and what the funnel is allowed to imply — is made HERE, so
// `test/admin-data.test.ts` can hold the matrix and the components stay
// presentation-only.
//
// THREE PROPERTIES THIS FILE IS RESPONSIBLE FOR.
//
// 1. PANELS DEGRADE INDIVIDUALLY (plan invariant 14). Each §8.8 panel is its
//    own endpoint and its own `PanelState`, so an unavailable input renders one
//    captioned "n/a" rather than blanking the page — and never renders as 0,
//    which would read as a measured result.
//
// 2. THE LOADER NEVER THROWS. Every read is caught to its own null; a dashboard
//    that 500s because one aggregate failed is worse than one that says which
//    aggregate failed.
//
// 3. THE FUNNEL IS ASSEMBLED WITHOUT CROSSING THE API BOUNDARY. Counters live
//    in the `app` schema, which `api_reader` has no grants on (ADR-001
//    Decision 1), so they are read from this tier's own model store. That is
//    not a shortcut — there is no path by which `services/api` could serve them.
//
// The `admin:` assertion is minted per request through `adminApiHeaders`, which
// performs the FRESH on-chain membership read (invariant 2). A degraded read
// mints nothing and this seam is never reached.

import type { FetchLike } from "@nvhash/chain-client";
import { FUNNEL_WINDOW_DAYS, type FreshnessMeta } from "@nvhash/api-types";

import {
  adminHolderCohortsEnvelopeSchema,
  adminIncidentsEnvelopeSchema,
  adminProgramHealthEnvelopeSchema,
  adminUpkeepEnvelopeSchema,
  adminValidatorCohortsEnvelopeSchema,
  fetchApiJson,
} from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { bpsToPercent, formatBaseAmount, HASH_EXPONENT } from "~/learn/amounts";
import { formatDuration } from "~/learn/duration";
import { getFunnelCounterStore } from "~/lib/models/funnel-counters.server";
import { getIncidentAckStore } from "~/lib/models/incident-acks.server";
import { FUNNEL_STAGE_KEYS, utcDay } from "~/lib/services/funnel.server";
import type {
  AdminViewData,
  FunnelVM,
  HolderCohortsVM,
  IncidentFeedVM,
  PanelState,
  ProgramHealthVM,
  UpkeepDistributionVM,
  UpkeepVM,
  ValidatorCohortsVM,
} from "./types";

export type { AdminViewData } from "./types";

/** Incident feed page size. Bounded here as well as at the API. */
export const INCIDENT_PAGE_SIZE = 50;

/**
 * Days of funnel history the panel reads — re-exported from `@nvhash/api-types`
 * rather than declared here.
 *
 * The funnel's upper stages are counter-derived in this tier and its terminal
 * stage is chain-derived in `services/api`. A web-local 90 could drift from the
 * API's window and produce a funnel whose bottom counts a different span than
 * its top — silently, since both numbers would look reasonable. One declaration
 * makes that unrepresentable. It is inside the 400-day counter retention, which
 * `test/funnel-counters.test.ts` asserts.
 */
export { FUNNEL_WINDOW_DAYS };

function hash(base: string): string {
  return formatBaseAmount(BigInt(base), HASH_EXPONENT, 2);
}

// ── Pure mapping (exported for the honesty-matrix test) ─────────────────────

/**
 * Program health. Cold start is DISTINCT from a failed read: a program with no
 * settled epoch has a legitimately empty trend, and saying "no settled epochs
 * yet" is a different message from "we could not read the trend".
 */
export function toProgramHealthVM(
  data: {
    depositor_count: number | null;
    first_deposits_in_window: number | null;
    funnel_window_days: number;
    epochs: Array<{
      epoch_index: number;
      ended_at: string;
      tvv: string;
      net_apr_bps: number | null;
      net_deposits: string;
    }>;
    epochs_truncated: boolean;
  } | null,
): PanelState<ProgramHealthVM> {
  if (data === null) return { kind: "unavailable", reason: "read-failed" };
  if (data.epochs.length === 0 && data.depositor_count === null) {
    return { kind: "unavailable", reason: "cold-start" };
  }
  return {
    kind: "data",
    data: {
      depositorCount: data.depositor_count,
      points: data.epochs.map((e) => ({
        epochIndex: e.epoch_index,
        endedAt: e.ended_at,
        tvvHash: hash(e.tvv),
        netAprPercent: e.net_apr_bps === null ? null : bpsToPercent(e.net_apr_bps),
        netDepositsHash: hash(e.net_deposits),
        // A flag, not a colour: the sign has to survive for a reader who does
        // not perceive the colour (the accrued-gain precedent).
        netOutflow: BigInt(e.net_deposits) < 0n,
      })),
      truncated: data.epochs_truncated,
    },
  };
}

/**
 * Holder cohorts. The concentration band is its OWN panel state inside this
 * one, because "withheld below the minimum" is a different message from "the
 * cohort panel is unavailable", and the two can occur independently.
 */
export function toHolderCohortsVM(
  data: {
    min_cohort_size: number;
    adoption: Array<{ epoch_index: number; ended_at: string; new_depositors: number }>;
    adoption_truncated: boolean;
    retention: Array<{
      cohort_epoch: number;
      cohort_size: number;
      below_minimum: boolean;
      points: Array<{ horizon: number; retained_bps: number | null }>;
    }>;
    retention_truncated: boolean;
    redemption_mix: { enqueued: number; expedited: number; matured: number; refunded: number };
    concentration: {
      top1_bps: number;
      top5_bps: number;
      top10_bps: number;
      holder_count: number;
    } | null;
    holders_truncated: boolean;
  } | null,
): PanelState<HolderCohortsVM> {
  if (data === null) return { kind: "unavailable", reason: "read-failed" };
  if (data.adoption.length === 0 && data.retention.length === 0) {
    return { kind: "unavailable", reason: "cold-start" };
  }
  return {
    kind: "data",
    data: {
      minCohortSize: data.min_cohort_size,
      adoption: data.adoption.map((a) => ({
        epochIndex: a.epoch_index,
        endedAt: a.ended_at,
        newDepositors: a.new_depositors,
      })),
      adoptionTruncated: data.adoption_truncated,
      curves: data.retention.map((c) => ({
        cohortEpoch: c.cohort_epoch,
        cohortSize: c.cohort_size,
        belowMinimum: c.below_minimum,
        points: c.points.map((p) => ({
          horizon: p.horizon,
          retainedPercent: p.retained_bps === null ? null : bpsToPercent(p.retained_bps),
        })),
      })),
      retentionTruncated: data.retention_truncated,
      holdersTruncated: data.holders_truncated,
      redemptionMix: data.redemption_mix,
      concentration:
        data.concentration === null
          ? // The server withheld it as a privacy gate — it is not missing, and
            // the panel says exactly that (plan invariant 12).
            { kind: "unavailable", reason: "below-minimum" }
          : {
              kind: "data",
              data: {
                top1Percent: bpsToPercent(data.concentration.top1_bps),
                top5Percent: bpsToPercent(data.concentration.top5_bps),
                top10Percent: bpsToPercent(data.concentration.top10_bps),
                holderCount: data.concentration.holder_count,
              },
            },
    },
  };
}

export function toValidatorCohortsVM(
  data: {
    enrolled_now: number;
    churned_total: number;
    timeline: Array<{
      epoch_index: number;
      ended_at: string;
      sampled: number;
      eligible: number;
      in_arrears: number;
      tip_paying: number;
      purged: number;
    }>;
    timeline_truncated: boolean;
  } | null,
): PanelState<ValidatorCohortsVM> {
  if (data === null) return { kind: "unavailable", reason: "read-failed" };
  if (data.timeline.length === 0 && data.enrolled_now === 0 && data.churned_total === 0) {
    return { kind: "unavailable", reason: "cold-start" };
  }
  return {
    kind: "data",
    data: {
      enrolledNow: data.enrolled_now,
      churnedTotal: data.churned_total,
      timeline: data.timeline.map((t) => ({
        epochIndex: t.epoch_index,
        endedAt: t.ended_at,
        sampled: t.sampled,
        eligible: t.eligible,
        inArrears: t.in_arrears,
        tipPaying: t.tip_paying,
        purged: t.purged,
      })),
      truncated: data.timeline_truncated,
    },
  };
}

/** A distribution with no samples is "cold-start", not a flat histogram. */
function toDistributionState(
  d: {
    sample_count: number;
    median_seconds: number | null;
    p90_seconds: number | null;
    buckets: Array<{ from_seconds: number; to_seconds: number | null; count: number }>;
    truncated: boolean;
  } | null,
): PanelState<UpkeepDistributionVM> {
  if (d === null) return { kind: "unavailable", reason: "not-collected" };
  if (d.sample_count === 0) return { kind: "unavailable", reason: "cold-start" };
  return {
    kind: "data",
    data: {
      sampleCount: d.sample_count,
      medianLabel: d.median_seconds === null ? null : formatDuration(d.median_seconds),
      p90Label: d.p90_seconds === null ? null : formatDuration(d.p90_seconds),
      buckets: d.buckets.map((b) => ({
        label:
          b.to_seconds === null
            ? `${formatDuration(b.from_seconds)}+`
            : `${formatDuration(b.from_seconds)}–${formatDuration(b.to_seconds)}`,
        count: b.count,
      })),
      truncated: d.truncated,
    },
  };
}

export function toUpkeepVM(
  data: {
    epoch_lag: Parameters<typeof toDistributionState>[0];
    redemption_latency: Parameters<typeof toDistributionState>[0];
    capture_cadence: Parameters<typeof toDistributionState>[0];
  } | null,
): UpkeepVM {
  if (data === null) {
    const failed: PanelState<UpkeepDistributionVM> = {
      kind: "unavailable",
      reason: "read-failed",
    };
    return { epochLag: failed, redemptionLatency: failed, captureCadence: failed };
  }
  return {
    epochLag: toDistributionState(data.epoch_lag),
    redemptionLatency: toDistributionState(data.redemption_latency),
    // Null from the API means "not indexed in this build", which
    // `toDistributionState` maps to `not-collected` — a stated absence, not a
    // failure and not a zero.
    captureCadence: toDistributionState(data.capture_cadence),
  };
}

/**
 * Incident rows with their C4 affordances resolved.
 *
 * The rule that is easy to get wrong: an incident acknowledged by ANOTHER admin
 * is not re-offered as if unacknowledged. Offering "acknowledge" there would
 * invite a write the partial unique index permits (different admin) but which
 * would read on screen as though the first ack had not happened.
 */
export function toIncidentRowVMs(
  rows: Array<{
    id: number;
    kind: string;
    severity: "info" | "warning" | "critical";
    opened_at: string;
    closed_at: string | null;
    height: number | null;
  }> | null,
  acks: Map<number, { acknowledgedBy: string; acknowledgedAt: Date; note: string | null }> | null,
  sessionAddress: string,
): PanelState<IncidentFeedVM> {
  if (rows === null) return { kind: "unavailable", reason: "read-failed" };
  // NULL acks means the `app`-schema read failed — NOT that nothing is
  // acknowledged. An empty map would be indistinguishable from it here and
  // would make every open incident render as unacknowledged with an
  // "acknowledge" button, including one another admin has already handled: a
  // definite state asserted from a missing input (invariant 14), and the C4 row
  // that says an ack by another admin is never re-offered as if unacked.
  const ackStateKnown = acks !== null;
  return {
    kind: "data",
    data: {
      ackStateKnown,
      rows: rows.map((row) => {
        const ack = acks?.get(row.id) ?? null;
        const open = row.closed_at === null;
        const bySessionAdmin = ack !== null && ack.acknowledgedBy === sessionAddress;
        return {
          id: row.id,
          kind: row.kind,
          severity: row.severity,
          openedAt: row.opened_at,
          closedAt: row.closed_at,
          height: row.height,
          open,
          ack:
            ack === null
              ? null
              : {
                  by: ack.acknowledgedBy,
                  at: ack.acknowledgedAt.toISOString(),
                  note: ack.note,
                  bySessionAdmin,
                },
          // A closed incident is read-only: there is no retroactive ack, and no
          // un-acking history. Unknown ack state offers nothing at all — acting
          // on a state you could not read is not a coherent action, the same
          // reason a degraded feed offers no control.
          affordance:
            !ackStateKnown || !open || (ack !== null && !bySessionAdmin)
              ? "none"
              : ack === null
                ? "acknowledge"
                : "unacknowledge",
        };
      }),
    },
  };
}

/**
 * The funnel panel.
 *
 * `firstDeposits` is carried SEPARATELY from `stages` rather than appended to
 * the series, and that separation is the honesty control (plan invariant 15).
 * The stage totals are event totals with no deduplication — a returning reader
 * counts again — while the terminal stage is exact, chain-derived. Presenting
 * them as one series would imply uniform precision the data does not have, and
 * the panel's copy says which is which.
 *
 * `firstDeposits` must be the API's WINDOWED count (`first_deposits_in_window`),
 * never the all-time `depositor_count`: the stage totals cover `windowDays`, so
 * an all-time terminal would sit under the window caption and could exceed
 * every stage above it — a funnel wider at the bottom than at the top. The two
 * differ in precision, which the copy explains; they must not also differ in
 * span, which no copy could make honest.
 */
export function toFunnelVM(
  rows: Array<{ stage: string; day: string; count: number }> | null,
  firstDeposits: number | null,
  windowDays: number,
): PanelState<FunnelVM> {
  if (rows === null) return { kind: "unavailable", reason: "read-failed" };
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.stage, (totals.get(row.stage) ?? 0) + row.count);
  // Every stage appears, including those with no events in the window: a
  // missing row means "nobody did this", which is a measured 0 here — the
  // counters are exhaustive over the window by construction.
  const stages = FUNNEL_STAGE_KEYS.map((stage) => ({ stage, total: totals.get(stage) ?? 0 }));
  if (rows.length === 0 && firstDeposits === null) {
    return { kind: "unavailable", reason: "cold-start" };
  }
  return { kind: "data", data: { windowDays, stages, firstDeposits } };
}

// ── Loader ─────────────────────────────────────────────────────────────────

export interface AdminViewOptions {
  fetchImpl?: FetchLike;
  /** Injectable clock for the funnel window (deterministic in tests). */
  now?: Date;
}

/**
 * Assemble the `/admin` dashboard for one request. NEVER throws.
 *
 * `headers` is the minted `admin:` assertion — the caller obtains it from
 * `adminApiHeaders`, which is where the fresh membership read happens. Passing
 * it in rather than minting here keeps this seam free of the privilege check,
 * so there is exactly one place that can grant.
 */
export async function loadAdminViewData(
  config: WebConfig,
  session: { address: string },
  headers: { Authorization: string },
  options: AdminViewOptions = {},
): Promise<AdminViewData> {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const authFetch: FetchLike = (url, init) => doFetch(url, { ...init, headers });
  const apiBase = config.apiUrl.replace(/\/+$/, "");
  const now = options.now ?? new Date();

  const read = async <T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T | null> => {
    try {
      return schema.parse(
        await fetchApiJson(`${apiBase}${path}`, authFetch, CHROME_READ_TIMEOUT_MS),
      );
    } catch {
      // Per-panel, so one failed aggregate degrades one panel (invariant 14).
      return null;
    }
  };

  const [health, cohorts, validators, upkeep, incidents] = await Promise.all([
    read("/api/v1/admin/program-health", adminProgramHealthEnvelopeSchema),
    read("/api/v1/admin/holder-cohorts", adminHolderCohortsEnvelopeSchema),
    read("/api/v1/admin/validator-cohorts", adminValidatorCohortsEnvelopeSchema),
    read("/api/v1/admin/upkeep", adminUpkeepEnvelopeSchema),
    read(`/api/v1/admin/incidents?limit=${INCIDENT_PAGE_SIZE}`, adminIncidentsEnvelopeSchema),
  ]);

  // `app`-schema reads. They cannot come through services/api — `api_reader`
  // has no grants on `app` — so they are this tier's own, and they fail to
  // their own panel state like every other input.
  const incidentRows = incidents?.data ?? null;
  const acks = await (async () => {
    if (incidentRows === null) return null;
    try {
      const store = await getIncidentAckStore(config);
      return await store.liveAcksFor(incidentRows.map((r) => r.id));
    } catch {
      // NULL, not an empty map. A failed ack read must not hide the incidents
      // themselves — but it must not be reported as "nothing is acknowledged"
      // either, which is what an empty map would become one line later.
      return null;
    }
  })();

  const funnelRows = await (async () => {
    try {
      const store = await getFunnelCounterStore(config);
      const from = new Date(now.getTime() - FUNNEL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      return await store.since(utcDay(from));
    } catch {
      return null;
    }
  })();

  return {
    address: session.address,
    programHealth: toProgramHealthVM(health?.data ?? null),
    holderCohorts: toHolderCohortsVM(cohorts?.data ?? null),
    validatorCohorts: toValidatorCohortsVM(validators?.data ?? null),
    upkeep: toUpkeepVM(upkeep?.data ?? null),
    incidents: toIncidentRowVMs(incidentRows, acks, session.address),
    // The chain-derived terminal stage: the health panel's WINDOWED first-
    // deposit count, computed by the API over the same `FUNNEL_WINDOW_DAYS` the
    // counter read above used. Not `depositor_count`, which is all-time and
    // belongs to the header panel.
    funnel: toFunnelVM(
      funnelRows,
      health?.data.first_deposits_in_window ?? null,
      FUNNEL_WINDOW_DAYS,
    ),
    // Surfaced so a stale indexed read is visibly stale rather than presented
    // as current (C5). Any panel's envelope will do — they share a reader.
    freshness:
      (health?.meta as FreshnessMeta | undefined) ??
      (cohorts?.meta as FreshnessMeta | undefined) ??
      (incidents?.meta as FreshnessMeta | undefined) ??
      null,
  };
}
