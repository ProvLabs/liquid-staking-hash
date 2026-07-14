// Typed smart queries against the nvHASH asset-manager contract, over LCD
// /cosmwasm/wasm/v1/contract/{addr}/smart/{base64(query)}. Response types
// mirror contracts/src/msg.rs; every Uint128 decodes to bigint, every
// contract u64 arrives as a JSON number (validated safe-integer). Shapes are
// fixture-locked in test/ — a contract interface change breaks tests here,
// not production (spec §9.2).

import {
  expectArray,
  expectBoolean,
  expectObject,
  expectString,
  parseInt128,
  parseU64Number,
  parseUint128,
} from "./amounts.ts";
import { LcdClient } from "./lcd.ts";

export interface ContractConfig {
  admin: string;
  vaultAddress: string;
  underlyingDenom: string;
  receiptDenom: string;
  minRunIntervalSecs: number;
  maxDelegationsPerRun: number;
  aumFeeBps: number;
  performanceThresholdBps: number;
  minCaptureIntervalSecs: number;
  maxConcentrationMultipleBps: number;
  minBondedCapBps: number;
  maxBondedCapBps: number;
  concentrationSafetyOffsetBps: number;
  commissionBps: number;
  jailUnbondDelaySecs: number;
}

export interface PendingDelegation {
  valoper: string;
  amount: bigint;
}

export interface PendingRedelegation {
  src: string;
  dst: string;
  amount: bigint;
}

export interface EpochStatus {
  phase: string;
  halted: boolean;
  lastRunSeconds: number;
  receiptMinted: bigint;
  pendingDelegations: PendingDelegation[];
  pendingRedelegations: PendingRedelegation[];
}

/** Contract §9.10 value decomposition — only the latest is retained on chain. */
export interface EpochSnapshot {
  epochIndex: number;
  startedAtSeconds: number;
  endedAtSeconds: number;
  endHeight: number;
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
  redemptionsExpedited: number;
  validatorsPurged: number;
  eligibleCount: number;
  aumFeeEstimate: bigint;
  /** signed: swap-ins minus swap-outs over the window */
  netDeposits: bigint;
}

export interface Apr {
  epochIndex: number;
  windowSeconds: number;
  tvvBefore: bigint;
  rewardsClaimed: bigint;
  commissionReceived: bigint;
  tipsReceived: bigint;
  aumFeeEstimate: bigint;
  writeDown: bigint;
  grossAprBps: number;
  netAprBps: number;
}

export interface ValidatorStatus {
  valoper: string;
  operator: string;
  enrolledAtSeconds: number;
  uptimeCaptureCount: number;
  /** null before the first uptime capture (Option<u64> upstream) */
  uptimeBps: number | null;
  jailed: boolean;
  tombstoned: boolean;
  tipEpoch: bigint;
  commissionAccrued: bigint;
  commissionPaid: bigint;
  commissionDue: bigint;
  inArrears: boolean;
  eligible: boolean;
  headroom: bigint;
}

export interface JailReport {
  valoper: string;
  reportedAtSeconds: number;
  purgeReadyAtSeconds: number;
}

export function parseContractConfig(value: unknown, path = "$"): ContractConfig {
  const o = expectObject(value, path);
  return {
    admin: expectString(o["admin"], `${path}.admin`),
    vaultAddress: expectString(o["vault_address"], `${path}.vault_address`),
    underlyingDenom: expectString(o["underlying_denom"], `${path}.underlying_denom`),
    receiptDenom: expectString(o["receipt_denom"], `${path}.receipt_denom`),
    minRunIntervalSecs: parseU64Number(o["min_run_interval_secs"], `${path}.min_run_interval_secs`),
    maxDelegationsPerRun: parseU64Number(o["max_delegations_per_run"], `${path}.max_delegations_per_run`),
    aumFeeBps: parseU64Number(o["aum_fee_bps"], `${path}.aum_fee_bps`),
    performanceThresholdBps: parseU64Number(o["performance_threshold_bps"], `${path}.performance_threshold_bps`),
    minCaptureIntervalSecs: parseU64Number(o["min_capture_interval_secs"], `${path}.min_capture_interval_secs`),
    maxConcentrationMultipleBps: parseU64Number(o["max_concentration_multiple_bps"], `${path}.max_concentration_multiple_bps`),
    minBondedCapBps: parseU64Number(o["min_bonded_cap_bps"], `${path}.min_bonded_cap_bps`),
    maxBondedCapBps: parseU64Number(o["max_bonded_cap_bps"], `${path}.max_bonded_cap_bps`),
    concentrationSafetyOffsetBps: parseU64Number(o["concentration_safety_offset_bps"], `${path}.concentration_safety_offset_bps`),
    commissionBps: parseU64Number(o["commission_bps"], `${path}.commission_bps`),
    jailUnbondDelaySecs: parseU64Number(o["jail_unbond_delay_secs"], `${path}.jail_unbond_delay_secs`),
  };
}

export function parseEpochStatus(value: unknown, path = "$"): EpochStatus {
  const o = expectObject(value, path);
  return {
    phase: expectString(o["phase"], `${path}.phase`),
    halted: expectBoolean(o["halted"], `${path}.halted`),
    lastRunSeconds: parseU64Number(o["last_run_seconds"], `${path}.last_run_seconds`),
    receiptMinted: parseUint128(o["receipt_minted"], `${path}.receipt_minted`),
    pendingDelegations: expectArray(o["pending_delegations"], `${path}.pending_delegations`).map((p, i) => {
      const d = expectObject(p, `${path}.pending_delegations[${i}]`);
      return {
        valoper: expectString(d["valoper"], `${path}.pending_delegations[${i}].valoper`),
        amount: parseUint128(d["amount"], `${path}.pending_delegations[${i}].amount`),
      };
    }),
    pendingRedelegations: expectArray(o["pending_redelegations"] ?? [], `${path}.pending_redelegations`).map((p, i) => {
      const d = expectObject(p, `${path}.pending_redelegations[${i}]`);
      return {
        src: expectString(d["src"], `${path}.pending_redelegations[${i}].src`),
        dst: expectString(d["dst"], `${path}.pending_redelegations[${i}].dst`),
        amount: parseUint128(d["amount"], `${path}.pending_redelegations[${i}].amount`),
      };
    }),
  };
}

export function parseEpochSnapshot(value: unknown, path = "$"): EpochSnapshot {
  const o = expectObject(value, path);
  return {
    epochIndex: parseU64Number(o["epoch_index"], `${path}.epoch_index`),
    startedAtSeconds: parseU64Number(o["started_at_seconds"], `${path}.started_at_seconds`),
    endedAtSeconds: parseU64Number(o["ended_at_seconds"], `${path}.ended_at_seconds`),
    endHeight: parseU64Number(o["end_height"], `${path}.end_height`),
    tvvBefore: parseUint128(o["tvv_before"], `${path}.tvv_before`),
    tvvAfter: parseUint128(o["tvv_after"], `${path}.tvv_after`),
    totalShares: parseUint128(o["total_shares"], `${path}.total_shares`),
    rewardsClaimed: parseUint128(o["rewards_claimed"], `${path}.rewards_claimed`),
    commissionReceived: parseUint128(o["commission_received"], `${path}.commission_received`),
    tipsReceived: parseUint128(o["tips_received"], `${path}.tips_received`),
    rewardsDeposited: parseUint128(o["rewards_deposited"], `${path}.rewards_deposited`),
    settled: parseUint128(o["settled"], `${path}.settled`),
    writeDown: parseUint128(o["write_down"], `${path}.write_down`),
    deployed: parseUint128(o["deployed"], `${path}.deployed`),
    rebalanced: parseUint128(o["rebalanced"], `${path}.rebalanced`),
    unbondedForRedemptions: parseUint128(o["unbonded_for_redemptions"], `${path}.unbonded_for_redemptions`),
    redemptionsExpedited: parseU64Number(o["redemptions_expedited"], `${path}.redemptions_expedited`),
    validatorsPurged: parseU64Number(o["validators_purged"], `${path}.validators_purged`),
    eligibleCount: parseU64Number(o["eligible_count"], `${path}.eligible_count`),
    aumFeeEstimate: parseUint128(o["aum_fee_estimate"], `${path}.aum_fee_estimate`),
    netDeposits: parseInt128(o["net_deposits"], `${path}.net_deposits`),
  };
}

export function parseApr(value: unknown, path = "$"): Apr {
  const o = expectObject(value, path);
  return {
    epochIndex: parseU64Number(o["epoch_index"], `${path}.epoch_index`),
    windowSeconds: parseU64Number(o["window_seconds"], `${path}.window_seconds`),
    tvvBefore: parseUint128(o["tvv_before"], `${path}.tvv_before`),
    rewardsClaimed: parseUint128(o["rewards_claimed"], `${path}.rewards_claimed`),
    commissionReceived: parseUint128(o["commission_received"], `${path}.commission_received`),
    tipsReceived: parseUint128(o["tips_received"], `${path}.tips_received`),
    aumFeeEstimate: parseUint128(o["aum_fee_estimate"], `${path}.aum_fee_estimate`),
    writeDown: parseUint128(o["write_down"], `${path}.write_down`),
    grossAprBps: parseU64Number(o["gross_apr_bps"], `${path}.gross_apr_bps`),
    netAprBps: parseU64Number(o["net_apr_bps"], `${path}.net_apr_bps`),
  };
}

export function parseValidatorStatus(value: unknown, path = "$"): ValidatorStatus {
  const o = expectObject(value, path);
  const uptime = o["uptime_bps"];
  return {
    valoper: expectString(o["valoper"], `${path}.valoper`),
    operator: expectString(o["operator"], `${path}.operator`),
    enrolledAtSeconds: parseU64Number(o["enrolled_at_seconds"], `${path}.enrolled_at_seconds`),
    uptimeCaptureCount: parseU64Number(o["uptime_capture_count"], `${path}.uptime_capture_count`),
    uptimeBps: uptime === null || uptime === undefined ? null : parseU64Number(uptime, `${path}.uptime_bps`),
    jailed: expectBoolean(o["jailed"], `${path}.jailed`),
    tombstoned: expectBoolean(o["tombstoned"], `${path}.tombstoned`),
    tipEpoch: parseUint128(o["tip_epoch"], `${path}.tip_epoch`),
    commissionAccrued: parseUint128(o["commission_accrued"], `${path}.commission_accrued`),
    commissionPaid: parseUint128(o["commission_paid"], `${path}.commission_paid`),
    commissionDue: parseUint128(o["commission_due"], `${path}.commission_due`),
    inArrears: expectBoolean(o["in_arrears"], `${path}.in_arrears`),
    eligible: expectBoolean(o["eligible"], `${path}.eligible`),
    headroom: parseUint128(o["headroom"], `${path}.headroom`),
  };
}

export function parseJailReport(value: unknown, path = "$"): JailReport {
  const o = expectObject(value, path);
  return {
    valoper: expectString(o["valoper"], `${path}.valoper`),
    reportedAtSeconds: parseU64Number(o["reported_at_seconds"], `${path}.reported_at_seconds`),
    purgeReadyAtSeconds: parseU64Number(o["purge_ready_at_seconds"], `${path}.purge_ready_at_seconds`),
  };
}

/** Runtime-portable base64 (Node and browser; queries are ASCII JSON). */
function toBase64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(s)));
}

export class NvhashContractClient {
  constructor(
    private readonly lcd: LcdClient,
    private readonly contract: string,
  ) {}

  /** Raw smart query: returns the LCD envelope's `data` payload. */
  async smart(query: Record<string, unknown>): Promise<unknown> {
    const b64 = toBase64(JSON.stringify(query));
    const res = expectObject(
      await this.lcd.get(`cosmwasm/wasm/v1/contract/${this.contract}/smart/${encodeURIComponent(b64)}`),
    );
    return res["data"];
  }

  async config(): Promise<ContractConfig> {
    return parseContractConfig(await this.smart({ config: {} }));
  }

  async epochStatus(): Promise<EpochStatus> {
    return parseEpochStatus(await this.smart({ epoch_status: {} }));
  }

  /** null before the first epoch crank (single-snapshot retention, spec §13). */
  async epochSnapshot(): Promise<EpochSnapshot | null> {
    const d = expectObject(await this.smart({ epoch_snapshot: {} }));
    const s = d["snapshot"];
    return s === null || s === undefined ? null : parseEpochSnapshot(s, "$.snapshot");
  }

  /** null before the first epoch crank. */
  async apr(): Promise<Apr | null> {
    const d = await this.smart({ apr: {} });
    return d === null || d === undefined ? null : parseApr(d);
  }

  async validators(): Promise<ValidatorStatus[]> {
    const d = expectObject(await this.smart({ validators: {} }));
    return expectArray(d["validators"], "$.validators").map((v, i) =>
      parseValidatorStatus(v, `$.validators[${i}]`),
    );
  }

  async jailReports(): Promise<JailReport[]> {
    const d = expectObject(await this.smart({ jail_reports: {} }));
    return expectArray(d["reports"], "$.reports").map((r, i) =>
      parseJailReport(r, `$.reports[${i}]`),
    );
  }
}
