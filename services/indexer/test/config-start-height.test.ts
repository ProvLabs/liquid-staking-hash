// INDEX_START_HEIGHT config gate (plan 8.4 §2.9/C2): bounded int ≥ 1 (the
// GOV_START_HEIGHT idiom), default 1 so devnet behavior is unchanged. Set per
// environment to the bootstrap's recorded contract STORE height so a public
// testnet backfill starts where history begins instead of walking millions of
// pre-contract blocks.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const BASE = {
  DATABASE_URL: "postgresql://indexer_writer:x@localhost/db?schema=indexed",
  LCD_URL: "http://localhost:1317",
  RPC_URL: "http://localhost:26657",
  CHAIN_ID: "chain-dev",
  CONTRACT_ADDRESS: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  VAULT_ADDRESS: "tp1vaultvaultvaultvaultvaultvaultvault000",
  RECEIPT_DENOM: "nvhash",
};

describe("INDEX_START_HEIGHT (plan 8.4 §2.9)", () => {
  it("defaults to 1 — devnet-compatible, no behavior change", () => {
    expect(loadConfig({ ...BASE }).indexStartHeight).toBe(1);
  });

  it("accepts the bootstrap's recorded store height", () => {
    expect(loadConfig({ ...BASE, INDEX_START_HEIGHT: "27411234" }).indexStartHeight).toBe(27411234);
  });

  it("rejects non-integers and values below 1 — bounded at the boundary, never clamped", () => {
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      expect(() => loadConfig({ ...BASE, INDEX_START_HEIGHT: bad })).toThrow(/INDEX_START_HEIGHT/);
    }
  });
});
