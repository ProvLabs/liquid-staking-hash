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
  // PR 4.2 tranche 1: the frozen /metrics and /epochs scaffold shapes
  // (@nvhash/api-types ProgramMetrics / EpochRow[]), honest nulls/empty
  // exactly like the services/api scaffold routes they mirror.
  http.get("*/api/v1/metrics", () =>
    HttpResponse.json(
      envelope(
        { participant_count: null, program_started_at: null, epoch_count: null },
        { source: "indexed" },
      ),
    ),
  ),
  http.get("*/api/v1/epochs", () =>
    HttpResponse.json(envelope([] as unknown[], { source: "indexed" })),
  ),
  // PR 5.4 /redemptions/stats — honest cold-start (§14.12): no data, no
  // completed epoch → null stats, the guarantee-alone state. Band bounds
  // ride as data. Tests exercising the sample-sufficient path override this.
  http.get("*/api/v1/redemptions/stats", () =>
    HttpResponse.json(
      envelope(
        {
          sample_count: 0,
          median_seconds: null,
          p90_seconds: null,
          band_floor_seconds: 21 * 24 * 60 * 60,
          band_ceiling_seconds: 60 * 24 * 60 * 60,
          cold_start: true,
        },
        { source: "indexed" },
      ),
    ),
  ),
  // PR 5.4 address-scoped reads the redemption tracker composes. Honest-empty
  // by default (no session in offline e2e); tests override with populated data.
  http.get("*/api/v1/portfolio", ({ request }) =>
    HttpResponse.json(
      envelope(
        {
          address: new URL(request.url).searchParams.get("address") ?? "",
          first_activity_at: null,
          transaction_count: 0,
          escrowed_shares: "0",
          active_redemptions: [],
        },
        { source: "indexed" },
      ),
    ),
  ),
  http.get("*/api/v1/transactions", () =>
    HttpResponse.json(envelope([] as unknown[], { source: "indexed" })),
  ),
  // PR 3.2's /market shape (MarketSummary), honest-empty exactly as the real
  // route serves with the sampler parked: no sample, no bridged supply.
  http.get("*/api/v1/market", () =>
    HttpResponse.json(
      envelope({ sample: null, bridged_supply: [] }, { source: "indexed" }),
    ),
  ),
  // PR 3.1's /validators shape (ValidatorsPayload), honest-empty exactly as
  // the real route serves with no reader wired.
  http.get("*/api/v1/validators", () =>
    HttpResponse.json(
      envelope(
        { validators: [], set_health: { total: 0, active: 0, eligible: 0, in_arrears: 0 } },
        { source: "indexed" },
      ),
    ),
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

  // PR 5.2 tx-lifecycle surfaces. The corpus has no auth/bank/simulate
  // captures, so the defaults answer as a real LCD does for state that does
  // not exist — a 404 account, empty balances, and tx endpoints that refuse
  // (a mock must not fabricate gas or an inclusion). Tests exercising the
  // lifecycle override these with server.use() (the roles-test pattern).
  http.get("*/cosmos/auth/v1beta1/accounts/:address", () =>
    lcdError(404, "account not found"),
  ),
  http.get("*/cosmos/bank/v1beta1/spendable_balances/:address", () =>
    HttpResponse.json({ balances: [], pagination: { next_key: null, total: "0" } }),
  ),
  http.get("*/cosmos/bank/v1beta1/balances/:address/by_denom", ({ request }) =>
    HttpResponse.json({
      balance: { denom: new URL(request.url).searchParams.get("denom") ?? "nhash", amount: "0" },
    }),
  ),
  http.post("*/cosmos/tx/v1beta1/simulate", () =>
    lcdError(400, "mock: simulation requires a live chain"),
  ),
  http.post("*/cosmos/tx/v1beta1/txs", () =>
    lcdError(400, "mock: broadcast requires a live chain"),
  ),
  http.get("*/cosmos/tx/v1beta1/txs/:hash", () => lcdError(404, "tx not found")),
];
