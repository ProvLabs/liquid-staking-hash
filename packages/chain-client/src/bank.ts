// x/bank balance reads (app plan PR 5.2): the balance-including-fee
// preflight bound (§10.2 step 2). Spendable balances subtract vesting locks
// — the honest number for "can this account fund the transfer + fee".

import { expectArray, expectObject, parseCoin, type Coin } from "./amounts.ts";
import { LcdClient } from "./lcd.ts";
import { parsePagination, type Pagination } from "./types.ts";

export class BankClient {
  constructor(private readonly lcd: LcdClient) {}

  /** GET /cosmos/bank/v1beta1/balances/{address}/by_denom — total balance. */
  async balance(address: string, denom: string): Promise<Coin> {
    const o = expectObject(
      await this.lcd.get(
        `cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}/by_denom`,
        { denom },
      ),
    );
    return parseCoin(o["balance"], "$.balance");
  }

  /**
   * GET /cosmos/bank/v1beta1/spendable_balances/{address} — balances net of
   * vesting locks (the §8.3 vesting-honesty figure).
   */
  async spendableBalances(
    address: string,
  ): Promise<{ balances: Coin[]; pagination: Pagination }> {
    const o = expectObject(
      await this.lcd.get(
        `cosmos/bank/v1beta1/spendable_balances/${encodeURIComponent(address)}`,
      ),
    );
    return {
      balances: expectArray(o["balances"] ?? [], "$.balances").map((c, i) =>
        parseCoin(c, `$.balances[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }
}
