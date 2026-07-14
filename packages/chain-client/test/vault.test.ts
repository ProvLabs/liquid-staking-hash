import { describe, expect, it } from "vitest";
import { LcdClient, UnsupportedTransportError, type FetchLike } from "../src/lcd.ts";
import {
  VaultClient,
  parsePendingSwapOuts,
  parseSwapEstimate,
  parseVaultParams,
  parseVaultState,
  type VaultRecord,
} from "../src/vault.ts";
import { expectArray, expectObject } from "../src/amounts.ts";
import { fixture } from "./fixtures.ts";

describe("vault decoders against the devnet corpus", () => {
  it("decodes /vault/v1/vaults/{id} (get.json)", () => {
    const s = parseVaultState(fixture("queries/vault/get.json"));
    expect(s.vault.totalShares.denom).toBe("nvhash");
    expect(typeof s.vault.totalShares.amount).toBe("bigint");
    expect(s.vault.withdrawalDelaySeconds).toBe(180n);
    expect(s.vault.assetManager).toMatch(/^tp1/);
    expect(s.vault.navAuthority).toBe(s.vault.assetManager);
    expect(s.totalVaultValue.denom).toBe("nhash");
    expect(s.totalVaultValue.amount > 0n).toBe(true);
    expect(s.principal.coins.length).toBeGreaterThan(0);
  });

  it("decodes /vault/v1/vaults (list.json)", () => {
    const o = expectObject(fixture("queries/vault/list.json"));
    const vaults = expectArray(o["vaults"]);
    expect(vaults.length).toBeGreaterThan(0);
    // list entries carry the same vault record shape as get
    const s = parseVaultState(fixture("queries/vault/get.json"));
    const first = expectObject(vaults[0]);
    expect(expectObject(first["base_account"])["address"]).toBe(s.vault.address);
  });

  it("decodes pending swap outs including the empty envelope", () => {
    const r = parsePendingSwapOuts(fixture("queries/vault/pending-swap-outs.json"));
    expect(Array.isArray(r.pendingSwapOuts)).toBe(true);
    expect(typeof r.pagination.total).toBe("bigint");
  });

  it("decodes estimate_swap_out (LCD) and estimate-swap-in (gRPC/CLI proto JSON) with one decoder", () => {
    const out = parseSwapEstimate(fixture("queries/vault/estimate-swap-out.json"));
    expect(out.assets.denom).toBe("nhash");
    expect(typeof out.assets.amount).toBe("bigint");
    expect(out.height > 0n).toBe(true);
    const inn = parseSwapEstimate(fixture("queries/vault/estimate-swap-in.json"));
    expect(inn.assets.denom).toBe("nvhash");
    expect(inn.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("decodes vault params", () => {
    const p = parseVaultParams(fixture("queries/vault/params.json"));
    expect(p.techFeeAddress).toMatch(/^tp1/);
    expect(p.defaultAumFeeBips).toBeGreaterThanOrEqual(0);
  });
});

function fakeLcd(routes: Record<string, unknown>): { lcd: LcdClient; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const path = url.replace("http://lcd", "").split("?")[0]!;
    const hit = Object.entries(routes).find(([k]) => path === k);
    return {
      ok: hit !== undefined,
      status: hit ? 200 : 404,
      text: async () => (hit ? JSON.stringify(hit[1]) : "not found"),
    };
  };
  return { lcd: new LcdClient("http://lcd", { fetchImpl }), calls };
}

describe("VaultClient transport", () => {
  const VAULT = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";

  it("hits /vault/v1 paths — never /provlabs/vault/v1 (pinned corpus fact)", async () => {
    const { lcd, calls } = fakeLcd({
      [`/vault/v1/vaults/${VAULT}`]: fixture("queries/vault/get.json"),
      [`/vault/v1/vaults/${VAULT}/estimate_swap_out`]: fixture("queries/vault/estimate-swap-out.json"),
    });
    const client = new VaultClient(lcd);
    await client.getVault(VAULT);
    const est = await client.estimateSwapOut(VAULT, 1000000000000n);
    expect(est.assets.amount).toBe(1017379n);
    expect(calls.every((u) => !u.includes("/provlabs/"))).toBe(true);
    expect(calls[1]).toContain("estimate_swap_out?shares=1000000000000");
  });

  it("estimateSwapIn fails loudly as transport-unsupported (grpc-gateway Coin param limitation)", async () => {
    const { lcd } = fakeLcd({});
    const client = new VaultClient(lcd);
    await expect(
      client.estimateSwapIn(VAULT, { denom: "nhash", amount: 1000000000n }),
    ).rejects.toThrow(UnsupportedTransportError);
  });
});

// Compile-time check: VaultRecord amounts are bigint, not number.
const _typeCheck: VaultRecord["totalShares"]["amount"] extends bigint ? true : never = true;
void _typeCheck;
