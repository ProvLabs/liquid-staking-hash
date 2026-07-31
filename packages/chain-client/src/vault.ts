// Typed reads for the ProvLabs vault module over LCD REST.
//
// Pinned transport facts (fixture corpus, app-spec §14.2 stage 1):
// - REST paths live under /vault/v1 (NOT /provlabs/vault/v1).
// - estimate_swap_out serves over REST (string params); estimate_swap_in does
//   NOT — grpc-gateway rejects Coin/math.Int query parameters — so it throws
//   UnsupportedTransportError here until a gRPC path exists (or the formal
// vault release fixes the annotation; re-checked).
// All shapes are decoded against @nvhash/fixtures in test/.

import {
  DecodeError,
  expectArray,
  expectBoolean,
  expectObject,
  expectString,
  parseCoin,
  parseU64Number,
  parseU64String,
  type Coin,
} from "./amounts.ts";
import { type LcdClient, UnsupportedTransportError } from "./lcd.ts";
import { parsePagination, type Pagination } from "./types.ts";

export interface VaultAccount {
  address: string;
  coins: Coin[];
}

export interface VaultRecord {
  address: string;
  accountNumber: bigint;
  totalShares: Coin;
  underlyingAsset: string;
  paymentDenom: string;
  admin: string;
  assetManager: string;
  navAuthority: string;
  swapInEnabled: boolean;
  swapOutEnabled: boolean;
  withdrawalDelaySeconds: bigint;
  paused: boolean;
  pausedReason: string;
  pausedBalance: Coin;
  bridgeAddress: string;
  bridgeEnabled: boolean;
  aumFeeBips: number;
  /** empty string when the vault sets no bound */
  minSwapInValue: string;
  maxSwapInValue: string;
  minSwapOutValue: string;
  maxSwapOutValue: string;
}

export interface VaultState {
  vault: VaultRecord;
  principal: VaultAccount;
  reserves: VaultAccount;
  totalVaultValue: Coin;
}

export interface PendingSwapOut {
  owner: string;
  vaultAddress: string;
  shares: Coin;
  redeemDenom: string;
  /** RFC3339 — the moment an unfunded request refunds (contract §8) */
  timeout: string;
}

export interface SwapEstimate {
  assets: Coin;
  height: bigint;
  /** RFC3339 sample time — estimates re-price; never present as a promise */
  time: string;
}

export interface VaultParams {
  techFeeAddress: string;
  defaultAumFeeBips: number;
}

function parseAccount(value: unknown, path: string): VaultAccount {
  const o = expectObject(value, path);
  return {
    address: expectString(o["address"], `${path}.address`),
    coins: expectArray(o["coins"] ?? [], `${path}.coins`).map((c, i) =>
      parseCoin(c, `${path}.coins[${i}]`),
    ),
  };
}

function parseVaultRecord(value: unknown, path: string): VaultRecord {
  const o = expectObject(value, path);
  const base = expectObject(o["base_account"], `${path}.base_account`);
  return {
    address: expectString(base["address"], `${path}.base_account.address`),
    accountNumber: parseU64String(base["account_number"], `${path}.base_account.account_number`),
    totalShares: parseCoin(o["total_shares"], `${path}.total_shares`),
    underlyingAsset: expectString(o["underlying_asset"], `${path}.underlying_asset`),
    paymentDenom: expectString(o["payment_denom"], `${path}.payment_denom`),
    admin: expectString(o["admin"], `${path}.admin`),
    assetManager: expectString(o["asset_manager"], `${path}.asset_manager`),
    navAuthority: expectString(o["nav_authority"], `${path}.nav_authority`),
    swapInEnabled: expectBoolean(o["swap_in_enabled"], `${path}.swap_in_enabled`),
    swapOutEnabled: expectBoolean(o["swap_out_enabled"], `${path}.swap_out_enabled`),
    withdrawalDelaySeconds: parseU64String(
      o["withdrawal_delay_seconds"],
      `${path}.withdrawal_delay_seconds`,
    ),
    paused: expectBoolean(o["paused"] ?? false, `${path}.paused`),
    pausedReason: expectString(o["paused_reason"] ?? "", `${path}.paused_reason`),
    pausedBalance: parseCoin(
      o["paused_balance"] ?? { denom: "", amount: "0" },
      `${path}.paused_balance`,
    ),
    bridgeAddress: expectString(o["bridge_address"] ?? "", `${path}.bridge_address`),
    bridgeEnabled: expectBoolean(o["bridge_enabled"] ?? false, `${path}.bridge_enabled`),
    aumFeeBips: parseU64Number(o["aum_fee_bips"] ?? 0, `${path}.aum_fee_bips`),
    minSwapInValue: expectString(o["min_swap_in_value"] ?? "", `${path}.min_swap_in_value`),
    maxSwapInValue: expectString(o["max_swap_in_value"] ?? "", `${path}.max_swap_in_value`),
    minSwapOutValue: expectString(o["min_swap_out_value"] ?? "", `${path}.min_swap_out_value`),
    maxSwapOutValue: expectString(o["max_swap_out_value"] ?? "", `${path}.max_swap_out_value`),
  };
}

export function parseVaultState(value: unknown, path = "$"): VaultState {
  const o = expectObject(value, path);
  return {
    vault: parseVaultRecord(o["vault"], `${path}.vault`),
    principal: parseAccount(o["principal"], `${path}.principal`),
    reserves: parseAccount(o["reserves"], `${path}.reserves`),
    totalVaultValue: parseCoin(o["total_vault_value"], `${path}.total_vault_value`),
  };
}

export function parsePendingSwapOuts(
  value: unknown,
  path = "$",
): { pendingSwapOuts: PendingSwapOut[]; pagination: Pagination } {
  const o = expectObject(value, path);
  const list = expectArray(o["pending_swap_outs"], `${path}.pending_swap_outs`);
  return {
    pendingSwapOuts: list.map((e, i) => {
      const entry = expectObject(e, `${path}.pending_swap_outs[${i}]`);
      const p = expectObject(
        entry["pending_swap_out"],
        `${path}.pending_swap_outs[${i}].pending_swap_out`,
      );
      return {
        owner: expectString(p["owner"], `${path}[${i}].owner`),
        vaultAddress: expectString(p["vault_address"], `${path}[${i}].vault_address`),
        shares: parseCoin(p["shares"], `${path}[${i}].shares`),
        redeemDenom: expectString(p["redeem_denom"], `${path}[${i}].redeem_denom`),
        timeout: expectString(entry["timeout"], `${path}[${i}].timeout`),
      };
    }),
    pagination: parsePagination(o["pagination"], `${path}.pagination`),
  };
}

export function parseSwapEstimate(value: unknown, path = "$"): SwapEstimate {
  const o = expectObject(value, path);
  return {
    assets: parseCoin(o["assets"], `${path}.assets`),
    height: parseU64String(o["height"], `${path}.height`),
    time: expectString(o["time"], `${path}.time`),
  };
}

export function parseVaultParams(value: unknown, path = "$"): VaultParams {
  const o = expectObject(expectObject(value, path)["params"], `${path}.params`);
  return {
    techFeeAddress: expectString(o["tech_fee_address"], `${path}.params.tech_fee_address`),
    defaultAumFeeBips: parseU64Number(
      o["default_aum_fee_bips"],
      `${path}.params.default_aum_fee_bips`,
    ),
  };
}

export class VaultClient {
  constructor(private readonly lcd: LcdClient) {}

  async getVault(id: string): Promise<VaultState> {
    return parseVaultState(await this.lcd.get(`vault/v1/vaults/${id}`));
  }

  async listVaults(): Promise<{ vaults: VaultRecord[]; pagination: Pagination }> {
    const o = expectObject(await this.lcd.get("vault/v1/vaults"));
    return {
      vaults: expectArray(o["vaults"], "$.vaults").map((v, i) =>
        parseVaultRecord(v, `$.vaults[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }

  async params(): Promise<VaultParams> {
    return parseVaultParams(await this.lcd.get("vault/v1/params"));
  }

  async pendingSwapOuts(
    vault: string,
  ): Promise<{ pendingSwapOuts: PendingSwapOut[]; pagination: Pagination }> {
    return parsePendingSwapOuts(await this.lcd.get(`vault/v1/vaults/${vault}/pending_swap_outs`));
  }

  async estimateSwapOut(
    vault: string,
    shares: bigint,
    redeemDenom?: string,
  ): Promise<SwapEstimate> {
    if (shares < 0n) throw new DecodeError("$.shares", "shares must be non-negative");
    return parseSwapEstimate(
      await this.lcd.get(`vault/v1/vaults/${vault}/estimate_swap_out`, {
        shares,
        redeem_denom: redeemDenom,
      }),
    );
  }

  /**
   * NOT SERVABLE over LCD REST on the current dev build: grpc-gateway rejects
   * `Coin`/`math.Int` query parameters ("field type *types.Coin is not
   * supported"). Callers needing swap-in estimates must use a gRPC path
   * (server-side) or wait for the formal vault release to fix the annotation.
   * Kept as a method so the call site — the stake flow preview — fails
   * loudly at the boundary instead of silently estimating client-side.
   */
  estimateSwapIn(_vault: string, _assets: Coin): Promise<SwapEstimate> {
    return Promise.reject(
      new UnsupportedTransportError(
        "vault estimate_swap_in",
        "grpc-gateway rejects Coin/math.Int query parameters on the feature-probed dev build (fixture corpus pinned fact; re-check at the formal vault release)",
      ),
    );
  }
}
