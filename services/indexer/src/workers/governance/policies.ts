// Policy-set discovery (decision D1).
//
// The program's governance authority is a SET, never "the admin policy".
// `contracts/IMPLEMENTATION-STATUS.md` carries an open item to split the single
// `admin` authority into `admin_group_policy` and `ops_group_policy`; hardcoding
// one policy would be exactly the topology assumption SECURITY.md forbids, and
// would need rewriting the day that split lands. Discovery instead walks:
//
//     contract.config().admin  ->  group_policy_info(admin)  ->  { groupId }
//       ->  group_policies_by_group(groupId)  ∪  group_policies_by_admin(group.admin)
//
// and mirrors 1..n policies, discriminated by `gov_proposals.groupPolicyAddress`.
// The devnet substrate deliberately bootstraps TWO policies on one group so the
// fixture corpus CONTAINS the n>1 case rather than the code merely claiming to
// handle it.
//
// A PLAIN-ACCOUNT `Config.admin` — any chain with no x/group substrate — yields
// an EMPTY SET, empty committed windows, and honest-empty read surfaces. That is
// the no-governance state, not a crash and not a reason to fall back to a guess.
//
// Re-resolved per window, because membership and the policy set can both change
// under us and a cached set would quietly stop mirroring a new policy.

import { logger } from "../../logger.ts";
import { decodeMemberWeights } from "./decode.ts";

/** The pinned-read surface discovery needs (injectable for tests). */
export interface PolicySource {
  /** Height-pinned contract smart query; returns the `data` payload. */
  smartAtHeight(contract: string, query: Record<string, unknown>, height: bigint): Promise<unknown>;
  /** Height-pinned LCD GET; returns the parsed body. Throws on any failure. */
  getAtHeight(
    path: string,
    params: Record<string, string | number | bigint | undefined>,
    height: bigint,
  ): Promise<unknown>;
}

export interface PolicyInfo {
  readonly address: string;
  readonly groupId: bigint;
  /** The decision rule in force at this height, kept as raw JSON — snapshotted
   * onto each proposal so a historical tally-vs-threshold stays renderable. */
  readonly decisionPolicy: unknown;
}

export interface DiscoveredGovernance {
  readonly policies: PolicyInfo[];
  /** Member weights per groupId — the only source of a vote's weight, since the
   * module's `Vote` payload has none. */
  readonly memberWeights: Map<string, Map<string, string>>;
}

const EMPTY: DiscoveredGovernance = { policies: [], memberWeights: new Map() };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function policyFrom(value: unknown): PolicyInfo | null {
  const o = asRecord(value);
  if (o === null) return null;
  const address = o["address"];
  const groupId = o["group_id"];
  if (typeof address !== "string" || typeof groupId !== "string") return null;
  return { address, groupId: BigInt(groupId), decisionPolicy: o["decision_policy"] ?? null };
}

/**
 * Resolve the governance set as of `height`.
 *
 * `overridePolicies` short-circuits the walk. It exists for the real case of a
 * chain whose contract was deployed BEFORE the group existed: there is no
 * admin-rotation message (`ExecuteMsg` has no variant that changes
 * `Config.admin`, `InstantiateMsg.admin` is set once — M7 overview F2), so on
 * such a chain the walk correctly finds nothing and an operator has to name the
 * policies to index them. It is a configuration escape hatch, not a default, and
 * it never suppresses the walk's own discoveries — the two are unioned.
 */
export async function discoverGovernance(
  source: PolicySource,
  contractAddress: string,
  height: bigint,
  overridePolicies: readonly string[] = [],
): Promise<DiscoveredGovernance> {
  const byAddress = new Map<string, PolicyInfo>();

  const addPolicy = (info: PolicyInfo | null): void => {
    if (info !== null && !byAddress.has(info.address)) byAddress.set(info.address, info);
  };

  // 1. The contract's configured admin. A read failure here is NOT an empty set:
  //    that would silently stop mirroring governance during an LCD blip and the
  //    surfaces would report "no governance" about a program that has it. Let it
  //    throw so the window is retried.
  const config = asRecord(await source.smartAtHeight(contractAddress, { config: {} }, height));
  const admin = config?.["admin"];
  if (typeof admin !== "string" || admin === "") {
    throw new Error("contract config carries no admin address");
  }

  // 2. Is the admin a group policy at all? A plain account is the honest
  //    no-governance state, so a failure HERE (unlike above) is expected and
  //    yields the empty set. The distinction matters: step 1 failing means "we
  //    could not read", step 2 failing means "there is nothing to read".
  let adminPolicy: PolicyInfo | null = null;
  try {
    const body = asRecord(
      await source.getAtHeight(
        `cosmos/group/v1/group_policy_info/${encodeURIComponent(admin)}`,
        {},
        height,
      ),
    );
    adminPolicy = policyFrom(body?.["info"]);
  } catch {
    adminPolicy = null;
  }

  if (adminPolicy === null) {
    if (overridePolicies.length === 0) {
      logger.info("no group policy behind the contract admin: governance is empty", {
        stream: "governance",
        height,
      });
      return EMPTY;
    }
  } else {
    addPolicy(adminPolicy);
  }

  // 3. Every policy on that group, and every policy the group's admin
  //    administers. Both legs, because the split policy may be administered by
  //    the group's admin without being attached to the same group id.
  const groupIds = new Set<bigint>();
  if (adminPolicy !== null) groupIds.add(adminPolicy.groupId);

  for (const address of overridePolicies) {
    try {
      const body = asRecord(
        await source.getAtHeight(
          `cosmos/group/v1/group_policy_info/${encodeURIComponent(address)}`,
          {},
          height,
        ),
      );
      const info = policyFrom(body?.["info"]);
      if (info !== null) {
        addPolicy(info);
        groupIds.add(info.groupId);
      } else {
        logger.warn("configured governance policy is not a group policy", {
          stream: "governance",
          height,
        });
      }
    } catch {
      logger.warn("configured governance policy could not be read", {
        stream: "governance",
        height,
      });
    }
  }

  for (const groupId of groupIds) {
    for (const p of await paginate(
      source,
      `cosmos/group/v1/group_policies_by_group/${groupId.toString()}`,
      "group_policies",
      height,
    )) {
      addPolicy(policyFrom(p));
    }

    const groupBody = asRecord(
      await source.getAtHeight(`cosmos/group/v1/group_info/${groupId.toString()}`, {}, height),
    );
    const groupAdmin = asRecord(groupBody?.["info"])?.["admin"];
    if (typeof groupAdmin === "string" && groupAdmin !== "") {
      for (const p of await paginate(
        source,
        `cosmos/group/v1/group_policies_by_admin/${encodeURIComponent(groupAdmin)}`,
        "group_policies",
        height,
      )) {
        addPolicy(policyFrom(p));
      }
    }
  }

  // 4. Member weights per group — the only place a vote's weight can come from.
  const memberWeights = new Map<string, Map<string, string>>();
  for (const groupId of new Set([...byAddress.values()].map((p) => p.groupId))) {
    const members = await paginate(
      source,
      `cosmos/group/v1/group_members/${groupId.toString()}`,
      "members",
      height,
    );
    memberWeights.set(groupId.toString(), decodeMemberWeights(members));
  }

  return { policies: [...byAddress.values()], memberWeights };
}

/** Hard cap on pages followed per collection read. */
export const MAX_PAGES = 50;
/** Page size requested from the LCD. */
export const PAGE_LIMIT = 100;

/**
 * Follow `pagination.next_key` to exhaustion under a page cap.
 *
 * Hitting the cap THROWS rather than returning a short list, and that choice is
 * the whole point (invariant 14): a silently truncated sweep is
 * indistinguishable from a prune, and the write path treats absence from a
 * successful sweep as evidence the chain dropped a proposal. Truncation would
 * therefore mark live proposals pruned — corrupting the mirror in exactly the
 * direction it exists to prevent. Failing the window is recoverable; a false
 * prune written durably is not.
 */
export async function paginate(
  source: PolicySource,
  path: string,
  field: string,
  height: bigint,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let key: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string | number | undefined> = { "pagination.limit": PAGE_LIMIT };
    if (key !== undefined) params["pagination.key"] = key;
    const body = asRecord(await source.getAtHeight(path, params, height));
    const items = body?.[field];
    if (Array.isArray(items)) out.push(...items);
    const nextKey = asRecord(body?.["pagination"])?.["next_key"];
    if (typeof nextKey !== "string" || nextKey === "") return out;
    key = nextKey;
  }
  throw new Error(
    `pagination cap (${MAX_PAGES} pages of ${PAGE_LIMIT}) reached on ${path} at height ${height}: ` +
      `refusing to commit a truncated sweep, which would be indistinguishable from a prune`,
  );
}
