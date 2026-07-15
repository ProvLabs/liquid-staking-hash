// MSW harness over the PR 0.2 devnet fixture corpus (@nvhash/fixtures) —
// verbatim captured LCD responses, never hand-written shapes. This is how the
// web lane builds and tests offline (plan §3): Vitest uses it via mocks/node,
// and the dev/e2e server enables it with NVHASH_MOCK=1 (entry.server).
//
// Coverage mirrors what @nvhash/chain-client can read over LCD REST. Two
// corpus fixtures are deliberately NOT mocked: `estimate-swap-in` (gRPC/CLI
// only — a REST mock would fabricate a transport the chain does not serve;
// pinned fact, app-spec §14.2) and `payments` (no REST consumer in the client
// yet; wire it with the PR that reads it).
//
// Handlers pin the manifest's contract/vault addresses: a query for an
// address the corpus was not captured from is a 404/error, like the real LCD
// — mocks must not invent state (SECURITY.md: never lie about state).

import { http, HttpResponse } from "msw";

import manifest from "@nvhash/fixtures/manifest";
import contractApr from "@nvhash/fixtures/queries/contract/apr";
import contractConfig from "@nvhash/fixtures/queries/contract/config";
import contractEpochSnapshot from "@nvhash/fixtures/queries/contract/epoch-snapshot";
import contractEpochStatus from "@nvhash/fixtures/queries/contract/epoch-status";
import contractJailReports from "@nvhash/fixtures/queries/contract/jail-reports";
import contractValidators from "@nvhash/fixtures/queries/contract/validators";
import groupGroups from "@nvhash/fixtures/queries/group/groups";
import stakingDelegations from "@nvhash/fixtures/queries/staking/delegations";
import stakingValidators from "@nvhash/fixtures/queries/staking/validators";
import vaultEstimateSwapOut from "@nvhash/fixtures/queries/vault/estimate-swap-out";
import vaultGet from "@nvhash/fixtures/queries/vault/get";
import vaultList from "@nvhash/fixtures/queries/vault/list";
import vaultParams from "@nvhash/fixtures/queries/vault/params";
import vaultPendingSwapOuts from "@nvhash/fixtures/queries/vault/pending-swap-outs";

export const FIXTURE_CHAIN_ID: string = manifest.chain_id;
export const FIXTURE_CONTRACT_ADDRESS: string = manifest.contract;
export const FIXTURE_VAULT_ADDRESS: string = manifest.vault;

/** Contract smart queries by their single top-level key (contract msg.rs). */
const smartQueryFixtures: Record<string, unknown> = {
  config: contractConfig,
  epoch_status: contractEpochStatus,
  epoch_snapshot: contractEpochSnapshot,
  apr: contractApr,
  validators: contractValidators,
  jail_reports: contractJailReports,
};

function lcdError(status: number, message: string) {
  return HttpResponse.json({ code: 2, message, details: [] }, { status });
}

export const handlers = [
  // /cosmwasm/wasm/v1/contract/{addr}/smart/{base64(query)}
  http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
    if (params["address"] !== FIXTURE_CONTRACT_ADDRESS) {
      return lcdError(404, `contract: not found: ${String(params["address"])}`);
    }
    let key: string | undefined;
    try {
      const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
      key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
    } catch {
      return lcdError(400, "invalid query: not base64 JSON");
    }
    const fixture = key === undefined ? undefined : smartQueryFixtures[key];
    if (fixture === undefined) {
      return lcdError(400, `unknown variant \`${String(key)}\`: query wasm contract failed`);
    }
    return HttpResponse.json(fixture);
  }),

  // vault module REST (under /vault/v1 — pinned fact, app-spec §14.2)
  http.get("*/vault/v1/vaults", () => HttpResponse.json(vaultList)),
  http.get("*/vault/v1/params", () => HttpResponse.json(vaultParams)),
  http.get("*/vault/v1/vaults/:id", ({ params }) =>
    params["id"] === FIXTURE_VAULT_ADDRESS
      ? HttpResponse.json(vaultGet)
      : lcdError(404, `vault ${String(params["id"])} not found`),
  ),
  http.get("*/vault/v1/vaults/:id/pending_swap_outs", ({ params }) =>
    params["id"] === FIXTURE_VAULT_ADDRESS
      ? HttpResponse.json(vaultPendingSwapOuts)
      : lcdError(404, `vault ${String(params["id"])} not found`),
  ),
  http.get("*/vault/v1/vaults/:id/estimate_swap_out", ({ params }) =>
    params["id"] === FIXTURE_VAULT_ADDRESS
      ? HttpResponse.json(vaultEstimateSwapOut)
      : lcdError(404, `vault ${String(params["id"])} not found`),
  ),

  // x/staking and x/group
  http.get("*/cosmos/staking/v1beta1/validators", () => HttpResponse.json(stakingValidators)),
  http.get("*/cosmos/staking/v1beta1/delegations/:delegator", () =>
    HttpResponse.json(stakingDelegations),
  ),
  http.get("*/cosmos/group/v1/groups", () => HttpResponse.json(groupGroups)),
];
