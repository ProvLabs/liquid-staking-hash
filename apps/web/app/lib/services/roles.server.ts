// Role detection as live on-chain facts (app-spec §4): operator
// = session address ∈ the contract's `Validators {}` operator set; admin =
// session address ∈ the members of the x/group policy behind the contract's
// `Config.admin`. Re-checked per session refresh through a short-TTL cache —
// NEVER persisted (the sessions schema has no role column by design; the
// allowlist gate fails if one appears; test/roles.test.ts pins the
// membership-loss-on-refresh behavior).
//
// On a failed chain read the caller gets a degradation flag and the role that
// leg would have decided is `false` — the App never guesses a privilege and
// never renders a role surface from stale knowledge (SECURITY.md: never lie
// about state).
//
// THE TWO ROLES FAIL INDEPENDENTLY, so there are two flags. `degraded` means
// the CONTRACT read failed and neither role is known; `adminDegraded` means the
// contract read succeeded and the x/group membership read did not, so
// `operator` is a fact and `admin: false` is a safe default. One flag for both
// would blank the operator surface — which gates on `degraded` and needs only
// `Validators {}` — every time the unrelated group query flickered. Only a 404
// on the policy lookup is a fact ("the admin is a plain account"), and only
// because the module says so.
//
// The cache is for RENDERING. Minting the `admin:` service assertion goes
// through `verifyAdminUncached` instead, which bypasses it in both directions
// (ADR-001 Decision 2, amendment 2026-07-28): a cached role is a stale
// privilege, and app-spec §12 requires the membership re-read per session
// refresh rather than per cached role.

import {
  GroupClient,
  LcdClient,
  LcdError,
  NvhashContractClient,
  type FetchLike,
} from "@nvhash/chain-client";

import type { WebConfig } from "~/config/config.server";

/** Plan §7 Q6 proposal: roles re-read at most every 60 s per address. */
export const ROLE_CACHE_TTL_SECONDS = 60;

export interface Roles {
  operator: boolean;
  admin: boolean;
  /**
   * True when the CONTRACT read failed, so neither role could be decided and
   * both are safe defaults.
   *
   * Scoped to the contract read on purpose. The operator surface gates on this
   * flag, and the operator fact comes from `Validators {}` alone — widening it
   * to "any leg failed" would blank a working operator view whenever the
   * unrelated x/group query flickered.
   */
  degraded: boolean;
  /**
   * True when the contract read succeeded but the x/group MEMBERSHIP read did
   * not, so `admin: false` is a safe default rather than a finding.
   *
   * Separate from `degraded` because the two roles have different authorities
   * and fail independently. `admin` is a fact only when neither flag is set —
   * any surface rendering it must check both, which is why this is a field and
   * not a comment.
   */
  adminDegraded: boolean;
}

export interface RoleDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
}

interface CacheEntry {
  roles: Roles;
  expiresAtMs: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: drop all cached role reads. */
export function resetRoleCacheForTests(): void {
  cache.clear();
}

/**
 * The outcome of an admin membership read. Three states across two fields:
 * a member (`admin`), a confirmed non-member (`!admin && !degraded`), and an
 * unknown (`degraded`) — which is neither, and must never be rendered as the
 * second.
 */
export interface AdminCheck {
  /** True only on a SUCCESSFUL read that found the address in the group. */
  admin: boolean;
  /** True when the membership read failed — `admin` is then a safe default,
   * not a fact. */
  degraded: boolean;
}

/** Is this failure the chain saying "no such policy", or just a failure?
 *
 * ONLY a 404 is read as "the admin is a plain account". Every other failure is
 * a failure, because "there is no group here" and "we could not ask" are
 * different facts and a plain `catch` cannot tell them apart — the
 * `governance.server.ts` rule, applied to the read that mints a privilege. (A
 * missing PROPOSAL answers 500 on this build, so a status code is not a general
 * semantic signal for x/group — hence the narrow 404-only test.) */
function isNotFound(error: unknown): boolean {
  return error instanceof LcdError && error.status === 404;
}

/**
 * Is `address` a member of the group behind `adminAccount`? The contract's
 * admin is expected to be a group-policy account; resolve policy → group →
 * members.
 *
 * THREE OUTCOMES, not two. A 404 on the policy lookup means `adminAccount` is a
 * plain account, and direct address equality is then the on-chain fact — a real
 * answer. Any OTHER policy failure, and any `groupMembers` failure, is
 * `degraded`: the read did not happen, so `admin: false` would be a safe
 * default dressed as a finding. Collapsing those into `false` told a real admin
 * "this address is not a program administrator" whenever the group query
 * flickered, which is a fact the App does not have (SECURITY.md: never lie
 * about state; app-spec §12.1).
 *
 * `groupMembers` deliberately has NO equality fallback: the policy resolved, so
 * a group exists, and answering a membership question from address equality
 * would be deciding it from an input that is not authoritative for it.
 */
async function readAdminMembership(
  group: GroupClient,
  adminAccount: string,
  address: string,
): Promise<AdminCheck> {
  let policy;
  try {
    policy = await group.groupPolicyInfo(adminAccount);
  } catch (error) {
    if (isNotFound(error)) return { admin: adminAccount === address, degraded: false };
    return { admin: false, degraded: true };
  }
  try {
    const { members } = await group.groupMembers(policy.groupId);
    return { admin: members.some((m) => m.address === address), degraded: false };
  } catch {
    return { admin: false, degraded: true };
  }
}

function clientsFor(config: WebConfig, deps: RoleDeps) {
  const lcd = new LcdClient(config.lcdUrl, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  return {
    contract: new NvhashContractClient(lcd, config.contractAddress),
    group: new GroupClient(lcd),
  };
}

async function readRoles(config: WebConfig, address: string, deps: RoleDeps): Promise<Roles> {
  const { contract, group } = clientsFor(config, deps);

  try {
    const [validators, contractConfig] = await Promise.all([
      contract.validators(),
      contract.config(),
    ]);
    const operator = validators.some((v) => v.operator === address);
    // A membership read that did not happen degrades ADMIN only. The operator
    // fact came from a read that succeeded and stays a fact.
    const membership = await readAdminMembership(group, contractConfig.admin, address);
    return {
      operator,
      admin: membership.admin,
      degraded: false,
      adminDegraded: membership.degraded,
    };
  } catch {
    return { operator: false, admin: false, degraded: true, adminDegraded: true };
  }
}

/**
 * Read admin group membership for `address` from chain, **bypassing the role
 * cache in both directions** — it is neither consulted nor populated.
 *
 * {@link detectRoles}'s `ROLE_CACHE_TTL_SECONDS` cache is correct for
 * *rendering* a role surface and wrong for *minting a privilege*: a 60 s stale
 * admin is 60 s of retained capability after membership is revoked (ADR-001
 * Decision 2, amendment 2026-07-28). This is the read
 * `mintAdminAssertion` is built on, and the only caller that may mint from it.
 *
 * A failed read returns `{ admin: false, degraded: true }` — the caller mints
 * nothing rather than a hopeful assertion. That covers BOTH legs: the contract
 * `Config {}` read and the x/group membership read. A group query that fails
 * while the contract read succeeds is `degraded`, never `admin: false`, because
 * a flickering group endpoint must not lock a real admin out under a message
 * that states a fact we do not have.
 */
export async function verifyAdminUncached(
  config: WebConfig,
  address: string,
  deps: RoleDeps = {},
): Promise<AdminCheck> {
  const { contract, group } = clientsFor(config, deps);
  let contractConfig;
  try {
    contractConfig = await contract.config();
  } catch {
    return { admin: false, degraded: true };
  }
  return readAdminMembership(group, contractConfig.admin, address);
}

/**
 * Detect roles for an address with the short-TTL cache. Degraded results are
 * NOT cached: the next call retries the chain rather than pinning a failure.
 */
export async function detectRoles(
  config: WebConfig,
  address: string,
  deps: RoleDeps = {},
): Promise<Roles> {
  const nowMs = (deps.now ?? Date.now)();
  const hit = cache.get(address);
  if (hit !== undefined && hit.expiresAtMs > nowMs) return hit.roles;

  const roles = await readRoles(config, address, deps);
  // Neither flag, not just `degraded`: caching a run whose membership read
  // failed would pin `admin: false` — a safe default — as an answer for a full
  // TTL, which is the staleness this cache is already careful about.
  if (!roles.degraded && !roles.adminDegraded) {
    cache.set(address, { roles, expiresAtMs: nowMs + ROLE_CACHE_TTL_SECONDS * 1000 });
  }
  return roles;
}
