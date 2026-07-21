// Decoders for the validator sample: the contract's validators()/jail_reports()
// smart queries, plus x/staking moniker + program-delegation module queries.
// Local mirror of the chain-client parsers (the indexer can't import that
// package at runtime — ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). Shapes are
// fixture-locked; a contract/chain interface change breaks the fixture-decode
// test, not production (app-spec §9.2). Every amount is a bigint.

import {
  expectArray,
  expectObject,
  expectString,
  parseUint128,
  parseU64Number,
} from "../../decode/scalars.ts";

/** Per-validator program status from the contract `validators()` query. */
export interface ValidatorStatus {
  valoper: string;
  operator: string;
  enrolledAtSeconds: bigint;
  /** null before the first uptime capture (Option<u64> upstream) */
  uptimeBps: number | null;
  jailed: boolean;
  tombstoned: boolean;
  inArrears: boolean;
  eligible: boolean;
  tipEpoch: bigint;
  commissionAccrued: bigint;
  commissionPaid: bigint;
  commissionDue: bigint;
  headroom: bigint;
}

export interface JailReport {
  valoper: string;
  reportedAtSeconds: bigint;
  purgeReadyAtSeconds: bigint;
}

function expectBool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`decode ${path}: expected boolean`);
  return value;
}

export function parseValidatorStatus(value: unknown, path = "$"): ValidatorStatus {
  const o = expectObject(value, path);
  const uptime = o["uptime_bps"];
  return {
    valoper: expectString(o["valoper"], `${path}.valoper`),
    operator: expectString(o["operator"], `${path}.operator`),
    enrolledAtSeconds: BigInt(parseU64Number(o["enrolled_at_seconds"], `${path}.enrolled_at_seconds`)),
    uptimeBps: uptime === null || uptime === undefined ? null : parseU64Number(uptime, `${path}.uptime_bps`),
    jailed: expectBool(o["jailed"], `${path}.jailed`),
    tombstoned: expectBool(o["tombstoned"], `${path}.tombstoned`),
    inArrears: expectBool(o["in_arrears"], `${path}.in_arrears`),
    eligible: expectBool(o["eligible"], `${path}.eligible`),
    tipEpoch: parseUint128(o["tip_epoch"], `${path}.tip_epoch`),
    commissionAccrued: parseUint128(o["commission_accrued"], `${path}.commission_accrued`),
    commissionPaid: parseUint128(o["commission_paid"], `${path}.commission_paid`),
    commissionDue: parseUint128(o["commission_due"], `${path}.commission_due`),
    headroom: parseUint128(o["headroom"], `${path}.headroom`),
  };
}

/** Parse the `validators()` payload (`data.validators`). */
export function parseValidators(data: unknown, path = "$"): ValidatorStatus[] {
  const o = expectObject(data, path);
  return expectArray(o["validators"], `${path}.validators`).map((v, i) =>
    parseValidatorStatus(v, `${path}.validators[${i}]`),
  );
}

/** Parse the `jail_reports()` payload (`data.reports`). */
export function parseJailReports(data: unknown, path = "$"): JailReport[] {
  const o = expectObject(data, path);
  return expectArray(o["reports"], `${path}.reports`).map((r, i) => {
    const jr = expectObject(r, `${path}.reports[${i}]`);
    return {
      valoper: expectString(jr["valoper"], `${path}.reports[${i}].valoper`),
      reportedAtSeconds: BigInt(parseU64Number(jr["reported_at_seconds"], `${path}.reports[${i}].reported_at_seconds`)),
      purgeReadyAtSeconds: BigInt(parseU64Number(jr["purge_ready_at_seconds"], `${path}.reports[${i}].purge_ready_at_seconds`)),
    };
  });
}

/** valoper -> self-declared moniker from x/staking validators. */
export function parseMonikers(body: unknown, path = "$"): Map<string, string> {
  const o = expectObject(body, path);
  const map = new Map<string, string>();
  for (const v of expectArray(o["validators"], `${path}.validators`)) {
    const vo = expectObject(v, `${path}.validators[]`);
    const desc = expectObject(vo["description"], `${path}.validators[].description`);
    map.set(expectString(vo["operator_address"], `${path}.operator_address`), String(desc["moniker"] ?? ""));
  }
  return map;
}

/** valoper -> the program's delegated nhash from x/staking delegations. */
export function parseProgramDelegations(body: unknown, path = "$"): Map<string, bigint> {
  const o = expectObject(body, path);
  const map = new Map<string, bigint>();
  for (const d of expectArray(o["delegation_responses"], `${path}.delegation_responses`)) {
    const dr = expectObject(d, `${path}.delegation_responses[]`);
    const del = expectObject(dr["delegation"], `${path}.delegation`);
    const bal = expectObject(dr["balance"], `${path}.balance`);
    map.set(
      expectString(del["validator_address"], `${path}.delegation.validator_address`),
      parseUint128(bal["amount"], `${path}.balance.amount`),
    );
  }
  return map;
}

/** The epoch index that closed at a crank height (`data.snapshot.epoch_index`). */
export function epochIndexOf(data: unknown, path = "$"): bigint | null {
  const o = expectObject(data, path);
  const snap = o["snapshot"];
  if (snap === null || snap === undefined) return null;
  const s = expectObject(snap, `${path}.snapshot`);
  return BigInt(parseU64Number(s["epoch_index"], `${path}.snapshot.epoch_index`));
}

/** Ineligibility reasons derived from the status flags (the contract reports
 * `eligible` + the flags; §9.1 wants the reasons enumerated). Empty when
 * eligible. */
export function deriveFailingReasons(s: ValidatorStatus): string[] {
  const reasons: string[] = [];
  if (s.jailed) reasons.push("jailed");
  if (s.tombstoned) reasons.push("tombstoned");
  if (s.inArrears) reasons.push("arrears");
  if (s.headroom === 0n) reasons.push("no_concentration_headroom");
  if (!s.eligible && reasons.length === 0) reasons.push("ineligible");
  return reasons;
}
