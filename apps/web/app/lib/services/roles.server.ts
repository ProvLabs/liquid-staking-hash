// Role detection as live on-chain facts (app-spec §4): operator
// = session address ∈ the contract's `Validators {}` operator set; admin =
// session address ∈ the members of the x/group policy behind the contract's
// `Config.admin`. Re-checked per session refresh through a short-TTL cache —
// NEVER persisted (the sessions schema has no role column by design; the
// allowlist gate fails if one appears; test/roles.test.ts pins the
// membership-loss-on-refresh behavior).
//
// On a failed chain read the caller gets `degraded: true` with both roles
// false — the App never guesses a privilege and never renders a role surface
// from stale knowledge (SECURITY.md: never lie about state).
//
// The cache is for RENDERING. Minting the `admin:` service assertion goes
// through `verifyAdminUncached` instead, which bypasses it in both directions
// (ADR-001 Decision 2, amendment 2026-07-28): a cached role is a stale
// privilege, and app-spec §12 requires the membership re-read per session
// refresh rather than per cached role.

import { GroupClient, LcdClient, NvhashContractClient, type FetchLike } from "@nvhash/chain-client";

import type { WebConfig } from "~/config/config.server";

/** Plan §7 Q6 proposal: roles re-read at most every 60 s per address. */
export const ROLE_CACHE_TTL_SECONDS = 60;

export interface Roles {
  operator: boolean;
  admin: boolean;
  /** True when a chain read failed and the roles above are a safe default. */
  degraded: boolean;
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
 * Is `address` a member of the group behind `adminAccount`? The contract's
 * admin is expected to be a group-policy account; resolve policy → group →
 * members. A policy lookup failure (a plain-account admin) degrades to direct
 * address equality — an on-chain fact either way, never a stored role.
 */
async function readAdminMembership(
  group: GroupClient,
  adminAccount: string,
  address: string,
): Promise<boolean> {
  try {
    const policy = await group.groupPolicyInfo(adminAccount);
    const { members } = await group.groupMembers(policy.groupId);
    return members.some((m) => m.address === address);
  } catch {
    return adminAccount === address;
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
    const admin = await readAdminMembership(group, contractConfig.admin, address);
    return { operator, admin, degraded: false };
  } catch {
    return { operator: false, admin: false, degraded: true };
  }
}

/** The outcome of a fresh admin membership read (never cached, either way). */
export interface AdminCheck {
  /** True only on a SUCCESSFUL read that found the address in the group. */
  admin: boolean;
  /** True when the chain read failed — `admin` is then a safe default, not a fact. */
  degraded: boolean;
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
 * nothing rather than a hopeful assertion.
 */
export async function verifyAdminUncached(
  config: WebConfig,
  address: string,
  deps: RoleDeps = {},
): Promise<AdminCheck> {
  const { contract, group } = clientsFor(config, deps);
  try {
    const contractConfig = await contract.config();
    return {
      admin: await readAdminMembership(group, contractConfig.admin, address),
      degraded: false,
    };
  } catch {
    return { admin: false, degraded: true };
  }
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
  if (!roles.degraded) {
    cache.set(address, { roles, expiresAtMs: nowMs + ROLE_CACHE_TTL_SECONDS * 1000 });
  }
  return roles;
}
