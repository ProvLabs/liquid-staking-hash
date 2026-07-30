// Typed reads for x/group over LCD — the governance surface the App renders
// (spec §8.7) and the admin role detection of the session layer (spec §4,
// plan PR 5.1: admin = session address ∈ the admin group-policy's members,
// re-checked live per session refresh).
//
// Proposal/vote reads land here with plan PR 7.1. Every shape below is pinned
// to the devnet corpus captured 2026-07-29 (`packages/fixtures/fixtures/
// queries/group/`, manifest `pinned_facts`), not to the module's proto docs.
// Four of those observations shape this file directly:
//
//  - `group_policy_info` carries `decision_policy` INLINE, so a policy's
//    threshold needs no second read. `parseGroupPolicyInfo` therefore gained a
//    `decisionPolicy` field it previously dropped.
//  - tally counts are UNBOUNDED integers (member weights, not token amounts),
//    so they are kept as canonical decimal STRINGS and never coerced to a
//    number. `Uint128` would also be the wrong bound.
//  - a proposal's `messages` are kept VERBATIM. 7.2's decoder and 7.4's
//    byte-identical canonical re-encode guard both need the exact payload;
//    normalizing here would quietly break the guard downstream.
//  - an unrecognized decision-policy type parses to a tagged `unknown` rather
//    than throwing. An unknown policy type must not stall a worker mid-window
//    (plan §4 invariant 8), and the raw payload is preserved so the surface can
//    say what it does not understand instead of inventing a summary.

import {
  expectArray,
  expectObject,
  expectString,
  parseU64String,
} from "./amounts.ts";
import { LcdClient, type QueryParams } from "./lcd.ts";
import { parsePagination, type Pagination } from "./types.ts";

/**
 * Canonical unsigned decimal string, unbounded. x/group weights and tally
 * counts are `string`-encoded `Int`s with no protocol ceiling — they are sums
 * of member weights, not token amounts — so `parseUint128` would impose a bound
 * the module does not have, and a JS number would corrupt them silently.
 * Validated for SHAPE and carried as a string.
 */
function expectDecimalString(value: unknown, path: string): string {
  const s = expectString(value, path);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) {
    throw new Error(`decode ${path}: expected canonical unsigned integer string (got ${JSON.stringify(s)})`);
  }
  return s;
}

export interface GroupInfo {
  id: bigint;
  admin: string;
  metadata: string;
  version: bigint;
  /** decimal string per x/group */
  totalWeight: string;
  createdAt: string;
}

export function parseGroupInfo(value: unknown, path = "$"): GroupInfo {
  const o = expectObject(value, path);
  return {
    id: parseU64String(o["id"], `${path}.id`),
    admin: expectString(o["admin"], `${path}.admin`),
    metadata: expectString(o["metadata"] ?? "", `${path}.metadata`),
    version: parseU64String(o["version"], `${path}.version`),
    totalWeight: expectString(o["total_weight"], `${path}.total_weight`),
    createdAt: expectString(o["created_at"], `${path}.created_at`),
  };
}

/**
 * A policy's decision rule. Threshold and percentage are the two the module
 * ships; `unknown` is the third case ON PURPOSE — a policy type this build does
 * not know must not throw and stall an indexer window, and the raw payload is
 * kept so a surface can say "this policy type is not understood" instead of
 * summarizing something it cannot read (app-spec §12.1).
 *
 * `threshold` and `percentage` stay strings for the same reason tally counts do.
 */
export type GroupDecisionPolicy =
  | { kind: "threshold"; threshold: string; votingPeriod: string; minExecutionPeriod: string }
  | { kind: "percentage"; percentage: string; votingPeriod: string; minExecutionPeriod: string }
  | { kind: "unknown"; typeUrl: string; raw: unknown };

export function parseDecisionPolicy(value: unknown, path = "$"): GroupDecisionPolicy {
  const o = expectObject(value, path);
  const typeUrl = typeof o["@type"] === "string" ? o["@type"] : "";
  // `windows` is absent on an unknown policy type, so it is read only inside
  // the branches that the module guarantees carry it.
  const windows = (): { votingPeriod: string; minExecutionPeriod: string } => {
    const w = expectObject(o["windows"], `${path}.windows`);
    return {
      votingPeriod: expectString(w["voting_period"], `${path}.windows.voting_period`),
      minExecutionPeriod: expectString(w["min_execution_period"], `${path}.windows.min_execution_period`),
    };
  };
  switch (typeUrl) {
    case "/cosmos.group.v1.ThresholdDecisionPolicy":
      return { kind: "threshold", threshold: expectDecimalString(o["threshold"], `${path}.threshold`), ...windows() };
    case "/cosmos.group.v1.PercentageDecisionPolicy":
      // A percentage is a decimal fraction ("0.5"), NOT an integer — so it is
      // carried as the raw string rather than through expectDecimalString.
      return { kind: "percentage", percentage: expectString(o["percentage"], `${path}.percentage`), ...windows() };
    default:
      return { kind: "unknown", typeUrl, raw: value };
  }
}

export interface GroupPolicyInfo {
  /** The policy account address (what the contract's `Config.admin` names). */
  address: string;
  groupId: bigint;
  admin: string;
  metadata: string;
  version: bigint;
  /**
   * The decision rule IN FORCE NOW. Served inline by the LCD (pinned fact,
   * 2026-07-29), which is why a historical proposal's threshold has to be
   * snapshotted at submit time rather than read from here — this value moves
   * when the policy is updated, and a past tally-vs-threshold would otherwise
   * be rendered against the wrong rule.
   */
  decisionPolicy: GroupDecisionPolicy;
  createdAt: string;
}

export function parseGroupPolicyInfo(value: unknown, path = "$"): GroupPolicyInfo {
  const o = expectObject(value, path);
  return {
    address: expectString(o["address"], `${path}.address`),
    groupId: parseU64String(o["group_id"], `${path}.group_id`),
    admin: expectString(o["admin"], `${path}.admin`),
    metadata: expectString(o["metadata"] ?? "", `${path}.metadata`),
    version: parseU64String(o["version"], `${path}.version`),
    decisionPolicy: parseDecisionPolicy(o["decision_policy"], `${path}.decision_policy`),
    createdAt: expectString(o["created_at"], `${path}.created_at`),
  };
}

export interface GroupMember {
  address: string;
  /** decimal string per x/group */
  weight: string;
  metadata: string;
  addedAt: string;
}

export function parseGroupMember(value: unknown, path = "$"): GroupMember {
  const o = expectObject(value, path);
  // LCD nests the member under `member` alongside `group_id`.
  const m = expectObject(o["member"], `${path}.member`);
  return {
    address: expectString(m["address"], `${path}.member.address`),
    weight: expectString(m["weight"], `${path}.member.weight`),
    metadata: expectString(m["metadata"] ?? "", `${path}.member.metadata`),
    addedAt: expectString(m["added_at"], `${path}.member.added_at`),
  };
}

// --- proposals and votes (plan PR 7.1) -------------------------------------

/** The module's proposal statuses. Closed set, and `ABORTED` is in it because
 * it is in the proto — NOT because the devnet corpus reaches it. The 2026-07-29
 * drill could not produce an abort on this build (a mid-vote group change did
 * not abort an open proposal), which is recorded in the manifest; the enum still
 * has to accept it, since multiplicity comes from the producing module and never
 * from the happy path a drill happens to walk. */
export const GROUP_PROPOSAL_STATUSES = [
  "SUBMITTED",
  "ACCEPTED",
  "REJECTED",
  "ABORTED",
  "WITHDRAWN",
  "UNSPECIFIED",
] as const;
export type GroupProposalStatus = (typeof GROUP_PROPOSAL_STATUSES)[number];

/** Execution outcome, independent of `status`. `ACCEPTED` + `FAILURE` is a real
 * pair — "it passed and then the messages failed" — and `status` alone cannot
 * express it. */
export const GROUP_EXECUTOR_RESULTS = ["NOT_RUN", "SUCCESS", "FAILURE", "UNSPECIFIED"] as const;
export type GroupExecutorResult = (typeof GROUP_EXECUTOR_RESULTS)[number];

export const GROUP_VOTE_OPTIONS = ["YES", "NO", "ABSTAIN", "NO_WITH_VETO", "UNSPECIFIED"] as const;
export type GroupVoteOption = (typeof GROUP_VOTE_OPTIONS)[number];

/**
 * Strip a proto enum prefix and validate against a closed set. An unrecognized
 * member maps to `UNSPECIFIED` rather than throwing: an enum the chain gains in
 * an upgrade must not stall an indexer window, and `UNSPECIFIED` is a value the
 * surfaces already have to render honestly.
 */
function parseEnum<T extends string>(
  value: unknown,
  prefix: string,
  allowed: readonly T[],
  path: string,
): T {
  const raw = expectString(value ?? "", path);
  const stripped = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return (allowed as readonly string[]).includes(stripped)
    ? (stripped as T)
    : (allowed[allowed.length - 1] as T);
}

/** The four tally counts, as canonical decimal strings (unbounded weights). */
export interface GroupTallyResult {
  yesCount: string;
  abstainCount: string;
  noCount: string;
  noWithVetoCount: string;
}

export function parseTallyResult(value: unknown, path = "$"): GroupTallyResult {
  const o = expectObject(value, path);
  return {
    yesCount: expectDecimalString(o["yes_count"], `${path}.yes_count`),
    abstainCount: expectDecimalString(o["abstain_count"], `${path}.abstain_count`),
    noCount: expectDecimalString(o["no_count"], `${path}.no_count`),
    noWithVetoCount: expectDecimalString(o["no_with_veto_count"], `${path}.no_with_veto_count`),
  };
}

export interface GroupProposal {
  id: bigint;
  groupPolicyAddress: string;
  metadata: string;
  /** x/group permits SEVERAL proposers, and every one is a required signer. */
  proposers: string[];
  submitTime: string;
  groupVersion: bigint;
  groupPolicyVersion: bigint;
  status: GroupProposalStatus;
  finalTallyResult: GroupTallyResult;
  votingPeriodEnd: string;
  executorResult: GroupExecutorResult;
  /**
   * The proposal's messages, VERBATIM and unnormalized. 7.2 decodes them and
   * 7.4 re-encodes them canonically byte-for-byte as a relay-guard condition;
   * any normalization here would break that guard somewhere far away.
   */
  messages: unknown[];
  /** Human-authored proposal title/summary (SDK ≥ 0.50 proposal fields). */
  title: string;
  summary: string;
}

export function parseProposal(value: unknown, path = "$"): GroupProposal {
  const o = expectObject(value, path);
  return {
    id: parseU64String(o["id"], `${path}.id`),
    groupPolicyAddress: expectString(o["group_policy_address"], `${path}.group_policy_address`),
    metadata: expectString(o["metadata"] ?? "", `${path}.metadata`),
    proposers: expectArray(o["proposers"], `${path}.proposers`).map((p, i) =>
      expectString(p, `${path}.proposers[${i}]`),
    ),
    submitTime: expectString(o["submit_time"], `${path}.submit_time`),
    groupVersion: parseU64String(o["group_version"], `${path}.group_version`),
    groupPolicyVersion: parseU64String(o["group_policy_version"], `${path}.group_policy_version`),
    status: parseEnum(o["status"], "PROPOSAL_STATUS_", GROUP_PROPOSAL_STATUSES, `${path}.status`),
    finalTallyResult: parseTallyResult(o["final_tally_result"], `${path}.final_tally_result`),
    votingPeriodEnd: expectString(o["voting_period_end"], `${path}.voting_period_end`),
    executorResult: parseEnum(
      o["executor_result"],
      "PROPOSAL_EXECUTOR_RESULT_",
      GROUP_EXECUTOR_RESULTS,
      `${path}.executor_result`,
    ),
    messages: expectArray(o["messages"] ?? [], `${path}.messages`),
    title: expectString(o["title"] ?? "", `${path}.title`),
    summary: expectString(o["summary"] ?? "", `${path}.summary`),
  };
}

/**
 * One vote. NOTE what is NOT here: a weight. The module's `Vote` carries no
 * weight field (pinned 2026-07-29), so a voter's weight at the vote height has
 * to come from `group_members` or stay null — a fabricated weight would be a lie
 * about a tally line.
 *
 * Votes are also DELETED at the voting-period-end tally, even for an accepted
 * proposal. So this read recovers votes only while a proposal is still open, and
 * per-voter provenance for any closed proposal exists only in the tx plane.
 */
export interface GroupVote {
  proposalId: bigint;
  voter: string;
  option: GroupVoteOption;
  metadata: string;
  submitTime: string;
}

export function parseVote(value: unknown, path = "$"): GroupVote {
  const o = expectObject(value, path);
  return {
    proposalId: parseU64String(o["proposal_id"], `${path}.proposal_id`),
    voter: expectString(o["voter"], `${path}.voter`),
    option: parseEnum(o["option"], "VOTE_OPTION_", GROUP_VOTE_OPTIONS, `${path}.option`),
    metadata: expectString(o["metadata"] ?? "", `${path}.metadata`),
    submitTime: expectString(o["submit_time"], `${path}.submit_time`),
  };
}

export class GroupClient {
  constructor(private readonly lcd: LcdClient) {}

  async groups(params?: QueryParams): Promise<{ groups: GroupInfo[]; pagination: Pagination }> {
    const o = expectObject(await this.lcd.get("cosmos/group/v1/groups", params));
    return {
      groups: expectArray(o["groups"], "$.groups").map((g, i) => parseGroupInfo(g, `$.groups[${i}]`)),
      pagination: parsePagination(o["pagination"]),
    };
  }

  /**
   * Resolve a group-policy account address to its policy info (PR 5.1: the
   * contract's `Config.admin` is expected to be a group-policy address; a 404
   * from the LCD means it is a plain account instead — callers treat that as
   * "no group behind the admin").
   */
  async groupPolicyInfo(policyAddress: string): Promise<GroupPolicyInfo> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/group_policy_info/${encodeURIComponent(policyAddress)}`),
    );
    return parseGroupPolicyInfo(o["info"], "$.info");
  }

  /** Members of a group, paginated (admin-membership check, spec §4). */
  async groupMembers(
    groupId: bigint,
    params?: QueryParams,
  ): Promise<{ members: GroupMember[]; pagination: Pagination }> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/group_members/${groupId.toString()}`, params),
    );
    return {
      members: expectArray(o["members"], "$.members").map((m, i) =>
        parseGroupMember(m, `$.members[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }

  /** Group info by id (its `admin` is the second leg of policy discovery). */
  async groupInfo(groupId: bigint): Promise<GroupInfo> {
    const o = expectObject(await this.lcd.get(`cosmos/group/v1/group_info/${groupId.toString()}`));
    return parseGroupInfo(o["info"], "$.info");
  }

  /**
   * Every policy on a group, paginated. Half of the set-valued discovery of
   * plan §2.1: a program has 1..n policies (the `admin`/`ops` split in
   * `contracts/IMPLEMENTATION-STATUS.md` is still open), so nothing may take
   * "the" policy to be the first element of this list.
   */
  async groupPoliciesByGroup(
    groupId: bigint,
    params?: QueryParams,
  ): Promise<{ policies: GroupPolicyInfo[]; pagination: Pagination }> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/group_policies_by_group/${groupId.toString()}`, params),
    );
    return {
      policies: expectArray(o["group_policies"], "$.group_policies").map((p, i) =>
        parseGroupPolicyInfo(p, `$.group_policies[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }

  /** The other half: policies administered by an account (the group's admin). */
  async groupPoliciesByAdmin(
    admin: string,
    params?: QueryParams,
  ): Promise<{ policies: GroupPolicyInfo[]; pagination: Pagination }> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/group_policies_by_admin/${encodeURIComponent(admin)}`, params),
    );
    return {
      policies: expectArray(o["group_policies"], "$.group_policies").map((p, i) =>
        parseGroupPolicyInfo(p, `$.group_policies[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }

  /**
   * One proposal by id.
   *
   * THROWS when the chain no longer holds it, and the caller must not read that
   * as "pruned". Observed 2026-07-29: the LCD answers a missing proposal with
   * **HTTP 500** — not 404 — and the body (`code: 2`,
   * `"not found: load proposal"`) is IDENTICAL for a proposal that was pruned
   * and one that never existed. A node outage and a bad height pin also arrive
   * as 500. So an error here is a READ FAILURE and nothing more; prune is
   * established by absence from `proposalsByGroupPolicy` (an authoritative 200)
   * or by an `EventProposalPruned` in the tx/block plane.
   */
  async proposal(proposalId: bigint): Promise<GroupProposal> {
    const o = expectObject(await this.lcd.get(`cosmos/group/v1/proposal/${proposalId.toString()}`));
    return parseProposal(o["proposal"], "$.proposal");
  }

  /**
   * Proposals on a policy, paginated. This is the AUTHORITATIVE set: a 200 here
   * enumerates exactly what the chain still holds, which is what makes "absent
   * from this list" a sound prune signal where an HTTP status is not.
   *
   * Callers must follow `pagination.nextKey` to exhaustion. A truncated sweep is
   * indistinguishable from a prune and would corrupt the mirror (SECURITY.md: no
   * unbounded work, and all chain reads paginate).
   */
  async proposalsByGroupPolicy(
    policyAddress: string,
    params?: QueryParams,
  ): Promise<{ proposals: GroupProposal[]; pagination: Pagination }> {
    const o = expectObject(
      await this.lcd.get(
        `cosmos/group/v1/proposals_by_group_policy/${encodeURIComponent(policyAddress)}`,
        params,
      ),
    );
    return {
      proposals: expectArray(o["proposals"], "$.proposals").map((p, i) =>
        parseProposal(p, `$.proposals[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }

  /**
   * The module's own tally for a proposal — `TallyResult`.
   *
   * WHY THIS EXISTS SEPARATELY FROM `proposal()` (app plan PR 7.2). A proposal's
   * `final_tally_result` is written by the module only when it TALLIES: it is
   * zeros for the whole voting period, whatever has been voted. So the state
   * plane — which is what both the indexer's sweep and `proposal()` read — cannot
   * report where an OPEN proposal stands, and rendering its `final_tally_result`
   * would state "nobody has voted" about a proposal that has votes. That is the
   * one number a member is looking at when they decide, so it gets the module's
   * own computation rather than one derived here from votes and member weights.
   *
   * A closed proposal answers with its stored final result, so callers need not
   * branch on status; they branch on WHICH PLANE is canonical for the status
   * they hold.
   *
   * The response ENVELOPE is not pinned by the fixture corpus (the 2026-07-29
   * capture predates this read), so both `{ tally: {...} }` and a bare tally
   * object are accepted. The tally SHAPE itself is corpus-pinned — it is the
   * same `TallyResult` `parseProposal` already decodes.
   */
  async tallyResult(proposalId: bigint): Promise<GroupTallyResult> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/proposals/${proposalId.toString()}/tally`),
    );
    return parseTallyResult(o["tally"] ?? o, "$.tally");
  }

  /**
   * Votes on a proposal, paginated. Answers 200 with an EMPTY list once the
   * proposal's tally is final — the module deletes the votes at voting-period
   * end — so an empty result here never means "nobody voted", and the mirror
   * must not overwrite recorded votes with it.
   */
  async votesByProposal(
    proposalId: bigint,
    params?: QueryParams,
  ): Promise<{ votes: GroupVote[]; pagination: Pagination }> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/votes_by_proposal/${proposalId.toString()}`, params),
    );
    return {
      votes: expectArray(o["votes"], "$.votes").map((v, i) => parseVote(v, `$.votes[${i}]`)),
      pagination: parsePagination(o["pagination"]),
    };
  }
}
