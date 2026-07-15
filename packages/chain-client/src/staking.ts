// Typed reads for x/staking over LCD — the subset the App consumes
// (validator set context, the contract's program delegations).

import {
  expectArray,
  expectBoolean,
  expectObject,
  expectString,
  parseCoin,
  parseUint128,
  type Coin,
} from "./amounts.ts";
import { LcdClient, type QueryParams } from "./lcd.ts";
import { parsePagination, type Pagination } from "./types.ts";

export interface StakingValidator {
  operatorAddress: string;
  moniker: string;
  /** e.g. BOND_STATUS_BONDED */
  status: string;
  jailed: boolean;
  /** bonded tokens in base units */
  tokens: bigint;
  /** decimal string, e.g. "0.100000000000000000" — rate math is render-side */
  commissionRate: string;
}

export interface Delegation {
  delegatorAddress: string;
  validatorAddress: string;
  balance: Coin;
}

export function parseStakingValidator(value: unknown, path = "$"): StakingValidator {
  const o = expectObject(value, path);
  const desc = expectObject(o["description"] ?? {}, `${path}.description`);
  const comm = expectObject(o["commission"] ?? {}, `${path}.commission`);
  const rates = expectObject(comm["commission_rates"] ?? {}, `${path}.commission.commission_rates`);
  return {
    operatorAddress: expectString(o["operator_address"], `${path}.operator_address`),
    moniker: expectString(desc["moniker"] ?? "", `${path}.description.moniker`),
    status: expectString(o["status"], `${path}.status`),
    jailed: expectBoolean(o["jailed"] ?? false, `${path}.jailed`),
    tokens: parseUint128(o["tokens"], `${path}.tokens`),
    commissionRate: expectString(rates["rate"] ?? "", `${path}.commission.commission_rates.rate`),
  };
}

export class StakingClient {
  constructor(private readonly lcd: LcdClient) {}

  async validators(params?: QueryParams): Promise<{ validators: StakingValidator[]; pagination: Pagination }> {
    const o = expectObject(await this.lcd.get("cosmos/staking/v1beta1/validators", params));
    return {
      validators: expectArray(o["validators"], "$.validators").map((v, i) =>
        parseStakingValidator(v, `$.validators[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }

  async delegations(delegator: string): Promise<{ delegations: Delegation[]; pagination: Pagination }> {
    const o = expectObject(await this.lcd.get(`cosmos/staking/v1beta1/delegations/${delegator}`));
    return {
      delegations: expectArray(o["delegation_responses"], "$.delegation_responses").map((r, i) => {
        const entry = expectObject(r, `$.delegation_responses[${i}]`);
        const d = expectObject(entry["delegation"], `$.delegation_responses[${i}].delegation`);
        return {
          delegatorAddress: expectString(d["delegator_address"], `$[${i}].delegator_address`),
          validatorAddress: expectString(d["validator_address"], `$[${i}].validator_address`),
          balance: parseCoin(entry["balance"], `$[${i}].balance`),
        };
      }),
      pagination: parsePagination(o["pagination"]),
    };
  }
}
