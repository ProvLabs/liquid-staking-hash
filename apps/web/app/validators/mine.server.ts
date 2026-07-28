// Operator-view data assembly (`/validators/mine`, plan M6.4 §2.3; app-spec
// §8.6, §12.1). Two planes composed honestly, the market.server.ts pattern:
// every read degrades to null independently and the loader NEVER throws.
//
//   LIVE plane (canonical): the contract's `Validators {}` + `Config {}` +
//     `JailReports {}`, plus the x/staking commission rate. This is what the
//     operator ACTS on — current standing, arrears, prepaid credit.
//   INDEXED plane (services/api, address-scoped assertion): the history the
//     console cannot show — per-epoch economics, per-payment facts, lifetime
//     totals.
//
// The load-bearing asymmetry (verified against `contracts/src/validators.rs`
// 2026-07-27): program COMMISSION is cumulative and an overpayment carries
// forward indefinitely, while TIP resets at every epoch rollover. And a
// prepaid credit is INVISIBLE in the payment events — `pay_commission`'s
// `outstanding` attribute is `accrued.saturating_sub(paid)`, so an overpayment
// reports 0, never a negative. The credit is therefore read from the LIVE
// plane only, as `commission_paid − commission_accrued`, and never inferred
// from the indexed payment history.
//
// Amounts are BigInt end-to-end; floats appear only at the delegation chart's
// point mapping (app-spec §9.5 render-time conversion). The acting address is
// the SESSION address only (standing session-scope gate).

import {
  LcdClient,
  NvhashContractClient,
  StakingClient,
  type FetchLike,
  type ValidatorStatus,
} from "@nvhash/chain-client";

import {
  fetchApiJson,
  epochsEnvelopeSchema,
  operatorEpochsEnvelopeSchema,
  operatorPaymentsEnvelopeSchema,
  operatorSummaryEnvelopeSchema,
} from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { bpsToPercent, formatBaseAmount, HASH_EXPONENT } from "~/learn/amounts";
import { isValoperAddress } from "~/lib/bech32";
import { personalApiHeaders } from "~/lib/services/assertion.server";
import { requireSession, type SessionDeps } from "~/lib/services/session.server";
import { verifyHref } from "~/components/verify-link";
import type {
  CommissionStanding,
  DelegationHistoryVM,
  NetBenefitVM,
  OperatorEpochRowVM,
  OperatorPaymentRowVM,
  OperatorStandingVM,
  OperatorValidatorVM,
  OperatorViewData,
} from "./mine-types";

export type { OperatorViewData } from "./mine-types";

/** Indexed page sizes. Epochs are calendar-month, so 200 covers ~16 years —
 * but a full page is still reported as truncated rather than assumed complete. */
export const EPOCH_PAGE_SIZE = 200;
export const PAYMENT_PAGE_SIZE = 50;

// ── Pure composition (BigInt only) ─────────────────────────────────────────

/**
 * The THREE-state commission standing (plan §2.3). `in_arrears` is the
 * contract's own assessment (`paid < due` past the one-epoch grace); a prepaid
 * credit exists whenever cumulative paid exceeds cumulative accrued.
 */
export function commissionStanding(v: {
  inArrears: boolean;
  commissionPaid: bigint;
  commissionAccrued: bigint;
}): CommissionStanding {
  if (v.inArrears) return "in-arrears";
  return v.commissionPaid > v.commissionAccrued ? "prepaid" : "current";
}

/** The prepaid credit in nhash, or null when there is none. Live plane only:
 * the payment events cannot express it (`outstanding` saturates at 0). */
export function prepaidCredit(v: {
  commissionPaid: bigint;
  commissionAccrued: bigint;
}): bigint | null {
  const credit = v.commissionPaid - v.commissionAccrued;
  return credit > 0n ? credit : null;
}

/** x/staking commission rate scale (18 decimal places, sdk.Dec). */
const RATE_SCALE = 10n ** 18n;
const YEAR_SECONDS = 365n * 24n * 60n * 60n;
const BPS_SCALE = 10_000n;

/**
 * `"0.100000000000000000"` → `100000000000000000` (scale 1e18). Returns null on
 * any shape the chain would not have produced — an unparseable rate must null
 * the estimate, never silently become zero (which would read as "you earn
 * nothing" rather than "we cannot say").
 */
export function parseCommissionRate(rate: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{0,18}))?$/.exec(rate.trim());
  if (match === null) return null;
  const fraction = (match[2] ?? "").padEnd(18, "0");
  return BigInt(match[1]!) * RATE_SCALE + BigInt(fraction);
}

/** One epoch step of the earnings estimate. */
export interface EarningsStep {
  /** The program's delegation to this validator during the step, nhash. */
  programDelegation: bigint;
  /** The program's realized net APR for the step, bps (may be negative). */
  netAprBps: number;
  /** Seconds the step covered (this epoch's close minus the previous close). */
  durationSeconds: bigint;
}

/**
 * Estimated staking-commission earnings on the program's delegation (§7 Q2,
 * DECIDED 2026-07-27 as a labeled estimate).
 *
 *   per step: delegation × max(netAprBps, 0)/10000 × duration/year × rate
 *
 * Why it is an ESTIMATE and must always be labeled one: the validator's actual
 * reward stream is not indexed, so the program's own realized net APR stands in
 * for the reward rate, and the CURRENT commission rate is applied to every past
 * step (rate changes over time are not indexed either). Precise attribution
 * needs an indexer follow-on.
 *
 * A negative program net APR (a slash epoch) is floored at zero rather than
 * subtracted: the program losing value does not mean the validator's staking
 * commission went negative. BigInt scale-then-floor throughout; the division is
 * last so no intermediate rounding accumulates.
 */
export function estimateOperatorEarnings(
  steps: readonly EarningsStep[],
  commissionRateScaled: bigint,
): bigint {
  let total = 0n;
  for (const step of steps) {
    if (step.programDelegation <= 0n || step.durationSeconds <= 0n) continue;
    const aprBps = BigInt(Math.max(0, Math.trunc(step.netAprBps)));
    if (aprBps === 0n) continue;
    total +=
      (step.programDelegation * aprBps * step.durationSeconds * commissionRateScaled) /
      (BPS_SCALE * YEAR_SECONDS * RATE_SCALE);
  }
  return total;
}

/**
 * Pair each epoch's program delegation with the program APR and the step's real
 * duration. `epochBoundaries` must be ascending by epoch index; the FIRST epoch
 * of the series contributes no step (there is no prior close to measure from),
 * which is honest rather than assuming a month.
 */
export function buildEarningsSteps(
  delegationByEpoch: ReadonlyMap<number, bigint>,
  epochBoundaries: readonly { epochIndex: number; endedAtSeconds: number; netAprBps: number | null }[],
): EarningsStep[] {
  const steps: EarningsStep[] = [];
  for (let i = 1; i < epochBoundaries.length; i++) {
    const current = epochBoundaries[i]!;
    const previous = epochBoundaries[i - 1]!;
    const delegation = delegationByEpoch.get(current.epochIndex);
    if (delegation === undefined || current.netAprBps === null) continue;
    const duration = BigInt(current.endedAtSeconds - previous.endedAtSeconds);
    if (duration <= 0n) continue;
    steps.push({ programDelegation: delegation, netAprBps: current.netAprBps, durationSeconds: duration });
  }
  return steps;
}

// ── Loader ─────────────────────────────────────────────────────────────────

export interface OperatorSession {
  address: string;
}

export interface OperatorViewOptions {
  fetchImpl?: FetchLike;
  /** The owned valoper whose detail sections to render; defaults to the first. */
  valoper?: string | null;
}

function hash(value: bigint | null): string | null {
  return value === null ? null : formatBaseAmount(value, HASH_EXPONENT, 4);
}

/** Assemble the operator view for one request. Never throws. */
export async function loadOperatorViewData(
  config: WebConfig,
  session: OperatorSession,
  options: OperatorViewOptions = {},
): Promise<OperatorViewData> {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl: doFetch, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  const staking = new StakingClient(lcd);
  const apiBase = config.apiUrl.replace(/\/+$/, "");
  const headers = personalApiHeaders(config, session.address);
  const authFetch: FetchLike | null =
    headers === null ? null : (url, init) => doFetch(url, { ...init, headers });
  const addr = encodeURIComponent(session.address);

  const [liveValidators, contractConfig, jailReports, stakingSet, summaryEnv] = await Promise.all([
    contract.validators().catch(() => null),
    contract.config().catch(() => null),
    contract.jailReports().catch(() => null),
    staking.validators().catch(() => null),
    authFetch === null
      ? Promise.resolve(null)
      : fetchApiJson(`${apiBase}/api/v1/operator/summary?address=${addr}`, authFetch, CHROME_READ_TIMEOUT_MS)
          .then((body) => operatorSummaryEnvelopeSchema.parse(body))
          .catch(() => null),
  ]);

  // Ownership comes from the INDEXED registry (the API enforces it server-side)
  // with the live set as a fallback, so an operator whose indexed plane is down
  // still sees their own standing rather than an empty page.
  const ownedFromIndex = summaryEnv?.data.validators ?? null;
  const ownedFromLive = (liveValidators ?? []).filter((v) => v.operator === session.address);
  const owned: OperatorValidatorVM[] =
    ownedFromIndex !== null
      ? ownedFromIndex.map((v) => ({
          valoper: v.valoper,
          moniker: v.moniker === "" ? null : v.moniker,
          active: v.active,
          commissionPaidTotalHash: formatBaseAmount(BigInt(v.commission_paid_total), HASH_EXPONENT, 4),
          tipPaidTotalHash: formatBaseAmount(BigInt(v.tip_paid_total), HASH_EXPONENT, 4),
          paymentCount: v.payment_count,
        }))
      : ownedFromLive.map((v) => ({
          valoper: v.valoper,
          moniker: null,
          active: true,
          commissionPaidTotalHash: "0.0000",
          tipPaidTotalHash: "0.0000",
          paymentCount: 0,
        }));

  const requested = options.valoper ?? null;
  const selectedValoper =
    requested !== null && owned.some((v) => v.valoper === requested)
      ? requested
      : (owned[0]?.valoper ?? null);

  const liveStatus: ValidatorStatus | null =
    selectedValoper === null
      ? null
      : ((liveValidators ?? []).find((v) => v.valoper === selectedValoper) ?? null);

  const monikerByValoper = new Map(
    (stakingSet?.validators ?? []).map((v) => [v.operatorAddress, v.moniker] as const),
  );
  const rateByValoper = new Map(
    (stakingSet?.validators ?? []).map((v) => [v.operatorAddress, v.commissionRate] as const),
  );

  const [epochsEnv, paymentsEnv, programEpochsEnv] =
    selectedValoper === null
      ? [null, null, null]
      : await Promise.all([
          authFetch === null
            ? Promise.resolve(null)
            : fetchApiJson(
                `${apiBase}/api/v1/operator/epochs?address=${addr}&valoper=${encodeURIComponent(selectedValoper)}&limit=${EPOCH_PAGE_SIZE}`,
                authFetch,
                CHROME_READ_TIMEOUT_MS,
              )
                .then((body) => operatorEpochsEnvelopeSchema.parse(body))
                .catch(() => null),
          authFetch === null
            ? Promise.resolve(null)
            : fetchApiJson(
                `${apiBase}/api/v1/operator/payments?address=${addr}&valoper=${encodeURIComponent(selectedValoper)}&limit=${PAYMENT_PAGE_SIZE}`,
                authFetch,
                CHROME_READ_TIMEOUT_MS,
              )
                .then((body) => operatorPaymentsEnvelopeSchema.parse(body))
                .catch(() => null),
          // The program's per-epoch net APR — a PUBLIC read, no assertion.
          fetchApiJson(
            `${apiBase}/api/v1/epochs?limit=${EPOCH_PAGE_SIZE}`,
            doFetch,
            CHROME_READ_TIMEOUT_MS,
          )
            .then((body) => epochsEnvelopeSchema.parse(body))
            .catch(() => null),
        ]);

  const summaryRow =
    selectedValoper === null
      ? null
      : (summaryEnv?.data.validators.find((v) => v.valoper === selectedValoper) ?? null);

  const standing: OperatorStandingVM | null =
    selectedValoper === null
      ? null
      : buildStanding({
          valoper: selectedValoper,
          live: liveStatus,
          thresholdBps: contractConfig?.performanceThresholdBps ?? null,
          moniker: monikerByValoper.get(selectedValoper) ?? summaryRow?.moniker ?? null,
          active: owned.find((v) => v.valoper === selectedValoper)?.active ?? true,
          enrolledAt: summaryRow?.enrolled_at ?? null,
          failingReasons: summaryRow?.failing_reasons ?? [],
          jailReport:
            (jailReports ?? []).find((r) => r.valoper === selectedValoper) ?? null,
        });

  // Epoch history (newest first from the API; the chart needs oldest first).
  const epochRows = epochsEnv?.data ?? [];
  const epochsAsc = [...epochRows].sort((a, b) => a.epoch_index - b.epoch_index);
  const epochs: OperatorEpochRowVM[] = epochRows.map((row) => ({
    epochIndex: row.epoch_index,
    observedAt: row.observed_at,
    uptimePercent: bpsToPercent(row.uptime_bps),
    eligible: row.eligible,
    failingReasons: row.failing_reasons,
    programDelegationHash: formatBaseAmount(BigInt(row.program_delegation), HASH_EXPONENT, 4),
    tipHash: formatBaseAmount(BigInt(row.tip), HASH_EXPONENT, 4),
    commissionAccruedHash: formatBaseAmount(BigInt(row.commission_accrued), HASH_EXPONENT, 4),
    commissionPaidHash: formatBaseAmount(BigInt(row.commission_paid), HASH_EXPONENT, 4),
    commissionDueHash: formatBaseAmount(BigInt(row.commission_due), HASH_EXPONENT, 4),
    consoleHref: verifyHref(config.consoleUrl, "validators"),
  }));

  const delegationHistory: DelegationHistoryVM | null =
    epochsAsc.length === 0
      ? null
      : {
          points: epochsAsc.map((row) =>
            // Plottable HASH; the float is confined to this mapping (§9.5).
            Number(formatBaseAmount(BigInt(row.program_delegation), HASH_EXPONENT, 4)),
          ),
          epochLabels: epochsAsc.map((row) => String(row.epoch_index)),
          rows: epochsAsc.map((row) => [
            String(row.epoch_index),
            formatBaseAmount(BigInt(row.program_delegation), HASH_EXPONENT, 4),
          ]),
          truncated: epochRows.length >= EPOCH_PAGE_SIZE,
        };

  const netBenefit: NetBenefitVM | null =
    summaryRow === null
      ? null
      : buildNetBenefit({
          summaryRow,
          epochsAsc,
          programEpochs: programEpochsEnv?.data ?? null,
          commissionRate:
            selectedValoper === null ? null : (rateByValoper.get(selectedValoper) ?? null),
          truncated: epochRows.length >= EPOCH_PAGE_SIZE,
        });

  const operatorAccount = summaryRow?.operator ?? session.address;
  const payments: OperatorPaymentRowVM[] = (paymentsEnv?.data ?? []).map((row) => ({
    time: row.occurred_at,
    msgIndex: row.msg_index,
    paymentType: row.payment_type,
    amountHash: formatBaseAmount(BigInt(row.amount), HASH_EXPONENT, 4),
    epochIndex: row.epoch_index,
    payer: row.payer,
    paidByOther: row.payer !== operatorAccount,
    txhash: row.txhash,
    explorerHref: config.explorerUrl
      ? `${config.explorerUrl.replace(/\/$/, "")}/tx/${row.txhash}`
      : null,
  }));

  return {
    address: session.address,
    owned,
    selectedValoper,
    standing,
    netBenefit,
    delegationHistory,
    epochs,
    epochsTruncated: epochRows.length >= EPOCH_PAGE_SIZE,
    payments,
    paymentsHasMore: (paymentsEnv?.data.length ?? 0) >= PAYMENT_PAGE_SIZE,
    personalReadsAvailable: headers !== null && summaryEnv !== null,
    liveAvailable: liveValidators !== null && contractConfig !== null,
    freshness: summaryEnv?.meta ?? epochsEnv?.meta ?? paymentsEnv?.meta ?? null,
  };
}

function buildStanding(input: {
  valoper: string;
  live: ValidatorStatus | null;
  thresholdBps: number | null;
  moniker: string | null;
  active: boolean;
  enrolledAt: string | null;
  failingReasons: string[];
  jailReport: { reportedAtSeconds: number; purgeReadyAtSeconds: number } | null;
}): OperatorStandingVM {
  const { live } = input;
  const uptimeBps = live?.uptimeBps ?? null;
  const thresholdBps = input.thresholdBps;
  return {
    valoper: input.valoper,
    moniker: input.moniker === "" ? null : input.moniker,
    active: input.active,
    enrolledAt:
      input.enrolledAt ??
      (live === null ? "" : new Date(live.enrolledAtSeconds * 1_000).toISOString()),
    eligible: live?.eligible ?? null,
    jailed: live?.jailed ?? false,
    tombstoned: live?.tombstoned ?? false,
    failingReasons: input.failingReasons,
    uptimePercent: uptimeBps === null ? null : bpsToPercent(uptimeBps),
    thresholdPercent: thresholdBps === null ? null : bpsToPercent(thresholdBps),
    // Signed headroom in percentage points; null unless BOTH sides are known —
    // a headroom against an unknown threshold would be meaningless.
    uptimeHeadroomPercent:
      uptimeBps === null || thresholdBps === null ? null : bpsToPercent(uptimeBps - thresholdBps),
    standing: live === null ? null : commissionStanding(live),
    commissionAccruedHash: hash(live?.commissionAccrued ?? null),
    commissionPaidHash: hash(live?.commissionPaid ?? null),
    commissionDueHash: hash(live?.commissionDue ?? null),
    prepaidCreditHash: live === null ? null : hash(prepaidCredit(live)),
    tipEpochHash: hash(live?.tipEpoch ?? null),
    headroomHash: hash(live?.headroom ?? null),
    jailReport:
      input.jailReport === null
        ? null
        : {
            reportedAt: new Date(input.jailReport.reportedAtSeconds * 1_000).toISOString(),
            purgeReadyAt: new Date(input.jailReport.purgeReadyAtSeconds * 1_000).toISOString(),
          },
  };
}

function buildNetBenefit(input: {
  summaryRow: { commission_paid_total: string; tip_paid_total: string };
  epochsAsc: readonly { epoch_index: number; program_delegation: string }[];
  programEpochs: readonly { epoch_index: number; ended_at: string; net_apr_bps: number | null }[] | null;
  commissionRate: string | null;
  truncated: boolean;
}): NetBenefitVM {
  const commissionPaid = BigInt(input.summaryRow.commission_paid_total);
  const tipPaid = BigInt(input.summaryRow.tip_paid_total);
  const rateScaled = input.commissionRate === null ? null : parseCommissionRate(input.commissionRate);

  let earnings: bigint | null = null;
  let epochsCovered = 0;
  if (rateScaled !== null && input.programEpochs !== null) {
    const delegationByEpoch = new Map(
      input.epochsAsc.map((row) => [row.epoch_index, BigInt(row.program_delegation)] as const),
    );
    const boundaries = [...input.programEpochs]
      .map((e) => ({
        epochIndex: e.epoch_index,
        endedAtSeconds: Math.floor(Date.parse(e.ended_at) / 1000),
        netAprBps: e.net_apr_bps,
      }))
      .filter((e) => Number.isFinite(e.endedAtSeconds))
      .sort((a, b) => a.epochIndex - b.epochIndex);
    const steps = buildEarningsSteps(delegationByEpoch, boundaries);
    epochsCovered = steps.length;
    // No coverable step means we cannot state an estimate — null, not zero.
    earnings = steps.length === 0 ? null : estimateOperatorEarnings(steps, rateScaled);
  }

  return {
    estimatedEarningsHash: hash(earnings),
    commissionPaidTotalHash: formatBaseAmount(commissionPaid, HASH_EXPONENT, 4),
    tipPaidTotalHash: formatBaseAmount(tipPaid, HASH_EXPONENT, 4),
    netBenefitHash: earnings === null ? null : hash(earnings - commissionPaid - tipPaid),
    commissionRatePercent:
      rateScaled === null ? null : formatBaseAmount(rateScaled * 100n, 18, 2),
    epochsCovered,
    truncated: input.truncated,
  };
}

// ── CSV export proxy ────────────────────────────────────────────────────────

const FORWARDED_EXPORT_HEADERS = [
  "content-type",
  "content-disposition",
  "x-chain-height",
  "x-indexed-height",
  "x-generated-at",
] as const;

export interface OperatorExportDeps {
  fetchImpl?: typeof fetch;
  sessionOverride?: Partial<SessionDeps>;
}

/**
 * Proxy the §14.11 operator payment export for the SESSION address. The
 * `valoper` query param selects among the operator's OWN validators; ownership
 * is enforced by services/api against the asserted address, so a valoper the
 * session does not operate returns a header-only CSV rather than another
 * operator's history. A malformed valoper is rejected here (400) rather than
 * forwarded.
 */
export async function exportOperatorPaymentsCsv(
  config: WebConfig,
  request: Request,
  deps: OperatorExportDeps = {},
): Promise<Response> {
  const session = await requireSession(config, request, deps.sessionOverride);
  const valoper = new URL(request.url).searchParams.get("valoper") ?? "";
  if (!isValoperAddress(valoper)) {
    return Response.json({ error: "valoper required" }, { status: 400 });
  }
  const headers = personalApiHeaders(config, session.address);
  if (headers === null) {
    return Response.json({ error: "export unavailable" }, { status: 503 });
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const apiBase = config.apiUrl.replace(/\/+$/, "");
  const url =
    `${apiBase}/api/v1/operator/payments?address=${encodeURIComponent(session.address)}` +
    `&valoper=${encodeURIComponent(valoper)}&format=csv`;

  const upstream = await doFetch(url, { headers });
  const forwarded = new Headers();
  for (const name of FORWARDED_EXPORT_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: forwarded });
}
