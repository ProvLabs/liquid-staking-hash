// Tx endpoints over LCD (§10.2 steps 3/5): simulate for
// gas, broadcast of a USER-SIGNED transaction, and inclusion polling. This
// client never constructs or signs anything — it carries bytes the wallet
// produced (SECURITY.md: signing happens client-side in the wallet; the
// web tier's relay guards are in apps/web, not here).

import { expectObject, expectString, parseU64String } from "./amounts.ts";
import { LcdClient, LcdError } from "./lcd.ts";

export interface GasInfo {
  gasWanted: bigint;
  gasUsed: bigint;
}

export interface BroadcastResult {
  txhash: string;
  /** 0 = accepted into the mempool check; inclusion is polled separately. */
  code: number;
  rawLog: string;
}

export interface TxInclusion {
  txhash: string;
  height: bigint;
  /** 0 = executed successfully. */
  code: number;
  rawLog: string;
  gasUsed: bigint;
  timestamp: string;
}

export class TxClient {
  constructor(private readonly lcd: LcdClient) {}

  /** POST /cosmos/tx/v1beta1/simulate over an (unsigned-ok) tx's raw bytes. */
  async simulate(txBytesBase64: string): Promise<GasInfo> {
    const o = expectObject(
      await this.lcd.post("cosmos/tx/v1beta1/simulate", { tx_bytes: txBytesBase64 }),
    );
    const gas = expectObject(o["gas_info"], "$.gas_info");
    return {
      gasWanted: parseU64String(gas["gas_wanted"] ?? "0", "$.gas_info.gas_wanted"),
      gasUsed: parseU64String(gas["gas_used"], "$.gas_info.gas_used"),
    };
  }

  /** POST /cosmos/tx/v1beta1/txs — BROADCAST_MODE_SYNC (CheckTx result). */
  async broadcast(txBytesBase64: string): Promise<BroadcastResult> {
    const o = expectObject(
      await this.lcd.post("cosmos/tx/v1beta1/txs", {
        tx_bytes: txBytesBase64,
        mode: "BROADCAST_MODE_SYNC",
      }),
    );
    const res = expectObject(o["tx_response"], "$.tx_response");
    return {
      txhash: expectString(res["txhash"], "$.tx_response.txhash"),
      code: Number(res["code"] ?? 0),
      rawLog: expectString(res["raw_log"] ?? "", "$.tx_response.raw_log"),
    };
  }

  /**
   * GET /cosmos/tx/v1beta1/txs/{hash}. Null while the tx is not yet
   * included (LCD 404s until inclusion) — the poll loop's "keep waiting".
   */
  async getTx(hash: string): Promise<TxInclusion | null> {
    let o: Record<string, unknown>;
    try {
      o = expectObject(await this.lcd.get(`cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`));
    } catch (error) {
      if (error instanceof LcdError && error.status === 404) return null;
      throw error;
    }
    const res = expectObject(o["tx_response"], "$.tx_response");
    return {
      txhash: expectString(res["txhash"], "$.tx_response.txhash"),
      height: parseU64String(res["height"], "$.tx_response.height"),
      code: Number(res["code"] ?? 0),
      rawLog: expectString(res["raw_log"] ?? "", "$.tx_response.raw_log"),
      gasUsed: parseU64String(res["gas_used"] ?? "0", "$.tx_response.gas_used"),
      timestamp: expectString(res["timestamp"] ?? "", "$.tx_response.timestamp"),
    };
  }
}
