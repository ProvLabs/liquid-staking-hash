// Governance-center data assembly (`/governance`, app-spec §8.7, §12.1.1;
// M7.2 §2.1). THE composition seam: the two planes meet here and nowhere else,
// and this module never throws — every read degrades to a stated absence.
//
//   LIVE plane (`app/lib/services/governance.server.ts`): the policy set, the
//     member set, and — for an OPEN proposal — status and tally. Canonical:
//     §12.1.1 names governance tallies live-canonical.
//   INDEXED plane (`services/api`, public reads, no assertion): the durable
//     mirror. It is the RECORD for anything closed, because x/group prunes and a
//     successfully executed proposal prunes in its own transaction — so the
//     happy path is precisely the path that leaves nothing on chain.
//
// The rule that shapes every merge below: a proposal's `plane` says which read
// produced its status and tally, and an indexed figure standing in for a failed
// live read is BADGED with the height it was observed at. Never blank, never
// indexed-presented-as-current (SECURITY.md "never lie about state"). That is
// M6.4's stale-registry P1 applied here before it can happen again.

import type {
  FreshnessMeta,
  GovDecisionPolicy,
  GovExecutorResult,
  GovProposalRow,
  GovProposalStatus,
  GovTally,
  GovVoteOption,
  GovVoteRow,
} from "@nvhash/api-types";
import type { FetchLike, GroupProposal, GroupVote } from "@nvhash/chain-client";

import {
  fetchApiJson,
  govPoliciesEnvelopeSchema,
  govProposalEnvelopeSchema,
  govProposalsEnvelopeSchema,
} from "~/api/api.server";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import {
  loadLiveGovernance,
  loadLiveProposal,
  loadLiveProposals,
  loadLiveTally,
  loadLiveVotes,
  type LiveGovernance,
  type LiveMember,
} from "~/lib/services/governance.server";
import { decodeMessage } from "./decode";
import { buildTally } from "./tally";
import type {
  GovernanceDetailData,
  GovernanceListData,
  LiveGroupVM,
  LivePlaneState,
  MemberStatus,
  PolicyVM,
  ProposalDetailVM,
  ProposalPlane,
  ProposalSummaryVM,
  VoteVM,
} from "./types";

export type { GovernanceDetailData, GovernanceListData } from "./types";

/** Proposals per page. Well inside the producer's 200-row cap; a full page is
 * reported as `hasMore` rather than assumed complete. */
export const PROPOSAL_PAGE_SIZE = 50;

/**
 * How many live tally reads one list render may make. Each open proposal costs
 * one request (the module has no bulk tally read), so without a cap a policy
 * with hundreds of open proposals would turn one page view into hundreds of
 * chain reads — SECURITY.md's "no unbounded work" applies to this tier too.
 * Proposals past the cap render on the indexed plane WITH its stale badge, which
 * is the same honest degradation a failed read gets.
 */
export const MAX_LIVE_TALLY_READS = 25;

// ── Pure composition ───────────────────────────────────────────────────────

const STATUS_BY_CHAIN_VALUE: Record<string, GovProposalStatus> = {
  SUBMITTED: "submitted",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  ABORTED: "aborted",
  WITHDRAWN: "withdrawn",
  UNSPECIFIED: "unspecified",
};

const EXECUTOR_BY_CHAIN_VALUE: Record<string, GovExecutorResult> = {
  NOT_RUN: "not_run",
  SUCCESS: "success",
  FAILURE: "failure",
  UNSPECIFIED: "unspecified",
};

const VOTE_OPTION_BY_CHAIN_VALUE: Record<string, GovVoteOption> = {
  YES: "yes",
  NO: "no",
  ABSTAIN: "abstain",
  NO_WITH_VETO: "no_with_veto",
  UNSPECIFIED: "unspecified",
};

/** Chain enum → wire enum. An unrecognized member lands on `unspecified`, the
 * value both planes already have to render honestly, rather than throwing. */
export function toWireStatus(status: string): GovProposalStatus {
  return STATUS_BY_CHAIN_VALUE[status] ?? "unspecified";
}

export function toWireExecutorResult(result: string): GovExecutorResult {
  return EXECUTOR_BY_CHAIN_VALUE[result] ?? "unspecified";
}

export function toWireVoteOption(option: string): GovVoteOption {
  return VOTE_OPTION_BY_CHAIN_VALUE[option] ?? "unspecified";
}

/** A live proposal's decision policy, mapped onto the wire shape. */
function toWireDecisionPolicy(policy: {
  kind: string;
  threshold?: string;
  percentage?: string;
  votingPeriod?: string;
  minExecutionPeriod?: string;
  typeUrl?: string;
}): GovDecisionPolicy {
  if (policy.kind === "threshold") {
    return {
      kind: "threshold",
      threshold: policy.threshold ?? "0",
      voting_period: policy.votingPeriod ?? "",
      min_execution_period: policy.minExecutionPeriod ?? "",
    };
  }
  if (policy.kind === "percentage") {
    return {
      kind: "percentage",
      percentage: policy.percentage ?? "0",
      voting_period: policy.votingPeriod ?? "",
      min_execution_period: policy.minExecutionPeriod ?? "",
    };
  }
  return { kind: "unknown", type_url: policy.typeUrl ?? "" };
}

/** Seconds until an ISO instant, or null once elapsed / unparseable. Computed
 * against the SERVER clock and labeled approximate at render (§7 Q2): the
 * absolute `voting_period_end` is the fact, this is the hint. */
export function secondsUntil(iso: string, nowMs: number): number | null {
  const end = Date.parse(iso);
  if (!Number.isFinite(end)) return null;
  const seconds = Math.floor((end - nowMs) / 1000);
  return seconds > 0 ? seconds : null;
}

/** A live-plane proposal projected onto the mirror's row shape, so one builder
 * serves both planes. `observed_*` are deliberately absent from the live path —
 * a live read is AS OF now, and stamping it with a height it did not carry would
 * invent provenance. */
export function liveProposalToRow(live: GroupProposal, tally: GovTally | null): Omit<
  GovProposalRow,
  "observed_height" | "observed_at" | "pruned_at_height" | "height" | "txhash"
> {
  return {
    proposal_id: live.id.toString(),
    group_policy_address: live.groupPolicyAddress,
    group_id: "",
    proposers: live.proposers,
    status: toWireStatus(live.status),
    executor_result: toWireExecutorResult(live.executorResult),
    title: live.title,
    summary: live.summary,
    metadata: live.metadata === "" ? null : live.metadata,
    tally: tally ?? {
      yes: live.finalTallyResult.yesCount,
      no: live.finalTallyResult.noCount,
      abstain: live.finalTallyResult.abstainCount,
      no_with_veto: live.finalTallyResult.noWithVetoCount,
    },
    decision_policy: { kind: "unknown", type_url: "" },
    submit_time: live.submitTime,
    voting_period_end: live.votingPeriodEnd,
    group_version: live.groupVersion.toString(),
    group_policy_version: live.groupPolicyVersion.toString(),
    messages_truncated: false,
    proposers_truncated: false,
    messages: live.messages,
  };
}

/**
 * The `min_execution_period` of a proposal's OWN policy, from the live plane.
 *
 * Null when the live plane is unresolved, when that policy is not in the
 * discovered set, or when its decision rule is one this build does not
 * understand — all of which render as "not yet, and we cannot say when" rather
 * than as an offered execute button.
 */
export function livePolicyMinExecutionPeriod(
  live: LiveGovernance,
  policyAddress: string,
): string | null {
  if (live.state !== "governed") return null;
  const policy = live.policies.find((entry) => entry.address === policyAddress) ?? null;
  if (policy === null || policy.decisionPolicy.kind === "unknown") return null;
  return policy.decisionPolicy.minExecutionPeriod;
}

export interface ProposalMergeInput {
  /** The mirrored row, or null when the mirror has never seen this proposal. */
  indexed: GovProposalRow | null;
  /** The live proposal, or null when the chain read failed or was not attempted. */
  live: GroupProposal | null;
  /** The module's live tally, or null when that read failed / was capped out. */
  liveTally: GovTally | null;
  /** Live electorate weight; a percentage rule is undecidable without it. */
  totalWeight: string | null;
  /** Current live group version; null when the live plane is unavailable. */
  currentGroupVersion: string | null;
  nowMs: number;
}

/**
 * Decide the plane and compose the summary. This function IS the C5 precedence
 * table, and the order of its branches is the table's row order:
 *
 *   pruned          → the mirror, labeled "the chain no longer holds this". No
 *                     live read is attempted at all: a live failure would be
 *                     indistinguishable from a node outage (HTTP 500 either way),
 *                     so prune is established only by `pruned_at_height`.
 *   closed          → the mirror is CANONICAL. The chain may hold nothing.
 *   open + live ok  → the chain, both status and tally together.
 *   open + live bad → the mirror, badged with `observed_height`. Never blank.
 *   no mirrored row → the chain alone, labeled "not mirrored yet".
 */
export function buildProposalSummary(input: ProposalMergeInput): ProposalSummaryVM {
  const { indexed, live, liveTally, totalWeight, currentGroupVersion, nowMs } = input;

  let plane: ProposalPlane;
  if (indexed === null) plane = "live-only";
  else if (indexed.pruned_at_height !== null) plane = "pruned";
  else if (indexed.status !== "submitted") plane = "indexed";
  // Status and tally move together: they are one row of the precedence table,
  // and a page that showed a live status beside a mirrored tally would be
  // labeling a figure with a freshness it does not have.
  else if (live !== null && liveTally !== null) plane = "live";
  else plane = "indexed-fallback";

  const useLive = plane === "live" || plane === "live-only";
  const source = useLive && live !== null ? liveProposalToRow(live, liveTally) : indexed;
  // Unreachable in practice (a null `indexed` forces `live-only`, which requires
  // a live proposal), but the types must not depend on that reasoning.
  if (source === null || (useLive && live === null)) {
    throw new Error("buildProposalSummary: neither plane supplied a proposal");
  }

  // The decision rule ALWAYS comes from the mirror's snapshot when there is one:
  // it is the rule in force at submit, and scoring a historical tally against
  // today's policy would misstate what passed (§2.3).
  const policy: GovDecisionPolicy | null = indexed?.decision_policy ?? null;

  const counts: GovTally | null =
    plane === "live"
      ? liveTally
      : plane === "live-only"
        ? // An open proposal with no mirrored row and no tally read has an
          // UNKNOWN tally — `final_tally_result` is zeros until the module
          // tallies, so it must not stand in.
          (liveTally ?? (source.status === "submitted" ? null : source.tally))
        : source.tally;

  const groupVersion = source.group_version;
  const membershipChanged =
    currentGroupVersion !== null && groupVersion !== "" && groupVersion !== currentGroupVersion;

  return {
    proposalId: source.proposal_id,
    title: source.title,
    policyAddress: source.group_policy_address,
    proposers: source.proposers,
    proposersTruncated: source.proposers_truncated,
    status: source.status,
    executorResult: source.executor_result,
    plane,
    observedHeight: plane === "live" || plane === "live-only" ? null : (indexed?.observed_height ?? null),
    observedAt: plane === "live" || plane === "live-only" ? null : (indexed?.observed_at ?? null),
    submitTime: source.submit_time,
    votingPeriodEnd: source.voting_period_end,
    votingEndsInSeconds:
      source.status === "submitted" ? secondsUntil(source.voting_period_end, nowMs) : null,
    tally: buildTally(counts, policy, totalWeight),
    pruned: plane === "pruned",
    membershipChanged,
    messageCount: source.messages.length,
    messagesTruncated: source.messages_truncated,
  };
}

function voteFromRow(row: GovVoteRow): VoteVM {
  return {
    voter: row.voter,
    option: row.option,
    weight: row.weight,
    submitTime: row.submit_time,
    height: row.height,
    txhash: row.txhash,
    liveOnly: false,
  };
}

/**
 * Merge recorded votes with the live vote read.
 *
 * The live read only ever ADDS: x/group deletes votes at the voting-period-end
 * tally, so a closed proposal answers 200 with an empty list, and a live read
 * that removed or blanked recorded votes would erase the only surviving record
 * of who voted (7.1 finding 2). Weight comes from the live member set when the
 * mirror could not recover one — never fabricated, and null when unknown.
 */
export function mergeVotes(
  recorded: readonly GovVoteRow[],
  live: readonly GroupVote[] | null,
  members: readonly LiveMember[] | null,
): VoteVM[] {
  const weightByAddress = new Map((members ?? []).map((m) => [m.address, m.weight] as const));
  const votes = recorded.map((row) => ({
    ...voteFromRow(row),
    weight: row.weight ?? weightByAddress.get(row.voter) ?? null,
  }));
  const seen = new Set(votes.map((v) => v.voter));
  for (const vote of live ?? []) {
    if (seen.has(vote.voter)) continue;
    votes.push({
      voter: vote.voter,
      option: toWireVoteOption(vote.option),
      weight: weightByAddress.get(vote.voter) ?? null,
      submitTime: vote.submitTime,
      // A live-only vote has no mirrored provenance yet. Null, not a guess.
      height: null,
      txhash: null,
      liveOnly: true,
    });
  }
  return votes;
}

/**
 * The per-member section, or the honest reason there is none (D5, §2.3).
 *
 * The membership-drift rule applies whether the proposal is open or closed. It
 * is stated for closed proposals in §2.3, and it is no less true for an open one
 * at an older group version: the 2026-07-29 drill measured that a mid-vote
 * members change does NOT abort an open proposal on this build, so "this
 * proposal's electorate" and "the group's members right now" can differ while
 * voting is still running. Rendering today's members either way would imply they
 * are the voters.
 */
export function buildMemberStatus(input: {
  members: readonly LiveMember[] | null;
  votes: readonly VoteVM[];
  proposalGroupVersion: string;
  currentGroupVersion: string | null;
  sessionAddress: string | null;
}): MemberStatus {
  const { members, votes, proposalGroupVersion, currentGroupVersion, sessionAddress } = input;
  if (members === null || currentGroupVersion === null) return { kind: "not-checked" };
  if (proposalGroupVersion !== "" && proposalGroupVersion !== currentGroupVersion) {
    return {
      kind: "membership-changed",
      proposalGroupVersion,
      currentGroupVersion,
    };
  }
  const voteByAddress = new Map(votes.map((v) => [v.voter, v] as const));
  return {
    kind: "members",
    rows: members.map((member) => ({
      address: member.address,
      weight: member.weight,
      vote: voteByAddress.get(member.address) ?? null,
      // Highlight only. This is a PUBLIC read (§8.7 "public read; member
      // write"), so the session address decorates a row and never gates one.
      isSession: sessionAddress !== null && member.address === sessionAddress,
    })),
  };
}

function liveGroupVM(live: LiveGovernance, memberCount: number): LiveGroupVM | null {
  return live.state === "governed"
    ? {
        groupId: live.group.groupId,
        version: live.group.version,
        totalWeight: live.group.totalWeight,
        memberCount,
      }
    : null;
}

function toLivePlaneState(live: LiveGovernance): LivePlaneState {
  return live.state === "governed"
    ? "governed"
    : live.state === "not-governed"
      ? "not-governed"
      : "unavailable";
}

/** Merge the live policy set with the mirror's historical one. A policy in one
 * and not the other is a real state both ways: live-only = it exists but has
 * never carried a proposal; indexed-only = it carried proposals and is no longer
 * in the live set (or the live read failed). */
function buildPolicies(
  live: LiveGovernance,
  indexed: readonly {
    address: string;
    group_id: string;
    proposal_count: number;
    last_seen_height: number;
    decision_policy: GovDecisionPolicy | null;
  }[],
): PolicyVM[] {
  const indexedByAddress = new Map(indexed.map((p) => [p.address, p] as const));
  const rows: PolicyVM[] = [];

  if (live.state === "governed") {
    for (const policy of live.policies) {
      const mirrored = indexedByAddress.get(policy.address) ?? null;
      const wire = toWireDecisionPolicy(policy.decisionPolicy);
      rows.push({
        address: policy.address,
        groupId: policy.groupId,
        metadata: policy.metadata === "" ? null : policy.metadata,
        proposalCount: mirrored?.proposal_count ?? null,
        lastSeenHeight: mirrored?.last_seen_height ?? null,
        rule: wire.kind,
        ruleValue: wire.kind === "threshold" ? wire.threshold : wire.kind === "percentage" ? wire.percentage : null,
        votingPeriod: wire.kind === "unknown" ? null : wire.voting_period,
        live: true,
      });
    }
  }

  const liveAddresses = new Set(rows.map((r) => r.address));
  for (const policy of indexed) {
    if (liveAddresses.has(policy.address)) continue;
    const rule = policy.decision_policy;
    rows.push({
      address: policy.address,
      groupId: policy.group_id,
      metadata: null,
      proposalCount: policy.proposal_count,
      lastSeenHeight: policy.last_seen_height,
      rule: rule?.kind ?? null,
      ruleValue:
        rule === null || rule === undefined
          ? null
          : rule.kind === "threshold"
            ? rule.threshold
            : rule.kind === "percentage"
              ? rule.percentage
              : null,
      votingPeriod: rule === null || rule === undefined || rule.kind === "unknown" ? null : rule.voting_period,
      live: false,
    });
  }
  return rows;
}

// ── Loaders ────────────────────────────────────────────────────────────────

export interface GovernanceOptions {
  fetchImpl?: FetchLike;
  /** Highlight only — never a gate (§8.7 is a public read). */
  sessionAddress?: string | null;
  now?: () => number;
}

export interface GovernanceListOptions extends GovernanceOptions {
  status?: GovProposalStatus | null;
  page?: number;
}

function apiBaseOf(config: WebConfig): string {
  return config.apiUrl.replace(/\/+$/, "");
}

/** Assemble the `/governance` list for one request. Never throws. */
export async function loadGovernanceListData(
  config: WebConfig,
  options: GovernanceListOptions = {},
): Promise<GovernanceListData> {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const deps = { fetchImpl: doFetch };
  const nowMs = (options.now ?? Date.now)();
  const page = options.page ?? 0;
  const status = options.status ?? null;
  const apiBase = apiBaseOf(config);

  const query = new URLSearchParams({
    limit: String(PROPOSAL_PAGE_SIZE),
    offset: String(page * PROPOSAL_PAGE_SIZE),
  });
  if (status !== null) query.set("status", status);

  const [live, proposalsEnv, policiesEnv] = await Promise.all([
    loadLiveGovernance(config, deps),
    fetchApiJson(`${apiBase}/api/v1/governance/proposals?${query.toString()}`, doFetch, CHROME_READ_TIMEOUT_MS)
      .then((body) => govProposalsEnvelopeSchema.parse(body))
      .catch(() => null),
    fetchApiJson(`${apiBase}/api/v1/governance/policies`, doFetch, CHROME_READ_TIMEOUT_MS)
      .then((body) => govPoliciesEnvelopeSchema.parse(body))
      .catch(() => null),
  ]);

  const rows = proposalsEnv?.data.proposals ?? [];
  const members = live.state === "governed" ? live.members : null;
  const totalWeight = live.state === "governed" ? live.group.totalWeight : null;
  const currentGroupVersion = live.state === "governed" ? live.group.version : null;

  // Live reads happen ONLY for open, unpruned proposals (§3.4 R7): a closed
  // proposal's record is the mirror's, and a pruned one has nothing to read.
  const openRows = rows.filter((row) => row.status === "submitted" && row.pruned_at_height === null);
  const openPolicies = [...new Set(openRows.map((row) => row.group_policy_address))];
  const liveByPolicy = new Map<string, Map<string, GroupProposal> | null>();
  if (live.state === "governed" && openPolicies.length > 0) {
    const sweeps = await Promise.all(
      openPolicies.map((policy) => loadLiveProposals(config, policy, deps)),
    );
    openPolicies.forEach((policy, index) => liveByPolicy.set(policy, sweeps[index] ?? null));
  }

  // One tally read per open proposal, under a hard cap. Past the cap a proposal
  // renders on the indexed plane with its stale badge — the same honest
  // degradation a failed read gets, never a silently different one.
  const tallyTargets = openRows.slice(0, MAX_LIVE_TALLY_READS);
  const tallies = new Map<string, GovTally | null>();
  if (live.state === "governed" && tallyTargets.length > 0) {
    const results = await Promise.all(
      tallyTargets.map((row) => loadLiveTally(config, row.proposal_id, deps)),
    );
    tallyTargets.forEach((row, index) => tallies.set(row.proposal_id, results[index] ?? null));
  }

  const proposals = rows.map((row) =>
    buildProposalSummary({
      indexed: row,
      live: liveByPolicy.get(row.group_policy_address)?.get(row.proposal_id) ?? null,
      liveTally: tallies.get(row.proposal_id) ?? null,
      totalWeight,
      currentGroupVersion,
      nowMs,
    }),
  );

  // Open proposals pinned above the rest (§7 Q1), newest first within each
  // group. `proposal_id` is a u64 decimal string, so it is compared as BigInt —
  // string order would put "10" before "9".
  proposals.sort((a, b) => {
    const aOpen = a.status === "submitted" ? 0 : 1;
    const bOpen = b.status === "submitted" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const ai = BigInt(a.proposalId);
    const bi = BigInt(b.proposalId);
    return ai === bi ? 0 : ai > bi ? -1 : 1;
  });

  return {
    state: toLivePlaneState(live),
    policies: buildPolicies(live, policiesEnv?.data ?? []),
    group: liveGroupVM(live, members?.length ?? 0),
    proposals,
    indexedFromHeight: proposalsEnv?.data.indexed_from_height ?? null,
    indexedAvailable: proposalsEnv !== null,
    truncated: live.state === "governed" && live.policiesTruncated,
    statusFilter: status,
    page,
    hasMore: rows.length >= PROPOSAL_PAGE_SIZE,
    freshness: proposalsEnv?.meta ?? policiesEnv?.meta ?? null,
  };
}

/**
 * Assemble one proposal's detail. Returns null ONLY when neither plane holds it
 * — which the route renders as a 404, because "we hold no record of this id" and
 * "this proposal exists and is empty" are different answers.
 */
export async function loadGovernanceProposalData(
  config: WebConfig,
  proposalId: string,
  options: GovernanceOptions = {},
): Promise<GovernanceDetailData | null> {
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const deps = { fetchImpl: doFetch };
  const nowMs = (options.now ?? Date.now)();
  const apiBase = apiBaseOf(config);
  const sessionAddress = options.sessionAddress ?? null;

  const [live, detailEnv] = await Promise.all([
    loadLiveGovernance(config, deps),
    fetchApiJson(
      `${apiBase}/api/v1/governance/proposal?id=${encodeURIComponent(proposalId)}`,
      doFetch,
      CHROME_READ_TIMEOUT_MS,
    )
      .then((body) => govProposalEnvelopeSchema.parse(body))
      .catch(() => null),
  ]);

  const indexed = detailEnv?.data.proposal ?? null;
  const members = live.state === "governed" ? live.members : null;
  const totalWeight = live.state === "governed" ? live.group.totalWeight : null;
  const currentGroupVersion = live.state === "governed" ? live.group.version : null;

  // A pruned proposal is never live-read: the chain answers 500 for a pruned id,
  // a never-existing id and an outage alike, so the read could only add noise.
  //
  // M7.3–7.4 WIDENS THIS to ACCEPTED proposals as well, and the widening is
  // load-bearing rather than incidental. Actions are decided from the live plane
  // alone (§4b C5), and execute is offered on accepted proposals — so without a
  // live read, execute could never be offered at all, and offering it from the
  // mirror would be exactly the stale-row hazard C5 names. The read also carries
  // its own answer for free: a SUCCESSFULLY executed proposal is pruned by the
  // module in its own transaction (F4), so a failed read on an accepted proposal
  // is itself evidence not to offer the button.
  const liveWorthReading =
    indexed === null ||
    (indexed.pruned_at_height === null &&
      (indexed.status === "submitted" || indexed.status === "accepted"));
  const shouldReadLive = live.state === "governed" && liveWorthReading;

  const [liveProposal, liveTally, liveVotes] = shouldReadLive
    ? await Promise.all([
        loadLiveProposal(config, proposalId, deps),
        loadLiveTally(config, proposalId, deps),
        loadLiveVotes(config, proposalId, deps),
      ])
    : [null, null, null];

  if (indexed === null && liveProposal === null) return null;

  const summary = buildProposalSummary({
    indexed,
    live: liveProposal,
    liveTally,
    totalWeight,
    currentGroupVersion,
    nowMs,
  });

  const source = indexed ?? liveProposalToRow(liveProposal!, liveTally);
  const votes = mergeVotes(
    detailEnv?.data.votes ?? [],
    // Votes are only read live for an OPEN proposal, and only ever ADD (§3.4 R6).
    summary.status === "submitted" ? liveVotes : null,
    members,
  );

  const policy = buildPolicies(live, []).find((p) => p.address === source.group_policy_address) ?? null;
  const decisionPolicy = indexed?.decision_policy ?? null;

  const proposal: ProposalDetailVM = {
    ...summary,
    summary: source.summary,
    metadata: source.metadata,
    groupId: indexed?.group_id ?? (live.state === "governed" ? live.group.groupId : ""),
    groupVersion: source.group_version,
    groupPolicyVersion: source.group_policy_version,
    height: indexed?.height ?? null,
    txhash: indexed?.txhash ?? null,
    // Messages are INDEXED VERBATIM where a mirrored row exists — they are
    // immutable once submitted, and the mirror is the copy 7.4's guard will
    // re-encode. The live copy is used only when the mirror has none yet.
    messages: source.messages.map((message) => decodeMessage(message, config.contractAddress)),
    votes,
    votesTruncated: detailEnv?.data.votes_truncated ?? false,
    memberStatus: buildMemberStatus({
      members,
      votes,
      proposalGroupVersion: source.group_version,
      currentGroupVersion,
      sessionAddress,
    }),
    votingPeriod:
      decisionPolicy === null || decisionPolicy.kind === "unknown" ? null : decisionPolicy.voting_period,
    minExecutionPeriod:
      decisionPolicy === null || decisionPolicy.kind === "unknown"
        ? null
        : decisionPolicy.min_execution_period,
    // The affordance plane (§4b C5). Present ONLY when the chain itself served
    // this proposal on this request; a mirrored row never fills it in.
    liveState:
      liveProposal === null
        ? null
        : {
            status: toWireStatus(liveProposal.status),
            executorResult: toWireExecutorResult(liveProposal.executorResult),
            submitTime: liveProposal.submitTime,
            votingPeriodEnd: liveProposal.votingPeriodEnd,
            groupVersion: liveProposal.groupVersion.toString(),
            // THE LIVE POLICY, not `decisionPolicy` (the mirror's snapshot two
            // fields above). x/group's `Proposal` carries no decision policy, so
            // the module reads `min_execution_period` from the policy account at
            // execution time — and `runGovernancePreflight` reads it the same
            // way. Sourcing the affordance from the snapshot let the button and
            // the check that gates it disagree after a policy change (PR #25
            // review, 2026-07-30). Resolved for THIS proposal's own policy;
            // "the first policy" would be D1's topology assumption in miniature.
            minExecutionPeriod: livePolicyMinExecutionPeriod(
              live,
              liveProposal.groupPolicyAddress,
            ),
          },
    // Membership is `null` — not `false` — when the live member read failed:
    // "we could not check" and "you are not a member" are different sentences,
    // and only one of them should be shown to an actual member.
    sessionIsMember:
      sessionAddress === null || members === null
        ? null
        : members.some((member) => member.address === sessionAddress),
    sessionVote:
      sessionAddress === null ? null : (votes.find((v) => v.voter === sessionAddress) ?? null),
  };

  return {
    state: toLivePlaneState(live),
    proposal,
    policy,
    group: liveGroupVM(live, members?.length ?? 0),
    freshness: detailEnv?.meta ?? null,
  };
}
