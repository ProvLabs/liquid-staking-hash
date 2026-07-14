// LCD read transport (spec §5, §13). Smart queries over the CosmWasm route;
// module/vault reads over their REST paths. The console's sole data transport for reads.
import { config } from "@/config";
import type { PendingSwapOut, VaultInfo } from "@/lib/types";

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

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${LCD_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`LCD ${res.status} ${path}`);
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
  const liquid = (principal.coins ?? []).find((c: { denom: string }) => c.denom === config.baseDenom)?.amount ?? "0";
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

/** Vault pending swap-out queue (paginated). Live shape: { pending_swap_outs:[], pagination }. */
export async function pendingSwapOuts(vaultAddress: string): Promise<PendingSwapOut[]> {
  const out: PendingSwapOut[] = [];
  let key: string | null = null;
  // page to exhaustion (spec §13); limit 100 to match the contract's own reads
  do {
    const q = new URLSearchParams({ "pagination.limit": "100" });
    if (key) q.set("pagination.key", key);
    const body = await getJson(`/vault/v1/vaults/${vaultAddress}/pending_swap_outs?${q}`);
    for (const r of body.pending_swap_outs ?? []) {
      out.push({
        id: Number(r.id ?? r.request_id ?? 0),
        owner: r.owner ?? r.address ?? "",
        shares: r.shares?.amount ?? r.shares ?? "0",
        estimate_nhash: r.estimate?.amount ?? r.estimate_nhash ?? r.amount?.amount ?? "0",
        enqueued_at_seconds: Number(r.enqueued_at_seconds ?? r.created_at ?? 0),
      });
    }
    key = body.pagination?.next_key ?? null;
  } while (key);
  return out;
}

/** Contract staking totals for the deployment split (spec §5.2). delegated = Σ delegation
 *  balances; unbonding = Σ unbonding entry balances. One page suffices (MAX_VALIDATORS=50). */
export async function stakingTotals(delegator: string): Promise<{ delegated: string; unbonding: string }> {
  const del = await getJson(`/cosmos/staking/v1beta1/delegations/${delegator}?pagination.limit=200`);
  let delegated = 0n;
  for (const r of del.delegation_responses ?? []) delegated += BigInt(r.balance?.amount ?? "0");
  const unb = await getJson(`/cosmos/staking/v1beta1/delegators/${delegator}/unbonding_delegations?pagination.limit=200`);
  let unbonding = 0n;
  for (const r of unb.unbonding_responses ?? []) for (const e of r.entries ?? []) unbonding += BigInt(e.balance ?? "0");
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
