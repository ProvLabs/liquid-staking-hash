// MSW harness over the devnet fixture corpus (@nvhash/fixtures) —
// verbatim captured LCD responses, never hand-written shapes. This is how the
// web lane builds and tests offline: Vitest uses it via mocks/node,
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
import groupInfo from "@nvhash/fixtures/queries/group/group-info";
import groupMembers from "@nvhash/fixtures/queries/group/group-members";
import groupPoliciesByGroup from "@nvhash/fixtures/queries/group/group-policies-by-group";
import groupProposalsByPolicy from "@nvhash/fixtures/queries/group/proposals-by-group-policy";
import groupVotesClosed from "@nvhash/fixtures/queries/group/votes-by-proposal-closed";
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

// ── x/group: the live plane, and a mirror derived from it (/) ─────
//
// Every row below is DERIVED from the captured corpus rather than authored. The
// mirror's shape is the indexer's output, so a hand-written proposal here would
// let the offline suite pass against a shape `services/indexer` cannot produce.

interface ChainProposal {
  id: string;
  group_policy_address: string;
  proposers: string[];
  metadata: string;
  submit_time: string;
  voting_period_end: string;
  group_version: string;
  group_policy_version: string;
  status: string;
  executor_result: string;
  final_tally_result: { yes_count: string; abstain_count: string; no_count: string; no_with_veto_count: string };
  messages: unknown[];
  title: string;
  summary: string;
}

const GROUP_ID: string = (groupInfo as { info: { id: string } }).info.id;
const GROUP_POLICIES = (groupPoliciesByGroup as { group_policies: { address: string }[] })
  .group_policies;
const SWEEP = groupProposalsByPolicy as { proposals: ChainProposal[] };
/** The policy whose proposal sweep the corpus captured. */
const PROPOSALS_POLICY_ADDRESS: string = SWEEP.proposals[0]?.group_policy_address ?? "";

/** Proposals the chain still holds, per the captured sweep. */
const CHAIN_PROPOSALS: ChainProposal[] = SWEEP.proposals;

/**
 * AS-OF stamp for the mirrored rows: the height and time of the 2026-07-29
 * governance capture (`manifest.partial_captures`), so the freshness the page
 * renders offline is the freshness the corpus actually has.
 */
const GOV_OBSERVED_HEIGHT = 302;
const GOV_OBSERVED_AT = "2026-07-29T23:32:10.000Z";
/** The stream start height D13 fixes at 1. */
const GOV_INDEXED_FROM_HEIGHT = 1;

const WIRE_STATUS: Record<string, string> = {
  PROPOSAL_STATUS_SUBMITTED: "submitted",
  PROPOSAL_STATUS_ACCEPTED: "accepted",
  PROPOSAL_STATUS_REJECTED: "rejected",
  PROPOSAL_STATUS_ABORTED: "aborted",
  PROPOSAL_STATUS_WITHDRAWN: "withdrawn",
};
const WIRE_EXECUTOR: Record<string, string> = {
  PROPOSAL_EXECUTOR_RESULT_NOT_RUN: "not_run",
  PROPOSAL_EXECUTOR_RESULT_SUCCESS: "success",
  PROPOSAL_EXECUTOR_RESULT_FAILURE: "failure",
};

/** The decision rule snapshot the indexer stamps on a proposal at submit. */
function policySnapshot(address: string): Record<string, unknown> {
  const policy = (
    groupPoliciesByGroup as {
      group_policies: {
        address: string;
        decision_policy: { threshold?: string; windows?: { voting_period: string; min_execution_period: string } };
      }[];
    }
  ).group_policies.find((p) => p.address === address);
  return {
    kind: "threshold",
    threshold: policy?.decision_policy.threshold ?? "1",
    voting_period: policy?.decision_policy.windows?.voting_period ?? "0s",
    min_execution_period: policy?.decision_policy.windows?.min_execution_period ?? "0s",
  };
}

function mirrorRow(p: ChainProposal, overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: p.id,
    group_policy_address: p.group_policy_address,
    group_id: GROUP_ID,
    proposers: p.proposers,
    status: WIRE_STATUS[p.status] ?? "unspecified",
    executor_result: WIRE_EXECUTOR[p.executor_result] ?? "unspecified",
    title: p.title,
    summary: p.summary,
    metadata: p.metadata === "" ? null : p.metadata,
    tally: {
      yes: p.final_tally_result.yes_count,
      no: p.final_tally_result.no_count,
      abstain: p.final_tally_result.abstain_count,
      no_with_veto: p.final_tally_result.no_with_veto_count,
    },
    decision_policy: policySnapshot(p.group_policy_address),
    submit_time: p.submit_time,
    voting_period_end: p.voting_period_end,
    group_version: p.group_version,
    group_policy_version: p.group_policy_version,
    observed_height: GOV_OBSERVED_HEIGHT,
    observed_at: GOV_OBSERVED_AT,
    height: null,
    txhash: null,
    pruned_at_height: null,
    messages_truncated: false,
    proposers_truncated: false,
    messages: p.messages,
    ...overrides,
  };
}

/**
 * The mirrored proposal set the offline server serves.
 *
 * The swept proposals plus ONE pruned row. That row is the honest edge of this
 * mock and is marked as such: the corpus has no mirrored row for a pruned
 * proposal — a proposal pruned before the capture was never swept — and its only
 * captured trace is the `EventProposalPruned` in
 * `fixtures/governance/proposal-pruned-block.json`, which carries the id, the
 * terminal status (`WITHDRAWN`) and the prune height (288) and nothing else. So
 * the row below carries exactly those three facts and the mirror's honest empty
 * values for everything the event does not have, and `e2e/governance.spec.ts`
 * asserts only the prune LABEL against it.
 */
const PRUNED_ROW = {
  ...mirrorRow(
    {
      id: "7",
      group_policy_address: PROPOSALS_POLICY_ADDRESS,
      proposers: [],
      metadata: "",
      submit_time: GOV_OBSERVED_AT,
      voting_period_end: GOV_OBSERVED_AT,
      group_version: "1",
      group_policy_version: "1",
      status: "PROPOSAL_STATUS_WITHDRAWN",
      executor_result: "PROPOSAL_EXECUTOR_RESULT_NOT_RUN",
      final_tally_result: { yes_count: "0", abstain_count: "0", no_count: "0", no_with_veto_count: "0" },
      messages: [],
      title: "drill-withdraw",
      summary: "",
    },
    { pruned_at_height: 288, observed_height: 288 },
  ),
};

const GOV_MIRROR_ROWS = [...CHAIN_PROPOSALS.map((p) => mirrorRow(p)), PRUNED_ROW];

const GOV_MIRROR_POLICIES = [
  {
    address: PROPOSALS_POLICY_ADDRESS,
    group_id: GROUP_ID,
    proposal_count: GOV_MIRROR_ROWS.length,
    last_seen_height: GOV_OBSERVED_HEIGHT,
    decision_policy: policySnapshot(PROPOSALS_POLICY_ADDRESS),
  },
];

// Test-harness-only failure injection (classified toolingOnly): with
// NVHASH_MOCK_LIVE_DOWN=1 the two chrome live reads (vault `get`,
// `epoch_status`) return 503 while everything else (notably the `config`
// smart query the boot check needs) keeps working. This is how the e2e suite
// exercises the "program status unavailable" footer honestly.
const liveReadsDown = () => process.env.NVHASH_MOCK_LIVE_DOWN === "1";

export const handlers = [
  // services/api scaffold responses (shape): enveloped, honest null
  // heights until the reconciler and API wire real ones. Built with the same
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
  // The frozen /metrics and /epochs scaffold shapes
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
  // /redemptions/stats — honest cold-start (§14.12): no data, no
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
  // Address-scoped reads the redemption tracker composes. Honest-empty
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
  // The /market shape (MarketSummary), honest-empty exactly as the real
  // route serves with the sampler parked: no sample, no bridged supply.
  http.get("*/api/v1/market", () =>
    HttpResponse.json(
      envelope({ sample: null, bridged_supply: [] }, { source: "indexed" }),
    ),
  ),
  // Personal surfaces (/portfolio, /portfolio/metrics, /transactions):
  // honest-empty defaults mirroring the services/api empty payloads (reader
  // stub + derivePortfolioMetrics over an empty history). Auth-agnostic (match
  // by path); tests exercising populated positions override with server.use().
  // The CSV branch is deliberately unmocked: the export proxy is covered by
  // its own stubbed-fetch unit test, not MSW.
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
  http.get("*/api/v1/portfolio/metrics", ({ request }) =>
    HttpResponse.json(
      envelope(
        {
          address: new URL(request.url).searchParams.get("address") ?? "",
          history_state: "complete" as const,
          indexed_share_balance: "0",
          escrowed_share_balance: "0",
          cost_basis_nhash: "0",
          escrowed_basis_nhash: "0",
          realized_gain_nhash: "0",
          effective_apr_bps: null,
          yield_by_epoch: [],
          yield_truncated: false,
          accrual: [],
          accrual_truncated: false,
          accrual_markers: [],
          markers_truncated: false,
        },
        { source: "indexed" },
      ),
    ),
  ),
  http.get("*/api/v1/transactions", () =>
    HttpResponse.json(envelope([] as unknown[], { source: "indexed" })),
  ),
  // Operator surface (/operator/{summary,epochs,payments}): honest-empty
  // defaults mirroring what services/api serves for an address that operates
  // no validator — which is also what the offline e2e (no session) sees. Tests
  // exercising a real operator override with server.use(). The CSV branch is
  // deliberately unmocked, like the portfolio export: the proxy has its own
  // stubbed-fetch unit test.
  http.get("*/api/v1/operator/summary", ({ request }) =>
    HttpResponse.json(
      envelope(
        { address: new URL(request.url).searchParams.get("address") ?? "", validators: [] },
        { source: "indexed" },
      ),
    ),
  ),
  http.get("*/api/v1/operator/epochs", () =>
    HttpResponse.json(envelope([] as unknown[], { source: "indexed" })),
  ),
  http.get("*/api/v1/operator/payments", () =>
    HttpResponse.json(envelope([] as unknown[], { source: "indexed" })),
  ),
  // The /validators shape (ValidatorsPayload), honest-empty exactly as
  // the real route serves with no reader wired.
  http.get("*/api/v1/validators", () =>
    HttpResponse.json(
      envelope(
        { validators: [], set_health: { total: 0, active: 0, eligible: 0, in_arrears: 0 } },
        { source: "indexed" },
      ),
    ),
  ),

  // Governance mirror (/governance/{proposals,proposal,policies}). The
  // rows are DERIVED FROM THE CAPTURED PROPOSALS (`GOV_MIRROR_ROWS` below), not
  // hand-written: the mirror's job is to hold what the chain held, so a mock
  // that invented proposals would exercise shapes the indexer can never produce.
  http.get("*/api/v1/governance/proposals", ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const rows = status === null ? GOV_MIRROR_ROWS : GOV_MIRROR_ROWS.filter((r) => r.status === status);
    return HttpResponse.json(
      envelope(
        { proposals: rows, indexed_from_height: GOV_INDEXED_FROM_HEIGHT },
        { source: "indexed" },
      ),
    );
  }),
  http.get("*/api/v1/governance/proposal", ({ request }) => {
    const id = new URL(request.url).searchParams.get("id");
    const proposal = GOV_MIRROR_ROWS.find((r) => r.proposal_id === id);
    // A 404 for an id the mirror has never seen — the real route's answer, and
    // NOT an empty 200: "no record of this id" and "exists and is empty" are
    // different answers, and conflating them makes a typo look like a proposal.
    if (proposal === undefined) {
      return HttpResponse.json({ error: "not_found" }, { status: 404 });
    }
    return HttpResponse.json(
      envelope({ proposal, votes: [], votes_truncated: false }, { source: "indexed" }),
    );
  }),
  http.get("*/api/v1/governance/policies", () =>
    HttpResponse.json(envelope(GOV_MIRROR_POLICIES, { source: "indexed" })),
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
  // The x/group reads the governance center's LIVE plane makes.
  //
  // `group_policy_info` answers 404 for anything that is not one of the two
  // captured POLICY addresses — and the corpus's contract admin is a plain
  // account, so offline the live plane correctly resolves to "this deployment's
  // admin is not a group policy" (R1). That is a property of the
  // corpus, not a gap in the mock: the contract was deployed before the group
  // existed and has no admin-rotation message (M7 overview F2). Tests that need
  // the governed plane override this handler, the roles-test pattern.
  http.get("*/cosmos/group/v1/group_policy_info/:address", ({ params }) => {
    const address = String(params["address"]);
    const policy = GROUP_POLICIES.find((p) => p.address === address);
    return policy === undefined
      ? lcdError(404, `group policy: not found: ${address}`)
      : HttpResponse.json({ info: policy });
  }),
  http.get("*/cosmos/group/v1/group_info/:groupId", ({ params }) =>
    String(params["groupId"]) === GROUP_ID
      ? HttpResponse.json(groupInfo)
      : lcdError(404, `group: not found: ${String(params["groupId"])}`),
  ),
  http.get("*/cosmos/group/v1/group_members/:groupId", ({ params }) =>
    String(params["groupId"]) === GROUP_ID
      ? HttpResponse.json(groupMembers)
      : lcdError(404, `group: not found: ${String(params["groupId"])}`),
  ),
  http.get("*/cosmos/group/v1/group_policies_by_group/:groupId", ({ params }) =>
    String(params["groupId"]) === GROUP_ID
      ? HttpResponse.json(groupPoliciesByGroup)
      : lcdError(404, `group: not found: ${String(params["groupId"])}`),
  ),
  http.get("*/cosmos/group/v1/proposals_by_group_policy/:address", ({ params }) =>
    String(params["address"]) === PROPOSALS_POLICY_ADDRESS
      ? HttpResponse.json(groupProposalsByPolicy)
      : HttpResponse.json({ proposals: [], pagination: { next_key: null, total: "0" } }),
  ),
  // A missing proposal answers HTTP 500 with a body identical for a pruned id,
  // a never-existing id and a node outage (pinned fact, 2026-07-29). The mock
  // reproduces that ambiguity deliberately: a consumer that reads a failure here
  // as "pruned" must fail its tests, not pass them.
  http.get("*/cosmos/group/v1/proposal/:proposalId", ({ params }) => {
    const proposal = CHAIN_PROPOSALS.find((p) => p.id === String(params["proposalId"]));
    return proposal === undefined
      ? lcdError(500, "codespace sdk code 38: not found: load proposal")
      : HttpResponse.json({ proposal });
  }),
  // Votes: the corpus captured an EMPTY list, because the module deletes votes
  // at the voting-period-end tally. An empty read is never "nobody voted".
  http.get("*/cosmos/group/v1/votes_by_proposal/:proposalId", () =>
    HttpResponse.json(groupVotesClosed),
  ),
  // The live tally read. Unpinned by the corpus (it postdates the capture), so
  // the mock serves the proposal's own captured `final_tally_result` — which for
  // the open proposals is all zeros, exactly as the chain holds it.
  http.get("*/cosmos/group/v1/proposals/:proposalId/tally", ({ params }) => {
    const proposal = CHAIN_PROPOSALS.find((p) => p.id === String(params["proposalId"]));
    return proposal === undefined
      ? lcdError(500, "codespace sdk code 38: not found: load proposal")
      : HttpResponse.json({ tally: proposal.final_tally_result });
  }),

  // Tx-lifecycle surfaces. The corpus has no auth/bank/simulate
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
