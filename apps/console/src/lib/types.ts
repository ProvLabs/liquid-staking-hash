// TypeScript mirror of the contract query/response surface (contracts/src/msg.rs, contracts/src/state.rs,
// verified 2026-07-09). All Uint128/Int128 arrive as decimal STRINGS and are parsed to
// BigInt at the edge (spec Decision 8); these interfaces keep the wire shape as strings.

export interface ConfigResponse {
  admin: string;
  vault_address: string;
  underlying_denom: string;
  receipt_denom: string;
  max_delegations_per_run: number;
  aum_fee_bps: number;
  performance_threshold_bps: number;
  min_capture_interval_secs: number;
  max_concentration_multiple_bps: number;
  min_bonded_cap_bps: number;
  max_bonded_cap_bps: number;
  concentration_safety_offset_bps: number;
  commission_bps: number;
  jail_unbond_delay_secs: number;
  /** Absent on pre-8.4a deployed builds (the field's serde default is 50 on
   *  chain, but an old binary omits the key entirely) — optional, never 0. */
  redemption_margin_bps?: number;
}

export type EpochPhase = "Idle" | "Releasing";

export interface PendingDelegation {
  valoper: string;
  amount: string;
}
export interface PendingRedelegation {
  src: string;
  dst: string;
  amount: string;
}
export interface EpochStatusResponse {
  phase: string; // "Idle" | "Releasing"; unknown => warning state, never crash
  halted: boolean;
  last_run_seconds: number;
  receipt_minted: string;
  pending_delegations: PendingDelegation[];
  pending_redelegations: PendingRedelegation[];
}

export interface ValidatorStatus {
  valoper: string;
  operator: string;
  enrolled_at_seconds: number;
  uptime_capture_count: number;
  uptime_bps: number | null;
  jailed: boolean;
  tombstoned: boolean;
  tip_epoch: string;
  commission_accrued: string;
  commission_paid: string;
  commission_due: string;
  in_arrears: boolean;
  eligible: boolean;
  headroom: string;
}
export interface ValidatorsResponse {
  validators: ValidatorStatus[];
}

export interface JailReport {
  valoper: string;
  reported_at_seconds: number;
  purge_ready_at_seconds: number;
}
export interface JailReportsResponse {
  reports: JailReport[];
}

export interface EpochSnapshot {
  epoch_index: number;
  started_at_seconds: number;
  ended_at_seconds: number;
  end_height: number;
  tvv_before: string;
  tvv_after: string;
  total_shares: string;
  rewards_claimed: string;
  commission_received: string;
  tips_received: string;
  rewards_deposited: string;
  settled: string;
  write_down: string;
  deployed: string;
  rebalanced: string;
  unbonded_for_redemptions: string;
  redemptions_expedited: number;
  validators_purged: number;
  eligible_count: number;
  aum_fee_estimate: string;
  net_deposits: string; // signed
}
export interface EpochSnapshotResponse {
  snapshot: EpochSnapshot | null;
}

export interface AprResponse {
  epoch_index: number;
  window_seconds: number;
  tvv_before: string;
  rewards_claimed: string;
  commission_received: string;
  tips_received: string;
  aum_fee_estimate: string;
  write_down: string;
  gross_apr_bps: number;
  net_apr_bps: number;
}

// ---- secondary (module / vault) reads (spec §5.2) --------------------------
export interface VaultInfo {
  total_vault_value: string; // nhash
  total_shares: string; // nvhash base shares
  paused: boolean;
  pause_reason?: string;
  withdrawal_delay_seconds: number;
  principal_marker_address: string;
  principal_liquid_nhash: string;
}
export interface PendingSwapOut {
  id: number;
  owner: string;
  shares: string;
  estimate_nhash: string; // vault estimate-swap-out query
  matures_at_seconds: number; // absolute maturity instant (timeout)
}
export interface DeploymentSplit {
  delegated: string;
  unbonding: string;
  liquid: string;
  pending: string;
}

// ---- ledger row (client-persisted, spec §9.3) ------------------------------
export interface LedgerRow extends EpochSnapshot {
  net_apr_bps: number;
  gross_apr_bps: number;
  observed_at: number;
}

// ---- x/group governance reads (spec §8.0 /governance; PR 8.4b) -------------
// Mirror-tracked against the LCD shapes the indexer's governance worker reads
// (services/indexer/src/workers/governance/{policies,state}.ts) — update in
// the same change as any route or field the worker's decode moves to.

export interface GroupPolicyInfo {
  address: string;
  group_id: string;
  admin: string;
  metadata: string;
  version: string;
  /** Raw decision policy Any — threshold and windows read defensively. */
  decision_policy: {
    "@type"?: string;
    threshold?: string;
    percentage?: string;
    windows?: { voting_period?: string; min_execution_period?: string };
  } & Record<string, unknown>;
}

export interface GroupInfo {
  id: string;
  admin: string;
  metadata: string;
  version: string;
  total_weight: string;
}

export interface GroupMember {
  group_id: string;
  member: { address: string; weight: string; metadata: string; added_at?: string };
}

export type ProposalStatus =
  | "PROPOSAL_STATUS_SUBMITTED"
  | "PROPOSAL_STATUS_ACCEPTED"
  | "PROPOSAL_STATUS_REJECTED"
  | "PROPOSAL_STATUS_ABORTED"
  | "PROPOSAL_STATUS_WITHDRAWN";

export interface TallyCounts {
  yes_count: string;
  no_count: string;
  abstain_count: string;
  no_with_veto_count: string;
}

export interface GroupProposal {
  id: string;
  group_policy_address: string;
  metadata: string;
  proposers: string[];
  submit_time: string;
  group_version: string;
  group_policy_version: string;
  status: ProposalStatus;
  /** Zeros until the module tallies — NEVER rendered for an open proposal
   *  (chain-facts §x/group 7); the live tally comes from the Tally query. */
  final_tally_result: TallyCounts;
  voting_period_end: string;
  executor_result: string;
  messages: unknown[];
}

export interface GroupVote {
  proposal_id: string;
  voter: string;
  option: string;
  metadata: string;
  submit_time: string;
}

/** A bounded LCD sweep: `truncated` means the page cap was hit — the list is
 *  a prefix, never evidence of absence (chain-facts §x/group 9). */
export interface Bounded<T> {
  items: T[];
  truncated: boolean;
}
