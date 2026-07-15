// Client-config allowlist (SECURITY.md: everything shipped to the browser is
// public; app-spec §7 client-safe subset). Together with the bundle-secret
// gate (scripts/check-bundle-secrets.mjs) this is the standing
// security-executable check of plan §4 for the web component.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CLIENT_SAFE_CONFIG_KEYS } from "~/config/client";
import { loadConfig, toClientConfig } from "~/config/config.server";

import classification from "../scripts/server-only-env.json";

const SAMPLE_ENV = {
  APP_ENV: "development",
  CHAIN_ID: "chain-dev",
  LCD_URL: "http://lcd.example:1317",
  CONTRACT_ADDRESS: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  VAULT_ADDRESS: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: "chain-dev",
} as NodeJS.ProcessEnv;

describe("client-safe config subset (§7)", () => {
  it("toClientConfig emits exactly the allowlisted keys, nothing more", () => {
    const client = toClientConfig(loadConfig(SAMPLE_ENV));
    expect(Object.keys(client).sort()).toEqual([...CLIENT_SAFE_CONFIG_KEYS].sort());
  });

  it("never includes server-only values", () => {
    const client = toClientConfig(loadConfig(SAMPLE_ENV));
    const serialized = JSON.stringify(client);
    expect(serialized).not.toContain(SAMPLE_ENV.LCD_URL);
    expect(Object.keys(client)).not.toContain("lcdUrl");
    expect(Object.keys(client)).not.toContain("consoleChainId");
  });

  it("classification file and TS allowlist agree, with no overlap", () => {
    // The bundle gate reads scripts/server-only-env.json; the runtime
    // projection reads CLIENT_SAFE_CONFIG_KEYS. Keep them from drifting.
    const clientEnv: string[] = classification.clientSafeEnv;
    expect(clientEnv.length).toBe(CLIENT_SAFE_CONFIG_KEYS.length);
    const overlap = classification.serverOnly.filter((k: string) => clientEnv.includes(k));
    expect(overlap).toEqual([]);
  });

  it("every uncommented .env.example key is classified", () => {
    const example = readFileSync(join(__dirname, "../.env.example"), "utf8");
    const keys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    const classified = new Set([
      ...classification.serverOnly,
      ...classification.clientSafeEnv,
      ...classification.toolingOnly,
    ]);
    for (const key of keys) {
      expect(classified.has(key), `unclassified env var ${key} in .env.example`).toBe(true);
    }
  });
});
