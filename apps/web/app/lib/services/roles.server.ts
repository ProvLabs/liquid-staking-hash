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

import {
  GroupClient,
  LcdClient,
  NvhashContractClient,
  type FetchLike,
} from "@nvhash/chain-client";

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

async function readRoles(config: WebConfig, address: string, deps: RoleDeps): Promise<Roles> {
  const lcd = new LcdClient(config.lcdUrl, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const contract = new NvhashContractClient(lcd, config.contractAddress);
  const group = new GroupClient(lcd);

  try {
    const [validators, contractConfig] = await Promise.all([
      contract.validators(),
      contract.config(),
    ]);
    const operator = validators.some((v) => v.operator === address);

    // Admin: the contract's admin is expected to be a group-policy account.
    // Resolve policy → group → members; a policy lookup failure (plain
    // account admin) degrades to direct address equality — an on-chain fact
    // either way, never a stored role.
    let admin = false;
    try {
      const policy = await group.groupPolicyInfo(contractConfig.admin);
      const { members } = await group.groupMembers(policy.groupId);
      admin = members.some((m) => m.address === address);
    } catch {
      admin = contractConfig.admin === address;
    }

    return { operator, admin, degraded: false };
  } catch {
    return { operator: false, admin: false, degraded: true };
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
