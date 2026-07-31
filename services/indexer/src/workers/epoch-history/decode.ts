// Decode the contract's epoch-snapshot and APR smart-query payloads into the
// `epoch_snapshots` row fields. Mirrors packages/chain-client parseEpochSnapshot
// / parseApr (fixture-locked shapes, contract §9.10); a contract interface
// change breaks the fixture-decode test, not production (app-spec §9.2). Amounts
// are bigint; heights/seconds/epoch index are BigInt columns, so u64 JSON
// numbers are widened to bigint here; bps/counts stay Int.

import { expectObject, parseInt128, parseU64Number, parseUint128 } from "../../decode/scalars.ts";

/** The §9.10 decomposition, typed for the `epoch_snapshots` row. */
export interface EpochSnapshotFields {
  epochIndex: bigint;
  startedAtSeconds: bigint;
  endedAtSeconds: bigint;
  endHeight: bigint;
  tvvBefore: bigint;
  tvvAfter: bigint;
  totalShares: bigint;
  rewardsClaimed: bigint;
  commissionReceived: bigint;
  tipsReceived: bigint;
  rewardsDeposited: bigint;
  settled: bigint;
  writeDown: bigint;
  deployed: bigint;
  rebalanced: bigint;
  unbondedForRedemptions: bigint;
  aumFeeEstimate: bigint;
  netDeposits: bigint;
  redemptionsExpedited: number;
  validatorsPurged: number;
  eligibleCount: number;
}

export interface AprFields {
  epochIndex: bigint;
  grossAprBps: number;
  netAprBps: number;
}

/** Parse the `snapshot` object (the `data.snapshot` of an epoch_snapshot query). */
export function parseEpochSnapshot(value: unknown, path = "$.snapshot"): EpochSnapshotFields {
  const o = expectObject(value, path);
  const u64big = (key: string): bigint => BigInt(parseU64Number(o[key], `${path}.${key}`));
  const u128 = (key: string): bigint => parseUint128(o[key], `${path}.${key}`);
  return {
    epochIndex: u64big("epoch_index"),
    startedAtSeconds: u64big("started_at_seconds"),
    endedAtSeconds: u64big("ended_at_seconds"),
    endHeight: u64big("end_height"),
    tvvBefore: u128("tvv_before"),
    tvvAfter: u128("tvv_after"),
    totalShares: u128("total_shares"),
    rewardsClaimed: u128("rewards_claimed"),
    commissionReceived: u128("commission_received"),
    tipsReceived: u128("tips_received"),
    rewardsDeposited: u128("rewards_deposited"),
    settled: u128("settled"),
    writeDown: u128("write_down"),
    deployed: u128("deployed"),
    rebalanced: u128("rebalanced"),
    unbondedForRedemptions: u128("unbonded_for_redemptions"),
    aumFeeEstimate: u128("aum_fee_estimate"),
    netDeposits: parseInt128(o["net_deposits"], `${path}.net_deposits`),
    redemptionsExpedited: parseU64Number(
      o["redemptions_expedited"],
      `${path}.redemptions_expedited`,
    ),
    validatorsPurged: parseU64Number(o["validators_purged"], `${path}.validators_purged`),
    eligibleCount: parseU64Number(o["eligible_count"], `${path}.eligible_count`),
  };
}

/** Parse the APR query payload (`data` of an apr query). */
export function parseApr(value: unknown, path = "$"): AprFields {
  const o = expectObject(value, path);
  return {
    epochIndex: BigInt(parseU64Number(o["epoch_index"], `${path}.epoch_index`)),
    grossAprBps: parseU64Number(o["gross_apr_bps"], `${path}.gross_apr_bps`),
    netAprBps: parseU64Number(o["net_apr_bps"], `${path}.net_apr_bps`),
  };
}
