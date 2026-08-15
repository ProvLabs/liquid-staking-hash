// Mock fixtures for every query (spec §15.2): the console builds and renders fully
// offline. Numbers are internally consistent so the receipt invariant and epoch
// identity checks PASS (they are the honesty surface, spec §17.1).
import type {
  AprResponse,
  ConfigResponse,
  DeploymentSplit,
  EpochSnapshot,
  EpochStatusResponse,
  JailReportsResponse,
  LedgerRow,
  PendingSwapOut,
  ValidatorsResponse,
  VaultInfo,
} from "@/lib/types";
import type { GovProposals, GovTopology } from "@/lib/governance";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const HASH = 1_000_000_000n; // 1 HASH in nhash
const h = (n: number): string => (BigInt(n) * HASH).toString();

export const ADMIN_ADDR = "pb1adminadminadminadminadminadminadmin00";
export const PAT_OPERATOR = "pb1operatoroperatoroperatoroperatorop000";
const VAULT_ADDR = "pb1vaultvaultvaultvaultvaultvaultvault000";
const MARKER_ADDR = "pb1markerprincipalmarkerprincipalmarker00";

export const mockConfig: ConfigResponse = {
  admin: ADMIN_ADDR,
  vault_address: VAULT_ADDR,
  underlying_denom: "nhash",
  receipt_denom: "nvhash.staked",
  max_delegations_per_run: 10,
  aum_fee_bps: 25,
  performance_threshold_bps: 9500,
  min_capture_interval_secs: 3600,
  max_concentration_multiple_bps: 55000,
  min_bonded_cap_bps: 500,
  max_bonded_cap_bps: 3300,
  concentration_safety_offset_bps: 500,
  commission_bps: 1000,
  jail_unbond_delay_secs: 8 * 3600,
  redemption_margin_bps: 50,
};

export const mockEpochStatus: EpochStatusResponse = {
  phase: "Idle",
  halted: false,
  last_run_seconds: NOW - 3 * DAY - 2 * 3600,
  receipt_minted: h(12_320_000),
  pending_delegations: [],
  pending_redelegations: [],
};

export const mockVault: VaultInfo = {
  total_vault_value: h(12_400_000),
  total_shares: "11886000000000000000000", // NAV ~= 1.0432
  paused: false,
  withdrawal_delay_seconds: 60 * DAY,
  principal_marker_address: MARKER_ADDR,
  principal_liquid_nhash: h(80_000),
};

export const mockDeployment: DeploymentSplit = {
  delegated: h(12_000_000),
  unbonding: h(300_000),
  liquid: h(80_000),
  pending: h(20_000),
};

export const mockSnapshot: EpochSnapshot = {
  epoch_index: 14,
  started_at_seconds: NOW - 6 * DAY,
  ended_at_seconds: NOW - 3 * DAY,
  end_height: 1_842_991,
  tvv_before: h(12_397_824),
  tvv_after: h(12_400_000),
  total_shares: "11886000000000000000000",
  rewards_claimed: h(2_140),
  commission_received: h(214),
  tips_received: h(50),
  rewards_deposited: h(2_176),
  settled: h(0),
  write_down: h(0),
  deployed: h(1_800),
  rebalanced: h(420),
  unbonded_for_redemptions: h(0),
  redemptions_expedited: 2,
  validators_purged: 0,
  eligible_count: 3,
  aum_fee_estimate: h(38),
  net_deposits: h(0),
};

export const mockApr: AprResponse = {
  epoch_index: 14,
  window_seconds: 3 * DAY,
  tvv_before: h(12_397_824),
  rewards_claimed: h(2_140),
  commission_received: h(214),
  tips_received: h(50),
  aum_fee_estimate: h(38),
  write_down: h(0),
  gross_apr_bps: 902,
  net_apr_bps: 841,
};

export const mockValidators: ValidatorsResponse = {
  validators: [
    {
      valoper: "pbvaloper1alphaalphaalphaalphaalphaalpha00",
      operator: "pb1alphaoperatoralphaoperatoralphaop00000",
      enrolled_at_seconds: NOW - 220 * DAY,
      uptime_capture_count: 42,
      uptime_bps: 9920,
      jailed: false,
      tombstoned: false,
      tip_epoch: h(500),
      commission_accrued: h(1_240),
      commission_paid: h(1_240),
      commission_due: h(1_240),
      in_arrears: false,
      eligible: true,
      headroom: h(40_000),
    },
    {
      valoper: "pbvaloper1bravobravobravobravobravobravo0",
      operator: PAT_OPERATOR,
      enrolled_at_seconds: NOW - 180 * DAY,
      uptime_capture_count: 40,
      uptime_bps: 9870,
      jailed: false,
      tombstoned: false,
      tip_epoch: h(0),
      commission_accrued: h(880),
      commission_paid: h(880),
      commission_due: h(880),
      in_arrears: false,
      eligible: true,
      headroom: h(120_000),
    },
    {
      valoper: "pbvaloper1charliecharliecharliecharlie000",
      operator: "pb1charlieopcharlieopcharlieopcharlie0000",
      enrolled_at_seconds: NOW - 90 * DAY,
      uptime_capture_count: 38,
      uptime_bps: 9750,
      jailed: false,
      tombstoned: false,
      tip_epoch: h(0),
      commission_accrued: h(300),
      commission_paid: h(180),
      commission_due: h(300),
      in_arrears: true,
      eligible: false,
      headroom: h(0),
    },
    {
      valoper: "pbvaloper1deltadeltadeltadeltadeltadelta0",
      operator: "pb1deltaopdeltaopdeltaopdeltaopdelta00000",
      enrolled_at_seconds: NOW - 60 * DAY,
      uptime_capture_count: 0,
      uptime_bps: null,
      jailed: true,
      tombstoned: false,
      tip_epoch: h(0),
      commission_accrued: h(120),
      commission_paid: h(120),
      commission_due: h(120),
      in_arrears: false,
      eligible: false,
      headroom: h(0),
    },
    {
      valoper: "pbvaloper1echoechoechoechoechoechoecho000",
      operator: "pb1echooperatorechooperatorechooper000000",
      enrolled_at_seconds: NOW - 12 * DAY,
      uptime_capture_count: 8,
      uptime_bps: 9990,
      jailed: false,
      tombstoned: false,
      tip_epoch: h(0),
      commission_accrued: h(40),
      commission_paid: h(40),
      commission_due: h(40),
      in_arrears: false,
      eligible: true,
      headroom: h(200_000),
    },
  ],
};

export const mockJailReports: JailReportsResponse = {
  reports: [
    {
      valoper: "pbvaloper1deltadeltadeltadeltadeltadelta0",
      reported_at_seconds: NOW - 2 * 3600,
      purge_ready_at_seconds: NOW + 6 * 3600,
    },
  ],
};

export const mockSwapOuts: PendingSwapOut[] = [
  {
    id: 101,
    owner: PAT_OPERATOR,
    shares: "480000000000000000000",
    estimate_nhash: h(50_000),
    matures_at_seconds: NOW + 55 * DAY,
  },
  {
    id: 102,
    owner: "pb1holderaholderaholderaholderaholdera000",
    shares: "240000000000000000000",
    estimate_nhash: h(25_000),
    matures_at_seconds: NOW + 58 * DAY,
  },
  {
    id: 103,
    owner: "pb1holderbholderbholderbholderbholderb000",
    shares: "120000000000000000000",
    estimate_nhash: h(12_500),
    matures_at_seconds: NOW - 3600,
  },
];

// A 14-epoch ledger history for the trend charts, deterministic (no Math.random).
export const mockLedger: LedgerRow[] = Array.from({ length: 14 }, (_, i) => {
  const idx = i + 1;
  const navBps = 10000 + i * 32; // NAV drifts up ~0.32% per epoch
  const tvvBefore = 8_000_000 + i * 320_000;
  const rewards = 1_800 + ((i * 37) % 500);
  const netDep = ((i % 4) - 1) * 40_000; // some negative (net redemption) epochs
  return {
    epoch_index: idx,
    started_at_seconds: NOW - (14 - i) * 3 * DAY,
    ended_at_seconds: NOW - (13 - i) * 3 * DAY,
    end_height: 1_700_000 + i * 10_000,
    tvv_before: h(tvvBefore),
    tvv_after: h(tvvBefore + rewards),
    total_shares: (((BigInt(tvvBefore) * 1_000_000n * 10000n) / BigInt(navBps)) * HASH).toString(),
    rewards_claimed: h(rewards),
    commission_received: h(Math.floor(rewards / 10)),
    tips_received: h((i % 3) * 25),
    rewards_deposited: h(rewards),
    settled: h(0),
    write_down: h(i === 9 ? 120 : 0), // one slash epoch for the waterfall/drag
    deployed: h(1_500),
    rebalanced: h(300),
    unbonded_for_redemptions: h(0),
    redemptions_expedited: i % 3,
    validators_purged: i === 9 ? 1 : 0,
    eligible_count: 3,
    aum_fee_estimate: h(30 + i),
    net_deposits: h(netDep),
    net_apr_bps: 820 + ((i * 13) % 120),
    gross_apr_bps: 900 + ((i * 13) % 120),
    observed_at: NOW - (13 - i) * 3 * DAY,
  };
});

// ---- x/group governance (spec §8.0 /governance; PR 8.4b) -------------------
// Governed topology as the devnet bootstraps it: one group, TWO policies
// (the D25 dual-policy shape — set-valued discovery exercised by data), a
// live SUBMITTED proposal with votes, and terminal rows the panel renders
// from final tallies. `mockGovTopologyPlainAccount` is the 404 fact variant,
// consumed by tests rather than the mock page.

const POLICY_ADMIN = ADMIN_ADDR; // Config.admin IS the primary policy in mock
const POLICY_OPS = "pb1opspolicyopspolicyopspolicyopspolicy00";
const MEMBERS = [
  { addr: "pb1memberadaadaadaadaadaadaadaadaada0000", weight: "1" },
  { addr: "pb1memberbobbobbobbobbobbobbobbobbob0000", weight: "1" },
  { addr: "pb1membercalcalcalcalcalcalcalcalcal0000", weight: "1" },
];

const decisionPolicy = {
  "@type": "/cosmos.group.v1.ThresholdDecisionPolicy",
  threshold: "2",
  windows: { voting_period: "300s", min_execution_period: "0s" },
};

export const mockGovTopology: GovTopology = {
  state: "governed",
  groupId: "1",
  group: {
    id: "1",
    admin: MEMBERS[0].addr,
    metadata: "nvhash admin group",
    version: "1",
    total_weight: "3",
  },
  policies: {
    items: [
      {
        address: POLICY_ADMIN,
        group_id: "1",
        admin: MEMBERS[0].addr,
        metadata: "primary (admin) policy",
        version: "1",
        decision_policy: decisionPolicy,
      },
      {
        address: POLICY_OPS,
        group_id: "1",
        admin: MEMBERS[0].addr,
        metadata: "ops policy",
        version: "1",
        decision_policy: decisionPolicy,
      },
    ],
    truncated: false,
  },
  members: {
    items: MEMBERS.map((m) => ({
      group_id: "1",
      member: { address: m.addr, weight: m.weight, metadata: "" },
    })),
    truncated: false,
  },
};

export const mockGovTopologyPlainAccount: GovTopology = { state: "no-group" };

const ZERO_TALLY = {
  yes_count: "0",
  no_count: "0",
  abstain_count: "0",
  no_with_veto_count: "0",
};

export const mockGovProposals: GovProposals = {
  rows: [
    {
      proposal: {
        id: "7",
        group_policy_address: POLICY_ADMIN,
        metadata: "raise the AUM fee to 30 bps",
        proposers: [MEMBERS[0].addr],
        submit_time: new Date((NOW - 3600) * 1000).toISOString(),
        group_version: "1",
        group_policy_version: "1",
        status: "PROPOSAL_STATUS_SUBMITTED",
        final_tally_result: ZERO_TALLY, // zeros until tallied — never rendered live
        voting_period_end: new Date((NOW + 240) * 1000).toISOString(),
        executor_result: "PROPOSAL_EXECUTOR_RESULT_NOT_RUN",
        messages: [
          {
            "@type": "/cosmwasm.wasm.v1.MsgExecuteContract",
            sender: POLICY_ADMIN,
            contract: "pb1contractcontractcontractcontract00000",
            msg: { update_config: { aum_fee_bps: 30 } },
            funds: [],
          },
        ],
      },
      policyAddress: POLICY_ADMIN,
      liveTally: { yes_count: "1", no_count: "0", abstain_count: "0", no_with_veto_count: "0" },
      liveTallyError: null,
      votes: {
        items: [
          {
            proposal_id: "7",
            voter: MEMBERS[0].addr,
            option: "VOTE_OPTION_YES",
            metadata: "",
            submit_time: new Date((NOW - 1800) * 1000).toISOString(),
          },
        ],
        truncated: false,
      },
    },
    {
      proposal: {
        id: "5",
        group_policy_address: POLICY_ADMIN,
        metadata: "accepted but not yet executed",
        proposers: [MEMBERS[1].addr],
        submit_time: new Date((NOW - 2 * DAY) * 1000).toISOString(),
        group_version: "1",
        group_policy_version: "1",
        status: "PROPOSAL_STATUS_ACCEPTED",
        final_tally_result: {
          yes_count: "2",
          no_count: "1",
          abstain_count: "0",
          no_with_veto_count: "0",
        },
        voting_period_end: new Date((NOW - DAY) * 1000).toISOString(),
        executor_result: "PROPOSAL_EXECUTOR_RESULT_NOT_RUN",
        messages: [],
      },
      policyAddress: POLICY_ADMIN,
      liveTally: null,
      liveTallyError: null,
      votes: null, // deleted at the voting-period-end tally (§x/group 2)
    },
  ],
  truncated: false,
};
