// x/auth account reads: account number + sequence for the
// SIGN_MODE_DIRECT sign doc, and the account TYPE for the §8.3 vesting-lock
// preflight — a vesting account's locked HASH cannot fund a SwapIn, so the
// preflight must know before the wallet is ever asked to sign.

import { expectObject, expectString, parseU64String } from "./amounts.ts";
import { LcdClient, LcdError } from "./lcd.ts";

export interface AccountInfo {
  address: string;
  accountNumber: bigint;
  sequence: bigint;
  /** The proto type URL, e.g. "/cosmos.auth.v1beta1.BaseAccount". */
  typeUrl: string;
  /** True for any *VestingAccount type (§8.3 vesting-lock preflight). */
  isVesting: boolean;
}

export class AuthClient {
  constructor(private readonly lcd: LcdClient) {}

  /**
   * GET /cosmos/auth/v1beta1/accounts/{address}. Null when the account does
   * not exist on chain yet (never funded) — a preflight fact, not an error.
   */
  async account(address: string): Promise<AccountInfo | null> {
    let o: Record<string, unknown>;
    try {
      o = expectObject(
        await this.lcd.get(`cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`),
      );
    } catch (error) {
      if (error instanceof LcdError && error.status === 404) return null;
      throw error;
    }
    const account = expectObject(o["account"], "$.account");
    const typeUrl = expectString(account["@type"], "$.account.@type");
    // Vesting accounts nest the base account; base accounts carry it flat.
    const base =
      account["base_vesting_account"] !== undefined
        ? expectObject(
            expectObject(account["base_vesting_account"], "$.account.base_vesting_account")[
              "base_account"
            ],
            "$.account.base_vesting_account.base_account",
          )
        : (account["base_account"] !== undefined
            ? expectObject(account["base_account"], "$.account.base_account")
            : account);
    return {
      address: expectString(base["address"], "$.account…address"),
      accountNumber: parseU64String(base["account_number"], "$.account…account_number"),
      sequence: parseU64String(base["sequence"] ?? "0", "$.account…sequence"),
      typeUrl,
      isVesting: typeUrl.includes("Vesting"),
    };
  }
}
