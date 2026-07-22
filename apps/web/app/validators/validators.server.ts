// Validators-page data assembly (plan 4.3 §2 tranche 2; app-spec §8.6 public
// view, §12.1). Live reads answer "who is staking your HASH and are they
// reliable": the contract's validator set joined with x/staking monikers and
// the program's delegations; the indexed plane serves the set-health trend.
//
// Honesty rules, gated by test/validators-data.test.ts:
// - The contract validators read failing nulls `rows` (the page renders the
//   unavailable state); a failed staking or delegation read degrades ONLY the
//   moniker/delegation fields of each row, never the row.
// - `uptimeBps: null` (no capture yet) renders "n/a", never a number.
// - Operator economics (commission, TIP, headroom, arrears) are never
//   projected into the client-crossing row (§8.6 keeps them for the operator
//   view); the gating test asserts the closed key set.

import {
  LcdClient,
  NvhashContractClient,
  StakingClient,
  type FetchLike,
} from "@nvhash/chain-client";

import { fetchApiJson, validatorsEnvelopeSchema } from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { bpsToPercent, formatHashCompact } from "~/learn/amounts";
import type { ValidatorRow, ValidatorsData } from "./types";

export type { ValidatorRow, ValidatorsData } from "./types";

export interface ValidatorsReadOptions {
  fetchImpl?: FetchLike;
}

/** Assemble the validators page's data for one request. Never throws. */
export async function loadValidatorsData(
  config: WebConfig,
  options: ValidatorsReadOptions = {},
): Promise<ValidatorsData> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, { fetchImpl, timeoutMs: CHROME_READ_TIMEOUT_MS });
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  const staking = new StakingClient(lcd);
  const apiBase = config.apiUrl.replace(/\/+$/, "");

  const [programValidators, contractConfig, stakingSet, delegations, snapshot, indexedSet] =
    await Promise.all([
      contract.validators().catch(() => null),
      contract.config().catch(() => null),
      staking.validators().catch(() => null),
      // The program's stake is delegated by the asset-manager contract (the
      // fixture corpus captures the delegator as the contract address).
      staking.delegations(config.contractAddress).catch(() => null),
      contract.epochSnapshot().catch(() => null),
      fetchApiJson(`${apiBase}/api/v1/validators`, fetchImpl, CHROME_READ_TIMEOUT_MS)
        .then((body) => validatorsEnvelopeSchema.parse(body))
        .catch(() => null),
    ]);

  const monikerByValoper = new Map(
    (stakingSet?.validators ?? []).map((v) => [v.operatorAddress, v.moniker] as const),
  );
  const delegationByValoper = new Map(
    (delegations?.delegations ?? []).map((d) => [d.validatorAddress, d.balance.amount] as const),
  );
  // The §8.6 threshold comparison needs the live config; if that read failed
  // the whole set read is not trustworthy enough to rank, so degrade rows.
  const thresholdBps = contractConfig?.performanceThresholdBps ?? null;

  const rows: ValidatorRow[] | null =
    programValidators === null || thresholdBps === null
      ? null
      : programValidators.map((v) => ({
          valoper: v.valoper,
          moniker: monikerByValoper.get(v.valoper) ?? null,
          eligible: v.eligible,
          jailed: v.jailed,
          tombstoned: v.tombstoned,
          uptimePercent:
            v.uptimeBps !== null && Number.isSafeInteger(v.uptimeBps)
              ? bpsToPercent(v.uptimeBps)
              : null,
          thresholdPercent: bpsToPercent(thresholdBps),
          programDelegation: (() => {
            const amount = delegationByValoper.get(v.valoper);
            return amount === undefined ? null : formatHashCompact(amount);
          })(),
          enrolledAt: new Date(v.enrolledAtSeconds * 1_000).toISOString(),
        }));

  return {
    rows,
    eligibleCount: snapshot?.eligibleCount ?? null,
    // Project ONLY the public aggregates (§8.6): the API's per-validator rows
    // and the in_arrears count stay server-side — the live table is this
    // page's per-validator source, and operator economics never cross, even
    // aggregated (gated by test/validators-data.test.ts).
    setHealth:
      indexedSet === null
        ? null
        : {
            data: {
              total: indexedSet.data.set_health.total,
              active: indexedSet.data.set_health.active,
              eligible: indexedSet.data.set_health.eligible,
            },
            meta: indexedSet.meta,
          },
  };
}
