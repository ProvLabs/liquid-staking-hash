import { describe, expect, it } from "vitest";
import { parseGroupInfo, GroupClient } from "../src/group.ts";
import { StakingClient } from "../src/staking.ts";
import { LcdClient, LcdError, type FetchLike } from "../src/lcd.ts";
import { expectArray, expectObject } from "../src/amounts.ts";
import { fixture } from "./fixtures.ts";

function lcdServing(body: unknown): LcdClient {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
  return new LcdClient("http://lcd", { fetchImpl });
}

describe("staking decoders against the devnet corpus", () => {
  it("decodes the validator set (tokens as bigint)", async () => {
    const r = await new StakingClient(lcdServing(fixture("queries/staking/validators.json"))).validators();
    expect(r.validators.length).toBeGreaterThan(0);
    for (const v of r.validators) {
      expect(typeof v.tokens).toBe("bigint");
      expect(v.operatorAddress).toMatch(/^tpvaloper1/);
    }
    // pagination total decodes to the exact value the corpus carries
    const rawTotal = expectObject(expectObject(fixture("queries/staking/validators.json"))["pagination"])["total"];
    expect(r.pagination.total).toBe(BigInt(rawTotal as string));
  });

  it("decodes the contract's program delegations", async () => {
    const r = await new StakingClient(lcdServing(fixture("queries/staking/delegations.json"))).delegations("tp1contract");
    expect(r.delegations.length).toBeGreaterThan(0);
    const d = r.delegations[0]!;
    expect(d.balance.denom).toBe("nhash");
    expect(typeof d.balance.amount).toBe("bigint");
  });
});

describe("group decoders against the devnet corpus", () => {
  it("decodes the (empty) groups list and its pagination envelope", async () => {
    const r = await new GroupClient(lcdServing(fixture("queries/group/groups.json"))).groups();
    expect(r.groups).toEqual([]);
    expect(r.pagination.nextKey).toBeNull();
    expect(r.pagination.total).toBe(0n);
  });

  it("decodes a populated group info", () => {
    const g = parseGroupInfo({
      id: "1",
      admin: "tp1admin",
      metadata: "nvHASH admin group",
      version: "2",
      total_weight: "3",
      created_at: "2026-07-14T00:00:00Z",
    });
    expect(g.id).toBe(1n);
    expect(g.version).toBe(2n);
  });
});

describe("LcdClient error surface", () => {
  it("throws LcdError with status and body on non-2xx", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 501,
      text: async () => '{"code":12,"message":"Not Implemented"}',
    });
    const lcd = new LcdClient("http://lcd", { fetchImpl });
    await expect(lcd.get("vault/v1/nope")).rejects.toThrow(LcdError);
  });

  it("skips undefined query params and serializes bigint", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const lcd = new LcdClient("http://lcd/", { fetchImpl });
    await lcd.get("x", { shares: 10n, redeem_denom: undefined });
    expect(urls[0]).toBe("http://lcd/x?shares=10");
  });
});

describe("corpus manifest stays provisional until PR 8.0", () => {
  it("manifest carries the provisional marker and the feature-probe result", () => {
    const m = expectObject(fixture("manifest.json"));
    expect(String(m["status"])).toContain("PROVISIONAL");
    const probe = expectObject(m["feature_probe"]);
    expect(probe["name"]).toBe("AcceptAsset");
    expect(probe["result"]).toBe("present");
    expect(expectArray(m["pinned_facts"]).length).toBeGreaterThan(0);
  });
});
