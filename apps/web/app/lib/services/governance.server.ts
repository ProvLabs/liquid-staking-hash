// The LIVE x/group plane for the governance center (app-spec §8.7, §12.1.1).
// Server-only: the LCD is never reached from the browser.
//
// `services/api` is DB-only by design (ADR-001 Decision 1), so it serves the
// durable MIRROR. Everything that must be true RIGHT NOW — an open proposal's
// status and tally, the current policy set, the current member set — is read
// here, the same division `/market` and `/portfolio` already use.
//
// FOUR properties this module is responsible for:
//
//  1. **Policy discovery is set-valued** (D1). `Config.admin` → policy → group →
//     ALL policies on that group. Never "the admin policy": the admin/ops split
//     in `contracts/IMPLEMENTATION-STATUS.md` is open, and hardcoding a single
//     policy is the topology assumption SECURITY.md forbids. The devnet corpus
//     carries TWO policies on one group precisely so this is exercised by data.
//
//  2. **`not-governed` and `unavailable` are different answers** (§3.4 R2).
//     `groupPolicyInfo` throws for a plain-account admin AND for an unreachable
//     node. Only an `LcdError` with status 404 is read as "not a policy"; every
//     other failure reports `unavailable`, because the conservative direction
//     never claims a governance topology that is not there. (A missing PROPOSAL
//     answers 500 on this build, so a status code is not a general semantic
//     signal here — hence the narrow 404-only rule.)
//
//  3. **A live read failure is never evidence of a prune** (§3.4 R7). This
//     module reports what it could read and nothing about what it could not;
//     `prunedAtHeight` from the mirror is the only source of "pruned".
//
//  4. **Every read is bounded and paginated to exhaustion under a cap.** An
//     x/group group has no membership ceiling and no proposal ceiling
//     (SECURITY.md: no unbounded work, all chain reads paginate). Hitting a cap
//     is reported as `truncated`, never silently dropped.

import {
  GroupClient,
  LcdClient,
  LcdError,
  NvhashContractClient,
  type FetchLike,
  type GroupDecisionPolicy,
  type GroupProposal,
  type GroupVote,
} from "@nvhash/chain-client";

import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";

/** Per-call page size and page cap for every paginated x/group read here.
 * A capped sweep is REPORTED (`truncated`), because "we stopped early" and
 * "that is all there is" are different facts. */
export const GROUP_PAGE_LIMIT = 100;
export const GROUP_MAX_PAGES = 10;

export interface LivePolicy {
  address: string;
  groupId: string;
  version: string;
  metadata: string;
  decisionPolicy: GroupDecisionPolicy;
}

export interface LiveMember {
  address: string;
  weight: string;
  metadata: string;
}

export interface LiveGroup {
  groupId: string;
  version: string;
  totalWeight: string;
}

/**
 * The live plane, or the honest reason there isn't one.
 *
 * `governed` carries the group; the member read may still have failed
 * independently, which is why `members` is separately nullable — "we know the
 * policies but could not list the electorate" is a real state and the page says
 * so rather than rendering an empty member table.
 */
export type LiveGovernance =
  | {
      state: "governed";
      group: LiveGroup;
      policies: LivePolicy[];
      policiesTruncated: boolean;
      members: LiveMember[] | null;
      membersTruncated: boolean;
    }
  | { state: "not-governed"; adminAddress: string }
  | { state: "unavailable" };

export interface GovernanceLiveDeps {
  fetchImpl?: FetchLike;
}

function clients(config: WebConfig, deps: GovernanceLiveDeps) {
  const lcd = new LcdClient(config.lcdUrl, {
    fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
    timeoutMs: CHROME_READ_TIMEOUT_MS,
  });
  return {
    contract: new NvhashContractClient(lcd, config.contractAddress),
    group: new GroupClient(lcd),
  };
}

/** Is this failure the chain saying "no such policy", or just a failure? */
function isNotFound(error: unknown): boolean {
  return error instanceof LcdError && error.status === 404;
}

/**
 * Page a cursor-paginated x/group read to exhaustion, under the page cap.
 * Returns what it collected plus whether the cap bounded it.
 */
async function pageAll<T>(
  read: (key: string | undefined) => Promise<{ items: T[]; nextKey: string | null }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let key: string | undefined = undefined;
  for (let page = 0; page < GROUP_MAX_PAGES; page++) {
    const result: { items: T[]; nextKey: string | null } = await read(key);
    items.push(...result.items);
    if (result.nextKey === null || result.nextKey === "") return { items, truncated: false };
    key = result.nextKey;
  }
  return { items, truncated: true };
}

/**
 * Resolve the program's live governance topology.
 *
 * Never throws: every failure lands on one of the three states above.
 */
export async function loadLiveGovernance(
  config: WebConfig,
  deps: GovernanceLiveDeps = {},
): Promise<LiveGovernance> {
  const { contract, group } = clients(config, deps);

  let adminAddress: string;
  try {
    adminAddress = (await contract.config()).admin;
  } catch {
    // The contract read failed, so nothing downstream can be trusted — and in
    // particular a policy lookup failure below could not be attributed.
    return { state: "unavailable" };
  }

  let policyInfo;
  try {
    policyInfo = await group.groupPolicyInfo(adminAddress);
  } catch (error) {
    return isNotFound(error) ? { state: "not-governed", adminAddress } : { state: "unavailable" };
  }

  const groupId = policyInfo.groupId;
  const [info, policies, members] = await Promise.all([
    group.groupInfo(groupId).catch(() => null),
    pageAll(async (key) => {
      const page = await group.groupPoliciesByGroup(groupId, {
        "pagination.limit": GROUP_PAGE_LIMIT,
        "pagination.key": key,
      });
      return { items: page.policies, nextKey: page.pagination.nextKey };
    }).catch(() => null),
    pageAll(async (key) => {
      const page = await group.groupMembers(groupId, {
        "pagination.limit": GROUP_PAGE_LIMIT,
        "pagination.key": key,
      });
      return { items: page.members, nextKey: page.pagination.nextKey };
    }).catch(() => null),
  ]);

  // The group read is what carries the version and total weight; without it a
  // percentage rule has no denominator and membership drift cannot be judged,
  // so this is `unavailable` rather than a partly-filled `governed`.
  if (info === null) return { state: "unavailable" };

  // The policy the contract's admin names is always in the set, even if the
  // by-group sweep failed — it was read successfully above.
  const discovered = policies?.items ?? [policyInfo];
  const byAddress = new Map(discovered.map((p) => [p.address, p] as const));
  byAddress.set(policyInfo.address, policyInfo);

  return {
    state: "governed",
    group: {
      groupId: groupId.toString(),
      version: info.version.toString(),
      totalWeight: info.totalWeight,
    },
    policies: [...byAddress.values()].map((p) => ({
      address: p.address,
      groupId: p.groupId.toString(),
      version: p.version.toString(),
      metadata: p.metadata,
      decisionPolicy: p.decisionPolicy,
    })),
    policiesTruncated: policies?.truncated ?? false,
    members:
      members === null
        ? null
        : members.items.map((m) => ({
            address: m.address,
            weight: m.weight,
            metadata: m.metadata,
          })),
    membersTruncated: members?.truncated ?? false,
  };
}

/**
 * Live proposals for one policy, keyed by id.
 *
 * `null` means the read FAILED — which is not the same as "this policy has no
 * proposals", and callers must render the two differently. An empty map is the
 * authoritative "the chain holds none of this policy's proposals right now"
 * (7.1: absence from a successful sweep is the only sound prune signal, and even
 * then it is the indexer's conclusion to draw, never this page's).
 */
export async function loadLiveProposals(
  config: WebConfig,
  policyAddress: string,
  deps: GovernanceLiveDeps = {},
): Promise<Map<string, GroupProposal> | null> {
  const { group } = clients(config, deps);
  try {
    const { items } = await pageAll(async (key) => {
      const page = await group.proposalsByGroupPolicy(policyAddress, {
        "pagination.limit": GROUP_PAGE_LIMIT,
        "pagination.key": key,
      });
      return { items: page.proposals, nextKey: page.pagination.nextKey };
    });
    return new Map(items.map((p) => [p.id.toString(), p] as const));
  } catch {
    return null;
  }
}

/**
 * One live proposal, or null when the chain could not serve it.
 *
 * Null is DELIBERATELY ambiguous and must be treated as "we could not read it":
 * the LCD answers a missing proposal with HTTP 500 and a body byte-identical for
 * a pruned id, a never-existing id and a node outage (pinned fact, 2026-07-29).
 * A caller that read null as "pruned" would state a fact the chain never gave it.
 */
export async function loadLiveProposal(
  config: WebConfig,
  proposalId: string,
  deps: GovernanceLiveDeps = {},
): Promise<GroupProposal | null> {
  const { group } = clients(config, deps);
  try {
    return await group.proposal(BigInt(proposalId));
  } catch {
    return null;
  }
}

/**
 * The module's own tally for one proposal, or null when the read failed.
 *
 * This is the ONLY live source of an open proposal's tally: `final_tally_result`
 * on the proposal is zeros until the module tallies, so the state plane cannot
 * answer "where does this stand now" — and rendering those zeros would assert
 * that nobody has voted. Null degrades to the mirror with a stale badge, which
 * is a weaker statement but a true one.
 */
export async function loadLiveTally(
  config: WebConfig,
  proposalId: string,
  deps: GovernanceLiveDeps = {},
): Promise<{ yes: string; no: string; abstain: string; no_with_veto: string } | null> {
  const { group } = clients(config, deps);
  try {
    const tally = await group.tallyResult(BigInt(proposalId));
    return {
      yes: tally.yesCount,
      no: tally.noCount,
      abstain: tally.abstainCount,
      no_with_veto: tally.noWithVetoCount,
    };
  } catch {
    return null;
  }
}

/**
 * Live votes on an OPEN proposal, or null when the read failed.
 *
 * Only meaningful while a proposal is open: x/group DELETES votes at the
 * voting-period-end tally even for an accepted proposal, so a closed proposal
 * answers 200 with an empty list. An empty list must therefore never overwrite
 * or blank the mirror's recorded votes (7.1 finding 2; §3.4 R6).
 */
export async function loadLiveVotes(
  config: WebConfig,
  proposalId: string,
  deps: GovernanceLiveDeps = {},
): Promise<GroupVote[] | null> {
  const { group } = clients(config, deps);
  try {
    const { items } = await pageAll(async (key) => {
      const page = await group.votesByProposal(BigInt(proposalId), {
        "pagination.limit": GROUP_PAGE_LIMIT,
        "pagination.key": key,
      });
      return { items: page.votes, nextKey: page.pagination.nextKey };
    });
    return items;
  } catch {
    return null;
  }
}
