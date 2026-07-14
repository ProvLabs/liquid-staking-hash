import { describe, expect, it } from "vitest";
import { LcdClient, type FetchLike } from "../src/lcd.ts";
import {
  NvhashContractClient,
  parseApr,
  parseContractConfig,
  parseEpochSnapshot,
  parseEpochStatus,
  parseValidatorStatus,
} from "../src/contract.ts";
import { expectArray, expectObject, DecodeError } from "../src/amounts.ts";
import { fixture, smartData } from "./fixtures.ts";

describe("contract smart-query decoders against the devnet corpus", () => {
  it("decodes config with bounded bps values", () => {
    const c = parseContractConfig(smartData("queries/contract/config.json"));
    expect(c.receiptDenom).toBe("nvhash.staked");
    expect(c.maxBondedCapBps).toBeLessThanOrEqual(10000);
    expect(c.vaultAddress).toMatch(/^tp1/);
  });

  it("decodes epoch status (phase, receipt_minted as bigint, pending arrays)", () => {
    const s = parseEpochStatus(smartData("queries/contract/epoch-status.json"));
    expect(s.phase).toBe("Idle");
    expect(typeof s.receiptMinted).toBe("bigint");
    expect(Array.isArray(s.pendingDelegations)).toBe(true);
    expect(Array.isArray(s.pendingRedelegations)).toBe(true);
  });

  it("decodes the §9.10 snapshot decomposition, including signed net_deposits", () => {
    const raw = expectObject(smartData("queries/contract/epoch-snapshot.json"));
    const snap = parseEpochSnapshot(raw["snapshot"]);
    expect(snap.epochIndex).toBeGreaterThan(0);
    expect(typeof snap.tvvBefore).toBe("bigint");
    expect(typeof snap.netDeposits).toBe("bigint");
    // the drilled corpus has a negative net_deposits window — sign must survive
    expect(snap.netDeposits < 0n).toBe(true);
    // the drill's phase-4 snapshot identity holds in decoded form
    // (tvv_after == tvv_before + rewards_deposited for this reward-only window)
    expect(snap.tvvAfter).toBe(snap.tvvBefore + snap.rewardsDeposited);
  });

  it("decodes APR with numeric bps", () => {
    const a = parseApr(smartData("queries/contract/apr.json"));
    expect(a.grossAprBps).toBeGreaterThan(0);
    expect(a.netAprBps).toBeLessThanOrEqual(a.grossAprBps);
  });

  it("decodes validator assessments (headroom/tip as bigint, uptime nullable)", () => {
    const d = expectObject(smartData("queries/contract/validators.json"));
    const list = expectArray(d["validators"]);
    expect(list.length).toBeGreaterThan(0);
    const v = parseValidatorStatus(list[0]);
    expect(typeof v.headroom).toBe("bigint");
    expect(typeof v.commissionAccrued).toBe("bigint");
    expect(v.uptimeBps === null || typeof v.uptimeBps === "number").toBe(true);
  });

  it("rejects a snapshot whose amount became a JSON number (drift detection)", () => {
    const raw = expectObject(smartData("queries/contract/epoch-snapshot.json"));
    const snap = { ...expectObject(raw["snapshot"]), tvv_before: 315340713169 };
    expect(() => parseEpochSnapshot(snap)).toThrow(DecodeError);
  });
});

describe("NvhashContractClient transport", () => {
  it("base64-encodes the smart query into the LCD path and unwraps .data", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify(fixture("queries/contract/config.json")) };
    };
    const client = new NvhashContractClient(new LcdClient("http://lcd", { fetchImpl }), "tp1contract");
    const cfg = await client.config();
    expect(cfg.underlyingDenom).toBe("nhash");
    const expected = Buffer.from(JSON.stringify({ config: {} })).toString("base64");
    expect(calls[0]).toBe(`http://lcd/cosmwasm/wasm/v1/contract/tp1contract/smart/${encodeURIComponent(expected)}`);
  });
});
