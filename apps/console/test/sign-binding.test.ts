import { describe, expect, it } from "vitest";
import {
  encodeExecuteContract,
  encodeSignDoc,
  encodeTxBody,
  MSG_EXECUTE_CONTRACT,
  type Coin,
} from "@/tx/build";
import { bytesField, bytesFields, readFields, stringField } from "@/tx/proto";
import type { ExecuteMsg } from "@/tx/messages";

/** Decode a MsgExecuteContract back to its rendered parts. */
function decodeExecute(bytes: Uint8Array): {
  sender: string;
  contract: string;
  message: unknown;
  funds: Coin[];
} {
  const fields = readFields(bytes);
  const message = JSON.parse(new TextDecoder().decode(bytesField(fields, 3) ?? new Uint8Array()));
  const funds = bytesFields(fields, 5).map((coin) => {
    const c = readFields(coin);
    return { denom: stringField(c, 1), amount: stringField(c, 2) };
  });
  return {
    sender: stringField(fields, 1),
    contract: stringField(fields, 2),
    message,
    funds,
  };
}

const SENDER = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk";
const CONTRACT = "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8";

describe("decode-back equality: signed bytes == rendered message", () => {
  const cases: Array<{ name: string; message: ExecuteMsg; funds: Coin[] }> = [
    { name: "run_epoch (fundless)", message: { run_epoch: {} }, funds: [] },
    {
      name: "pay_commission (funded)",
      message: { pay_commission: { valoper: "tpvaloper1aaa" } },
      funds: [{ denom: "nhash", amount: "123456789" }],
    },
    {
      name: "purge with claimant (null field preserved)",
      message: { purge_jailed_validator: { valoper: "tpvaloper1aaa", claimant_valoper: null } },
      funds: [],
    },
    {
      name: "update_config (partial fields)",
      message: { update_config: { aum_fee_bps: 30, commission_bps: null } },
      funds: [],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const encoded = encodeExecuteContract(SENDER, CONTRACT, c.message, c.funds);
      const decoded = decodeExecute(encoded);
      expect(decoded.message).toEqual(c.message);
      expect(decoded.funds).toEqual(c.funds);
      expect(decoded.sender).toBe(SENDER);
      expect(decoded.contract).toBe(CONTRACT);
    });
  }

  it("the TxBody carries exactly one message, the encoded one", () => {
    const value = encodeExecuteContract(SENDER, CONTRACT, { claim_rewards: {} }, []);
    const body = readFields(encodeTxBody([{ typeUrl: MSG_EXECUTE_CONTRACT, value }]));
    const anys = bytesFields(body, 1);
    expect(anys.length).toBe(1);
    const any = readFields(anys[0]!);
    expect(stringField(any, 1)).toBe(MSG_EXECUTE_CONTRACT);
    expect(decodeExecute(bytesField(any, 2) ?? new Uint8Array()).message).toEqual({
      claim_rewards: {},
    });
  });

  it("the SignDoc embeds the same bodyBytes it was built from (no re-encode drift)", () => {
    const value = encodeExecuteContract(SENDER, CONTRACT, { claim_rewards: {} }, []);
    const bodyBytes = encodeTxBody([{ typeUrl: MSG_EXECUTE_CONTRACT, value }]);
    const doc = readFields(encodeSignDoc(bodyBytes, new Uint8Array([9]), "chain-dev", 1n));
    expect(bytesField(doc, 1)).toEqual(bodyBytes);
  });
});
