// LCD read transport (spec §5, §13). Smart queries over the CosmWasm route;
// module/vault reads over their REST paths. The console's sole data transport for reads.
import { config } from "@/config";
import type {
  Bounded,
  GroupInfo,
  GroupMember,
  GroupPolicyInfo,
  GroupProposal,
  GroupVote,
  PendingSwapOut,
  TallyCounts,
  VaultInfo,
} from "@/lib/types";

// Under Vite (dev + `vite preview`) route reads through the same-origin `/lcd` proxy so the
// browser never makes a cross-origin request to the node (avoids CORS in local dev, see
// vite.config.ts). A real deployed build talks to the absolute lcd_url, which must itself
// send CORS for the console origin (spec §14.2).
const LCD_BASE = import.meta.env.DEV || import.meta.env.MODE === "preview" ? "/lcd" : config.lcdUrl;

function b64(json: unknown): string {
  // The LCD gateway decodes query_data with Go's StdEncoding (standard base64, padded).
  // URL-safe base64 is rejected once a payload contains '+' or '/', so use standard here.
  const s = JSON.stringify(json);
  return btoa(unescape(encodeURIComponent(s)));
}

/** An LCD non-2xx, with the status recoverable by callers that must
 *  distinguish a 404 fact from every other failure (chain-facts §x/group 8). */
export class LcdError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`LCD ${status} ${path}`);
    this.status = status;
  }
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${LCD_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new LcdError(res.status, path);
  return res.json();
}

/** Status-aware GET for callers that must react to a specific status (the
 *  broadcast poller's 404-means-not-yet-included); throws LcdError otherwise. */
export async function lcdGetJson(path: string): Promise<unknown> {
  return getJson(path);
}

/** POST with the chain's own error surfaced VERBATIM (spec §17: a simulate or
 *  broadcast failure shows what the chain said, not a paraphrase). */
export async function lcdPostJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${LCD_BASE}${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // non-JSON error body: surface the raw text
    }
    throw new Error(`LCD ${res.status} ${path}: ${detail}`);
  }
  return res.json();
}

/** Contract smart query (spec §13): responses wrap the contract JSON under `data`. */
export async function smartQuery<T>(queryMsg: unknown): Promise<T> {
  const path = `/cosmwasm/wasm/v1/contract/${config.contractAddress}/smart/${b64(queryMsg)}`;
  const body = await getJson(path);
  return body.data as T;
}

/** Vault REST read (spec §14.2), reconciled against the live devnet shape (2026-07-10):
 *  { vault: { total_shares:{denom,amount}, withdrawal_delay_seconds:"<str>", paused,
 *             paused_reason }, principal: { address, coins:[{denom,amount}] } }.
 *  This build exposes no `total_vault_value`; NAV/TVV fall back to the contract snapshot. */
export async function vaultQuery(vaultAddress: string): Promise<VaultInfo> {
  const body = await getJson(`/vault/v1/vaults/${vaultAddress}`);
  const v = body.vault ?? {};
  const principal = body.principal ?? {};
  const liquid =
    (principal.coins ?? []).find((c: { denom: string }) => c.denom === config.baseDenom)?.amount ??
    "0";
  return {
    total_vault_value: v.total_vault_value ?? "", // not on this build -> derived from snapshot
    total_shares: v.total_shares?.amount ?? "0",
    paused: !!v.paused,
    pause_reason: v.paused_reason || undefined,
    withdrawal_delay_seconds: Number(v.withdrawal_delay_seconds ?? 0),
    principal_marker_address: principal.address ?? "",
    principal_liquid_nhash: liquid,
  };
}

/** Query/EstimateSwapOut: underlying assets for `shares` at current NAV. */
async function estimateSwapOut(vaultAddress: string, sharesAmount: string): Promise<string> {
  const q = new URLSearchParams({ shares: sharesAmount });
  const body = await getJson(`/vault/v1/vaults/${vaultAddress}/estimate_swap_out?${q}`);
  const amount = body?.assets?.amount;
  if (typeof amount !== "string") throw new Error("estimate_swap_out: unexpected response shape");
  return amount;
}

/** Vault pending swap-out queue (paginated). Rows are PendingSwapOutWithTimeout:
 *  { request_id, pending_swap_out: { owner, shares: Coin, redeem_denom }, timeout }.
 *  Parse strictly; a silent default here would lie about real requests (spec §17). */
export async function pendingSwapOuts(vaultAddress: string): Promise<PendingSwapOut[]> {
  const rows: Omit<PendingSwapOut, "estimate_nhash">[] = [];
  let key: string | null = null;
  // page to exhaustion (spec §13); limit 100 to match the contract's own reads
  do {
    const q = new URLSearchParams({ "pagination.limit": "100" });
    if (key) q.set("pagination.key", key);
    const body = await getJson(`/vault/v1/vaults/${vaultAddress}/pending_swap_outs?${q}`);
    for (const r of body.pending_swap_outs ?? []) {
      const p = r?.pending_swap_out;
      const maturesAtMs = Date.parse(r?.timeout ?? "");
      if (
        r?.request_id == null ||
        !p?.owner ||
        typeof p?.shares?.amount !== "string" ||
        Number.isNaN(maturesAtMs)
      )
        throw new Error(
          `pending_swap_outs: unexpected row shape: ${JSON.stringify(r).slice(0, 200)}`,
        );
      rows.push({
        id: Number(r.request_id),
        owner: p.owner,
        shares: p.shares.amount,
        matures_at_seconds: Math.floor(maturesAtMs / 1000),
      });
    }
    key = body.pagination?.next_key ?? null;
  } while (key);
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      estimate_nhash: await estimateSwapOut(vaultAddress, r.shares),
    })),
  );
}

/** Contract staking totals for the deployment split (spec §5.2). delegated = Σ delegation
 *  balances; unbonding = Σ unbonding entry balances. One page suffices (MAX_VALIDATORS=50). */
export async function stakingTotals(
  delegator: string,
): Promise<{ delegated: string; unbonding: string }> {
  const del = await getJson(
    `/cosmos/staking/v1beta1/delegations/${delegator}?pagination.limit=200`,
  );
  let delegated = 0n;
  for (const r of del.delegation_responses ?? []) delegated += BigInt(r.balance?.amount ?? "0");
  const unb = await getJson(
    `/cosmos/staking/v1beta1/delegators/${delegator}/unbonding_delegations?pagination.limit=200`,
  );
  let unbonding = 0n;
  for (const r of unb.unbonding_responses ?? [])
    for (const e of r.entries ?? []) unbonding += BigInt(e.balance ?? "0");
  return { delegated: delegated.toString(), unbonding: unbonding.toString() };
}

export async function latestBlock(): Promise<{ height: number; timeSecs: number }> {
  const body = await getJson(`/cosmos/base/tendermint/v1beta1/blocks/latest`);
  const header = body?.block?.header ?? {};
  return {
    height: Number(header.height ?? 0),
    timeSecs: header.time ? Math.floor(new Date(header.time).getTime() / 1000) : 0,
  };
}

// ---- x/group governance reads (spec §8.0 /governance; PR 8.4b) -------------
// Routes as exercised by the indexer's governance worker. Every list read is
// BOUNDED: an explicit page cap with the hit carried in the return type,
// because a hidden cap is a silent prune (chain-facts §x/group 9, C2).

/** Per-read page caps (100 rows/page, the module's own page size). */
export const GOV_PROPOSAL_PAGE_CAP = 10;
export const GOV_VOTE_PAGE_CAP = 5;
export const GOV_MEMBER_PAGE_CAP = 5;
export const GOV_POLICY_PAGE_CAP = 2;

/** Follow `pagination.next_key` to exhaustion under `pageCap`; a next_key
 *  surviving the cap marks the result truncated — a prefix, not the set. */
async function pagedList<T>(path: string, field: string, pageCap: number): Promise<Bounded<T>> {
  const items: T[] = [];
  let key: string | null = null;
  for (let page = 0; page < pageCap; page++) {
    const q = new URLSearchParams({ "pagination.limit": "100" });
    if (key) q.set("pagination.key", key);
    const body = await getJson(`${path}${path.includes("?") ? "&" : "?"}${q}`);
    for (const row of body[field] ?? []) items.push(row as T);
    key = body.pagination?.next_key ?? null;
    if (!key) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/**
 * The plain-account discriminator (chain-facts §x/group 8): a 404 on the
 * policy lookup IS the fact "no group behind this deployment"; every other
 * failure stays a throw, so the caller renders "could not check", never
 * "no group".
 */
export async function groupPolicyInfo(
  address: string,
): Promise<{ found: true; info: GroupPolicyInfo } | { found: false }> {
  try {
    const body = await getJson(`/cosmos/group/v1/group_policy_info/${encodeURIComponent(address)}`);
    return { found: true, info: body.info as GroupPolicyInfo };
  } catch (e) {
    if (e instanceof LcdError && e.status === 404) return { found: false };
    throw e;
  }
}

export async function groupInfo(groupId: string): Promise<GroupInfo> {
  const body = await getJson(`/cosmos/group/v1/group_info/${encodeURIComponent(groupId)}`);
  return body.info as GroupInfo;
}

export async function groupPoliciesByGroup(groupId: string): Promise<Bounded<GroupPolicyInfo>> {
  return pagedList(
    `/cosmos/group/v1/group_policies_by_group/${encodeURIComponent(groupId)}`,
    "group_policies",
    GOV_POLICY_PAGE_CAP,
  );
}

export async function groupMembers(groupId: string): Promise<Bounded<GroupMember>> {
  return pagedList(
    `/cosmos/group/v1/group_members/${encodeURIComponent(groupId)}`,
    "members",
    GOV_MEMBER_PAGE_CAP,
  );
}

export async function proposalsByPolicy(policyAddress: string): Promise<Bounded<GroupProposal>> {
  return pagedList(
    `/cosmos/group/v1/proposals_by_group_policy/${encodeURIComponent(policyAddress)}`,
    "proposals",
    GOV_PROPOSAL_PAGE_CAP,
  );
}

/** The live tally for an OPEN proposal — `final_tally_result` is zeros until
 *  the module tallies, and rendering those zeros would assert "nobody voted"
 *  (chain-facts §x/group 7). */
export async function proposalTally(proposalId: string): Promise<TallyCounts> {
  const body = await getJson(`/cosmos/group/v1/proposals/${encodeURIComponent(proposalId)}/tally`);
  return body.tally as TallyCounts;
}

export async function votesByProposal(proposalId: string): Promise<Bounded<GroupVote>> {
  return pagedList(
    `/cosmos/group/v1/votes_by_proposal/${encodeURIComponent(proposalId)}`,
    "votes",
    GOV_VOTE_PAGE_CAP,
  );
}
