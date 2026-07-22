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

import { envelope } from "@nvhash/api-types";
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

// Test-harness-only failure injection (classified toolingOnly): with
// NVHASH_MOCK_LIVE_DOWN=1 the two chrome live reads (vault `get`,
// `epoch_status`) return 503 while everything else (notably the `config`
// smart query the boot check needs) keeps working. This is how the e2e suite
// exercises the "program status unavailable" footer honestly (plan 4.1 §3).
const liveReadsDown = () => process.env.NVHASH_MOCK_LIVE_DOWN === "1";

export const handlers = [
  // services/api scaffold responses (PR 1.2 shape): enveloped, honest null
  // heights until M2.5/M3 wire real ones. Built with the same
  // @nvhash/api-types producers the real API uses, not hand-written shapes.
  // Tests exercising heights/lag/incidents override these with server.use().
  http.get("*/api/v1/status", () =>
    HttpResponse.json(
      envelope(
        { service: "nvhash-api", api_version: "v1", environment: "development", data_source: "unwired" },
        { source: "indexed" },
      ),
    ),
  ),
  http.get("*/api/v1/incidents", () =>
    HttpResponse.json(envelope([] as unknown[], { source: "indexed" })),
  ),

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
    if (key === "epoch_status" && liveReadsDown()) {
      return lcdError(503, "injected failure: NVHASH_MOCK_LIVE_DOWN");
    }
    return HttpResponse.json(fixture);
  }),

  // vault module REST (under /vault/v1 — pinned fact, app-spec §14.2)
  http.get("*/vault/v1/vaults", () => HttpResponse.json(vaultList)),
  http.get("*/vault/v1/params", () => HttpResponse.json(vaultParams)),
  http.get("*/vault/v1/vaults/:id", ({ params }) => {
    if (params["id"] !== FIXTURE_VAULT_ADDRESS) {
      return lcdError(404, `vault ${String(params["id"])} not found`);
    }
    if (liveReadsDown()) {
      return lcdError(503, "injected failure: NVHASH_MOCK_LIVE_DOWN");
    }
    return HttpResponse.json(vaultGet);
  }),
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
