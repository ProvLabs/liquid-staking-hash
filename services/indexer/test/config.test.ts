// Config-boundary tests. `loadConfig` is the process boundary where every
// input is validated and bounded (SECURITY.md); a value that cannot be bounded
// safely is an error, never a best-effort continue.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

/** Minimal environment satisfying every `required()` field. */
const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://u:p@h:5432/d?schema=indexed",
  LCD_URL: "http://lcd:1317",
  RPC_URL: "http://rpc:26657",
  CHAIN_ID: "pio-testnet-1",
  CONTRACT_ADDRESS: "tp1contract",
  VAULT_ADDRESS: "tp1vault",
  RECEIPT_DENOM: "nvhash",
};

describe("INDEX_START_HEIGHT", () => {
  it("defaults to 1 so devnet behaviour is unchanged", () => {
    expect(loadConfig({ ...BASE_ENV }).indexStartHeight).toBe(1);
  });

  it("parses a configured start height", () => {
    expect(loadConfig({ ...BASE_ENV, INDEX_START_HEIGHT: "33273900" }).indexStartHeight).toBe(
      33_273_900,
    );
  });

  it("treats an empty value as unset rather than as zero", () => {
    expect(loadConfig({ ...BASE_ENV, INDEX_START_HEIGHT: "" }).indexStartHeight).toBe(1);
  });

  it("rejects 0 — CometBFT heights are 1-based, there is no block 0", () => {
    expect(() => loadConfig({ ...BASE_ENV, INDEX_START_HEIGHT: "0" })).toThrow(
      /INDEX_START_HEIGHT/,
    );
  });

  it("rejects a non-integer rather than silently truncating", () => {
    expect(() => loadConfig({ ...BASE_ENV, INDEX_START_HEIGHT: "12.5" })).toThrow(
      /INDEX_START_HEIGHT/,
    );
  });
});
