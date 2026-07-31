// Assemble a per-epoch validator sample at a crank height. Like epoch-history,
// the validator-sampler is anchored to epoch cranks and reads state
// height-pinned AS OF the crank (finalized per-epoch economics, keyed by the
// epoch that closed there), rather than free-running — so it backfills and
// replays deterministically. Combines the contract's validators()/jail_reports()
// with x/staking moniker + program delegation.

import {
  deriveFailingReasons,
  epochIndexOf,
  parseJailReports,
  parseMonikers,
  parseProgramDelegations,
  parseValidators,
  type JailReport,
  type ValidatorStatus,
} from "./decode.ts";
import type { Crank } from "../epoch-history/boundaries.ts";

/** One validator's finalized economics for an epoch, ready to write. */
export interface SampledValidator {
  valoper: string;
  operator: string;
  moniker: string;
  enrolledAtSeconds: bigint;
  uptimeBps: number;
  eligible: boolean;
  failingReasons: string[];
  tip: bigint;
  commissionAccrued: bigint;
  commissionPaid: bigint;
  commissionDue: bigint;
  programDelegation: bigint;
  jailedEvents: unknown | null;
}

export interface CrankSample {
  epochIndex: bigint;
  height: bigint;
  observedAt: Date;
  validators: SampledValidator[];
}

/** The reads a sample needs: pinned smart query, pinned LCD GET, block time. */
export interface SamplerSource {
  smartAtHeight(
    contract: string,
    query: Record<string, unknown>,
    height: bigint | number,
  ): Promise<unknown>;
  getAtHeight(
    path: string,
    params: Record<string, string | number | bigint | undefined>,
    height: bigint | number,
  ): Promise<unknown>;
  blockTime(height: bigint | number): Promise<Date>;
}

// Single-page cap for x/staking module reads (program validators <= 100;
// realistic chain validator count fits). Truncation would under-report a
// moniker/delegation, never corrupt an amount — bounded and logged upstream.
const STAKING_PAGE_LIMIT = "1000";

function jailedEventsFor(status: ValidatorStatus, reports: readonly JailReport[]): unknown | null {
  const mine = reports.filter((r) => r.valoper === status.valoper);
  if (!status.jailed && !status.tombstoned && mine.length === 0) return null;
  return {
    jailed: status.jailed,
    tombstoned: status.tombstoned,
    reports: mine.map((r) => ({
      reported_at_seconds: r.reportedAtSeconds.toString(),
      purge_ready_at_seconds: r.purgeReadyAtSeconds.toString(),
    })),
  };
}

/** Sample the validator set for the epoch that closed at `crank`. Null if the
 * contract reports no snapshot at that height (should not happen at a real
 * crank; a null just skips rather than fabricating an epoch index). */
export async function sampleCrank(
  src: SamplerSource,
  contractAddress: string,
  crank: Crank,
): Promise<CrankSample | null> {
  const H = crank.height;

  const epochIndex = epochIndexOf(
    await src.smartAtHeight(contractAddress, { epoch_snapshot: {} }, H),
  );
  if (epochIndex === null) return null;

  const statuses = parseValidators(await src.smartAtHeight(contractAddress, { validators: {} }, H));
  const reports = parseJailReports(
    await src.smartAtHeight(contractAddress, { jail_reports: {} }, H),
  );
  const monikers = parseMonikers(
    await src.getAtHeight(
      "cosmos/staking/v1beta1/validators",
      { "pagination.limit": STAKING_PAGE_LIMIT },
      H,
    ),
  );
  const delegations = parseProgramDelegations(
    await src.getAtHeight(
      `cosmos/staking/v1beta1/delegations/${contractAddress}`,
      { "pagination.limit": STAKING_PAGE_LIMIT },
      H,
    ),
  );
  const observedAt = await src.blockTime(H);

  const validators: SampledValidator[] = statuses.map((s) => ({
    valoper: s.valoper,
    operator: s.operator,
    moniker: monikers.get(s.valoper) ?? "",
    enrolledAtSeconds: s.enrolledAtSeconds,
    // Int column: unknown uptime (no capture yet) stores as 0 — read alongside
    // `eligible`/`failingReasons`, never as an asserted 0% uptime.
    uptimeBps: s.uptimeBps ?? 0,
    eligible: s.eligible,
    failingReasons: deriveFailingReasons(s),
    tip: s.tipEpoch,
    commissionAccrued: s.commissionAccrued,
    commissionPaid: s.commissionPaid,
    commissionDue: s.commissionDue,
    programDelegation: delegations.get(s.valoper) ?? 0n,
    jailedEvents: jailedEventsFor(s, reports),
  }));

  return { epochIndex, height: H, observedAt, validators };
}
