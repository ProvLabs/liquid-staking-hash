// Boot checks (app-spec §7): vault-address cross-check against the contract's
// Config {} and console chain-id match — both must fail startup loudly on
// mismatch. Chain reads come from the @nvhash/fixtures corpus via the MSW
// harness (the mocks the e2e suite uses too), never hand-written shapes.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BootCheckError, loadConfig, runBootChecks } from "~/config/config.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const GOOD_ENV = {
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
} as NodeJS.ProcessEnv;

describe("config loading (bounded at the boundary)", () => {
  it("loads a valid environment", () => {
    const config = loadConfig(GOOD_ENV);
    expect(config.chainId).toBe(FIXTURE_CHAIN_ID);
    expect(config.appEnv).toBe("development");
  });

  it.each([
    ["missing CHAIN_ID", { ...GOOD_ENV, CHAIN_ID: undefined }],
    ["non-URL LCD_URL", { ...GOOD_ENV, LCD_URL: "not a url" }],
    ["non-bech32 contract", { ...GOOD_ENV, CONTRACT_ADDRESS: "0xdeadbeef" }],
    ["non-bech32 vault", { ...GOOD_ENV, VAULT_ADDRESS: "vault" }],
    ["unknown APP_ENV", { ...GOOD_ENV, APP_ENV: "prod" }],
  ])("rejects %s", (_name, env) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/Invalid web configuration/);
  });
});

describe("boot checks (fail loudly on mismatch)", () => {
  it("passes when the console chain id matches and Config{} reports the configured vault", async () => {
    await expect(runBootChecks(loadConfig(GOOD_ENV))).resolves.toBeUndefined();
  });

  it("fails on console chain-id mismatch before touching the network", async () => {
    const config = loadConfig({ ...GOOD_ENV, CONSOLE_CHAIN_ID: "pio-mainnet-1" });
    const neverFetch = () => {
      throw new Error("network must not be reached for a local-check failure");
    };
    await expect(runBootChecks(config, { fetchImpl: neverFetch })).rejects.toThrow(
      /console chain-id mismatch/,
    );
  });

  it("fails when the contract's Config{} reports a different vault address", async () => {
    const otherVault = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk"; // valid bech32, wrong vault
    const config = loadConfig({ ...GOOD_ENV, VAULT_ADDRESS: otherVault });
    const error = await runBootChecks(config).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BootCheckError);
    // The message must name both sides so the operator can see the mismatch.
    expect(String(error)).toContain(otherVault);
    expect(String(error)).toContain(FIXTURE_VAULT_ADDRESS);
  });

  it("refuses to start when the LCD is unreachable/undecodable", async () => {
    const config = loadConfig(GOOD_ENV);
    const failingFetch = async () => ({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    });
    await expect(runBootChecks(config, { fetchImpl: failingFetch })).rejects.toThrow(
      /cross-check could not run/,
    );
  });
});
